import 'server-only';

import type { AIProvider } from './provider';

/**
 * Reply language.
 *
 * ShopiQ computes every fact in English: cart totals, order statuses, payment
 * outcomes and refusals are deterministic templates, and the recommendation
 * prose is generated against English product data. That is deliberate — the
 * facts must not depend on which language someone typed in.
 *
 * So translation is a LAST step over finished text, not a second code path.
 * `localise()` re-renders an already-correct English sentence in the shopper's
 * language and then PROVES the numbers survived; if they did not, the English
 * original is sent instead. A mistranslated pleasantry is a small problem. A
 * mistranslated price is a lie about money, and this file is what makes that
 * failure mode impossible rather than unlikely.
 */

export type ReplyLanguage = 'en' | 'hi' | 'hinglish';

const DEVANAGARI = /[ऀ-ॿ]/;

/**
 * Distinctive romanised Hindi markers.
 *
 * Deliberately excludes words that collide with English or with product text —
 * "hai" is fine, but "do", "to", "me", "is" and "so" are not, because "add the
 * 2 TB one to my cart" must not read as Hindi. Each entry here is a word that
 * essentially only appears when someone is writing Hindi in Latin script.
 */
const HINGLISH_MARKERS = new Set([
  'chahiye', 'chaahiye', 'dikhao', 'dikha', 'batao', 'bata', 'karo', 'kardo',
  'kijiye', 'mujhe', 'mereko', 'mera', 'meri', 'aapka', 'aapko',
  'kitna', 'kitne', 'kitni', 'kaunsa', 'kaunse', 'kaun', 'kyun', 'kyu',
  'accha', 'achha', 'acha', 'sasta', 'sasti', 'mehnga', 'mehngi', 'behtar',
  'sabse', 'thoda', 'zyada', 'jyada', 'bilkul', 'lekin', 'magar', 'phir',
  'nahi', 'nahin', 'haan', 'wala', 'wali', 'waala', 'hazaar', 'hajar',
  'rupaye', 'paisa', 'paise', 'daal', 'daalo', 'daldo', 'nikaal', 'nikalo',
  'hatao', 'khareed', 'kharidna', 'lena', 'lunga', 'loonga', 'chalega',
  'theek', 'thik', 'bhej', 'bhejo', 'dedo', 'dena', 'raha', 'rahe', 'rahi',
  'gaya', 'liye', 'saath', 'andar', 'baad', 'pehle', 'pehla', 'dusra',
  'teesra', 'apna', 'apne', 'kuch', 'sirf', 'bhi', 'aur',
]);

/** An explicit instruction always wins over what the sentence looks like. */
const ASK_HINDI =
  /(?:speak|reply|answer|talk|respond|write)\s+(?:to\s+me\s+)?in\s+hindi|\b(?:hindi|हिंदी|हिन्दी)\s*(?:me|mein|mai|में)\b/i;
const ASK_ENGLISH =
  /(?:speak|reply|answer|talk|respond|write)\s+(?:to\s+me\s+)?in\s+english|\benglish\s*(?:me|mein|mai|में)\b|(?:अंग्रेजी|अंग्रेज़ी|इंग्लिश)\s*(?:में|मे)/i;

/**
 * Which language should the reply be written in?
 *
 * `previous` is the conversation's sticky preference: once someone asks for
 * Hindi, a following "ok" or "haan" should not silently snap back to English.
 */
export function detectLanguage(
  message: string,
  previous: ReplyLanguage | null = null,
): ReplyLanguage {
  if (ASK_ENGLISH.test(message)) return 'en';
  if (ASK_HINDI.test(message)) return 'hi';

  // Script is unambiguous evidence — no scoring needed.
  if (DEVANAGARI.test(message)) return 'hi';

  const words = message.toLowerCase().match(/[a-z]+/g) ?? [];
  let hits = 0;
  for (const word of words) {
    if (HINGLISH_MARKERS.has(word)) hits += 1;
  }

  // Two markers, or one in a short message where that one word is already most
  // of the sentence ("dikhao", "kitna hai"). A single marker buried in a long
  // English sentence is more likely a product name or a typo.
  if (hits >= 2 || (hits === 1 && words.length <= 4)) {
    // Both readings are Hindi, so the established script wins: someone who has
    // been typing Devanagari and answers "haan" in Latin has not asked to be
    // replied to in Latin.
    return previous === 'hi' ? 'hi' : 'hinglish';
  }

  // Nothing said otherwise — keep whatever the conversation was already using,
  // so a one-word "yes" mid-conversation does not change the language.
  return previous ?? 'en';
}

const INSTRUCTIONS: Record<Exclude<ReplyLanguage, 'en'>, string> = {
  hi: 'Rewrite it in natural, conversational Hindi using Devanagari script.',
  hinglish:
    'Rewrite it in Hinglish — conversational Hindi written in Latin script, the way Indians text each other. Do not use Devanagari.',
};

/**
 * Every digit run in the text, as written.
 *
 * This is the evidence `localise()` checks: if a translation dropped, invented
 * or altered a number, the sequences will not line up and it is discarded.
 */
function digitRuns(text: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).map((run) => run.replace(/[.,]+$/, '')).sort();
}

/** Order numbers, SKUs and similar identifiers must survive verbatim. */
function identifiers(text: string): string[] {
  return (text.match(/\b[A-Z]{2,}[-_A-Z0-9]{3,}\b/g) ?? []).sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Render a finished English reply in the shopper's language.
 *
 * Returns the English original unchanged whenever the translation cannot be
 * trusted: no provider, an empty response, a thrown request, or — the
 * important one — a result whose numbers or identifiers do not match the
 * source exactly.
 */
export async function localise(
  provider: AIProvider,
  text: string,
  language: ReplyLanguage,
): Promise<string> {
  if (language === 'en' || !provider.available) return text;

  const trimmed = text.trim();
  if (trimmed.length === 0) return text;

  try {
    const result = await provider.generateResponse({
      system: [
        'You are a translator for an Indian e-commerce assistant.',
        '',
        'You are given one finished message. Rewrite it — do not answer it, do not',
        'add to it, do not remove anything from it.',
        '',
        'Absolute rules:',
        '- Every number, price and quantity must appear EXACTLY as in the original,',
        '  in the same Latin digits. Never convert digits to another script, and never',
        '  round or reword an amount. Rupees 1,49,999 stays 1,49,999.',
        '- Keep product names, brand names, order numbers and email addresses in their',
        '  original form. Do not translate them.',
        '- Keep the meaning and the tone identical. If the original asks a question,',
        '  the rewrite asks the same question.',
        '- Reply with the rewritten message only. No preamble, no quotes, no notes.',
      ].join('\n'),
      messages: [
        {
          role: 'user',
          content: `${INSTRUCTIONS[language]}\n\nMessage:\n"""${trimmed}"""`,
        },
      ],
      effort: 'low',
      maxTokens: 700,
    });

    const output = result.text.trim().replace(/^"""/, '').replace(/"""$/, '').trim();
    if (output.length === 0) return text;

    // The safety property: facts must be identical, or we do not ship it.
    if (!sameList(digitRuns(output), digitRuns(trimmed))) return text;
    if (!sameList(identifiers(output), identifiers(trimmed))) return text;

    return output;
  } catch {
    return text;
  }
}

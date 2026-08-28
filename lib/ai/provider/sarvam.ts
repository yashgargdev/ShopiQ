import 'server-only';

import { z } from 'zod';

import {
  AIProviderError,
  type AIProvider,
  type GenerateRequest,
  type GenerateResult,
  type StructuredRequest,
  type ToolCallRequest,
  type ToolCallResult,
} from './types';

/**
 * Sarvam provider.
 *
 * Sarvam exposes an OpenAI-compatible chat-completions endpoint, so this is a
 * plain fetch client — no extra SDK. It exists now so the Indian-language work
 * planned for Phase 3 is a configuration change (`AI_PROVIDER=sarvam`) rather
 * than a rewrite.
 *
 * Structured output is done by asking for JSON and validating with the same Zod
 * schema the Claude path uses. Validation is on our side either way, so a model
 * that ignores the instruction fails closed rather than corrupting state.
 */

const DEFAULT_BASE_URL = 'https://api.sarvam.ai/v1';
/**
 * `sarvam-m` was deprecated and now returns a hard 400. Verified working
 * against the live API: `sarvam-105b` and `sarvam-105b-conversations`.
 * Overridable via SARVAM_MODEL so the next deprecation is a config change.
 */
/**
 * `sarvam-105b` is a REASONING model: it emits its thinking into
 * `reasoning_content` and the answer into `content`. Under a modest token
 * budget it spends the whole allowance thinking, returns `content: null` with
 * `finish_reason: "length"`, and every extraction silently falls back to the
 * deterministic rules — after paying for the round trip.
 *
 * The conversation-tuned variant answers directly and measured ~2.5x faster on
 * the same prompt, so it is the default. Override with SARVAM_MODEL.
 */
const DEFAULT_MODEL = 'sarvam-105b-conversations';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: unknown;
      /** Reasoning models put their thinking here and leave content null. */
      reasoning_content?: string | null;
    };
    finish_reason?: string;
  }>;
  error?: { message?: string };
}

export class SarvamProvider implements AIProvider {
  readonly name = 'sarvam';
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(
    apiKey: string | undefined = process.env.SARVAM_API_KEY,
    model: string = process.env.SARVAM_MODEL ?? DEFAULT_MODEL,
    baseUrl: string = process.env.SARVAM_BASE_URL ?? DEFAULT_BASE_URL,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  private async chat(
    system: string,
    messages: Array<{ role: string; content: string }>,
    options: { maxTokens?: number; json?: boolean } = {},
  ): Promise<string> {
    if (!this.apiKey) {
      throw new AIProviderError('SARVAM_API_KEY is not configured.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          // Generous by default: a reasoning model that runs out of budget
          // mid-thought returns nothing at all rather than a short answer.
          max_tokens: options.maxTokens ?? 2400,
          temperature: options.json ? 0 : 0.3,
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ChatCompletionResponse | null;
        throw new AIProviderError(
          `Sarvam returned ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}.`,
          undefined,
          response.status >= 500 || response.status === 429,
        );
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const choice = payload.choices?.[0];
      const text = choice?.message?.content ?? '';

      if (!text.trim()) {
        // Name the actual cause. A reasoning model that exhausted its budget
        // mid-thought returns null content with finish_reason "length" and a
        // populated reasoning_content — indistinguishable from a generic empty
        // reply unless you say so, and it sent us chasing a phantom 18-second
        // timeout once already.
        const starved =
          choice?.finish_reason === 'length' &&
          Boolean((choice?.message as { reasoning_content?: string } | undefined)?.reasoning_content);

        throw new AIProviderError(
          starved
            ? `Sarvam model "${this.model}" used its whole token budget reasoning and returned no answer. Raise maxTokens, or use a conversation-tuned model.`
            : 'Sarvam returned an empty response.',
          undefined,
          // Starvation is deterministic: retrying the same request wastes time
          // and money for the same nothing.
          !starved,
        );
      }
      return text.trim();
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AIProviderError('Sarvam request timed out.', error, true);
      }
      throw new AIProviderError('Could not reach Sarvam.', error, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateResponse(request: GenerateRequest): Promise<GenerateResult> {
    const text = await this.chat(request.system, request.messages, {
      maxTokens: request.maxTokens,
    });
    return { text, provider: this.name, model: this.model };
  }

  async generateStructuredOutput<T>(request: StructuredRequest<T>): Promise<T> {
    const schemaHint = JSON.stringify(z.toJSONSchema(request.schema as z.ZodType), null, 2);

    const text = await this.chat(
      `${request.system}\n\nReply with a single JSON object and nothing else. It must satisfy this JSON Schema:\n${schemaHint}`,
      request.messages,
      { maxTokens: request.maxTokens, json: true },
    );

    let raw: unknown;
    try {
      raw = JSON.parse(stripCodeFence(text));
    } catch {
      throw new AIProviderError('Sarvam did not return valid JSON.');
    }

    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new AIProviderError(
        `Sarvam output did not match the ${request.schemaName} schema.`,
        parsed.error,
      );
    }
    return parsed.data;
  }

  /**
   * Not implemented for Sarvam yet. The agent catches this and falls back to
   * the deterministic path, so an open-ended question still gets answered from
   * catalogue data rather than failing.
   */
  async executeToolCalls(_request: ToolCallRequest): Promise<ToolCallResult> {
    throw new AIProviderError(
      'Tool calling is not wired up for the Sarvam provider yet.',
      undefined,
      false,
    );
  }
}

/** Models often wrap JSON in ```json fences despite being told not to. */
function stripCodeFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

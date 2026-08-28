import 'server-only';

import { AnthropicProvider } from './anthropic';
import { SarvamProvider } from './sarvam';
import {
  AICapabilityError,
  type AIProvider,
  type GenerateRequest,
  type GenerateResult,
  type StructuredRequest,
  type ToolCallRequest,
  type ToolCallResult,
} from './types';

export * from './types';

/**
 * Provider selection.
 *
 * `AI_PROVIDER` picks the implementation; when it is unset we auto-detect from
 * whichever key is present. If none is, we return the null provider and the
 * agent runs its deterministic path — rule-based requirement extraction and
 * templated explanations over the same real catalogue data.
 *
 * That fallback is the point: ShopiQ's storefront must never depend on an LLM
 * being reachable (Phase 2 §34), and the test suite must run without a key.
 */

/**
 * No LLM. Reports itself unavailable so callers take the deterministic route
 * rather than discovering the absence through an exception.
 */
class NullProvider implements AIProvider {
  readonly name = 'none';
  readonly model = 'deterministic';
  readonly available = false;

  async generateResponse(_request: GenerateRequest): Promise<GenerateResult> {
    throw new AICapabilityError('No AI provider is configured.');
  }
  async generateStructuredOutput<T>(_request: StructuredRequest<T>): Promise<T> {
    throw new AICapabilityError('No AI provider is configured.');
  }
  async executeToolCalls(_request: ToolCallRequest): Promise<ToolCallResult> {
    throw new AICapabilityError('No AI provider is configured.');
  }
}

export type ProviderName = 'anthropic' | 'sarvam' | 'none';

let cached: AIProvider | null = null;

export function resolveProvider(): AIProvider {
  if (cached) return cached;
  cached = buildProvider();
  return cached;
}

function buildProvider(): AIProvider {
  const configured = (process.env.AI_PROVIDER ?? '').trim().toLowerCase();

  if (configured === 'none') return new NullProvider();

  if (configured === 'anthropic' || configured === 'claude') {
    const provider = new AnthropicProvider();
    return provider.available ? provider : new NullProvider();
  }

  if (configured === 'sarvam') {
    const provider = new SarvamProvider();
    return provider.available ? provider : new NullProvider();
  }

  // A value that matches nothing is almost always a model name written into
  // the provider slot (AI_PROVIDER=sarvam-105b instead of AI_PROVIDER=sarvam
  // plus SARVAM_MODEL=sarvam-105b). Silently ignoring it means the setting
  // appears to work while doing nothing, so say so once, loudly.
  if (configured && configured !== 'auto') {
    console.warn(
      `[shopiq] AI_PROVIDER="${configured}" is not a provider name. ` +
        'Expected "anthropic", "sarvam" or "none" — set the model with ' +
        'SARVAM_MODEL / ANTHROPIC_MODEL instead. Falling back to auto-detection.',
    );
  }

  // Unset: use whichever credential is actually present.
  const anthropic = new AnthropicProvider();
  if (anthropic.available) return anthropic;

  const sarvam = new SarvamProvider();
  if (sarvam.available) return sarvam;

  return new NullProvider();
}

/** Surfaced on the health endpoint and in the UI's degraded state. */
export function providerStatus(): {
  provider: string;
  model: string;
  available: boolean;
  configured: string | null;
} {
  const provider = resolveProvider();
  return {
    provider: provider.name,
    model: provider.model,
    available: provider.available,
    configured: process.env.AI_PROVIDER ?? null,
  };
}

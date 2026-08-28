import type { z } from 'zod';

/**
 * The AI provider contract.
 *
 * Nothing above this interface knows which model is running. `AI_PROVIDER`
 * picks the implementation at runtime; adding Sarvam (or any other vendor)
 * means adding one file under lib/ai/provider/ and one switch case.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Hint for how much reasoning to spend. Providers map this as they see fit. */
  effort?: 'low' | 'medium' | 'high';
  temperatureHint?: 'precise' | 'natural';
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
}

export interface StructuredRequest<T> {
  system: string;
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  /** Stable name for the output shape; some providers require one. */
  schemaName: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

/** A tool the provider may ask the host to run. Execution never happens here. */
export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRequest {
  system: string;
  messages: ChatMessage[];
  tools: ProviderToolDefinition[];
  /**
   * The host executes the call and returns a JSON-serialisable result. The
   * provider never gets database access — it only ever sees this function.
   */
  execute: (name: string, input: unknown) => Promise<unknown>;
  maxIterations?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
}

export interface ToolCallResult {
  text: string;
  toolsUsed: string[];
  iterations: number;
  provider: string;
  model: string;
}

export class AIProviderError extends Error {
  readonly reason: unknown;
  /** True when a retry or a different provider might succeed. */
  readonly retryable: boolean;

  constructor(message: string, reason?: unknown, retryable = false) {
    super(message);
    this.name = 'AIProviderError';
    this.reason = reason;
    this.retryable = retryable;
  }
}

/** Thrown by providers that cannot do a given capability at all. */
export class AICapabilityError extends AIProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'AICapabilityError';
  }
}

export interface AIProvider {
  readonly name: string;
  /** False when credentials are missing — the caller degrades instead of failing. */
  readonly available: boolean;
  readonly model: string;

  generateResponse(request: GenerateRequest): Promise<GenerateResult>;
  generateStructuredOutput<T>(request: StructuredRequest<T>): Promise<T>;
  executeToolCalls(request: ToolCallRequest): Promise<ToolCallResult>;
}

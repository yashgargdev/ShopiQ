import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

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
 * Claude provider.
 *
 * Requirement extraction goes through `messages.parse()` with a Zod output
 * format, so the model physically cannot return a shape we did not ask for —
 * which is what keeps the downstream deterministic pipeline safe.
 */

const DEFAULT_MODEL = 'claude-opus-5';

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly apiKey: string | undefined;
  private client: Anthropic | null = null;

  constructor(
    apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
    model: string = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
  ) {
    this.apiKey = apiKey;
    this.model = model;
  }

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  private getClient(): Anthropic {
    if (!this.apiKey) {
      throw new AIProviderError('ANTHROPIC_API_KEY is not configured.');
    }
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 2 });
    }
    return this.client;
  }

  async generateResponse(request: GenerateRequest): Promise<GenerateResult> {
    const client = this.getClient();
    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 1200,
        system: request.system,
        output_config: { effort: request.effort ?? 'low' },
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return { text, provider: this.name, model: this.model };
    } catch (error) {
      throw wrapError(error);
    }
  }

  async generateStructuredOutput<T>(request: StructuredRequest<T>): Promise<T> {
    const client = this.getClient();
    try {
      const response = await client.messages.parse({
        model: this.model,
        max_tokens: request.maxTokens ?? 1500,
        system: request.system,
        output_config: {
          effort: request.effort ?? 'low',
          format: zodOutputFormat(request.schema as never),
        },
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      if (response.parsed_output == null) {
        throw new AIProviderError('Model returned no parsable structured output.');
      }
      return response.parsed_output as T;
    } catch (error) {
      throw wrapError(error);
    }
  }

  /**
   * Bounded tool loop for open-ended product questions.
   *
   * The provider proposes calls; `request.execute` — the host's validated tool
   * registry — decides whether anything actually runs. The model never gets a
   * database handle.
   */
  async executeToolCalls(request: ToolCallRequest): Promise<ToolCallResult> {
    const client = this.getClient();
    const maxIterations = Math.min(Math.max(request.maxIterations ?? 4, 1), 6);
    const toolsUsed: string[] = [];

    const messages: Anthropic.MessageParam[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const tools: Anthropic.Tool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    }));

    try {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        const response = await client.messages.create({
          model: this.model,
          max_tokens: request.maxTokens ?? 1600,
          system: request.system,
          output_config: { effort: request.effort ?? 'low' },
          tools,
          messages,
        });

        if (response.stop_reason !== 'tool_use') {
          const text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
            .trim();
          return { text, toolsUsed, iterations: iteration, provider: this.name, model: this.model };
        }

        messages.push({ role: 'assistant', content: response.content });

        const calls = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );

        // All results for one assistant turn go back in a single user message,
        // otherwise the model learns to stop calling tools in parallel.
        const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
          calls.map(async (call) => {
            toolsUsed.push(call.name);
            try {
              const output = await request.execute(call.name, call.input);
              return {
                type: 'tool_result' as const,
                tool_use_id: call.id,
                content: JSON.stringify(output),
              };
            } catch (error) {
              return {
                type: 'tool_result' as const,
                tool_use_id: call.id,
                is_error: true,
                content: JSON.stringify({
                  error: error instanceof Error ? error.message : 'Tool failed.',
                }),
              };
            }
          }),
        );

        messages.push({ role: 'user', content: results });
      }

      // Ran out of iterations — ask for a final answer with no tools attached.
      const final = await client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens ?? 1200,
        system: `${request.system}\n\nYou have used all available tool calls. Answer now using only the tool results already gathered.`,
        output_config: { effort: 'low' },
        messages,
      });

      const text = final.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return {
        text,
        toolsUsed,
        iterations: maxIterations,
        provider: this.name,
        model: this.model,
      };
    } catch (error) {
      throw wrapError(error);
    }
  }
}

function wrapError(error: unknown): AIProviderError {
  if (error instanceof AIProviderError) return error;

  if (error instanceof Anthropic.RateLimitError) {
    return new AIProviderError('AI provider rate limit reached.', error, true);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new AIProviderError('AI provider rejected the configured credentials.', error, false);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AIProviderError('Could not reach the AI provider.', error, true);
  }
  if (error instanceof Anthropic.APIError) {
    return new AIProviderError(
      `AI provider returned an error (${error.status ?? 'unknown'}).`,
      error,
      (error.status ?? 500) >= 500,
    );
  }
  return new AIProviderError('AI provider call failed.', error, true);
}

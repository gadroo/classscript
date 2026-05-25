import { z } from "zod";
import { runWithRetry } from "../utils.js";

const ChatCompletionResponseSchema = z.object({
  model: z.string(),
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable(),
    }),
  })).min(1),
});

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (withoutFence.startsWith("{") && withoutFence.endsWith("}")) {
    return withoutFence;
  }

  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return withoutFence.slice(start, end + 1);
  }

  throw new Error("Model response did not contain a JSON object");
}

export interface StructuredLlmResult<T> {
  output: T;
  raw: string;
  model: string;
  attempts: number;
}

interface LlmFailureState {
  reason: string;
  until: number;
}

class LlmFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmFatalError";
  }
}

const LLM_FAILURE_COOLDOWN_MS = Number.parseInt(process.env.CURRICULUM_LLM_FAILURE_COOLDOWN_MS ?? "180000", 10);
let lastFatalFailure: LlmFailureState | null = null;

function getCachedFailureMessage(now = Date.now()): string | null {
  if (!lastFatalFailure) {
    return null;
  }
  if (lastFatalFailure.until <= now) {
    lastFatalFailure = null;
    return null;
  }
  const waitSeconds = Math.max(1, Math.ceil((lastFatalFailure.until - now) / 1000));
  return `${lastFatalFailure.reason} (cooldown ${waitSeconds}s)`;
}

function markFatalFailure(message: string): void {
  lastFatalFailure = {
    reason: message,
    until: Date.now() + Math.max(10_000, LLM_FAILURE_COOLDOWN_MS),
  };
}

function isFatalConnectivityError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  const text = error.message.toLowerCase();
  return text.includes("fetch failed")
    || text.includes("timed out")
    || text.includes("authentication failed")
    || text.includes("api key is not set");
}

export async function generateStructuredObject<T>(params: {
  schema: z.ZodType<T>;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  maxRetries: number;
}): Promise<StructuredLlmResult<T>> {
  const cachedFailure = getCachedFailureMessage();
  if (cachedFailure) {
    throw new Error(`LLM temporarily unavailable: ${cachedFailure}`);
  }

  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const reason = "OPENROUTER_API_KEY or OPENAI_API_KEY is not set";
    markFatalFailure(reason);
    throw new LlmFatalError(reason);
  }

  const model = process.env.CURRICULUM_MODEL ?? "openai/gpt-4.1";
  const baseUrl = process.env.CURRICULUM_LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
  const referer = process.env.CURRICULUM_APP_ORIGIN ?? "http://localhost:4000";
  const appTitle = process.env.CURRICULUM_APP_TITLE ?? "curriculum-os";

  const { value, attempts } = await runWithRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    const startTime = Date.now();
    console.error(`[LLM] Starting request to ${baseUrl} with model ${model} for schema ${params.schemaName}`);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": referer,
          "X-Title": appTitle,
        },
        body: JSON.stringify({
          model,
          temperature: params.temperature ?? 0,
          max_tokens: params.maxTokens ?? 1500,
          messages: [
            {
              role: "system",
              content: [
                params.systemPrompt,
                "Return only valid JSON with no markdown fences.",
                `Target schema: ${params.schemaName}`,
              ].join("\n"),
            },
            {
              role: "user",
              content: params.userPrompt,
            },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      console.error(`[LLM] Response received: ${response.status} in ${Date.now() - startTime}ms for ${params.schemaName}`);

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 401 || response.status === 403) {
          throw new LlmFatalError(`LLM authentication failed (${response.status}). Check OPENROUTER_API_KEY/OPENAI_API_KEY and base URL.`);
        }
        throw new Error(`LLM API error (${response.status}): ${text}`);
      }

      const data = ChatCompletionResponseSchema.parse(await response.json());
      const content = data.choices[0]?.message.content ?? "";
      const jsonText = extractJsonObject(content);
      const parsed = params.schema.parse(JSON.parse(jsonText));

      return {
        output: parsed,
        raw: content,
        model: data.model,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof LlmFatalError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmFatalError("LLM request timed out after 30 seconds");
      }
      if (isFatalConnectivityError(error)) {
        throw new LlmFatalError(error.message);
      }
      throw error instanceof Error ? error : new Error("Unknown LLM error");
    }
  }, params.maxRetries).catch((error) => {
    if (error instanceof LlmFatalError || isFatalConnectivityError(error)) {
      markFatalFailure(error instanceof Error ? error.message : "LLM unavailable");
    }
    throw error;
  });

  lastFatalFailure = null;

  return {
    ...value,
    attempts,
  };
}

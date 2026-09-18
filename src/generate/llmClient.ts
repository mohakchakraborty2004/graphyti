import { requireOpenRouterApiKey } from "../config";

const DEFAULT_MODEL = "google/gemini-3.5-flash-lite";

/**
 * Output budget for every call.
 *
 * 1024 was not enough for a create_file whose whole content is returned in
 * one JSON string: the response was truncated mid-token, JSON.parse failed,
 * and the retry produced another truncated file.
 */
const MAX_OUTPUT_TOKENS = 8192;

export function getConfiguredModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

function extractText(result: unknown): string {
  const res = result as {
    choices?: Array<{ message?: { content?: string | Array<unknown> } }>;
  };
  const choice = res.choices?.[0];
  if (!choice) throw new Error("No choices in LLM response");
  const content = choice.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textPart = content.find(
      (p: unknown) =>
        (p as { type?: string }).type === "text" &&
        typeof (p as { text?: string }).text === "string"
    );
    if (textPart) return (textPart as { text: string }).text;
  }
  throw new Error("Could not extract text from LLM response");
}

async function callChat(
  chatRequest: Record<string, unknown>,
  timeoutMs?: number
): Promise<unknown> {
  const { OpenRouter } = await import("@openrouter/sdk");
  // Via config, not process.env: config.ts is what loads .env from the package
  // root, and graphyti runs as a global CLI inside somebody else's project.
  // Reading the variable directly only worked when some other module happened
  // to import config first.
  const client = new OpenRouter({ apiKey: requireOpenRouterApiKey() });
  // SDK resolves directly to ChatResult on success, throws on error.
  // Use the SDK timeout rather than only racing the returned promise. That
  // aborts the underlying HTTP request, so a fallback/retry never leaves an
  // orphaned free-tier request running in the background.
  return client.chat.send({ chatRequest } as never, timeoutMs ? { timeoutMs } : undefined);
}

/**
 * Generate a plain-text or JSON completion via OpenRouter.
 *
 * - Reads OPENROUTER_API_KEY and OPENROUTER_MODEL from env.
 * - For JSON mode, uses the SDK's `responseFormat: { type: "json_object" }` if the
 *   underlying model supports it, otherwise falls back to prompt-level instruction
 *   with one JSON.parse retry on failure.
 */
export async function generateCompletion(
  prompt: string,
  opts?: {
    model?: string;
    responseFormat?: "text" | "json";
    /** Small structured calls must not reserve the full code-generation budget. */
    maxTokens?: number;
    /** Aborts the actual HTTP request when the provider does not respond in time. */
    timeoutMs?: number;
  }
): Promise<string> {
  const model = opts?.model ?? getConfiguredModel();
  const format = opts?.responseFormat ?? "text";
  const maxTokens = opts?.maxTokens ?? MAX_OUTPUT_TOKENS;

  const chatRequest: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens,
    stream: false,
  };

  if (format === "json") {
    chatRequest.responseFormat = { type: "json_object" };
  }

  let result: unknown;
  try {
    result = await callChat(chatRequest, opts?.timeoutMs);
  } catch (err: unknown) {
    throw wrapError(err);
  }

  const text = extractText(result);

  if (format === "json") {
    try {
      JSON.parse(text);
      return text;
    } catch {
      return await generateJsonViaPrompt(model, prompt, maxTokens, opts?.timeoutMs);
    }
  }

  return text;
}

async function generateJsonViaPrompt(
  model: string,
  prompt: string,
  maxTokens: number,
  timeoutMs?: number
): Promise<string> {
  const jsonPrompt = `${prompt}\n\nIMPORTANT: You MUST return only valid JSON. No markdown, no explanation, no code fences.`;
  let result: unknown;
  try {
    result = await callChat({
      model,
      messages: [{ role: "user", content: jsonPrompt }],
      maxTokens,
      stream: false,
    }, timeoutMs);
  } catch (err: unknown) {
    throw wrapError(err);
  }
  const text = extractText(result);
  try {
    JSON.parse(text);
    return text;
  } catch {
    throw new Error(
      `Failed to parse JSON from model response after prompt-level instruction. Raw response: ${text.slice(0, 500)}`
    );
  }
}

function wrapError(err: unknown): Error {
  if (err instanceof Error) {
    const name = err.constructor.name;
    const sc = (err as unknown as { statusCode?: number }).statusCode;

    if (name === "UnauthorizedResponseError" || sc === 401) {
      return new Error(
        `OpenRouter auth error: invalid or missing API key (HTTP ${sc ?? "?"})`
      );
    }
    if (name === "PaymentRequiredResponseError" || sc === 402) {
      return new Error(
        `OpenRouter payment required: insufficient credits (HTTP ${sc ?? "?"})`
      );
    }
    if (name === "TooManyRequestsResponseError" || sc === 429) {
      return new Error(
        `OpenRouter rate limit exceeded (HTTP ${sc ?? "?"})`
      );
    }
    if (name === "ConnectionError") {
      return new Error(`OpenRouter network error: ${err.message}`);
    }
    if (name === "RequestTimeoutError" || name === "RequestAbortedError") {
      return new Error(`OpenRouter request timed out: ${err.message}`);
    }
    if (name === "OpenRouterError" || name.endsWith("ResponseError")) {
      return new Error(
        `OpenRouter API error (HTTP ${sc ?? "?"}): ${err.message}`
      );
    }
    return err;
  }
  if (err !== undefined && err !== null) {
    return new Error(
      `OpenRouter error: ${JSON.stringify(err).slice(0, 300)}`
    );
  }
  return new Error("OpenRouter request failed with unknown error");
}

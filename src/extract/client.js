import Anthropic from "@anthropic-ai/sdk";
import { extractionOutputFormat } from "./schema.js";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";

/**
 * LLM boundary for extraction. Everything provider-facing lives here so the
 * pipeline can be tested with an injected fake generator. Uses the official
 * Anthropic SDK: credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * or an `ant auth login` profile; ANTHROPIC_BASE_URL is honored for gateways.
 */
export function extractConfig() {
  return {
    model: process.env.FUNDGRAPH_EXTRACT_MODEL ?? "claude-opus-5",
    effort: process.env.FUNDGRAPH_EXTRACT_EFFORT ?? "low",
    maxTokens: Number(process.env.FUNDGRAPH_EXTRACT_MAX_TOKENS ?? 8192),
  };
}

let _client = null;
function client() {
  if (!_client) {
    try {
      _client = new Anthropic({ maxRetries: 3 });
    } catch (err) {
      // No key, no auth token, no profile: fail the whole run immediately
      // with instructions instead of writing a `failed` row per document.
      throw Object.assign(
        new Error(`no Anthropic credentials found (${err.message})`),
        { isAuthProblem: true }
      );
    }
  }
  return _client;
}

export function isAuthError(err) {
  return err?.isAuthProblem === true ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    // The SDK throws a generic AnthropicError (not AuthenticationError) when
    // no credential source resolves at request time.
    /could not resolve authentication method/i.test(err?.message ?? "");
}

/** One extraction request for one chunk. Returns {people, orgs, usage}. */
export async function generateExtraction(doc, chunk, chunkIndex, chunkCount) {
  const cfg = extractConfig();
  const response = await client().messages.parse({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    // Static system prompt first with a cache breakpoint: every doc in a run
    // shares the prefix, so runs bill the instructions once, not per doc.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { format: extractionOutputFormat(), effort: cfg.effort },
    messages: [{ role: "user", content: userPrompt(doc, chunk, chunkIndex, chunkCount) }],
  });

  const usage = {
    input: (response.usage?.input_tokens ?? 0) +
      (response.usage?.cache_creation_input_tokens ?? 0) +
      (response.usage?.cache_read_input_tokens ?? 0),
    output: response.usage?.output_tokens ?? 0,
  };
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw Object.assign(new Error(`model declined this document (refusal: ${category})`), { usage });
  }
  if (!response.parsed_output) {
    throw Object.assign(new Error("model returned no parseable extraction"), { usage });
  }
  return { ...response.parsed_output, usage };
}

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../brand.js";
import { ExtractionResult, extractionOutputFormat } from "./schema.js";
import { SYSTEM_PROMPT, userPrompt } from "./prompt.js";

/**
 * LLM boundary for extraction. Everything provider-facing lives here so the
 * pipeline can be tested with an injected fake generator. Uses the official
 * Anthropic SDK: credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * or an `ant auth login` profile; ANTHROPIC_BASE_URL is honored for gateways.
 */

// Models whose API rejects the `effort` parameter (Haiku tier). Everything
// current in the Opus/Sonnet/Fable lines accepts it.
const NO_EFFORT = /haiku/i;

export function extractConfig() {
  return {
    model: env("EXTRACT_MODEL") ?? "claude-opus-5",
    effort: env("EXTRACT_EFFORT") ?? "low",
    maxTokens: Number(env("EXTRACT_MAX_TOKENS") ?? 8192),
  };
}

// USD per MTok, Anthropic list prices as of 2026-08. Deliberately coarse:
// family match only, and the dashboard labels every figure "approximate".
// Unknown families degrade to a token-only estimate rather than a wrong
// dollar figure.
const PRICE_PER_MTOK = [
  [/fable|mythos/i, { input: 10, output: 50 }],
  [/opus/i,         { input: 5,  output: 25 }],
  [/sonnet/i,       { input: 3,  output: 15 }],
  [/haiku/i,        { input: 1,  output: 5  }],
];

export function priceFor(model) {
  return PRICE_PER_MTOK.find(([re]) => re.test(model ?? ""))?.[1] ?? null;
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

function usageOf(response) {
  return {
    input: (response?.usage?.input_tokens ?? 0) +
      (response?.usage?.cache_creation_input_tokens ?? 0) +
      (response?.usage?.cache_read_input_tokens ?? 0),
    output: response?.usage?.output_tokens ?? 0,
  };
}

/**
 * One extraction request for one chunk. Returns {people, orgs, usage}.
 * Deliberately messages.create + explicit validation rather than the parse()
 * helper: stop_reason (refusal, truncation) must be inspected — with token
 * usage preserved for accounting — before any schema validation can throw.
 */
export async function generateExtraction(doc, chunk, chunkIndex, chunkCount) {
  const cfg = extractConfig();
  const response = await client().messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    // Static prompt first, with a cache marker. Note: prompts only cache above
    // the model's minimum prefix (512 tokens on claude-opus-5) — this prompt
    // sits under that today, so the marker is a no-op until the prompt grows;
    // it is kept because it is harmless and future-proof.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: {
      format: extractionOutputFormat(),
      ...(NO_EFFORT.test(cfg.model) ? {} : { effort: cfg.effort }),
    },
    messages: [{ role: "user", content: userPrompt(doc, chunk, chunkIndex, chunkCount) }],
  });

  const usage = usageOf(response);
  const fail = (msg) => { throw Object.assign(new Error(msg), { usage }); };

  if (response.stop_reason === "refusal") {
    fail(`model declined this document (refusal: ${response.stop_details?.category ?? "unspecified"})`);
  }
  if (response.stop_reason === "max_tokens") {
    fail(`output truncated at ${cfg.maxTokens} tokens — raise FEIN_EXTRACT_MAX_TOKENS`);
  }
  const text = response.content?.find((b) => b.type === "text")?.text;
  if (!text) fail("model returned no text content");
  let parsed;
  try {
    parsed = ExtractionResult.parse(JSON.parse(text));
  } catch (err) {
    fail(`model output failed schema validation: ${err.message?.slice(0, 200)}`);
  }
  return { ...parsed, usage };
}

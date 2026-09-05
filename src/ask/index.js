import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, env } from "../brand.js";
import { buildMcpServer } from "../mcp/server.js";
import { systemPrompt, contextBlock } from "./prompt.js";

/**
 * Ask — one question in, one streamed answer out.
 *
 * Claude drives the graph through the very same MCP tools an external agent
 * gets (an in-process client on an in-memory transport), so an answer on
 * the Ask page and an answer in Claude Code come from identical code. The
 * loop is manual and streaming: text deltas go to the caller as they
 * arrive, tool calls run between turns, and the whole exchange is bounded
 * (iterations, tool-result size, wall clock) because it faces a browser.
 *
 * The provider boundary is injectable (`createClient`) so the loop is
 * tested offline with a scripted stream.
 */

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

export function askConfig() {
  return {
    model: env("ASK_MODEL") ?? "claude-opus-5",
    effort: env("ASK_EFFORT") ?? "medium",
    maxTokens: Number(env("ASK_MAX_TOKENS") ?? 16000),
    maxIterations: Number(env("ASK_MAX_ITERATIONS") ?? 10),
    maxToolChars: Number(env("ASK_MAX_TOOL_CHARS") ?? 60000),
    firm: env("FIRM") ?? "the firm",
    fallbacks: env("ASK_FALLBACKS") !== "0",
  };
}

/** Presence only, never values: what the first question will authenticate with. */
export function askCredentials() {
  if (process.env.ANTHROPIC_API_KEY) return "api-key";
  if (process.env.ANTHROPIC_AUTH_TOKEN) return "auth-token";
  return "ambient"; // an `ant auth login` profile may still resolve at request time
}

let _client = null;
function defaultClient() {
  if (!_client) _client = new Anthropic({ maxRetries: 2 });
  return _client;
}

/** Sanitize the browser's transcript: alternating text turns only, bounded. */
export function normalizeMessages(input, { maxTurns = 30, maxChars = 12000 } = {}) {
  const out = [];
  for (const m of Array.isArray(input) ? input : []) {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const text = typeof m?.content === "string" ? m.content.trim() : "";
    if (!role || !text) continue;
    if (out.length && out[out.length - 1].role === role) {
      out[out.length - 1].content += "\n\n" + text; // merge consecutive same-role turns
    } else {
      out.push({ role, content: text.slice(0, maxChars) });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (out.length && out[out.length - 1].role !== "user") out.pop();
  return out.slice(-maxTurns);
}

/** Map SDK errors to something a person can act on; never leak internals. */
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError ||
      /could not resolve authentication method/i.test(err?.message ?? "")) {
    return { code: "not_configured", message: "Ask is not set up on this instance yet: it has no Anthropic credentials." };
  }
  if (err instanceof Anthropic.RateLimitError) return { code: "busy", message: "The model is busy right now. Try again in a moment." };
  if (err instanceof Anthropic.APIConnectionError) return { code: "unreachable", message: "Could not reach the model provider." };
  if (err instanceof Anthropic.BadRequestError) return { code: "bad_request", message: "The model rejected the request." };
  if (err?.name === "AbortError" || err?.message === "Request was aborted.") return { code: "aborted", message: "Stopped." };
  return { code: "error", message: "Something went wrong answering that." };
}

/**
 * Run one question. `messages` is the browser transcript (text turns);
 * `onEvent(type, data)` receives, in order: start, text*, (tool, tool_result)*, turn*, done | error.
 * Returns the final assistant text.
 */
export async function ask(db, { messages, viewer = null, viewerName = null, asker = null, signal = null,
  onEvent = () => {}, createClient = defaultClient, now = () => new Date(), config = askConfig() } = {}) {
  const turns = normalizeMessages(messages);
  if (!turns.length) throw Object.assign(new Error("ask needs a question"), { statusCode: 400 });

  // The graph, as an MCP client would see it — same tools, same viewer scoping.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(db, { viewer, actor: asker ? `ask:${asker}` : "ask" });
  await server.connect(serverTransport);
  const mcp = new Client({ name: `${BRAND.toLowerCase()}-ask`, version: VERSION });
  await mcp.connect(clientTransport);

  try {
    const { tools: listed } = await mcp.listTools();
    // Deterministic order: the tool list is part of the cached prefix.
    const tools = listed
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema }));
    if (tools.length) tools[tools.length - 1].cache_control = { type: "ephemeral" };

    const system = [
      { type: "text", text: systemPrompt({ firm: config.firm, brand: BRAND }), cache_control: { type: "ephemeral" } },
      { type: "text", text: contextBlock({ today: now().toISOString().slice(0, 10), asker, viewerName }) },
    ];
    const api = [...turns];
    const client = createClient();
    let answer = "";
    let usedFallbacks = config.fallbacks;
    onEvent("start", { model: config.model });

    for (let i = 0; i < config.maxIterations; i++) {
      const params = {
        model: config.model,
        max_tokens: config.maxTokens,
        output_config: { effort: config.effort },
        system,
        tools,
        messages: api,
        ...(usedFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      };
      let message;
      try {
        const stream = client.beta.messages.stream(params, signal ? { signal } : undefined);
        stream.on("text", (delta) => { answer += delta; onEvent("text", { delta }); });
        message = await stream.finalMessage();
      } catch (err) {
        // A gateway or region without the fallback beta: try once without it.
        if (usedFallbacks && err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(err.message ?? "")) {
          usedFallbacks = false;
          i--;
          continue;
        }
        throw err;
      }
      onEvent("turn", {
        stop: message.stop_reason,
        model: message.model,
        usage: {
          input: message.usage?.input_tokens ?? 0,
          output: message.usage?.output_tokens ?? 0,
          cacheRead: message.usage?.cache_read_input_tokens ?? 0,
          cacheWrite: message.usage?.cache_creation_input_tokens ?? 0,
        },
      });
      if (message.stop_reason === "refusal") {
        const why = message.stop_details?.category ?? null;
        onEvent("error", { code: "refusal", message: "The model declined to answer that.", category: why });
        return answer;
      }
      if (message.stop_reason === "pause_turn") {
        api.push({ role: "assistant", content: message.content });
        continue;
      }
      const calls = message.content.filter((b) => b.type === "tool_use");
      if (message.stop_reason !== "tool_use" || !calls.length) break;

      api.push({ role: "assistant", content: message.content });
      const results = [];
      for (const call of calls) {
        onEvent("tool", { id: call.id, name: call.name, input: call.input ?? {} });
        let text;
        let isError = false;
        try {
          const res = await mcp.callTool({ name: call.name, arguments: call.input ?? {} });
          text = (res.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
          isError = Boolean(res.isError);
        } catch (err) {
          text = `error: ${err.message}`;
          isError = true;
        }
        if (text.length > config.maxToolChars) {
          text = text.slice(0, config.maxToolChars) +
            `\n… truncated at ${config.maxToolChars} characters; ask again with a smaller limit or a narrower question.`;
        }
        onEvent("tool_result", { id: call.id, name: call.name, ok: !isError, chars: text.length, summary: summarize(call.name, text) });
        results.push({ type: "tool_result", tool_use_id: call.id, content: text, ...(isError ? { is_error: true } : {}) });
      }
      // All results in one user turn, so parallel calls stay parallel.
      api.push({ role: "user", content: results });
    }
    onEvent("done", { chars: answer.length });
    return answer;
  } finally {
    await mcp.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/** A one-line receipt for the page: what came back, in numbers. */
function summarize(name, text) {
  try {
    const d = JSON.parse(text);
    if (Array.isArray(d)) return `${d.length} result${d.length === 1 ? "" : "s"}`;
    const who = d?.profile?.canonical_name ?? d?.entity?.canonical_name ?? (typeof d?.entity === "string" ? d.entity : null);
    if (who) return who;
    if (d?.guests) return `${d.guests.length} guest${d.guests.length === 1 ? "" : "s"}`;
    if (d?.history) return `${d.history.length} event${d.history.length === 1 ? "" : "s"}`;
    if (d?.radar) return `${d.radar.length} relationship${d.radar.length === 1 ? "" : "s"}`;
    if (d?.connections) return `${d.connections.length} connection${d.connections.length === 1 ? "" : "s"}`;
    if (d?.path) return `${d.path.length - 1} hop${d.path.length === 2 ? "" : "s"}`;
    if (d?.error) return "no match";
    return "ok";
  } catch {
    return `${text.length} chars`;
  }
}

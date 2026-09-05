import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Ask over Claude Code — the subscription path.
 *
 * The Claude Agent SDK is Claude Code as a library: it spawns the Claude
 * Code runtime, authenticates with a Claude Code OAuth token (a Max or Team
 * subscription — `claude setup-token`), and drives its own agent loop. We
 * hand it the Fein system prompt, point it at this server's own MCP
 * endpoint over loopback for the graph tools, switch every built-in coding
 * tool off, and translate its message stream into the same events the API
 * provider emits. Nothing on the page knows which provider answered.
 *
 * Costs come out of the subscription's usage allowance rather than an API
 * bill. Latency is a little higher (a runtime is spawned per question).
 */

// Claude Code's built-in tools have no business answering a graph question.
const BUILT_INS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Task", "TodoWrite", "TodoRead", "KillShell", "BashOutput", "Agent", "Skill",
  "ExitPlanMode", "EnterPlanMode", "AskUserQuestion", "SlashCommand", "Monitor", "SendMessage", "ListAgents", "ToolSearch"];

/** Fold a text transcript into one prompt: the SDK takes a single prompt per spawn. */
export function foldTranscript(turns) {
  if (turns.length === 1) return turns[0].content;
  const prior = turns.slice(0, -1).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`).join("\n\n");
  return `Earlier in this conversation:\n\n${prior}\n\nThe user now asks:\n\n${turns[turns.length - 1].content}`;
}

/** The subprocess must not inherit a parent Claude Code session's identity. */
export function childEnv(base = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|MESSAGING_|BRIDGE_|ENTRYPOINT|EXECPATH)/.test(k)) continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Build the SDK options for one question. Pure, so the test can pin the
 * shape without spawning anything.
 */
export function claudeCodeOptions({ systemText, contextText, mcpUrl, mcpAuth, model, effort, maxTurns, abortController }) {
  const cwd = join(tmpdir(), "fein-ask");
  try { mkdirSync(cwd, { recursive: true }); } catch {}
  return {
    systemPrompt: { type: "custom", prompt: [systemText, contextText] },
    mcpServers: {
      // alwaysLoad: every graph tool is in the first prompt, never deferred
      // behind Claude Code's own tool search — that cost three turns per question.
      fein: { type: "http", url: mcpUrl, alwaysLoad: true, ...(mcpAuth ? { headers: { Authorization: `Bearer ${mcpAuth}` } } : {}) },
    },
    strictMcpConfig: true,
    allowedTools: ["mcp__fein__*"],
    disallowedTools: BUILT_INS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    persistSession: false,
    includePartialMessages: true,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    maxTurns,
    cwd,
    env: childEnv(),
    ...(abortController ? { abortController } : {}),
  };
}

const stripServer = (name) => name.replace(/^mcp__fein__/, "");

/**
 * Run one question through Claude Code. `queryFn` is the SDK's `query`,
 * injectable for tests. Emits the same events as the API provider.
 */
export async function askViaClaudeCode({ turns, systemText, contextText, mcpUrl, mcpAuth, config, signal = null,
  onEvent = () => {}, queryFn = null } = {}) {
  const query = queryFn ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  const options = claudeCodeOptions({
    systemText, contextText, mcpUrl, mcpAuth,
    model: config.model, effort: config.effort, maxTurns: config.maxIterations, abortController,
  });
  onEvent("start", { model: config.model, provider: "claude-code" });

  let answer = "";
  const pending = new Map(); // tool_use id -> name
  const q = query({ prompt: foldTranscript(turns), options });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        const fein = (m.mcp_servers ?? []).find((s) => s.name === "fein");
        if (fein && !/connected|ready|ok/i.test(fein.status ?? "")) {
          onEvent("error", { code: "tools_unavailable", message: "The graph's tools did not connect; try again in a moment." });
        }
        continue;
      }
      if (m.type === "stream_event") {
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && m.parent_tool_use_id == null) {
          answer += ev.delta.text;
          onEvent("text", { delta: ev.delta.text });
        }
        continue;
      }
      if (m.type === "assistant" && m.parent_tool_use_id == null) {
        for (const b of m.message?.content ?? []) {
          // Only the graph's tools are receipts; anything else is Claude Code's own machinery.
          if (b.type === "tool_use" && b.name.startsWith("mcp__fein__")) {
            pending.set(b.id, stripServer(b.name));
            onEvent("tool", { id: b.id, name: stripServer(b.name), input: b.input ?? {} });
          }
        }
        continue;
      }
      if (m.type === "user" && m.parent_tool_use_id == null) {
        const content = m.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type !== "tool_result" || !pending.has(b.tool_use_id)) continue;
          const text = typeof b.content === "string" ? b.content
            : (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
          const name = pending.get(b.tool_use_id);
          onEvent("tool_result", { id: b.tool_use_id, name, ok: !b.is_error, chars: text.length, summary: summarize(text) });
        }
        continue;
      }
      if (m.type === "result") {
        const usage = m.usage ?? {};
        onEvent("turn", {
          stop: m.stop_reason ?? null, model: config.model, turns: m.num_turns, ms: m.duration_ms, costUsd: m.total_cost_usd,
          usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 },
        });
        if (m.subtype !== "success" || m.is_error) {
          const reason = m.subtype === "error_max_turns" ? "That question needed more steps than allowed; ask something narrower."
            : m.subtype === "error_max_budget_usd" ? "That question hit the spending cap."
            : Array.isArray(m.errors) && m.errors.length ? String(m.errors[0]).slice(0, 200)
            : "Claude Code could not finish that question.";
          onEvent("error", { code: m.subtype ?? "error", message: reason });
          return answer;
        }
        // A non-streamed final answer (no partial messages) lives in result.result.
        if (!answer && typeof m.result === "string" && m.result) {
          answer = m.result;
          onEvent("text", { delta: m.result });
        }
      }
    }
    onEvent("done", { chars: answer.length });
    return answer;
  } finally {
    try { q.close?.(); } catch {}
  }
}

function summarize(text) {
  try {
    const d = JSON.parse(text);
    if (Array.isArray(d)) return `${d.length} result${d.length === 1 ? "" : "s"}`;
    const who = d?.profile?.canonical_name ?? d?.entity?.canonical_name ?? (typeof d?.entity === "string" ? d.entity : null);
    if (who) return who;
    if (d?.guests) return `${d.guests.length} guest${d.guests.length === 1 ? "" : "s"}`;
    if (d?.history) return `${d.history.length} event${d.history.length === 1 ? "" : "s"}`;
    if (d?.radar) return `${d.radar.length} relationship${d.radar.length === 1 ? "" : "s"}`;
    if (d?.error) return "no match";
    return "ok";
  } catch {
    return `${text.length} chars`;
  }
}

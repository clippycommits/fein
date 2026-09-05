/**
 * Ask: the streamed question loop, offline. A scripted stand-in for the
 * Anthropic client plays the model; the graph is a throwaway embedded
 * database with a few documents; the tools run for real through the
 * in-process MCP client. Then the HTTP route: auth, status, event framing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

const dataDir = mkdtempSync(join(tmpdir(), "fein-ask-"));
process.env.FEIN_DATA = dataDir;
process.env.FEIN_FIRM = "Ridgeline Capital";
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { rebuildEdges } = await import(join(root, "src/graph/edges.js"));
const { addMember } = await import(join(root, "src/members.js"));
const { ask, normalizeMessages, describeError, askCredentials, askProvider } = await import(join(root, "src/ask/index.js"));
const { claudeCodeOptions, foldTranscript, childEnv } = await import(join(root, "src/ask/claude-code.js"));
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.FEIN_ASK_PROVIDER;

let failures = 0;
const ok = (cond, label, extra) => {
  console.log(`  ${cond ? "ok " : "FAIL"} ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 400)}` : ""}`);
  if (!cond) failures++;
};

/* ---------- a scripted model ---------- */
// Each script entry is one assistant turn: { text?, tools?: [{name, input}] }.
// The fake streams `text` deltas, then resolves finalMessage() with the
// content blocks and a stop_reason of tool_use when tools are present.
function scriptedClient(script, { capture = [] } = {}) {
  let turn = 0;
  return () => ({
    beta: {
      messages: {
        stream(params, opts) {
          capture.push({ params, opts });
          const step = script[turn++] ?? { text: "" };
          const em = new EventEmitter();
          const content = [];
          if (step.text) content.push({ type: "text", text: step.text });
          for (const [i, t] of (step.tools ?? []).entries()) content.push({ type: "tool_use", id: `tu_${turn}_${i}`, name: t.name, input: t.input });
          const message = {
            model: params.model,
            content,
            stop_reason: step.stop ?? (step.tools?.length ? "tool_use" : "end_turn"),
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: step.cached ? 900 : 0, cache_creation_input_tokens: 0 },
            ...(step.stop === "refusal" ? { stop_details: { type: "refusal", category: "test" } } : {}),
          };
          queueMicrotask(() => {
            for (const piece of (step.text ?? "").match(/.{1,7}/gs) ?? []) em.emit("text", piece);
          });
          em.finalMessage = () => new Promise((resolve, reject) => {
            if (opts?.signal?.aborted) return reject(Object.assign(new Error("Request was aborted."), { name: "AbortError" }));
            setTimeout(() => resolve(message), 5);
          });
          return em;
        },
      },
    },
  });
}

/* ---------- a tiny graph ---------- */
const db = await getDb();
const jess = await addMember(db, { name: "Jess Webber", email: "jess@example.com" });
const docs = [
  { source: "attio", kind: "record", external_id: "p1", title: "Contact: Alex Rivera", people: [{ name: "Alex Rivera", email: "alex@northgate.example", org: "Northgate Media", role: "mentioned" }], orgs: ["Northgate Media"] },
  { source: "attio", kind: "record", external_id: "p2", title: "Contact: Priya Nair", people: [{ name: "Priya Nair", email: "priya@meridian.example", role: "mentioned" }] },
  ...["2025-01-08", "2025-04-10", "2026-04-07"].map((d, i) => ({
    source: "attio", kind: "event", external_id: `e${i}`, title: `Dinner ${i} — attended`, occurred_at: `${d}T12:00:00Z`,
    people: [{ name: "Alex Rivera", email: "alex@northgate.example", role: "attendee" }, { name: "Jess Webber", email: "jess@example.com", role: "author" }],
    raw: { event: `dinner_${i}`, event_name: `Dinner ${i}`, event_date: d, tier: "attended", evidence: "attended=true", guest: { name: "Alex Rivera" }, host: { name: "Jess Webber" } },
  })),
  { source: "attio", kind: "invite", external_id: "e9", title: "Dinner 2 — invited", occurred_at: "2026-04-07T12:00:00Z",
    people: [{ name: "Priya Nair", email: "priya@meridian.example", role: "to" }, { name: "Jess Webber", email: "jess@example.com", role: "author" }],
    raw: { event: "dinner_2", event_name: "Dinner 2", event_date: "2026-04-07", tier: "invited", evidence: "invite_sent=true", guest: { name: "Priya Nair" }, host: { name: "Jess Webber" } } },
];
await ingestDocs(db, docs);
await resolveMentions(db);
await rebuildEdges(db);

console.log("normalizeMessages:");
{
  const t = normalizeMessages([
    { role: "assistant", content: "stray" },
    { role: "user", content: "  hi " }, { role: "user", content: "again" },
    { role: "assistant", content: "sure" }, { role: "assistant", content: "" },
    { role: "user", content: "final" }, { role: "assistant", content: "trailing" },
  ]);
  ok(t.length === 3 && t[0].role === "user" && t[0].content === "hi\n\nagain" && t[2].content === "final",
    "leading assistant dropped, same-role turns merged, trailing assistant dropped", t);
  ok(normalizeMessages([{ role: "user", content: "x".repeat(20000) }])[0].content.length === 12000, "turns are bounded");
  ok(normalizeMessages(null).length === 0, "garbage in, nothing out");
}

console.log("The loop:");
{
  const capture = [];
  const events = [];
  const script = [
    { text: "Let me look.", tools: [{ name: "guest_league", input: { sort: "most_attended", limit: 5 } }] },
    { text: "Alex Rivera has attended 3 events.", cached: true },
  ];
  const answer = await ask(db, {
    messages: [{ role: "user", content: "who came to the most events?" }],
    onEvent: (type, data) => events.push([type, data]),
    createClient: scriptedClient(script, { capture }),
    now: () => new Date("2026-09-05T10:00:00Z"),
  });
  ok(answer === "Let me look.Alex Rivera has attended 3 events.", "answer is the concatenated text", answer);
  const types = events.map((e) => e[0]);
  ok(types[0] === "start" && types.at(-1) === "done", "starts with start, ends with done", types);
  ok(types.includes("tool") && types.includes("tool_result") && types.filter((t) => t === "turn").length === 2, "tool, tool_result and two turns", types);
  const tool = events.find((e) => e[0] === "tool")[1];
  ok(tool.name === "guest_league" && tool.input.sort === "most_attended", "tool event carries name + input", tool);
  const result = events.find((e) => e[0] === "tool_result")[1];
  ok(result.ok && result.summary === "1 guest", "the tool really ran against the graph (one guest with attendance)", result);
  ok(events.filter((e) => e[0] === "text").length >= 4, "text streamed in deltas");

  const first = capture[0].params;
  ok(first.model === "claude-opus-5" && first.output_config.effort === "low", "model + effort from config", { model: first.model, oc: first.output_config });
  ok(first.betas?.[0] === "server-side-fallback-2026-07-01" && first.fallbacks === "default", "refusal fallback on by default");
  ok(Array.isArray(first.system) && first.system[0].cache_control?.type === "ephemeral" && !first.system[1].cache_control,
    "stable system block cached, volatile block not", first.system.map((b) => Boolean(b.cache_control)));
  ok(first.system[0].text.includes("Ridgeline Capital"), "firm name in the prompt");
  ok(first.system[1].text.includes("Today is 2026-09-05"), "date in the volatile block", first.system[1].text);
  const names = first.tools.map((t) => t.name);
  ok(names.length === 15 && names.join() === [...names].sort().join(), "all 15 graph tools, sorted", names);
  ok(first.tools.at(-1).cache_control?.type === "ephemeral" && !first.tools[0].cache_control, "last tool carries the cache breakpoint");
  ok(first.tools.find((t) => t.name === "guest_league").input_schema?.type === "object", "MCP schemas become input_schema");
  const second = capture[1].params;
  ok(second.messages.length === 3 && second.messages[1].role === "assistant" && second.messages[2].role === "user"
    && second.messages[2].content[0].type === "tool_result" && second.messages[2].content[0].tool_use_id === "tu_1_0",
    "second request carries the assistant turn and one tool_result turn", second.messages.map((m) => m.role));
  const turn2 = events.filter((e) => e[0] === "turn")[1][1];
  ok(turn2.usage.cacheRead === 900, "usage reports cache reads", turn2);
}

console.log("Viewer scoping + asker:");
{
  const capture = [];
  const events = [];
  await ask(db, {
    messages: [{ role: "user", content: "prep me for Alex" }],
    viewer: jess.id, viewerName: "Jess Webber", asker: "Jess Webber",
    onEvent: (t, d) => events.push([t, d]),
    createClient: scriptedClient([{ tools: [{ name: "meeting_prep", input: { entity: "Alex Rivera", me: "Jess Webber" } }] }, { text: "Done." }], { capture }),
  });
  ok(capture[0].params.system[1].text.includes("Jess Webber") && capture[0].params.system[1].text.includes("private layer"),
    "asker and layer named in the volatile block", capture[0].params.system[1].text);
  const r = events.find((e) => e[0] === "tool_result")[1];
  ok(r.ok && r.summary === "Alex Rivera", "meeting_prep ran as Jess and found Alex", r);
}

console.log("Edges of the loop:");
{
  // A tool the model invents: error result, loop continues, answer still lands.
  const events = [];
  const answer = await ask(db, {
    messages: [{ role: "user", content: "x" }],
    onEvent: (t, d) => events.push([t, d]),
    createClient: scriptedClient([{ tools: [{ name: "no_such_tool", input: {} }] }, { text: "Sorry." }]),
  });
  const r = events.find((e) => e[0] === "tool_result")[1];
  ok(r.ok === false && answer === "Sorry.", "an unknown tool is an error result, not a crash", r);

  // Oversized tool output is truncated with a note.
  const cap = [];
  await ask(db, {
    messages: [{ role: "user", content: "x" }],
    createClient: scriptedClient([{ tools: [{ name: "graph_stats", input: {} }] }, { text: "ok" }], { capture: cap }),
    config: { model: "claude-opus-5", effort: "low", maxTokens: 100, maxIterations: 5, maxToolChars: 40, firm: "F", fallbacks: false },
  });
  const tr = cap[1].params.messages[2].content[0].content;
  ok(tr.length > 40 && tr.includes("truncated at 40"), "tool results are bounded", tr.slice(0, 80));
  ok(!("betas" in cap[0].params) && !("fallbacks" in cap[0].params), "fallbacks can be switched off");

  // Iteration cap: a model that never stops calling tools is cut off.
  const forever = Array.from({ length: 20 }, () => ({ tools: [{ name: "graph_stats", input: {} }] }));
  const ev = [];
  await ask(db, { messages: [{ role: "user", content: "x" }], onEvent: (t) => ev.push(t),
    createClient: scriptedClient(forever), config: { model: "m", effort: "low", maxTokens: 10, maxIterations: 3, maxToolChars: 1000, firm: "F", fallbacks: false } });
  ok(ev.filter((t) => t === "turn").length === 3 && ev.at(-1) === "done", "iteration cap ends the loop cleanly", ev);

  // Refusal: reported as an error event, no throw.
  const ev2 = [];
  await ask(db, { messages: [{ role: "user", content: "x" }], onEvent: (t, d) => ev2.push([t, d]),
    createClient: scriptedClient([{ text: "", stop: "refusal" }]) });
  const e = ev2.find((x) => x[0] === "error")?.[1];
  ok(e?.code === "refusal" && e.category === "test", "a refusal is an error event with its category", ev2);

  // Empty question is a 400.
  let threw = null;
  try { await ask(db, { messages: [], createClient: scriptedClient([]) }); } catch (err) { threw = err; }
  ok(threw?.statusCode === 400, "no question → 400");

  // Aborted before the first turn resolves.
  const ac = new AbortController(); ac.abort();
  let aborted = null;
  try { await ask(db, { messages: [{ role: "user", content: "x" }], signal: ac.signal, createClient: scriptedClient([{ text: "late" }]) }); } catch (err) { aborted = err; }
  ok(describeError(aborted).code === "aborted", "an abort maps to 'aborted'", describeError(aborted));
  ok(describeError(new Error("boom")).code === "error" && !describeError(new Error("boom")).message.includes("boom"), "unknown errors never leak their message");
  ok(askCredentials() === "ambient", "no key in the environment reads as ambient");
}

console.log("Claude Code provider:");
{
  ok(askProvider() === "api", "no credentials at all → api (and not configured)");
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat";
  ok(askProvider() === "claude-code", "a Claude Code token and no API key → claude-code");
  process.env.ANTHROPIC_API_KEY = "sk";
  ok(askProvider() === "api", "an API key wins over the token");
  process.env.FEIN_ASK_PROVIDER = "claude-code";
  ok(askProvider() === "claude-code", "FEIN_ASK_PROVIDER pins it");
  delete process.env.ANTHROPIC_API_KEY; delete process.env.FEIN_ASK_PROVIDER;

  ok(foldTranscript([{ role: "user", content: "hi" }]) === "hi", "a single turn is the prompt");
  const folded = foldTranscript([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
  ok(folded.startsWith("Earlier in this conversation") && folded.endsWith("c") && folded.includes("Assistant: b"), "history folds into the prompt", folded);
  const ce = childEnv({ PATH: "/bin", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_OAUTH_TOKEN: "oat", CLAUDE_CODE_ENTRYPOINT: "cli" });
  ok(ce.PATH === "/bin" && ce.CLAUDE_CODE_OAUTH_TOKEN === "oat" && !("CLAUDE_CODE_SESSION_ID" in ce) && !("CLAUDE_CODE_ENTRYPOINT" in ce),
    "the child keeps the token, drops the parent session's identity", ce);

  const opts = claudeCodeOptions({ systemText: "SYS", contextText: "CTX", mcpUrl: "http://127.0.0.1:1/mcp?as=m1", mcpAuth: "tok", model: "claude-opus-5", effort: "low", maxTurns: 10 });
  ok(opts.systemPrompt.type === "custom" && opts.systemPrompt.prompt[0] === "SYS", "custom system prompt replaces Claude Code's");
  ok(opts.mcpServers.fein.type === "http" && opts.mcpServers.fein.url.endsWith("?as=m1") && opts.mcpServers.fein.headers.Authorization === "Bearer tok", "graph over loopback MCP with the token and the viewer", opts.mcpServers);
  ok(opts.allowedTools[0] === "mcp__fein__*" && opts.disallowedTools.includes("Bash") && opts.disallowedTools.includes("ToolSearch"), "only graph tools allowed, tool search off");
  ok(opts.mcpServers.fein.alwaysLoad === true, "graph tools load in the first prompt, never deferred");
  ok(opts.permissionMode === "bypassPermissions" && opts.allowDangerouslySkipPermissions && opts.strictMcpConfig && opts.persistSession === false && opts.includePartialMessages, "headless, strict, streaming, no session files");
  ok(opts.effort === "low" && opts.model === "claude-opus-5" && opts.maxTurns === 10, "model, effort and turn cap pass through");

  // A scripted SDK stream: init → tool_use → tool_result → text deltas → result.
  const script = [
    { type: "system", subtype: "init", mcp_servers: [{ name: "fein", status: "connected" }], tools: ["mcp__fein__guest_league"], model: "claude-opus-5" },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t0", name: "ToolSearch", input: { query: "x" } }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t0", content: "" }] } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "mcp__fein__guest_league", input: { sort: "most_attended" } }] } },
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: JSON.stringify({ guests: [{ name: "Alex" }] }) }] }] } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Alex " } } },
    { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "leads." } } },
    { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Alex leads." }] } },
    { type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 1200, total_cost_usd: 0.01, result: "Alex leads.", usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  let seen = null;
  const queryFn = ({ prompt, options }) => { seen = { prompt, options }; const it = (async function* () { for (const m of script) yield m; })(); it.close = () => {}; return it; };
  const events = [];
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat";
  const answer = await ask(db, {
    messages: [{ role: "user", content: "who leads?" }], viewerRef: jess.id, viewerName: "Jess Webber", asker: "Jess Webber",
    onEvent: (t, d) => events.push([t, d]), queryFn, mcpUrl: "http://127.0.0.1:9/mcp", mcpAuth: "tok",
    config: { model: "claude-opus-5", effort: "low", maxTokens: 1, maxIterations: 8, maxToolChars: 1, firm: "Ridgeline Capital", fallbacks: true, provider: "claude-code" },
  });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  ok(answer === "Alex leads.", "answer assembled from stream deltas, not duplicated by the assistant message", answer);
  const types = events.map((e) => e[0]);
  ok(types.join() === "start,tool,tool_result,text,text,turn,done", "event order matches the API provider; Claude Code's own tools never surface", types);
  ok(events[0][1].provider === "claude-code", "start names the provider");
  ok(events[1][1].name === "guest_league" && events[2][1].summary === "1 guest" && events[2][1].ok, "tool names lose the mcp__fein__ prefix; receipts summarize", [events[1][1], events[2][1]]);
  ok(events.find((e) => e[0] === "turn")[1].costUsd === 0.01 && events.find((e) => e[0] === "turn")[1].turns === 2, "turn carries cost and turns");
  ok(seen.prompt === "who leads?" && seen.options.mcpServers.fein.url === `http://127.0.0.1:9/mcp?as=${jess.id}` && seen.options.systemPrompt.prompt[0].includes("Ridgeline Capital") && seen.options.systemPrompt.prompt[1].includes("Jess Webber"),
    "the SDK got the question, the viewer-scoped MCP url and the Fein prompt", { prompt: seen.prompt, url: seen.options.mcpServers.fein.url });

  // An error result becomes an error event.
  const bad = [{ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 8, duration_ms: 5, total_cost_usd: 0 }];
  const ev2 = [];
  await ask(db, { messages: [{ role: "user", content: "x" }], onEvent: (t, d) => ev2.push([t, d]), mcpUrl: "http://127.0.0.1:9/mcp",
    queryFn: () => { const it = (async function* () { for (const m of bad) yield m; })(); it.close = () => {}; return it; },
    config: { model: "m", effort: "low", maxTokens: 1, maxIterations: 8, maxToolChars: 1, firm: "F", fallbacks: true, provider: "claude-code" } });
  ok(ev2.at(-1)[0] === "error" && ev2.at(-1)[1].code === "error_max_turns", "max turns → error event", ev2.at(-1));
}

console.log("HTTP route:");
{
  process.env.FEIN_AUTH_TOKEN = "t0k";
  process.env.FEIN_HOST = "127.0.0.1";
  const { startWebServer } = await import(join(root, "src/web/server.js"));
  const port = 4600 + Math.floor(Math.random() * 300);
  const server = await startWebServer(port);
  const base = `http://127.0.0.1:${port}`;
  const H = { authorization: "Bearer t0k", "content-type": "application/json" };

  let r = await fetch(`${base}/api/ask/status`);
  ok(r.status === 401, "status needs the token");
  r = await fetch(`${base}/api/ask/status`, { headers: H });
  const st = await r.json();
  ok(r.status === 200 && st.configured === false && st.provider === "api" && st.credentials === "ambient" && st.firm === "Ridgeline Capital" && st.model === "claude-opus-5",
    "status reports not configured, the provider, the firm and the model", st);
  r = await fetch(`${base}/`, { headers: { authorization: "Bearer t0k" } });
  ok((await r.text()).includes('id="tiles"'), "the dashboard is the front door by default");
  r = await fetch(`${base}/dashboard`, { headers: { authorization: "Bearer t0k" } });
  ok(r.status === 200 && (await r.text()).includes('id="tiles"'), "…and always at /dashboard");
  r = await fetch(`${base}/ask`, { headers: { authorization: "Bearer t0k" } });
  ok(r.status === 200 && (await r.text()).includes("Ask the graph"), "the page is served behind auth");
  r = await fetch(`${base}/ask`, { redirect: "manual" });
  ok(r.status === 302, "…and redirects to login without it");
  r = await fetch(`${base}/api/ask`, { method: "POST", headers: H, body: JSON.stringify({ messages: [] }) });
  const text = await r.text();
  ok(r.status === 200 && r.headers.get("content-type").startsWith("text/event-stream") && /^event: error\ndata: /m.test(text)
    && text.includes("ask needs a question"), "an empty question is an SSE error event", text.slice(0, 200));
  r = await fetch(`${base}/api/ask?as=nobody@example.com`, { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  ok(r.status === 400, "an unknown ?as= member is refused before anything runs");
  r = await fetch(`${base}/api/ask`, { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  const t2 = await r.text();
  ok(/event: error/.test(t2) && /not_configured/.test(t2), "without credentials the stream ends in a not_configured error", t2.slice(0, 300));
  await new Promise((resolve) => server.close(resolve));
}

await db.close?.();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} ASK TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nASK TESTS PASSED");

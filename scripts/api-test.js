import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-api-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4977;
const BASE = `http://127.0.0.1:${PORT}`;

// Attio is mocked at the fetch boundary so the connector is covered without a
// live workspace; everything else falls through to the real fetch.
delete process.env.ATTIO_API_KEY;
const realFetch = globalThis.fetch;
const attioJson = (data) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => "" });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.attio.com")) return realFetch(url, opts);
  if (!(opts.headers?.authorization ?? "").includes("good-key")) {
    return { ok: false, status: 401, text: async () => "invalid token", json: async () => ({}) };
  }
  const b = opts.body ? JSON.parse(opts.body) : {};
  if (u.endsWith("/self")) {
    return { ok: true, status: 200, json: async () => ({ data: { workspace_name: "Test Workspace" } }), text: async () => "" };
  }
  if (u.includes("companies")) {
    return b.offset ? attioJson([]) : attioJson([{ id: { record_id: "co-1" }, values: { name: [{ value: "Nordwind Ventures" }] } }]);
  }
  if (u.includes("people")) {
    return b.offset ? attioJson([]) : attioJson([{ id: { record_id: "p-1" },
      values: { name: [{ full_name: "Maya Chen" }],
                email_addresses: [{ email_address: "maya@nordwind.vc" }],
                company: [{ target_record_id: "co-1" }] } }]);
  }
  if (u.includes("/notes")) {
    return u.includes("offset=500") ? attioJson([])
      : attioJson([{ id: { note_id: "n1" }, parent_record_id: "p-1", title: "Coffee re co-invest", created_at: "2026-07-01T00:00:00Z" }]);
  }
  return attioJson([]);
};

const { startWebServer } = await import(join(root, "src/web/server.js"));
const server = await startWebServer(PORT);

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};
const get = async (path) => {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const send = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log("[1/10] health, security, empty state");
{
  const h = await get("/api/health");
  check(h.status === 200 && h.body.ok === true && h.body.version, "health reports ok + version", h.body);
  const page = await fetch(BASE + "/");
  check(page.headers.get("content-security-policy")?.includes("default-src 'self'"), "CSP header on pages");
  const stats = await get("/api/stats");
  check(stats.body.documents === 0, "fresh database is empty", stats.body);
  const evil = await send("POST", "/api/sample", {}, { origin: "https://evil.example" });
  check(evil.status === 403, "cross-origin POST is refused", evil);
  const missing = await get("/api/nope");
  check(missing.status === 404, "unknown API route 404s");
}

console.log("[2/10] onboarding: load sample dataset");
{
  const res = await send("POST", "/api/sample", {}, { origin: BASE });
  // 16 seed docs + 22 fixtures (incl. the team) + Seb's 2 private emails.
  // sample.mbox / sample.ics / contacts.csv stay OUT — they're the live-drag demo.
  check(res.status === 200 && res.body.stats.documents === 40, "sample dataset loads (40 docs)", res.body.stats);
  check(res.body.stats.entities === 26, "sample resolves to 26 entities", res.body.stats);
  check(res.body.stats.pendingExtraction === 20, "fixture bodies are pending extraction", res.body.stats);
  check(res.body.members?.length === 2, "sample seeds the two-member team", res.body.members);
}

console.log("[3/10] read endpoints");
{
  const graph = await get("/api/graph");
  check(graph.body.nodes.length === 14 && graph.body.links.length > 5, "graph payload has people + links",
    { nodes: graph.body.nodes.length, links: graph.body.links.length });
  const search = await get("/api/search?q=maya");
  check(search.body.length >= 1 && search.body[0].canonical_name === "Maya Chen", "search finds Maya", search.body);
  const brief = await get(`/api/entity/${search.body[0].id}`);
  check(brief.body.entity && brief.body.connections.length > 0, "entity brief has connections");
  const dana = (await get("/api/search?q=dana")).body[0];
  const priya = (await get("/api/search?q=priya")).body[0];
  const path = await get(`/api/path?from=${dana.id}&to=${priya.id}`);
  check(path.body.path && path.body.path.path.length >= 2, "warm path resolves", path.body.path);
  check(Array.isArray(path.body.introducers), "introducers array present");
  const badPath = await get("/api/path?from=onlyone");
  check(badPath.status === 400, "missing param 400s", badPath);
  const docs = await get("/api/documents");
  // 40 ingested minus Seb's 2 private emails: the shared view counts what it may show.
  check(docs.body.total === 38 && docs.body.withheld === 2 && docs.body.sources.length >= 4,
    "documents breakdown by source, private layer withheld", { total: docs.body.total, withheld: docs.body.withheld });
}

console.log("[4/10] review flow + audit");
{
  const reviews = await get("/api/reviews");
  check(reviews.body.length === 1, "one pending review (M. Chen)", reviews.body.length);
  const bad = await send("POST", `/api/reviews/${reviews.body[0].id}`, { decision: "maybe" });
  check(bad.status === 400, "invalid decision 400s");
  const ok = await send("POST", `/api/reviews/${reviews.body[0].id}`, { decision: "accept" });
  check(ok.status === 200, "review accept succeeds");
  const audit = await get("/api/audit");
  check(audit.body.some((a) => a.action === "review_accept"), "audit trail records the decision",
    audit.body.map((a) => a.action));
}

console.log("[5/10] settings: customization rebuilds the graph");
{
  const before = await get("/api/settings");
  check(before.body.weights.meeting === 3 && before.body.halfLifeDays === 180, "default settings served", before.body);
  const beforeGraph = await get("/api/graph");
  const beforeStrength = Math.max(...beforeGraph.body.links.map((l) => l.strength));
  const res = await send("PUT", "/api/settings", { weights: { meeting: 10 }, saturation: 3 });
  check(res.status === 200 && res.body.settings.weights.meeting === 10, "settings saved", res.body.settings);
  const afterGraph = await get("/api/graph");
  const afterStrength = Math.max(...afterGraph.body.links.map((l) => l.strength));
  check(afterStrength > beforeStrength, "weight change strengthens edges",
    { before: beforeStrength, after: afterStrength });
  const invalid = await send("PUT", "/api/settings", { weights: { nonsense: 5 } });
  check(invalid.status === 400, "unknown weight is rejected with 400", invalid.status);
  check(/unknown weight/.test(invalid.body?.error ?? ""), "client error message is preserved", invalid.body);

  // `?as=` on a write names the audit actor (display name, never an id/email).
  const tom = (await get("/api/members")).body.find((m) => m.name === "Tom Merrill");
  const asTom = await send("PUT", `/api/settings?as=${tom.id}`, { weights: { meeting: 10 } });
  check(asTom.status === 200, "settings PUT accepts ?as", asTom.status);
  const audit = await get("/api/audit");
  const row = audit.body.find((a) => a.action === "settings_update");
  check(row?.actor === "Tom Merrill", "the ?as viewer is recorded as the audit actor", row);
}

console.log("[6/10] hostile input");
{
  // Malformed request targets must not crash the process.
  for (const target of ["//%ff", "//[", "//:", "//%c0%ae", "//"]) {
    await fetch(BASE + target).catch(() => {});
  }
  const alive = await get("/api/health");
  check(alive.status === 200, "server survives malformed request targets", alive.status);

  // Prototype-named document kinds must not poison scoring or the graph.
  const poison = JSON.stringify({
    source: "local", kind: "toString", external_id: "poison-1",
    title: "prototype probe", occurred_at: "2026-08-01T00:00:00Z",
    people: [{ name: "Maya Chen", email: "maya@nordwind.vc", role: "from" },
             { name: "Dana Whitfield", email: "dana@foxglove.vc", role: "to" }],
  });
  const pRes = await send("POST", "/api/ingest?name=poison.jsonl", poison);
  check(pRes.status === 200, "prototype-named kind ingests without error", pRes.status);
  const g = await get("/api/graph");
  const bad = g.body.links.filter((l) => !Number.isFinite(l.strength));
  check(bad.length === 0, "no non-finite edge strengths after prototype probe", bad);
  check(g.body.links.length > 5, "relationships survive the prototype probe", g.body.links.length);

  const protoWeight = await send("PUT", "/api/settings", { weights: { toString: 9 } });
  check(protoWeight.status === 400, "prototype-named weight is rejected with 400", protoWeight);
}

console.log("[7/10] attio connector (mocked workspace)");
{
  check((await get("/api/connectors/attio")).body.connected === false, "starts disconnected");
  const bad = await send("POST", "/api/connectors/attio", { apiKey: "wrong" });
  check(bad.status === 400 && /rejected/i.test(bad.body.error), "bad key rejected with a useful message", bad.body);
  check((await get("/api/connectors/attio")).body.connected === false, "a failed connect stores nothing");

  const ok = await send("POST", "/api/connectors/attio", { apiKey: "good-key-abcd1234" });
  check(ok.status === 200 && ok.body.connected, "valid key connects", ok.body);
  check(ok.body.keyHint === "····1234" && !JSON.stringify(ok.body).includes("good-key-abcd1234"),
    "only a masked hint is returned, never the key", ok.body.keyHint);

  const sync = await send("POST", "/api/connectors/attio/sync");
  check(sync.status === 200 && sync.body.ingested.docCount === 3, "sync ingests people, companies and notes", sync.body.ingested);
  const maya = (await get("/api/search?q=maya")).body[0];
  check(maya?.emails.includes("maya@nordwind.vc"), "Attio contact merges with the existing person", maya?.emails);

  const audit = await get("/api/audit");
  check(!JSON.stringify(audit.body).includes("good-key"), "the key never reaches the audit log");
  const gone = await send("DELETE", "/api/connectors/attio");
  check(gone.body.connected === false, "disconnect clears the key", gone.body);
  const docs = await get("/api/documents");
  check(docs.body.sources.some((s) => s.source === "attio"), "disconnect keeps ingested data");
}

console.log("[8/10] upload + reresolve");
{
  const csv = readFileSync(join(root, "sample/contacts.csv"), "utf8");
  const up = await send("POST", "/api/ingest?name=contacts.csv", csv);
  check(up.status === 200 && up.body.ingested.docCount === 3, "csv upload ingests", up.body.ingested);
  const badUp = await send("POST", "/api/ingest?name=evil.exe", "MZ");
  check(badUp.status === 400, "unsupported upload type 400s", badUp.status);
  const rr = await send("POST", "/api/reresolve", {});
  check(rr.status === 200, "reresolve succeeds", rr.status);
  check(rr.body.replayed === 1 && (rr.body.dropped ?? []).length === 0,
    "the accepted review decision is replayed, not lost", { replayed: rr.body.replayed, dropped: rr.body.dropped });
  const maya = (await get("/api/search?q=maya")).body[0];
  check(maya.emails.includes("mchen@gmail.com"),
    "replayed accept restores the merged gmail alias", maya.emails);
  const post = await get("/api/reviews");
  check(post.body.length === 0, "no re-asked question after replay", post.body.length);
}

console.log("[9/10] privacy layers: one-click scene, private upload, scoping");
{
  const members = (await get("/api/members")).body;
  const tom = members.find((m) => m.name === "Tom Merrill");
  const seb = members.find((m) => m.name === "Seb Larkin");
  check(tom && seb, "the sample seeded the team", members.map((m) => m.name));
  const again = await send("POST", "/api/sample", {});
  check(again.status === 200 && (await get("/api/members")).body.length === members.length,
    "reloading the sample never duplicates members");

  const docs = await get("/api/documents");
  check(docs.body.withheld === 2, "Seb's two private documents are withheld from the shared view", docs.body.withheld);
  const sebDocs = await get(`/api/documents?as=${seb.id}`);
  check(!sebDocs.body.withheld, "nothing is withheld from their owner", sebDocs.body.withheld);

  const tomE = (await get("/api/search?q=tom")).body.find((e) => e.canonical_name === "Tom Merrill");
  const priyaE = (await get("/api/search?q=priya")).body[0];
  const path = await get(`/api/path?from=${tomE.id}&to=${priyaE.id}&as=${tom.id}`);
  check(path.body.path?.path?.length >= 2, "Tom has his own public route to Priya", path.body.path?.pathStrength);
  check(path.body.viaPrivate?.some((v) => v.owner === "Seb Larkin"),
    "\"ask a colleague\" names Seb without exposing evidence", path.body.viaPrivate);

  const secret = JSON.stringify({
    source: "local", kind: "note", external_id: "priv-tom-1", title: "ZARA-PRIVATE-MARKER",
    occurred_at: "2026-08-01T00:00:00Z",
    people: [{ name: "Tom Merrill", email: "tom@ridgeline.vc", role: "from" },
             { name: "Zara Quist", email: "zara@quist.example", role: "to" }],
  });
  const badAs = await send("POST", "/api/ingest?name=p.jsonl&as=nobody", secret);
  check(badAs.status === 400, "unknown member on private ingest is a hard 400", badAs.status);
  const up = await send("POST", `/api/ingest?name=zara-inbox.jsonl&as=${tom.id}`, secret);
  check(up.status === 200 && up.body.layer === "Tom Merrill", "upload lands in Tom's private layer", up.body.layer);
  const audit = await get("/api/audit");
  const row = audit.body.find((a) => a.detail?.layer === "Tom Merrill");
  check(row && row.detail.file === "(private upload)" && !JSON.stringify(audit.body).includes("zara-inbox"),
    "audit records whose layer grew, never the private filename", row?.detail);
  check(row?.actor === "Tom Merrill", "the private upload's audit row names the uploader as actor", row?.actor);
  const sharedGraph = await get("/api/graph");
  check(!sharedGraph.body.nodes.some((n) => n.name === "Zara Quist"),
    "a private-only person is hidden from the shared graph");
  const tomGraph = await get(`/api/graph?as=${tom.id}`);
  check(tomGraph.body.nodes.some((n) => n.name === "Zara Quist"), "her owner sees her");
}

console.log("[10/10] MCP over HTTP: one endpoint, viewer-scoped");
{
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const connect = async (qs = "") => {
    const client = new Client({ name: "api-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp${qs}`)));
    return client;
  };
  const asText = (r) => JSON.parse(r.content[0].text);

  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.length === 11 && tools.includes("meeting_prep") && tools.includes("company_memory"),
    "all 11 tools listed over HTTP", tools);
  const stats = asText(await client.callTool({ name: "graph_stats", arguments: {} }));
  check(stats.documents > 0, "graph_stats answers from the live database", stats.documents);
  const shared = asText(await client.callTool({ name: "entity_brief", arguments: { entity: "Priya Nair" } }));
  check(shared.withheldDocuments >= 2, "a shared-layer agent gets a withheld count, not content", shared.withheldDocuments);
  check(!JSON.stringify(shared).includes("Fund II allocation — timing question"),
    "private titles never reach the shared-layer agent");
  await client.close();

  const sebClient = await connect("?as=Seb%20Larkin");
  const own = asText(await sebClient.callTool({ name: "entity_brief", arguments: { entity: "Priya Nair" } }));
  check(JSON.stringify(own).includes("Fund II allocation — timing question"),
    "?as=Seb binds the agent to Seb's private layer");

  // An agent's decision is audited as agent:<member>. Exact name + conflicting
  // non-freemail domain scores 0.90 — deterministically in the review band.
  const seb = (await get("/api/members")).body.find((m) => m.name === "Seb Larkin");
  const rival = JSON.stringify({
    source: "local", kind: "email", external_id: "rival-1", title: "intro?",
    occurred_at: "2026-08-02T00:00:00Z",
    people: [{ name: "Maya Chen", email: "maya@rivalfund.example", role: "from" }],
  });
  const rIngest = await send("POST", "/api/ingest?name=rival.jsonl", rival);
  check(rIngest.status === 200 && rIngest.body.resolved.queued === 1,
    "conflicting-domain mention queues for review", rIngest.body.resolved);
  const review = (await get(`/api/reviews?as=${seb.id}`)).body
    .find((r) => r.mention_email === "maya@rivalfund.example");
  check(Boolean(review), "the queued review is visible to Seb's agent");
  await sebClient.callTool({ name: "review_resolve",
    arguments: { review_id: review.id, decision: "accept" } });
  const agentRow = (await get("/api/audit")).body
    .find((a) => a.action === "review_accept" && a.detail?.review === review.id);
  check(agentRow?.actor === "agent:Seb Larkin",
    "the MCP decision is audited as agent:<member>", agentRow);
  await sebClient.close();

  const rejected = await fetch(`${BASE}/mcp`);
  check(rejected.status === 405, "GET /mcp is refused (POST JSON-RPC only)", rejected.status);
  const badViewer = await send("POST", "/mcp?as=nobody", {});
  check(badViewer.status === 400, "unknown ?as member is a hard 400, never a silent fallback", badViewer.status);
}

server.close();
// Server holds the PGlite handle; give closes a beat, then clean up.
await new Promise((r) => setTimeout(r, 300));
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nAPI TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nAPI TESTS PASSED");
process.exit(0);

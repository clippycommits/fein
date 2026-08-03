import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fundgraph-api-"));
process.env.FUNDGRAPH_DATA = dataDir;
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

console.log("[1/8] health, security, empty state");
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

console.log("[2/8] onboarding: load sample dataset");
{
  const res = await send("POST", "/api/sample", {}, { origin: BASE });
  // 24 core docs + 20 extraction fixtures (sample/fixtures/*.jsonl, bodies included)
  check(res.status === 200 && res.body.stats.documents === 44, "sample dataset loads (44 docs)", res.body.stats);
  check(res.body.stats.entities === 23, "sample resolves to 23 entities", res.body.stats);
  check(res.body.stats.pendingExtraction === 20, "fixture bodies are pending extraction", res.body.stats);
}

console.log("[3/8] read endpoints");
{
  const graph = await get("/api/graph");
  check(graph.body.nodes.length === 12 && graph.body.links.length > 5, "graph payload has people + links",
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
  check(docs.body.total === 44 && docs.body.sources.length >= 4, "documents breakdown by source", docs.body.sources.map((s) => s.source));
}

console.log("[4/8] review flow + audit");
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

console.log("[5/8] settings: customization rebuilds the graph");
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
}

console.log("[6/8] hostile input");
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

console.log("[7/8] attio connector (mocked workspace)");
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

console.log("[8/8] upload + reresolve");
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

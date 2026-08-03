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

console.log("[1/6] health, security, empty state");
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

console.log("[2/6] onboarding: load sample dataset");
{
  const res = await send("POST", "/api/sample", {}, { origin: BASE });
  check(res.status === 200 && res.body.stats.documents === 24, "sample dataset loads (24 docs)", res.body.stats);
  check(res.body.stats.entities === 14, "sample resolves to 14 entities", res.body.stats);
}

console.log("[3/6] read endpoints");
{
  const graph = await get("/api/graph");
  check(graph.body.nodes.length === 8 && graph.body.links.length > 5, "graph payload has people + links",
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
  check(docs.body.total === 24 && docs.body.sources.length >= 4, "documents breakdown by source", docs.body.sources.map((s) => s.source));
}

console.log("[4/6] review flow + audit");
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

console.log("[5/6] settings: customization rebuilds the graph");
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
  check(invalid.status === 500 || invalid.status === 400, "unknown weight is rejected", invalid.status);
}

console.log("[6/6] upload + reresolve");
{
  const csv = readFileSync(join(root, "sample/contacts.csv"), "utf8");
  const up = await send("POST", "/api/ingest?name=contacts.csv", csv);
  check(up.status === 200 && up.body.ingested.docCount === 3, "csv upload ingests", up.body.ingested);
  const badUp = await send("POST", "/api/ingest?name=evil.exe", "MZ");
  check(badUp.status === 400, "unsupported upload type 400s", badUp.status);
  const rr = await send("POST", "/api/reresolve", {});
  check(rr.status === 200 && rr.body.stats.entities === 14, "reresolve rebuilds cleanly", rr.body.stats);
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

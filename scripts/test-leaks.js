import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir = mkdtempSync(join(tmpdir(), "fg-leak-"));
process.env.FEIN_DATA = dataDir;
// An ambient auth token would 401 every probe and pass this suite vacuously.
delete process.env.FEIN_AUTH_TOKEN;
delete process.env.FUNDGRAPH_AUTH_TOKEN;
import { dirname, join as pjoin } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = pjoin(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4993, BASE = `http://127.0.0.1:${PORT}`;

const { startWebServer } = await import(`${ROOT}/src/web/server.js`);
const server = await startWebServer(PORT);
const { getDb } = await import(`${ROOT}/src/db.js`);
const { addMember } = await import(`${ROOT}/src/members.js`);
const { ingestDocs } = await import(`${ROOT}/src/ingest/index.js`);
const { resolveMentions } = await import(`${ROOT}/src/resolve/pipeline.js`);
const { rebuildEdges } = await import(`${ROOT}/src/graph/edges.js`);
const db = await getDb();

const seb = await addMember(db, { name: "Seb Larkin", email: "seb@ridgeline.vc" });
const tom = await addMember(db, { name: "Tom Merrill", email: "tom@ridgeline.vc" });

// Shared doc so both people exist in the shared graph.
await ingestDocs(db, [{
  source: "calendar", kind: "event", external_id: "shared-1", title: "Partner sync",
  occurred_at: "2026-07-20T10:00:00Z",
  people: [{ name: "Seb Larkin", email: "seb@ridgeline.vc", role: "attendee" },
           { name: "Tom Merrill", email: "tom@ridgeline.vc", role: "attendee" }],
}]);
// Seb's private layer, stuffed with distinctive markers in every field.
await ingestDocs(db, [{
  source: "gmail", kind: "email", external_id: "priv-1",
  title: "SECRETTITLE Meridian terms",
  occurred_at: "2026-07-25T10:00:00Z",
  body: "SECRETBODY confidential allocation with SECRETPERSON at SECRETCOMPANY Ventures",
  people: [{ name: "Seb Larkin", email: "seb@ridgeline.vc", role: "from" },
           { name: "SECRETPERSON Nair", email: "secretperson@secretcompany.com", role: "to" }],
  orgs: ["SECRETCOMPANY Ventures"],
}], { owner: seb.id });
await resolveMentions(db);
await rebuildEdges(db);

const MARKERS = ["SECRETTITLE", "SECRETBODY", "SECRETCOMPANY", "SECRETPERSON"];
const endpoints = [
  "/api/stats", "/api/graph", "/api/documents", "/api/reviews", "/api/audit",
  "/api/radar", "/api/members", "/api/settings", "/api/search?q=secret",
  "/api/search?q=nair", "/api/extract/status",
];

let leaks = 0;
const probe = async (label, asParam) => {
  for (const ep of endpoints) {
    const url = BASE + ep + (asParam ? (ep.includes("?") ? "&" : "?") + asParam : "");
    const res = await fetch(url).catch(() => null);
    if (!res || res.status === 401) { leaks++; console.log(`  FAIL [${label}] ${ep} unreachable/401 — probe is vacuous`); continue; }
    const text = await res.text();
    for (const m of MARKERS) {
      if (text.includes(m)) { leaks++; console.log(`  LEAK [${label}] ${ep} contains ${m}`); }
    }
  }
  // Entity endpoints for every person, plus company memory.
  const ents = await fetch(`${BASE}/api/search?q=`).then((r) => r.json()).catch(() => []);
  for (const e of ents) {
    const url = `${BASE}/api/entity/${e.id}` + (asParam ? `?${asParam}` : "");
    const text = await fetch(url).then((r) => r.text()).catch(() => "");
    for (const m of MARKERS) {
      if (text.includes(m)) { leaks++; console.log(`  LEAK [${label}] /api/entity/${e.canonical_name} contains ${m}`); }
    }
  }
};

console.log("Probing as TOM (must see no marker):");
await probe("tom", `as=${tom.id}`);
console.log("Probing with NO viewer (shared layer only):");
await probe("shared", "");
console.log(leaks ? `\n${leaks} LEAK(S) FOUND` : "  no marker reached a viewer who shouldn't see it");

// A private-only person must not be reachable by direct id, and the graph
// payload must not carry links to ids that are not in its own node list.
{
  const sebSearch = await fetch(`${BASE}/api/search?q=secretperson&as=${seb.id}`).then((r) => r.json());
  const secretId = sebSearch[0]?.id;
  if (!secretId) { leaks++; console.log("  FAIL: owner cannot find their own private contact"); }
  else {
    for (const [label, asParam] of [["tom", `?as=${tom.id}`], ["shared", ""]]) {
      const res = await fetch(`${BASE}/api/entity/${secretId}${asParam}`);
      const text = await res.text();
      if (res.status !== 404 || MARKERS.some((m) => text.includes(m))) {
        leaks++; console.log(`  LEAK [${label}] /api/entity/<private-only id> answered (${res.status})`);
      }
    }
    const ownerRes = await fetch(`${BASE}/api/entity/${secretId}?as=${seb.id}`);
    if (ownerRes.status !== 200) { leaks++; console.log("  FAIL: owner blocked from their own private contact"); }
  }
  for (const [label, asParam] of [["tom", `?as=${tom.id}`], ["shared", ""]]) {
    const g = await fetch(`${BASE}/api/graph${asParam}`).then((r) => r.json());
    const ids = new Set(g.nodes.map((n) => n.id));
    const dangling = g.links.filter((l) => !ids.has(l.source) || !ids.has(l.target));
    if (dangling.length) { leaks++; console.log(`  LEAK [${label}] /api/graph has ${dangling.length} link(s) to hidden ids`); }
  }
  console.log("  ok  direct-id and graph-link probes done");
}

console.log("\nControl — as SEB (owner) markers SHOULD appear:");
let sebSees = 0;
for (const ep of ["/api/documents", "/api/reviews"]) {
  const text = await fetch(`${BASE}${ep}?as=${seb.id}`).then((r) => r.text());
  for (const m of MARKERS) if (text.includes(m)) sebSees++;
}
if (!sebSees) { leaks++; console.log("  FAIL: the owner sees nothing either — over-filtering, not privacy"); }
else console.log(`  ok  the owner still sees their own data (${sebSees} markers)`);

// The MCP endpoint is a read surface like any other — probe every tool with
// the same markers. Probe queries never contain a marker themselves, so any
// hit is a real leak, not an echo.
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const mcpClient = async (asParam) => {
  const client = new Client({ name: "leak-probe", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/mcp${asParam ? `?${asParam}` : ""}`)));
  return client;
};
const mcpProbe = async (label, asParam) => {
  const client = await mcpClient(asParam);
  const calls = [
    ["search_entities", { query: "secret" }],
    ["search_entities", { query: "secretperson" }],
    ["company_memory", { company: "secretcompany ventures" }],
    ["entity_brief", { entity: "secretperson@secretcompany.com" }],
    ["search_entities", { query: "nair" }],
    ["entity_brief", { entity: "Seb Larkin" }],
    ["strongest_connections", { entity: "Seb Larkin" }],
    ["meeting_prep", { entity: "Seb Larkin", me: "Tom Merrill" }],
    ["relationship_radar", {}],
    ["review_queue", {}],
    ["graph_stats", {}],
  ];
  for (const [name, args] of calls) {
    const text = JSON.stringify(
      await client.callTool({ name, arguments: args }).catch((e) => String(e)));
    for (const m of MARKERS) {
      if (text.includes(m)) { leaks++; console.log(`  LEAK [${label}] mcp:${name} contains ${m}`); }
    }
  }
  await client.close();
};
console.log("\nProbing MCP as TOM (must see no marker):");
await mcpProbe("tom", `as=${tom.id}`);
console.log("Probing MCP with NO viewer:");
await mcpProbe("shared", "");

console.log("Control — Seb's own MCP agent SHOULD see his layer:");
const sebAgent = await mcpClient(`as=${seb.id}`);
const own = JSON.stringify(
  await sebAgent.callTool({ name: "entity_brief", arguments: { entity: "Seb Larkin" } }));
if (!MARKERS.some((m) => own.includes(m))) {
  leaks++; console.log("  FAIL: the owner's agent sees nothing — over-filtering, not privacy");
} else console.log("  ok  the owner's MCP agent sees their own data");
await sebAgent.close();

server.close();
await new Promise((r) => setTimeout(r, 300));
rmSync(dataDir, { recursive: true, force: true });
console.log(leaks ? `\nLEAK TESTS FAILED: ${leaks}` : "\nLEAK TESTS PASSED");
process.exit(leaks ? 1 : 0);

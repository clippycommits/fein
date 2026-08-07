import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir = mkdtempSync(join(tmpdir(), "fg-leak-"));
process.env.FEIN_DATA = dataDir;
// An ambient DATABASE_URL would aim every marker write at a real database —
// getDb prefers it over the temp data dir.
delete process.env.DATABASE_URL;
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

// Shared doc so both people exist in the shared graph — Vera included, so the
// absorption case below attaches to an ALREADY-SHARED entity.
await ingestDocs(db, [{
  source: "calendar", kind: "event", external_id: "shared-1", title: "Partner sync",
  occurred_at: "2026-07-20T10:00:00Z",
  people: [{ name: "Seb Larkin", email: "seb@ridgeline.vc", role: "attendee" },
           { name: "Tom Merrill", email: "tom@ridgeline.vc", role: "attendee" },
           { name: "Vera Shared", email: "vera@known.com", role: "attendee" }],
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
// The absorption trap: Seb's private mail teaches resolution a fuller name,
// an org, and a second address for shared Vera. Exact-email (0.98) and
// exact-name-without-conflict (0.96, gmail is freemail so no domain conflict)
// both AUTO-attach — without the absorption policy these markers land in the
// shared entity record itself. Lowercase markers catch the normalized forms.
await ingestDocs(db, [{
  source: "gmail", kind: "email", external_id: "priv-2", title: "Vera intro",
  occurred_at: "2026-07-26T10:00:00Z",
  people: [{ name: "Seb Larkin", email: "seb@ridgeline.vc", role: "from" },
           { name: "Vera SECRETMIDDLE Shared", email: "vera@known.com",
             org: "SECRETEVORG Capital", role: "to" }],
}, {
  source: "gmail", kind: "email", external_id: "priv-3", title: "Vera follow-up",
  occurred_at: "2026-07-27T10:00:00Z",
  people: [{ name: "Seb Larkin", email: "seb@ridgeline.vc", role: "from" },
           { name: "Vera Shared", email: "secretevidence@gmail.com", role: "to" }],
}], { owner: seb.id });
// The reverse-order trap: the private layer sees Nolan FIRST (priv-4, 07-24),
// the shared CRM only later (shared-2, 07-28). Resolution processes mentions
// by occurred_at, so the entity is created private-first and the shared
// witness attaches second — the moment it becomes visible, the privately-
// witnessed middle name must not ride along as its canonical name.
await ingestDocs(db, [{
  source: "gmail", kind: "email", external_id: "priv-4", title: "Nolan terms",
  occurred_at: "2026-07-24T10:00:00Z",
  people: [{ name: "Seb Larkin", email: "seb@ridgeline.vc", role: "from" },
           { name: "Nolan SECRETMIDDLE Pike", email: "nolan@pike.example", role: "to" }],
}], { owner: seb.id });
await ingestDocs(db, [{
  source: "crm", kind: "record", external_id: "shared-2", title: "Contact: Nolan Pike",
  occurred_at: "2026-07-28T10:00:00Z",
  people: [{ name: "Nolan Pike", email: "nolan@pike.example", role: "mentioned" }],
}]);
await resolveMentions(db);
await rebuildEdges(db);

// A human override on a private-only entity writes an audit row, and
// /api/audit is a global surface — the probes below sweep it for markers.
{
  const { setAutomated } = await import(`${ROOT}/src/resolve/automated.js`);
  const { rows: [secret] } = await db.query(
    `select id from entities where canonical_name like '%SECRETPERSON%'`);
  await setAutomated(db, secret.id, true, { actor: "Seb Larkin" });
}

const MARKERS = ["SECRETTITLE", "SECRETBODY", "SECRETCOMPANY", "SECRETPERSON",
  "SECRETMIDDLE", "secretmiddle", "secretevidence@", "SECRETEVORG", "secretevorg"];
const endpoints = [
  "/api/stats", "/api/graph", "/api/documents", "/api/reviews", "/api/audit",
  "/api/radar", "/api/members", "/api/settings", "/api/search?q=secret",
  "/api/search?q=nair", "/api/search?q=secretevidence", "/api/search?q=secretmiddle",
  "/api/extract/status",
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

  // The leaked-id escalation: a non-owner must not be able to merge a hidden
  // entity — the 200 body would both mutate across layers and echo the hidden
  // canonical name.
  if (secretId) {
    const vera = (await fetch(`${BASE}/api/search?q=vera`).then((r) => r.json()))[0];
    for (const [label, qs] of [["tom", `?as=${tom.id}`], ["shared", ""]]) {
      const res = await fetch(`${BASE}/api/merge${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keep: vera.id, lose: secretId }),
      });
      const text = await res.text();
      if (res.status !== 404 || MARKERS.some((m) => text.includes(m))) {
        leaks++; console.log(`  LEAK [${label}] /api/merge accepted a hidden id (${res.status})`);
      }
    }
    console.log("  ok  a hidden id cannot be merged by a non-owner");
  }
}

// The private-first ordering case: Nolan's canonical name must be the
// shared-witnessed form, not the privately-witnessed one it started with.
{
  const nolan = (await fetch(`${BASE}/api/search?q=nolan`).then((r) => r.json()))[0];
  if (!nolan) { leaks++; console.log("  FAIL: shared person Nolan not found"); }
  else if (nolan.canonical_name !== "Nolan Pike") {
    leaks++; console.log(`  LEAK private-first canonical name survived the shared witness: ${nolan.canonical_name}`);
  } else console.log("  ok  private-first name re-derived at the first shared witness");
}

// The absorption case explicitly: private evidence auto-attached to the
// already-shared Vera must not reach the shared row, its search index, or her
// display name — while the owner's overlay still carries all of it.
{
  const vera = (await fetch(`${BASE}/api/search?q=vera`).then((r) => r.json()))[0];
  if (!vera) { leaks++; console.log("  FAIL: shared person Vera not found"); }
  else {
    if (vera.canonical_name !== "Vera Shared") {
      leaks++; console.log(`  LEAK canonical name upgraded from a private mailbox: ${vera.canonical_name}`);
    }
    for (const [label, asParam] of [["tom", `?as=${tom.id}`], ["shared", ""]]) {
      const text = await fetch(`${BASE}/api/entity/${vera.id}${asParam}`).then((r) => r.text());
      for (const m of ["SECRETMIDDLE", "secretmiddle", "secretevidence@", "secretevorg"]) {
        if (text.includes(m)) { leaks++; console.log(`  LEAK [${label}] Vera's brief carries absorbed ${m}`); }
      }
    }
    for (const [label, qs] of [["tom", `&as=${tom.id}`], ["shared", ""]]) {
      const hits = await fetch(`${BASE}/api/search?q=secretevidence${qs}`).then((r) => r.json());
      if (hits.length) { leaks++; console.log(`  LEAK [${label}] search finds a privately-absorbed address`); }
    }
    const ownHits = await fetch(`${BASE}/api/search?q=secretevidence&as=${seb.id}`).then((r) => r.json());
    if (ownHits.length !== 1 || ownHits[0].id !== vera.id) {
      leaks++; console.log("  FAIL: the owner cannot search their own absorbed address — over-filtering");
    }
    const own = await fetch(`${BASE}/api/entity/${vera.id}?as=${seb.id}`).then((r) => r.text());
    if (["secretmiddle", "secretevidence@", "secretevorg"].some((m) => !own.includes(m))) {
      leaks++; console.log("  FAIL: the owner's overlay is missing their own absorbed evidence");
    } else console.log("  ok  absorbed private evidence stays with its owner");
  }
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
    ["search_entities", { query: "secretevidence" }],
    ["entity_brief", { entity: "Vera Shared" }],
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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir = mkdtempSync(join(tmpdir(), "fg-leak-"));
process.env.FUNDGRAPH_DATA = dataDir;
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

const MARKERS = ["SECRETTITLE", "SECRETBODY", "SECRETCOMPANY"];
const endpoints = [
  "/api/stats", "/api/graph", "/api/documents", "/api/reviews", "/api/audit",
  "/api/radar", "/api/members", "/api/settings", "/api/search?q=secret",
  "/api/search?q=nair", "/api/extract/status",
];

let leaks = 0;
const probe = async (label, asParam) => {
  for (const ep of endpoints) {
    const url = BASE + ep + (asParam ? (ep.includes("?") ? "&" : "?") + asParam : "");
    const text = await fetch(url).then((r) => r.text()).catch((e) => `ERR ${e.message}`);
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

console.log("\nControl — as SEB (owner) markers SHOULD appear:");
let sebSees = 0;
for (const ep of ["/api/documents", "/api/reviews"]) {
  const text = await fetch(`${BASE}${ep}?as=${seb.id}`).then((r) => r.text());
  for (const m of MARKERS) if (text.includes(m)) sebSees++;
}
if (!sebSees) { leaks++; console.log("  FAIL: the owner sees nothing either — over-filtering, not privacy"); }
else console.log(`  ok  the owner still sees their own data (${sebSees} markers)`);

server.close();
await new Promise((r) => setTimeout(r, 300));
rmSync(dataDir, { recursive: true, force: true });
console.log(leaks ? `\nLEAK TESTS FAILED: ${leaks}` : "\nLEAK TESTS PASSED");
process.exit(leaks ? 1 : 0);

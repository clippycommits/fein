import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fundgraph-smoke-"));
process.env.FUNDGRAPH_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { loadJsonl } = await import(join(root, "src/ingest/local.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { listReviews, resolveReview } = await import(join(root, "src/resolve/review.js"));
const { rebuildEdges } = await import(join(root, "src/graph/edges.js"));
const { findWarmPath, findIntroducers } = await import(join(root, "src/graph/paths.js"));
const { searchEntities, entityBrief, counts } = await import(join(root, "src/graph/queries.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

const db = await getDb();

console.log("[1/9] ingest");
const ing = await ingestDocs(db, loadJsonl(join(root, "sample/seed.jsonl")));
check(ing.docCount === 16, `ingested 16 docs`, ing);

console.log("[2/9] resolve");
const res = await resolveMentions(db);
const c1 = await counts(db);
check(c1.entities === 12, `12 entities (7 people + 5 orgs)`, c1);
check(c1.pendingReviews === 1, `1 pending review (M. Chen from gmail)`, c1);
const sams = await searchEntities(db, "okafor");
check(sams.length === 1, `"Sam Okafor" and "Samuel Okafor" merged via email`, sams);

console.log("[3/9] edges");
const edg = await rebuildEdges(db);
check(edg.edges > 5, `built ${edg.edges} edges`);

console.log("[4/9] paths");
const [dana] = await searchEntities(db, "dana whitfield");
const [priya] = await searchEntities(db, "priya nair");
const [maya] = await searchEntities(db, "maya chen");
check(dana && priya && maya, "found dana/priya/maya entities");
const path = await findWarmPath(db, dana.id, priya.id);
check(path && path.path.length === 3, "warm path Dana→Priya has 3 nodes", path);
check(path && path.path[1].entity === maya.id, "path routes via Maya", path);
const intros = await findIntroducers(db, dana.id, priya.id);
check(intros.length >= 2 && intros[0].entity === maya.id, "Maya is top introducer", intros);
const brief = await entityBrief(db, maya.id);
check(brief.connections.length >= 3 && brief.recentDocuments.length > 0, "Maya brief has connections + docs");

console.log("[5/9] review queue");
const reviews = await listReviews(db);
check(reviews.length === 1 && reviews[0].mention_email === "mchen@gmail.com", "review is the gmail alias", reviews);
await resolveReview(db, reviews[0].id, "accept");
const [maya2] = await searchEntities(db, "maya chen");
check(maya2.emails.length === 2 && maya2.emails.includes("mchen@gmail.com"),
  "accepting review adds gmail alias to Maya", maya2);
const c2 = await counts(db);
check(c2.unresolvedMentions === 0, "no unresolved mentions after review", c2);

console.log("[6/9] re-ingest idempotency");
await ingestDocs(db, loadJsonl(join(root, "sample/seed.jsonl")));
const res2 = await resolveMentions(db);
const c3 = await counts(db);
check(c3.entities === 12, "re-ingest + re-resolve creates no new entities", c3);
check(c3.pendingReviews === 0, "re-ingest re-asks no answered questions", c3);
check(c3.unresolvedMentions === 0, "all re-ingested mentions resolve", { c3, res2 });

console.log("[7/9] reversed-name blocking");
await ingestDocs(db, [{
  source: "crm", kind: "record", external_id: "crm-099",
  title: "Contact: Whitfield, Dana", occurred_at: "2026-08-01T00:00:00Z",
  people: [{ name: "Whitfield, Dana", org: "Foxglove Capital", role: "mentioned" }],
}]);
await resolveMentions(db);
const c4 = await counts(db);
check(c4.entities === 12, "'Whitfield, Dana' attaches to Dana, no duplicate entity", c4);
check(c4.unresolvedMentions === 0 && c4.pendingReviews === 0, "reversed name auto-attached", c4);

console.log("[8/9] multi-source adapters (mbox / ics / csv)");
{
  const { loadMbox } = await import(join(root, "src/ingest/mbox.js"));
  const { loadIcs } = await import(join(root, "src/ingest/ics.js"));
  const { loadCsv } = await import(join(root, "src/ingest/csv.js"));
  const mbox = loadMbox(join(root, "sample/sample.mbox"));
  check(mbox.length === 3, "mbox parses 3 messages", mbox.length);
  check(mbox[0].people.some((p) => p.name === "Chen, Maya"), "mbox parses quoted display names", mbox[0].people);
  check(mbox[0].people.some((p) => p.name === "Elena Ruiz"), "mbox decodes RFC 2047 names", mbox[0].people);
  const ics = loadIcs(join(root, "sample/sample.ics"));
  check(ics.length === 2 && ics[0].people.length === 4, "ics parses events + attendees", ics);
  const csv = loadCsv(join(root, "sample/contacts.csv"));
  check(csv.length === 3, "csv parses 3 contacts", csv);
  await ingestDocs(db, [...mbox, ...ics, ...csv]);
  await resolveMentions(db);
  const c5 = await counts(db);
  // Only Theo Marchetti + CasselBlu Advisors are new: everyone else must
  // resolve to existing entities across all three formats.
  check(c5.entities === 14, "cross-source resolution: only Theo + CasselBlu are new", c5);
  check(c5.pendingReviews === 0 && c5.unresolvedMentions === 0, "no reviews or strays from adapters", c5);

  // A person first seen as a bare address must pick up their display name later.
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "up-1", title: "bare address",
      occurred_at: "2026-08-01T00:00:00Z",
      people: [{ email: "kai@vellum.fund", role: "from" },
               { name: "Dana Whitfield", email: "dana@foxglove.vc", role: "to" }] },
    { source: "gmail", kind: "email", external_id: "up-2", title: "named",
      occurred_at: "2026-08-02T00:00:00Z",
      people: [{ name: "Kai Tanaka", email: "kai@vellum.fund", role: "from" },
               { name: "Dana Whitfield", email: "dana@foxglove.vc", role: "to" }] },
  ]);
  await resolveMentions(db);
  const [kai] = await searchEntities(db, "vellum.fund");
  check(kai?.canonical_name === "Kai Tanaka", "email-only entity upgrades to display name", kai);
}

console.log("[9/9] hop-budget pathfinding");
// Cheap 4-hop chain A-B-C-D-E must not shadow the 2-hop route to E: with
// maxHops=4 the only viable path to T is A->G->E->T (3 hops).
const syn = [
  ["syn_A", "syn_B", 0.99], ["syn_B", "syn_C", 0.99], ["syn_C", "syn_D", 0.99],
  ["syn_D", "syn_E", 0.99], ["syn_A", "syn_G", 0.5], ["syn_E", "syn_G", 0.5],
  ["syn_E", "syn_T", 0.9],
];
for (const [a, b, s] of syn) {
  await db.query(`insert into edges (a, b, signals, strength) values ($1, $2, '{}', $3)`, [a, b, s]);
}
const synPath = await findWarmPath(db, "syn_A", "syn_T", 4);
check(synPath !== null, "hop-bounded path is found despite cheaper long chain", synPath);
check(synPath && synPath.path.map((s) => s.entity).join(">") === "syn_A>syn_G>syn_E>syn_T",
  "path routes A>G>E>T", synPath?.path.map((s) => s.entity));

await db.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nSMOKE FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");

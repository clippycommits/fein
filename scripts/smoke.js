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

console.log("[1/5] ingest");
const ing = await ingestDocs(db, loadJsonl(join(root, "sample/seed.jsonl")));
check(ing.docCount === 16, `ingested 16 docs`, ing);

console.log("[2/5] resolve");
const res = await resolveMentions(db);
const c1 = await counts(db);
check(c1.entities === 12, `12 entities (7 people + 5 orgs)`, c1);
check(c1.pendingReviews === 1, `1 pending review (M. Chen from gmail)`, c1);
const sams = await searchEntities(db, "okafor");
check(sams.length === 1, `"Sam Okafor" and "Samuel Okafor" merged via email`, sams);

console.log("[3/5] edges");
const edg = await rebuildEdges(db);
check(edg.edges > 5, `built ${edg.edges} edges`);

console.log("[4/5] paths");
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

console.log("[5/5] review queue");
const reviews = await listReviews(db);
check(reviews.length === 1 && reviews[0].mention_email === "mchen@gmail.com", "review is the gmail alias", reviews);
await resolveReview(db, reviews[0].id, "accept");
const [maya2] = await searchEntities(db, "maya chen");
check(maya2.emails.length === 2 && maya2.emails.includes("mchen@gmail.com"),
  "accepting review adds gmail alias to Maya", maya2);
const c2 = await counts(db);
check(c2.unresolvedMentions === 0, "no unresolved mentions after review", c2);

await db.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nSMOKE FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");

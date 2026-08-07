import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-merge-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { rebuildEdges, rebuildEdgesFor } = await import(join(root, "src/graph/edges.js"));
const { mergeEntities, unmergeEntity, listMerges } = await import(join(root, "src/resolve/merge.js"));
const { reresolveAll } = await import(join(root, "src/resolve/reresolve.js"));
const { searchEntities, entityBrief, counts } = await import(join(root, "src/graph/queries.js"));
const { listAudit, putSettings } = await import(join(root, "src/settings.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

const db = await getDb();
// Two identities the resolver deliberately keeps apart: same person, different
// work domains and no shared name form.
await ingestDocs(db, [
  { source: "gmail", kind: "email", external_id: "m1", title: "from work",
    occurred_at: "2026-07-01T10:00:00Z",
    people: [{ name: "Alex Rivera", email: "alex@ridgeline.vc", role: "from" },
             { name: "Maya Chen", email: "maya@nordwind.vc", role: "to" }] },
  { source: "gmail", kind: "email", external_id: "m2", title: "from side project",
    occurred_at: "2026-07-02T10:00:00Z",
    people: [{ name: "A. Rivera", email: "alex@northgate.io", role: "from" },
             { name: "Priya Nair", email: "priya@meridian.co.uk", role: "to" }] },
]);
await resolveMentions(db);
// The resolver isn't sure these are the same person (same-ish name, different
// work domains) so it asks. The human says "different people" — and only later
// realises they were wrong. That reject-then-merge path is exactly what manual
// merge exists for.
const { listReviews, resolveReview } = await import(join(root, "src/resolve/review.js"));
for (const r of await listReviews(db)) await resolveReview(db, r.id, "reject");
await resolveMentions(db);
await rebuildEdges(db);

const find = async (q) => (await searchEntities(db, q)).filter((e) => e.kind === "person");

console.log("[1/4] merge unifies identity and evidence");
const before = await counts(db);
const work = (await find("alex@ridgeline.vc"))[0];
const side = (await find("alex@northgate.io"))[0];
check(work && side && work.id !== side.id, "the two identities start separate", { work: work?.id, side: side?.id });

const merged = await mergeEntities(db, work.id, side.id, { actor: "Tom Merrill" });
// The incremental path is what the API and CLI use after a merge — the
// survivor-inherits-connections assertions below exercise it, not the full rebuild.
await rebuildEdgesFor(db, [work.id, side.id]);
check(merged.emails.includes("alex@ridgeline.vc") && merged.emails.includes("alex@northgate.io"),
  "both addresses land on the survivor", merged.emails);
const mergeRow = (await listAudit(db)).find((a) => a.action === "entity_merge");
check(mergeRow?.actor === "Tom Merrill", "the merge audit row names its actor", mergeRow);
const after = await counts(db);
check(after.entities === before.entities - 1, "live entity count drops by one", { before: before.entities, after: after.entities });

const brief = await entityBrief(db, work.id);
const names = brief.connections.map((c) => c.name);
check(names.includes("Maya Chen") && names.includes("Priya Nair"),
  "the survivor inherits both sides' relationships", names);
const afterMerge = await find("alex@northgate.io");
check(afterMerge.length === 1 && afterMerge[0].id === work.id,
  "searching the absorbed address now finds the survivor, not a duplicate", afterMerge.map((e) => e.id));

console.log("[2/4] merges are recorded and reversible");
{
  const merges = await listMerges(db);
  check(merges.length === 1 && merges[0].kept_id === work.id, "the merge is listed", merges);
  await unmergeEntity(db, side.id, { actor: "Tom Merrill" });
  await rebuildEdges(db);
  const unmergeRow = (await listAudit(db)).find((a) => a.action === "entity_unmerge");
  check(unmergeRow?.actor === "Tom Merrill", "the unmerge audit row names its actor", unmergeRow);
  const restoredHits = await find("alex@northgate.io");
  check(restoredHits.length === 1 && restoredHits[0].id === side.id,
    "unmerge restores the entity and the survivor stops claiming its address",
    restoredHits.map((e) => ({ id: e.id, emails: e.emails })));
  const restored = restoredHits[0];
  const rBrief = await entityBrief(db, restored.id);
  check(rBrief.connections.some((c) => c.name === "Priya Nair"),
    "and its own mentions come back with it", rBrief.connections.map((c) => c.name));
  const wBrief = await entityBrief(db, work.id);
  check(!wBrief.connections.some((c) => c.name === "Priya Nair"),
    "the survivor gives them up", wBrief.connections.map((c) => c.name));
}

console.log("[3/4] a merge survives a full rebuild");
{
  await mergeEntities(db, work.id, side.id);
  await rebuildEdges(db);
  const result = await reresolveAll(db, { actor: "Tom Merrill" });
  check(result.merges.replayed === 1, "reresolve replays the manual merge", result.merges);
  check(result.merges.dropped.length === 0, "nothing dropped", result.merges.dropped);
  const audit = await listAudit(db);
  const rrRow = audit.find((a) => a.action === "reresolve");
  check(rrRow?.actor === "Tom Merrill", "the reresolve audit row names its actor", rrRow);
  check(audit.some((a) => a.action === "review_reject" && a.actor === "Tom Merrill"),
    "replayed review decisions are re-audited under the replaying actor",
    audit.filter((a) => a.action === "review_reject").map((a) => a.actor));
  const live = await find("daniel");
  check(live.length === 1, "the two identities are still one person after rebuild",
    live.map((e) => e.emails));
  check(live[0].emails.includes("alex@northgate.io") && live[0].emails.includes("alex@ridgeline.vc"),
    "with both addresses intact", live[0].emails);
}

console.log("[4/4] guard rails");
{
  const maya = (await find("maya"))[0];
  await db.query(`insert into entities (id, kind, canonical_name) values ('org_x', 'org', 'Nordwind Ventures')`);
  let threw = null;
  try { await mergeEntities(db, maya.id, "org_x"); } catch (e) { threw = e.message; }
  check(/cannot merge a org into a person/.test(threw ?? ""), "kinds can't be mixed", threw);
  threw = null;
  try { await mergeEntities(db, maya.id, maya.id); } catch (e) { threw = e.message; }
  check(/itself/.test(threw ?? ""), "an entity can't be merged into itself", threw);
  threw = null;
  try { await unmergeEntity(db, maya.id); } catch (e) { threw = e.message; }
  check(/not merged/.test(threw ?? ""), "unmerging a live entity is refused", threw);
}

console.log("[5/5] resolution thresholds are settings, not constants");
{
  const maya = (await find("maya"))[0];
  // With defaults, an exact email match (score 0.98) auto-attaches.
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "th-1", title: "threshold check",
      occurred_at: "2026-07-05T10:00:00Z",
      people: [{ name: "Maya Chen", email: "maya@nordwind.vc", role: "from" }] },
  ]);
  const attached = await resolveMentions(db);
  check(attached.attached === 1 && attached.queued === 0,
    "with default thresholds an exact email match auto-attaches", attached);

  // Raise the bar above 0.98: the SAME evidence now asks a human instead.
  await putSettings(db, { resolution: { autoMerge: 0.99, review: 0.9 } });
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "th-2", title: "threshold check 2",
      occurred_at: "2026-07-06T10:00:00Z",
      people: [{ name: "Maya Chen", email: "maya@nordwind.vc", role: "from" }] },
  ]);
  const queued = await resolveMentions(db);
  check(queued.queued === 1 && queued.attached === 0,
    "a raised auto-merge bar sends the same match to review", queued);
  const { rows: pending } = await db.query(
    `select m.entity_id from mentions m join documents d on d.id = m.document_id
     where d.external_id = 'th-2'`);
  check(pending[0].entity_id === null, "the mention stays unattached while the question is pending", pending);

  // Restore defaults and answer the queued question so nothing dangles.
  await putSettings(db, { resolution: { autoMerge: 0.95, review: 0.7 } });
  const q = (await listReviews(db)).find((r) => r.mention_email === "maya@nordwind.vc");
  const resolved = await resolveReview(db, q.id, "accept");
  check(resolved.entity === maya.id, "accepting attaches to Maya after all", resolved);
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\nMERGE TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nMERGE TESTS PASSED");

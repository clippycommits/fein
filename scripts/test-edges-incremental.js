import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-incr-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { rebuildEdges, rebuildEdgesFor } = await import(join(root, "src/graph/edges.js"));
const { mergeEntities, unmergeEntity } = await import(join(root, "src/resolve/merge.js"));
const { listReviews, resolveReview } = await import(join(root, "src/resolve/review.js"));
const { strongestConnections } = await import(join(root, "src/graph/paths.js"));
const { searchEntities } = await import(join(root, "src/graph/queries.js"));
const { addMember } = await import(join(root, "src/members.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

const db = await getDb();
// Stored weights are baselined to the `now` of the rebuild that wrote them, so
// every rebuild in this file pins the same clock — the equivalence oracle
// (incremental result === full rebuild result) only holds at one `now`.
const NOW = Date.parse("2026-08-04T00:00:00Z");

const snapshot = async () =>
  (await db.query(
    `select a, b, owner, weight, strength, signals, last_seen from edges order by a, b, owner`
  )).rows;
const sameGraph = (msg, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return check(true, msg);
  const i = want.findIndex((r, ix) => JSON.stringify(r) !== JSON.stringify(got[ix]));
  check(false, msg, { rows: [got.length, want.length], firstDiff: { got: got[i], want: want[i] } });
};

const tom = await addMember(db, { name: "Tom Merrill", email: "tom@ridgeline.vc" });
const seb = await addMember(db, { name: "Seb Larkin", email: "seb@ridgeline.vc" });

const person = (name, email, role) => ({ name, email, role });
// Shared world: {Ava,Ben,Cleo} in one thread, {Ben,Cleo} alone in another —
// the Ben–Cleo pair deliberately has evidence OUTSIDE any document that
// mentions Ava, which is the undercount trap an incremental rebuild must dodge.
await ingestDocs(db, [
  { source: "gmail", kind: "email", external_id: "d-1", title: "founder intro",
    occurred_at: "2026-07-01T10:00:00Z",
    people: [person("Ava Stone", "ava@stonebridge.vc", "from"),
             person("Ben Okafor", "ben@okafor.capital", "to"),
             person("Cleo Marsh", "cleo@marshlane.co", "to")] },
  { source: "gmail", kind: "email", external_id: "d-2", title: "term sheet redlines",
    occurred_at: "2026-07-10T10:00:00Z",
    people: [person("Ben Okafor", "ben@okafor.capital", "from"),
             person("Cleo Marsh", "cleo@marshlane.co", "to")] },
  { source: "calendar", kind: "event", external_id: "d-3", title: "Frostworks pitch",
    occurred_at: "2026-07-15T10:00:00Z",
    people: [person("Ava Stone", "ava@stonebridge.vc", "attendee"),
             person("Dana Frost", "dana@frostworks.io", "attendee")] },
]);
// Seb's private layer: only he corresponds with Nell.
await ingestDocs(db, [
  { source: "gmail", kind: "email", external_id: "p-1", title: "LP terms (confidential)",
    occurred_at: "2026-07-25T10:00:00Z",
    people: [person("Ava Stone", "ava@stonebridge.vc", "from"),
             person("Nell Grey", "nell@greyfield.example", "to")] },
], { owner: seb.id });
await resolveMentions(db);

const eid = async (q, viewer = null) =>
  (await searchEntities(db, q, 10, { viewer })).find((e) => e.kind === "person")?.id;
const [ava, ben, cleo, dana] = await Promise.all(
  ["ava@stonebridge.vc", "ben@okafor.capital", "cleo@marshlane.co", "dana@frostworks.io"].map((q) => eid(q)));
const nell = await eid("nell@greyfield.example", seb.id);
check(ava && ben && cleo && dana && nell, "world resolved", { ava, ben, cleo, dana, nell });

console.log("[1/5] non-dirty pairs are left untouched");
{
  await rebuildEdges(db, NOW);
  const before = await snapshot();
  const bcBefore = before.find((r) => [r.a, r.b].includes(ben) && [r.a, r.b].includes(cleo));
  check(bcBefore?.signals?.email === 2, "Ben–Cleo starts with both emails counted", bcBefore);
  const res = await rebuildEdgesFor(db, [ava], NOW);
  check(res.mode === "incremental" && res.edges === 4,
    "Ava's four pairs (three shared + one private) are recomputed", res);
  const after = await snapshot();
  const bcAfter = after.find((r) => [r.a, r.b].includes(ben) && [r.a, r.b].includes(cleo));
  check(JSON.stringify(bcAfter) === JSON.stringify(bcBefore),
    "Ben–Cleo keeps the weight from the doc OUTSIDE the dirty subset", { bcBefore, bcAfter });
  sameGraph("a clean incremental pass changes nothing at all", after, before);
}

console.log("[2/5] merge and unmerge: incremental equals the full rebuild");
{
  await mergeEntities(db, ben, dana, { actor: "Tom Merrill" });
  await rebuildEdgesFor(db, [ben, dana], NOW);
  const incr = await snapshot();
  await rebuildEdges(db, NOW);
  sameGraph("after a merge, rebuildEdgesFor([keep, lose]) matches rebuildEdges", incr, await snapshot());

  const un = await unmergeEntity(db, dana, { actor: "Tom Merrill" });
  check(un.restored === dana && un.from === ben, "unmerge names both touched entities", un);
  await rebuildEdgesFor(db, [un.restored, un.from], NOW);
  const incrUn = await snapshot();
  await rebuildEdges(db, NOW);
  sameGraph("after an unmerge, the incremental result matches too", incrUn, await snapshot());
}

console.log("[3/5] review decisions: accept and reject stay equivalent");
{
  // Exact name + conflicting non-freemail domain scores 0.90 — deterministically
  // in the review band (same recipe as the api-test fixtures).
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "r-1", title: "co-invest?",
      occurred_at: "2026-07-20T10:00:00Z",
      people: [person("Ben Okafor", "ben@rivalfund.example", "from"),
               person("Cleo Marsh", "cleo@marshlane.co", "to")] },
  ]);
  await resolveMentions(db);
  const accept = (await listReviews(db)).find((r) => r.mention_email === "ben@rivalfund.example");
  check(Boolean(accept), "the conflicting-domain mention queued for review");
  const accepted = await resolveReview(db, accept.id, "accept");
  check(accepted.entity === ben, "accept reports the candidate entity", accepted);
  await rebuildEdgesFor(db, [accepted.entity], NOW);
  const incrAcc = await snapshot();
  await rebuildEdges(db, NOW);
  sameGraph("an accepted review's incremental rebuild matches the full one", incrAcc, await snapshot());

  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "r-2", title: "diligence notes",
      occurred_at: "2026-07-21T10:00:00Z",
      people: [person("Cleo Marsh", "cleo@rivalco.example", "from"),
               person("Ava Stone", "ava@stonebridge.vc", "to")] },
  ]);
  await resolveMentions(db);
  const reject = (await listReviews(db)).find((r) => r.mention_email === "cleo@rivalco.example");
  const rejected = await resolveReview(db, reject.id, "reject");
  check(rejected.entity && rejected.entity !== cleo, "reject reports the freshly created entity", rejected);
  await rebuildEdgesFor(db, [rejected.entity], NOW);
  const other = (await snapshot()).find((r) => [r.a, r.b].includes(rejected.entity));
  check(other && [other.a, other.b].includes(ava), "the new entity's edges appear", other);
  const incrRej = await snapshot();
  await rebuildEdges(db, NOW);
  sameGraph("a rejected review's incremental rebuild matches the full one", incrRej, await snapshot());
}

console.log("[4/5] layers: a merge touching a private doc recomputes both, leaks neither");
{
  await mergeEntities(db, ava, dana, { actor: "Tom Merrill" });
  const res = await rebuildEdgesFor(db, [ava, dana], NOW);
  check(res.layers === 2, "both the shared and the private layer recompute", res);
  const incr = await snapshot();
  check(incr.some((r) => r.owner === seb.id && [r.a, r.b].includes(ava) && [r.a, r.b].includes(nell)),
    "Ava's private-layer edge to Nell is rebuilt in Seb's layer");
  const tomSees = await strongestConnections(db, nell, { viewer: tom.id });
  check(tomSees.length === 0, "the other member still sees no private strength", tomSees);
  const sebSees = await strongestConnections(db, nell, { viewer: seb.id });
  check(sebSees.length === 1 && sebSees[0].strength > 0, "its owner still does", sebSees);
  await rebuildEdges(db, NOW);
  sameGraph("and the layered result matches the full rebuild", incr, await snapshot());
  await unmergeEntity(db, dana, { actor: "Tom Merrill" });
  await rebuildEdgesFor(db, [ava, dana], NOW);
}

console.log("[5/5] empty and unknown dirty sets are no-ops");
{
  const before = await snapshot();
  const empty = await rebuildEdgesFor(db, [], NOW);
  check(empty.edges === 0 && empty.mode === "incremental", "an empty dirty set writes nothing", empty);
  const holes = await rebuildEdgesFor(db, [null, undefined], NOW);
  check(holes.edges === 0, "ids that filter to nothing are the same no-op", holes);
  const unknown = await rebuildEdgesFor(db, ["ent_doesnotexist"], NOW);
  check(unknown.edges === 0 && unknown.layers === 0, "an unknown id deletes and inserts nothing", unknown);
  sameGraph("the table is untouched throughout", await snapshot(), before);
}

console.log("[6/6] docs crossing the participant cap force the safe path");
{
  const { putSettings } = await import(join(root, "src/settings.js"));
  await putSettings(db, { maxDocParticipants: 3 });
  // A 4-person doc: over the cap, so it contributes no pairs at all.
  await ingestDocs(db, [
    { source: "calendar", kind: "event", external_id: "cap-1", title: "roundtable",
      occurred_at: "2026-07-18T10:00:00Z",
      people: [person("Ava Stone", "ava@stonebridge.vc", "attendee"),
               person("Ben Okafor", "ben@okafor.capital", "attendee"),
               person("Cleo Marsh", "cleo@marshlane.co", "attendee"),
               person("Dana Frost", "dana@frostworks.io", "attendee")] },
  ]);
  await resolveMentions(db);
  await rebuildEdges(db, NOW);
  // Merging Dana into Cleo drops the doc to 3 distinct people — at the cap it
  // becomes eligible, changing pairs between entities the merge never touched
  // (Ava–Ben). The incremental path must detect the boundary and fall back to
  // the full rebuild instead of leaving those pairs missing.
  await mergeEntities(db, cleo, dana, { actor: "Tom Merrill" });
  const res = await rebuildEdgesFor(db, [cleo, dana], NOW);
  check(res.mode === "full", "a cap-boundary doc falls back to the full rebuild", res);
  const incr = await snapshot();
  await rebuildEdges(db, NOW);
  sameGraph("after a merge across the cap, the result matches the full rebuild", incr, await snapshot());

  // The mirror: unmerge pushes the doc back over the cap, and the pairs it no
  // longer justifies must disappear rather than going stale.
  const un = await unmergeEntity(db, dana, { actor: "Tom Merrill" });
  const res2 = await rebuildEdgesFor(db, [un.restored, un.from], NOW);
  check(res2.mode === "full", "crossing back over the cap is caught too", res2);
  const incrUn = await snapshot();
  await rebuildEdges(db, NOW);
  sameGraph("and matches the full rebuild again", incrUn, await snapshot());
  await putSettings(db, { maxDocParticipants: 50 });
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\nINCREMENTAL EDGE TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nINCREMENTAL EDGE TESTS PASSED");

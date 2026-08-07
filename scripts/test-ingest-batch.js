import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-ingest-batch-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;
delete process.env.FEIN_NO_BODIES;
delete process.env.FUNDGRAPH_NO_BODIES;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb, id, insertMany, MAX_PARAMS } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { rebuildEdges } = await import(join(root, "src/graph/edges.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

const db = await getDb();
const one = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

console.log("[1/6] duplicate doc ids in one batch: last occurrence wins");
{
  // Same source/kind/external_id → same docId. A multi-row upsert containing
  // the id twice would raise "cannot affect row a second time"; the dedupe
  // must instead reproduce the sequential outcome: the later upsert wins.
  const dup = (title, people = []) => ({
    source: "crm", kind: "record", external_id: "dup-1", title,
    occurred_at: "2026-08-01T00:00:00Z", people,
  });
  const res = await ingestDocs(db, [dup("first"), dup("second")]);
  check(res.docCount === 2, "docCount counts input docs, duplicates included", res);
  const { rows } = await db.query(`select title from documents where external_id = 'dup-1'`);
  check(rows.length === 1 && rows[0].title === "second", "one row survives and the last title wins", rows);

  // Mentions follow the same rule: only the last occurrence's people land.
  const res2 = await ingestDocs(db, [
    dup("third", [{ name: "Ann Alpha", email: "ann@alpha.example", role: "mentioned" }]),
    dup("fourth", [{ name: "Bob Beta", email: "bob@beta.example", role: "mentioned" }]),
  ]);
  check(res2.mentionCount === 1, "superseded occurrence's mentions are never written", res2);
  const { rows: men } = await db.query(
    `select m.name from mentions m join documents d on d.id = m.document_id where d.external_id = 'dup-1'`);
  check(men.length === 1 && men[0].name === "Bob Beta", "only the last occurrence's mention survives", men);
}

console.log("[2/6] a batch that crosses chunk boundaries lands exactly");
{
  // 1200 docs (10 cols → 2 chunks) carrying 3600 person mentions
  // (9 cols → 5 chunks): counts must be exact and rows spot-checkable.
  const people = [
    { name: "Ada Founder", email: "ada@startup.example", role: "from" },
    { name: "Bo Partner", email: "bo@fund.example", role: "to" },
    { name: "Cy Analyst", email: "cy@fund.example", role: "cc" },
  ];
  const docs = Array.from({ length: 1200 }, (_, i) => ({
    source: "gmail", kind: "email", external_id: `bulk-${i}`, title: `bulk ${i}`,
    occurred_at: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 3600000).toISOString(),
    people,
  }));
  const res = await ingestDocs(db, docs);
  check(res.docCount === 1200 && res.mentionCount === 3600, "exact counts across chunk boundaries", res);
  check(await one(`select count(*) as n from documents where external_id like 'bulk-%'`) === 1200,
    "all 1200 documents landed");
  check(await one(`select count(*) as n from mentions m join documents d on d.id = m.document_id
                   where d.external_id like 'bulk-%'`) === 3600, "all 3600 mentions landed");
  const { rows } = await db.query(
    `select m.name, m.role from mentions m join documents d on d.id = m.document_id
     where d.external_id = 'bulk-777' order by m.role`);
  check(rows.length === 3 && rows.some((r) => r.name === "Ada Founder" && r.role === "from"),
    "a mid-batch doc carries its exact mentions", rows);
}

console.log("[3/6] re-ingest with fewer people deletes only stale structured mentions");
{
  const doc = (people) => ({
    source: "gmail", kind: "email", external_id: "shrink-1", title: "shrink",
    occurred_at: "2026-02-01T00:00:00Z", people,
  });
  const three = [
    { name: "Ada Founder", email: "ada@startup.example", role: "from" },
    { name: "Bo Partner", email: "bo@fund.example", role: "to" },
    { name: "Cy Analyst", email: "cy@fund.example", role: "cc" },
  ];
  await ingestDocs(db, [doc(three)]);
  const { rows: [d] } = await db.query(`select id from documents where external_id = 'shrink-1'`);
  await db.query(
    `insert into mentions (id, document_id, kind, name, norm_name, origin)
     values ($1, $2, 'person', 'Extracted Eve', 'extracted eve', 'extracted')`,
    [id("men"), d.id]);
  await ingestDocs(db, [doc(three.slice(0, 2))]);
  check(await one(`select count(*) as n from mentions where document_id = $1 and origin = 'structured'`, [d.id]) === 2,
    "stale structured mentions are deleted");
  check(await one(`select count(*) as n from mentions where document_id = $1 and origin = 'extracted'`, [d.id]) === 1,
    "an extracted mention on the same doc survives");
}

console.log("[4/6] body policy survives the excluded.* rewrite");
{
  const BODY = "This body is long enough to clear the forty-character capture floor.";
  const doc = (body) => ({
    source: "gmail", kind: "email", external_id: "body-1", title: "body test",
    occurred_at: "2026-03-01T00:00:00Z", ...(body === undefined ? {} : { body }),
  });
  const bodyOf = async () =>
    (await db.query(`select body, body_sha256 from documents where external_id = 'body-1'`)).rows[0];

  await ingestDocs(db, [doc(BODY)]);
  let b = await bodyOf();
  check(b.body === BODY && b.body_sha256 !== null, "body captured on first ingest", b);

  process.env.FEIN_NO_BODIES = "1";
  await ingestDocs(db, [doc(BODY)]);
  b = await bodyOf();
  check(b.body === null && b.body_sha256 === null, "FEIN_NO_BODIES=1 re-ingest scrubs body and hash", b);
  delete process.env.FEIN_NO_BODIES;

  await ingestDocs(db, [doc(BODY)]);
  b = await bodyOf();
  check(b.body === BODY, "unsetting the flag restores capture", b);
  await ingestDocs(db, [doc(undefined)]);
  b = await bodyOf();
  check(b.body === BODY && b.body_sha256 !== null, "a headers-only re-pass keeps the stored body", b);
}

console.log("[5/6] mention ids are stable and review history survives");
{
  const doc = {
    source: "calendar", kind: "event", external_id: "stable-1", title: "stable",
    occurred_at: "2026-04-01T00:00:00Z",
    people: [{ name: "Ada Founder", email: "ada@startup.example", role: "attendee" },
             { name: "Bo Partner", email: "bo@fund.example", role: "attendee" }],
  };
  await ingestDocs(db, [doc]);
  const { rows: [d] } = await db.query(`select id from documents where external_id = 'stable-1'`);
  const idsOf = async () => (await db.query(
    `select id from mentions where document_id = $1 and origin = 'structured' order by id`, [d.id]))
    .rows.map((r) => r.id);
  const before = await idsOf();
  check(before.length === 2, "two structured mentions on first ingest", before);
  await db.query(
    `insert into review_queue (id, mention_id, candidate_entity_id, score, status)
     values ($1, $2, 'ent_synthetic', 0.9, 'accepted')`,
    [id("rev"), before[0]]);

  await ingestDocs(db, [doc]);
  const after = await idsOf();
  check(before.join(",") === after.join(","), "mention ids are identical across re-ingest", { before, after });
  check(await one(`select count(*) as n from review_queue where mention_id = $1`, [before[0]]) === 1,
    "a review row referencing a mention survives (no FK cascade)");
}

console.log("[6/6] batched edge writes");
{
  // 40 resolved participants on one doc → C(40,2) = 780 pairs. Resolution is
  // synthesized directly (rebuildEdges only reads mentions.entity_id) so this
  // stays a test of the edge writer, not of the resolver.
  const board = {
    source: "calendar", kind: "event", external_id: "board-1", title: "AGM",
    occurred_at: "2026-05-01T00:00:00Z",
    people: Array.from({ length: 40 }, (_, i) =>
      ({ name: `Member ${i}`, email: `m${i}@board.example`, role: "attendee" })),
  };
  await ingestDocs(db, [board]);
  const { rows: [d] } = await db.query(`select id from documents where external_id = 'board-1'`);
  await db.query(`update mentions set entity_id = 'syn_' || norm_email where document_id = $1`, [d.id]);
  const built = await rebuildEdges(db);
  check(built.edges === 780, "40 resolved participants build C(40,2) = 780 edges", built);
  check(await one(`select count(*) as n from edges where strength > 0 and strength < 1`) === 780,
    "every stored strength is finite and in (0,1)");

  // insertMany chunking, exercised directly: 7 cols → ~1142 rows/statement,
  // so 3000 synthetic rows must cross at least one chunk boundary.
  check(Math.floor(MAX_PARAMS / 7) < 3000, "3000 rows genuinely cross a chunk boundary");
  const rows = Array.from({ length: 3000 }, (_, i) =>
    [`syn_a${i}`, `syn_b${i}`, "", "{}", 1, 0.5, null]);
  await insertMany(db, {
    table: "edges",
    cols: ["a", "b", "owner", "signals", "weight", "strength", "last_seen"],
    rows,
  });
  check(await one(`select count(*) as n from edges`) === 3780, "insertMany lands every chunk");
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\nINGEST BATCH TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nINGEST BATCH TESTS PASSED");

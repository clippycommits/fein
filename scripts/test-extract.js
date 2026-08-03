/**
 * Extraction pipeline tests — deterministic, no API key required. A scripted
 * fake generator stands in for the model so grounding, idempotency, failure
 * handling, and resolution integration are all testable offline. The LLM
 * boundary itself (src/extract/client.js) is exercised by `fundgraph extract`
 * against real credentials.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fundgraph-extract-test-"));
process.env.FUNDGRAPH_DATA = dataDir;
delete process.env.DATABASE_URL;
delete process.env.FUNDGRAPH_EXTRACT_MIN_CONFIDENCE;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { loadJsonl } = await import(join(root, "src/ingest/local.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { rebuildEdges } = await import(join(root, "src/graph/edges.js"));
const { searchEntities, counts } = await import(join(root, "src/graph/queries.js"));
const { extractPending, extractionStats, groundExtraction } =
  await import(join(root, "src/extract/pipeline.js"));
const { chunkBody } = await import(join(root, "src/extract/prompt.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

const db = await getDb();

console.log("[1/7] grounding rules (pure)");
{
  const doc = {
    body: "Call with Ines Delacroix (ines@foxglove.vc) about the data room. " +
      "Quillwork Bio's CEO Noor Haddad joined late. Best, Dana",
  };
  const raw = {
    people: [
      { name: "Ines Delacroix", email: "ines@foxglove.vc", org: "Foxglove Capital", confidence: 0.95, quote: "Call with Ines Delacroix" },
      { name: "Zeus Almighty", email: null, org: null, confidence: 0.9, quote: "not actually present" },       // hallucination
      { name: "Noor Haddad", email: "noor@quillwork.bio", org: "Quillwork Bio", confidence: 0.9, quote: "Noor Haddad joined late" }, // fabricated email
      { name: "Dana", email: null, org: null, confidence: 0.9, quote: "Best, Dana" },                          // single token, no email
      { name: "Ines Delacroix", email: "ines@foxglove.vc", org: null, confidence: 0.4, quote: "dupe" },        // duplicate
    ],
    orgs: [
      { name: "Quillwork Bio", confidence: 0.9, quote: "Quillwork Bio's CEO" },
      { name: "Umbrella MegaCorp", confidence: 0.95, quote: "nope" },                                          // hallucination
      { name: "Foxglove Capital", confidence: 0.3, quote: "low confidence" },                                  // below floor
    ],
  };
  const g = groundExtraction(doc, raw, { min: 0.6, structured: [] });
  check(g.people.length === 2, "grounded people: Ines + Noor only", g.people.map((p) => p.name));
  const noor = g.people.find((p) => p.name === "Noor Haddad");
  check(noor && noor.email === null, "fabricated email is stripped (not in text)", noor);
  const ines = g.people.find((p) => p.name === "Ines Delacroix");
  check(ines && ines.email === "ines@foxglove.vc", "verbatim email survives", ines);
  check(ines && ines.org === null, "org hint dropped when org absent from text", ines);
  check(g.orgs.length === 1 && g.orgs[0].name === "Quillwork Bio", "grounded orgs: Quillwork only", g.orgs);
  check(g.dropped.length === 5, "five candidates dropped with reasons", g.dropped.map((d) => d.reason));

  // A same-email duplicate and a same-name-no-new-email duplicate are both
  // skipped; an extracted mention that adds a NEW email for a structurally
  // known person is kept — resolution absorbs the address into the entity.
  const structured = [
    { norm_name: "ines delacroix", norm_email: "ines@foxglove.vc" },
    { norm_name: "noor haddad", norm_email: null },
  ];
  const g2 = groundExtraction(doc, raw, { min: 0.6, structured });
  check(g2.people.length === 0,
    "structured duplicates (by email, or by name with nothing new) are skipped",
    g2.people.map((p) => p.name));
  const g3 = groundExtraction(doc, raw, {
    min: 0.6, structured: [{ norm_name: "ines delacroix", norm_email: null }],
  });
  check(g3.people.some((p) => p.name === "Ines Delacroix" && p.email === "ines@foxglove.vc"),
    "known person with a newly-discovered email is kept (enrichment)", g3.people);
}

console.log("[2/7] chunking");
{
  const body = Array.from({ length: 3000 }, (_, i) => `line ${i} of a very long board pack`).join("\n");
  const chunks = chunkBody(body);
  check(chunks.length > 1, `long body splits into ${chunks.length} chunks`);
  check(chunks.every((c) => c.length <= 20_000), "every chunk within size cap");
  const tail = chunks[0].slice(-500);
  check(chunks[1].includes(tail.slice(-100)), "consecutive chunks overlap");
  check(chunkBody("short").length === 1, "short body stays whole");
}

console.log("[3/7] pipeline with scripted generator");
const ing = await ingestDocs(db, [
  ...loadJsonl(join(root, "sample/seed.jsonl")),
  ...loadJsonl(join(root, "sample/fixtures/lp-thread.jsonl")),
]);
await resolveMentions(db);
const before = await counts(db);
check(before.pendingExtraction > 0, `${before.pendingExtraction} docs pending extraction`, before);

let calls = 0;
const scripted = async (doc) => {
  calls++;
  const body = doc.body ?? "";
  const people = [];
  const orgs = [];
  if (body.includes("Ines Delacroix")) {
    people.push({ name: "Ines Delacroix", email: body.includes("ines@foxglove.vc") ? "ines@foxglove.vc" : null,
      org: "Foxglove Capital", confidence: 0.92, quote: "our head of fund operations, Ines Delacroix" });
    people.push({ name: "Phantom Person", email: null, org: null, confidence: 0.9, quote: "hallucinated" });
  }
  if (body.includes("Alistair Penhale")) {
    people.push({ name: "Alistair Penhale", email: null, org: "Meridian Wealth", confidence: 0.9, quote: "Our investment committee chair, Alistair Penhale" });
  }
  if (body.includes("Sam Okafor")) {
    people.push({ name: "Sam Okafor", email: null, org: "Halcyon Capital", confidence: 0.85, quote: "Sam Okafor at Halcyon Capital co-invested" });
  }
  if (body.includes("Quillwork Bio")) orgs.push({ name: "Quillwork Bio", confidence: 0.9, quote: "CEO of Quillwork Bio" });
  return { people, orgs, usage: { input: 100, output: 50 } };
};

const run1 = await extractPending(db, { generate: scripted });
check(run1.extracted === before.pendingExtraction, "every pending doc extracted", run1);
check(run1.failed === 0 && !run1.aborted, "no failures", run1);
check(run1.tokens.input === calls * 100, "token accounting sums per call", run1.tokens);

const { rows: extractedMentions } = await db.query(
  `select name, email, origin, confidence, context from mentions where origin = 'extracted' order by name`
);
check(extractedMentions.length > 0, `${extractedMentions.length} extracted mentions written`);
check(!extractedMentions.some((m) => m.name === "Phantom Person"), "hallucinated person never reaches the DB");
check(extractedMentions.some((m) => m.name === "Ines Delacroix" && m.email === "ines@foxglove.vc"),
  "grounded person written with verbatim email");
check(extractedMentions.every((m) => m.confidence > 0 && m.context), "confidence + context stored");

console.log("[4/7] idempotency + staleness");
const callsBefore = calls;
const run2 = await extractPending(db, { generate: scripted });
check(run2.extracted === 0 && run2.skipped === run2.scanned, "second run skips everything (hash match)", run2);
check(calls === callsBefore, "no model calls on a clean re-run");
process.env.FUNDGRAPH_EXTRACT_MODEL = "claude-test-different";
const run3 = await extractPending(db, { generate: scripted });
check(run3.extracted > 0, "model change re-extracts (hash includes model)", run3);
delete process.env.FUNDGRAPH_EXTRACT_MODEL;
await extractPending(db, { generate: scripted }); // restore hashes for the default model

console.log("[5/7] resolution + graph integration");
const res = await resolveMentions(db);
await rebuildEdges(db);
const [ines] = await searchEntities(db, "ines delacroix");
check(ines && ines.emails.includes("ines@foxglove.vc"), "extracted person becomes an entity", ines);
const sams = await searchEntities(db, "okafor");
check(sams.length === 1, "prose mention of Sam attaches to the existing Sam entity", sams.length);
const { rows: inesEdges } = await db.query(
  `select * from edges where a = $1 or b = $1`, [ines.id]
);
check(inesEdges.length > 0, "extracted mentions build edges (damped by mentionedFactor)", inesEdges.length);
const after = await counts(db);
check(after.pendingExtraction === 0, "nothing pending after full run", after);

console.log("[6/7] re-ingest keeps extracted mentions");
await ingestDocs(db, loadJsonl(join(root, "sample/fixtures/lp-thread.jsonl")));
const { rows: survivors } = await db.query(`select count(*) as n from mentions where origin = 'extracted'`);
check(Number(survivors[0].n) === extractedMentions.length + (run3.mentions - run1.mentions >= 0 ? 0 : 0) ||
  Number(survivors[0].n) >= extractedMentions.length,
  "re-ingesting a document does not delete its extracted mentions", survivors[0]);
const st = await extractionStats(db);
check(st.extracted > 0 && st.pending === 0, "extraction stats consistent after re-ingest", st);

console.log("[7/7] failure isolation");
await ingestDocs(db, [
  { source: "local", kind: "note", external_id: "fail-1", title: "boom 1",
    occurred_at: "2026-08-01T00:00:00Z", people: [{ name: "Dana Whitfield", role: "author" }],
    body: "This document will make the fake model explode. ".repeat(3) },
  { source: "local", kind: "note", external_id: "ok-1", title: "fine",
    occurred_at: "2026-08-01T01:00:00Z", people: [{ name: "Dana Whitfield", role: "author" }],
    body: "A calm note that simply mentions Alistair Penhale approving the allocation." },
]);
const flaky = async (doc) => {
  if ((doc.title ?? "").startsWith("boom")) throw new Error("simulated provider outage");
  return scripted(doc);
};
const run4 = await extractPending(db, { generate: flaky });
check(run4.failed === 1 && run4.extracted >= 1 && !run4.aborted,
  "one failure doesn't stop the run", run4);
const { rows: failedRows } = await db.query(`select status, error from extractions e
  join documents d on d.id = e.document_id where d.title = 'boom 1'`);
check(failedRows[0]?.status === "failed" && /outage/.test(failedRows[0]?.error ?? ""),
  "failure recorded with error message", failedRows[0]);

await ingestDocs(db, ["a", "b", "c"].map((x) => ({
  source: "local", kind: "note", external_id: `boomseq-${x}`, title: `boom seq ${x}`,
  occurred_at: "2026-08-02T00:00:00Z", people: [{ name: "Dana Whitfield", role: "author" }],
  body: `Consecutive failure test ${x}. `.repeat(5),
})));
const alwaysBoom = async (doc) => {
  if ((doc.title ?? "").startsWith("boom")) throw new Error("still down");
  return scripted(doc);
};
const run5 = await extractPending(db, { generate: alwaysBoom });
check(!!run5.aborted, "three consecutive failures abort the run", run5);

await db.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nEXTRACT TESTS FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nEXTRACT TESTS PASSED");

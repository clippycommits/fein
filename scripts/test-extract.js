/**
 * Extraction pipeline tests — deterministic, no API key required. A scripted
 * fake generator stands in for the model so grounding, idempotency, failure
 * handling, and resolution integration are all testable offline. The LLM
 * boundary itself (src/extract/client.js) is exercised by `fundgraph extract`
 * against real credentials.
 *
 * Sections [8]-[9] are regression tests for the adversarial-review findings:
 * token-recombination and email-truncation grounding bypasses, model-authored
 * review quotes, retry exhaustion, body scrubbing, and stale-mention sweeps.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fundgraph-extract-test-"));
process.env.FUNDGRAPH_DATA = dataDir;
delete process.env.DATABASE_URL;
delete process.env.FUNDGRAPH_EXTRACT_MIN_CONFIDENCE;
delete process.env.FUNDGRAPH_EXTRACT_MODEL;
delete process.env.FUNDGRAPH_EXTRACT_EFFORT;
delete process.env.FUNDGRAPH_NO_BODIES;

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

console.log("[1/10] grounding rules (pure)");
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
      { name: "Ines Delacroix", email: "ines@foxglove.vc", org: null, confidence: 0.4, quote: "dupe" },        // low-confidence duplicate
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

console.log("[2/10] chunking");
{
  const body = Array.from({ length: 3000 }, (_, i) => `line ${i} of a very long board pack`).join("\n");
  const chunks = chunkBody(body);
  check(chunks.length > 1, `long body splits into ${chunks.length} chunks`);
  check(chunks.every((c) => c.length <= 20_000), "every chunk within size cap");
  const tail = chunks[0].slice(-500);
  check(chunks[1].includes(tail.slice(-100)), "consecutive chunks overlap");
  check(chunkBody("short").length === 1, "short body stays whole");
}

console.log("[3/10] pipeline with scripted generator");
await ingestDocs(db, [
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
      org: "Foxglove Capital", confidence: 0.92, quote: "model quote — should be ignored" });
    people.push({ name: "Phantom Person", email: null, org: null, confidence: 0.9, quote: "hallucinated" });
  }
  if (body.includes("Alistair Penhale")) {
    people.push({ name: "Alistair Penhale", email: null, org: "Meridian Wealth", confidence: 0.9, quote: "IC chair" });
  }
  if (body.includes("Sam Okafor")) {
    people.push({ name: "Sam Okafor", email: null, org: "Halcyon Capital", confidence: 0.85, quote: "co-invested" });
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
check(extractedMentions.every((m) => !m.context.includes("model quote")),
  "stored context is code-derived from the body, never the model's quote");
const inesRow = extractedMentions.find((m) => m.name === "Ines Delacroix");
check(inesRow && /Ines Delacroix/.test(inesRow.context), "context snippet contains the grounded match", inesRow?.context);

console.log("[4/10] idempotency + config staleness");
const callsBefore = calls;
const run2 = await extractPending(db, { generate: scripted });
check(run2.extracted === 0 && run2.skipped === run2.scanned, "second run skips everything (hash match)", run2);
check(calls === callsBefore, "no model calls on a clean re-run");
process.env.FUNDGRAPH_EXTRACT_MODEL = "claude-test-different";
const run3 = await extractPending(db, { generate: scripted });
check(run3.extracted > 0, "model change re-extracts (hash includes model)", run3);
delete process.env.FUNDGRAPH_EXTRACT_MODEL;
process.env.FUNDGRAPH_EXTRACT_EFFORT = "high";
const run3b = await extractPending(db, { generate: scripted });
check(run3b.extracted > 0, "effort change re-extracts (hash includes effort)", run3b);
delete process.env.FUNDGRAPH_EXTRACT_EFFORT;
await extractPending(db, { generate: scripted }); // restore hashes for the default config

console.log("[5/10] resolution + graph integration");
await resolveMentions(db);
await rebuildEdges(db);
const [ines] = await searchEntities(db, "ines delacroix");
check(ines && ines.emails.includes("ines@foxglove.vc"), "extracted person becomes an entity", ines);
const sams = await searchEntities(db, "okafor");
check(sams.length === 1, "prose mention of Sam attaches to the existing Sam entity", sams.length);
const { rows: inesEdges } = await db.query(`select * from edges where a = $1 or b = $1`, [ines.id]);
check(inesEdges.length > 0, "extracted mentions build edges (damped by mentionedFactor)", inesEdges.length);
const after = await counts(db);
check(after.pendingExtraction === 0, "nothing pending after full run", after);

console.log("[6/10] re-ingest keeps extracted mentions");
await ingestDocs(db, loadJsonl(join(root, "sample/fixtures/lp-thread.jsonl")));
const { rows: survivors } = await db.query(`select count(*) as n from mentions where origin = 'extracted'`);
check(Number(survivors[0].n) >= extractedMentions.length,
  "re-ingesting a document does not delete its extracted mentions", survivors[0]);
const st = await extractionStats(db);
check(st.extracted > 0 && st.pending === 0, "extraction stats consistent after re-ingest", st);

console.log("[7/10] failure isolation + retry exhaustion");
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
check(run4.failed === 1 && run4.extracted >= 1 && !run4.aborted, "one failure doesn't stop the run", run4);
const { rows: failedRows } = await db.query(`select status, error, attempts from extractions e
  join documents d on d.id = e.document_id where d.title = 'boom 1'`);
check(failedRows[0]?.status === "failed" && /outage/.test(failedRows[0]?.error ?? ""),
  "failure recorded with error message", failedRows[0]);
check(failedRows[0]?.attempts === 1, "first failure records attempt 1", failedRows[0]);

// Two more failing runs exhaust the doc; the fourth run parks it instead of retrying.
await extractPending(db, { generate: flaky });
await extractPending(db, { generate: flaky });
const flakyCalls = [];
const run5 = await extractPending(db, {
  generate: async (doc) => { flakyCalls.push(doc.title); return flaky(doc); },
});
check(run5.exhausted === 1 && !flakyCalls.includes("boom 1"),
  "after 3 attempts the doc is exhausted — no more token burn", { run5, flakyCalls });
const stExhausted = await extractionStats(db);
check(stExhausted.exhausted === 1 && stExhausted.pending === 0,
  "exhausted docs leave the pending count", stExhausted);
const cExhausted = await counts(db);
check(cExhausted.pendingExtraction === 0,
  "counts().pendingExtraction agrees with extractionStats on exhaustion", cExhausted);

// A wall of consecutive failures aborts the run instead of burning the backlog.
await ingestDocs(db, ["a", "b", "c"].map((x) => ({
  source: "local", kind: "note", external_id: `boomseq-${x}`, title: `boom seq ${x}`,
  occurred_at: "2026-08-02T00:00:00Z", people: [{ name: "Dana Whitfield", role: "author" }],
  body: `Consecutive failure test ${x}. `.repeat(5),
})));
const run6 = await extractPending(db, { generate: flaky });
check(!!run6.aborted, "three consecutive failures abort the run", run6);

console.log("[8/10] adversarial grounding regressions");
{
  const doc = {
    body: "Maya Chen and Daniel Roth joined the call. We also discussed the final model with Sarah. " +
      "Contact bjohnson@acme.com for the data room.",
  };
  const attack = {
    people: [
      { name: "Maya Roth", email: null, org: null, confidence: 0.95, quote: "x" },        // token recombination
      { name: "Daniel Chen", email: null, org: null, confidence: 0.95, quote: "x" },      // token recombination
      { name: "Al Sarah", email: null, org: null, confidence: 0.95, quote: "x" },         // substring token ('al' in 'final')
      { name: "Johnson", email: "johnson@acme.com", org: null, confidence: 0.95, quote: "x" }, // truncated email
      { name: "Maya Chen", email: null, org: null, confidence: 0.95, quote: "x" },        // legitimate
    ],
    orgs: [
      { name: "Acme", confidence: 0.9, quote: "x" },                                      // substring of an email only
    ],
  };
  const g = groundExtraction(doc, attack, { min: 0.6, structured: [] });
  check(g.people.length === 1 && g.people[0].name === "Maya Chen",
    "recombined names, substring tokens, and truncated-email identities all drop",
    g.people.map((p) => p.name));
  check(!g.orgs.some((o) => o.name === "Acme") || g.orgs.length === 0,
    "org grounded only via word-boundary phrase (inside an email address doesn't count)", g.orgs);

  const punct = groundExtraction(
    { body: "Attendees: Chen, Maya (Nordwind); Whitfield, Dana." },
    { people: [{ name: "Chen, Maya", email: null, org: null, confidence: 0.9, quote: "x" }], orgs: [] },
    { min: 0.6, structured: [] }
  );
  check(punct.people.length === 1, "punctuated name forms still ground as written", punct.people);
}

console.log("[9/10] body lifecycle: NO_BODIES, scrubbing, shrink sweep");
{
  const probe = [{
    source: "local", kind: "note", external_id: "lifecycle-1", title: "lifecycle probe",
    occurred_at: "2026-08-03T00:00:00Z", people: [{ name: "Dana Whitfield", role: "author" }],
    body: "A body long enough to store, naming Alistair Penhale for extraction purposes.",
  }];
  await ingestDocs(db, probe);
  let { rows } = await db.query(
    `select body, body_sha256 from documents where external_id = 'lifecycle-1'`);
  check(rows[0].body && rows[0].body_sha256, "body + hash stored when capture is on", rows[0]?.body_sha256?.slice(0, 8));

  await extractPending(db, { generate: scripted });
  const { rows: m1 } = await db.query(
    `select count(*) as n from mentions m join documents d on d.id = m.document_id
     where d.external_id = 'lifecycle-1' and m.origin = 'extracted'`);
  check(Number(m1[0].n) > 0, "probe doc yields extracted mentions", m1[0]);

  // Re-ingest with the flag set: body AND hash are scrubbed…
  process.env.FUNDGRAPH_NO_BODIES = "1";
  await ingestDocs(db, probe);
  ({ rows } = await db.query(
    `select body, body_sha256 from documents where external_id = 'lifecycle-1'`));
  check(rows[0].body === null && rows[0].body_sha256 === null,
    "FUNDGRAPH_NO_BODIES=1 re-ingest scrubs stored bodies (all adapters, central)", rows[0]);
  delete process.env.FUNDGRAPH_NO_BODIES;

  // …and the next run sweeps the now-bodyless doc's extraction artifacts.
  await extractPending(db, { generate: scripted });
  const { rows: m2 } = await db.query(
    `select count(*) as n from mentions m join documents d on d.id = m.document_id
     where d.external_id = 'lifecycle-1' and m.origin = 'extracted'`);
  const { rows: e2 } = await db.query(
    `select count(*) as n from extractions e join documents d on d.id = e.document_id
     where d.external_id = 'lifecycle-1'`);
  check(Number(m2[0].n) === 0 && Number(e2[0].n) === 0,
    "bodyless docs keep no stale extracted mentions or extraction rows", { m: m2[0], e: e2[0] });

  // Sub-floor bodies are treated as no body at all.
  await ingestDocs(db, [{ ...probe[0], external_id: "lifecycle-2", title: "tiny", body: "too short" }]);
  const { rows: tiny } = await db.query(
    `select body, body_sha256 from documents where external_id = 'lifecycle-2'`);
  check(tiny[0].body === null && tiny[0].body_sha256 === null, "sub-floor bodies are not stored", tiny[0]);
}

console.log("[10/10] fund memory: deals from IC memos");
{
  const { companyMemory } = await import(join(root, "src/graph/memory.js"));
  await ingestDocs(db, loadJsonl(join(root, "sample/fixtures/ic-memo.jsonl")));
  await resolveMentions(db);

  // Triggers pair company + recommendation: the PASS memo also *mentions*
  // Saltglass (fixtures share a cast), and a real model reports deals only
  // for the document's own decision — the mock must do the same.
  const dealer = async (doc) => {
    const body = doc.body ?? "";
    const out = { people: [], orgs: [], deals: [], usage: { input: 100, output: 50 } };
    if (body.includes("Saltglass Photonics") && body.includes("RECOMMENDATION: INVEST")) {
      out.deals.push({ company: "Saltglass Photonics", stage: "Series A", status: "invested",
        summary: "Nordwind leads EUR 7M of a EUR 12M Series A at EUR 38M pre-money.",
        confidence: 0.95, quote: "x" });
      out.deals.push({ company: "Vaporware Dynamics", stage: null, status: "invested",
        summary: "hallucinated company", confidence: 0.99, quote: "x" });        // must drop
      out.deals.push({ company: "Saltglass Photonics", stage: null, status: "definitely-a-lie",
        summary: "dupe with junk status", confidence: 0.9, quote: "x" });        // dupe → dropped by seen
    }
    if (body.includes("Copperleaf Freight") && body.includes("RECOMMENDATION: PASS")) {
      out.deals.push({ company: "Copperleaf Freight", stage: "Series A", status: "passed",
        summary: "Pass recorded for fund memory; unit economics depend on fuel-hedging assumptions.",
        confidence: 0.9, quote: "x" });
    }
    return out;
  };

  const dealRun = await extractPending(db, { generate: dealer });
  check(dealRun.deals === 2, "two grounded deal signals extracted (hallucinated company dropped)", dealRun);
  const { rows: dealRows } = await db.query(`select company, status, context from deals order by company`);
  check(dealRows.length === 2 && dealRows.every((d) => ["invested", "passed"].includes(d.status)),
    "deal rows carry validated statuses only", dealRows.map((d) => [d.company, d.status]));
  check(dealRows.every((d) => d.context && !d.context.includes("x")),
    "deal context is code-derived from the memo body", dealRows[0]?.context?.slice(0, 60));

  // The deal implies the org: Saltglass/Copperleaf become entities via the
  // synthesized org mention, so memory + brief can link them.
  await resolveMentions(db);
  const salt = await companyMemory(db, "Saltglass Photonics");
  check(salt.entity?.kind === "org" && salt.deals.length === 1 && salt.deals[0].status === "invested",
    "company_memory: Saltglass resolves to an org with its INVEST record", { deals: salt.deals.length });
  const copper = await companyMemory(db, "Copperleaf Freight");
  check(copper.deals.length === 1 && copper.deals[0].status === "passed" &&
    /fund memory/i.test(copper.deals[0].summary ?? ""),
    "company_memory: the PASS and its reasoning are recallable", copper.deals[0]?.summary);
  const nobody = await companyMemory(db, "Totally Unknown Ventures LLC");
  check(nobody.deals.length === 0 && nobody.note, "unknown company answers gracefully", nobody.note);

  // Brief integration: the org's brief carries its deal history.
  const [saltEnt] = (await searchEntities(db, "saltglass")).filter((e) => e.kind === "org");
  const { entityBrief } = await import(join(root, "src/graph/queries.js"));
  const saltBrief = await entityBrief(db, saltEnt.id);
  check(saltBrief.deals?.length === 1, "org entity brief includes fund memory", saltBrief.deals?.length);

  // Lifecycle: scrubbing the memo's body sweeps its deal.
  const probeDocs = loadJsonl(join(root, "sample/fixtures/ic-memo.jsonl"));
  process.env.FUNDGRAPH_NO_BODIES = "1";
  await ingestDocs(db, probeDocs);
  delete process.env.FUNDGRAPH_NO_BODIES;
  await extractPending(db, { generate: dealer });
  const { rows: sweptDeals } = await db.query(`select count(*) as n from deals`);
  check(Number(sweptDeals[0].n) === 0, "bodyless memos keep no stale deals", sweptDeals[0]);
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nEXTRACT TESTS FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nEXTRACT TESTS PASSED");

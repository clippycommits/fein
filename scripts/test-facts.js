import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-facts-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { applyFact, applyFacts, retractDocumentFacts } = await import(join(root, "src/facts/write.js"));
const { liveFacts, retiredFacts, factsAsOf, factHistory, whatChanged, factStats } =
  await import(join(root, "src/facts/queries.js"));
const { normValue } = await import(join(root, "src/facts/vocab.js"));
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
const HALO = "halo compute";

/* Seven documents, the same corpus the landing page narrates. Ids are the
   document ids; occurred_at is what becomes valid_at, exactly as ingest
   populates it. */
const DOCS = [
  ["d1", "gmail",    "Fwd: Halo Compute — seed deck",  "2024-11-08T09:00:00Z"],
  ["d2", "granola",  "Coffee with Halo Compute",       "2024-11-21T10:00:00Z"],
  ["d3", "crm",      "Halo Compute — stage changed",   "2024-12-12T11:00:00Z"],
  ["d4", "notion",   "Monday memo — Halo Compute",     "2025-01-16T09:30:00Z"],
  ["d5", "linkedin", "Priya Nayar — new position",     "2025-06-03T12:00:00Z"],
  ["d6", "gmail",    "Halo Compute — June update",     "2026-06-02T08:00:00Z"],
  ["d7", "slack",    "#dealflow — Dev Raman",          "2026-07-28T10:42:00Z"],
];
for (const [id, source, title, at] of DOCS) {
  await db.query(
    `insert into documents (id, source, kind, title, occurred_at, owner, raw)
     values ($1,$2,'email',$3,$4,'', '{}'::jsonb) on conflict (id) do nothing`,
    [id, source, title, at]
  );
}

const f = (document_id, predicate, value, opts = {}) => ({
  document_id, predicate, value,
  subject: "Halo Compute", subject_norm: HALO,
  valid_at: DOCS.find((d) => d[0] === document_id)?.[3],
  quote: `…${value}…`, confidence: 0.9, owner: "", ...opts,
});

/* ---------- 1. the walk-through, in document order ---------- */
console.log("\nThe seven documents:");

await applyFacts(db, [
  f("d1", "raising", "$4M seed"),
  f("d1", "investor", "Dev Raman", { object: "Dev Raman", object_norm: "dev raman" }),
  f("d2", "valuation", "$9M pre"),
  f("d2", "design_partners", "0"),
  f("d3", "stage", "Diligence"),
  f("d4", "decision", "Passed at seed"),
  f("d4", "decision", "No design partners, and the wedge is unproven at this price"),
  f("d5", "employs", "VP Engineering", { object: "Priya Nayar", object_norm: "priya nayar" }),
  f("d6", "raising", "$30M Series A"),
  f("d6", "design_partners", "six"),
  f("d6", "arr", "$2.4M"),
]);

const live = await liveFacts(db, HALO);
const retired = await retiredFacts(db, HALO);
const stats = await factStats(db, HALO);

check(stats.total === 11, "11 facts on file", stats);
check(stats.live === 9, "9 true today", stats);
check(stats.retired === 2, "2 retired, kept", stats);
check(
  retired.map((r) => r.predicate).sort().join(",") === "design_partners,raising",
  "the retired two are the seed round and the zero design partners",
  retired.map((r) => `${r.predicate}=${r.value}`)
);
check(
  live.find((l) => l.predicate === "raising")?.value === "$30M Series A",
  "raising is now the Series A"
);
check(
  live.filter((l) => l.predicate === "decision").length === 2,
  "both decision facts survive — a pass is never retired"
);

/* ---------- 2. the window closes at the new fact's valid_at, not now() ---------- */
const seed = retired.find((r) => r.value === "$4M seed");
check(
  new Date(seed.invalid_at).toISOString() === "2026-06-02T08:00:00.000Z",
  "the seed round's window closes when the Series A became true, not at ingest time",
  seed.invalid_at
);
check(seed.invalidated_by, "the retired fact points at the fact that replaced it");

/* ---------- 3. as-of: the day you passed ---------- */
console.log("\nAs of the day you passed (16 Jan 2025):");
const then = await factsAsOf(db, HALO, "2025-01-16T23:59:00Z");
const val = (p) => then.find((x) => x.predicate === p)?.value;
check(val("raising") === "$4M seed", "we believed they were raising a $4M seed", val("raising"));
check(val("design_partners") === "0", "we believed there were no design partners");
check(val("arr") === undefined, "we knew nothing about ARR — that fact did not exist yet");
check(
  then.some((x) => x.predicate === "decision"),
  "the pass itself is visible on the day it was made"
);

const beforeAnything = await factsAsOf(db, HALO, "2024-01-01T00:00:00Z");
check(beforeAnything.length === 0, "before the first document, fein knew nothing");

/* ---------- 4. restatement must not duplicate ---------- */
console.log("\nRestatement:");
await db.query(
  `insert into documents (id, source, kind, title, occurred_at, owner, raw)
   values ('d8','gmail','email','Halo Compute — July update','2026-07-05T08:00:00Z','', '{}'::jsonb)`
);
const r1 = await applyFact(db, f("d8", "arr", "$2,400,000", { valid_at: "2026-07-05T08:00:00Z" }));
check(r1.action === "restated", "a July update repeating $2.4M ARR is a restatement, not a new fact", r1);
check((await factStats(db, HALO)).live === 9, "live count unchanged after the restatement");
check(normValue("$2.4M") === normValue("$2,400,000"), "money normalizes across written forms");
check(normValue("six") === normValue("6"), "spelled-out numbers normalize");

/* ---------- 5. late arrival must not rewrite the present ---------- */
console.log("\nLate arrival (a backfilled 2025 document, read today):");
await db.query(
  `insert into documents (id, source, kind, title, occurred_at, owner, raw)
   values ('d9','gmail','email','Halo Compute — Feb 2025 update','2025-02-01T08:00:00Z','', '{}'::jsonb)`
);
const r2 = await applyFact(db, f("d9", "arr", "$600k", { valid_at: "2025-02-01T08:00:00Z" }));
check(r2.action === "historical", "an older ARR figure lands in history, not on top", r2);
const liveArr = (await liveFacts(db, HALO)).find((x) => x.predicate === "arr");
check(liveArr.value === "$2.4M", "today's ARR is still $2.4M", liveArr.value);
const feb = await factsAsOf(db, HALO, "2025-03-01T00:00:00Z");
check(
  feb.find((x) => x.predicate === "arr")?.value === "$600k",
  "but as of March 2025 the ARR was $600k",
  feb.find((x) => x.predicate === "arr")?.value
);

/* ---------- 6. history and what-changed ---------- */
console.log("\nAudit views:");
const hist = await factHistory(db, HALO, "arr");
check(hist.length === 2, "ARR has two windows in its history", hist.map((h) => h.value));
check(hist[0].value === "$600k" && hist[1].value === "$2.4M", "ordered oldest first");

const changed = await whatChanged(db, HALO, "2026-01-01T00:00:00Z");
check(
  changed.written.some((w) => w.value === "$30M Series A"),
  "what changed this year includes the Series A"
);
check(
  changed.retired.some((w) => w.value === "$4M seed"),
  "and reports the seed round as retired in the same window"
);

/* ---------- 7. idempotence: re-extraction must not duplicate ---------- */
console.log("\nRe-extraction:");
const before = await factStats(db, HALO);
await applyFacts(db, [f("d6", "raising", "$30M Series A"), f("d6", "arr", "$2.4M")]);
const after = await factStats(db, HALO);
check(
  before.total === after.total && before.live === after.live,
  "re-running the same document changes nothing",
  { before, after }
);

/* ---------- 8. retraction reopens what it closed ---------- */
console.log("\nRetraction (fein was wrong, not the world changed):");
const n = await retractDocumentFacts(db, "d6");
check(n === 3, "d6 produced three facts", n);
const afterRetract = await liveFacts(db, HALO);
check(
  afterRetract.find((x) => x.predicate === "raising")?.value === "$4M seed",
  "retracting the June update reopens the seed round — no hole in the timeline",
  afterRetract.find((x) => x.predicate === "raising")?.value
);
check(
  !afterRetract.some((x) => x.predicate === "arr" && x.value === "$2.4M"),
  "and the retracted ARR is gone from the live set"
);

/* ---------- 9. privacy layers ---------- */
console.log("\nPrivacy layers:");
const marcus = await addMember(db, { name: "Marcus Feld", email: "marcus@longshore.vc" });
await db.query(
  `insert into documents (id, source, kind, title, occurred_at, owner, raw)
   values ('p1','gmail','email','Private note','2026-08-01T08:00:00Z',$1,'{}'::jsonb)`,
  [marcus.id]
);
await applyFact(db, f("p1", "valuation", "$120M whisper", {
  valid_at: "2026-08-01T08:00:00Z", owner: marcus.id,
}));
const shared = await liveFacts(db, HALO);
const asMarcus = await liveFacts(db, HALO, { viewer: marcus.id });
check(
  !shared.some((x) => x.value === "$120M whisper"),
  "a private-layer fact is invisible in the shared layer"
);
check(
  asMarcus.some((x) => x.value === "$120M whisper"),
  "and visible to its owner"
);
check(
  asMarcus.some((x) => x.predicate === "valuation" && x.value === "$9M pre"),
  "the private fact did not retire the shared one — layers do not contradict each other"
);

await db.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} FACT TEST${failures === 1 ? "" : "S"} FAILED`);
  process.exit(1);
}
console.log("\nFACT TESTS PASSED");

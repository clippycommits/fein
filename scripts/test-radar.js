import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-radar-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { relationshipRadar, radarSummary } = await import(join(root, "src/graph/radar.js"));
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

// Fixed clock so cadence maths is reproducible.
const NOW = Date.parse("2026-08-04T00:00:00Z");
const DAY = 86400000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

const db = await getDb();
const me = { name: "Tom Merrill", email: "tom@ridgeline.vc" };
const meet = (id, other, otherEmail, ago) => ({
  source: "calendar", kind: "event", external_id: id,
  title: `sync ${id}`, occurred_at: daysAgo(ago),
  people: [{ ...me, role: "attendee" }, { name: other, email: otherEmail, role: "attendee" }],
});

const docs = [];
// Weekly contact, current: last touch 3 days ago.
[3, 10, 17, 24, 31].forEach((d, i) => docs.push(meet(`w${i}`, "Weekly Wendy", "wendy@x.com", d)));
// Weekly cadence but silent for 40 days → overdue relative to *their* norm.
[40, 47, 54, 61, 68].forEach((d, i) => docs.push(meet(`o${i}`, "Overdue Oli", "oli@x.com", d)));
// Quarterly contact, 40 days silent → perfectly normal for them.
[40, 130, 220, 310].forEach((d, i) => docs.push(meet(`q${i}`, "Quarterly Quinn", "quinn@x.com", d)));
// Weekly cadence, then nothing for 200 days → cold.
[200, 207, 214, 221].forEach((d, i) => docs.push(meet(`c${i}`, "Cold Cassie", "cassie@x.com", d)));
// A single touch, recent → "new", no cadence to be late against.
docs.push(meet("n0", "New Nadia", "nadia@x.com", 5));
// Busy 90-180 days ago, only one touch since → genuinely cooling.
[20, 95, 110, 125, 140, 155].forEach((d, i) => docs.push(meet(`f${i}`, "Fading Fred", "fred@x.com", d)));

await ingestDocs(db, docs);
await resolveMentions(db);

const id = async (q) => (await searchEntities(db, q))[0]?.id;
const tomId = await id("Tom Merrill");

console.log("[1/3] cadence is learned per relationship");
const radar = await relationshipRadar(db, tomId, { now: NOW });
const by = Object.fromEntries(await Promise.all(radar.map(async (r) => [
  (await searchEntities(db, r.entity)).length ? r.entity : r.entity, r,
])));
const named = {};
for (const r of radar) {
  const { rows } = await db.query(`select canonical_name from entities where id = $1`, [r.entity]);
  named[rows[0].canonical_name] = r;
}
check(Math.round(named["Weekly Wendy"].cadenceDays) === 7, "weekly contact learns a ~7 day cadence", named["Weekly Wendy"].cadenceDays);
check(Math.round(named["Quarterly Quinn"].cadenceDays) === 90, "quarterly contact learns a ~90 day cadence", named["Quarterly Quinn"].cadenceDays);

console.log("[2/3] 'overdue' is relative to that pair, not a global threshold");
check(named["Weekly Wendy"].status === "active", "recent weekly contact is active", named["Weekly Wendy"]);
check(named["Overdue Oli"].status === "overdue" || named["Overdue Oli"].status === "cold",
  "40 days silent on a weekly cadence flags", named["Overdue Oli"]);
check(named["Quarterly Quinn"].status === "active",
  "the SAME 40 days is fine on a quarterly cadence", named["Quarterly Quinn"]);
check(named["Cold Cassie"].status === "cold", "long silence on a frequent cadence goes cold", named["Cold Cassie"]);
check(named["New Nadia"].status === "new" && named["New Nadia"].cadenceDays === null,
  "a single touch has no cadence and is not scolded", named["New Nadia"]);
check(radar[0].status === "cold", "most actionable is sorted first", radar.map((r) => r.status));
check(named["Weekly Wendy"].trend === "warming", "trend compares the last 90 days with the 90 before",
  named["Weekly Wendy"].trend);
check(named["Cold Cassie"].trend === null,
  "no contact in either window reports no trend rather than a false 'steady'", named["Cold Cassie"].trend);
check(named["Fading Fred"].trend === "cooling", "a real slowdown reads as cooling", named["Fading Fred"]);

console.log("[3/4] bursts and thin history don't fake a cadence");
{
  // Five touches in one day, then silence: a 0-day cadence would make every
  // later day "cold". A one-day burst is not a one-day rhythm.
  const burst = [0, 0.1, 0.2, 0.3, 0.4].map((h, i) => ({
    source: "gmail", kind: "email", external_id: `b${i}`, title: "burst",
    occurred_at: new Date(NOW - 9 * DAY + h * 3600000).toISOString(),
    people: [{ ...me, role: "from" }, { name: "Burst Bella", email: "bella@x.com", role: "to" }],
  }));
  await ingestDocs(db, burst);
  await resolveMentions(db);
  const r = await relationshipRadar(db, tomId, { now: NOW });
  const bella = {};
  for (const x of r) {
    const { rows } = await db.query(`select canonical_name from entities where id = $1`, [x.entity]);
    if (rows[0].canonical_name === "Burst Bella") Object.assign(bella, x);
  }
  check(bella.status === "new",
    "a single-day burst has too little span to be judged late", bella);
  check(bella.cadenceDays >= 1, "cadence never drops below a day", bella.cadenceDays);
}

console.log("[3b/4] one document is one contact event");
{
  // Same person as To AND Cc on every message: two mention rows per document.
  // Comparing timestamps with === (Date objects) never deduped, so gaps of 0
  // collapsed the cadence and marked a healthy weekly relationship "cold".
  const dup = [7, 14, 21, 28].map((d, i) => ({
    source: "gmail", kind: "email", external_id: `dup${i}`, title: "dup",
    occurred_at: daysAgo(d),
    people: [{ ...me, role: "from" },
             { name: "Doubled Dana", email: "dana@x.com", role: "to" },
             { name: "Doubled Dana", email: "dana@x.com", role: "cc" }],
  }));
  await ingestDocs(db, dup);
  await resolveMentions(db);
  const r = await relationshipRadar(db, tomId, { now: NOW });
  let dana = null;
  for (const x of r) {
    const { rows } = await db.query(`select canonical_name from entities where id = $1`, [x.entity]);
    if (rows[0].canonical_name === "Doubled Dana") dana = x;
  }
  check(dana?.contacts === 4, "four documents count as four contacts, not eight", dana?.contacts);
  check(Math.round(dana?.cadenceDays) === 7, "cadence stays weekly despite duplicate mentions", dana?.cadenceDays);
  // Exactly one interval elapsed is "due", not "cold" — the point is that the
  // duplicate mentions no longer collapse the cadence and force a false cold.
  check(dana?.status === "due", "the relationship reads due, not cold", dana?.status);
}

console.log("[3c/4] future-dated documents don't fake recency");
{
  await ingestDocs(db, [{
    source: "calendar", kind: "event", external_id: "future-1", title: "next quarter offsite",
    occurred_at: new Date(NOW + 40 * DAY).toISOString(),
    people: [{ ...me, role: "attendee" }, { name: "Cold Cassie", email: "cassie@x.com", role: "attendee" }],
  }]);
  await resolveMentions(db);
  const r = await relationshipRadar(db, tomId, { now: NOW });
  let cassie = null;
  for (const x of r) {
    const { rows } = await db.query(`select canonical_name from entities where id = $1`, [x.entity]);
    if (rows[0].canonical_name === "Cold Cassie") cassie = x;
  }
  check(cassie?.daysSinceContact > 0, "a future invite doesn't produce negative days-since", cassie?.daysSinceContact);
  check(cassie?.status === "cold", "and doesn't mask a cold relationship as active", cassie?.status);
}

console.log("[4/4] summary + privacy scoping");
const summary = await radarSummary(db, { now: NOW });
check(summary.counts.cold >= 1 && summary.needsAttention.length >= 2,
  "graph-wide summary surfaces what needs attention", summary.counts);

const seb = await addMember(db, { name: "Seb Larkin" });
await ingestDocs(db, [{
  source: "gmail", kind: "email", external_id: "priv-1", title: "private",
  occurred_at: daysAgo(400),
  people: [{ ...me, role: "from" }, { name: "Secret Sasha", email: "sasha@x.com", role: "to" }],
}], { owner: seb.id });
await resolveMentions(db);
const shared = await relationshipRadar(db, tomId, { now: NOW });
const sebView = await relationshipRadar(db, tomId, { viewer: seb.id, now: NOW });
const nameOf = async (r) => (await db.query(`select canonical_name from entities where id = $1`, [r.entity])).rows[0].canonical_name;
const sharedNames = await Promise.all(shared.map(nameOf));
const sebNames = await Promise.all(sebView.map(nameOf));
check(!sharedNames.includes("Secret Sasha"), "a private relationship is absent from the shared radar", sharedNames);
check(sebNames.includes("Secret Sasha"), "its owner sees it on theirs", sebNames);

await db.close();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\nRADAR TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nRADAR TESTS PASSED");

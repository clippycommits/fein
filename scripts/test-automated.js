import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fundgraph-auto-"));
process.env.FUNDGRAPH_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { detectAutomated, setAutomated, classifyAddress } = await import(join(root, "src/resolve/automated.js"));
const { searchEntities } = await import(join(root, "src/graph/queries.js"));
const { relationshipRadar } = await import(join(root, "src/graph/radar.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

console.log("[1/4] address tiers");
check(classifyAddress("no-reply@apple.com").automated, "no-reply is a machine on sight");
check(classifyAddress("mailer-daemon@x.com").automated, "mailer-daemon is a machine on sight");
check(classifyAddress("notifications@github.com").automated, "notifications@ is a machine on sight");
check(!classifyAddress("team@ridgeline.vc").automated, "team@ is NOT automated on the pattern alone");
check(classifyAddress("team@ridgeline.vc").role, "team@ is recognised as a role address");
check(!classifyAddress("hello@redgravestudio.com").automated, "a client's hello@ is not a robot");
check(!classifyAddress("maya@nordwind.vc").automated, "an ordinary address is untouched");

const db = await getDb();
const NOW = Date.parse("2026-08-04T00:00:00Z");
const DAY = 86400000;
const at = (d) => new Date(NOW - d * DAY).toISOString();
const email = (id, from, to, day, kind = "email") => ({
  source: "gmail", kind, external_id: id, title: `msg ${id}`, occurred_at: at(day),
  people: [{ ...from, role: "from" }, { ...to, role: "to" }],
});

const me = { name: "Alex Rivera", email: "alex@ridgeline.vc" };
const docs = [];
// A robot blasting 6 messages, never replied to.
for (let i = 0; i < 6; i++) docs.push(email(`r${i}`, { name: "Apple", email: "no-reply@apple.com" }, me, 10 + i));
// A role address that only ever broadcasts → service desk.
for (let i = 0; i < 4; i++) docs.push(email(`s${i}`, { name: "Hostinger", email: "support@hostinger.com" }, me, 20 + i));
// A role address with a real human behind it: they reply and they meet.
for (let i = 0; i < 4; i++) docs.push(email(`c${i}`, { name: "Will Hartley", email: "hello@redgravestudio.com" }, me, 30 + i));
docs.push(email("c-reply", me, { name: "Will Hartley", email: "hello@redgravestudio.com" }, 29));
docs.push({
  source: "calendar", kind: "event", external_id: "c-meet", title: "Redgrave catch-up", occurred_at: at(28),
  people: [{ ...me, role: "attendee" }, { name: "Will Hartley", email: "hello@redgravestudio.com", role: "attendee" }],
});
// An ordinary person.
for (const d of [5, 12, 19, 26]) docs.push(email(`p${d}`, { name: "Maya Chen", email: "maya@nordwind.vc" }, me, d));
docs.push(email("p-reply", me, { name: "Maya Chen", email: "maya@nordwind.vc" }, 4));

await ingestDocs(db, docs);
await resolveMentions(db);
const res = await detectAutomated(db);

const flaggedNames = new Set(res.examples.map((e) => e.name));
const { rows: all } = await db.query(`select canonical_name, automated, automated_reason from entities where kind = 'person'`);
const byName = Object.fromEntries(all.map((r) => [r.canonical_name, r]));

console.log("[2/4] behaviour decides the ambiguous cases");
check(byName["Apple"]?.automated, "the no-reply robot is flagged", byName["Apple"]);
check(byName["Hostinger"]?.automated, "a role address that only broadcasts is flagged", byName["Hostinger"]);
check(/broadcasting only/.test(byName["Hostinger"]?.automated_reason ?? ""),
  "and the reason says why", byName["Hostinger"]?.automated_reason);
check(!byName["Will Hartley"]?.automated,
  "a role address that replies and meets stays human", byName["Will Hartley"]);
check(!byName["Maya Chen"]?.automated, "an ordinary correspondent stays human", byName["Maya Chen"]);
check(!byName["Alex Rivera"]?.automated, "the account owner stays human", byName["Alex Rivera"]);

console.log("[3/4] flags are advisory, never destructive");
{
  const before = (await db.query(`select count(*) as n from documents`)).rows[0].n;
  const appleId = (await searchEntities(db, "Apple"))[0].id;
  await setAutomated(db, appleId, false); // a human says: actually, keep it
  await detectAutomated(db);              // re-detection must not undo that
  const after = await db.query(`select automated from entities where id = $1`, [appleId]);
  check(after.rows[0].automated === false, "an explicit human override survives re-detection", after.rows[0]);
  check((await db.query(`select count(*) as n from documents`)).rows[0].n === before,
    "nothing was deleted");
  await setAutomated(db, appleId, true); // put it back
}

console.log("[4/4] radar ignores robots by default");
{
  const meId = (await searchEntities(db, "Alex Rivera"))[0].id;
  const names = async (opts) => {
    const r = await relationshipRadar(db, meId, { now: NOW, ...opts });
    return Promise.all(r.map(async (x) =>
      (await db.query(`select canonical_name from entities where id = $1`, [x.entity])).rows[0].canonical_name));
  };
  const human = await names({});
  check(!human.includes("Apple") && !human.includes("Hostinger"), "robots are off the radar", human);
  check(human.includes("Maya Chen") && human.includes("Will Hartley"), "people are still on it", human);
  const withBots = await names({ includeAutomated: true });
  check(withBots.includes("Apple"), "…but they're one flag away when you want them", withBots);
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\nAUTOMATED-SENDER TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nAUTOMATED-SENDER TESTS PASSED");

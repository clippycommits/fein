/**
 * Scheduled connector sync — drives schedulerTick/nextDueAt directly with an
 * injected clock: no wall-clock waits, no timers, no HTTP server. The Attio
 * fetch boundary is mocked exactly like api-test.js, with two extra levers —
 * a failMode flag (record queries 500) and a gate promise (holds a sync in
 * flight for the overlap-guard check).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-scheduler-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;
delete process.env.ATTIO_API_KEY;
delete process.env.AFFINITY_API_KEY;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failMode = false; // record queries answer 500
let gate = null;      // when set, the mock awaits it — a sync hangs in flight
const realFetch = globalThis.fetch;
const attioJson = (data) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => "" });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.attio.com")) return realFetch(url, opts);
  if (gate) await gate;
  if (!(opts.headers?.authorization ?? "").includes("good-key")) {
    return { ok: false, status: 401, text: async () => "invalid token", json: async () => ({}) };
  }
  if (failMode && u.includes("records/query")) {
    return { ok: false, status: 500, text: async () => "workspace exploded", json: async () => ({}) };
  }
  const b = opts.body ? JSON.parse(opts.body) : {};
  if (u.endsWith("/self")) {
    return { ok: true, status: 200, json: async () => ({ data: { workspace_name: "Test Workspace" } }), text: async () => "" };
  }
  if (u.includes("companies")) {
    return b.offset ? attioJson([]) : attioJson([{ id: { record_id: "co-1" }, values: { name: [{ value: "Nordwind Ventures" }] } }]);
  }
  if (u.includes("people")) {
    return b.offset ? attioJson([]) : attioJson([{ id: { record_id: "p-1" },
      values: { name: [{ full_name: "Maya Chen" }],
                email_addresses: [{ email_address: "maya@nordwind.vc" }],
                company: [{ target_record_id: "co-1" }] } }]);
  }
  if (u.includes("/notes")) {
    return u.includes("offset=500") ? attioJson([])
      : attioJson([{ id: { note_id: "n1" }, parent_record_id: "p-1", title: "Coffee re co-invest", created_at: "2026-07-01T00:00:00Z" }]);
  }
  return attioJson([]);
};

const { getDb } = await import(join(root, "src/db.js"));
const { putConnector, getConnector, deleteConnector, clampSyncInterval } = await import(join(root, "src/connectors.js"));
const { runConnectorSync, schedulerTick, nextDueAt, syncingProvider, startScheduler, schedulerRunning } =
  await import(join(root, "src/sync.js"));
const { listAudit } = await import(join(root, "src/settings.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

const db = await getDb();
const MIN = 60_000;
const T0 = Date.parse("2026-08-08T09:00:00Z");
const at = (ms) => ({ now: () => ms });
const docCount = async () => Number((await db.query(`select count(*) as n from documents`)).rows[0].n);

console.log("[1/10] nextDueAt is pure and unit-testable");
{
  const iso = new Date(T0).toISOString();
  check(nextDueAt({}, T0) === null, "no interval -> null (off)");
  check(nextDueAt({ syncIntervalMinutes: 0, lastAttemptAt: iso }, T0) === null, "interval 0 -> null (off)");
  check(nextDueAt({ syncIntervalMinutes: 60 }, T0) === T0, "never attempted -> due now");
  check(nextDueAt({ syncIntervalMinutes: 60, lastAttemptAt: iso }, T0) === T0 + 60 * MIN,
    "due one interval after the last attempt");
  check(nextDueAt({ syncIntervalMinutes: 60, lastSyncAt: iso }, T0) === T0 + 60 * MIN,
    "legacy blob with only lastSyncAt uses it as the base");
  check(nextDueAt({ syncIntervalMinutes: 60, lastAttemptAt: iso, consecutiveFailures: 2 }, T0) === T0 + 240 * MIN,
    "each consecutive failure doubles the spacing");
  check(nextDueAt({ syncIntervalMinutes: 60, lastAttemptAt: iso, consecutiveFailures: 9 }, T0) === T0 + 960 * MIN,
    "failure backoff is capped at 16x");
  check(nextDueAt({ syncIntervalMinutes: 360, lastAttemptAt: iso, consecutiveFailures: 4 }, T0) === T0 + 24 * 60 * MIN,
    "backed-off spacing is capped at 24h");
  check(nextDueAt({ syncIntervalMinutes: 10080, lastAttemptAt: iso }, T0) === T0 + 10080 * MIN,
    "a configured interval above 24h is honored as-is (the cap is for backoff)");
}

console.log("[2/10] interval knob validation");
{
  check(clampSyncInterval(0) === 0, "0 (off) is valid");
  check(clampSyncInterval(5) === 5 && clampSyncInterval(10080) === 10080, "5..10080 minutes are valid");
  for (const bad of [3, -1, "junk", 10081]) {
    let threw = false;
    try { clampSyncInterval(bad); } catch { threw = true; }
    check(threw, `${JSON.stringify(bad)} is rejected`);
  }
}

console.log("[3/10] off by default");
{
  await putConnector(db, "attio", { apiKey: "good-key-abcd1234", workspace: "Test Workspace" });
  const r = await schedulerTick(db, at(T0));
  check(r.ran.length === 0 && r.skipped.includes("attio"), "a connected connector with no interval never runs", r);
}

console.log("[4/10] due / not due");
{
  await putConnector(db, "attio", { syncIntervalMinutes: 60 });
  const r1 = await schedulerTick(db, at(T0));
  check(r1.ran.includes("attio"), "armed + never attempted: runs on the first tick", r1);
  const cfg = await getConnector(db, "attio");
  check(cfg.lastRun?.ok === true && cfg.lastRun.trigger === "scheduled",
    "lastRun records the scheduled success", cfg.lastRun);
  check(cfg.lastAttemptAt === new Date(T0).toISOString() && cfg.consecutiveFailures === 0 &&
        cfg.lastSyncAt === cfg.lastAttemptAt && cfg.lastDocCount === 3,
    "success bookkeeping lands in the blob", cfg);
  const rows = await listAudit(db, 50);
  const row = rows.find((a) => a.action === "ingest" && a.actor === "scheduler");
  check(row?.detail?.trigger === "scheduled" && row.detail.file === "attio workspace",
    "audited as an ingest by \"scheduler\" with trigger \"scheduled\"", row);

  const before = await docCount();
  const r2 = await schedulerTick(db, at(T0 + 30 * MIN));
  check(r2.ran.length === 0, "half an interval later: not due", r2);
  // isBusy is the extraction single-flight seen from here: a due connector
  // defers (no attempt, no bookkeeping) while another consumer holds the
  // shared resolve + edge-rebuild pipeline.
  const busy = await schedulerTick(db, { ...at(T0 + 61 * MIN), isBusy: () => true });
  check(busy.ran.length === 0 && busy.skipped.includes("attio"),
    "a due connector defers while extraction holds the pipeline (isBusy)", busy);
  const r3 = await schedulerTick(db, at(T0 + 61 * MIN));
  check(r3.ran.includes("attio"), "past the interval: due again", r3);
  check((await docCount()) === before, "the re-pull is idempotent — doc count unchanged");
}

console.log("[5/10] failure + backoff");
const lastGoodSync = (await getConnector(db, "attio")).lastSyncAt;
const tFail = T0 + 122 * MIN;
{
  failMode = true;
  const r1 = await schedulerTick(db, at(tFail));
  check(r1.ran.includes("attio"), "a due connector still attempts under failMode", r1);
  const cfg = await getConnector(db, "attio");
  check(cfg.lastRun?.ok === false && /500/.test(cfg.lastRun.error ?? ""),
    "the failed run is recorded with its error", cfg.lastRun);
  check(cfg.consecutiveFailures === 1, "consecutive failures counted", cfg.consecutiveFailures);
  check(cfg.lastSyncAt === lastGoodSync && cfg.lastDocCount === 3,
    "lastSyncAt/lastDocCount still mean the last SUCCESS", { lastSyncAt: cfg.lastSyncAt, lastGoodSync });
  const rows = await listAudit(db, 50);
  check(rows.some((a) => a.action === "sync_failed" && a.actor === "scheduler" && a.detail?.trigger === "scheduled"),
    "sync_failed audited with the scheduler actor");

  const r2 = await schedulerTick(db, at(tFail + 60 * MIN));
  check(r2.ran.length === 0, "one interval later: backoff doubled the spacing", r2);
  const r3 = await schedulerTick(db, at(tFail + 121 * MIN));
  check(r3.ran.includes("attio"), "after the doubled spacing: attempts again", r3);
  check((await getConnector(db, "attio")).consecutiveFailures === 2, "a second failure counts up");

  failMode = false;
  const tRecover = tFail + 121 * MIN + 241 * MIN; // 2 failures -> 4x spacing
  const r4 = await schedulerTick(db, at(tRecover));
  check(r4.ran.includes("attio"), "a recovered connector runs at its backed-off due time", r4);
  const cfg2 = await getConnector(db, "attio");
  check(cfg2.consecutiveFailures === 0 && cfg2.lastRun.ok === true &&
        cfg2.lastSyncAt === new Date(tRecover).toISOString(),
    "success resets the failure count and advances lastSyncAt", cfg2);
}

console.log("[6/10] not-configured guard");
{
  await deleteConnector(db, "attio");
  await putConnector(db, "attio", { syncIntervalMinutes: 60 }); // armed blob, no key, no env var
  const r = await schedulerTick(db, at(tFail + 600 * MIN));
  check(r.ran.length === 0 && r.skipped.includes("attio"), "an armed blob with no key never runs", r);
}

console.log("[7/10] overlap guard (single-flight)");
{
  await putConnector(db, "attio", { apiKey: "good-key-abcd1234", syncIntervalMinutes: 60 });
  let release;
  gate = new Promise((r) => { release = r; });
  const inflight = runConnectorSync(db, "attio", { actor: "local", trigger: "manual" });
  // Let the sync reach the gated fetch before probing the claim.
  await new Promise((r) => setImmediate(r));
  check(syncingProvider() === "attio", "the in-flight manual sync holds the claim");
  const tick = await schedulerTick(db, at(tFail + 600 * MIN));
  check(tick.ran.length === 0 && tick.skipped.includes("attio"),
    "the scheduler skips while a sync is in flight", tick);
  let code = null;
  await runConnectorSync(db, "attio", {}).catch((err) => { code = err.statusCode; });
  check(code === 409, "a second manual sync rejects with 409", code);
  release();
  gate = null;
  await inflight;
  check(syncingProvider() === null, "the single-flight claim is released");
}

console.log("[8/10] a disconnect mid-run stays a disconnect");
{
  // DELETE lands while the pull is gated in flight: the run itself completes
  // (its ingest already committed), but the outcome bookkeeping must not
  // resurrect the deleted blob with ghost lastSyncAt/lastRun timestamps.
  let release;
  gate = new Promise((r) => { release = r; });
  const inflight = runConnectorSync(db, "attio", { actor: "local", trigger: "manual" });
  await new Promise((r) => setImmediate(r));
  check(syncingProvider() === "attio", "the sync is in flight before the disconnect");
  await deleteConnector(db, "attio");
  release();
  gate = null;
  const result = await inflight;
  check(result.ingested.docCount === 3, "the in-flight pull still completes", result.ingested);
  check((await getConnector(db, "attio")) === null,
    "success bookkeeping does not resurrect the deleted connector blob");
}

console.log("[9/10] guard errors do not pollute the blob");
{
  const before = await getConnector(db, "attio");
  await deleteConnector(db, "attio");
  let code = null;
  await runConnectorSync(db, "attio", {}).catch((err) => { code = err.statusCode; });
  check(code === 400, "not-configured is the caller's 400", code);
  check((await getConnector(db, "attio")) === null,
    "the not-configured guard writes no failure bookkeeping", { before: Boolean(before) });
}

console.log("[10/10] startScheduler exposes a live handle (the server-wiring observable)");
{
  check(schedulerRunning() === false, "no scheduler is running before start");
  const stop = startScheduler(db, { everyMs: 3_600_000 }); // never fires in-test; unref'd
  check(schedulerRunning() === true, "startScheduler arms the interval");
  stop();
  check(schedulerRunning() === false, "stopping disarms it");
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nSCHEDULER TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nSCHEDULER TESTS PASSED");

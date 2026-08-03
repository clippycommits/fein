import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

console.log("[1/9] ingest");
const ing = await ingestDocs(db, loadJsonl(join(root, "sample/seed.jsonl")));
check(ing.docCount === 16, `ingested 16 docs`, ing);

console.log("[2/9] resolve");
const res = await resolveMentions(db);
const c1 = await counts(db);
check(c1.entities === 12, `12 entities (7 people + 5 orgs)`, c1);
check(c1.pendingReviews === 1, `1 pending review (M. Chen from gmail)`, c1);
const sams = await searchEntities(db, "okafor");
check(sams.length === 1, `"Sam Okafor" and "Samuel Okafor" merged via email`, sams);

console.log("[3/9] edges");
const edg = await rebuildEdges(db);
check(edg.edges > 5, `built ${edg.edges} edges`);

console.log("[4/9] paths");
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

console.log("[5/9] review queue");
const reviews = await listReviews(db);
check(reviews.length === 1 && reviews[0].mention_email === "mchen@gmail.com", "review is the gmail alias", reviews);
await resolveReview(db, reviews[0].id, "accept");
const [maya2] = await searchEntities(db, "maya chen");
check(maya2.emails.length === 2 && maya2.emails.includes("mchen@gmail.com"),
  "accepting review adds gmail alias to Maya", maya2);
const c2 = await counts(db);
check(c2.unresolvedMentions === 0, "no unresolved mentions after review", c2);

console.log("[6/9] re-ingest idempotency");
await ingestDocs(db, loadJsonl(join(root, "sample/seed.jsonl")));
const res2 = await resolveMentions(db);
const c3 = await counts(db);
check(c3.entities === 12, "re-ingest + re-resolve creates no new entities", c3);
check(c3.pendingReviews === 0, "re-ingest re-asks no answered questions", c3);
check(c3.unresolvedMentions === 0, "all re-ingested mentions resolve", { c3, res2 });
const { rows: kept } = await db.query(`select count(*) as n from review_queue where status = 'accepted'`);
check(Number(kept[0].n) === 1, "accepted review history survives re-ingest (stable mention ids)", kept);

console.log("[7/9] reversed-name blocking");
await ingestDocs(db, [{
  source: "crm", kind: "record", external_id: "crm-099",
  title: "Contact: Whitfield, Dana", occurred_at: "2026-08-01T00:00:00Z",
  people: [{ name: "Whitfield, Dana", org: "Foxglove Capital", role: "mentioned" }],
}]);
await resolveMentions(db);
const c4 = await counts(db);
check(c4.entities === 12, "'Whitfield, Dana' attaches to Dana, no duplicate entity", c4);
check(c4.unresolvedMentions === 0 && c4.pendingReviews === 0, "reversed name auto-attached", c4);

console.log("[8/10] multi-source adapters (mbox / ics / csv)");
{
  const { loadMbox } = await import(join(root, "src/ingest/mbox.js"));
  const { loadIcs } = await import(join(root, "src/ingest/ics.js"));
  const { loadCsv } = await import(join(root, "src/ingest/csv.js"));
  const mbox = await loadMbox(join(root, "sample/sample.mbox"));
  check(mbox.length === 3, "mbox parses 3 messages", mbox.length);
  check(mbox[0].people.some((p) => p.name === "Chen, Maya"), "mbox parses quoted display names", mbox[0].people);
  check(mbox[0].people.some((p) => p.name === "Elena Ruiz"), "mbox decodes RFC 2047 names", mbox[0].people);
  const ics = loadIcs(join(root, "sample/sample.ics"));
  check(ics.length === 2 && ics[0].people.length === 4, "ics parses events + attendees", ics);
  const csv = loadCsv(join(root, "sample/contacts.csv"));
  check(csv.length === 3, "csv parses 3 contacts", csv);

  // Google Contacts / Workspace Takeout column names differ from every other
  // tool's ("E-mail 1 - Value", "Organization Name", split first/last).
  const gPath = join(dataDir, "google-contacts.csv");
  writeFileSync(gPath, [
    "First Name,Middle Name,Last Name,Organization Name,Organization Title,E-mail 1 - Label,E-mail 1 - Value,E-mail 2 - Value",
    "Maya,,Chen,Nordwind Ventures,Partner,* ,maya@nordwind.vc,mchen@gmail.com",
    "Priya,,Nair,Meridian Wealth,Director,* ,priya.nair@meridianwealth.co.uk,",
  ].join("\n"));
  const gc = loadCsv(gPath);
  check(gc.length === 2, "Google Contacts export parses", gc.length);
  check(gc[0].people[0].name === "Maya Chen", "split first/last columns build the full name", gc[0].people[0]);
  check(gc[0].people.map((p) => p.email).join(",") === "maya@nordwind.vc,mchen@gmail.com",
    "both numbered email columns are read", gc[0].people.map((p) => p.email));
  check(gc[0].people[0].org === "Nordwind Ventures", "Organization Name maps to org", gc[0].people[0].org);
  await ingestDocs(db, [...mbox, ...ics, ...csv]);
  await resolveMentions(db);
  const c5 = await counts(db);
  // Only Theo Marchetti + CasselBlu Advisors are new: everyone else must
  // resolve to existing entities across all three formats.
  check(c5.entities === 14, "cross-source resolution: only Theo + CasselBlu are new", c5);
  check(c5.pendingReviews === 0 && c5.unresolvedMentions === 0, "no reviews or strays from adapters", c5);

  // A person first seen as a bare address must pick up their display name later.
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "up-1", title: "bare address",
      occurred_at: "2026-08-01T00:00:00Z",
      people: [{ email: "kai@vellum.fund", role: "from" },
               { name: "Dana Whitfield", email: "dana@foxglove.vc", role: "to" }] },
    { source: "gmail", kind: "email", external_id: "up-2", title: "named",
      occurred_at: "2026-08-02T00:00:00Z",
      people: [{ name: "Kai Tanaka", email: "kai@vellum.fund", role: "from" },
               { name: "Dana Whitfield", email: "dana@foxglove.vc", role: "to" }] },
  ]);
  await resolveMentions(db);
  const [kai] = await searchEntities(db, "vellum.fund");
  check(kai?.canonical_name === "Kai Tanaka", "email-only entity upgrades to display name", kai);
}

console.log("[9/10] parser + resolution safety rails");
{
  const { loadMbox, parseAddressList, decodeRfc2047 } = await import(join(root, "src/ingest/mbox.js"));
  const { loadIcs } = await import(join(root, "src/ingest/ics.js"));

  // Unescaped "From " in a body must not fabricate a phantom message.
  const phantomPath = join(dataDir, "phantom.mbox");
  writeFileSync(phantomPath, [
    "From alice@x.com Mon Jul 27 09:15:00 2026",
    "From: Alice <alice@x.com>", "To: bob@y.com",
    "Subject: hi", "Date: Mon, 27 Jul 2026 09:15:00 +0000", "",
    "From my side all good. Quoting the thread:",
    "From: Carol Attacker <carol@evil.example>", "To: victim@x.com", "",
  ].join("\n"));
  check((await loadMbox(phantomPath)).length === 1, "body 'From ' lines don't fabricate messages");

  // Batched streaming: a Takeout archive must never be materialized whole.
  const { streamMbox } = await import(join(root, "src/ingest/mbox.js"));
  const { ingestStream } = await import(join(root, "src/ingest/index.js"));
  const streamPath = join(dataDir, "stream.mbox");
  writeFileSync(streamPath, Array.from({ length: 25 }, (_, i) => [
    `From s${i}@example.com Mon Jul 27 09:15:00 2026`,
    `From: Streamer ${i} <s${i}@example.com>`,
    "To: Maya Chen <maya@nordwind.vc>",
    `Subject: streamed ${i}`, "Date: Mon, 27 Jul 2026 09:15:00 +0000",
    `Message-ID: <s${i}@example.com>`, "", "body text", "",
  ].join("\n")).join(""));
  let batches = 0;
  const streamed = await ingestStream(db, streamMbox(streamPath), {
    batchSize: 10, onProgress: () => batches++,
  });
  check(streamed.docCount === 25 && batches === 3, "streamed mbox ingests in batches",
    { streamed, batches });

  check(decodeRfc2047("=?utf-8?Q?Hyperlon?= =?utf-8?Q?gword?=") === "Hyperlongword",
    "adjacent RFC 2047 words join without a space");
  const commented = parseAddressList("maya@x.com (Maya Chen)");
  check(commented.length === 1 && commented[0].email === "maya@x.com" && commented[0].name === "Maya Chen",
    "RFC 5322 comment becomes display name, address stays clean", commented);
  const grouped = parseAddressList("Investors: maya@x.com, tom@y.com;");
  check(grouped.length === 2 && grouped[0].email === "maya@x.com" && grouped[1].email === "tom@y.com",
    "group syntax yields clean addresses", grouped);
  const quotedPair = parseAddressList('"Chen \\"The, Closer\\" Maya" <maya@x.com>, tom@y.com');
  check(quotedPair.length === 2 && quotedPair[0].name === 'Chen "The, Closer" Maya',
    "quoted-pair escapes survive tokenizing and unquoting", quotedPair);

  // VALARM properties must not leak into the event.
  const alarmPath = join(dataDir, "alarm.ics");
  writeFileSync(alarmPath, [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:evt-1",
    "SUMMARY:Board meeting with LPs", "DTSTART:20260810T100000Z",
    "ATTENDEE;CN=Dana Whitfield:mailto:dana@foxglove.vc",
    "ATTENDEE;CN=Maya Chen:mailto:maya@nordwind.vc",
    "BEGIN:VALARM", "ACTION:EMAIL", "SUMMARY:Reminder: leave now",
    "ATTENDEE:mailto:alerts@pagerduty.example", "TRIGGER:-PT15M",
    "END:VALARM", "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n"));
  const alarmEvents = loadIcs(alarmPath);
  check(alarmEvents.length === 1 && alarmEvents[0].title === "Board meeting with LPs" &&
    alarmEvents[0].people.length === 2, "VALARM does not overwrite title or inject attendees", alarmEvents);

  // Same name + conflicting work domain and org must ask a human, not merge.
  await ingestDocs(db, [
    { source: "crm", kind: "record", external_id: "js-1", title: "Contact: John Smith",
      occurred_at: "2026-08-01T00:00:00Z",
      people: [{ name: "John Smith", email: "jsmith@acme.com", org: "Acme Capital", role: "mentioned" }] },
  ]);
  await resolveMentions(db);
  await ingestDocs(db, [
    { source: "crm", kind: "record", external_id: "js-2", title: "Contact: John Smith (Zenith)",
      occurred_at: "2026-08-02T00:00:00Z",
      people: [{ name: "John Smith", email: "john@zenith.io", org: "Zenith Partners", role: "mentioned" }] },
  ]);
  await resolveMentions(db);
  const c6 = await counts(db);
  check(c6.pendingReviews === 1, "same-named stranger with conflicting evidence queues for review", c6);
  const [johnReview] = (await listReviews(db)).filter((r) => r.mention_email === "john@zenith.io");
  check(!!johnReview, "the queued review is the Zenith John Smith", johnReview);
  await resolveReview(db, johnReview.id, "reject");
  const smiths = await searchEntities(db, "john smith");
  check(smiths.length === 2, "reject keeps two distinct John Smiths", smiths.map((s) => s.emails));
}

console.log("[10/10] hop-budget pathfinding");
// Cheap 4-hop chain A-B-C-D-E must not shadow the 2-hop route to E: with
// maxHops=4 the only viable path to T is A->G->E->T (3 hops).
const syn = [
  ["syn_A", "syn_B", 0.99], ["syn_B", "syn_C", 0.99], ["syn_C", "syn_D", 0.99],
  ["syn_D", "syn_E", 0.99], ["syn_A", "syn_G", 0.5], ["syn_E", "syn_G", 0.5],
  ["syn_E", "syn_T", 0.9],
];
for (const [a, b, s] of syn) {
  await db.query(`insert into edges (a, b, signals, strength) values ($1, $2, '{}', $3)`, [a, b, s]);
}
const synPath = await findWarmPath(db, "syn_A", "syn_T", 4);
check(synPath !== null, "hop-bounded path is found despite cheaper long chain", synPath);
check(synPath && synPath.path.map((s) => s.entity).join(">") === "syn_A>syn_G>syn_E>syn_T",
  "path routes A>G>E>T", synPath?.path.map((s) => s.entity));

await db.close();
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nSMOKE FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log("\nSMOKE PASSED");

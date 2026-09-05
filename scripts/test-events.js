/**
 * Events: Attio list entries → touch + cohort documents → history, guests,
 * league tables. The mapping half is pure (fixtures modelled on real Attio
 * entry shapes); the query half runs against a throwaway embedded database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-events-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseEventDate, parseEventDates, parseHosts, classifyTier, attributeEntry, eventsFromLists, docsFromEventEntries } =
  await import(join(root, "src/ingest/attio-events.js"));
const { docsFromAttioRecords } = await import(join(root, "src/ingest/attio.js"));
const { getDb } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { rebuildEdges } = await import(join(root, "src/graph/edges.js"));
const { entityBrief, searchEntities } = await import(join(root, "src/graph/queries.js"));
const { strongestConnections } = await import(join(root, "src/graph/paths.js"));
const { listEvents, resolveEvent, eventHistory, eventGuests, guestLeague } = await import(join(root, "src/graph/events.js"));
const { putSettings } = await import(join(root, "src/settings.js"));

let failures = 0;
const ok = (cond, label, extra) => {
  console.log(`  ${cond ? "ok " : "FAIL"} ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  if (!cond) failures++;
};

const NOW = Date.parse("2026-09-05T00:00:00Z");

/* ---------- cell builders in Attio's entry_values shape ---------- */
const sel = (title) => [{ option: { title }, attribute_type: "select" }];
const status = (title) => [{ status: { title }, attribute_type: "status" }];
const check = (v = true) => [{ value: v, attribute_type: "checkbox" }];
const txt = (value) => [{ value, attribute_type: "text" }];
const date = (value) => [{ value, attribute_type: "date" }];

console.log("Event dates from list names:");
{
  ok(parseEventDate("Cannes Closing Set · Jun 25, 2026") === "2026-06-25", "· Mon D, YYYY");
  ok(parseEventDate("Media x AI · Jun 13, 2023") === "2023-06-13", "older year");
  ok(parseEventDate("Human Attention @ Night · Apr 8, 2026") === "2026-04-08", "single-digit day");
  ok(parseEventDate("Dinner - Sept 22, 2025") === "2025-09-22", "Sept and a hyphen");
  ok(parseEventDate("Human Attention Summit 2026") === null, "a bare year is not a date");
  ok(parseEventDate("Publicis Priority List") === null, "no date → not an event");
  ok(parseEventDates('{"summit_2026":"2026-04-07"}').summit_2026 === "2026-04-07", "ATTIO_EVENT_DATES parses");
  let threw = false;
  try { parseEventDates('{"x":"April 7"}'); } catch { threw = true; }
  ok(threw, "a non-ISO pinned date is rejected");
}

console.log("Hosts:");
{
  const h = parseHosts({ host: "Jess Webber <Jess@Example.com>", hostMap: '{"joe":"Joe Marchese <joe@example.com>"}' });
  ok(h.default.name === "Jess Webber" && h.default.email === "jess@example.com", "default host parsed, email lowercased");
  ok(h.byToken.joe.name === "Joe Marchese", "host map token → person");
  ok(parseHosts({}).default === null, "no host configured → null");
}

console.log("Tier classification:");
{
  const past = { past: true };
  ok(classifyTier({ attended: check(), rsvp: sel("Yes") }, past).tier === "attended", "attended checkbox wins over RSVP");
  ok(classifyTier({ checked_in: check() }, past).tier === "attended", "checked_in counts as attended");
  ok(classifyTier({ stage: status("Attended") }, past).tier === "attended", "status Attended");
  ok(classifyTier({ attendance_status: sel("Did Not Attend"), rsvp_status: sel("Accepted") }, past).tier === "rsvp",
    "Did Not Attend is not attendance; the RSVP still stands");
  ok(classifyTier({ rsvp: sel("Yes +1") }, past).tier === "rsvp", "Yes +1 is a yes");
  ok(classifyTier({ gatsby_accepted: check(), invite_sent: check() }, past).tier === "rsvp", "gatsby_accepted is an RSVP");
  ok(classifyTier({ rsvp: sel("No") }, past).tier === "declined", "No is a decline");
  ok(classifyTier({ happy_hour_status: sel("Sent") }, { past: false }).tier === "invited", "Sent is an invitation");
  ok(classifyTier({ invite_sent_date: date("2026-03-01") }, { past: false }).tier === "invited", "an invite date is an invitation");
  ok(classifyTier({ rsvp: sel("Invited") }, { past: false }).tier === "invited", "rsvp=Invited");
  ok(classifyTier({ approved_by_human: sel("Yes"), priority: check() }, { past: false }).tier === null,
    "review/priority columns never count as a touch");
  ok(classifyTier({}, past).tier === "invited", "membership on a past event's list = invited");
  ok(classifyTier({}, past).evidence.includes("past event"), "…with the rule as the receipt");
  ok(classifyTier({}, { past: false }).tier === null, "membership on a future event's list = nothing yet");
  ok(classifyTier({ rsvp_status: sel("Not yet sent") }, past).tier === null, "an explicit not-sent overrides the past-event rule");
  ok(classifyTier({ stage: status("For Review") }, past).tier === null, "For Review on a past summit list = never contacted");
  const ev = classifyTier({ rsvp_status: sel("Accepted") }, past);
  ok(ev.evidence === "rsvp_status=Accepted", "evidence names attribute and value", ev);
}

console.log("Attribution:");
{
  const hosts = parseHosts({ host: "Jess Webber <jess@example.com>", hostMap: '{"joe":"Joe Marchese <joe@example.com>","jess":"Jess Webber <jess@example.com>"}' });
  const firm = /^(human|hv)\b/i;
  let a = attributeEntry({ invited_by: txt("Rich Greenfield") }, hosts, { firmPattern: firm });
  ok(a.inviter?.name === "Rich Greenfield" && a.org === null && a.host.name === "Jess Webber", "a named inviter is a person; default host stays");
  a = attributeEntry({ invited_by: sel("OpenAP") }, hosts, { firmPattern: firm });
  ok(a.org === "OpenAP" && a.inviter === null, "a partner org is an org");
  a = attributeEntry({ added_by: sel("Human - Joe") }, hosts, { firmPattern: firm });
  ok(a.host.name === "Joe Marchese" && a.org === null, "'Human - Joe' credits Joe as host");
  a = attributeEntry({ added_by: sel("Human Ventures") }, hosts, { firmPattern: firm });
  ok(a.host.name === "Jess Webber" && a.org === null && a.inviter === null, "the firm itself is nobody extra");
  a = attributeEntry({ added_by: sel("Human Network Partner") }, hosts, { firmPattern: firm });
  ok(a.org === null && a.inviter === null, "a firm-prefixed partner label is neither person nor org");
  a = attributeEntry({ source_lists: sel("CES wb: 2025 Door List") }, hosts, { firmPattern: firm });
  ok(a.org === null && a.inviter === null && a.raw.length === 1, "a spreadsheet tab is provenance only");
  a = attributeEntry({ added_by: sel("Ben") }, hosts, { firmPattern: firm });
  ok(a.org === null && a.inviter === null, "a lone first name in a select is neither person nor org");
  a = attributeEntry({ added_by: sel("Publicis") }, hosts, { firmPattern: firm, orgNames: new Set(["publicis"]) });
  ok(a.org === "Publicis", "a one-word value the workspace knows as a company is an org");
  a = attributeEntry({ invited_by: sel("On Discourse") }, hosts, { firmPattern: firm });
  ok(a.inviter === null && a.org === "On Discourse", "'On Discourse' is a platform, not a person");
  a = attributeEntry({ invited_by: sel("Heather Hartnett | HH") }, hosts, { firmPattern: firm });
  ok(a.inviter?.name === "Heather Hartnett" && a.org === null, "'Name | initials' is the person", a);
  a = attributeEntry({ invited_by: sel("Walt Piecyk (LightShed)") }, hosts, { firmPattern: firm });
  ok(a.inviter?.name === "Walt Piecyk" && a.org === "LightShed", "'Name (Org)' is the person and the org", a);
  a = attributeEntry({ invited_by: sel("Radial Entertainment") }, hosts, { firmPattern: firm });
  ok(a.inviter === null && a.org === "Radial Entertainment", "a two-word company is an org", a);
  a = attributeEntry({ invited_by: sel("HOST") }, hosts, { firmPattern: firm });
  ok(a.inviter === null && a.org === null, "an all-caps label is nothing", a);
  a = attributeEntry({ invite_source: sel("B2B CMO 100 List (The Drum)") }, hosts, { firmPattern: firm });
  ok(a.org === null && a.inviter === null, "a list name is provenance");
  a = attributeEntry({ invited_by: txt("Joe Marchese") }, hosts, { firmPattern: firm });
  ok(a.host.name === "Joe Marchese" && a.inviter === null, "an inviter who is a mapped host becomes the host");
}

/* ---------- a small workspace ---------- */
const person = (id, name, email, companyId) => ({
  id: { record_id: id }, created_at: "2026-09-03T00:00:00Z",
  values: {
    name: [{ full_name: name }],
    email_addresses: email ? [{ email_address: email }] : [],
    company: companyId ? [{ target_record_id: companyId }] : [],
  },
});
const company = (id, name) => ({ id: { record_id: id }, created_at: "2026-09-03T00:00:00Z", values: { name: [{ value: name }] } });
const entry = (id, personId, values) => ({ id: { entry_id: id }, parent_record_id: personId, parent_object: "people", entry_values: values });

const companies = [company("c1", "Northgate Media"), company("c2", "LightShed")];
const people = [
  person("p1", "Alex Rivera", "alex@northgate.example", "c1"),
  person("p2", "Priya Nair", "priya@meridian.example", null),
  person("p3", "Sam Okafor", null, null),
  person("p4", "Dana Whitfield", "dana@whitfield.example", null),
  person("p5", "Rich Greenfield", "rich@lightshed.example", "c2"),
  person("p6", "Jess Webber", "jess@example.com", null),
];
const lists = [
  { id: { list_id: "L1" }, api_slug: "ces_2025", name: "CES Cocktails · Jan 8, 2025", parent_object: ["people"] }, // the array form the /lists endpoint really returns
  { id: { list_id: "L2" }, api_slug: "dinner_2025", name: "Salon Dinner · Apr 10, 2025", parent_object: "people" },
  { id: { list_id: "L3" }, api_slug: "mixer_2026", name: "Local Innovation Mixer · Sep 28, 2026", parent_object: "people" },
  { id: { list_id: "L4" }, api_slug: "summit_2026", name: "Human Attention Summit 2026", parent_object: "people" },
  { id: { list_id: "L5" }, api_slug: "prospects", name: "Summit · Prospect Research", parent_object: "people" },
  { id: { list_id: "L6" }, api_slug: "partners", name: "Activation Partners · Jun 22, 2026", parent_object: ["companies"] },
];
const entries = {
  L1: [
    entry("e1", "p1", { attended: check(), rsvp: sel("Yes"), invited_by: txt("Rich Greenfield") }),
    entry("e2", "p2", { attended: check(), rsvp: sel("Yes") }),
    entry("e3", "p3", { attended: check(false), rsvp: sel("Yes") }),
    entry("e4", "p4", { attended: check(false), rsvp: sel("No") }),
  ],
  L2: [
    entry("e5", "p1", { attended: check() }),
    entry("e6", "p2", { attended: check() }),
    entry("e7", "p4", {}),                                   // past event, no columns → invited
  ],
  L3: [
    entry("e8", "p1", { added_by: sel("Human - Joe") }),      // future, nothing sent → skipped
    entry("e9", "p2", { added_by: sel("Human - Joe"), rsvp: sel("Yes") }),
  ],
  L4: [
    entry("e10", "p1", { stage: status("Attended"), rsvp_status: sel("Accepted"), invite_source: sel("Publicis"), vip: check() }),
    entry("e11", "p4", { stage: status("Invited"), rsvp_status: sel("No response") }),
    entry("e12", "p3", { stage: status("For Review"), rsvp_status: sel("Not yet sent") }),
  ],
  L5: [entry("e13", "p1", { research_status: sel("Accepted") })],
};

console.log("Events from lists:");
const events = eventsFromLists(lists, { dates: { summit_2026: "2026-04-07" }, now: NOW });
{
  ok(events.length === 4, `4 event lists (dated + pinned; prospects and a company list excluded) — got ${events.length}`, events.map((e) => e.slug));
  ok(events[0].slug === "ces_2025" && events[0].past === true, "sorted by date, past flagged");
  ok(events.find((e) => e.slug === "mixer_2026").past === false, "a future event is not past");
  ok(events.find((e) => e.slug === "summit_2026").date === "2026-04-07", "pinned date applies");
}

console.log("Documents from entries:");
const hosts = parseHosts({ host: "Jess Webber <jess@example.com>", hostMap: '{"joe":"Joe Marchese <joe@example.com>"}' });
const { docs: crmDocs, peopleById } = docsFromAttioRecords({ companies, people });
const eventDocs = [];
const tallies = {};
for (const ev of events) {
  const r = docsFromEventEntries(ev, entries[ev.listId] ?? [], peopleById, { hosts, firmPattern: /^(human|hv)\b/i, orgNames: new Set(["publicis"]) });
  eventDocs.push(...r.docs);
  tallies[ev.slug] = { ...r.tallies, cohort: r.cohort, basis: r.basis };
}
{
  ok(peopleById.size === 6, "people map built alongside the CRM docs");
  const ces = tallies.ces_2025;
  ok(ces.attended === 2 && ces.rsvp === 1 && ces.declined === 1, "CES: 2 attended, 1 RSVP'd, 1 declined", ces);
  ok(ces.cohort === 2 && ces.basis === "attended", "CES room = the 2 who attended", ces);
  const dinner = tallies.dinner_2025;
  ok(dinner.attended === 2 && dinner.invited === 1, "dinner: past-event membership = invited", dinner);
  const mixer = tallies.mixer_2026;
  ok(mixer.skipped === 1 && mixer.rsvp === 1 && mixer.cohort === 0, "future mixer: draft guest skipped, RSVP kept, no room yet", mixer);
  const summit = tallies.summit_2026;
  ok(summit.attended === 1 && summit.invited === 1 && summit.skipped === 1, "summit: attended, invited, not-yet-sent skipped", summit);

  const alexCes = eventDocs.find((d) => d.external_id === "attio-entry-e1");
  ok(alexCes.kind === "event" && alexCes.title === "CES Cocktails · Jan 8, 2025 — attended", "attended → kind event, titled", alexCes.title);
  ok(alexCes.occurred_at.startsWith("2025-01-08"), "dated at the event");
  ok(alexCes.people.some((p) => p.email === "jess@example.com" && p.role === "author"), "host on the touch as author");
  ok(alexCes.people.some((p) => p.name === "Rich Greenfield" && p.role === "from"), "inviter on the touch as from");
  ok(alexCes.people[0].role === "attendee" && alexCes.people[0].org === "Northgate Media", "guest is the attendee, carrying the org hint");
  ok(alexCes.raw.tier === "attended" && alexCes.raw.evidence === "attended=true", "raw carries tier + receipt", alexCes.raw);

  const danaCes = eventDocs.find((d) => d.external_id === "attio-entry-e4");
  ok(danaCes.kind === "invite" && danaCes.title.endsWith("declined") && danaCes.people[0].role === "to", "declined → kind invite, guest role to");
  const priyaMixer = eventDocs.find((d) => d.external_id === "attio-entry-e9");
  ok(priyaMixer.people.some((p) => p.name === "Joe Marchese" && p.role === "author"), "'Human - Joe' makes Joe the host on that touch");
  const alexSummit = eventDocs.find((d) => d.external_id === "attio-entry-e10");
  ok(alexSummit.orgs[0] === "Publicis" && alexSummit.raw.via === "Publicis", "a partner org is an org mention + via");
  ok(alexSummit.raw.attributes?.vip === true, "flags like vip ride along");
  const room = eventDocs.find((d) => d.external_id === "attio-list-L1-cohort");
  ok(room && room.kind === "cohort" && room.people.length === 2 && !room.people.some((p) => p.email === "jess@example.com"),
    "cohort doc holds the room, hosts excluded");
  ok(!eventDocs.some((d) => d.external_id === "attio-entry-e13"), "prospect-list entries produce nothing");
}

/* ---------- into the graph ---------- */
console.log("Queries:");
const db = await getDb();
await putSettings(db, { maxDocParticipants: 80 });
await ingestDocs(db, [...crmDocs, ...eventDocs]);
await resolveMentions(db);
await rebuildEdges(db, NOW);
{
  const evs = await listEvents(db);
  ok(evs.length === 4, `4 events listed — got ${evs.length}`, evs);
  const ces = evs.find((e) => e.slug === "ces_2025");
  ok(ces.attended === 2 && ces.rsvp === 1 && ces.declined === 1 && ces.contacted === 4, "per-tier counts", ces);
  ok((await resolveEvent(db, "ces")).event?.slug === "ces_2025", "partial name resolves");
  ok((await resolveEvent(db, "2025")).error?.includes("ambiguous"), "ambiguous name says so");
  ok((await resolveEvent(db, "nope")).error?.includes("no event"), "unknown name says so");

  const [alex] = await searchEntities(db, "alex@northgate.example");
  const hist = await eventHistory(db, alex.id);
  ok(hist.history.length === 3 && hist.summary.attended === 3, "Alex: 3 events, all attended", hist.summary);
  ok(hist.history[0].event.startsWith("Human Attention Summit"), "newest first");
  ok(hist.history[2].invitedBy === "Rich Greenfield", "history carries who invited");
  ok(hist.summary.showRate === 1 && hist.summary.lastAttended === "2026-04-07", "summary: show rate + last attended", hist.summary);

  const [dana] = await searchEntities(db, "dana@whitfield.example");
  const dh = await eventHistory(db, dana.id);
  ok(dh.summary.events === 3 && dh.summary.attended === 0 && dh.summary.declined === 1 && dh.summary.invited === 2,
    "Dana: contacted 3 times, never attended", dh.summary);

  const guests = await eventGuests(db, "ces_2025");
  ok(guests.counts.attended === 2 && guests.guests[0].tier === "attended", "guests grouped, attended first", guests.counts);
  ok(guests.guests.find((g) => g.name === "Alex Rivera")?.invitedBy === "Rich Greenfield", "guest row shows who brought them");
  ok((await eventGuests(db, "ces_2025", { tier: "declined" })).guests.length === 1, "tier filter");

  const loyal = await guestLeague(db, { sort: "most_attended" });
  ok(loyal.guests[0].name === "Alex Rivera" && loyal.guests[0].attended === 3, "league: Alex is the most loyal", loyal.guests[0]);
  ok(!loyal.guests.some((g) => g.name === "Jess Webber"), "hosts are kept out of the league");
  const over = await guestLeague(db, { sort: "never_attended" });
  ok(over.guests.length === 1 && over.guests[0].name === "Dana Whitfield" && over.guests[0].events === 3, "over-invited: Dana", over.guests);
  const lapsed = await guestLeague(db, { sort: "lapsed", since: "2026-01-01" });
  ok(lapsed.guests.length === 1 && lapsed.guests[0].name === "Priya Nair", "lapsed since 2026: Priya (2 in 2025, RSVP only since)", lapsed.guests);
  const rate = await guestLeague(db, { sort: "best_show_rate", minEvents: 2 });
  ok(rate.guests[0].name === "Alex Rivera" && rate.guests[0].showRate === 1, "best show rate", rate.guests[0]);
  let threw = false;
  try { await guestLeague(db, { sort: "lapsed" }); } catch { threw = true; }
  ok(threw, "lapsed without since is refused");
  const windowed = await guestLeague(db, { sort: "most_attended", since: "2026-01-01" });
  ok(windowed.guests[0].attended === 1, "since bounds the counted events", windowed.guests[0]);

  const brief = await entityBrief(db, alex.id);
  ok(brief.events?.attended === 3 && brief.events.recent.length === 3, "brief carries the events summary", brief.events);
  const [jess] = await searchEntities(db, "jess@example.com");
  const jb = await entityBrief(db, jess.id);
  ok(!jb.events, "a host has no guest-side events block");

  // Edges: the firm ↔ guest edge carries typed signals; the room links guests.
  const conns = await strongestConnections(db, jess.id, { limit: 10 });
  const toAlex = conns.find((c) => c.entity === alex.id);
  ok(toAlex && toAlex.signals.event === 3, "Jess ↔ Alex edge: 3 attended signals", toAlex);
  const toDana = conns.find((c) => c.entity === dana.id);
  ok(toDana && toDana.signals.invite === 3 && toDana.strength < toAlex.strength, "invites are weaker evidence than attendance", { toDana, toAlex });
  const [priya] = await searchEntities(db, "priya@meridian.example");
  const alexConns = await strongestConnections(db, alex.id, { limit: 10 });
  const toPriya = alexConns.find((c) => c.entity === priya.id);
  ok(toPriya && toPriya.signals.cohort === 2, "Alex ↔ Priya: in the same room twice", toPriya);
  const [rich] = await searchEntities(db, "rich@lightshed.example");
  const toRich = alexConns.find((c) => c.entity === rich.id);
  ok(toRich && toRich.signals.event === 1, "the inviter is linked to the guest they brought", toRich);

  // Idempotent: a second ingest of the same pull changes nothing.
  await ingestDocs(db, [...crmDocs, ...eventDocs]);
  await resolveMentions(db);
  const { rows: [{ n }] } = await db.query(`select count(*) as n from documents where raw->>'event' is not null`);
  ok(Number(n) === eventDocs.length, `re-ingest is idempotent (${n} event docs)`);
}

await db.close?.();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} EVENTS TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nEVENTS TESTS PASSED");

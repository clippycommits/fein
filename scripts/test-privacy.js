import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-privacy-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { getDb } = await import(join(root, "src/db.js"));
const { ingestDocs } = await import(join(root, "src/ingest/index.js"));
const { resolveMentions } = await import(join(root, "src/resolve/pipeline.js"));
const { rebuildEdges } = await import(join(root, "src/graph/edges.js"));
const { findWarmPath, findIntroducers, strongestConnections } = await import(join(root, "src/graph/paths.js"));
const { entityBrief, searchEntities } = await import(join(root, "src/graph/queries.js"));
const { addMember, listMembers, removeMember, resolveMember } = await import(join(root, "src/members.js"));

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};

const db = await getDb();
const tom = await addMember(db, { name: "Tom Merrill", email: "tom@ridgeline.vc" });
const seb = await addMember(db, { name: "Seb Larkin", email: "seb@ridgeline.vc" });

const person = (name, email, role) => ({ name, email, role });
// Shared: Tom and Seb are colleagues; Tom knows Dana.
await ingestDocs(db, [
  { source: "calendar", kind: "event", external_id: "sh-1", title: "Partner sync",
    occurred_at: "2026-07-20T10:00:00Z",
    people: [person("Tom Merrill", "tom@ridgeline.vc", "attendee"),
             person("Seb Larkin", "seb@ridgeline.vc", "attendee")] },
  { source: "calendar", kind: "event", external_id: "sh-2", title: "Foxglove call",
    occurred_at: "2026-07-21T10:00:00Z",
    people: [person("Tom Merrill", "tom@ridgeline.vc", "attendee"),
             person("Dana Whitfield", "dana@foxglove.vc", "attendee")] },
  // Priya is a known name at the firm — she appears in a shared document — but
  // only Seb actually corresponds with her. This is the case the feature is for.
  { source: "crm", kind: "record", external_id: "sh-3", title: "Contact: Priya Nair",
    occurred_at: "2026-07-01T10:00:00Z",
    people: [person("Priya Nair", "priya.nair@meridianwealth.co.uk", "mentioned")] },
]);
// Seb's private layer: only he corresponds with Priya.
await ingestDocs(db, [
  { source: "gmail", kind: "email", external_id: "sp-1", title: "LP allocation (confidential)",
    occurred_at: "2026-07-25T10:00:00Z",
    people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
             person("Priya Nair", "priya.nair@meridianwealth.co.uk", "to")] },
  { source: "gmail", kind: "email", external_id: "sp-2", title: "Meridian terms",
    occurred_at: "2026-07-26T10:00:00Z",
    people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
             person("Priya Nair", "priya.nair@meridianwealth.co.uk", "to")] },
], { owner: seb.id });
await resolveMentions(db);
const built = await rebuildEdges(db);

console.log("[1/6] layered rebuild");
check(built.layers === 2, "edges are built per privacy layer", built);
const id = async (q, viewer = null) => (await searchEntities(db, q, 10, { viewer }))[0]?.id;
const [tomE, sebE, priyaE] = [await id("Tom Merrill"), await id("Seb Larkin"), await id("Priya Nair")];
check(tomE && sebE && priyaE, "all three people resolved");

console.log("[2/6] evidence is scoped to the viewer");
{
  const sebConns = await strongestConnections(db, priyaE, { viewer: seb.id });
  check(sebConns.length === 1 && sebConns[0].strength > 0.4, "Seb sees his own connection to Priya", sebConns);
  const tomConns = await strongestConnections(db, priyaE, { viewer: tom.id });
  check(tomConns.length === 0, "Tom sees no strength for a connection he doesn't own", tomConns);
  const shared = await strongestConnections(db, priyaE, {});
  check(shared.length === 0, "the shared layer alone has no Priya evidence", shared);
}

console.log("[3/6] documents never leak, only their count");
{
  const sebBrief = await entityBrief(db, priyaE, { viewer: seb.id });
  check(sebBrief.recentDocuments.length === 3,
    "Seb sees his 2 private documents plus the shared CRM record", sebBrief.recentDocuments.length);
  check(!sebBrief.withheldDocuments, "nothing is withheld from their owner");
  const tomBrief = await entityBrief(db, priyaE, { viewer: tom.id });
  const tomTitles = tomBrief.recentDocuments.map((d) => d.title);
  check(tomTitles.length === 1 && tomTitles[0] === "Contact: Priya Nair",
    "Tom sees the shared record and nothing else", tomTitles);
  check(tomBrief.withheldDocuments === 2, "Tom is told how many are withheld, nothing more", tomBrief.withheldDocuments);
  const titles = JSON.stringify(tomBrief);
  check(!titles.includes("confidential") && !titles.includes("Meridian terms"),
    "no private title appears anywhere in another member's brief");
}

console.log("[4/6] warm paths reveal existence, not evidence");
{
  const sebPath = await findWarmPath(db, sebE, priyaE, { viewer: seb.id });
  check(sebPath?.path?.length === 2 && sebPath.pathStrength > 0.4, "Seb gets a direct scored path", sebPath?.pathStrength);

  const tomPath = await findWarmPath(db, tomE, priyaE, { viewer: tom.id });
  check(!tomPath?.path, "Tom has no visible path", tomPath?.path);
  check(tomPath?.privatePath, "Tom is told a private route exists");
  const hops = tomPath.privatePath.path;
  check(hops.at(-1).private === true && hops.at(-1).viaStrength === null,
    "the private hop carries no strength", hops.at(-1));
  check(hops[1].viaStrength > 0, "the shared hop still shows its real strength", hops[1].viaStrength);
  check(tomPath.privatePath.owners.includes("Seb Larkin"), "the owner to ask is named", tomPath.privatePath.owners);

  const introRes = await findIntroducers(db, tomE, priyaE, { viewer: tom.id });
  check(introRes.viaPrivate?.some((v) => v.owner === "Seb Larkin"),
    "introducers surface the colleague to ask", introRes.viaPrivate);
}

console.log("[5/6] a viewer with no membership sees only the shared layer");
{
  const anon = await findWarmPath(db, tomE, priyaE, {});
  check(!anon?.path, "no visible path without a layer");
  check(anon?.privatePath?.owners?.length === 1, "existence is still shared", anon?.privatePath?.owners);
}

console.log("[5b/6] private-only entities are hidden by default");
{
  // A company that exists ONLY inside Seb's private mail: its NAME is the secret.
  await ingestDocs(db, [{
    source: "gmail", kind: "email", external_id: "sp-3", title: "Project Nightjar",
    occurred_at: "2026-07-27T10:00:00Z",
    people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
             person("Nightjar Founder", "founder@nightjar.example", "to")],
  }], { owner: seb.id });
  await resolveMentions(db);
  check((await searchEntities(db, "Nightjar", 10, { viewer: tom.id })).length === 0,
    "Tom cannot even see that a private-only person exists (default 'hide')");
  check((await searchEntities(db, "Nightjar", 10, { viewer: seb.id })).length === 1,
    "its owner sees it normally");
  check((await searchEntities(db, "Priya", 10, { viewer: tom.id })).length === 1,
    "but a person the FIRM knows stays visible — that's what makes 'ask Seb' work");

  const { putSettings } = await import(join(root, "src/settings.js"));
  await putSettings(db, { privateEntityVisibility: "reveal" });
  check((await searchEntities(db, "Nightjar", 10, { viewer: tom.id })).length === 1,
    "'reveal' opts into the names-are-shared model deliberately");
  await putSettings(db, { privateEntityVisibility: "hide" });
}

console.log("[5c/6] the review queue quotes private documents, so it is scoped too");
{
  const { listReviews } = await import(join(root, "src/resolve/review.js"));
  // A pending question whose mention came from Seb's private mail.
  await ingestDocs(db, [{
    source: "gmail", kind: "email", external_id: "sp-4", title: "PRIVATETITLE deal terms",
    occurred_at: "2026-07-28T10:00:00Z",
    people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
             person("Priya Nair-Watson", "pnw@meridianwealth.co.uk", "to")],
  }], { owner: seb.id });
  await resolveMentions(db);
  const tomQueue = JSON.stringify(await listReviews(db, { viewer: tom.id }));
  check(!tomQueue.includes("PRIVATETITLE"), "another member's review cards never quote a private title");
  const sebQueue = JSON.stringify(await listReviews(db, { viewer: seb.id }));
  const sharedQueue = JSON.stringify(await listReviews(db, {}));
  check(!sharedQueue.includes("PRIVATETITLE"), "nor does the shared queue");
  check(sebQueue.length >= sharedQueue.length, "the owner's queue is a superset of the shared one");
}

console.log("[6/6] removing a member disposes of their layer");
{
  const gone = await removeMember(db, seb.id);
  check(gone.documents === 4, "their private documents are deleted with them", gone);
  await rebuildEdges(db);
  const after = await findWarmPath(db, tomE, priyaE, { viewer: tom.id });
  check(!after?.path && !after?.privatePath, "the private route disappears too", after);
  check((await listMembers(db)).length === 1, "member list shrinks");

  // The alternative: keep the documents by moving them into the shared layer.
  const t2 = await addMember(db, { name: "Temp Member" });
  await ingestDocs(db, [{ source: "gmail", kind: "email", external_id: "t-1", title: "handover",
    occurred_at: "2026-07-28T10:00:00Z",
    people: [person("Tom Merrill", "tom@ridgeline.vc", "from"),
             person("Iris Kwan", "iris@example.com", "to")] }], { owner: t2.id });
  await resolveMentions(db);
  const moved = await removeMember(db, t2.id, { reassign: "shared" });
  check(moved.reassigned && moved.documents === 1, "reassign keeps the documents", moved);
  await rebuildEdges(db);
  const irisId = await id("Iris Kwan");
  const sharedConns = await strongestConnections(db, irisId, {});
  check(sharedConns.length === 1, "reassigned evidence is now visible to everyone", sharedConns);
}

console.log("[6b/6] ambiguous member refs fail loudly, naming the candidates");
{
  // addMember refuses duplicate names, but one member's name can still
  // collide with another's email — the one ambiguity resolveMember must
  // refuse rather than pick a private layer at random.
  const alex = await addMember(db, { name: "Alex" });
  const alexa = await addMember(db, { name: "Alexa", email: "alex" });
  const err = await resolveMember(db, "alex").then(() => null, (e) => e);
  check(/matches 2 members/.test(err?.message ?? ""), "name-vs-email collision throws", err?.message);
  check(Boolean(err?.message.includes(alex.id) && err?.message.includes(alexa.id)),
    "the error lists both candidates", err?.message);
  await removeMember(db, alex.id);
  await removeMember(db, alexa.id);
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\nPRIVACY TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nPRIVACY TESTS PASSED");

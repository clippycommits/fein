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
const { entityBrief, searchEntities, counts } = await import(join(root, "src/graph/queries.js"));
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
// let, not const: [5d/6] rebuilds the world and entity ids do not survive it.
let [tomE, sebE, priyaE] = [await id("Tom Merrill"), await id("Seb Larkin"), await id("Priya Nair")];
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

console.log("[2b/6] stat counts are scoped like every other read");
{
  const shared = await counts(db);
  const sebC = await counts(db, { viewer: seb.id });
  check(shared.documents === 3 && sebC.documents === 5,
    "documents count only the visible layers", { shared: shared.documents, seb: sebC.documents });
  check(sebC.mentions === shared.mentions + 4,
    "private mentions count only for their owner", { shared: shared.mentions, seb: sebC.mentions });
  check(shared.edges === 2 && sebC.edges === 3,
    "edges count distinct visible pairs", { shared: shared.edges, seb: sebC.edges });
  check(shared.withheldDocuments === 2 && !sebC.withheldDocuments,
    "hidden volume is a count for others, absent for the owner", shared.withheldDocuments);
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

  // The private-hop routing prior is a setting. Its routing effect only shows
  // as tie-breaks between equal-hop routes, which this fixture graph has none
  // of — so the honest coverage is validation plus this threading regression:
  // a tuned prior must neither lose the route nor leak a number through it.
  const { putSettings } = await import(join(root, "src/settings.js"));
  await putSettings(db, { privateHopStrength: 0.2 });
  const tuned = await findWarmPath(db, tomE, priyaE, { viewer: tom.id });
  check(Boolean(tuned?.privatePath) && tuned.privatePath.path.at(-1).viaStrength === null,
    "a tuned prior still reports the private route with no strength attached",
    tuned?.privatePath?.path?.at(-1));
  check(tuned.privatePath.owners.includes("Seb Larkin"),
    "and still names the owner to ask", tuned.privatePath.owners);
  await putSettings(db, { privateHopStrength: 0.5 });
}

console.log("[4b/6] the private-hop routing prior is a real routing input");
{
  const { putSettings } = await import(join(root, "src/settings.js"));
  const kay = await addMember(db, { name: "Kay Zhou", email: "kay@ridgeline.vc" });
  // Kay's private layer builds an ALL-private 2-hop route Tom → Kay → Priya
  // competing with the half-visible Tom → Seb → Priya at the same hop count.
  // Cost(via Seb) = −ln s − ln prior, cost(via Kay) = −2 ln prior, so the
  // route flips exactly where the prior crosses the visible Tom–Seb strength
  // s — the one observable place the setting steers routing.
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "kp-1", title: "Kay x Tom",
      occurred_at: "2026-07-22T10:00:00Z",
      people: [person("Kay Zhou", "kay@ridgeline.vc", "from"),
               person("Tom Merrill", "tom@ridgeline.vc", "to")] },
    { source: "gmail", kind: "email", external_id: "kp-2", title: "Kay x Priya",
      occurred_at: "2026-07-23T10:00:00Z",
      people: [person("Kay Zhou", "kay@ridgeline.vc", "from"),
               person("Priya Nair", "priya.nair@meridianwealth.co.uk", "to")] },
  ], { owner: kay.id });
  await resolveMentions(db);
  // Pin the decay baseline: s(Tom–Seb) ≈ 0.27 here, safely between the priors.
  await rebuildEdges(db, Date.parse("2026-08-04T00:00:00Z"));
  const kayE = await id("Kay Zhou", kay.id);
  const via = async (prior) => {
    await putSettings(db, { privateHopStrength: prior });
    const p = await findWarmPath(db, tomE, priyaE, { viewer: tom.id });
    return p?.privatePath?.path?.[1]?.entity;
  };
  const viaLow = await via(0.05);
  const viaHigh = await via(0.9);
  check(viaLow === sebE, "a weak prior routes through the half-visible hop (via Seb)", { viaLow, sebE });
  check(viaHigh === kayE, "a strong prior prefers the all-private shortcut (via Kay)", { viaHigh, kayE });
  await putSettings(db, { privateHopStrength: 0.5 });
  await removeMember(db, kay.id); // Kay and her layer leave; later sections assume two members
  await rebuildEdges(db);
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

console.log("[5d/6] absorbed private evidence never reaches the shared record");
{
  const { reresolveAll } = await import(join(root, "src/resolve/reresolve.js"));
  const { mergeEntities, unmergeEntity } = await import(join(root, "src/resolve/merge.js"));
  // Vera is known to the firm through a shared CRM record; only Seb's private
  // mail knows her middle name, her org, and her second address. Both private
  // mentions AUTO-attach (exact email 0.98; exact name 0.96 — gmail is
  // freemail, so no domain conflict) — the absorption path, not the review band.
  await ingestDocs(db, [
    { source: "crm", kind: "record", external_id: "sh-4", title: "Contact: Vera Shared",
      occurred_at: "2026-07-02T10:00:00Z",
      people: [person("Vera Shared", "vera@known.com", "mentioned")] },
  ]);
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "sp-5", title: "Vera intro",
      occurred_at: "2026-07-29T10:00:00Z",
      people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
               { name: "Vera Anne Shared", email: "vera@known.com", org: "Quietfund Capital", role: "to" }] },
    { source: "gmail", kind: "email", external_id: "sp-6", title: "Vera follow-up",
      occurred_at: "2026-07-30T10:00:00Z",
      people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
               person("Vera Shared", "secretevidence@gmail.com", "to")] },
  ], { owner: seb.id });
  await resolveMentions(db);

  const assertClean = async (note) => {
    check((await searchEntities(db, "secretevidence", 10, { viewer: tom.id })).length === 0,
      `Tom cannot search the privately-absorbed address${note}`);
    check((await searchEntities(db, "secretevidence", 10, { viewer: null })).length === 0,
      `nor can the shared view${note}`);
    check((await searchEntities(db, "secretevidence", 10, { viewer: seb.id })).length === 1,
      `its owner still finds it${note}`);
    const veraId = (await searchEntities(db, "vera@known.com", 10))[0]?.id;
    const tomView = await entityBrief(db, veraId, { viewer: tom.id });
    check(!tomView.entity.emails.includes("secretevidence@gmail.com") &&
          !tomView.entity.orgs.includes("quietfund") &&
          !tomView.entity.aliases.includes("vera anne shared"),
      `another member's brief carries none of the private evidence${note}`, tomView.entity);
    const sebView = await entityBrief(db, veraId, { viewer: seb.id });
    check(sebView.entity.emails.includes("secretevidence@gmail.com") &&
          sebView.entity.orgs.includes("quietfund") &&
          sebView.entity.aliases.includes("vera anne shared"),
      `the owner's brief overlays all of it${note}`, sebView.entity);
    check(tomView.entity.canonical_name === "Vera Shared" &&
          sebView.entity.canonical_name === "Vera Shared",
      `display-name upgrades come only from shared mentions${note}`, sebView.entity.canonical_name);
    const { rows } = await db.query(`select emails, orgs, aliases from entities where id = $1`, [veraId]);
    const raw = JSON.stringify(rows[0]);
    check(!raw.includes("secretevidence") && !raw.includes("quietfund") && !raw.includes("anne"),
      `the stored shared record is clean${note}`, rows[0]);
    return veraId;
  };
  await assertClean("");

  // Derived state: a full rebuild must repopulate the side table, never
  // launder private values into the shared columns.
  await reresolveAll(db);
  [tomE, sebE, priyaE] = [await id("Tom Merrill"), await id("Seb Larkin"), await id("Priya Nair")];
  const veraId = await assertClean(" after reresolve");

  // A manual merge moves the side rows to the survivor and unmerge sends
  // exactly those back — the shared columns stay clean throughout.
  await ingestDocs(db, [
    { source: "crm", kind: "record", external_id: "sh-5", title: "Contact: Vern Shard",
      occurred_at: "2026-07-03T10:00:00Z",
      people: [person("Vern Shard", "vern@shard.example", "mentioned")] },
  ]);
  await resolveMentions(db);
  const vernId = await id("Vern Shard");
  await mergeEntities(db, vernId, veraId);
  const kept = await searchEntities(db, "secretevidence", 10, { viewer: seb.id });
  check(kept.length === 1 && kept[0].id === vernId,
    "after a merge the survivor carries the private evidence for its owner", kept.map((e) => e.id));
  check((await searchEntities(db, "secretevidence", 10, { viewer: tom.id })).length === 0,
    "and still nothing for anyone else");
  const { rows: kRows } = await db.query(`select emails, orgs, aliases from entities where id = $1`, [vernId]);
  check(!JSON.stringify(kRows[0]).includes("secretevidence"),
    "the survivor's shared record stays clean", kRows[0]);
  await unmergeEntity(db, veraId);
  const back = await searchEntities(db, "secretevidence", 10, { viewer: seb.id });
  check(back.length === 1 && back[0].id === veraId,
    "unmerge returns the private evidence to the restored entity", back.map((e) => e.id));
  check((await db.query(`select 1 from entity_evidence where entity_id = $1`, [vernId])).rows.length === 0,
    "the survivor keeps none of it");
}

console.log("[5e/6] a private-first name is re-derived at the first shared witness");
{
  const { mergeEntities } = await import(join(root, "src/resolve/merge.js"));
  // Reverse of [5d]: Seb's private mail knows Wren FIRST; the firm's shared
  // CRM learns of her later. When the shared witness lands, the entity turns
  // visible to everyone — the privately-witnessed middle name must not ride
  // along as its canonical name.
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "sp-7", title: "Wren intro",
      occurred_at: "2026-07-24T10:00:00Z",
      people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
               person("Wren SECRETMIDDLE Callow", "wren@callow.example", "to")] },
  ], { owner: seb.id });
  await resolveMentions(db);
  check((await searchEntities(db, "wren", 10, { viewer: tom.id })).length === 0,
    "before any shared witness the person is hidden");
  await ingestDocs(db, [
    { source: "crm", kind: "record", external_id: "sh-6", title: "Contact: Wren Callow",
      occurred_at: "2026-07-31T10:00:00Z",
      people: [person("Wren Callow", "wren@callow.example", "mentioned")] },
  ]);
  await resolveMentions(db);
  const wren = (await searchEntities(db, "wren", 10, { viewer: tom.id }))[0];
  check(wren?.canonical_name === "Wren Callow",
    "the first shared witness re-derives the display name", wren?.canonical_name);
  check(!JSON.stringify(wren).toLowerCase().includes("secretmiddle"),
    "no private name form reaches another member", wren);
  const sebWren = (await searchEntities(db, "wren", 10, { viewer: seb.id }))[0];
  check(sebWren.aliases.includes("wren secretmiddle callow"),
    "the private form survives as its owner's alias overlay", sebWren.aliases);

  // Manual merges obey the same rule, in both directions. A private-only
  // LOSER: its name may not surface on the shared survivor.
  await ingestDocs(db, [
    { source: "crm", kind: "record", external_id: "sh-7", title: "Contact: Xan Vole",
      occurred_at: "2026-07-05T10:00:00Z",
      people: [person("Xan Vole", "xan@vole.example", "mentioned")] },
    { source: "crm", kind: "record", external_id: "sh-8", title: "Contact: Rex Tan",
      occurred_at: "2026-07-06T10:00:00Z",
      people: [person("Rex Tan", "rex@tan.example", "mentioned")] },
  ]);
  await ingestDocs(db, [
    { source: "gmail", kind: "email", external_id: "sp-8", title: "quiet intro",
      occurred_at: "2026-07-26T10:00:00Z",
      people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
               person("Q. SECRETX Nym", "qnym@nymco.example", "to")] },
    { source: "gmail", kind: "email", external_id: "sp-9", title: "quieter intro",
      occurred_at: "2026-07-27T10:00:00Z",
      people: [person("Seb Larkin", "seb@ridgeline.vc", "from"),
               person("SECRETY Held", "held@heldco.example", "to")] },
  ], { owner: seb.id });
  await resolveMentions(db);
  const xan = (await searchEntities(db, "xan@vole.example", 10))[0];
  const qnym = (await searchEntities(db, "qnym", 10, { viewer: seb.id }))[0];
  await mergeEntities(db, xan.id, qnym.id);
  const { rows: [xRow] } = await db.query(
    `select canonical_name, emails, orgs, aliases from entities where id = $1`, [xan.id]);
  check(xRow.canonical_name === "Xan Vole" &&
        !JSON.stringify(xRow).toLowerCase().includes("secretx") &&
        !JSON.stringify(xRow).includes("qnym"),
    "merging a private-only duplicate lifts nothing into the shared record", xRow);
  check((await searchEntities(db, "qnym", 10, { viewer: tom.id })).length === 0,
    "the merged private address stays invisible to others");
  check((await searchEntities(db, "qnym", 10, { viewer: seb.id }))[0]?.id === xan.id,
    "while the owner's overlay finds it on the survivor");

  // And a private-only KEEPER absorbing a shared duplicate adopts the
  // shared-witnessed name — never the other way round.
  const rex = (await searchEntities(db, "rex@tan.example", 10))[0];
  const held = (await searchEntities(db, "held@heldco", 10, { viewer: seb.id }))[0];
  await mergeEntities(db, held.id, rex.id);
  const { rows: [hRow] } = await db.query(
    `select canonical_name, aliases from entities where id = $1`, [held.id]);
  check(hRow.canonical_name === "Rex Tan" &&
        !JSON.stringify(hRow).toLowerCase().includes("secrety"),
    "a private-only keeper adopts the shared-witnessed name", hRow);
}

console.log("[6/6] removing a member disposes of their layer");
{
  const gone = await removeMember(db, seb.id);
  // sp-1 … sp-6 plus [5e]'s sp-7/sp-8/sp-9.
  check(gone.documents === 9, "their private documents are deleted with them", gone);
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
  // The layer's overlay values are shared-witnessed by definition once its
  // documents move: they are promoted into the shared columns, not dropped —
  // nothing else would ever re-derive them (the moved mentions stay resolved).
  const promoted = await searchEntities(db, "iris@example.com", 10);
  check(promoted.length === 1 && promoted[0].emails.includes("iris@example.com"),
    "values the departed layer witnessed are shared-searchable after reassign", promoted);
  check((await db.query(`select 1 from entity_evidence where owner = $1`, [t2.id])).rows.length === 0,
    "no orphaned overlay rows remain");
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

console.log("[7/7] pre-absorption databases are detected on boot");
{
  const { staleAbsorptionState } = await import(join(root, "src/db.js"));
  check((await staleAbsorptionState(db)) === false, "a policy-clean database raises no warning");
  // Seed the exact shape v0.4.0 wrote: a resolved private-layer mention whose
  // values sit in the shared columns with no overlay row.
  const ghost = await addMember(db, { name: "Ghost Member" });
  await ingestDocs(db, [{ source: "gmail", kind: "email", external_id: "old-1", title: "legacy",
    occurred_at: "2026-07-01T10:00:00Z",
    people: [person("Old Contact", "old@legacy.example", "from")] }], { owner: ghost.id });
  await resolveMentions(db);
  await db.query(`delete from entity_evidence`);
  await db.query(`update entities set emails = '["old@legacy.example"]'
                  where canonical_name = 'Old Contact'`);
  check((await staleAbsorptionState(db)) === true, "the legacy shape is detected");
  // The documented remedy: a reresolve re-derives the overlay and clears it.
  const { reresolveAll } = await import(join(root, "src/resolve/reresolve.js"));
  await reresolveAll(db);
  check((await staleAbsorptionState(db)) === false, "a reresolve heals it");
}

console.log("[8/8] the CLI resolves private-layer refs under --as");
{
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const cliDir = mkdtempSync(join(tmpdir(), "fein-privacy-cli-"));
  const run = (...cliArgs) => spawnSync(process.execPath, [join(root, "src/cli.js"), ...cliArgs], {
    env: { ...process.env, FEIN_DATA: cliDir },
    encoding: "utf8",
  });
  check(run("members", "add", "Alice Voss", "alicev@example.com").status === 0, "member added via CLI");
  const jsonl = join(cliDir, "priv.jsonl");
  writeFileSync(jsonl, JSON.stringify({
    source: "gmail", kind: "email", external_id: "cli-1", title: "digest",
    occurred_at: "2026-07-01T10:00:00Z",
    people: [{ name: "Robo Digest", email: "digest@robomail.example", role: "from" },
             { name: "Alice Voss", email: "alicev@example.com", role: "to" }],
  }) + "\n");
  check(run("ingest", jsonl, "--as", "Alice Voss").status === 0, "private ingest via CLI");
  check(run("resolve").status === 0, "resolve via CLI");
  // The flagged entity is witnessed only in Alice's private layer: with --as
  // her CLI can name it; without, the "hide" policy keeps it unresolvable.
  const marked = run("automated", "mark", "digest@robomail.example", "--as", "Alice Voss");
  check(marked.status === 0 && /"automated": true/.test(marked.stdout),
    "a private-layer entity is reachable by ref under --as", marked.stderr || marked.stdout);
  const unmarked = run("automated", "unmark", "digest@robomail.example", "--as", "Alice Voss");
  check(unmarked.status === 0 && /"automated": false/.test(unmarked.stdout),
    "and unmark works the same way", unmarked.stderr || unmarked.stdout);
  const blocked = run("automated", "mark", "digest@robomail.example");
  check(blocked.status === 1 && /no entity matching/.test(blocked.stderr),
    "without --as the hide policy still applies", blocked.stderr);
  rmSync(cliDir, { recursive: true, force: true });
}

await db.close();
rmSync(dataDir, { recursive: true, force: true });
if (failures) {
  console.error(`\nPRIVACY TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nPRIVACY TESTS PASSED");

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(join(tmpdir(), "fein-api-"));
process.env.FEIN_DATA = dataDir;
delete process.env.DATABASE_URL;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4977;
const BASE = `http://127.0.0.1:${PORT}`;

// Attio is mocked at the fetch boundary so the connector is covered without a
// live workspace; everything else falls through to the real fetch.
delete process.env.ATTIO_API_KEY;
const realFetch = globalThis.fetch;
const attioJson = (data) => ({ ok: true, status: 200, json: async () => ({ data }), text: async () => "" });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.attio.com")) return realFetch(url, opts);
  if (!(opts.headers?.authorization ?? "").includes("good-key")) {
    return { ok: false, status: 401, text: async () => "invalid token", json: async () => ({}) };
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

const { startWebServer } = await import(join(root, "src/web/server.js"));
const server = await startWebServer(PORT);

let failures = 0;
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
};
const get = async (path) => {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const send = async (method, path, body, headers = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log("[1/10] health, security, empty state");
{
  const h = await get("/api/health");
  check(h.status === 200 && h.body.ok === true && h.body.version, "health reports ok + version", h.body);
  const page = await fetch(BASE + "/");
  check(page.headers.get("content-security-policy")?.includes("default-src 'self'"), "CSP header on pages");
  const stats = await get("/api/stats");
  check(stats.body.documents === 0, "fresh database is empty", stats.body);
  const evil = await send("POST", "/api/sample", {}, { origin: "https://evil.example" });
  check(evil.status === 403, "cross-origin POST is refused", evil);
  const missing = await get("/api/nope");
  check(missing.status === 404, "unknown API route 404s");
}

console.log("[2/10] onboarding: load sample dataset");
{
  const res = await send("POST", "/api/sample", {}, { origin: BASE });
  // 16 seed docs + 22 fixtures (incl. the team); Seb's 2 private emails are a
  // withheld count only — stats are scoped to the viewer like every other read.
  // sample.mbox / sample.ics / contacts.csv stay OUT — they're the live-drag demo.
  check(res.status === 200 && res.body.stats.documents === 38, "sample dataset loads (38 shared docs)", res.body.stats);
  check(res.body.stats.withheldDocuments === 2, "private docs surface only as a withheld count", res.body.stats);
  check(res.body.stats.entities === 26, "sample resolves to 26 entities", res.body.stats);
  check(res.body.stats.pendingExtraction === 20, "fixture bodies are pending extraction", res.body.stats);
  check(res.body.members?.length === 2, "sample seeds the two-member team", res.body.members);
}

console.log("[3/10] read endpoints");
{
  const graph = await get("/api/graph");
  check(graph.body.nodes.length === 14 && graph.body.links.length > 5, "graph payload has people + links",
    { nodes: graph.body.nodes.length, links: graph.body.links.length });
  check(graph.body.totalNodes === 14 && graph.body.truncated === false,
    "a graph under the default limit reports totals, not truncation",
    { totalNodes: graph.body.totalNodes, truncated: graph.body.truncated });
  const bounded = await get("/api/graph?limit=5");
  check(bounded.body.nodes.length === 5 && bounded.body.totalNodes === 14 && bounded.body.truncated === true,
    "limit bounds the payload and reports the full size",
    { nodes: bounded.body.nodes.length, totalNodes: bounded.body.totalNodes, truncated: bounded.body.truncated });
  const boundedIds = new Set(bounded.body.nodes.map((n) => n.id));
  check(bounded.body.links.every((l) => boundedIds.has(l.source) && boundedIds.has(l.target)),
    "every link in a pruned payload keeps both endpoints (d3.forceLink crashes on dangling ids)",
    bounded.body.links.filter((l) => !boundedIds.has(l.source) || !boundedIds.has(l.target)));
  const search = await get("/api/search?q=maya");
  check(search.body.length >= 1 && search.body[0].canonical_name === "Maya Chen", "search finds Maya", search.body);
  const mayaEgo = new Set([search.body[0].id]);
  for (const l of graph.body.links) {
    if (l.source === search.body[0].id) mayaEgo.add(l.target);
    if (l.target === search.body[0].id) mayaEgo.add(l.source);
  }
  const focused = await get(`/api/graph?focus=${search.body[0].id}&radius=1`);
  check(focused.body.nodes.some((n) => n.id === search.body[0].id) &&
        focused.body.nodes.length === mayaEgo.size &&
        focused.body.nodes.every((n) => mayaEgo.has(n.id)),
    "focus+radius=1 returns Maya and exactly her direct connections",
    { got: focused.body.nodes.length, expected: mayaEgo.size });
  const noFocus = await get("/api/graph?focus=does-not-exist");
  check(noFocus.status === 404, "unknown focus entity 404s", noFocus.status);
  const brief = await get(`/api/entity/${search.body[0].id}`);
  check(brief.body.entity && brief.body.connections.length > 0, "entity brief has connections");
  // Human override on the automated flag — the dashboard toggle's endpoint.
  const mark = await send("POST", `/api/entity/${search.body[0].id}/automated`, { automated: true });
  check(mark.status === 200 && mark.body.automated === true && mark.body.name === "Maya Chen",
    "marking an entity automated returns the decision", mark.body);
  const marked = await get(`/api/entity/${search.body[0].id}`);
  check(marked.body.entity.automated === true && marked.body.entity.automated_override === true,
    "the brief reflects the override",
    { automated: marked.body.entity.automated, override: marked.body.entity.automated_override });
  const badFlag = await send("POST", `/api/entity/${search.body[0].id}/automated`, { automated: "yes" });
  check(badFlag.status === 400, "a non-boolean flag 400s", badFlag.status);
  const noEnt = await send("POST", "/api/entity/ent_nope/automated", { automated: true });
  check(noEnt.status === 404, "marking an unknown entity 404s", noEnt.status);
  const unmark = await send("POST", `/api/entity/${search.body[0].id}/automated`, { automated: false });
  check(unmark.status === 200 && unmark.body.automated === false, "unmarking works the same way", unmark.body);
  const unmarked = await get(`/api/entity/${search.body[0].id}`);
  check(unmarked.body.entity.automated === false && unmarked.body.entity.automated_override === false,
    "unmark is a durable human decision (confirmed human), not a reset",
    { automated: unmarked.body.entity.automated, override: unmarked.body.entity.automated_override });
  const dana = (await get("/api/search?q=dana")).body[0];
  const priya = (await get("/api/search?q=priya")).body[0];
  const path = await get(`/api/path?from=${dana.id}&to=${priya.id}`);
  check(path.body.path && path.body.path.path.length >= 2, "warm path resolves", path.body.path);
  check(Array.isArray(path.body.introducers), "introducers array present");
  const badPath = await get("/api/path?from=onlyone");
  check(badPath.status === 400, "missing param 400s", badPath);
  const docs = await get("/api/documents");
  // 40 ingested minus Seb's 2 private emails: the shared view counts what it may show.
  check(docs.body.total === 38 && docs.body.withheld === 2 && docs.body.sources.length >= 4,
    "documents breakdown by source, private layer withheld", { total: docs.body.total, withheld: docs.body.withheld });
}

console.log("[4/10] review flow + audit");
{
  const reviews = await get("/api/reviews");
  check(reviews.body.length === 1, "one pending review (M. Chen)", reviews.body.length);
  const bad = await send("POST", `/api/reviews/${reviews.body[0].id}`, { decision: "maybe" });
  check(bad.status === 400, "invalid decision 400s");
  const gBefore = await get("/api/graph");
  const ok = await send("POST", `/api/reviews/${reviews.body[0].id}`, { decision: "accept" });
  check(ok.status === 200 && ok.body.entity, "review accept succeeds and names the entity", ok.body);
  // The accept triggers an incremental rebuild: the M. Chen email (Maya <-> Dana)
  // must land in the graph without a full rebuild, and corrupt nothing else.
  const gAfter = await get("/api/graph");
  const mayaId = (await get("/api/search?q=maya")).body[0].id;
  const danaId = (await get("/api/search?q=dana")).body[0].id;
  const strengthOf = (g, x, y) => g.body.links.find((l) =>
    [l.source, l.target].includes(x) && [l.source, l.target].includes(y))?.strength ?? 0;
  check(strengthOf(gAfter, mayaId, danaId) > strengthOf(gBefore, mayaId, danaId),
    "the accepted mention's evidence strengthens Maya–Dana incrementally",
    { before: strengthOf(gBefore, mayaId, danaId), after: strengthOf(gAfter, mayaId, danaId) });
  check(gAfter.body.links.length >= gBefore.body.links.length &&
        gAfter.body.links.every((l) => Number.isFinite(l.strength)),
    "no other edge is lost or corrupted by the incremental pass",
    { before: gBefore.body.links.length, after: gAfter.body.links.length });
  const audit = await get("/api/audit");
  check(audit.body.some((a) => a.action === "review_accept"), "audit trail records the decision",
    audit.body.map((a) => a.action));
}

console.log("[5/10] settings: customization rebuilds the graph");
{
  const before = await get("/api/settings");
  check(before.body.weights.meeting === 3 && before.body.halfLifeDays === 180, "default settings served", before.body);
  check(before.body.maxDocParticipants === 50, "participant cap default is served", before.body.maxDocParticipants);
  const beforeGraph = await get("/api/graph");
  const beforeStrength = Math.max(...beforeGraph.body.links.map((l) => l.strength));
  const res = await send("PUT", "/api/settings", { weights: { meeting: 10 }, saturation: 3 });
  check(res.status === 200 && res.body.settings.weights.meeting === 10, "settings saved", res.body.settings);
  const afterGraph = await get("/api/graph");
  const afterStrength = Math.max(...afterGraph.body.links.map((l) => l.strength));
  check(afterStrength > beforeStrength, "weight change strengthens edges",
    { before: beforeStrength, after: afterStrength });
  const cap = await send("PUT", "/api/settings", { maxDocParticipants: 80 });
  check(cap.status === 200 && cap.body.settings.maxDocParticipants === 80 && cap.body.edges,
    "participant cap round-trips and rebuilds edges", cap.body.settings);
  const invalid = await send("PUT", "/api/settings", { weights: { nonsense: 5 } });
  check(invalid.status === 400, "unknown weight is rejected with 400", invalid.status);
  check(/unknown weight/.test(invalid.body?.error ?? ""), "client error message is preserved", invalid.body);

  // Scoring thresholds are settings: partial patches deep-merge, unrelated
  // saves must not erase them, and inverted bands are refused.
  const res1 = await send("PUT", "/api/settings", { resolution: { autoMerge: 0.99 } });
  check(res1.status === 200 && res1.body.settings.resolution.autoMerge === 0.99,
    "resolution.autoMerge round-trips", res1.body.settings?.resolution);
  const merged = await get("/api/settings");
  check(merged.body.resolution.review === 0.7,
    "a partial resolution patch keeps the sibling default (deep-merge)", merged.body.resolution);
  await send("PUT", "/api/settings", { weights: { meeting: 10 } });
  check((await get("/api/settings")).body.resolution.autoMerge === 0.99,
    "a weights-only save keeps the stored thresholds (field-list trap)");
  await send("PUT", "/api/settings", { resolution: { autoMerge: 0.95 } });
  const inverted = await send("PUT", "/api/settings", { resolution: { review: 0.96 } });
  check(inverted.status === 400 && /must be below/.test(inverted.body?.error ?? ""),
    "a review floor above auto-merge is a 400 (inverted band)", inverted.body);
  const radarInverted = await send("PUT", "/api/settings", { radar: { overdueRatio: 5 } });
  check(radarInverted.status === 400,
    "an overdue ratio above the cold ratio is a 400 (overdue unreachable)", radarInverted.body);
  const radarUnknown = await send("PUT", "/api/settings", { radar: { nonsense: 1 } });
  check(radarUnknown.status === 400 && /unknown radar setting/.test(radarUnknown.body?.error ?? ""),
    "an unknown radar setting is a 400", radarUnknown.body);
  const hopRange = await send("PUT", "/api/settings", { privateHopStrength: 7 });
  check(hopRange.status === 400, "privateHopStrength outside (0,1) is a 400", hopRange.body);

  // `?as=` on a write names the audit actor (display name, never an id/email).
  const tom = (await get("/api/members")).body.find((m) => m.name === "Tom Merrill");
  const asTom = await send("PUT", `/api/settings?as=${tom.id}`, { weights: { meeting: 10 } });
  check(asTom.status === 200, "settings PUT accepts ?as", asTom.status);
  const audit = await get("/api/audit");
  const row = audit.body.find((a) => a.action === "settings_update");
  check(row?.actor === "Tom Merrill", "the ?as viewer is recorded as the audit actor", row);
}

console.log("[6/10] hostile input");
{
  // Malformed request targets must not crash the process.
  for (const target of ["//%ff", "//[", "//:", "//%c0%ae", "//"]) {
    await fetch(BASE + target).catch(() => {});
  }
  const alive = await get("/api/health");
  check(alive.status === 200, "server survives malformed request targets", alive.status);

  // Prototype-named document kinds must not poison scoring or the graph.
  const poison = JSON.stringify({
    source: "local", kind: "toString", external_id: "poison-1",
    title: "prototype probe", occurred_at: "2026-08-01T00:00:00Z",
    people: [{ name: "Maya Chen", email: "maya@nordwind.vc", role: "from" },
             { name: "Dana Whitfield", email: "dana@foxglove.vc", role: "to" }],
  });
  const pRes = await send("POST", "/api/ingest?name=poison.jsonl", poison);
  check(pRes.status === 200, "prototype-named kind ingests without error", pRes.status);
  const g = await get("/api/graph");
  const bad = g.body.links.filter((l) => !Number.isFinite(l.strength));
  check(bad.length === 0, "no non-finite edge strengths after prototype probe", bad);
  check(g.body.links.length > 5, "relationships survive the prototype probe", g.body.links.length);

  const protoWeight = await send("PUT", "/api/settings", { weights: { toString: 9 } });
  check(protoWeight.status === 400, "prototype-named weight is rejected with 400", protoWeight);
  const protoRes = await send("PUT", "/api/settings", { resolution: { toString: 9 } });
  check(protoRes.status === 400, "prototype-named resolution setting is rejected with 400", protoRes);

  // Hostile graph bounds clamp, never crash: 0/negative floor at one node,
  // junk falls back to the default (everything, on a sample-sized graph).
  const zero = await get("/api/graph?limit=0");
  check(zero.status === 200 && zero.body.nodes.length === 1 && zero.body.truncated === true,
    "limit=0 clamps to one node", { status: zero.status, nodes: zero.body?.nodes?.length });
  const negative = await get("/api/graph?limit=-3");
  check(negative.status === 200 && negative.body.nodes.length === 1,
    "negative limit clamps to one node", { status: negative.status, nodes: negative.body?.nodes?.length });
  const junk = await get("/api/graph?limit=junk");
  check(junk.status === 200 && junk.body.nodes.length === junk.body.totalNodes && junk.body.truncated === false,
    "junk limit falls back to the default", { status: junk.status, nodes: junk.body?.nodes?.length });
}

console.log("[7/10] attio connector (mocked workspace)");
{
  check((await get("/api/connectors/attio")).body.connected === false, "starts disconnected");
  const bad = await send("POST", "/api/connectors/attio", { apiKey: "wrong" });
  check(bad.status === 400 && /rejected/i.test(bad.body.error), "bad key rejected with a useful message", bad.body);
  check((await get("/api/connectors/attio")).body.connected === false, "a failed connect stores nothing");

  const ok = await send("POST", "/api/connectors/attio", { apiKey: "good-key-abcd1234" });
  check(ok.status === 200 && ok.body.connected, "valid key connects", ok.body);
  check(ok.body.keyHint === "····1234" && !JSON.stringify(ok.body).includes("good-key-abcd1234"),
    "only a masked hint is returned, never the key", ok.body.keyHint);

  const sync = await send("POST", "/api/connectors/attio/sync");
  check(sync.status === 200 && sync.body.ingested.docCount === 3, "sync ingests people, companies and notes", sync.body.ingested);
  const maya = (await get("/api/search?q=maya")).body[0];
  check(maya?.emails.includes("maya@nordwind.vc"), "Attio contact merges with the existing person", maya?.emails);

  const audit = await get("/api/audit");
  check(!JSON.stringify(audit.body).includes("good-key"), "the key never reaches the audit log");
  const gone = await send("DELETE", "/api/connectors/attio");
  check(gone.body.connected === false, "disconnect clears the key", gone.body);
  const docs = await get("/api/documents");
  check(docs.body.sources.some((s) => s.source === "attio"), "disconnect keeps ingested data");
}

console.log("[8/10] upload + reresolve");
{
  const csv = readFileSync(join(root, "sample/contacts.csv"), "utf8");
  const up = await send("POST", "/api/ingest?name=contacts.csv", csv);
  check(up.status === 200 && up.body.ingested.docCount === 3, "csv upload ingests", up.body.ingested);
  const badUp = await send("POST", "/api/ingest?name=evil.exe", "MZ");
  check(badUp.status === 400, "unsupported upload type 400s", badUp.status);
  const rr = await send("POST", "/api/reresolve", {});
  check(rr.status === 200, "reresolve succeeds", rr.status);
  check(rr.body.replayed === 1 && (rr.body.dropped ?? []).length === 0,
    "the accepted review decision is replayed, not lost", { replayed: rr.body.replayed, dropped: rr.body.dropped });
  check(rr.body.automatedOverrides?.replayed === 1 && rr.body.automatedOverrides.dropped.length === 0,
    "the automated override survives the rebuild too", rr.body.automatedOverrides);
  const maya = (await get("/api/search?q=maya")).body[0];
  check(maya.emails.includes("mchen@gmail.com"),
    "replayed accept restores the merged gmail alias", maya.emails);
  const mayaBrief = await get(`/api/entity/${maya.id}`);
  check(mayaBrief.body.entity.automated_override === false && mayaBrief.body.entity.automated === false,
    "the replayed override still says confirmed-human", {
      automated: mayaBrief.body.entity.automated, override: mayaBrief.body.entity.automated_override });
  const post = await get("/api/reviews");
  check(post.body.length === 0, "no re-asked question after replay", post.body.length);
}

console.log("[9/10] privacy layers: one-click scene, private upload, scoping");
{
  const members = (await get("/api/members")).body;
  const tom = members.find((m) => m.name === "Tom Merrill");
  const seb = members.find((m) => m.name === "Seb Larkin");
  check(tom && seb, "the sample seeded the team", members.map((m) => m.name));
  const again = await send("POST", "/api/sample", {});
  check(again.status === 200 && (await get("/api/members")).body.length === members.length,
    "reloading the sample never duplicates members");

  const docs = await get("/api/documents");
  check(docs.body.withheld === 2, "Seb's two private documents are withheld from the shared view", docs.body.withheld);
  const sebDocs = await get(`/api/documents?as=${seb.id}`);
  check(!sebDocs.body.withheld, "nothing is withheld from their owner", sebDocs.body.withheld);

  // One resolver everywhere: reads now fail loudly on an unknown ?as= (they
  // used to answer silently from the shared layer) and take names/emails
  // like /mcp and ingest always did.
  check((await get("/api/documents?as=nobody")).status === 400,
    "unknown ?as on a read is a hard 400, never the shared layer");
  check((await get("/api/graph?as=nobody")).status === 400,
    "unknown ?as on the graph is a hard 400");
  const byName = await get("/api/documents?as=Seb%20Larkin");
  const byEmail = await get("/api/documents?as=seb@ridgeline.vc");
  check(byName.status === 200 && byName.body.total === sebDocs.body.total && !byName.body.withheld,
    "?as= accepts an exact member name on reads", byName.body);
  check(byEmail.status === 200 && byEmail.body.total === sebDocs.body.total && !byEmail.body.withheld,
    "?as= accepts a member email on reads", byEmail.body);

  const tomE = (await get("/api/search?q=tom")).body.find((e) => e.canonical_name === "Tom Merrill");
  const priyaE = (await get("/api/search?q=priya")).body[0];
  const path = await get(`/api/path?from=${tomE.id}&to=${priyaE.id}&as=${tom.id}`);
  check(path.body.path?.path?.length >= 2, "Tom has his own public route to Priya", path.body.path?.pathStrength);
  check(path.body.viaPrivate?.some((v) => v.owner === "Seb Larkin"),
    "\"ask a colleague\" names Seb without exposing evidence", path.body.viaPrivate);

  const secret = JSON.stringify({
    source: "local", kind: "note", external_id: "priv-tom-1", title: "ZARA-PRIVATE-MARKER",
    occurred_at: "2026-08-01T00:00:00Z",
    people: [{ name: "Tom Merrill", email: "tom@ridgeline.vc", role: "from" },
             { name: "Zara Quist", email: "zara@quist.example", role: "to" }],
  });
  const badAs = await send("POST", "/api/ingest?name=p.jsonl&as=nobody", secret);
  check(badAs.status === 400, "unknown member on private ingest is a hard 400", badAs.status);
  const up = await send("POST", `/api/ingest?name=zara-inbox.jsonl&as=${tom.id}`, secret);
  check(up.status === 200 && up.body.layer === "Tom Merrill", "upload lands in Tom's private layer", up.body.layer);
  const audit = await get("/api/audit");
  const row = audit.body.find((a) => a.detail?.layer === "Tom Merrill");
  check(row && row.detail.file === "(private upload)" && !JSON.stringify(audit.body).includes("zara-inbox"),
    "audit records whose layer grew, never the private filename", row?.detail);
  check(row?.actor === "Tom Merrill", "the private upload's audit row names the uploader as actor", row?.actor);
  const sharedGraph = await get("/api/graph");
  check(!sharedGraph.body.nodes.some((n) => n.name === "Zara Quist"),
    "a private-only person is hidden from the shared graph");
  const tomGraph = await get(`/api/graph?as=${tom.id}`);
  check(tomGraph.body.nodes.some((n) => n.name === "Zara Quist"), "her owner sees her");

  // A guessed private id must not resolve as a graph focus — the same gate
  // entityBrief enforces. Her owner, of course, can focus on her.
  const zara = (await get(`/api/search?q=zara&as=${tom.id}`)).body
    .find((e) => e.canonical_name === "Zara Quist");
  const sharedFocus = await get(`/api/graph?focus=${zara.id}`);
  check(sharedFocus.status === 404, "a private-only person cannot be a shared-view focus", sharedFocus.status);
  const tomFocus = await get(`/api/graph?as=${tom.id}&focus=${zara.id}`);
  check(tomFocus.status === 200 && tomFocus.body.nodes.some((n) => n.name === "Zara Quist"),
    "her owner can focus the graph on her", tomFocus.status);

  // The automated toggle honors the same gate: a guessed private id must not
  // become a write-side probe around the "hide" policy.
  const zMark = await send("POST", `/api/entity/${zara.id}/automated`, { automated: true });
  check(zMark.status === 404, "a private-only entity cannot be marked from the shared view", zMark.status);
  const zOwn = await send("POST", `/api/entity/${zara.id}/automated?as=${tom.id}`, { automated: true });
  check(zOwn.status === 200 && zOwn.body.automated === true, "her owner can mark her", zOwn.body);
  await send("POST", `/api/entity/${zara.id}/automated?as=${tom.id}`, { automated: false });

  // Stats are viewer-scoped like every other read: Tom's private upload and
  // its private-only person count for Tom alone.
  const sharedStats = (await get("/api/stats")).body;
  const tomStats = (await get(`/api/stats?as=${tom.id}`)).body;
  check(tomStats.documents === sharedStats.documents + 1, "a private upload counts only for its owner",
    { shared: sharedStats.documents, tom: tomStats.documents });
  check(tomStats.entities > sharedStats.entities, "private-only Zara is not in the shared entity count",
    { shared: sharedStats.entities, tom: tomStats.entities });

  // A fuzzy match rooted in Tom's private mail: name-variant of a shared
  // person plus a new freemail address scores in the 0.70–0.95 review band
  // (mirroring the M. Chen seed fixture), so the badge must agree with the
  // queue for every viewer — a review card quotes the private document.
  const fuzzy = JSON.stringify({
    source: "local", kind: "email", external_id: "priv-tom-2", title: "intro thread",
    occurred_at: "2026-08-03T00:00:00Z",
    people: [{ name: "D. Whitfield", email: "dwhitfield@gmail.com", role: "from" }],
  });
  const fUp = await send("POST", `/api/ingest?name=fuzzy.jsonl&as=${tom.id}`, fuzzy);
  check(fUp.status === 200 && fUp.body.resolved.queued === 1, "private fuzzy mention queues for review", fUp.body.resolved);
  const sharedAfter = (await get("/api/stats")).body;
  const tomAfter = (await get(`/api/stats?as=${tom.id}`)).body;
  check(sharedAfter.pendingReviews === 0 && tomAfter.pendingReviews === 1,
    "the reviews badge counts only reviews the viewer may see",
    { shared: sharedAfter.pendingReviews, tom: tomAfter.pendingReviews });
  check((await get("/api/reviews")).body.length === sharedAfter.pendingReviews &&
        (await get(`/api/reviews?as=${tom.id}`)).body.length === tomAfter.pendingReviews,
    "badge equals queue length for both viewers");

  // Mutation responses hint stats for the SAME viewer the request named —
  // shared-scoped numbers next to viewer-scoped tiles would contradict the
  // dashboard on screen.
  const rrTom = await send("POST", `/api/reresolve?as=${tom.id}`, {});
  check(rrTom.status === 200 && rrTom.body.stats.documents === tomAfter.documents,
    "a mutation's stats hint is scoped to the requesting viewer",
    { got: rrTom.body?.stats?.documents, want: tomAfter.documents });
  // Zara is witnessed only in Tom's private layer: her confirmed-human
  // override must replay through the evidence union, not drop.
  check(rrTom.body.automatedOverrides.replayed === 2 &&
        rrTom.body.automatedOverrides.dropped.length === 0,
    "overrides on privately-evidenced entities replay through the rebuild too",
    rrTom.body.automatedOverrides);
}

console.log("[10/10] MCP over HTTP: one endpoint, viewer-scoped");
{
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const connect = async (qs = "") => {
    const client = new Client({ name: "api-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp${qs}`)));
    return client;
  };
  const asText = (r) => JSON.parse(r.content[0].text);

  const client = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.length === 11 && tools.includes("meeting_prep") && tools.includes("company_memory"),
    "all 11 tools listed over HTTP", tools);
  const stats = asText(await client.callTool({ name: "graph_stats", arguments: {} }));
  check(stats.documents > 0, "graph_stats answers from the live database", stats.documents);
  const shared = asText(await client.callTool({ name: "entity_brief", arguments: { entity: "Priya Nair" } }));
  check(shared.withheldDocuments >= 2, "a shared-layer agent gets a withheld count, not content", shared.withheldDocuments);
  check(!JSON.stringify(shared).includes("Fund II allocation — timing question"),
    "private titles never reach the shared-layer agent");
  await client.close();

  const sebClient = await connect("?as=Seb%20Larkin");
  const own = asText(await sebClient.callTool({ name: "entity_brief", arguments: { entity: "Priya Nair" } }));
  check(JSON.stringify(own).includes("Fund II allocation — timing question"),
    "?as=Seb binds the agent to Seb's private layer");
  const sebStats = asText(await sebClient.callTool({ name: "graph_stats", arguments: {} }));
  check(sebStats.documents === stats.documents + 2,
    "graph_stats honors the bound viewer (Seb's 2 private docs)",
    { shared: stats.documents, seb: sebStats.documents });

  // An agent's decision is audited as agent:<member>. Exact name + conflicting
  // non-freemail domain scores 0.90 — deterministically in the review band.
  const seb = (await get("/api/members")).body.find((m) => m.name === "Seb Larkin");
  const rival = JSON.stringify({
    source: "local", kind: "email", external_id: "rival-1", title: "intro?",
    occurred_at: "2026-08-02T00:00:00Z",
    people: [{ name: "Maya Chen", email: "maya@rivalfund.example", role: "from" }],
  });
  const rIngest = await send("POST", "/api/ingest?name=rival.jsonl", rival);
  check(rIngest.status === 200 && rIngest.body.resolved.queued === 1,
    "conflicting-domain mention queues for review", rIngest.body.resolved);
  const review = (await get(`/api/reviews?as=${seb.id}`)).body
    .find((r) => r.mention_email === "maya@rivalfund.example");
  check(Boolean(review), "the queued review is visible to Seb's agent");
  await sebClient.callTool({ name: "review_resolve",
    arguments: { review_id: review.id, decision: "accept" } });
  const agentRow = (await get("/api/audit")).body
    .find((a) => a.action === "review_accept" && a.detail?.review === review.id);
  check(agentRow?.actor === "agent:Seb Larkin",
    "the MCP decision is audited as agent:<member>", agentRow);
  await sebClient.close();

  const rejected = await fetch(`${BASE}/mcp`);
  check(rejected.status === 405, "GET /mcp is refused (POST JSON-RPC only)", rejected.status);
  const badViewer = await send("POST", "/mcp?as=nobody", {});
  check(badViewer.status === 400, "unknown ?as member is a hard 400, never a silent fallback", badViewer.status);
}

server.close();
// Server holds the PGlite handle; give closes a beat, then clean up.
await new Promise((r) => setTimeout(r, 300));
rmSync(dataDir, { recursive: true, force: true });

if (failures) {
  console.error(`\nAPI TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("\nAPI TESTS PASSED");
process.exit(0);

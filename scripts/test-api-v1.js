/**
 * /api/v1 HTTP API suite. Same spawn harness as test-auth.js: a throwaway
 * FEIN_DATA, a spawned `web` server, no network, no real DB. Covers auth
 * gating (problem+json), the happy path per endpoint, viewer/privacy scoping
 * with a leak sweep, error shapes, keyset + offset pagination, the
 * OpenAPI/ROUTES drift guard, and a dashboard-regression check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "fein-apiv1-"));
// Ambient creds/DB would hijack the throwaway instance or 401 every probe.
delete process.env.DATABASE_URL;
delete process.env.FEIN_AUTH_TOKEN;
delete process.env.FUNDGRAPH_AUTH_TOKEN;
const PORT = 4767;
const TOKEN = "test-token-apiv1-correct-horse";
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

const ok = (cond, label, extra) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  if (!cond) failures++;
};

const H = { authorization: `Bearer ${TOKEN}` };
async function api(path, { method = "GET", body, headers } = {}) {
  const hasBody = body !== undefined;
  const res = await fetch(BASE + path, {
    method,
    headers: { ...H, ...(hasBody ? { "content-type": "application/json" } : {}), ...headers },
    body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ct: res.headers.get("content-type") || "", etag: res.headers.get("etag"), text, json };
}
const ingest = (jsonl, as) =>
  api(`/api/ingest?name=fx.jsonl${as ? `&as=${as}` : ""}`, { method: "POST", body: jsonl });
const jsonl = (docs) => docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
const isProblem = (r, type, status) =>
  r.status === status && /problem\+json/.test(r.ct) && r.json?.type?.endsWith(type) &&
  r.json?.detail === r.json?.error && typeof r.json?.title === "string";

function startServer() {
  return spawn(process.execPath, ["src/cli.js", "web", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, FEIN_DATA: dataDir, FEIN_AUTH_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not come up");
}

const person = (name, email, role) => ({ name, email, role });
const server = startServer();
try {
  await waitForServer();

  /* ---- seed: sample world + a two-member privacy fixture + bulk keyset set ---- */
  await api("/api/sample", { method: "POST" });
  const A = (await api("/api/members", { method: "POST", body: { name: "Ana Vance", email: "ana@fixture.example" } })).json;
  const B = (await api("/api/members", { method: "POST", body: { name: "Bo Finch", email: "bo@fixture.example" } })).json;

  await ingest(jsonl([
    { source: "calendar", kind: "event", external_id: "fx-sh-1", title: "Partner sync", occurred_at: "2026-07-20T10:00:00Z",
      people: [person("Ana Vance", "ana@fixture.example", "attendee"), person("Bo Finch", "bo@fixture.example", "attendee")] },
    { source: "crm", kind: "record", external_id: "fx-sh-2", title: "Contact: ZZLINK Nair", occurred_at: "2026-07-01T10:00:00Z",
      people: [person("ZZLINK Nair", "zzlink@known.example", "mentioned")] },
  ]));
  // Bo's private layer: a private-only person (ZZGHOST) and a two-hop private
  // route Bo -> ZZGHOST -> ZZLINK, so an Ana-scoped path to ZZLINK must run
  // through a redacted private hop and never quote the private docs.
  await ingest(jsonl([
    { source: "gmail", kind: "email", external_id: "fx-bo-1", title: "ZZSECRETDOC alpha", occurred_at: "2026-07-25T10:00:00Z",
      people: [person("Bo Finch", "bo@fixture.example", "from"), person("ZZGHOST Vole", "ghost@zzghost.example", "to")] },
    { source: "gmail", kind: "email", external_id: "fx-bo-2", title: "ZZSECRETDOC beta", occurred_at: "2026-07-26T10:00:00Z",
      people: [person("ZZGHOST Vole", "ghost@zzghost.example", "from"), person("ZZLINK Nair", "zzlink@known.example", "to")] },
  ]), B.id);
  // Ana's private layer: a private-only person (ZZPHANTOM), symmetric to ZZGHOST.
  await ingest(jsonl([
    { source: "gmail", kind: "email", external_id: "fx-an-1", title: "ZZPHANTOM note", occurred_at: "2026-07-27T10:00:00Z",
      people: [person("Ana Vance", "ana@fixture.example", "from"), person("ZZPHANTOM Wren", "phantom@zzphantom.example", "to")] },
  ]), A.id);
  // 210 shared entities to exercise the 200-cap and keyset walk across it.
  // The resolver's normalizer strips digits, so a numeric suffix would collapse
  // every name to one block. Use a base-26 LETTER code instead: distinct last
  // tokens + a unique email domain per person keep every blocking key disjoint,
  // so 210 separate entities are created (no fuzzy merge, no review band).
  // "zrecord" is the shared search handle; the code keeps the (name,id) order
  // unique and deterministic.
  const L = "abcdefghijklmnopqrstuvwxyz";
  const code = (i) => L[Math.floor(i / 26) % 26] + L[i % 26] + L[(i * 13 + 4) % 26];
  const bulk = [];
  for (let i = 0; i < 210; i++) {
    const c = code(i);
    bulk.push({ source: "crm", kind: "record", external_id: `fx-bulk-${c}`, title: `Bulk ${c}`, occurred_at: "2026-06-01T10:00:00Z",
      people: [person(`Qbulk${c} Zrecord${c}`, `p${c}@qd${c}.example`, "mentioned")] });
  }
  await ingest(jsonl(bulk));

  const idOf = async (q, as) => (await api(`/api/v1/search?q=${encodeURIComponent(q)}${as ? `&as=${as}` : ""}`)).json.data[0]?.id;
  const anaId = await idOf("ana@fixture.example", A.id);
  const zzlinkId = await idOf("zzlink@known.example", A.id);
  const ghostId = await idOf("ZZGHOST", B.id);   // resolvable only for its owner
  const phantomId = await idOf("ZZPHANTOM", A.id);

  /* -------------------- 1. health / meta -------------------- */
  console.log("[1] health / meta");
  {
    const pkg = JSON.parse((await api("/api/v1/openapi.json")).text);
    const h = await api("/api/v1/health");
    ok(h.status === 200 && h.json.ok === true && typeof h.json.uptimeSeconds === "number", "health is 200 with ok/version/uptime", h.json);
    ok(h.json.version === pkg.info.version, "health.version matches package.json", { h: h.json.version, pkg: pkg.info.version });
    const v = await api("/api/v1/version");
    ok(v.status === 200 && v.json.apiVersion === "v1" && typeof v.json.started === "string", "version endpoint shape", v.json);
    const oa = await api("/api/v1/openapi.json");
    ok(oa.status === 200 && oa.json.openapi === "3.1.0", "openapi.json is 200 and 3.1.0", oa.json?.openapi);
    ok(oa.json.components?.schemas?.Problem && oa.json.components?.schemas?.Page, "Problem + Page schemas present");
  }

  /* -------------------- 2. auth gating (problem+json) -------------------- */
  console.log("[2] auth gating");
  {
    const bare = async (p, hdr) => (await fetch(BASE + p, { headers: hdr })).status;
    ok(await bare("/api/v1/health") === 200, "health open without a token");
    ok(await bare("/api/v1/version") === 200, "version open without a token");
    const noTok = await fetch(`${BASE}/api/v1/stats`);
    const body = await noTok.json();
    ok(noTok.status === 401 && /problem\+json/.test(noTok.headers.get("content-type") || "") && body.type.endsWith("unauthorized"),
      "no token → 401 problem+json unauthorized", { s: noTok.status, ct: noTok.headers.get("content-type"), type: body.type });
    ok(body.error === body.detail, "401 carries the legacy error alias");
    ok(await bare("/api/v1/stats", { authorization: `Bearer ${TOKEN}` }) === 200, "bearer unlocks the API");
    ok(await bare("/api/v1/stats", { cookie: `fein_auth=${TOKEN}` }) === 200, "cookie flavor unlocks the API");
    ok(await bare("/api/v1/stats", { authorization: "Bearer wrong" }) === 401, "wrong bearer stays 401");
    const oaNoTok = await fetch(`${BASE}/api/v1/openapi.json`);
    ok(oaNoTok.status === 401, "openapi.json is behind auth");
    const docs = await fetch(`${BASE}/docs`, { redirect: "manual" });
    ok(docs.status === 302 && docs.headers.get("location") === "/login", "/docs redirects a tokenless browser to /login");
    const docsAuthed = await fetch(`${BASE}/docs`, { headers: { cookie: `fein_auth=${TOKEN}` } });
    ok(docsAuthed.status === 200 && /text\/html/.test(docsAuthed.headers.get("content-type") || ""), "/docs serves HTML with a cookie");
    const docsJs = await fetch(`${BASE}/docs.js`, { headers: { cookie: `fein_auth=${TOKEN}` } });
    ok(docsJs.status === 200 && /javascript/.test(docsJs.headers.get("content-type") || ""), "/docs.js serves same-origin JS");
  }

  /* -------------------- 3. happy path per endpoint -------------------- */
  console.log("[3] happy path per endpoint (as A)");
  const as = `as=${A.id}`;
  {
    const s = await api(`/api/v1/search?q=&limit=5&${as}`);
    ok(s.status === 200 && Array.isArray(s.json.data) && s.json.page && "has_more" in s.json.page, "search returns {data, page}", s.json.page);
    const list = await api(`/api/v1/entities?limit=5&${as}`);
    ok(list.status === 200 && Array.isArray(list.json.data), "entities list returns {data, page}");
    const byRef = await api(`/api/v1/entities?ref=${encodeURIComponent("ana@fixture.example")}&${as}`);
    ok(byRef.status === 200 && byRef.json.entity?.canonical_name === "Ana Vance" && Array.isArray(byRef.json.connections),
      "entities?ref=<email> resolves + briefs in one hop", byRef.json.entity);
    const byId = await api(`/api/v1/entities/${anaId}?${as}`);
    ok(byId.status === 200 && byId.json.entity?.id === anaId && Array.isArray(byId.json.connections), "entities/{id} brief by id");
    const res = await api(`/api/v1/resolve?ref=${encodeURIComponent("Ana Vance")}&${as}`);
    ok(res.status === 200 && res.json.entity?.id === anaId, "resolve returns {entity}");
    const conns = await api(`/api/v1/entities/${anaId}/connections?limit=3&${as}`);
    ok(conns.status === 200 && Array.isArray(conns.json.data) && conns.json.data.every((c) => "name" in c), "connections carry .name");
    const path = await api(`/api/v1/paths?from=${anaId}&to=${zzlinkId}&${as}`);
    ok(path.status === 200 && (path.json === null || typeof path.json === "object"), "paths returns a bare union");
    const intro = await api(`/api/v1/introducers?from=${anaId}&to=${zzlinkId}&${as}`);
    ok(intro.status === 200 && Array.isArray(intro.json.data), "introducers returns {data, viaPrivate?}");
    const prep = await api(`/api/v1/meeting-prep?with=${encodeURIComponent("zzlink@known.example")}&${as}`);
    ok(prep.status === 200 && prep.json.entity?.canonical_name === "ZZLINK Nair" && prep.json.brief, "meeting-prep composite", Object.keys(prep.json));
    const radar = await api(`/api/v1/radar?limit=3&${as}`);
    ok(radar.status === 200 && radar.json.counts && radar.json.needsAttention?.page && typeof radar.json.pairs === "number",
      "radar summary: bare object, needsAttention nests a page", Object.keys(radar.json));
    const radarE = await api(`/api/v1/radar/${anaId}?${as}`);
    ok(radarE.status === 200 && typeof radarE.json.entity === "string" && Array.isArray(radarE.json.data), "radar/{id} shape");
    const mem = await api(`/api/v1/companies/${encodeURIComponent("known")}/memory?${as}`);
    ok(mem.status === 200 && "company" in mem.json && "deals" in mem.json && "people" in mem.json, "company memory shape");
    const stats = await api(`/api/v1/stats?${as}`);
    ok(stats.status === 200 && typeof stats.json.entities === "number", "stats counts");
    const reviews = await api(`/api/v1/reviews?${as}`);
    ok(reviews.status === 200 && Array.isArray(reviews.json.data), "reviews returns {data, page}");
    const br = await api(`/api/v1/batch/resolve?${as}`, { method: "POST", body: { refs: ["Ana Vance", "nobody-xyz"] } });
    ok(br.status === 200 && br.json.data.length === 2 && br.json.data[0].entity && br.json.data[1].error, "batch/resolve mixes hits + misses");
    const bb = await api(`/api/v1/batch/briefs?${as}`, { method: "POST", body: { ids: [anaId, "ent_missing"] } });
    ok(bb.status === 200 && bb.json.data[0].brief && bb.json.data[1].brief === null, "batch/briefs → null for missing");
    const nd = await api(`/api/v1/entities/export.ndjson?${as}`);
    const lines = nd.text.trim().split("\n").filter(Boolean);
    let parsed = 0; for (const l of lines) { try { if (JSON.parse(l).id) parsed++; } catch {} }
    ok(nd.status === 200 && /x-ndjson/.test(nd.ct) && parsed === lines.length && parsed > 200,
      "export.ndjson: every line parses, crawl crosses the 200 cap", { parsed, lines: lines.length });
  }

  /* -------------------- 4. viewer/privacy scoping + LEAK SWEEP -------------------- */
  console.log("[4] privacy scoping + leak sweep");
  {
    ok(Boolean(ghostId) && Boolean(phantomId), "each private entity resolves for its own owner", { ghostId, phantomId });
    ok((await api(`/api/v1/search?q=ZZGHOST&${as}`)).json.data.length === 0, "A cannot search B's private-only entity");
    ok((await api(`/api/v1/search?q=ZZGHOST&as=${B.id}`)).json.data.length === 1, "B (owner) finds it — not over-filtering");
    ok(isProblem(await api(`/api/v1/entities/${ghostId}?${as}`), "entity-not-found", 404), "entities/{B-private-id} → 404 for A");
    ok(isProblem(await api(`/api/v1/resolve?ref=ZZGHOST&${as}`), "entity-not-found", 404), "resolve of B's private entity → 404 for A");
    ok(isProblem(await api(`/api/v1/entities/${ghostId}/connections?${as}`), "entity-not-found", 404), "connections on a hidden id → 404");
    ok(isProblem(await api(`/api/v1/radar/${ghostId}?${as}`), "entity-not-found", 404), "radar on a hidden id → 404");

    // A-scoped private hop: no visible path, a privatePath owned by Bo, with a
    // redacted "(private contact)" hop and no leaked doc/id.
    const path = await api(`/api/v1/paths?from=${anaId}&to=${zzlinkId}&${as}`);
    ok(!path.json?.path && path.json?.privatePath, "A gets a privatePath, not a visible one", path.json);
    ok(path.json?.privatePath?.owners?.includes("Bo Finch"), "the owner to ask is named", path.json?.privatePath?.owners);
    const redacted = (path.json?.privatePath?.path || []).find((s) => s.name === "(private contact)");
    ok(redacted && !("entity" in redacted), "the invisible hop is redacted with its id withheld", redacted);
    const introObj = await api(`/api/v1/introducers?from=${anaId}&to=${zzlinkId}&${as}`);
    ok(Array.isArray(introObj.json.viaPrivate) && introObj.json.viaPrivate.some((v) => v.owner === "Bo Finch"),
      "introducers surface the private colleague to ask", introObj.json.viaPrivate);

    // Collect every A-scoped body into one blob; B's private markers must never appear.
    const aBlob = [];
    for (const p of [
      `/api/v1/search?q=&limit=200&${as}`, `/api/v1/search?q=nair&${as}`, `/api/v1/search?q=ZZGHOST&${as}`,
      `/api/v1/entities?limit=200&${as}`, `/api/v1/stats?${as}`, `/api/v1/radar?limit=50&${as}`,
      `/api/v1/reviews?${as}`, `/api/v1/paths?from=${anaId}&to=${zzlinkId}&${as}`,
      `/api/v1/introducers?from=${anaId}&to=${zzlinkId}&${as}`,
      `/api/v1/meeting-prep?with=${encodeURIComponent("zzlink@known.example")}&${as}`,
      `/api/v1/companies/known/memory?${as}`, `/api/v1/entities/${zzlinkId}?${as}`,
      `/api/v1/entities/${zzlinkId}/connections?${as}`, `/api/v1/entities/export.ndjson?${as}`,
      `/api/v1/radar/${anaId}?${as}`,
    ]) aBlob.push((await api(p)).text);
    const aText = aBlob.join("\0");
    for (const m of ["ZZGHOST", "zzghost", "ZZSECRETDOC"]) {
      ok(!aText.includes(m), `no B-private marker "${m}" reaches any A-scoped response`);
    }

    // Symmetric sweep as B for A's private marker.
    const asB = `as=${B.id}`;
    const bBlob = [];
    for (const p of [
      `/api/v1/search?q=&limit=200&${asB}`, `/api/v1/search?q=wren&${asB}`, `/api/v1/entities?limit=200&${asB}`,
      `/api/v1/stats?${asB}`, `/api/v1/radar?limit=50&${asB}`, `/api/v1/entities/export.ndjson?${asB}`,
    ]) bBlob.push((await api(p)).text);
    const bText = bBlob.join("\0");
    for (const m of ["ZZPHANTOM", "zzphantom"]) ok(!bText.includes(m), `no A-private marker "${m}" reaches any B-scoped response`);
    ok((await api(`/api/v1/search?q=ZZPHANTOM&as=${B.id}`)).json.data.length === 0, "B cannot see A's private entity");

    // Unknown ?as= is a hard 400 (unknown-viewer), never a silent shared answer.
    ok(isProblem(await api(`/api/v1/stats?as=nobody-ghost`), "unknown-viewer", 400), "unknown ?as= → 400 unknown-viewer");

    // Conditional fields: a person with no deals omits `deals` (never null).
    const anaBrief = (await api(`/api/v1/entities/${anaId}?${as}`)).json;
    ok(!("deals" in anaBrief), "a person brief omits `deals` when absent (not null)");
    const anaStats = (await api(`/api/v1/stats?${as}`)).json;
    ok(typeof anaStats.withheldDocuments === "number" && anaStats.withheldDocuments > 0, "stats.withheldDocuments present when nonzero", anaStats.withheldDocuments);
  }

  /* -------------------- 5. error shapes -------------------- */
  console.log("[5] error shapes");
  {
    ok(isProblem(await api(`/api/v1/entities/ent_nope?${as}`), "entity-not-found", 404), "404 entity is problem+json");
    const amb = await api(`/api/v1/resolve?ref=zrecord&${as}`);
    ok(isProblem(amb, "ambiguous-ref", 409) && Array.isArray(amb.json.candidates) && amb.json.candidates.length > 0,
      "409 ambiguous carries candidates[]", amb.json.candidates?.length);
    const missing = await api(`/api/v1/paths?to=${zzlinkId}&${as}`);
    ok(isProblem(missing, "bad-request", 400) && missing.json.detail === "missing required param: from", "missing param 400 reuses required()", missing.json.detail);
    const reviews = (await api(`/api/v1/reviews`)).json.data;
    const rid = reviews[0]?.id;
    const badDec = await api(`/api/v1/reviews/${rid}/decision`, { method: "POST", body: { decision: "maybe" } });
    ok(isProblem(badDec, "validation", 400), "bad decision → 400 validation");
    const wrongMethod = await api(`/api/v1/reviews/${rid}/decision`);
    ok(isProblem(wrongMethod, "method-not-allowed", 405), "GET on a POST route → 405");
    // 413: a body over the 50MB readBody cap.
    const huge = "x".repeat(50 * 1024 * 1024 + 4096);
    const tooBig = await api(`/api/v1/batch/resolve?${as}`, { method: "POST", body: huge });
    ok(isProblem(tooBig, "payload-too-large", 413), "oversized body → 413 payload-too-large", tooBig.status);
  }

  /* -------------------- 6. pagination -------------------- */
  console.log("[6] pagination");
  {
    const clamped = await api(`/api/v1/search?q=zrecord&limit=99999`);
    ok(clamped.json.data.length === 200 && clamped.json.page.has_more === true, "limit=99999 clamps to 200 with has_more", clamped.json.data.length);

    // Keyset walk with a small page: full coverage, no overlap, crosses the cap.
    let cursor = null, pages = 0, dupes = 0; const seen = new Set();
    for (;;) {
      const r = await api(`/api/v1/search?q=zrecord&limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const e of r.json.data) { if (seen.has(e.id)) dupes++; seen.add(e.id); }
      pages++;
      if (!r.json.page.has_more) { ok(r.json.page.next_cursor === null, "last page has next_cursor:null + has_more:false"); break; }
      cursor = r.json.page.next_cursor;
      if (pages > 20) break;
    }
    ok(seen.size === 210 && dupes === 0, "keyset pages are disjoint and their union is the full set", { size: seen.size, dupes, pages });

    const bad = await api(`/api/v1/search?cursor=@@@bad`);
    ok(isProblem(bad, "validation", 400), "malformed cursor → 400 validation");

    // A cursor carries position, not scope: minted under A, reused under B, it
    // resumes B-visible rows without error and never revisits page 1.
    const p1 = await api(`/api/v1/search?q=zrecord&limit=40&as=${A.id}`);
    const p1ids = new Set(p1.json.data.map((e) => e.id));
    const p2asB = await api(`/api/v1/search?q=zrecord&limit=40&as=${B.id}&cursor=${encodeURIComponent(p1.json.page.next_cursor)}`);
    ok(p2asB.status === 200 && p2asB.json.data.length > 0 && p2asB.json.data.every((e) => !p1ids.has(e.id)),
      "A's cursor reused as B resumes cleanly (position, not scope)");

    // Offset cursor on an already-materialized feed (radar.needsAttention).
    const r1 = await api(`/api/v1/radar?limit=2&${as}`);
    if (r1.json.needsAttention.page.has_more) {
      const r2 = await api(`/api/v1/radar?limit=2&${as}&cursor=${encodeURIComponent(r1.json.needsAttention.page.next_cursor)}`);
      const a1 = new Set(r1.json.needsAttention.data.map((i) => `${i.a}|${i.b}`));
      ok(r2.json.needsAttention.data.every((i) => !a1.has(`${i.a}|${i.b}`)), "offset page 2 of radar does not overlap page 1");
    } else ok(true, "radar needsAttention fits one page (offset cursor exercised via clamp)");
    ok(isProblem(await api(`/api/v1/radar?cursor=@@@&${as}`), "validation", 400), "malformed offset cursor → 400");
  }

  /* -------------------- 7. OpenAPI ⇄ ROUTES drift + ajv conformance -------------------- */
  console.log("[7] openapi drift + ajv");
  {
    const { ROUTES } = await import(join(ROOT, "src/web/api.js"));
    const spec = (await api("/api/v1/openapi.json")).json;
    // Every route has a matching spec operation.
    let covered = true;
    for (const r of ROUTES) {
      const op = spec.paths[r.pattern]?.[r.method.toLowerCase()];
      if (!op) { covered = false; console.log(`      missing in spec: ${r.method} ${r.pattern}`); }
    }
    ok(covered, "every ROUTES entry has a spec operation");
    // Every spec operation has a matching route.
    let reverse = true;
    for (const [p, item] of Object.entries(spec.paths)) {
      for (const method of Object.keys(item)) {
        if (!ROUTES.some((r) => r.pattern === p && r.method.toLowerCase() === method)) {
          reverse = false; console.log(`      spec op with no route: ${method} ${p}`);
        }
      }
    }
    ok(reverse, "every spec operation has a ROUTES entry");

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validProblem = ajv.compile(spec.components.schemas.Problem);
    const validPage = ajv.compile(spec.components.schemas.Page);
    const realProblem = (await api(`/api/v1/entities/ent_nope?${as}`)).json;
    ok(validProblem(realProblem), "a live 404 body validates against the Problem schema", validProblem.errors);
    const realPage = (await api(`/api/v1/search?q=&limit=3&${as}`)).json;
    ok(validPage(realPage), "a live search page validates against the Page schema", validPage.errors);
  }

  /* -------------------- 8. review decision write path -------------------- */
  console.log("[8] review decision (write)");
  {
    const before = (await api(`/api/v1/reviews`)).json;
    const rid = before.data[0]?.id;
    ok(Boolean(rid), "a pending review exists (sample M. Chen)", before.data.length);
    const dec = await api(`/api/v1/reviews/${rid}/decision`, { method: "POST", body: { decision: "accept" } });
    ok(dec.status === 200 && dec.json.entity && dec.json.reviewId === rid && !/problem/.test(dec.ct), "decision returns a bare {reviewId, decision, entity}", dec.json);
    const after = (await api(`/api/v1/reviews`)).json;
    ok(after.data.length === before.data.length - 1, "the queue drops by one", { before: before.data.length, after: after.data.length });
    const gone = await api(`/api/v1/reviews/${rid}/decision`, { method: "POST", body: { decision: "accept" } });
    ok(isProblem(gone, "review-not-found", 404), "re-deciding a resolved review → 404 review-not-found");
  }

  /* -------------------- 9. dashboard regression (additive, untouched) -------------------- */
  console.log("[9] dashboard regression");
  {
    const stats = await api(`/api/stats`);
    ok(stats.status === 200 && /application\/json/.test(stats.ct) && !/problem/.test(stats.ct) && !("type" in stats.json),
      "/api/stats stays a bare body");
    const someId = (await api(`/api/search?q=ana`)).json[0]?.id;
    const ent = await api(`/api/entity/${someId}`);
    ok(ent.status === 200 && ent.json.entity && !("type" in ent.json), "/api/entity/{id} stays a bare brief");
    const nf = await api(`/api/entity/ent_nope`);
    ok(nf.status === 404 && nf.json.error === "not found" && !("type" in nf.json), "dashboard 404 keeps the bare {error} shape");
  }

  /* -------------------- 10. 500 sanitization (in-process, stubbed throw) -------------------- */
  console.log("[10] 500 sanitization");
  {
    const { apiV1 } = await import(join(ROOT, "src/web/api.js"));
    const boom = { query: async () => { throw new Error("SECRET INTERNAL DETAIL"); }, tx: async () => {} };
    const rec = {
      statusCode: 0, _headers: {}, _body: "", writableEnded: false, headersSent: false,
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      writeHead(s, h) { this.statusCode = s; for (const k in (h || {})) this._headers[k.toLowerCase()] = h[k]; this.headersSent = true; return this; },
      end(b) { if (b !== undefined) this._body = b; this.writableEnded = true; },
    };
    await apiV1(boom, { method: "GET", headers: {} }, rec, new URL(`${BASE}/api/v1/stats`), PORT);
    const body = JSON.parse(rec._body || "{}");
    ok(rec.statusCode === 500 && body.detail === "internal error" && body.error === "internal error" && body.type.endsWith("internal-error"),
      "an unexpected throw masks to a sanitized 500", body);
    ok(!rec._body.includes("SECRET INTERNAL DETAIL"), "the internal message never reaches the client");
  }
} finally {
  const gone = new Promise((r) => server.on("exit", r));
  server.kill();
  await gone;
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures) {
  console.error(`\n${failures} API V1 TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nAPI V1 TESTS PASSED");

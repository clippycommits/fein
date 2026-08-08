import { createHash } from "node:crypto";
// Reused server plumbing. Imported here but only ever referenced INSIDE handler
// bodies — never at module-evaluation time — so the server.js <-> api.js import
// cycle resolves safely (server.js is mid-evaluation when it pulls in apiV1).
import {
  json, withStatus, classify, boundedInt, required, parseJson, readBody,
  viewerOf, memberOf, actorOf, SECURITY_HEADERS, VERSION, STARTED,
} from "./server.js";
// Query layer, imported straight from its own modules so scoping stays by
// construction: every read threads `viewer` unchanged into these.
import {
  searchEntities, entityBrief, resolveRef, getEntity, entityVisible, nameSteps, counts,
} from "../graph/queries.js";
import { findWarmPath, findIntroducers, strongestConnections } from "../graph/paths.js";
import { radarSummary, relationshipRadar } from "../graph/radar.js";
import { companyMemory } from "../graph/memory.js";
import { listReviews, resolveReview } from "../resolve/review.js";
import { rebuildEdgesFor } from "../graph/edges.js";
import { OPENAPI } from "./openapi.js";

const HANDLED = Symbol("handled"); // a handler that already wrote the response

/* ------------------------------------------------------------------ *
 * Error boundary — RFC 9457 problem+json with a legacy `error` alias.
 * ------------------------------------------------------------------ */

// A small, fixed type set grouped by cause (not one per message). The prefix
// URI doubles as the docs index; `error` == `detail` keeps dashboard-style
// clients (`.error` only) working until v2.
const PROBLEM_BASE = "https://fein.vc/probs/";
const TITLES = {
  "bad-request": "Bad request",
  validation: "Validation error",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  "not-found": "Not found",
  "entity-not-found": "Entity not found",
  "review-not-found": "Review not found",
  "ambiguous-ref": "Ambiguous reference",
  "unknown-viewer": "Unknown viewer",
  "payload-too-large": "Payload too large",
  "method-not-allowed": "Method not allowed",
  conflict: "Conflict",
  "internal-error": "Internal error",
};
const DEFAULT_TYPE = {
  400: "bad-request", 401: "unauthorized", 403: "forbidden", 404: "not-found",
  405: "method-not-allowed", 409: "conflict", 413: "payload-too-large", 500: "internal-error",
};

/** Throw a caller-fixable error carrying its problem type + any extension
 * members (e.g. 409 `candidates`). Everything else masks to a 500. */
function fail(status, detail, type, extra) {
  const err = withStatus(new Error(detail), status);
  if (type) err.problemType = type;
  if (extra) err.problemExtra = extra;
  throw err;
}

/** The problem+json responder — a sibling of json() that reuses SECURITY_HEADERS
 * but sets application/problem+json, applies the >=500 sanitization, and emits
 * both the RFC 9457 members and the legacy `error` alias. */
function problem(res, { status, type, title, detail, extra }) {
  const s = status ?? 500;
  const safe = s >= 500 ? "internal error" : detail;
  const body = {
    type: PROBLEM_BASE + (type ?? "internal-error"),
    title: title ?? "Error",
    status: s,
    detail: safe,
    error: safe, // legacy alias == detail; drop at v2
    ...(extra ?? {}),
  };
  if (res.writableEnded) return;
  if (res.headersSent) { res.end(); return; } // mid-stream failure: can't change headers
  res.writeHead(s, { "content-type": "application/problem+json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------ *
 * Cursors — opaque base64url(JSON). Position only, never scope.
 * ------------------------------------------------------------------ */

const encodeCursor = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function decodeCursor(raw) {
  let obj;
  try {
    obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    fail(400, "malformed cursor", "validation");
  }
  if (!obj || typeof obj !== "object") fail(400, "malformed cursor", "validation");
  return obj;
}

/** `{name,id}` keyset cursor (search / entities list / export). */
function keysetCursor(raw) {
  if (!raw) return null;
  const obj = decodeCursor(raw);
  if (typeof obj.name !== "string" || typeof obj.id !== "string") {
    fail(400, "invalid cursor", "validation");
  }
  return { name: obj.name, id: obj.id };
}

/** `{o:offset}` cursor for the offset-paginated feeds. */
function offsetCursor(raw) {
  if (!raw) return 0;
  const obj = decodeCursor(raw);
  if (!Number.isInteger(obj.o) || obj.o < 0) fail(400, "invalid cursor", "validation");
  return obj.o;
}

/** Keyset page over searchEntities: over-fetch one row to learn `has_more`,
 * mint next_cursor from the last kept row's sort tuple. */
function keysetPage(rows, limit) {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    page: {
      next_cursor: hasMore && last ? encodeCursor({ name: last.canonical_name, id: last.id }) : null,
      has_more: hasMore,
    },
  };
}

/** Best-effort offset page over an already-materialized, sorted array. */
function offsetPage(all, offset, limit, extra = {}) {
  const start = Math.max(0, offset);
  const data = all.slice(start, start + limit);
  const hasMore = start + limit < all.length;
  return {
    data,
    page: {
      next_cursor: hasMore ? encodeCursor({ o: start + limit }) : null,
      has_more: hasMore,
      ...extra,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Viewer / actor resolution — the ONLY layer selector is `?as=`.
 * ------------------------------------------------------------------ */

// memberOf/viewerOf/actorOf hard-400 on an unknown ref; tag it `unknown-viewer`
// so the boundary reports the right problem type.
async function memberSafe(db, url) {
  try { return await memberOf(db, url); }
  catch (err) { err.problemType = "unknown-viewer"; throw err; }
}
const viewerId = async (db, url) => (await memberSafe(db, url))?.id ?? null;
async function actorSafe(db, url) {
  try { return await actorOf(db, url); }
  catch (err) { err.problemType = "unknown-viewer"; throw err; }
}

/** Resolve a ref to one entity or raise the faithful 404/409. */
async function resolveOr404(db, ref, viewer) {
  const r = await resolveRef(db, ref, { viewer });
  if (r.entity) return r.entity;
  if (r.candidates) fail(409, r.error, "ambiguous-ref", { candidates: r.candidates });
  fail(404, r.error, "entity-not-found");
}

const nameOf = async (db, id, viewer) => (await getEntity(db, id, { viewer }))?.canonical_name ?? id;

/* ------------------------------------------------------------------ *
 * Handlers — one per endpoint in the design's table. Each returns the
 * body object to serialize, or writes directly and returns HANDLED.
 * ------------------------------------------------------------------ */

async function h_health() {
  return { ok: true, version: VERSION, uptimeSeconds: Math.round((Date.now() - STARTED) / 1000) };
}

async function h_version() {
  return { version: VERSION, apiVersion: "v1", started: new Date(STARTED).toISOString() };
}

async function h_openapi() {
  return OPENAPI;
}

async function h_search({ db, url }) {
  const viewer = await viewerId(db, url);
  const q = String(url.searchParams.get("q") ?? "").slice(0, 200);
  const limit = boundedInt(url, "limit", 20, 1, 200);
  const after = keysetCursor(url.searchParams.get("cursor"));
  const rows = await searchEntities(db, q, limit + 1, { viewer, after });
  return keysetPage(rows, limit);
}

async function h_entities({ db, url }) {
  const viewer = await viewerId(db, url);
  const ref = url.searchParams.get("ref");
  if (ref) {
    // One-hop resolve + brief. Faithful 404/409 on the ref.
    const entity = await resolveOr404(db, ref, viewer);
    return await entityBrief(db, entity.id, { viewer });
  }
  const q = String(url.searchParams.get("q") ?? "").slice(0, 200);
  const limit = boundedInt(url, "limit", 50, 1, 200);
  const after = keysetCursor(url.searchParams.get("cursor"));
  const rows = await searchEntities(db, q, limit + 1, { viewer, after });
  return keysetPage(rows, limit);
}

async function h_entity_brief({ db, url, params }) {
  const viewer = await viewerId(db, url);
  const brief = await entityBrief(db, params.id, { viewer });
  // An id is a lookup key: a cross-layer-private or absent id is "not found",
  // never an echo of the hidden canonical name.
  if (!brief) fail(404, `no entity ${params.id}`, "entity-not-found");
  return brief;
}

async function h_resolve({ db, url }) {
  const viewer = await viewerId(db, url);
  const ref = required(url, "ref");
  return { entity: await resolveOr404(db, ref, viewer) };
}

async function h_batch_resolve({ db, req, url }) {
  const viewer = await viewerId(db, url);
  const body = parseJson(await readBody(req));
  const refs = body.refs;
  if (!Array.isArray(refs) || refs.length === 0) fail(400, "refs must be a non-empty array", "validation");
  if (refs.length > 100) fail(400, "too many refs (100 max)", "validation");
  const data = [];
  for (const r of refs) {
    const res = await resolveRef(db, String(r), { viewer });
    if (res.entity) data.push({ ref: r, entity: res.entity });
    else data.push({ ref: r, error: res.error, ...(res.candidates ? { candidates: res.candidates } : {}) });
  }
  return { data };
}

async function h_batch_briefs({ db, req, url }) {
  const viewer = await viewerId(db, url);
  const body = parseJson(await readBody(req));
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) fail(400, "ids must be a non-empty array", "validation");
  if (ids.length > 50) fail(400, "too many ids (50 max)", "validation");
  const data = [];
  for (const raw of ids) {
    const brief = await entityBrief(db, String(raw), { viewer });
    data.push({ id: raw, brief: brief ?? null });
  }
  return { data };
}

async function h_export_ndjson({ db, req, res, url }) {
  const viewer = await viewerId(db, url);
  const q = String(url.searchParams.get("q") ?? "").slice(0, 200);
  const kind = url.searchParams.get("kind");
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", ...SECURITY_HEADERS });
  // Internal keyset loop — an eventually-consistent snapshot, not a transaction
  // (see design h.5). Pages of 200 by the same (name,id) tuple search uses.
  const PAGE = 200;
  let after = null;
  for (;;) {
    const rows = await searchEntities(db, q, PAGE, { viewer, after });
    for (const row of rows) {
      if (kind && row.kind !== kind) continue;
      res.write(JSON.stringify(row) + "\n");
    }
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    after = { name: last.canonical_name, id: last.id };
  }
  res.end();
  return HANDLED;
}

async function h_connections({ db, url, params }) {
  const viewer = await viewerId(db, url);
  // Same gate as entityBrief: a guessed/hidden id must not resolve.
  if (!(await entityVisible(db, params.id, viewer))) fail(404, `no entity ${params.id}`, "entity-not-found");
  const limit = boundedInt(url, "limit", 10, 1, 200);
  const offset = offsetCursor(url.searchParams.get("cursor"));
  // strongestConnections hard-caps at 200 internally; paginate over that set.
  const all = await strongestConnections(db, params.id, { viewer, limit: 200 });
  const page = offsetPage(all, offset, limit);
  for (const c of page.data) c.name = await nameOf(db, c.entity, viewer);
  return page;
}

async function h_paths({ db, url }) {
  const viewer = await viewerId(db, url);
  const from = required(url, "from");
  const to = required(url, "to");
  const maxHops = boundedInt(url, "max_hops", 4, 1, 6);
  const result = await findWarmPath(db, from, to, { viewer, maxHops });
  // Redact both the visible and the private route through the same nameSteps
  // the dashboard/MCP use: invisible hops become "(private contact)" with the
  // id deleted; visible hops get their real name.
  await nameSteps(db, result?.path ?? [], { viewer });
  await nameSteps(db, result?.privatePath?.path ?? [], { viewer });
  return result; // bare: null | {path,pathStrength} | (+privatePath)
}

async function h_introducers({ db, url }) {
  const viewer = await viewerId(db, url);
  const from = required(url, "from");
  const to = required(url, "to");
  const limit = boundedInt(url, "limit", 5, 1, 50);
  const res = await findIntroducers(db, from, to, { viewer, limit });
  const intros = Array.isArray(res) ? res : res.introducers;
  for (const i of intros) i.name = await nameOf(db, i.entity, viewer);
  // Normalize the array-or-object union: data always the introducers; viaPrivate
  // present only when findIntroducers returned the object form (omit-not-null).
  return { data: intros, ...(Array.isArray(res) ? {} : { viaPrivate: res.viaPrivate }) };
}

async function h_meeting_prep({ db, url }) {
  const member = await memberSafe(db, url);
  const viewer = member?.id ?? null;
  const withRef = required(url, "with");
  const target = await resolveOr404(db, withRef, viewer);
  const brief = await entityBrief(db, target.id, { viewer });
  const prep = { entity: target, brief, warmPath: null, introducers: [] };
  // `from` defaults to the `?as=` member's own identity.
  const fromRef = url.searchParams.get("from") ?? member?.email ?? member?.name ?? null;
  if (fromRef) {
    const self = await resolveRef(db, fromRef, { viewer });
    if (self.entity) {
      const path = await findWarmPath(db, self.entity.id, target.id, { viewer });
      await nameSteps(db, path?.path ?? [], { viewer });
      await nameSteps(db, path?.privatePath?.path ?? [], { viewer });
      const introRes = await findIntroducers(db, self.entity.id, target.id, { viewer });
      const intros = Array.isArray(introRes) ? introRes : introRes.introducers;
      for (const i of intros) i.name = await nameOf(db, i.entity, viewer);
      prep.warmPath = path;
      prep.introducers = intros;
      if (!Array.isArray(introRes)) prep.viaPrivate = introRes.viaPrivate;
    }
  }
  return prep;
}

async function h_radar_summary({ db, url }) {
  const viewer = await viewerId(db, url);
  const limit = boundedInt(url, "limit", 20, 1, 200);
  const includeAutomated = url.searchParams.get("automated") === "1";
  const offset = offsetCursor(url.searchParams.get("cursor"));
  // Materialize the whole needsAttention feed (server-only `now`), then offset
  // -paginate it; the top-level object stays bare, only needsAttention nests a
  // page.
  const summary = await radarSummary(db, { viewer, limit: 1e9, includeAutomated });
  const page = offsetPage(summary.needsAttention, offset, limit);
  for (const i of page.data) {
    i.aName = await nameOf(db, i.a, viewer);
    i.bName = await nameOf(db, i.b, viewer);
  }
  return { counts: summary.counts, needsAttention: page, pairs: summary.pairs };
}

async function h_radar_entity({ db, url, params }) {
  const viewer = await viewerId(db, url);
  if (!(await entityVisible(db, params.id, viewer))) fail(404, `no entity ${params.id}`, "entity-not-found");
  const limit = boundedInt(url, "limit", 25, 1, 200);
  const includeAutomated = url.searchParams.get("automated") === "1";
  const items = await relationshipRadar(db, params.id, { viewer, limit, includeAutomated });
  for (const i of items) i.name = await nameOf(db, i.entity, viewer);
  return { entity: await nameOf(db, params.id, viewer), data: items };
}

async function h_company_memory({ db, url, params }) {
  const viewer = await viewerId(db, url);
  return await companyMemory(db, params.ref, { viewer });
}

async function h_stats({ db, url }) {
  const viewer = await viewerId(db, url);
  return await counts(db, { viewer });
}

async function h_reviews({ db, url }) {
  const viewer = await viewerId(db, url);
  const limit = boundedInt(url, "limit", 50, 1, 200);
  const offset = offsetCursor(url.searchParams.get("cursor"));
  const all = await listReviews(db, { viewer });
  // ?include=count is the one place a total is wired (the queue badge).
  const extra = url.searchParams.get("include") === "count" ? { total: all.length } : {};
  return offsetPage(all, offset, limit, extra);
}

async function h_review_decision({ db, req, url, params }) {
  const actor = await actorSafe(db, url);
  const body = parseJson(await readBody(req));
  if (body.decision !== "accept" && body.decision !== "reject") {
    fail(400, "decision must be accept or reject", "validation");
  }
  let result;
  try {
    result = await resolveReview(db, params.id, body.decision, { actor });
  } catch (err) {
    if (/no pending review/i.test(err.message)) fail(404, err.message, "review-not-found");
    throw err;
  }
  // The graph is a read model: refresh only what the decision touched.
  await rebuildEdgesFor(db, [result.entity]);
  return result;
}

/* ------------------------------------------------------------------ *
 * Route table + dispatch.
 * ------------------------------------------------------------------ */

// The manifest the drift test enumerates: {method, pattern, opId}. Order is
// most-specific-first so `export.ndjson` and `{id}/connections` win over the
// bare `{id}` catch. Handlers live in HANDLERS, keyed by opId.
export const ROUTES = [
  { method: "GET", pattern: "/api/v1/health", opId: "health" },
  { method: "GET", pattern: "/api/v1/version", opId: "version" },
  { method: "GET", pattern: "/api/v1/openapi.json", opId: "openapi" },
  { method: "GET", pattern: "/api/v1/search", opId: "search" },
  { method: "GET", pattern: "/api/v1/entities/export.ndjson", opId: "exportNdjson" },
  { method: "GET", pattern: "/api/v1/entities/{id}/connections", opId: "connections" },
  { method: "GET", pattern: "/api/v1/entities/{id}", opId: "entityBrief" },
  { method: "GET", pattern: "/api/v1/entities", opId: "entities" },
  { method: "GET", pattern: "/api/v1/resolve", opId: "resolve" },
  { method: "POST", pattern: "/api/v1/batch/resolve", opId: "batchResolve" },
  { method: "POST", pattern: "/api/v1/batch/briefs", opId: "batchBriefs" },
  { method: "GET", pattern: "/api/v1/paths", opId: "paths" },
  { method: "GET", pattern: "/api/v1/introducers", opId: "introducers" },
  { method: "GET", pattern: "/api/v1/meeting-prep", opId: "meetingPrep" },
  { method: "GET", pattern: "/api/v1/radar/{id}", opId: "radarEntity" },
  { method: "GET", pattern: "/api/v1/radar", opId: "radar" },
  { method: "GET", pattern: "/api/v1/companies/{ref}/memory", opId: "companyMemory" },
  { method: "GET", pattern: "/api/v1/stats", opId: "stats" },
  { method: "GET", pattern: "/api/v1/reviews", opId: "reviews" },
  { method: "POST", pattern: "/api/v1/reviews/{id}/decision", opId: "reviewDecision" },
];

const HANDLERS = {
  health: h_health, version: h_version, openapi: h_openapi, search: h_search,
  exportNdjson: h_export_ndjson, connections: h_connections, entityBrief: h_entity_brief,
  entities: h_entities, resolve: h_resolve, batchResolve: h_batch_resolve,
  batchBriefs: h_batch_briefs, paths: h_paths, introducers: h_introducers,
  meetingPrep: h_meeting_prep, radarEntity: h_radar_entity, radar: h_radar_summary,
  companyMemory: h_company_memory, stats: h_stats, reviews: h_reviews,
  reviewDecision: h_review_decision,
};

/** Compile a `/a/{x}` pattern into a matcher. Dots are literal (export.ndjson);
 * `{name}` captures one path segment. */
function compile(pattern) {
  const names = [];
  const rx = pattern
    .replace(/[.]/g, "\\$&")
    .replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return "([^/]+)"; });
  return { regex: new RegExp(`^${rx}$`), names };
}

const COMPILED = ROUTES.map((r) => ({ ...r, ...compile(r.pattern), handler: HANDLERS[r.opId] }));

/** First route whose path matches; `pathMatched` distinguishes 405 from 404. */
function matchRoute(method, path) {
  let pathMatched = false;
  for (const r of COMPILED) {
    const m = r.regex.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method === method) {
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
  }
  return { pathMatched };
}

const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Send a 200 GET body with an ETag (and honor If-None-Match → 304). The hash
 * is over method+pathname+search+body; `search` carries `?as=`, so a scoped body
 * can never 304 across layers. Non-GET / non-200 fall through to json(). */
function sendJson(req, res, url, obj, status = 200) {
  if (req.method === "GET" && status === 200) {
    const body = JSON.stringify(obj);
    const etag = `"${sha16(req.method + url.pathname + url.search + "\0" + body)}"`;
    if (req.headers["if-none-match"] === etag) {
      if (!res.writableEnded && !res.headersSent) { res.writeHead(304, SECURITY_HEADERS); res.end(); }
      return;
    }
    res.setHeader("ETag", etag);
    if (res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
    res.end(body);
    return;
  }
  json(res, obj, status);
}

/**
 * The `/api/v1` layer: a faithful HTTP projection of the graph. Auth + the
 * cross-origin write guard are already applied upstream (server.js route());
 * here we own dispatch, the problem+json boundary, ETag/304, and pagination.
 */
export async function apiV1(db, req, res, url, port) {
  try {
    const m = matchRoute(req.method, url.pathname);
    if (!m.route) {
      if (m.pathMatched) fail(405, `method ${req.method} not allowed for ${url.pathname}`, "method-not-allowed");
      fail(404, `no such endpoint: ${url.pathname}`, "not-found");
    }
    const result = await m.route.handler({ db, req, res, url, port, params: m.params });
    if (result === HANDLED) return;
    return sendJson(req, res, url, result);
  } catch (err) {
    const status = err.statusCode ?? classify(err);
    // Reuse the server's sanitization rule: internals never reach the client.
    if (status >= 500) console.error(`v1 ${req.method} ${url.pathname}:`, err);
    const type = err.problemType ?? DEFAULT_TYPE[status] ?? "internal-error";
    return problem(res, {
      status,
      type,
      title: TITLES[type] ?? "Error",
      detail: err.message,
      extra: { instance: url.pathname + url.search, ...(err.problemExtra ?? {}) },
    });
  }
}

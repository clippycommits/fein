import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { env } from "../brand.js";
import { tmpdir } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import { ingestDocs } from "../ingest/index.js";
import { loadJsonl } from "../ingest/local.js";
import { resolveMentions } from "../resolve/pipeline.js";
import { listReviews, resolveReview } from "../resolve/review.js";
import { rebuildEdges, rebuildEdgesFor, strengthOf } from "../graph/edges.js";
import { companyMemory } from "../graph/memory.js";
import { findWarmPath, findIntroducers } from "../graph/paths.js";
import { searchEntities, entityBrief, counts, getEntity, entityVisible, nameSteps } from "../graph/queries.js";
import { getSettings, putSettings, audit, listAudit } from "../settings.js";
import { CONNECTOR_PROVIDERS, clampSyncInterval, putConnector, deleteConnector, resolveConnectorKey, maskKey } from "../connectors.js";
import { runConnectorSync, syncingProvider, startScheduler, connectorSyncStatus } from "../sync.js";
import { listMembers, addMember, removeMember, resolveMember, visibleLayers } from "../members.js";
import { extractPending, extractionStats, estimateExtraction } from "../extract/pipeline.js";
import { extractConfig, isAuthError } from "../extract/client.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "../mcp/server.js";
import { apiV1 } from "./api.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = join(ROOT, "src/web/public");
export const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/docs": ["docs.html", "text/html; charset=utf-8"],
  "/docs.js": ["docs.js", "text/javascript; charset=utf-8"],
};

export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const MAX_UPLOAD = 50 * 1024 * 1024;
export const STARTED = Date.now();

// ---- access control -------------------------------------------------------
// FEIN_AUTH_TOKEN gates everything except /api/health (for container
// healthchecks) and /login. Agents send `Authorization: Bearer <token>`;
// browsers land on /login once and get a cookie. Unset = open, which is only
// acceptable on loopback — startWebServer refuses to bind further without it.
const AUTH_TOKEN = env("AUTH_TOKEN") || null;
const AUTH_COOKIE = "fein_auth";

const sha = (s) => createHash("sha256").update(String(s)).digest();
const tokenMatches = (candidate) =>
  candidate != null && timingSafeEqual(sha(candidate), sha(AUTH_TOKEN));

function presentedToken(req) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (bearer) return bearer[1];
  const cookie = new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? "");
  return cookie ? decodeURIComponent(cookie[1]) : null;
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fein — sign in</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#ededed;
       font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  form{width:min(320px,90vw);padding:2rem;border:1px solid #262626;border-radius:8px}
  h1{font-size:1rem;font-weight:600;margin:0 0 .25rem;letter-spacing:.01em}
  p{margin:0 0 1.25rem;color:#8a8a8a;font-size:.85rem}
  input{width:100%;box-sizing:border-box;padding:.55rem .7rem;border:1px solid #333;border-radius:6px;
        background:#111;color:#ededed;font:inherit}
  input:focus{outline:none;border-color:#0070f3}
  button{margin-top:.75rem;width:100%;padding:.55rem;border:0;border-radius:6px;background:#ededed;
         color:#0a0a0a;font:inherit;font-weight:600;cursor:pointer}
</style>
<form method="GET" action="/login">
  <h1>fein</h1>
  <p>Enter the access token you were given.</p>
  <input name="token" type="password" autofocus autocomplete="current-password" placeholder="Access token">
  <button>Sign in</button>
</form>`;

/** Handle auth before routing. Returns true when the request was fully
 * handled here (login flow or rejection) and routing must not run. */
function handleAuth(req, res, url) {
  if (!AUTH_TOKEN) return false;
  const path = url.pathname;
  if (path === "/api/health" || path === "/api/v1/health" || path === "/api/v1/version") return false;

  if (path === "/login") {
    const attempt = url.searchParams.get("token");
    if (attempt !== null && tokenMatches(attempt)) {
      const secure = (req.headers["x-forwarded-proto"] ?? "").includes("https") ? "; Secure" : "";
      res.writeHead(302, {
        location: "/",
        "set-cookie":
          `${AUTH_COOKIE}=${encodeURIComponent(attempt)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`,
        ...SECURITY_HEADERS,
      });
      res.end();
    } else {
      // Same page for "no token yet" and "wrong token": no oracle.
      res.writeHead(attempt === null ? 200 : 401, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
      res.end(LOGIN_PAGE);
    }
    return true;
  }

  if (tokenMatches(presentedToken(req))) return false;

  if (path.startsWith("/api/") || path === "/mcp") {
    const msg = "unauthorized — send Authorization: Bearer <FEIN_AUTH_TOKEN>";
    // The versioned API speaks problem+json for every error, including this
    // upstream auth rejection; the dashboard /api/* and /mcp keep their bare
    // {error} shape untouched.
    if (path === "/api/v1" || path.startsWith("/api/v1/")) {
      res.writeHead(401, { "content-type": "application/problem+json", ...SECURITY_HEADERS });
      res.end(JSON.stringify({
        type: "https://fein.vc/probs/unauthorized",
        title: "Unauthorized", status: 401, detail: msg, error: msg,
      }));
    } else {
      json(res, { error: msg }, 401);
    }
  } else {
    res.writeHead(302, { location: "/login", ...SECURITY_HEADERS });
    res.end();
  }
  return true;
}
let extracting = false;        // single-flight: extraction holds the API budget, never run two
let extractProgress = null;    // last onProgress snapshot of the current run; null when idle
let cancelExtract = false;     // cooperative stop flag, checked between documents
// The connector sync single-flight lives in ../sync.js (syncingProvider),
// shared with the scheduler; the provider registry is in ../connectors.js.

export async function startWebServer(port = 4321) {
  const db = await getDb();

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    // Node's URL parser throws on targets like "//%ff" — parse before the
    // logger closes over `url`, and never let it escape as a rejection.
    let url;
    try {
      url = new URL(req.url, `http://localhost:${port}`);
    } catch {
      res.writeHead(400, { "content-type": "application/json", ...SECURITY_HEADERS });
      res.end('{"error":"bad request target"}');
      return;
    }
    res.on("finish", () => {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    try {
      if (handleAuth(req, res, url)) return;
      await route(db, req, res, url, port);
    } catch (err) {
      const status = err.statusCode ?? classify(err);
      // Only messages we authored are safe to return; anything else is internal.
      const message = status >= 500 ? "internal error" : err.message;
      if (status >= 500) console.error(`${req.method} ${url.pathname}:`, err);
      json(res, { error: message }, status);
    }
  });

  const host = env("HOST") ?? "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && !AUTH_TOKEN && env("INSECURE") !== "1") {
    console.error(
      `refusing to bind ${host} without auth: the whole graph would be public.\n` +
      `Set FEIN_AUTH_TOKEN (recommended) or FEIN_INSECURE=1 if a firewall/VPN already gates access.`,
    );
    process.exit(1);
  }
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`fein ${VERSION} — http://${loopback ? "localhost" : host}:${port}${AUTH_TOKEN ? " (token auth on)" : ""}`);

  // Scheduled connector syncs share this process and database. Ticks are
  // no-ops until a connector sets syncIntervalMinutes > 0 — and defer while
  // an extraction run holds the pipeline: syncs and extraction end in the
  // same resolveMentions + rebuildEdges, which must never interleave.
  const stopScheduler = startScheduler(db, { isBusy: () => extracting });

  // A single bad request must never take the server down.
  process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err));
  process.on("uncaughtException", (err) => console.error("uncaught exception:", err));

  const shutdown = async () => {
    console.log("shutting down…");
    // Stop NEW scheduled runs; never await an in-flight one (a hung provider
    // API would block shutdown — ingest transactions keep the DB consistent).
    stopScheduler();
    server.close();
    try { await db.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

async function route(db, req, res, url, port) {
  const path = url.pathname;

  if (req.method === "GET" && STATIC[path]) {
    const [file, type] = STATIC[path];
    res.writeHead(200, { "content-type": type, ...SECURITY_HEADERS });
    res.end(readFileSync(join(PUBLIC, file)));
    return;
  }
  if (req.method === "GET" && path === "/vendor/d3.js") {
    res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=86400" });
    res.end(readFileSync(join(ROOT, "node_modules/d3/dist/d3.min.js")));
    return;
  }

  if (req.method !== "GET") guardCrossOrigin(req, port);

  // ---- versioned public API: a faithful HTTP projection of the graph ----
  // Sits alongside (not inside) MCP and dashboard routing, so it inherits the
  // auth gate and the cross-origin write guard above, then owns its own
  // problem+json error boundary, ETag/304, and pagination.
  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    return apiV1(db, req, res, url, port);
  }

  // ---- MCP endpoint: the same graph, for agents, from the same process ----
  // Stateless Streamable HTTP: a fresh server per request, so the dashboard
  // and any number of MCP clients share one embedded database with no
  // single-process conflict. `?as=<member>` binds the agent to that member's
  // private layer (name, email, or id — errors loudly rather than silently
  // answering from the wrong layer).
  if (path === "/mcp") {
    if (req.method !== "POST") {
      return json(res, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed — POST JSON-RPC to this endpoint" },
        id: null,
      }, 405);
    }
    const member = await memberOf(db, url);
    const body = parseJson(await readBody(req));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    const mcp = buildMcpServer(db, {
      viewer: member?.id ?? null,
      actor: member ? `agent:${member.name}` : "agent",
    });
    res.on("close", () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  // ---- read endpoints ----
  if (req.method === "GET") {
    if (path === "/api/health") {
      return json(res, { ok: true, version: VERSION, uptimeSeconds: Math.round((Date.now() - STARTED) / 1000) });
    }
    if (path === "/api/stats") return json(res, await counts(db, { viewer: await viewerOf(db, url) }));
    if (path === "/api/settings") return json(res, await getSettings(db));
    if (path === "/api/audit") return json(res, await listAudit(db, boundedInt(url, "limit", 50, 1, 500)));
    if (path === "/api/reviews") return json(res, await listReviews(db, { viewer: await viewerOf(db, url) }));
    if (path === "/api/extract/status") {
      const cfg = extractConfig();
      return json(res, {
        ...(await extractionStats(db)),
        running: extracting,
        // Progress rides the status endpoint so ANY tab (or agent) can watch
        // the run — only the tab that POSTed gets the final summary.
        progress: extracting ? extractProgress : null,
        model: cfg.model,
        // Presence only, never values. "ambient" = the SDK may still find an
        // `ant auth login` profile; running an extraction is the real test.
        credentials: process.env.ANTHROPIC_API_KEY ? "api-key"
          : process.env.ANTHROPIC_AUTH_TOKEN ? "auth-token" : "ambient",
      });
    }
    if (path === "/api/extract/estimate") {
      // Read-only preview of the next batch — no audit, no model call. The
      // batch size comes from settings; ?limit= overrides for this preview.
      const batchSize = (await getSettings(db)).extraction.batchSize;
      return json(res, await estimateExtraction(db, {
        limit: boundedInt(url, "limit", batchSize, 1, 100000),
      }));
    }
    if (path === "/api/members") return json(res, await listMembers(db));
    if (path === "/api/radar") {
      const { relationshipRadar, radarSummary } = await import("../graph/radar.js");
      const viewer = await viewerOf(db, url);
      const entity = url.searchParams.get("entity");
      if (entity) {
        const items = await relationshipRadar(db, entity, { viewer });
        for (const i of items) i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
        return json(res, { radar: items });
      }
      const summary = await radarSummary(db, {
        viewer,
        limit: boundedInt(url, "limit", 25, 1, 200),
        includeAutomated: url.searchParams.get("automated") === "1",
      });
      for (const i of summary.needsAttention) {
        i.aName = (await getEntity(db, i.a))?.canonical_name ?? i.a;
        i.bName = (await getEntity(db, i.b))?.canonical_name ?? i.b;
      }
      return json(res, summary);
    }
    const conn = /^\/api\/connectors\/([a-z]+)$/.exec(path);
    if (conn && CONNECTOR_PROVIDERS[conn[1]]) return json(res, await connectorStatus(db, conn[1]));
    if (path === "/api/graph") {
      return json(res, await graphPayload(db, await viewerOf(db, url), {
        limit: boundedInt(url, "limit", 300, 1, 5000),
        focus: url.searchParams.get("focus"),
        radius: boundedInt(url, "radius", 2, 1, 4),
      }));
    }
    // Company memory for the dashboard's Memory tab: what is true today, what
    // has been retired (with the window it was true for), and — with as_of —
    // the world as fein believed it on that day.
    if (path === "/api/memory") {
      const company = (url.searchParams.get("company") ?? "").trim();
      if (!company) return json(res, { error: "company required" }, 400);
      const asOf = url.searchParams.get("as_of");
      return json(res, await companyMemory(db, company, {
        viewer: await viewerOf(db, url),
        asOf: asOf && Number.isFinite(Date.parse(asOf)) ? new Date(asOf).toISOString() : null,
      }));
    }
    if (path === "/api/documents") return json(res, await documentsPayload(db, await viewerOf(db, url)));
    if (path === "/api/search") {
      return json(res, await searchEntities(db, String(url.searchParams.get("q") ?? "").slice(0, 200), 12,
        { viewer: await viewerOf(db, url) }));
    }
    if (path.startsWith("/api/entity/")) {
      const brief = await entityBrief(db, path.slice("/api/entity/".length), { viewer: await viewerOf(db, url) });
      if (!brief) return json(res, { error: "not found" }, 404);
      return json(res, brief);
    }
    if (path === "/api/path") {
      const from = required(url, "from");
      const to = required(url, "to");
      const viewer = await viewerOf(db, url);
      const result = await findWarmPath(db, from, to, { viewer });
      await nameSteps(db, result?.path ?? [], { viewer });
      await nameSteps(db, result?.privatePath?.path ?? [], { viewer });
      const introRes = await findIntroducers(db, from, to, { viewer });
      const intros = Array.isArray(introRes) ? introRes : introRes.introducers;
      for (const i of intros) i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
      return json(res, {
        path: result,
        introducers: intros,
        ...(Array.isArray(introRes) ? {} : { viaPrivate: introRes.viaPrivate }),
      });
    }
    return json(res, { error: "not found" }, 404);
  }

  // ---- write endpoints ----
  if (req.method === "POST" && path.startsWith("/api/reviews/")) {
    const body = parseJson(await readBody(req));
    if (body.decision !== "accept" && body.decision !== "reject") {
      return json(res, { error: "decision must be accept or reject" }, 400);
    }
    const result = await resolveReview(db, path.slice("/api/reviews/".length), body.decision,
      { actor: await actorOf(db, url) });
    // Graph is a read model; refresh what the decision touched, nothing more.
    await rebuildEdgesFor(db, [result.entity]);
    return json(res, result);
  }

  if (req.method === "PUT" && path === "/api/settings") {
    const patch = parseJson(await readBody(req));
    const settings = await putSettings(db, patch);
    const edges = await rebuildEdges(db);
    await audit(db, "settings_update", { patch }, await actorOf(db, url));
    return json(res, { settings, edges });
  }

  if (req.method === "POST" && path === "/api/ingest") {
    const name = String(url.searchParams.get("name") ?? "upload.jsonl").slice(0, 200);
    // `?as=<member>` targets that member's private layer; memberOf 400s on an
    // unknown ref — silently landing someone's inbox in the shared layer would
    // be the exact leak the layer model exists to prevent.
    const member = await memberOf(db, url);
    const docs = await parseUpload(name, await readBody(req));
    const ingested = await ingestDocs(db, docs, { owner: member?.id ?? "" });
    const resolved = await resolveMentions(db);
    const edges = await rebuildEdges(db);
    // The audit trail is a shared surface: a private upload's filename is
    // content, so log only whose layer grew — existence, not evidence.
    await audit(db, "ingest", member
      ? { file: "(private upload)", layer: member.name, ...ingested }
      : { file: name, ...ingested }, member?.name ?? "local");
    // The stats hint reflects the uploader's own layers, like the upload did.
    return json(res, { ingested, resolved, edges, layer: member?.name ?? null,
      stats: await counts(db, { viewer: member?.id ?? null }) });
  }

  if (req.method === "POST" && path === "/api/sample") {
    const { loadSampleDataset } = await import("../ingest/sample.js");
    const member = await memberOf(db, url);
    const result = await loadSampleDataset(db);
    await audit(db, "ingest", { file: "bundled sample dataset", ...result.ingested },
      member?.name ?? "local");
    // Stats hints on mutations answer for the requesting viewer, like /api/stats.
    return json(res, { ...result, stats: await counts(db, { viewer: member?.id ?? null }) });
  }

  if (req.method === "POST" && path === "/api/reresolve") {
    const { reresolveAll } = await import("../resolve/reresolve.js");
    const member = await memberOf(db, url);
    const result = await reresolveAll(db, { actor: member?.name ?? "local" });
    return json(res, { ...result, stats: await counts(db, { viewer: member?.id ?? null }) });
  }

  if (req.method === "POST" && path === "/api/extract/cancel") {
    // Same contract as every other mutation: ?as= resolves through the one
    // viewer resolver (unknown refs are a hard 400), and the cancel leaves its
    // own audit row — the eventual "extract" row is attributed to whoever
    // STARTED the run, so without this the canceller would be unrecoverable.
    const actor = await actorOf(db, url);
    if (!extracting) return json(res, { error: "no extraction run in progress" }, 409);
    cancelExtract = true; // the run checks between documents; partial work stays durable
    await audit(db, "extract_cancel", {}, actor);
    return json(res, { cancelling: true });
  }

  if (req.method === "POST" && path === "/api/extract") {
    const member = await memberOf(db, url); // before the claim: no await may split check-and-set
    const actor = member?.name ?? "local";
    if (extracting) return json(res, { error: "an extraction run is already in progress" }, 409);
    // Syncs and extraction end in the same resolveMentions + rebuildEdges —
    // a non-transactional check-then-act loop that double-creates entities
    // when interleaved — so each side yields to the other's claim.
    if (syncingProvider()) {
      return json(res, {
        error: `a ${CONNECTOR_PROVIDERS[syncingProvider()].label} sync is running — retry when it finishes`,
      }, 409);
    }
    extracting = true; // claim BEFORE the first await — the check-and-set must be atomic
    cancelExtract = false; // reset on the same synchronous claim, or a late cancel kills the NEXT run
    extractProgress = null;
    try {
      const body = parseJson(await readBody(req));
      // Explicit body.limit (CLI parity, agents) still wins; the no-limit
      // default is one settings-sized batch, no longer the whole corpus.
      const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0
        ? Number(body.limit)
        : (await getSettings(db)).extraction.batchSize;
      const planned = (await estimateExtraction(db, { limit })).docsThisRun;
      const extract = await extractPending(db, {
        limit,
        shouldStop: () => cancelExtract,
        onProgress: (s) => {
          extractProgress = { done: s.extracted + s.failed, total: planned,
            extracted: s.extracted, failed: s.failed, tokens: s.tokens };
        },
      });
      // Extracted mentions reach the graph through the same pipeline as
      // structured ones: resolve, then rebuild the read model. Cancellation
      // returns through this success path too — partial results still count.
      const resolved = extract.extracted > 0 ? await resolveMentions(db) : null;
      const edges = extract.extracted > 0 ? await rebuildEdges(db) : null;
      await audit(db, "extract", {
        extracted: extract.extracted, failed: extract.failed, mentions: extract.mentions,
        model: extract.model, tokens: extract.tokens, cancelled: extract.cancelled ?? null,
      }, actor);
      return json(res, { extract, resolved, edges, stats: await counts(db, { viewer: member?.id ?? null }) });
    } catch (err) {
      // Even an aborted run may have spent tokens — always leave an audit row.
      const spent = err.stats?.tokens ?? null;
      await audit(db, "extract_failed", { error: String(err.message).slice(0, 300), tokens: spent }, actor).catch(() => {});
      // Only credential/config problems are the caller's to fix; everything
      // else stays a 500 so the sanitizer hides internals.
      if (isAuthError(err) || err.statusCode) throw withStatus(err, err.statusCode ?? 400);
      throw err;
    } finally {
      extracting = false;
    }
  }

  if (req.method === "POST" && path === "/api/merge") {
    const body = parseJson(await readBody(req));
    const { mergeEntities } = await import("../resolve/merge.js");
    if (!body.keep || !body.lose) throw withStatus(new Error("keep and lose entity ids are required"), 400);
    const member = await memberOf(db, url);
    // Same gate as entityBrief: a guessed or leaked private id must not become
    // a cross-layer mutation — or an echo of the hidden canonical name in the
    // 200 body.
    for (const ref of [body.keep, body.lose]) {
      if (!(await entityVisible(db, ref, member?.id ?? null))) return json(res, { error: "not found" }, 404);
    }
    const result = await mergeEntities(db, body.keep, body.lose, { actor: member?.name ?? "local" });
    await rebuildEdgesFor(db, [body.keep, body.lose]);
    return json(res, { ...result, stats: await counts(db, { viewer: member?.id ?? null }) });
  }

  if (req.method === "POST" && path === "/api/unmerge") {
    const body = parseJson(await readBody(req));
    const { unmergeEntity } = await import("../resolve/merge.js");
    if (!body.entity) throw withStatus(new Error("entity id is required"), 400);
    const member = await memberOf(db, url);
    // A tombstone has no mentions of its own (the merge moved them), so the
    // visibility gate rides on the survivor it merged into.
    const { rows: tomb } = await db.query(`select merged_into from entities where id = $1`, [body.entity]);
    if (tomb[0]?.merged_into &&
        !(await entityVisible(db, tomb[0].merged_into, member?.id ?? null))) {
      return json(res, { error: "not found" }, 404);
    }
    const result = await unmergeEntity(db, body.entity, { actor: member?.name ?? "local" });
    await rebuildEdgesFor(db, [result.restored, result.from]);
    return json(res, { ...result, stats: await counts(db, { viewer: member?.id ?? null }) });
  }

  // Human override on the automated-sender flag — the dashboard toggle. Only
  // the radar filters on it, so no edge rebuild is needed.
  if (req.method === "POST" && /^\/api\/entity\/[^/]+\/automated$/.test(path)) {
    const entityId = decodeURIComponent(path.split("/")[3]);
    const body = parseJson(await readBody(req));
    if (typeof body.automated !== "boolean") {
      throw withStatus(new Error("automated must be true or false"), 400);
    }
    const member = await memberOf(db, url);
    // Same gate as entityBrief: a guessed id must not become a write-side
    // probe around the "hide" policy.
    if (!(await entityVisible(db, entityId, member?.id ?? null))) {
      return json(res, { error: "not found" }, 404);
    }
    const { setAutomated } = await import("../resolve/automated.js");
    return json(res, await setAutomated(db, entityId, body.automated, { actor: member?.name ?? "local" }));
  }

  if (req.method === "POST" && path === "/api/members") {
    const body = parseJson(await readBody(req));
    const member = await addMember(db, { name: body.name, email: body.email });
    await audit(db, "member_add", { member: member.name }, await actorOf(db, url));
    return json(res, member);
  }

  if (req.method === "DELETE" && path.startsWith("/api/members/")) {
    const memberId = path.slice("/api/members/".length);
    const reassign = url.searchParams.get("reassign") === "shared" ? "shared" : null;
    const result = await removeMember(db, memberId, { reassign });
    // removeMember already dropped the departed layer's edges; only documents
    // moved INTO the shared layer leave the read model stale.
    if (reassign === "shared") await rebuildEdges(db);
    await audit(db, "member_remove", result, await actorOf(db, url));
    return json(res, result);
  }

  // ---- CRM connectors: the key is write-only, never returned ----
  const connWrite = /^\/api\/connectors\/([a-z]+)(\/sync)?$/.exec(path);
  const provider = connWrite && CONNECTOR_PROVIDERS[connWrite[1]] ? connWrite[1] : null;
  const { label, envVar } = provider ? CONNECTOR_PROVIDERS[provider] : {};

  if (req.method === "POST" && provider && !connWrite[2]) {
    const body = parseJson(await readBody(req));
    const apiKey = String(body.apiKey ?? "").trim();
    let interval;
    if (body.syncIntervalMinutes !== undefined) {
      try {
        interval = clampSyncInterval(body.syncIntervalMinutes);
      } catch (err) {
        throw withStatus(err, 400);
      }
    }
    if (!apiKey) {
      // No key in the body but one already resolves (stored or env): a
      // config-only patch — the interval knob must not demand re-pasting a
      // key, and an env key cannot be re-pasted at all.
      const { key } = await resolveConnectorKey(db, provider, envVar);
      if (!key) throw withStatus(new Error(`paste an ${label} API key`), 400);
      const patch = {
        ...(interval !== undefined ? { syncIntervalMinutes: interval } : {}),
        ...(body.includeNotes !== undefined ? { includeNotes: body.includeNotes !== false } : {}),
      };
      await putConnector(db, provider, patch);
      await audit(db, "connector_config", { connector: provider, ...patch }, await actorOf(db, url));
      return json(res, await connectorStatus(db, provider));
    }
    let info;
    try {
      info = await CONNECTOR_PROVIDERS[provider].verify(apiKey);
    } catch (err) {
      throw withStatus(new Error(err.message), 400);
    }
    await putConnector(db, provider, {
      apiKey,
      includeNotes: body.includeNotes !== false,
      ...(interval !== undefined ? { syncIntervalMinutes: interval } : {}),
      workspace: info.workspace,
      connectedAt: new Date().toISOString(),
      // putConnector merges over the existing blob, and a key that just passed
      // verify() is evidence the failure streak is over: without this reset a
      // stale count keeps nextDueAt deferring the fresh connection up to 24h.
      consecutiveFailures: 0,
    });
    await audit(db, "connector_connect", { connector: provider, workspace: info.workspace },
      await actorOf(db, url));
    return json(res, { connected: true, ...(await connectorStatus(db, provider)) });
  }

  if (req.method === "POST" && provider && connWrite[2]) {
    const member = await memberOf(db, url);
    // The mirror of the extract endpoint's sync guard: a manual sync must not
    // interleave its resolve + edge rebuild with an in-flight extraction run.
    if (extracting) {
      return json(res, { error: "an extraction run is in progress — retry when it finishes" }, 409);
    }
    let result;
    try {
      result = await runConnectorSync(db, provider, { actor: member?.name ?? "local", trigger: "manual" });
    } catch (err) {
      // Guard statuses pass through (400 not-configured, 409 busy); a failed
      // workspace pull stays the caller's 400 — runConnectorSync already
      // persisted and audited the failure.
      throw withStatus(err, err.statusCode ?? 400);
    }
    return json(res, { ...result, stats: await counts(db, { viewer: member?.id ?? null }),
      ...(await connectorStatus(db, provider)) });
  }

  if (req.method === "DELETE" && provider) {
    await deleteConnector(db, provider);
    await audit(db, "connector_disconnect", { connector: provider }, await actorOf(db, url));
    return json(res, { connected: false, ...(await connectorStatus(db, provider)) });
  }

  json(res, { error: "not found" }, 404);
}

/** `?as=<member>` — id, exact name, or email — selects the viewing layer.
 * Unknown or ambiguous refs are a hard 400: silently answering from the
 * shared layer would hide the exact wrong-layer bug the model exists to
 * prevent. Every `?as=` on the server resolves through here. */
export async function memberOf(db, url) {
  const as = url.searchParams.get("as");
  if (!as) return null;
  try {
    return await resolveMember(db, as);
  } catch (err) {
    throw withStatus(new Error(err.message), 400);
  }
}
export const viewerOf = async (db, url) => (await memberOf(db, url))?.id ?? null;

/** `?as=` as an audit actor: the member's display name, or "local". Self-
 * declared under the single shared token — this is provenance, not
 * authentication; per-user login is what makes it honest. */
export const actorOf = async (db, url) => (await memberOf(db, url))?.name ?? "local";

/** Presence and a masked hint only — the stored key never leaves the server. */
async function connectorStatus(db, provider) {
  const { key } = await resolveConnectorKey(db, provider, CONNECTOR_PROVIDERS[provider].envVar);
  return {
    ...(await connectorSyncStatus(db, provider)),
    keyHint: key ? maskKey(key) : null,
    syncing: syncingProvider() === provider,
  };
}

/* ---------- payload builders ---------- */

async function graphPayload(db, viewer = null, { limit = 300, focus = null, radius = 2 } = {}) {
  const cfg = await getSettings(db);
  const layers = visibleLayers(viewer);
  const lph = layers.map((_, i) => `$${i + 1}`).join(", ");
  // Under the default "hide" policy, a person only a colleague has ever
  // corresponded with is not drawn at all — their name can be the secret.
  const nodeGate = cfg.privateEntityVisibility === "reveal" ? "" : `
       and exists (select 1 from mentions mm join documents dd on dd.id = mm.document_id
                   where mm.entity_id = entities.id and dd.owner in (${lph}))`;
  const { rows: people } = await db.query(
    `select id, canonical_name, orgs from entities
     where kind = 'person' and merged_into is null ${nodeGate}`,
    cfg.privateEntityVisibility === "reveal" ? [] : layers
  );

  // Visible evidence is summed across the viewer's layers, then saturated once.
  const { rows: edges } = await db.query(
    `select a, b, sum(weight) as weight, max(last_seen) as last_seen,
            jsonb_agg(signals) as signal_sets
     from edges where owner in (${lph}) group by a, b`,
    layers
  );
  // Edges that exist only in other members' layers: drawn, but without
  // strength or signals — existence is shared, evidence is not.
  const { rows: foreign } = await db.query(
    `select distinct e.a, e.b from edges e
     where e.owner <> '' and e.owner not in (${lph})
       and not exists (select 1 from edges v where v.a = e.a and v.b = e.b and v.owner in (${lph}))`,
    layers
  );

  const links = [];
  const degree = new Map();
  const bump = (x) => degree.set(x, (degree.get(x) ?? 0) + 1);
  for (const e of edges) {
    const strength = strengthOf(Number(e.weight), cfg);
    if (strength <= 0.01) continue;
    const sets = typeof e.signal_sets === "string" ? JSON.parse(e.signal_sets) : e.signal_sets;
    const signals = Object.create(null);
    for (const s of sets ?? []) for (const [k, v] of Object.entries(s ?? {})) signals[k] = (signals[k] ?? 0) + v;
    links.push({ source: e.a, target: e.b, strength, signals, last_seen: e.last_seen });
    bump(e.a); bump(e.b);
  }
  // Only hint at private routes between people this viewer can already see:
  // a dangling endpoint id is both a leak (ids are lookup keys) and a d3
  // crash (forceLink throws on ids absent from nodes).
  const visibleIds = new Set(people.map((p) => p.id));
  for (const e of foreign) {
    if (!visibleIds.has(e.a) || !visibleIds.has(e.b)) continue;
    // 0.25 is a cosmetic line weight for the hint — deliberately NOT the
    // tunable routing prior (settings.privateHopStrength): drawing at the
    // routing strength would read as evidence.
    links.push({ source: e.a, target: e.b, strength: 0.25, private: true, signals: {} });
    bump(e.a); bump(e.b);
  }

  // Bound AFTER assembly: the privacy queries above and the both-endpoints
  // filter stay untouched, so pruning inherits their guarantees. `degree`
  // stays pre-prune so the tooltip's "N connections" remains truthful.
  const totalNodes = people.length;
  const totalLinks = links.length;

  let candidates = people;
  if (focus) {
    const f = await getEntity(db, focus);
    // Same gate as entityBrief: a guessed private id must not resolve.
    if (!f || !(await entityVisible(db, f.id, viewer))) {
      throw withStatus(new Error(`no entity ${focus}`), 404);
    }
    // Ego set by BFS over the drawn links — private 0.25 links included:
    // they are drawn, so they are navigable.
    const adj = new Map();
    const arc = (x, y) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push(y); };
    for (const l of links) { arc(l.source, l.target); arc(l.target, l.source); }
    const ego = new Set([f.id]);
    let frontier = [f.id];
    for (let hop = 0; hop < radius && frontier.length; hop++) {
      const next = [];
      for (const id of frontier) {
        for (const n of adj.get(id) ?? []) if (!ego.has(n)) { ego.add(n); next.push(n); }
      }
      frontier = next;
    }
    candidates = people.filter((p) => ego.has(p.id));
  }

  // Strongest connections first: summed incident strength, name as the
  // deterministic tie-break, the focus (when set) pinned in front.
  const score = new Map();
  for (const l of links) {
    score.set(l.source, (score.get(l.source) ?? 0) + l.strength);
    score.set(l.target, (score.get(l.target) ?? 0) + l.strength);
  }
  candidates = [...candidates].sort((a, b) =>
    (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) ||
    (a.canonical_name < b.canonical_name ? -1 : a.canonical_name > b.canonical_name ? 1 : 0));
  if (focus) {
    const i = candidates.findIndex((p) => p.id === focus);
    if (i > 0) candidates.unshift(...candidates.splice(i, 1));
  }
  const kept = candidates.slice(0, limit);
  const keptIds = new Set(kept.map((p) => p.id));

  return {
    nodes: kept.map((p) => ({
      id: p.id,
      name: p.canonical_name,
      orgs: typeof p.orgs === "string" ? JSON.parse(p.orgs) : p.orgs,
      degree: degree.get(p.id) ?? 0,
    })),
    // Both endpoints must survive the prune — a dangling id crashes d3.forceLink.
    links: links.filter((l) => keptIds.has(l.source) && keptIds.has(l.target)),
    totalNodes,
    totalLinks,
    truncated: kept.length < totalNodes,
  };
}

async function documentsPayload(db, viewer = null) {
  const layers = visibleLayers(viewer);
  const lph = layers.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await db.query(
    `select source, kind, count(*) as n, max(occurred_at) as latest
     from documents where owner in (${lph}) group by source, kind order by source, kind`,
    layers
  );
  const bySource = new Map();
  let total = 0;
  for (const r of rows) {
    if (!bySource.has(r.source)) {
      bySource.set(r.source, { source: r.source, count: 0, kinds: Object.create(null), latest: null });
    }
    const s = bySource.get(r.source);
    const n = Number(r.n);
    s.count += n;
    total += n;
    s.kinds[r.kind] = n;
    const latest = r.latest ? new Date(r.latest).toISOString() : null;
    if (latest && (!s.latest || latest > s.latest)) s.latest = latest;
  }
  // Titles are content: only from layers the viewer may see.
  const { rows: recent } = await db.query(
    `select source, kind, title, occurred_at from documents
     where owner in (${lph}) order by occurred_at desc nulls last limit 12`,
    layers
  );
  const { rows: hidden } = await db.query(
    `select count(*) as n from documents where owner <> '' and owner not in (${lph})`,
    layers
  );
  const withheld = Number(hidden[0].n);
  return { total, sources: [...bySource.values()], recent, ...(withheld ? { withheld } : {}) };
}

/* ---------- plumbing ---------- */

export function json(res, obj, status = 200) {
  if (res.writableEnded) return;
  if (res.headersSent) { res.end(); return; } // mid-stream failure: close, headers can't change
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

/** Browsers can POST to localhost from any web page — refuse cross-origin
 * writes. A same-origin request (Origin host equals the Host the browser
 * targeted) is allowed under any hostname, so deployments behind a domain or
 * reverse proxy work unchanged. Requests without an Origin (curl, SDKs) pass:
 * they are not browsers, and the auth gate covers them. The strict loopback
 * Host check (DNS-rebinding protection) still applies to unauthenticated
 * loopback installs — the only place rebinding is a live threat. */
function guardCrossOrigin(req, port) {
  const loopback = (hostname) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  const target = req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
  const origin = req.headers.origin;
  if (origin) {
    let o;
    try { o = new URL(origin); } catch { throw withStatus(new Error("cross-origin writes are not allowed"), 403); }
    const sameOrigin = o.host === target;
    const loopbackOrigin = loopback(o.hostname) && String(o.port || 80) === String(port);
    if (!sameOrigin && !loopbackOrigin) throw withStatus(new Error("cross-origin writes are not allowed"), 403);
  } else if (!AUTH_TOKEN) {
    let h;
    try { h = new URL(`http://${target}`); } catch { throw withStatus(new Error("bad host header"), 403); }
    if (!loopback(h.hostname)) throw withStatus(new Error("bad host header"), 403);
  }
}

export function withStatus(err, code) {
  err.statusCode = code;
  return err;
}

/** Map known user-error shapes to 4xx; everything else is a 500. */
export function classify(err) {
  const m = err.message ?? "";
  if (/(not found|no entity|no pending review|no member|no live entity)/i.test(m)) return 404;
  if (/(unknown (weight|resolution|radar|extraction)|must be a number|must be below|must be accept or reject|unsupported|invalid|decision |cannot merge|needs a name|matches \d+ members|no name or email column|already exists)/i.test(m)) return 400;
  return 500;
}

export function required(url, name) {
  const v = url.searchParams.get(name);
  if (!v) throw withStatus(new Error(`missing required param: ${name}`), 400);
  return v;
}

export function boundedInt(url, name, dflt, min, max) {
  const v = Number(url.searchParams.get(name) ?? dflt);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : dflt;
}

export function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw withStatus(new Error("invalid JSON body"), 400);
  }
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        // Pause rather than destroy, so the 413 body actually reaches the client.
        req.pause();
        reject(withStatus(new Error("upload too large (50MB max)"), 413));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Uploads reuse the file adapters via a temp file (they take paths). */
async function parseUpload(name, body) {
  const ext = extname(name).toLowerCase();
  const tmp = mkdtempSync(join(tmpdir(), "fein-upload-"));
  const file = join(tmp, `upload${ext}`);
  try {
    writeFileSync(file, body);
    try {
      if (ext === ".jsonl" || ext === ".json") return loadJsonl(file);
      if (ext === ".mbox") return (await import("../ingest/mbox.js")).loadMbox(file);
      if (ext === ".ics") return (await import("../ingest/ics.js")).loadIcs(file);
      if (ext === ".csv") return (await import("../ingest/csv.js")).loadCsv(file);
    } catch (err) {
      if (err.statusCode) throw err;
      // A bad file is the user's error to fix: 400, their filename, no temp paths.
      throw withStatus(
        new Error(`could not parse ${name}: ${String(err.message).replaceAll(file, name)}`), 400);
    }
    throw withStatus(new Error(`unsupported upload type ${ext} — use .jsonl, .mbox, .ics, or .csv`), 400);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

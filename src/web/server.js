import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import { ingestDocs } from "../ingest/index.js";
import { loadJsonl } from "../ingest/local.js";
import { resolveMentions } from "../resolve/pipeline.js";
import { listReviews, resolveReview } from "../resolve/review.js";
import { rebuildEdges, strengthOf } from "../graph/edges.js";
import { findWarmPath, findIntroducers } from "../graph/paths.js";
import { searchEntities, entityBrief, counts, getEntity } from "../graph/queries.js";
import { getSettings, putSettings, audit, listAudit } from "../settings.js";
import { putConnector, deleteConnector, resolveConnectorKey, maskKey } from "../connectors.js";
import { listMembers, addMember, removeMember, getMember, resolveMember, visibleLayers } from "../members.js";
import { extractPending, extractionStats } from "../extract/pipeline.js";
import { extractConfig, isAuthError } from "../extract/client.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "../mcp/server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC = join(ROOT, "src/web/public");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const MAX_UPLOAD = 50 * 1024 * 1024;
const STARTED = Date.now();
let extracting = false;   // single-flight: extraction holds the API budget, never run two
let attioSyncing = false; // same for connector pulls — two concurrent syncs would duplicate work

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
      await route(db, req, res, url, port);
    } catch (err) {
      const status = err.statusCode ?? classify(err);
      // Only messages we authored are safe to return; anything else is internal.
      const message = status >= 500 ? "internal error" : err.message;
      if (status >= 500) console.error(`${req.method} ${url.pathname}:`, err);
      json(res, { error: message }, status);
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`fein ${VERSION} — http://localhost:${port}`);

  // A single bad request must never take the server down.
  process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err));
  process.on("uncaughtException", (err) => console.error("uncaught exception:", err));

  const shutdown = async () => {
    console.log("shutting down…");
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
    let viewer = null;
    if (url.searchParams.get("as")) {
      try {
        viewer = (await resolveMember(db, url.searchParams.get("as"))).id;
      } catch (err) {
        throw withStatus(new Error(err.message), 400);
      }
    }
    const body = parseJson(await readBody(req));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    const mcp = buildMcpServer(db, { viewer });
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
    if (path === "/api/version") return json(res, { version: VERSION });
    if (path === "/api/stats") return json(res, await counts(db));
    if (path === "/api/settings") return json(res, await getSettings(db));
    if (path === "/api/audit") return json(res, await listAudit(db, boundedInt(url, "limit", 50, 1, 500)));
    if (path === "/api/reviews") return json(res, await listReviews(db, { viewer: await viewerOf(db, url) }));
    if (path === "/api/extract/status") {
      const cfg = extractConfig();
      return json(res, {
        ...(await extractionStats(db)),
        running: extracting,
        model: cfg.model,
        // Presence only, never values. "ambient" = the SDK may still find an
        // `ant auth login` profile; running an extraction is the real test.
        credentials: process.env.ANTHROPIC_API_KEY ? "api-key"
          : process.env.ANTHROPIC_AUTH_TOKEN ? "auth-token" : "ambient",
      });
    }
    if (path === "/api/members") return json(res, await listMembers(db));
    if (path === "/api/merges") {
      const { listMerges } = await import("../resolve/merge.js");
      return json(res, await listMerges(db));
    }
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
    if (path === "/api/connectors/attio") return json(res, await attioStatus(db));
    if (path === "/api/graph") return json(res, await graphPayload(db, await viewerOf(db, url)));
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
      const nameSteps = async (steps) => {
        for (const step of steps ?? []) {
          step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
        }
      };
      const result = await findWarmPath(db, from, to, { viewer });
      await nameSteps(result?.path);
      await nameSteps(result?.privatePath?.path);
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
    const result = await resolveReview(db, path.slice("/api/reviews/".length), body.decision);
    await rebuildEdges(db); // graph is a read model; refresh after human input
    return json(res, result);
  }

  if (req.method === "PUT" && path === "/api/settings") {
    const patch = parseJson(await readBody(req));
    const settings = await putSettings(db, patch);
    const edges = await rebuildEdges(db);
    await audit(db, "settings_update", { patch });
    return json(res, { settings, edges });
  }

  if (req.method === "POST" && path === "/api/ingest") {
    const name = String(url.searchParams.get("name") ?? "upload.jsonl").slice(0, 200);
    // `?as=<member>` targets that member's private layer. Unknown members are
    // a hard 400: silently landing someone's inbox in the shared layer would
    // be the exact leak the layer model exists to prevent.
    let member = null;
    if (url.searchParams.get("as")) {
      try {
        member = await resolveMember(db, url.searchParams.get("as"));
      } catch (err) {
        throw withStatus(new Error(err.message), 400);
      }
    }
    const docs = await parseUpload(name, await readBody(req));
    const ingested = await ingestDocs(db, docs, { owner: member?.id ?? "" });
    const resolved = await resolveMentions(db);
    const edges = await rebuildEdges(db);
    // The audit trail is a shared surface: a private upload's filename is
    // content, so log only whose layer grew — existence, not evidence.
    await audit(db, "ingest", member
      ? { file: "(private upload)", layer: member.name, ...ingested }
      : { file: name, ...ingested });
    return json(res, { ingested, resolved, edges, layer: member?.name ?? null, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/sample") {
    const { loadSampleDataset } = await import("../ingest/sample.js");
    const result = await loadSampleDataset(db);
    await audit(db, "ingest", { file: "bundled sample dataset", ...result.ingested });
    return json(res, { ...result, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/reresolve") {
    const { reresolveAll } = await import("../resolve/reresolve.js");
    const result = await reresolveAll(db);
    return json(res, { ...result, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/extract") {
    if (extracting) return json(res, { error: "an extraction run is already in progress" }, 409);
    extracting = true; // claim BEFORE the first await — the check-and-set must be atomic
    try {
      const body = parseJson(await readBody(req));
      const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Number(body.limit) : Infinity;
      const extract = await extractPending(db, { limit });
      // Extracted mentions reach the graph through the same pipeline as
      // structured ones: resolve, then rebuild the read model.
      const resolved = extract.extracted > 0 ? await resolveMentions(db) : null;
      const edges = extract.extracted > 0 ? await rebuildEdges(db) : null;
      await audit(db, "extract", {
        extracted: extract.extracted, failed: extract.failed, mentions: extract.mentions,
        model: extract.model, tokens: extract.tokens,
      });
      return json(res, { extract, resolved, edges, stats: await counts(db) });
    } catch (err) {
      // Even an aborted run may have spent tokens — always leave an audit row.
      const spent = err.stats?.tokens ?? null;
      await audit(db, "extract_failed", { error: String(err.message).slice(0, 300), tokens: spent }).catch(() => {});
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
    const result = await mergeEntities(db, body.keep, body.lose);
    await rebuildEdges(db);
    return json(res, { ...result, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/unmerge") {
    const body = parseJson(await readBody(req));
    const { unmergeEntity } = await import("../resolve/merge.js");
    if (!body.entity) throw withStatus(new Error("entity id is required"), 400);
    const result = await unmergeEntity(db, body.entity);
    await rebuildEdges(db);
    return json(res, { ...result, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/members") {
    const body = parseJson(await readBody(req));
    const member = await addMember(db, { name: body.name, email: body.email });
    await audit(db, "member_add", { member: member.name });
    return json(res, member);
  }

  if (req.method === "DELETE" && path.startsWith("/api/members/")) {
    const memberId = path.slice("/api/members/".length);
    const reassign = url.searchParams.get("reassign") === "shared" ? "shared" : null;
    const result = await removeMember(db, memberId, { reassign });
    await rebuildEdges(db); // their layer is gone; the read model must follow
    await audit(db, "member_remove", result);
    return json(res, result);
  }

  // ---- Attio connector: the key is write-only, never returned ----
  if (req.method === "POST" && path === "/api/connectors/attio") {
    const body = parseJson(await readBody(req));
    const apiKey = String(body.apiKey ?? "").trim();
    if (!apiKey) throw withStatus(new Error("paste an Attio API key"), 400);
    const { verifyAttioKey } = await import("../ingest/attio.js");
    let info;
    try {
      info = await verifyAttioKey(apiKey);
    } catch (err) {
      throw withStatus(new Error(err.message), 400);
    }
    await putConnector(db, "attio", {
      apiKey,
      includeNotes: body.includeNotes !== false,
      workspace: info.workspace,
      connectedAt: new Date().toISOString(),
    });
    await audit(db, "connector_connect", { connector: "attio", workspace: info.workspace });
    return json(res, { connected: true, ...(await attioStatus(db)) });
  }

  if (req.method === "POST" && path === "/api/connectors/attio/sync") {
    if (attioSyncing) return json(res, { error: "an Attio sync is already running" }, 409);
    attioSyncing = true; // claim BEFORE the first await — the check-and-set must be atomic
    try {
      const { key, config } = await resolveConnectorKey(db, "attio", "ATTIO_API_KEY");
      if (!key) throw withStatus(new Error("connect an Attio API key first"), 400);
      const { fetchAttio } = await import("../ingest/attio.js");
      const docs = await fetchAttio({ key, includeNotes: config.includeNotes !== false });
      const ingested = await ingestDocs(db, docs);
      const resolved = await resolveMentions(db);
      const edges = await rebuildEdges(db);
      await putConnector(db, "attio", { lastSyncAt: new Date().toISOString(), lastDocCount: ingested.docCount });
      await audit(db, "ingest", { file: "attio workspace", ...ingested });
      return json(res, { ingested, resolved, edges, stats: await counts(db), ...(await attioStatus(db)) });
    } catch (err) {
      throw withStatus(new Error(err.message), 400);
    } finally {
      attioSyncing = false;
    }
  }

  if (req.method === "DELETE" && path === "/api/connectors/attio") {
    await deleteConnector(db, "attio");
    await audit(db, "connector_disconnect", { connector: "attio" });
    return json(res, { connected: false, ...(await attioStatus(db)) });
  }

  json(res, { error: "not found" }, 404);
}

/** `?as=<member id>` selects the viewing layer; unknown ids fall back to shared. */
async function viewerOf(db, url) {
  const as = url.searchParams.get("as");
  if (!as) return null;
  const member = await getMember(db, as);
  return member?.id ?? null;
}

/** Presence and a masked hint only — the stored key never leaves the server. */
async function attioStatus(db) {
  const { key, origin, config } = await resolveConnectorKey(db, "attio", "ATTIO_API_KEY");
  return {
    connected: Boolean(key),
    origin,                       // "stored" (pasted here) | "env" (ATTIO_API_KEY) | null
    keyHint: key ? maskKey(key) : null,
    workspace: config.workspace ?? null,
    includeNotes: config.includeNotes !== false,
    lastSyncAt: config.lastSyncAt ?? null,
    lastDocCount: config.lastDocCount ?? null,
    syncing: attioSyncing,
  };
}

/* ---------- payload builders ---------- */

async function graphPayload(db, viewer = null) {
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
  for (const e of foreign) {
    links.push({ source: e.a, target: e.b, strength: 0.25, private: true, signals: {} });
    bump(e.a); bump(e.b);
  }

  return {
    nodes: people.map((p) => ({
      id: p.id,
      name: p.canonical_name,
      orgs: typeof p.orgs === "string" ? JSON.parse(p.orgs) : p.orgs,
      degree: degree.get(p.id) ?? 0,
    })),
    links,
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

function json(res, obj, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

/** Browsers can POST to localhost from any web page — refuse cross-origin writes. */
function guardCrossOrigin(req, port) {
  const ok = (v) => {
    try {
      const u = new URL(v);
      return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && String(u.port || 80) === String(port);
    } catch {
      return false;
    }
  };
  const origin = req.headers.origin;
  if (origin && !ok(origin)) throw withStatus(new Error("cross-origin writes are not allowed"), 403);
  const host = req.headers.host;
  if (host && !ok(`http://${host}`)) throw withStatus(new Error("bad host header"), 403);
}

function withStatus(err, code) {
  err.statusCode = code;
  return err;
}

/** Map known user-error shapes to 4xx; everything else is a 500. */
function classify(err) {
  const m = err.message ?? "";
  if (/(not found|no entity|no pending review)/i.test(m)) return 404;
  if (/(unknown weight|must be a number|must be accept or reject|unsupported|invalid|decision )/i.test(m)) return 400;
  return 500;
}

function required(url, name) {
  const v = url.searchParams.get(name);
  if (!v) throw withStatus(new Error(`missing required param: ${name}`), 400);
  return v;
}

function boundedInt(url, name, dflt, min, max) {
  const v = Number(url.searchParams.get(name) ?? dflt);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : dflt;
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw withStatus(new Error("invalid JSON body"), 400);
  }
}

function readBody(req) {
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
    if (ext === ".jsonl" || ext === ".json") return loadJsonl(file);
    if (ext === ".mbox") return (await import("../ingest/mbox.js")).loadMbox(file);
    if (ext === ".ics") return (await import("../ingest/ics.js")).loadIcs(file);
    if (ext === ".csv") return (await import("../ingest/csv.js")).loadCsv(file);
    throw withStatus(new Error(`unsupported upload type ${ext} — use .jsonl, .mbox, .ics, or .csv`), 400);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

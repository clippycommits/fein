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
import { rebuildEdges } from "../graph/edges.js";
import { findWarmPath, findIntroducers } from "../graph/paths.js";
import { searchEntities, entityBrief, counts, getEntity } from "../graph/queries.js";
import { getSettings, putSettings, audit, listAudit } from "../settings.js";
import { putConnector, deleteConnector, resolveConnectorKey, maskKey } from "../connectors.js";
import { extractPending, extractionStats } from "../extract/pipeline.js";
import { extractConfig } from "../extract/client.js";

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
  console.log(`fundgraph ${VERSION} — http://localhost:${port}`);

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

  // ---- read endpoints ----
  if (req.method === "GET") {
    if (path === "/api/health") {
      return json(res, { ok: true, version: VERSION, uptimeSeconds: Math.round((Date.now() - STARTED) / 1000) });
    }
    if (path === "/api/version") return json(res, { version: VERSION });
    if (path === "/api/stats") return json(res, await counts(db));
    if (path === "/api/settings") return json(res, await getSettings(db));
    if (path === "/api/audit") return json(res, await listAudit(db, boundedInt(url, "limit", 50, 1, 500)));
    if (path === "/api/reviews") return json(res, await listReviews(db));
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
    if (path === "/api/connectors/attio") return json(res, await attioStatus(db));
    if (path === "/api/graph") return json(res, await graphPayload(db));
    if (path === "/api/documents") return json(res, await documentsPayload(db));
    if (path === "/api/search") {
      return json(res, await searchEntities(db, String(url.searchParams.get("q") ?? "").slice(0, 200), 12));
    }
    if (path.startsWith("/api/entity/")) {
      const brief = await entityBrief(db, path.slice("/api/entity/".length));
      if (!brief) return json(res, { error: "not found" }, 404);
      return json(res, brief);
    }
    if (path === "/api/path") {
      const from = required(url, "from");
      const to = required(url, "to");
      const result = await findWarmPath(db, from, to);
      if (result) {
        for (const step of result.path) {
          step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
        }
      }
      const intros = await findIntroducers(db, from, to);
      for (const i of intros) i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
      return json(res, { path: result, introducers: intros });
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
    const docs = await parseUpload(name, await readBody(req));
    const ingested = await ingestDocs(db, docs);
    const resolved = await resolveMentions(db);
    const edges = await rebuildEdges(db);
    await audit(db, "ingest", { file: name, ...ingested });
    return json(res, { ingested, resolved, edges, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/sample") {
    const { readdirSync } = await import("node:fs");
    const fixtureDir = join(ROOT, "sample/fixtures");
    let fixtures = [];
    try {
      fixtures = readdirSync(fixtureDir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => loadJsonl(join(fixtureDir, f)));
    } catch {} // fixtures are optional
    const docs = [
      ...loadJsonl(join(ROOT, "sample/seed.jsonl")),
      ...(await (await import("../ingest/mbox.js")).loadMbox(join(ROOT, "sample/sample.mbox"))),
      ...(await import("../ingest/ics.js")).loadIcs(join(ROOT, "sample/sample.ics")),
      ...(await import("../ingest/csv.js")).loadCsv(join(ROOT, "sample/contacts.csv")),
      ...fixtures,
    ];
    const ingested = await ingestDocs(db, docs);
    const resolved = await resolveMentions(db);
    const edges = await rebuildEdges(db);
    await audit(db, "ingest", { file: "bundled sample dataset", ...ingested });
    return json(res, { ingested, resolved, edges, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/reresolve") {
    const { reresolveAll } = await import("../resolve/reresolve.js");
    const result = await reresolveAll(db);
    return json(res, { ...result, stats: await counts(db) });
  }

  if (req.method === "POST" && path === "/api/extract") {
    if (extracting) return json(res, { error: "an extraction run is already in progress" }, 409);
    const body = parseJson(await readBody(req));
    const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Number(body.limit) : Infinity;
    extracting = true;
    try {
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
      // Credential/config problems are the caller's to fix — surface the message.
      throw withStatus(new Error(err.message), 400);
    } finally {
      extracting = false;
    }
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
    const { key, config } = await resolveConnectorKey(db, "attio", "ATTIO_API_KEY");
    if (!key) throw withStatus(new Error("connect an Attio API key first"), 400);
    attioSyncing = true;
    try {
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

async function graphPayload(db) {
  const { rows: people } = await db.query(
    `select id, canonical_name, orgs from entities where kind = 'person' and merged_into is null`
  );
  const { rows: edges } = await db.query(
    `select a, b, strength, signals, last_seen from edges where strength > 0.01`
  );
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  return {
    nodes: people.map((p) => ({
      id: p.id,
      name: p.canonical_name,
      orgs: typeof p.orgs === "string" ? JSON.parse(p.orgs) : p.orgs,
      degree: degree.get(p.id) ?? 0,
    })),
    links: edges.map((e) => ({
      source: e.a, target: e.b, strength: e.strength,
      signals: typeof e.signals === "string" ? JSON.parse(e.signals) : e.signals,
      last_seen: e.last_seen,
    })),
  };
}

async function documentsPayload(db) {
  const { rows } = await db.query(
    `select source, kind, count(*) as n, max(occurred_at) as latest
     from documents group by source, kind order by source, kind`
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
  const { rows: recent } = await db.query(
    `select source, kind, title, occurred_at from documents
     order by occurred_at desc nulls last limit 12`
  );
  return { total, sources: [...bySource.values()], recent };
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
  const tmp = mkdtempSync(join(tmpdir(), "fundgraph-upload-"));
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

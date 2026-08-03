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

export async function startWebServer(port = 4321) {
  const db = await getDb();

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, `http://localhost:${port}`);
    res.on("finish", () => {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    try {
      await route(db, req, res, url, port);
    } catch (err) {
      const status = err.statusCode ?? (/(not found|no entity)/i.test(err.message) ? 404 : 500);
      json(res, { error: err.message }, status);
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`fundgraph ${VERSION} — http://localhost:${port}`);

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
    const docs = [
      ...loadJsonl(join(ROOT, "sample/seed.jsonl")),
      ...(await import("../ingest/mbox.js")).loadMbox(join(ROOT, "sample/sample.mbox")),
      ...(await import("../ingest/ics.js")).loadIcs(join(ROOT, "sample/sample.ics")),
      ...(await import("../ingest/csv.js")).loadCsv(join(ROOT, "sample/contacts.csv")),
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

  json(res, { error: "not found" }, 404);
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
    if (!bySource.has(r.source)) bySource.set(r.source, { source: r.source, count: 0, kinds: {}, latest: null });
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
        reject(withStatus(new Error("upload too large (50MB max)"), 413));
        req.destroy();
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

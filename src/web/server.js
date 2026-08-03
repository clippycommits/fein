import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db.js";
import { ingestDocs } from "../ingest/index.js";
import { resolveMentions } from "../resolve/pipeline.js";
import { listReviews, resolveReview } from "../resolve/review.js";
import { rebuildEdges } from "../graph/edges.js";
import { findWarmPath, findIntroducers } from "../graph/paths.js";
import { searchEntities, entityBrief, counts, getEntity } from "../graph/queries.js";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const D3 = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/d3/dist/d3.min.js");

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const MAX_UPLOAD = 50 * 1024 * 1024;

export async function startWebServer(port = 4321) {
  const db = await getDb();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;

      if (req.method === "GET" && STATIC[path]) {
        const [file, type] = STATIC[path];
        res.writeHead(200, { "content-type": type });
        res.end(readFileSync(join(PUBLIC, file)));
        return;
      }
      if (req.method === "GET" && path === "/vendor/d3.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(readFileSync(D3));
        return;
      }

      if (req.method === "GET" && path === "/api/stats") return json(res, await counts(db));

      if (req.method === "GET" && path === "/api/graph") {
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
        return json(res, {
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
        });
      }

      if (req.method === "GET" && path === "/api/search") {
        return json(res, await searchEntities(db, url.searchParams.get("q") ?? "", 12));
      }

      if (req.method === "GET" && path.startsWith("/api/entity/")) {
        const brief = await entityBrief(db, path.slice("/api/entity/".length));
        if (!brief) return json(res, { error: "not found" }, 404);
        return json(res, brief);
      }

      if (req.method === "GET" && path === "/api/path") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
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

      if (req.method === "GET" && path === "/api/reviews") return json(res, await listReviews(db));

      if (req.method === "POST" && path.startsWith("/api/reviews/")) {
        const body = JSON.parse(await readBody(req));
        const result = await resolveReview(db, path.slice("/api/reviews/".length), body.decision);
        await rebuildEdges(db); // graph is a read model; refresh after human input
        return json(res, result);
      }

      if (req.method === "POST" && path === "/api/ingest") {
        const name = url.searchParams.get("name") ?? "upload.jsonl";
        const body = await readBody(req);
        const docs = await parseUpload(name, body);
        const ingested = await ingestDocs(db, docs);
        const resolved = await resolveMentions(db);
        const edges = await rebuildEdges(db);
        return json(res, { ingested, resolved, edges, stats: await counts(db) });
      }

      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`fundgraph web: http://localhost:${port}`);
  return server;
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        reject(new Error("upload too large (50MB max)"));
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
    if (ext === ".jsonl" || ext === ".json") {
      return (await import("../ingest/local.js")).loadJsonl(file);
    }
    if (ext === ".mbox") return (await import("../ingest/mbox.js")).loadMbox(file);
    if (ext === ".ics") return (await import("../ingest/ics.js")).loadIcs(file);
    if (ext === ".csv") return (await import("../ingest/csv.js")).loadCsv(file);
    throw new Error(`unsupported upload type ${ext} — use .jsonl, .mbox, .ics, or .csv`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { env } from "./brand.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

let _db = null;

/**
 * Returns a handle with:
 *   query(sql, params) -> {rows}
 *   tx(fn)             -> run fn({query}) inside a transaction
 *   close()
 * Uses embedded Postgres (PGlite) under ./data by default; set DATABASE_URL
 * to point at a real Postgres instance. Embedded mode is single-process —
 * a lockfile guards the data dir, since two PGlite instances on the same
 * directory silently diverge and can corrupt it.
 */
export async function getDb() {
  if (_db) return _db;
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => console.error("postgres pool error:", err.message));
    _db = {
      query: (sql, params) => pool.query(sql, params),
      // BEGIN/COMMIT must run on one checked-out client, not pool.query.
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const result = await fn({ query: (s, p) => client.query(s, p) });
          await client.query("commit");
          return result;
        } catch (err) {
          await client.query("rollback");
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    // Prefer an existing legacy data dir so pre-rename installs keep their graph.
    const dataDir =
      env("DATA") ?? (existsSync("./data/fundgraph") ? "./data/fundgraph" : "./data/fein");
    mkdirSync(dataDir, { recursive: true });
    const release = acquireLock(dataDir);
    const lite = new PGlite(dataDir);
    _db = {
      query: (sql, params) => lite.query(sql, params),
      // PGlite's transaction() holds the session-wide tx mutex; hand-rolled
      // begin/commit does not, so two concurrent tx() calls would interleave
      // inside one transaction (and one rollback could discard both).
      tx: (fn) => lite.transaction((t) => fn({ query: (s, p) => t.query(s, p) })),
      close: async () => {
        await lite.close();
        release();
      },
    };
  }
  await migrate(_db);
  return _db;
}

function acquireLock(dataDir) {
  const lockPath = dataDir + ".lock";
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const holder = Number(readFileSync(lockPath, "utf8"));
    if (holder && isAlive(holder)) {
      throw new Error(
        `data dir ${dataDir} is in use by pid ${holder} — embedded Postgres is single-process. ` +
        `Stop that process (e.g. a running MCP server) first, or set DATABASE_URL to share a real Postgres.`
      );
    }
    writeFileSync(lockPath, String(process.pid)); // stale lock from a dead process
  }
  const release = () => { try { rmSync(lockPath, { force: true }); } catch {} };
  process.on("exit", release);
  return release;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function migrate(db) {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  // Split on top-level semicolons; PGlite prefers one statement per call.
  for (const stmt of schema.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

// The Postgres wire protocol caps bind parameters at 65535 (int16); 8000
// leaves margin and behaves identically on PGlite and a DATABASE_URL pool.
// Bigger chunks buy nothing — statement parse time grows with the list.
export const MAX_PARAMS = 8000;

/**
 * Chunked multi-row insert. `rows` are arrays in `cols` order; `conflict` is
 * an optional "on conflict ..." clause appended verbatim. Rows are split so
 * no statement exceeds MAX_PARAMS bind parameters — the point is one
 * round-trip per ~thousand rows instead of one per row, which is what makes
 * large ingests and edge rebuilds tolerable on PGlite (every query is a WASM
 * round-trip). Rows must have unique conflict keys within one call: the same
 * key twice in one statement raises "cannot affect row a second time".
 */
export async function insertMany(db, { table, cols, rows, conflict = "" }) {
  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  for (let at = 0; at < rows.length; at += perChunk) {
    const chunk = rows.slice(at, at + perChunk);
    const values = chunk
      .map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(", ")})`)
      .join(", ");
    try {
      await db.query(`insert into ${table} (${cols.join(", ")}) values ${values} ${conflict}`, chunk.flat());
    } catch (err) {
      // One bad row fails its whole chunk — name the chunk so it can be found.
      const keys = chunk.map((r) => r[0]);
      err.message += ` (batch insert into ${table}, ${cols[0]}s ${keys.slice(0, 8).join(", ")}` +
        (keys.length > 8 ? ` … ${keys.length} rows` : "") + `)`;
      throw err;
    }
  }
}

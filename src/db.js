import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

let _db = null;

/**
 * Returns a handle with `query(sql, params) -> {rows}`.
 * Uses embedded Postgres (PGlite) under ./data by default; set DATABASE_URL
 * to point at a real Postgres instance.
 */
export async function getDb() {
  if (_db) return _db;
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    _db = { query: (sql, params) => pool.query(sql, params), close: () => pool.end() };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = process.env.FUNDGRAPH_DATA ?? "./data/fundgraph";
    const lite = new PGlite(dataDir);
    _db = { query: (sql, params) => lite.query(sql, params), close: () => lite.close() };
  }
  await migrate(_db);
  return _db;
}

async function migrate(db) {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  // Split on top-level semicolons; PGlite prefers one statement per call.
  for (const stmt of schema.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

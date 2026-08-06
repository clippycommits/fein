import { createHash } from "node:crypto";
import { env } from "../brand.js";
import { id } from "../db.js";
import { normEmail, normPersonName, normOrgName } from "../resolve/normalize.js";
import { MIN_BODY_CHARS } from "../extract/prompt.js";

function bodySha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function docId(doc) {
  const key = doc.external_id
    ? `${doc.source}:${doc.external_id}`
    : `${doc.source}:${doc.kind}:${doc.title ?? ""}:${doc.occurred_at ?? ""}`;
  return "doc_" + createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/**
 * Deterministic mention ids: re-ingesting a document must keep the same
 * mention rows, or their review-queue history (a FK cascade) is silently
 * destroyed. The ordinal disambiguates identical entries within one doc.
 */
export function mentionId(did, kind, role, normName, normEmailValue, ordinal) {
  const key = `${did}:${kind}:${role}:${normEmailValue ?? ""}|${normName ?? ""}#${ordinal}`;
  return "men_" + createHash("sha1").update(key).digest("hex").slice(0, 20);
}

/** Idempotent: re-ingesting the same document replaces its mentions.
 * Runs in one transaction so a crash can't strand documents without mentions. */
export async function ingestDocs(outerDb, docs, { owner = "" } = {}) {
  return outerDb.tx((db) => ingestInTx(db, docs, owner));
}

/**
 * Ingest an async iterable of documents in batches, so a multi-gigabyte
 * archive never has to fit in memory. Each batch is its own transaction.
 */
export async function ingestStream(outerDb, source, { batchSize = 2000, onProgress, owner = "" } = {}) {
  const totals = { docCount: 0, mentionCount: 0 };
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const res = await outerDb.tx((db) => ingestInTx(db, batch, owner));
    totals.docCount += res.docCount;
    totals.mentionCount += res.mentionCount;
    batch = [];
    onProgress?.(totals);
  };
  for await (const doc of source) {
    batch.push(doc);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return totals;
}

async function ingestInTx(db, docs, owner = "") {
  let docCount = 0;
  let mentionCount = 0;
  for (const doc of docs) {
    const did = docId(doc);
    // Body policy: FEIN_NO_BODIES=1 (legacy FUNDGRAPH_NO_BODIES) disables capture for every adapter
    // AND scrubs previously stored bodies on re-ingest (the flag means "no
    // bodies, period"). Otherwise: keep a new body when the adapter provides
    // one (sub-floor bodies aren't worth mining and are dropped), fall back
    // to the previously stored body when it doesn't — a headers-only re-pass
    // over the same mbox must not erase what an earlier pass captured.
    const capture = env("NO_BODIES") !== "1";
    const body = capture && typeof doc.body === "string" && doc.body.length >= MIN_BODY_CHARS
      ? doc.body : null;
    await db.query(
      `insert into documents (id, source, kind, external_id, title, occurred_at, raw, body, body_sha256, owner)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $11)
       on conflict (id) do update set title = $5, occurred_at = $6, raw = $7,
         body = case when $10 then coalesce($8, documents.body) else null end,
         body_sha256 = case when $10 then coalesce($9, documents.body_sha256) else null end,
         owner = $11`,
      [did, doc.source, doc.kind, doc.external_id ?? null, doc.title ?? null,
       doc.occurred_at ?? null, JSON.stringify(doc.raw ?? {}), body,
       body ? bodySha256(body) : null, capture, doc.owner ?? owner]
    );
    docCount++;

    // Upsert with stable ids (never touching entity_id), then delete only
    // stale rows — a blanket delete would cascade away review-queue history.
    const ordinals = new Map();
    const keep = [];
    for (const p of doc.people ?? []) {
      const nn = normPersonName(p.name);
      const ne = normEmail(p.email);
      const role = p.role ?? "mentioned";
      const okey = `person:${role}:${ne ?? ""}|${nn ?? ""}`;
      const ordinal = ordinals.get(okey) ?? 0;
      ordinals.set(okey, ordinal + 1);
      const mid = mentionId(did, "person", role, nn, ne, ordinal);
      keep.push(mid);
      await db.query(
        `insert into mentions (id, document_id, kind, name, email, org_hint, role, norm_name, norm_email)
         values ($1, $2, 'person', $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set name = $3, email = $4, org_hint = $5, role = $6,
           norm_name = $7, norm_email = $8`,
        [mid, did, p.name ?? null, p.email ?? null, p.org ?? null, role, nn, ne]
      );
      mentionCount++;
    }
    for (const orgName of doc.orgs ?? []) {
      const nn = normOrgName(orgName);
      const okey = `org:${nn ?? ""}`;
      const ordinal = ordinals.get(okey) ?? 0;
      ordinals.set(okey, ordinal + 1);
      const mid = mentionId(did, "org", "mentioned", nn, null, ordinal);
      keep.push(mid);
      await db.query(
        `insert into mentions (id, document_id, kind, name, role, norm_name)
         values ($1, $2, 'org', $3, 'mentioned', $4)
         on conflict (id) do update set name = $3, norm_name = $4`,
        [mid, did, orgName, nn]
      );
      mentionCount++;
    }
    // Structured mentions only: extracted mentions belong to the extraction
    // pipeline, which does its own replace when the body's hash changes.
    if (keep.length) {
      const placeholders = keep.map((_, i) => `$${i + 2}`).join(", ");
      await db.query(
        `delete from mentions where document_id = $1 and origin = 'structured' and id not in (${placeholders})`,
        [did, ...keep]
      );
    } else {
      await db.query(`delete from mentions where document_id = $1 and origin = 'structured'`, [did]);
    }
  }
  return { docCount, mentionCount };
}

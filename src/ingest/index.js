import { createHash } from "node:crypto";
import { env } from "../brand.js";
import { insertMany, MAX_PARAMS } from "../db.js";
import { normEmail, normPersonName, normOrgName } from "../resolve/normalize.js";
import { MIN_BODY_CHARS } from "../extract/prompt.js";

function bodySha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function docId(doc, owner = "") {
  // The owner is part of the identity: the same source document ingested into
  // two layers is two documents. Without this, a re-ingest by another member
  // (or without --as) would silently move a private document out of its layer.
  const key = (doc.external_id
    ? `${doc.source}:${doc.external_id}`
    : `${doc.source}:${doc.kind}:${doc.title ?? ""}:${doc.occurred_at ?? ""}`)
    + (owner ? `@${owner}` : "");
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
  // Body policy: FEIN_NO_BODIES=1 (legacy FUNDGRAPH_NO_BODIES) disables capture for every adapter
  // AND scrubs previously stored bodies on re-ingest (the flag means "no
  // bodies, period"). Otherwise: keep a new body when the adapter provides
  // one (sub-floor bodies aren't worth mining and are dropped), fall back
  // to the previously stored body when it doesn't — a headers-only re-pass
  // over the same mbox must not erase what an earlier pass captured.
  const capture = env("NO_BODIES") !== "1";

  // Phase 1, pure: build every row before touching the database. Duplicate
  // doc ids are deduped to the LAST occurrence — that is what the sequential
  // upserts used to converge to, and a multi-row upsert hitting the same id
  // twice raises "ON CONFLICT DO UPDATE command cannot affect row a second
  // time". One carve-out keeps the equivalence exact: the old per-row upsert
  // COALESCEd body/body_sha256, converging to the last NON-NULL body — so a
  // later headers-only occurrence (a Sent/All-Mail copy of the same message)
  // must not erase an earlier occurrence's body within the batch. Duplicates
  // are real: external_id-less docs share an id whenever source/kind/title/
  // date repeat. Keeping the whole per-doc record (mentions and keep list
  // included) makes the dedupe atomic: a superseded occurrence's mentions are
  // never written at all.
  const byId = new Map(); // did -> { docRow, mentionRows, keep }
  for (const doc of docs) {
    const docOwner = doc.owner ?? owner;
    const did = docId(doc, docOwner);
    const body = capture && typeof doc.body === "string" && doc.body.length >= MIN_BODY_CHARS
      ? doc.body : null;
    const docRow = [did, doc.source, doc.kind, doc.external_id ?? null, doc.title ?? null,
      doc.occurred_at ?? null, JSON.stringify(doc.raw ?? {}), body,
      body ? bodySha256(body) : null, docOwner];

    const ordinals = new Map();
    const keep = [];
    const mentionRows = []; // person and org rows share one column set; org rows null the person-only columns
    for (const p of doc.people ?? []) {
      const nn = normPersonName(p.name);
      const ne = normEmail(p.email);
      const role = p.role ?? "mentioned";
      const okey = `person:${role}:${ne ?? ""}|${nn ?? ""}`;
      const ordinal = ordinals.get(okey) ?? 0;
      ordinals.set(okey, ordinal + 1);
      const mid = mentionId(did, "person", role, nn, ne, ordinal);
      keep.push(mid);
      mentionRows.push([mid, did, "person", p.name ?? null, p.email ?? null, p.org ?? null, role, nn, ne]);
    }
    for (const orgName of doc.orgs ?? []) {
      const nn = normOrgName(orgName);
      const okey = `org:${nn ?? ""}`;
      const ordinal = ordinals.get(okey) ?? 0;
      ordinals.set(okey, ordinal + 1);
      const mid = mentionId(did, "org", "mentioned", nn, null, ordinal);
      keep.push(mid);
      mentionRows.push([mid, did, "org", orgName, null, null, "mentioned", nn, null]);
    }
    const prev = byId.get(did);
    if (prev && docRow[7] == null && prev.docRow[7] != null) {
      docRow[7] = prev.docRow[7]; // body — keep the earlier occurrence's
      docRow[8] = prev.docRow[8]; // body_sha256 travels with it
    }
    byId.set(did, { docRow, mentionRows, keep });
  }
  const perDoc = [...byId.values()];

  // Phase 2: documents. `capture` is code-derived (an env flag, never user
  // data), inlined as a SQL literal so the excluded.* clause can keep the
  // scrub/keep-previous-body contract above without a per-row flag param.
  await insertMany(db, {
    table: "documents",
    cols: ["id", "source", "kind", "external_id", "title", "occurred_at", "raw", "body", "body_sha256", "owner"],
    rows: perDoc.map((d) => d.docRow),
    conflict: `on conflict (id) do update set title = excluded.title,
      occurred_at = excluded.occurred_at, raw = excluded.raw,
      body = case when ${capture} then coalesce(excluded.body, documents.body) else null end,
      body_sha256 = case when ${capture} then coalesce(excluded.body_sha256, documents.body_sha256) else null end,
      owner = excluded.owner`,
  });

  // Phase 3: mentions, upserted with stable ids and entity_id never listed —
  // review-queue history hangs off these rows by FK cascade.
  const mentionRows = perDoc.flatMap((d) => d.mentionRows);
  await insertMany(db, {
    table: "mentions",
    cols: ["id", "document_id", "kind", "name", "email", "org_hint", "role", "norm_name", "norm_email"],
    rows: mentionRows,
    conflict: `on conflict (id) do update set name = excluded.name, email = excluded.email,
      org_hint = excluded.org_hint, role = excluded.role,
      norm_name = excluded.norm_name, norm_email = excluded.norm_email`,
  });

  // Phase 4: delete stale rows. Structured mentions only: extracted mentions
  // belong to the extraction pipeline, which does its own replace when the
  // body's hash changes. Mention ids embed their document id, so a keep list
  // shared across a chunk of docs cannot shield another doc's rows — but a
  // doc's own keep ids must travel in ITS chunk, so docs and their keep ids
  // are chunked together under MAX_PARAMS.
  let chunk = [];
  let params = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const dids = chunk.map((d) => d.docRow[0]);
    const keeps = chunk.flatMap((d) => d.keep);
    const dph = dids.map((_, i) => `$${i + 1}`).join(", ");
    if (keeps.length) {
      const kph = keeps.map((_, i) => `$${dids.length + i + 1}`).join(", ");
      await db.query(
        `delete from mentions where document_id in (${dph}) and origin = 'structured' and id not in (${kph})`,
        [...dids, ...keeps]
      );
    } else {
      await db.query(`delete from mentions where document_id in (${dph}) and origin = 'structured'`, dids);
    }
    chunk = [];
    params = 0;
  };
  for (const d of perDoc) {
    const cost = 1 + d.keep.length;
    if (chunk.length && params + cost > MAX_PARAMS) await flush();
    chunk.push(d);
    params += cost;
  }
  await flush();

  // docCount counts input docs (as the sequential loop did); mentionCount is
  // the rows actually written, after dedupe.
  return { docCount: docs.length, mentionCount: mentionRows.length };
}

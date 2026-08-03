import { createHash } from "node:crypto";
import { id } from "../db.js";
import { normEmail, normPersonName, normOrgName } from "../resolve/normalize.js";

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
function mentionId(did, kind, role, normName, normEmailValue, ordinal) {
  const key = `${did}:${kind}:${role}:${normEmailValue ?? ""}|${normName ?? ""}#${ordinal}`;
  return "men_" + createHash("sha1").update(key).digest("hex").slice(0, 20);
}

/** Idempotent: re-ingesting the same document replaces its mentions.
 * Runs in one transaction so a crash can't strand documents without mentions. */
export async function ingestDocs(outerDb, docs) {
  return outerDb.tx((db) => ingestInTx(db, docs));
}

async function ingestInTx(db, docs) {
  let docCount = 0;
  let mentionCount = 0;
  for (const doc of docs) {
    const did = docId(doc);
    await db.query(
      `insert into documents (id, source, kind, external_id, title, occurred_at, raw)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do update set title = $5, occurred_at = $6, raw = $7`,
      [did, doc.source, doc.kind, doc.external_id ?? null, doc.title ?? null,
       doc.occurred_at ?? null, JSON.stringify(doc.raw ?? {})]
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
    if (keep.length) {
      const placeholders = keep.map((_, i) => `$${i + 2}`).join(", ");
      await db.query(
        `delete from mentions where document_id = $1 and id not in (${placeholders})`,
        [did, ...keep]
      );
    } else {
      await db.query(`delete from mentions where document_id = $1`, [did]);
    }
  }
  return { docCount, mentionCount };
}

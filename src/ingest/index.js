import { createHash } from "node:crypto";
import { id } from "../db.js";
import { normEmail, normPersonName, normOrgName } from "../resolve/normalize.js";

function docId(doc) {
  const key = doc.external_id
    ? `${doc.source}:${doc.external_id}`
    : `${doc.source}:${doc.kind}:${doc.title ?? ""}:${doc.occurred_at ?? ""}`;
  return "doc_" + createHash("sha1").update(key).digest("hex").slice(0, 12);
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
    await db.query(`delete from mentions where document_id = $1`, [did]);
    docCount++;

    for (const p of doc.people ?? []) {
      await db.query(
        `insert into mentions (id, document_id, kind, name, email, org_hint, role, norm_name, norm_email)
         values ($1, $2, 'person', $3, $4, $5, $6, $7, $8)`,
        [id("men"), did, p.name ?? null, p.email ?? null, p.org ?? null,
         p.role ?? "mentioned", normPersonName(p.name), normEmail(p.email)]
      );
      mentionCount++;
    }
    for (const orgName of doc.orgs ?? []) {
      await db.query(
        `insert into mentions (id, document_id, kind, name, role, norm_name)
         values ($1, $2, 'org', $3, 'mentioned', $4)`,
        [id("men"), did, orgName, normOrgName(orgName)]
      );
      mentionCount++;
    }
  }
  return { docCount, mentionCount };
}

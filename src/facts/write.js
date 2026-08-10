import { createHash } from "node:crypto";
import { cardinalityOf, isPredicate, normValue, PREDICATES } from "./vocab.js";

/**
 * Writing a fact is the only place in fein where history can be rewritten, so
 * the rules are deterministic and live in one function — no second model call
 * decides what stopped being true.
 *
 * Four cases, and three of them are the ones a naive implementation gets wrong:
 *
 *   restatement  — a later document repeats what we already hold. It must not
 *                  create a second row, and must not close the first.
 *   late arrival — a document ingested today describes an EARLIER period than
 *                  the live fact. It belongs in history; it must not supersede
 *                  the present just because it was read last. (Backfills are
 *                  full of these.)
 *   contradiction— genuinely new value. Close the old window at the new fact's
 *                  valid_at, NOT at now(), or the timeline develops a gap
 *                  between the two and the as-of query returns nothing.
 *   append       — decision facts are never contradicted at all.
 */

/** Stable id: re-extracting a document must not duplicate its facts. */
export function factId(documentId, predicate, subjectNorm, valueNorm, objectNorm) {
  return (
    "f_" +
    createHash("sha256")
      .update([documentId, predicate, subjectNorm, valueNorm ?? "", objectNorm ?? ""].join("\u0000"))
      .digest("hex")
      .slice(0, 24)
  );
}

async function liveFacts(db, { subject_norm, predicate, owner }) {
  const { rows } = await db.query(
    `select id, subject_norm, predicate, object_norm, value, value_norm,
            valid_at, invalid_at, confidence
       from facts
      where subject_norm = $1 and predicate = $2 and owner = $3
        and invalid_at is null and expired_at is null
      order by valid_at asc, created_at asc`,
    [subject_norm, predicate, owner]
  );
  return rows;
}

/** Close a validity window. The row itself is never touched again. */
async function closeWindow(db, id, { invalid_at, by }) {
  await db.query(`update facts set invalid_at = $2, invalidated_by = $3 where id = $1`, [
    id,
    invalid_at,
    by,
  ]);
}

/**
 * Does `next` displace `prev`? For "one" predicates any different value does.
 * For "many" predicates only a declared displacement key does — a person
 * changing employer displaces their own prior employment, but a new investor
 * does not displace the existing ones.
 */
function displaces(predicate, prev, next) {
  const spec = PREDICATES[predicate];
  if (!spec) return false;
  if (spec.cardinality === "append") return false;
  if (spec.cardinality === "one") return prev.value_norm !== next.value_norm;
  if (spec.displacesBy === "object") {
    // Same object (same person), different value (different employer/title).
    return prev.object_norm && prev.object_norm === next.object_norm &&
           prev.value_norm !== next.value_norm;
  }
  return false;
}

/**
 * Apply one extracted fact. Returns what happened, so the caller can report
 * and the tests can assert on the branch taken rather than on side effects.
 */
export async function applyFact(db, f) {
  if (!isPredicate(f.predicate)) return { action: "rejected", reason: "unknown predicate" };
  if (!f.subject_norm) return { action: "rejected", reason: "no subject" };
  if (!f.valid_at) return { action: "rejected", reason: "no valid_at" };

  const value_norm = f.value_norm ?? normValue(f.value);
  const id = f.id ?? factId(f.document_id, f.predicate, f.subject_norm, value_norm, f.object_norm);
  const row = { ...f, id, value_norm };

  // Re-extraction of the same document: the row already exists and is correct.
  const { rows: existing } = await db.query(`select id from facts where id = $1`, [id]);
  if (existing.length) return { action: "unchanged", id };

  if (cardinalityOf(f.predicate) === "append") {
    await insert(db, row);
    return { action: "appended", id };
  }

  const live = await liveFacts(db, row);
  let retired = null;

  for (const prev of live) {
    if (!displaces(f.predicate, prev, row)) continue;

    // Late arrival: this document describes a period at or before the fact we
    // already hold. It is history, not news — record it with its window
    // already closed by the fact that came after it, and leave the live fact
    // alone. Without this, replaying an archive backwards rewrites the present.
    if (new Date(row.valid_at) <= new Date(prev.valid_at)) {
      await insert(db, { ...row, invalid_at: prev.valid_at, invalidated_by: prev.id });
      return { action: "historical", id, behind: prev.id };
    }

    await closeWindow(db, prev.id, { invalid_at: row.valid_at, by: id });
    retired = prev.id;
  }

  // Restatement: a live fact already holds this exact value. Nothing to do —
  // and critically, no second row, or "11 live facts" becomes "37 live facts"
  // after a year of monthly investor updates repeating the same numbers.
  if (!retired && live.some((p) => p.value_norm === value_norm &&
                                   (p.object_norm ?? null) === (row.object_norm ?? null))) {
    return { action: "restated", id: live.find((p) => p.value_norm === value_norm).id };
  }

  await insert(db, row);
  return retired ? { action: "superseded", id, retired } : { action: "written", id };
}

async function insert(db, r) {
  await db.query(
    `insert into facts (id, subject, subject_norm, predicate, object, object_norm,
                        value, value_norm, valid_at, invalid_at, document_id,
                        quote, confidence, owner, invalidated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (id) do nothing`,
    [r.id, r.subject, r.subject_norm, r.predicate, r.object ?? null, r.object_norm ?? null,
     r.value ?? null, r.value_norm ?? null, r.valid_at, r.invalid_at ?? null, r.document_id,
     r.quote, r.confidence, r.owner ?? "", r.invalidated_by ?? null]
  );
}

/**
 * Retract every fact a document produced — fein was wrong, or the body is gone.
 * Distinct from contradiction: expired_at, not invalid_at, and any window this
 * fact closed is reopened so the timeline does not keep a hole where a
 * retracted fact used to be.
 */
export async function retractDocumentFacts(db, documentId) {
  const { rows } = await db.query(
    `select id from facts where document_id = $1 and expired_at is null`,
    [documentId]
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  await db.query(
    `update facts set invalid_at = null, invalidated_by = null where invalidated_by in (${ph})`,
    ids
  );
  await db.query(`update facts set expired_at = now() where id in (${ph})`, ids);
  return ids.length;
}

/**
 * Hard-delete the facts a document produced (optionally keeping some), used
 * when a re-extraction supersedes the previous run's output.
 *
 * A raw DELETE is not safe here: a fact that CLOSED another fact's window
 * leaves that window shut with a dangling invalidated_by pointing at a row
 * that no longer exists — a permanent hole in the timeline that the as-of
 * query silently reads as "we believed nothing". Reopen first, then delete.
 */
export async function deleteDocumentFacts(db, documentId, keepIds = []) {
  const kp = keepIds.map((_, i) => `$${i + 2}`).join(",");
  const { rows } = await db.query(
    `select id from facts where document_id = $1${keepIds.length ? ` and id not in (${kp})` : ""}`,
    [documentId, ...keepIds]
  );
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  await db.query(
    `update facts set invalid_at = null, invalidated_by = null where invalidated_by in (${ph})`,
    ids
  );
  await db.query(`delete from facts where id in (${ph})`, ids);
  return ids.length;
}

/** Apply a batch in document order, oldest first, so backfills are deterministic. */
export async function applyFacts(db, facts) {
  const ordered = [...facts].sort((a, b) => new Date(a.valid_at) - new Date(b.valid_at));
  const results = [];
  for (const f of ordered) results.push(await applyFact(db, f));
  return results;
}

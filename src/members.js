import { id } from "./db.js";

/**
 * Team members own private layers. The shared layer is `''` — the absence of
 * an owner — so a single-user install never has to think about any of this.
 */
export const SHARED = "";

export async function listMembers(db) {
  const { rows } = await db.query(
    `select m.id, m.name, m.email, m.created_at,
            (select count(*) from documents d where d.owner = m.id) as documents
     from members m order by m.name`
  );
  return rows.map((r) => ({ ...r, documents: Number(r.documents) }));
}

export async function getMember(db, memberId) {
  if (!memberId) return null;
  const { rows } = await db.query(`select * from members where id = $1`, [memberId]);
  return rows[0] ?? null;
}

export async function addMember(db, { name, email }) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("a member needs a name");
  const member = { id: id("mem"), name: clean, email: email?.trim() || null };
  await db.query(`insert into members (id, name, email) values ($1, $2, $3)`,
    [member.id, member.name, member.email]);
  return member;
}

/**
 * Removing a member must not silently expose their private documents: their
 * layer is deleted with them unless `reassign` moves it somewhere explicit.
 */
export async function removeMember(db, memberId, { reassign = null } = {}) {
  const member = await getMember(db, memberId);
  if (!member) throw new Error(`no member ${memberId}`);
  let documents = 0;
  await db.tx(async (tx) => {
    // Count first: rowCount isn't reported consistently across drivers.
    const { rows } = await tx.query(`select count(*) as n from documents where owner = $1`, [memberId]);
    documents = Number(rows[0].n);
    if (reassign === "shared") {
      await tx.query(`update documents set owner = '' where owner = $1`, [memberId]);
    } else {
      await tx.query(`delete from documents where owner = $1`, [memberId]); // cascades to mentions
    }
    await tx.query(`delete from edges where owner = $1`, [memberId]);
    await tx.query(`delete from members where id = $1`, [memberId]);
  });
  return { removed: member.name, documents, reassigned: reassign === "shared" };
}

/** Accept an id, exact name, or email — CLI and API both take human input. */
export async function resolveMember(db, ref) {
  if (!ref) return null;
  const { rows } = await db.query(
    `select * from members
     where id = $1 or lower(name) = lower($1) or lower(email) = lower($1) limit 1`,
    [String(ref).trim()]
  );
  if (!rows.length) throw new Error(`no member matching "${ref}"`);
  return rows[0];
}

/** The layers a viewer may see in full: the shared one plus their own. */
export function visibleLayers(viewerId) {
  return viewerId ? [SHARED, viewerId] : [SHARED];
}

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
  const cleanEmail = email?.trim() || null;
  // A duplicate poisons every later --as ("Tom" matches 2 members): refuse now.
  const { rows: dupes } = await db.query(
    `select 1 from members where lower(name) = lower($1)
        or ($2::text is not null and lower(email) = lower($2))`,
    [clean, cleanEmail]
  );
  if (dupes.length) throw new Error(`a member named "${clean}" (or with that email) already exists`);
  const member = { id: id("mem"), name: clean, email: cleanEmail };
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
      // Their documents are shared now, so every value witnessed only by them
      // is shared-witnessed by definition: promote the overlay into the shared
      // columns before it is deleted below. Nothing else re-derives it — the
      // moved mentions keep their entity_id, so resolution never revisits them.
      const { rows: ev } = await tx.query(
        `select entity_id, kind, value from entity_evidence where owner = $1`, [memberId]);
      const cols = { email: "emails", org: "orgs", alias: "aliases" };
      const byEntity = new Map();
      for (const r of ev) {
        if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
        byEntity.get(r.entity_id).push(r);
      }
      const arr = (v) => (typeof v === "string" ? JSON.parse(v) : v ?? []);
      for (const [entityId, vals] of byEntity) {
        const { rows: ents } = await tx.query(
          `select emails, orgs, aliases from entities where id = $1`, [entityId]);
        if (!ents.length) continue;
        const next = { emails: arr(ents[0].emails), orgs: arr(ents[0].orgs), aliases: arr(ents[0].aliases) };
        for (const { kind, value } of vals) {
          const col = cols[kind];
          if (col && !next[col].includes(value)) next[col].push(value);
        }
        await tx.query(`update entities set emails = $2, orgs = $3, aliases = $4 where id = $1`,
          [entityId, JSON.stringify(next.emails), JSON.stringify(next.orgs), JSON.stringify(next.aliases)]);
      }
    } else {
      await tx.query(`delete from documents where owner = $1`, [memberId]); // cascades to mentions
    }
    await tx.query(`delete from edges where owner = $1`, [memberId]);
    // Their overlay evidence goes with the layer either way: promoted into the
    // shared columns on a reassign (above), deleted with the documents
    // otherwise — the rows are keyed to a member id that stops resolving.
    await tx.query(`delete from entity_evidence where owner = $1`, [memberId]);
    await tx.query(`delete from members where id = $1`, [memberId]);
  });
  return { removed: member.name, documents, reassigned: reassign === "shared" };
}

/** Accept an id, exact name, or email — CLI and API both take human input. */
export async function resolveMember(db, ref) {
  if (!ref) return null;
  const needle = String(ref).trim();
  const { rows } = await db.query(
    `select * from members
     where id = $1 or lower(name) = lower($1) or lower(email) = lower($1)`,
    [needle]
  );
  if (!rows.length) throw new Error(`no member matching "${ref}"`);
  // Two people called "Tom" must never resolve to whichever the database
  // returned first: the wrong answer here means writing into — or reading —
  // the wrong person's private layer.
  if (rows.length > 1) {
    const options = rows.map((r) => `${r.name}${r.email ? ` <${r.email}>` : ""} (${r.id})`).join(", ");
    throw new Error(`"${ref}" matches ${rows.length} members — use an email or id. Candidates: ${options}`);
  }
  return rows[0];
}

/** The layers a viewer may see in full: the shared one plus their own. */
export function visibleLayers(viewerId) {
  return viewerId ? [SHARED, viewerId] : [SHARED];
}

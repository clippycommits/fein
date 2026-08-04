import { normOrgName } from "../resolve/normalize.js";
import { searchEntities } from "./queries.js";

/**
 * Fund memory for a company: every deal signal ever recorded about it —
 * investments, passes with their reasoning, live evaluations — with document
 * provenance, plus the resolved org entity and affiliated people when
 * resolution knows the company. Deals link to entities at query time via
 * normalized-name aliases, so entity rebuilds never orphan a deal, and a
 * company the graph hasn't resolved yet still answers from its deal rows.
 */
export async function companyMemory(db, companyRef) {
  const norm = normOrgName(companyRef);
  const matches = (await searchEntities(db, companyRef, 5)).filter((e) => e.kind === "org");
  const entity =
    matches.find((e) => normOrgName(e.canonical_name) === norm || e.aliases.includes(norm)) ??
    matches[0] ?? null;
  const aliases = [...new Set(
    [norm, ...(entity ? [normOrgName(entity.canonical_name), ...entity.aliases] : [])].filter(Boolean)
  )];
  if (!aliases.length) return { company: companyRef, entity: null, deals: [], documents: [], people: [] };
  const ph = aliases.map((_, i) => `$${i + 1}`).join(", ");

  const { rows: deals } = await db.query(
    `select d.company, d.stage, d.status, d.summary, d.confidence, d.context,
            doc.id as document_id, doc.title as document_title,
            doc.source as document_source, doc.occurred_at
     from deals d join documents doc on doc.id = d.document_id
     where d.company_norm in (${ph})
     order by doc.occurred_at desc nulls last`,
    aliases
  );

  let documents = [];
  let people = [];
  if (entity) {
    ({ rows: documents } = await db.query(
      `select distinct doc.id, doc.source, doc.kind, doc.title, doc.occurred_at
       from documents doc join mentions m on m.document_id = doc.id
       where m.entity_id = $1
       order by doc.occurred_at desc nulls last limit 15`,
      [entity.id]
    ));
    ({ rows: people } = await db.query(
      `select e.id, e.canonical_name, e.emails from entities e
       where e.kind = 'person' and e.merged_into is null
         and exists (select 1 from jsonb_array_elements_text(e.orgs) o where o in (${ph}))
       order by e.canonical_name`,
      aliases
    ));
  }

  return {
    company: entity?.canonical_name ?? companyRef,
    entity,
    deals,
    documents,
    people: people.map((p) => ({
      id: p.id,
      name: p.canonical_name,
      emails: typeof p.emails === "string" ? JSON.parse(p.emails) : p.emails,
    })),
    ...(deals.length === 0 ? { note: "no recorded deal signals for this company" } : {}),
  };
}

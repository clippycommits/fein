import { normOrgName } from "../resolve/normalize.js";
import { searchEntities } from "./queries.js";
import { visibleLayers } from "../members.js";
import { getSettings } from "../settings.js";
import { liveFacts, retiredFacts, factsAsOf, factStats } from "../facts/queries.js";

/**
 * Fund memory for a company: every deal signal ever recorded about it —
 * investments, passes with their reasoning, live evaluations — with document
 * provenance, plus the resolved org entity and affiliated people when
 * resolution knows the company. Deals link to entities at query time via
 * normalized-name aliases, so entity rebuilds never orphan a deal, and a
 * company the graph hasn't resolved yet still answers from its deal rows.
 */
export async function companyMemory(db, companyRef, { viewer = null, asOf = null } = {}) {
  const norm = normOrgName(companyRef);
  const layers = visibleLayers(viewer);
  const matches = (await searchEntities(db, companyRef, 5, { viewer })).filter((e) => e.kind === "org");
  const entity =
    matches.find((e) => normOrgName(e.canonical_name) === norm || e.aliases.includes(norm)) ??
    matches[0] ?? null;
  const aliases = [...new Set(
    [norm, ...(entity ? [normOrgName(entity.canonical_name), ...entity.aliases] : [])].filter(Boolean)
  )];
  if (!aliases.length)
    return { company: companyRef, entity: null, deals: [], documents: [], people: [],
             facts: { as_of: asOf, live: [], retired: [], counts: { total: 0, live: 0, retired: 0 } } };
  const ph = aliases.map((_, i) => `$${i + 1}`).join(", ");
  // Layer scoping mirrors entityBrief exactly: deal rows, document titles,
  // and affiliated people are all evidence — never served across layers.
  const lph = layers.map((_, i) => `$${aliases.length + i + 1}`).join(", ");

  const { rows: deals } = await db.query(
    `select d.company, d.stage, d.status, d.summary, d.confidence, d.context,
            doc.id as document_id, doc.title as document_title,
            doc.source as document_source, doc.occurred_at
     from deals d join documents doc on doc.id = d.document_id
     where d.company_norm in (${ph}) and doc.owner in (${lph})
     order by doc.occurred_at desc nulls last`,
    [...aliases, ...layers]
  );

  let documents = [];
  let people = [];
  if (entity) {
    ({ rows: documents } = await db.query(
      `select distinct doc.id, doc.source, doc.kind, doc.title, doc.occurred_at
       from documents doc join mentions m on m.document_id = doc.id
       where m.entity_id = $1 and doc.owner in (${layers.map((_, i) => `$${i + 2}`).join(", ")})
       order by doc.occurred_at desc nulls last limit 15`,
      [entity.id, ...layers]
    ));
    const { privateEntityVisibility } = await getSettings(db);
    const peopleGate = privateEntityVisibility === "reveal" ? "" : `
         and exists (
           select 1 from mentions mm join documents dd on dd.id = mm.document_id
           where mm.entity_id = e.id and dd.owner in (${lph})
         )`;
    ({ rows: people } = await db.query(
      `select e.id, e.canonical_name, e.emails from entities e
       where e.kind = 'person' and e.merged_into is null
         and exists (select 1 from jsonb_array_elements_text(e.orgs) o where o in (${ph}))
         ${peopleGate}
       order by e.canonical_name`,
      privateEntityVisibility === "reveal" ? aliases : [...aliases, ...layers]
    ));
  }

  // Temporal facts. With no asOf this is the present: what is true today, and
  // what has been retired and kept. With an asOf it is the world as fein
  // believed it on that day — the "what did we know when we passed" question,
  // which is the whole reason validity windows exist.
  const facts = asOf
    ? { as_of: asOf, live: await factsAsOf(db, aliases, asOf, { viewer }), retired: [],
        counts: await factStats(db, aliases, { viewer }) }
    : { as_of: null,
        live: await liveFacts(db, aliases, { viewer }),
        retired: await retiredFacts(db, aliases, { viewer }),
        counts: await factStats(db, aliases, { viewer }) };

  return {
    company: entity?.canonical_name ?? companyRef,
    entity,
    facts,
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

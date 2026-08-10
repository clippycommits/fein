import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SLUG, env } from "../brand.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../db.js";
import { searchEntities, entityBrief, resolveRef, counts, nameSteps } from "../graph/queries.js";
import { findWarmPath, findIntroducers, strongestConnections } from "../graph/paths.js";
import { rebuildEdgesFor } from "../graph/edges.js";
import { listReviews, resolveReview } from "../resolve/review.js";
import { getEntity } from "../graph/queries.js";
import { companyMemory } from "../graph/memory.js";
import { whatChanged, factHistory } from "../facts/queries.js";
import { normOrgName } from "../resolve/normalize.js";
import { PREDICATE_NAMES } from "../facts/vocab.js";

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

async function ref(db, r, viewer) {
  const res = await resolveRef(db, r, { viewer });
  if (res.error) throw new Error(JSON.stringify(res));
  return res.entity;
}

/** stdio entry point (`fein mcp`). FEIN_VIEWER (or legacy FUNDGRAPH_VIEWER) selects which
 * member's private layer the agent speaks for; unset = shared layer only. */
export async function startMcpServer() {
  const db = await getDb();
  let viewer = null;
  let actor = "agent";
  if (env("VIEWER")) {
    const { resolveMember } = await import("../members.js");
    let member;
    try {
      member = await resolveMember(db, env("VIEWER"));
    } catch (err) {
      // A wrong viewer must fail before the first tool call — loudly, not
      // with a stack trace.
      console.error(err.message);
      process.exit(1);
    }
    viewer = member.id;
    actor = `agent:${member.name}`;
  }
  const server = buildMcpServer(db, { viewer, actor });
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * All Fein tools on a fresh McpServer, bound to one viewer. The web
 * server builds one of these per HTTP request (stateless Streamable HTTP),
 * so construction must stay cheap — it only registers handlers.
 */
export function buildMcpServer(db, { viewer = null, actor = "agent" } = {}) {
  const server = new McpServer({ name: SLUG, version: VERSION });

  server.tool(
    "search_entities",
    "Search people and organizations in the fund graph by name, email, or org.",
    { query: z.string() },
    async ({ query }) => text(await searchEntities(db, query, 10, { viewer }))
  );

  server.tool(
    "entity_brief",
    "Pre-meeting brief: profile, strongest connections, recent documents. Accepts an entity id, name, or email.",
    { entity: z.string() },
    async ({ entity }) => {
      const e = await ref(db, entity, viewer);
      return text(await entityBrief(db, e.id, { viewer }));
    }
  );

  server.tool(
    "find_warm_path",
    "Best warm-intro path between two people, maximizing the product of relationship strengths along the way. If the only route runs through a colleague's private layer, `privatePath` reports that it exists and who owns it — hop strengths are null and the underlying documents are never returned.",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      const a = await ref(db, from, viewer);
      const b = await ref(db, to, viewer);
      const result = await findWarmPath(db, a.id, b.id, { viewer });
      if (!result) return text({ path: null, note: "no connecting path found" });
      await nameSteps(db, result.path ?? [], { viewer });
      await nameSteps(db, result.privatePath?.path ?? [], { viewer });
      return text(result);
    }
  );

  server.tool(
    "find_introducers",
    "Rank mutual connections who could introduce `from` to `to`, scored by the weaker leg of the two relationships.",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      const a = await ref(db, from, viewer);
      const b = await ref(db, to, viewer);
      const res = await findIntroducers(db, a.id, b.id, { viewer });
      const intros = Array.isArray(res) ? res : res.introducers;
      for (const i of intros) {
        i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
      }
      return text(res);
    }
  );

  server.tool(
    "strongest_connections",
    "An entity's strongest relationships with the signals behind each score.",
    { entity: z.string(), limit: z.number().optional() },
    async ({ entity, limit }) => {
      const e = await ref(db, entity, viewer);
      const conns = await strongestConnections(db, e.id, { viewer, limit: limit ?? 10 });
      for (const c of conns) {
        const other = await getEntity(db, c.entity);
        c.name = other?.canonical_name ?? c.entity;
      }
      return text(conns);
    }
  );

  server.tool(
    "meeting_prep",
    "Everything needed to prep a meeting with a person: profile, relationship history with receipts, recent shared documents, and (when `me` is given) your warm paths and best introducers to them. Returns structured data for you to write up.",
    { entity: z.string(), me: z.string().optional() },
    async ({ entity, me }) => {
      const target = await ref(db, entity, viewer);
      const brief = await entityBrief(db, target.id, { viewer });
      const prep = {
        profile: brief.entity,
        connections: brief.connections,
        recentDocuments: brief.recentDocuments,
      };
      if (me) {
        const self = await ref(db, me, viewer);
        const path = await findWarmPath(db, self.id, target.id, { viewer });
        await nameSteps(db, path?.path ?? [], { viewer });
        await nameSteps(db, path?.privatePath?.path ?? [], { viewer });
        const introRes = await findIntroducers(db, self.id, target.id, { viewer });
        const intros = Array.isArray(introRes) ? introRes : introRes.introducers;
        for (const i of intros) {
          i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
        }
        prep.warmPath = path;
        prep.introducers = intros;
        if (!Array.isArray(introRes)) prep.viaPrivate = introRes.viaPrivate;
      }
      return text(prep);
    }
  );

  server.tool(
    "company_memory",
    "Institutional memory for a company: what is true today and what has stopped being true (with the date each fact was retired and the document that retired it), plus every recorded deal signal (investments, passes with reasoning, live evaluations) mined from IC memos, board packs, and emails — with document provenance — plus the resolved org entity, affiliated people, and related documents. Passes matter: 'have we seen this company before, and why did we say no?'. Pass as_of (ISO date) to get the world as fein believed it on that day rather than today — what we knew when we passed.",
    { company: z.string(), as_of: z.string().optional() },
    async ({ company, as_of }) => text(await companyMemory(db, company, { viewer, asOf: as_of ?? null }))
  );

  server.tool(
    "what_changed",
    "What stopped being true, and what became true, about a company in a time window — each change with the document that caused it. This is the standing-brief tool: run it before a meeting or on Monday morning to see what moved without reading every source. `since` is an ISO date. Facts that were retired are reported alongside the fact that replaced them, so 'they used to have no design partners, now they have six' is a single answer rather than an inference across two documents.",
    { company: z.string(), since: z.string(), until: z.string().optional() },
    async ({ company, since, until }) => {
      const subject = normOrgName(company);
      const changed = await whatChanged(db, subject, since, { viewer, until: until ?? null });
      return text({ company, since, until: until ?? null, ...changed });
    }
  );

  server.tool(
    "fact_history",
    `The full validity timeline for one attribute of a company, oldest first — every value it has held, when each became true, when each stopped, and the document behind each. Use it to audit an answer or to show how a number moved over time. Predicates: ${PREDICATE_NAMES.join(", ")}. Nothing is deleted, so a retired value is still here with its date range.`,
    { company: z.string(), predicate: z.enum(PREDICATE_NAMES) },
    async ({ company, predicate }) => {
      const subject = normOrgName(company);
      const history = await factHistory(db, subject, predicate, { viewer });
      return text({ company, predicate, history });
    }
  );

  server.tool(
    "relationship_radar",
    "Timing intelligence: which relationships need attention now. Every pair has its own cadence learned from real contact history, so 'overdue' means overdue *for them* — three weeks is nothing for a quarterly contact and alarming for a weekly one. Give a person for their radar, or omit for the whole graph. Statuses: active, due, overdue, cold, dormant, new; trend is warming/steady/cooling.",
    { entity: z.string().optional(), limit: z.number().optional() },
    async ({ entity, limit }) => {
      const { relationshipRadar, radarSummary } = await import("../graph/radar.js");
      if (!entity) {
        const summary = await radarSummary(db, { viewer, limit: limit ?? 20 });
        for (const i of summary.needsAttention) {
          i.aName = (await getEntity(db, i.a))?.canonical_name ?? i.a;
          i.bName = (await getEntity(db, i.b))?.canonical_name ?? i.b;
        }
        return text(summary);
      }
      const e = await ref(db, entity, viewer);
      const items = await relationshipRadar(db, e.id, { viewer, limit: limit ?? 25 });
      for (const i of items) i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
      return text({ entity: e.canonical_name, radar: items });
    }
  );

  server.tool(
    "graph_stats",
    "Counts of documents, mentions, entities, pending reviews, and edges — scoped to the layers this connection may see.",
    {},
    async () => text(await counts(db, { viewer }))
  );

  server.tool(
    "review_queue",
    // Static copy on purpose: buildMcpServer runs per HTTP request and must
    // stay cheap, so no settings fetch to interpolate live thresholds.
    "Pending entity-resolution matches that need human confirmation (score between the review floor and the auto-merge threshold — default 0.70–0.95, tunable in Settings).",
    {},
    async () => text(await listReviews(db, { viewer }))
  );

  server.tool(
    "review_resolve",
    "Confirm or reject a pending entity match. accept = same person, reject = different person.",
    { review_id: z.string(), decision: z.enum(["accept", "reject"]) },
    async ({ review_id, decision }) => {
      const result = await resolveReview(db, review_id, decision, { actor });
      // The graph is a read model: an agent's decision refreshes it exactly
      // like a dashboard click — but only the entity the decision touched.
      await rebuildEdgesFor(db, [result.entity]);
      return text(result);
    }
  );

  return server;
}

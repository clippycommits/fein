import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../db.js";
import { searchEntities, entityBrief, resolveRef, counts } from "../graph/queries.js";
import { findWarmPath, findIntroducers, strongestConnections } from "../graph/paths.js";
import { listReviews, resolveReview } from "../resolve/review.js";
import { getEntity } from "../graph/queries.js";
import { companyMemory } from "../graph/memory.js";

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

async function ref(db, r) {
  const res = await resolveRef(db, r);
  if (res.error) throw new Error(JSON.stringify(res));
  return res.entity;
}

/** stdio entry point (`fundgraph mcp`). FUNDGRAPH_VIEWER selects which
 * member's private layer the agent speaks for; unset = shared layer only. */
export async function startMcpServer() {
  const db = await getDb();
  let viewer = null;
  if (process.env.FUNDGRAPH_VIEWER) {
    const { resolveMember } = await import("../members.js");
    viewer = (await resolveMember(db, process.env.FUNDGRAPH_VIEWER)).id;
  }
  const server = buildMcpServer(db, { viewer });
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * All fundgraph tools on a fresh McpServer, bound to one viewer. The web
 * server builds one of these per HTTP request (stateless Streamable HTTP),
 * so construction must stay cheap — it only registers handlers.
 */
export function buildMcpServer(db, { viewer = null } = {}) {
  const server = new McpServer({ name: "fundgraph", version: "0.3.0" });

  server.tool(
    "search_entities",
    "Search people and organizations in the fund graph by name, email, or org.",
    { query: z.string() },
    async ({ query }) => text(await searchEntities(db, query))
  );

  server.tool(
    "entity_brief",
    "Pre-meeting brief: profile, strongest connections, recent documents. Accepts an entity id, name, or email.",
    { entity: z.string() },
    async ({ entity }) => {
      const e = await ref(db, entity);
      return text(await entityBrief(db, e.id, { viewer }));
    }
  );

  server.tool(
    "find_warm_path",
    "Best warm-intro path between two people, maximizing the product of relationship strengths along the way. If the only route runs through a colleague's private layer, `privatePath` reports that it exists and who owns it — hop strengths are null and the underlying documents are never returned.",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      const a = await ref(db, from);
      const b = await ref(db, to);
      const result = await findWarmPath(db, a.id, b.id, { viewer });
      if (!result) return text({ path: null, note: "no connecting path found" });
      for (const step of result.path ?? []) {
        step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
      }
      for (const step of result.privatePath?.path ?? []) {
        step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
      }
      return text(result);
    }
  );

  server.tool(
    "find_introducers",
    "Rank mutual connections who could introduce `from` to `to`, scored by the weaker leg of the two relationships.",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      const a = await ref(db, from);
      const b = await ref(db, to);
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
      const e = await ref(db, entity);
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
      const target = await ref(db, entity);
      const brief = await entityBrief(db, target.id, { viewer });
      const prep = {
        profile: brief.entity,
        connections: brief.connections,
        recentDocuments: brief.recentDocuments,
      };
      if (me) {
        const self = await ref(db, me);
        const path = await findWarmPath(db, self.id, target.id, { viewer });
        for (const step of path?.path ?? []) {
          step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
        }
        for (const step of path?.privatePath?.path ?? []) {
          step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
        }
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
    "Institutional memory for a company: every recorded deal signal (investments, passes with reasoning, live evaluations) mined from IC memos, board packs, and emails — with document provenance — plus the resolved org entity, affiliated people, and related documents. Passes matter: 'have we seen this company before, and why did we say no?'",
    { company: z.string() },
    async ({ company }) => text(await companyMemory(db, company, { viewer }))
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
      const e = await ref(db, entity);
      const items = await relationshipRadar(db, e.id, { viewer, limit: limit ?? 25 });
      for (const i of items) i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
      return text({ entity: e.canonical_name, radar: items });
    }
  );

  server.tool(
    "graph_stats",
    "Counts of documents, mentions, entities, pending reviews, and edges.",
    {},
    async () => text(await counts(db))
  );

  server.tool(
    "review_queue",
    "Pending entity-resolution matches that need human confirmation (score between 0.70 and 0.95).",
    {},
    async () => text(await listReviews(db, { viewer }))
  );

  server.tool(
    "review_resolve",
    "Confirm or reject a pending entity match. accept = same person, reject = different person.",
    { review_id: z.string(), decision: z.enum(["accept", "reject"]) },
    async ({ review_id, decision }) => text(await resolveReview(db, review_id, decision))
  );

  return server;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../db.js";
import { searchEntities, entityBrief, resolveRef, counts } from "../graph/queries.js";
import { findWarmPath, findIntroducers, strongestConnections } from "../graph/paths.js";
import { listReviews, resolveReview } from "../resolve/review.js";
import { getEntity } from "../graph/queries.js";

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

async function ref(db, r) {
  const res = await resolveRef(db, r);
  if (res.error) throw new Error(JSON.stringify(res));
  return res.entity;
}

export async function startMcpServer() {
  const db = await getDb();
  const server = new McpServer({ name: "fundgraph", version: "0.1.0" });

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
      return text(await entityBrief(db, e.id));
    }
  );

  server.tool(
    "find_warm_path",
    "Best warm-intro path between two people, maximizing the product of relationship strengths along the way.",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      const a = await ref(db, from);
      const b = await ref(db, to);
      const result = await findWarmPath(db, a.id, b.id);
      if (!result) return text({ path: null, note: "no connecting path found" });
      for (const step of result.path) {
        const e = await getEntity(db, step.entity);
        step.name = e?.canonical_name ?? step.entity;
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
      const intros = await findIntroducers(db, a.id, b.id);
      for (const i of intros) {
        const e = await getEntity(db, i.entity);
        i.name = e?.canonical_name ?? i.entity;
      }
      return text(intros);
    }
  );

  server.tool(
    "strongest_connections",
    "An entity's strongest relationships with the signals behind each score.",
    { entity: z.string(), limit: z.number().optional() },
    async ({ entity, limit }) => {
      const e = await ref(db, entity);
      const conns = await strongestConnections(db, e.id, limit ?? 10);
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
      const brief = await entityBrief(db, target.id);
      const prep = {
        profile: brief.entity,
        connections: brief.connections,
        recentDocuments: brief.recentDocuments,
      };
      if (me) {
        const self = await ref(db, me);
        const path = await findWarmPath(db, self.id, target.id);
        if (path) {
          for (const step of path.path) {
            step.name = (await getEntity(db, step.entity))?.canonical_name ?? step.entity;
          }
        }
        const intros = await findIntroducers(db, self.id, target.id);
        for (const i of intros) {
          i.name = (await getEntity(db, i.entity))?.canonical_name ?? i.entity;
        }
        prep.warmPath = path;
        prep.introducers = intros;
      }
      return text(prep);
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
    async () => text(await listReviews(db))
  );

  server.tool(
    "review_resolve",
    "Confirm or reject a pending entity match. accept = same person, reject = different person.",
    { review_id: z.string(), decision: z.enum(["accept", "reject"]) },
    async ({ review_id, decision }) => text(await resolveReview(db, review_id, decision))
  );

  await server.connect(new StdioServerTransport());
  return server;
}

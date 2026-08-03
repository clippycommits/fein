#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";
import { loadJsonl } from "./ingest/local.js";
import { ingestDocs } from "./ingest/index.js";
import { resolveMentions } from "./resolve/pipeline.js";
import { listReviews, resolveReview } from "./resolve/review.js";
import { rebuildEdges } from "./graph/edges.js";
import { findWarmPath, findIntroducers } from "./graph/paths.js";
import { searchEntities, entityBrief, resolveRef, counts } from "./graph/queries.js";
import { getEntity } from "./graph/queries.js";

const [, , cmd, ...args] = process.argv;

const USAGE = `fundgraph — open-source agentic data layer for investment teams

  fundgraph ingest <file.jsonl>     ingest documents (see sample/seed.jsonl for the shape)
  fundgraph resolve                 run entity resolution over unresolved mentions
  fundgraph edges                   rebuild the relationship graph
  fundgraph stats                   counts of docs / mentions / entities / edges
  fundgraph entities <query>        search people and orgs
  fundgraph brief <ref>             pre-meeting brief for a person (name, email, or id)
  fundgraph path <from> <to>        best warm-intro path between two people
  fundgraph intros <from> <to>      rank mutual connections as introducers
  fundgraph review                  list pending resolution reviews
  fundgraph review accept|reject <review_id>
  fundgraph demo                    ingest sample data + resolve + edges
  fundgraph mcp                     start the MCP server (stdio)`;

async function refOrDie(db, r) {
  const res = await resolveRef(db, r);
  if (res.error) {
    console.error(res.error);
    if (res.candidates) console.error(JSON.stringify(res.candidates, null, 2));
    process.exit(1);
  }
  return res.entity;
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "mcp") {
    const { startMcpServer } = await import("./mcp/server.js");
    await startMcpServer();
    return; // stays alive on stdio
  }

  const db = await getDb();
  const out = (o) => console.log(JSON.stringify(o, null, 2));

  switch (cmd) {
    case "ingest": {
      if (!args[0]) throw new Error("usage: fundgraph ingest <file.jsonl>");
      out(await ingestDocs(db, loadJsonl(args[0])));
      break;
    }
    case "resolve":
      out(await resolveMentions(db));
      break;
    case "edges":
      out(await rebuildEdges(db));
      break;
    case "stats":
      out(await counts(db));
      break;
    case "entities":
      out(await searchEntities(db, args.join(" ") || ""));
      break;
    case "brief": {
      const e = await refOrDie(db, args.join(" "));
      out(await entityBrief(db, e.id));
      break;
    }
    case "path":
    case "intros": {
      if (args.length < 2) throw new Error(`usage: fundgraph ${cmd} <from> <to>`);
      const a = await refOrDie(db, args[0]);
      const b = await refOrDie(db, args[1]);
      if (cmd === "path") {
        const p = await findWarmPath(db, a.id, b.id);
        if (p) for (const s of p.path) s.name = (await getEntity(db, s.entity))?.canonical_name;
        out(p ?? { path: null });
      } else {
        const intros = await findIntroducers(db, a.id, b.id);
        for (const i of intros) i.name = (await getEntity(db, i.entity))?.canonical_name;
        out(intros);
      }
      break;
    }
    case "review": {
      if (!args.length) out(await listReviews(db));
      else out(await resolveReview(db, args[1], args[0]));
      break;
    }
    case "demo": {
      const dir = fileURLToPath(new URL("../sample/seed.jsonl", import.meta.url));
      console.log("ingest:", JSON.stringify(await ingestDocs(db, loadJsonl(dir))));
      console.log("resolve:", JSON.stringify(await resolveMentions(db)));
      console.log("edges:", JSON.stringify(await rebuildEdges(db)));
      console.log("stats:", JSON.stringify(await counts(db)));
      break;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
  await db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

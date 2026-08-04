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

  fundgraph ingest <file> [--as M]  ingest a file: .jsonl | .mbox (Gmail export) | .ics | .csv (CRM export)
                                    --as <member> puts it in that member's PRIVATE layer
  fundgraph ingest-granola [path]   ingest meetings from the local Granola cache (macOS)
  fundgraph ingest-gog <service>    live pull via the gog CLI: gmail | calendar | drive
                                    (set FUNDGRAPH_GOG_SSH=user@host to run gog on a remote machine;
                                     gmail extras: [query] [max])
  fundgraph ingest-google <service> live pull via Google APIs: gmail | calendar | drive
                                    (needs GOOGLE_OAUTH_CREDENTIALS; prefer ingest-gog if you have gog)
  fundgraph ingest-attio            pull people, companies + notes from an Attio workspace
                                    (needs ATTIO_API_KEY; pass --no-notes to skip notes)
  fundgraph sync [--extract]        resolve + rebuild edges (add --extract to mine bodies first)
  fundgraph extract [--limit N]     LLM mention extraction over unprocessed document bodies
                                    (Anthropic API: set ANTHROPIC_API_KEY or use \`ant auth login\`;
                                     FUNDGRAPH_EXTRACT_MODEL overrides the model, default claude-opus-5)
  fundgraph reresolve               re-run entity resolution from scratch (documents kept;
                                    review decisions are replayed, pending questions re-asked)
  fundgraph web [port]              start the web dashboard (default port 4321)
  fundgraph resolve                 run entity resolution over unresolved mentions
  fundgraph edges                   rebuild the relationship graph
  fundgraph stats                   counts of docs / mentions / entities / edges
  fundgraph entities <query>        search people and orgs
  fundgraph brief <ref>             pre-meeting brief for a person (name, email, or id)
  fundgraph memory <company>        fund memory: every recorded deal signal for a company
                                    (investments, passes + reasoning), with provenance
  fundgraph path <from> <to>        best warm-intro path between two people
  fundgraph intros <from> <to>      rank mutual connections as introducers
  fundgraph merge <keep> <lose>     merge two entities that resolution left separate
  fundgraph unmerge <entity>        reverse a merge
  fundgraph merges                  list merges (they survive reresolve)
  fundgraph automated [--list]      re-detect automated senders (robots, notification services);
                                    --list shows what is currently flagged and why
  fundgraph radar [person]          relationships needing attention, by their own cadence
                                    (a person = their radar; no arg = the whole graph)
  fundgraph review                  list pending resolution reviews
  fundgraph review accept|reject <review_id>
  fundgraph demo                    ingest sample data + resolve + edges
  fundgraph members                 list team members and their private layers
  fundgraph members add <name> [email]
  fundgraph members remove <member> [--reassign-shared]
  fundgraph mcp                     start the MCP server (stdio)

  Most read commands accept --as <member> to view as that person: the shared
  layer plus their own private layer. Without it you see the shared layer only.`;

async function loadFile(path) {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "jsonl" || ext === "json") return loadJsonl(path);
  if (ext === "mbox") return (await import("./ingest/mbox.js")).loadMbox(path);
  if (ext === "ics") return (await import("./ingest/ics.js")).loadIcs(path);
  if (ext === "csv") return (await import("./ingest/csv.js")).loadCsv(path);
  throw new Error(`unsupported file type .${ext} — expected .jsonl, .mbox, .ics, or .csv`);
}

function extractTicker() {
  let last = 0;
  return (s) => {
    const done = s.extracted + s.failed;
    if (done !== last) {
      last = done;
      process.stderr.write(`  …${done} docs (${s.mentions} mentions, ${s.tokens.input + s.tokens.output} tokens)\n`);
    }
  };
}

/** `--as <member>` selects the viewing/owning layer for a command. */
async function takeAs(db, args) {
  const i = args.indexOf("--as");
  if (i === -1) return { member: null, rest: [...args] }; // copy: caller rewrites in place
  const ref = args[i + 1];
  if (!ref) throw new Error("--as needs a member name, email, or id");
  const { resolveMember } = await import("./members.js");
  const member = await resolveMember(db, ref);
  return { member, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

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
  if (cmd === "web") {
    const { startWebServer } = await import("./web/server.js");
    await startWebServer(Number(args[0] ?? process.env.FUNDGRAPH_PORT ?? 4321));
    return; // stays alive serving http
  }

  const db = await getDb();
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  const { member: as, rest: rawArgs } = await takeAs(db, args);
  args.length = 0;
  args.push(...rawArgs);
  const viewer = as?.id ?? null;

  switch (cmd) {
    case "ingest": {
      if (!args[0]) throw new Error("usage: fundgraph ingest <file.{jsonl,mbox,ics,csv}>");
      // A Takeout mbox can be tens of gigabytes: stream it in batches rather
      // than materializing every message first.
      if (args[0].toLowerCase().endsWith(".mbox")) {
        const { streamMbox } = await import("./ingest/mbox.js");
        const { ingestStream } = await import("./ingest/index.js");
        let ticks = 0;
        out(await ingestStream(db, streamMbox(args[0]), {
          owner: viewer ?? "",
          onProgress: (t) => {
            if (++ticks % 5 === 0) process.stderr.write(`  …${t.docCount.toLocaleString()} messages\n`);
          },
        }));
      } else {
        out(await ingestDocs(db, await loadFile(args[0]), { owner: viewer ?? "" }));
      }
      break;
    }
    case "ingest-granola": {
      const { loadGranola } = await import("./ingest/granola.js");
      out(await ingestDocs(db, loadGranola(args[0])));
      break;
    }
    case "ingest-gog": {
      const service = args[0] ?? "gmail";
      const gog = await import("./ingest/gog.js");
      let docs;
      if (service === "gmail") {
        docs = gog.fetchGogGmail({ query: args[1] ?? "in:anywhere", max: Number(args[2] ?? 200) });
      } else if (service === "calendar") docs = gog.fetchGogCalendar({ max: Number(args[1] ?? 500) });
      else if (service === "drive") docs = gog.fetchGogDrive({ max: Number(args[1] ?? 500) });
      else throw new Error("usage: fundgraph ingest-gog gmail|calendar|drive");
      out(await ingestDocs(db, docs));
      break;
    }
    case "ingest-attio": {
      const { fetchAttio } = await import("./ingest/attio.js");
      out(await ingestDocs(db, await fetchAttio({ includeNotes: args[0] !== "--no-notes" })));
      break;
    }
    case "ingest-google": {
      const service = args[0] ?? "gmail";
      const g = await import("./ingest/google/fetchers.js");
      let docs;
      if (service === "gmail") docs = await g.fetchGmail({ query: args[1] ?? "", max: Number(args[2] ?? 300) });
      else if (service === "calendar") docs = await g.fetchCalendar({});
      else if (service === "drive") docs = await g.fetchDrive({});
      else throw new Error("usage: fundgraph ingest-google gmail|calendar|drive");
      out(await ingestDocs(db, docs));
      break;
    }
    case "sync": {
      let extract = null;
      if (args.includes("--extract")) {
        const { extractPending } = await import("./extract/pipeline.js");
        extract = await extractPending(db, { onProgress: extractTicker() });
      }
      const r = await resolveMentions(db);
      const { detectAutomated } = await import("./resolve/automated.js");
      const auto = await detectAutomated(db);
      const e = await rebuildEdges(db);
      out({ ...(extract ? { extract } : {}), resolve: r, automated: auto, edges: e, stats: await counts(db) });
      break;
    }
    case "extract": {
      const { extractPending } = await import("./extract/pipeline.js");
      const limitIx = args.indexOf("--limit");
      const limit = limitIx !== -1 ? Number(args[limitIx + 1]) : Infinity;
      if (limitIx !== -1 && !Number.isFinite(limit)) throw new Error("usage: fundgraph extract [--limit N]");
      const result = await extractPending(db, { limit, onProgress: extractTicker() });
      // Newly extracted mentions still need resolution + edges to reach the graph.
      const resolve = result.extracted > 0 ? await resolveMentions(db) : null;
      const edges = result.extracted > 0 ? await rebuildEdges(db) : null;
      out({ extract: result, ...(resolve ? { resolve, edges } : {}), stats: await counts(db) });
      break;
    }
    case "reresolve": {
      const { reresolveAll } = await import("./resolve/reresolve.js");
      const r = await reresolveAll(db);
      out({ ...r, stats: await counts(db) });
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
      out(await entityBrief(db, e.id, { viewer }));
      break;
    }
    case "memory": {
      if (!args.length) throw new Error("usage: fundgraph memory <company>");
      const { companyMemory } = await import("./graph/memory.js");
      out(await companyMemory(db, args.join(" ")));
      break;
    }
    case "path":
    case "intros": {
      if (args.length < 2) throw new Error(`usage: fundgraph ${cmd} <from> <to>`);
      const a = await refOrDie(db, args[0]);
      const b = await refOrDie(db, args[1]);
      const name = async (steps) => {
        for (const s of steps ?? []) s.name = (await getEntity(db, s.entity))?.canonical_name;
      };
      if (cmd === "path") {
        const p = await findWarmPath(db, a.id, b.id, { viewer });
        await name(p?.path);
        await name(p?.privatePath?.path);
        out(p ?? { path: null });
      } else {
        const res = await findIntroducers(db, a.id, b.id, { viewer });
        const list = Array.isArray(res) ? res : res.introducers;
        for (const i of list) i.name = (await getEntity(db, i.entity))?.canonical_name;
        out(res);
      }
      break;
    }
    case "merge": {
      if (args.length < 2) throw new Error("usage: fundgraph merge <keep> <lose>");
      const { mergeEntities } = await import("./resolve/merge.js");
      const keep = await refOrDie(db, args[0]);
      const lose = await refOrDie(db, args[1]);
      const r = await mergeEntities(db, keep.id, lose.id);
      await rebuildEdges(db);
      out(r);
      break;
    }
    case "unmerge": {
      if (!args[0]) throw new Error("usage: fundgraph unmerge <entity>");
      const { unmergeEntity } = await import("./resolve/merge.js");
      const { rows } = await db.query(
        `select id from entities where (id = $1 or lower(canonical_name) = lower($1))
           and merged_into is not null limit 1`, [args.join(" ")]
      );
      if (!rows.length) throw new Error(`no merged entity matching "${args.join(" ")}"`);
      const r = await unmergeEntity(db, rows[0].id);
      await rebuildEdges(db);
      out(r);
      break;
    }
    case "merges": {
      const { listMerges } = await import("./resolve/merge.js");
      out(await listMerges(db));
      break;
    }
    case "automated": {
      const { detectAutomated } = await import("./resolve/automated.js");
      if (args.includes("--list")) {
        const { rows } = await db.query(
          `select canonical_name, automated_reason, automated_override from entities
           where automated order by canonical_name`
        );
        out(rows);
      } else out(await detectAutomated(db));
      break;
    }
    case "radar": {
      const { relationshipRadar, radarSummary } = await import("./graph/radar.js");
      if (args.length) {
        const e = await refOrDie(db, args.join(" "));
        const items = await relationshipRadar(db, e.id, { viewer });
        for (const i of items) i.name = (await getEntity(db, i.entity))?.canonical_name;
        out({ entity: e.canonical_name, radar: items });
      } else {
        const summary = await radarSummary(db, { viewer });
        for (const i of summary.needsAttention) {
          i.aName = (await getEntity(db, i.a))?.canonical_name;
          i.bName = (await getEntity(db, i.b))?.canonical_name;
        }
        out(summary);
      }
      break;
    }
    case "members": {
      const m = await import("./members.js");
      const sub = args[0];
      if (!sub) { out(await m.listMembers(db)); break; }
      if (sub === "add") {
        if (!args[1]) throw new Error("usage: fundgraph members add <name> [email]");
        out(await m.addMember(db, { name: args[1], email: args[2] }));
      } else if (sub === "remove") {
        if (!args[1]) throw new Error("usage: fundgraph members remove <member> [--reassign-shared]");
        const target = await m.resolveMember(db, args[1]);
        out(await m.removeMember(db, target.id, {
          reassign: args.includes("--reassign-shared") ? "shared" : null,
        }));
      } else throw new Error("usage: fundgraph members [add|remove] …");
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

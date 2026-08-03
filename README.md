# fundgraph

**Open-source agentic data layer for investment teams.** An entity-resolved knowledge graph over your fund's scattered data — emails, calendar, meeting notes, docs, CRM — exposed to Claude, ChatGPT, or Cursor through a single MCP endpoint.

Agents can't operate over 15M documents by guessing with vector search: they fetch the wrong things and don't know what exists. fundgraph gives them a deterministic **map of reality** instead — who exists, who knows whom, and how strongly — so retrieval is structured graph traversal, not similarity roulette.

```
systems of record          fundgraph                        agents
─────────────────    ──────────────────────────    ──────────────────────
gmail    ─┐          ┌─ metadata layer             Claude Code / Desktop
calendar ─┤  ingest  │  (what was ingested,        ChatGPT
drive    ─┼────────▶ │   when, who's mentioned)    Cursor
granola  ─┤          ├─ entity resolution             ▲
crm      ─┘          │  (blocking → candidates →      │ one MCP endpoint
                     │   matching → review)           │
                     └─ knowledge graph  ─────────────┘
                        (people + orgs, weighted edges,
                         warm-path traversal)
```

## Design principles

1. **Everything resolves to two entities: people and organizations.** Deals, funds, docs all hang off those two.
2. **Two-layer data model.** A metadata layer tracks what was ingested and who was mentioned; the knowledge graph holds resolved entities and weighted connections. The graph is a read model — rebuilt deterministically from source data, never hand-edited.
3. **Four-stage entity resolution:** blocking → candidate generation → probabilistic matching → human review. Deterministic auto-merge at ≥0.95 confidence; 0.70–0.95 goes to a review queue. Without this, one person appears as 100+ duplicates across sources.
4. **Never let an LLM score a relationship.** Connection strength is computed from observable signals — meeting frequency, email reciprocity, doc co-authorship, recency decay — because models will confidently hallucinate a 3/10 relationship as a 10/10.
5. **Graph-based retrieval, not pure vector.** "Who can intro me to X?" is a weighted shortest-path query, answered with the evidence behind each hop.

## Quickstart

Requires Node 20+. No database setup — uses embedded Postgres ([PGlite](https://pglite.dev)) under `./data/`; set `DATABASE_URL` to use real Postgres.

Embedded mode is **single-process** (a lockfile enforces this): stop the MCP server before running CLI ingests, or set `DATABASE_URL` to share a real Postgres between them.

```bash
npm install
node src/cli.js demo                          # ingest sample data, resolve, build edges

node src/cli.js entities "chen"               # search people and orgs
node src/cli.js brief "Maya Chen"             # pre-meeting brief
node src/cli.js path "Dana Whitfield" "Priya Nair"    # warm-intro path
node src/cli.js intros "Dana Whitfield" "Priya Nair"  # ranked introducers
node src/cli.js review                        # pending entity matches (0.70–0.95)
node src/cli.js review accept rev_xxxx        # confirm a match
```

## MCP

```bash
claude mcp add fundgraph -- node /path/to/fundgraph/src/cli.js mcp
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "fundgraph": { "command": "node", "args": ["/path/to/fundgraph/src/cli.js", "mcp"] }
  }
}
```

Tools exposed: `search_entities`, `entity_brief`, `find_warm_path`, `find_introducers`, `strongest_connections`, `graph_stats`, `review_queue`, `review_resolve`.

## Web dashboard

```bash
node src/cli.js web          # http://localhost:4321
```

Interactive network graph (strength-weighted, with signal receipts on hover),
entity briefs, warm-path finder with ranked introducers, the human review queue,
and drag-and-drop ingestion. See `DEMO.md` for a walkthrough.

## Ingesting your own data

| Source | Command | Setup needed |
|---|---|---|
| Gmail export (Takeout) | `fundgraph ingest export.mbox` | none |
| Calendar export | `fundgraph ingest calendar.ics` | none |
| CRM contacts (Attio/Affinity/any) | `fundgraph ingest contacts.csv` | none |
| Granola (macOS) | `fundgraph ingest-granola` | none — reads the local cache |
| Live Gmail/Calendar/Drive via [gog](https://github.com/steipete/gogcli) | `fundgraph ingest-gog gmail` | gog already authenticated (local, or remote via `FUNDGRAPH_GOG_SSH=user@host`) |
| Live Gmail/Calendar/Drive via Google APIs | `fundgraph ingest-google gmail` | a Desktop OAuth client JSON in `GOOGLE_OAUTH_CREDENTIALS` |

Then `fundgraph sync` (resolve + rebuild edges). Only metadata and participant
identities are read — message bodies, transcripts, and file contents are never
fetched or stored.

Adapters emit a common JSONL shape (see `sample/seed.jsonl`) — one document per line:

```json
{"source": "granola", "kind": "meeting", "external_id": "abc",
 "title": "Fund II kickoff", "occurred_at": "2026-07-02T10:00:00Z",
 "people": [{"name": "Maya Chen", "email": "maya@nordwind.vc", "org": "Nordwind Ventures", "role": "attendee"}],
 "orgs": ["Nordwind Ventures"]}
```

`kind` ∈ `email | meeting | event | doc | note | record`; person `role` ∈ `from | to | cc | attendee | author | mentioned`. Export from any source into that shape and run:

```bash
node src/cli.js ingest export.jsonl && node src/cli.js resolve && node src/cli.js edges
```

Ingestion is idempotent — re-ingesting a document replaces its mentions.

## How connection strength works

Each co-occurrence contributes `weight(kind) × decay(age)`: meetings 3, calendar events 2, direct emails 2.5 (cc'd 1), co-authored docs 1.5 — with a 180-day half-life, and merely-`mentioned` participants halved. Edge strength is `1 − e^(−W/6)`, saturating toward 1. Warm paths maximize the product of hop strengths (hop-bounded Dijkstra over `−ln(strength)`).

All weights are in `src/graph/edges.js` — tune them to your data.

## Status & roadmap

Working today: ingestion from mbox/ICS/CSV/Granola/JSONL plus live Gmail·Calendar·Drive (via gog or Google APIs), entity resolution + review queue, relationship graph, warm paths, web dashboard, MCP server, embedded or real Postgres.

Not yet built (PRs welcome):
- **Privacy layers** — per-user private sources contributing to shared answers without exposing underlying data ("a warm path exists via X" without X's emails)
- **LLM mention extraction** — pulling people/orgs out of unstructured doc bodies (current adapters use structured metadata only)
- **Merge/split tooling** — merging two entities discovered to be the same person, undo for bad merges, bulk review
- **Access control** — role-based visibility for multi-user teams
- **Scheduled sync** — periodic re-pull from live sources

## License

MIT

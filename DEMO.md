# Demo script (~7 minutes)

Setup: `npm start` → http://localhost:4321. On an empty database you get the
onboarding screen — "Load sample dataset" is itself a demo moment (data lands,
resolves, and the graph appears in one click).

## 1. The problem (30s)

"Fund data is scattered — email, calendar, meeting notes, CRM, docs. Agents can't
operate over it by guessing with vector search: they fetch the wrong things and
don't know what exists. fundgraph builds the **map of reality** they navigate:
every person and organization, resolved across sources, with relationship
strength computed from actual behavior."

## 2. The graph (1 min)

Open the dashboard. Point at the stat tiles, then the network: circle size =
number of connections, line weight = relationship strength. Hover an edge —
**the strength has receipts**: "3 meetings, 2 emails, 1 co-authored doc." Nothing
is LLM-guessed; models hallucinate relationship strength, so we compute it.

## 3. Warm paths (2 min)

Warm path tab → Dana Whitfield → Priya Nair. The path lights up:
Dana **→ 91%** Maya **→ 79%** Priya, with ranked introducers below (scored by
their *weaker* leg — an introducer is only as good as their weaker relationship).
This is the level-1 relationship-intelligence use case: right connection, right
context, pre-meeting brief one click away (click any node).

## 4. Entity resolution — "the magic" (2 min)

Review queue tab. "The same person appears 100+ different ways across sources —
`M. Chen` from a gmail address vs `Maya Chen` at Nordwind. Above 95% confidence
the system merges deterministically; between 70–95% **it asks a human** — never
merges on a guess." Click ✓ — the gmail alias merges into Maya, graph updates.

## 5. Live ingest (1.5 min)

Add-data tab. Drag `sample/sample.mbox` in — 3 emails ingest, resolve, and a new
node (Theo Marchetti) appears, correctly deduped across formats: `"Chen, Maya"`
reversed-name form, an RFC-2047-encoded name, a CSV contact — all land on the
right entities. Works the same with a Gmail Takeout mbox, a calendar .ics, or an
Attio CSV export.

## 5b. Connect the CRM live (1 min)

Data tab → *Attio workspace*. Paste an access token, hit **Connect & sync** —
the key is verified against Attio, then people, companies, and notes pull in
and resolve against what's already there. The point to make out loud: an Attio
contact and that same person's Gmail address collapse into **one** entity, so
the CRM's structure and the inbox's behavioural signal end up on the same node.
Attio can't do that on its own — it has no view of who actually emails whom.

## 6. Make it yours (45s)

Settings tab. "What counts as a strong relationship differs by firm — maybe
meetings matter 10x more than emails for you." Bump the meeting weight, hit
Save — the graph rebuilds live, edge weights visibly change. Every decision
is recorded in the audit trail (Data tab).

## 7. Agents on top (1 min)

"The same graph is one MCP endpoint" — in Claude:

> *Prep me for my meeting with Priya Nair. I'm Dana.*

Claude calls `meeting_prep` and gets, in one shot: her profile, relationship
history with receipts, recent shared documents, and Dana's warm paths and best
introducers to her — then writes the brief. Structured data from the graph,
prose from the model, nothing hallucinated.

## Live-data variant

A second database ingested from a real inbox via the gog adapter
(`FUNDGRAPH_DATA=./data/real node src/cli.js web 4322`) shows the same pipeline
on live Gmail — including the review queue catching a real display-name/address
ambiguity.

## Notes

- Embedded DB is single-process: stop the web server before starting the MCP
  server on the same data dir (or use `DATABASE_URL` Postgres to run both).
- Everything in the default demo dataset is fictional.

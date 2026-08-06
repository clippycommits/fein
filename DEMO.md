# Demo script (~7 minutes)

Setup: `npm start` → http://localhost:4321. On an empty database you get the
onboarding screen — "Load sample dataset" is itself a demo moment (data lands,
resolves, and the graph appears in one click). That one click seeds the whole
world below: the shared graph, the review queue, the two-member team (Tom +
Seb Larkin) and Seb's private layer. `sample/sample.mbox`, `sample.ics`, and
`contacts.csv` are deliberately left out — they're your live-drag ammunition
for step 5. Everything in this script happens in the browser.

## 1. The problem (30s)

"Fund data is scattered — email, calendar, meeting notes, CRM, docs. Agents can't
operate over it by guessing with vector search: they fetch the wrong things and
don't know what exists. fein builds the **map of reality** they navigate:
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

Reviews tab. "The same person appears 100+ different ways across sources —
`M. Chen` from a gmail address vs `Maya Chen` at Nordwind. Above 95% confidence
the system merges deterministically; between 70–95% **it asks a human** — never
merges on a guess." Click ✓ — the gmail alias merges into Maya, graph updates.

## 5. Live ingest (1.5 min)

Data tab. Drag `sample/sample.mbox` in — 3 emails ingest, resolve, and land on
the **right existing people**: `"Chen, Maya"` in reversed-name form, an
RFC-2047-encoded Elena Ruiz, Theo Marchetti writing from a different thread.
Watch the connection count tick up while the people count doesn't — that's the
pitch line: *"eight more documents, zero new duplicates."* Follow with
`sample.ics` and `contacts.csv` if you want the cross-format point (a calendar
attendee line and a `"Nair, Priya"` CSV row landing on the same entities).
Works the same with a Gmail Takeout mbox or an Attio CSV export.

## 5b. Connect the CRM live (1 min)

Data tab → *Attio workspace*. Paste an access token, hit **Connect & sync** —
the key is verified against Attio, then people, companies, and notes pull in
and resolve against what's already there. The point to make out loud: an Attio
contact and that same person's Gmail address collapse into **one** entity, so
the CRM's structure and the inbox's behavioural signal end up on the same node.
Attio can't do that on its own — it has no view of who actually emails whom.

## 5c. Privacy layers — the objection-killer (1.5 min)

This answers the question every partner asks: *"I'm not putting my inbox where
the whole team can read it."*

Data tab shows the team (seeded by the sample load — in your own install this
is **Uploads land in → member** on the dropzone). Seb's correspondence with
Priya is his **private layer**. Switch **Viewing as** to Tom, then ask for a
warm path from Tom Merrill to Priya Nair:

- Tom gets his own weak ~17% route through Dana, **plus** "Ask a colleague:
  Seb Larkin 🔒" — no strength, no documents, no titles
- Tom's brief on Priya says only *"2 documents withheld"*
- Switch **Viewing as** to Seb and rerun the same Tom → Priya query: the route
  through Seb now carries real numbers (38% × 54%) because his own evidence is
  visible to him. Ask Seb → Priya and it's a direct ~54% hop, both private
  emails listed in Priya's brief

Say the point out loud: **evidence is private, existence is shared.** You learn
that a route exists and who to ask — which is the entire value of a relationship
graph — without anyone handing over their inbox. (Then be honest about the
boundary: it's enforced server-side on every query, but it's a cooperative model
for one trusted team on one machine, not a hostile-tenant wall.)

## 5d. Radar — right person, right time (1 min)

Radar tab. "Strength tells you who you know. Radar tells you who to contact
*now*." Every pair's cadence is learned from real history, so *overdue* is
relative: "Priya ↔ Maya — last contact 16d ago, usually every 10d, **6d
overdue**." A quarterly contact silent for 40 days isn't flagged; a weekly one
is. This is the level Vicunea's own notes describe as future work.

## 6. Make it yours (45s)

Settings tab. "What counts as a strong relationship differs by firm — maybe
meetings matter 10x more than emails for you." Bump the meeting weight, hit
Save — the graph rebuilds live, edge weights visibly change. Every decision
is recorded in the audit trail (Data tab).

## 7. Agents on top (1 min)

"The same graph is one MCP endpoint — served by the dashboard you're looking
at." Show the Data tab's **Agents (MCP)** section, hit Copy, and (done once,
before the call) connect it:

```bash
claude mcp add --transport http fein http://localhost:4321/mcp
```

Then in Claude:

> *Prep me for my meeting with Priya Nair. I'm Dana.*

Claude calls `meeting_prep` and gets, in one shot: her profile, relationship
history with receipts, recent shared documents, and Dana's warm paths and best
introducers to her — then writes the brief. Structured data from the graph,
prose from the model, nothing hallucinated.

Optional privacy kicker: reconnect with `?as=Seb%20Larkin` on the URL and ask
the same about Priya — the agent now cites Seb's two private emails, exactly as
the Viewing-as switch did in the browser.

## Live-data variant

A second database ingested from a real inbox via the gog adapter
(`FEIN_DATA=./data/real node src/cli.js web 4322`) shows the same pipeline
on live Gmail — including the review queue catching a real display-name/address
ambiguity.

## Notes

- The dashboard serves MCP itself (`/mcp`), so the demo needs exactly one
  process. The single-process caveat only applies to the stdio flavor
  (`fein mcp`) or CLI ingests while the web server runs — use
  `DATABASE_URL` Postgres if you need several processes on one database.
- The **Extract pending documents** button calls the Anthropic API — export
  `ANTHROPIC_API_KEY` before `npm start` if you want to run it live on the
  call; everything else works without credentials.
- Everything in the default demo dataset is fictional.

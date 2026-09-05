# Changelog

## 0.6.0 — 2026-09-05

**The events release**: a firm that runs events has its relationship
history in guest lists, not inboxes. Fein now reads it.

### Added
- **Attio event lists**: every list whose name ends in a date (or is pinned
  with `ATTIO_EVENT_DATES`) is pulled entry by entry. Each contacted guest
  becomes a dated touch between the firm and that person, tiered by the
  list's own columns — attended (`event`), RSVP'd yes (`rsvp`), declined or
  invited (`invite`) — with the deciding attribute kept as the receipt. A
  past event's membership counts as invited; a future event's draft list
  produces nothing until invitations go out. `src/ingest/attio-events.js`
  is pure and tested offline against real Attio entry shapes.
- **Hosts and inviters**: `ATTIO_EVENT_HOST` is the firm-side person on
  every touch; `ATTIO_EVENT_HOST_MAP` routes "added by: Human - Joe" to Joe.
  A named "invited by" becomes a person on the touch (who brought whom); a
  partner in "added by" becomes an org mention.
- **Cohorts**: one `cohort` document per event for the people in the room
  (attended when tracked, else the yes-RSVPs of a past event). The
  participant cap decides which rooms produce pair-edges.
- **Signal weights** `rsvp`, `invite`, `cohort` (Settings).
- **Queries**: `listEvents`, `eventGuests`, `eventHistory`, `guestLeague`
  (most_attended, never_attended, most_invited, lapsed, best_show_rate) in
  `src/graph/events.js`; `/api/events`, `/api/events/<event>`,
  `/api/events/league`, `/api/entity/<id>/events`; MCP tools `list_events`,
  `event_guests`, `event_history`, `guest_league`; CLI `events`, `history`,
  `league`. `entity_brief` / `meeting_prep` carry an `events` block; the
  dashboard brief and its Markdown copy show it.

### Changed
- The Attio pull no longer caps people/companies at 5,000 — it pages
  through the workspace.

## 0.5.0 — 2026-08-08

**The hardening release**: the data layer grows up for shared firm
deployments — every read answers as the viewer, every write records its
actor, private evidence stays in its layer even through resolution, and the
graph stops doing O(everything) work on every click.

### Added
- **Audit actors**: every audit row records who did it — the member's name
  for humans (`?as=`/`--as`), `agent:<member>` for MCP callers, `local`
  otherwise. The dashboard's audit feed shows non-local actors.
- **Participant cap**: a document with more distinct resolved people than
  `maxDocParticipants` (Settings, default 50) contributes no pair-edges and
  no radar history — a 500-recipient mailing-list email no longer fans out
  into 124,750 edges. The document and mentions are kept, so changing the
  cap applies or undoes it on the next rebuild.
- **Bounded graph payloads**: `/api/graph` takes `?limit=` (default 300),
  `?focus=<id>` and `?radius=` for ego graphs, returns
  `totalNodes`/`totalLinks`/`truncated`, and the dashboard says
  "N of M people" when truncated. Bounding happens strictly after the
  privacy filters, so pruning inherits their guarantees.
- **Automated-sender override**: `fein automated mark/unmark`, a toggle on
  the dashboard entity brief, and `POST /api/entity/:id/automated` — human
  verdicts survive re-detection, merges, unmerges, and full rebuilds.
- **Scoring constants in Settings**: the resolution band (auto-merge 0.95 /
  review floor 0.70), radar overdue/cold ratios and dormancy window, the
  private-hop routing prior, and the participant cap are per-firm knobs
  now, editable from the dashboard.
- **Scheduled connector sync**: each connector card gets an auto-sync
  interval (off by default); the dashboard server re-pulls on schedule with
  failure backoff, records per-connector last-run status ("last synced 12
  minutes ago — 12 documents"), audits runs as actor `scheduler`, and
  shares one single-flight pipeline claim with extraction and manual syncs
  so runs never interleave. CLI: `fein sync <provider>` and
  `fein sync --status`.
- **Extraction budget, progress, and cancel**: "Extract" now runs one
  settings-sized batch (`extraction.batchSize`, default 25) instead of the
  whole corpus, shows an upfront approximate token/cost estimate
  (`GET /api/extract/estimate`), reports live progress while running, and
  can be cancelled between documents — partial results are kept, resolved,
  and audited with who cancelled. Explicit `limit` and CLI `--limit` still
  override the batch size.

### Changed
- **One viewer resolver**: every `?as=` (API reads, uploads, `/mcp`, stats)
  accepts a member id, exact name, or email — and unknown or ambiguous refs
  are a loud 400 listing candidates. `/api/*` reads used to silently answer
  from the shared layer on an unknown id; they no longer do.
- **Viewer-scoped stats**: `/api/stats` counts only what the viewer can
  open (documents, entities, reviews badge, edges), with a
  `withheldDocuments` hint. Mutation endpoints scope their stats the same
  way. The CLI gained `fein stats --as`.
- **Private-evidence absorption policy**: resolution no longer folds a
  private mention's email/org/alias into the shared entity record — the
  shared columns only ever hold shared-witnessed values (or explicit human
  merges). Privately-witnessed evidence lives in a per-layer overlay
  (`entity_evidence`) visible only to its owner; display names come only
  from shared witnesses. Matching stays global, so resolution quality is
  unchanged.
- **Incremental edge rebuilds**: review decisions, merges, and unmerges
  recompute only the edges touching the affected entities (all layers)
  instead of rewriting the whole table; ingest and settings changes keep
  the full rebuild. Inserts across ingest and edge writes are chunked
  multi-row statements now.

### Fixed
33 findings across two adversarial review passes over this release's own
changes (privacy, correctness, integration, and test-honesty lenses; every
finding independently verified before fixing) — the most serious, all
pinned by tests:
- A manual merge could lift a private-only entity's display name into the
  shared canonical name, and audit rows for overrides/merges echoed private
  names into the shared audit trail (ids only now).
- Human input (merges, automated overrides) against privately-evidenced
  entities was silently dropped by `fein reresolve`; replay now matches on
  the shared + private-evidence union.
- An entity first seen privately kept its private display name even after
  shared witnesses arrived (name now re-derives from the first shared
  witness); `removeMember --reassign-shared` deleted the only copy of the
  departed layer's evidence instead of promoting it.
- The incremental rebuild diverged from a full rebuild when an operation
  moved a document across the participant-cap boundary (falls back to a
  full rebuild there).
- The dashboard's Explore search and merge picker never sent `?as=`, so
  private-layer people were unfindable exactly for their owner.
- Scheduled syncs could interleave with a running extraction (duplicate
  entities from concurrent resolution) — one shared pipeline claim now;
  re-pasting a fresh API key resets a connector's failure backoff; the
  extraction estimate accounts for stale documents a run will re-extract.

### Upgrading
Existing databases carry evidence absorbed under the old policy in their
shared entity records. Fein detects this on boot and warns until you run
`fein reresolve` once, which rebuilds entities under the new policy and
replays your reviews, merges, and overrides. See DEPLOY.md.

## 0.4.0 — 2026-08-07

**The Fein release**: the product is now Fein (the fund graph for venture
capital); the engine remains open source in the same repo, and nothing breaks
for existing installs — `FUNDGRAPH_*` env vars, the `fundgraph` bin alias,
`~/.fundgraph`, and `./data/fundgraph` all keep working as legacy fallbacks.

### Added
- **Client deployments**: `docker compose up -d` is a production deploy —
  Dockerfile + compose (embedded volume, optional Postgres profile),
  `FEIN_AUTH_TOKEN` gating every surface (Bearer for agents, a one-time
  login page + HttpOnly cookie for browsers), `FEIN_HOST` binding that
  refuses to leave loopback without a token, and DEPLOY.md — the
  client-onboarding runbook (TLS, agents, backups, upgrades).
- **Affinity connector**: people, organizations, and note participants via
  the dashboard's Data tab or `fein ingest-affinity` (note bodies are never
  read). The connector layer is table-driven now — a third CRM is one module
  and one registry entry.
- **LinkedIn Connections.csv**: sniffed inside the generic CSV path, so
  dragging the export in just works — and "Connected On" becomes real timing
  signal for edge strength and the relationship radar.
- **ROADMAP.md**: prioritized next steps, seeded by the review below.

### Fixed
21 findings from a three-lens adversarial review (privacy, correctness,
tech debt) — the most serious:
- `company_memory` ignored its viewer: private deal snippets, document
  titles, and people leaked to any MCP agent (all three reviewers found it).
- A leaked/guessed entity id bypassed the hide policy via `/api/entity`, and
  `/api/graph` emitted links to hidden entities — which also crashed the
  dashboard graph for exactly the viewer being protected.
- Embedded-mode transactions had no mutual exclusion (hand-rolled
  begin/commit on a shared PGlite session): concurrent writes could
  interleave or discard each other. Now on PGlite's real transaction mutex.
- Re-ingesting a document silently moved it between privacy layers: the
  layer is now part of the document's identity.
- Warm-path private hops named private-only contacts; review decisions wrote
  private mention text into the shared audit trail; the owner's own agent
  couldn't find their private-only contacts (over-filtering). All fixed, and
  the leak probe now covers every one of these paths and fails loudly if
  auth would make it vacuous.
- Every write endpoint returned 403 behind a reverse proxy (the cross-origin
  guard assumed localhost); same-origin writes now work under any hostname.

## 0.3.0 — 2026-08-04

**The demo-in-one-process release**: everything the demo script needs happens
in the browser, and agents connect to the running dashboard.

### Added
- **MCP over HTTP**: the dashboard serves a Streamable-HTTP MCP endpoint at
  `/mcp` (stateless, one server per request), so the web UI and agents share
  one process and one live embedded database — no more stopping the dashboard
  to run `fundgraph mcp`. `?as=<member>` binds an agent to that member's
  private layer; unknown members are rejected, never silently downgraded to
  the shared view. The Data tab shows the endpoint with a copyable
  `claude mcp add` command.
- **Private-layer uploads from the UI**: an "Uploads land in" selector on the
  Data tab dropzone targets any member's private layer
  (`/api/ingest?as=<member>`). The shared audit trail records whose layer grew
  — never the private filename.
- **One-click demo world**: "Load sample dataset" now also seeds the
  two-member team (Tom + Seb Larkin) and Seb's private correspondence with
  Priya Nair, so the privacy-layers demo works on a fresh install. The loader
  is idempotent, shared with `fundgraph demo`, and deliberately leaves
  `sample.mbox` / `sample.ics` / `contacts.csv` out as live-drag demo files.
- Entity briefs in the UI show the withheld-documents count ("existence is
  shared, evidence is not" made visible).
- Tests: 64 API assertions including an MCP round-trip and viewer scoping;
  the leak probe now sweeps every MCP tool as the wrong viewer, plus an
  owner control against over-filtering.

## 0.2.0 — 2026-08-03

**The product release**: web dashboard, every adapter, customization, hardening.

### Added
- **Web dashboard** (`fundgraph web`): interactive relationship graph with
  signal receipts on hover, entity briefs with Markdown export, warm-path
  finder with ranked introducers, human review queue, drag-and-drop ingestion,
  source/audit views, first-run onboarding with a one-click sample dataset,
  light/dark themes.
- **Adapters for every source**: mbox (Gmail Takeout), ICS calendar, CSV
  contacts (Attio/Affinity/any), Granola local cache, live Gmail/Calendar/Drive
  via the gog CLI (local or over SSH), and via raw Google APIs with a built-in
  OAuth loopback flow. All read metadata and participants only — never bodies.
- **Customization**: relationship-scoring weights, recency half-life, and
  saturation are per-database settings, editable in the UI (Settings tab) or
  API; saving rebuilds the graph live.
- **Audit trail**: ingests, review decisions, settings changes, and rebuilds
  are recorded and visible in the Data tab.
- **MCP `meeting_prep` tool**: one call returns profile, relationship history
  with receipts, recent shared documents, and your warm paths to the person.
- **`fundgraph reresolve`**: rebuild all entities from raw documents; human
  review decisions are snapshotted and replayed, not lost.
- **API test suite** (`npm test`): 22 endpoint assertions on a throwaway
  database, plus the 38-assertion resolution smoke suite.

### Fixed (27 confirmed findings from three adversarial review passes)

**Third pass (pre-ship hardening):**
- A malformed request target (`//%ff`) crashed the whole server process; targets
  are now parsed defensively and rejected with 400, plus last-resort process
  handlers.
- Ingested document `kind` reached prototype-chain lookups, silently zeroing
  real relationships (`kind: "toString"`); own-property lookups and
  null-prototype accumulators throughout, and non-finite strengths now throw.
- The CSP blocked the app's own inline styles, so relationship strength bars
  rendered at zero width; widths are set via CSSOM.
- `reresolve` lost human decisions when a display name had been upgraded, and
  dropped chained decisions entirely; replay now matches on stable identity
  (emails/aliases), iterates to a fixpoint with deferred mentions, and runs in
  one transaction so a crash can't wipe review history.
- `mentionedFactor` was never applied to email documents.
- Client errors returned 500 with internal messages; now classified 400/404 with
  internal details logged, not returned.
- Frontend: zoom buttons no longer throw before first render, viewport survives
  rebuilds, GET failures surface as toasts instead of dead buttons, onboarding
  can't resurrect over 0-document upload feedback, settings weight validation
  rejects prototype names.
- Graph readability at real-data scale: a weak centring force keeps
  disconnected components together, fit-view trims positional outliers so a
  stray pair can't shrink the main cluster to a dot, and labels are budgeted to
  the best-connected nodes (hover or select reveals the rest).

**First two passes:**
- Resolution: exact-name merges are now conflict-gated (same-named strangers
  with different work domains/orgs queue for review instead of silently
  merging); a mention's email exempts it from the ambiguity guard only when
  exactly one entity holds that email; review-queue questions dedupe per
  identity; re-ingest keeps stable mention ids so review history survives;
  entities first seen as a bare address upgrade to their display name.
- Parsers: mbox postmark validation (body "From " lines no longer fabricate
  messages), RFC 2047 adjacent-word joining, RFC 5322 comments/groups/
  quoted-pairs in address lists, ICS VALARM properties no longer leak into
  events, Granola empty-string emails no longer collapse attendees.
- OAuth: denied consent rejects instead of hanging; expired tokens without a
  refresh token re-run consent; failed refresh falls back to consent.
- Web: cross-origin writes refused, CSP headers, `[hidden]` overlay fix.

## 0.1.0 — 2026-08-03

Initial release: two-layer data model (ingestion metadata + knowledge graph),
four-stage entity resolution with 0.95 auto-merge and human review queue,
deterministic connection scoring with recency decay, hop-bounded warm paths,
MCP server, embedded Postgres (PGlite) or DATABASE_URL.

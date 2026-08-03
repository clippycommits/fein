# Changelog

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

# Fein roadmap

What's next, in priority order. Shipped work moves to [CHANGELOG.md](CHANGELOG.md).
The near-term list is driven by what the first client deployments actually
need; most items came out of the 2026-08 three-lens review (privacy /
correctness / tech debt), which fixed 21 findings and deferred these.

## Deployment hardening (near term)

- **Audit actors** — the schema has an `actor` column, but every audit row
  says `local`. Now that a whole firm shares one token, record which member
  (or agent) ingested, merged, and changed settings.
- **Scale guards** — `/api/graph` returns the entire node/edge set and the
  browser force-layout eats it; edge rebuilds are full O(pairs) rewrites run
  after every review click; a single 500-recipient mailing-list email creates
  124k pair-edges. Bounded ego-graph payloads, batched inserts, a
  participant cap per document, incremental rebuilds.
- **Extraction budget + progress** — the dashboard's "Extract N documents"
  button currently runs unbounded with no cost estimate, no progress, and no
  cancel. Default batch size, an upfront token/cost estimate, and a
  poll/stream progress UI.
- **One viewer resolver** — `?as=` is resolved three different ways:
  `/api/*` reads silently fall back to the shared layer on an unknown id,
  `/mcp` and uploads hard-error, and the docs suggest names where only ids
  work. One resolver, always loud on unknown refs.
- **Viewer-scoped stats** — `/api/stats` counts are global, so the Reviews
  badge counts other members' private queues and the tiles include documents
  the viewer can't open. Scope them like every other read.
- **Private-evidence absorption policy** — entity resolution currently folds
  a private mention's email/org/alias into the *shared* entity record (an
  address seen only in a private mailbox becomes visible to every viewer).
  Decide the policy (likely: absorb only into viewer-visible provenance),
  implement, and state it in the privacy docs.
- **Automated-sender override** — detection exists and is careful about
  overrides, but nothing can *set* one: `fein automated mark/unmark` plus a
  toggle on the entity brief.
- **Scoring constants into settings** — resolution thresholds (0.95/0.7),
  radar cadence ratios and dormancy windows, and the private-hop strength are
  the per-firm knobs, and they're the only ones not in Settings yet.
- **Backup automation** — DEPLOY.md documents manual snapshots; ship a
  scheduled backup + a restore check.

## Connectors

- **Bodies from live pulls** — file exports capture bodies today; the
  Granola/gog/Google/Attio/Affinity live pulls are still metadata-only.
- **Scheduled sync** — periodic re-pull per connector (the ingest path is
  idempotent, so this is a scheduler + status surface).
- **Microsoft 365 / Outlook** — mail + calendar; the biggest unlock for
  non-Google funds.
- **HubSpot** — third CRM; the connector layer is table-driven now, so this
  is one module + one registry entry.
- **Slack export** — channel membership and DM metadata are relationship
  signal.
- **Notion / Airtable** — where a lot of small funds actually keep their
  deal flow.

## Product

- **Batch extraction** — large backfills through the Anthropic Batches API
  at 50% token cost.
- **Per-user login** — one shared token gates the deployment today, with
  per-member *view* scoping on top. Real multi-tenant isolation needs
  per-user sessions, and it unlocks honest audit actors.
- **Undo merge in the dashboard** — the CLI has `unmerge`; the UI offers
  merge with no way back.
- **Read-only brief links** — share a pre-meeting brief without handing out
  the dashboard token.

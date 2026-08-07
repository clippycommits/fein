# Fein roadmap

What's next, in priority order. Shipped work moves to [CHANGELOG.md](CHANGELOG.md).
The near-term list is driven by what the first client deployments actually
need. The 2026-08 hardening pass (v0.5.0) shipped the data-layer items:
audit actors, the one viewer resolver, viewer-scoped stats, scale guards
(participant cap, batched inserts, incremental rebuilds, bounded graph
payloads), the private-evidence absorption policy, automated-sender
overrides, scoring constants in Settings, scheduled connector sync, and
extraction budget/progress/cancel.

## Deployment hardening (near term)

- **Backup automation** — DEPLOY.md documents manual snapshots; ship a
  scheduled backup + a restore check.
- **Graph autocomplete at scale** — the warm-path datalist only suggests
  nodes in the bounded payload; typed exact names fall back to `/api/search`,
  but autocomplete should too.

## Connectors

- **Bodies from live pulls** — file exports capture bodies today; the
  Granola/gog/Google/Attio/Affinity live pulls are still metadata-only.
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
  per-user sessions — and it is what makes the recorded audit actors
  trustworthy rather than self-declared via `?as=`.
- **Undo merge in the dashboard** — the CLI has `unmerge`; the UI offers
  merge with no way back.
- **Read-only brief links** — share a pre-meeting brief without handing out
  the dashboard token.

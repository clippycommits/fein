# Contributing to fein

Thanks for helping build the fund graph. fein is a small, dependency-light
codebase with a deterministic core — most changes are readable in an afternoon.

## Local development

Requires **Node 20+**. There is no build step, no bundler, and no TypeScript
compile — it runs straight from `src/`.

```bash
npm install
npm start          # → http://localhost:4321
npm test
```

`npm start` boots the dashboard, which also serves the MCP endpoint at `/mcp`
out of the same process and the same live database. First run shows onboarding —
load the bundled fictional sample dataset with one click to get a full demo
world to poke at, no real data required.

Storage is embedded Postgres ([PGlite](https://pglite.dev)) under `./data/` by
default; nothing to install. Set `DATABASE_URL` to point at a real Postgres
instance instead (see the gotcha below for when you'll want to).

### The single-process gotcha

Embedded mode is **single-process** — a lockfile guards the data directory,
because two PGlite instances on the same directory silently diverge and can
corrupt it. Practically:

- **Stop the web server before running a CLI ingest, sync, or reresolve.** A
  running `npm start` holds the lock; a CLI command against the same `./data`
  will refuse to start (`data dir … is in use by pid N`).
- While the server is up, drive ingestion from the **Data tab** instead — it
  shares the one process.
- Or set `DATABASE_URL` to a real Postgres, which lifts the restriction and
  lets the server and CLI run at once. Tests do neither: each suite runs
  against a throwaway data dir via `FEIN_DATA`.

## Tests

`npm test` runs 13 suites in sequence (see the `test` script in
`package.json`). All run offline against throwaway databases — no API key,
no network, no real Postgres. Run one directly with node:

```bash
node scripts/smoke.js
node scripts/test-privacy.js
```

| Suite | Covers |
|---|---|
| `smoke.js` | end-to-end resolution smoke: ingest → resolve → edges → queries |
| `test-ingest-batch.js` | streamed/batched ingest (mbox, ics, csv), idempotent re-ingest, body capture |
| `api-test.js` | the dashboard HTTP API surface end to end |
| `test-extract.js` | extraction pipeline against a scripted fake model: grounding, idempotency, failure isolation, resolution integration, review-finding regressions |
| `test-privacy.js` | private-layer scoping: evidence-private / existence-shared, layered absorption, `?as=` binding |
| `test-radar.js` | relationship radar: learned cadence, statuses, trend, determinism |
| `test-automated.js` | automated-sender detection + human mark/unmark overrides surviving rebuilds |
| `test-merge.js` | manual merge/unmerge, tombstones, replay after reresolve |
| `test-leaks.js` | privacy leak probe — stuffs markers into a private layer and greps every endpoint's response as another member |
| `test-auth.js` | `FEIN_AUTH_TOKEN` gate on every surface, Bearer + cookie flavors, non-loopback bind refusal |
| `test-connectors.js` | LinkedIn Connections.csv adapter + Affinity mapping, offline fixtures |
| `test-edges-incremental.js` | incremental edge rebuild vs. full rebuild equivalence |
| `test-scheduler.js` | scheduled connector sync with an injected clock: due-time math, failure backoff, single-flight overlap guard |

The suites are plain node scripts — no framework. They print `ok`/`FAIL` lines
and exit non-zero on failure. Match that style: a new behavior wants a
regression test in the relevant suite (or a new one wired into the `test`
script), and adversarial-review findings are expected to land with coverage.

## Code conventions

Inferred from the source; keep changes in the same register.

- **ESM only** (`"type": "module"`). Use `import`, `node:`-prefixed built-ins
  (`node:fs`, `node:path`, `node:crypto`), and dynamic `import()` for optional
  heavy deps (`pg`, `@electric-sql/pglite`) so they load only on the path that
  needs them.
- **The graph is a read model.** The metadata layer records what was ingested;
  the knowledge graph is rebuilt deterministically and never hand-edited. Keep
  resolution and scoring in `src/resolve/` and `src/graph/` pure and
  deterministic — no clocks or randomness leaking into scores (inject a clock,
  like `test-scheduler.js` does).
- **Never let an LLM score a relationship.** Strength is computed from
  observable signals. The extractor may only propose typed, text-grounded
  mention candidates that flow through the same resolution/review pipeline as
  structured mentions.
- **Fail closed on privacy and auth.** Enforcement is server-side on every
  query. If you touch a read path, assume a `test-leaks.js` probe is watching.
- Small arrow helpers, terse comments that explain **why** (the tricky
  invariant), not what. Two-space indent, double quotes, semicolons.
- Config reads go through `env()` in `src/brand.js` so the legacy
  `FUNDGRAPH_*` names keep working alongside `FEIN_*`.
- MCP tool inputs are validated with `zod`.

## Pull requests

- One focused change per PR. Describe the behavior change and why.
- `npm test` must pass, and new behavior ships with a test.
- **Preserve backward compatibility**: the `fundgraph` CLI alias, `FUNDGRAPH_*`
  env vars, and existing `./data` directories must keep working. Data written
  by older versions must still open (add a migration step if the shape
  changes).
- Update the docs that describe what you changed — `README.md`, `DEPLOY.md`,
  `CHANGELOG.md`, or files under `docs/` — in the same PR.
- Match the surrounding voice: terse, technical, confident.

MIT licensed; by contributing you agree your work ships under the same license.

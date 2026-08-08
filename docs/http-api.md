# fein HTTP API (`/api/v1`)

A versioned, documented HTTP projection of the fund graph — the same data, the
same privacy scoping, and the same process as the dashboard and the [MCP
endpoint](../README.md#mcp--agents-on-the-graph). Use it when an integration
speaks plain HTTP rather than MCP: a webhook, a scheduled job, a CRM sync, a
CI script.

- **Machine spec:** `GET /api/v1/openapi.json` (OpenAPI 3.1).
- **Browsable docs:** open `/docs` in the dashboard.
- **Stability:** everything under `/api/v1` is a versioned contract. Breaking
  changes ship as `/api/v2`. The undocumented dashboard `/api/*` endpoints are
  *not* a contract — use `/api/v1`.

## Base URL

Whatever host the dashboard runs on, for example `http://localhost:4321`. All
paths below are relative to that.

## Authentication

The deployment token gates everything except `/api/v1/health` and
`/api/v1/version`. Send it as a bearer token (agents, scripts) or rely on the
browser cookie set at `/login` (the docs page):

```bash
curl -H "Authorization: Bearer $FEIN_AUTH_TOKEN" \
  "http://localhost:4321/api/v1/stats"
```

A missing or wrong token is `401` `problem+json`. If the deployment runs with no
`FEIN_AUTH_TOKEN` (loopback only), auth is off and the header is ignored.

## Private layers — `?as=<member>`

Append `?as=<member>` (a member id, exact name, or email) to any request to bind
it to that member's private layer, exactly as on MCP. Evidence from that layer is
summed into the answer; evidence from *other* members' private layers is never
revealed, only its existence (a warm-path hop through a colleague comes back as
`(private contact)` with no id). An unknown or ambiguous `?as=` ref is a hard
`400` (`type: unknown-viewer`) — the API never silently answers from the shared
layer. With no `?as=`, a request sees the shared layer only.

`?as=` is provenance, not authentication: under the single shared token any
caller may assume any member's layer. Real per-user isolation is on the roadmap.

## Response envelopes

- **A single resource, composite, or singleton** is returned as a **bare
  object** — the same shape the MCP tools return (`entities/{id}`, `resolve`,
  `paths`, `meeting-prep`, `companies/{ref}/memory`, `stats`, `radar/{id}`).
- **A collection** is wrapped thinly so pagination has somewhere to live:

  ```jsonc
  { "data": [ /* items */ ], "page": { "next_cursor": "…"|null, "has_more": false } }
  ```

Conditional fields are **omitted when absent**, never sent as `null`
(`deals`, `withheldDocuments`, `viaPrivate`, `privatePath`, memory `note`).

## Errors — `problem+json`

Every error is `application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)):

```jsonc
{
  "type":   "https://fein.vc/probs/ambiguous-ref",
  "title":  "Ambiguous reference",
  "status": 409,
  "detail": "ambiguous ref \"chen\"",
  "error":  "ambiguous ref \"chen\"",   // legacy alias == detail
  "instance": "/api/v1/resolve?ref=chen",
  "candidates": [ /* only on 409 */ ]
}
```

Branch on the stable `type` slug, not the English `detail`. The full set:
`bad-request`, `validation`, `unauthorized`, `forbidden`, `not-found`,
`entity-not-found`, `review-not-found`, `ambiguous-ref`, `unknown-viewer`,
`payload-too-large`, `method-not-allowed`, `conflict`, `internal-error`.
A `5xx` never leaks an internal message — `detail` is always `"internal error"`.

## Pagination

List endpoints take `?limit=` (clamped to `1..200`) and an opaque `?cursor=`.
Read the first page, then pass the returned `page.next_cursor` back as `?cursor=`
until `has_more` is `false`. A cursor carries only position, never scope, so it
is safe to store — but always re-send your `?as=`/token; a cursor minted under
one viewer returns only that viewer's rows.

`GET /api/v1/entities/export.ndjson` and the offset-paginated feeds
(`connections`, `reviews`, `radar`) are **best-effort snapshots**, not
point-in-time transactions: an entity merging mid-crawl can be skipped or its
survivor repeated. Warehousing jobs should tolerate that or run against a quiet
instance.

## Caching

`GET` reads carry an `ETag`; send it back as `If-None-Match` to get a `304` when
nothing changed. The tag incorporates the request path and query (including
`?as=`), so a scoped body never revalidates across layers.

---

## Endpoints

### Meta

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/health` | Open. `{ ok, version, uptimeSeconds }`. |
| GET | `/api/v1/version` | Open. `{ version, apiVersion, started }`. |
| GET | `/api/v1/openapi.json` | The OpenAPI 3.1 document. |

### Search & entities

**`GET /api/v1/search`** — fuzzy search over people and organizations.
Params: `q`, `limit` (default 20), `cursor`. Returns `{ data: [entity], page }`.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/search?q=halcyon&limit=5"
```

**`GET /api/v1/entities`** — list entities, or resolve one.
Without `ref`: a keyset-paginated list (`q`, `limit` default 50, `cursor`).
With `?ref=<id|email|name>`: resolves the ref and returns that entity's brief in
one hop (`404` if unresolved, `409` with `candidates` if ambiguous).

**`GET /api/v1/entities/{id}`** — the full brief for a canonical id: profile,
strongest connections (with the signals behind each), recent shared documents,
`deals` for an org, and a `withheldDocuments` count when another layer holds
more. A hidden or unknown id is `404` (an id is a lookup key — the API never
echoes a hidden name).

**`GET /api/v1/resolve`** — resolve `?ref=` to exactly one entity.
`{ entity }`, or `404`, or `409` with `candidates`.

**`POST /api/v1/batch/resolve`** — CRM enrichment: resolve up to 100 refs.
Body `{ "refs": ["a@x.com", "Maya Chen", …] }`. Returns
`{ data: [{ ref, entity }|{ ref, error, candidates? }] }`.

**`POST /api/v1/batch/briefs`** — briefs for up to 50 ids. Body `{ "ids": [...] }`.
Returns `{ data: [{ id, brief|null }] }` (`null` where invisible/absent).

**`GET /api/v1/entities/export.ndjson`** — stream every viewer-visible entity,
one JSON object per line. Params: `q`, `kind` (`person`|`org`). For full crawls
and warehousing.

### Relationships, paths & introducers

**`GET /api/v1/entities/{id}/connections`** — strongest relationships with their
signals. Params: `limit` (default 10), `cursor`. `404` on a hidden id.

**`GET /api/v1/paths`** — the best warm-intro path. Required `from`, `to`
(entity ids); `max_hops` (default 4, max 6). Bare result: `null`, or
`{ path, pathStrength }`, plus `privatePath` when a colleague's private layer
offers a shorter route (with whom to ask, no strengths).

**`GET /api/v1/introducers`** — rank mutual connections who could introduce
`from` to `to`, scored by the weaker leg. Params: `from`, `to`, `limit`
(default 5). Returns `{ data: [...], viaPrivate? }`.

**`GET /api/v1/meeting-prep`** — one bundle for prepping a meeting.
Required `with` (id/email/name); optional `from` (defaults to the `?as=` member).
Returns `{ entity, brief, warmPath, introducers, viaPrivate? }`.

### Timing (radar)

**`GET /api/v1/radar`** — the whole graph's timing view: who needs attention now,
judged against each pair's own learned cadence. Params: `limit` (default 20),
`automated` (`1` to include robots), `cursor`. Returns
`{ counts, needsAttention: { data, page }, pairs }`.

**`GET /api/v1/radar/{id}`** — one person's radar. Params: `limit` (default 25),
`automated`. Returns `{ entity, data }`. `404` on a hidden id.

### Institutional memory & stats

**`GET /api/v1/companies/{ref}/memory`** — every recorded deal signal for a
company (investments and passes, with the stated reasoning and provenance), plus
the resolved org, affiliated people, and related documents. Answers "have we seen
this company before, and why did we say no?". Works even for a company the graph
has not resolved yet (answers from its deal rows).

**`GET /api/v1/stats`** — viewer-scoped counts of documents, mentions, entities,
pending reviews, edges, and pending extraction.

### Review queue

**`GET /api/v1/reviews`** — pending entity-resolution matches that need a human.
Params: `limit` (default 50), `cursor`, `include=count` (adds `page.total`).

**`POST /api/v1/reviews/{id}/decision`** — resolve one match. Body
`{ "decision": "accept" | "reject" }` (`accept` = same person, `reject` =
different). Rebuilds the edges the decision touched and returns
`{ reviewId, decision, entity }`. Attributed to the `?as=` member in the audit
log. `404` (`type: review-not-found`) if the id is not a pending review.

---

## A worked example: enrich a contact and prep the meeting

```bash
BASE=http://localhost:4321
AUTH="Authorization: Bearer $FEIN_AUTH_TOKEN"

# 1. You have an email from your calendar. Who is this, in our graph?
curl -sH "$AUTH" "$BASE/api/v1/entities?ref=maya@northgate.io"

# 2. Prep the meeting: brief + your warm paths + best introducers.
curl -sH "$AUTH" "$BASE/api/v1/meeting-prep?with=maya@northgate.io&as=Alex%20Rivera"

# 3. Have we looked at her company before?
curl -sH "$AUTH" "$BASE/api/v1/companies/northgate/memory"
```

## Not in v1

No outbound webhooks or event streams — every "push" workflow is a poll against
these endpoints on your own schedule. An event bus is a candidate for a future
version. See [ROADMAP.md](../ROADMAP.md).

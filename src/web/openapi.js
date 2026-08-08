import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
).version;

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (t) => ({ type: [t, "null"] });

// Every error uses the same Problem body; wire it to the fixed status set.
const problemResponse = (desc) => ({
  description: desc,
  content: { "application/problem+json": { schema: ref("Problem") } },
});
const ERRORS = {
  400: problemResponse("Bad request / validation / unknown viewer"),
  401: problemResponse("Missing or invalid token"),
  404: problemResponse("Not found"),
  409: problemResponse("Ambiguous reference"),
  413: problemResponse("Payload too large"),
  405: problemResponse("Method not allowed"),
};
const errs = (...codes) => Object.fromEntries(codes.map((c) => [String(c), ERRORS[c]]));

// Collection body = allOf[Page, {data:[items]}] — Page defined once.
const collection = (items) => ({
  allOf: [ref("Page"), { type: "object", required: ["data"], properties: { data: { type: "array", items } } }],
});
const jsonBody = (schema, description = "Success") => ({
  description,
  content: { "application/json": { schema } },
});

const asParam = {
  name: "as", in: "query", required: false,
  description: "Layer selector: an id, exact name, or email of a team member. Unknown ref → 400. Provenance, not authentication (see info.description).",
  schema: { type: "string" },
};
const limitParam = (dflt, max = 200) => ({
  name: "limit", in: "query", required: false,
  description: `Page size (default ${dflt}, clamped to 1–${max}).`,
  schema: { type: "integer", default: dflt, minimum: 1, maximum: max },
});
const cursorParam = {
  name: "cursor", in: "query", required: false,
  description: "Opaque pagination cursor from a previous page's next_cursor. Malformed → 400.",
  schema: { type: "string" },
};
const qParam = {
  name: "q", in: "query", required: false,
  description: "Substring match over name, email, and org.",
  schema: { type: "string", maxLength: 200 },
};
const pathId = { name: "id", in: "path", required: true, schema: { type: "string" } };

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "fein HTTP API",
    version: VERSION,
    description:
      "A stable, versioned HTTP projection of the fein relationship graph — the same entity-resolved graph, viewer scoping, and privacy layers as MCP and the dashboard, over plain HTTP.\n\n" +
      "**Auth.** A single bearer token (`Authorization: Bearer <FEIN_AUTH_TOKEN>`, or the `fein_auth` session cookie) gates everything except `/health` and `/version`.\n\n" +
      "**`?as=` is provenance, not authentication.** Under the shared token any caller may assume any member's layer; layer isolation is advisory until per-member login lands. Do not treat `?as=` as a security boundary.\n\n" +
      "**Errors** are RFC 9457 `application/problem+json`, each carrying a legacy `error` alias equal to `detail`. **Pagination** is opaque-cursor with a hard cap. **No webhooks** in v1 — poll on your own schedule.",
  },
  servers: [{ url: "/", description: "This instance" }],
  tags: [
    { name: "Meta", description: "Health, version, and the spec itself." },
    { name: "Entities", description: "Search, briefs, resolve, batch, export." },
    { name: "Graph", description: "Connections, warm paths, introducers, meeting prep." },
    { name: "Radar", description: "Relationship timing." },
    { name: "Memory", description: "Institutional company memory and graph stats." },
    { name: "Reviews", description: "The entity-resolution review queue." },
  ],
  paths: {
    "/api/v1/health": {
      get: {
        operationId: "health", tags: ["Meta"], summary: "Liveness, version, and uptime.", security: [],
        responses: { 200: jsonBody(ref("Health")) },
      },
    },
    "/api/v1/version": {
      get: {
        operationId: "version", tags: ["Meta"], summary: "Version and build info.", security: [],
        responses: { 200: jsonBody(ref("Version")) },
      },
    },
    "/api/v1/openapi.json": {
      get: {
        operationId: "openapi", tags: ["Meta"], summary: "This OpenAPI 3.1 document.",
        responses: { 200: jsonBody({ type: "object" }), ...errs(401) },
      },
    },
    "/api/v1/search": {
      get: {
        operationId: "search", tags: ["Entities"], summary: "Fuzzy entity search, viewer-scoped.",
        parameters: [qParam, limitParam(20), cursorParam, asParam],
        responses: { 200: jsonBody(collection(ref("Entity"))), ...errs(400, 401) },
      },
    },
    "/api/v1/entities/export.ndjson": {
      get: {
        operationId: "exportNdjson", tags: ["Entities"],
        summary: "Streaming NDJSON crawl of viewer-visible entities (best-effort snapshot).",
        parameters: [qParam, { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["person", "org"] } }, asParam],
        responses: {
          200: { description: "One entity JSON per line.", content: { "application/x-ndjson": { schema: ref("Entity") } } },
          ...errs(400, 401),
        },
      },
    },
    "/api/v1/entities/{id}/connections": {
      get: {
        operationId: "connections", tags: ["Graph"], summary: "An entity's strongest connections.",
        parameters: [pathId, limitParam(10), cursorParam, asParam],
        responses: { 200: jsonBody(collection(ref("Connection"))), ...errs(400, 401, 404) },
      },
    },
    "/api/v1/entities/{id}": {
      get: {
        operationId: "entityBrief", tags: ["Entities"], summary: "Full brief by canonical id.",
        parameters: [pathId, asParam],
        responses: { 200: jsonBody(ref("Brief")), ...errs(400, 401, 404) },
      },
    },
    "/api/v1/entities": {
      get: {
        operationId: "entities", tags: ["Entities"],
        summary: "List entities (keyset), or — with ?ref= — resolve+brief in one hop.",
        parameters: [
          qParam, limitParam(50), cursorParam,
          { name: "ref", in: "query", required: false, description: "id, email, or name; returns a bare brief.", schema: { type: "string" } },
          asParam,
        ],
        responses: { 200: jsonBody({ oneOf: [collection(ref("Entity")), ref("Brief")] }), ...errs(400, 401, 404, 409) },
      },
    },
    "/api/v1/resolve": {
      get: {
        operationId: "resolve", tags: ["Entities"], summary: "Resolve a ref to one entity.",
        parameters: [{ name: "ref", in: "query", required: true, schema: { type: "string" } }, asParam],
        responses: { 200: jsonBody({ type: "object", properties: { entity: ref("Entity") } }), ...errs(400, 401, 404, 409) },
      },
    },
    "/api/v1/batch/resolve": {
      post: {
        operationId: "batchResolve", tags: ["Entities"], summary: "Resolve many refs (CRM enrichment).",
        parameters: [asParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["refs"], properties: { refs: { type: "array", items: { type: "string" }, maxItems: 100 } } } } } },
        responses: {
          200: jsonBody({ type: "object", required: ["data"], properties: { data: { type: "array", items: { type: "object" } } } }),
          ...errs(400, 401, 413),
        },
      },
    },
    "/api/v1/batch/briefs": {
      post: {
        operationId: "batchBriefs", tags: ["Entities"], summary: "Briefs for many ids (null when invisible/missing).",
        parameters: [asParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" }, maxItems: 50 } } } } } },
        responses: {
          200: jsonBody({ type: "object", required: ["data"], properties: { data: { type: "array", items: { type: "object", properties: { id: { type: "string" }, brief: { anyOf: [ref("Brief"), { type: "null" }] } } } } } }),
          ...errs(400, 401, 413),
        },
      },
    },
    "/api/v1/paths": {
      get: {
        operationId: "paths", tags: ["Graph"], summary: "Best warm-intro path (polymorphic union; null when none).",
        parameters: [
          { name: "from", in: "query", required: true, schema: { type: "string" } },
          { name: "to", in: "query", required: true, schema: { type: "string" } },
          { name: "max_hops", in: "query", required: false, schema: { type: "integer", default: 4, minimum: 1, maximum: 6 } },
          asParam,
        ],
        responses: { 200: jsonBody(ref("PathResult")), ...errs(400, 401) },
      },
    },
    "/api/v1/introducers": {
      get: {
        operationId: "introducers", tags: ["Graph"], summary: "Ranked mutual introducers (union normalized to {data, viaPrivate?}).",
        parameters: [
          { name: "from", in: "query", required: true, schema: { type: "string" } },
          { name: "to", in: "query", required: true, schema: { type: "string" } },
          limitParam(5, 50), asParam,
        ],
        responses: { 200: jsonBody(ref("Introducers")), ...errs(400, 401) },
      },
    },
    "/api/v1/meeting-prep": {
      get: {
        operationId: "meetingPrep", tags: ["Graph"], summary: "Composite brief + warm path + introducers.",
        parameters: [
          { name: "with", in: "query", required: true, description: "id/email/name of the person to prep for.", schema: { type: "string" } },
          { name: "from", in: "query", required: false, description: "Defaults to the ?as= member.", schema: { type: "string" } },
          asParam,
        ],
        responses: { 200: jsonBody(ref("MeetingPrep")), ...errs(400, 401, 404, 409) },
      },
    },
    "/api/v1/radar/{id}": {
      get: {
        operationId: "radarEntity", tags: ["Radar"], summary: "One entity's relationship timing.",
        parameters: [pathId, limitParam(25), { name: "automated", in: "query", required: false, schema: { type: "string", enum: ["0", "1"] } }, asParam],
        responses: { 200: jsonBody(ref("RadarEntity")), ...errs(400, 401, 404) },
      },
    },
    "/api/v1/radar": {
      get: {
        operationId: "radar", tags: ["Radar"], summary: "Whole-graph radar summary (needsAttention paginates).",
        parameters: [limitParam(20), { name: "automated", in: "query", required: false, schema: { type: "string", enum: ["0", "1"] } }, cursorParam, asParam],
        responses: { 200: jsonBody(ref("RadarSummary")), ...errs(400, 401) },
      },
    },
    "/api/v1/companies/{ref}/memory": {
      get: {
        operationId: "companyMemory", tags: ["Memory"], summary: "Institutional memory for a company.",
        parameters: [{ name: "ref", in: "path", required: true, schema: { type: "string" } }, asParam],
        responses: { 200: jsonBody(ref("CompanyMemory")), ...errs(400, 401) },
      },
    },
    "/api/v1/stats": {
      get: {
        operationId: "stats", tags: ["Memory"], summary: "Viewer-scoped graph counts.",
        parameters: [asParam],
        responses: { 200: jsonBody(ref("Stats")), ...errs(400, 401) },
      },
    },
    "/api/v1/reviews": {
      get: {
        operationId: "reviews", tags: ["Reviews"], summary: "Pending entity-resolution queue.",
        parameters: [limitParam(50), cursorParam, { name: "include", in: "query", required: false, schema: { type: "string", enum: ["count"] } }, asParam],
        responses: { 200: jsonBody(collection(ref("Review"))), ...errs(400, 401) },
      },
    },
    "/api/v1/reviews/{id}/decision": {
      post: {
        operationId: "reviewDecision", tags: ["Reviews"], summary: "Accept or reject one pending match.",
        parameters: [pathId, asParam],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["accept", "reject"] }, reason: { type: "string" } } } } } },
        responses: {
          200: jsonBody({ type: "object", properties: { reviewId: { type: "string" }, decision: { type: "string" }, entity: { type: "string" } } }),
          ...errs(400, 401, 404),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
      cookie: { type: "apiKey", in: "cookie", name: "fein_auth" },
    },
    schemas: {
      Problem: {
        type: "object",
        required: ["type", "title", "status", "detail", "error"],
        properties: {
          type: { type: "string", description: "Stable, machine-readable problem type URI." },
          title: { type: "string" },
          status: { type: "integer" },
          detail: { type: "string" },
          error: { type: "string", description: "Legacy alias == detail; removed at v2." },
          instance: { type: "string" },
          candidates: { type: "array", items: { type: "object" }, description: "Present only on 409 ambiguous." },
        },
        additionalProperties: true,
      },
      Page: {
        type: "object",
        required: ["page"],
        properties: {
          page: {
            type: "object",
            required: ["next_cursor", "has_more"],
            properties: {
              next_cursor: nullable("string"),
              has_more: { type: "boolean" },
              total: { type: "integer", description: "Only when ?include=count (reviews)." },
            },
          },
        },
      },
      Entity: {
        type: "object",
        required: ["id", "kind", "canonical_name"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["person", "org"] },
          canonical_name: { type: "string" },
          emails: { type: "array", items: { type: "string" } },
          orgs: { type: "array", items: { type: "string" } },
          aliases: { type: "array", items: { type: "string" } },
        },
      },
      Connection: {
        type: "object",
        properties: {
          entity: { type: "string" },
          name: { type: "string" },
          strength: { type: "number" },
          signals: { type: "object", additionalProperties: { type: "number" } },
          last_seen: nullable("string"),
        },
      },
      Document: {
        type: "object",
        properties: {
          id: { type: "string" }, source: { type: "string" }, kind: { type: "string" },
          title: nullable("string"), occurred_at: nullable("string"),
        },
      },
      Brief: {
        type: "object",
        required: ["entity", "connections", "recentDocuments"],
        properties: {
          entity: ref("Entity"),
          connections: { type: "array", items: ref("Connection") },
          recentDocuments: { type: "array", items: ref("Document") },
          deals: { type: "array", items: { type: "object" }, description: "Orgs only; omitted when absent." },
          withheldDocuments: { type: "integer", description: "Count of docs in layers the viewer can't see; omitted when zero." },
        },
      },
      PathStep: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Withheld on a redacted private hop." },
          name: { type: "string" },
          viaStrength: nullable("number"),
          private: { type: "boolean" },
          via: { type: "string" },
          redacted: { type: "boolean" },
        },
      },
      PathResult: {
        type: ["object", "null"],
        properties: {
          path: { anyOf: [{ type: "array", items: ref("PathStep") }, { type: "null" }] },
          pathStrength: nullable("number"),
          privatePath: {
            type: "object",
            properties: {
              path: { type: "array", items: ref("PathStep") },
              owners: { type: "array", items: { type: "string" } },
              note: { type: "string" },
            },
          },
        },
      },
      Introducer: {
        type: "object",
        properties: {
          entity: { type: "string" }, name: { type: "string" },
          strengthToYou: { type: "number" }, strengthToTarget: { type: "number" }, score: { type: "number" },
        },
      },
      Introducers: {
        type: "object",
        required: ["data"],
        properties: {
          data: { type: "array", items: ref("Introducer") },
          viaPrivate: {
            type: "array",
            description: "Present only when a colleague's private layer reaches the target.",
            items: { type: "object", properties: { owner: { type: "string" }, private: { type: "boolean" }, note: { type: "string" } } },
          },
        },
      },
      MeetingPrep: {
        type: "object",
        required: ["entity", "brief"],
        properties: {
          entity: ref("Entity"),
          brief: ref("Brief"),
          warmPath: ref("PathResult"),
          introducers: { type: "array", items: ref("Introducer") },
          viaPrivate: { type: "array", items: { type: "object" } },
        },
      },
      RadarItem: {
        type: "object",
        properties: {
          entity: { type: "string" }, name: { type: "string" },
          status: { type: "string", enum: ["active", "due", "overdue", "cold", "dormant", "new"] },
          contacts: { type: "integer" },
          daysSinceContact: nullable("integer"),
          cadenceDays: nullable("number"),
          overdueBy: nullable("integer"),
          trend: nullable("string"),
        },
      },
      RadarEntity: {
        type: "object",
        required: ["entity", "data"],
        properties: { entity: { type: "string" }, data: { type: "array", items: ref("RadarItem") } },
      },
      RadarSummary: {
        type: "object",
        required: ["counts", "needsAttention", "pairs"],
        properties: {
          counts: { type: "object", additionalProperties: { type: "integer" } },
          needsAttention: collection({ allOf: [ref("RadarItem"), { type: "object", properties: { a: { type: "string" }, b: { type: "string" }, aName: { type: "string" }, bName: { type: "string" } } }] }),
          pairs: { type: "integer" },
        },
      },
      CompanyMemory: {
        type: "object",
        required: ["company", "entity", "deals", "documents", "people"],
        properties: {
          company: { type: "string" },
          entity: { anyOf: [ref("Entity"), { type: "null" }] },
          deals: { type: "array", items: { type: "object" } },
          documents: { type: "array", items: ref("Document") },
          people: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, emails: { type: "array", items: { type: "string" } } } } },
          note: { type: "string", description: "Present only when there are no recorded deal signals." },
        },
      },
      Stats: {
        type: "object",
        required: ["documents", "mentions", "unresolvedMentions", "entities", "pendingReviews", "edges", "pendingExtraction"],
        properties: {
          documents: { type: "integer" }, mentions: { type: "integer" },
          unresolvedMentions: { type: "integer" }, entities: { type: "integer" },
          pendingReviews: { type: "integer" }, edges: { type: "integer" },
          withheldDocuments: { type: "integer", description: "Omitted when zero." },
          pendingExtraction: { type: "integer" },
        },
      },
      Review: {
        type: "object",
        properties: {
          id: { type: "string" }, score: { type: "number" }, status: { type: "string" },
          detail: {}, mention_name: nullable("string"), mention_email: nullable("string"),
          candidate_name: { type: "string" }, candidate_id: { type: "string" },
          doc_title: nullable("string"), doc_source: { type: "string" },
        },
      },
      Health: {
        type: "object",
        required: ["ok", "version", "uptimeSeconds"],
        properties: { ok: { type: "boolean" }, version: { type: "string" }, uptimeSeconds: { type: "integer" } },
      },
      Version: {
        type: "object",
        required: ["version", "apiVersion", "started"],
        properties: { version: { type: "string" }, apiVersion: { type: "string" }, started: { type: "string" } },
      },
    },
  },
  security: [{ bearer: [] }, { cookie: [] }],
};

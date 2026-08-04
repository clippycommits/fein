-- Layer 1: metadata — what was ingested, when, and who was mentioned.
create table if not exists documents (
  id          text primary key,
  source      text not null,          -- gmail | calendar | drive | granola | crm | local
  kind        text not null,          -- email | meeting | event | doc | note | record
  external_id text,
  title       text,
  occurred_at timestamptz,
  ingested_at timestamptz not null default now(),
  raw         jsonb
);

create table if not exists mentions (
  id          text primary key,
  document_id text not null references documents(id) on delete cascade,
  kind        text not null,          -- person | org
  name        text,
  email       text,
  org_hint    text,
  role        text,                   -- from | to | cc | attendee | author | mentioned
  norm_name   text,
  norm_email  text,
  entity_id   text                    -- null until resolved
);

-- Layer 2: the knowledge graph — everything resolves to people and organizations.
create table if not exists entities (
  id             text primary key,
  kind           text not null,       -- person | org
  canonical_name text not null,
  emails         jsonb not null default '[]',
  orgs           jsonb not null default '[]',
  aliases        jsonb not null default '[]',  -- normalized name forms seen for this entity
  merged_into    text,
  created_at     timestamptz not null default now()
);
alter table entities add column if not exists aliases jsonb not null default '[]';
-- Automated senders (no-reply robots, notification services, mailing lists) are
-- flagged, never deleted: they are hidden from relationship views by default.
-- `automated_override` records an explicit human decision that detection must
-- not undo.
alter table entities add column if not exists automated boolean not null default false;
alter table entities add column if not exists automated_reason text;
alter table entities add column if not exists automated_override boolean;
-- What a manual merge ADDED to the survivor, recorded on the tombstone so an
-- unmerge can subtract exactly that and no more.
alter table entities add column if not exists merge_delta jsonb;

create table if not exists review_queue (
  id                  text primary key,
  mention_id          text not null references mentions(id) on delete cascade,
  candidate_entity_id text not null,
  score               real not null,
  detail              jsonb,
  status              text not null default 'pending',  -- pending | accepted | rejected
  created_at          timestamptz not null default now()
);

create table if not exists edges (
  a          text not null,
  b          text not null,
  owner      text not null default '',     -- '' = shared layer; else a member id
  signals    jsonb not null default '{}',  -- {meeting: n, email: n, doc: n, mention: n}
  weight     real not null default 0,      -- raw evidence, summable across visible layers
  strength   real not null default 0,      -- 1-exp(-weight/saturation) for this layer alone
  last_seen  timestamptz,
  updated_at timestamptz not null default now()
);
-- edges is a derived read model, rebuilt wholesale; these keep old databases
-- working when the layer columns are introduced.
alter table edges add column if not exists owner text not null default '';
alter table edges add column if not exists weight real not null default 0;
alter table edges drop constraint if exists edges_pkey;
create unique index if not exists edges_pk on edges (a, b, owner);

-- Unstructured extraction: document bodies + per-document bookkeeping.
-- `body` is captured by adapters; `body_sha256` lets the pipeline decide
-- skip/re-extract without loading bodies; mentions gain provenance so
-- extracted mentions are distinguishable from structured-metadata ones.
alter table documents add column if not exists body text;
alter table documents add column if not exists body_sha256 text;
alter table mentions add column if not exists origin text not null default 'structured';
alter table mentions add column if not exists confidence real;
alter table mentions add column if not exists context text;

create table if not exists extractions (
  document_id   text primary key references documents(id) on delete cascade,
  status        text not null,              -- ok | failed
  model         text,
  input_sha256  text not null,              -- hash of (prompt ver | model | effort | floor | body hash)
  attempts      int not null default 0,     -- failures at this hash; exhausted docs stop retrying
  mentions_found int not null default 0,
  input_tokens  int,
  output_tokens int,
  error         text,
  updated_at    timestamptz not null default now()
);
alter table extractions add column if not exists attempts int not null default 0;

-- Fund memory: deal signals mined from document bodies (IC memos, board packs,
-- update emails). Deals hang off organizations (design principle 1) — linkage
-- to a resolved org entity happens at query time via company_norm ↔ aliases,
-- so entity rebuilds never orphan a deal. Provenance-first: every deal points
-- at the document it came from and carries a code-derived context snippet.
create table if not exists deals (
  id          text primary key,
  document_id text not null references documents(id) on delete cascade,
  company     text not null,
  company_norm text not null,
  stage       text,                      -- as written: "Series A", "seed", …
  status      text not null default 'unknown',  -- active | invested | passed | exited | unknown
  summary     text,                      -- model-authored, advisory, labeled as such
  confidence  real,
  context     text,                      -- verbatim snippet cut from the body by code
  origin      text not null default 'extracted',
  updated_at  timestamptz not null default now()
);
create index if not exists deals_company_norm on deals (company_norm);
create index if not exists deals_document on deals (document_id);

-- Privacy layers: a team member connects their own sensitive sources; those
-- documents form a private layer visible only to them inside the shared graph.
-- Entities (who exists) stay shared — it is the evidence, strength, and
-- documents that are private. `owner = ''` means the shared layer.
create table if not exists members (
  id         text primary key,
  name       text not null,
  email      text,
  created_at timestamptz not null default now()
);
alter table documents add column if not exists owner text not null default '';

create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists audit_log (
  id     text primary key,
  at     timestamptz not null default now(),
  actor  text not null default 'local',
  action text not null,   -- ingest | review_accept | review_reject | settings_update | reresolve
  detail jsonb
);

create index if not exists mentions_unresolved on mentions (entity_id) where entity_id is null;
create index if not exists mentions_norm_email on mentions (norm_email);
create index if not exists edges_a on edges (a);
create index if not exists edges_b on edges (b);

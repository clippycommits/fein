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
  signals    jsonb not null default '{}',  -- {meeting: n, email: n, doc: n, mention: n}
  strength   real not null default 0,      -- 0..1, deterministic — never LLM-scored
  last_seen  timestamptz,
  updated_at timestamptz not null default now(),
  primary key (a, b)
);

-- Unstructured extraction: document bodies + per-document bookkeeping.
-- `body` is captured by adapters; mentions gain provenance so extracted
-- mentions are distinguishable from structured-metadata ones.
alter table documents add column if not exists body text;
alter table mentions add column if not exists origin text not null default 'structured';
alter table mentions add column if not exists confidence real;
alter table mentions add column if not exists context text;

create table if not exists extractions (
  document_id   text primary key references documents(id) on delete cascade,
  status        text not null,              -- ok | failed
  model         text,
  input_sha256  text not null,              -- hash of (prompt version | model | body); re-extract when it drifts
  mentions_found int not null default 0,
  input_tokens  int,
  output_tokens int,
  error         text,
  updated_at    timestamptz not null default now()
);

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

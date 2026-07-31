create extension if not exists vector;

create table if not exists chunks (
  id bigserial primary key,
  tenant_id text not null default 'default',
  text text not null,
  source_type text not null, -- 'docx' | 'xlsx' | 'website' | 'image'
  source_uri text not null,
  page_or_row text,
  image_refs text[] default '{}',
  embedding vector(1024),
  ingested_at timestamptz not null default now()
);

create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

create index if not exists chunks_tenant_idx on chunks (tenant_id);

-- Temporary hosting for generated TTS audio so Twilio can fetch it by URL
-- for outbound WhatsApp voice-note replies. Rows are short-lived (cleaned up
-- periodically or left to accumulate for this POC's scale).
create table if not exists voice_replies (
  id uuid primary key default gen_random_uuid(),
  content_type text not null,
  audio_data bytea not null,
  created_at timestamptz not null default now()
);

-- Twilio/WhatsApp can deliver the same inbound message more than once
-- (retry on a slow ack, or their own at-least-once delivery). Claiming the
-- MessageSid here before running the pipeline makes processing idempotent.
create table if not exists processed_messages (
  message_sid text primary key,
  created_at timestamptz not null default now()
);

-- Registry of tenants (clients) for the multi-tenant platform. Not itself
-- RLS-scoped - it's the registry, gated by admin auth in its route handlers.
create table if not exists tenants (
  id text primary key,
  name text not null,
  subdomain text not null unique,
  twilio_whatsapp_number text unique,
  license_expires_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

-- create table if not exists is a no-op once the table already exists, so
-- columns added after the table's initial creation need their own explicit
-- ALTER TABLE - putting them in the CREATE TABLE block above would silently
-- never apply to an already-existing tenants table (confirmed the hard way:
-- shipped code assuming these columns existed before this line was added).
--
-- A tenant's WhatsApp number can live on its own Twilio subaccount (distinct
-- Account SID + Auth Token from the platform's main account) - Twilio signs
-- webhook requests and requires sending using the credentials of whichever
-- account actually owns the number. Both null (the common case) means "use
-- the platform's global TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env vars";
-- both set means "use this tenant's own". Enforced as both-or-neither at
-- the application layer, not here. twilio_auth_token is never returned by
-- any API response - see src/lib/tenants.ts.
alter table tenants add column if not exists twilio_account_sid text;
alter table tenants add column if not exists twilio_auth_token text;

-- Freeform admin-authored guidance blended into the system prompt for this
-- tenant's answers - answer tone/format preferences and how to weigh this
-- tenant's KB content. Null means "use the platform's default tone only".
-- Not sensitive (admin-authored, not a secret), safe to return from API
-- responses unlike twilio_auth_token above.
alter table tenants add column if not exists answer_config_md text;

insert into tenants (id, name, subdomain)
values ('default', 'UAT', 'default')
on conflict (id) do nothing;

-- Sliding-window rate limiting, backed by Postgres rather than in-memory
-- counters because Vercel serverless functions are stateless per-invocation
-- and don't share memory across concurrent instances. bucket_key encodes
-- both the endpoint/limit-type and identifier, e.g. "ask:ip:1.2.3.4" or
-- "escalate:phone:+919840000000". Rows are cleaned up opportunistically by
-- checkRateLimit() itself rather than a separate cron job.
create table if not exists rate_limit_events (
  id bigserial primary key,
  bucket_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_events_bucket_idx
  on rate_limit_events (bucket_key, created_at);

-- Sarvam has no knowledge-base API (verified by probing: every KB-shaped path
-- 404s, where a real-but-undocumented route like /connections 500s instead),
-- so pushing a tenant's derived KB into a Sarvam voice agent is a manual
-- dashboard upload. These two columns record what was last uploaded so the
-- admin UI can tell "in sync" from "the KB changed, re-upload needed" - the
-- hash is of the generated artifacts, not of the source chunks, so editing a
-- doc in a way that doesn't change the derived output correctly stays in sync.
alter table tenants add column if not exists derived_kb_uploaded_at timestamptz;
alter table tenants add column if not exists derived_kb_uploaded_hash text;

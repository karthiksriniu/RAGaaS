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

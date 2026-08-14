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


-- The phone number a tenant's customers dial to reach its voice agent, in
-- E.164 (e.g. +918071582575). Distinct from twilio_whatsapp_number, which is
-- stored with Twilio's "whatsapp:" wire prefix and belongs to a different
-- channel. Unique so one number can never resolve to two tenants; nullable
-- because a tenant may exist before a number is provisioned for it.
alter table tenants add column if not exists voice_phone_number text unique;

-- The derived-KB export was removed when the Sarvam-managed path was dropped
-- in favour of LiveKit; retrieval is now live via /api/voice/retrieve, so
-- there is nothing to export or track the upload of. Dropped rather than left
-- orphaned, so the schema matches the code.
alter table tenants drop column if exists derived_kb_uploaded_at;
alter table tenants drop column if exists derived_kb_uploaded_hash;

-- ── Self-service signup ───────────────────────────────────────────────────
-- A business owner's login. Identity is the mobile number (OTP), so there is
-- no password column at all. One account owns exactly one tenant in this
-- phase; the FK is on the account, not the tenant, so a future "one owner,
-- several businesses" needs no migration of existing rows.
create table if not exists business_accounts (
  id text primary key,
  mobile text not null unique,
  tenant_id text not null references tenants(id),
  created_at timestamptz not null default now()
);
create index if not exists business_accounts_tenant_idx on business_accounts (tenant_id);

-- Short-lived OTP challenges. Rows are deleted on successful verification and
-- swept on issue, so this never accumulates. attempts caps brute force
-- against a 6-digit code.
create table if not exists otp_challenges (
  mobile text primary key,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Numbers bought up front and handed out at signup. Signup claims a free row
-- atomically, so it can never spend money unexpectedly and two simultaneous
-- signups can never take the same number.
create table if not exists phone_number_pool (
  e164 text primary key,
  tenant_id text references tenants(id),
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists phone_number_pool_free_idx on phone_number_pool (tenant_id) where tenant_id is null;

-- What the business told us it does, at signup. Seeds the agent's prompt and
-- the generated starter knowledge base.
alter table tenants add column if not exists business_description text;

-- The app connects as the non-owner app_runtime role (SUPABASE_DB_URL_APP), so
-- every new table needs explicit grants or the app gets a permission error that
-- surfaces as a 500. The role's PASSWORD is deliberately not in this file;
-- grants are not secret and belong here so a fresh environment is reproducible.
--
-- None of these three are RLS-scoped, for the same reason `tenants` isn't: they
-- are registries and request bookkeeping, not tenant content. business_accounts
-- is read before any session exists (to find which tenant a mobile owns), and
-- phone_number_pool is platform inventory.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    grant select, insert, update, delete on business_accounts to app_runtime;
    grant select, insert, update, delete on otp_challenges    to app_runtime;
    grant select, insert, update, delete on phone_number_pool to app_runtime;
  end if;
end $$;

-- Which named voice preset this tenant's agent speaks with (see
-- src/lib/voicePresets.ts). Stored as the preset id rather than the raw
-- speaker/pace/temperature so the tuned pairings can be adjusted centrally
-- without migrating every tenant's numbers. Null means the default preset.
alter table tenants add column if not exists voice_preset text;

-- Optional business website, captured at signup. Used to generate a far richer
-- starter knowledge base than a one-line description can support.
alter table tenants add column if not exists website_url text;

-- Tracks the website-informed KB enhancement, which runs AFTER the signup
-- response so the business isn't held on the provisioning screen for minutes.
--   pending  - queued, running now in the background
--   done     - website read and ingested
--   failed   - see kb_enhancement_error; the business can retry
--   null     - nothing to do (no website given)
-- Needed because a background failure is otherwise invisible: without a status
-- the business simply never receives the better KB and never learns why.
alter table tenants add column if not exists kb_enhancement_status text;
alter table tenants add column if not exists kb_enhancement_error text;

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

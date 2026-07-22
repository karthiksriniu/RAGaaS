# AgriAdvisor

Voice-first RAG proof-of-concept for agriculturists. Farmers ask questions about seeds, crop conditions, and agronomy; the app retrieves from an uploaded knowledge bank and answers with citations.

**Phase 1 (live):** text-only Q&A against a docx knowledge base, single tenant.

## Stack

- Next.js 16 (App Router, TypeScript) + Tailwind CSS
- Voyage AI (`voyage-3`) for embeddings
- Supabase Postgres + pgvector for the vector store
- Anthropic Claude (`claude-sonnet-5`) for grounded answer generation
- `mammoth` for docx parsing

## Local development

```bash
npm install
npm run dev
```

Requires a `.env.local` with:

```
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
SUPABASE_DB_URL=
DEFAULT_TENANT_ID=default
```

Run `node scripts/migrate.mjs` once to create the `chunks` table and enable pgvector on a fresh Supabase database.

## Deployment

Deployed on Vercel, connected to this repo for auto-deploy on push to `main`. Environment variables are set directly on the Vercel project (never committed).

## Roadmap

| Phase | Scope |
|---|---|
| 1 | Core RAG, text only, single tenant *(live)* |
| 2 | Classification (2×2 source × criticality matrix) + confidence labeling |
| 3 | Per-tenant configuration layer + `/admin` view |
| 4 | Full connector layer: xlsx, website ingestion, image captioning |
| 5 | Voice I/O via Sarvam AI (Saaras v3 STT, Bulbul v3 TTS), EN/TA/ML |
| 6 | Deploy polish, mobile responsiveness |

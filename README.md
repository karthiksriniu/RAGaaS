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
ADMIN_PASSWORD_HASH=      # scrypt "salt:hash" hex - generate with a one-off node -e script, never commit the plaintext
ADMIN_SESSION_SECRET=     # random hex, signs the admin session cookie
```

Run `node scripts/migrate.mjs` once to create the `chunks` table and enable pgvector on a fresh Supabase database.

## Admin portal

Knowledge base management (`upload` / `list` / `delete` sources) lives at `/admin`, gated by a single shared admin login (`src/proxy.ts` + `src/lib/adminAuth.ts`) - not yet per-user auth, tracked for a future phase. The farmer-facing routes (`/`, `/api/ask`, `/api/whatsapp/*`, `/api/voice/*`, `/api/escalate`) are deliberately excluded from the gate so Twilio and real users are never blocked.

## Environments

| Environment | Branch | Vercel project | Supabase project | Twilio |
|---|---|---|---|---|
| Production | `main` | `agriadvisor-poc` | production project | main account |
| Staging | `staging` | `agriadvisor-poc-staging` | separate staging project | `AgriAdvisor Staging` subaccount |

Push to `staging` first and run UAT there — it has its own database and its own Twilio subaccount, so nothing touches production data, numbers, or contacts. Only merge `staging` → `main` once UAT passes; `main` auto-deploys straight to production.

## Deployment

Deployed on Vercel, connected to this repo for auto-deploy on push to `main` (production) and `staging` (staging, separate Vercel project). Environment variables are set directly on each Vercel project (never committed).

## Roadmap

| Phase | Scope |
|---|---|
| 1 | Core RAG, text only, single tenant *(live)* |
| 2 | Classification (2×2 source × criticality matrix) + confidence labeling |
| 3 | Per-tenant configuration layer + `/admin` view |
| 4 | Full connector layer: xlsx, website ingestion, image captioning |
| 5 | Voice I/O via Sarvam AI (Saaras v3 STT, Bulbul v3 TTS), EN/TA/ML |
| 6 | Deploy polish, mobile responsiveness |

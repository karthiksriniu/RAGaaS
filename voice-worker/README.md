# MyBizCare voice worker (Phase A3)

A LiveKit agent that answers live phone calls using Sarvam end to end — Saaras v3 STT,
Sarvam 105B, Bulbul v3 TTS — grounded in the tenant's MyBizCare knowledge base, with a real
**agent-assisted warm transfer** to a human.

## Why this path exists

Sarvam's managed Voice Agents platform has native human handover, but it is **enterprise-gated**
(`docs.sarvam.ai/conversations/build/run-time`: *"Human handover is available today for enterprise
deployments"*). This worker gets warm transfer with no enterprise plan and no Twilio, because
**LiveKit transfers over SIP REFER** and **Vobiz supports REFER on verified trunks**
(RFC 3515, blind and attended).

It also keeps retrieval ours — per-tenant RLS isolation, the answer-config layer, and whatever
source formats we choose to support.

## Architecture

```
Caller → Vobiz SIP trunk → LiveKit SIP → this worker
                                            ├── Saaras v3 STT   (streaming)
                                            ├── Sarvam 105B     (streaming)
                                            ├── Bulbul v3 TTS   (streaming)
                                            ├── search_knowledge_base → MyBizCare /api/voice/retrieve
                                            └── transfer_to_human     → WarmTransferTask (SIP REFER)
```

The LLM streams straight into TTS. This is **not** a port of `answerQuestion.ts`, which composes a
complete structured answer before emitting anything — fine for chat, fatal for a phone call.

## Setup

### 1. MyBizCare side

Set `VOICE_WORKER_TOKEN` on the deployment (Vercel → project → Environment Variables). Generate one
with:

```bash
openssl rand -hex 32
```

Until it is set, `/api/voice/retrieve` returns **503** by design — it fails closed rather than
serving KB content unauthenticated.

### 2. LiveKit

Create a project at [LiveKit Cloud](https://cloud.livekit.io) (or self-host). Note the URL, API key
and secret.

### 3. Vobiz SIP trunk → LiveKit

- Point an **inbound** trunk at LiveKit and attach `+918071582575`, so calls reach this worker
  instead of the Sarvam-managed agent.
- Create an **outbound** trunk for the transfer leg, and confirm with Vobiz that it is a
  **verified trunk** — REFER only works on those, and transfer is the whole point of this path.
- Fill `SIP_TRUNK_HOSTNAME`, `SIP_AUTH_USERNAME`, `SIP_AUTH_PASSWORD`.

> The rented number currently points at Sarvam's managed agent. Repointing it moves the number to
> this worker. Rent a second number if you want both paths live to compare.

### 4. Run

```bash
cp .env.example .env   # then fill it in
docker build -t mybizcare-voice-worker .
docker run --env-file .env mybizcare-voice-worker
```

Locally without Docker (needs Python 3.11+; 3.9 will not work):

```bash
pip install -r requirements.txt
python agent.py console   # terminal-only, no telephony — fastest way to test the loop
python agent.py dev       # connects to LiveKit, hot reload
```

## Testing before the account upgrade

Vobiz trial accounts allow **outbound** trunks but refuse to bind a number to an
**inbound** trunk until the account is upgraded (KYC + a paid DID). So nobody can dial in yet.
Dial *out* instead — same media path, same worker, same pipeline:

```bash
python agent.py dev            # terminal 1
python dial.py +919840816035   # terminal 2 — your phone rings, the agent speaks
```

Latency, barge-in and warm transfer are all measurable this way, so Phase A does not have to
wait on the upgrade.

## What to measure

This is a spike. The questions it exists to answer:

1. **Time to first audio** after the caller stops speaking. Target under ~1.5s.
2. **Barge-in** — talking over the agent stops it.
3. **Warm transfer** — the expert hears the brief, then the caller is moved across, without the
   caller ever hanging up.
4. **Retrieval quality** versus Sarvam's own KB (the A2a comparison).

## Known gaps

- **Single-tenant.** Tenant comes from `MYBIZCARE_TENANT_ID`. Multi-tenant means resolving the
  dialed number from the SIP participant attributes at session start and looking the tenant up —
  the same pattern `getTenantByWhatsappNumber` already uses for WhatsApp. Deliberately deferred so
  the spike measures latency and transfer, not plumbing.
- **Per-tenant answer style not injected.** `INSTRUCTIONS` is the global voice prompt; the
  tenant's `answerConfigMd` is not yet appended. It is already exposed as `systemPromptAddendum`
  from `/api/admin/derived-kb`.
- **`WarmTransferTask` is beta.** It lives under `livekit.agents.beta.workflows` and has moved
  between releases, hence the `~=1.6` pin. If the import fails, check the installed version before
  anything else.
- **Untested against live infrastructure.** The code is written against the documented APIs and
  parses cleanly, but no one has run it against a real LiveKit project or SIP trunk yet — the dev
  machine has neither Docker nor Python 3.11. Expect to fix signature drift on the first run.

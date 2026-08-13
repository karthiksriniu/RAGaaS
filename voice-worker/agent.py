"""MyBizCare voice worker — Phase A3.

ONE worker serves EVERY tenant. The tenant is resolved from the number the
caller dialed, at session start, before the agent speaks — the same pattern
`getTenantByWhatsappNumber` already uses for WhatsApp. That is what makes
self-service signup possible: onboarding a business is a database row plus a
Vobiz number, with no per-customer deployment or dashboard step.

Sarvam does all the AI (Saaras v3 STT, Sarvam 105B, Bulbul v3 TTS). LiveKit is
transport: it answers the phone, moves audio, and gives us SIP REFER for a real
warm transfer. Retrieval and configuration stay ours.

Deliberately NOT a port of answerQuestion.ts. That path forces the model to emit
a complete structured object before anything is returned — fine for chat, fatal
on a phone call. Here the LLM streams straight into TTS and calls retrieval as a
tool only when it actually needs a fact.
"""

from __future__ import annotations

import logging
import os
import sys

import aiohttp
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
)

# MUST be imported at module scope, not inside the Agent. livekit.plugins.sarvam
# pulls in livekit.plugins.openai, which calls Plugin.register_plugin() at import
# time, and LiveKit only permits that on the main thread - deferring it into
# __init__ runs it in the job process and raises "Plugins must be registered on
# the main thread". Importing here also means a missing extra fails fast at
# startup instead of on the first call.
from livekit.plugins import sarvam

load_dotenv()

logger = logging.getLogger("mybizcare-voice")
logger.setLevel(logging.INFO)

# Read with .get(), NOT os.environ[...]: the Dockerfile runs
# `python agent.py download-files` at BUILD time to pre-fetch the VAD weights,
# and a build has no environment set. Indexing here made the image fail to
# build. Validated at startup instead - see _require_env() - so a genuinely
# missing variable still fails fast and loudly, just at run time.
BASE_URL = os.getenv("MYBIZCARE_BASE_URL", "").rstrip("/")
VOICE_WORKER_TOKEN = os.getenv("VOICE_WORKER_TOKEN", "")
EXPERT_PHONE_NUMBER = os.getenv("EXPERT_PHONE_NUMBER", "")


def _require_env() -> None:
    """Fail fast on a misconfigured deployment, before any call is answered."""
    missing = [
        n for n in ("MYBIZCARE_BASE_URL", "VOICE_WORKER_TOKEN",
                    "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
                    "SARVAM_API_KEY")
        if not os.getenv(n)
    ]
    if missing:
        raise RuntimeError(
            "Missing required environment variables: " + ", ".join(missing)
        )

# Used only when the dialed number can't be determined — a console/dev session
# has no SIP participant at all. Never relied on for real calls.
DEV_FALLBACK_TENANT_NUMBER = os.getenv("DEV_FALLBACK_TENANT_NUMBER", "")

# Retrieval sits inside the caller's turn latency, so it gets a tight timeout.
# Better to apologise in three seconds than leave dead air on a phone line; the
# tool returns an instruction to offer a transfer rather than inventing facts.
RETRIEVE_TIMEOUT_S = 3.0
SESSION_TIMEOUT_S = 5.0


class TenantContext:
    """Everything about the tenant whose number was dialed."""

    def __init__(self, tenant_id: str, business_name: str, greeting: str, instructions: str,
                 voice: dict | None = None):
        self.tenant_id = tenant_id
        self.business_name = business_name
        self.greeting = greeting
        self.instructions = instructions
        # Speaker and delivery come from the tenant's chosen preset, resolved
        # server-side. Defaults here only cover an older app deployment that
        # doesn't send them yet.
        v = voice or {}
        self.speaker: str = v.get("speaker") or "priya"
        self.pace: float = float(v.get("pace") or 0.95)
        self.temperature: float = float(v.get("temperature") or 0.8)


def _normalize_e164(raw: str) -> str:
    """Carrier-presented number -> E.164, so tenant lookup is format-proof.

    Vobiz presents an inbound Indian number in national form with a leading
    zero ("08071580725"), not E.164. Looking that up against a tenants table
    holding "+918071580725" simply misses, and the caller hears the line was
    never set up. Confirmed from Vobiz CDR: destination_number=08071580725.

    India-specific on purpose - this product serves Indian numbers, and a
    generic parser would need a real phone-number library. Anything already in
    E.164 is passed through untouched, so other countries still work.
    """
    n = "".join(ch for ch in raw if ch.isdigit() or ch == "+").strip()
    if n.startswith("+"):
        return n
    if n.startswith("00"):
        return "+" + n[2:]
    if len(n) == 12 and n.startswith("91"):
        return "+" + n
    if n.startswith("0"):
        # A single leading 0 is India's national trunk prefix. What follows is
        # either a bare 10-digit subscriber number or an already-country-coded
        # one; strip the prefix and re-decide rather than assuming a length.
        rest = n[1:]
        if len(rest) == 10:
            return "+91" + rest
        if len(rest) == 12 and rest.startswith("91"):
            return "+" + rest
    if len(n) == 10:
        return "+91" + n
    return n


def _dialed_number(participant) -> str | None:
    """The number the caller dialed, from the SIP participant's attributes.

    Takes an already-joined participant rather than the JobContext: attributes
    only exist once the participant has actually connected. Reading
    ctx.room.remote_participants at entrypoint start always found it empty, so
    every call silently fell back to DEV_FALLBACK_TENANT_NUMBER.

    Attribute naming has shifted across LiveKit versions, so several known
    spellings are tried rather than pinning to one and breaking on upgrade.
    """
    attrs = getattr(participant, "attributes", None) or {}
    if True:
        for key in ("sip.trunkPhoneNumber", "sip.dialedNumber", "sip.to", "sip.toNumber"):
            value = attrs.get(key)
            # isinstance, not truthiness: `agent.py console` supplies a
            # MagicMock room, and every attribute access on a mock returns
            # another mock - which is truthy. A bare `if value` therefore
            # returned the mock's repr as if it were a phone number, and the
            # dev fallback below never ran.
            if isinstance(value, str) and value.strip():
                return _normalize_e164(value)
    return None


async def _fetch_tenant(http: aiohttp.ClientSession, dialed: str) -> TenantContext | None:
    try:
        async with http.post(
            f"{BASE_URL}/api/voice/session",
            json={"dialedNumber": dialed},
            headers={"Authorization": f"Bearer {VOICE_WORKER_TOKEN}"},
            timeout=aiohttp.ClientTimeout(total=SESSION_TIMEOUT_S),
        ) as res:
            if res.status == 404:
                logger.error("no tenant owns dialed number %s", dialed)
                return None
            if res.status == 403:
                logger.error("tenant licence expired for dialed number %s", dialed)
                return None
            if res.status != 200:
                logger.error("session lookup failed: %s %s", res.status, await res.text())
                return None
            data = await res.json()
    except Exception:
        logger.exception("session lookup errored")
        return None

    return TenantContext(
        tenant_id=data["tenantId"],
        business_name=data["businessName"],
        greeting=data["greeting"],
        instructions=data["instructions"],
        voice=data.get("voice"),
    )


class MyBizCareAgent(Agent):
    def __init__(self, http: aiohttp.ClientSession, tenant: TenantContext) -> None:
        super().__init__(
            # Instructions come from the app, already composed with this
            # tenant's answer-style config, so tone changes need no redeploy.
            instructions=tenant.instructions,
            # language="unknown" because Indian callers routinely code-mix
            # mid-sentence; pinning a language degrades transcription the
            # moment they do. Telephony audio is 8kHz, which saaras:v3 accepts
            # natively with no upsampling step.
            stt=sarvam.STT(language="unknown", model="saaras:v3", mode="transcribe", flush_signal=True),
            # reasoning_effort=None is the latency choice: these are short
            # question-and-confirm turns, and reasoning latency is audible as
            # dead air on a phone line.
            llm=sarvam.LLM(model="sarvam-105b", reasoning_effort=None, max_tokens=400),
            # target_language_code, not language_code - the installed plugin
            # rejects the latter.
            #
            # Speaker and delivery come from the tenant's voice preset via
            # /api/voice/session, so a business changing its voice in the
            # dashboard takes effect on its next call with no redeploy here.
            #
            # Deliberately NOT Sarvam's "IVR / Telephony" preset (pace 1.1,
            # temperature 0.4) - that is tuned for menu prompts, and on a
            # conversational agent every sentence lands on the same flat
            # contour.
            tts=sarvam.TTS(
                target_language_code="en-IN",
                model="bulbul:v3",
                speaker=tenant.speaker,
                pace=tenant.pace,
                temperature=tenant.temperature,
            ),
        )
        self._http = http
        self._tenant = tenant

    async def on_enter(self) -> None:
        self.session.say(self._tenant.greeting)

    @function_tool
    async def search_knowledge_base(self, ctx: RunContext, question: str) -> str:
        """Look up factual information about this business to answer the caller.

        Args:
            question: A self-contained search query describing what the caller wants to know.
        """
        unavailable = (
            "The knowledge base could not be reached. Tell the caller you cannot check "
            "that right now and offer to transfer them to a person."
        )
        try:
            async with self._http.post(
                f"{BASE_URL}/api/voice/retrieve",
                json={"tenantId": self._tenant.tenant_id, "question": question},
                headers={"Authorization": f"Bearer {VOICE_WORKER_TOKEN}"},
                timeout=aiohttp.ClientTimeout(total=RETRIEVE_TIMEOUT_S),
            ) as res:
                if res.status != 200:
                    logger.warning("retrieve failed: %s %s", res.status, await res.text())
                    return unavailable
                data = await res.json()
        except Exception:
            logger.exception("retrieve errored")
            return unavailable

        context = data.get("contextBlock") or ""
        if not context.strip():
            return (
                "No matching information was found. Tell the caller you don't have that "
                "information and offer to transfer them to a person."
            )

        # The success path must be framed as explicitly as the failure paths
        # are. Returning bare context left the model with a wall of text and no
        # instruction, while its system prompt forbids naming sources - so it
        # treated the result as unusable and told callers there was no
        # information, even though the facts were right there. Observed
        # happening with retrieval demonstrably returning the right passages.
        return (
            "Here is the information from this business's own records. Answer the caller "
            "using it. It is authoritative - do not contradict it or add facts of your own. "
            "Do not mention documents, records, or where this came from; just answer. "
            "If it genuinely does not cover what was asked, say you don't have that "
            "information and offer to put them through to a person.\n\n"
            f"{context}"
        )

    @function_tool
    async def transfer_to_human(self, ctx: RunContext, reason: str) -> str:
        """Warm-transfer the caller to a human expert, briefing them first.

        Args:
            reason: A one-sentence summary of what the caller needs, for the expert.
        """
        if not EXPERT_PHONE_NUMBER:
            logger.error("transfer requested but EXPERT_PHONE_NUMBER is unset")
            return "Transfer is unavailable. Apologise and offer to take a callback number instead."

        # Beta namespace — see the pin in requirements.txt. Imported here so a
        # version mismatch breaks only the transfer path rather than stopping
        # the worker from starting and answering calls at all.
        from livekit.agents.beta.workflows import WarmTransferTask
        from livekit.protocol.sip import SIPOutboundConfig

        logger.info("warm transfer requested (tenant=%s): %s", self._tenant.tenant_id, reason)
        try:
            await WarmTransferTask(
                sip_call_to=EXPERT_PHONE_NUMBER,
                sip_connection=SIPOutboundConfig(
                    # .get() so a deployment without transfer configured fails
                    # this one tool gracefully rather than crashing the call.
                    hostname=os.getenv("SIP_TRUNK_HOSTNAME", ""),
                    auth_username=os.getenv("SIP_AUTH_USERNAME", ""),
                    auth_password=os.getenv("SIP_AUTH_PASSWORD", ""),
                ),
                # Handing over the transcript is what makes this warm rather
                # than merely connected: the expert hears the context before
                # the caller is moved across.
                chat_ctx=ctx.session.history,
                ringing_timeout=30.0,
            )
        except Exception:
            logger.exception("warm transfer failed")
            return "The transfer did not connect. Apologise and offer to take a callback number instead."

        return "Transfer completed."


async def entrypoint(ctx: JobContext) -> None:
    # One session for every request this worker makes, so connections are
    # pooled — a fresh TCP+TLS handshake per lookup would land directly in the
    # caller's turn latency.
    http = aiohttp.ClientSession()
    ctx.add_shutdown_callback(http.close)

    # Connect and wait for the caller before touching attributes - they do not
    # exist until the participant has joined. Also required so the job
    # finalises properly; without it LiveKit logs "completed without
    # establishing a connection".
    await ctx.connect()
    try:
        participant = await ctx.wait_for_participant()
    except RuntimeError as err:
        # "room disconnected while waiting for participant" - the caller hung
        # up during ringing. An ordinary outcome, not an error worth a
        # traceback, and there is nothing left to serve.
        logger.info("caller left before connecting (%s); ending job", err)
        return
    logger.info("participant joined: %s attrs=%s", participant.identity,
                dict(getattr(participant, "attributes", {}) or {}))

    dialed = _dialed_number(participant)
    if not dialed and DEV_FALLBACK_TENANT_NUMBER:
        # `agent.py console` has no SIP participant. Only reachable when the
        # fallback is explicitly configured, so production can never silently
        # answer as the wrong tenant.
        logger.warning("no dialed number; using DEV_FALLBACK_TENANT_NUMBER")
        dialed = _normalize_e164(DEV_FALLBACK_TENANT_NUMBER)

    tenant = await _fetch_tenant(http, dialed) if dialed else None

    if tenant is None:
        # Fail loudly rather than answering as some default tenant, which would
        # serve one business's knowledge base to another business's caller.
        logger.error("could not resolve tenant for room %s (dialed=%s); ending", ctx.room.name, dialed)
        return

    logger.info("call started: room=%s tenant=%s dialed=%s voice=%s pace=%s temp=%s",
                ctx.room.name, tenant.tenant_id, dialed, tenant.speaker, tenant.pace, tenant.temperature)

    session = AgentSession(
        # Turn-taking delegated to the Sarvam STT plugin; 70ms matches its
        # documented processing latency, and waiting longer is an audible pause
        # before the agent starts speaking.
        turn_detection="stt",
        min_endpointing_delay=0.07,
    )
    await session.start(agent=MyBizCareAgent(http, tenant), room=ctx.room)


if __name__ == "__main__":
    # download-files runs at image build with no env; everything else needs it.
    if len(sys.argv) > 1 and sys.argv[1] != "download-files":
        _require_env()
    # agent_name must match the dispatch rule's RoomAgentDispatch exactly.
    # Without it the worker uses default dispatch, and a rule that names an
    # agent will never match it - the call connects and nobody joins.
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="mybizcare-voice",
            # num_idle_processes defaults to FOUR in production. Each prewarmed
            # process loads the Silero VAD model, so on a small container they
            # starve the process actually serving the call: the event loop
            # stalls for seconds, LiveKit's watchdog sees no heartbeat, and
            # kills the job mid-call ("process is unresponsive" -> exit -10).
            # One spare is enough to keep answer latency low.
            num_idle_processes=1,
        )
    )

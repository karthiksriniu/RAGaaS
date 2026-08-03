"""MyBizCare voice worker — Phase A3.

A LiveKit agent that answers live phone calls using Sarvam for the whole
speech pipeline (Saaras STT -> Sarvam 105B -> Bulbul TTS), grounded in the
tenant's own knowledge base via MyBizCare's retrieval API, with a real
agent-assisted warm transfer to a human.

Why this exists alongside the managed Sarvam Voice Agents path (A2):
  - Warm transfer. Sarvam's native human handover is enterprise-gated, but
    LiveKit performs transfer over SIP REFER, which Vobiz supports on
    verified trunks. This path gets warm transfer with no enterprise plan
    and no Twilio.
  - Retrieval stays ours: per-tenant RLS isolation, the answer-config layer,
    and any source format we choose to support.

Deliberately NOT a copy of answerQuestion.ts. That path composes a complete
structured answer before returning anything, which is fine for chat and
fatal for voice. Here the LLM streams straight into TTS, and retrieval is a
tool the model calls only when it actually needs a fact.
"""

from __future__ import annotations

import logging
import os

import aiohttp
from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, JobContext, RunContext, WorkerOptions, cli, function_tool

load_dotenv()

logger = logging.getLogger("mybizcare-voice")
logger.setLevel(logging.INFO)

BASE_URL = os.environ["MYBIZCARE_BASE_URL"].rstrip("/")
VOICE_WORKER_TOKEN = os.environ["VOICE_WORKER_TOKEN"]
TENANT_ID = os.environ["MYBIZCARE_TENANT_ID"]
EXPERT_PHONE_NUMBER = os.getenv("EXPERT_PHONE_NUMBER", "")

# Retrieval sits in the caller's turn latency, so it gets a tight timeout.
# Better to apologise in half a second than leave dead air on a phone line;
# the model is instructed to say it couldn't check rather than invent.
RETRIEVE_TIMEOUT_S = 3.0


# Adapted from GLOBAL_RULES in app/src/lib/systemPrompt.ts. Three changes for
# voice: no bracketed citations (they would be read aloud), shorter answers
# (a caller cannot skim), and handoff offered in conversation rather than as
# a UI badge.
INSTRUCTIONS = """You are a customer care assistant answering questions over a phone call.

Use the search_knowledge_base tool whenever the caller asks anything factual about this
business — its products, services, policies, procedures, or troubleshooting. Do not answer
factual questions from memory. If the tool returns nothing useful, say you don't have that
information and offer to put them through to a person.

Never describe or name your sources. Do not say "according to the document", "our records
show", or "the knowledge base says". Just answer, or say you don't know.

Never state your own confidence. Do not say "I'm confident", "definitely", or "you can be sure".

Because this is spoken aloud:
- Lead with the direct answer in the first one or two sentences. No preamble.
- Keep replies to roughly three or four short sentences unless asked for more.
- One idea per sentence. Short sentences. Plain, everyday words.
- Never speak formatting: no bracketed numbers, no markdown, no bullet characters, no URLs.
- For steps, say "first", "then", "after that" rather than reading numbers aloud.
- Spell out anything easily misheard — phone numbers and codes digit by digit.
- If the question is ambiguous, ask one short clarifying question instead of guessing.
- Answer only what was asked. Do not volunteer adjacent topics.

Use the transfer_to_human tool when the caller asks for a person, when you have failed to
answer their question, or when they sound distressed or frustrated. Tell them you're
connecting them before you call the tool.

Speak in the language the caller uses. If they switch languages, switch with them."""


class MyBizCareAgent(Agent):
    def __init__(self, http: aiohttp.ClientSession) -> None:
        # Imported lazily so that a missing optional extra surfaces as a clear
        # ImportError at startup rather than a confusing failure mid-call.
        from livekit.plugins import sarvam

        super().__init__(
            instructions=INSTRUCTIONS,
            # language="unknown" because Indian callers routinely code-mix
            # mid-sentence; pinning a language degrades transcription the
            # moment they do. Telephony audio is 8kHz, which saaras:v3 takes
            # natively with no upsampling step.
            stt=sarvam.STT(language="unknown", model="saaras:v3", mode="transcribe", flush_signal=True),
            # reasoning_effort=None is the latency choice: these are short
            # question-and-confirm turns, not multi-step reasoning, and the
            # reasoning latency would be audible as dead air.
            llm=sarvam.LLM(model="sarvam-105b", reasoning_effort=None, max_tokens=400),
            tts=sarvam.TTS(language_code="en-IN", model="bulbul:v3", speaker="priya"),
        )
        self._http = http

    async def on_enter(self) -> None:
        self.session.generate_reply()

    @function_tool
    async def search_knowledge_base(self, ctx: RunContext, question: str) -> str:
        """Look up factual information about this business to answer the caller.

        Args:
            question: A self-contained search query describing what the caller wants to know.
        """
        try:
            async with self._http.post(
                f"{BASE_URL}/api/voice/retrieve",
                json={"tenantId": TENANT_ID, "question": question},
                headers={"Authorization": f"Bearer {VOICE_WORKER_TOKEN}"},
                timeout=aiohttp.ClientTimeout(total=RETRIEVE_TIMEOUT_S),
            ) as res:
                if res.status != 200:
                    logger.warning("retrieve failed: %s %s", res.status, await res.text())
                    return "The knowledge base could not be reached. Tell the caller you cannot check that right now and offer to transfer them."
                data = await res.json()
        except Exception:
            logger.exception("retrieve errored")
            return "The knowledge base could not be reached. Tell the caller you cannot check that right now and offer to transfer them."

        context = data.get("contextBlock") or ""
        if not context.strip():
            return "No matching information was found. Tell the caller you don't have that information and offer to transfer them."
        return context

    @function_tool
    async def transfer_to_human(self, ctx: RunContext, reason: str) -> str:
        """Warm-transfer the caller to a human expert, briefing them first.

        Args:
            reason: A one-sentence summary of what the caller needs, for the expert.
        """
        if not EXPERT_PHONE_NUMBER:
            logger.error("transfer requested but EXPERT_PHONE_NUMBER is unset")
            return "Transfer is unavailable. Apologise and offer to take a callback number instead."

        # Beta namespace - see the pin in requirements.txt. Imported here so a
        # version mismatch surfaces only on the transfer path rather than
        # preventing the worker from starting and answering calls at all.
        from livekit.agents.beta.workflows import WarmTransferTask
        from livekit.protocol.sip import SIPOutboundConfig

        logger.info("warm transfer requested: %s", reason)
        try:
            await WarmTransferTask(
                sip_call_to=EXPERT_PHONE_NUMBER,
                sip_connection=SIPOutboundConfig(
                    hostname=os.environ["SIP_TRUNK_HOSTNAME"],
                    auth_username=os.environ["SIP_AUTH_USERNAME"],
                    auth_password=os.environ["SIP_AUTH_PASSWORD"],
                ),
                # Handing the transcript over is what makes this warm rather
                # than merely connected: the expert hears the context before
                # the caller is brought across.
                chat_ctx=ctx.session.history,
                ringing_timeout=30.0,
            )
        except Exception:
            logger.exception("warm transfer failed")
            return "The transfer did not connect. Apologise and offer to take a callback number instead."

        return "Transfer completed."


async def entrypoint(ctx: JobContext) -> None:
    logger.info("call started in room %s (tenant=%s)", ctx.room.name, TENANT_ID)

    # One session reused for every request this worker makes, so connections
    # are pooled - a fresh TCP+TLS handshake per lookup would land directly
    # in the caller's turn latency.
    http = aiohttp.ClientSession()
    ctx.add_shutdown_callback(http.close)

    session = AgentSession(
        # Turn-taking is delegated to the Sarvam STT plugin, and 70ms matches
        # its documented processing latency - waiting longer just adds a pause
        # the caller can hear before the agent starts speaking.
        turn_detection="stt",
        min_endpointing_delay=0.07,
    )
    await session.start(agent=MyBizCareAgent(http), room=ctx.room)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))

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

import asyncio
import logging
import os
import sys

import aiohttp

from lang import LanguageTracker, language_name
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

# How long a caller may be silent before the agent checks they are still there,
# and how long after that check before the call is ended. Env-tunable because
# the right pause differs by line: a support queue can afford to wait, a
# high-volume sales line cannot.
SILENCE_PROMPT_SECONDS = float(os.getenv("SILENCE_PROMPT_SECONDS", "10"))
SILENCE_HANGUP_SECONDS = float(os.getenv("SILENCE_HANGUP_SECONDS", "8"))

# Tags the retrieved-context message so each turn can remove the previous one.
# Only ever sent to the model, never spoken, and the prompt tells it not to
# describe its sources - so it does not leak to the caller.
_CONTEXT_MARKER = "[kb-context]"
_LANGUAGE_MARKER = "[[mybizcare-language]]"

# Below this, a partial transcript is too vague to retrieve anything useful
# ("what is the", "can you") and the lookup would only be thrown away.
MIN_SPECULATIVE_CHARS = int(os.getenv("MIN_SPECULATIVE_CHARS", "12"))


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
# A cold call to /api/voice/retrieve measured 2.7s from a fast connection, and
# the worker now runs in Mumbai calling a Vercel function - 3s left almost no
# headroom, so an ordinary cold start read as "knowledge base unreachable"
# mid-call. Long enough to absorb that, short enough that the caller is not
# left in silence if the endpoint is genuinely down.
RETRIEVE_TIMEOUT_S = 6.0
SESSION_TIMEOUT_S = 5.0


class TenantContext:
    """Everything about the tenant whose number was dialed."""

    def __init__(self, tenant_id: str, business_name: str, greeting: str, instructions: str,
                 voice: dict | None = None, expert_phone_number: str | None = None,
                 appointments: dict | None = None):
        self.tenant_id = tenant_id
        self.business_name = business_name
        self.greeting = greeting
        self.instructions = instructions

        # Who this tenant's callers are handed to. Resolved once per call, here,
        # so the transfer tool has a single value to use and the fallback is
        # visible in one place: EXPERT_PHONE_NUMBER is the platform-wide number
        # this used to ALWAYS be, and is now only reached by a tenant that has
        # not set its own.
        self.expert_phone_number: str = expert_phone_number or EXPERT_PHONE_NUMBER

        # Speaker and delivery come from the tenant's chosen preset, resolved
        # server-side. Defaults here only cover an older app deployment that
        # doesn't send them yet.
        v = voice or {}
        self.speaker: str = v.get("speaker") or "priya"
        self.pace: float = float(v.get("pace") or 0.95)
        self.temperature: float = float(v.get("temperature") or 0.8)

        # Scheduling, read fresh from /api/voice/session on every call. .get()
        # throughout so an older app deployment that does not send this yet
        # simply means "no booking", rather than breaking the call.
        a = appointments or {}
        self.appointments_enabled: bool = bool(a.get("enabled"))
        self.appointment_minutes: int = int(a.get("defaultMinutes") or 30)
        self.booking_window_days: int = int(a.get("windowDays") or 30)
        self.booking_lead_minutes: int = int(a.get("leadMinutes") or 60)
        self.resources: list[dict] = list(a.get("resources") or [])


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
        expert_phone_number=data.get("expertPhoneNumber"),
        appointments=data.get("appointments"),
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
                # linear16 (raw PCM) rather than the default mp3: MP3 has to
                # accumulate and decode frames before any of it can play, which
                # is pure added delay before the caller hears the first word.
                # PCM starts playing as it arrives.
                output_audio_codec="linear16",
                # Sarvam's documented default for bulbul:v3, and better source
                # material for the downsampling that happens on the way to the
                # phone network than the plugin's 22050.
                #
                # Note pitch and loudness are NOT set: both are bulbul:v2-only
                # per Sarvam's API reference, so on v3 they are silently
                # inert - modulation on this model comes from temperature
                # (set per voice preset) and from the punctuation the model
                # writes, which the speech model follows exactly.
                speech_sample_rate=24000,
                # How much text to buffer before synthesis starts. The default
                # 50 characters is most of a sentence - the caller waits for it
                # every single turn. 30 is the plugin's documented FLOOR (it
                # raises below that, which crashed every call when this was
                # briefly set to 25), so this is as early as synthesis can
                # legally start.
                min_buffer_size=30,
            ),
        )
        self._http = http
        self._tenant = tenant
        # Mirrors the target_language_code the TTS was constructed with. The
        # greeting is English, so that is where every call starts.
        # Always starts English: the greeting is English, and an agent that
        # opens in a language the caller did not choose is worse than one that
        # opens in the wrong one they can at least recognise.
        self._language = LanguageTracker("en-IN")
        # A failing component fires the error event on every turn; the caller
        # should be apologised to and transferred exactly once.
        self._rescuing = False
        # A knowledge-base lookup started from a partial transcript, so the
        # ~0.7s round trip overlaps the caller still talking instead of being
        # added on after they stop. Holds (query, task).
        #
        # MUST be initialised HERE, on the agent - speculate(),
        # _cancel_speculative() and _retrieve_for_turn() are all methods of
        # this class. It briefly lived on TenantContext instead, and because
        # livekit's Agent defines no __getattr__, every access raised
        # AttributeError: the proactive lookup was swallowed as "retrieval
        # failed" and the search_knowledge_base tool returned its
        # knowledge-base-unreachable branch, so the agent told every caller it
        # could not access that information while retrieval was in fact fine.
        self._speculative: tuple[str, asyncio.Task[str]] | None = None

    def _sync_tts_language(self, text: str) -> None:
        """Point the voice at the language the caller is actually speaking.

        Never raises: a failed switch must leave the call running in the
        previous language, because the alternative is the silence this exists to
        fix.
        """
        code = self._language.observe(text)
        if code is None:
            return  # not enough agreement yet - stay where we are

        # self.tts, NOT self.session.tts. The stt/llm/tts triple is passed to
        # Agent.__init__ above, not to AgentSession, so the session's own tts is
        # None and reaching through it raised AttributeError on every turn.
        # Both are tried because which one holds it is a plugin-version detail,
        # and being wrong again should degrade to "wrong language" rather than
        # "exception on every turn".
        tts = getattr(self, "tts", None) or getattr(self.session, "tts", None)
        if tts is None or not hasattr(tts, "update_options"):
            logger.warning("no TTS to switch to %s", code)
            return
        try:
            tts.update_options(target_language_code=code)
            logger.info("switching voice to %s after %d agreeing turns", code, 2)
        except Exception:
            logger.exception("could not switch TTS language to %s", code)

    async def on_enter(self) -> None:
        # Registered here rather than in entrypoint() because this is the first
        # point at which self.session exists AND the agent has the tenant's
        # expert number to hand.
        self.session.on("error", self._on_session_error)
        self.session.say(self._tenant.greeting)

    def _on_session_error(self, ev) -> None:
        """A component died mid-call. Say so, then hand the caller to a person.

        This exists because of what silence costs. On 5 Sep the LLM answered 400
        on every turn and the caller heard the greeting and then nothing at all -
        no apology, no transfer, just a live line going nowhere until they hung
        up. That looked like a telephony fault and was a dependency version.

        Sync, because that is how session.on delivers; the work is spawned.
        """
        err = getattr(ev, "error", None)
        source = type(getattr(ev, "source", None)).__name__

        # LiveKit retries what it can. Transferring on a blip it was about to
        # recover from would end a call that was going to be fine.
        if getattr(err, "retryable", None) is True:
            logger.warning("recoverable %s error, letting it retry: %s", source, err)
            return

        logger.error("fatal %s error, rescuing the call: %s", source, err)
        asyncio.create_task(self._rescue_call())

    async def _rescue_call(self) -> None:
        """Apologise aloud, then transfer. Never raises, and runs once."""
        if self._rescuing:
            return  # a broken LLM fires this every turn; the caller needs one apology
        self._rescuing = True

        expert = self._tenant.expert_phone_number
        try:
            # say() goes straight to TTS and needs no LLM, which is the whole
            # reason it can still speak when the LLM is what failed - it is why
            # the greeting played on the silent calls.
            line = (
                "I'm sorry, I'm having trouble on my end. Let me put you through to someone."
                if expert
                else "I'm sorry, I'm having trouble on my end. Please call back in a few minutes."
            )
            await self.session.say(line)
        except Exception:
            # If TTS is what broke, the caller hears nothing - transfer anyway.
            logger.exception("could not speak the failure message")

        if not expert:
            logger.error("no expert number for tenant %s; caller left with an apology only",
                         self._tenant.tenant_id)
            return

        if not await self._warm_transfer(expert, self.session.history):
            logger.error("rescue transfer failed for tenant %s", self._tenant.tenant_id)

    def _set_language_directive(self, turn_ctx) -> None:
        """Name the language the model must WRITE in, every turn.

        The standing rule in the prompt ("speak in the language the caller
        uses") loses to the model's default. On a real call the voice switched
        to Tamil correctly and the caller still heard English: TTS was speaking
        Tamil-flavoured English because the model had written English.
        target_language_code says what language the text IS - it does not
        translate. So the model has to be told, in the turn, and by name.

        Replaced rather than appended, like the retrieval block above: a
        directive per turn would grow the prompt without bound and drown the
        conversation it is meant to steer.
        """
        name = language_name(self._language.current)
        turn_ctx.items[:] = [
            item for item in turn_ctx.items
            if _LANGUAGE_MARKER not in (getattr(item, "text_content", "") or "")
        ]
        turn_ctx.add_message(
            role="assistant",
            content=(
                f"{_LANGUAGE_MARKER} The caller is speaking {name}. Write your entire next "
                f"reply in {name}, in the {name} script. Do not reply in English unless the "
                f"caller is speaking English."
            ),
        )

    async def _retrieve(self, question: str) -> str:
        """The tenant's matching knowledge-base passages, or "" if none.

        Shared by the proactive lookup in on_user_turn_completed and by the
        search_knowledge_base tool, so the two can never drift into returning
        different things for the same question. Raises on transport failure;
        each caller decides what that means for its own path.
        """
        async with self._http.post(
            f"{BASE_URL}/api/voice/retrieve",
            json={"tenantId": self._tenant.tenant_id, "question": question},
            headers={"Authorization": f"Bearer {VOICE_WORKER_TOKEN}"},
            timeout=aiohttp.ClientTimeout(total=RETRIEVE_TIMEOUT_S),
        ) as res:
            if res.status != 200:
                raise RuntimeError(f"retrieve returned {res.status}: {await res.text()}")
            data = await res.json()
        return (data.get("contextBlock") or "").strip()

    def speculate(self, partial: str) -> None:
        """Start looking up a partial transcript before the caller has finished.

        Retrieval takes ~0.7s and used to sit entirely between the caller
        stopping and the agent answering. Starting it on a partial transcript
        moves most of that inside the time they are still speaking.

        Cheap to be wrong: a discarded guess costs one embedding call, and
        callers rarely reverse the sense of a sentence halfway through.
        """
        partial = (partial or "").strip()
        if len(partial) < MIN_SPECULATIVE_CHARS:
            return
        if self._speculative and self._speculative[0] == partial:
            return  # already looking this one up

        self._cancel_speculative()
        self._speculative = (partial, asyncio.create_task(self._retrieve(partial)))

    def _cancel_speculative(self) -> None:
        if self._speculative and not self._speculative[1].done():
            self._speculative[1].cancel()
        self._speculative = None

    async def _retrieve_for_turn(self, question: str) -> str:
        """The lookup for this turn, reusing a speculative one when it fits.

        Reused only when the final transcript STARTS WITH the speculated text:
        that means the caller carried on in the same direction, so the passages
        found for the prefix are the passages for the whole. If they changed
        tack, the guess is dropped and a fresh lookup runs - a wrong answer
        served quickly is worse than a right one served slowly.
        """
        spec = self._speculative
        self._speculative = None
        if spec:
            query, task = spec
            if question.startswith(query):
                try:
                    context = await task
                    logger.debug("used speculative retrieval (%d chars ahead)", len(question) - len(query))
                    return context
                except asyncio.CancelledError:
                    pass
                except Exception as err:
                    logger.warning("speculative retrieval failed: %s", err)
            elif not task.done():
                task.cancel()
        return await self._retrieve(question)

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        """Look the caller's question up BEFORE the model replies.

        Without this the agent needs two model round trips per answer: one to
        decide it should search, then another to answer once the result comes
        back - and no audio can start until both have finished. Retrieving here
        collapses that to one, and because the model then streams text
        immediately, the caller hears the first words far sooner.

        Best-effort: a failed or empty lookup just means no context is added.
        The tool below is still available for anything this does not cover, and
        the call must never fail because retrieval did.
        """
        question = (new_message.text_content or "").strip()

        # BEFORE the length check below, deliberately. A one-word Tamil "yes" is
        # still Tamil, and the reply to it has to be speakable.
        self._sync_tts_language(question)
        self._set_language_directive(turn_ctx)

        if len(question) < 3:
            return  # "yes", "ok" - nothing to look up

        try:
            context = await self._retrieve_for_turn(question)
        except Exception as err:
            logger.warning("proactive retrieval failed: %s", err)
            return
        if not context:
            return

        # Drop the previous turn's context before adding this one. turn_ctx is
        # the PERSISTENT chat context, so appending each turn's passages without
        # removing the last means every question carries all earlier lookups
        # too. The prompt grows by a full context block per turn, and the model
        # degrades into answering nothing at all - a call that works for the
        # first question or two and then goes quiet.
        turn_ctx.items[:] = [
            item
            for item in turn_ctx.items
            if _CONTEXT_MARKER not in (getattr(item, "text_content", "") or "")
        ]

        turn_ctx.add_message(
            role="assistant",
            content=(
                f"{_CONTEXT_MARKER} Information from this business's knowledge base "
                "that may answer the caller's question. Treat it as authoritative. "
                # Said here as well as in the prompt because this block arrives
                # every turn, immediately before the model answers, and framed as
                # authoritative it out-argues a standing rule sitting far above
                # it. A caller asking to book was getting told what the records
                # say ABOUT appointments instead of being offered one.
                "It cannot make or change a booking: if the caller wants an "
                "appointment, ignore this and use the appointment tools instead."
                f"\n\n{context}"
            ),
        )

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
            context = await self._retrieve_for_turn(question)
        except Exception:
            logger.exception("retrieve errored")
            return unavailable

        if not context:
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
        expert = self._tenant.expert_phone_number
        if not expert:
            logger.error(
                "transfer requested but tenant %s has no expert number and "
                "EXPERT_PHONE_NUMBER is unset",
                self._tenant.tenant_id,
            )
            return "Transfer is unavailable. Apologise and offer to take a callback number instead."

        logger.info("warm transfer requested (tenant=%s -> %s): %s",
                    self._tenant.tenant_id, expert, reason)
        if await self._warm_transfer(expert, ctx.session.history):
            return "Transfer completed."
        return "The transfer did not connect. Apologise and offer to take a callback number instead."

    async def _warm_transfer(self, expert: str, chat_ctx) -> bool:
        """Hand the caller to a person, briefing them with the transcript first.

        Shared by the tool above and by the failure path below, so a transfer
        the model asks for and a transfer we fall back to cannot drift into
        behaving differently.
        """
        # Beta namespace — see the pin in requirements.txt. Imported here so a
        # version mismatch breaks only the transfer path rather than stopping
        # the worker from starting and answering calls at all.
        from livekit.agents.beta.workflows import WarmTransferTask
        from livekit.protocol.sip import SIPOutboundConfig

        try:
            await WarmTransferTask(
                sip_call_to=expert,
                sip_connection=SIPOutboundConfig(
                    # .get() so a deployment without transfer configured fails
                    # this one path gracefully rather than crashing the call.
                    hostname=os.getenv("SIP_TRUNK_HOSTNAME", ""),
                    auth_username=os.getenv("SIP_AUTH_USERNAME", ""),
                    auth_password=os.getenv("SIP_AUTH_PASSWORD", ""),
                ),
                # Handing over the transcript is what makes this warm rather
                # than merely connected: the expert hears the context before
                # the caller is moved across.
                chat_ctx=chat_ctx,
                ringing_timeout=30.0,
            )
            return True
        except Exception:
            logger.exception("warm transfer failed")
            return False



class SchedulingAgent(MyBizCareAgent):
    """MyBizCareAgent plus booking, for tenants that have appointments on.

    A SUBCLASS rather than a flag inside the tools, because a tool the model can
    see is a tool it will eventually offer. A salon with no chairs configured
    must not be able to promise anyone an appointment, and the cheapest way to
    guarantee that is for the tool not to exist on the object.
    """

    def __init__(self, http: aiohttp.ClientSession, tenant: TenantContext):
        super().__init__(http, tenant)
        # What check_availability last read out. book_appointment resolves the
        # caller's choice against this rather than asking the model to echo an
        # ISO timestamp back - models mangle those, and a mangled timestamp is a
        # booking at the wrong hour that everyone believes is correct.
        self._offered: list[dict] = []

    def _resource_by_name(self, name: str | None) -> dict | None:
        """Loose match on a spoken name. Returns None when it is ambiguous or
        absent, so the caller is asked rather than guessed at."""
        if not name:
            return None
        wanted = name.strip().casefold()
        if not wanted:
            return None
        exact = [r for r in self._tenant.resources if r.get("name", "").casefold() == wanted]
        if exact:
            return exact[0]
        partial = [r for r in self._tenant.resources if wanted in r.get("name", "").casefold()]
        return partial[0] if len(partial) == 1 else None

    @function_tool
    async def check_availability(
        self,
        ctx: RunContext,
        day: str | None = None,
        resource_name: str | None = None,
        preferred_time: str | None = None,
    ) -> str:
        """Find free appointment times for this business.

        Args:
            day: The date the caller asked for, as YYYY-MM-DD. Omit for today.
            resource_name: The person, table or doctor they asked for, if they named one.
            preferred_time: The time they asked for, e.g. "5:30 pm". Omit if they
                said any time is fine - do NOT invent one.
        """
        resource = self._resource_by_name(resource_name)
        # Asked for by name and no such person. Booking them with somebody else
        # because the name did not match is the one outcome nobody forgives.
        if resource_name and resource is None:
            names = ", ".join(r.get("name", "") for r in self._tenant.resources if r.get("name"))
            return (f"There is nobody here called '{resource_name}'. Tell the caller that, read "
                    f"out who IS available - {names} - and ask which of them they would like. "
                    "Do not book anyone until they choose.")

        payload: dict = {
            "tenantId": self._tenant.tenant_id,
            "durationMinutes": self._tenant.appointment_minutes,
        }
        if day:
            payload["dayISO"] = day
        if resource:
            payload["resourceId"] = resource["id"]
        if preferred_time:
            payload["preferredTime"] = preferred_time

        try:
            async with self._http.post(
                f"{BASE_URL}/api/voice/appointments/availability",
                json=payload,
                headers={"Authorization": f"Bearer {VOICE_WORKER_TOKEN}"},
                timeout=aiohttp.ClientTimeout(total=RETRIEVE_TIMEOUT_S),
            ) as res:
                if res.status != 200:
                    logger.error("availability returned %s: %s", res.status, await res.text())
                    return ("Could not check the diary just now. Tell the caller you cannot see "
                            "the schedule and offer to transfer them to a person.")
                data = await res.json()
        except Exception:
            logger.exception("availability errored")
            return ("Could not check the diary just now. Tell the caller you cannot see the "
                    "schedule and offer to transfer them to a person.")

        if data.get("outOfWindow"):
            return (f"That is further ahead than this business takes bookings "
                    f"({data.get('windowDays')} days). Tell the caller that and offer a nearer date.")
        if data.get("past"):
            return "That date has passed. Ask the caller which upcoming day they meant."

        day_said = data.get("daySpoken") or "that day"

        # Three different things, and only one of them is "fully booked".
        if data.get("closed"):
            return (f"The business is CLOSED on {day_said}. Say exactly that - do not say it is "
                    "busy or fully booked - and ask which other day would suit them.")

        if data.get("outsideHours"):
            hours = data.get("hoursSpoken") or "our usual hours"
            return (f"That time is outside opening hours. On {day_said} the business is open "
                    f"{hours}. Say so, and offer a time inside those hours.")

        self._offered = data.get("options") or []
        if not self._offered:
            return (f"Everything is taken on {day_said} - the business is open, but there is "
                    "nothing left. Say that and ask whether another day would work.")

        lines = []
        if data.get("nearestTo"):
            # Said plainly, because presenting the nearest slot as though it were
            # the requested one is how a caller turns up at the wrong hour.
            lines.append(
                f"The caller asked for {data['nearestTo']} and that exact time is not free. "
                "These are the CLOSEST times available - say so before offering them."
            )
        else:
            lines.append("These times are free. Offer them to the caller in your own words.")

        if data.get("daySpoken"):
            lines.append(
                f"When you say the date, say it as \"{data['daySpoken']}\" - month then number, "
                "never the ordinal first."
            )

        if data.get("confirmDate"):
            lines.append(
                "This is more than a week away, so say the full date back to the caller and get "
                "them to confirm it before you book."
            )

        lines.append(
            "Then call book_appointment with the one they choose. Do not invent other times."
        )
        return "\n".join(lines) + "\n\n" + (data.get("spoken") or "")

    @function_tool
    async def book_appointment(
        self,
        ctx: RunContext,
        time_offered: str,
        customer_phone: str,
        customer_name: str | None = None,
        resource_name: str | None = None,
        party_size: int = 1,
        service: str | None = None,
    ) -> str:
        """Book one of the times check_availability just offered.

        Only call this AFTER reading the caller's phone number back to them and
        hearing them confirm it.

        Args:
            time_offered: The chosen time, exactly as it was offered, e.g. "5:30 pm".
            customer_phone: The caller's number, as they confirmed it.
            customer_name: Their name, if they gave one.
            resource_name: The person or table, if the caller chose one.
            party_size: How many people, for a table booking.
            service: What they are coming for, in a few words.
        """
        if not self._offered:
            return ("No times have been offered yet. Call check_availability first and offer "
                    "the caller a time before booking.")

        wanted = (time_offered or "").strip().casefold()
        resource = self._resource_by_name(resource_name)
        matches = [
            o for o in self._offered
            if o.get("spoken", "").casefold() == wanted
            and (resource is None or o.get("resourceId") == resource["id"])
        ]
        if not matches:
            return (f"'{time_offered}' was not one of the times offered. Read the available "
                    "times out again and ask the caller to pick one of them.")
        chosen = matches[0]

        try:
            async with self._http.post(
                f"{BASE_URL}/api/voice/appointments/book",
                json={
                    "tenantId": self._tenant.tenant_id,
                    "resourceId": chosen["resourceId"],
                    "startsAt": chosen["startsAt"],
                    "durationMinutes": self._tenant.appointment_minutes,
                    "customerPhone": customer_phone,
                    "customerName": customer_name,
                    "partySize": party_size,
                    "service": service,
                },
                headers={"Authorization": f"Bearer {VOICE_WORKER_TOKEN}"},
                timeout=aiohttp.ClientTimeout(total=RETRIEVE_TIMEOUT_S),
            ) as res:
                # 409 is the slot going while we were talking - a normal outcome
                # of a busy diary, not a fault. Say so plainly and re-offer.
                if res.status == 409:
                    detail = await res.json()
                    reason = detail.get("reason")
                    if reason == "too_soon":
                        return (f"That is too soon - this business needs at least "
                                f"{detail.get('leadMinutes')} minutes' notice. Tell the caller and "
                                "offer a later time.")
                    if reason == "out_of_window":
                        return (f"That is beyond how far ahead this business books "
                                f"({detail.get('windowDays')} days). Offer a nearer date.")
                    self._offered = []
                    return ("That time was just taken by someone else. Apologise, call "
                            "check_availability again, and offer what is left.")
                if res.status != 200:
                    logger.error("book returned %s: %s", res.status, await res.text())
                    return ("The booking could not be saved. Apologise, do NOT tell the caller "
                            "it is confirmed, and offer to transfer them to a person.")
                data = await res.json()
        except Exception:
            logger.exception("book errored")
            return ("The booking could not be saved. Apologise, do NOT tell the caller it is "
                    "confirmed, and offer to transfer them to a person.")

        self._offered = []
        who = chosen.get("resourceName") or ""
        return (f"Booked for {data.get('spoken')}{' with ' + who if who else ''}. "
                "Say that back once, in one short sentence, and then stop - do not "
                "re-confirm the time again or ask anything further about it.")


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
        # preemptive_generation is deliberately OFF. It speculatively generates
        # a reply from the partial transcript, then keeps it only if the chat
        # context is unchanged when the turn completes - see
        # agent_activity._user_turn_completed_task, which cancels the draft and
        # logs "chat context or tools have changed" otherwise. Injecting
        # retrieved passages in on_user_turn_completed changes the context on
        # EVERY turn, so the draft could never survive: it cost an extra LLM
        # call per turn, and contended for CPU on a single-vCPU container, for
        # nothing. Speculation happens on the RETRIEVAL instead (see
        # MyBizCareAgent.speculate), which does not touch the chat context.
        # Marks the caller "away" after this much silence. The default is 15s,
        # which leaves a caller listening to nothing for an uncomfortably long
        # time before anyone checks on them.
        user_away_timeout=SILENCE_PROMPT_SECONDS,
    )

    # Silence handling cannot live in the prompt: the model only ever sees
    # turns that happened, so it has no way to notice that nothing did. The
    # session emits "away" after user_away_timeout of silence; we nudge once,
    # give the caller SILENCE_HANGUP_SECONDS to answer, then hang up rather
    # than leaving a dead line open (which bills for the whole time).
    silence_timer: asyncio.Task | None = None

    async def _hang_up_if_still_silent() -> None:
        try:
            await asyncio.sleep(SILENCE_HANGUP_SECONDS)
        except asyncio.CancelledError:
            return  # caller spoke; cancelled by the listening/speaking branch
        logger.info("caller silent after nudge; ending call")
        try:
            # A brief sign-off first, so the line does not simply go dead.
            await session.say("I'll let you go for now. Do call back anytime.")
        except Exception:
            pass
        await ctx.delete_room()

    @session.on("user_state_changed")
    def _on_user_state(ev) -> None:
        nonlocal silence_timer
        if ev.new_state == "away":
            logger.info("caller went quiet; checking in")
            # generate_reply rather than say(): the check-in should sound like
            # this agent, in this call's language, not a canned line.
            session.generate_reply(
                instructions="The caller has gone quiet. Check whether they are still there, in one short line."
            )
            if silence_timer is None or silence_timer.done():
                silence_timer = asyncio.create_task(_hang_up_if_still_silent())
        else:
            # Any speech at all cancels the pending hangup.
            if silence_timer and not silence_timer.done():
                silence_timer.cancel()
                silence_timer = None

    # The subclass carries the booking tools; the base class does not have them
    # at all, so a tenant without appointments cannot be offered one.
    agent_cls = SchedulingAgent if tenant.appointments_enabled else MyBizCareAgent
    agent = agent_cls(http, tenant)

    # Kick the knowledge-base lookup off from partial transcripts, so most of
    # its round trip happens while the caller is still speaking rather than
    # after they stop.
    @session.on("user_input_transcribed")
    def _on_transcript(ev) -> None:
        if not ev.is_final:
            agent.speculate(ev.transcript)

    await session.start(agent=agent, room=ctx.room)


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
            # The health-check listener. Nothing consumes it - this is a worker
            # that dials OUT to LiveKit and serves no HTTP (see fly.toml) - but
            # it still binds, and the bind is fatal when the port is taken:
            #   OSError: [Errno 98] ... bind on address ('::', 8081) ... in use
            #   worker failed -> draining worker -> id: "unregistered"
            # which is a crash loop that never registers, so calls ring and
            # nobody answers while the container reports itself healthy.
            #
            # That happens when two workers share a network namespace - the
            # normal way being two containers in ONE Lightsail container
            # service, e.g. staging and production deployed together. Prefer a
            # service each; set WORKER_HTTP_PORT to give them different ports
            # when you cannot. 0 picks a free port, which is safe here only
            # because nothing checks this endpoint.
            port=int(os.getenv("WORKER_HTTP_PORT", "8081")),
        )
    )

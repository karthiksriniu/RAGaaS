"""Which Indian language a piece of text is written in, by script.

Its own module, and not because agent.py was crowded: agent.py imports aiohttp
and the whole livekit stack at import time, so anything living in it cannot be
tested without installing them. This is pure, so it can be.

NOTE: voice-worker/Dockerfile copies files individually - a new module here MUST
be added to it, or the image builds fine and every call dies on ImportError.
"""

from __future__ import annotations

# Sarvam's TTS takes a target_language_code and, per the plugin source, does NOT
# check it against the text it is given. Hand it Tamil with "en-IN" and the
# request simply produces nothing, which on a phone call is silence: the
# greeting plays in English, the caller answers in Tamil, and the agent never
# speaks again. Observed on a real call, 5 Sep 2026.
#
# Read from the Unicode block rather than asked of a model or a language API: it
# is exact for these scripts, costs nothing, and adds no latency to a turn that
# is already racing the caller's patience.
_SCRIPT_RANGES: list[tuple[str, int, int]] = [
    ("ta-IN", 0x0B80, 0x0BFF),   # Tamil
    ("ml-IN", 0x0D00, 0x0D7F),   # Malayalam
    ("te-IN", 0x0C00, 0x0C7F),   # Telugu
    ("kn-IN", 0x0C80, 0x0CFF),   # Kannada
    ("bn-IN", 0x0980, 0x09FF),   # Bengali
    ("gu-IN", 0x0A80, 0x0AFF),   # Gujarati
    ("pa-IN", 0x0A00, 0x0A7F),   # Gurmukhi
    ("or-IN", 0x0B00, 0x0B7F),   # Odia
    # Devanagari carries both Hindi and Marathi and the script cannot tell them
    # apart. Hindi is the overwhelmingly likelier caller, and being wrong here
    # means a Marathi speaker hears a Hindi voice - understandable, unlike
    # silence.
    ("hi-IN", 0x0900, 0x097F),
]


# Below this many Indian-script characters, the text is treated as English. One
# stray glyph in an otherwise English sentence should not flip the voice; three
# is the length of the shortest real word anyone says ("ஆம்" - yes).
_MIN_INDIC_CHARS = 3

# Switching AWAY from the language currently in use needs much more than that.
# Saaras with language="unknown" confuses the Indian scripts with each other -
# observed on one call calling a Tamil turn Telugu, and later Malayalam, off a
# word or two. Each wrong switch is a whole reply in a language the caller does
# not speak, so the bar for changing is deliberately far higher than the bar for
# reading a short answer.
_MIN_INDIC_CHARS_TO_SWITCH = 10

# ...and it has to say the same thing twice running. One confused turn is
# common; two consecutive confused turns agreeing on the same wrong language is
# not.
_TURNS_TO_SWITCH = 2


def detect_language_code(text: str, default: str = "en-IN") -> str:
    """The Sarvam language code for the script this text is written in.

    ANY meaningful amount of an Indian script wins over Latin, rather than a
    straight character-count majority against it. That looks biased and is
    deliberate, because the two ways of being wrong are not equally bad:

      * Tamil text sent as "en-IN" produced SILENCE on a real call - the failure
        this whole function exists to prevent.
      * English text sent as "ta-IN" is code-mixed input under an Indian
        language code, which is the ordinary case these voices are built for.

    It also matches how the reply is actually produced: the model mirrors the
    caller's language, so a caller who code-mixes any Tamil into a sentence gets
    a Tamil answer, even when most of the characters they used were Latin -
    which a majority rule would get backwards ("Kumaresan இன்று இருக்கிறாரா
    appointment" is 20 Latin letters against 16 Tamil, and is a Tamil sentence).

    Among Indian scripts it IS a majority, so one Devanagari character inside a
    Tamil sentence does not win.
    """
    counts: dict[str, int] = {}
    for ch in text or "":
        cp = ord(ch)
        for code, lo, hi in _SCRIPT_RANGES:
            if lo <= cp <= hi:
                counts[code] = counts.get(code, 0) + 1
                break
    if sum(counts.values()) < _MIN_INDIC_CHARS:
        return default
    return max(counts.items(), key=lambda kv: kv[1])[0]


# For telling the model which language to WRITE in. Setting the TTS language
# alone does nothing about this: target_language_code says what language the
# text already is, it does not translate. Observed on a real call - the voice
# switched to Tamil correctly and the caller still heard English, because the
# model had written English and Sarvam faithfully read it out.
LANGUAGE_NAMES: dict[str, str] = {
    "en-IN": "English",
    "ta-IN": "Tamil",
    "ml-IN": "Malayalam",
    "te-IN": "Telugu",
    "kn-IN": "Kannada",
    "bn-IN": "Bengali",
    "gu-IN": "Gujarati",
    "pa-IN": "Punjabi",
    "or-IN": "Odia",
    "hi-IN": "Hindi",
}


def language_name(code: str) -> str:
    return LANGUAGE_NAMES.get(code, "English")


class LanguageTracker:
    """Decides when the conversation has actually changed language.

    Detection per turn is noisy - the speech model genuinely mixes up the Indian
    scripts - so acting on every turn made the agent hop between Tamil, Telugu
    and Malayalam inside one call. This holds a candidate until it has been seen
    on `_TURNS_TO_SWITCH` turns in a row with enough script behind it each time.

    Deliberately asymmetric: staying put costs nothing, switching wrongly costs
    a whole reply the caller cannot understand.
    """

    def __init__(self, current: str = "en-IN") -> None:
        self.current = current
        self._candidate: str | None = None
        self._streak = 0

    def observe(self, text: str) -> str | None:
        """Returns the language to switch to, or None to stay put."""
        counts: dict[str, int] = {}
        for ch in text or "":
            cp = ord(ch)
            for code, lo, hi in _SCRIPT_RANGES:
                if lo <= cp <= hi:
                    counts[code] = counts.get(code, 0) + 1
                    break

        total = sum(counts.values())
        candidate = max(counts.items(), key=lambda kv: kv[1])[0] if counts else "en-IN"

        # Not enough evidence to mean anything either way. A short "ok" or a
        # number must not reset a streak OR start one.
        if candidate != "en-IN" and total < _MIN_INDIC_CHARS_TO_SWITCH:
            return None
        # Evidence of English means LATIN LETTERS, not characters. A read-back
        # phone number is ten characters and zero letters, and treating it as
        # "they have switched to English" would drop a Tamil conversation into
        # English the moment the caller gave their number - which is exactly
        # when they are most likely to be asked for it.
        if candidate == "en-IN":
            latin = sum(1 for ch in (text or "") if ch.isascii() and ch.isalpha())
            if latin < _MIN_INDIC_CHARS_TO_SWITCH:
                return None

        if candidate == self.current:
            self._candidate, self._streak = None, 0
            return None

        if candidate == self._candidate:
            self._streak += 1
        else:
            self._candidate, self._streak = candidate, 1

        if self._streak >= _TURNS_TO_SWITCH:
            self.current = candidate
            self._candidate, self._streak = None, 0
            return self.current
        return None

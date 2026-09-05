"""Guards the script -> Sarvam language-code mapping.

The failure it prevents is not a wrong answer, it is SILENCE: Sarvam's TTS takes
a target_language_code and does not check it against the text, so Tamil sent
with "en-IN" simply produces nothing and the caller hears the agent die
mid-conversation. Observed on a real call on 5 Sep 2026.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from lang import detect_language_code  # noqa: E402

failures = []


def check(text, expected, why):
    got = detect_language_code(text)
    if got != expected:
        failures.append(f"{why}: expected {expected}, got {got} for {text!r}")


# The exact call that failed: "is Kumaresan available today?"
check("குமரேசன் இன்று இருக்கிறாரா?", "ta-IN", "Tamil question")
check("നമസ്കാരം, അപ്പോയിന്റ്മെന്റ് വേണം", "ml-IN", "Malayalam")
check("क्या आज अपॉइंटमेंट मिलेगा", "hi-IN", "Hindi")
check("ఈరోజు అపాయింట్‌మెంట్ దొరుకుతుందా", "te-IN", "Telugu")
check("ಇಂದು ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಸಿಗುತ್ತದೆಯೇ", "kn-IN", "Kannada")
check("আজ অ্যাপয়েন্টমেন্ট পাওয়া যাবে", "bn-IN", "Bengali")

# English stays English rather than being switched by a stray character.
check("Is Kumaresan available today?", "en-IN", "English")
check("", "en-IN", "empty transcript")
check("   ", "en-IN", "whitespace only")
check("9840816035", "en-IN", "digits only")

# Code-mixing is the norm on these calls: a Tamil sentence with an English word
# in it is still Tamil, and switching voice on one token would make the agent
# stutter between languages mid-call.
# 20 Latin letters against 16 Tamil, and unmistakably a Tamil sentence. A
# straight majority against Latin would call this English and go silent.
check("Kumaresan இன்று இருக்கிறாரா appointment", "ta-IN", "Tamil with English words")
# A short Tamil word still switches: the model will answer in Tamil.
check("I need an appointment ஆம்", "ta-IN", "English with a Tamil word")
# But a single stray glyph does not - otherwise the voice flaps mid-call.
check("Is Kumaresan available ஆ", "en-IN", "one stray Indic character")
# Among Indian scripts it is a majority, so one foreign glyph does not win.
check("இன்று இருக்கிறாரா क", "ta-IN", "Tamil with one Devanagari character")



# --- switching, not just detecting -------------------------------------------
# On a real call the agent hopped Tamil -> Telugu -> Malayalam inside one
# conversation, off a word or two, because every turn was acted on. Each wrong
# switch is a whole reply the caller cannot understand.
from lang import LanguageTracker  # noqa: E402

TAMIL = "இன்று அப்பாயிண்ட்மென்ட் கிடைக்குமா என்று சொல்லுங்கள்"
TELUGU = "ఈరోజు అపాయింట్‌మెంట్ దొరుకుతుందా చెప్పండి"
ENGLISH = "Could you tell me if an appointment is available today please"


def track(seq, start="en-IN"):
    t = LanguageTracker(start)
    return [t.observe(x) for x in seq], t.current


# One turn is never enough.
sw, cur = track([TAMIL])
if sw != [None] or cur != "en-IN":
    failures.append(f"switched on a single turn: {sw} -> {cur}")

# Two agreeing turns are.
sw, cur = track([TAMIL, TAMIL])
if cur != "ta-IN":
    failures.append(f"did not switch after two agreeing Tamil turns: {sw} -> {cur}")

# The exact observed failure: one confused turn between two good ones must not
# move the conversation to Telugu.
sw, cur = track([TAMIL, TELUGU, TAMIL, TAMIL])
if cur != "ta-IN":
    failures.append(f"a single confused turn changed the language: {sw} -> {cur}")

# Short answers carry no evidence and must neither switch nor break a streak.
sw, cur = track([TAMIL, "ஆம்", TAMIL])
if cur != "ta-IN":
    failures.append(f"a short answer broke the streak: {sw} -> {cur}")

# A phone number is not someone switching to English.
t = LanguageTracker("ta-IN")
t.observe("9840816035"); t.observe("9840816035")
if t.current != "ta-IN":
    failures.append("a phone number switched the language to English")

# A genuine, sustained switch back to English still works.
sw, cur = track([ENGLISH, ENGLISH], start="ta-IN")
if cur != "en-IN":
    failures.append(f"could not switch back to English: {sw} -> {cur}")

if failures:
    print("FAIL")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("language switching OK")

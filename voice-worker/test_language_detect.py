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

if failures:
    print("FAIL")
    for f in failures:
        print(" -", f)
    sys.exit(1)
print("language detection OK")

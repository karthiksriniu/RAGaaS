"""Guards the Sarvam TTS options the worker constructs with.

A value outside the plugin's accepted range raises in the TTS constructor,
which happens per call - so the worker registers fine, every call rings, and
nobody is ever answered. That failure looks like a telephony problem and cost a
deploy cycle to find. These bounds are cheap to assert and would have caught it.
"""
import os, sys, inspect, re
os.environ.setdefault("SARVAM_API_KEY", "sk_test")
from livekit.plugins import sarvam
import livekit.plugins.sarvam.tts as tts_mod

failures = []

# The floor the plugin enforces, read from the plugin itself rather than
# hardcoded, so a future version tightening it fails loudly here.
src = inspect.getsource(tts_mod)
m = re.search(r"min_buffer_size must be between (\d+) and (\d+)", src)
lo, hi = (int(m.group(1)), int(m.group(2))) if m else (30, 200)

agent_src = open(os.path.join(os.path.dirname(__file__), "agent.py")).read() \
    if os.path.exists(os.path.join(os.path.dirname(__file__), "agent.py")) else ""
used = re.search(r"min_buffer_size=(\d+)", agent_src)
if used:
    v = int(used.group(1))
    if not (lo <= v <= hi):
        failures.append(f"agent.py uses min_buffer_size={v}, outside the plugin's {lo}-{hi}")
    else:
        print(f"  min_buffer_size={v} within plugin bounds {lo}-{hi}")

codec = re.search(r'output_audio_codec="([^"]+)"', agent_src)
if codec and codec.group(1) not in tts_mod.ALLOWED_OUTPUT_AUDIO_CODECS:
    failures.append(f"output_audio_codec={codec.group(1)!r} not in {tts_mod.ALLOWED_OUTPUT_AUDIO_CODECS}")
elif codec:
    print(f"  output_audio_codec={codec.group(1)!r} accepted")

# Every preset the dashboard can select must actually construct.
for spk, pace, temp in [("priya",0.95,0.8),("simran",1.05,0.9),("ishita",0.9,0.6),
                        ("rahul",0.95,0.8),("rohan",1.05,0.9),("shubh",0.9,0.6)]:
    try:
        sarvam.TTS(target_language_code="en-IN", model="bulbul:v3", speaker=spk,
                   pace=pace, temperature=temp,
                   output_audio_codec=codec.group(1) if codec else "linear16",
                   min_buffer_size=int(used.group(1)) if used else 30)
    except Exception as e:
        failures.append(f"preset {spk}: {e}")

if failures:
    print("\nFAILED:"); [print("  -", f) for f in failures]; sys.exit(1)
print("  all six voice presets construct")

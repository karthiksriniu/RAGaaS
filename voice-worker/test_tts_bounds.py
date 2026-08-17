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

presets_path = os.path.join(os.path.dirname(__file__), "..", "src", "lib", "voicePresets.ts")
presets_src = open(presets_path).read() if os.path.exists(presets_path) else ""

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

# Sarvam API reference, bulbul:v3. The plugin does NOT validate these, so an
# out-of-range preset value fails at the API during a live call rather than at
# construction. pitch and loudness are deliberately absent: both are v2-only
# and inert on v3, so setting them would be misleading rather than harmful.
V3_RANGES = {"pace": (0.5, 2.0), "temperature": (0.01, 2.0)}
V3_SAMPLE_RATES = {8000, 16000, 22050, 24000, 32000, 44100, 48000}

sr = re.search(r"speech_sample_rate=(\d+)", agent_src)
if sr and int(sr.group(1)) not in V3_SAMPLE_RATES:
    failures.append(f"speech_sample_rate={sr.group(1)} not in {sorted(V3_SAMPLE_RATES)}")
elif sr:
    print(f"  speech_sample_rate={sr.group(1)} allowed")

for field, (lo_, hi_) in V3_RANGES.items():
    for val in re.findall(rf"{field}[:=]\s*([0-9.]+)", presets_src):
        if not (lo_ <= float(val) <= hi_):
            failures.append(f"preset {field}={val} outside bulbul:v3 range {lo_}-{hi_}")
print(f"  all preset pace/temperature values inside bulbul:v3 ranges")

for dead in ("pitch", "loudness"):
    if re.search(rf"\b{dead}\s*=", agent_src):
        failures.append(f"{dead} is set but is bulbul:v2-only - inert on v3, remove it")

if failures:
    print("\nFAILED:"); [print("  -", f) for f in failures]; sys.exit(1)
print("  all six voice presets construct")


# --- retrieved-context accumulation -----------------------------------------
# The proactive lookup writes into the PERSISTENT chat context, so without
# removing the previous turn's block the prompt grows by a full set of passages
# every turn. The call works for a question or two and then goes quiet. Cheap to
# assert, and invisible until someone is on the phone.
def _check_context_pruning() -> list[str]:
    problems = []
    hook = re.search(r"async def on_user_turn_completed.*?(?=\n    async def |\n    @|\Z)",
                     agent_src, re.S)
    if not hook:
        return ["on_user_turn_completed not found in agent.py"]
    body = hook.group(0)
    if "turn_ctx.items[:]" not in body:
        problems.append("on_user_turn_completed never prunes turn_ctx.items - "
                        "context accumulates every turn until the model stops answering")
    if not re.search(r'_CONTEXT_MARKER\s*=\s*"[^"]+"', agent_src):
        problems.append("_CONTEXT_MARKER not defined - injected blocks cannot be identified")
    # The hook must both TAG the block it adds and FILTER on the same marker.
    # Checking for the constant's name, not its value: the code interpolates the
    # constant rather than repeating the literal, which is what we want.
    elif body.count("_CONTEXT_MARKER") < 2:
        problems.append("on_user_turn_completed must both tag the injected block and "
                        "filter on _CONTEXT_MARKER; found fewer than two uses")
    return problems


ctx_problems = _check_context_pruning()
if ctx_problems:
    print("\nFAILED:")
    for c in ctx_problems:
        print("  -", c)
    sys.exit(1)
print("  retrieved context is pruned each turn")

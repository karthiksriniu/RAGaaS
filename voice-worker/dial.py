"""Place an outbound test call so the agent can be exercised over real telephony.

Why this exists: Vobiz trial accounts allow OUTBOUND (termination) trunks but
refuse to bind a number to an inbound trunk until the account is upgraded with
KYC and a paid DID. So nobody can dial in yet. Dialling *out* uses the same
media path, the same worker, and the same Sarvam pipeline — it just starts from
our side. Latency, barge-in and warm transfer are all measurable this way, which
means Phase A does not have to wait on an account upgrade.

Usage — the worker must already be running in another terminal:

    python agent.py dev          # terminal 1
    python dial.py +9198XXXXXXXX # terminal 2

The agent is dispatched into the room automatically because the worker
registers without an agent_name, so it accepts any room LiveKit creates.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time

from dotenv import load_dotenv
from livekit import api

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# The LiveKit outbound trunk that fronts Vobiz. Overridable so this still works
# if the trunk is ever recreated.
OUTBOUND_TRUNK_ID = os.getenv("LIVEKIT_OUTBOUND_TRUNK_ID", "ST_TibCXaURwWFu")


async def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: python dial.py +91XXXXXXXXXX")
    to_number = sys.argv[1].strip()
    if not to_number.startswith("+"):
        sys.exit("number must be E.164, e.g. +919840816035")

    room = f"call-outbound-{int(time.time())}"

    lk = api.LiveKitAPI(
        url=os.environ["LIVEKIT_URL"].replace("wss://", "https://"),
        api_key=os.environ["LIVEKIT_API_KEY"],
        api_secret=os.environ["LIVEKIT_API_SECRET"],
    )
    try:
        print(f"dialling {to_number} into room {room} ...")
        participant = await lk.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                sip_trunk_id=OUTBOUND_TRUNK_ID,
                sip_call_to=to_number,
                room_name=room,
                participant_identity="caller",
                participant_name="Test caller",
                # Block until the callee actually answers, so a failure to
                # connect surfaces here rather than as silence on the line.
                wait_until_answered=True,
            )
        )
        print("answered. participant:", participant.participant_identity)
        print("the agent should now be speaking — hang up when finished.")
    except Exception as e:
        print("call failed:", type(e).__name__, e)
        print(
            "\nIf this is a Vobiz permission error, outbound may also need the "
            "account upgrade. If it rings but nobody speaks, the worker is not "
            "running or did not get dispatched into the room."
        )
    finally:
        await lk.aclose()


if __name__ == "__main__":
    asyncio.run(main())

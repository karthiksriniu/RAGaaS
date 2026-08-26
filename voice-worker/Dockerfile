# livekit-agents 1.6 targets modern Python; 3.11 is the safe floor here and
# matches what the LiveKit examples are tested against. (The dev machine has
# only 3.9, which is why the worker is built and run in a container.)
FROM python:3.11-slim

# libgomp1 is required by the silero VAD wheel (ONNX runtime); without it the
# worker imports fine and then fails at first audio frame.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py .

# Downloads the silero VAD weights at build time so the first call doesn't pay
# for it, and so a cold start can't be blocked by a model-download failure.
RUN python agent.py download-files

# "start" is the production mode; "dev" enables hot reload and is not wanted here.
CMD ["python", "agent.py", "start"]

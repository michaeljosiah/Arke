# Spike-only (ADR-0002): a no-auth local Omnigent control-plane server for the live conformance run.
# pip cannot resolve omnigent's deps — uv can; this is the documented install path.
#
#   docker build -f packages/adapter-omnigent/spike/Dockerfile -t arke-omnigent-spike .
#   docker run -d --name arke-omnigent -p 6767:6767 arke-omnigent-spike
#   curl http://127.0.0.1:6767/v1/sessions?limit=1     # → 200, no auth
#
# This stands up the CONTROL PLANE only. Executing a real turn additionally needs a runner/host
# bound to the session (`omnigent host`) plus the harness (e.g. Claude Code) and a model API key —
# without one, POST /v1/sessions/{id}/events returns 503 runner_unavailable. See ADR-0002.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git tmux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv && uv tool install omnigent
ENV PATH=/root/.local/bin:$PATH \
    OMNIGENT_LOCAL_SINGLE_USER=1 \
    OMNIGENT_AUTH_ENABLED=0
EXPOSE 6767
CMD ["omnigent", "server", "--host", "0.0.0.0", "--port", "6767"]

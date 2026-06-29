# Spike-only (ADR-0002): a no-auth local Omnigent server + host with the OpenCode harness, for the
# live conformance run. pip cannot resolve omnigent's deps — uv can; this is the documented path.
#
#   docker build -f packages/adapter-omnigent/spike/Dockerfile -t arke-omnigent-spike .
#   docker run -d --name arke-omnigent -p 6767:6767 \
#       -v arke-omnigent-data:/root/.omnigent \
#       -v "<your>/opencode/auth.json:/root/.local/share/opencode/auth.json:ro" \
#       arke-omnigent-spike
#   docker exec -d arke-omnigent sh -c 'omni host --server http://localhost:6767'   # bind a runner
#   curl http://127.0.0.1:6767/v1/sessions?limit=1                                   # → 200, no auth
#
# `omnigent server` is the CONTROL PLANE only; a turn executes on a runner bound via `omni host`,
# which carries the OpenCode harness + the model credential mounted above. Without a runner,
# POST /v1/sessions/{id}/events returns 503 runner_unavailable. See ADR-0002.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git tmux ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
# Omnigent control plane + host (uv resolves its deps; pip cannot)
RUN pip install --no-cache-dir uv && uv tool install omnigent
# OpenCode harness, symlinked onto the system PATH so the Omnigent host detects it
RUN curl -fsSL https://opencode.ai/install | bash \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode
ENV PATH=/usr/local/bin:/root/.local/bin:$PATH \
    OMNIGENT_LOCAL_SINGLE_USER=1 \
    OMNIGENT_AUTH_ENABLED=0
EXPOSE 6767
CMD ["omnigent", "server", "--host", "0.0.0.0", "--port", "6767"]

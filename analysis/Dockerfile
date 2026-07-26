# Analysis sidecar: Praat (parselmouth) + numpy pinned via uv.lock.
# Built as `voicetrain-analysis`; the Go server runs it per recording:
#   docker run --rm -v <data-dir>:/data:ro voicetrain-analysis \
#     /data/recordings/YYYY/MM/<id>.wav --target-min-hz 165 --target-max-hz 220
#
# The builder stage carries a full toolchain because praat-parselmouth
# ships no linux/arm64 wheels — on Apple silicon it compiles Praat from
# source (slow once, cached in the layer until uv.lock changes). On
# amd64 the wheel is used and the toolchain sits idle.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake ninja-build \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY analyze.py ./
ENTRYPOINT ["/app/.venv/bin/python", "analyze.py"]

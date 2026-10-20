# Backup destination: the server backs itself up here hourly, when there's
# something new (`--backup-dir`, `--backup-share`).
# export VOICETRAIN_BACKUP_DIR := "/Volumes/your-nas/Backup/voicetrain"
# export VOICETRAIN_BACKUP_SHARE := "smb://your-nas/share"

# Run the app (serves the embedded UI at http://localhost:8100)
run:
    go run ./cmd/voicetrain

# Run the app with the analyzer native instead of in docker: identical
# results, about 3.5x faster on Apple silicon (the arm64 image compiles
# Praat from source, macOS gets parselmouth's wheel). Needs uv.
run-native:
    uv sync --frozen --project analysis --quiet
    go run ./cmd/voicetrain --analysis-command "$PWD/analysis/.venv/bin/python $PWD/analysis/analyze.py"

# Run the backend for the dev loop (pair with `just ui-dev`)
dev:
    go run ./cmd/voicetrain --debug

# Run the Vite dev server (http://localhost:3002, proxies /api to :8100)
ui-dev:
    cd ui && pnpm install && pnpm dev

# Build the frontend into ui/dist
ui-build:
    cd ui && pnpm install && pnpm build

# Build the binary with version info (frontend included via go:embed)
build:
    #!/usr/bin/env bash
    set -euo pipefail
    just ui-build
    GIT_COMMIT=$(git rev-parse --short HEAD)
    BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    LDFLAGS="-X github.com/jazware/mono/packages/version.GitCommit=${GIT_COMMIT} -X github.com/jazware/mono/packages/version.BuildTime=${BUILD_TIME}"
    echo "Building voicetrain (commit: ${GIT_COMMIT})..."
    go build -ldflags "${LDFLAGS}" -o bin/voicetrain ./cmd/voicetrain

# Build the amd64 image (the static server and analyze.py on the runtime base) and push it to ghcr.io/jazware/mono/voicetrain; PUSH=0 builds only. Prints the ref (build/oci-image.sh)
image-push tag=`git rev-parse --short=12 HEAD`:
    build/oci-image.sh {{tag}}

# Rebuild the runtime base (the Dockerfile's runtime-base stage: Python 3.12, parselmouth, numpy) and pin it in build/oci-base
image-base:
    build/oci-image.sh base

# Build the acoustic-analysis sidecar image (uv-locked Python + Praat)
analysis-build:
    docker build -t voicetrain-analysis analysis

# Re-lock analysis sidecar dependencies after editing its pyproject.toml
analysis-lock:
    cd analysis && uv lock

# Analyze one WAV ad hoc, printing the JSON (path relative to ~)
analyze wav:
    docker run --rm -v "$HOME:/data:ro" voicetrain-analysis "/data/{{wav}}"

# Back up recordings + a consistent DB snapshot to the NAS by hand
# (the running server also does this itself, hourly)
backup:
    bash scripts/backup.sh

# Run the Go and UI tests (`analysis-test` covers the Python side)
test:
    go test ./...
    cd ui && pnpm install && pnpm test

# Run the analyzer's ground-truth tests inside the analysis image
analysis-test:
    docker run --rm -v "$PWD/analysis:/src:ro" -w /src --entrypoint /app/.venv/bin/python voicetrain-analysis -m unittest discover -s tests -t .

# Everything a change should pass: tests, typecheck + build, analyzer tests
check: test ui-build analysis-test

# Format code
fmt:
    go fmt ./...

# Run linter
lint:
    golangci-lint run

# Clean up built binaries
clean:
    rm -rf bin/

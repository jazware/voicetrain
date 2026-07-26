# Jaz's NAS; the server backs itself up here (hourly, only when new).
# export VOICETRAIN_BACKUP_DIR := "/Volumes/your-nas/Backup/voicetrain"
# export VOICETRAIN_BACKUP_SHARE := "smb://your-nas/share"

# Run the app (serves the embedded UI at http://localhost:8100)
run:
    go run ./cmd/voicetrain

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

# Run tests
test:
    go test ./...

# Format code
fmt:
    go fmt ./...

# Run linter
lint:
    golangci-lint run

# Clean up built binaries
clean:
    rm -rf bin/

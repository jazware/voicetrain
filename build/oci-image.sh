#!/usr/bin/env bash
# The amd64 image without a Docker build (scripts/oci/README.md): the static
# voicetrain server (UI embedded) and analysis/analyze.py on voicetrain's
# runtime base (the Dockerfile's runtime-base stage: Python 3.12 with
# parselmouth and numpy), pinned by digest in build/oci-base.
#
#   build/oci-image.sh [tag]        (or: just image-push [tag])
#   build/oci-image.sh base         (or: just image-base) rebuild + pin the base
#
# Builds the committed tree; uncommitted changes under packages/voicetrain,
# telemetry or version stop it (DIRTY=1 builds them as <sha>-dirty). The tag
# defaults to the committed revision's 12-char id. PUSH=0 builds without
# pushing.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../../../scripts/oci/lib.sh"
image=ghcr.io/jazware/mono/voicetrain

if [ "${1:-}" = base ]; then
  oci_init voicetrain "$image"
  oci_base_push "$here/Dockerfile" runtime-base "$here/oci-base"
  exit
fi

oci_tracked "$image" "${1:-}" "$0" "$@"
oci_init voicetrain "$image" "${1:-}"
oci_base "$here/oci-base"
srcs=(packages/voicetrain packages/telemetry packages/version)
oci_export "${srcs[@]}"
oci_npm packages/voicetrain/ui
oci_ui_into packages/voicetrain/ui/dist

_oci_phase_start go
epoch=$(oci_mtime "${srcs[@]}")
bin=$OCI_OUT/voicetrain
(cd "$OCI_SRC/packages/voicetrain" && GOWORK=off CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -buildvcs=false \
  -ldflags "-s -w -X github.com/jazware/mono/packages/version.GitCommit=${OCI_REV:0:12} -X github.com/jazware/mono/packages/version.BuildTime=$(_oci_utc "$epoch")" \
  -o "$bin" ./cmd/voicetrain)
_oci_output binary_bytes "$(wc -c <"$bin" | tr -d ' ')"
_oci_phase_end go

oci_layer app "$epoch" "$bin:/usr/local/bin/voicetrain"
oci_layer analyzer "$(oci_mtime packages/voicetrain/analysis)" \
  "$OCI_SRC/packages/voicetrain/analysis/analyze.py:/app/analysis/analyze.py"
# The base's user (65532), env and /var/lib/voicetrain stay; settings come
# from VOICETRAIN_* env in the stack.
oci_push --entrypoint /usr/local/bin/voicetrain --workdir /var/lib/voicetrain

# voicetrain's runtime base: everything but the server and the analyzer
# script. build/oci-image.sh puts the static voicetrain binary (UI
# embedded) and analysis/analyze.py on it (pinned by digest in
# build/oci-base, which `just image-base` rewrites); there is no Docker
# build of the app itself.
#
# The analyzer's Python: the same CPython minor and the same wheels as
# analysis/uv.lock (pkg/analysis's TestBasePinsMatchLock checks the URLs
# and hashes below against it). Base stages get no build context, so the
# pins live here rather than in a copied lockfile.
FROM python:3.12-slim-bookworm AS runtime-base
RUN printf '%s\n' \
      'numpy @ https://files.pythonhosted.org/packages/65/af/aa78d1a88805456e212b65461354cd943197fb9acecc4c90fd12295123a3/numpy-2.5.3-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl --hash=sha256:b7e18c623bb5c95acb3b3328861272816ba199fb531921c5d6d0b675f1fde9e3' \
      'praat-parselmouth @ https://files.pythonhosted.org/packages/9f/5f/e4495c8ac6ed26a1f16a34269c12579532e747b4ac5db57123093904f2ec/praat_parselmouth-0.4.7-cp312-cp312-manylinux2014_x86_64.manylinux_2_17_x86_64.whl --hash=sha256:6b5fbfab5b3cd4f6146e6145559d5d7c231384d88f942e0c8c0e791058aa61a5' \
      > /tmp/requirements.txt \
    && pip install --no-cache-dir --no-deps --require-hashes -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && python3 -c 'import parselmouth, numpy; print(parselmouth.PRAAT_VERSION, numpy.__version__)' \
    && groupadd --system --gid 65532 voicetrain \
    && useradd --system --uid 65532 --gid voicetrain --no-create-home --home-dir /var/lib/voicetrain voicetrain \
    && mkdir -p /var/lib/voicetrain /app/analysis && chown 65532:65532 /var/lib/voicetrain
USER 65532:65532
ENV VOICETRAIN_DATA_DIR=/var/lib/voicetrain \
    VOICETRAIN_LISTEN_ADDRESS=0.0.0.0:8100 \
    VOICETRAIN_ANALYSIS_COMMAND="python3 /app/analysis/analyze.py" \
    HOME=/var/lib/voicetrain \
    PYTHONDONTWRITEBYTECODE=1
EXPOSE 8100

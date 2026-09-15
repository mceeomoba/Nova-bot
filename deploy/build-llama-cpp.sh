#!/usr/bin/env bash
# Builds llama.cpp's llama-server binary if it doesn't already exist at
# the path deploy/llama-qwen3-4b.service and deploy/llama-vision.service
# expect. Safe to re-run — skips the build entirely if the binary is
# already there and executable.
set -euo pipefail

LLAMA_DIR="/root/Downloads/AI-VM/llama.cpp"
LLAMA_BIN="$LLAMA_DIR/build/bin/llama-server"

if [ -x "$LLAMA_BIN" ]; then
  echo "Already built: $LLAMA_BIN"
  "$LLAMA_BIN" --version || true
  exit 0
fi

if [ ! -d "$LLAMA_DIR" ]; then
  echo "ERROR: $LLAMA_DIR does not exist. Expected the llama.cpp source clone there." >&2
  exit 1
fi

echo "No built binary found at $LLAMA_BIN — building now."

if ! command -v cmake >/dev/null 2>&1; then
  echo "cmake not found, installing build tools (requires root/sudo)..."
  apt-get update -y
  apt-get install -y build-essential cmake
fi

cd "$LLAMA_DIR"
# CPU-only build. If this VM actually has a GPU, tell me and I'll adjust
# this to add -DGGML_CUDA=ON (or the relevant backend flag) instead —
# I'm assuming CPU-only based on this being a general-purpose Alibaba
# Cloud VM (ecs.g6.large-class instance), not a GPU one, but I haven't
# verified that against your actual instance type.
# -t llama-server matches llama.cpp's own current README exactly
# (checked live, not from memory) — builds only the server binary
# instead of every tool (llama-cli, llama-quantize, etc.), which is
# faster and is all these systemd units actually need.
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -t llama-server -j"$(nproc)"

if [ -x "$LLAMA_BIN" ]; then
  echo "Build succeeded: $LLAMA_BIN"
  "$LLAMA_BIN" --version
else
  echo "ERROR: build finished but $LLAMA_BIN still doesn't exist — check the build output above for the actual binary location, llama.cpp's output layout does shift between versions." >&2
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

LLAMA_BIN="${LLAMA_BIN:-/root/Downloads/AI-VM/llama.cpp/build/bin/llama-server}"
MODEL_ROOT="${MODEL_ROOT:-/root/Downloads/AI-VM}"
VISION_KEY_FILE="${VISION_KEY_FILE:-/etc/automaton/vision-api-key}"

test -x "$LLAMA_BIN"
test -r "$MODEL_ROOT/qwen3-4b/Qwen3-4B-Q4_K_M.gguf"
test -r "$MODEL_ROOT/vision/SmolVLM2-500M-Video-Instruct-Q8_0.gguf"
test -r "$MODEL_ROOT/vision/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf"
test -r "$VISION_KEY_FILE"

mkdir -p /var/log/automaton
nohup "$LLAMA_BIN" -m "$MODEL_ROOT/qwen3-4b/Qwen3-4B-Q4_K_M.gguf" \
  --alias qwen3-4b --host 127.0.0.1 --port 8080 --ctx-size 8192 --parallel 4 \
  > /var/log/automaton/qwen.log 2>&1 &
nohup "$LLAMA_BIN" -m "$MODEL_ROOT/vision/SmolVLM2-500M-Video-Instruct-Q8_0.gguf" \
  --mmproj "$MODEL_ROOT/vision/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf" \
  --alias smolvlm2-500m --host 127.0.0.1 --port 8081 --ctx-size 4096 --parallel 2 \
  --api-key-file "$VISION_KEY_FILE" --no-ui \
  > /var/log/automaton/vision.log 2>&1 &

#!/usr/bin/env bash
# Adds an 8GB swap file as a safety net against transient memory spikes
# (a self-mod rebuild, a burst of sandboxed executions) getting
# OOM-killed instead of just slowing down. Safe to re-run — does
# nothing if swap is already configured.
set -euo pipefail

SWAPFILE="/swapfile"
SWAPSIZE_GB=8

if swapon --show | grep -q "$SWAPFILE"; then
  echo "Swap already active at $SWAPFILE:"
  swapon --show
  exit 0
fi

if [ -f "$SWAPFILE" ]; then
  echo "WARNING: $SWAPFILE exists but isn't active as swap. Not touching an existing file — check it manually." >&2
  exit 1
fi

echo "Creating ${SWAPSIZE_GB}GB swap file at $SWAPFILE..."
fallocate -l "${SWAPSIZE_GB}G" "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAPSIZE_GB * 1024))
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE"
swapon "$SWAPFILE"

if ! grep -q "^$SWAPFILE " /etc/fstab; then
  echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
  echo "Added to /etc/fstab so it survives reboot."
fi

echo "Done:"
swapon --show
free -h

const DEFAULT_MAX_TOKENS = 1024;
const MAX_INFERENCE_TOKENS = 8192;

/** Normalize caller input before it reaches pricing or an inference provider. */
export function parseMaxTokens(value: unknown): number | null {
  if (value === undefined) return DEFAULT_MAX_TOKENS;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < 1 || value > MAX_INFERENCE_TOKENS) return null;
  return value;
}

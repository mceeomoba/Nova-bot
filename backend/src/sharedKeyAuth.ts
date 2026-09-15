import { timingSafeEqual } from "node:crypto";

/** Compare a request-provided shared secret without early-exit byte checks. */
export function constantTimeSecretEqual(candidate: unknown, expected: unknown): boolean {
  if (typeof candidate !== "string" || typeof expected !== "string" || candidate.length === 0 || expected.length === 0) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}

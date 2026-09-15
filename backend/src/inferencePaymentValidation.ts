export interface InferencePaymentQuote {
  agentAddress: string;
  treasuryAddress: string;
  chainNetwork: string;
  requiredAmountUsdc: string;
  maxTokens: number;
}

export interface InferencePaymentPayload {
  authorization?: {
    from?: string;
    to?: string;
    value?: string | number | bigint;
    validBefore?: string | number | bigint;
  };
  network?: unknown;
  resource?: unknown;
  maxTokens?: unknown;
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

export function usdcToAtomic(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) throw new Error("invalid_usdc_amount");
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] || "").padEnd(6, "0") || "0");
}

export function validateInferencePayment(
  payment: InferencePaymentPayload,
  quote: InferencePaymentQuote,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  const auth = payment?.authorization;
  if (!auth || !sameAddress(auth.from, quote.agentAddress)) return "payer_mismatch";
  if (!sameAddress(auth.to, quote.treasuryAddress)) return "recipient_mismatch";
  if (payment.network !== quote.chainNetwork) return "network_mismatch";
  if (payment.resource !== "/inference/chat") return "resource_mismatch";
  if (payment.maxTokens !== quote.maxTokens) return "max_tokens_mismatch";
  let value: bigint;
  let required: bigint;
  try {
    value = BigInt(auth.value as any);
    required = usdcToAtomic(quote.requiredAmountUsdc);
  } catch {
    return "invalid_amount";
  }
  if (value < required) return "insufficient_quoted_amount";
  const validBefore = Number(auth.validBefore);
  if (!Number.isSafeInteger(validBefore)) {
    return "invalid_deadline";
  }
  if (nowSeconds > validBefore) return "authorization_expired";
  return null;
}

import assert from "node:assert/strict";
import test from "node:test";
import { validateInferencePayment } from "../inferencePaymentValidation.js";

const quote = {
  agentAddress: "0x1111111111111111111111111111111111111111",
  treasuryAddress: "0x2222222222222222222222222222222222222222",
  chainNetwork: "base-sepolia",
  requiredAmountUsdc: "0.010240",
  maxTokens: 1024,
};
const payment = {
  authorization: {
    from: quote.agentAddress,
    to: quote.treasuryAddress,
    value: "10240",
    validBefore: "2000000000",
  },
  network: quote.chainNetwork,
  resource: "/inference/chat",
  maxTokens: 1024,
};

test("validateInferencePayment accepts a payment matching the quote", () => {
  assert.equal(validateInferencePayment(payment, quote, 1_700_000_000), null);
});

const rejectionCases: Array<[string, Record<string, unknown>]> = [
  ["payer_mismatch", { ...payment, authorization: { ...payment.authorization, from: quote.treasuryAddress } }],
  ["recipient_mismatch", { ...payment, authorization: { ...payment.authorization, to: quote.agentAddress } }],
  ["insufficient_quoted_amount", { ...payment, authorization: { ...payment.authorization, value: "1" } }],
  ["network_mismatch", { ...payment, network: "base" }],
  ["resource_mismatch", { ...payment, resource: "/other" }],
  ["max_tokens_mismatch", { ...payment, maxTokens: 2048 }],
];

for (const [reason, altered] of rejectionCases) {
  test(`validateInferencePayment rejects ${reason}`, () => {
    assert.equal(validateInferencePayment(altered as any, quote, 1_700_000_000), reason);
  });
}

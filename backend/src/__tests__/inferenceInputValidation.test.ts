import test from "node:test";
import assert from "node:assert/strict";
import { parseMaxTokens } from "../inferenceValidation.js";

test("parseMaxTokens accepts bounded positive integers", () => {
  assert.equal(parseMaxTokens(undefined), 1024);
  assert.equal(parseMaxTokens(1), 1);
  assert.equal(parseMaxTokens(8192), 8192);
});

test("parseMaxTokens rejects unsafe token values", () => {
  for (const value of [0, -1, 1.5, Infinity, NaN, "1024", 8193, null]) {
    assert.equal(parseMaxTokens(value), null, `expected rejection for ${String(value)}`);
  }
});

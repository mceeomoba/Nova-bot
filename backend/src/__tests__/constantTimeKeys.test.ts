import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeSecretEqual } from "../sharedKeyAuth.js";

test("constant-time shared-key verification accepts only an exact non-empty secret and rejects missing or different-length input", () => {
  assert.equal(constantTimeSecretEqual("backend-secret", "backend-secret"), true);
  assert.equal(constantTimeSecretEqual("wrong-secret", "backend-secret"), false);
  assert.equal(constantTimeSecretEqual("backend-secretx", "backend-secret"), false);
  assert.equal(constantTimeSecretEqual(undefined, "backend-secret"), false);
  assert.equal(constantTimeSecretEqual(null, "backend-secret"), false);
  assert.equal(constantTimeSecretEqual("", ""), false);
});

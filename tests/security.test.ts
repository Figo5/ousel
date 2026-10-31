/**
 * The local action token: `x-ousel-token` is the name, `x-agentops-token` the
 * pre-rename alias. No current route needs the token, so the guard is exercised
 * directly with a minimal request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, LocalGuard } from "../src/server/security.js";

function check(guard: LocalGuard, headers: Record<string, string>): void {
  const req = {
    method: "POST",
    headers: {
      host: "127.0.0.1:4317",
      "content-type": "application/json",
      ...headers,
    },
  } as unknown as IncomingMessage;
  const res = { setHeader() {} } as unknown as ServerResponse;
  guard.check(req, res);
}

test("x-ousel-token is accepted", () => {
  const guard = new LocalGuard(4317);
  assert.doesNotThrow(() => check(guard, { "x-ousel-token": guard.token }));
});

test("the legacy x-agentops-token carries the same token", () => {
  const guard = new LocalGuard(4317);
  assert.doesNotThrow(() => check(guard, { "x-agentops-token": guard.token }));
});

test("a missing or wrong token is refused under either name", () => {
  const guard = new LocalGuard(4317);
  const refused = (error: unknown) =>
    error instanceof HttpError && error.status === 403;
  assert.throws(() => check(guard, {}), refused);
  assert.throws(() => check(guard, { "x-ousel-token": "nope" }), refused);
  assert.throws(() => check(guard, { "x-agentops-token": "nope" }), refused);
});

/**
 * Retry-once-on-timeout tests (ticket #20) — drive the REAL bridge client
 * (dist/client.js, the same build that ships) with a stubbed `fetch`, no
 * live Blockbench, no ports.
 *
 * Pins the retry contract: a timed-out first attempt is re-sent exactly
 * once with the identical request; a second consecutive timeout surfaces
 * the existing timeout error; non-timeout failures (bridge-reported error,
 * unreachable bridge) are never retried.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callBlockbench } from "../../dist/client.js";

const realFetch = globalThis.fetch;

/** An abort-shaped rejection, as produced when the client's timer fires. */
function abortRejection() {
  return Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });
}

function okResponse(result) {
  return { json: async () => ({ ok: true, result }) };
}

function bridgeErrorResponse(message) {
  return { json: async () => ({ ok: false, error: message }) };
}

function bodiesOf(calls) {
  return calls.map((c) => JSON.parse(c[1].body));
}

test("timeout then success: retried once with the identical request, result returned", async (t) => {
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw abortRejection();
    return okResponse({ created: 1 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const result = await callBlockbench("add_cubes", { cubes: [{ name: "a" }] }, 1234);
  assert.deepEqual(result, { created: 1 });
  assert.equal(calls.length, 2, "exactly one retry, no more");
  const [first, second] = bodiesOf(calls);
  assert.deepEqual(second, first, "retry re-sends the identical request");
  assert.equal(first.action, "add_cubes");
  assert.deepEqual(first.params, { cubes: [{ name: "a" }] });
  for (const [url, init] of calls) {
    assert.ok(String(url).endsWith("/command"));
    assert.equal(init.method, "POST");
  }
});

test("double timeout: surfaces the existing timeout error after exactly two attempts", async (t) => {
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw abortRejection();
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(
    () => callBlockbench("add_cubes", { cubes: [] }, 1234),
    /Command "add_cubes" timed out after 1234ms\./
  );
  assert.equal(calls.length, 2, "no infinite retry, no exponential machinery");
});

test("bridge-reported error: NOT retried", async (t) => {
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return bridgeErrorResponse("bad cube spec");
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(() => callBlockbench("add_cubes", {}, 1234), /bad cube spec/);
  assert.equal(calls.length, 1, "explicit bridge errors must not retry");
});

test("unreachable bridge: NOT retried", async (t) => {
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new TypeError("fetch failed");
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await assert.rejects(() => callBlockbench("add_cubes", {}, 1234), /Cannot reach Blockbench/);
  assert.equal(calls.length, 1, "connection failures must not retry");
});

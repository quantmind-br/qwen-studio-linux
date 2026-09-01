import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fetchRetry, githubHeaders } from "./http.mjs";

const silent = { attempts: 4, baseDelayMs: 1, maxDelayMs: 2, onRetry: () => {} };

async function withServer(handler, run) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    handler(requests.length, request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(origin, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function reply(response, status, body = "{}", headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(body);
}

test("retries a transient 503 and returns the eventual success", async () => {
  await withServer((count, _request, response) => reply(response, count < 3 ? 503 : 200, JSON.stringify({ count })), async (origin, requests) => {
    const response = await fetchRetry(`${origin}/releases`, {}, silent);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 3 });
    assert.equal(requests.length, 3);
  });
});

test("retries a gateway timeout that returns an HTML body", async () => {
  await withServer((count, _request, response) => {
    if (count === 1) return reply(response, 504, "<html><body>We couldn't respond to your request in time.</body></html>", { "Content-Type": "text/html" });
    reply(response, 200, JSON.stringify({ ok: true }));
  }, async (origin, requests) => {
    const response = await fetchRetry(`${origin}/repos/tags/qwen-v1.0.5`, {}, silent);
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
  });
});

test("returns the last retryable response after exhausting attempts", async () => {
  await withServer((_count, _request, response) => reply(response, 502), async (origin, requests) => {
    const response = await fetchRetry(`${origin}/releases`, {}, { ...silent, attempts: 2 });
    assert.equal(response.status, 502);
    assert.equal(requests.length, 2);
  });
});

test("returns non-retryable responses immediately", async () => {
  for (const status of [200, 404, 422]) {
    await withServer((_count, _request, response) => reply(response, status), async (origin, requests) => {
      const response = await fetchRetry(`${origin}/releases`, {}, silent);
      assert.equal(response.status, status);
      assert.equal(requests.length, 1);
    });
  }
});

test("does not retry non-idempotent methods by default", async () => {
  await withServer((_count, _request, response) => reply(response, 503), async (origin, requests) => {
    const response = await fetchRetry(`${origin}/issues`, { method: "POST", body: "{}" }, silent);
    assert.equal(response.status, 503);
    assert.equal(requests.length, 1);
  });
});

test("retries non-idempotent methods when explicitly opted in", async () => {
  await withServer((count, _request, response) => reply(response, count < 2 ? 503 : 201), async (origin, requests) => {
    const response = await fetchRetry(`${origin}/issues`, { method: "POST", body: "{}" }, { ...silent, retryNonIdempotent: true });
    assert.equal(response.status, 201);
    assert.equal(requests.length, 2);
  });
});

test("honours Retry-After instead of exponential backoff", async () => {
  await withServer((count, _request, response) => reply(response, count < 2 ? 429 : 200, "{}", { "Retry-After": "0" }), async (origin, requests) => {
    const started = process.hrtime.bigint();
    const response = await fetchRetry(`${origin}/releases`, {}, { ...silent, baseDelayMs: 30_000, maxDelayMs: 30_000 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(response.status, 200);
    assert.equal(requests.length, 2);
    assert.ok(elapsedMs < 5_000, `Retry-After ignored, waited ${elapsedMs}ms`);
  });
});

test("retries connection failures and rethrows the last one", async () => {
  const port = await withServer(() => {}, async (origin) => new URL(origin).port);
  await assert.rejects(fetchRetry(`http://127.0.0.1:${port}/releases`, {}, { ...silent, attempts: 2 }), /fetch failed/);
});

test("rejects a caller-supplied signal", async () => {
  await assert.rejects(fetchRetry("http://127.0.0.1:1/", { signal: AbortSignal.timeout(1) }), /owns the AbortSignal/);
});

test("builds GitHub headers with and without a token", () => {
  const anonymous = githubHeaders(undefined);
  assert.equal(anonymous.Accept, "application/vnd.github+json");
  assert.equal(anonymous["X-GitHub-Api-Version"], "2022-11-28");
  assert.ok(!("Authorization" in anonymous));
  const authenticated = githubHeaders("t0ken", { Accept: "application/octet-stream" });
  assert.equal(authenticated.Authorization, "Bearer t0ken");
  assert.equal(authenticated.Accept, "application/octet-stream");
});

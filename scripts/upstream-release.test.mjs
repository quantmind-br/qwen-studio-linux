import test from "node:test";
import assert from "node:assert/strict";
import { isForceRecheck, parseManifest, publishedState } from "./upstream-release.mjs";

const digest = Buffer.alloc(64, 7).toString("base64");
const base = {
  version: "1.0.5",
  filename: "Qwen-1.0.5.163.dmg",
  size: 157497343,
  sha512: digest,
  releaseDate: "2026-07-14T07:37:16.416Z",
};

function manifest(overrides = {}) {
  const value = { ...base, ...overrides };
  const files = value.files ?? [{ url: value.filename, sha512: value.sha512, size: value.size }];
  return Buffer.from(`version: ${value.version}\nfiles:\n${files.map((file) => `  - url: ${file.url}\n    sha512: ${file.sha512}\n    size: ${file.size}`).join("\n")}\nreleaseDate: '${value.releaseDate}'\n`);
}

test("parses canonical DMG release and creates a stable identity", () => {
  const first = parseManifest(manifest());
  const second = parseManifest(manifest());
  assert.deepEqual(first, second);
  assert.equal(first.version, "1.0.5");
  assert.equal(first.build, 163);
  assert.equal(first.filename, base.filename);
  assert.equal(first.size, base.size);
  assert.match(first.identity, /^[a-f0-9]{64}$/);
});

for (const [name, overrides, message] of [
  ["absolute URL", { filename: "https://download.qwen.ai/Qwen-1.0.5.163.dmg" }, /safe basename|Invalid DMG filename/],
  ["host-like URL", { filename: "http:Qwen-1.0.5.163.dmg" }, /safe basename|Invalid DMG filename/],
  ["path traversal", { filename: "../Qwen-1.0.5.163.dmg" }, /safe basename/],
  ["version mismatch", { filename: "Qwen-1.0.6.163.dmg" }, /version differ/],
  ["noncanonical SemVer", { version: "01.0.5", filename: "Qwen-01.0.5.163.dmg" }, /canonical SemVer/],
  ["invalid digest", { sha512: "not-base64" }, /canonical Base64/],
  ["undersized DMG", { size: 1024 }, /between 50 MiB and 1 GiB/],
  ["invalid date", { releaseDate: "yesterday" }, /valid ISO timestamp/],
]) test(`rejects ${name}`, () => assert.throws(() => parseManifest(manifest(overrides)), message));

test("rejects two DMG entries", () => {
  const files = [
    { url: base.filename, sha512: digest, size: base.size },
    { url: "Qwen-1.0.5.164.dmg", sha512: digest, size: base.size },
  ];
  assert.throws(() => parseManifest(manifest({ files })), /exactly one DMG/);
});

test("rejects manifests larger than one MiB", () => {
  assert.throws(() => parseManifest(Buffer.alloc(1024 * 1024 + 1)), /exceeds 1 MiB/);
});

const detected = { version: "1.0.5", build: 163, identity: "e40a8403" };
const provenanceUrl = { tagged: "https://assets.invalid/tagged/upstream-release.json", latest: "https://assets.invalid/latest/upstream-release.json" };

function releaseWithProvenance(url, draft = false) {
  return { draft, assets: [{ name: "upstream-release.json", browser_download_url: url }] };
}

async function withGithubRoutes(routes, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const fragment = Object.keys(routes).find((candidate) => href.includes(candidate));
    assert.ok(fragment, `Unexpected request: ${href}`);
    const value = routes[fragment];
    return value === null ? new Response("", { status: 404 }) : Response.json(value);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("reports a noop when the published identity matches", async () => {
  const state = await withGithubRoutes({
    "releases/tags/": releaseWithProvenance(provenanceUrl.tagged),
    "tagged/upstream-release.json": { ...detected },
  }, () => publishedState(detected, false));
  assert.deepEqual(state, { action: "noop", reason: "identity already published" });
});

test("forces a rebuild of an already published identity when force_recheck is set", async () => {
  const state = await withGithubRoutes({
    "releases/tags/": releaseWithProvenance(provenanceUrl.tagged),
    "tagged/upstream-release.json": { ...detected },
  }, () => publishedState(detected, true));
  assert.equal(state.action, "build");
  assert.match(state.reason, /forced recheck/);
});

test("still fails a forced recheck when the published build was repacked", async () => {
  const state = await withGithubRoutes({
    "releases/tags/": releaseWithProvenance(provenanceUrl.tagged),
    "tagged/upstream-release.json": { ...detected, identity: "deadbeef" },
  }, () => publishedState(detected, true));
  assert.equal(state.action, "fail");
  assert.match(state.reason, /suspected repack/);
});

test("fails a rollback below the published latest release", async () => {
  const state = await withGithubRoutes({
    "releases/tags/": null,
    "releases/latest": releaseWithProvenance(provenanceUrl.latest),
    "latest/upstream-release.json": { version: "1.0.6", build: 1, identity: "newer" },
  }, () => publishedState(detected, false));
  assert.equal(state.action, "fail");
  assert.match(state.reason, /rollback below published 1\.0\.6 build 1/);
});

test("builds a new upstream identity", async () => {
  const state = await withGithubRoutes({
    "releases/tags/": null,
    "releases/latest": null,
  }, () => publishedState(detected, false));
  assert.deepEqual(state, { action: "build", reason: "new upstream identity" });
});

test("parses the force_recheck flag exactly as the workflow passes it", () => {
  for (const value of ["true", "TRUE", " true ", "1", "yes"]) assert.equal(isForceRecheck(value), true, value);
  for (const value of ["false", "", "0", "no", undefined, null]) assert.equal(isForceRecheck(value), false, String(value));
});

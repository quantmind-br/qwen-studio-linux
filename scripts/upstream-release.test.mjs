import test from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "./upstream-release.mjs";

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

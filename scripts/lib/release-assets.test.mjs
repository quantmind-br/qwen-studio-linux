import test from "node:test";
import assert from "node:assert/strict";
import { assertSameUpstreamIdentity, reconcilePublishedAssets } from "./release-assets.mjs";

const expectedNames = [
  "Qwen-1.0.5-linux-x86_64.AppImage",
  "qwen_1.0.5_amd64.deb",
  "qwen-1.0.5-1-x86_64.pkg.tar.zst",
  "latest-linux.yml",
  "SHA256SUMS",
  "upstream-release.json",
  "upstream-latest-mac.yml",
];

function published(names) {
  return names.map((name, index) => ({ name, size: (index + 1) * 1024 }));
}

test("reports no missing assets when the published set matches", () => {
  assert.deepEqual(reconcilePublishedAssets(expectedNames, published(expectedNames)), { missing: [] });
});

test("tolerates a published release that predates a newly added artifact", () => {
  const legacy = expectedNames.filter((name) => !name.endsWith(".pkg.tar.zst"));
  assert.deepEqual(reconcilePublishedAssets(expectedNames, published(legacy)), { missing: ["qwen-1.0.5-1-x86_64.pkg.tar.zst"] });
});

test("ignores asset sizes, which repacking does not reproduce byte for byte", () => {
  const resized = published(expectedNames).map((asset) => ({ ...asset, size: asset.size + 4096 }));
  assert.deepEqual(reconcilePublishedAssets(expectedNames, resized), { missing: [] });
});

test("rejects a published release missing the updater feed or the provenance", () => {
  for (const core of ["latest-linux.yml", "upstream-release.json"]) {
    const withoutCore = published(expectedNames.filter((name) => name !== core));
    assert.throws(() => reconcilePublishedAssets(expectedNames, withoutCore), new RegExp(`incomplete: ${core} is missing`));
  }
});

test("rejects an unexpected published asset", () => {
  const extra = [...published(expectedNames), { name: "qwen-1.0.5.exe", size: 10 }];
  assert.throws(() => reconcilePublishedAssets(expectedNames, extra), /unexpected asset: qwen-1\.0\.5\.exe/);
});

test("accepts a published release built from the same upstream identity", () => {
  assert.doesNotThrow(() => assertSameUpstreamIdentity({ identity: "e40a8403" }, { identity: "e40a8403" }));
});

test("rejects a published release built from a different upstream identity", () => {
  assert.throws(() => assertSameUpstreamIdentity({ identity: "deadbeef" }, { identity: "e40a8403" }), /derives from upstream identity deadbeef, expected e40a8403/);
  assert.throws(() => assertSameUpstreamIdentity(null, { identity: "e40a8403" }), /identity unknown, expected e40a8403/);
});

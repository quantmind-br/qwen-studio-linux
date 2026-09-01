import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePublishedAssets } from "./release-assets.mjs";

const expectedNames = [
  "Qwen-1.0.5-linux-x86_64.AppImage",
  "qwen_1.0.5_amd64.deb",
  "qwen-1.0.5-1-x86_64.pkg.tar.zst",
  "latest-linux.yml",
  "SHA256SUMS",
  "upstream-release.json",
  "upstream-latest-mac.yml",
];
const expected = new Map(expectedNames.map((name, index) => [name, { size: (index + 1) * 1024, sha256: `${index}`.repeat(64) }]));

function published(names) {
  return names.map((name) => ({ name, size: expected.get(name).size }));
}

test("reports no missing assets when the published set matches", () => {
  assert.deepEqual(reconcilePublishedAssets(expectedNames, expected, published(expectedNames)), { missing: [] });
});

test("tolerates a published release that predates a newly added artifact", () => {
  const legacy = expectedNames.filter((name) => !name.endsWith(".pkg.tar.zst"));
  assert.deepEqual(reconcilePublishedAssets(expectedNames, expected, published(legacy)), { missing: ["qwen-1.0.5-1-x86_64.pkg.tar.zst"] });
});

test("rejects a published release missing the updater feed or the provenance", () => {
  for (const core of ["latest-linux.yml", "upstream-release.json"]) {
    const withoutCore = published(expectedNames.filter((name) => name !== core));
    assert.throws(() => reconcilePublishedAssets(expectedNames, expected, withoutCore), new RegExp(`incomplete: ${core} is missing`));
  }
});

test("rejects a published asset whose size differs", () => {
  const tampered = published(expectedNames).map((asset) => asset.name === "SHA256SUMS" ? { ...asset, size: 1 } : asset);
  assert.throws(() => reconcilePublishedAssets(expectedNames, expected, tampered), /Published asset differs: SHA256SUMS/);
});

test("rejects an unexpected published asset", () => {
  const extra = [...published(expectedNames), { name: "qwen-1.0.5.exe", size: 10 }];
  assert.throws(() => reconcilePublishedAssets(expectedNames, expected, extra), /unexpected asset: qwen-1\.0\.5\.exe/);
});

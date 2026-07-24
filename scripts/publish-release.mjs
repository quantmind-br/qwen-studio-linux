import { createHash } from "node:crypto";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const repository = "quantmind-br/qwen-studio-linux-releases";
const root = resolve(import.meta.dirname, "..");
const assetsDir = resolve(process.env.RELEASE_ASSETS_DIR ?? join(root, ".stage/release-assets"));
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(path) {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    for await (const chunk of file.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "qwen-studio-linux-release",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : await response.json();
}

const provenance = JSON.parse(await readFile(join(assetsDir, "upstream-release.json"), "utf8"));
const tag = `qwen-v${provenance.version}`;
const expectedNames = [
  `Qwen-${provenance.version}-linux-x86_64.AppImage`,
  `qwen_${provenance.version}_amd64.deb`,
  `qwen-${provenance.version}-1-x86_64.pkg.tar.zst`,
  "latest-linux.yml",
  "SHA256SUMS",
  "upstream-release.json",
  "upstream-latest-mac.yml",
];
const actualNames = (await readdir(assetsDir)).sort();
assert(JSON.stringify(actualNames) === JSON.stringify([...expectedNames].sort()), `Release asset set differs: ${actualNames.join(", ")}`);
const expected = new Map(await Promise.all(expectedNames.map(async (name) => {
  const path = join(assetsDir, name);
  return [name, { path, size: (await stat(path)).size, sha256: await sha256(path) }];
})));

const releases = await api(`/repos/${repository}/releases?per_page=100`);
const matching = (releases ?? []).filter((entry) => entry.tag_name === tag);
assert(matching.length <= 1, `Multiple releases share tag ${tag}`);
let release = matching[0] ?? null;
if (release && !release.draft) {
  assert(release.assets.length === expected.size, "Published release is incomplete");
  for (const asset of release.assets) {
    const item = expected.get(asset.name);
    assert(item && asset.size === item.size, `Published asset differs: ${asset.name}`);
  }
  process.stdout.write(`${JSON.stringify({ action: "noop", tag })}\n`);
  process.exit(0);
}
if (!release) {
  release = await api(`/repos/${repository}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: `Qwen ${provenance.version} for Linux`, draft: true, prerelease: false, make_latest: "false" }),
  });
}
assert(release.draft, "Existing matching release must be a draft");
for (const asset of release.assets ?? []) {
  const item = expected.get(asset.name);
  assert(item, `Unexpected draft asset ${asset.name}`);
  assert(asset.size === item.size, `Draft asset size differs: ${asset.name}`);
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream", "User-Agent": "qwen-studio-linux-release", "X-GitHub-Api-Version": "2022-11-28" } });
  assert(response.ok, `Cannot download draft asset ${asset.name}`);
  const digest = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  assert(digest === item.sha256, `Draft asset digest differs: ${asset.name}`);
  expected.delete(asset.name);
}
for (const [name, item] of expected) {
  const response = await fetch(`${release.upload_url.replace("{?name,label}", "")}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Content-Length": String(item.size) },
    body: await readFile(item.path),
  });
  if (!response.ok) throw new Error(`Asset upload failed for ${name}: ${response.status} ${await response.text()}`);
}
release = await api(`/repos/${repository}/releases/${release.id}`);
assert(release.assets.length === expectedNames.length, `Draft has ${release.assets.length} assets, expected ${expectedNames.length}`);
for (const asset of release.assets) assert(asset.state === "uploaded" && expectedNames.includes(asset.name), `Invalid uploaded asset ${asset.name}`);
await api(`/repos/${repository}/releases/${release.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ draft: false, prerelease: false, make_latest: "true" }),
});
process.stdout.write(`${JSON.stringify({ action: "published", tag })}\n`);

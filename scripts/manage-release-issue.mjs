import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fetchRetry, githubHeaders } from "./lib/http.mjs";

const repository = "quantmind-br/qwen-studio-linux";
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");
const root = resolve(import.meta.dirname, "..");
const provenance = JSON.parse(await readFile(process.env.UPSTREAM_RELEASE_JSON ?? join(root, ".stage/upstream/release.json"), "utf8"));
const title = `[Qwen ${provenance.version} build ${provenance.build}] Automatic Linux release failed`;
const mode = process.argv[2];

async function api(path, options = {}) {
  const response = await fetchRetry(`https://api.github.com${path}`, { ...options, headers: githubHeaders(token, options.headers) });
  if (!response.ok) throw new Error(`GitHub API ${path} failed with ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : await response.json();
}

const query = encodeURIComponent(`repo:${repository} is:issue in:title "${title}"`);
const results = await api(`/search/issues?q=${query}&per_page=10`);
const existing = results.items.find((issue) => issue.title === title);
if (mode === "close") {
  if (existing?.state === "open") await api(`/repos/${repository}/issues/${existing.number}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
  process.exit(0);
}
if (mode !== "fail") throw new Error("Usage: node scripts/manage-release-issue.mjs fail|close");
const body = [
  `Upstream URL: ${provenance.url}`,
  `Identity: \`${provenance.identity}\``,
  `Manifest SHA-256: \`${provenance.manifestSha256}\``,
  `DMG SHA-512: \`${provenance.sha512}\``,
  `Run: ${process.env.RUN_URL ?? "unknown"}`,
  `Failed stage: ${process.env.FAILED_STAGE ?? "unknown"}`,
].join("\n\n");
if (existing) {
  await api(`/repos/${repository}/issues/${existing.number}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
  if (existing.state !== "open") await api(`/repos/${repository}/issues/${existing.number}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "open" }) });
} else {
  await api(`/repos/${repository}/issues`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, body, labels: ["upstream-update-failed"] }) });
}

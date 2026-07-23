import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { extractAll } from "@electron/asar";
import { parseDocument } from "yaml";
import { assertCanonicalVersion } from "./lib/linux-package.mjs";

export const MANIFEST_URL = "https://download.qwen.ai/macos/x64/latest-mac.yml";
export const RELEASE_REPOSITORY = "quantmind-br/qwen-studio-linux-releases";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MIN_DMG_BYTES = 50 * 1024 * 1024;
const MAX_DMG_BYTES = 1024 * 1024 * 1024;
const TEAM_ID = "NF4574S59H";
const BUNDLE_ID = "com.qwen.chat";
const root = resolve(import.meta.dirname, "..");
const stageDir = join(root, ".stage/upstream");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeCanonicalBase64(value) {
  assert(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0, "sha512 must be canonical Base64");
  const decoded = Buffer.from(value, "base64");
  assert(decoded.length === 64 && decoded.toString("base64") === value, "sha512 must decode canonically to 64 bytes");
  return decoded;
}

export function parseManifest(bytes, sourceUrl = MANIFEST_URL) {
  assert(Buffer.byteLength(bytes) <= MAX_MANIFEST_BYTES, "Manifest exceeds 1 MiB");
  const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
  assert(document.errors.length === 0, `Invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`);
  const manifest = document.toJS({ maxAliasCount: 0 });
  assert(manifest && typeof manifest === "object" && !Array.isArray(manifest), "Manifest root must be a mapping");
  const version = assertCanonicalVersion(manifest.version, "manifest.version");
  assert(typeof manifest.releaseDate === "string" && !Number.isNaN(Date.parse(manifest.releaseDate)), "releaseDate must be a valid ISO timestamp");
  assert(new Date(manifest.releaseDate).toISOString() === manifest.releaseDate, "releaseDate must be canonical ISO-8601 UTC");
  assert(Array.isArray(manifest.files), "files must be an array");
  const dmgFiles = manifest.files.filter((file) => typeof file?.url === "string" && file.url.endsWith(".dmg"));
  assert(dmgFiles.length === 1, `Expected exactly one DMG entry, found ${dmgFiles.length}`);
  const file = dmgFiles[0];
  assert(!file.url.includes("/") && !file.url.includes("\\") && !file.url.includes("..") && !file.url.includes("?") && !file.url.includes("#") && !/^[a-z][a-z\d+.-]*:/i.test(file.url), "DMG url must be a safe basename");
  const match = /^Qwen-(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(?<build>[1-9]\d*)\.dmg$/.exec(file.url);
  assert(match, `Invalid DMG filename: ${file.url}`);
  assert(match.groups.version === version, "Manifest version and DMG filename version differ");
  const build = Number(match.groups.build);
  assert(Number.isSafeInteger(build) && build > 0, "DMG build must be a positive integer");
  assert(Number.isSafeInteger(file.size) && file.size >= MIN_DMG_BYTES && file.size <= MAX_DMG_BYTES, "DMG size must be between 50 MiB and 1 GiB");
  decodeCanonicalBase64(file.sha512);
  const identityFields = { version, build, filename: file.url, size: file.size, sha512: file.sha512 };
  return {
    version,
    build,
    filename: file.url,
    url: new URL(file.url, sourceUrl).href,
    size: file.size,
    sha512: file.sha512,
    releaseDate: manifest.releaseDate,
    manifestSha256: sha256Bytes(bytes),
    identity: sha256Bytes(Buffer.from(canonicalJson(identityFields))),
  };
}

async function fetchStrict(url, { maxBytes, timeoutMs = 30_000 } = {}) {
  let current = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assert(current.protocol === "https:" && current.hostname === "download.qwen.ai" && !current.port, `Rejected download URL: ${current.href}`);
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert(redirects < 3, "Too many redirects");
      const location = response.headers.get("location");
      assert(location, "Redirect lacks Location header");
      current = new URL(location, current);
      continue;
    }
    assert(response.ok && response.body, `GET ${current.href} failed with ${response.status}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      assert(maxBytes === undefined || total <= maxBytes, `Response exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), url: current.href };
  }
  throw new Error("Unreachable redirect state");
}

async function writeReleaseJson(release) {
  await mkdir(stageDir, { recursive: true });
  const ordered = {
    version: release.version,
    build: release.build,
    filename: release.filename,
    url: release.url,
    size: release.size,
    sha512: release.sha512,
    releaseDate: release.releaseDate,
    manifestSha256: release.manifestSha256,
    identity: release.identity,
  };
  await writeFile(join(stageDir, "release.json"), `${JSON.stringify(ordered, null, 2)}\n`);
}

function compareRelease(a, b) {
  const av = a.version.split(".").map(Number);
  const bv = b.version.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (av[index] !== bv[index]) return Math.sign(av[index] - bv[index]);
  }
  return Math.sign(a.build - b.build);
}

async function githubJson(path, token = process.env.GITHUB_TOKEN) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "qwen-studio-linux-release",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  assert(response.ok, `GitHub API ${path} failed with ${response.status}: ${await response.text()}`);
  return await response.json();
}

async function publishedState(release) {
  const tagged = await githubJson(`/repos/${RELEASE_REPOSITORY}/releases/tags/qwen-v${release.version}`);
  if (tagged && !tagged.draft) {
    const provenanceAsset = tagged.assets?.find((asset) => asset.name === "upstream-release.json");
    assert(provenanceAsset, "Published release is missing upstream-release.json");
    const response = await fetch(provenanceAsset.browser_download_url, { signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Failed to read published provenance: ${response.status}`);
    const provenance = await response.json();
    if (provenance.identity === release.identity) return { action: "noop", reason: "identity already published" };
    if (provenance.version === release.version && provenance.build === release.build) return { action: "fail", reason: "published version/build has a different identity (suspected repack)" };
    return { action: "fail", reason: "published tag provenance conflicts with detected upstream" };
  }
  const latest = await githubJson(`/repos/${RELEASE_REPOSITORY}/releases/latest`);
  if (latest) {
    const provenanceAsset = latest.assets?.find((asset) => asset.name === "upstream-release.json");
    if (provenanceAsset) {
      const response = await fetch(provenanceAsset.browser_download_url, { signal: AbortSignal.timeout(30_000) });
      assert(response.ok, `Failed to read latest provenance: ${response.status}`);
      const provenance = await response.json();
      if (compareRelease(release, provenance) < 0) return { action: "fail", reason: `rollback below published ${provenance.version} build ${provenance.build}` };
    }
  }
  return { action: "build", reason: "new upstream identity" };
}

async function detect() {
  const source = process.env.QWEN_MANIFEST_FIXTURE
    ? { bytes: await readFile(resolve(process.env.QWEN_MANIFEST_FIXTURE)), url: MANIFEST_URL }
    : await fetchStrict(MANIFEST_URL, { maxBytes: MAX_MANIFEST_BYTES });
  const release = parseManifest(source.bytes, source.url);
  await mkdir(stageDir, { recursive: true });
  await writeFile(join(stageDir, "latest-mac.yml"), source.bytes);
  await writeReleaseJson(release);
  const state = process.env.QWEN_SKIP_RELEASE_CHECK === "1" ? { action: "build", reason: "release check skipped" } : await publishedState(release);
  const result = { ...release, ...state };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function streamDmg(release) {
  const temporary = join(stageDir, `${release.filename}.tmp`);
  const destination = join(stageDir, release.filename);
  await rm(temporary, { force: true });
  let current = new URL(release.url);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assert(current.protocol === "https:" && current.hostname === "download.qwen.ai" && !current.port, `Rejected DMG URL: ${current.href}`);
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(10 * 60_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert(redirects < 3, "Too many DMG redirects");
      current = new URL(response.headers.get("location"), current);
      continue;
    }
    assert(response.ok && response.body, `DMG GET failed with ${response.status}`);
    const file = await open(temporary, "wx");
    const hash = createHash("sha512");
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        assert(size <= release.size, `DMG exceeds declared size ${release.size}`);
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
    assert(size === release.size, `DMG size mismatch: expected ${release.size}, got ${size}`);
    const digest = hash.digest("base64");
    assert(digest === release.sha512, `DMG SHA-512 mismatch: expected ${release.sha512}, got ${digest}`);
    await rename(temporary, destination);
    return destination;
  }
  throw new Error("Unreachable DMG redirect state");
}

async function runCapture(command, args) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun({ stdout: stdout.trim(), stderr: stderr.trim() }) : reject(new Error(`${command} failed (${signal ?? code})\n${stderr || stdout}`)));
  });
}

async function validateMacApp(dmg, release) {
  assert(process.platform === "darwin", "macOS validation must run on macos-15-intel");
  await runCapture("hdiutil", ["verify", dmg]);
  const mount = await mkdtemp(join(tmpdir(), "qwen-dmg-"));
  try {
    await runCapture("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
    const entries = (await readdir(mount, { withFileTypes: true })).filter((entry) => !entry.name.startsWith("."));
    const unexpected = entries.filter((entry) => entry.name !== "Qwen.app" && entry.name !== "Applications");
    const qwenApp = entries.filter((entry) => entry.name === "Qwen.app" && entry.isDirectory());
    assert(qwenApp.length === 1 && unexpected.length === 0, `DMG must contain Qwen.app and optionally the Applications alias, found ${entries.map((entry) => entry.name).join(", ")}`);
    const app = join(mount, "Qwen.app");
    await runCapture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    await runCapture("spctl", ["-a", "-vv", "-t", "exec", app]);
    const signing = await runCapture("codesign", ["-dv", "--verbose=4", app]);
    const signingText = `${signing.stdout}\n${signing.stderr}`;
    assert(new RegExp(`^TeamIdentifier=${TEAM_ID}$`, "m").test(signingText), `Unexpected Apple Team ID; expected ${TEAM_ID}`);
    const plist = join(app, "Contents/Info.plist");
    const bundleId = (await runCapture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])).stdout;
    const shortVersion = (await runCapture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist])).stdout;
    const bundleVersion = (await runCapture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", plist])).stdout;
    assert(bundleId === BUNDLE_ID, `Unexpected bundle ID ${bundleId}`);
    assert(shortVersion === release.version, `Bundle version ${shortVersion} differs from ${release.version}`);
    assert(bundleVersion.length > 0, "CFBundleVersion is empty");
    const executableName = (await runCapture("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist])).stdout;
    const executable = join(app, "Contents/MacOS", executableName);
    const fileInfo = (await runCapture("file", [executable])).stdout;
    assert(fileInfo.includes("x86_64"), `Application executable is not x86_64: ${fileInfo}`);
    const ingestRoot = join(stageDir, "ingest");
    await rm(ingestRoot, { recursive: true, force: true });
    await mkdir(join(ingestRoot, "extract/Qwen.app/Contents/Resources"), { recursive: true });
    extractAll(join(app, "Contents/Resources/app.asar"), join(ingestRoot, "asar-src"));
    for (const item of ["i18n", "assets", "icon.icns"]) await cp(join(app, "Contents/Resources", item), join(ingestRoot, "extract/Qwen.app/Contents/Resources", item), { recursive: true });
    await removeAppleStreams(ingestRoot);
    await cp(join(stageDir, "release.json"), join(ingestRoot, "release.json"));
    await cp(join(stageDir, "latest-mac.yml"), join(ingestRoot, "latest-mac.yml"));
    const releaseWithBundle = { ...release, bundleVersion };
    await writeFile(join(ingestRoot, "release.json"), `${JSON.stringify(releaseWithBundle, null, 2)}\n`);
    await runCapture("tar", ["-czf", join(stageDir, "qwen-upstream-ingest.tar.gz"), "-C", ingestRoot, "."]);
    return releaseWithBundle;
  } finally {
    await runCapture("hdiutil", ["detach", mount]).catch(() => {});
    await rm(mount, { recursive: true, force: true });
  }
}

async function removeAppleStreams(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.name.includes(":com.apple.")) await rm(child, { recursive: true, force: true });
    else if (entry.isDirectory()) await removeAppleStreams(child);
  }
}

async function ingest() {
  const release = JSON.parse(await readFile(join(stageDir, "release.json"), "utf8"));
  const dmg = await streamDmg(release);
  const validated = await validateMacApp(dmg, release);
  process.stdout.write(`${JSON.stringify(validated)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const command = process.argv[2];
  if (command === "detect") await detect();
  else if (command === "ingest") await ingest();
  else throw new Error("Usage: node scripts/upstream-release.mjs detect|ingest");
}

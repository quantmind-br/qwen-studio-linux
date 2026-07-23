import { createHash } from "node:crypto";
import { access, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { extractAll, listPackage } from "@electron/asar";
import { parse } from "yaml";
import { assertCanonicalVersion, PUBLIC_UPDATE_URL, resolveRendererBundle } from "./lib/linux-package.mjs";

const root = resolve(import.meta.dirname, "..");
const layout = process.argv.find((arg) => arg.startsWith("--layout="))?.slice(9) ?? "unpacked";
const targetRoot = resolve(root, process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? "dist/linux-unpacked");
const resourcesDir = layout === "deb" ? join(targetRoot, "opt/Qwen/resources") : join(targetRoot, "resources");
const executable = layout === "deb" ? join(targetRoot, "opt/Qwen/qwen") : join(targetRoot, "qwen");
const desktopCandidates = layout === "appimage"
  ? [join(targetRoot, "com.qwen.chat.desktop"), join(targetRoot, "usr/share/applications/com.qwen.chat.desktop")]
  : [join(targetRoot, "usr/share/applications/com.qwen.chat.desktop")];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function runCapture(command, args, timeoutMs = 120_000) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} failed (${signal ?? code})\n${stderr || stdout}`));
    });
  });
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  const file = await open(path, "r");
  try {
    for await (const chunk of file.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await file.close();
  }
  return hash.digest(encoding);
}

async function assertElfX64Mode(path) {
  const file = await readFile(path);
  assert(file.length >= 20 && file.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${path} is not ELF`);
  assert(file[4] === 2 && file[5] === 1 && file.readUInt16LE(18) === 62, `${path} is not ELF64 x86-64`);
  assert(((await stat(path)).mode & 0o777) === 0o755, `${path} mode is not 0755`);
}

async function verifyDesktop() {
  const desktopPath = (await Promise.all(desktopCandidates.map(async (candidate) => [candidate, await exists(candidate)]))).find(([, present]) => present)?.[0];
  if (layout === "unpacked" && !desktopPath) return;
  assert(desktopPath, `Desktop file missing; checked: ${desktopCandidates.join(", ")}`);
  const desktop = await readFile(desktopPath, "utf8");
  assert((desktop.match(/^MimeType=(.*)$/m)?.[1] ?? "").split(";").includes("x-scheme-handler/qwen"), "Desktop entry lacks x-scheme-handler/qwen");
  assert((layout === "appimage" ? /^Exec=AppRun --no-sandbox %U$/m : /^Exec=(?:.*\/)?qwen %U$/m).test(desktop), `Unexpected desktop Exec line in ${desktopPath}`);
  assert(/^StartupWMClass=com\.qwen\.chat$/m.test(desktop), "Desktop entry has wrong StartupWMClass");
  assert(/^Icon=qwen$/m.test(desktop), "Desktop entry does not use staged Qwen icon");
}

async function verifyUpdateMetadata(version) {
  const appUpdatePath = join(resourcesDir, "app-update.yml");
  if (layout === "appimage") {
    assert(await exists(appUpdatePath), "AppImage resources/app-update.yml is missing");
    const config = parse(await readFile(appUpdatePath, "utf8"));
    assert(config.provider === "generic" && config.url === PUBLIC_UPDATE_URL, "AppImage app-update.yml has the wrong provider or URL");
  } else {
    assert(!(await exists(appUpdatePath)), `Updater metadata must not exist for ${layout}`);
  }
  assert(!(await exists(join(resourcesDir, "latest-linux.yml"))), "latest-linux.yml must not be embedded in resources");
  assert(!(await exists(join(targetRoot, "latest-linux.yml"))), "latest-linux.yml must not exist inside the package root");

  const appImage = join(root, `dist/Qwen-${version}-linux-x86_64.AppImage`);
  const deb = join(root, `dist/qwen_${version}_amd64.deb`);
  const latestPath = join(root, "dist/latest-linux.yml");
  if (!(await exists(appImage)) && !(await exists(deb)) && !(await exists(latestPath))) return;
  assert(await exists(appImage), `Expected AppImage missing: ${basename(appImage)}`);
  assert(await exists(deb), `Expected DEB missing: ${basename(deb)}`);
  assert(await exists(latestPath), "latest-linux.yml is missing");
  assert(!(await exists(`${appImage}.blockmap`)), "A separate AppImage blockmap must not be published");
  const latest = parse(await readFile(latestPath, "utf8"));
  assert(latest.version === version, `latest-linux.yml version ${latest.version} differs from ${version}`);
  const file = latest.files?.find((entry) => entry.url === basename(appImage));
  const debEntry = latest.files?.find((entry) => entry.url === basename(deb));
  assert(file && debEntry && latest.files.length === 2, "latest-linux.yml must reference the canonical AppImage and DEB only");
  assert(file.size === (await stat(appImage)).size, "latest-linux.yml AppImage size mismatch");
  assert(file.sha512 === await hashFile(appImage, "sha512", "base64"), "latest-linux.yml AppImage SHA-512 mismatch");
  assert(Number.isSafeInteger(file.blockMapSize) && file.blockMapSize > 0, "latest-linux.yml blockMapSize is missing or invalid");
}

async function verify() {
  assert(await exists(executable), `Electron executable missing: ${executable}`);
  const asarPath = join(resourcesDir, "app.asar");
  assert(await exists(asarPath), `ASAR missing: ${asarPath}`);
  assert(!(await exists(join(resourcesDir, "app/app.asar"))), "Nested resources/app/app.asar must not exist");
  const entries = new Set(listPackage(asarPath, { isPack: false }).map((entry) => entry.replace(/^\//, "")));
  for (const entry of ["package.json", "out/main/index.js", "out/preload/index.js", "out/renderer/index.html", "node_modules/@ali/spark-mcp/package.json", "node_modules/@modelcontextprotocol/sdk/package.json", "i18n/en-US.json", "assets/icon.png"]) assert(entries.has(entry), `ASAR entry missing: ${entry}`);

  const temporary = await mkdtemp(join(tmpdir(), "qwen-package-verify-"));
  let version;
  try {
    extractAll(asarPath, temporary);
    const packageJson = JSON.parse(await readFile(join(temporary, "package.json"), "utf8"));
    version = assertCanonicalVersion(packageJson.version, "packaged version");
    const main = await readFile(join(temporary, "out/main/index.js"), "utf8");
    for (const marker of [
      `return "linux-x64"`, `Unsupported Linux architecture`, `path.join(process.resourcesPath, type, dir)`,
      `if (process.platform === "linux" && !process.env.APPIMAGE) return;`, PUBLIC_UPDATE_URL,
      `...process.platform !== "linux" || process.env.APPIMAGE ? [checkUpdateItem, { type: "separator" }] : []`,
      `path.join(electron.app.getAppPath(), "i18n")`, `path.join(electron.app.getAppPath(), "assets/icon.png")`,
      `platform: process.platform, arch: process.arch`, `function cloneMcpConfig(configs)`,
      `function sanitizePersistedMcpConfig(configs, stripInheritedEnv = false)`, `sanitizePersistedMcpConfig(savedConfig, true)`,
      `await mcpServer.setMCPServers(adaptConfig(cloneMcpConfig(sanitized)))`, `const pendingEvents = [];`,
      `electron.ipcMain.on("event-listener-ready", flushPendingEventType);`, `MimeType=x-scheme-handler/qwen;`,
      `repairLinuxDesktopEntry(existing, appImagePath)`, `electron.app.requestSingleInstanceLock()`,
      `if (hasSingleInstanceLock) electron.app.whenReady().then(async () => {`,
    ]) assert(main.includes(marker), `Packaged main process lacks marker: ${marker}`);
    const preload = await readFile(join(temporary, "out/preload/index.js"), "utf8");
    assert(preload.includes(`electron.ipcRenderer.send("event-listener-ready", type);`), "Packaged preload lacks event listener ready handshake");
    const renderer = await readFile(await resolveRendererBundle(temporary, `if (grantedButton.isConnected) grantedButton.click();`), "utf8");
    assert(renderer.includes(`new MutationObserver(scheduleMcpPermissionGrant)`), "Packaged renderer lacks MCP permission observer");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const bun = join(resourcesDir, "bun/linux-x64/bun");
  const uv = join(resourcesDir, "python/linux-x64/uv");
  const uvx = join(resourcesDir, "python/linux-x64/uvx");
  for (const runtime of [bun, uv, uvx]) await assertElfX64Mode(runtime);
  assert((await runCapture(bun, ["--version"])).stdout === "1.2.10", "Bun version is not 1.2.10");
  assert((await runCapture(uv, ["--version"])).stdout === "uv 0.7.14", "uv version is not 0.7.14");
  assert((await runCapture(uvx, ["--version"])).stdout === "uvx 0.7.14", "uvx version is not 0.7.14");
  await verifyUpdateMetadata(version);
  await verifyDesktop();
  console.log(`Verified Linux package layout: ${targetRoot}`);
}

await verify();

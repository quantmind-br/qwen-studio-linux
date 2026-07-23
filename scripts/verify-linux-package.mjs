import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { extractAll, listPackage } from "@electron/asar";

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

async function assertElfX64Mode(path) {
  const file = await readFile(path);
  assert(file.length >= 20 && file.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${path} is not ELF`);
  assert(file[4] === 2 && file[5] === 1 && file.readUInt16LE(18) === 62, `${path} is not ELF64 x86-64`);
  assert(((await stat(path)).mode & 0o777) === 0o755, `${path} mode is not 0755`);
}

async function verifyDesktop() {
  const desktopPath = (await Promise.all(desktopCandidates.map(async (candidate) => [candidate, await exists(candidate)])))
    .find(([, present]) => present)?.[0];
  if (layout === "unpacked" && !desktopPath) return;
  assert(desktopPath, `Desktop file missing; checked: ${desktopCandidates.join(", ")}`);
  const desktop = await readFile(desktopPath, "utf8");
  const mimeLine = desktop.split(/\r?\n/).find((line) => line.startsWith("MimeType=")) ?? "";
  assert(mimeLine.slice("MimeType=".length).split(";").includes("x-scheme-handler/qwen"), "Desktop entry lacks x-scheme-handler/qwen");
  const execPattern = layout === "appimage" ? /^Exec=AppRun --no-sandbox %U$/m : /^Exec=(?:.*\/)?qwen %U$/m;
  assert(execPattern.test(desktop), `Unexpected desktop Exec line in ${desktopPath}`);
  assert(/^StartupWMClass=com\.qwen\.chat$/m.test(desktop), "Desktop entry has wrong StartupWMClass");
  assert(/^Icon=qwen$/m.test(desktop), "Desktop entry does not use staged Qwen icon");
}

async function verify() {
  assert(await exists(executable), `Electron executable missing: ${executable}`);
  const asarPath = join(resourcesDir, "app.asar");
  assert(await exists(asarPath), `ASAR missing: ${asarPath}`);
  assert(!(await exists(join(resourcesDir, "app/app.asar"))), "Nested resources/app/app.asar must not exist");
  assert(!(await exists(join(resourcesDir, "app/package.json"))), "Unpacked resources/app/package.json must not exist");

  const entries = new Set(listPackage(asarPath, { isPack: false }).map((entry) => entry.replace(/^\//, "")));
  for (const entry of [
    "package.json",
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
    "node_modules/@ali/spark-mcp/package.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "i18n/en-US.json",
    "assets/icon.png",
  ]) assert(entries.has(entry), `ASAR entry missing: ${entry}`);

  const temporary = await mkdtemp(join(tmpdir(), "qwen-package-verify-"));
  try {
    extractAll(asarPath, temporary);
    const main = await readFile(join(temporary, "out/main/index.js"), "utf8");
    for (const marker of [
      `return "linux-x64"`,
      `Unsupported Linux architecture`,
      `path.join(process.resourcesPath, type, dir)`,
      `if (process.platform === "linux") return;`,
      `...process.platform === "linux" ? []`,
      `path.join(electron.app.getAppPath(), "i18n")`,
      `path.join(electron.app.getAppPath(), "assets/icon.png")`,
      `platform: process.platform, arch: process.arch`,
      `function cloneMcpConfig(configs)`,
      `function sanitizePersistedMcpConfig(configs, stripInheritedEnv = false)`,
      `sanitizePersistedMcpConfig(savedConfig, true)`,
      `process.env[key] === config.env[key]`,
      `await mcpServer.setMCPServers(adaptConfig(cloneMcpConfig(sanitized)))`,
      `sanitizePersistedMcpConfig(config, true)`,
      `sanitizePersistedMcpConfig(mcpServer.getMCPServers(), true)`,
      `const MAX_DIRECTORY_LIST_TEXT_CHARS = 20_000;`,
      `limitMcpToolResult(params, await mcpServer.callTool(params))`,
      `TRUNCATED BY QWEN DESKTOP`,
      `const pendingEvents = [];`,
      `electron.ipcMain.on("event-listener-ready", flushPendingEventType);`,
      `pendingEvents.findIndex((event) => event.type === type)`,
      `const matching = pendingEvents.filter((event) => event.type === type);`,
      `for (const event of matching) sendEventNow(event.type, event.payload);`,
      `MimeType=x-scheme-handler/qwen;`,
      `repairLinuxDesktopEntry(existing, appImagePath)`,
      `mimeMatch[1].split(";").filter(Boolean)`,
      `mimeTypes.includes("x-scheme-handler/qwen")`,
      `update-desktop-database`,
      `xdg-mime`,
      `["default", desktopName, "x-scheme-handler/qwen"]`,
      `if (desktop !== existing) await fs.writeFile`,
      `Failed to register Linux qwen protocol`,
      `electron.app.requestSingleInstanceLock()`,
      `electron.app.on("second-instance", (event, argv) => {`,
      `initialProtocolUrl = process.argv.find((arg) => arg.startsWith("qwen://"))`,
      `if (hasSingleInstanceLock) electron.app.whenReady().then(async () => {`,
      `registerIPC();\n  await restoreMcpConfig();\n  createWindow();\n  await callClient();\n  if (process.platform !== "darwin")`,
    ]) assert(main.includes(marker), `Packaged main process lacks marker: ${marker}`);
    assert(main.includes(`const autoUpdate = () => {\n  if (process.platform === "linux") return;`), "Linux updater return is not first");
    const preload = await readFile(join(temporary, "out/preload/index.js"), "utf8");
    assert(preload.includes(`electron.ipcRenderer.send("event-listener-ready", type);`), "Packaged preload lacks event listener ready handshake");
    assert(preload.includes(`normalized.args[normalized.args.length - 1] = process.env.HOME`), "Packaged preload lacks Filesystem Linux home default");
    assert(preload.includes(`normalizeFilesystemConfig(config)`), "Packaged preload lacks Filesystem IPC normalization");
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

  for (const forbidden of [join(resourcesDir, "app-update.yml"), join(resourcesDir, "latest-linux.yml"), join(targetRoot, "latest-linux.yml")]) {
    assert(!(await exists(forbidden)), `Updater metadata must not exist: ${forbidden}`);
  }
  await verifyDesktop();

  const appImage = join(root, "dist/Qwen-1.0.2-linux-x86_64.AppImage");
  const deb = join(root, "dist/qwen_1.0.2_amd64.deb");
  if ((await exists(appImage)) || (await exists(deb))) {
    assert(await exists(appImage), `Expected AppImage missing: ${basename(appImage)}`);
    assert(await exists(deb), `Expected DEB missing: ${basename(deb)}`);
  }
  console.log(`Verified Linux package layout: ${targetRoot}`);
}

await verify();

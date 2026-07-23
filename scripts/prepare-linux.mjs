import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, "asar-src");
const resources = join(root, "extract/Qwen.app/Contents/Resources");
const stageApp = join(root, ".stage/app");
const stageRuntime = join(root, ".stage/runtime");
const cacheDir = join(root, ".cache/downloads");
const iconsDir = join(root, "build/icons");

const downloads = {
  bun: {
    url: "https://github.com/oven-sh/bun/releases/download/bun-v1.2.10/bun-linux-x64.zip",
    file: "bun-linux-x64-v1.2.10.zip",
    sha256: "68a154ff1be96851b4d1a87cc5197f027ef80ab79afa3d4587150fae5c34c36e",
  },
  uv: {
    url: "https://github.com/astral-sh/uv/releases/download/0.7.14/uv-x86_64-unknown-linux-gnu.tar.gz",
    file: "uv-x86_64-unknown-linux-gnu-0.7.14.tar.gz",
    sha256: "2b38641d02bf107c5099f09778fda93bbaa4a4a2ee44ba303a4097102254e5e5",
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isAlternateStream(path) {
  return basename(path).includes(":com.apple.");
}

async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}

function replaceExactly(source, preimage, replacement, label) {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(preimage, offset)) !== -1) {
    count += 1;
    offset += preimage.length;
  }
  assert(count === 1, `${label}: expected exactly one preimage match, found ${count}`);
  return source.replace(preimage, replacement);
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

async function downloadLocked(entry) {
  const destination = join(cacheDir, entry.file);
  await mkdir(cacheDir, { recursive: true });
  try {
    if ((await sha256(destination)) === entry.sha256) return destination;
    await rm(destination, { force: true });
    throw new Error(`Cached archive checksum mismatch: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT" && !String(error.message).startsWith("Cached archive checksum mismatch")) throw error;
    if (String(error.message).startsWith("Cached archive checksum mismatch")) throw error;
  }

  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    const response = await fetch(entry.url, { redirect: "follow" });
    assert(response.ok && response.body, `Download failed (${response.status}) for ${entry.url}`);
    const file = await open(temporary, "wx");
    try {
      await file.writeFile(response.body);
    } finally {
      await file.close();
    }
    const actual = await sha256(temporary);
    assert(actual === entry.sha256, `Checksum mismatch for ${entry.file}: expected ${entry.sha256}, got ${actual}`);
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(destination, { force: true });
    throw error;
  }
}

async function validateElfX64(path) {
  const file = await open(path, "r");
  const header = Buffer.alloc(64);
  try {
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    assert(bytesRead >= 20, `${path} is too short to be ELF`);
  } finally {
    await file.close();
  }
  assert(header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), `${path} is not ELF`);
  assert(header[4] === 2, `${path} is not ELF64`);
  assert(header[5] === 1, `${path} is not little-endian ELF`);
  assert(header.readUInt16LE(18) === 62, `${path} is not x86-64 ELF`);
  await chmod(path, 0o755);
  assert(((await stat(path)).mode & 0o777) === 0o755, `${path} mode is not 0755`);
}

async function extractRuntimes() {
  const bunArchive = await downloadLocked(downloads.bun);
  const uvArchive = await downloadLocked(downloads.uv);
  const temporary = join(root, `.stage/runtime-extract-${process.pid}`);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, "bun"), { recursive: true });
  await mkdir(join(temporary, "uv"), { recursive: true });
  try {
    await run("unzip", ["-q", bunArchive, "-d", join(temporary, "bun")]);
    await run("tar", ["-xzf", uvArchive, "-C", join(temporary, "uv")]);
    const bunSource = join(temporary, "bun/bun-linux-x64/bun");
    const uvSourceDir = join(temporary, "uv/uv-x86_64-unknown-linux-gnu");
    const bunTarget = join(stageRuntime, "bun/linux-x64/bun");
    const pythonTarget = join(stageRuntime, "python/linux-x64");
    await mkdir(dirname(bunTarget), { recursive: true });
    await mkdir(pythonTarget, { recursive: true });
    await copyFile(bunSource, bunTarget);
    await copyFile(join(uvSourceDir, "uv"), join(pythonTarget, "uv"));
    await copyFile(join(uvSourceDir, "uvx"), join(pythonTarget, "uvx"));
    await validateElfX64(bunTarget);
    await validateElfX64(join(pythonTarget, "uv"));
    await validateElfX64(join(pythonTarget, "uvx"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function convertIcons() {
  const icnsPath = join(resources, "icon.icns");
  const data = await readFile(icnsPath);
  assert(data.subarray(0, 4).toString("ascii") === "icns", `${icnsPath} is not ICNS`);
  const declaredLength = data.readUInt32BE(4);
  assert(declaredLength === data.length, `Invalid ICNS length: ${declaredLength} != ${data.length}`);
  const pngs = [];
  for (let offset = 8; offset + 8 <= data.length; ) {
    const length = data.readUInt32BE(offset + 4);
    assert(length >= 8 && offset + length <= data.length, `Invalid ICNS record at ${offset}`);
    const payload = data.subarray(offset + 8, offset + length);
    if (payload.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      pngs.push({ width: payload.readUInt32BE(16), height: payload.readUInt32BE(20), payload });
    }
    offset += length;
  }
  const largest = pngs.sort((a, b) => b.width - a.width)[0];
  assert(largest && largest.width >= 256 && largest.height >= 256, "No 256x256-or-larger PNG exists in icon.icns");
  await rm(iconsDir, { recursive: true, force: true });
  await mkdir(iconsDir, { recursive: true });
  const source = join(iconsDir, ".source.png");
  await writeFile(source, largest.payload);
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    await run("magick", [source, "-filter", "Lanczos", "-resize", `${size}x${size}`, join(iconsDir, `${size}x${size}.png`)]);
  }
  await rm(source, { force: true });
}

async function stageApplication() {
  await rm(join(root, ".stage"), { recursive: true, force: true });
  await mkdir(stageApp, { recursive: true });
  const filter = (source) => !isAlternateStream(source);
  await cp(join(upstream, "out"), join(stageApp, "out"), { recursive: true, filter });
  await cp(join(upstream, "node_modules"), join(stageApp, "node_modules"), { recursive: true, filter });
  await cp(join(resources, "i18n"), join(stageApp, "i18n"), { recursive: true, filter });
  await cp(join(resources, "assets"), join(stageApp, "assets"), { recursive: true, filter });

  const packageJson = JSON.parse(await readFile(join(upstream, "package.json"), "utf8"));
  packageJson.desktopName = "com.qwen.chat.desktop";
  await writeFile(join(stageApp, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  const mainPath = join(stageApp, "out/main/index.js");
  let main = await readFile(mainPath, "utf8");
  main = replaceExactly(main, `function getPlatformDir(platform = os.platform(), arch = os.arch()) {\n  if (platform === "darwin") {\n    return arch === "arm64" ? "mac-arm64" : "mac-x64";\n  }\n  if (platform === "win32") {\n    return "win-x64";\n  }\n  throw new Error(\`Unsupported platform: \${platform}, arch: \${arch}\`);\n}`, `function getPlatformDir(platform = os.platform(), arch = os.arch()) {\n  if (platform === "darwin") {\n    return arch === "arm64" ? "mac-arm64" : "mac-x64";\n  }\n  if (platform === "win32") {\n    return "win-x64";\n  }\n  if (platform === "linux") {\n    if (arch === "x64") return "linux-x64";\n    throw new Error(\`Unsupported Linux architecture: \${arch}\`);\n  }\n  throw new Error(\`Unsupported platform: \${platform}, arch: \${arch}\`);\n}`, "Linux platform directory patch");
  main = replaceExactly(main, `  const base = utils.is.dev ? \`\${electron.app.getAppPath()}/resources/\${type}/\${dir}\` : path.join(process.resourcesPath, type);`, `  const base = utils.is.dev ? \`\${electron.app.getAppPath()}/resources/\${type}/\${dir}\` : path.join(process.resourcesPath, type, dir);`, "Production runtime resource path patch");
  main = replaceExactly(main, `const icon = path.join(__dirname, "../../resources/assets/icon.png");`, `const icon = path.join(electron.app.getAppPath(), "assets/icon.png");`, "Packaged icon path patch");
  main = replaceExactly(main, `const autoUpdate = () => {\n  electronUpdater.autoUpdater.autoDownload = false;`, `const autoUpdate = () => {\n  if (process.platform === "linux") return;\n  electronUpdater.autoUpdater.autoDownload = false;`, "Linux updater disable patch");
  main = replaceExactly(main, `      submenu: [\n        { role: "about", label: i18next.t("menu.about") },\n        { type: "separator" },\n        checkUpdateItem,\n        { type: "separator" },\n        { role: "quit", label: i18next.t("menu.quit") }\n      ]`, `      submenu: [\n        { role: "about", label: i18next.t("menu.about") },\n        { type: "separator" },\n        ...process.platform === "linux" ? [] : [checkUpdateItem, { type: "separator" }],\n        { role: "quit", label: i18next.t("menu.quit") }\n      ]`, "Linux update menu omission patch");
  main = replaceExactly(main, `const basePath = path.join(resourcesPath(), "i18n");`, `const basePath = path.join(electron.app.getAppPath(), "i18n");`, "Packaged i18n path patch");
  main = replaceExactly(main, `const getPlatformInfo = () => Promise.resolve({ os: process.platform });`, `const getPlatformInfo = () => Promise.resolve({ platform: process.platform, arch: process.arch });`, "Platform IPC contract patch");
  main = replaceExactly(main, `function adaptConfig(configs) {`, `function cloneMcpConfig(configs) {\n  return Object.fromEntries(Object.entries(configs || {}).map(([key, config]) => [key, {\n    ...config,\n    args: Array.isArray(config.args) ? [...config.args] : config.args,\n    env: config.env ? { ...config.env } : config.env\n  }]));\n}\nfunction sanitizePersistedMcpConfig(configs, stripInheritedEnv = false) {\n  const sanitized = cloneMcpConfig(configs);\n  for (const config of Object.values(sanitized)) {\n    if (typeof config.command === "string" && /\\/resources\\/bun\\/linux-x64\\/bun$/.test(config.command)) {\n      config.command = "npx";\n      if (Array.isArray(config.args) && config.args[0] === "x") config.args.shift();\n    } else if (typeof config.command === "string" && /\\/resources\\/python\\/linux-x64\\/uvx$/.test(config.command)) {\n      config.command = "uvx";\n    }\n    if (config.env && stripInheritedEnv) {\n      for (const key of Object.keys(config.env)) {\n        if (process.env[key] === config.env[key]) delete config.env[key];\n      }\n      if (!Object.keys(config.env).length) delete config.env;\n    }\n  }\n  return sanitized;\n}\nfunction adaptConfig(configs) {`, "MCP config clone and migration patch");
  main = replaceExactly(main, `const mcpServer = new sparkMcp.Proxy();`, `const mcpServer = new sparkMcp.Proxy();\nasync function restoreMcpConfig() {\n  const savedConfig = await settings.get("mcp_config");\n  if (!savedConfig || typeof savedConfig !== "object") return;\n  const sanitized = sanitizePersistedMcpConfig(savedConfig, true);\n  await mcpServer.setMCPServers(adaptConfig(cloneMcpConfig(sanitized)));\n  if (JSON.stringify(sanitized) !== JSON.stringify(savedConfig)) await settings.set("mcp_config", sanitized);\n}`, "MCP startup restore patch");
  main = replaceExactly(main, `    mcpServer.setMCPServers(adaptConfig(config));\n    settings.set("mcp_config", config);`, `    const persistedConfig = sanitizePersistedMcpConfig(config, true);\n    await mcpServer.setMCPServers(adaptConfig(cloneMcpConfig(persistedConfig)));\n    await settings.set("mcp_config", persistedConfig);`, "MCP update persistence patch");
  main = replaceExactly(main, `const mcpClientGetConfig = async () => mcpServer.getMCPServers();`, `const mcpClientGetConfig = async () => sanitizePersistedMcpConfig(mcpServer.getMCPServers(), true);`, "MCP live config sanitized read patch");
  main = replaceExactly(main, `const mcpClientToolCall = async (_, params) => mcpServer.callTool(params);`, `const MAX_DIRECTORY_LIST_TEXT_CHARS = 20_000;\nfunction limitMcpToolResult(params, result) {\n  if (params?.toolName !== "list_directory" || !Array.isArray(result?.content)) return result;\n  let remaining = MAX_DIRECTORY_LIST_TEXT_CHARS;\n  let truncated = false;\n  const content = result.content.map((item) => {\n    if (item?.type !== "text" || typeof item.text !== "string") return item;\n    if (item.text.length <= remaining) {\n      remaining -= item.text.length;\n      return item;\n    }\n    truncated = true;\n    const text = item.text.slice(0, Math.max(0, remaining));\n    remaining = 0;\n    return {\n      ...item,\n      text: text + "\\n\\n[TRUNCATED BY QWEN DESKTOP: directory listing exceeded " + MAX_DIRECTORY_LIST_TEXT_CHARS + " characters. Retry with depth=1 or a narrower path.]"\n    };\n  });\n  return truncated ? { ...result, content } : result;\n}\nconst mcpClientToolCall = async (_, params) => limitMcpToolResult(params, await mcpServer.callTool(params));`, "Bound list_directory MCP result patch");
  main = replaceExactly(main, `const fs = require("fs/promises");`, `const fs = require("fs/promises");\nconst childProcess = require("child_process");`, "Linux desktop database dependency patch");
  main = replaceExactly(main, `const sendEvent = (type, payload) => {\n  const wbs = electron.webContents.getAllWebContents();`, `const pendingEvents = [];\nconst readyEventTypes = new Set();\nconst sendEventNow = (type, payload) => {\n  const wbs = electron.webContents.getAllWebContents();`, "Queued renderer events send patch");
  main = replaceExactly(main, `    }\n  }\n};\nconst onEvent = (callback) => {`, `    }\n  }\n};\nconst sendEvent = (type, payload) => {\n  if (!readyEventTypes.has(type)) {\n    if (type === "set_cookie") {\n      const existingIndex = pendingEvents.findIndex((event) => event.type === type);\n      if (existingIndex !== -1) pendingEvents.splice(existingIndex, 1);\n    }\n    pendingEvents.push({ type, payload });\n    return;\n  }\n  sendEventNow(type, payload);\n};\nconst flushPendingEventType = (_, type) => {\n  readyEventTypes.add(type);\n  const matching = pendingEvents.filter((event) => event.type === type);\n  for (let index = pendingEvents.length - 1; index >= 0; index -= 1) {\n    if (pendingEvents[index].type === type) pendingEvents.splice(index, 1);\n  }\n  for (const event of matching) sendEventNow(event.type, event.payload);\n};\nconst onEvent = (callback) => {`, "Queued renderer events flush patch");
  main = replaceExactly(main, `  electron.ipcMain.handle("webview-loaded", webviewLoaded);`, `  electron.ipcMain.handle("webview-loaded", webviewLoaded);\n  electron.ipcMain.on("event-listener-ready", flushPendingEventType);`, "Renderer listener ready IPC patch");
  const preloadPath = join(stageApp, "out/preload/index.js");
  let preload = await readFile(preloadPath, "utf8");
  preload = replaceExactly(preload, `const api = {`, `function normalizeFilesystemConfig(configs) {\n  if (process.platform !== "linux") return configs;\n  return Object.fromEntries(Object.entries(configs || {}).map(([name, config]) => {\n    const normalized = { ...config, args: Array.isArray(config.args) ? [...config.args] : config.args };\n    if (Array.isArray(normalized.args) && normalized.args.includes("@modelcontextprotocol/server-filesystem@latest") && normalized.args.at(-1) === "/Users") {\n      normalized.args[normalized.args.length - 1] = process.env.HOME;\n    }\n    return [name, normalized];\n  }));\n}\nfunction normalizeFilesystemStorage() {\n  if (process.platform !== "linux") return;\n  try {\n    const key = "LOCAL_MCP_SERVER";\n    const servers = JSON.parse(window.localStorage.getItem(key) || "[]");\n    let changed = false;\n    for (const server of servers) {\n      if (server?.name === "Filesystem" && Array.isArray(server.params?.args) && server.params.args.at(-1) === "/Users") {\n        server.params.args[server.params.args.length - 1] = process.env.HOME;\n        server.connectionStatus = server.enabled ? "connecting" : server.connectionStatus;\n        server.errorMessage = "";\n        changed = true;\n      }\n    }\n    if (changed) window.localStorage.setItem(key, JSON.stringify(servers));\n  } catch (error) {\n    console.warn("Failed to normalize Filesystem MCP root", error);\n  }\n}\nnormalizeFilesystemStorage();\nif (process.platform === "linux") setInterval(normalizeFilesystemStorage, 1000);\nconst api = {`, "Filesystem Linux home migration patch");
  preload = replaceExactly(preload, `mcp_client_update_config: (config = {}) => electron.ipcRenderer.invoke("mcp_client_update_config", config),`, `mcp_client_update_config: (config = {}) => electron.ipcRenderer.invoke("mcp_client_update_config", normalizeFilesystemConfig(config)),`, "Filesystem IPC config normalization patch");
  preload = replaceExactly(preload, `    events.on(type, callback);`, `    events.on(type, callback);\n    electron.ipcRenderer.send("event-listener-ready", type);`, "Preload listener ready handshake patch");
  await writeFile(preloadPath, preload);
  main = replaceExactly(main, `  electron.app.on("second-instance", (event, argv) => {\n    console.log("second-instance", event);\n    if (process.platform !== "darwin") {\n      const url = argv.find((arg) => arg.startsWith("qwen://"));\n      if (url) handleProtocolUrl(url);\n    }\n  });\n`, ``, "Move second-instance listener patch");
  main = replaceExactly(main, `exports.mainWindow = null;\nif (!electron.app.isPackaged`, `exports.mainWindow = null;\nconst hasSingleInstanceLock = electron.app.requestSingleInstanceLock();\nif (!hasSingleInstanceLock) {\n  electron.app.quit();\n} else {\n  electron.app.on("second-instance", (event, argv) => {\n    console.log("second-instance", event);\n    if (process.platform !== "darwin") {\n      const url = argv.find((arg) => arg.startsWith("qwen://"));\n      if (url) handleProtocolUrl(url);\n    }\n  });\n}\nif (!electron.app.isPackaged`, "Single-instance lock patch");
  main = replaceExactly(main, `const callClient = () => {\n  if (!electron.app.isDefaultProtocolClient(SCHEME)) {\n    electron.app.setAsDefaultProtocolClient(SCHEME);\n  }`, `function quoteDesktopExec(value) {\n  return \`"\${value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"').replace(/\\\$/g, "\\\\\\$").replace(/\`/g, "\\\\\`")}"\`;\n}\nfunction repairLinuxDesktopEntry(existing, executable) {\n  if (!existing) {\n    return \`[Desktop Entry]\\nType=Application\\nName=Qwen\\nExec=\${quoteDesktopExec(executable)} %U\\nTerminal=false\\nIcon=qwen\\nStartupWMClass=com.qwen.chat\\nMimeType=x-scheme-handler/qwen;\\nCategories=Network;\\n\`;\n  }\n  let desktop = existing;\n  const mimeMatch = desktop.match(/^MimeType=(.*)$/m);\n  const mimeTypes = mimeMatch ? mimeMatch[1].split(";").filter(Boolean) : [];\n  if (!mimeTypes.includes("x-scheme-handler/qwen")) {\n    if (mimeMatch) {\n      mimeTypes.push("x-scheme-handler/qwen");\n      desktop = desktop.replace(/^MimeType=.*$/m, \`MimeType=\${mimeTypes.join(";")};\`);\n    } else {\n      desktop = desktop.replace(/^(?:Exec=.*)$/m, (line) => \`\${line}\\nMimeType=x-scheme-handler/qwen;\`);\n    }\n  }\n  desktop = desktop.replace(/^Exec=(.*)$/m, (line, command) => /(?:^|\\s)%[Uu](?:\\s|$)/.test(command) ? line : \`\${line} %U\`);\n  return desktop.endsWith("\\n") ? desktop : \`\${desktop}\\n\`;\n}\nasync function runDesktopCommand(command, args) {\n  await new Promise((resolveCommand) => {\n    childProcess.execFile(command, args, (error) => {\n      if (error && error.code !== "ENOENT") console.warn(\`Failed to run \${command}\`, error);\n      resolveCommand();\n    });\n  });\n}\nasync function registerLinuxProtocol() {\n  const applicationsDir = path.join(os.homedir(), ".local/share/applications");\n  const desktopName = "com.qwen.chat.desktop";\n  const desktopPath = path.join(applicationsDir, desktopName);\n  const appImagePath = process.env.APPIMAGE && !/[\\r\\n]/.test(process.env.APPIMAGE) ? process.env.APPIMAGE : process.execPath;\n  let existing = "";\n  try {\n    existing = await fs.readFile(desktopPath, "utf8");\n  } catch (error) {\n    if (error.code !== "ENOENT") throw error;\n  }\n  const desktop = repairLinuxDesktopEntry(existing, appImagePath);\n  await fs.mkdir(applicationsDir, { recursive: true });\n  if (desktop !== existing) await fs.writeFile(desktopPath, desktop, "utf8");\n  await runDesktopCommand("update-desktop-database", [applicationsDir]);\n  await runDesktopCommand("xdg-mime", ["default", desktopName, "x-scheme-handler/qwen"]);\n}\nconst callClient = async () => {\n  if (process.platform === "linux") {\n    try {\n      await registerLinuxProtocol();\n    } catch (error) {\n      console.warn("Failed to register Linux qwen protocol", error);\n    }\n  } else if (!electron.app.isDefaultProtocolClient(SCHEME)) {\n    electron.app.setAsDefaultProtocolClient(SCHEME);\n  }`, "Linux protocol desktop registration patch");
  main = replaceExactly(main, `  createWindow();\n  callClient();\n  registerIPC();`, `  registerIPC();\n  await restoreMcpConfig();\n  createWindow();\n  await callClient();\n  if (process.platform !== "darwin") {\n    const initialProtocolUrl = process.argv.find((arg) => arg.startsWith("qwen://"));\n    if (initialProtocolUrl) handleProtocolUrl(initialProtocolUrl);\n  }`, "Initial Linux protocol URL patch");
  main = replaceExactly(main, `electron.app.whenReady().then(async () => {`, `if (hasSingleInstanceLock) electron.app.whenReady().then(async () => {`, "Primary instance ready guard patch");
  await writeFile(mainPath, main);
}

async function verifyStage() {
  const required = [
    "package.json",
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
    "node_modules/@ali/spark-mcp/package.json",
    "i18n/en-US.json",
    "assets/icon.png",
  ];
  for (const item of required) await stat(join(stageApp, item));
  const main = await readFile(join(stageApp, "out/main/index.js"), "utf8");
  for (const marker of [
    `return "linux-x64"`,
    `Unsupported Linux architecture`,
    `path.join(process.resourcesPath, type, dir)`,
    `if (process.platform === "linux") return;`,
    `...process.platform === "linux" ? []`,
    `path.join(electron.app.getAppPath(), "i18n")`,
    `path.join(electron.app.getAppPath(), "assets/icon.png")`,
    `platform: process.platform, arch: process.arch`,
    `function sanitizePersistedMcpConfig(configs, stripInheritedEnv = false)`,
    `function cloneMcpConfig(configs)`,
    `sanitizePersistedMcpConfig(savedConfig, true)`,
    `process.env[key] === config.env[key]`,
    `async function restoreMcpConfig()`,
    `await mcpServer.setMCPServers(adaptConfig(cloneMcpConfig(sanitized)))`,
    `sanitizePersistedMcpConfig(config, true)`,
    `sanitizePersistedMcpConfig(mcpServer.getMCPServers(), true)`,
    `const MAX_DIRECTORY_LIST_TEXT_CHARS = 20_000;`,
    `limitMcpToolResult(params, await mcpServer.callTool(params))`,
    `TRUNCATED BY QWEN DESKTOP`,
    `const pendingEvents = [];`,
    `electron.ipcMain.on("event-listener-ready", flushPendingEventType);`,
    `readyEventTypes.has(type)`,
    `pendingEvents.findIndex((event) => event.type === type)`,
    `const matching = pendingEvents.filter((event) => event.type === type);`,
    `for (const event of matching) sendEventNow(event.type, event.payload);`,
    `MimeType=x-scheme-handler/qwen;`,
    `update-desktop-database`,
    `xdg-mime`,
    `repairLinuxDesktopEntry(existing, appImagePath)`,
    `Failed to register Linux qwen protocol`,
    `process.env.APPIMAGE`,
    `electron.app.requestSingleInstanceLock()`,
    `electron.app.on("second-instance", (event, argv) => {`,
    `initialProtocolUrl = process.argv.find((arg) => arg.startsWith("qwen://"))`,
    `if (hasSingleInstanceLock) electron.app.whenReady().then(async () => {`,
    `registerIPC();\n  await restoreMcpConfig();\n  createWindow();\n  await callClient();\n  if (process.platform !== "darwin")`,
  ]) assert(main.includes(marker), `Staged main process lacks marker: ${marker}`);
  const preload = await readFile(join(stageApp, "out/preload/index.js"), "utf8");
  assert(preload.includes(`electron.ipcRenderer.send("event-listener-ready", type);`), "Staged preload lacks event listener ready handshake");
  for (const item of ["bun/linux-x64/bun", "python/linux-x64/uv", "python/linux-x64/uvx"]) {
    await validateElfX64(join(stageRuntime, item));
  }
  const iconFiles = await Promise.all([16, 32, 48, 64, 128, 256, 512, 1024].map(async (size) => {
    const path = join(iconsDir, `${size}x${size}.png`);
    await stat(path);
    return relative(root, path);
  }));
  console.log(`Prepared ${relative(root, stageApp)}, runtimes, and icons: ${iconFiles.join(", ")}`);
}

await stageApplication();
await extractRuntimes();
await convertIcons();
await verifyStage();

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(root, process.argv.find((arg) => arg.startsWith("--executable="))?.slice(13) ?? "dist/linux-unpacked/qwen");
const expectedVersion = process.argv.find((arg) => arg.startsWith("--version="))?.slice(10);
if (!expectedVersion) throw new Error("--version is required");
const profile = await mkdtemp(join(tmpdir(), "qwen-smoke-"));
const port = 9229 + Math.floor(Math.random() * 1000);
const child = spawn(executable, ["--no-sandbox", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, APPIMAGE: process.env.APPIMAGE ?? "", ELECTRON_IS_DEV: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

async function fetchTargets(url) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : [];
  } catch {
    return [];
  }
}

try {
  const deadline = Date.now() + 60_000;
  let page;
  let targets = [];
  while (Date.now() < deadline && !page) {
    targets = await fetchTargets(`http://127.0.0.1:${port}/json/list`);
    page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && (target.url.startsWith("file:") || target.url.startsWith("app:"))) ?? targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl && !target.url.startsWith("devtools://"));
    if (!page) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  if (!page) throw new Error(`No BrowserWindow target found: ${JSON.stringify(targets)}\n${stderr}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  });
  const evaluate = (expression) => new Promise((resolveEval, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveEval, reject });
    socket.send(JSON.stringify({ id: requestId, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const result = await evaluate(`(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (location.href.startsWith('https://chat.qwen.ai')) return { webview: location.href, guest: true };
      const webview = document.querySelector('webview');
      if (webview && window.electron?.ipcRenderer) {
        return {
          webview: webview.src,
          platform: await window.electron.ipcRenderer.invoke('get_platform_info'),
          version: await window.electron.ipcRenderer.invoke('get_app_version'),
          mcp: await window.electron.ipcRenderer.invoke('mcp_client_get_config')
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Renderer API or webview not ready');
  })()`);
  if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description ?? "unknown"}`);
  const value = result.result.value;
  if (!value?.webview?.startsWith("https://chat.qwen.ai")) throw new Error(`Unexpected webview URL: ${value?.webview}; target=${page.url}`);
  if (JSON.stringify(value.platform) !== JSON.stringify({ platform: "linux", arch: "x64" })) throw new Error(`Unexpected platform info: ${JSON.stringify(value.platform)}`);
  if (value.version !== expectedVersion) throw new Error(`Unexpected version ${value.version}, expected ${expectedVersion}`);
  console.log(JSON.stringify(value));
  socket.close();
} finally {
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit)).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}

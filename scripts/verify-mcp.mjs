import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import process from "node:process";
import vm from "node:vm";
import { extractAll } from "@electron/asar";

const root = resolve(import.meta.dirname, "..");
const resourcesDir = join(root, "dist/linux-unpacked/resources");
const asarPath = join(resourcesDir, "app.asar");
const extracted = await mkdtemp(join(tmpdir(), "qwen-mcp-"));
const originalConsoleLog = console.log;
console.log = () => {};
const fixtureStderr = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withTimeout(promise, label, timeoutMs = 180_000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function waitForLine(stream, label, timeoutMs = 30_000) {
  return await withTimeout(new Promise((resolveLine, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        cleanup();
        resolveLine(buffer.slice(0, newline).trim());
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`${label} ended before reporting readiness`));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  }), label, timeoutMs);
}

function textResult(result) {
  return result?.content?.find((item) => item.type === "text")?.text;
}

async function freshProxy(Proxy, configs, clients) {
  const proxy = new Proxy();
  await proxy.setMCPServers(configs);
  const originalGetClient = proxy.getClient;
  proxy.getClient = async (serverName) => {
    const client = await originalGetClient(serverName);
    if (!clients.includes(client)) clients.push(client);
    return client;
  };
  return proxy;
}

async function verifyProxyPathPatch(main) {
  assert(main.includes(`path.join(process.resourcesPath, type, dir)`), "Packaged runtime path patch is absent");
  assert(main.includes(`if (arch === "x64") return "linux-x64";`), "Packaged Linux platform mapping is absent");
  const bun = join(resourcesDir, "bun/linux-x64/bun");
  const uvx = join(resourcesDir, "python/linux-x64/uvx");
  assert(main.includes(`return getBunPath()`), "Bun command rewrite is absent");
  assert(main.includes(`return getUvxPath()`), "uvx command rewrite is absent");
  return { bun, uvx };
}

function runPackagedAdaptConfig(main, configs) {
  const start = main.indexOf("function getPlatformDir(");
  const endMarker = "  return configs;\n}";
  const end = main.indexOf(endMarker, start);
  assert(start !== -1 && end !== -1, "Could not isolate packaged adaptConfig implementation");
  const implementation = main.slice(start, end + endMarker.length);
  const sandbox = {
    electron: { app: { getAppPath: () => extracted, isPackaged: true } },
    os: { platform: () => "linux", arch: () => "x64" },
    path: { join },
    process: { resourcesPath: resourcesDir, env: { PATH: process.env.PATH } },
    utils: { is: { dev: false } },
    configs: structuredClone(configs),
    result: undefined,
  };
  vm.runInNewContext(`${implementation}\nresult = adaptConfig(configs);`, sandbox, { timeout: 5_000 });
  return sandbox.result;
}

extractAll(asarPath, extracted);
const requireFromApp = createRequire(join(extracted, "package.json"));
const { Proxy } = requireFromApp("@ali/spark-mcp");
const packagedMain = await readFile(join(extracted, "out/main/index.js"), "utf8");
const { bun, uvx } = await verifyProxyPathPatch(packagedMain);
const fixtureEnv = { ...process.env, QWEN_PACKAGED_APP_DIR: extracted };
const adaptedBun = runPackagedAdaptConfig(packagedMain, {
  bun: { command: "bun", args: [join(root, "scripts/mcp/bun-fixture.ts")], transportType: "stdio", env: fixtureEnv },
});
assert(adaptedBun.bun.command === bun, `adaptConfig rewrote bun to ${adaptedBun.bun.command}, expected ${bun}`);
const adaptedUvx = runPackagedAdaptConfig(packagedMain, {
  uvx: { command: "uvx", args: ["--from", "mcp-server-time==2025.7.1", "mcp-server-time"], transportType: "stdio", env: fixtureEnv },
});
assert(adaptedUvx.uvx.command === uvx, `adaptConfig rewrote uvx to ${adaptedUvx.uvx.command}, expected ${uvx}`);
assert(adaptedBun.bun.env.QWEN_PACKAGED_APP_DIR === extracted, "adaptConfig dropped QWEN_PACKAGED_APP_DIR for Bun");
assert(adaptedUvx.uvx.env.QWEN_PACKAGED_APP_DIR === extracted, "adaptConfig dropped QWEN_PACKAGED_APP_DIR for uvx");
const clients = [];

let httpFixture;
try {
  const bunConfig = adaptedBun;
  const bunProxy = await freshProxy(Proxy, bunConfig, clients);
  const bunTools = await withTimeout(bunProxy.listTools({ serverName: "bun" }), "Bun listTools");
  assert(bunTools.tools.some((tool) => tool.name === "echo"), "Bun MCP echo tool missing");
  const bunResult = await withTimeout(bunProxy.callTool({ serverName: "bun", toolName: "echo", toolArguments: { value: "bun" } }), "Bun callTool");
  assert(textResult(bunResult) === "bun", "Bun MCP echo returned the wrong result");

  const uvxConfig = adaptedUvx;
  const uvxProxy = await freshProxy(Proxy, uvxConfig, clients);
  const uvxTools = await withTimeout(uvxProxy.listTools({ serverName: "uvx" }), "uvx listTools", 300_000);
  assert(uvxTools.tools.some((tool) => tool.name === "get_current_time"), "uvx get_current_time tool missing");
  const uvxResult = await withTimeout(uvxProxy.callTool({ serverName: "uvx", toolName: "get_current_time", toolArguments: { timezone: "UTC" } }), "uvx callTool", 300_000);
  assert(/UTC/i.test(textResult(uvxResult) ?? JSON.stringify(uvxResult)), "uvx UTC result is invalid");

  httpFixture = spawn(process.execPath, [join(root, "scripts/mcp/http-fixture.cjs")], {
    cwd: root,
    env: fixtureEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  httpFixture.stderr.on("data", (chunk) => fixtureStderr.push(chunk.toString()));
  const ready = JSON.parse(await waitForLine(httpFixture.stdout, "HTTP fixture readiness"));
  assert(Number.isInteger(ready.port) && ready.port > 0, "HTTP fixture returned an invalid port");

  for (const [transportType, path, value] of [["sse", "/sse", "sse"], ["httpStream", "/mcp", "httpStream"]]) {
    const serverName = transportType;
    const proxy = await freshProxy(Proxy, { [serverName]: { transportType, url: `http://127.0.0.1:${ready.port}${path}` } }, clients);
    const tools = await withTimeout(proxy.listTools({ serverName }), `${transportType} listTools`);
    assert(tools.tools.some((tool) => tool.name === "echo"), `${transportType} echo tool missing`);
    const result = await withTimeout(proxy.callTool({ serverName, toolName: "echo", toolArguments: { value } }), `${transportType} callTool`);
    assert(textResult(result) === value, `${transportType} echo returned the wrong result`);
  }

  originalConsoleLog("Verified MCP transports: Bun stdio, uvx stdio, SSE, Streamable HTTP");
} catch (error) {
  if (fixtureStderr.length) error.message += `\nHTTP fixture stderr:\n${fixtureStderr.join("")}`;
  throw error;
} finally {
  console.log = originalConsoleLog;
  await Promise.allSettled(clients.map((client) => client.close()));
  if (httpFixture && httpFixture.exitCode === null) {
    httpFixture.kill("SIGTERM");
    await withTimeout(new Promise((resolveExit) => httpFixture.once("exit", resolveExit)), "HTTP fixture shutdown", 10_000).catch(() => httpFixture.kill("SIGKILL"));
  }
  await rm(extracted, { recursive: true, force: true });
}

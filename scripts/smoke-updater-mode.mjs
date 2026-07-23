import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(root, process.argv.find((arg) => arg.startsWith("--executable="))?.slice(13) ?? "dist/linux-unpacked/qwen");
const appImage = process.argv.find((arg) => arg.startsWith("--appimage="))?.slice(11);
const expectRequests = process.argv.includes("--expect-requests");
const profile = await mkdtemp(join(tmpdir(), "qwen-updater-smoke-"));
let requests = 0;
const server = createServer((_request, response) => {
  requests += 1;
  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("fixture");
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
let stderr = "";
const child = spawn(executable, ["--no-sandbox", `--user-data-dir=${profile}`], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_IS_DEV: "1",
    QWEN_TEST_UPDATE_URL: `http://127.0.0.1:${address.port}/`,
    ...(appImage ? { APPIMAGE: resolve(root, appImage) } : { APPIMAGE: "" }),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.on("data", (chunk) => (stderr += chunk));
try {
  const deadline = Date.now() + 30_000;
  while (expectRequests && requests === 0 && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  if (!expectRequests) await new Promise((resolveWait) => setTimeout(resolveWait, 8_000));
  if (child.exitCode !== null) throw new Error(`Application exited before updater assertion (${child.exitCode})\n${stderr}`);
  if (expectRequests && requests === 0) throw new Error(`AppImage mode made no update feed request\n${stderr}`);
  if (!expectRequests && requests !== 0) throw new Error(`Non-AppImage mode made ${requests} update feed requests`);
  console.log(JSON.stringify({ requests, appImage: Boolean(appImage) }));
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

async function run(command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

export default async function artifactBuildCompleted(context) {
  if (!context.file?.endsWith(".deb")) return;
  const temporary = await mkdtemp(join(tmpdir(), "qwen-deb-repack-"));
  try {
    const data = join(temporary, "data");
    await run("dpkg-deb", ["-R", context.file, data]);
    await rm(join(data, "opt/Qwen/resources/app-update.yml"), { force: true });
    const rebuilt = join(temporary, basename(context.file));
    await run("dpkg-deb", ["--build", "--root-owner-group", data, rebuilt]);
    await run("cp", [rebuilt, context.file]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

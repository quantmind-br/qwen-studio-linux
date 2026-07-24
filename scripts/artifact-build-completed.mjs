import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

async function run(command, args, env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: env ? { ...process.env, ...env } : process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

async function repackDeb(file) {
  const temporary = await mkdtemp(join(tmpdir(), "qwen-deb-repack-"));
  try {
    const data = join(temporary, "data");
    await run("dpkg-deb", ["-R", file, data]);
    await rm(join(data, "opt/Qwen/resources/app-update.yml"), { force: true });
    const rebuilt = join(temporary, basename(file));
    await run("dpkg-deb", ["--build", "--root-owner-group", data, rebuilt]);
    await run("cp", [rebuilt, file]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// `pacman.publish: null` does not stop app-builder-lib's FpmTarget from embedding
// resources/app-update.yml and resources/package-type, so strip both and rebuild a
// canonical Arch package (root-owned, makepkg-style .MTREE) with only bsdtar/zstd.
async function repackPacman(file) {
  const temporary = await mkdtemp(join(tmpdir(), "qwen-pacman-repack-"));
  try {
    const out = join(temporary, "out.pkg.tar.zst");
    const script = [
      "set -euo pipefail",
      "export LC_COLLATE=C",
      'mkdir -p "$WORK/pkg"',
      'bsdtar -xpf "$FILE" -C "$WORK/pkg"',
      'cd "$WORK/pkg"',
      "rm -f opt/Qwen/resources/app-update.yml opt/Qwen/resources/package-type .MTREE",
      "shopt -s dotglob globstar",
      "printf '%s\\0' **/* | LANG=C bsdtar -cnf - --format=mtree --options='!all,use-set,type,uid,gid,mode,time,size,sha256,link' --null --files-from - --exclude .MTREE | gzip -c -f -n > .MTREE",
      'printf \'%s\\0\' **/* | LANG=C bsdtar --no-fflags --no-read-sparse -cnf - --null --files-from - | zstd -c -T0 -19 -q > "$OUT"',
    ].join("\n");
    await run("fakeroot", ["bash", "-c", script], { WORK: temporary, FILE: file, OUT: out });
    await run("cp", [out, file]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export default async function artifactBuildCompleted(context) {
  if (context.file?.endsWith(".deb")) return repackDeb(context.file);
  if (context.file?.endsWith(".pkg.tar.zst")) return repackPacman(context.file);
}

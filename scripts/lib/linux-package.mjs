import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const RENDERER_PREIMAGE = `      window.electron.ipcRenderer.invoke("webview-loaded", webContentsId);`;
export const PUBLIC_UPDATE_URL = "https://github.com/quantmind-br/qwen-studio-linux-releases/releases/latest/download/";

export async function resolveRendererBundle(appRoot, preimage = RENDERER_PREIMAGE) {
  const assetsDir = join(appRoot, "out/renderer/assets");
  const entries = await readdir(assetsDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^index-.*\.js$/.test(entry.name)) continue;
    const path = join(assetsDir, entry.name);
    if ((await readFile(path, "utf8")).includes(preimage)) candidates.push(path);
  }
  if (candidates.length !== 1) {
    throw new Error(`Renderer bundle resolution expected exactly one preimage match, found ${candidates.length}: ${candidates.join(", ") || "none"}`);
  }
  return candidates[0];
}

export function assertCanonicalVersion(version, label = "version") {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error(`${label} must be canonical SemVer, got ${JSON.stringify(version)}`);
  }
  return version;
}

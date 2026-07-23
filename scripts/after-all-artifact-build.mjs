import { rm } from "node:fs/promises";
import { join } from "node:path";

export default async function afterAllArtifactBuild(context) {
  await rm(join(context.outDir, "linux-unpacked/resources/app-update.yml"), { force: true });
  return [];
}

import { rm } from "node:fs/promises";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  await rm(join(context.appOutDir, "resources/app-update.yml"), { force: true });
}

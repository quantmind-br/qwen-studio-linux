import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packagedApp = process.env.QWEN_PACKAGED_APP_DIR;
if (!packagedApp) throw new Error("QWEN_PACKAGED_APP_DIR is required");
const importPackaged = (path: string) => import(pathToFileURL(join(packagedApp, path)).href);
const { McpServer } = await importPackaged("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js");
const { StdioServerTransport } = await importPackaged("node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js");
const { z } = await importPackaged("node_modules/zod/index.js");

const server = new McpServer({ name: "qwen-bun-fixture", version: "1.0.0" });
server.tool(
  "echo",
  "Return the supplied value",
  { value: z.string() },
  async ({ value }: { value: string }) => ({ content: [{ type: "text", text: value }] }),
);

await server.connect(new StdioServerTransport());

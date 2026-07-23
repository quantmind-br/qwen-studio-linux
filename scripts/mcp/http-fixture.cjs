"use strict";

const http = require("node:http");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

const packagedApp = process.env.QWEN_PACKAGED_APP_DIR;
if (!packagedApp) throw new Error("QWEN_PACKAGED_APP_DIR is required");
const importPackaged = (path) => import(pathToFileURL(join(packagedApp, path)).href);

async function main() {
  const [{ McpServer }, { SSEServerTransport }, { StreamableHTTPServerTransport }, { isInitializeRequest }, { z }] = await Promise.all([
    importPackaged("node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js"),
    importPackaged("node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js"),
    importPackaged("node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js"),
    importPackaged("node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"),
    importPackaged("node_modules/zod/index.js"),
  ]);

  const createMcpServer = () => {
    const server = new McpServer({ name: "qwen-http-fixture", version: "1.0.0" });
    server.tool(
      "echo",
      "Return the supplied value",
      { value: z.string() },
      async ({ value }) => ({ content: [{ type: "text", text: value }] }),
    );
    return server;
  };

  const sseTransports = new Map();
  const streamTransports = new Map();
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports.set(transport.sessionId, transport);
        transport.onclose = () => sseTransports.delete(transport.sessionId);
        await createMcpServer().connect(transport);
        return;
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        const transport = sseTransports.get(url.searchParams.get("sessionId"));
        if (!transport) {
          res.writeHead(404).end("Unknown SSE session");
          return;
        }
        await transport.handlePostMessage(req, res, await readBody(req));
        return;
      }
      if (url.pathname === "/mcp") {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const sessionId = req.headers["mcp-session-id"];
        let transport = sessionId ? streamTransports.get(sessionId) : undefined;
        if (!transport && req.method === "POST" && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => streamTransports.set(id, transport),
          });
          transport.onclose = () => {
            if (transport.sessionId) streamTransports.delete(transport.sessionId);
          };
          await createMcpServer().connect(transport);
        }
        if (!transport) {
          res.writeHead(sessionId ? 404 : 400).end(sessionId ? "Unknown HTTP stream session" : "Missing initialization request");
          return;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      res.writeHead(404).end("Not found");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500);
      res.end("Fixture error");
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  console.log(JSON.stringify({ port: address.port }));

  const shutdown = async () => {
    for (const transport of [...sseTransports.values(), ...streamTransports.values()]) {
      await transport.close().catch(() => {});
    }
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

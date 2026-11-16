#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildTools, createDeps } from "./tools.js";

// stdout carries the MCP protocol: every log in this process goes to stderr.
const config = loadConfig();
const tools = buildTools(createDeps(config));
const server = new McpServer({ name: "pokelances", version: "0.1.0" });

for (const t of tools) {
  server.registerTool(
    t.name,
    {
      title: t.title,
      description: t.description,
      inputSchema: t.input,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: t.name === "search_store" },
    },
    async (args: Record<string, unknown>) => {
      const started = Date.now();
      try {
        const result = await t.run(args);
        console.error(`[tool] ${t.name} ok ${Date.now() - started}ms`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[tool] ${t.name} error ${Date.now() - started}ms: ${message}`);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error(`pokelances-mcp ready (catalog: ${config.catalogPath}, store: ${config.storeUrl})`);

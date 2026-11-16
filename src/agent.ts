#!/usr/bin/env node
/**
 * A Claude agent that uses the pokelances MCP server as its only tools.
 * Usage: npm run agent -- "Tengo un Charizard ex de 151 casi nuevo y 2 Pikachu reverse"
 */
import Anthropic from "@anthropic-ai/sdk";
import { mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./config.js";

const MAX_STEPS = 8;
const request = process.argv.slice(2).join(" ").trim();
if (!request) {
  console.error('Usage: npm run agent -- "Tengo un Charizard ex de 151 casi nuevo"');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Set ANTHROPIC_API_KEY to run the agent. The MCP server itself works without it.");
  process.exit(2);
}

const runId = randomBytes(4).toString("hex");
const logPath = join(ROOT, "data", "agent-log.jsonl");
mkdirSync(join(ROOT, "data"), { recursive: true });

const SYSTEM = `Eres el asistente de inventario de PokeLances, un marketplace de Pokémon TCG en Perú.
Conviertes lo que el vendedor describe en borradores de publicación.

Para cada producto:
1. Búscalo con search_cards. Si hay varias coincidencias y el set o el número no alcanzan para decidir, no adivines: no crees ese borrador y pide el dato al final.
2. Revisa con search_store si ya está publicado.
3. Si el vendedor no dio precio, usa el sugerido (create_draft lo calcula si omites pricePen).
4. Crea el borrador con create_draft. idempotencyKey = "${runId}-<productId>-<condición>-<idioma>".

Condición: "casi nuevo" o "mint" = NM, "poco uso" = LP, "usado" = MP, "muy usado" = HP, "dañado" = DMG. Si no la dice, NM y avísalo.
Nunca publicas nada: solo creas borradores que el vendedor revisa.
Responde en español con una tabla corta (carta, set, condición, precio S/, avisos) y, al final, lo que necesitas que el vendedor aclare.`;

const serverPath = join(fileURLToPath(new URL(".", import.meta.url)), "server.js");
const mcp = new Client({ name: "pokelances-agent", version: "0.1.0" });
await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: "ignore" }));

try {
  const { tools } = await mcp.listTools();
  // Log every tool call: which tool, arguments, duration and whether it failed.
  // The MCP SDK types also allow a legacy result shape; at runtime callTool returns { content }.
  const runnable = mcpTools(tools, mcp as unknown as Parameters<typeof mcpTools>[1]).map((tool) => ({
    ...tool,
    run: async (args: Record<string, unknown>, ctx?: Parameters<typeof tool.run>[1]) => {
      const started = Date.now();
      let ok = true;
      try {
        return await tool.run(args, ctx);
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        const entry = { runId, at: new Date().toISOString(), tool: tool.name, args, ms: Date.now() - started, ok };
        appendFileSync(logPath, JSON.stringify(entry) + "\n");
        console.error(`  → ${tool.name} ${JSON.stringify(args)} (${entry.ms} ms)`);
      }
    },
  }));

  const anthropic = new Anthropic();
  console.error(`run ${runId}: ${tools.length} tools from the MCP server`);
  const final = await anthropic.beta.messages.toolRunner({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    max_iterations: MAX_STEPS,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: runnable,
    messages: [{ role: "user", content: request }],
  });

  if (final.stop_reason === "refusal") {
    console.error("The model declined this request.");
    process.exitCode = 1;
  } else {
    if (final.stop_reason === "tool_use") console.error(`Stopped at the ${MAX_STEPS}-step limit: the result may be incomplete.`);
    for (const block of final.content) if (block.type === "text") console.log(block.text);
  }
} finally {
  await mcp.close();
}

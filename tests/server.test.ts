// End to end: start the real MCP server over stdio and call it like Claude Code would.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
let http: Server;
let client: Client;

// A fake PokeLances API so the test never hits the real store.
const LISTINGS = [{ id: "1", name: "Charizard ex", type: "card", set_name: "Scarlet & Violet 151", condition: "NM", fixed_price: "1150.00", quantity: 1, language: "English", description: "N.º 199/165 · Holofoil" }];

before(async () => {
  http = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ listings: LISTINGS, total: LISTINGS.length }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;

  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(root, "src", "server.ts")],
      cwd: root,
      stderr: "ignore",
      env: {
        ...(process.env as Record<string, string>),
        CATALOG_PATH: join(root, "fixtures", "catalog-sample.json"),
        DRAFTS_PATH: join(mkdtempSync(join(tmpdir(), "mcp-")), "drafts.json"),
        STORE_URL: `http://127.0.0.1:${port}`,
      },
    }),
  );
});

after(async () => {
  await client?.close();
  http?.close();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { isError: r.isError ?? false, text: r.content[0].text, json: () => JSON.parse(r.content[0].text) };
};

test("exposes the six tools with descriptions", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["create_draft", "list_drafts", "search_cards", "search_help", "search_store", "suggest_price"]);
  assert.ok(tools.every((t) => (t.description ?? "").length > 40));
  assert.equal(tools.find((t) => t.name === "search_cards")?.annotations?.readOnlyHint, true);
});

test("search_cards finds a card by name and number", async () => {
  const r = (await call("search_cards", { name: "Charizard ex", number: "199" })).json();
  assert.equal(r.count, 1);
  assert.equal(r.results[0].productId, 517045);
  assert.equal(r.results[0].marketUsd.Holofoil, 309.65);
});

test("invalid arguments come back as a tool error, not a crash", async () => {
  const r = await call("suggest_price", { productId: "not-a-number" });
  assert.equal(r.isError, true);
  const missing = await call("suggest_price", { productId: 1 });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /search_cards/);
});

test("create_draft warns about duplicates and is idempotent", async () => {
  const args = { productId: 517045, condition: "NM", language: "English", idempotencyKey: "test-517045-NM-English" };
  const first = (await call("create_draft", args)).json();
  assert.equal(first.created, true);
  assert.equal(first.draft.priceSource, "suggested");
  assert.equal(first.draft.pricePen, 1161);
  assert.match(first.draft.warnings.join(" "), /Already listed/);

  const retry = (await call("create_draft", args)).json();
  assert.equal(retry.created, false);
  assert.equal(retry.draft.id, first.draft.id);
  assert.equal((await call("list_drafts")).json().count, 1);
});

test("another printing of the same card is not flagged as a duplicate", async () => {
  // Charizard ex 006/165 vs the listed 199/165
  const r = (await call("create_draft", { productId: 502558, condition: "NM", idempotencyKey: "test-502558-NM-English" })).json();
  assert.deepEqual(r.draft.warnings, []);
});

test("a seller price far from the suggestion gets a warning", async () => {
  const r = (await call("create_draft", { productId: 517033, condition: "NM", pricePen: 50, idempotencyKey: "test-517033-NM-English" })).json();
  assert.equal(r.draft.priceSource, "seller");
  assert.match(r.draft.warnings.join(" "), /far from the suggested/);
});

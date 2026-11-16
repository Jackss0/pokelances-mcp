import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { baseName, Catalog, normalize } from "../src/catalog.ts";

const catalog = Catalog.load(fileURLToPath(new URL("../fixtures/catalog-sample.json", import.meta.url)));

test("normalize strips accents, case and punctuation", () => {
  assert.equal(normalize("Pokémon: Scarlet & Violet—151"), "pokemon scarlet violet 151");
});

test("baseName removes the collector number TCGplayer appends", () => {
  assert.equal(baseName("Charizard ex - 199/165"), "Charizard ex");
  assert.equal(baseName("Pikachu - SVP 085"), "Pikachu");
  assert.equal(baseName("151 Booster Bundle"), "151 Booster Bundle");
});

test("search by name returns every printing", () => {
  const r = catalog.search({ name: "charizard ex" });
  assert.deepEqual(r.map((p) => p.number), ["006/165", "183/165", "199/165"]);
});

test("collector number narrows to one card, with or without padding", () => {
  assert.equal(catalog.search({ name: "Charizard ex", number: "199/165" })[0].productId, 517045);
  assert.equal(catalog.search({ name: "Pikachu", number: "25" })[0].productId, 517033);
});

test("set filter accepts the set code", () => {
  assert.equal(catalog.search({ name: "Pikachu", set: "MEW" }).length, 2);
  assert.equal(catalog.search({ name: "Pikachu", set: "Surging Sparks" }).length, 0);
});

test("kind filter separates sealed products from cards", () => {
  const sealed = catalog.search({ name: "151", kind: "sealed", limit: 25 });
  assert.ok(sealed.length > 0);
  assert.ok(sealed.every((p) => p.kind === "sealed"));
});

test("empty or unknown names return nothing", () => {
  assert.equal(catalog.search({ name: "  " }).length, 0);
  assert.equal(catalog.search({ name: "Agumon" }).length, 0);
});

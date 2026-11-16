import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Product } from "../src/catalog.ts";
import { DraftStore, type NewDraft } from "../src/drafts.ts";
import { suggestPrice } from "../src/pricing.ts";
import { Store, type Listing } from "../src/store.ts";

const pikachu: Product = {
  productId: 517033, name: "Pikachu - 025/165", set: "SV: Scarlet & Violet 151", setCode: "MEW", number: "025/165",
  rarity: "Common", kind: "card", url: null, imageUrl: null,
  prices: [{ subType: "Reverse Holofoil", market: 0.85, low: 0.2 }, { subType: "Normal", market: 0.31, low: 0.04 }],
};

test("suggestPrice: market x rate x condition, rounded to S/ 0.50", () => {
  const nm = suggestPrice({ ...pikachu, prices: [{ subType: "Holofoil", market: 309.65, low: null }] }, { condition: "NM", usdToPen: 3.75 });
  assert.ok(nm.ok);
  assert.equal(nm.suggestedPen, 1161.0); // 309.65 * 3.75 = 1161.19
  const lp = suggestPrice({ ...pikachu, prices: [{ subType: "Holofoil", market: 309.65, low: null }] }, { condition: "LP", usdToPen: 3.75 });
  assert.ok(lp.ok);
  assert.equal(lp.suggestedPen, 987.0); // * 0.85 = 987.01
});

test("suggestPrice: picks the requested sub-type and lists the others", () => {
  const r = suggestPrice(pikachu, { condition: "NM", usdToPen: 3.75, subType: "normal" });
  assert.ok(r.ok);
  assert.equal(r.subType, "Normal");
  assert.equal(r.suggestedPen, 1.0);
  assert.deepEqual(r.otherSubTypes, ["Reverse Holofoil"]);
});

test("suggestPrice: explains when there is no market price", () => {
  const r = suggestPrice({ ...pikachu, prices: [{ subType: "Normal", market: null, low: null }] }, { condition: "NM", usdToPen: 3.75 });
  assert.equal(r.ok, false);
});

test("DraftStore: same idempotency key returns the same draft", () => {
  const store = new DraftStore(join(mkdtempSync(join(tmpdir(), "drafts-")), "drafts.json"));
  const input: NewDraft = {
    idempotencyKey: "run1-517033-NM-English", productId: 517033, name: "Pikachu", set: "151", number: "025/165",
    condition: "NM", language: "English", quantity: 2, pricePen: 3, priceSource: "suggested", marketUsd: 0.85, imageUrl: null, warnings: [],
  };
  const first = store.create(input);
  const retry = store.create({ ...input, quantity: 5 });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.draft.id, first.draft.id);
  assert.equal(store.list().length, 1);
  store.create({ ...input, idempotencyKey: "run1-517033-LP-English", condition: "LP" });
  assert.equal(store.list().length, 2);
});

function fakeStore(listings: Partial<Listing>[]) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const offset = Number(new URL(url).searchParams.get("offset"));
    return new Response(JSON.stringify({ listings: listings.slice(offset, offset + 100), total: listings.length }));
  }) as unknown as typeof fetch;
  return { store: new Store("https://example.test", fetchFn), calls };
}

test("Store: pages through the API and caches the result", async () => {
  const many = Array.from({ length: 230 }, (_, i) => ({ name: `Card ${i}`, set_name: "Set", quantity: 1 }));
  const { store, calls } = fakeStore(many);
  assert.equal((await store.all()).length, 230);
  await store.all();
  assert.equal(calls.length, 3);
});

test("Store: search matches every word and the set", async () => {
  const { store } = fakeStore([
    { name: "Charizard ex", set_name: "Scarlet & Violet 151", quantity: 1 },
    { name: "Charizard ex", set_name: "Obsidian Flames", quantity: 1 },
    { name: "Charmander", set_name: "Scarlet & Violet 151", quantity: 3 },
  ]);
  assert.equal((await store.search("charizard EX")).length, 2);
  assert.equal((await store.search("Charizard ex", "151")).length, 1);
});

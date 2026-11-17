import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Bm25, chunkMarkdown, HelpIndex, loadKnowledge, tokens, type Embedder } from "../src/rag/help.ts";

const knowledge = fileURLToPath(new URL("../knowledge", import.meta.url));

/** Deterministic stand-in for the real model: hashed bag of words, normalized. No download needed. */
const fakeEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(64).fill(0);
      for (const w of tokens(t)) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

test("chunkMarkdown makes one chunk per section, with stable ids", () => {
  const chunks = chunkMarkdown("pagos.md", "# Pagos\n\n## Pagar con Yape\nTexto uno.\n\n## Vacía\n\n## Tarjeta\nTexto\ndos.");
  assert.deepEqual(chunks.map((c) => c.id), ["pagos.md#pagar-con-yape", "pagos.md#tarjeta"]);
  assert.equal(chunks[1].text, "Texto dos.");
  assert.equal(chunks[0].doc, "Pagos");
});

test("every knowledge section loads and every eval answer exists", async () => {
  const chunks = loadKnowledge(knowledge);
  assert.ok(chunks.length >= 15);
  const ids = new Set(chunks.map((c) => c.id));
  const { readFileSync } = await import("node:fs");
  const evalSet = JSON.parse(readFileSync(`${knowledge}/eval.json`, "utf8"));
  for (const { expected } of evalSet.questions) assert.ok(ids.has(expected), `missing ${expected}`);
});

test("tokens drop accents, stopwords and simple plurals", () => {
  assert.deepEqual(tokens("¿Cómo son los envíos a Perú?"), ["son", "envio", "peru"]);
});

test("BM25 ranks the document with the rare term first", () => {
  const s = new Bm25(["pagos con tarjeta izipay", "envios por shalom", "pagos con yape"]).scores("izipay");
  assert.ok(s[0] > 0 && s[1] === 0 && s[2] === 0);
});

test("the keyword side of the hybrid finds exact terms and returns the source", async () => {
  // alpha 0 = only BM25 inside the hybrid; the fake embedder is too noisy to test meaning.
  const index = new HelpIndex(loadKnowledge(knowledge), fakeEmbedder, 0);
  const [top] = await index.search("¿Trabajan con Shalom?");
  assert.equal(top.id, "envios.md#envios-a-todo-el-peru");
  assert.equal(top.source, "knowledge/envios.md#envios-a-todo-el-peru");
  const [card] = await index.search("Izipay tarjeta cargo", 1);
  assert.equal(card.id, "pagos.md#pagar-con-tarjeta");
});

test("modes return k results ordered by score", async () => {
  const index = new HelpIndex(loadKnowledge(knowledge), fakeEmbedder);
  for (const mode of ["vector", "hybrid"] as const) {
    const hits = await index.search("preventa adelanto", 3, mode);
    assert.equal(hits.length, 3);
    assert.ok(hits[0].score >= hits[1].score && hits[1].score >= hits[2].score);
  }
});

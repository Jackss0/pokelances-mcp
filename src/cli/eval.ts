#!/usr/bin/env node
/**
 * Retrieval evaluation for the help RAG: recall@1, recall@3 and MRR for BM25, vectors and hybrid.
 *   npm run eval                       # print the table
 *   npm run eval -- --min-recall3 0.9  # also fail (exit 1) if hybrid recall@3 is below 0.9 (used in CI)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../config.js";
import { HelpIndex, loadKnowledge, localEmbedder, type Mode } from "../rag/help.js";

const { values } = parseArgs({ options: { "min-recall3": { type: "string" } } });
const evalSet = JSON.parse(readFileSync(join(ROOT, "knowledge", "eval.json"), "utf8")) as {
  questions: { q: string; expected: string }[];
};
const index = new HelpIndex(loadKnowledge(join(ROOT, "knowledge")), localEmbedder());

const rows: Record<Mode, { r1: number; r3: number; mrr: number; misses: string[] }> = {} as never;
for (const mode of ["bm25", "vector", "hybrid"] as Mode[]) {
  let r1 = 0, r3 = 0, mrr = 0;
  const misses: string[] = [];
  for (const { q, expected } of evalSet.questions) {
    const ids = (await index.search(q, 10, mode)).map((h) => h.id);
    const rank = ids.indexOf(expected) + 1;
    if (rank === 1) r1++;
    if (rank >= 1 && rank <= 3) r3++;
    else misses.push(`${q} -> got ${ids[0] ?? "nothing"}`);
    if (rank) mrr += 1 / rank;
  }
  const n = evalSet.questions.length;
  rows[mode] = { r1: r1 / n, r3: r3 / n, mrr: mrr / n, misses };
}

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
console.log(`\n${evalSet.questions.length} questions\n\nmode     recall@1  recall@3   MRR`);
for (const [mode, r] of Object.entries(rows)) console.log(`${mode.padEnd(8)} ${pct(r.r1)}     ${pct(r.r3)}     ${r.mrr.toFixed(2)}`);
for (const [mode, r] of Object.entries(rows)) if (r.misses.length) console.log(`\n${mode} misses (not in top 3):\n  ` + r.misses.join("\n  "));

const min = values["min-recall3"] ? Number(values["min-recall3"]) : null;
if (min != null && rows.hybrid.r3 < min) {
  console.error(`\nHybrid recall@3 ${rows.hybrid.r3} is below ${min}`);
  process.exit(1);
}

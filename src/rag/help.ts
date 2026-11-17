/**
 * Small RAG over the help docs in knowledge/*.md:
 * chunk by "## " section -> BM25 (keywords) + embeddings (meaning) -> weighted sum of normalized scores.
 * The MCP client's model writes the answer from the returned passages and cites their source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalize } from "../catalog.js";

export interface Chunk {
  id: string; // "pagos.md#pagar-con-yape-o-plin"
  doc: string; // "Pagos"
  section: string; // "Pagar con Yape o Plin"
  text: string;
}

export interface Hit extends Chunk {
  score: number; // rank score, relative to the other chunks (normalized in hybrid mode)
  similarity: number | null; // raw cosine similarity to the question: low values mean "probably not answered here"
  source: string;
}

/** Turns texts into unit vectors. "query" and "passage" may be embedded differently (e5 models need prefixes). */
export interface Embedder {
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

const slug = (s: string) => normalize(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** One chunk per "## " section, with the document title as context. */
export function chunkMarkdown(file: string, md: string): Chunk[] {
  const doc = md.match(/^# (.+)$/m)?.[1].trim() ?? file;
  return md
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const [first, ...rest] = part.split("\n");
      const section = first.trim();
      return { id: `${file}#${slug(section)}`, doc, section, text: rest.join(" ").replace(/\s+/g, " ").trim() };
    })
    .filter((c) => c.text.length > 0);
}

export function loadKnowledge(dir: string): Chunk[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((f) => chunkMarkdown(f, readFileSync(join(dir, f), "utf8")));
}

// ---------- BM25 ----------
const STOP = new Set(
  "a al algo como con de del el en es esta este hay la las lo los mi mis o para pero por que se si sin su sus te tu un una uno y yo me puedo puede cual cuales donde cuando hago".split(" "),
);

/** Lowercase, no accents, no stopwords and a light plural strip ("envios" -> "envio"). */
export const tokens = (s: string): string[] =>
  normalize(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));

export class Bm25 {
  private readonly docs: string[][];
  private readonly df = new Map<string, number>();
  private readonly avg: number;

  constructor(texts: string[], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.docs = texts.map(tokens);
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avg = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }

  scores(query: string): number[] {
    const q = tokens(query);
    const n = this.docs.length;
    return this.docs.map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.length) / this.avg));
      }
      return s;
    });
  }
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

/** Ranks indices by score, best first, ignoring zero scores. */
const ranking = (scores: number[]) =>
  scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((x, y) => y[0] - x[0])
    .map(([, i]) => i);

export type Mode = "bm25" | "vector" | "hybrid";

/** Min-max to [0, 1] so BM25 scores and cosine similarities can be added. */
const minMax = (xs: number[]) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0));
};

export class HelpIndex {
  private readonly bm25: Bm25;
  private vectors?: number[][];

  /**
   * alpha = weight of the vector score in the hybrid (BM25 gets 1 - alpha).
   * Tested against knowledge/eval.json: Reciprocal Rank Fusion did worse than vectors alone, because any
   * weak one-word BM25 match outranked the best semantic matches. A weighted sum of normalized scores with
   * alpha 0.8 matches vectors alone on the eval and still lets exact terms ("Izipay", "Shalom") count.
   */
  constructor(
    readonly chunks: Chunk[],
    private readonly embedder: Embedder,
    readonly alpha = 0.8,
  ) {
    this.bm25 = new Bm25(chunks.map((c) => `${c.doc} ${c.section} ${c.text}`));
  }

  private async passageVectors() {
    return (this.vectors ??= await this.embedder.embed(
      this.chunks.map((c) => `${c.doc} - ${c.section}. ${c.text}`),
      "passage",
    ));
  }

  async search(question: string, k = 3, mode: Mode = "hybrid"): Promise<Hit[]> {
    const lexical = this.bm25.scores(question);
    let semantic = this.chunks.map(() => 0);
    if (mode !== "bm25") {
      const [q] = await this.embedder.embed([question], "query");
      semantic = (await this.passageVectors()).map((v) => dot(q, v));
    }
    const scores =
      mode === "bm25" ? lexical
      : mode === "vector" ? semantic
      : (() => {
          const l = minMax(lexical), s = minMax(semantic);
          return s.map((x, i) => this.alpha * x + (1 - this.alpha) * l[i]);
        })();
    const order = mode === "bm25" ? ranking(scores) : scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    return order
      .slice(0, k)
      .map((i) => ({
        ...this.chunks[i],
        score: Number(scores[i].toFixed(4)),
        similarity: mode === "bm25" ? null : Number(semantic[i].toFixed(3)),
        source: `knowledge/${this.chunks[i].id}`,
      }));
  }
}

/** Local multilingual embeddings (no API key). The model downloads on first use and is cached. */
export function localEmbedder(model = "Xenova/multilingual-e5-base"): Embedder {
  let extractor: Promise<(texts: string[], o: object) => Promise<{ tolist(): number[][] }>> | undefined;
  return {
    async embed(texts, kind) {
      extractor ??= import("@huggingface/transformers").then((t) => {
        if (process.env.MODEL_CACHE_DIR) t.env.cacheDir = process.env.MODEL_CACHE_DIR; // lets CI cache the model
        return t.pipeline("feature-extraction", model, { dtype: "q8" }) as never;
      });
      const out = await (await extractor)(texts.map((x) => `${kind}: ${x}`), { pooling: "mean", normalize: true });
      return out.tolist();
    },
  };
}

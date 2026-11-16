import { existsSync, readFileSync } from "node:fs";

export interface Price {
  subType: string;
  market: number | null;
  low: number | null;
}

export interface Product {
  productId: number;
  name: string;
  set: string;
  setCode: string | null;
  number: string | null;
  rarity: string | null;
  kind: "card" | "sealed";
  url: string | null;
  imageUrl: string | null;
  prices: Price[];
}

export interface CatalogFile {
  source: string;
  syncedAt: string;
  products: Product[];
}

export interface SearchQuery {
  name: string;
  set?: string;
  number?: string;
  kind?: "card" | "sealed";
  limit?: number;
}

/** Lowercase, strip accents and punctuation so "Pokémon: 151" matches "pokemon 151". */
export const normalize = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** TCGplayer appends the number to card names: "Charizard ex - 199/165" -> "Charizard ex". */
export const baseName = (name: string): string => name.replace(/\s+-\s+[A-Za-z-]*\s?\d+[A-Za-z]*(\/\w+)?$/, "").trim();

/** "035/165" -> "35", "SVP 085" -> "svp 85": compare collector numbers without padding. */
export const collectorNumber = (s: string): string => normalize(s).split("/")[0].replace(/\b0+(\d)/g, "$1");

interface Entry {
  product: Product;
  name: string;
  set: string;
  setCode: string;
  number: string;
}

export class Catalog {
  private readonly byId = new Map<number, Product>();
  private readonly entries: Entry[] = [];

  constructor(readonly file: CatalogFile) {
    for (const p of file.products) {
      this.byId.set(p.productId, p);
      this.entries.push({
        product: p,
        name: normalize(p.name),
        set: normalize(p.set),
        setCode: normalize(p.setCode ?? ""),
        number: p.number ? collectorNumber(p.number) : "",
      });
    }
  }

  static load(path: string): Catalog {
    if (!existsSync(path)) {
      throw new Error(`Catalog not found at ${path}. Run "npm run sync-catalog" first.`);
    }
    return new Catalog(JSON.parse(readFileSync(path, "utf8")) as CatalogFile);
  }

  get size(): number {
    return this.entries.length;
  }

  get(productId: number): Product | undefined {
    return this.byId.get(productId);
  }

  /** Every word of the name must appear; set and number narrow it down. Exact names rank first. */
  search(q: SearchQuery): Product[] {
    const wanted = normalize(q.name);
    const words = wanted.split(" ").filter(Boolean);
    if (words.length === 0) return [];
    const set = q.set ? normalize(q.set) : null;
    const num = q.number ? collectorNumber(q.number) : null;

    const hits: { e: Entry; score: number }[] = [];
    for (const e of this.entries) {
      if (q.kind && e.product.kind !== q.kind) continue;
      if (!words.every((w) => e.name.includes(w))) continue;
      if (set && !(e.set.includes(set) || e.setCode === set)) continue;
      if (num && e.number !== num) continue;
      const score = (e.name === wanted ? 0 : 1000) + (e.name.length - wanted.length);
      hits.push({ e, score });
    }
    hits.sort((a, b) => a.score - b.score || a.e.product.productId - b.e.product.productId);
    return hits.slice(0, q.limit ?? 8).map((h) => h.e.product);
  }
}

#!/usr/bin/env node
/**
 * Build data/catalog.json from TCGplayer data published by tcgcsv.com (Pokémon = category 3).
 *
 *   npm run sync-catalog                                  # download every set (about 220 groups)
 *   npm run sync-catalog -- --groups 23237,23651          # only some sets
 *   npm run sync-catalog -- --from-cardpulse <raw dir>    # reuse a CardPulse raw snapshot, offline
 *   npm run sync-catalog -- --out fixtures/catalog-sample.json
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { CatalogFile, Product } from "../catalog.js";
import { ROOT } from "../config.js";

interface Group { groupId: number; name: string; abbreviation: string | null }
interface RawProduct {
  productId: number;
  name: string;
  groupId: number;
  url?: string;
  imageUrl?: string;
  extendedData?: { name: string; value: string }[];
}
interface RawPrice { productId: number; subTypeName: string; marketPrice: number | null; lowPrice: number | null }

const { values } = parseArgs({
  options: {
    groups: { type: "string" },
    "from-cardpulse": { type: "string" },
    out: { type: "string", default: join(ROOT, "data", "catalog.json") },
  },
});
const onlyGroups = values.groups ? new Set(values.groups.split(",").map(Number)) : null;
const BASE = "https://tcgcsv.com/tcgplayer/3";

async function getJson<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "User-Agent": "pokelances-mcp catalog sync" },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { success: boolean; results: T; errors?: unknown };
      if (!body.success) throw new Error(`${path}: ${JSON.stringify(body.errors)}`);
      return body.results;
    }
    if (attempt >= 4 || (res.status !== 429 && res.status < 500)) throw new Error(`${path}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

function readCardPulse(dir: string) {
  const gz = (f: string) => JSON.parse(gunzipSync(readFileSync(join(dir, f))).toString("utf8"));
  return {
    groups: (): Group[] => gz("groups.json.gz"),
    group: (id: number): { products: RawProduct[]; prices: RawPrice[] } | null =>
      existsSync(join(dir, `group=${id}.json.gz`)) ? gz(`group=${id}.json.gz`) : null,
  };
}

function toProducts(group: Group, raw: RawProduct[], prices: RawPrice[]): Product[] {
  const byProduct = new Map<number, RawPrice[]>();
  for (const p of prices) byProduct.set(p.productId, [...(byProduct.get(p.productId) ?? []), p]);
  return raw.map((r) => {
    const ext = Object.fromEntries((r.extendedData ?? []).map((e) => [e.name, e.value]));
    return {
      productId: r.productId,
      name: r.name,
      set: group.name,
      setCode: group.abbreviation,
      number: ext.Number ?? null,
      rarity: ext.Rarity ?? null,
      kind: ext.Number ? "card" : "sealed",
      url: r.url ?? null,
      imageUrl: r.imageUrl ?? null,
      prices: (byProduct.get(r.productId) ?? []).map((p) => ({ subType: p.subTypeName, market: p.marketPrice, low: p.lowPrice })),
    };
  });
}

const local = values["from-cardpulse"] ? readCardPulse(values["from-cardpulse"]) : null;
const allGroups = local ? local.groups() : await getJson<Group[]>("/groups");
const groups = allGroups.filter((g) => !onlyGroups || onlyGroups.has(g.groupId));
if (groups.length === 0) throw new Error("No groups matched.");

const products: Product[] = [];
for (const [i, g] of groups.entries()) {
  let raw: RawProduct[], prices: RawPrice[];
  if (local) {
    const data = local.group(g.groupId);
    if (!data) continue;
    ({ products: raw, prices } = data);
  } else {
    [raw, prices] = await Promise.all([getJson<RawProduct[]>(`/${g.groupId}/products`), getJson<RawPrice[]>(`/${g.groupId}/prices`)]);
    await new Promise((r) => setTimeout(r, 50)); // be polite with a free service
  }
  products.push(...toProducts(g, raw, prices));
  console.error(`[${i + 1}/${groups.length}] ${g.name}: ${raw.length} products`);
}

const file: CatalogFile = {
  source: local ? `CardPulse snapshot ${values["from-cardpulse"]}` : "tcgcsv.com (TCGplayer, category 3)",
  syncedAt: new Date().toISOString(),
  products,
};
mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(values.out + ".tmp", JSON.stringify(file));
renameSync(values.out + ".tmp", values.out!);
console.error(`Wrote ${products.length} products to ${values.out}`);

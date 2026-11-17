import { z } from "zod";
import { baseName, Catalog, collectorNumber, normalize, type Product } from "./catalog.js";
import type { Config } from "./config.js";
import { DraftStore } from "./drafts.js";
import { CONDITIONS, suggestPrice } from "./pricing.js";
import { Store } from "./store.js";
import { HelpIndex, loadKnowledge, localEmbedder } from "./rag/help.js";

export interface Deps {
  catalog: () => Catalog; // lazy: the server starts even before the catalog is synced
  store: Store;
  drafts: DraftStore;
  usdToPen: number;
  help: () => HelpIndex; // lazy: the embedding model loads on the first question
}

export function createDeps(config: Config): Deps {
  let catalog: Catalog | undefined;
  let help: HelpIndex | undefined;
  return {
    catalog: () => (catalog ??= Catalog.load(config.catalogPath)),
    store: new Store(config.storeUrl),
    drafts: new DraftStore(config.draftsPath),
    usdToPen: config.usdToPen,
    help: () => (help ??= new HelpIndex(loadKnowledge(config.knowledgeDir), localEmbedder())),
  };
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  run: (args: any) => Promise<unknown>;
}

const brief = (p: Product) => ({
  productId: p.productId,
  name: p.name,
  set: p.set,
  number: p.number,
  rarity: p.rarity,
  kind: p.kind,
  marketUsd: Object.fromEntries(p.prices.filter((x) => x.market != null).map((x) => [x.subType, x.market])),
  url: p.url,
});

const condition = z.enum(CONDITIONS).describe("Card condition: NM, LP, MP, HP or DMG");

export function buildTools(d: Deps): ToolDef[] {
  const product = (id: number) => {
    const p = d.catalog().get(id);
    if (!p) throw new Error(`No product with productId ${id}. Use search_cards first.`);
    return p;
  };

  return [
    {
      name: "search_cards",
      title: "Search the card catalog",
      description:
        "Search the Pokémon TCG catalog (TCGplayer data) by card name, optionally narrowed by set name or code and collector number. " +
        "Returns productId, set, number, rarity and USD market price per sub-type (Normal, Holofoil, Reverse Holofoil). " +
        "If several products match, ask the seller for the set or number instead of guessing.",
      input: {
        name: z.string().min(1).describe("Card or product name, e.g. 'Charizard ex'"),
        set: z.string().optional().describe("Set name or code, e.g. '151' or 'MEW'"),
        number: z.string().optional().describe("Collector number, e.g. '199/165' or '199'"),
        kind: z.enum(["card", "sealed"]).optional().describe("Only single cards or only sealed products"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results, default 8"),
      },
      readOnly: true,
      run: async (a) => {
        const results = d.catalog().search(a).map(brief);
        return { count: results.length, results };
      },
    },
    {
      name: "suggest_price",
      title: "Suggest a price in soles",
      description:
        "Suggest a listing price in Peruvian soles for a catalog product: USD market price x exchange rate x a condition discount, rounded to S/ 0.50. " +
        "It is a starting point; the seller has the final word.",
      input: {
        productId: z.number().int().describe("productId from search_cards"),
        condition: condition.default("NM"),
        subType: z.string().optional().describe("Price sub-type, e.g. 'Holofoil'. Defaults to the first one with a price."),
      },
      readOnly: true,
      run: async (a) => suggestPrice(product(a.productId), { condition: a.condition, subType: a.subType, usdToPen: d.usdToPen }),
    },
    {
      name: "search_store",
      title: "Search live PokeLances listings",
      description:
        "Search what is already listed on pokelances.com (public, read-only). Use it to spot duplicates and compare prices before drafting.",
      input: {
        name: z.string().min(1).describe("Card or product name"),
        set: z.string().optional().describe("Set name to narrow the search"),
      },
      readOnly: true,
      run: async (a) => {
        const found = await d.store.search(a.name, a.set);
        return {
          count: found.length,
          listings: found.slice(0, 20).map((l) => ({
            name: l.name,
            set: l.set_name,
            condition: l.condition,
            pricePen: l.fixed_price == null ? null : Number(l.fixed_price),
            quantity: l.quantity,
            language: l.language,
          })),
        };
      },
    },
    {
      name: "create_draft",
      title: "Create a listing draft",
      description:
        "Create a listing DRAFT for the seller to review. It never publishes anything. " +
        "If pricePen is omitted, the suggested price is used. Reusing an idempotencyKey returns the existing draft instead of creating another. " +
        "The result includes warnings, e.g. when the same card is already listed.",
      input: {
        productId: z.number().int().describe("productId from search_cards"),
        condition,
        language: z.enum(["English", "Spanish", "Japanese"]).default("English"),
        quantity: z.number().int().min(1).max(99).default(1),
        pricePen: z.number().positive().optional().describe("Price set by the seller, in soles"),
        subType: z.string().optional().describe("Price sub-type used for the suggestion"),
        idempotencyKey: z.string().min(8).max(120).describe("Stable key for this draft, e.g. '<runId>-<productId>-<condition>-<language>'"),
      },
      readOnly: false,
      run: async (a) => {
        const p = product(a.productId);
        const warnings: string[] = [];
        const s = suggestPrice(p, { condition: a.condition, subType: a.subType, usdToPen: d.usdToPen });

        let pricePen: number;
        if (a.pricePen != null) pricePen = a.pricePen;
        else if (s.ok) pricePen = s.suggestedPen;
        else throw new Error(`${s.reason} Ask the seller for a price and pass pricePen.`);

        if (s.ok && a.pricePen != null) {
          const ratio = a.pricePen / s.suggestedPen;
          if (ratio < 0.6 || ratio > 1.6) warnings.push(`Price S/ ${a.pricePen} is far from the suggested S/ ${s.suggestedPen}.`);
        }
        try {
          // Store listings use the plain name ("Charizard ex") and a shorter set name ("Scarlet & Violet 151").
          const name = baseName(p.name);
          // The collector number, when present, lives in the description: "N.º 199/167 · Holofoil".
          const ours = p.number ? collectorNumber(p.number) : null;
          for (const l of await d.store.search(name)) {
            const set = normalize(l.set_name ?? "");
            if (normalize(l.name) !== normalize(name) || set === "" || !normalize(p.set).includes(set)) continue;
            const theirs = l.description?.match(/(\d+)\s*\/\s*\d+/)?.[1];
            if (ours && theirs && collectorNumber(theirs) !== ours) continue; // another printing
            const what = theirs ? "Already listed" : "Possibly already listed (no number in the listing)";
            warnings.push(`${what}: ${l.condition ?? "?"} at S/ ${l.fixed_price} (${l.quantity} in stock).`);
          }
        } catch {
          warnings.push("Could not check the live store for duplicates.");
        }

        const { draft, created } = d.drafts.create({
          idempotencyKey: a.idempotencyKey,
          productId: p.productId,
          name: p.name,
          set: p.set,
          number: p.number,
          condition: a.condition,
          language: a.language,
          quantity: a.quantity,
          pricePen,
          priceSource: a.pricePen != null ? "seller" : "suggested",
          marketUsd: s.ok ? s.marketUsd : null,
          imageUrl: p.imageUrl,
          warnings,
        });
        return { created, draft };
      },
    },
    {
      name: "search_help",
      title: "Search the PokeLances help docs",
      description:
        "Search PokeLances' help docs (payments, shipping, ways to buy, products, stores) for passages that answer a buyer's or seller's question. " +
        "Answer ONLY with what the passages say and cite each one by its source. " +
        "Each passage has its cosine similarity to the question; passages are always returned, so check that they actually answer it. " +
        "If they don't, say you don't have that information instead of guessing.",
      input: {
        question: z.string().min(3).describe("The user's question, in their own words"),
        k: z.number().int().min(1).max(5).optional().describe("Passages to return, default 3"),
      },
      readOnly: true,
      run: async (a) => {
        const hits = await d.help().search(a.question, a.k ?? 3);
        return { passages: hits.map((h) => ({ source: h.source, title: `${h.doc} > ${h.section}`, text: h.text, similarity: h.similarity })) };
      },
    },
    {
      name: "list_drafts",
      title: "List drafts",
      description: "List the listing drafts created so far, newest last.",
      input: {},
      readOnly: true,
      run: async () => {
        const drafts = d.drafts.list();
        return { count: drafts.length, drafts };
      },
    },
  ];
}

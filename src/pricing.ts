import type { Product } from "./catalog.js";

/** Rough discount by condition, relative to Near Mint market price. A starting point, not a rule. */
export const CONDITION_FACTOR = { NM: 1, LP: 0.85, MP: 0.7, HP: 0.5, DMG: 0.35 } as const;
export type Condition = keyof typeof CONDITION_FACTOR;
export const CONDITIONS = Object.keys(CONDITION_FACTOR) as [Condition, ...Condition[]];

export type PriceSuggestion =
  | {
      ok: true;
      productId: number;
      subType: string;
      marketUsd: number;
      usdToPen: number;
      condition: Condition;
      conditionFactor: number;
      suggestedPen: number;
      otherSubTypes: string[];
    }
  | { ok: false; productId: number; reason: string; availableSubTypes: string[] };

/** Market (USD) x exchange rate x condition factor, rounded to S/ 0.50. */
export function suggestPrice(
  p: Product,
  opts: { condition: Condition; usdToPen: number; subType?: string },
): PriceSuggestion {
  const withMarket = p.prices.filter((x) => x.market != null);
  const price = opts.subType
    ? withMarket.find((x) => x.subType.toLowerCase() === opts.subType!.toLowerCase())
    : withMarket[0];

  if (!price || price.market == null) {
    return {
      ok: false,
      productId: p.productId,
      reason: opts.subType
        ? `No market price for sub-type "${opts.subType}".`
        : "This product has no market price yet.",
      availableSubTypes: withMarket.map((x) => x.subType),
    };
  }

  const factor = CONDITION_FACTOR[opts.condition];
  const pen = price.market * opts.usdToPen * factor;
  return {
    ok: true,
    productId: p.productId,
    subType: price.subType,
    marketUsd: price.market,
    usdToPen: opts.usdToPen,
    condition: opts.condition,
    conditionFactor: factor,
    suggestedPen: Math.max(0.5, Math.round(pen * 2) / 2),
    otherSubTypes: withMarket.filter((x) => x !== price).map((x) => x.subType),
  };
}

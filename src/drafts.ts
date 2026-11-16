import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Condition } from "./pricing.js";

export interface Draft {
  id: string;
  idempotencyKey: string;
  createdAt: string;
  status: "draft";
  productId: number;
  name: string;
  set: string;
  number: string | null;
  condition: Condition;
  language: string;
  quantity: number;
  pricePen: number;
  priceSource: "seller" | "suggested";
  marketUsd: number | null;
  imageUrl: string | null;
  warnings: string[];
}

export type NewDraft = Omit<Draft, "id" | "createdAt" | "status">;

/**
 * Drafts live in a local JSON file: nothing here touches the live store.
 * The seller reviews them and publishes from the PokeLances admin panel.
 */
export class DraftStore {
  constructor(private readonly path: string) {}

  list(): Draft[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, "utf8")) as Draft[];
  }

  /** Same idempotency key -> same draft. A retried tool call never creates a duplicate. */
  create(input: NewDraft): { draft: Draft; created: boolean } {
    const all = this.list();
    const existing = all.find((d) => d.idempotencyKey === input.idempotencyKey);
    if (existing) return { draft: existing, created: false };

    const draft: Draft = { id: randomUUID(), createdAt: new Date().toISOString(), status: "draft", ...input };
    all.push(draft);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, this.path); // atomic: a crash never leaves half a file
    return { draft, created: true };
  }
}

import { normalize } from "./catalog.js";

/** The fields we use from PokeLances' public listings API. */
export interface Listing {
  id: string;
  name: string;
  type: string;
  set_name: string | null;
  condition: string | null;
  fixed_price: string | null;
  quantity: number;
  language: string | null;
  description?: string | null;
}

const PAGE = 100; // the API caps limit at 100
const MAX_PAGES = 50;

/** Read-only client for the live store, with a short cache so one agent run makes few requests. */
export class Store {
  private cache?: { at: number; listings: Listing[] };

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async all(): Promise<Listing[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.listings;

    const listings: Listing[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${this.baseUrl}/api/marketplace/listings?limit=${PAGE}&offset=${page * PAGE}`;
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Store API returned ${res.status} for ${url}`);
      const body = (await res.json()) as { listings?: Listing[]; total?: number };
      const batch = body.listings ?? [];
      listings.push(...batch);
      if (batch.length < PAGE || (body.total != null && listings.length >= body.total)) break;
    }
    this.cache = { at: Date.now(), listings };
    return listings;
  }

  async search(name: string, set?: string): Promise<Listing[]> {
    const words = normalize(name).split(" ").filter(Boolean);
    const s = set ? normalize(set) : null;
    return (await this.all()).filter((l) => {
      const n = normalize(l.name);
      if (!words.every((w) => n.includes(w))) return false;
      return !s || normalize(l.set_name ?? "").includes(s);
    });
  }
}

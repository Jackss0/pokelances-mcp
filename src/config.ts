import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Repo root, whether running from src/ (tsx) or dist/ (built). */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface Config {
  catalogPath: string;
  draftsPath: string;
  storeUrl: string;
  usdToPen: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const usdToPen = Number(env.USD_TO_PEN ?? 3.75);
  if (!Number.isFinite(usdToPen) || usdToPen <= 0) throw new Error("USD_TO_PEN must be a positive number");
  return {
    catalogPath: env.CATALOG_PATH ?? join(ROOT, "data", "catalog.json"),
    draftsPath: env.DRAFTS_PATH ?? join(ROOT, "data", "drafts.json"),
    storeUrl: (env.STORE_URL ?? "https://www.pokelances.com").replace(/\/+$/, ""),
    usdToPen,
  };
}

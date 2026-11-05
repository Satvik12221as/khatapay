/**
 * Pricebook Re-verification Scheduler
 * Runs every 10 days to compare pricebook prices against a live data source.
 * Logs price deltas (↑ for increase, ↓ for decrease) to pricebook_history.json.
 *
 * For now, this is a mock implementation that simulates price drift.
 * In production, replace fetchPriceFromLiveSource() with a call to:
 *   - Exchangerate API (for currency conversion)
 *   - Data.gov.in Agri prices API (requires API key)
 *   - BigBasket/other grocery APIs (may require scraping)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { PRICEBOOK, PriceEntry } from "../agents/pricecheck_local";

interface PriceHistoryEntry {
  shopId: string;
  item: string;
  oldPriceCents: number;
  newPriceCents: number;
  deltaCents: number;
  deltaPct: number;
  date: string;
  source: "live" | "simulated";
}

const HISTORY_FILE = resolve(process.cwd(), "data", "pricebook_history.json");

/**
 * MOCK LIVE PRICE FETCHER
 * Simulates realistic price drift: -5% to +10% daily drift.
 * Replace with real API call in production.
 */
async function fetchPriceFromLiveSource(entry: PriceEntry): Promise<number> {
  // Simulate natural price inflation (average +2% per day, random variation)
  const driftPct = 0.02 + (Math.random() - 0.5) * 0.1; // ~2% ± 5%
  return Math.round(entry.priceCents * (1 + driftPct));
}

/**
 * Load existing history or start fresh
 */
function loadHistory(): PriceHistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const content = readFileSync(HISTORY_FILE, "utf8");
    return JSON.parse(content) as PriceHistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(history: PriceHistoryEntry[]): void {
  const dir = dirname(HISTORY_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

/**
 * Main verification run - call this from a cron job or scheduled task
 */
export async function runPriceVerification(): Promise<PriceHistoryEntry[]> {
  const history = loadHistory();
  const today = new Date().toISOString().split("T")[0];

  const updates: PriceHistoryEntry[] = [];

  for (const item of PRICEBOOK) {
    const livePrice = await fetchPriceFromLiveSource(item);
    const delta = livePrice - item.priceCents;

    // Only record if change > 1% or > 5 cents
    if (Math.abs(delta) > item.priceCents * 0.01 || Math.abs(delta) >= 5) {
      updates.push({
        shopId: item.shopId,
        item: item.item,
        oldPriceCents: item.priceCents,
        newPriceCents: livePrice,
        deltaCents: delta,
        deltaPct: Math.round((delta / item.priceCents) * 100 * 100) / 100,
        date: today,
        source: "simulated",
      });
    }
  }

  if (updates.length > 0) {
    const all = [...history, ...updates];
    saveHistory(all);
    console.log(`[Price-Check] Recorded ${updates.length} price updates`);
  }

  return updates;
}

/**
 * Run verification and return summary
 */
export async function verifyPricebook(): Promise<string> {
  const updates = await runPriceVerification();

  if (updates.length === 0) {
    return "No price changes detected.";
  }

  const summary = updates
    .map((u) => `${u.item}: ${u.oldPriceCents}¢ → ${u.newPriceCents}¢ (${u.deltaCents > 0 ? "↑" : "↓"}${Math.abs(u.deltaPct)}%) @ ${u.date}`)
    .join("\n");

  return `Pricebook updates:\n${summary}`;
}

// CLI entry point
const isMain = process.argv[1]?.includes("verifyPricebook") || import.meta.url.includes("verifyPricebook");
if (isMain) {
  verifyPricebook().then(console.log).catch(console.error);
}
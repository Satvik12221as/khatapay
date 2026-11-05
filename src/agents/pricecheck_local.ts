import { readCSV } from "../utils/csv";

const DEFAULT_THRESHOLD = 0.8; // 80% of typical spend

export interface PriceEntry {
  shopId: string;
  shopName: string;
  category: string;
  area: string;
  item: string;
  unit: string;
  priceCents: number;
  priceDate: string;
  source: string;
}

const PRICEBOOK: PriceEntry[] = [
  // shop1 - Groceries
  { shopId: "shop1", shopName: "Lakshmi Provision Store", category: "groceries", area: "Mylapore", item: "Rice (5kg)", unit: "bag", priceCents: 6000, priceDate: "2026-11-05", source: "seeded" },
  { shopId: "shop1", shopName: "Lakshmi Provision Store", category: "groceries", area: "Mylapore", item: "Toor Dal (1kg)", unit: "pack", priceCents: 1200, priceDate: "2026-11-05", source: "seeded" },
  { shopId: "shop1", shopName: "Lakshmi Provision Store", category: "groceries", area: "Mylapore", item: "Cooking Oil (1L)", unit: "bottle", priceCents: 900, priceDate: "2026-11-05", source: "seeded" },
  { shopId: "shop1", shopName: "Lakshmi Provision Store", category: "groceries", area: "Mylapore", item: "Tea (250g)", unit: "box", priceCents: 500, priceDate: "2026-11-05", source: "seeded" },
  { shopId: "shop1", shopName: "Lakshmi Provision Store", category: "groceries", area: "Mylapore", item: "Sugar (1kg)", unit: "pack", priceCents: 400, priceDate: "2026-11-05", source: "seeded" },
  // shop2 - Organic
  { shopId: "shop2", shopName: "Green Leaf Organics", category: "organic", area: "Adyar", item: "Organic Rice (5kg)", unit: "bag", priceCents: 9000, priceDate: "2026-11-05", source: "seeded" },
  { shopId: "shop2", shopName: "Green Leaf Organics", category: "organic", area: "Adyar", item: "Organic Toor Dal (1kg)", unit: "pack", priceCents: 1800, priceDate: "2026-11-05", source: "seeded" },
  // shop3 - Sweets
  { shopId: "shop3", shopName: "Annapurna Sweets", category: "sweets", area: "T. Nagar", item: "Mysore Pak (500g)", unit: "box", priceCents: 3000, priceDate: "2026-11-05", source: "seeded" },
  { shopId: "shop3", shopName: "Annapurna Sweets", category: "sweets", area: "T. Nagar", item: "Jangri (250g)", unit: "box", priceCents: 1200, priceDate: "2026-11-05", source: "seeded" },
  { shopId: "shop3", shopName: "Annapurna Sweets", category: "sweets", area: "T. Nagar", item: "Laddu (250g)", unit: "box", priceCents: 800, priceDate: "2026-11-05", source: "seeded" },
];

interface LineCheck {
  expr: string;
  cents: number;
  verdict: "ok" | "suspicious" | "overcharge";
  expectedCents?: number;
  note: string;
}

interface PriceCheckResult {
  lines: LineCheck[];
  totalVerdict: "ok" | "flagged";
  totalExpectedCents?: number;
  note: string;
  source: "gemini" | "scripted";
}

export function ScriptedPriceBrain(typicalCents: number | null = null) {
  const avgItem = PRICEBOOK.length > 0 ? Math.round(PRICEBOOK.reduce((a, r) => a + r.priceCents, 0) / PRICEBOOK.length) : 1000;

  return (req: { merchantName: string; totalCents: number; lines: { expr: string; cents: number }[]; category: string; area: string }): PriceCheckResult => {
    const lineResults: LineCheck[] = [];
    let totalExpected = 0;
    let hasFlag = false;

    for (const l of req.lines) {
      const cents = l.cents;
      const expected = avgItem;
      totalExpected += expected;

      let verdict: "ok" | "suspicious" | "overcharge" = "ok";
      let note = "Within expected range.";

      if (cents > 10000) {
        verdict = "overcharge";
        note = "Amount is unusually high for a single line item.";
        hasFlag = true;
      } else if (typicalCents && cents > typicalCents * DEFAULT_THRESHOLD) {
        verdict = "suspicious";
        note = "This line accounts for the majority of typical spend.";
        hasFlag = true;
      }

      lineResults.push({ expr: l.expr, cents, verdict, expectedCents: expected, note });
    }

    const totalVerdict = hasFlag || (typicalCents && req.totalCents > typicalCents * 3) ? "flagged" : "ok";
    const finalNote = hasFlag
      ? "Audited against local pricebook and typical spend; flags raised."
      : "Audited against local pricebook and typical spend.";

    return {
      lines: lineResults,
      totalVerdict,
      totalExpectedCents: totalExpected,
      note: finalNote,
      source: "scripted",
    };
  };
}

export { PRICEBOOK };
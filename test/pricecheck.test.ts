import { describe, it, expect } from "vitest";
import { ScriptedPriceBrain } from "../src/agents/pricecheck_local";

describe("price-check brain", () => {
  it("returns ok verdict when all line items are within expected range", () => {
    const brain = ScriptedPriceBrain(12000);
    const result = brain({
      merchantName: "Lakshmi Provision Store",
      totalCents: 2400,
      lines: [
        { expr: "500", cents: 500 },
        { expr: "1200", cents: 1200 },
        { expr: "700", cents: 700 },
      ],
      category: "groceries",
      area: "Mylapore",
    });

    expect(result.totalVerdict).toBe("ok");
    expect(result.source).toBe("scripted");
    expect(result.lines.every((l) => l.verdict === "ok")).toBe(true);
  });

  it("flags a single large line item", () => {
    const brain = ScriptedPriceBrain(12000);
    const result = brain({
      merchantName: "Lakshmi Provision Store",
      totalCents: 15000,
      lines: [{ expr: "15000", cents: 15000 }],
      category: "groceries",
      area: "Mylapore",
    });

    expect(result.totalVerdict).toBe("flagged"); // hasFlag is true
    expect(result.lines[0].verdict).toBe("overcharge");
  });

  it("flags when total exceeds 3x typical spend", () => {
    const brain = ScriptedPriceBrain(12000);
    const result = brain({
      merchantName: "Lakshmi Provision Store",
      totalCents: 40000,
      lines: [
        { expr: "12000", cents: 12000 },
        { expr: "12000", cents: 12000 },
        { expr: "16000", cents: 16000 },
      ],
      category: "groceries",
      area: "Mylapore",
    });

    expect(result.totalVerdict).toBe("flagged");
  });

  it("marks a line close to typical spend as suspicious", () => {
    const brain = ScriptedPriceBrain(12000);
    const result = brain({
      merchantName: "Lakshmi Provision Store",
      totalCents: 10000,
      lines: [{ expr: "10000", cents: 10000 }],
      category: "groceries",
      area: "Mylapore",
    });

    expect(result.lines[0].verdict).toBe("suspicious");
    expect(result.lines[0].note).toContain("majority");
  });

  it("handles null typical spend", () => {
    const brain = ScriptedPriceBrain(null);
    const result = brain({
      merchantName: "Unknown Shop",
      totalCents: 1000,
      lines: [{ expr: "1000", cents: 1000 }],
      category: "groceries",
      area: "Unknown",
    });

    expect(result.totalVerdict).toBe("ok");
  });
});
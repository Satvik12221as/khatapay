/** Checks your Gemini key works. Run: npm run gemini */
import { GeminiBrain } from "../src/haggle/brains";

async function main() {
  const key = process.env.GEMINI_API_KEY ?? "";
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  console.log(`Key found: ${key ? "yes" : "NO"}   Model: ${model}`);
  if (!key) throw new Error("Missing GEMINI_API_KEY in .env");

  console.log("Calling Gemini...");
  const brain = new GeminiBrain(key, model);
  const d = await brain.decide({
    side: "customer", round: 1, merchantName: "Test Shop", totalCents: 9000, capCents: 900, comfortCents: 450,
    loyalty: { visits: 14, memberSince: "March", onTimeRate: 1 }, askCents: null, counterCents: null,
  });
  console.log(d);
  console.log(d.source === "gemini" ? "\nSUCCESS: Gemini is working." : "\nUnexpected result.");
}

main().catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); process.exit(1); });
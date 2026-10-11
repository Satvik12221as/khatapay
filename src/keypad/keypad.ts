/**
 * KhataPay keypad engine.
 * The normal payment number pad, plus + - x / keys. Pure logic: no UI, no network.
 * UI calls press(key) and renders view(). Money is handled as whole numbers, never floats.
 */
export type Key =
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
  | "." | "+" | "-" | "×" | "÷" | "back" | "clear";

type Op = "+" | "-" | "×" | "÷";
type Token = { type: "num"; text: string } | { type: "op"; op: Op };

export interface Line { expr: string; cents: number }       // one receipt line, e.g. "3×25" -> 7500
export interface View {
  display: string;            // what the screen shows, e.g. "30 + 40 + 20"
  lines: Line[];              // the tape / itemized receipt
  totalCents: number | null;  // null while the sum is incomplete or invalid
  totalFormatted: string;     // "90.00" (or "" if no total yet)
  canPay: boolean;
  error: string | null;
}

const SCALE = 1_000_000n;   // internal precision for division
const MAX_INT_DIGITS = 7;
const MAX_DECIMALS = 2;
const MAX_TOKENS = 41;
const MAX_TOTAL_CENTS = 1_000_000_000; // 10,000,000.00

const isOp = (k: string): k is Op => k === "+" || k === "-" || k === "×" || k === "÷";

export class Keypad {
  private tokens: Token[] = [];

  press(key: Key): View {
    const last = this.tokens.at(-1);

    if (key === "clear") { this.tokens = []; return this.view(); }

    if (key === "back") {
      if (last?.type === "num") {
        last.text = last.text.slice(0, -1);
        if (last.text === "") this.tokens.pop();
      } else if (last?.type === "op") this.tokens.pop();
      return this.view();
    }

    if (isOp(key)) {
      if (!last) return this.view();                       // cannot start with an operator
      if (last.type === "op") { last.op = key; return this.view(); } // replace operator
      if (last.text.endsWith(".")) last.text = last.text.slice(0, -1);
      if (this.tokens.length < MAX_TOKENS) this.tokens.push({ type: "op", op: key });
      return this.view();
    }

    if (key === ".") {
      if (last?.type === "num") { if (!last.text.includes(".")) last.text += "."; }
      else if (this.tokens.length < MAX_TOKENS) this.tokens.push({ type: "num", text: "0." });
      return this.view();
    }

    // digit
    if (last?.type === "num") {
      const [ip, fp] = last.text.split(".");
      if (fp !== undefined) { if (fp.length < MAX_DECIMALS) last.text += key; }
      else if (ip === "0") last.text = key;                // replace a lone leading zero
      else if (ip.length < MAX_INT_DIGITS) last.text += key;
    } else if (this.tokens.length < MAX_TOKENS) {
      this.tokens.push({ type: "num", text: key });
    }
    return this.view();
  }

  view(): View {
    const display = this.tokens.map((t) => (t.type === "num" ? t.text : ` ${t.op} `)).join("").replace(/\s+/g, " ").trim();
    const empty: View = { display, lines: [], totalCents: null, totalFormatted: "", canPay: false, error: null };
    if (this.tokens.length === 0) return empty;
    if (this.tokens.at(-1)?.type === "op") return empty;   // incomplete, e.g. "30 +"

    try {
      const lines = this.evaluate();
      const totalCents = lines.reduce((a, l) => a + l.cents, 0);
      if (Math.abs(totalCents) > MAX_TOTAL_CENTS) return { ...empty, error: "Amount too large" };
      return { display, lines, totalCents, totalFormatted: formatMoney(totalCents), canPay: totalCents > 0, error: null };
    } catch (e) {
      return { ...empty, error: (e as Error).message };
    }
  }

  /** Split into additive terms; evaluate each (x and / bind tighter than + and -). */
  private evaluate(): Line[] {
    const terms: { sign: 1 | -1; toks: Token[] }[] = [{ sign: 1, toks: [] }];
    for (const t of this.tokens) {
      if (t.type === "op" && (t.op === "+" || t.op === "-")) terms.push({ sign: t.op === "-" ? -1 : 1, toks: [] });
      else terms.at(-1)!.toks.push(t);
    }
    return terms.map((term) => {
      let acc = toScaled((term.toks[0] as { text: string }).text);
      for (let i = 1; i < term.toks.length; i += 2) {
        const op = (term.toks[i] as { op: Op }).op;
        const n = toScaled((term.toks[i + 1] as { text: string }).text);
        if (op === "×") acc = (acc * n) / SCALE;
        else { if (n === 0n) throw new Error("Can't divide by zero"); acc = (acc * SCALE) / n; }
      }
      const expr = term.toks.map((t) => (t.type === "num" ? t.text : t.op)).join("");
      return { expr: (term.sign === -1 ? "-" : "") + expr, cents: term.sign * toCents(acc) };
    });
  }
}

const toScaled = (text: string): bigint => {
  const [ip, fp = ""] = text.split(".");
  return BigInt(ip || "0") * SCALE + BigInt(fp.padEnd(6, "0").slice(0, 6));
};
const toCents = (v: bigint): number => {
  const unit = SCALE / 100n;
  return Number((v + unit / 2n) / unit);   // round half up (terms are never negative before sign)
};

export function formatMoney(cents: number): string {
  const neg = cents < 0; const a = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** Fat-finger guard: warn when a total is far above what this customer usually pays here. */
export function fatFingerCheck(totalCents: number, typicalCents: number | null, factor = 5) {
  if (!typicalCents || typicalCents <= 0 || totalCents < typicalCents * factor) return { suspicious: false as const };
  return { suspicious: true as const, suggestionCents: Math.round(totalCents / 10), reason: `This is ${(totalCents / typicalCents).toFixed(1)}x your usual spend here.` };
}
import { formatMoney } from "../src/keypad/keypad";

// Must match the currency the server uses (USD in the PayPal sandbox).
export const CURRENCY = "$";
export const money = (cents: number) => `${CURRENCY}${formatMoney(cents)}`;
export const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export type State = "CREATED" | "HELD" | "FULFILLED" | "DISPUTED" | "RELEASED" | "REFUNDED" | "FAILED" | "CANCELLED";
export interface Vote { judge: string; verdict: "release" | "refund"; reason: string; source: "gemini" | "scripted" }
export interface PanelVerdict { votes: Vote[]; outcome: "release" | "refund"; note?: string }
export interface PaymentDTO {
  id: string; merchantName: string; amountCents: number; state: State; tapeHash: string; orderId: string;
  captureId?: string; payoutId?: string; refundId?: string; error?: string; createdAt: string;
  lines: { expr: string; cents: number }[];
  dispute?: { reason: string; note: string; shopStance?: string; shopNote?: string; verdict?: PanelVerdict };
  events: { at: string; event: string; from: State | null; to: State; actor: string; detail?: string; ref?: string }[];
}

export const STATE_INFO: Record<State, { label: string; kind: "ok" | "wait" | "bad" | "neutral"; title: string }> = {
  CREATED:   { label: "Waiting",     kind: "wait",    title: "Payment not completed yet" },
  HELD:      { label: "Held safely", kind: "wait",    title: "Your money is held until delivery" },
  FULFILLED: { label: "Delivered",   kind: "wait",    title: "The shop says it delivered" },
  DISPUTED:  { label: "In dispute",  kind: "bad",     title: "A problem was reported" },
  RELEASED:  { label: "Shop paid",   kind: "ok",      title: "Done: the shop has been paid" },
  REFUNDED:  { label: "Refunded",    kind: "neutral", title: "Your money was returned" },
  FAILED:    { label: "Failed",      kind: "bad",     title: "Payment did not go through" },
  CANCELLED: { label: "Cancelled",   kind: "neutral", title: "You cancelled the payment" },
};
export const REASONS: Record<string, string> = { not_received: "I did not receive it", wrong_items: "Wrong items", wrong_amount: "Wrong amount", other: "Other problem" };

/** Calls our API and throws a readable Error on failure. */
export async function api<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Cannot reach the server. Is `npm run dev` running?");
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.reason || `Request failed (${r.status})`);
  return j as T;
}

const text = (tag: string, cls: string, t: string) => { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = t; return e; };

export function drawLines(list: HTMLElement, lines: { expr: string; cents: number }[]) {
  list.replaceChildren();
  for (const l of lines) {
    const li = document.createElement("li");
    li.append(text("span", "", l.expr), text("span", "", formatMoney(l.cents)));
    list.append(li);
  }
}

export function drawAudit(list: HTMLElement, events: PaymentDTO["events"]) {
  list.replaceChildren();
  for (const e of events) {
    const li = document.createElement("li");
    const t = new Date(e.at).toLocaleTimeString();
    li.append(text("strong", "", `${e.event} `), text("span", "", `${e.from ?? "-"} → ${e.to} · ${e.actor} · ${t}`));
    if (e.detail || e.ref) li.append(text("div", "ref", [e.detail, e.ref].filter(Boolean).join(" · ")));
    list.append(li);
  }
}

export function drawVerdict(box: HTMLElement, v?: PanelVerdict) {
  box.replaceChildren();
  box.hidden = !v;
  if (!v) return;
  box.append(text("h3", "", "Tape Judges"));
  for (const x of v.votes) {
    const row = document.createElement("div");
    row.className = "vote";
    const head = document.createElement("div");
    head.className = "bubble-head";
    head.append(text("strong", "", x.judge), text("span", "chip", x.verdict === "release" ? "pay the shop" : "refund"), text("span", "src", x.source === "gemini" ? "Gemini" : "offline"));
    row.append(head, text("p", "", x.reason));
    box.append(row);
  }
  if (v.note) box.append(text("p", "ref", v.note));
  const n = v.votes.filter((x) => x.verdict === v.outcome).length;
  box.append(text("p", "final", v.votes.length ? `Verdict: ${v.outcome === "release" ? "pay the shop" : "refund the customer"} (${n} of ${v.votes.length})` : `Verdict: ${v.outcome === "release" ? "pay the shop" : "refund the customer"}`));
}

export function button(label: string, cls: string, onClick: () => void | Promise<void>) {
  const b = document.createElement("button");
  b.type = "button"; b.className = cls; b.textContent = label;
  b.addEventListener("click", async () => {
    b.disabled = true;
    try { await onClick(); } finally { b.disabled = false; }
  });
  return b;
}
export function select(options: Record<string, string>) {
  const s = document.createElement("select");
  for (const [v, l] of Object.entries(options)) { const o = document.createElement("option"); o.value = v; o.textContent = l; s.append(o); }
  return s;
}
export function textarea(placeholder: string) {
  const t = document.createElement("textarea");
  t.placeholder = placeholder; t.maxLength = 200; t.rows = 2;
  return t;
}
export { text };
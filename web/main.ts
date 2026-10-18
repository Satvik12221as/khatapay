import { Keypad, fatFingerCheck, formatMoney, type Key, type View } from "../src/keypad/keypad";

// Must match the currency the server uses (USD in the PayPal sandbox).
const CURRENCY = "$";
// Default shop. Replaced by the server's list on load (see init below).
let SHOP = { id: "shop1", name: "Lakshmi Provision Store", typicalCents: 12000 };

const kp = new Keypad();
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const display = el<HTMLDivElement>("display");
const linesEl = el<HTMLOListElement>("lines");
const totalEl = el<HTMLElement>("total");
const msgEl = el<HTMLParagraphElement>("msg");
const payBtn = el<HTMLButtonElement>("pay");
const sheet = el<HTMLDialogElement>("sheet");
const sheetLines = el<HTMLOListElement>("sheetLines");
const sheetTotal = el<HTMLElement>("sheetTotal");
const sheetWarn = el<HTMLParagraphElement>("sheetWarn");
const sheetErr = el<HTMLParagraphElement>("sheetErr");
const confirmBtn = el<HTMLButtonElement>("confirm");

let current: View = kp.view();
// Every key pressed since the last Clear. This (not the total) is what we send to the server.
let sent: Key[] = [];
let largeWarned = false;
const MAX_KEYS = 300;

function showShop() {
  el<HTMLElement>("shopName").textContent = SHOP.name;
  el<HTMLElement>("sheetShop").textContent = `To ${SHOP.name}`;
}

function drawLines(list: HTMLOListElement, lines: { expr: string; cents: number }[]) {
  list.replaceChildren();
  for (const l of lines) {
    const li = document.createElement("li");
    const expr = document.createElement("span");
    expr.textContent = l.expr;
    const amt = document.createElement("span");
    amt.textContent = formatMoney(l.cents);
    li.append(expr, amt);
    list.append(li);
  }
}

function render(v: View) {
  current = v;
  display.textContent = v.display || "0";

  const isSum = /[+×÷]|.-/.test(v.display);
  if (isSum && v.totalCents !== null) drawLines(linesEl, v.lines); else linesEl.replaceChildren();

  totalEl.textContent = v.totalCents !== null ? `${CURRENCY}${v.totalFormatted}` : "-";
  payBtn.disabled = !v.canPay;
  payBtn.textContent = v.canPay ? `Pay ${CURRENCY}${v.totalFormatted}` : "Pay";

  if (v.error) msgEl.textContent = v.error;
  else if (v.totalCents !== null && v.totalCents <= 0) msgEl.textContent = "Total must be above zero.";
  else msgEl.textContent = "";
    if (v.error) msgEl.textContent = v.error;
  else if (v.totalCents !== null && v.totalCents <= 0) msgEl.textContent = "Total must be above zero.";
  else msgEl.textContent = "";
  updateHaggle();
}

function press(k: Key) {
  if (k === "clear") sent = [];
  else if (sent.length >= MAX_KEYS) return;
  else sent.push(k);
  render(kp.press(k));
}

el<HTMLElement>("pad").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-key]");
  if (btn) press(btn.dataset.key as Key);
});
el<HTMLButtonElement>("clear").addEventListener("click", () => press("clear"));

const MAP: Record<string, Key> = { "*": "×", x: "×", "/": "÷", "-": "-", "+": "+", ".": ".", Backspace: "back", Escape: "clear" };
window.addEventListener("keydown", (e) => {
  if (sheet.open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (el("keypadView").hidden) return;
  if (e.key === "Enter") { if (current.canPay) openSheet(); return; }
  const k = /^[0-9]$/.test(e.key) ? (e.key as Key) : MAP[e.key];
  if (k) { e.preventDefault(); press(k); }
});

function openSheet() {
  if (!current.canPay || current.totalCents === null) return;
  drawLines(sheetLines, current.lines);
  sheetTotal.textContent = `${CURRENCY}${current.totalFormatted}`;
  const ff = fatFingerCheck(current.totalCents, SHOP.typicalCents);
  largeWarned = ff.suspicious;
  sheetWarn.hidden = !ff.suspicious;
  if (ff.suspicious) sheetWarn.textContent = `${ff.reason} Did you mean ${CURRENCY}${formatMoney(ff.suggestionCents)}?`;
  sheetErr.hidden = true;
  confirmBtn.disabled = false;
  confirmBtn.textContent = "Confirm and pay";
  sheet.showModal();
}
payBtn.addEventListener("click", openSheet);
el<HTMLButtonElement>("cancel").addEventListener("click", () => sheet.close());

// The real payment: send KEYS to our server, then go to PayPal to approve.
confirmBtn.addEventListener("click", async () => {
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Contacting PayPal...";
  sheetErr.hidden = true;
  try {
    const r = await fetch("/api/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId: SHOP.id, keys: sent, confirmedLarge: largeWarned }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.reason || "Payment could not start");
    location.href = j.approvalUrl;
  } catch (e) {
    const m = (e as Error).message;
    sheetErr.textContent = m === "Failed to fetch" ? "Cannot reach the server. Is `npm run dev` running?" : m;
    sheetErr.hidden = false;
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm and pay";
  }
});

// ---- Haggle: two AI agents negotiate a discount on your tape ----
interface Turn { side: "customer" | "shop"; accept: boolean; discountCents: number; message: string; source: "gemini" | "scripted"; note?: string }
interface HaggleResult { turns: Turn[]; finalDiscountCents: number; agreed: boolean; keys: Key[]; totalBeforeCents: number; totalAfterCents: number }

const haggleBtn = el<HTMLButtonElement>("haggle");
const haggleSheet = el<HTMLDialogElement>("haggleSheet");
const chat = el<HTMLOListElement>("chat");
const haggleErr = el<HTMLParagraphElement>("haggleErr");
const haggleYes = el<HTMLButtonElement>("haggleYes");
let haggleResult: HaggleResult | null = null;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function updateHaggle() {
  haggleBtn.disabled = !(current.canPay && (current.totalCents ?? 0) >= 100);
}

function addBubble(t: Turn) {
  const li = document.createElement("li");
  li.className = `bubble ${t.side}`;
  const head = document.createElement("div");
  head.className = "bubble-head";
  const who = document.createElement("strong");
  who.textContent = t.side === "customer" ? "Your agent" : "Shop's agent";
  const chip = document.createElement("span");
  chip.className = "chip";
  const amt = `-${CURRENCY}${formatMoney(t.discountCents)}`;
  chip.textContent = t.accept ? `agrees ${amt}` : `${t.side === "customer" ? "asks" : "offers"} ${amt}`;
  const src = document.createElement("span");
  src.className = "src";
  src.textContent = t.source === "gemini" ? "Gemini" : "offline";
  head.append(who, chip, src);
  const msg = document.createElement("p");
  msg.textContent = t.message;
  li.append(head, msg);
  if (t.note) { const n = document.createElement("p"); n.className = "ref"; n.textContent = t.note; li.append(n); }
  chat.append(li);
  li.scrollIntoView({ block: "nearest" });
}

haggleBtn.addEventListener("click", async () => {
  chat.replaceChildren();
  haggleErr.hidden = true;
  haggleYes.disabled = true;
  haggleYes.textContent = "Apply";
  haggleResult = null;
  haggleSheet.showModal();
  const wait = document.createElement("li");
  wait.className = "thinking";
  wait.textContent = "The agents are talking...";
  chat.append(wait);
  try {
    const r = await fetch("/api/haggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId: SHOP.id, keys: sent }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "Haggle failed");
    wait.remove();
    for (const t of j.turns as Turn[]) { addBubble(t); await sleep(800); }
    haggleResult = j as HaggleResult;
    const d = formatMoney(haggleResult.finalDiscountCents);
    haggleYes.textContent = haggleResult.finalDiscountCents > 0 ? `${haggleResult.agreed ? "Apply" : "Take final offer"} -${CURRENCY}${d}` : "No discount";
    haggleYes.disabled = haggleResult.finalDiscountCents <= 0;
  } catch (e) {
    wait.remove();
    const m = (e as Error).message;
    haggleErr.textContent = m === "Failed to fetch" ? "Cannot reach the server. Is `npm run dev` running?" : m;
    haggleErr.hidden = false;
  }
});
el<HTMLButtonElement>("haggleNo").addEventListener("click", () => haggleSheet.close());

// The agents "press the keys": we replay the extra keys onto your keypad one by one.
haggleYes.addEventListener("click", async () => {
  const r = haggleResult;
  if (!r) return;
  haggleSheet.close();
  const samePrefix = sent.every((k, i) => r.keys[i] === k);
  if (!samePrefix) press("clear");
  for (const k of r.keys.slice(samePrefix ? sent.length : 0)) { press(k); await sleep(180); }
});


// ---- Result screen after PayPal sends the customer back ----
async function showResult(kind: "paid" | "failed" | "cancelled", id: string) {
  el("keypadView").hidden = true;
  el("statusView").hidden = false;
  const badge = el<HTMLElement>("badge");
  const title = el<HTMLElement>("statusTitle");
  const sub = el<HTMLElement>("statusSub");
  badge.dataset.kind = kind;
  badge.textContent = kind === "paid" ? "Paid" : kind === "failed" ? "Failed" : "Cancelled";
  title.textContent = kind === "paid" ? "Payment complete" : kind === "failed" ? "Payment did not go through" : "You cancelled the payment";
  sub.textContent = "";
  try {
    const r = await fetch(`/api/payments/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error("not found");
    const p = await r.json();
    sub.textContent = `To ${p.merchantName}`;
    drawLines(el<HTMLOListElement>("statusLines"), p.lines);
    el("statusTotal").textContent = `${CURRENCY}${formatMoney(p.amountCents)}`;
    const facts = el<HTMLElement>("facts");
    facts.replaceChildren();
    const add = (k: string, v: string) => {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      facts.append(dt, dd);
    };
    add("PayPal order", p.orderId);
    if (p.captureId) add("PayPal capture", p.captureId);
    add("Tape fingerprint", p.tapeHash.slice(0, 16) + "...");
    if (p.error) add("Reason", p.error);
  } catch {
    sub.textContent = "Could not load payment details.";
  }
}
el<HTMLButtonElement>("again").addEventListener("click", () => { location.href = "/"; });

async function init() {
  try {
    const r = await fetch("/api/merchants");
    if (r.ok) { const list = await r.json(); if (list[0]) SHOP = list[0]; }
  } catch { /* server not running: keep the default shop */ }
  showShop();
  render(current);

  const q = new URLSearchParams(location.search);
  if (q.get("paid")) void showResult("paid", q.get("paid")!);
  else if (q.get("failed")) void showResult("failed", q.get("failed")!);
  else if (q.get("cancelled")) void showResult("cancelled", q.get("cancelled")!);
}
void init();
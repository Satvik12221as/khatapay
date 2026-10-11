import { Keypad, fatFingerCheck, formatMoney, type Key, type View } from "../src/keypad/keypad";

// Change this symbol to match the currency you use in the PayPal sandbox.
const CURRENCY = "$";
// Demo shop. In a later phase this comes from the server.
const SHOP = { name: "Lakshmi Provision Store", typicalCents: 12000 };

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

el<HTMLElement>("shopName").textContent = SHOP.name;
el<HTMLElement>("sheetShop").textContent = `To ${SHOP.name}`;

let current: View = kp.view();

/** Draw receipt lines (one per item) into a list element. */
function drawLines(list: HTMLOListElement, v: View) {
  list.replaceChildren();
  for (const l of v.lines) {
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

  // Only itemize when the user is actually doing a sum.
  const isSum = /[+×÷]|.-/.test(v.display);
  if (isSum && v.totalCents !== null) drawLines(linesEl, v); else linesEl.replaceChildren();

  totalEl.textContent = v.totalCents !== null ? `${CURRENCY}${v.totalFormatted}` : "-";
  payBtn.disabled = !v.canPay;
  payBtn.textContent = v.canPay ? `Pay ${CURRENCY}${v.totalFormatted}` : "Pay";

  if (v.error) msgEl.textContent = v.error;
  else if (v.totalCents !== null && v.totalCents <= 0) msgEl.textContent = "Total must be above zero.";
  else msgEl.textContent = "";
}

function press(k: Key) { render(kp.press(k)); }

// Taps on the on-screen keypad
el<HTMLElement>("pad").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-key]");
  if (btn) press(btn.dataset.key as Key);
});
el<HTMLButtonElement>("clear").addEventListener("click", () => press("clear"));

// Physical keyboard (handy on desktop and for demos)
const MAP: Record<string, Key> = { "*": "×", x: "×", "/": "÷", "-": "-", "+": "+", ".": ".", Backspace: "back", Escape: "clear" };
window.addEventListener("keydown", (e) => {
  if (sheet.open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Enter") { if (current.canPay) openSheet(); return; }
  const k = /^[0-9]$/.test(e.key) ? (e.key as Key) : MAP[e.key];
  if (k) { e.preventDefault(); press(k); }
});

// Confirm sheet (this is where the PIN step lives in GPay/Paytm)
function openSheet() {
  if (!current.canPay || current.totalCents === null) return;
  drawLines(sheetLines, current);
  sheetTotal.textContent = `${CURRENCY}${current.totalFormatted}`;
  const ff = fatFingerCheck(current.totalCents, SHOP.typicalCents);
  sheetWarn.hidden = !ff.suspicious;
  if (ff.suspicious) sheetWarn.textContent = `${ff.reason} Did you mean ${CURRENCY}${formatMoney(ff.suggestionCents)}?`;
  sheet.showModal();
}
payBtn.addEventListener("click", openSheet);
el<HTMLButtonElement>("cancel").addEventListener("click", () => sheet.close());
el<HTMLButtonElement>("confirm").addEventListener("click", () => {
  const paid = current.totalFormatted;
  sheet.close();
  kp.press("clear");
  render(kp.view());
  msgEl.textContent = `Confirmed ${CURRENCY}${paid}. PayPal connects in the next phase.`;
});

render(current);
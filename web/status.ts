import { api, button, drawAudit, drawLines, drawVerdict, el, money, REASONS, select, STATE_INFO, text, textarea, type PaymentDTO } from "./common";

const TERMINAL = ["RELEASED", "REFUNDED", "FAILED", "CANCELLED"];
let timer: number | undefined;
let lastKey = "";

/** The customer's payment screen. Polls every 3 seconds so shop actions show up live. */
export function showStatus(id: string) {
  el("keypadView").hidden = true;
  el("statusView").hidden = false;
  el<HTMLButtonElement>("again").onclick = () => { location.href = "/"; };
  const err = el<HTMLElement>("statusErr");

  const refresh = async () => {
    try {
      const p = await api<PaymentDTO>(`/api/payments/${encodeURIComponent(id)}`);
      render(p, id, refresh);
      if (TERMINAL.includes(p.state)) window.clearInterval(timer);
    } catch (e) {
      err.textContent = (e as Error).message; err.hidden = false;
    }
  };
  void refresh();
  window.clearInterval(timer);
  timer = window.setInterval(refresh, 3000);
}

function render(p: PaymentDTO, id: string, refresh: () => Promise<void>) {
  const info = STATE_INFO[p.state];
  const badge = el<HTMLElement>("badge");
  badge.textContent = info.label;
  badge.dataset.kind = info.kind;
  el("statusTitle").textContent = info.title;
  el("statusSub").textContent = `To ${p.merchantName}`;
  drawLines(el("statusLines"), p.lines);
  el("statusTotal").textContent = money(p.amountCents);
  drawVerdict(el("verdictBox"), p.dispute?.verdict);
  drawAudit(el("audit"), p.events);

  const facts = el("facts");
  facts.replaceChildren();
  const add = (k: string, v?: string) => { if (v) facts.append(text("dt", "", k), text("dd", "", v)); };
  add("PayPal order", p.orderId);
  add("Captured", p.captureId);
  add("Shop payout", p.payoutId);
  add("Refund", p.refundId);
  add("Tape fingerprint", p.tapeHash.slice(0, 16) + "...");
  add("Reason", p.error);

  // Only rebuild the buttons when something relevant changed (keeps a half-typed form alive).
  const key = [p.state, p.dispute?.shopStance ?? "", p.dispute?.verdict ? "v" : ""].join("|");
  if (key === lastKey) return;
  lastKey = key;
  const box = el("actions");
  box.replaceChildren();
  const err = el<HTMLElement>("statusErr");
  const run = (path: string, body?: unknown) => async () => {
    err.hidden = true;
    try { await api(`/api/payments/${encodeURIComponent(id)}/${path}`, "POST", body); } catch (e) { err.textContent = (e as Error).message; err.hidden = false; }
    lastKey = ""; await refresh();
  };

  if (p.state === "HELD") {
    box.append(text("p", "hint", "The shop is paid only after it delivers and you confirm."));
    box.append(button("Refund me", "ghost", run("refund")));
  }
  if (p.state === "FULFILLED") {
    box.append(text("p", "hint", "The shop marked this delivered. Got everything?"));
    box.append(button("Confirm receipt, pay the shop", "pay", run("confirm")));
    const form = document.createElement("div");
    form.className = "form"; form.hidden = true;
    const reason = select(REASONS); const note = textarea("What went wrong? (optional)");
    form.append(reason, note, button("Open dispute", "ghost", async () => run("dispute", { reason: reason.value, note: note.value })()));
    box.append(button("Report a problem", "ghost", async () => { form.hidden = !form.hidden; }), form);
  }
  if (p.state === "DISPUTED") {
    const d = p.dispute!;
    box.append(text("p", "hint", `Your claim: ${REASONS[d.reason] ?? d.reason}${d.note ? ` ("${d.note}")` : ""}`));
    box.append(text("p", "hint", d.shopStance ? `Shop replied: ${d.shopStance === "agrees_refund" ? "agrees to refund" : "says it delivered"}${d.shopNote ? ` ("${d.shopNote}")` : ""}` : "The shop has not replied yet. You can ask the judges now or wait."));
    box.append(button("Ask the Tape Judges", "pay", run("judge")));
  }
}
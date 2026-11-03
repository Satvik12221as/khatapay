import { api, button, drawAudit, drawLines, drawVerdict, el, money, REASONS, select, STATE_INFO, text, textarea, type PaymentDTO } from "./common";

const list = el<HTMLOListElement>("list");
const msg = el<HTMLElement>("mMsg");
let lastJson = "";

function card(p: PaymentDTO): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "card";
  const info = STATE_INFO[p.state];
  const head = document.createElement("div");
  head.className = "card-head";
  const badge = text("span", "badge", info.label);
  badge.dataset.kind = info.kind;
  head.append(text("strong", "", `${money(p.amountCents)} · ${p.merchantName}`), badge);
  li.append(head, text("div", "ref", `${new Date(p.createdAt).toLocaleString()} · ${p.id.slice(0, 8)}`));

  const lines = document.createElement("ol");
  lines.className = "lines";
  drawLines(lines, p.lines);
  li.append(lines);

  const act = (path: string, body?: unknown) => async () => {
    msg.textContent = "";
    try { await api(`/api/payments/${encodeURIComponent(p.id)}/${path}`, "POST", body); } catch (e) { msg.textContent = (e as Error).message; }
    lastJson = ""; await load();
  };

  if (p.state === "HELD") li.append(button("Mark delivered", "pay", act("deliver")));
  if (p.state === "FULFILLED") li.append(text("p", "hint", "Waiting for the customer to confirm."));
  if (p.state === "DISPUTED" && p.dispute) {
    const d = p.dispute;
    li.append(text("p", "hint", `Customer claim: ${REASONS[d.reason] ?? d.reason}${d.note ? ` ("${d.note}")` : ""}`));
    if (!d.shopStance) {
      const stance = select({ delivered_ok: "I delivered, the claim is wrong", agrees_refund: "I agree to refund" });
      const note = textarea("Your side (optional)");
      li.append(stance, note, button("Send reply", "ghost", async () => act("respond", { stance: stance.value, note: note.value })()));
    } else {
      li.append(text("p", "hint", `Your reply: ${d.shopStance === "agrees_refund" ? "agree to refund" : "delivered"}${d.shopNote ? ` ("${d.shopNote}")` : ""}`));
    }
    if (!d.verdict) li.append(button("Ask the Tape Judges", "pay", act("judge")));
  }
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  drawVerdict(verdict, p.dispute?.verdict);
  li.append(verdict);

  const facts = document.createElement("dl");
  facts.className = "facts";
  for (const [k, v] of [["Captured", p.captureId], ["Payout", p.payoutId], ["Refund", p.refundId]] as const) if (v) facts.append(text("dt", "", k), text("dd", "", v));
  li.append(facts);

  const det = document.createElement("details");
  det.className = "audit";
  det.append(text("summary", "", "Audit trail"));
  const ol = document.createElement("ol");
  drawAudit(ol, p.events);
  det.append(ol);
  li.append(det);
  return li;
}

async function load() {
  try {
    const all = await api<PaymentDTO[]>("/api/payments");
    const shown = all.filter((p) => p.state !== "CREATED" && p.state !== "CANCELLED");
    const json = JSON.stringify(shown);
    if (json === lastJson) return;
    // Do not wipe a reply the shop owner is typing.
    if (list.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement) return;
    lastJson = json;
    list.replaceChildren(...shown.map(card));
    if (!shown.length) list.append(text("li", "hint", "No payments yet. Make one on the customer keypad."));
  } catch (e) {
    msg.textContent = (e as Error).message;
  }
}
void load();
window.setInterval(load, 3000);
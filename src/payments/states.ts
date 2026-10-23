import type { PaymentState } from "./store";

export type Action = "capture" | "cancel" | "fail" | "deliver" | "refund" | "confirm" | "dispute" | "release";

// Every legal move. Anything not listed here is refused.
const T: Record<PaymentState, Partial<Record<Action, PaymentState>>> = {
  CREATED:   { capture: "HELD", cancel: "CANCELLED", fail: "FAILED" },
  HELD:      { deliver: "FULFILLED", refund: "REFUNDED" },
  FULFILLED: { confirm: "RELEASED", dispute: "DISPUTED" },
  DISPUTED:  { release: "RELEASED", refund: "REFUNDED" },
  RELEASED: {}, REFUNDED: {}, FAILED: {}, CANCELLED: {},
};

export class IllegalTransition extends Error {
  constructor(public from: PaymentState, public action: Action) {
    super(`Cannot ${action} a payment that is ${from}`);
    this.name = "IllegalTransition";
  }
}

export function next(from: PaymentState, action: Action): PaymentState {
  const to = T[from][action];
  if (!to) throw new IllegalTransition(from, action);
  return to;
}
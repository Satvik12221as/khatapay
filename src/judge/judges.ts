import type { ClaimReason, PanelVerdict, ShopStance, Vote } from "../payments/store";

/** Facts computed by OUR code. The two *Note fields are untrusted user text. */
export interface Evidence {
  totalCents: number;
  lines: { expr: string; cents: number }[];
  tapeVerified: boolean;
  deliveryMarked: boolean;
  hoursSinceDelivery: number | null;
  claimReason: ClaimReason;
  customerNote: string;
  shopStance: ShopStance | "no_response";
  shopNote: string;
}

export type Lean = "customer" | "shop" | "neutral";
export interface Persona { id: string; name: string; lean: Lean }
// The names must match the Python service's judges.
export const PERSONAS: Persona[] = [
  { id: "consumer", name: "Consumer advocate", lean: "customer" },
  { id: "shopkeeper", name: "Small-shop advocate", lean: "shop" },
  { id: "auditor", name: "Neutral auditor", lean: "neutral" },
];

type Ballot = Omit<Vote, "judge">;
export interface JudgeBrain { vote(p: Persona, ev: Evidence): Promise<Ballot> }

/** Rule-based judges. No AI. The offline safety net for when the Python agent service is unavailable. */
export class ScriptedJudge implements JudgeBrain {
  async vote(p: Persona, ev: Evidence): Promise<Ballot> {
    const s = "scripted" as const;
    const refund = (reason: string): Ballot => ({ verdict: "refund", reason, source: s });
    const release = (reason: string): Ballot => ({ verdict: "release", reason, source: s });
    if (!ev.tapeVerified) return refund("The bill's fingerprint does not match, so it cannot be trusted.");
    if (ev.shopStance === "agrees_refund") return refund("The shop itself agrees to a refund.");
    if (ev.claimReason === "wrong_amount") return release("The customer approved this exact tape before paying and the total matches it.");
    if (p.lean === "customer") return refund("Delivery cannot be proven either way, so the customer gets the benefit of the doubt.");
    if (p.lean === "shop") return release("The shop marked delivery and nothing proves otherwise.");
    return ev.shopStance === "delivered_ok"
      ? release("The shop states it delivered and the bill is intact; the claim is not backed by evidence.")
      : refund("The shop did not defend the delivery, so the customer's claim stands.");
  }
}

/** Three judges vote in parallel. Majority wins. Judges can only pick release or refund. */
export async function runPanel(judge: JudgeBrain, ev: Evidence): Promise<PanelVerdict> {
  const votes: Vote[] = await Promise.all(PERSONAS.map(async (p) => ({ judge: p.name, ...(await judge.vote(p, ev)) })));
  const outcome = votes.filter((v) => v.verdict === "release").length >= 2 ? "release" : "refund";
  return { votes, outcome };
}
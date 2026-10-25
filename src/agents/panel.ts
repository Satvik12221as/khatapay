import { PERSONAS, ScriptedJudge, runPanel, type Evidence, type JudgeBrain } from "../judge/judges";
import type { PanelVerdict } from "../payments/store";
import { AgentsClient } from "./client";

export interface Panel { run(ev: Evidence): Promise<PanelVerdict> }

/** Offline rule-based judges (no AI). */
export class LocalPanel implements Panel {
  constructor(private judge: JudgeBrain = new ScriptedJudge()) {}
  run(ev: Evidence) { return runPanel(this.judge, ev); }
}

/** The Node referee for verdicts: exactly one vote per judge, and WE count the majority, never the service. */
export function checkVerdict(raw: { votes: PanelVerdict["votes"]; note?: string }): PanelVerdict {
  const names = PERSONAS.map((p) => p.name);
  if (raw.votes.length !== names.length || !names.every((n, i) => raw.votes[i].judge === n)) throw new Error("Verdict does not have one vote per judge");
  const outcome = raw.votes.filter((v) => v.verdict === "release").length >= 2 ? "release" : "refund";
  return { votes: raw.votes, outcome, ...(raw.note ? { note: raw.note } : {}) };
}

/** Asks the Python LangGraph judges; on any failure or rule break, uses the offline judges instead. */
export class RemotePanel implements Panel {
  constructor(private client: AgentsClient, private fallback: Panel, private onError: (e: unknown) => void = () => {}) {}
  async run(ev: Evidence): Promise<PanelVerdict> {
    try { return checkVerdict(await this.client.judge(ev)); }
    catch (e) { this.onError(e); return this.fallback.run(ev); }
  }
}

export function makePanel(env: Record<string, string | undefined> = process.env, onError?: (e: unknown) => void, fetchImpl?: typeof fetch): Panel {
  const local = new LocalPanel();
  return env.AGENTS_URL ? new RemotePanel(new AgentsClient(env.AGENTS_URL, env.AGENTS_API_KEY, fetchImpl), local, onError) : local;
}
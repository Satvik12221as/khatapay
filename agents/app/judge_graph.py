"""The Tape Judges as a LangGraph deliberation.

  START -> 3 judges vote IN PARALLEL -> tally -+-> unanimous ------------------------> summarize -> END
                                               +-> split: 3 judges re-vote in parallel,
                                                   each seeing the others' reasoning -> final_tally -> summarize

The chief justice (summarize) writes the plain-language ruling. The outcome itself is only a majority count."""
import logging
import operator
import time
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from .brains import PERSONAS, Brain, Persona
from .models import Evidence, JudgeResponse, TraceStep, Vote

log = logging.getLogger("agents.judge")


class JState(TypedDict, total=False):
    evidence: dict
    round1: Annotated[list[dict], operator.add]
    round2: Annotated[list[dict], operator.add]
    split: bool
    note: str
    trace: Annotated[list[dict], operator.add]


def _step(node: str, t0: float, detail: str) -> dict:
    return {"node": node, "ms": round((time.perf_counter() - t0) * 1000, 1), "detail": detail}


def _order(ballots: list[dict]) -> list[dict]:
    names = [p.name for p in PERSONAS]
    return sorted(ballots, key=lambda b: names.index(b["judge"]))


def _releases(ballots: list[dict]) -> int:
    return sum(1 for b in ballots if b["verdict"] == "release")


def build_judge_graph(brain: Brain):
    def voter(p: Persona, key: str, deliberate: bool):
        async def node(s: JState) -> dict:
            t0 = time.perf_counter()
            peers = [b for b in s["round1"] if b["judge"] != p.name] if deliberate else None
            b = await brain.vote(p, s["evidence"], peers)
            ballot = {"judge": p.name, "verdict": b.verdict, "reason": b.reason, "source": b.source}
            return {key: [ballot], "trace": [_step(f"{'rebut' if deliberate else 'judge'}_{p.id}", t0, b.verdict)]}
        return node

    async def tally(s: JState) -> dict:
        t0 = time.perf_counter()
        n = _releases(s["round1"])
        split = 0 < n < len(s["round1"])
        return {"split": split, "trace": [_step("tally", t0, "split vote, judges deliberate" if split else "unanimous")]}

    async def final_tally(s: JState) -> dict:
        t0 = time.perf_counter()
        before = {b["judge"]: b["verdict"] for b in s["round1"]}
        changed = sum(1 for b in s["round2"] if before.get(b["judge"]) != b["verdict"])
        return {"note": f"Judges deliberated after a split vote; {changed} changed their verdict. ",
                "trace": [_step("final_tally", t0, f"{changed} changed")]}

    async def summarize(s: JState) -> dict:
        t0 = time.perf_counter()
        ballots = _order(s["round2"] if s.get("split") else s["round1"])
        text = await brain.summarize(s["evidence"], ballots, bool(s.get("split")))
        prefix = s.get("note") or ("Unanimous. " if len(ballots) and _releases(ballots) in (0, len(ballots)) else "")
        return {"note": prefix + text, "trace": [_step("summarize", t0, "chief justice")]}

    g = StateGraph(JState)
    for p in PERSONAS:
        g.add_node(f"judge_{p.id}", voter(p, "round1", False))
        g.add_node(f"rebut_{p.id}", voter(p, "round2", True))
        g.add_edge(START, f"judge_{p.id}")
    g.add_node("tally", tally)
    g.add_node("final_tally", final_tally)
    g.add_node("summarize", summarize)
    g.add_edge([f"judge_{p.id}" for p in PERSONAS], "tally")

    rebuts = [f"rebut_{p.id}" for p in PERSONAS]
    g.add_conditional_edges("tally", lambda s: rebuts if s.get("split") else "summarize", [*rebuts, "summarize"])
    g.add_edge(rebuts, "final_tally")
    g.add_edge("final_tally", "summarize")
    g.add_edge("summarize", END)
    return g.compile()


async def run_judge(graph, ev: Evidence) -> JudgeResponse:
    st = await graph.ainvoke({"evidence": ev.model_dump(by_alias=True), "round1": [], "round2": [], "trace": []},
                             config={"recursion_limit": 25})
    ballots = _order(st["round2"] if st.get("split") else st["round1"])
    outcome = "release" if _releases(ballots) >= 2 else "refund"
    return JudgeResponse(votes=[Vote(**b) for b in ballots], outcome=outcome, note=st.get("note"),
                         trace=[TraceStep(**t) for t in st["trace"]])
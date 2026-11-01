"""The Referral Concierge as a LangGraph state machine.

  START -> shortlist (trust filter) -+-> interpret (what does the friend need?) -> rank
                                     +-> rank
  rank -> compose (write the pitch) -> fact_check -+-> (invented a fact? send back once) -> compose
                                                   +-> END    (still wrong -> safe template)
"""
import operator
import time
from typing import Annotated, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from .referral_brain import ComposeCtx, Composition, ReferralBrain, check_message, template_message
from .referral_models import RecommendRequest, RecommendResponse, Ranked, TraceStep


class NoEligibleShop(Exception):
    pass


class RState(TypedDict, total=False):
    req: dict
    shops: list[dict]
    tags: list[str]
    ranked: list[dict]
    pick: dict
    pick_id: str
    message: str
    source: str
    feedback: Optional[str]
    retries: int
    revise: bool
    revisions: int
    fact_checked: bool
    trace: Annotated[list[dict], operator.add]


def _step(node: str, t0: float, detail: str) -> dict:
    return {"node": node, "ms": round((time.perf_counter() - t0) * 1000, 1), "detail": detail}


def _ctx(s: RState) -> ComposeCtx:
    r = s["req"]
    return ComposeCtx(referrer_name=r["referrer_name"], shop=s["pick"], welcome_cents=r["welcome_cents"], needs=r["needs"], feedback=s.get("feedback"))


def build_referral_graph(brain: ReferralBrain):
    async def shortlist(s: RState) -> dict:
        t0 = time.perf_counter()
        r = s["req"]
        shops = [c for c in r["candidates"] if c["score"] >= r["min_trust"]]
        if not shops:
            raise NoEligibleShop()
        return {"shops": shops, "tags": [], "trace": [_step("shortlist", t0, f"{len(shops)} of {len(r['candidates'])} shops meet the trust minimum")]}

    async def interpret(s: RState) -> dict:
        t0 = time.perf_counter()
        tags = await brain.interpret(s["req"]["needs"])
        return {"tags": tags, "trace": [_step("interpret", t0, ", ".join(tags) or "no clear need")]}

    async def rank(s: RState) -> dict:
        t0 = time.perf_counter()
        tags = set(s.get("tags", []))  # a clear need decides among the TRUSTED shops; trust still gates and breaks ties
        scored = sorted(({**c, "fit": min(100, c["score"] + (25 if c["category"] in tags else 0) + min(10, c["customer_orders"]))} for c in s["shops"]),
                        key=lambda c: (0 if c["category"] in tags else 1, -c["fit"], c["name"]))
        return {"ranked": scored, "pick": scored[0], "retries": 0, "feedback": None, "revise": False, "revisions": 0,
                "trace": [_step("rank", t0, f"picks {scored[0]['shop_id']} (fit {scored[0]['fit']})")]}

    async def compose(s: RState) -> dict:
        t0 = time.perf_counter()
        comp = await brain.compose(_ctx(s))
        return {"message": comp.message, "source": comp.source, "pick_id": comp.shop_id,
                "trace": [_step("compose", t0, f"{comp.source} draft")]}

    async def fact_check(s: RState) -> dict:
        t0 = time.perf_counter()
        problem = check_message(_ctx(s), Composition(s.get("pick_id", s["pick"]["shop_id"]), s["message"], s["source"]))
        if problem is None:
            return {"revise": False, "fact_checked": True, "trace": [_step("fact_check", t0, "all facts verified")]}
        if s.get("retries", 0) < 1:
            return {"revise": True, "retries": 1, "revisions": s.get("revisions", 0) + 1, "feedback": problem,
                    "trace": [_step("fact_check", t0, f"sent back: {problem}")]}
        return {"revise": False, "fact_checked": False, "message": template_message(_ctx(s)), "source": "scripted",
                "trace": [_step("fact_check", t0, "still wrong, using the verified template")]}

    g = StateGraph(RState)
    for name, fn in (("shortlist", shortlist), ("interpret", interpret), ("rank", rank), ("compose", compose), ("fact_check", fact_check)):
        g.add_node(name, fn)
    g.add_edge(START, "shortlist")
    g.add_conditional_edges("shortlist", lambda s: "interpret" if s["req"]["needs"].strip() else "rank", {"interpret": "interpret", "rank": "rank"})
    g.add_edge("interpret", "rank")
    g.add_edge("rank", "compose")
    g.add_edge("compose", "fact_check")
    g.add_conditional_edges("fact_check", lambda s: "compose" if s.get("revise") else END, {"compose": "compose", END: END})
    return g.compile()


async def run_recommend(graph, req: RecommendRequest) -> RecommendResponse:
    r = req.model_dump()
    st = await graph.ainvoke({"req": r, "trace": []}, config={"recursion_limit": 25})
    return RecommendResponse(
        shop_id=st["pick"]["shop_id"], message=st["message"], source=st["source"], revisions=st.get("revisions", 0),
        fact_checked=bool(st.get("fact_checked", False)), ranked=[Ranked(shop_id=c["shop_id"], fit=c["fit"]) for c in st["ranked"]],
        trace=[TraceStep(**t) for t in st["trace"]])
"""The negotiation as a LangGraph state machine.

   customer -> shop_decide -> shop_referee -+-> (offer too high? send back once) -> shop_decide
       ^                                    +-> (deal) -> END
       +------------ round 2 ---------------+

The shop agent drafts an offer, the referee (plain code) checks it, and a draft that breaks the
shop's own limit goes BACK to the agent once with feedback before the referee clamps it."""
import logging
import operator
import time
from typing import Annotated, Any, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from .brains import Brain, HaggleCtx
from .models import HaggleRequest, HaggleResponse, TraceStep, Turn
from .referee import cap_for, clamp, comfort_for, customer_max, money

log = logging.getLogger("agents.haggle")


class HState(TypedDict, total=False):
    base: dict
    round: int
    ask: int
    counter: int
    pending: dict
    feedback: Optional[str]
    retries: int
    revise: bool
    done: bool
    agreed: bool
    final: int
    turns: Annotated[list[dict], operator.add]
    trace: Annotated[list[dict], operator.add]


def _step(node: str, t0: float, detail: str) -> dict:
    return {"node": node, "ms": round((time.perf_counter() - t0) * 1000, 1), "detail": detail}


def _ctx(s: HState, side: str) -> HaggleCtx:
    b = s["base"]
    return HaggleCtx(side=side, round=s["round"], merchant_name=b["merchant_name"], total_cents=b["total"], cap_cents=b["cap"],
                     comfort_cents=b["comfort"], visits=b["visits"], member_since=b["since"], on_time_rate=b["on_time"],
                     ask_cents=s.get("ask"), counter_cents=s.get("counter"), feedback=s.get("feedback"))


def build_haggle_graph(brain: Brain):
    async def customer(s: HState) -> dict:
        t0 = time.perf_counter()
        b, r = s["base"], s["round"]
        d = await brain.haggle(_ctx(s, "customer"))
        if r == 2 and d.accept:
            counter = s["counter"]
            turn = {"side": "customer", "accept": True, "discount_cents": counter, "message": d.message, "source": d.source}
            return {"turns": [turn], "done": True, "agreed": True, "final": counter, "trace": [_step("customer", t0, f"accepts {money(counter)}")]}
        if r == 1:
            ask = clamp(d.discount_cents, 0, customer_max(b["total"]))
            note = "Referee: ask reduced to a sane range." if ask != d.discount_cents else None
        else:
            counter = s["counter"]
            ask = clamp(d.discount_cents, counter, max(counter, s["ask"]))
            note = None
        turn = {"side": "customer", "accept": False, "discount_cents": ask, "message": d.message, "source": d.source, **({"note": note} if note else {})}
        return {"turns": [turn], "ask": ask, "retries": 0, "feedback": None, "revise": False, "trace": [_step("customer", t0, f"asks {money(ask)}")]}

    async def shop_decide(s: HState) -> dict:
        t0 = time.perf_counter()
        d = await brain.haggle(_ctx(s, "shop"))
        return {"pending": {"accept": d.accept, "discount": d.discount_cents, "message": d.message, "source": d.source},
                "trace": [_step("shop_decide", t0, f"drafts {money(d.discount_cents)}{' (accept)' if d.accept else ''}")]}

    async def shop_referee(s: HState) -> dict:
        t0 = time.perf_counter()
        b, r, ask, raw = s["base"], s["round"], s["ask"], s["pending"]
        cap, counter = b["cap"], s.get("counter", 0)
        over = raw["discount"] > cap or (raw["accept"] and ask > cap)
        if over and s.get("retries", 0) < 1:
            fb = f"Your draft of {money(raw['discount'])} breaks the shop's maximum of {money(cap)}. Revise it to stay within the limit."
            return {"revise": True, "retries": 1, "feedback": fb, "trace": [_step("shop_referee", t0, "sent back for revision")]}
        lo = 0 if r == 1 else counter
        allowed = min(ask, cap) if r == 1 else max(counter, min(ask, cap))
        accepted = raw["accept"] and ask <= cap
        disc = ask if accepted else clamp(raw["discount"], lo, allowed)
        note = f"Referee: the shop's limit is {b['pct']:g}% ({money(cap)})." if over else None
        agreed = accepted if r == 1 else (accepted or disc == ask)
        turn = {"side": "shop", "accept": agreed, "discount_cents": disc, "message": raw["message"], "source": raw["source"], **({"note": note} if note else {})}
        out: dict[str, Any] = {"turns": [turn], "revise": False, "trace": [_step("shop_referee", t0, f"approves {money(disc)}" + (" (clamped)" if over else ""))]}
        if r == 1 and not accepted:
            out.update({"counter": disc, "round": 2})
        else:
            out.update({"done": True, "agreed": agreed, "final": disc})
        return out

    def after_customer(s: HState) -> str:
        return END if s.get("done") else "shop_decide"

    def after_referee(s: HState) -> str:
        if s.get("revise"):
            return "shop_decide"
        return END if s.get("done") else "customer"

    g = StateGraph(HState)
    g.add_node("customer", customer)
    g.add_node("shop_decide", shop_decide)
    g.add_node("shop_referee", shop_referee)
    g.add_edge(START, "customer")
    g.add_conditional_edges("customer", after_customer, {"shop_decide": "shop_decide", END: END})
    g.add_edge("shop_decide", "shop_referee")
    g.add_conditional_edges("shop_referee", after_referee, {"shop_decide": "shop_decide", "customer": "customer", END: END})
    return g.compile()


async def run_haggle(graph, req: HaggleRequest) -> HaggleResponse:
    cap = cap_for(req.total_cents, req.max_discount_pct, req.min_total_cents)
    base = {"merchant_name": req.merchant_name, "total": req.total_cents, "cap": cap, "pct": req.max_discount_pct,
            "comfort": comfort_for(req.total_cents, req.loyalty.visits, cap), "visits": req.loyalty.visits,
            "since": req.loyalty.member_since, "on_time": req.loyalty.on_time_rate}
    st = await graph.ainvoke({"base": base, "round": 1, "turns": [], "trace": [], "retries": 0, "done": False},
                             config={"recursion_limit": 25})
    return HaggleResponse(turns=[Turn(**t) for t in st["turns"]], final_discount_cents=st["final"], agreed=st["agreed"],
                          trace=[TraceStep(**t) for t in st["trace"]])
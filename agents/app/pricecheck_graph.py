"""Price-check LangGraph state machine with deterministic fact-checking."""
import operator
import time
from typing import Annotated, Any, Optional, TypedDict

from langgraph.graph import END, START, StateGraph

from .pricecheck_brain import PriceBrain, PriceCtx, load_pricebook
from .pricecheck_models import LineCheck, PriceCheckRequest, PriceCheckResponse, TraceStep


class PState(TypedDict, total=False):
    req: dict
    pricebook: list[dict]
    audit: Any
    verified_lines: list[dict]
    total_verdict: str
    total_expected: Optional[int]
    note: str
    source: str
    trace: Annotated[list[dict], operator.add]


def _step(node: str, t0: float, detail: str) -> dict:
    return {"node": node, "ms": round((time.perf_counter() - t0) * 1000, 1), "detail": detail}


def build_pricecheck_graph(brain: PriceBrain):
    async def load_data(s: PState) -> dict:
        t0 = time.perf_counter()
        pb = load_pricebook()
        return {"pricebook": pb, "trace": [_step("load_data", t0, f"loaded {len(pb)} pricebook items")]}

    async def audit_prices(s: PState) -> dict:
        t0 = time.perf_counter()
        r = s["req"]
        ctx = PriceCtx(
            merchant_name=r["merchant_name"],
            total_cents=r["total_cents"],
            typical_cents=r.get("typical_cents"),
            category=r["category"],
            area=r["area"],
            lines=r["lines"],
            pricebook=s["pricebook"]
        )
        res = await brain.audit(ctx)
        return {"audit": res, "source": res.source, "trace": [_step("audit_prices", t0, f"{res.source} audit completed")]}

    async def fact_check(s: PState) -> dict:
        t0 = time.perf_counter()
        aud = s["audit"]
        # Ensure all line cents match original input exactly
        orig_lines = {l["expr"]: l["cents"] for l in s["req"]["lines"]}
        verified = []
        for l in aud.lines:
            cents = orig_lines.get(l.expr, l.cents)
            verified.append(LineCheck(
                expr=l.expr,
                cents=cents,
                verdict=l.verdict,
                expected_cents=l.expected_cents,
                note=l.note
            ))
        return {
            "verified_lines": verified,
            "total_verdict": aud.total_verdict,
            "total_expected": aud.total_expected_cents,
            "note": aud.note,
            "trace": [_step("fact_check", t0, "verified line items and amounts")]
        }

    g = StateGraph(PState)
    g.add_node("load_data", load_data)
    g.add_node("audit_prices", audit_prices)
    g.add_node("fact_check", fact_check)

    g.add_edge(START, "load_data")
    g.add_edge("load_data", "audit_prices")
    g.add_edge("audit_prices", "fact_check")
    g.add_edge("fact_check", END)
    return g.compile()


async def run_pricecheck(graph, req: PriceCheckRequest) -> PriceCheckResponse:
    st = await graph.ainvoke({"req": req.model_dump(), "trace": []}, config={"recursion_limit": 25})
    return PriceCheckResponse(
        lines=st["verified_lines"],
        total_verdict=st["total_verdict"],
        total_expected_cents=st["total_expected"],
        note=st["note"],
        source=st["source"],
        trace=[TraceStep(**t) for t in st["trace"]]
    )

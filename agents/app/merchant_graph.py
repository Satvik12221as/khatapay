"""Merchant Concierge Agent as a LangGraph state machine.

Helps customers find the right shop for their needs.
"""
import operator
import time
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from .merchant_brain import MerchantBrain, MerchantFindResult
from .merchant_models import MerchantFindRequest, MerchantFindResponse, MerchantMatch
from .models import TraceStep


class MState(TypedDict, total=False):
    """State for the merchant finder agent."""
    request: dict
    needs: str
    candidates: list[dict]
    filters: dict
    matches: list[dict]
    source: str
    trace: Annotated[list[dict], operator.add]


def _step(node: str, t0: float, detail: str) -> dict:
    """Create a trace step."""
    return {"node": node, "ms": round((time.perf_counter() - t0) * 1000, 1), "detail": detail}


def build_merchant_graph(brain: MerchantBrain):
    """Build the LangGraph state machine for merchant finding."""

    async def prepare_candidates(s: MState) -> dict:
        """Prepare the candidate list from the request."""
        t0 = time.perf_counter()
        req = s["request"]

        candidates = req.get("candidates", [])
        filters = {
            "min_trust_score": req.get("minTrustScore", 0),
            "area": req.get("area"),
            "max_price_dollars": req.get("maxPriceDollars"),
            "max_results": req.get("maxResults", 5)
        }

        return {
            "needs": req.get("needs", ""),
            "candidates": candidates,
            "filters": filters,
            "trace": [_step("prepare_candidates", t0, f"loaded {len(candidates)} candidates")]
        }

    async def find_matches(s: MState) -> dict:
        """Find matching merchants using the AI brain."""
        t0 = time.perf_counter()

        result: MerchantFindResult = await brain.find(
            s["needs"],
            s["candidates"],
            s["filters"]
        )

        matches_dicts = [
            {
                "shopId": m.shop_id,
                "name": m.name,
                "category": m.category,
                "area": m.area,
                "trustScore": m.trust_score,
                "trustTier": m.trust_tier,
                "typicalTotalDollars": m.typical_total_dollars,
                "distanceKm": m.distance_km,
                "fitScore": m.fit_score,
                "reason": m.reason
            }
            for m in result.matches
        ]

        return {
            "matches": matches_dicts,
            "source": result.source,
            "trace": [_step("find_matches", t0, f"found {len(matches_dicts)} matches")]
        }

    g = StateGraph(MState)
    g.add_node("prepare_candidates", prepare_candidates)
    g.add_node("find_matches", find_matches)

    g.add_edge(START, "prepare_candidates")
    g.add_edge("prepare_candidates", "find_matches")
    g.add_edge("find_matches", END)

    return g.compile()


async def run_merchant(graph, req: MerchantFindRequest) -> MerchantFindResponse:
    """Run the merchant finder agent with the given request."""
    state = {
        "request": req.model_dump(),
        "trace": []
    }

    result = await graph.ainvoke(state, config={"recursion_limit": 25})

    return MerchantFindResponse(
        matches=[MerchantMatch(**m) for m in result["matches"]],
        source=result["source"],
        trace=result["trace"]
    )
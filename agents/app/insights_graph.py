"""Merchant Performance Insights Agent as a LangGraph state machine.

The agent analyzes merchant performance data and generates actionable insights.
"""
import operator
import time
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from .insights_brain import InsightsBrain, InsightsResult
from .insights_models import InsightsRequest, InsightsResponse, Insight
from .models import TraceStep


class IState(TypedDict, total=False):
    """State for the insights agent."""
    request: dict
    merchant_name: str
    stats: dict
    period_days: int
    insights: list[dict]
    summary: str
    confidence: str
    source: str
    trace: Annotated[list[dict], operator.add]


def _step(node: str, t0: float, detail: str) -> dict:
    """Create a trace step."""
    return {"node": node, "ms": round((time.perf_counter() - t0) * 1000, 1), "detail": detail}


def build_insights_graph(brain: InsightsBrain):
    """Build the LangGraph state machine for merchant insights."""

    async def analyze_pattern(s: IState) -> dict:
        """Analyze the merchant's performance patterns."""
        t0 = time.perf_counter()
        req = s["request"]

        # Extract stats from the payment history stored locally
        stats = {
            "total_revenue_cents": req.get("totalRevenueCents", 0),
            "avg_order_cents": req.get("avgOrderCents", 0),
            "success_rate": req.get("successRate", 0),
            "disputes_lost": req.get("disputesLost", 0),
            "disputes_opened": req.get("disputesOpened", 0),
            "repeat_customer_rate": req.get("repeatCustomerRate", 0),
            "total_payments": req.get("totalPayments", 0),
            "avg_response_time_hours": req.get("avgResponseTimeHours", 24)
        }

        period_days = req.get("periodDays", 30)

        return {
            "merchant_name": req.get("merchantName", "Shop"),
            "stats": stats,
            "period_days": period_days,
            "trace": [_step("analyze_pattern", t0, f"analyzed {stats.get('total_payments', 0)} payments over {period_days} days")]
        }

    async def generate_insights(s: IState) -> dict:
        """Generate insights using the AI brain."""
        t0 = time.perf_counter()

        result: InsightsResult = await brain.generate(
            s["merchant_name"],
            s["stats"],
            s["period_days"]
        )

        insights_dicts = [{"id": i.id, "title": i.title, "description": i.description,
                          "priority": i.priority, "actionable": i.actionable,
                          "recommendedAction": i.recommendedAction} for i in result.insights]

        return {
            "insights": insights_dicts,
            "summary": result.summary,
            "confidence": result.confidence,
            "source": result.source,
            "trace": [_step("generate_insights", t0, f"generated {len(insights_dicts)} insights")]
        }

    g = StateGraph(IState)
    g.add_node("analyze_pattern", analyze_pattern)
    g.add_node("generate_insights", generate_insights)

    g.add_edge(START, "analyze_pattern")
    g.add_edge("analyze_pattern", "generate_insights")
    g.add_edge("generate_insights", END)

    return g.compile()


async def run_insights(graph, req: InsightsRequest) -> InsightsResponse:
    """Run the insights agent with the given request."""
    state = {
        "request": req.model_dump(),
        "trace": []
    }

    result = await graph.ainvoke(state, config={"recursion_limit": 25})

    return InsightsResponse(
        merchantId=req.merchantId,
        merchantName=result["merchant_name"],
        periodDays=result["period_days"],
        insights=[Insight(**i) for i in result["insights"]],
        summary=result["summary"],
        source=result["source"],
        confidence=result["confidence"],
        trace=result["trace"]
    )
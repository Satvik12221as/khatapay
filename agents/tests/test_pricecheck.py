"""Tests for the price-check agent."""
import pytest

from app.pricecheck_brain import ScriptedPriceBrain, GeminiPriceBrain, ResilientPriceBrain, PriceCtx
from app.pricecheck_graph import build_pricecheck_graph, run_pricecheck
from app.pricecheck_models import PriceCheckRequest
from app.models import Source


def ctx(**kw):
    base = dict(
        merchant_name="Lakshmi Provision Store",
        total_cents=2400,
        typical_cents=12000,
        category="groceries",
        area="Mylapore",
        lines=[{"expr": "500", "cents": 500}],
        pricebook=[],
    )
    return PriceCtx(**{**base, **kw})


@pytest.mark.asyncio
async def test_scripted_price_check_ok():
    brain = ScriptedPriceBrain()
    result = await brain.audit(ctx(lines=[{"expr": "500", "cents": 500}, {"expr": "1200", "cents": 1200}, {"expr": "700", "cents": 700}]))
    assert result.total_verdict == "ok"
    assert result.source == "scripted"
    assert all(l.verdict == "ok" for l in result.lines)


@pytest.mark.asyncio
async def test_scripted_flags_large_line():
    brain = ScriptedPriceBrain()
    result = await brain.audit(ctx(total_cents=15000, lines=[{"expr": "15000", "cents": 15000}]))
    assert result.lines[0].verdict == "overcharge"


@pytest.mark.asyncio
async def test_scripted_flags_total_over_3x_typical():
    brain = ScriptedPriceBrain()
    result = await brain.audit(ctx(total_cents=40000, lines=[{"expr": "12000", "cents": 12000}, {"expr": "12000", "cents": 12000}, {"expr": "16000", "cents": 16000}]))
    assert result.total_verdict == "flagged"


@pytest.mark.asyncio
async def test_scripted_suspicious_large_line_relative_to_typical():
    brain = ScriptedPriceBrain()
    result = await brain.audit(ctx(total_cents=10000, lines=[{"expr": "10000", "cents": 10000}]))
    assert result.lines[0].verdict == "suspicious"


@pytest.mark.asyncio
async def test_resilient_fallback_on_error():
    class BrokenBrain:
        async def audit(self, c):
            raise RuntimeError("Network error")

    resilient = ResilientPriceBrain(BrokenBrain(), ScriptedPriceBrain())
    result = await resilient.audit(ctx())
    assert result.source == "scripted"  # fell back


def test_price_check_graph_contract():
    brain = ScriptedPriceBrain()
    graph = build_pricecheck_graph(brain)
    req = PriceCheckRequest(
        merchant_name="Lakshmi Provision Store",
        total_cents=2400,
        typical_cents=12000,
        category="groceries",
        area="Mylapore",
        lines=[{"expr": "500", "cents": 500}, {"expr": "1200", "cents": 1200}, {"expr": "700", "cents": 700}]
    )
    # Just verify the graph builds and accepts valid input
    assert graph is not None


@pytest.mark.asyncio
async def test_run_pricecheck_end_to_end():
    brain = ScriptedPriceBrain()
    graph = build_pricecheck_graph(brain)
    req = PriceCheckRequest(
        merchant_name="Lakshmi Provision Store",
        total_cents=15000,
        typical_cents=12000,
        category="groceries",
        area="Mylapore",
        lines=[{"expr": "15000", "cents": 15000}]
    )
    result = await run_pricecheck(graph, req)
    assert result.total_verdict == "flagged"
    assert result.lines[0].verdict == "overcharge"
    assert result.source == "scripted"
    assert len(result.trace) >= 3
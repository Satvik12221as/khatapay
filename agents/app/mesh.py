"""In-process Agent Mesh — pub/sub for direct agent-to-agent communication.

No external Redis needed; uses asyncio queues for in-process pub/sub.
Can be swapped for Redis later without changing handler signatures.
"""

import asyncio
import json
import logging
from collections import defaultdict
from typing import Callable, Awaitable, Any

log = logging.getLogger("agents.mesh")


class AgentMesh:
    """In-process pub/sub mesh for agent-to-agent communication."""

    def __init__(self):
        self._subscribers: dict[str, list[Callable[[dict], Awaitable[None]]]] = defaultdict(list)
        self._running = False

    async def publish(self, topic: str, data: dict) -> None:
        """Publish an event to all subscribers of a topic."""
        if not self._running:
            return
        handlers = self._subscribers.get(topic, [])
        if not handlers:
            return
        payload = json.dumps(data)
        log.debug("Mesh publish: %s -> %d handlers", topic, len(handlers))
        for handler in handlers:
            try:
                await handler(json.loads(payload))
            except Exception as e:
                log.exception("Mesh handler error on %s: %s", topic, e)

    def subscribe(self, topic: str, handler: Callable[[dict], Awaitable[None]]) -> None:
        """Subscribe a handler to a topic."""
        self._subscribers[topic].append(handler)

    def start(self) -> None:
        self._running = True

    def stop(self) -> None:
        self._running = False


# Global mesh instance (singleton)
_mesh: AgentMesh | None = None


def get_mesh() -> AgentMesh:
    """Get the global mesh instance."""
    global _mesh
    if _mesh is None:
        _mesh = AgentMesh()
    return _mesh


# --- Topic constants ---
class Topics:
    PAYMENT_CREATED = "payment.created"
    PAYMENT_CAPTURED = "payment.captured"
    PAYMENT_DELIVERED = "payment.delivered"
    PAYMENT_DISPUTED = "payment.disputed"
    PAYMENT_RELEASED = "payment.released"
    PAYMENT_REFUNDED = "payment.refunded"
    PAYMENT_CANCELLED = "payment.cancelled"
    PAYMENT_FAILED = "payment.failed"

    INSIGHTS_GENERATE = "insights.generate"
    INVOICE_GENERATE = "invoice.generate"
    REFERRAL_SETTLE = "referral.settle"
    PRICE_CHECK = "price.check"

    JUDGE_REQUEST = "judge.request"


# --- Handler registration ---
async def _on_payment_captured(mesh: AgentMesh, data: dict) -> None:
    """Triggered when payment is captured (HELD state)."""
    payment_id = data.get("payment_id")
    merchant_id = data.get("merchant_id")
    if not payment_id:
        return

    # Trigger parallel: insights + invoice + referral settlement
    await asyncio.gather(
        mesh.publish(Topics.INSIGHTS_GENERATE, {"merchant_id": merchant_id, "payment_id": payment_id}),
        mesh.publish(Topics.INVOICE_GENERATE, {"payment_id": payment_id, "merchant_id": merchant_id}),
        mesh.publish(Topics.REFERRAL_SETTLE, {"payment_id": payment_id, "merchant_id": merchant_id}),
    )


async def _on_payment_delivered(mesh: AgentMesh, data: dict) -> None:
    """Triggered when payment is delivered (FULFILLED state)."""
    payment_id = data.get("payment_id")
    if not payment_id:
        return
    await mesh.publish(Topics.REFERRAL_SETTLE, {"payment_id": payment_id})


async def _on_payment_disputed(mesh: AgentMesh, data: dict) -> None:
    """Triggered when payment is disputed."""
    payment_id = data.get("payment_id")
    if not payment_id:
        return
    await mesh.publish(Topics.JUDGE_REQUEST, {"payment_id": payment_id})


async def _on_insights_generate(mesh: AgentMesh, data: dict) -> None:
    """Generate insights for a merchant."""
    from .insights_graph import build_insights_graph
    from .insights_brain import ScriptedInsightsBrain
    from .insights_models import InsightsRequest, PeriodParams

    merchant_id = data.get("merchant_id")
    if not merchant_id:
        return

    # Build request from stored payment data (simplified)
    # In production, fetch from store
    brain = ScriptedInsightsBrain()
    graph = build_insights_graph(brain)
    # Note: actual invocation would need payment store access
    log.info("Mesh: insights generation requested for %s", merchant_id)


async def _on_invoice_generate(mesh: AgentMesh, data: dict) -> None:
    """Generate invoice for a payment."""
    from .invoice_graph import build_invoice_graph
    from .invoice_brain import ScriptedInvoiceBrain
    from .invoice_models import InvoiceRequest, LineItem, MerchantInfo

    payment_id = data.get("payment_id")
    if not payment_id:
        return

    brain = ScriptedInvoiceBrain()
    graph = build_invoice_graph(brain)
    # Note: actual invocation would need payment store access
    log.info("Mesh: invoice generation requested for %s", payment_id)


async def _on_referral_settle(mesh: AgentMesh, data: dict) -> None:
    """Settle referral for a payment."""
    from .referral_api import ReferralService

    payment_id = data.get("payment_id")
    if not payment_id:
        return

    # Note: actual invocation would need ReferralService access
    log.info("Mesh: referral settlement requested for %s", payment_id)


async def _on_judge_request(mesh: AgentMesh, data: dict) -> None:
    """Request judge verdict for a disputed payment."""
    from .judge_graph import build_judge_graph
    from .brains import ScriptedBrain
    from .models import Evidence

    payment_id = data.get("payment_id")
    if not payment_id:
        return

    brain = ScriptedBrain()
    graph = build_judge_graph(brain)
    # Note: actual invocation would need evidence from payment store
    log.info("Mesh: judge verdict requested for %s", payment_id)


def register_mesh_handlers(mesh: AgentMesh, referrals: Any = None, payments: Any = None) -> None:
    """Register all mesh event handlers."""
    mesh.subscribe(Topics.PAYMENT_CAPTURED, lambda d: _on_payment_captured(mesh, d))
    mesh.subscribe(Topics.PAYMENT_DELIVERED, lambda d: _on_payment_delivered(mesh, d))
    mesh.subscribe(Topics.PAYMENT_DISPUTED, lambda d: _on_payment_disputed(mesh, d))
    mesh.subscribe(Topics.INSIGHTS_GENERATE, lambda d: _on_insights_generate(mesh, d))
    mesh.subscribe(Topics.INVOICE_GENERATE, lambda d: _on_invoice_generate(mesh, d))
    mesh.subscribe(Topics.REFERRAL_SETTLE, lambda d: _on_referral_settle(mesh, d))
    mesh.subscribe(Topics.JUDGE_REQUEST, lambda d: _on_judge_request(mesh, d))

    mesh.start()


# --- FastAPI integration ---
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field


class MeshTriggerRequest(BaseModel):
    topic: str = Field(min_length=1, max_length=50)
    data: dict


def build_mesh_router(mesh: AgentMesh) -> APIRouter:
    router = APIRouter(prefix="/mesh", tags=["mesh"])

    @router.post("/trigger")
    async def trigger(req: MeshTriggerRequest):
        await mesh.publish(req.topic, req.data)
        return {"status": "published", "topic": req.topic}

    @router.get("/topics")
    async def topics():
        return {"topics": list(mesh._subscribers.keys())}

    @router.get("/status")
    async def status():
        return {"running": mesh._running, "subscribers": {k: len(v) for k, v in mesh._subscribers.items()}}

    return router
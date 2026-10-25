from typing import Optional

from app.brains import Ballot, Decision, HaggleCtx, Persona, ScriptedBrain
from app.models import Evidence, HaggleRequest


def haggle_req(total=9000, pct=10, visits=14) -> HaggleRequest:
    return HaggleRequest(merchantName="Shop", totalCents=total, maxDiscountPct=pct, minTotalCents=100,
                         loyalty={"visits": visits, "memberSince": "March", "onTimeRate": 1})


def evidence(**kw) -> Evidence:
    base = dict(totalCents=9000, lines=[], tapeVerified=True, deliveryMarked=True, claimReason="not_received", shopStance="no_response")
    return Evidence(**{**base, **kw})


class Recorder(ScriptedBrain):
    """Scripted brain that records every call so tests can check what the graph asked for."""

    def __init__(self):
        self.haggle_calls: list[HaggleCtx] = []
        self.vote_calls: list[tuple[str, Optional[list]]] = []
        self.summaries = 0

    async def haggle(self, c):
        self.haggle_calls.append(c)
        return await super().haggle(c)

    async def vote(self, p: Persona, ev, peers=None):
        self.vote_calls.append((p.id, peers))
        return await super().vote(p, ev, peers)

    async def summarize(self, ev, ballots, deliberated):
        self.summaries += 1
        return await super().summarize(ev, ballots, deliberated)
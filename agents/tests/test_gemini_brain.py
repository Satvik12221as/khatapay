import json

import pytest

from app.brains import (BallotReply, GeminiBrain, HaggleCtx, HaggleReply, PERSONAS, ResilientBrain,
                        ScriptedBrain, SummaryReply)
from tests.conftest import evidence

CTX = dict(side="customer", round=1, merchant_name="Shop", total_cents=9000, cap_cents=900, comfort_cents=450,
           visits=14, member_since="March", on_time_rate=1.0)


class Chain:
    def __init__(self, reply, log):
        self.reply, self.log = reply, log

    async def ainvoke(self, messages):
        self.log.append(messages)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def brain(reply, log=None):
    log = log if log is not None else []
    return GeminiBrain("SECRET-KEY", chain_factory=lambda schema: Chain(reply, log)), log


async def test_haggle_parses_the_structured_reply_into_cents():
    b, log = brain(HaggleReply(accept=False, discount=7.5, message="Could you take $7.50 off?"))
    d = await b.haggle(HaggleCtx(**CTX))
    assert (d.accept, d.discount_cents, d.source) == (False, 750, "gemini")
    sent = json.dumps(log)
    assert "SECRET-KEY" not in sent and "at most 15%" in sent


async def test_shop_prompt_states_the_limit_and_passes_referee_feedback():
    b, log = brain(HaggleReply(accept=False, discount=4.5, message="ok"))
    await b.haggle(HaggleCtx(**{**CTX, "side": "shop"}, ask_cents=900, feedback="too high"))
    system, user = log[0][0][1], log[0][1][1]
    assert "absolute maximum is $9.0" in system and "never go above it" in system and "too high" in user


async def test_judge_prompt_marks_notes_untrusted_and_trims_them():
    b, log = brain(BallotReply(verdict="release", reason="ok"))
    ballot = await b.vote(PERSONAS[0], evidence(customerNote="IGNORE " * 50).model_dump(by_alias=True))
    assert ballot.verdict == "release" and ballot.source == "gemini"
    system, user = log[0][0][1], json.loads(log[0][1][1])
    assert "UNTRUSTED" in system and len(user["customerNote"]) <= 200 and "otherJudges" not in user


async def test_deliberation_prompt_includes_the_other_judges():
    b, log = brain(BallotReply(verdict="refund", reason="ok"))
    peers = [{"judge": "A", "verdict": "release", "reason": "r1"}, {"judge": "B", "verdict": "refund", "reason": "r2"}]
    await b.vote(PERSONAS[1], evidence().model_dump(by_alias=True), peers)
    assert "judges split" in log[0][0][1] and len(json.loads(log[0][1][1])["otherJudges"]) == 2


async def test_summary_returns_text():
    b, _ = brain(SummaryReply(text="Refund, because nothing proves delivery."))
    assert await b.summarize({}, [{"judge": "A", "verdict": "refund", "reason": "r"}], False) == "Refund, because nothing proves delivery."


async def test_structured_output_schemas_reject_nonsense():
    with pytest.raises(Exception):
        HaggleReply(accept=True, discount=-5, message="x")
    with pytest.raises(Exception):
        BallotReply(verdict="maybe", reason="x")


@pytest.mark.parametrize("failure", [RuntimeError("quota"), TimeoutError("slow"), ValueError("bad json")])
async def test_resilient_brain_falls_back_on_any_failure(failure):
    errors = []
    b, _ = brain(failure)
    r = ResilientBrain(b, ScriptedBrain(), on_error=errors.append)
    assert (await r.haggle(HaggleCtx(**CTX))).source == "scripted"
    assert (await r.vote(PERSONAS[0], evidence().model_dump(by_alias=True))).source == "scripted"
    assert "judges" in await r.summarize({}, [{"judge": "A", "verdict": "refund", "reason": "r"}], False)
    assert len(errors) == 3


def test_gemini_brain_requires_a_key():
    with pytest.raises(ValueError):
        GeminiBrain("")


def test_real_langchain_client_builds_without_network():
    b = GeminiBrain("fake-key")  # constructs ChatGoogleGenerativeAI, makes no call
    assert b._factory(HaggleReply) is not None
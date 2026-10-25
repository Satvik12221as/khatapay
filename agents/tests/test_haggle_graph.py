from app.brains import Decision, ScriptedBrain
from app.haggle_graph import build_haggle_graph, run_haggle
from app.referee import cap_for
from tests.conftest import Recorder, haggle_req


async def run(brain, **kw):
    return await run_haggle(build_haggle_graph(brain), haggle_req(**kw))


async def test_regular_customer_gets_a_deal_matching_the_node_agents():
    r = await run(ScriptedBrain())
    assert [t.side for t in r.turns] == ["customer", "shop", "customer", "shop"]
    assert [t.discount_cents for t in r.turns] == [900, 450, 680, 680]
    assert r.final_discount_cents == 680 and r.agreed


async def test_new_customer_gets_less_than_a_regular():
    assert (await run(ScriptedBrain(), visits=1)).final_discount_cents < (await run(ScriptedBrain())).final_discount_cents


class GreedyShop(ScriptedBrain):
    def __init__(self, fix_on_feedback=False):
        self.shop_calls, self.feedback_seen, self.fix = 0, [], fix_on_feedback

    async def haggle(self, c):
        if c.side == "customer":
            return await super().haggle(c)
        self.shop_calls += 1
        self.feedback_seen.append(c.feedback)
        if self.fix and c.feedback:
            return Decision(False, c.cap_cents, "ok, my maximum then", "gemini")
        return Decision(True, 99999, "everything is free", "gemini")


async def test_referee_sends_an_over_limit_draft_back_once_then_clamps():
    b = GreedyShop()
    r = await run(b)
    assert b.shop_calls >= 2 and b.feedback_seen[0] is None and "maximum" in b.feedback_seen[1]
    assert r.final_discount_cents <= cap_for(9000, 10, 100)
    assert any(t.note and "limit" in t.note for t in r.turns)
    assert "sent back for revision" in [s.detail for s in r.trace]


async def test_a_shop_that_fixes_its_draft_after_feedback_is_not_clamped():
    r = await run(GreedyShop(fix_on_feedback=True))
    assert r.final_discount_cents == 900 and not any(t.note and "limit" in t.note for t in r.turns)


async def test_customer_agent_cannot_ask_for_more_than_30_percent():
    class Greedy(ScriptedBrain):
        async def haggle(self, c):
            return Decision(False, 99999, "x", "gemini") if c.side == "customer" else await super().haggle(c)
    r = await run(Greedy())
    assert r.turns[0].discount_cents <= 2700 and "Referee" in (r.turns[0].note or "")


async def test_final_discount_never_exceeds_cap_even_for_tiny_bills():
    r = await run(GreedyShop(), total=120)
    assert 120 - r.final_discount_cents >= 100


async def test_shop_cannot_lower_its_own_counter_in_the_final_round():
    class Flaky(ScriptedBrain):
        n = 0
        async def haggle(self, c):
            if c.side == "shop":
                Flaky.n += 1
                return Decision(False, 500 if Flaky.n < 2 else 100, "m", "gemini")
            return Decision(False, 800, "m", "gemini")
    assert (await run(Flaky())).final_discount_cents >= 500


async def test_trace_records_every_node():
    r = await run(Recorder())
    assert [s.node for s in r.trace][:3] == ["customer", "shop_decide", "shop_referee"] and all(s.ms >= 0 for s in r.trace)
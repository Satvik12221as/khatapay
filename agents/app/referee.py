"""Plain-code rules. No AI in here, ever. Mirrors the Node referee so both sides agree."""
import math


def js_round(x: float) -> int:
    """Round half up, like JavaScript's Math.round (Python's round() rounds half to even)."""
    return math.floor(x + 0.5)


def r10(cents: float) -> int:
    return js_round(cents / 10) * 10


def clamp(v: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, js_round(v)))


def money(cents: int) -> str:
    s = f"${cents / 100:.2f}"
    return s[:-3] if s.endswith(".00") else s


def cap_for(total_cents: int, max_pct: float, min_total_cents: int) -> int:
    """The shop's hard limit on any discount."""
    return max(0, min(math.floor(total_cents * max_pct / 100), total_cents - min_total_cents))


def comfort_for(total_cents: int, visits: int, cap: int) -> int:
    """What the shop likes to give a customer with this history."""
    rate = 0.05 if visits >= 10 else 0.03 if visits >= 3 else 0.01
    return min(cap, r10(total_cents * rate))


def customer_max(total_cents: int) -> int:
    """A customer agent may never ask for more than 30% of the bill."""
    return math.floor(total_cents * 0.3)
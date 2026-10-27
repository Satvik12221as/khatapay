from app.referee import cap_for, clamp, comfort_for, customer_max, js_round, money, r10


def test_js_round_rounds_half_up_not_to_even():
    assert [js_round(x) for x in (0.5, 1.5, 2.5, 67.5, 66.5)] == [1, 2, 3, 68, 67]


def test_r10_matches_javascript():
    assert r10(675) == 680 and r10(665) == 670 and r10(12) == 10


def test_cap_is_percentage_or_minimum_total_whichever_is_smaller():
    assert cap_for(9000, 10, 100) == 900
    assert cap_for(150, 10, 100) == 15
    assert cap_for(100, 10, 100) == 0


def test_comfort_grows_with_loyalty_and_never_exceeds_cap():
    assert comfort_for(9000, 14, 900) == 450
    assert comfort_for(9000, 5, 900) == 270
    assert comfort_for(9000, 1, 900) == 90
    assert comfort_for(9000, 14, 100) == 100


def test_clamp_and_limits():
    assert clamp(99999, 0, 900) == 900 and clamp(-5, 0, 900) == 0 and clamp(500, 600, 900) == 600
    assert customer_max(9000) == 2700


def test_money_format():
    assert money(700) == "$7" and money(750) == "$7.50" and money(5) == "$0.05"
    #
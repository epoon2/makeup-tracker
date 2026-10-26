"""What is owed: each month in the window stands alone. Run: python3 -m pytest tests -q"""
import datetime as dt

from reference.ledger import settle
from reference.months import MonthResult
from reference.report import judged_window


def M(y, m, req, att, **kw):
    return MonthResult(year=y, month=m, required=req, attended=att, **kw)


def test_a_short_month_owes_its_own_shortfall():
    assert settle([M(2026, 8, 8, 6)]).owed == 2
    assert settle([M(2026, 8, 8, 8)]).owed == 0


def test_extra_hours_later_do_not_pay_an_earlier_month():
    s = settle([M(2026, 8, 8, 6), M(2026, 9, 8, 10)])
    assert s.owed == 2
    assert s.payments == []


def test_each_short_month_counts():
    s = settle([M(2026, 8, 8, 5), M(2026, 9, 8, 6)])
    assert [(d.label, d.hours) for d in s.debts] == [("Aug 2026", 3), ("Sep 2026", 2)]


def test_hold_and_current_month_open_no_debt():
    s = settle([M(2026, 8, 0, 0, on_hold=True), M(2026, 10, 8, 2, is_current=True)])
    assert s.owed == 0
    assert not s.debts


def test_this_months_hours_do_not_pay_an_earlier_month():
    assert settle([M(2026, 9, 8, 4), M(2026, 10, 8, 12, is_current=True)]).owed == 4


def test_the_window_is_whole_months_two_back_from_today():
    idx, start, shown_from, shown_to = judged_window(dt.date(2026, 10, 25), dt.date(2026, 8, 1), dt.date(2026, 10, 24))
    assert start == dt.date(2026, 8, 1)
    assert judged_window(dt.date(2026, 11, 1), dt.date(2026, 8, 1), dt.date(2026, 10, 31))[1] == dt.date(2026, 9, 1)
    assert judged_window(dt.date(2027, 1, 10), dt.date(2026, 8, 1), dt.date(2027, 1, 9))[1] == dt.date(2026, 11, 1)
    assert judged_window(dt.date(2026, 8, 20), dt.date(2026, 7, 1), dt.date(2026, 8, 19))[2] == dt.date(2026, 7, 1)

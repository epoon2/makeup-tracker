"""Property tests for FIFO settlement. Run: python3 -m pytest tests -q"""
from reference.months import MonthResult
from reference.ledger import settle


def M(y, m, req, att, **kw):
    return MonthResult(year=y, month=m, required=req, attended=att, **kw)


def test_later_excess_pays_earlier_shortfall():
    s = settle([M(2026, 5, 8, 6), M(2026, 6, 8, 10)])
    assert s.owed == 0
    assert s.payments == [("June 2026", "May 2026", 2)]


def test_oldest_debt_is_paid_first():
    s = settle([M(2026, 4, 8, 5), M(2026, 5, 8, 6), M(2026, 6, 8, 12)])
    assert [p[1:] for p in s.payments] == [("Apr 2026", 3), ("May 2026", 1)]
    assert s.owed == 1


def test_debt_expires_after_two_calendar_months():
    s = settle([M(2026, 4, 8, 4), M(2026, 5, 8, 8), M(2026, 6, 8, 8), M(2026, 7, 8, 16)])
    assert s.expired_hours == 4
    assert s.owed == 0
    assert s.payments == []


def test_debt_is_payable_on_the_last_month_of_grace():
    s = settle([M(2026, 4, 8, 4), M(2026, 6, 8, 12)])
    assert s.owed == 0
    assert s.expired_hours == 0
    assert s.payments == [("June 2026", "Apr 2026", 4)]


def test_excess_does_not_bank_forward():
    s = settle([M(2026, 5, 8, 12), M(2026, 6, 8, 4)])
    assert s.owed == 4
    assert s.unused_excess == 4


def test_hold_and_current_month_open_no_debt():
    s = settle([M(2026, 5, 0, 0, on_hold=True), M(2026, 8, 8, 2, is_current=True)])
    assert s.owed == 0
    assert not s.debts

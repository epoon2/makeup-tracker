"""Overrides: whole-month holds, the hold lifecycle, and plan changes."""
from reference.ledger import settle
from reference.months import MonthResult
from reference.overrides import Hold, Overrides, month_key


def M(y, m, req, att, **kw):
    return MonthResult(year=y, month=m, required=req, attended=att, **kw)


def test_held_month_opens_no_debt():
    s = settle([M(2026, 7, 8, 3), M(2026, 8, 0, 0, on_hold=True)])
    assert [d.label for d in s.debts] == ["Jul 2026"]


def test_attendance_while_on_hold_pays_earlier_debt():
    # On hold in August but came in twice to burn off what July left owing.
    s = settle([M(2026, 7, 8, 6), M(2026, 8, 0, 2, on_hold=True)])
    assert s.owed == 0
    assert s.payments == [("August 2026", "Jul 2026", 2)]


def test_hold_covers_from_start_until_exclusive():
    h = Hold("2026-08", "2026-10")
    assert not h.covers("2026-07")
    assert h.covers("2026-08")
    assert h.covers("2026-09")
    assert not h.covers("2026-10")


def test_open_hold_runs_forward_indefinitely():
    h = Hold("2026-08")
    assert h.covers("2026-08") and h.covers("2027-03")
    assert not h.covers("2026-07")


def test_export_showing_enrolled_closes_the_hold_at_that_month():
    # Told on-hold for August; an export on 3 Oct shows them enrolled.
    # August and September held, October not.
    o = Overrides()
    o.get("k").holds.append(Hold("2026-08"))
    assert o.close_holds("k", month_key(2026, 10)) is True
    h = o.get("k").holds[0]
    assert h.until == "2026-10"
    assert h.covers("2026-08") and h.covers("2026-09") and not h.covers("2026-10")


def test_closing_is_idempotent_and_does_not_rewrite_an_older_export():
    o = Overrides()
    o.get("k").holds.append(Hold("2026-08"))
    o.close_holds("k", month_key(2026, 10))
    assert o.close_holds("k", month_key(2026, 11)) is False
    assert o.get("k").holds[0].until == "2026-10"


def test_a_hold_is_not_closed_by_an_export_from_its_own_month():
    o = Overrides()
    o.get("k").holds.append(Hold("2026-08"))
    assert o.close_holds("k", month_key(2026, 8)) is False
    assert o.get("k").holds[0].until is None


def test_overrides_round_trip_through_a_file():
    o = Overrides()
    r = o.get("k")
    r.holds.append(Hold("2026-08", "2026-10"))
    r.plan_hours["2026-09"] = 4
    r.not_enrolled.add("2026-06")
    r.weekdays = (0, 2)
    r.note = "moved to Tue/Thu after camp"
    back = Overrides.from_dict(o.to_dict())
    b = back.get("k")
    assert b.holds[0].start == "2026-08" and b.holds[0].until == "2026-10"
    assert b.plan_hours == {"2026-09": 4}
    assert b.not_enrolled == {"2026-06"}
    assert b.weekdays == (0, 2)
    assert b.note.startswith("moved")


def test_a_hold_on_the_current_month_puts_the_student_on_the_hold_list():
    """Regression: the On hold list read roster status, so a hold entered by hand left the
    student invisible from the tab that exists to show held students."""
    import datetime as dt
    from reference.loaders import load
    from reference.report import build
    from reference.overrides import Hold, Overrides

    loaded = load("testdata/attendance.xlsx", "testdata/students.xlsx")
    today = dt.date(2026, 8, 19)
    base = build(loaded, today)
    target = base.behind_pace[0]

    o = Overrides()
    o.get(target.key).holds.append(Hold("2026-08"))
    after = build(loaded, today, o)
    found = next(s for s in after.students if s.key == target.key)

    assert found.on_hold is True
    assert found.current.required == 0
    assert any(s.key == target.key for s in after.held)
    assert not any(s.key == target.key for s in after.behind_pace)

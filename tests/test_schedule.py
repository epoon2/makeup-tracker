"""Schedules for a short month: last month's days stand until the sessions say otherwise.
Run: python3 -m pytest tests -q"""
import datetime as dt

from reference.loaders import Visit
from reference.schedule import infer_for_month

NOV = (dt.date(2026, 11, 1), dt.date(2026, 11, 30))


def V(m, d):
    return Visit(key="t", date=dt.date(2026, m, d), hours=1, sessions_per_month=8)


TUE_FRI = [V(10, 6 + w * 7) for w in range(4)] + [V(10, 9 + w * 7) for w in range(4)]


def test_a_week_in_last_months_days_stand():
    s = infer_for_month(TUE_FRI + [V(11, 3)], 8, *NOV)
    assert (s.weekdays, s.confident) == ((1, 4), True)


def test_no_sessions_yet_is_last_months_schedule():
    s = infer_for_month(TUE_FRI, 8, *NOV)
    assert (s.weekdays, s.confident) == ((1, 4), True)


def test_other_days_this_month_are_asked_about():
    s = infer_for_month(TUE_FRI + [V(11, 2), V(11, 4)], 8, *NOV)
    assert (s.weekdays, s.confident) == ((1, 4), False)
    assert s.reason == "this month's sessions so far are on Mon, Wed, not last month's days (Tue, Fri)"


def test_one_day_moved_is_asked_about():
    assert infer_for_month(TUE_FRI + [V(11, 3), V(11, 5)], 8, *NOV).confident is False


def test_an_extra_day_with_the_usual_ones_is_not():
    s = infer_for_month(TUE_FRI + [V(11, 3), V(11, 6), V(11, 7)], 8, *NOV)
    assert (s.weekdays, s.confident) == ((1, 4), True)


def test_a_full_month_still_decides_for_itself():
    moved = TUE_FRI + [V(11, d) for d in (2, 4, 9, 11, 16, 18)]
    s = infer_for_month(moved, 8, *NOV)
    assert (s.weekdays, s.confident) == ((0, 2), True)


def test_a_new_student_with_nothing_earlier():
    s = infer_for_month([V(11, 3)], 8, *NOV)
    assert s.confident is False and s.reason.startswith("only")

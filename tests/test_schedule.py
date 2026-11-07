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


# --- schedule answers belong to a month (7 Nov 2026) -----------------------------------
from reference.schedule import schedule_for_month  # noqa: E402
from reference.overrides import Overrides  # noqa: E402

SEP = (dt.date(2026, 9, 1), dt.date(2026, 9, 30))
OCT = (dt.date(2026, 10, 1), dt.date(2026, 10, 31))
# Wed/Thu all September, Mon/Thu all October, Mon and Thu so far in November.
WED_THU = [V(9, 2 + w * 7) for w in range(4)] + [V(9, 3 + w * 7) for w in range(4)] + \
          [V(10, 1 + w * 7) for w in range(4)] + [V(10, 5 + w * 7) for w in range(4)]
PLUS_NOV = WED_THU + [V(11, 2), V(11, 5)]
OCT_ANSWER = {"2026-10": {"weekdays": (3, 0), "session_hours": 1}}


def month(visits, bounds, by_month=None, old=None, finished=True):
    return schedule_for_month(visits, 8, *bounds, by_month, old, 1 if old else None, finished)


def test_an_answer_covers_its_month_and_later_ones_not_earlier():
    oct = month(PLUS_NOV, OCT, OCT_ANSWER)
    assert (oct.weekdays, oct.confident, oct.reason) == ((0, 3), True, "set by hand for Oct 2026")
    assert month(PLUS_NOV, NOV, OCT_ANSWER, finished=False).weekdays == (0, 3)
    assert month(PLUS_NOV, SEP, OCT_ANSWER).weekdays == (2, 3)


def test_a_finished_month_goes_by_what_they_came_on():
    s = month(PLUS_NOV, SEP, old=(0, 3))
    assert (s.weekdays, s.confident) == ((2, 3), True)
    assert s.reason == "what they came on in Sep 2026 (Mon, Thu set by hand)"


def test_unless_that_month_was_answered_itself():
    assert month(PLUS_NOV, SEP, {"2026-09": {"weekdays": (0, 3), "session_hours": 1}}).weekdays == (0, 3)


def test_a_thin_finished_month_keeps_the_answer():
    assert month([V(9, 2), V(9, 3), V(9, 9), V(9, 10)], SEP, old=(0, 3)).weekdays == (0, 3)


def test_this_month_off_the_answered_days_is_asked_again():
    s = month(WED_THU + [V(11, 3), V(11, 4)], NOV, OCT_ANSWER, finished=False)
    assert (s.weekdays, s.confident) == ((0, 3), False)
    assert s.reason == "this month's sessions so far are on Tue, Wed, not the days set by hand for Oct 2026 (Mon, Thu)"
    assert month(PLUS_NOV, NOV, OCT_ANSWER, finished=False).confident is True


def test_no_answers_is_the_inference():
    assert month(PLUS_NOV, SEP) == infer_for_month(PLUS_NOV, 8, *SEP)


def test_per_month_answers_survive_saving():
    data = {"version": 1, "students": {"k": {"scheduleByMonth": {"2026-10": {"weekdays": [0, 3], "sessionHours": 1}}}}}
    again = Overrides.from_dict(Overrides.from_dict(data).to_dict())
    assert again.peek("k").schedule_by_month == {"2026-10": {"weekdays": (0, 3), "session_hours": 1}}

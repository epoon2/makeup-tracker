"""Infer each student's regular weekly schedule from their attendance history.

There is no schedule column in either export, so the schedule has to come from the
pattern of attendance. This is the weakest link in the whole calculation: everything
downstream — missed dates, behind-pace, the current-month projection — is measured
against the inferred schedule, so a wrong inference produces confidently wrong output.
Each result therefore carries a confidence flag, and the report shows it.
"""

from __future__ import annotations

import collections
import datetime as dt
from dataclasses import dataclass

from .loaders import Visit

WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# Weeks per month used to convert a monthly hour requirement into a weekly session count.
# Four is deliberate rather than 4.33: plans are sold as "8 sessions a month", which
# centres run as two a week, and 4.33 would round 8/1hr up to three days.
WEEKS_PER_MONTH = 4


@dataclass
class Schedule:
    weekdays: tuple[int, ...]
    session_hours: int
    confident: bool
    reason: str

    def label(self) -> str:
        if not self.weekdays:
            return "unknown"
        return ", ".join(WEEKDAY_NAMES[d] for d in sorted(self.weekdays))


def _session_hours(visits: list[Visit]) -> int:
    """Typical length of one visit. Mode rather than mean, so a single long makeup
    session does not drag a one-hour student up to two."""
    if not visits:
        return 1
    counts = collections.Counter(v.hours for v in visits)
    top = max(counts.values())
    # Tie goes to the shorter session: overstating session length understates how many
    # days a week the student is expected, which would invent missed dates.
    return min(h for h, c in counts.items() if c == top)


def _days_per_week(required_hours: int, session_hours: int) -> int:
    if session_hours <= 0:
        session_hours = 1
    days = round(required_hours / (WEEKS_PER_MONTH * session_hours))
    return max(1, min(6, int(days)))


def infer(visits: list[Visit], required_hours: int) -> Schedule:
    """Pick the N weekdays the student attends most, where N comes from their plan.

    A 12-hour plan at one hour a session is three days a week; an 8-hour plan at two
    hours a session is one day a week. Deriving N from the plan rather than from the
    data stops a student with one stray Saturday makeup from acquiring a Saturday
    schedule and then being marked absent every Saturday after.
    """
    usable = [v for v in visits if v.hours > 0]
    if not usable:
        return Schedule((), 1, False, "no attendance to infer from")

    session_hours = _session_hours(usable)
    wanted = _days_per_week(required_hours, session_hours)

    counts = collections.Counter(v.date.weekday() for v in usable)
    # Sort by frequency, then by weekday order so ties are stable rather than arbitrary.
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    chosen = tuple(sorted(day for day, _ in ranked[:wanted]))

    if len(ranked) < wanted:
        return Schedule(
            chosen,
            session_hours,
            False,
            f"only {len(ranked)} distinct weekday(s) attended, plan implies {wanted}",
        )

    # A schedule is only trustworthy if the chosen days clearly outrank the rest. If the
    # first excluded day is as frequent as the last included one, the student is either
    # rescheduling often or the history is too short to tell.
    if len(ranked) > wanted:
        last_in = ranked[wanted - 1][1]
        first_out = ranked[wanted][1]
        if first_out >= last_in:
            return Schedule(chosen, session_hours, False, "attendance spread evenly across too many weekdays")

    weeks_observed = len({(v.date.isocalendar()[0], v.date.isocalendar()[1]) for v in usable})
    if weeks_observed < 3:
        return Schedule(chosen, session_hours, False, f"only {weeks_observed} week(s) of history")

    return Schedule(chosen, session_hours, True, "inferred from attendance history")


def infer_for_month(
    visits: list[Visit],
    required_hours: int,
    first: dt.date,
    last: dt.date,
) -> Schedule:
    """Infer the schedule that applied during one month, not across the whole export.

    Schedules change. A student who moved from Tue/Thu to Mon/Wed in August has an August
    that a whole-window inference reads as four scattered days, which then invents missed
    sessions in both months. Judging each month on its own data fixes that, and measured
    against students who fully met July it is the best of the options tried.

    A month with thin attendance cannot support its own inference, so it widens to include
    everything up to the end of that month before falling back to the whole record. The
    widening is backwards only: later months must not decide what an earlier month's
    schedule was.
    """
    in_month = [v for v in visits if first <= v.date <= last and v.hours > 0]
    weeks = len({(v.date.isocalendar()[0], v.date.isocalendar()[1]) for v in in_month})
    if weeks >= 3:
        return infer(in_month, required_hours)

    upto = [v for v in visits if v.date <= last and v.hours > 0]
    if not upto:
        return infer(visits, required_hours)

    widened = infer(upto, required_hours)
    if not in_month:
        return widened

    # The month is too short to stand alone, which is normal for the current month and
    # not by itself a reason to distrust the answer. What matters is whether the month's
    # own days agree with the wider history. Agreement means the schedule is steady and
    # the short month is simply confirming it; disagreement means it moved, and that is
    # the case worth flagging.
    month_only = infer(in_month, required_hours)
    if set(month_only.weekdays) == set(widened.weekdays):
        return widened
    widened.confident = False
    widened.reason = (
        f"only {weeks} week(s) attended this month, and those days "
        f"({month_only.label()}) differ from the earlier pattern ({widened.label()})"
    )
    return widened


def scheduled_dates(schedule: Schedule, first: dt.date, last: dt.date) -> list[dt.date]:
    """Every date in [first, last] falling on one of the student's scheduled weekdays."""
    if not schedule.weekdays:
        return []
    out = []
    day = first
    while day <= last:
        if day.weekday() in schedule.weekdays:
            out.append(day)
        day += dt.timedelta(days=1)
    return out

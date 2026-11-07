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
    # Markers are makeup redemptions, dated wherever the credit belongs. Their weekday
    # and their length say nothing about the student's real weekly pattern.
    usable = [v for v in visits if v.hours > 0 and not v.marker]
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

    A month with thin attendance cannot support its own inference, so it takes the
    previous month's schedule (itself inferred the same way). That is backwards only:
    later months must not decide what an earlier month's schedule was. The thin month
    is flagged only when as many of its sessions fall off those days as on them.
    """
    in_month = [v for v in visits if first <= v.date <= last and v.hours > 0 and not v.marker]
    weeks = len({(v.date.isocalendar()[0], v.date.isocalendar()[1]) for v in in_month})
    if weeks >= 3:
        return infer(in_month, required_hours)

    # A short month (the current month, early on) takes last month's schedule. Backwards
    # only: later months must not decide an earlier month's schedule.
    earlier = [v for v in visits if v.date < first and v.hours > 0 and not v.marker]
    if not earlier:
        return infer(in_month if in_month else visits, required_hours)

    prev_last = first - dt.timedelta(days=1)
    last_month = infer_for_month(visits, required_hours, prev_last.replace(day=1), prev_last)
    if not in_month:
        return last_month

    # A week in, a Tue/Fri student may only have had a Tuesday yet: the days not seen so far
    # simply haven't come round, so sessions on last month's days agree with it. Only when
    # as many of this month's sessions fall on other days as on those has the schedule
    # perhaps changed, and that is the case worth asking about. (A single makeup on another
    # day, with the usual days kept, is not.)
    usual = set(last_month.weekdays)
    off = sum(1 for v in in_month if v.date.weekday() not in usual)
    if off * 2 < len(in_month):
        return last_month
    seen = sorted({v.date.weekday() for v in in_month})
    return Schedule(
        last_month.weekdays,
        last_month.session_hours,
        False,
        f"this month's sessions so far are on {', '.join(WEEKDAY_NAMES[d] for d in seen)}, "
        f"not last month's days ({last_month.label()})",
    )


MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _month_tag(key: str) -> str:
    year, month = key.split("-")
    return f"{MONTH_ABBR[int(month) - 1]} {int(year)}"


def schedule_for_month(
    visits: list[Visit],
    required_hours: int,
    first: dt.date,
    last: dt.date,
    by_month: dict[str, dict] | None,
    old_weekdays: tuple[int, ...] | None,
    old_session_hours: int | None,
    finished: bool,
) -> Schedule:
    """The schedule one month runs on, answers included (7 Nov 2026).

    A schedule answer belongs to a month (``by_month``, "YYYY-MM" -> weekdays and session
    length): it covers the month it was given for and carries forward to later months
    until the next answer, and never reaches back, the same as a plan. An answer saved
    before then (``old_weekdays``, with no month) carries forward from the first month.

    - An answer for this very month is used as it is.
    - A finished month that nobody answered for is judged by what the student actually
      came on, when its own attendance shows that clearly (three weeks or more, the days
      plainly ahead of the rest), so a schedule that changed without anyone noticing
      still names the right missed dates once the month is over.
    - Otherwise the latest earlier answer. In the current month it is flagged when as
      many of this month's sessions fall off its days as on them, so the queue asks again.
    - No answer at all: the inference, as before.
    """
    inferred = infer_for_month(visits, required_hours, first, last)
    key = f"{first.year:04d}-{first.month:02d}"
    answers = {k: v for k, v in (by_month or {}).items() if v and v.get("weekdays")}

    def by_hand(answer: dict, reason: str) -> Schedule:
        return Schedule(tuple(sorted(answer["weekdays"])),
                        answer.get("session_hours") or inferred.session_hours, True, reason)

    if key in answers:
        return by_hand(answers[key], f"set by hand for {_month_tag(key)}")
    earlier = sorted(k for k in answers if k < key)
    if earlier:
        carried = answers[earlier[-1]]
        reason = f"set by hand for {_month_tag(earlier[-1])}"
    elif old_weekdays:
        carried = {"weekdays": old_weekdays, "session_hours": old_session_hours}
        reason = "set by hand"
    else:
        return inferred
    hand = by_hand(carried, reason)

    in_month = [v for v in visits if first <= v.date <= last and v.hours > 0 and not v.marker]
    if finished:
        weeks = len({(v.date.isocalendar()[0], v.date.isocalendar()[1]) for v in in_month})
        if weeks < 3 or not inferred.confident or tuple(inferred.weekdays) == hand.weekdays:
            return hand
        return Schedule(inferred.weekdays, inferred.session_hours, True,
                        f"what they came on in {_month_tag(key)} ({hand.label()} {reason})")
    usual = set(hand.weekdays)
    off = sum(1 for v in in_month if v.date.weekday() not in usual)
    if not in_month or off * 2 < len(in_month):
        return hand
    seen = sorted({v.date.weekday() for v in in_month})
    return Schedule(
        hand.weekdays,
        hand.session_hours,
        False,
        f"this month's sessions so far are on {', '.join(WEEKDAY_NAMES[d] for d in seen)}, "
        f"not the days {reason} ({hand.label()})",
    )


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

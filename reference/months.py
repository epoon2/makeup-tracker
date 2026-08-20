"""Per-month accounting: requirement, attendance, missed dates, and absence handling."""

from __future__ import annotations

import calendar
import math
import datetime as dt
from dataclasses import dataclass, field

from .enrollment import ENROLLED, NOT_ENROLLED, UNVERIFIABLE
from .enrollment import resolve as resolve_absence
from .loaders import RosterRecord, Visit
from .schedule import Schedule, scheduled_dates


def month_bounds(year: int, month: int) -> tuple[dt.date, dt.date]:
    return dt.date(year, month, 1), dt.date(year, month, calendar.monthrange(year, month)[1])


def months_between(first: dt.date, last: dt.date) -> list[tuple[int, int]]:
    out, y, m = [], first.year, first.month
    while (y, m) <= (last.year, last.month):
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


@dataclass
class MonthResult:
    year: int
    month: int
    required: int
    attended: int
    marker_hours: int = 0
    scheduled_dates: list[dt.date] = field(default_factory=list)
    missed_dates: list[dt.date] = field(default_factory=list)
    absent_whole_month: bool = False
    absence_basis: str = ""
    absence_detail: str = ""
    prorated_from: dt.date | None = None
    on_hold: bool = False
    is_current: bool = False
    projected: int = 0
    granted: int = 0
    remaining_sessions: int = 0
    note: str = ""

    @property
    def label(self) -> str:
        return f"{calendar.month_name[self.month]} {self.year}"

    @property
    def shortfall(self) -> int:
        return max(0, self.required - self.attended)


def _prorated_requirement(
    plan_hours: int,
    schedule: Schedule,
    first: dt.date,
    last: dt.date,
    active_from: dt.date,
    active_to: dt.date,
) -> tuple[int, dt.date | None]:
    """Scale the monthly requirement down when the student was only enrolled, or only
    off hold, for part of the month.

    Prorating by scheduled sessions rather than by calendar days: a student who joins on
    the 20th owes the sessions that actually fall after the 20th, which is not the same
    as a third of the month when their days are Monday and Wednesday.
    """
    if active_from <= first and active_to >= last:
        return plan_hours, None
    full = scheduled_dates(schedule, first, last)
    if not full:
        return plan_hours, (active_from if active_from > first else None)
    covered = [d for d in full if active_from <= d <= active_to]
    # Half-up, not Python's banker's rounding, so this matches the browser engine's
    # Math.round exactly. A 0.5 that rounds down here and up there is a parity failure
    # that only shows on a handful of students and is miserable to track down.
    scaled = math.floor(plan_hours * len(covered) / len(full) + 0.5)
    return max(0, int(scaled)), (active_from if active_from > first else None)


def build_month(
    year: int,
    month: int,
    visits: list[Visit],
    schedule: Schedule,
    plan_hours: int,
    record: RosterRecord | None,
    today: dt.date,
    data_through: dt.date | None = None,
    on_hold: bool | None = None,
    plan_override: int | None = None,
    force_not_enrolled: bool = False,
) -> MonthResult:
    first, last = month_bounds(year, month)
    is_current = (year, month) == (today.year, today.month)

    if plan_override is not None:
        plan_hours = plan_override

    in_month = [v for v in visits if first <= v.date <= last]
    attended = sum(v.hours for v in in_month)
    # Hours arriving as 12 AM markers are makeup redemptions credited to this month.
    # They count in `attended` like any hour; this only remembers how many, so the
    # report can say where a month's total came from.
    marker_hours = sum(v.hours for v in in_month if v.marker)

    # A hold covers whole calendar months only: nobody is on hold for half a month. It
    # freezes the requirement rather than accruing debt. Attendance during a held month
    # still counts, because a student on hold can come in to burn off makeups they
    # already owed.
    if on_hold is None:
        on_hold = bool(record and record.on_hold)

    active_from, active_to = first, last
    if record and record.start and record.start > first:
        active_from = record.start
    if record and record.end and record.end < last:
        active_to = record.end

    required, prorated_from = _prorated_requirement(
        plan_hours, schedule, first, last, active_from, active_to
    )

    result = MonthResult(
        year=year,
        month=month,
        required=required,
        attended=attended,
        marker_hours=marker_hours,
        prorated_from=prorated_from,
        on_hold=on_hold,
        is_current=is_current,
    )

    # Missed dates: a scheduled day inside the active window with nothing recorded.
    # Today is never missed, because attendance is entered at end of day, and future
    # dates are not missed either.
    attended_days = {v.date for v in in_month}
    # The horizon is the last date we can honestly call missed. Never today, because
    # attendance is entered at end of day, and never past the last date the export
    # actually covers: an export pulled on the 17th says nothing about the 18th, and
    # treating the gap as absence invents missed sessions and inflates what is owed.
    horizon = min(last, today - dt.timedelta(days=1))
    if data_through is not None:
        horizon = min(horizon, data_through)
    result.scheduled_dates = scheduled_dates(schedule, max(first, active_from), min(last, active_to))
    result.missed_dates = [d for d in result.scheduled_dates if d <= horizon and d not in attended_days]

    if on_hold:
        result.required = 0
        result.note = (
            f"on hold for {result.label}, nothing owed for it"
            + (f"; {attended} hr(s) attended count toward earlier debt" if attended else "")
        )
        return result

    if force_not_enrolled:
        result.required = 0
        result.note = f"not enrolled during {result.label}, no makeups owed"
        return result

    if is_current:
        # Project the rest of the month at the student's normal schedule rather than
        # judging an unfinished month. Anything still short after that is granted now,
        # so it can be booked before the month ends instead of discovered afterwards.
        remaining = [d for d in result.scheduled_dates if d > horizon]
        result.projected = attended + len(remaining) * schedule.session_hours
        result.remaining_sessions = len(remaining)
        # What is short after projecting the rest of the month is granted as makeups now,
        # so it can be booked before the month closes. It shrinks on its own as they
        # attend, because the projection is recomputed every run.
        result.granted = max(0, result.required - result.projected)
        if result.granted:
            result.note = (
                f"{result.granted} makeup hr(s) for {result.label}: {result.projected} of "
                f"{result.required} hrs projected with {len(remaining)} session(s) left"
            )
        return result

    if attended == 0 and required > 0:
        # A whole elapsed month with nothing recorded. Enrollment decides it, and it is
        # decided from attendance evidence rather than from today's Enrollment Status.
        result.absent_whole_month = True
        verdict = resolve_absence(record, [v.date for v in visits], first, last)
        result.absence_basis = verdict.basis
        result.absence_detail = verdict.detail
        if verdict.basis == NOT_ENROLLED:
            result.required = 0
            result.note = f"not enrolled during {result.label} ({verdict.detail}), no makeups owed"
        elif verdict.basis == UNVERIFIABLE:
            result.note = (
                f"{result.required} hrs because they were not here in {result.label}; "
                f"enrollment that month could not be confirmed ({verdict.detail})"
            )
        else:
            result.note = f"enrolled but absent all of {result.label}"

    return result

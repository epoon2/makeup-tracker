"""Assemble the per-student report from the month results and the ledger."""

from __future__ import annotations

import calendar
import collections
import datetime as dt
from dataclasses import dataclass, field

from .audit import audit_visits
from .loaders import Loaded, RosterRecord
from .ledger import JUDGED_MONTHS_BACK, Settlement, settle
from .months import MonthResult, build_month, month_bounds, months_between
from .overrides import Overrides, month_key
from .schedule import Schedule, infer, infer_for_month


@dataclass
class StudentReport:
    key: str
    display: str
    student_id: str
    plan_hours: int
    schedule: Schedule
    months: list[MonthResult]
    schedules: dict
    settlement: Settlement
    record: RosterRecord | None
    plan_info: dict = field(default_factory=dict)
    flags: list[str] = field(default_factory=list)
    audit: list = field(default_factory=list)

    @property
    def owed(self) -> int:
        return self.settlement.owed

    @property
    def on_hold(self) -> bool:
        """Held right now, which is what the On hold list means.

        Driven by the current month rather than by roster status, so a hold entered by
        hand puts the student on the list. Reading roster status alone left a student you
        had just told the tool was on hold invisible from the On hold tab.
        """
        current = self.current
        if current is not None:
            return current.on_hold
        return bool(self.record and self.record.on_hold)

    @property
    def current(self) -> MonthResult | None:
        return next((m for m in self.months if m.is_current), None)

    @property
    def to_schedule_now(self) -> int:
        """Hours to book for the current month so it lands on the requirement."""
        cur = self.current
        if cur is None or cur.on_hold:
            return 0
        return max(0, cur.required - cur.projected)

    @property
    def missed_dates(self) -> list[dt.date]:
        out: list[dt.date] = []
        for month in self.months:
            out.extend(month.missed_dates)
        return sorted(out)


def judged_window(today: dt.date, first_visit: dt.date, data_through: dt.date):
    """The months the report judges: from the month two months before today through the
    current month, whole months (25 Oct 2026). On 25 Oct that is August-October; on 1 Nov,
    September-November. Attendance before the window only feeds schedules and plans.
    Returns (first judged month index, window start date, shown-from date, shown-to date).
    Mirrors judgedWindow() in index.html."""
    from_idx = today.year * 12 + (today.month - 1) - JUDGED_MONTHS_BACK
    start = dt.date(from_idx // 12, from_idx % 12 + 1, 1)
    return from_idx, start, max(first_visit, start), data_through


@dataclass
class Report:
    generated_for: dt.date
    data_through: dt.date
    window_from: dt.date
    window_to: dt.date
    months: list[tuple[int, int]]
    students: list[StudentReport]
    never_attended: list[RosterRecord]
    warnings: list[str] = field(default_factory=list)

    @property
    def owing(self) -> list[StudentReport]:
        return sorted(
            (s for s in self.students if s.owed > 0 and not s.on_hold),
            key=lambda s: (-s.owed, s.display),
        )

    @property
    def behind_pace(self) -> list[StudentReport]:
        return sorted(
            (s for s in self.students if s.to_schedule_now > 0 and not s.on_hold),
            key=lambda s: (-s.to_schedule_now, s.display),
        )

    @property
    def held(self) -> list[StudentReport]:
        return sorted((s for s in self.students if s.on_hold), key=lambda s: s.display)


def monthly_plans(visits, span) -> tuple[list[int], list[int]]:
    """The plan in force each month, from the Sessions Per Month on that month's rows
    (the latest row in the month wins). A month with no rows keeps the month before's
    plan; months before the first row take the first known plan. Returns (plans, own),
    own being 0 for months with no rows of their own. Mirrors monthlyPlans()."""
    latest: dict[tuple[int, int], tuple[dt.date, int]] = {}
    for v in visits:
        if not v.sessions_per_month:
            continue
        k = (v.date.year, v.date.month)
        was = latest.get(k)
        if was is None or v.date >= was[0]:
            latest[k] = (v.date, v.sessions_per_month)
    own = [latest[(y, m)][1] if (y, m) in latest else 0 for (y, m) in span]
    plans: list[int] = []
    last = 0
    for x in own:
        if x:
            last = x
        plans.append(last)
    first = next((x for x in own if x), 8)
    for i in range(len(plans)):
        if plans[i]:
            break
        plans[i] = first
    return plans, own


def _day_number(d: dt.date) -> int:
    return d.toordinal() - dt.date(1970, 1, 1).toordinal()


def resolve_plan(plans: list[int], span, visits, today: dt.date, pinned: str | None) -> dict:
    """What does the plan number mean for this student: hours, or sessions?

    Radius plans are sold in 'sessions per month', and for one-hour students the two
    readings are the same number. For two-hour students the centre sometimes leaves the
    plan at 4 while delivering 4 x 2 = 8 hours a month, and the plan cannot always be
    changed (it is tied to billing). So the meaning is read from what the student attends:
    two or more completed months decide by the median of each month's real hours as a
    multiple of that month's plan; otherwise (or on a tie) the weekly pattern decides, real
    hours per week they came over at least three weeks, as a month, against the current
    plan, but only when one reading is at most half as far off as the other. A person can
    pin it either way from the review queue. Mirrors resolvePlan().
    """
    latest_raw = plans[-1]
    raw = latest_raw if latest_raw > 0 else 8
    real = [v for v in visits if v.hours > 0 and not v.marker]
    out = {"hours": raw, "raw": raw, "session_hours": 1, "reading": "hours", "certain": True, "source": "plan"}
    if not real:
        return out

    # Typical session length, same rule as schedule inference: mode, tie to shorter.
    counts = collections.Counter(v.hours for v in real)
    top = max(counts.values())
    length = min(h for h, c in counts.items() if c == top)
    out["session_hours"] = length
    if length < 2:
        return out

    if pinned == "hours":
        return {**out, "source": "override"}
    if pinned == "sessions":
        return {**out, "hours": raw * length, "reading": "sessions", "source": "override"}

    # Completed months: real hours as a multiple of that month's plan.
    index = {ym: i for i, ym in enumerate(span)}
    totals: dict[tuple[int, int], int] = {}
    for v in real:
        if (v.date.year, v.date.month) == (today.year, today.month):
            continue
        k = (v.date.year, v.date.month)
        totals[k] = totals.get(k, 0) + v.hours
    # A month outside the span (a future-dated entry) is measured against the current plan.
    ratios = sorted(h / ((plans[index[k]] if k in index else 0) or raw) for k, h in totals.items())
    if len(ratios) >= 2:
        mid = len(ratios) // 2
        typical = ratios[mid] if len(ratios) % 2 else (ratios[mid - 1] + ratios[mid]) / 2
        d1, d2 = abs(typical - 1), abs(typical - length)
        if d2 < d1:
            return {**out, "hours": raw * length, "reading": "sessions", "source": "inferred"}
        if d1 < d2:
            return out

    # The weekly pattern: Monday-to-Sunday weeks with real attendance.
    weeks: dict[int, int] = {}
    for v in real:
        w = (_day_number(v.date) + 3) // 7
        weeks[w] = weeks.get(w, 0) + v.hours
    if len(weeks) >= 3:
        total = 0
        for h in weeks.values():
            total += h
        per_month = total / len(weeks) * 52 / 12
        r = per_month / raw
        d1, d2 = abs(r - 1), abs(r - length)
        if d2 * 2 <= d1:
            return {**out, "hours": raw * length, "reading": "sessions", "source": "weekly"}
        if d1 * 2 <= d2:
            return {**out, "source": "weekly"}
    return {**out, "certain": False}

    mid = len(values) // 2
    typical = values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2
    d1, d2 = abs(typical - raw), abs(typical - raw * length)
    if d2 < d1:
        return {**out, "hours": raw * length, "reading": "sessions", "source": "inferred"}
    if d1 < d2:
        return out
    return {**out, "certain": False}


def _display(key: str) -> str:
    first, _, last = key.partition("\x1f")
    return f"{first.title()} {last.title()}".strip()


def build(loaded: Loaded, today: dt.date | None = None,
          overrides: Overrides | None = None) -> Report:
    today = today or dt.date.today()
    overrides = overrides or Overrides()
    if not loaded.visits:
        raise ValueError("attendance export contained no usable rows")

    data_through = max(v.date for v in loaded.visits)
    first_visit = min(v.date for v in loaded.visits)
    span = months_between(first_visit, today)
    from_idx, window_start, window_from, window_to = judged_window(today, first_visit, data_through)

    by_student: dict[str, list] = collections.defaultdict(list)
    for visit in loaded.visits:
        by_student[visit.key].append(visit)

    students: list[StudentReport] = []
    for key, visits in by_student.items():
        record = loaded.roster.get(key)
        over = overrides.peek(key)
        plans, _own = monthly_plans(visits, span)
        plan_info = resolve_plan(plans, span, visits, today, over.plan_reading if over else None)
        # Hours per plan unit: the session length when the plan counts sessions, else 1.
        unit = plan_info["session_hours"] if plan_info["reading"] == "sessions" else 1
        plan = plan_info["hours"]

        # An export showing the student enrolled closes any open hold, dated by the month
        # the export covers rather than by today, so re-running an old export cannot
        # rewrite what a newer one already settled.
        if over and record and record.status.casefold() == "enrolled":
            overrides.close_holds(key, month_key(data_through.year, data_through.month))

        # Exact hold periods, parsed once per student
        hold_ranges = []
        if over:
            for period in over.hold_dates:
                try:
                    a = dt.date.fromisoformat(period["from"])
                    b = dt.date.fromisoformat(period["to"])
                except (KeyError, ValueError):
                    continue
                if a <= b:
                    hold_ranges.append((a, b))

        months = []
        schedules: dict[tuple[int, int], Schedule] = {}
        for i, (y, m) in enumerate(span):
            first, last = month_bounds(y, m)
            mk = month_key(y, m)
            month_plan = plans[i] * unit
            sched = infer_for_month(visits, month_plan, first, last)
            if over and over.weekdays:
                sched = Schedule(
                    tuple(sorted(over.weekdays)),
                    over.session_hours or sched.session_hours,
                    True,
                    "set by hand",
                )
            schedules[(y, m)] = sched
            months.append(
                build_month(
                    y, m, visits, sched, month_plan, record, today, data_through,
                    on_hold=over.held(mk) if over else None,
                    plan_override=(over.plan_hours.get(mk) if over else None),
                    force_not_enrolled=bool(over and mk in over.not_enrolled),
                    force_charge=bool(over and mk in over.charged),
                    hold_ranges=hold_ranges,
                    hour_adjust=(over.hour_adjust.get(mk, 0) if over else 0),
                )
            )
        # The student-level schedule is the one that applied most recently, since that is
        # what a person looking at the row wants to know. Earlier months keep their own.
        schedule = schedules[span[-1]]
        # Only the window's months are judged; earlier ones only fed schedules and plans.
        months = [mo for mo in months if mo.year * 12 + (mo.month - 1) >= from_idx]
        report = StudentReport(
            key=key,
            display=_display(key),
            student_id=record.student_id if record else "",
            plan_hours=plan,
            plan_info=plan_info,
            schedule=schedule,
            months=months,
            schedules=schedules,
            settlement=settle(months),
            record=record,
        )
        if plan_info["reading"] == "sessions":
            report.flags.append(
                f"plan {plan_info['raw']}/month read as {plan_info['raw']} sessions of "
                f"{plan_info['session_hours']} hrs = {plan} hrs/month"
                + (" (set by hand)" if plan_info["source"] == "override"
                   else " (from their weekly pattern)" if plan_info["source"] == "weekly"
                   else " (from the attendance pattern)")
            )
        if not schedule.confident:
            report.flags.append(f"schedule uncertain: {schedule.reason}")
        if over and over.note:
            report.flags.append(f"note: {over.note}")
        if record and record.ambiguous:
            report.flags.append("two Enrolled roster records under exactly this name")
        if record is None:
            report.flags.append("no roster record matched")
        # Assumed holds and hand-charged empty months are notes on the page, not flags.
        report.audit = audit_visits([v for v in visits if v.date >= window_start], today)
        students.append(report)

    attended_keys = set(by_student)
    never = [
        record
        for key, record in loaded.roster.items()
        if key not in attended_keys and record.expected
    ]
    never.sort(key=lambda r: _display(r.key))

    warnings = list(loaded.warnings)
    shaky_grant = sum(
        s.current.granted for s in students if s.current and not s.schedule.confident
    )
    total_grant = sum(s.current.granted for s in students if s.current)
    if shaky_grant:
        warnings.append(
            f"{shaky_grant} of {total_grant} makeup hrs granted for the current month rest on a "
            "schedule that could not be inferred confidently; check those before booking"
        )
    unconfident = sum(1 for s in students if not s.schedule.confident)
    if unconfident:
        warnings.append(
            f"{unconfident} of {len(students)} schedules could not be inferred confidently; "
            "their missed dates and behind-pace flags are estimates"
        )

    return Report(
        generated_for=today,
        data_through=data_through,
        window_from=window_from,
        window_to=window_to,
        months=span,
        students=students,
        never_attended=never,
        warnings=warnings,
    )

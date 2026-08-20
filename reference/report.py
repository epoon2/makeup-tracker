"""Assemble the per-student report from the month results and the ledger."""

from __future__ import annotations

import calendar
import collections
import datetime as dt
from dataclasses import dataclass, field

from .audit import audit_month, audit_visits
from .loaders import Loaded, RosterRecord
from .ledger import Settlement, settle
from .months import UNVERIFIABLE, MonthResult, build_month, month_bounds, months_between
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


def payable_window(first_visit: dt.date, data_through: dt.date) -> tuple[dt.date, dt.date]:
    """The span the report is really about: two months back from the newest attendance.

    Anything older than that has expired out of the grace window, so showing the full
    export range would overstate what the numbers cover. Clipped to the start of the
    export, because with less than two months of data the window is simply everything
    there is. Display only; the calculation still runs over the whole export, since a
    partial first month cannot produce a monthly requirement.
    """
    month = data_through.month - 2
    year = data_through.year
    if month <= 0:
        month += 12
        year -= 1
    day = min(data_through.day, calendar.monthrange(year, month)[1])
    back = dt.date(year, month, day)
    return max(first_visit, back), data_through


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


def resolve_plan(raw_plan: int, visits, today: dt.date, pinned: str | None) -> dict:
    """What does the plan number mean for this student: hours, or sessions?

    Radius plans are sold in 'sessions per month', and for one-hour students the two
    readings are the same number. For two-hour students the centre sometimes leaves the
    plan at 4 while delivering 4 x 2 = 8 hours a month, and the plan cannot always be
    changed (it is tied to billing). So the meaning is inferred from what full months
    actually delivered, and a person can pin it either way from the review queue.
    """
    raw = raw_plan if raw_plan > 0 else 8
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

    # Evidence: real (non-marker) hours per completed month with any attendance.
    totals: dict[tuple[int, int], int] = collections.defaultdict(int)
    for v in real:
        if (v.date.year, v.date.month) == (today.year, today.month):
            continue
        totals[(v.date.year, v.date.month)] += v.hours
    values = sorted(totals.values())
    if len(values) < 2:
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

    by_student: dict[str, list] = collections.defaultdict(list)
    for visit in loaded.visits:
        by_student[visit.key].append(visit)

    students: list[StudentReport] = []
    for key, visits in by_student.items():
        raw_plan = next((v.sessions_per_month for v in visits if v.sessions_per_month), 8)
        record = loaded.roster.get(key)
        over = overrides.peek(key)
        plan_info = resolve_plan(raw_plan, visits, today, over.plan_reading if over else None)
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
        for (y, m) in span:
            first, last = month_bounds(y, m)
            mk = month_key(y, m)
            sched = infer_for_month(visits, plan, first, last)
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
                    y, m, visits, sched, plan, record, today, data_through,
                    on_hold=over.held(mk) if over else None,
                    plan_override=(over.plan_hours.get(mk) if over else None),
                    force_not_enrolled=bool(over and mk in over.not_enrolled),
                    hold_ranges=hold_ranges,
                    hour_adjust=(over.hour_adjust.get(mk, 0) if over else 0),
                )
            )
        # The student-level schedule is the one that applied most recently, since that is
        # what a person looking at the row wants to know. Earlier months keep their own.
        schedule = schedules[span[-1]]
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
                + (" (set by hand)" if plan_info["source"] == "override" else " (from the attendance pattern)")
            )
        if not schedule.confident:
            report.flags.append(f"schedule uncertain: {schedule.reason}")
        if over and over.note:
            report.flags.append(f"note: {over.note}")
        if record and record.ambiguous:
            report.flags.append("more than one roster record under this name")
        if record is None:
            report.flags.append("no roster record matched")
        for month in months:
            if month.absent_whole_month and month.absence_basis == UNVERIFIABLE:
                report.flags.append(
                    f"{month.required} hrs granted for {month.label}; enrollment that month unconfirmed"
                )
        report.audit = audit_visits(visits, schedule.session_hours, today)
        for month in months:
            entry = audit_month(key, month.label, month.required, month.attended,
                                month.marker_hours, month.on_hold)
            if entry:
                report.audit.append(entry)
        students.append(report)

    attended_keys = set(by_student)
    never = [
        record
        for key, record in loaded.roster.items()
        if key not in attended_keys and record.expected
    ]
    never.sort(key=lambda r: _display(r.key))

    warnings = list(loaded.warnings)
    elapsed = [m for m in span if m != (today.year, today.month)]
    if len(elapsed) < 2:
        # Not a fix-your-export warning. Attendance was only recorded reliably from
        # 1 July 2026, so there is nothing earlier to load. The grace window simply has
        # less to work with than it will next month, and the report should say so rather
        # than look like it checked further back than it did.
        warnings.append(
            f"only {len(elapsed)} completed month(s) of attendance are available, so the "
            "two-month grace window cannot settle debt against a later month yet"
        )
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

    window_from, window_to = payable_window(first_visit, data_through)
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

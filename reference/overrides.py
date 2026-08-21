"""Things the exports cannot tell us, supplied by whoever runs the report.

Radius gives a current snapshot and a visit log. It does not say when a hold started, why
a month is empty, or that a student was sold four sessions this month instead of eight.
Those are answerable by a person in about a second each, so the tool asks rather than
guesses, and keeps the answers.

Every override is scoped to whole calendar months. Holds in particular cannot be partial:
a student is on hold for a month or they are not.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

HOLD = "hold"
PLAN = "plan"
NOT_ENROLLED = "not-enrolled"
SCHEDULE = "schedule"
NOTE = "note"


def month_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def month_index(key: str) -> int:
    year, month = key.split("-")
    return int(year) * 12 + int(month) - 1


@dataclass
class Hold:
    """A hold running from `start` until enrollment is seen again.

    `until` is exclusive and is normally filled in by the tool rather than typed: when an
    export arrives whose roster says the student is enrolled, the month that export covers
    becomes `until`, and every month from `start` up to it counts as held. So a hold
    entered for August, with an export on 3 October showing them enrolled, means August and
    September held and October not.

    Left open (`until is None`) the hold runs to the end of the report, which is correct
    for a student who is still on hold.
    """

    start: str
    until: str | None = None
    source: str = "entered"

    def covers(self, key: str) -> bool:
        if month_index(key) < month_index(self.start):
            return False
        return self.until is None or month_index(key) < month_index(self.until)


@dataclass
class StudentOverrides:
    holds: list[Hold] = field(default_factory=list)
    plan_hours: dict[str, int] = field(default_factory=dict)
    not_enrolled: set[str] = field(default_factory=set)
    # Months confirmed as enrolled-but-absent, so the full plan is charged.
    # Without this a fully empty month is assumed to be a hold.
    charged: set[str] = field(default_factory=set)
    weekdays: tuple[int, ...] | None = None
    session_hours: int | None = None
    # 'hours' or 'sessions': what the plan number means for this student, pinned by a
    # person when the attendance history cannot decide it.
    plan_reading: str | None = None
    # Exact hold periods typed off the Radius hold screen, as ISO date strings.
    # Month-aligned periods are stored as month holds instead; these carry the
    # rare hold that starts or ends mid-month, and prorate that month.
    hold_dates: list[dict] = field(default_factory=list)
    # Net hour corrections per month key, from answered audit findings: a
    # double-logged hour removed, or a folded makeup hour moved to the month
    # it belongs to. Always small, always person-approved.
    hour_adjust: dict[str, int] = field(default_factory=dict)
    audit_checked: list[str] = field(default_factory=list)
    note: str = ""

    def held(self, key: str) -> bool:
        return any(h.covers(key) for h in self.holds)


@dataclass
class Overrides:
    students: dict[str, StudentOverrides] = field(default_factory=dict)

    def get(self, student_key: str) -> StudentOverrides:
        return self.students.setdefault(student_key, StudentOverrides())

    def peek(self, student_key: str) -> StudentOverrides | None:
        return self.students.get(student_key)

    # -- hold lifecycle ----------------------------------------------------------

    def close_holds(self, student_key: str, enrolled_in: str) -> bool:
        """Close any open hold once an export shows the student enrolled again.

        Returns True if something changed, so the caller knows to save. The closing month
        is the month the export covers, not today: re-running an old export must not
        rewrite history that a newer one already settled.
        """
        record = self.students.get(student_key)
        if not record:
            return False
        changed = False
        for hold in record.holds:
            if hold.until is not None:
                continue
            if month_index(enrolled_in) > month_index(hold.start):
                hold.until = enrolled_in
                hold.source = "closed by export"
                changed = True
        return changed

    # -- serialisation -----------------------------------------------------------

    def to_dict(self) -> dict:
        out: dict = {"version": 1, "students": {}}
        for key, record in self.students.items():
            if not (record.holds or record.plan_hours or record.not_enrolled
                    or record.charged or record.weekdays or record.plan_reading
                    or record.hold_dates or record.hour_adjust or record.audit_checked
                    or record.note):
                continue
            out["students"][key] = {
                "holds": [{"start": h.start, "until": h.until, "source": h.source} for h in record.holds],
                "planHours": record.plan_hours,
                "notEnrolled": sorted(record.not_enrolled),
                "charged": sorted(record.charged),
                "weekdays": list(record.weekdays) if record.weekdays else None,
                "sessionHours": record.session_hours,
                "planReading": record.plan_reading,
                "holdDates": record.hold_dates,
                "hourAdjust": record.hour_adjust,
                "auditChecked": record.audit_checked,
                "note": record.note,
            }
        return out

    @classmethod
    def from_dict(cls, data: dict | None) -> "Overrides":
        result = cls()
        if not data:
            return result
        for key, raw in (data.get("students") or {}).items():
            record = result.get(key)
            for hold in raw.get("holds") or []:
                record.holds.append(Hold(hold["start"], hold.get("until"), hold.get("source", "entered")))
            record.plan_hours = {k: int(v) for k, v in (raw.get("planHours") or {}).items()}
            record.not_enrolled = set(raw.get("notEnrolled") or [])
            record.charged = set(raw.get("charged") or [])
            weekdays = raw.get("weekdays")
            record.weekdays = tuple(weekdays) if weekdays else None
            record.session_hours = raw.get("sessionHours")
            record.plan_reading = raw.get("planReading")
            record.hold_dates = list(raw.get("holdDates") or [])
            record.hour_adjust = {k: int(v) for k, v in (raw.get("hourAdjust") or {}).items()}
            record.audit_checked = list(raw.get("auditChecked") or [])
            record.note = raw.get("note") or ""
        return result

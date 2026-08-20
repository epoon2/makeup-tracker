"""Load and normalize the two Radius exports.

This is the reference implementation. The shipped tool is the single-file HTML page;
this module exists so its numbers can be checked against an independent implementation.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field

import pandas as pd

# Columns the tool actually reads. Radius exports carry far more than this, including
# addresses, dates of birth and medical notes. Nothing outside these lists is loaded.
ATTENDANCE_COLUMNS = [
    "Lead Id",
    "Attendance Date",
    "First Name",
    "Last Name",
    "Duration (Minutes)",
    "Duration (Hours)",
    "Sessions Per Month",
    "Center",
]
ROSTER_COLUMNS = [
    "Student Id",
    "First Name",
    "Last Name",
    "Enrollment Status",
    "Enrollment Start Date",
    "Enrollment End Date",
    "Last Attendance Date",
    "Center",
]

# Columns that may carry the session's start time. The real Radius attendance export
# calls it "Arrival Time" (verified against the 8/20/2026 export, format "4:00 PM");
# the rest are fallbacks, and a time inside Attendance Date is the last resort.
TIME_COLUMNS = ["Arrival Time", "Start Time", "Session Start Time", "Session Start", "Time In", "Attendance Time", "Time"]

# 'Recurring' appears in Enrollment End Date to mean "no end date", not a date.
NO_END_SENTINEL = {"recurring", "", "none", "n/a"}

ACTIVE_STATUSES = {"enrolled", "new", "pre-enrolled"}
HOLD_STATUSES = {"on hold"}


def _parse_date(value) -> dt.date | None:
    """Radius writes M/D/YYYY. Returns None for blanks and for sentinels like 'Recurring'."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in NO_END_SENTINEL:
        return None
    match = re.match(r"^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})", text)
    if not match:
        return None
    a, b, c = (int(x) for x in match.groups())
    # ISO (YYYY-M-D) if the first field is a year, otherwise US (M/D/YYYY).
    year, month, day = (a, b, c) if a > 31 else (c, a, b)
    if year < 100:
        year += 2000
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def parse_time_of_day(value) -> int | None:
    """A start time as minutes since midnight, or None when the cell says nothing.

    Excel can hand a time back as a fraction of a day (0.5 = noon). A bare '0' in a
    dedicated time column is taken as midnight; a dateless serial is not a time.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text == "0":
        return 0
    if re.match(r"^0?\.\d+$", text):
        try:
            f = float(text)
        except ValueError:
            return None
        return round(f * 1440) % 1440 if 0 <= f < 1 else None
    match = re.search(r"(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?", text, re.IGNORECASE)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if minute > 59 or hour > 23:
        return None
    ampm = (match.group(3) or "").upper()
    if ampm == "AM" and hour == 12:
        hour = 0
    elif ampm == "PM" and hour != 12:
        hour += 12
    return None if hour > 23 else hour * 60 + minute


def start_minutes_for(row: dict) -> int | None:
    """Start time for one attendance row: a dedicated time column first, then a time
    written after the date inside Attendance Date ('8/5/2026 12:00 AM')."""
    for col in TIME_COLUMNS:
        if col in row:
            t = parse_time_of_day(row[col])
            if t is not None:
                return t
    text = "" if row.get("Attendance Date") is None else str(row.get("Attendance Date"))
    after = re.sub(r"^\s*\d{1,4}[/-]\d{1,2}[/-]\d{1,4}[,\s]*", "", text)
    if after and after != text:
        t = parse_time_of_day(after)
        if t is not None:
            return t
    return None


def round_hours(minutes) -> int:
    """Round a visit to the nearest whole hour. 56 min -> 1, 115 min -> 2, 20 min -> 0.

    Uses half-up rather than Python's banker's rounding, so 90 minutes is 2 hours and
    not 2 hours on one row and 1 on the next.
    """
    if minutes is None or (isinstance(minutes, float) and pd.isna(minutes)):
        return 0
    try:
        value = float(minutes)
    except (TypeError, ValueError):
        return 0
    if value <= 0:
        return 0
    return int((value / 60.0) + 0.5)


def name_key(first, last) -> str:
    """Join key between the two exports.

    The attendance export has no Student Id, so name is the only available join. Keys are
    case-folded and internally whitespace-collapsed so 'De  La Cruz' and 'de la cruz' meet.
    """
    parts = []
    for piece in (first, last):
        text = "" if piece is None else str(piece)
        parts.append(re.sub(r"\s+", " ", text).strip().casefold())
    return "\x1f".join(parts)


@dataclass
class Visit:
    key: str
    date: dt.date
    hours: int
    sessions_per_month: int
    start_minutes: int | None = None
    # 12:00 AM is never a real session (real ones run 1:30-7:30 pm). By convention an
    # entry logged at exactly midnight is a makeup-redemption marker: its hours credit
    # the month it is dated in, but it is not evidence of a weekly schedule.
    marker: bool = False


@dataclass
class RosterRecord:
    key: str
    student_id: str
    status: str
    start: dt.date | None
    end: dt.date | None
    last_attendance: dt.date | None
    ambiguous: bool = False

    @property
    def on_hold(self) -> bool:
        return self.status.casefold() in HOLD_STATUSES

    @property
    def active(self) -> bool:
        """Broad sense: on the roster in some live capacity. Used to pick between two
        records that share a name, not to decide who owes anything."""
        return self.status.casefold() in ACTIVE_STATUSES or self.on_hold

    @property
    def expected(self) -> bool:
        """Narrow sense: should be attending right now, so an absence is worth chasing.

        Only 'Enrolled'. New and Pre-Enrolled students have often not started yet, and a
        list that mixes them in reads as 30-odd false alarms, which is how a report stops
        being used.
        """
        return self.status.casefold() == "enrolled"


@dataclass
class Loaded:
    visits: list[Visit]
    roster: dict[str, RosterRecord]
    warnings: list[str] = field(default_factory=list)


def _read(path, columns, optional=()) -> pd.DataFrame:
    frame = pd.read_excel(path, dtype=str)
    frame.columns = [str(c).strip() for c in frame.columns]
    missing = [c for c in columns if c not in frame.columns]
    if missing:
        raise ValueError(f"{path}: missing expected columns {missing}")
    # Deduplicate labels before selecting; the roster export ships two 'Lead Id' columns.
    frame = frame.loc[:, ~frame.columns.duplicated()]
    wanted = [c for c in columns if c in frame.columns] + [c for c in optional if c in frame.columns]
    return frame[wanted]


def load(attendance_path, roster_path) -> Loaded:
    warnings: list[str] = []

    att = _read(attendance_path, ATTENDANCE_COLUMNS, optional=TIME_COLUMNS)
    visits: list[Visit] = []
    unparsed_dates = 0
    zero_hour = 0
    timed = 0
    for record in att.to_dict("records"):
        when = _parse_date(record.get("Attendance Date"))
        if when is None:
            unparsed_dates += 1
            continue
        hours = round_hours(record.get("Duration (Minutes)"))
        if hours <= 0:
            zero_hour += 1
            continue
        try:
            spm = int(float(str(record.get("Sessions Per Month") or 0)))
        except (TypeError, ValueError):
            spm = 0
        start_minutes = start_minutes_for(record)
        if start_minutes is not None:
            timed += 1
        visits.append(
            Visit(
                key=name_key(record.get("First Name"), record.get("Last Name")),
                date=when,
                hours=hours,
                sessions_per_month=spm,
                start_minutes=start_minutes,
                marker=start_minutes == 0,
            )
        )
    if unparsed_dates:
        warnings.append(f"{unparsed_dates} attendance rows had an unreadable date and were skipped")
    if zero_hour:
        warnings.append(f"{zero_hour} attendance rows rounded to 0 hours and were ignored")
    if visits and not timed:
        warnings.append(
            "the attendance export carries no session start times, so 12 AM "
            "makeup-redemption markers cannot be recognised"
        )

    ros = _read(roster_path, ROSTER_COLUMNS)
    roster: dict[str, RosterRecord] = {}
    collisions: set[str] = set()
    for raw in ros.to_dict("records"):
        key = name_key(raw.get("First Name"), raw.get("Last Name"))
        record = RosterRecord(
            key=key,
            student_id=str(raw.get("Student Id") or "").strip(),
            status=str(raw.get("Enrollment Status") or "").strip(),
            start=_parse_date(raw.get("Enrollment Start Date")),
            end=_parse_date(raw.get("Enrollment End Date")),
            last_attendance=_parse_date(raw.get("Last Attendance Date")),
        )
        existing = roster.get(key)
        if existing is None:
            roster[key] = record
            continue
        collisions.add(key)
        # Two records under one name. Prefer the active one; if both are active or both
        # are not, prefer the more recently attending. Either way mark it ambiguous so
        # the report can say so rather than quietly picking.
        better = record.active and not existing.active
        if not better and record.active == existing.active:
            better = (record.last_attendance or dt.date.min) > (existing.last_attendance or dt.date.min)
        if better:
            record.ambiguous = True
            roster[key] = record
        else:
            existing.ambiguous = True
    for key in collisions:
        roster[key].ambiguous = True
    if collisions:
        warnings.append(
            f"{len(collisions)} names appear on more than one roster record; "
            "those students are flagged rather than silently merged"
        )

    return Loaded(visits=visits, roster=roster, warnings=warnings)

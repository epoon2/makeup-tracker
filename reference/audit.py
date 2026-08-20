"""Flag attendance entries that look off, so a person can check them in Radius.

Deliberately few checks and conservative thresholds: a list with false alarms in it stops
being read, which is worse than no list. Each entry says what looked odd and why.
"""

from __future__ import annotations

import collections
import datetime as dt
from dataclasses import dataclass

from .loaders import Visit

# The 1:30-7:30 pm window is the WEEKDAY window (Jorge, 20 Aug 2026). The real export
# shows the centre runs weekend mornings (418 Saturday and 14 Sunday morning arrivals in
# Jul-Aug 2026), and Arrival Time is a check-in clock, so sessions routinely end a few
# minutes past 7:30. The rule that survives contact with the data: weekday starts before
# 1:30 pm are odd, starts before 8 am are odd on any day, and end times are not checked.
WEEKDAY_OPEN_MINUTES = 13 * 60 + 30
ANY_DAY_OPEN_MINUTES = 8 * 60

# A month running this many hours past its requirement with no 12 AM markers suggests
# makeup hours folded into longer entries the old way.
EXCESS_WORTH_ASKING = 3


@dataclass
class AuditEntry:
    key: str
    date: dt.date | None
    kind: str
    detail: str


def audit_visits(visits: list[Visit], typical_session_hours: int, today: dt.date) -> list[AuditEntry]:
    out: list[AuditEntry] = []
    seen: collections.Counter = collections.Counter()

    for v in sorted(visits, key=lambda x: (x.date, x.start_minutes or 0)):
        if v.date > today:
            out.append(AuditEntry(v.key, v.date, "future",
                                  f"dated {v.date.month}/{v.date.day}/{v.date.year}, which has not happened yet"))
        if not v.marker and v.start_minutes is not None:
            weekend = v.date.weekday() >= 5
            too_early = v.start_minutes < ANY_DAY_OPEN_MINUTES or (
                not weekend and v.start_minutes < WEEKDAY_OPEN_MINUTES)
            if too_early:
                hh, mm = divmod(v.start_minutes, 60)
                ampm = "AM" if hh < 12 else "PM"
                h12 = hh % 12 or 12
                when = "before 8 am" if v.start_minutes < ANY_DAY_OPEN_MINUTES else "on a weekday before the 1:30 pm opening"
                out.append(AuditEntry(v.key, v.date, "off-hours",
                                      f"starts {h12}:{mm:02d} {ampm} {when}, and is not a 12 AM marker - makeup or typo?"))
        if not v.marker:
            dup_key = (v.key, v.date, v.start_minutes, v.hours)
            seen[dup_key] += 1
            if seen[dup_key] == 2:
                out.append(AuditEntry(v.key, v.date, "duplicate",
                                      "two identical entries on the same date and time"))
        if not v.marker and typical_session_hours == 1 and v.hours >= 2:
            out.append(AuditEntry(v.key, v.date, "folded",
                                  f"{v.hours}-hour entry for a student whose sessions run 1 hour - if part of it is a makeup, log that hour as its own 12 AM entry"))
    return out


def audit_month(key: str, label: str, required: int, attended: int,
                marker_hours: int, on_hold: bool) -> AuditEntry | None:
    if on_hold or required <= 0:
        return None
    if attended >= required + EXCESS_WORTH_ASKING and marker_hours == 0:
        return AuditEntry(key, None, "heavy-month",
                          f"{attended} hrs in {label} against a requirement of {required}, with no 12 AM markers - folded makeup hours?")
    return None

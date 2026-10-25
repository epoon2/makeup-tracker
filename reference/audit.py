"""Flag attendance entries that cannot be right as logged, so a person can check them in Radius.

Deliberately few checks: a list with false alarms in it stops being read, which is worse
than no list. Since 25 Oct 2026 it holds only the same entry twice and entries dated in
the future. Visits outside session hours are makeups (loaders.SESSION_WINDOWS), not
oddities; extra hours in a month pay older debt and are not a problem; 2-hour entries for
1-hour students count either way.
"""

from __future__ import annotations

import collections
import datetime as dt
from dataclasses import dataclass

from .loaders import Visit


@dataclass
class AuditEntry:
    key: str
    date: dt.date | None
    kind: str
    detail: str


def audit_visits(visits: list[Visit], today: dt.date) -> list[AuditEntry]:
    out: list[AuditEntry] = []
    seen: collections.Counter = collections.Counter()

    for v in sorted(visits, key=lambda x: (x.date, x.start_minutes or 0)):
        if v.date > today:
            out.append(AuditEntry(v.key, v.date, "future",
                                  f"dated {v.date.month}/{v.date.day}/{v.date.year}, which has not happened yet"))
        if not v.marker:
            dup_key = (v.key, v.date, v.start_minutes, v.hours)
            seen[dup_key] += 1
            if seen[dup_key] == 2:
                out.append(AuditEntry(v.key, v.date, "duplicate",
                                      "two identical entries on the same date and time"))
    return out

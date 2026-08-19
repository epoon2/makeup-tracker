"""Decide whether a student was enrolled during a month they were entirely absent for.

`Enrollment Status` is a snapshot of today. A student who reads Enrolled now may have been
unenrolled, or on hold, during the month in question, so the status column cannot testify
about a past month and is deliberately not used as evidence here.

What can be used is attendance itself. Attendance can only be recorded for an enrolled
student, so **an attendance row on a date proves enrollment on that date**. That turns the
question into bracketing: if there is evidence of enrollment before the gap and evidence
after it, the student was almost certainly enrolled through it. Almost, because a hold
would look identical from outside, and holds are not dated anywhere in either export.
That residual is what UNVERIFIABLE means, and it is why the report names the month.

Two roster columns extend the brackets past the export window:
`Enrollment Start Date` is a left bound, `Last Attendance Date` a right bound. Both can
reach back before the attendance export starts, which matters because the export begins
1 July and nothing earlier exists.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from .loaders import RosterRecord

ENROLLED = "enrolled"
NOT_ENROLLED = "not-enrolled"
UNVERIFIABLE = "unverifiable"


@dataclass
class AbsenceVerdict:
    basis: str
    detail: str


def resolve(
    record: RosterRecord | None,
    visit_dates: list[dt.date],
    first: dt.date,
    last: dt.date,
) -> AbsenceVerdict:
    """Classify a whole-month absence over [first, last]."""

    # Hard negatives. These come from dated roster fields, so they are facts rather
    # than inferences, and they settle the question outright.
    if record is not None:
        if record.start is not None and record.start > last:
            return AbsenceVerdict(NOT_ENROLLED, f"enrollment started {record.start:%-m/%-d/%Y}, after this month")
        if record.end is not None and record.end < first:
            return AbsenceVerdict(NOT_ENROLLED, f"enrollment ended {record.end:%-m/%-d/%Y}, before this month")

    before = [d for d in visit_dates if d < first]
    after = [d for d in visit_dates if d > last]

    # Left bracket: was the student enrolled at or before the start of the gap?
    left = bool(before)
    left_source = "attended before this month" if before else ""
    if not left and record is not None and record.start is not None and record.start <= first:
        left, left_source = True, f"enrolled since {record.start:%-m/%-d/%Y}"

    # Right bracket: is there evidence of enrollment after the gap?
    right = bool(after)
    right_source = "attended after this month" if after else ""
    if not right and record is not None and record.last_attendance is not None and record.last_attendance > last:
        right, right_source = True, f"last attended {record.last_attendance:%-m/%-d/%Y}"

    if not right:
        # Nothing after the gap. The student stopped coming; the gap is the tail of their
        # record, not a month they owe for.
        return AbsenceVerdict(NOT_ENROLLED, "no attendance or enrollment activity after this month")

    if not left:
        # Evidence after but none before. Most likely they had not started yet, and there
        # is nothing to prove otherwise, so no makeups are owed.
        return AbsenceVerdict(
            NOT_ENROLLED,
            "no evidence of enrollment before this month; treated as not yet started",
        )

    # Bracketed on both sides. They were on the roster either side of a month they did not
    # attend at all. Enrolled and absent is the likeliest reading, but an undated hold
    # looks exactly the same, so this is granted and flagged rather than asserted.
    reason = f"{left_source} and {right_source}"
    if record is not None and record.on_hold:
        reason += "; currently on hold, and holds are not dated in the export"
    return AbsenceVerdict(UNVERIFIABLE, reason)

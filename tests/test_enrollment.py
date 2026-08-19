"""Whole-month absence resolution. Current Enrollment Status is never evidence."""
import datetime as dt
from reference.enrollment import ENROLLED, NOT_ENROLLED, UNVERIFIABLE, resolve
from reference.loaders import RosterRecord

JUL = (dt.date(2026, 7, 1), dt.date(2026, 7, 31))
D = dt.date


def rec(**kw):
    base = dict(key="k", student_id="1", status="Enrolled", start=None, end=None, last_attendance=None)
    base.update(kw)
    return RosterRecord(**base)


def test_start_after_the_month_is_a_hard_no():
    v = resolve(rec(start=D(2026, 8, 3)), [D(2026, 8, 5)], *JUL)
    assert v.basis == NOT_ENROLLED


def test_end_before_the_month_is_a_hard_no():
    v = resolve(rec(end=D(2026, 6, 20)), [D(2026, 6, 1)], *JUL)
    assert v.basis == NOT_ENROLLED


def test_no_activity_after_the_gap_means_they_left():
    v = resolve(rec(start=D(2025, 1, 1)), [D(2026, 6, 10)], *JUL)
    assert v.basis == NOT_ENROLLED
    assert "after this month" in v.detail


def test_no_evidence_before_the_gap_means_not_yet_started():
    v = resolve(rec(), [D(2026, 8, 4)], *JUL)
    assert v.basis == NOT_ENROLLED
    assert "not yet started" in v.detail


def test_bracketed_by_attendance_is_unverifiable_not_enrolled():
    # Attended either side of the gap. Enrolled-and-absent and on-hold look identical,
    # and holds are not dated anywhere, so this is granted and flagged.
    v = resolve(rec(), [D(2026, 6, 9), D(2026, 8, 4)], *JUL)
    assert v.basis == UNVERIFIABLE


def test_roster_dates_extend_the_brackets_past_the_export_window():
    # Nothing before July in the export, but the roster says enrolled since 2024.
    v = resolve(rec(start=D(2024, 3, 1)), [D(2026, 8, 4)], *JUL)
    assert v.basis == UNVERIFIABLE
    assert "enrolled since" in v.detail


def test_last_attendance_date_can_supply_the_right_bracket():
    v = resolve(rec(start=D(2024, 3, 1), last_attendance=D(2026, 8, 12)), [], *JUL)
    assert v.basis == UNVERIFIABLE


def test_current_hold_is_called_out_in_the_detail():
    v = resolve(rec(start=D(2024, 1, 1), status="On Hold"), [D(2026, 8, 4)], *JUL)
    assert v.basis == UNVERIFIABLE
    assert "on hold" in v.detail


def test_current_status_alone_never_proves_past_enrollment():
    # Reads Enrolled today, but nothing places them on the roster before the gap.
    assert resolve(rec(status="Enrolled"), [D(2026, 8, 4)], *JUL).basis != ENROLLED

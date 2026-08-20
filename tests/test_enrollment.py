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


def test_markers_stay_out_of_schedule_inference():
    import datetime as dt
    from reference.loaders import Visit
    from reference.schedule import infer

    visits = []
    for w in range(5):
        visits.append(Visit("t", dt.date(2026, 7, 6) + dt.timedelta(days=7 * w), 1, 8))
        visits.append(Visit("t", dt.date(2026, 7, 8) + dt.timedelta(days=7 * w), 1, 8))
    for w in range(3):
        visits.append(Visit("t", dt.date(2026, 7, 11) + dt.timedelta(days=7 * w), 2, 8, marker=True))
    schedule = infer(visits, 8)
    assert schedule.weekdays == (0, 2)
    assert schedule.session_hours == 1


def test_marker_hours_credit_their_month_and_are_reported():
    import datetime as dt
    from reference.loaders import Visit
    from reference.months import build_month
    from reference.schedule import Schedule

    visits = [Visit("t", dt.date(2026, 7, 6), 1, 8), Visit("t", dt.date(2026, 7, 8), 1, 8),
              Visit("t", dt.date(2026, 7, 20), 1, 8, marker=True)]
    month = build_month(2026, 7, visits, Schedule((0, 2), 1, True, ""), 8, None,
                        dt.date(2026, 9, 10), dt.date(2026, 9, 1))
    assert month.attended == 3
    assert month.marker_hours == 1


def test_audit_flags_the_odd_entries_and_nothing_else():
    import datetime as dt
    from reference.audit import audit_month, audit_visits
    from reference.loaders import Visit

    today = dt.date(2026, 8, 19)
    clean = Visit("t", dt.date(2026, 8, 4), 1, 8, start_minutes=15 * 60)
    marker = Visit("t", dt.date(2026, 7, 28), 1, 8, start_minutes=0, marker=True)
    off = Visit("t", dt.date(2026, 8, 5), 1, 8, start_minutes=11 * 60)       # Wed morning
    sat_ok = Visit("t", dt.date(2026, 8, 8), 1, 8, start_minutes=10 * 60)  # Sat morning: normal
    sat_dawn = Visit("t", dt.date(2026, 8, 8), 1, 8, start_minutes=6 * 60) # 6 AM: odd anywhere
    late = Visit("t", dt.date(2026, 8, 6), 2, 8, start_minutes=18 * 60)    # ends 8 pm: drift, not flagged
    dup_a = Visit("t", dt.date(2026, 8, 7), 1, 8, start_minutes=15 * 60)
    dup_b = Visit("t", dt.date(2026, 8, 7), 1, 8, start_minutes=15 * 60)
    future = Visit("t", dt.date(2026, 8, 25), 1, 8, start_minutes=15 * 60)

    kinds = sorted(e.kind for e in audit_visits(
        [clean, marker, off, sat_ok, sat_dawn, late, dup_a, dup_b, future], 1, today))
    # `late` only trips the folded check now; ends past 7:30 are check-in drift
    assert kinds == ["duplicate", "folded", "future", "off-hours", "off-hours"]

    assert audit_month("t", "July 2026", 8, 12, 0, False).kind == "heavy-month"
    assert audit_month("t", "July 2026", 8, 12, 4, False) is None   # markers explain it
    assert audit_month("t", "July 2026", 8, 10, 0, False) is None   # under the threshold
    assert audit_month("t", "July 2026", 0, 12, 0, True) is None    # held month

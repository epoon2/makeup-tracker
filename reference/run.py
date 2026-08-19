"""CLI: python3 -m reference.run <attendance.xlsx> <students.xlsx> [YYYY-MM-DD]

Prints aggregates only. Never prints student names, so it is safe to paste output.
"""
import datetime as dt, sys
from .loaders import load
from .report import build

def main(argv):
    if len(argv) < 3:
        print(__doc__); return 1
    today = dt.date.fromisoformat(argv[3]) if len(argv) > 3 else dt.date.today()
    rep = build(load(argv[1], argv[2]), today)
    print(f"as of {rep.generated_for}  |  data through {rep.data_through}")
    print(f"months in scope: {', '.join(f'{y}-{m:02d}' for y, m in rep.months)}")
    print(f"students with attendance: {len(rep.students)}")
    print(f"owe makeup hours:        {len(rep.owing):>4}  ({sum(s.owed for s in rep.owing)} hrs)")
    print(f"behind pace this month:  {len(rep.behind_pace):>4}  ({sum(s.to_schedule_now for s in rep.behind_pace)} hrs to book)")
    print(f"on hold:                 {len(rep.held):>4}")
    print(f"enrolled, never attended:{len(rep.never_attended):>4}")
    print(f"missed dates found:      {sum(len(s.missed_dates) for s in rep.students):>4}")
    exp = sum(s.settlement.expired_hours for s in rep.students)
    paid = sum(sum(p[2] for p in s.settlement.payments) for s in rep.students)
    print(f"hours paid off by later excess: {paid}   expired unpaid: {exp}")
    if rep.warnings:
        print("\nwarnings:")
        for w in rep.warnings:
            print("  -", w)
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

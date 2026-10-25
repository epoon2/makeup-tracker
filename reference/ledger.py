"""What is owed: each month in the window stands alone.

Ethan's rule (25 Oct 2026): a student owes makeups for a completed month exactly when that
month's hours fall short of its plan - all of that month's sessions, whatever the dates,
makeups logged into it included. Extra hours in a later month do not pay an earlier one;
they count for the month they are dated in. Only the months the window covers are judged
(report.judged_window): the month two months before today through the current one, so a
month's shortfall can be made up for two months and then drops off. The current month never
owes anything yet: its gap is projected as hours to book. Mirrors settle() in index.html.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .months import MonthResult

JUDGED_MONTHS_BACK = 2


def _index(year: int, month: int) -> int:
    """Months since year 0, so month arithmetic is subtraction."""
    return year * 12 + (month - 1)


@dataclass
class Debt:
    year: int
    month: int
    hours: int
    paid: int = 0
    expired: bool = False
    basis: str = ""
    note: str = ""

    @property
    def outstanding(self) -> int:
        return max(0, self.hours - self.paid)

    @property
    def label(self) -> str:
        import calendar

        return f"{calendar.month_abbr[self.month]} {self.year}"


@dataclass
class Settlement:
    debts: list[Debt] = field(default_factory=list)
    # Kept for the report's shape; under the standalone rule nothing is paid across months
    # and nothing expires inside the window.
    payments: list[tuple[str, str, int]] = field(default_factory=list)
    expired_hours: int = 0
    unused_excess: int = 0

    @property
    def owed(self) -> int:
        return sum(d.outstanding for d in self.debts if not d.expired)

    @property
    def open_debts(self) -> list[Debt]:
        return [d for d in self.debts if not d.expired and d.outstanding > 0]


def settle(months: list[MonthResult]) -> Settlement:
    """One debt per completed, not-held month that fell short of its plan."""
    result = Settlement()
    for month in sorted(months, key=lambda m: (m.year, m.month)):
        if month.is_current or month.on_hold:
            continue
        shortfall = max(0, month.required - month.attended)
        if shortfall:
            result.debts.append(
                Debt(year=month.year, month=month.month, hours=shortfall,
                     basis=month.absence_basis, note=month.note)
            )
    return result

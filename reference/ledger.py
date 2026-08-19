"""FIFO settlement of monthly shortfalls against later excess hours.

A shortfall in a month becomes a debt. Hours attended beyond the requirement in a later
month pay that debt oldest-first. A debt survives two calendar months past the month it
arose in and then expires. Excess hours never bank forward on their own: once every
outstanding debt inside the window is paid, the rest is gone.

Two calendar months of grace, so a July shortfall is payable in August and September and
expires at the end of September.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .months import MonthResult

GRACE_MONTHS = 2


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

    def expires_after(self) -> int:
        return _index(self.year, self.month) + GRACE_MONTHS


@dataclass
class Settlement:
    debts: list[Debt] = field(default_factory=list)
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
    """Walk the months in order, opening debts and paying them oldest-first.

    The current month never opens a debt: its gap is a projection, reported separately as
    makeups to schedule, not as hours already owed. Held months open nothing either.
    """
    result = Settlement()
    ordered = sorted(months, key=lambda m: (m.year, m.month))

    for month in ordered:
        now = _index(month.year, month.month)

        # Expire anything past its grace window before this month's excess is applied,
        # so a debt cannot be paid by hours attended after it lapsed.
        for debt in result.debts:
            if not debt.expired and debt.outstanding > 0 and now > debt.expires_after():
                debt.expired = True
                result.expired_hours += debt.outstanding

        if month.is_current:
            continue

        # A held month requires nothing, so everything attended in it is excess and pays
        # down earlier debt. That is the point of coming in while on hold.
        shortfall = month.shortfall
        excess = max(0, month.attended - month.required)

        if excess:
            for debt in result.debts:
                if excess <= 0:
                    break
                if debt.expired or debt.outstanding <= 0:
                    continue
                applied = min(excess, debt.outstanding)
                debt.paid += applied
                excess -= applied
                result.payments.append((month.label, debt.label, applied))
            result.unused_excess += excess

        if shortfall and not month.on_hold:
            result.debts.append(
                Debt(
                    year=month.year,
                    month=month.month,
                    hours=shortfall,
                    basis=month.absence_basis,
                    note=month.note,
                )
            )

    return result

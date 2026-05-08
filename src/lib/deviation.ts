import type { MilestonePoint, SnapshotPoint } from "./net-worth";

export type DeviationStatus =
  | "ahead"
  | "on_track"
  | "slightly_behind"
  | "behind"
  | "no_data";

export type DeviationResult = {
  status: DeviationStatus;
  actualCents: number;
  expectedCents: number;
  deltaCents: number;
  pct: number; // (actual - expected) / expected; negative = behind
  nextMilestone: MilestonePoint | null;
  monthsToNextMilestone: number | null;
  requiredMonthlySavingsCents: number | null;
};

const DAY_MS = 86_400_000;

function dateMs(s: string): number {
  // s = "YYYY-MM-DD" (treat as UTC midnight; we only care about day-level math)
  return Date.parse(s + "T00:00:00Z");
}

/**
 * Linear interpolation across a sorted list of (date, amountCents) points.
 * Before the first point: returns the first amount.
 * After the last point: returns the last amount.
 */
function linearExpected(
  todayMs: number,
  points: { date: string; amountCents: number }[],
): number {
  if (points.length === 0) return 0;
  if (todayMs <= dateMs(points[0].date)) return points[0].amountCents;
  if (todayMs >= dateMs(points[points.length - 1].date))
    return points[points.length - 1].amountCents;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const aMs = dateMs(a.date);
    const bMs = dateMs(b.date);
    if (todayMs >= aMs && todayMs <= bMs) {
      const frac = (todayMs - aMs) / (bMs - aMs);
      return a.amountCents + (b.amountCents - a.amountCents) * frac;
    }
  }
  return points[points.length - 1].amountCents;
}

export function computeDeviation({
  snapshots,
  milestones,
  todayIso,
  currentNetWorthCents,
}: {
  snapshots: SnapshotPoint[];
  milestones: MilestonePoint[];
  todayIso: string;
  currentNetWorthCents: number;
}): DeviationResult {
  if (snapshots.length === 0 || milestones.length === 0) {
    return {
      status: "no_data",
      actualCents: currentNetWorthCents,
      expectedCents: 0,
      deltaCents: 0,
      pct: 0,
      nextMilestone: null,
      monthsToNextMilestone: null,
      requiredMonthlySavingsCents: null,
    };
  }

  // Anchor the curve at the EARLIEST snapshot (treat that as the "starting line")
  // and continue through every milestone in date order.
  const first = snapshots.reduce((min, s) =>
    dateMs(s.date) < dateMs(min.date) ? s : min,
  );
  const sortedMilestones = [...milestones].sort(
    (a, b) => dateMs(a.date) - dateMs(b.date),
  );

  const points: { date: string; amountCents: number }[] = [
    { date: first.date, amountCents: first.netWorthCents },
    ...sortedMilestones.map((m) => ({
      date: m.date,
      amountCents: m.targetCents,
    })),
  ];

  const todayMs = dateMs(todayIso);
  const expectedCents = linearExpected(todayMs, points);
  const deltaCents = currentNetWorthCents - expectedCents;
  const pct = expectedCents > 0 ? deltaCents / expectedCents : 0;

  let status: DeviationStatus;
  if (pct >= 0) status = "ahead";
  else if (pct >= -0.05) status = "on_track";
  else if (pct >= -0.1) status = "slightly_behind";
  else status = "behind";

  // Find the next milestone we haven't yet passed
  const nextMilestone =
    sortedMilestones.find((m) => dateMs(m.date) > todayMs) ?? null;

  let monthsToNext: number | null = null;
  let requiredMonthly: number | null = null;
  if (nextMilestone) {
    const daysOut = (dateMs(nextMilestone.date) - todayMs) / DAY_MS;
    monthsToNext = daysOut / 30.44; // average month length
    if (monthsToNext > 0) {
      const gap = nextMilestone.targetCents - currentNetWorthCents;
      requiredMonthly = Math.max(0, Math.round(gap / monthsToNext));
    }
  }

  return {
    status,
    actualCents: currentNetWorthCents,
    expectedCents: Math.round(expectedCents),
    deltaCents: Math.round(deltaCents),
    pct,
    nextMilestone,
    monthsToNextMilestone: monthsToNext,
    requiredMonthlySavingsCents: requiredMonthly,
  };
}

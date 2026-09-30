/** Score arithmetic, manual overrides, and the low-confidence downgrade.
 *
 *  Everything here is pure so the results screen can recompute totals
 *  synchronously on every tap — an override has to feel instant. */
import type { GradedPaper, GradedProblem, ProblemStatus, ScanResult, ScoredProblem } from '@/types';

/** The effective status of a problem once the user's override is applied. */
export function effectiveStatus(p: ScoredProblem): ProblemStatus {
  if (p.override === 'correct') return 'correct';
  if (p.override === 'incorrect') return 'incorrect';
  return p.status;
}

/** Points a problem is actually worth once overrides are applied. */
export function effectivePoints(p: ScoredProblem): number {
  if (p.override === 'correct') return p.points_possible;
  if (p.override === 'incorrect') return 0;
  // An unresolved "needs review" scores nothing until the teacher rules on it.
  if (p.status === 'needs_review') return 0;
  return clamp(p.points_earned, 0, p.points_possible);
}

export interface Totals {
  earned: number;
  possible: number;
  percent: number;
  needsReview: number;
  correct: number;
  incorrect: number;
  partial: number;
}

export function computeTotals(problems: ScoredProblem[]): Totals {
  let earned = 0;
  let possible = 0;
  let needsReview = 0;
  let correct = 0;
  let incorrect = 0;
  let partial = 0;

  for (const p of problems) {
    earned += effectivePoints(p);
    possible += Math.max(0, p.points_possible);
    switch (effectiveStatus(p)) {
      case 'correct':
        correct++;
        break;
      case 'incorrect':
        incorrect++;
        break;
      case 'partial':
        partial++;
        break;
      default:
        needsReview++;
    }
  }

  return {
    earned: round2(earned),
    possible: round2(possible),
    percent: possible > 0 ? Math.round((earned / possible) * 100) : 0,
    needsReview,
    correct,
    incorrect,
    partial,
  };
}

/** Cycle a problem between the teacher's two manual verdicts and "leave it to
 *  the model", which is what repeated taps on a mark should do. */
export function cycleOverride(current: ScoredProblem['override']): ScoredProblem['override'] {
  if (current === undefined) return 'correct';
  if (current === 'correct') return 'incorrect';
  return undefined;
}

/**
 * Normalize what the model returned: clamp the numbers into range, and
 * downgrade anything it was not sure about to "needs review" rather than
 * letting a guess count for or against a student.
 */
export function normalizeGraded(paper: GradedPaper, confidenceFloor: number): ScoredProblem[] {
  return paper.problems.map((p: GradedProblem): ScoredProblem => {
    const possible = Number.isFinite(p.points_possible) ? Math.max(0, p.points_possible) : 1;
    const earned = Number.isFinite(p.points_earned) ? clamp(p.points_earned, 0, possible) : 0;
    const confidence = Number.isFinite(p.confidence) ? clamp(p.confidence, 0, 1) : 0;
    const lowConfidence = confidence < confidenceFloor;

    return {
      ...p,
      points_possible: possible,
      points_earned: lowConfidence ? 0 : earned,
      confidence,
      status: lowConfidence ? 'needs_review' : p.status,
      bbox: normalizeBBox(p.bbox),
      explanation: (p.explanation ?? '').trim(),
    };
  });
}

/** Keep bboxes inside the page so overlay marks never render off-image. */
function normalizeBBox(b: GradedProblem['bbox']): GradedProblem['bbox'] {
  const src = b ?? { x: 0, y: 0, w: 0, h: 0 };
  const x = clamp(num(src.x), 0, 1);
  const y = clamp(num(src.y), 0, 1);
  return {
    x,
    y,
    w: clamp(num(src.w), 0, 1 - x),
    h: clamp(num(src.h), 0, 1 - y),
  };
}

export interface AssignmentStats {
  count: number;
  average: number | null;
  /** Problems ordered by how often the class got them wrong. */
  mostMissed: { number: string; missed: number; of: number; questionText: string }[];
  needsReview: number;
}

export function assignmentStats(results: ScanResult[]): AssignmentStats {
  if (results.length === 0) {
    return { count: 0, average: null, mostMissed: [], needsReview: 0 };
  }

  let percentSum = 0;
  let needsReview = 0;
  // Keyed by problem number so the same question lines up across students.
  const missed = new Map<string, { missed: number; of: number; questionText: string }>();

  for (const r of results) {
    const totals = computeTotals(r.problems);
    percentSum += totals.percent;
    needsReview += totals.needsReview;

    for (const p of r.problems) {
      const key = p.number || '?';
      const entry = missed.get(key) ?? { missed: 0, of: 0, questionText: p.question_text };
      entry.of += 1;
      const status = effectiveStatus(p);
      if (status === 'incorrect' || status === 'partial') entry.missed += 1;
      if (!entry.questionText && p.question_text) entry.questionText = p.question_text;
      missed.set(key, entry);
    }
  }

  const mostMissed = [...missed.entries()]
    .map(([number, v]) => ({ number, ...v }))
    .filter((e) => e.missed > 0)
    .sort((a, b) => b.missed / b.of - a.missed / a.of || b.missed - a.missed)
    .slice(0, 5);

  return {
    count: results.length,
    average: Math.round(percentSum / results.length),
    mostMissed,
    needsReview,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

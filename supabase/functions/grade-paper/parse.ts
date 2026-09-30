/** Turning Claude's reply into a grade we are willing to show a teacher.
 *
 *  Separate from index.ts so it is pure, importable and testable without a
 *  Deno server or a network call. Everything here assumes the model output is
 *  untrusted: wrong types, missing fields, fenced JSON, a status that
 *  contradicts the points, and arithmetic that does not add up are all normal
 *  and all handled rather than thrown. */

export type Status = 'correct' | 'incorrect' | 'partial' | 'needs_review';

export interface GradedProblem {
  number: string;
  question_text: string;
  student_answer: string;
  correct_answer: string;
  status: Status;
  points_earned: number;
  points_possible: number;
  explanation: string;
  confidence: number;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface GradedPaper {
  student_name: string | null;
  problems: GradedProblem[];
  total_earned: number;
  total_possible: number;
}

export interface ParseOptions {
  /** When false, a "partial" verdict is collapsed to "incorrect". The prompt
   *  already forbids partial credit in that mode; this makes it structural,
   *  so a model that ignores the instruction still cannot award half marks. */
  allowPartial: boolean;
}

/** Pull the JSON object out of a response that may be fenced, prefixed, or
 *  followed by commentary, then coerce it into the schema. */
export function parseGraded(
  raw: string,
  options: ParseOptions = { allowPartial: true },
): GradedPaper | null {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // One common repair: a trailing comma before a closing brace or bracket.
    try {
      parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }

  return coercePaper(parsed, options);
}

/** Find the outermost balanced {...}, ignoring braces inside strings. */
export function extractJsonObject(raw: string): string | null {
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const STATUSES: Status[] = ['correct', 'incorrect', 'partial', 'needs_review'];

export function coercePaper(
  value: unknown,
  options: ParseOptions = { allowPartial: true },
): GradedPaper | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.problems)) return null;

  const problems = v.problems
    .map((p) => coerceProblem(p, options))
    .filter((p): p is GradedProblem => p !== null);

  // Recompute the totals rather than trusting the model's arithmetic.
  const total_earned = round2(problems.reduce((s, p) => s + p.points_earned, 0));
  const total_possible = round2(problems.reduce((s, p) => s + p.points_possible, 0));

  const name = typeof v.student_name === 'string' ? v.student_name.trim() : '';

  return {
    student_name: name.length > 0 && name.toLowerCase() !== 'null' ? name.slice(0, 80) : null,
    problems,
    total_earned,
    total_possible,
  };
}

function coerceProblem(value: unknown, options: ParseOptions): GradedProblem | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;

  const points_possible = clamp(num(v.points_possible, 1), 0, 1000);
  let status: Status = STATUSES.includes(v.status as Status)
    ? (v.status as Status)
    : 'needs_review';
  if (status === 'partial' && !options.allowPartial) status = 'incorrect';

  // Status and points must never disagree: a "correct" verdict always earns
  // full marks, and an unresolved one always earns none, whatever number the
  // model put in the field.
  const points_earned =
    status === 'correct'
      ? points_possible
      : status === 'incorrect' || status === 'needs_review'
        ? 0
        : clamp(num(v.points_earned, 0), 0, points_possible);

  const bboxIn = (v.bbox ?? {}) as Record<string, unknown>;
  const x = clamp(num(bboxIn.x, 0), 0, 1);
  const y = clamp(num(bboxIn.y, 0), 0, 1);

  return {
    number: str(v.number, 40),
    question_text: str(v.question_text, 600),
    student_answer: str(v.student_answer, 300),
    correct_answer: str(v.correct_answer, 300),
    status,
    points_earned: round2(points_earned),
    points_possible: round2(points_possible),
    explanation: status === 'correct' ? '' : str(v.explanation, 300),
    confidence: clamp(num(v.confidence, 0), 0, 1),
    bbox: { x, y, w: clamp(num(bboxIn.w, 0), 0, 1 - x), h: clamp(num(bboxIn.h, 0), 0, 1 - y) },
  };
}

function str(v: unknown, max: number): string {
  if (typeof v === 'string') return v.slice(0, max);
  if (typeof v === 'number') return String(v);
  return '';
}

function num(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Number(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

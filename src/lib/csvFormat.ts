/** Building the CSV text. Pure — no filesystem, no share sheet — so the
 *  quoting and column rules can be tested directly; `csv.ts` does the IO. */
import type { Assignment, ScanResult } from '@/types';
import { computeTotals, effectiveStatus } from './scoring';

export type CsvShape = 'summary' | 'detail';

/** RFC 4180 quoting: wrap in quotes when the value contains a delimiter,
 *  quote or newline, and double any embedded quotes. */
export function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** One row per student — the shape a gradebook wants. */
export function buildSummaryCsv(results: ScanResult[]): string {
  const lines = [csvRow(['Student', 'Score', 'Possible', 'Percent', 'Needs review', 'Scanned at'])];
  for (const r of results) {
    const t = computeTotals(r.problems);
    lines.push(
      csvRow([
        r.studentName,
        t.earned,
        t.possible,
        `${t.percent}%`,
        t.needsReview,
        new Date(r.createdAt).toISOString(),
      ]),
    );
  }
  return lines.join('\r\n');
}

/** One row per problem per student — the shape item analysis wants. */
export function buildDetailCsv(results: ScanResult[]): string {
  const lines = [
    csvRow([
      'Student',
      'Problem',
      'Question',
      'Student answer',
      'Correct answer',
      'Status',
      'Earned',
      'Possible',
      'Confidence',
      'Explanation',
      'Manually overridden',
    ]),
  ];
  for (const r of results) {
    for (const p of r.problems) {
      lines.push(
        csvRow([
          r.studentName,
          p.number,
          p.question_text,
          p.student_answer,
          p.correct_answer,
          effectiveStatus(p),
          p.override === 'correct' ? p.points_possible : p.override === 'incorrect' ? 0 : p.points_earned,
          p.points_possible,
          p.confidence.toFixed(2),
          p.explanation,
          p.override ? 'yes' : '',
        ]),
      );
    }
  }
  return lines.join('\r\n');
}

export function buildCsv(results: ScanResult[], shape: CsvShape): string {
  return shape === 'summary' ? buildSummaryCsv(results) : buildDetailCsv(results);
}

/** Filesystem-safe version of an assignment name. */
export function fileSlug(name: string): string {
  return (
    name
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 48) || 'assignment'
  );
}

/** The filename an export lands under. */
export function exportFileName(assignment: Assignment, shape: CsvShape): string {
  return `${fileSlug(assignment.name)}-${shape}.csv`;
}

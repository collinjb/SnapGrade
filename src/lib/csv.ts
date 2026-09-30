/** Handing an assignment's CSV to the user. The text itself is built in
 *  `csvFormat.ts`; where the file goes is `media.ts`'s problem — the native
 *  share sheet on a phone, the Web Share API or a download in a browser. */
import { buildCsv, exportFileName, type CsvShape } from './csvFormat';
import { saveTextAndShare } from './media';
import type { Assignment, ScanResult } from '@/types';

export type { CsvShape };
export { csvCell, csvRow, buildSummaryCsv, buildDetailCsv } from './csvFormat';

/** Write the CSV and offer it to the user. Returns the file's location. */
export async function exportCsv(
  assignment: Assignment,
  results: ScanResult[],
  shape: CsvShape,
): Promise<string> {
  return saveTextAndShare(
    exportFileName(assignment, shape),
    // Excel needs the BOM to read UTF-8 accented names correctly.
    `\uFEFF${buildCsv(results, shape)}`,
    'text/csv',
    `${assignment.name} (${shape})`,
  );
}

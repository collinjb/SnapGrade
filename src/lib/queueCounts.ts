/** Summarising the pending queue for the UI. Split out from `gradeFlow.ts`
 *  so the badge arithmetic stays pure and testable while the worker itself
 *  pulls in the filesystem, the network and the store. */
import type { PendingScan } from '@/types';

export interface QueueCounts {
  /** Being processed or graded right now. */
  working: number;
  /** Queued, or waiting out a retry backoff. */
  waiting: number;
  /** Out of retries; waiting on the user. */
  failed: number;
  total: number;
}

export function queueCounts(pending: PendingScan[]): QueueCounts {
  let working = 0;
  let waiting = 0;
  let failed = 0;
  for (const p of pending) {
    if (p.status === 'failed') failed++;
    else if (p.status === 'waiting') waiting++;
    else working++;
  }
  return { working, waiting, failed, total: pending.length };
}

/** The background grading pipeline.
 *
 *  Capture never waits on grading. A shot goes straight into the pending
 *  queue and the shutter is free again immediately, so a stack of papers can
 *  be scanned as fast as they can be laid down — the checkout-scanner feel
 *  the app is built around.
 *
 *  A small pool of workers drains the queue: de-skew and compress, then grade.
 *  Failures back off and retry; a scan captured with no signal simply waits
 *  until there is some. Nothing here ever blocks the UI thread's next
 *  capture. */
import NetInfo from '@react-native-community/netinfo';
import { uuidv4 } from './id';
import { getApiKey } from './apiKeys';
import { gradePaper, ProviderError } from './grading';
import { processCapture } from './imaging';
import { readBase64 } from './media';
import { normalizeGraded } from './scoring';
import { tapError, tapGraded } from './haptics';
import { useStore } from '@/store/useStore';
import type { PendingScan, Quad, ScanResult } from '@/types';

export { queueCounts, type QueueCounts } from './queueCounts';

/** Grades in flight at once. Three keeps a stack moving without tripping a
 *  free-tier rate limit or saturating a classroom's wifi. */
const MAX_CONCURRENT = 3;

/** Give up after this many tries so one broken image cannot retry forever. */
const MAX_ATTEMPTS = 5;

/** Exponential backoff, capped. */
const backoffMs = (attempts: number): number => Math.min(2000 * 2 ** attempts, 60_000);

/** How often to re-check the queue while anything is waiting out a backoff. */
const TICK_MS = 2000;

const active = new Set<string>();
let ticker: ReturnType<typeof setInterval> | null = null;
let online = true;

/**
 * Queue a captured photo for grading and return immediately.
 *
 * `sourceUri` is the raw photo; `quad` is the detected page, consumed later
 * by the processing step. The caller is free to capture again the moment
 * this returns.
 */
export function enqueueCapture(
  sourceUri: string,
  sourceSize: { width: number; height: number },
  quad: Quad | null,
): PendingScan {
  const assignment = useStore.getState().ensureAssignment();

  const scan: PendingScan = {
    id: uuidv4(),
    assignmentId: assignment.id,
    createdAt: Date.now(),
    imageUri: sourceUri,
    imageWidth: sourceSize.width,
    imageHeight: sourceSize.height,
    quad,
    processed: false,
    status: 'waiting',
    attempts: 0,
  };

  useStore.getState().addPending(scan);
  pump();
  return scan;
}

/** Start work on anything that is due, up to the concurrency limit. */
export function pump(): void {
  const now = Date.now();

  for (const item of useStore.getState().pending) {
    if (active.size >= MAX_CONCURRENT) break;
    if (active.has(item.id)) continue;
    if (item.status !== 'waiting') continue;
    if (item.nextAttemptAt != null && item.nextAttemptAt > now) continue;
    // Starting a grade with no connection just burns an attempt. Image
    // processing is local, so an unprocessed scan is still worth running.
    if (!online && item.processed) continue;

    void runOne(item.id);
  }

  ensureTicker();
}

async function runOne(id: string): Promise<void> {
  active.add(id);
  const store = useStore.getState();

  try {
    let item = store.getPending(id);
    if (!item) return;

    const assignment = store.assignments.find((a) => a.id === item!.assignmentId);
    if (!assignment) {
      // Its assignment was deleted out from under it.
      store.removePending(id);
      return;
    }

    // --- De-skew, boost, compress (once; a retry reuses the result) -------
    if (!item.processed) {
      store.setPendingStatus(id, 'processing');
      try {
        const processed = await processCapture(
          item.imageUri,
          { width: item.imageWidth, height: item.imageHeight },
          item.quad,
        );
        store.updatePending(id, {
          imageUri: processed.uri,
          imageWidth: processed.width,
          imageHeight: processed.height,
          processed: true,
          quad: null,
        });
      } catch (e) {
        // A photo we cannot even decode will not decode next time either.
        fail(id, 'That photo could not be processed. Retake it.', e);
        return;
      }
      item = useStore.getState().getPending(id);
      if (!item) return;
    }

    if (!online) {
      // Processed and ready, but there is nowhere to send it yet.
      requeue(id, item.attempts, backoffMs(0));
      return;
    }

    // --- Grade ------------------------------------------------------------
    useStore.getState().setPendingStatus(id, 'grading');

    let base64: string | null;
    try {
      base64 = await readBase64(item.imageUri);
    } catch (e) {
      fail(id, 'That page could not be read back.', e);
      return;
    }
    if (!base64) {
      fail(id, 'That page image is no longer available.', null);
      return;
    }

    const settings = useStore.getState().settings;
    const { result } = await gradePaper({
      imageBase64: base64,
      answerKeyMode: assignment.answerKey.mode,
      answerKeyText: assignment.answerKey.text,
      answerKeyImageBase64: assignment.answerKey.imageBase64,
      partialCredit: settings.partialCredit,
      providerId: settings.provider,
      apiKey: getApiKey(settings.provider),
    });

    const problems = normalizeGraded(result, settings.confidenceFloor);
    const detectedName = result.student_name?.trim() ?? '';

    const scan: ScanResult = {
      id: item.id,
      assignmentId: item.assignmentId,
      createdAt: item.createdAt,
      imageUri: item.imageUri,
      imageWidth: item.imageWidth,
      imageHeight: item.imageHeight,
      // Left empty on purpose: the store assigns "Student N" atomically, so
      // two grades landing together cannot be given the same label.
      studentName: detectedName,
      studentNameIsPlaceholder: detectedName.length === 0,
      problems,
      rawTotalEarned: result.total_earned,
      rawTotalPossible: result.total_possible,
    };

    useStore.getState().addResult(scan);
    useStore.getState().removePending(id);
    tapGraded(problems.some((p) => p.status === 'needs_review'));
  } catch (e) {
    handleGradeError(id, e);
  } finally {
    active.delete(id);
    pump();
  }
}

function handleGradeError(id: string, e: unknown): void {
  const item = useStore.getState().getPending(id);
  if (!item) return;

  const failure = e instanceof ProviderError ? e : null;
  const message = failure?.message ?? (e instanceof Error ? e.message : String(e));

  if (failure && !failure.retryable) {
    fail(id, message, e);
    return;
  }

  // Rate limiting and quota are not this scan's fault, so neither burns an
  // attempt — the scan just waits as long as the provider asked.
  if (failure?.code === 'rate_limited' || failure?.code === 'quota') {
    requeue(id, item.attempts, (failure.retryAfterSeconds ?? 30) * 1000, message);
    return;
  }

  const attempts = item.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    fail(id, message, e);
    return;
  }
  requeue(id, attempts, backoffMs(attempts), message);
}

function requeue(id: string, attempts: number, delayMs: number, error?: string): void {
  useStore.getState().updatePending(id, {
    status: 'waiting',
    attempts,
    nextAttemptAt: Date.now() + delayMs,
    lastError: error,
  });
}

function fail(id: string, message: string, cause: unknown): void {
  if (cause) console.warn(`[snapgrade] scan ${id} failed:`, cause);
  useStore.getState().updatePending(id, { status: 'failed', lastError: message });
  tapError();
}

/** Keep a timer alive only while something is actually waiting. */
function ensureTicker(): void {
  const anyWaiting = useStore.getState().pending.some((p) => p.status !== 'failed');

  if (anyWaiting && ticker === null) {
    ticker = setInterval(() => pump(), TICK_MS);
  } else if (!anyWaiting && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * Start the pipeline: drain whatever survived the last session, and wake up
 * whenever connectivity returns. Returns an unsubscribe.
 */
export function startGradingWorker(): () => void {
  const unsubscribe = NetInfo.addEventListener((state) => {
    const wasOffline = !online;
    online = state.isConnected !== false;

    if (online && wasOffline) {
      // Connectivity is back: clear the backoffs rather than making a stack
      // of scans wait out timers that were set for a dead network.
      const store = useStore.getState();
      for (const item of store.pending) {
        if (item.status === 'waiting') store.updatePending(item.id, { nextAttemptAt: undefined });
      }
    }
    pump();
  });

  void NetInfo.fetch().then((state) => {
    online = state.isConnected !== false;
    pump();
  });

  return () => {
    unsubscribe();
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/** Kick every failed scan back into the queue. */
export function retryAllFailed(): void {
  const store = useStore.getState();
  for (const item of store.pending) {
    if (item.status === 'failed') store.retryPending(item.id);
  }
  pump();
}

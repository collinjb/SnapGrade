/** Client side of the grading call.
 *
 *  The Anthropic key never reaches the device: we invoke the `grade-paper`
 *  Edge Function with the user's Supabase JWT and it holds the key. */
import { supabase, supabaseConfigured, ensureSession } from './supabase';
import { base64Bytes } from './imaging';
import type { GradeRequest, GradeResponse, GradedPaper } from '@/types';

/** Anthropic caps a single image at 5 MB; we stay well under it. Anything
 *  bigger means the processing pipeline failed and we would rather say so. */
const MAX_IMAGE_BYTES = 4_000_000;

export class GradeFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GradeFailure';
  }
}

function isGradedPaper(v: unknown): v is GradedPaper {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return Array.isArray(p.problems) && typeof p.total_possible === 'number';
}

/**
 * Grade one page. Throws `GradeFailure` with `retryable` set so the offline
 * queue knows whether another attempt is worth making.
 */
export async function gradePaper(req: GradeRequest): Promise<GradeResponse> {
  if (!supabaseConfigured) {
    throw new GradeFailure(
      'SnapGrade is not connected to a backend yet. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, then rebuild.',
      'not_configured',
      false,
    );
  }

  if (!req.imageBase64) {
    throw new GradeFailure('The captured image was empty.', 'bad_request', false);
  }
  if (base64Bytes(req.imageBase64) > MAX_IMAGE_BYTES) {
    throw new GradeFailure('That page came out too large to send.', 'bad_request', false);
  }

  const userId = await ensureSession();
  if (!userId) {
    throw new GradeFailure('Could not reach the sign-in service.', 'unauthorized', true);
  }

  const { data, error } = await supabase.functions.invoke('grade-paper', { body: req });

  if (error) {
    // FunctionsHttpError carries the response; read the structured body so the
    // user sees "you are going too fast" rather than "Edge Function failed".
    const body = await readErrorBody(error);
    if (body) {
      throw new GradeFailure(
        body.error,
        body.code,
        body.code === 'rate_limited' || body.code === 'upstream_error' || body.code === 'server_error',
        body.retryAfterSeconds,
      );
    }
    throw new GradeFailure(error.message || 'Grading failed.', 'network', true);
  }

  if (!data || data.ok !== true || !isGradedPaper(data.result)) {
    throw new GradeFailure('The grader returned something unreadable.', 'parse_error', true);
  }

  return data as GradeResponse;
}

interface ErrorBody {
  error: string;
  code: string;
  retryAfterSeconds?: number;
}

async function readErrorBody(error: unknown): Promise<ErrorBody | null> {
  const ctx = (error as { context?: unknown }).context;
  if (!ctx || typeof (ctx as Response).json !== 'function') return null;
  try {
    const parsed = (await (ctx as Response).json()) as Partial<ErrorBody>;
    if (typeof parsed?.error === 'string') {
      return {
        error: parsed.error,
        code: typeof parsed.code === 'string' ? parsed.code : 'server_error',
        retryAfterSeconds: parsed.retryAfterSeconds,
      };
    }
  } catch {
    // Body was not JSON — fall through to the generic message.
  }
  return null;
}

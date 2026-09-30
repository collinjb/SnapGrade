/** Mirrors local assignments and results into Supabase.
 *
 *  The device is the source of truth while you are scanning a stack — every
 *  write here is best-effort and never blocks the capture loop. Failures are
 *  logged and retried on the next sync pass rather than surfaced as errors. */
import { readBytes } from './media';
import { supabase, supabaseConfigured, ensureSession } from './supabase';
import { computeTotals } from './scoring';
import type { Assignment, ScanResult } from '@/types';

export const SCANS_BUCKET = 'scans';

/** Upload the page image under `<user-id>/<assignment>/<result>.jpg`, which is
 *  the path shape the storage RLS policies expect. Returns the object path. */
export async function uploadScanImage(
  userId: string,
  result: ScanResult,
): Promise<string | null> {
  try {
    const bytes = await readBytes(result.imageUri);
    if (!bytes) return null;
    const path = `${userId}/${result.assignmentId}/${result.id}.jpg`;
    const { error } = await supabase.storage.from(SCANS_BUCKET).upload(path, bytes, {
      contentType: 'image/jpeg',
      upsert: true,
    });
    if (error) {
      console.warn('[snapgrade] image upload failed:', error.message);
      return null;
    }
    return path;
  } catch (e) {
    console.warn('[snapgrade] image upload threw:', e);
    return null;
  }
}

export async function syncAssignment(assignment: Assignment): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const userId = await ensureSession();
  if (!userId) return null;

  const { data, error } = await supabase
    .from('assignments')
    .upsert(
      {
        id: assignment.id,
        user_id: userId,
        name: assignment.name,
        answer_key_mode: assignment.answerKey.mode,
        answer_key_text: assignment.answerKey.text ?? null,
        created_at: new Date(assignment.createdAt).toISOString(),
      },
      { onConflict: 'id' },
    )
    .select('id')
    .single();

  if (error) {
    console.warn('[snapgrade] assignment sync failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

export async function syncResult(
  result: ScanResult,
  opts: { uploadImage: boolean },
): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const userId = await ensureSession();
  if (!userId) return null;

  const totals = computeTotals(result.problems);
  const imagePath = opts.uploadImage ? await uploadScanImage(userId, result) : null;

  const { error } = await supabase.from('results').upsert(
    {
      id: result.id,
      user_id: userId,
      assignment_id: result.assignmentId,
      student_name: result.studentName,
      total_earned: totals.earned,
      total_possible: totals.possible,
      needs_review_count: totals.needsReview,
      image_path: imagePath,
      created_at: new Date(result.createdAt).toISOString(),
    },
    { onConflict: 'id' },
  );

  if (error) {
    console.warn('[snapgrade] result sync failed:', error.message);
    return null;
  }

  // Replace the problem rows wholesale: overrides make them mutable, and a
  // page never has enough problems for the delete+insert to matter.
  const { error: delError } = await supabase.from('problems').delete().eq('result_id', result.id);
  if (delError) console.warn('[snapgrade] problem cleanup failed:', delError.message);

  const rows = result.problems.map((p, i) => ({
    result_id: result.id,
    user_id: userId,
    position: i,
    number: p.number,
    question_text: p.question_text,
    student_answer: p.student_answer,
    correct_answer: p.correct_answer,
    status: p.status,
    override_status: p.override ?? null,
    points_earned: p.points_earned,
    points_possible: p.points_possible,
    explanation: p.explanation,
    confidence: p.confidence,
    bbox: p.bbox,
  }));

  if (rows.length > 0) {
    const { error: insError } = await supabase.from('problems').insert(rows);
    if (insError) console.warn('[snapgrade] problem sync failed:', insError.message);
  }

  return result.id;
}

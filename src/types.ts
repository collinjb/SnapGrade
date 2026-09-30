/** Shared domain types. The grading shapes mirror the JSON contract the
 *  edge function enforces on Claude's output (see supabase/functions/grade-paper/prompt.ts). */

export type ProblemStatus = 'correct' | 'incorrect' | 'partial' | 'needs_review';

/** A point normalized to the camera frame or page: 0–1 on each axis, origin
 *  at the top-left. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Page corners, clockwise from top-left. */
export type Corners = [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];

/** The detected page, in source-image pixel coordinates. */
export interface Quad {
  topLeft: NormalizedPoint;
  topRight: NormalizedPoint;
  bottomRight: NormalizedPoint;
  bottomLeft: NormalizedPoint;
}

/** Normalized (0–1) position of a problem on the page, origin at top-left. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GradedProblem {
  number: string;
  question_text: string;
  student_answer: string;
  correct_answer: string;
  status: ProblemStatus;
  points_earned: number;
  points_possible: number;
  /** One short sentence; empty when the answer is correct. */
  explanation: string;
  /** 0–1. Anything below CONFIDENCE_FLOOR is surfaced as "Needs review". */
  confidence: number;
  bbox: BBox;
}

export interface GradedPaper {
  student_name: string | null;
  problems: GradedProblem[];
  total_earned: number;
  total_possible: number;
}

/** A problem after the user has had a chance to override it. */
export interface ScoredProblem extends GradedProblem {
  /** Set when the user manually marked this problem; wins over `status`. */
  override?: 'correct' | 'incorrect';
}

export type AnswerKeyMode = 'ai' | 'scan' | 'typed';

export interface AnswerKey {
  mode: AnswerKeyMode;
  /** Mode C: raw text the user typed, e.g. "1: 42\n2: x=3". */
  text?: string;
  /** Mode B: base64 JPEG of the completed key (no data: prefix). */
  imageBase64?: string;
  /** Local file URI for the key thumbnail, when we still have one. */
  imageUri?: string;
  updatedAt: number;
}

export interface Assignment {
  id: string;
  name: string;
  createdAt: number;
  answerKey: AnswerKey;
  /** Remote row id once synced; null while offline-only. */
  remoteId?: string | null;
}

export interface ScanResult {
  id: string;
  assignmentId: string;
  createdAt: number;
  /** Local file URI of the processed page image. */
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  studentName: string;
  /** True while the name is still the auto-assigned "Student N" placeholder. */
  studentNameIsPlaceholder: boolean;
  problems: ScoredProblem[];
  /** Totals as returned by Claude, before overrides. */
  rawTotalEarned: number;
  rawTotalPossible: number;
  remoteId?: string | null;
}

/** Where a captured page is in the background pipeline.
 *
 *  Capture never blocks on grading: every shot goes straight into this queue
 *  and the camera stays live, so a stack of papers can be scanned as fast as
 *  they can be laid down. */
export type PendingStatus =
  /** Queued, or waiting out a retry backoff. */
  | 'waiting'
  /** Being de-skewed, contrast-boosted and compressed. */
  | 'processing'
  /** In flight to the grader. */
  | 'grading'
  /** Out of retries, or rejected outright. Waits for the user to decide. */
  | 'failed';

export interface PendingScan {
  id: string;
  assignmentId: string;
  createdAt: number;
  /** The raw photo until `processed`, then the processed page. */
  imageUri: string;
  imageWidth: number;
  imageHeight: number;
  /** Detected page corners; consumed by the processing step, then cleared. */
  quad: Quad | null;
  /** True once the image pipeline has run, so a retry does not redo it. */
  processed: boolean;
  status: PendingStatus;
  attempts: number;
  /** Epoch ms before which no further attempt should be made. */
  nextAttemptAt?: number;
  lastError?: string;
}

export interface Settings {
  /** Award partial credit when work is shown. Off by default. */
  partialCredit: boolean;
  /** Capture automatically once the page is framed and steady. */
  autoCapture: boolean;
  /** Which capture pipeline to use. */
  scanEngine: 'vision' | 'native';
  /** Upload page images to Supabase Storage as well as keeping them locally. */
  uploadImages: boolean;
  hapticsEnabled: boolean;
  /** Below this, a problem is downgraded to "needs_review" regardless of status. */
  confidenceFloor: number;
}

export interface GradeRequest {
  imageBase64: string;
  answerKeyMode: AnswerKeyMode;
  answerKeyText?: string;
  answerKeyImageBase64?: string;
  partialCredit: boolean;
}

export interface GradeResponse {
  ok: true;
  result: GradedPaper;
  meta: { model: string; latencyMs: number; retried: boolean };
}

export interface GradeError {
  ok: false;
  error: string;
  code:
    | 'rate_limited'
    | 'unauthorized'
    | 'bad_request'
    | 'upstream_error'
    | 'parse_error'
    | 'server_error';
  retryAfterSeconds?: number;
}

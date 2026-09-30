/**
 * Smoke tests for SnapGrade's pure logic: model-output parsing, score
 * arithmetic with overrides, auto-capture gating, and CSV formatting.
 *
 * These are the parts that decide a student's grade, so they are the parts
 * worth pinning down. Everything imported here is free of native modules by
 * design — run with `npm test`.
 */
import assert from 'node:assert/strict';
import { parseGraded, extractJsonObject } from '../supabase/functions/grade-paper/parse';
import {
  assignmentStats,
  computeTotals,
  cycleOverride,
  effectiveStatus,
  normalizeGraded,
} from '../src/lib/scoring';
import {
  MotionOnlyTracker,
  StabilityTracker,
  drift,
  quadAreaFraction,
  skew,
} from '../src/lib/autoCapture';
import { buildDetailCsv, buildSummaryCsv, csvCell, exportFileName } from '../src/lib/csvFormat';
import { queueCounts } from '../src/lib/queueCounts';
import { GRID_H, GRID_W, detectPageInLuma, otsuThreshold, rgbaToLuma } from '../src/lib/pageDetect';
import type { Assignment, Corners, PendingScan, ScanResult, ScoredProblem } from '../src/types';

let passed = 0;
let failed = 0;

function t(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===========================================================================
// parse.ts — the model's output is untrusted input
// ===========================================================================

const goodJson = `{
  "student_name": "Maya R.",
  "problems": [
    {"number":"1","question_text":"$\\\\frac{3}{4}+\\\\frac{1}{4}$","student_answer":"1",
     "correct_answer":"1","status":"correct","points_earned":1,"points_possible":1,
     "explanation":"","confidence":0.97,"bbox":{"x":0.1,"y":0.1,"w":0.3,"h":0.08}},
    {"number":"2","question_text":"2x+6=14","student_answer":"x=10","correct_answer":"x=4",
     "status":"incorrect","points_earned":0,"points_possible":1,
     "explanation":"Added 6 instead of subtracting.","confidence":0.93,
     "bbox":{"x":0.1,"y":0.2,"w":0.3,"h":0.08}}
  ],
  "total_earned": 1, "total_possible": 2
}`;

t('parses a clean response', () => {
  const p = parseGraded(goodJson);
  assert.ok(p);
  assert.equal(p.student_name, 'Maya R.');
  assert.equal(p.problems.length, 2);
  assert.equal(p.total_earned, 1);
  assert.equal(p.total_possible, 2);
});

t('strips code fences and surrounding prose', () => {
  const p = parseGraded('Sure! Here you go:\n```json\n' + goodJson + '\n```\nHope that helps.');
  assert.ok(p);
  assert.equal(p.problems.length, 2);
});

t('survives the assistant prefill being prepended', () => {
  const p = parseGraded('{' + goodJson.slice(1));
  assert.ok(p);
  assert.equal(p.problems.length, 2);
});

t('repairs a trailing comma', () => {
  const p = parseGraded('{"student_name":null,"problems":[],"total_earned":0,"total_possible":0,}');
  assert.ok(p);
  assert.equal(p.problems.length, 0);
});

t('ignores braces inside strings', () => {
  const raw =
    '{"student_name":"a}b{c","problems":[],"total_earned":0,"total_possible":0} trailing junk }';
  const extracted = extractJsonObject(raw);
  assert.ok(extracted);
  assert.equal(extracted.at(-1), '}');
  assert.ok(parseGraded(raw));
});

t('rejects output with no object at all', () => {
  assert.equal(parseGraded('I cannot read this page.'), null);
  assert.equal(parseGraded(''), null);
});

t('rejects a truncated object rather than half-parsing it', () => {
  assert.equal(parseGraded('{"student_name":"A","problems":[{"number":"1"'), null);
});

t('recomputes totals instead of trusting the model arithmetic', () => {
  const p = parseGraded(
    '{"student_name":null,"problems":[' +
      '{"number":"1","status":"correct","points_earned":0,"points_possible":2,"confidence":0.9},' +
      '{"number":"2","status":"incorrect","points_earned":5,"points_possible":2,"confidence":0.9}' +
      '],"total_earned":99,"total_possible":99}',
  );
  assert.ok(p);
  // Status wins over points: "correct" is forced to full marks and
  // "incorrect" to zero, so the two can never disagree.
  assert.equal(p.problems[0]!.points_earned, 2);
  assert.equal(p.problems[1]!.points_earned, 0);
  assert.equal(p.total_earned, 2);
  assert.equal(p.total_possible, 4);
});

t('coerces junk fields rather than throwing', () => {
  const p = parseGraded(
    '{"student_name":123,"problems":[{"number":7,"status":"banana","points_possible":"3",' +
      '"points_earned":"1.5","confidence":"2","bbox":{"x":1.4,"y":-3,"w":9,"h":9}}],' +
      '"total_earned":0,"total_possible":0}',
  );
  assert.ok(p);
  const q = p.problems[0]!;
  assert.equal(p.student_name, null); // a number is not a name
  assert.equal(q.number, '7');
  assert.equal(q.status, 'needs_review'); // an unknown status is not trusted
  assert.equal(q.points_possible, 3);
  assert.equal(q.points_earned, 0); // needs_review always scores zero
  assert.equal(q.confidence, 1); // clamped into 0–1
  assert.equal(q.bbox.x, 1);
  assert.equal(q.bbox.y, 0);
  assert.equal(q.bbox.w, 0); // clamped to 1 - x, so marks stay on the page
});

t('treats the literal string "null" as no name', () => {
  const p = parseGraded('{"student_name":"null","problems":[],"total_earned":0,"total_possible":0}');
  assert.equal(p!.student_name, null);
});

t('keeps partial credit when it is switched on', () => {
  const p = parseGraded(
    '{"student_name":null,"problems":[{"number":"1","status":"partial","points_earned":0.5,' +
      '"points_possible":1,"confidence":0.8}],"total_earned":0.5,"total_possible":1}',
  );
  assert.equal(p!.problems[0]!.points_earned, 0.5);
  assert.equal(p!.total_earned, 0.5);
});

t('collapses partial to incorrect when partial credit is off', () => {
  const p = parseGraded(
    '{"student_name":null,"problems":[{"number":"1","status":"partial","points_earned":0.5,' +
      '"points_possible":2,"confidence":0.9}],"total_earned":0.5,"total_possible":2}',
    { allowPartial: false },
  );
  assert.equal(p!.problems[0]!.status, 'incorrect');
  assert.equal(p!.problems[0]!.points_earned, 0);
  assert.equal(p!.total_earned, 0);
});

// ===========================================================================
// scoring.ts — what the teacher actually sees
// ===========================================================================

const problem = (over: Partial<ScoredProblem> = {}): ScoredProblem => ({
  number: '1',
  question_text: 'q',
  student_answer: 'a',
  correct_answer: 'a',
  status: 'correct',
  points_earned: 1,
  points_possible: 1,
  explanation: '',
  confidence: 0.9,
  bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
  ...over,
});

t('totals a straightforward paper', () => {
  const totals = computeTotals([
    problem(),
    problem({ number: '2', status: 'incorrect', points_earned: 0 }),
    problem({ number: '3', status: 'partial', points_earned: 0.5, points_possible: 2 }),
  ]);
  assert.equal(totals.earned, 1.5);
  assert.equal(totals.possible, 4);
  assert.equal(totals.percent, 38);
  assert.equal(totals.correct, 1);
  assert.equal(totals.incorrect, 1);
  assert.equal(totals.partial, 1);
});

t('an unresolved needs_review scores zero but still counts toward possible', () => {
  const totals = computeTotals([problem({ status: 'needs_review', points_earned: 1 })]);
  assert.equal(totals.earned, 0);
  assert.equal(totals.possible, 1);
  assert.equal(totals.needsReview, 1);
});

t('an override beats the model verdict and repoints immediately', () => {
  const p = problem({ status: 'needs_review', points_possible: 2, override: 'correct' });
  assert.equal(effectiveStatus(p), 'correct');
  assert.equal(computeTotals([p]).earned, 2);

  const wrong = problem({ status: 'correct', override: 'incorrect' });
  assert.equal(effectiveStatus(wrong), 'incorrect');
  assert.equal(computeTotals([wrong]).earned, 0);
});

t('override cycles correct -> incorrect -> back to the AI grade', () => {
  assert.equal(cycleOverride(undefined), 'correct');
  assert.equal(cycleOverride('correct'), 'incorrect');
  assert.equal(cycleOverride('incorrect'), undefined);
});

t('a zero-point paper does not divide by zero', () => {
  assert.equal(computeTotals([]).percent, 0);
  assert.equal(computeTotals([problem({ points_possible: 0, points_earned: 0 })]).percent, 0);
});

t('low confidence is downgraded to needs_review', () => {
  const normalized = normalizeGraded(
    {
      student_name: null,
      total_earned: 2,
      total_possible: 2,
      problems: [problem(), problem({ number: '2', confidence: 0.3 })],
    },
    0.6,
  );
  assert.equal(normalized[0]!.status, 'correct');
  assert.equal(normalized[1]!.status, 'needs_review');
  assert.equal(normalized[1]!.points_earned, 0);
});

t('normalize clamps out-of-range points and bboxes', () => {
  const normalized = normalizeGraded(
    {
      student_name: null,
      total_earned: 0,
      total_possible: 0,
      problems: [
        { ...problem(), points_earned: 99, points_possible: 2, bbox: { x: 0.9, y: 0.9, w: 5, h: 5 } },
      ],
    },
    0.5,
  );
  const q = normalized[0]!;
  assert.equal(q.points_earned, 2);
  assert.ok(q.bbox.x + q.bbox.w <= 1.0001);
  assert.ok(q.bbox.y + q.bbox.h <= 1.0001);
});

const scan = (id: string, statuses: ScoredProblem['status'][]): ScanResult => ({
  id,
  assignmentId: 'a',
  createdAt: 0,
  imageUri: '',
  imageWidth: 100,
  imageHeight: 100,
  studentName: id,
  studentNameIsPlaceholder: false,
  rawTotalEarned: 0,
  rawTotalPossible: 0,
  problems: statuses.map((s, i) =>
    problem({ number: String(i + 1), status: s, points_earned: s === 'correct' ? 1 : 0 }),
  ),
});

t('class stats rank the most-missed problems', () => {
  const stats = assignmentStats([
    scan('s1', ['correct', 'incorrect', 'incorrect']),
    scan('s2', ['correct', 'correct', 'incorrect']),
    scan('s3', ['correct', 'incorrect', 'incorrect']),
  ]);

  assert.equal(stats.count, 3);
  assert.equal(stats.average, 44); // 33 + 67 + 33, averaged and rounded
  assert.equal(stats.mostMissed[0]!.number, '3'); // missed by everyone
  assert.equal(stats.mostMissed[0]!.missed, 3);
  assert.ok(!stats.mostMissed.some((m) => m.number === '1')); // nobody missed it
});

t('stats on an empty assignment are empty, not NaN', () => {
  const stats = assignmentStats([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.average, null);
  assert.deepEqual(stats.mostMissed, []);
});

// ===========================================================================
// autoCapture.ts — when the shutter is allowed to fire
// ===========================================================================

const quad = (inset: number, dx = 0, dy = 0): Corners => [
  { x: inset + dx, y: inset + dy },
  { x: 1 - inset + dx, y: inset + dy },
  { x: 1 - inset + dx, y: 1 - inset + dy },
  { x: inset + dx, y: 1 - inset + dy },
];

const tapered: Corners = [
  { x: 0.3, y: 0.05 },
  { x: 0.7, y: 0.05 },
  { x: 0.98, y: 0.95 },
  { x: 0.02, y: 0.95 },
];

t('quad area is the shoelace area', () => {
  assert.ok(Math.abs(quadAreaFraction(quad(0.1)) - 0.64) < 1e-9);
});

t('a flat rectangle has no skew; a tapered one does', () => {
  assert.ok(skew(quad(0.1)) < 1e-9);
  assert.ok(skew(tapered) > 0.3);
});

t('drift is the worst corner movement', () => {
  assert.ok(Math.abs(drift(quad(0.1), quad(0.1, 0.05)) - 0.05) < 1e-9);
});

t('a steady framed page fires after the hold window, not before', () => {
  const tracker = new StabilityTracker();
  const page = quad(0.12);
  let now = 100_000;

  const first = tracker.push({ corners: page, confidence: 0.9, t: now }, 0.05);
  assert.equal(first.readiness, 'hold-still'); // the first sample has no baseline
  assert.equal(first.shouldCapture, false);

  let fired = false;
  for (let i = 0; i < 12 && !fired; i++) {
    now += 100;
    const e = tracker.push({ corners: page, confidence: 0.9, t: now }, 0.05);
    fired = e.shouldCapture;
    if (!fired) assert.ok(e.progress < 1);
  }
  assert.ok(fired, 'should capture within ~1.2s of steady framing');
});

t('a shaking hand never fires', () => {
  const tracker = new StabilityTracker();
  const page = quad(0.12);
  let now = 200_000;
  for (let i = 0; i < 30; i++) {
    now += 100;
    const e = tracker.push({ corners: page, confidence: 0.9, t: now }, 1.4);
    assert.equal(e.shouldCapture, false);
    assert.equal(e.readiness, 'hold-still');
  }
});

t('a page too far, too close or skewed reports why', () => {
  const tracker = new StabilityTracker();
  const t0 = 300_000;
  assert.equal(tracker.push({ corners: quad(0.42), confidence: 0.9, t: t0 }, 0).readiness, 'too-far');
  assert.equal(
    tracker.push({ corners: quad(0.002), confidence: 0.9, t: t0 + 100 }, 0).readiness,
    'too-close',
  );
  assert.equal(
    tracker.push({ corners: tapered, confidence: 0.9, t: t0 + 200 }, 0).readiness,
    'skewed',
  );
});

t('low detector confidence reads as no page', () => {
  const tracker = new StabilityTracker();
  assert.equal(
    tracker.push({ corners: quad(0.12), confidence: 0.2, t: 400_000 }, 0).readiness,
    'searching',
  );
});

t('the cooldown stops one page triggering a burst', () => {
  const tracker = new StabilityTracker(1500);
  const page = quad(0.12);
  let now = 500_000;
  let fired = 0;
  for (let i = 0; i < 20; i++) {
    now += 100;
    if (tracker.push({ corners: page, confidence: 0.9, t: now }, 0.05).shouldCapture) fired++;
  }
  assert.equal(fired, 1, 'exactly one capture in a 2s steady run');
});

t('a page left in frame is never scanned twice, however long it sits', () => {
  const tracker = new StabilityTracker(1500);
  const page = quad(0.12);
  let now = 700_000;
  let fired = 0;

  // Thirty seconds of the same sheet lying there under a steady hand.
  for (let i = 0; i < 300; i++) {
    now += 100;
    const e = tracker.push({ corners: page, confidence: 0.9, t: now }, 0.02);
    if (e.shouldCapture) fired++;
  }
  assert.equal(fired, 1, 'the sheet is graded once, not every cooldown');
});

t('swapping in the next sheet arms the shutter again', () => {
  const tracker = new StabilityTracker(1500);
  let now = 800_000;
  const first = quad(0.12);

  let fired = 0;
  const feed = (corners: Corners | null, ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      now += 100;
      const e = tracker.push(
        corners ? { corners, confidence: 0.9, t: now } : null,
        0.02,
      );
      if (e.shouldCapture) fired++;
    }
  };

  feed(first, 20); // grabs sheet one
  assert.equal(fired, 1);

  feed(null, 5); // the sheet is lifted away
  feed(quad(0.12, 0.2), 20); // the next sheet lands, offset from the first
  assert.equal(fired, 2, 'the second sheet should be graded too');
});

t('the tracker says to swap the page rather than going quiet', () => {
  const tracker = new StabilityTracker(1500);
  const page = quad(0.12);
  let now = 900_000;
  for (let i = 0; i < 20; i++) {
    now += 100;
    tracker.push({ corners: page, confidence: 0.9, t: now }, 0.02);
  }
  now += 2000; // past the cooldown, sheet still there
  assert.equal(
    tracker.push({ corners: page, confidence: 0.9, t: now }, 0.02).readiness,
    'swap-page',
  );
});

// ===========================================================================
// the background queue
// ===========================================================================

const pendingScan = (over: Partial<PendingScan> = {}): PendingScan => ({
  id: 'p1',
  assignmentId: 'a',
  createdAt: 0,
  imageUri: 'file:///x.jpg',
  imageWidth: 100,
  imageHeight: 100,
  quad: null,
  processed: false,
  status: 'waiting',
  attempts: 0,
  ...over,
});

t('queue counts split working, waiting and failed', () => {
  const counts = queueCounts([
    pendingScan({ id: '1', status: 'processing' }),
    pendingScan({ id: '2', status: 'grading' }),
    pendingScan({ id: '3', status: 'waiting' }),
    pendingScan({ id: '4', status: 'waiting' }),
    pendingScan({ id: '5', status: 'failed' }),
  ]);
  assert.deepEqual(counts, { working: 2, waiting: 2, failed: 1, total: 5 });
});

t('an empty queue counts to zero', () => {
  assert.deepEqual(queueCounts([]), { working: 0, waiting: 0, failed: 0, total: 0 });
});

t('the motion-only fallback will not fire unless armed', () => {
  const tracker = new MotionOnlyTracker();
  let now = 600_000;
  for (let i = 0; i < 20; i++) {
    now += 100;
    assert.equal(tracker.push(0.01, false, now).shouldCapture, false);
  }
  let fired = false;
  for (let i = 0; i < 12 && !fired; i++) {
    now += 100;
    fired = tracker.push(0.01, true, now).shouldCapture;
  }
  assert.ok(fired, 'armed and still should eventually capture');
});

// ===========================================================================
// pageDetect.ts — the detector behind auto-capture on web and Android
// ===========================================================================

/** A synthetic frame: a bright page on a dark background. */
function frameWithPage(
  box: { x: number; y: number; w: number; h: number },
  opts: { page?: number; background?: number; noise?: number } = {},
): Uint8Array {
  const { page = 225, background = 40, noise = 0 } = opts;
  const luma = new Uint8Array(GRID_W * GRID_H);
  // Deterministic pseudo-noise: a test that fails one run in ten is useless.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const nx = x / GRID_W;
      const ny = y / GRID_H;
      const inside = nx >= box.x && nx < box.x + box.w && ny >= box.y && ny < box.y + box.h;
      const base = inside ? page : background;
      luma[y * GRID_W + x] = Math.max(0, Math.min(255, base + rand() * noise));
    }
  }
  return luma;
}

t('otsu splits a two-peak histogram between the peaks', () => {
  const hist = new Int32Array(256);
  hist[30] = 500;
  hist[220] = 500;
  const threshold = otsuThreshold(hist, 1000);
  // The implementation biases 6 low, so allow for that.
  assert.ok(threshold > 30 && threshold < 220, `threshold was ${threshold}`);
});

t('finds a centred page and reports where it is', () => {
  const found = detectPageInLuma(frameWithPage({ x: 0.2, y: 0.12, w: 0.6, h: 0.76 }));
  assert.ok(found, 'should have found the page');
  const [tl, tr, br, bl] = found.corners;
  assert.ok(Math.abs(tl.x - 0.2) < 0.03, `left edge at ${tl.x}`);
  assert.ok(Math.abs(tl.y - 0.12) < 0.03, `top edge at ${tl.y}`);
  assert.ok(Math.abs(tr.x - 0.8) < 0.03, `right edge at ${tr.x}`);
  assert.ok(Math.abs(bl.y - 0.88) < 0.03, `bottom edge at ${bl.y}`);
  assert.equal(br.x, tr.x);
  assert.ok(found.confidence > 0.6, `confidence was ${found.confidence}`);
});

t('survives sensor noise', () => {
  const found = detectPageInLuma(
    frameWithPage({ x: 0.18, y: 0.1, w: 0.64, h: 0.8 }, { noise: 40 }),
  );
  assert.ok(found, 'noise should not hide the page');
  assert.ok(Math.abs(found.corners[0].x - 0.18) < 0.06);
});

t('ignores a page too small to be the worksheet', () => {
  assert.equal(detectPageInLuma(frameWithPage({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })), null);
});

t('ignores a shape with the wrong aspect for paper', () => {
  // A long thin bright strip: a ruler, a window frame, a desk edge.
  assert.equal(detectPageInLuma(frameWithPage({ x: 0.02, y: 0.4, w: 0.96, h: 0.14 })), null);
});

t('reports nothing for a blank frame', () => {
  assert.equal(detectPageInLuma(new Uint8Array(GRID_W * GRID_H)), null); // lens covered
  assert.equal(detectPageInLuma(new Uint8Array(GRID_W * GRID_H).fill(255)), null); // all sky
});

t('rejects a buffer that is too small rather than reading past it', () => {
  assert.equal(detectPageInLuma(new Uint8Array(10)), null);
});

t('bright clutter beside the page lowers confidence', () => {
  const page = { x: 0.32, y: 0.12, w: 0.5, h: 0.76 };
  const clean = detectPageInLuma(frameWithPage(page));

  // A second bright object in shot — a window, a whiteboard, a lamp. The
  // detector should still find something, but be less sure about it.
  const cluttered = frameWithPage(page);
  for (let y = Math.floor(GRID_H * 0.3); y < Math.floor(GRID_H * 0.7); y++) {
    for (let x = 0; x < Math.floor(GRID_W * 0.2); x++) cluttered[y * GRID_W + x] = 235;
  }
  const messy = detectPageInLuma(cluttered);

  assert.ok(clean, 'the clean frame should be found');
  assert.equal(clean.confidence, 1);
  if (messy) {
    assert.ok(
      messy.confidence < clean.confidence,
      `cluttered ${messy.confidence} should be under clean ${clean.confidence}`,
    );
  }
});

t('a low-contrast page under noise is never reported as certain', () => {
  // Paper on a pale desk, with sensor noise blurring the two together.
  const found = detectPageInLuma(
    frameWithPage({ x: 0.2, y: 0.12, w: 0.6, h: 0.76 }, { page: 250, background: 215, noise: 45 }),
  );
  if (found) {
    assert.ok(found.confidence < 1, `confidence was ${found.confidence}`);
  }
});

t('rgba converts to luma with Rec. 601 weights', () => {
  // white, black, pure red, pure green
  const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  const luma = rgbaToLuma(rgba, 4);
  assert.equal(luma[0], 255);
  assert.equal(luma[1], 0);
  // Green reads much brighter than red, which is the whole point of weighting.
  assert.ok(luma[3]! > luma[2]! * 1.8, `red ${luma[2]}, green ${luma[3]}`);
});

// ===========================================================================
// csvFormat.ts
// ===========================================================================

t('csv quoting follows RFC 4180', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('has,comma'), '"has,comma"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(0), '0');
});

t('csv export renders both shapes', () => {
  const results: ScanResult[] = [
    {
      ...scan('r1', ['correct', 'incorrect']),
      studentName: 'Ada, L',
    },
  ];
  results[0]!.problems[1]!.explanation = 'Sign error';

  const summary = buildSummaryCsv(results);
  assert.ok(summary.startsWith('Student,Score,Possible,Percent,Needs review,Scanned at'));
  assert.ok(summary.includes('"Ada, L",1,2,50%'));

  const detail = buildDetailCsv(results);
  assert.equal(detail.split('\r\n').length, 3); // header + two problems
  assert.ok(detail.includes('Sign error'));
});

t('csv detail reflects a manual override', () => {
  const results = [scan('r1', ['incorrect'])];
  results[0]!.problems[0]!.override = 'correct';
  const detail = buildDetailCsv(results);
  const row = detail.split('\r\n')[1]!;
  assert.ok(row.includes(',correct,'), 'status column should show the override');
  assert.ok(row.endsWith(',yes'), 'override column should be flagged');
});

t('export filenames are filesystem-safe', () => {
  const assignment: Assignment = {
    id: 'a',
    name: 'Quiz: "Unit 3" / period 2',
    createdAt: 0,
    answerKey: { mode: 'ai', updatedAt: 0 },
  };
  assert.equal(exportFileName(assignment, 'summary'), 'Quiz-Unit-3-period-2-summary.csv');
  assert.equal(
    exportFileName({ ...assignment, name: '***' }, 'detail'),
    'assignment-detail.csv',
  );
});

// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

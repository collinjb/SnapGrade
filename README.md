# SnapGrade

Point your phone at a paper math test and get it graded. The app opens
straight to a camera, grabs the page automatically once it is framed and
steady, and comes back with a score, marks on the page, and a one-line
explanation of every mistake. One tap returns you to the camera for the next
paper.

- **Expo (React Native, TypeScript)** on the device
- **Supabase** for auth, storage and the Edge Function that talks to Claude
- **Claude Sonnet 5.5** does the grading. The API key never leaves the server.

Ships two ways: a native iOS/Android app, and an installable **PWA** you can
add to the home screen without building anything. Same code, same screens —
see [Running it as a web app](#running-it-as-a-web-app).

---

## The loop

```
         ┌─── camera stays live, shutter stays armed ───┐
         │                                              │
  auto-capture ──▶ [ pending queue ]                    │
                        │  x3 workers                   │
                        ▼                               │
        de-skew + contrast + resize                     │
                        ▼                               │
          grade-paper (Edge Function) ──▶ Claude        │
                        ▼                               │
              score lands in the tray ──────────────────┘
                        │
                   tap a chip ──▶ results overlay
```

**Capture never waits on grading.** There is no confirm step, no retake
prompt and no blocking "Grading…" screen: the shot flashes, drops into the
background queue, and the shutter is free again. Fire off a whole stack and
the scores come back into the tray above the shutter as they finish — up to
three grading at once, the rest queued.

Everything else — assignments, the answer key, the class summary, CSV export
— hangs off that loop rather than interrupting it.

---

## Which build do I want?

| | Native app | Web app (PWA) |
| --- | --- | --- |
| To install | Xcode / Android Studio, or an EAS build | Open a URL, Add to Home Screen |
| Page de-skew | True keystone correction (iOS) | Crop to the page, like Android |
| System document scanner | Yes | No |
| Auto-capture | Native detector | Same algorithm, in a canvas |
| Haptics | Yes | Android only |
| Everything else | — | Identical |

Start with the PWA. It needs no toolchain, and if you outgrow it the native
build is the same project.

---

## Quick start

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your Supabase URL and anon key, then set up the backend
(below) and build a dev client:

```bash
npx expo prebuild --clean
npx expo run:ios     # or: npx expo run:android
```

Expo Go will not work — the app needs VisionCamera, MMKV and Skia, which are
native modules. A development build is required.

---

## Running it as a web app

```bash
npm run build:web      # -> dist/
```

Serve `dist/` from **the root of an HTTPS origin** and open it on your phone.
Any static host works — Netlify, Vercel, Cloudflare Pages, GitHub Pages,
`npx serve dist` behind a tunnel.

- **iOS**: Safari → Share → *Add to Home Screen*. (Only Safari can do this;
  Chrome on iOS cannot.) Camera access from an installed PWA needs iOS 14.3+.
- **Android**: Chrome will offer *Install app*, or ⋮ → *Add to Home screen*.

Once installed it launches chromeless in portrait, straight to the camera.

**HTTPS is not optional.** `getUserMedia` and service workers both require a
secure context, so the camera simply will not appear over plain HTTP.
`http://localhost` is exempt, which is what makes local testing work.

### Deploying under a subpath

The bundle is referenced from `/_expo/...`, so a root-path deploy is the
simple case. For something like `https://example.com/snapgrade/`, tell Expo:

```json
{ "expo": { "experiments": { "baseUrl": "/snapgrade" } } }
```

then rebuild. The manifest, icons and service worker are all referenced
relatively and need no change.

### For local development

```bash
npm run web            # expo start --web
```

Note that `npm run web` serves over HTTP on your machine's LAN address, where
the camera will be blocked. Test the camera either on `localhost` itself or
against a real HTTPS deploy.

### What the web build is doing differently

Everything platform-specific sits behind a `.web.ts` file, so the screens,
the store, the grading pipeline and the prompt are all shared:

| Concern | Native | Web |
| --- | --- | --- |
| Camera | `react-native-vision-camera` | `getUserMedia` into a `<video>` |
| Page detection | Vision (iOS) / Kotlin plugin (Android) | `pageDetect.ts` over a 96x96 canvas |
| De-skew + contrast | Skia homography | Canvas crop + contrast |
| Page storage | Cache directory | IndexedDB, surfaced as object URLs |
| Settings + queue | MMKV | `localStorage` |
| Haptics | expo-haptics | Vibration API (nothing on iOS) |
| Steadiness | Gyroscope | `devicemotion`, optional |
| CSV export | Native share sheet | Web Share API, else a download |

The Android detector in `DocumentDetectorPlugin.kt` and the web detector in
`src/lib/pageDetect.ts` are deliberate twins — same algorithm, same
constants. `pageDetect.ts` is the one with tests; keep them in step.

The icons are generated, not hand-drawn:

```bash
npm run icons          # rewrites public/icons/*.png
```

---

## 1. Supabase setup

### Create the project

Make a project at [supabase.com](https://supabase.com), then link it:

```bash
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
```

### Push the schema

```bash
npx supabase db push
```

This creates `assignments`, `results`, `problems` and `api_usage`, the
`check_rate_limit` function, the private `scans` storage bucket, and
row-level security on all of it. Every table is scoped to `auth.uid()`, so
the anon key shipped in the app can only ever reach that user's own rows.

### Enable anonymous sign-in

Dashboard → **Authentication → Sign In / Providers → Anonymous sign-ins** →
on. This is what makes the first launch frictionless: no account, no login
wall, and the same user can be upgraded to email later without losing data.

### Set the Anthropic key as a secret

```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

Optionally tune the per-user budget:

```bash
npx supabase secrets set RATE_LIMIT_PER_MINUTE=12 RATE_LIMIT_PER_DAY=400
```

**Never put the Anthropic key in `.env`, `app.json`, or anything with an
`EXPO_PUBLIC_` prefix** — those are bundled into the app and readable by
anyone who downloads it.

### Deploy the Edge Function

```bash
npx supabase functions deploy grade-paper
```

To iterate locally instead:

```bash
cp supabase/.env.local.example supabase/.env.local   # add your key
npx supabase functions serve grade-paper --env-file supabase/.env.local
```

---

## 2. App environment

`.env` in the project root:

```
EXPO_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
```

Both are safe to ship: the anon key only grants what RLS allows. Expo inlines
`EXPO_PUBLIC_*` at build time, so **rebuild after changing them** — a Metro
restart is not enough, and for the web build that means re-running
`npm run build:web` and redeploying.

Without them the app still runs; scans queue locally and grading reports a
clear configuration error.

---

## 3. Building a dev client

### Locally

```bash
npx expo prebuild --clean
npx expo run:ios --device       # a real device: the simulator has no camera
npx expo run:android
```

### With EAS

```bash
npm install -g eas-cli
eas login
eas build --profile development --platform ios     # or android
```

Then `npm start` and scan the QR code from the installed dev client.

`npx expo prebuild --clean` regenerates `ios/` and `android/`, which are
gitignored. The native document detector in `modules/document-detector` is a
**local Expo module** and is picked up automatically by autolinking — there is
no config plugin to register and nothing to add to `MainApplication` or
`AppDelegate`.

---

## How the capture pipeline works

### Auto-capture

`modules/document-detector` registers a VisionCamera frame-processor plugin
called `detectDocument`. It runs at 8fps and returns the page's four corners
plus a confidence, normalized to the frame:

- **iOS** uses `VNDetectRectanglesRequest`, which gives four true corners — so
  iOS gets real perspective correction.
- **Android** uses an Otsu-thresholded luma profile to find the page. It is
  fast and dependency-free, but it returns an **axis-aligned** box, so on
  Android the "warp" is effectively a tight crop. For true de-skewing on
  Android, turn on **Settings → Use the system scanner**, which hands capture
  to ML Kit's document scanner.

`src/lib/autoCapture.ts` holds the decision logic, deliberately as pure
functions: a page must cover 22–97% of the frame, be roughly flat (opposing
edges within 28% of each other), and hold still — corner drift under 1.8% of
the frame *and* gyroscope under 0.35 rad/s — for 700 ms. Then it fires, with a
1.5 s cooldown so one page cannot trigger a burst.

After a capture the tracker **disarms until the page actually changes** —
either the detector loses it, or the quad moves more than 10% of the frame.
Without that, batch scanning would re-grade the same sheet every time the
cooldown expired. The readiness line reads "Next paper" while it waits.

If the native plugin is missing from the build, `detectorMode` reports
`steady-only` and auto-capture falls back to a gyroscope-only hold-still
timer. The manual shutter always works.

### Image processing

`src/lib/pageRender.ts` solves the 8-unknown homography mapping the detected
quad onto a rectangle and draws the photo through it with Skia (an `SkMatrix`
is a full 3×3 homography, so no decomposition is needed), applying a contrast
boost that pushes pencil grey toward black and paper toward white.

`src/lib/imaging.ts` then caps the long edge at 1600px and saves JPEG at
quality 0.8 — a typical worksheet lands under ~350 KB, which is the difference
between a four-second and a twelve-second round trip on cell data.

If Skia is unavailable the pipeline degrades to a bounding-box crop.

---

## The grading prompt

The full system prompt lives in
[`supabase/functions/grade-paper/prompt.ts`](supabase/functions/grade-paper/prompt.ts).
It is assembled per request from the answer-key mode and the partial-credit
setting. In summary, it instructs Claude to:

- **Output only JSON** matching the schema below — no fences, no preamble.
  The request also prefills the assistant turn with `{`, which is the cheapest
  reliable way to keep the response parseable.
- **Read handwriting in context**, treat crossed-out and overwritten work as
  not-the-answer, and look twice before failing an answer over a missing
  negative sign or dropped exponent.
- **Grade mathematical value, not formatting.** `0.5`, `1/2`, `2/4` and `50%`
  are the same value; `x = 3` and `3 = x` are the same answer. An explicit
  instruction in the problem ("simplify", "round to 2dp", "in terms of pi")
  makes the form part of the answer.
- **Flag rather than guess.** Ambiguous handwriting, a blurred or cut-off
  problem, several candidate answers with none marked final, or a problem it
  cannot solve all become `needs_review` — because a teacher can fix a flagged
  problem in one tap, but a confidently wrong grade goes into the gradebook
  unnoticed.
- **Honor partial credit only when it is switched on**, and otherwise treat
  every problem as all-or-nothing.
- **Read the student's name** off the page, or return `null` rather than
  guessing from partial letters.

### Response schema

```json
{
  "student_name": "string | null",
  "problems": [
    {
      "number": "string",
      "question_text": "string",
      "student_answer": "string",
      "correct_answer": "string",
      "status": "correct | incorrect | partial | needs_review",
      "points_earned": 0,
      "points_possible": 1,
      "explanation": "string",
      "confidence": 0.0,
      "bbox": { "x": 0, "y": 0, "w": 0, "h": 0 }
    }
  ],
  "total_earned": 0,
  "total_possible": 0
}
```

`bbox` is normalized 0–1 with the origin at the page's top-left; the results
screen places its check and X marks from it.

### What the server does with the reply

`supabase/functions/grade-paper/parse.ts` treats the output as untrusted:
strips fences, finds the outermost balanced object while ignoring braces
inside strings, repairs a trailing comma, coerces wrong-typed fields, clamps
every number into range, and **recomputes the totals** rather than trusting
the model's arithmetic. A `correct` verdict is forced to full marks and a
`needs_review` to zero, so the status and the points can never disagree.

If parsing still fails, the function shows the model its own bad output and
asks once more, then gives up with a `parse_error` rather than inventing a
grade.

On the device, `src/lib/scoring.ts` applies one more rule: anything below the
confidence floor (60% by default, adjustable in Settings) is downgraded to
`needs_review` regardless of what the model said.

---

## Answer key modes

Chosen once from the pill at the top of the camera, then remembered — and
carried forward into the next assignment.

| Mode | What happens |
| --- | --- |
| **AI solves it** (default) | Claude works each problem and grades against its own solution. Zero setup. |
| **Scan answer key** | Photograph the completed key once. It is sent as a second image alongside every paper, and the prompt tells Claude the first image is authoritative. |
| **Type answers** | `1: 42` / `2: x=3`, one per line. Matched to problems by number; a missing entry falls back to Claude solving that one, with lowered confidence. |

---

## The background queue

Every capture — online or not — goes into the same pipeline in
`src/lib/gradeFlow.ts`. A scan moves `waiting → processing → grading`, and
either lands as a result or goes back to `waiting` with an exponential
backoff (2s, doubling, capped at 60s). Three workers run at once.

- **Rate limiting does not burn an attempt** — it is not the scan's fault, so
  the scan just waits as long as the server asked.
- **Connectivity returning clears every backoff** rather than making a stack
  of scans sit out timers set for a dead network.
- **Image processing is done once.** A retry re-sends the processed JPEG
  rather than re-warping the photo.
- **After five tries a scan goes to `failed`** and stops consuming workers.
  Tap its chip to retry or discard; Settings has bulk retry and discard.
- **The queue is persisted**, so a stack captured on a bad connection is
  still there after a restart. Anything caught mid-flight by the restart is
  reset to `waiting` on rehydrate.

Student labels are assigned inside the store rather than by the worker, so
two grades landing in the same tick can't both be handed "Student 4".

The tray chips show state directly: a spinner while working, an amber clock
while queued, a red `!` on failure, and the score once it lands.

---

## Project layout

```
App.tsx                         navigation: 4 screens, camera as the root
index.ts                        entry point

src/
  screens/
    CameraScreen.tsx            the front door — capture, auto-capture, chrome
    ResultsScreen.tsx           score, marks on the page, per-problem list
    AssignmentSummaryScreen.tsx roster, class average, most-missed, CSV export
    AnswerKeyScreen.tsx         the three key modes
    SettingsScreen.tsx          grading/capture/sync toggles + diagnostics
  components/
    EdgeOverlay.tsx             live page outline (RN Animated, native driver)
    ShutterButton.tsx           manual shutter; the ring is the auto countdown
    ScanTray.tsx                the live queue + finished scores, as chips
    CaptureFlash.tsx            the whole capture acknowledgement
    CameraView.tsx / .web.tsx   preview + shutter + detection, per platform
    MarkOverlay.tsx             tappable ✓ / ✗ / ? positioned from bbox
    ProblemRow.tsx              one problem in the results list
    AnswerKeyPill.tsx           assignment + key mode + scan count
    MathText.tsx                KaTeX in a WebView, only when text is mathy
  lib/
    autoCapture.ts              pure capture-readiness rules
    pageDetect.ts               the page detector (web + twin of the Kotlin one)
    documentDetector.ts         binding to the native frame processor
    pageRender.ts   / .web.ts   homography + Skia warp, or a canvas crop
    imaging.ts      / .web.ts   crop/resize/compress to base64
    media.ts        / .web.ts   where page images and exports live
    motion.ts       / .web.ts   angular speed, for the steadiness gate
    pickPageImage.ts / .web.ts  one-off page photo (the answer key)
    pwa.ts          / .web.ts   manifest, home-screen icons, service worker
    useImageUri.ts  / .web.ts   resolves a stored page into something renderable
    nativeScanner.ts            the OS document-scanner engine
    gradeFlow.ts                the background grading queue and its workers
    queueCounts.ts              pure badge arithmetic over the queue
    api.ts                      the grade-paper call and its error taxonomy
    scoring.ts                  totals, overrides, confidence floor, class stats
    csvFormat.ts                pure CSV building (RFC 4180 quoting)
    csv.ts                      write the file + native share sheet
    sync.ts                     best-effort mirror to Supabase
    supabase.ts                 client + anonymous auth + email upgrade
    storage.ts      / .web.ts   MMKV, AsyncStorage, or localStorage
    haptics.ts / id.ts
  store/useStore.ts             Zustand + persist
  types.ts  theme.ts  navigation.ts

modules/document-detector/      local Expo module: the VisionCamera plugin
  ios/DocumentDetectorPlugin.swift        VNDetectRectanglesRequest
  android/.../DocumentDetectorPlugin.kt   Otsu luma profile

public/                         copied verbatim into the web build
  manifest.json                 the PWA manifest
  sw.js                         service worker: app shell only, never the API
  icons/                        generated by scripts/make-icons.mjs

scripts/
  make-icons.mjs                draws the icon PNGs, no image library
  postexport-pwa.mjs            injects the install tags into the built HTML

supabase/
  migrations/20260929000000_init.sql      tables, RLS, storage, rate limiting
  functions/grade-paper/
    index.ts                    auth → rate limit → Claude → parse → respond
    prompt.ts                   the full grading prompt
    parse.ts                    defensive parsing of the model's output

tests/run.ts                    49 assertions over the pure logic (npm test)
```

## Tests

```bash
npm test
```

Covers the parts that decide a grade: parsing malformed, fenced, truncated
and wrong-typed model output; score totals and manual overrides; the
confidence floor; class statistics; the auto-capture rules (steady window,
cooldown, the re-arm guard that stops a sheet being graded twice, too-far /
too-close / skewed, gyroscope gate); the page detector against synthetic
frames (Otsu thresholding, noise, clutter, wrong aspect, blank frames); queue
counts; and CSV quoting.

The modules under test import no native code — that is enforced by
`tests/tsconfig.json`, which compiles them in isolation — so the suite runs on
plain Node with no simulator, emulator or mocking framework.

---

## Design notes

- **No home screen and no onboarding.** The camera *is* the app. The only
  first-run UI is a one-line tooltip you dismiss by tapping it.
- **Dark capture surface, light review surface.** You are looking through the
  camera in a classroom and reading results anywhere.
- **Per-frame work never touches React.** The overlay and shutter ring are
  driven through imperative handles onto `Animated.Value`s; detections land in
  refs. Nothing in the capture path causes a render.
- **Nothing modal on the capture path.** No confirm, no retake prompt, no
  full-screen progress. The only acknowledgement a capture gets is a flash,
  a haptic and a new chip — which is all you need when the next paper is
  already in your other hand.
- **A manual override is instant and visible.** Tapping a mark recomputes the
  score synchronously and gives the mark a dashed rim, so you can always tell
  which verdicts were the model's and which were yours.
- **One deviation from the original brief:** it asked for exactly three
  screens beyond the camera. There are four — the answer-key sheet is its
  own modal rather than a section of Settings, because the pill on the
  camera needs somewhere focused to land, and scanning or typing a key is a
  task you do once and leave, not a setting you browse.
- **Failures degrade, they don't block.** No Skia → crop instead of warp. No
  native detector → hold-still auto-capture. No MMKV → AsyncStorage. No
  network → queue. No KaTeX → readable plain-text math.

---

## Known limits

- **Android and web perspective correction** is a crop, not a true warp (see
  above). On Android, use the system-scanner engine when that matters; on web
  there is no equivalent, so photograph the page square-on.
- **The web build keeps page images in IndexedDB**, which a browser may evict
  under storage pressure and which a private window will not keep at all.
  Grades are never lost with them — the results screen just says the photo is
  gone.
- **The service worker caches the app shell, never API calls.** The app opens
  offline and queues scans, but a grade always requires the network.
- **KaTeX loads from jsDelivr**, so math renders as plain text (still
  readable — `\frac{3}{4}` becomes `3/4`) when offline. To make it fully
  offline, vendor `katex.min.css`, `katex.min.js` and `auto-render.min.js`
  into `assets/katex/` and point `MathText.tsx` at the local copies.
- **Grading is not free.** Each scan is one Sonnet call with an image. The
  per-user rate limit in the Edge Function is the backstop; watch the
  `api_usage` table for actual token spend.
- **No app icon or splash yet.** Expo's defaults are in place; drop your own
  into `assets/` and point `app.json` at them before shipping.
- **Anonymous users are per-device.** Link an email in Settings before
  changing phones, or the assignments on the old device stay there.

---

## Scripts

```bash
npm start            # Metro for the dev client
npm run ios          # build + run on iOS
npm run android      # build + run on Android
npm run prebuild     # regenerate native projects
npm run typecheck    # tsc --noEmit
npm test             # pure-logic test suite
npm run web          # dev server for the web build
npm run build:web    # production PWA into dist/
npm run icons        # regenerate the app icons
npm run db:push      # push migrations to Supabase
npm run fn:deploy    # deploy the grade-paper function
npm run fn:serve     # run the function locally
```

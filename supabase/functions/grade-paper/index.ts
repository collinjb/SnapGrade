/**
 * grade-paper — the only place the Anthropic API key exists.
 *
 * Flow: verify the caller's Supabase JWT → rate-limit them → send the page to
 * Claude with a strict JSON contract → parse (retrying once on malformed
 * output) → validate → return.
 *
 * Deploy:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *   supabase functions deploy grade-paper
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { parseGraded, type GradedPaper } from './parse.ts';
import {
  ASSISTANT_PREFILL,
  RETRY_NUDGE,
  buildSystemPrompt,
  buildUserInstruction,
  type PromptOptions,
} from './prompt.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 8192;

/** Anthropic's hard limit is 5 MB per image; refuse earlier with a clear
 *  message rather than letting the upstream 400 surface. */
const MAX_IMAGE_BYTES = 4_500_000;

/** Per-user request budget. Generous enough for a class set in one sitting,
 *  tight enough that a leaked anon key cannot run up a bill. */
const MINUTE_LIMIT = Number(Deno.env.get('RATE_LIMIT_PER_MINUTE') ?? 12);
const DAY_LIMIT = Number(Deno.env.get('RATE_LIMIT_PER_DAY') ?? 400);

type ErrorCode =
  | 'rate_limited'
  | 'unauthorized'
  | 'bad_request'
  | 'upstream_error'
  | 'parse_error'
  | 'server_error';

interface GradeBody {
  imageBase64?: string;
  answerKeyMode?: 'ai' | 'scan' | 'typed';
  answerKeyText?: string;
  answerKeyImageBase64?: string;
  partialCredit?: boolean;
}

function fail(code: ErrorCode, message: string, status: number, retryAfterSeconds?: number) {
  return json(
    { ok: false, code, error: message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    status,
    retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {},
  );
}

const base64Bytes = (b64: string): number => Math.floor((b64.length * 3) / 4);

/** Strip a data-URL prefix if the client sent one. */
const stripDataUrl = (b64: string): string => b64.replace(/^data:image\/[a-z+]+;base64,/i, '');

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return fail('bad_request', 'Use POST.', 405);

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!anthropicKey || !supabaseUrl || !serviceKey || !anonKey) {
    console.error('grade-paper is missing required environment variables');
    return fail('server_error', 'Grading is not configured on the server.', 500);
  }

  // --- Who is calling? ----------------------------------------------------
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return fail('unauthorized', 'Missing bearer token.', 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userError || !user) {
    return fail('unauthorized', 'Your session expired. Reopen the app.', 401);
  }

  // --- Request body -------------------------------------------------------
  let body: GradeBody;
  try {
    body = (await req.json()) as GradeBody;
  } catch {
    return fail('bad_request', 'Body must be JSON.', 400);
  }

  const imageBase64 = stripDataUrl(body.imageBase64 ?? '');
  if (!imageBase64) return fail('bad_request', 'No image was sent.', 400);
  if (base64Bytes(imageBase64) > MAX_IMAGE_BYTES) {
    return fail('bad_request', 'That page is too large. Retake it.', 413);
  }

  const answerKeyMode = body.answerKeyMode ?? 'ai';
  const answerKeyImage =
    answerKeyMode === 'scan' && body.answerKeyImageBase64
      ? stripDataUrl(body.answerKeyImageBase64)
      : undefined;

  if (answerKeyImage && base64Bytes(answerKeyImage) > MAX_IMAGE_BYTES) {
    return fail('bad_request', 'The answer key image is too large.', 413);
  }

  const promptOptions: PromptOptions = {
    answerKeyMode,
    answerKeyText: body.answerKeyText,
    hasAnswerKeyImage: Boolean(answerKeyImage),
    partialCredit: body.partialCredit === true,
  };

  // --- Rate limit ---------------------------------------------------------
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: limit, error: limitError } = await admin.rpc('check_rate_limit', {
    p_user: user.id,
    p_minute_limit: MINUTE_LIMIT,
    p_day_limit: DAY_LIMIT,
  });

  if (limitError) {
    console.error('rate limit check failed:', limitError.message);
    return fail('server_error', 'Could not verify your usage.', 500);
  }

  const gate = limit as {
    allowed: boolean;
    reason?: string;
    retry_after_seconds?: number;
    usage_id?: number;
  };

  if (!gate.allowed) {
    const seconds = gate.retry_after_seconds ?? 60;
    const message =
      gate.reason === 'day'
        ? "You've hit today's grading limit. It resets in an hour."
        : "You're scanning faster than we can grade. Try again in a few seconds.";
    return fail('rate_limited', message, 429, seconds);
  }

  const usageId = gate.usage_id;
  const startedAt = Date.now();

  // --- Call Claude --------------------------------------------------------
  const imageBlock = (data: string) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
  });

  const content: unknown[] = [];
  // Key first so "the first image is the key" in the prompt stays true.
  if (answerKeyImage) content.push(imageBlock(answerKeyImage));
  content.push(imageBlock(imageBase64));
  content.push({ type: 'text', text: buildUserInstruction(promptOptions) });

  const system = buildSystemPrompt(promptOptions);

  let paper: GradedPaper | null = null;
  let retried = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastRaw = '';

  for (let attempt = 0; attempt < 2 && paper === null; attempt++) {
    retried = attempt > 0;

    const messages: unknown[] = [
      { role: 'user', content },
      { role: 'assistant', content: ASSISTANT_PREFILL },
    ];
    if (attempt > 0) {
      // Show the model its own bad output, then ask again. Cheaper and far
      // more reliable than re-running the whole request blind.
      messages.splice(1, 1, { role: 'assistant', content: lastRaw.slice(0, 2000) || '(empty)' });
      messages.push({ role: 'user', content: RETRY_NUDGE });
      messages.push({ role: 'assistant', content: ASSISTANT_PREFILL });
    }

    let upstream: Response;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          // Grading should be reproducible: the same page twice should not
          // produce two different scores.
          temperature: 0,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
        }),
      });
    } catch (e) {
      console.error('anthropic fetch failed:', e);
      await recordUsage(admin, usageId, 0, 0, Date.now() - startedAt, false);
      return fail('upstream_error', 'Could not reach the grader. Try again.', 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error(`anthropic ${upstream.status}: ${text.slice(0, 500)}`);
      await recordUsage(admin, usageId, 0, 0, Date.now() - startedAt, false);

      if (upstream.status === 429 || upstream.status === 529) {
        return fail('rate_limited', 'The grader is busy. Try again in a moment.', 429, 15);
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return fail('server_error', 'The grading service rejected our key.', 500);
      }
      return fail('upstream_error', 'The grader had a problem. Try again.', 502);
    }

    const payload = (await upstream.json()) as AnthropicResponse;
    inputTokens += payload.usage?.input_tokens ?? 0;
    outputTokens += payload.usage?.output_tokens ?? 0;

    const text = (payload.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

    // The prefill is not echoed back, so put it in front before parsing.
    lastRaw = ASSISTANT_PREFILL + text;
    paper = parseGraded(lastRaw, { allowPartial: promptOptions.partialCredit });

    if (payload.stop_reason === 'max_tokens' && paper === null) {
      // A truncated object will never parse; retrying identically will
      // truncate again, so stop here with a clear message.
      break;
    }
  }

  const latencyMs = Date.now() - startedAt;
  await recordUsage(admin, usageId, inputTokens, outputTokens, latencyMs, paper !== null);

  if (!paper) {
    console.error('unparseable grader output:', lastRaw.slice(0, 800));
    return fail('parse_error', 'The grader returned something we could not read.', 502);
  }

  return json({ ok: true, result: paper, meta: { model: MODEL, latencyMs, retried } });
});

// ---------------------------------------------------------------------------
// Upstream response shape
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/** Fill in the usage row that check_rate_limit reserved. Failures here must
 *  never fail the request — the grade already happened. */
async function recordUsage(
  admin: ReturnType<typeof createClient>,
  usageId: number | undefined,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  ok: boolean,
): Promise<void> {
  if (!usageId) return;
  const { error } = await admin
    .from('api_usage')
    .update({
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      latency_ms: latencyMs,
      ok,
    })
    .eq('id', usageId);
  if (error) console.warn('usage update failed:', error.message);
}

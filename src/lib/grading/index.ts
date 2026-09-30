/** The grading call, now that it runs on the device.
 *
 *  This is what the Supabase Edge Function used to be: build the prompt,
 *  call the model, parse defensively, retry once if the output is unreadable.
 *  The difference is that the key belongs to the person holding the phone,
 *  so there is no shared secret to protect and no server to deploy. */
import { base64Bytes } from '@/lib/imaging';
import { anthropicProvider } from './anthropic';
import { geminiProvider } from './gemini';
import { parseGraded, type GradedPaper } from './parse';
import { buildSystemPrompt, buildUserInstruction, type PromptOptions } from './prompt';
import { ProviderError, type Provider, type ProviderId } from './provider';
import type { AnswerKeyMode } from '@/types';

export { ProviderError } from './provider';
export type { ProviderId, Provider } from './provider';
export type { GradedPaper } from './parse';

export const PROVIDERS: Record<ProviderId, Provider> = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
};

export const PROVIDER_LIST: Provider[] = [geminiProvider, anthropicProvider];

export const DEFAULT_PROVIDER: ProviderId = 'gemini';

export function getProvider(id: ProviderId): Provider {
  return PROVIDERS[id] ?? geminiProvider;
}

/** Both providers cap a single image at around 5 MB; stay well under it so a
 *  failure here means the pipeline broke, not that the page was busy. */
const MAX_IMAGE_BYTES = 4_000_000;

export interface GradeRequest {
  imageBase64: string;
  answerKeyMode: AnswerKeyMode;
  answerKeyText?: string;
  answerKeyImageBase64?: string;
  partialCredit: boolean;
  providerId: ProviderId;
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
}

export interface GradeOutcome {
  result: GradedPaper;
  model: string;
  latencyMs: number;
  retried: boolean;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Grade one page.
 *
 * Throws `ProviderError` with `retryable` set, so the queue knows whether
 * another attempt is worth the user's quota.
 */
export async function gradePaper(request: GradeRequest): Promise<GradeOutcome> {
  const provider = getProvider(request.providerId);

  if (!request.apiKey) {
    throw new ProviderError(
      `Add your ${provider.label} API key in Settings to start grading.`,
      'no_key',
      false,
    );
  }
  if (!request.imageBase64) {
    throw new ProviderError('That capture came out empty.', 'upstream_error', false);
  }
  if (base64Bytes(request.imageBase64) > MAX_IMAGE_BYTES) {
    throw new ProviderError('That page came out too large to send.', 'too_large', false);
  }

  const promptOptions: PromptOptions = {
    answerKeyMode: request.answerKeyMode,
    answerKeyText: request.answerKeyText,
    hasAnswerKeyImage: Boolean(request.answerKeyImageBase64),
    partialCredit: request.partialCredit,
  };

  const userInstruction = buildUserInstruction(promptOptions);
  const startedAt = Date.now();

  let lastText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let model = provider.defaultModel;

  // Two attempts. Gemini's response schema makes a parse failure almost
  // impossible; what does happen on a long page is the response running out
  // of room, and the second attempt answers that by asking for less per
  // problem rather than by asking again identically.
  let ranOutOfRoom = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const systemPrompt = buildSystemPrompt({ ...promptOptions, terse: ranOutOfRoom });

    const call = await provider.grade({
      imageBase64: request.imageBase64,
      answerKeyImageBase64: request.answerKeyImageBase64,
      systemPrompt:
        attempt === 0 || ranOutOfRoom
          ? systemPrompt
          : `${systemPrompt}\n\nYour previous reply could not be parsed as JSON. Return ONLY the JSON object: start with { and end with }, no code fences, no commentary, no trailing commas.`,
      userInstruction,
      apiKey: request.apiKey,
      model: request.model,
      signal: request.signal,
    });

    lastText = call.text;
    model = call.model;
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;

    const parsed = parseGraded(call.text, { allowPartial: request.partialCredit });
    if (parsed) {
      return {
        result: parsed,
        model,
        latencyMs: Date.now() - startedAt,
        retried: attempt > 0,
        inputTokens,
        outputTokens,
      };
    }

    // A truncated object will never parse, and asking again identically
    // would truncate in the same place — so the retry asks for a leaner
    // answer instead. Only worth doing once.
    if (call.truncated) {
      if (ranOutOfRoom) break;
      ranOutOfRoom = true;
    }
  }

  console.warn('[snapgrade] unparseable grader output:', lastText.slice(0, 600));
  throw new ProviderError(
    ranOutOfRoom
      ? 'That page has more problems than the grader could get through in one go.'
      : 'The grader returned something we could not read.',
    'parse_error',
    true,
  );
}

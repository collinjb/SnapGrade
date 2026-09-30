/** What a grading provider has to do, and nothing more.
 *
 *  Both implementations take the same prompt and the same images and return
 *  the same raw text, which `parse.ts` then has to be suspicious of. Keeping
 *  the interface this thin is what makes swapping models a config change
 *  rather than a rewrite. */

export type ProviderId = 'gemini' | 'anthropic';

export interface GradeCall {
  /** base64 JPEG of the student page, no data: prefix. */
  imageBase64: string;
  /** base64 JPEG of the answer key, when one was photographed. */
  answerKeyImageBase64?: string;
  systemPrompt: string;
  userInstruction: string;
  apiKey: string;
  /** Overrides the provider's default model id. */
  model?: string;
  signal?: AbortSignal;
}

export interface GradeCallResult {
  /** Raw text from the model. Never trusted; always run through parseGraded. */
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the response was cut off before the model finished. */
  truncated: boolean;
}

export type FailureCode =
  | 'no_key'
  | 'bad_key'
  | 'bad_model'
  | 'rate_limited'
  | 'quota'
  | 'blocked'
  | 'too_large'
  | 'network'
  | 'upstream_error'
  | 'parse_error';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: FailureCode,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface Provider {
  id: ProviderId;
  label: string;
  defaultModel: string;
  /** Placeholder text for the key field. */
  keyHint: string;
  /** The literal prefix real keys carry, quoted verbatim in warnings. */
  keyPrefix: string;
  /** Where to go and get one. */
  keyUrl: string;
  /** Cheap sanity check before we bother making a request. */
  looksLikeKey(key: string): boolean;
  grade(call: GradeCall): Promise<GradeCallResult>;
}

/** Shared by both providers: turn an HTTP status into something the queue
 *  can act on, and the user can read. */
export function classifyHttpError(status: number, body: string): ProviderError {
  const snippet = body.slice(0, 300);

  if (status === 401 || status === 403) {
    return new ProviderError(
      'That API key was rejected. Check it in Settings.',
      'bad_key',
      false,
    );
  }
  if (status === 429) {
    return new ProviderError(
      "You're grading faster than the free tier allows. It'll catch up.",
      'rate_limited',
      true,
      30,
    );
  }
  if (status === 413) {
    return new ProviderError('That page was too large to send.', 'too_large', false);
  }
  if (status === 400) {
    // A 400 is usually our fault — a malformed request or a rejected image —
    // and retrying an identical bad request just wastes the user's quota.
    return new ProviderError(
      `The grader rejected that request. ${snippet}`,
      'upstream_error',
      false,
    );
  }
  if (status >= 500) {
    return new ProviderError('The grader is having a moment. Trying again shortly.', 'upstream_error', true, 15);
  }
  return new ProviderError(`Unexpected response (${status}). ${snippet}`, 'upstream_error', true);
}

/** Gemini, called straight from the device.
 *
 *  The default provider, because AI Studio hands out a free-tier key with no
 *  card, which means SnapGrade works end to end with nothing deployed.
 *
 *  Gemini's `responseSchema` is a real advantage for this app: the model is
 *  constrained to emit schema-shaped JSON rather than merely asked to, so the
 *  coaxing the Anthropic path needs (a `{` prefill, a retry on unparseable
 *  output) is mostly unnecessary here. `parse.ts` still runs — the shape
 *  being guaranteed says nothing about the numbers being sane. */
import { classifyHttpError, ProviderError, type GradeCall, type GradeCallResult, type Provider } from './provider';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.8-flash';
/** A 100-problem timed drill needs roughly 7k output tokens even written
 *  tersely, and 8k left no headroom at all — the response truncated and
 *  failed to parse. Flash models allow far more than this. */
const MAX_OUTPUT_TOKENS = 32768;

/** The JSON contract, expressed the way Gemini wants it. Mirrors the schema
 *  in `prompt.ts`; if one changes the other has to. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    student_name: { type: 'STRING', nullable: true },
    problems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          number: { type: 'STRING' },
          question_text: { type: 'STRING' },
          student_answer: { type: 'STRING' },
          correct_answer: { type: 'STRING' },
          status: {
            type: 'STRING',
            enum: ['correct', 'incorrect', 'partial', 'blank', 'needs_review'],
          },
          points_earned: { type: 'NUMBER' },
          points_possible: { type: 'NUMBER' },
          explanation: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          bbox: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' },
              y: { type: 'NUMBER' },
              w: { type: 'NUMBER' },
              h: { type: 'NUMBER' },
            },
            required: ['x', 'y', 'w', 'h'],
          },
        },
        // question_text and explanation are deliberately optional: on a
        // 100-problem drill they are the difference between fitting in the
        // output budget and truncating. Everything that decides the grade
        // stays required.
        required: [
          'number',
          'student_answer',
          'correct_answer',
          'status',
          'points_earned',
          'points_possible',
          'confidence',
          'bbox',
        ],
      },
    },
    total_earned: { type: 'NUMBER' },
    total_possible: { type: 'NUMBER' },
  },
  required: ['problems', 'total_earned', 'total_possible'],
} as const;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

export const geminiProvider: Provider = {
  id: 'gemini',
  label: 'Google Gemini',
  defaultModel: DEFAULT_MODEL,
  keyHint: 'Starts with AIza',
  keyPrefix: 'AIza',
  keyUrl: 'https://aistudio.google.com/apikey',

  looksLikeKey(key) {
    return /^AIza[\w-]{30,}$/.test(key.trim());
  },

  async grade({
    imageBase64,
    answerKeyImageBase64,
    systemPrompt,
    userInstruction,
    apiKey,
    model = DEFAULT_MODEL,
    signal,
  }: GradeCall): Promise<GradeCallResult> {
    const parts: GeminiPart[] = [];
    // Key first, so "the first image is the key" in the prompt stays true.
    if (answerKeyImageBase64) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: answerKeyImageBase64 } });
    }
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
    parts.push({ text: userInstruction });

    let response: Response;
    try {
      response = await fetch(
        `${ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // The header form keeps the key out of the URL, so it cannot
            // end up in a proxy log or a browser history entry.
            'x-goog-api-key': apiKey,
          },
          signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              // Grading has to be reproducible: the same page twice must not
              // produce two different scores.
              temperature: 0,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
            },
          }),
        },
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new ProviderError('Could not reach Gemini. Check your connection.', 'network', true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      // Google retires model ids on its own schedule, and the 404 body says
      // which one to move to. Surface that as an instruction rather than as
      // raw JSON, and point at the field that fixes it without a redeploy.
      if (response.status === 404) {
        const suggested = /models\/([\w.-]+)\s+for the latest/.exec(body)?.[1];
        throw new ProviderError(
          suggested
            ? `Gemini has retired ${model}. Set the model to ${suggested} in Settings.`
            : `Gemini does not recognise the model "${model}". Change it in Settings.`,
          'bad_model',
          false,
        );
      }

      // Google reports an exhausted free-tier quota as a 429 too, but the
      // body distinguishes it — and that one is worth saying plainly.
      if (response.status === 429 && /quota/i.test(body)) {
        throw new ProviderError(
          "You've used up the free Gemini quota for now. It resets on a rolling window.",
          'quota',
          true,
          120,
        );
      }
      throw classifyHttpError(response.status, body);
    }

    const payload = (await response.json()) as GeminiResponse;

    if (payload.promptFeedback?.blockReason) {
      throw new ProviderError(
        `Gemini declined to read that page (${payload.promptFeedback.blockReason}).`,
        'blocked',
        false,
      );
    }

    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    if (!text) {
      throw new ProviderError('Gemini returned an empty response.', 'parse_error', true);
    }

    return {
      text,
      model,
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      truncated: candidate?.finishReason === 'MAX_TOKENS',
    };
  },
};

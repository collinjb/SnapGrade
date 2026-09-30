/** Claude, called straight from the device.
 *
 *  No structured-output mode here, so the JSON contract is held together by
 *  the prompt plus an assistant prefill of `{` — the cheapest reliable way to
 *  stop the model opening with "Here's the grade:". The prefill is not echoed
 *  back, so it has to be prepended before parsing.
 *
 *  Browser calls need `anthropic-dangerous-direct-browser-access`. The header
 *  is named that way for a good reason: it is only acceptable because the key
 *  here is the user's own, entered on their own device, rather than one
 *  shared by every install. */
import { classifyHttpError, ProviderError, type GradeCall, type GradeCallResult, type Provider } from './provider';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 8192;

/** Prepended to the response before parsing, since the model continues from
 *  it rather than repeating it. */
export const ASSISTANT_PREFILL = '{';

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

export const anthropicProvider: Provider = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  defaultModel: DEFAULT_MODEL,
  keyHint: 'Starts with sk-ant-',
  keyPrefix: 'sk-ant-',
  keyUrl: 'https://console.anthropic.com/settings/keys',

  looksLikeKey(key) {
    return /^sk-ant-[\w-]{20,}$/.test(key.trim());
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
    const imageBlock = (data: string) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data },
    });

    const content: unknown[] = [];
    // Key first, so "the first image is the key" in the prompt stays true.
    if (answerKeyImageBase64) content.push(imageBlock(answerKeyImageBase64));
    content.push(imageBlock(imageBase64));
    content.push({ type: 'text', text: userInstruction });

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        signal,
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          // Grading has to be reproducible: the same page twice must not
          // produce two different scores.
          temperature: 0,
          system: systemPrompt,
          messages: [
            { role: 'user', content },
            { role: 'assistant', content: ASSISTANT_PREFILL },
          ],
        }),
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new ProviderError('Could not reach Claude. Check your connection.', 'network', true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 400 && /credit balance/i.test(body)) {
        throw new ProviderError(
          'That Anthropic account is out of credit.',
          'quota',
          false,
        );
      }
      if (response.status === 404 || /model/i.test(body) && response.status === 400) {
        throw new ProviderError(
          `Claude does not recognise the model "${model}". Change it in Settings.`,
          'bad_model',
          false,
        );
      }
      if (response.status === 529) {
        throw new ProviderError('Claude is overloaded. Trying again shortly.', 'upstream_error', true, 20);
      }
      throw classifyHttpError(response.status, body);
    }

    const payload = (await response.json()) as AnthropicResponse;

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    if (!text) {
      throw new ProviderError('Claude returned an empty response.', 'parse_error', true);
    }

    return {
      // The prefill is not in the response, so put it back before parsing.
      text: ASSISTANT_PREFILL + text,
      model,
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      truncated: payload.stop_reason === 'max_tokens',
    };
  },
};

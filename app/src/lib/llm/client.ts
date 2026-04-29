import { LLMCallOptions, LLMResponse } from '@/types';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_RETRIES_PER_MODEL = 3;
const BASE_RETRY_DELAY_MS = 1000;

interface ModelConfig {
  id: string;
  label: string;
}

function getModels(): ModelConfig[] {
  return [
    {
      id: process.env.OPENROUTER_MODEL_PRIMARY || 'x-ai/grok-4.20',
      label: 'Grok',
    },
    {
      id: process.env.OPENROUTER_MODEL_FALLBACK || 'google/gemini-3.1-flash-lite-preview',
      label: 'Gemini Flash Lite',
    },
  ];
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  return key;
}

function isTransientError(status: number, error?: string): boolean {
  // Network errors, rate limits, server errors
  if (status === 429) return true; // Rate limited
  if (status >= 500) return true; // Server error
  if (status === 0) return true; // Network failure
  if (error?.includes('ECONNRESET')) return true;
  if (error?.includes('ETIMEDOUT')) return true;
  if (error?.includes('ENOTFOUND')) return true;
  if (error?.includes('socket hang up')) return true;
  if (error?.includes('fetch failed')) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callWithRetry(
  model: ModelConfig,
  options: LLMCallOptions,
  apiKey: string,
): Promise<LLMResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
    try {
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/adoistic/mineru-true-copy',
          'X-Title': 'MinerU True Copy',
        },
        body: JSON.stringify({
          model: model.id,
          messages: options.messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.max_tokens ?? 4096,
          ...(options.response_format ? { response_format: options.response_format } : {}),
        }),
        signal: AbortSignal.timeout(120000), // 2 minute timeout
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        const isTransient = isTransientError(response.status, errorBody);

        if (isTransient && attempt < MAX_RETRIES_PER_MODEL - 1) {
          const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.log(`[LLM] ${model.label} attempt ${attempt + 1} failed (${response.status}), retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        throw new Error(`${model.label} API error ${response.status}: ${errorBody}`);
      }

      const data = await response.json();

      if (!data.choices?.[0]?.message?.content) {
        throw new Error(`${model.label} returned empty response`);
      }

      return {
        content: data.choices[0].message.content,
        model: data.model || model.id,
        usage: {
          prompt_tokens: data.usage?.prompt_tokens || 0,
          completion_tokens: data.usage?.completion_tokens || 0,
          total_tokens: data.usage?.total_tokens || 0,
        },
      };
    } catch (err) {
      lastError = err as Error;
      const errorMsg = (err as Error).message || '';
      const isTransient = isTransientError(0, errorMsg);

      if (isTransient && attempt < MAX_RETRIES_PER_MODEL - 1) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`[LLM] ${model.label} attempt ${attempt + 1} failed (${errorMsg}), retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError || new Error(`${model.label} failed after ${MAX_RETRIES_PER_MODEL} attempts`);
}

export async function callLLM(options: LLMCallOptions): Promise<LLMResponse> {
  const apiKey = getApiKey();
  const models = getModels();

  // Try primary model first
  try {
    return await callWithRetry(models[0], options, apiKey);
  } catch (primaryError) {
    console.log(`[LLM] ${models[0].label} exhausted all retries, falling back to ${models[1].label}`);

    // Fallback to secondary model
    try {
      return await callWithRetry(models[1], options, apiKey);
    } catch (fallbackError) {
      console.error(`[LLM] Both models failed. Primary: ${(primaryError as Error).message}, Fallback: ${(fallbackError as Error).message}`);
      throw new Error(`All LLM models failed. Last error: ${(fallbackError as Error).message}`);
    }
  }
}

export async function callLLMWithImages(
  systemPrompt: string,
  userPrompt: string,
  imageUrls: string[],
  options?: Partial<LLMCallOptions>,
): Promise<LLMResponse> {
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: userPrompt },
    ...imageUrls.map(url => ({
      type: 'image_url' as const,
      image_url: { url },
    })),
  ];

  return callLLM({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
    ...options,
  });
}

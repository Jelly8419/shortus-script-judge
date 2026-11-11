/**
 * OpenAI 호출. structured output(json_schema, strict)로 형식을 강제하고,
 * 토큰 사용량을 비용으로 환산해 함께 돌려준다.
 */
import OpenAI from 'openai';
import type { Usage } from './types.js';

/**
 * USD per 1M tokens [입력, 캐시된 입력, 출력].
 * 목록에 없는 모델은 PRICE_IN / PRICE_CACHED / PRICE_OUT 환경변수로 지정.
 * OpenAI는 같은 앞부분(1,024토큰 이상)이 반복되면 자동으로 캐시해 입력 단가를 깎아 준다.
 */
const PRICES: Record<string, [number, number, number]> = {
  'gpt-4o': [2.5, 1.25, 10],
  'gpt-4o-mini': [0.15, 0.075, 0.6],
  'gpt-4.1': [2, 0.5, 8],
  'gpt-4.1-mini': [0.4, 0.1, 1.6],
  'gpt-4.1-nano': [0.1, 0.025, 0.4],
  'gpt-5-mini': [0.25, 0.025, 2], // 2026-11 사용자 확인 가격
};

export function priceFor(model: string): [number, number, number] {
  const envIn = Number(process.env.PRICE_IN);
  const envOut = Number(process.env.PRICE_OUT);
  if (envIn > 0 && envOut > 0) return [envIn, Number(process.env.PRICE_CACHED) || envIn, envOut];
  const key = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? PRICES[key] : [0, 0, 0];
}

export interface LlmCall<T> {
  data: T;
  usage: Usage;
}

export interface LlmClient {
  json<T>(args: { name: string; system: string; user: string; schema: object }): Promise<LlmCall<T>>;
  model: string;
}

export function openaiClient(model: string): LlmClient {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // 추론 모델(gpt-5 계열, o 계열)은 temperature를 받지 않는다. 자동으로 빼고, 대신 추론 강도를 받는다.
  const reasoning = /^(gpt-5|o\d)/.test(model);
  const tempEnv = process.env.TEMPERATURE ?? (reasoning ? 'none' : '0');
  const temperature = tempEnv === 'none' ? undefined : Number(tempEnv);
  // REASONING_EFFORT=minimal|low|medium|high (추론 모델만). 비우면 모델 기본값
  const effort = reasoning ? process.env.REASONING_EFFORT : undefined;

  return {
    model,
    async json<T>({ name, system, user, schema }: { name: string; system: string; user: string; schema: object }) {
      const res = await client.chat.completions.create({
        model,
        ...(temperature === undefined ? {} : { temperature }),
        ...(effort ? { reasoning_effort: effort as 'low' | 'medium' | 'high' } : {}),
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema: schema as Record<string, unknown> } },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const choice = res.choices[0];
      if (choice?.message?.refusal) throw new Error(`모델이 응답을 거부함: ${choice.message.refusal}`);
      const text = choice?.message?.content ?? '';
      const [pin, pcached, pout] = priceFor(model);
      const input = res.usage?.prompt_tokens ?? 0;
      const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const output = res.usage?.completion_tokens ?? 0;
      return {
        data: JSON.parse(text) as T,
        usage: {
          calls: 1,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          cost_usd: ((input - cached) * pin + cached * pcached + output * pout) / 1e6,
        },
      };
    },
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    calls: a.calls + b.calls,
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: (a.cached_input_tokens ?? 0) + (b.cached_input_tokens ?? 0),
    output_tokens: a.output_tokens + b.output_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

export const ZERO_USAGE: Usage = { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cost_usd: 0 };

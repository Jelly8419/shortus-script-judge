/**
 * 테스트용 가짜 LLM. API 없이 파이프라인(인용 검증, 보류 결정, 평가 집계)을 돌려보기 위함.
 * fixtures 파일: { "<샘플 제목 앞부분>": { gate: {...}, score: {...} } }
 * 사용자 메시지 첫 줄의 제목으로 응답을 고른다.
 */
import { readFileSync } from 'node:fs';
import type { LlmClient } from './llm.js';

export function mockClient(path: string): LlmClient {
  const fixtures: Record<string, { gate: unknown; score: unknown }> = JSON.parse(readFileSync(path, 'utf8'));
  return {
    model: 'mock',
    async json<T>({ name, user }: { name: string; user: string }) {
      const lines = user.split('\n');
      const title = lines[lines.indexOf('# 원문 제목') + 1] ?? '';
      const key = Object.keys(fixtures).find((k) => title.startsWith(k));
      if (!key) throw new Error(`mock fixture 없음: ${title.slice(0, 30)}`);
      const data = (name === 'gate' ? fixtures[key].gate : fixtures[key].score) as T;
      return { data, usage: { calls: 1, input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200, cost_usd: 0 } };
    },
  };
}

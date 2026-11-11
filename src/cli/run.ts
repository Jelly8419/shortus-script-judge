/**
 * 샘플 전체(또는 일부)를 판정해 results/에 저장한다.
 *
 *   npm run judge                              # 기본 모델(gpt-4.1)로 전체 1회
 *   npm run judge -- --model gpt-4.1-mini      # 모델 지정
 *   npm run judge -- --repeat 3                # 같은 샘플을 3번씩 (일관성 확인)
 *   npm run judge -- --only s01,s08            # 일부만
 *   npm run judge -- --no-score                # 게이트만 (빠르고 싸게)
 *   npm run judge -- --data data/injected.jsonl  # 다른 데이터셋
 *   npm run judge -- --prompt v1               # 게이트 프롬프트 버전 (v1 | v2 | v2a, 기본 v2a)
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { judge } from '../judge.js';
import { openaiClient, type LlmClient } from '../llm.js';
import { mockClient } from '../mock.js';
import { PROMPT_VERSIONS, type PromptVersion } from '../prompts.js';
import type { Sample } from '../types.js';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const dataPath = arg('data', 'data/samples.jsonl')!;
// 기본 모델: gpt-4.1 (gpt-5-mini는 오탐 0이지만 판정 중앙값 12초로 느려서 제외, 2026-11-10 결정)
const model = arg('model', process.env.OPENAI_MODEL ?? 'gpt-4.1')!;
const repeat = Number(arg('repeat', '1'));
const only = arg('only')?.split(',');
const score = arg('no-score') === undefined;
const concurrency = Number(arg('concurrency', '4'));
const prompt = arg('prompt', 'v2a') as PromptVersion;
if (!PROMPT_VERSIONS.includes(prompt)) {
  console.error(`--prompt는 ${PROMPT_VERSIONS.join(' | ')} 중 하나`);
  process.exit(1);
}

const samples: Sample[] = readFileSync(dataPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((s: Sample) => !only || only.includes(s.id));

const llm: LlmClient = process.env.JUDGE_MOCK ? mockClient(process.env.JUDGE_MOCK) : openaiClient(model);
if (!process.env.JUDGE_MOCK && !process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY가 없습니다. .env에 넣어 주세요.');
  process.exit(1);
}

const jobs = Array.from({ length: repeat }, (_, run) => samples.map((s) => ({ s, run }))).flat();
const out: string[] = [];
const usages: { id: string; cost: number; input: number; cached: number; output: number }[] = [];
let done = 0;

async function worker() {
  while (jobs.length) {
    const { s, run } = jobs.shift()!;
    try {
      const r = await judge(s, llm, { score, prompt });
      out.push(JSON.stringify({ run, ...r }));
      usages.push({ id: s.id, cost: r.usage.cost_usd, input: r.usage.input_tokens, cached: r.usage.cached_input_tokens, output: r.usage.output_tokens });
      console.log(`[${++done}] ${s.id} run${run} → ${r.verdict}${r.hold_reasons.length ? ' · ' + r.hold_reasons.map((h) => h.split(':')[0]).join(', ') : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push(JSON.stringify({ run, id: s.id, error: msg }));
      console.log(`[${++done}] ${s.id} run${run} → 오류: ${msg}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

mkdirSync('results', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const tag = dataPath.split('/').pop()!.replace('.jsonl', '');
const file = `results/${stamp}_${llm.model}_${prompt}${score ? '' : '-gate'}_${tag}.jsonl`;
writeFileSync(file, out.join('\n') + '\n');
const sum = (k: 'cost' | 'input' | 'cached' | 'output') => usages.reduce((n, u) => n + u[k], 0);
const perId = new Map<string, number>();
for (const u of usages) perId.set(u.id, (perId.get(u.id) ?? 0) + u.cost);
const top = [...perId.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(
  `\n비용 $${sum('cost').toFixed(4)} · 입력 ${sum('input')}토큰 (캐시 ${sum('cached')}) · 출력 ${sum('output')}토큰` +
    `\n가장 비싼 샘플: ${top.map(([id, c]) => `${id} $${c.toFixed(4)}`).join(', ')}`,
);
console.log(`\n저장: ${file}\n평가: npm run eval -- ${file}`);

/**
 * 대본 1건을 텍스트 파일 두 개로 바로 판정한다. 쇼더스에서 원문·대본을 복사해 와서 시험해 보는 용도.
 *
 *   npm run judge:one -- --source source.txt --script script.txt
 *
 *   source.txt  원문을 그대로 붙여넣기 (쇼더스 입력 단계의 "입력한 원고"를 복사하면 가장 정확)
 *   script.txt  대본 섹션을 한 줄에 하나씩. "훅: ..."처럼 앞에 라벨을 붙여도 되고 안 붙여도 된다
 *               (안 붙이면 첫 줄은 훅, 나머지는 포인트)
 *
 * 옵션
 *   --title "<제목>"   원문 제목 (생략하면 원문 첫 줄)
 *   --score            품질 점수도 계산 (참고용, 호출 1회 추가)
 *   --model <모델>     기본 gpt-4.1
 *   --prompt v1|v2|v2a 기본 v2a
 *   --json             사람이 읽는 출력 대신 결과 JSON을 그대로 출력
 *   --save             results/one_<시각>.json에 저장
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { judge } from '../judge.js';
import { openaiClient, type LlmClient } from '../llm.js';
import { mockClient } from '../mock.js';
import { PROMPT_VERSIONS, type PromptVersion } from '../prompts.js';
import { parseScript } from '../input.js';
import type { Sample } from '../types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

function readText(path: string): string {
  try {
    // 윈도우 메모장 BOM·줄바꿈 정리
    return readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    console.error(`파일을 읽을 수 없습니다: ${path}`);
    process.exit(1);
  }
}

const sourcePath = arg('source');
const scriptPath = arg('script');
if (!sourcePath || !scriptPath) {
  console.error('사용법: npm run judge:one -- --source source.txt --script script.txt [--title "제목"] [--score] [--json] [--save]');
  process.exit(1);
}
const prompt = (arg('prompt') ?? 'v2a') as PromptVersion;
if (!PROMPT_VERSIONS.includes(prompt)) {
  console.error(`--prompt는 ${PROMPT_VERSIONS.join(' | ')} 중 하나`);
  process.exit(1);
}

const source = readText(sourcePath);
const sections = parseScript(readText(scriptPath));
if (sections.length === 0) {
  console.error('대본이 비어 있습니다. script 파일에 섹션을 한 줄에 하나씩 적어 주세요.');
  process.exit(1);
}
const title = arg('title') ?? source.split('\n').find((l) => l.trim())?.trim().slice(0, 100) ?? '';
const sample: Sample = {
  id: 'one',
  job_id: '',
  title,
  source_url: null,
  source_text: source,
  total_sec: +sections.reduce((n, s) => n + (s.est_sec ?? 0), 0).toFixed(1),
  sections,
};

const model = arg('model') ?? process.env.OPENAI_MODEL ?? 'gpt-4.1';
const llm: LlmClient = process.env.JUDGE_MOCK ? mockClient(process.env.JUDGE_MOCK) : openaiClient(model);
if (!process.env.JUDGE_MOCK && !process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY가 없습니다. .env에 넣어 주세요.');
  process.exit(1);
}

const r = await judge(sample, llm, { score: arg('score') !== undefined, prompt });

if (arg('save')) {
  mkdirSync('results', { recursive: true });
  const file = `results/one_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  writeFileSync(file, JSON.stringify({ sample, result: r }, null, 2));
  console.error(`저장: ${file}`);
}

if (arg('json')) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

const L: string[] = [];
const p = (s = '') => L.push(s);
p(`판정: ${r.verdict === '보류' ? '■ 보류' : '□ 통과'}`);
p(`제목: ${title}`);
p(`대본 ${sections.length}개 섹션 · 예상 ${sample.total_sec}초 (글자 수로 추정)`);
if (r.genre) p(`장르: ${r.genre} · 위험 신호: 건강 ${r.risk_signals?.health ? 'O' : 'X'}, 금융 ${r.risk_signals?.finance ? 'O' : 'X'}`);
p();

if (r.input_issue) {
  p(`[입력 문제] ${r.input_issue}`);
  p();
}

const gating = r.findings.filter((f) => f.gating);
if (gating.length) {
  p('보류 사유');
  for (const f of gating) {
    p(`  · ${f.type}${f.original_type ? ` (LLM은 ${f.original_type}로 분류)` : ''} — 섹션 ${f.section_idx + 1} [${sections[f.section_idx]?.label ?? '?'}]`);
    p(`    ${f.explanation}`);
    p(`    대본: "${f.script_quote}"`);
    if (f.source_quote) p(`    원문: "${f.source_quote}"`);
  }
  p();
}

const soft = r.findings.filter((f) => !f.gating);
if (soft.length) {
  p('참고 (보류 사유 아님)');
  for (const f of soft) {
    const why = !f.evidence_ok ? '인용이 원문·대본에서 확인되지 않음' : '건강·금융 위험 신호 없는 확실성 변화';
    p(`  · ${f.type} — 섹션 ${f.section_idx + 1}: ${f.explanation}`);
    p(`    (${why})`);
  }
  p();
}

const diags = r.diagnostics.filter((d) => !d.code.endsWith('finding'));
if (diags.length) {
  p('진단');
  for (const d of diags) p(`  · ${d.message}`);
  p();
}

if (r.scores.length) {
  p(`품질 점수 (참고용) ${r.weighted_score ?? '-'}/100`);
  for (const s of r.scores) p(`  · ${s.item} ${s.score}/5 — ${s.reason}`);
  p();
}

p(`모델 ${r.model} · 프롬프트 ${r.prompt_version} · ${(r.latency_ms / 1000).toFixed(1)}초 · $${r.usage.cost_usd.toFixed(4)}`);
console.log(L.join('\n'));

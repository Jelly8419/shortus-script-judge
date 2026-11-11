/**
 * 판정 결과를 사람 라벨과 비교한다.
 *
 *   npm run eval -- results/<파일>.jsonl [--labels data/labels.json] [--data data/samples.jsonl]
 *
 * 보는 것
 *   1. 판정 일치: 사람 보류/통과 vs 판정기 보류/통과 (혼동표, 보류 재현율, 오탐)
 *   2. 사유 일치: 같은 이유로 보류했는가 (결함 유형 기준)
 *   3. 일관성: 같은 샘플을 여러 번 돌렸을 때 판정이 흔들리는가 (--repeat 실행 결과일 때)
 *   4. 인용 검증: 판정기가 지어낸 인용 비율
 *   5. 장르 분류 일치, 비용·지연
 * 결과는 같은 이름의 .report.md로도 저장한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { JudgeResult, Sample } from '../types.js';

type Row = JudgeResult & { run: number; error?: string };
interface Label {
  verdict: '통과' | '보류' | null;
  gate_reasons: string[];
  gate_sections?: number[]; // 문제 섹션 번호 (1부터)
  confidence: string | null;
  note: string;
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const file = process.argv.slice(2).find((a) => a.endsWith('.jsonl') && !a.startsWith('--') && a.includes('results'));
if (!file) {
  console.error('사용법: npm run eval -- results/<파일>.jsonl');
  process.exit(1);
}
const labels: Record<string, Label> = JSON.parse(readFileSync(arg('labels', 'data/labels.json'), 'utf8'));
const dataPath = arg('data', 'data/samples.jsonl');
const samples: Record<string, Sample> = Object.fromEntries(
  readFileSync(dataPath, 'utf8').split('\n').filter(Boolean).map((l) => {
    const s = JSON.parse(l) as Sample;
    return [s.id, s];
  }),
);
const rows: Row[] = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ok = rows.filter((r) => !r.error);
const errors = rows.filter((r) => r.error);

const ids = [...new Set(ok.map((r) => r.id))].sort();
const runs = [...new Set(ok.map((r) => r.run))].length;
const byId = (id: string) => ok.filter((r) => r.id === id).sort((a, b) => a.run - b.run);

/** 반복 실행이면 다수결 판정, 아니면 그대로 */
function majority(id: string): '통과' | '보류' {
  const rs = byId(id);
  const hold = rs.filter((r) => r.verdict === '보류').length;
  return hold * 2 >= rs.length ? '보류' : '통과';
}
/** 사람 사유 "범위 확대: ..." → "범위 확대" */
const humanTypes = (l: Label) => l.gate_reasons.map((g) => g.split(':')[0].trim());
const judgeTypes = (r: Row) => (r.input_issue ? ['입력 부족'] : r.findings.filter((f) => f.gating).map((f) => f.type));

const L: string[] = [];
const p = (s = '') => L.push(s);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}% (${a}/${b})` : '-');

p(`# 판정기 평가 리포트`);
p();
p(`- 결과 파일: \`${file}\``);
p(`- 모델: ${ok[0]?.model ?? '-'} · 샘플 ${ids.length}건 · 반복 ${runs}회 · 오류 ${errors.length}건`);
p();

// 1. 판정 일치
const labeled = ids.filter((id) => labels[id]?.verdict);
const cm = { 보류: { 보류: 0, 통과: 0 }, 통과: { 보류: 0, 통과: 0 } };
for (const id of labeled) cm[labels[id].verdict!][majority(id)]++;
const humanHold = cm.보류.보류 + cm.보류.통과;
const humanPass = cm.통과.보류 + cm.통과.통과;

p(`## 1. 판정 일치${runs > 1 ? ' (반복 실행은 다수결)' : ''}`);
p();
p(`| 사람 \\ 판정기 | 보류 | 통과 |`);
p(`|---|---|---|`);
p(`| **보류** | ${cm.보류.보류} | ${cm.보류.통과} |`);
p(`| **통과** | ${cm.통과.보류} | ${cm.통과.통과} |`);
p();
p(`- 전체 일치: ${pct(cm.보류.보류 + cm.통과.통과, labeled.length)}`);
p(`- 보류 재현율 (사람이 보류한 것을 판정기도 보류): ${pct(cm.보류.보류, humanHold)}`);
p(`- 오탐 (사람은 통과, 판정기는 보류): ${pct(cm.통과.보류, humanPass)}`);
p();

// 2. 사유 일치: 보류는 했어도 사람이 본 그 문장을 잡았는지 (v1에서 s01이 엉뚱한 섹션으로 보류된 것을 계기로 추가)
type Outcome = '맞는 이유' | '틀린 이유' | '놓침';
function outcome(r: Row, lab: Label): Outcome {
  if (r.verdict !== '보류') return '놓침';
  if (humanTypes(lab).includes('입력 부족')) return r.input_issue ? '맞는 이유' : '틀린 이유';
  const secs = lab.gate_sections ?? [];
  const hit = r.findings.some((f) => f.gating && secs.includes(f.section_idx + 1));
  return hit ? '맞는 이유' : '틀린 이유';
}
function majorityOutcome(id: string): Outcome {
  const counts = new Map<Outcome, number>();
  for (const r of byId(id)) {
    const o = outcome(r, labels[id]);
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
const gatingDesc = (r: Row) =>
  r.input_issue ? '입력 부족' : r.findings.filter((f) => f.gating).map((f) => `${f.type}@${f.section_idx + 1}`).join(', ');

p(`## 2. 사유 일치 (사람이 보류한 샘플)`);
p();
p(`보류가 맞아도 사람이 본 문장(섹션)을 잡지 못했으면 '틀린 이유'로 센다. 유형 이름은 달라도 같은 섹션을 잡았으면 맞는 이유로 본다.`);
p();
p(`| 샘플 | 사람 (유형@섹션) | 판정기 보류 사유 (첫 실행) | 결과${runs > 1 ? ' (반복별)' : ''} |`);
p(`|---|---|---|---|`);
const tally: Record<Outcome, number> = { '맞는 이유': 0, '틀린 이유': 0, 놓침: 0 };
const holdIds = labeled.filter((i) => labels[i].verdict === '보류');
for (const id of holdIds) {
  const lab = labels[id];
  const human = humanTypes(lab).map((t, i) => `${t}${lab.gate_sections?.[i] ? '@' + lab.gate_sections[i] : ''}`).join(', ');
  const per = byId(id).map((r) => outcome(r, lab));
  tally[majorityOutcome(id)]++;
  p(`| ${id} | ${human} | ${gatingDesc(byId(id)[0]) || '(통과)'} | ${runs > 1 ? per.join(' / ') : per[0]} |`);
}
p();
p(`- 맞는 이유로 보류: ${pct(tally['맞는 이유'], holdIds.length)} · 틀린 이유로 보류: ${tally['틀린 이유']} · 놓침: ${tally['놓침']}${runs > 1 ? ' (반복 다수결)' : ''}`);
const fps = labeled.filter((i) => labels[i].verdict === '통과' && majority(i) === '보류');
if (fps.length) p(`- 오탐 상세: ${fps.map((i) => `${i} (${gatingDesc(byId(i).find((r) => r.verdict === '보류')!)})`).join(', ')}`);
p();

// 3. 일관성
if (runs > 1) {
  p(`## 3. 일관성 (${runs}회 반복)`);
  p();
  p(`| 샘플 | 판정 | 보류 사유 유형 |`);
  p(`|---|---|---|`);
  let stable = 0;
  for (const id of ids) {
    const rs = byId(id);
    const verdicts = rs.map((r) => r.verdict);
    const same = new Set(verdicts).size === 1;
    if (same) stable++;
    p(`| ${id} | ${verdicts.join(' / ')}${same ? '' : ' ⚠️'} | ${rs.map((r) => judgeTypes(r).join('+') || '-').join(' / ')} |`);
  }
  p();
  p(`- 판정이 모든 반복에서 같은 샘플: ${pct(stable, ids.length)}`);
  p();
}

// 4. 인용 검증
const allFindings = ok.flatMap((r) => r.findings ?? []);
const unverified = allFindings.filter((f) => !f.evidence_ok);
p(`## ${runs > 1 ? 4 : 3}. 인용 검증`);
p();
p(`- 판정기가 낸 결함 후보 ${allFindings.length}건 중 인용 확인 실패 ${pct(unverified.length, allFindings.length)}`);
p(`- 인용 확인 실패는 보류 사유로 쓰지 않는다 (판정기가 지어낸 근거 차단)`);
for (const f of unverified.slice(0, 10)) p(`  - ${f.type}: 대본 "${f.script_quote.slice(0, 40)}" / 원문 "${f.source_quote.slice(0, 40)}"`);
p();

// 5. 장르·비용
const genreHit = ids.filter((id) => samples[id]?.genre && byId(id)[0].genre === samples[id].genre);
const genreDen = ids.filter((id) => samples[id]?.genre && byId(id)[0].genre);
const cost = ok.reduce((n, r) => n + (r.usage?.cost_usd ?? 0), 0);
const lat = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
p(`## ${runs > 1 ? 5 : 4}. 장르 분류·비용·지연`);
p();
p(`품질 점수는 v1에서 변별력이 거의 없음을 확인(77~96점에 몰림)해 참고용으로만 둔다.`);
p();
p(`- 장르 분류 일치 (사람 표시 대비): ${pct(genreHit.length, genreDen.length)}`);
p(`- 비용 합계 $${cost.toFixed(4)} · 판정 1건 평균 $${(cost / Math.max(1, ok.length)).toFixed(4)}`);
p(`- 지연 중앙값 ${lat.length ? (lat[Math.floor(lat.length / 2)] / 1000).toFixed(1) : '-'}초 · 최대 ${lat.length ? (lat[lat.length - 1] / 1000).toFixed(1) : '-'}초`);
p();

// 6. 샘플별 상세
p(`## 샘플별 상세 (첫 번째 실행)`);
p();
for (const id of ids) {
  const r = byId(id)[0];
  const lab = labels[id];
  const agree = lab?.verdict ? (lab.verdict === r.verdict ? '일치' : '**불일치**') : '라벨 없음';
  p(`### ${id} · 사람 ${lab?.verdict ?? '-'} / 판정기 ${r.verdict} (${agree})`);
  p();
  p(`- 제목: ${samples[id]?.title ?? ''}`);
  p(`- 장르: 사람 ${samples[id]?.genre ?? '-'} / 판정기 ${r.genre ?? '-'} · 위험 신호: ${r.risk_signals ? `건강 ${r.risk_signals.health ? 'O' : 'X'}, 금융 ${r.risk_signals.finance ? 'O' : 'X'}` : '-'}`);
  if (lab?.gate_reasons.length) p(`- 사람 사유: ${lab.gate_reasons.join(' / ')}`);
  if (r.input_issue) p(`- 입력 문제: ${r.input_issue}`);
  for (const f of r.findings ?? []) {
    const tag = f.gating ? '보류' : f.evidence_ok ? '참고' : '인용 실패';
    p(`- [${tag}] ${f.type}${f.original_type ? ` (LLM은 ${f.original_type}로 분류, 코드가 재분류)` : ''} · 섹션 ${f.section_idx + 1}: ${f.explanation}`);
    p(`  - 대본: "${f.script_quote}"`);
    if (f.source_quote) p(`  - 원문: "${f.source_quote}"`);
  }
  if (r.checks?.length) {
    const bad = r.checks.filter((c) => c.result !== '일치');
    p(`- 대조한 주장 ${r.checks.length}건 (숫자 ${r.checks.filter((c) => c.kind === '숫자').length} · 주체 ${r.checks.filter((c) => c.kind === '주체').length} · 단정 ${r.checks.filter((c) => c.kind === '단정').length}), 불일치·근거 없음 ${bad.length}건`);
    for (const c of bad) p(`  - [${c.kind}·섹션 ${c.section_idx + 1}·${c.result}] ${c.script_claim} ↔ ${c.source_basis}`);
  }
  if (r.scores?.length) p(`- 점수 ${r.weighted_score ?? '-'}/100: ${r.scores.map((s) => `${s.item} ${s.score}`).join(', ')}`);
  if (r.diagnostics?.length) p(`- 진단: ${r.diagnostics.filter((d) => !d.code.endsWith('finding')).map((d) => d.message).join(' / ') || '-'}`);
  p();
}
if (errors.length) {
  p(`## 오류`);
  for (const e of errors) p(`- ${e.id} run${e.run}: ${e.error}`);
}

const report = L.join('\n');
writeFileSync(file.replace(/\.jsonl$/, '.report.md'), report + '\n');
console.log(report);

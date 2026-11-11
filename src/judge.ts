/**
 * 대본 품질 판정기.
 *
 *   원문 정제 → [규칙] 입력 부족? ──예──> 보류 (입력 문제)
 *                     │아니오
 *                     ├─> [LLM] 게이트: 장르·위험 신호·결함 후보(인용 포함)
 *                     │      └─> [코드] 인용 검증 → 보류 여부 결정
 *                     ├─> [LLM] 품질 점수 5항목 → 장르별 가중 평균 (참고용)
 *                     └─> [규칙] 진단: 길이, 말투 혼용, 섹션 반복
 *
 * 보류는 1단계 게이트만으로 결정한다. 점수는 참고 정보다 (docs/criteria.md).
 */
import { addUsage, ZERO_USAGE, type LlmClient } from './llm.js';
import { SCORE_SCHEMA, SCORE_SYSTEM, gateSchema, gateSystem, gateUser, scoreUser, type PromptVersion } from './prompts.js';
import { checkInput, diagnostics } from './rules.js';
import { cleanSource, quoteMatch } from './text.js';
import {
  SCORE_ITEMS,
  type ClaimCheck,
  type Finding,
  type Genre,
  type JudgeResult,
  type Sample,
  type ScoreDetail,
  type ScoreItem,
} from './types.js';

/** 인용이 이 이상 비슷해야 실제로 있는 인용으로 인정 */
export const QUOTE_MATCH_MIN = 0.8;

/** 장르별 가중치 (높음 3, 보통 2, 낮음 1). docs/criteria.md 표와 같다 */
export const WEIGHTS: Record<Genre, Record<ScoreItem, number>> = {
  보도: { '핵심 누락': 3, '훅 흡인력': 2, '훅 회수': 2, 흐름: 2, '글의 목적 보존': 1 },
  '정보·해설': { '핵심 누락': 3, '훅 흡인력': 2, '훅 회수': 2, 흐름: 2, '글의 목적 보존': 3 },
  홍보: { '핵심 누락': 2, '훅 흡인력': 3, '훅 회수': 2, 흐름: 2, '글의 목적 보존': 3 },
  '경험·의견': { '핵심 누락': 2, '훅 흡인력': 3, '훅 회수': 2, 흐름: 2, '글의 목적 보존': 3 },
};

interface GateOutput {
  genre: Genre;
  risk_signals: { health: boolean; finance: boolean; reason: string };
  checks?: ClaimCheck[];
  findings: Finding[];
}

/** 원문과 비교해야만 성립하는 유형. 원문 인용 없이 올라오면 근거 부족으로 본다 */
const NEEDS_SOURCE_QUOTE = new Set(['범위 확대', '귀속 오류', '확실성 변화']);

/** 유보 표현. 원문 인용엔 있고 대본 인용엔 없으면 확실성 변화로 본다 */
export const HEDGE = /알려졌|알려져|알려진|추정|것으로 보인|것으로 보여|것으로 보고 있|연구 결과|연구가 있|가능성|수 있다|수 있어|수도 있|것으로 전해|전해졌|라는 분석|평가가 나|라고 한다|라는 주장/;

/**
 * LLM이 붙인 유형 이름을 그대로 믿지 않는다.
 * v1·v2a에서 "안다고 알려져 → 알고"를 확실성 변화가 아니라 사실 오류로 분류한 일이 있었다 (s07).
 * 사실 오류는 위험 신호와 무관하게 보류라서, 유형이 틀리면 장르별 차등 규칙이 무너진다.
 * 그래서 원문 인용에 유보 표현이 있고 대본 인용에 없으면 코드가 확실성 변화로 바꾼다.
 */
export function reclassify(f: Finding): Finding {
  if (f.type === '확실성 변화' || f.type === '귀속 오류' || f.type === '범위 확대') return f;
  if (HEDGE.test(f.source_quote) && !HEDGE.test(f.script_quote)) {
    return { ...f, type: '확실성 변화', original_type: f.type };
  }
  return f;
}

/**
 * 인용 검증 + 보류 여부 결정. LLM 판단을 그대로 믿지 않고,
 * (1) 대본 인용이 실제 대본에 있고 (2) 원문 인용이 있으면 실제 원문에 있을 때만 보류 사유로 쓴다.
 * 확실성 변화는 건강·금융 위험 신호가 있을 때만 보류 사유 (s07 vs s08 결정).
 */
export function resolveFindings(findings: Finding[], scriptText: string, source: string, risk: GateOutput['risk_signals']): Finding[] {
  return findings.map(reclassify).map((f) => {
    const scriptOk = quoteMatch(f.script_quote, scriptText) >= QUOTE_MATCH_MIN;
    const sourceOk = f.source_quote === ''
      ? !NEEDS_SOURCE_QUOTE.has(f.type) // 사실 오류·의미 왜곡은 "원문에 아예 없음"일 수 있음
      : quoteMatch(f.source_quote, source) >= QUOTE_MATCH_MIN;
    const evidence_ok = scriptOk && sourceOk;
    const riskOk = f.type !== '확실성 변화' || risk.health || risk.finance;
    return { ...f, evidence_ok, gating: evidence_ok && riskOk };
  });
}

export function weightedScore(scores: ScoreDetail[], genre: Genre | null): number | null {
  if (!genre || scores.length === 0) return null;
  const w = WEIGHTS[genre];
  let num = 0;
  let den = 0;
  for (const s of scores) {
    const weight = w[s.item] ?? 0;
    num += weight * ((s.score - 1) / 4);
    den += weight;
  }
  return den ? Math.round((num / den) * 100) : null;
}

export async function judge(
  sample: Sample,
  llm: LlmClient,
  opts: { score?: boolean; prompt?: PromptVersion } = {},
): Promise<JudgeResult> {
  const pv: PromptVersion = opts.prompt ?? 'v2a';
  const t0 = Date.now();
  const source = cleanSource(sample.source_text);
  const diag = diagnostics(sample);
  const base = {
    id: sample.id,
    diagnostics: diag,
    model: llm.model,
    prompt_version: pv,
  };

  // 1) 입력 부족이면 LLM을 부르지 않고 바로 보류. 대본 탓이 아니라 입력 탓이라는 걸 구분해 알린다.
  const inputIssue = checkInput(source);
  if (inputIssue) {
    return {
      ...base,
      verdict: '보류',
      hold_reasons: [`입력 부족: ${inputIssue}`],
      input_issue: inputIssue,
      genre: null,
      risk_signals: null,
      checks: [],
      findings: [],
      scores: [],
      weighted_score: null,
      usage: ZERO_USAGE,
      latency_ms: Date.now() - t0,
    };
  }

  // 2) 게이트 (LLM) + 품질 점수 (LLM)를 병렬로
  const scriptText = sample.sections.map((s) => s.text).join('\n');
  const gateP = llm.json<GateOutput>({ name: 'gate', system: gateSystem(pv), user: gateUser(sample, source, pv), schema: gateSchema(pv) });
  const scoreP = opts.score === false
    ? Promise.resolve(null)
    : llm.json<{ scores: ScoreDetail[] }>({ name: 'score', system: SCORE_SYSTEM, user: scoreUser(sample, source), schema: SCORE_SCHEMA });
  const [gate, score] = await Promise.all([gateP, scoreP]);

  const findings = resolveFindings(gate.data.findings, scriptText, source, gate.data.risk_signals);
  const gating = findings.filter((f) => f.gating);

  const scores: ScoreDetail[] = (score?.data.scores ?? [])
    .filter((s) => SCORE_ITEMS.includes(s.item))
    .map((s) => ({ ...s, score: Math.min(5, Math.max(1, Math.round(s.score))) }));

  // 보류는 안 됐지만 알려줄 것: 인용 검증 실패, 위험 신호 없는 확실성 변화
  for (const f of findings.filter((x) => !x.gating)) {
    diag.push({
      code: f.evidence_ok ? 'soft_finding' : 'unverified_finding',
      message: `${f.evidence_ok ? '' : '[인용 확인 안 됨] '}${f.type} (섹션 ${f.section_idx + 1}): ${f.explanation}`,
    });
  }

  return {
    ...base,
    verdict: gating.length ? '보류' : '통과',
    hold_reasons: gating.map((f) => `${f.type} (섹션 ${f.section_idx + 1}): ${f.explanation}`),
    input_issue: null,
    genre: gate.data.genre,
    risk_signals: gate.data.risk_signals,
    checks: gate.data.checks ?? [],
    findings,
    scores,
    weighted_score: weightedScore(scores, gate.data.genre),
    usage: score ? addUsage(gate.usage, score.usage) : gate.usage,
    latency_ms: Date.now() - t0,
  };
}

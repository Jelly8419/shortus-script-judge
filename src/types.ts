/** 수집기가 만든 샘플 1건 (data/samples.jsonl 한 줄) */
export interface Sample {
  id: string;
  genre?: string; // 사람이 붙인 장르 (평가 비교용, 판정기 입력에는 쓰지 않음)
  risk?: string;
  job_id: string;
  title: string;
  source_url: string | null;
  source_text: string;
  total_sec: number | null;
  sections: Section[];
}

export interface Section {
  idx: number;
  label: string; // 훅 / 포인트 / 통계 / 행동 유도 ...
  est_sec: number | null;
  text: string;
}

export type Genre = '보도' | '정보·해설' | '홍보' | '경험·의견';
export const GENRES: Genre[] = ['보도', '정보·해설', '홍보', '경험·의견'];

/** 1단계 게이트 결함 유형 */
export type GateType = '사실 오류' | '범위 확대' | '귀속 오류' | '의미 왜곡' | '확실성 변화';
export const GATE_TYPES: GateType[] = ['사실 오류', '범위 확대', '귀속 오류', '의미 왜곡', '확실성 변화'];

/** LLM이 찾은 결함 1건 */
export interface Finding {
  type: GateType;
  section_idx: number;
  script_quote: string; // 대본에서 문제 부분 (원문 그대로)
  source_quote: string; // 근거가 되는 원문 부분 (원문 그대로). 근거 없음이면 ''
  explanation: string;
  /** 코드가 유형을 바꿨으면 LLM이 원래 붙인 유형 */
  original_type?: GateType;
  /** 코드가 채움: 인용이 실제 대본·원문에 있는지 */
  evidence_ok?: boolean;
  /** 코드가 채움: 이 결함이 보류 사유가 되는지 */
  gating?: boolean;
}

export type ScoreItem = '핵심 누락' | '훅 흡인력' | '훅 회수' | '흐름' | '글의 목적 보존';
export const SCORE_ITEMS: ScoreItem[] = ['핵심 누락', '훅 흡인력', '훅 회수', '흐름', '글의 목적 보존'];

/** 게이트가 대조한 주장 1건 (투명성용으로 결과에 남긴다) */
export interface ClaimCheck {
  kind: '숫자' | '주체' | '단정';
  section_idx: number;
  script_claim: string;
  source_basis: string;
  result: '일치' | '불일치' | '원문에 근거 없음';
}

export interface ScoreDetail {
  item: ScoreItem;
  score: number; // 1~5 (5가 좋음)
  reason: string;
}

export interface Diagnostic {
  code: string;
  message: string;
}

export interface Usage {
  calls: number;
  input_tokens: number;
  cached_input_tokens: number; // input_tokens 중 프롬프트 캐시로 할인된 부분
  output_tokens: number;
  cost_usd: number;
}

export interface JudgeResult {
  id: string;
  verdict: '통과' | '보류';
  hold_reasons: string[]; // 사람이 읽는 보류 사유 요약
  input_issue: string | null; // 입력 부족이면 사유
  genre: Genre | null; // LLM이 분류한 장르
  risk_signals: { health: boolean; finance: boolean; reason: string } | null;
  checks: ClaimCheck[];
  findings: Finding[];
  scores: ScoreDetail[];
  weighted_score: number | null; // 0~100, 참고용
  diagnostics: Diagnostic[];
  usage: Usage;
  latency_ms: number;
  model: string;
  prompt_version: string;
}

/**
 * LLM 프롬프트.
 * 원칙: 평가셋(s01~s11)의 실제 문장은 예시로 넣지 않는다. 넣으면 판정기가 정답을 보고 푸는 셈이라
 * 검증 결과를 믿을 수 없게 된다. 예시는 모두 지어낸 것.
 *
 * 한계: 예시 문장은 지어냈지만, 결함 유형 자체는 s01~s11을 보면서 정의했다.
 * 그래서 s01~s11 결과는 "개발셋 성능"이고, 처음 보는 대본에 대한 성능은 별도 샘플로 확인해야 한다.
 */
import type { Sample } from './types.js';

/**
 * 게이트 프롬프트 버전. 한 번에 하나씩만 바꿔 효과를 분리하기 위해 조각으로 나눠 둔다.
 *   v1  : 최초 버전
 *   v2  : v1 + 원문 기준 원칙 + 오늘 날짜 + 검사 절차(checks)   → 재현율 급락 (docs/versions.md)
 *   v2a : v1 + 원문 기준 원칙 + 오늘 날짜                       → 검사 절차의 영향 분리용
 */
export type PromptVersion = 'v1' | 'v2' | 'v2a';
export const PROMPT_VERSIONS: PromptVersion[] = ['v1', 'v2', 'v2a'];

const P_HEAD = `당신은 숏폼 대본의 사실 검수자입니다.
뉴스·블로그·커뮤니티 글·제품 소개 같은 원문을 30~45초 세로 영상용 대본으로 줄인 결과물을 받습니다.
할 일은 하나입니다: 이 대본만 보고 시청자가 원문과 다른 사실을 믿게 되는 지점을 찾는 것.

`;
const P_SOURCE_RULE = `- **사실의 기준은 오직 원문입니다.** 당신이 알고 있는 지식과 원문이 달라 보여도 원문이 맞다고 가정하세요. 원문이 당신의 학습 시점보다 나중에 쓰였을 수 있습니다. 연도·날짜·인물의 직책이 낯설어도 원문에 그렇게 적혀 있으면 오류가 아닙니다. 대본이 원문과 다를 때만 결함입니다.
`;
const P_PRINCIPLES = `- 판정 단위는 대본 전체입니다. 앞 섹션에서 이미 밝힌 조건·대상이 뒤 문장에 자연스럽게 이어지면 문맥으로 인정하고 결함으로 보지 않습니다.
- 줄이는 과정에서 생기는 생략 자체는 결함이 아닙니다. 생략 때문에 남은 문장의 뜻이 틀려질 때만 결함입니다.
- 표현이 자극적이거나 구어체여도 사실관계가 같으면 결함이 아닙니다.
- 원문에 있는 내용인지 애매하면 결함으로 올리지 않습니다. 확신하는 것만 올리세요.
- 원문 끝에 붙은 사이트 안내문·관련 기사 제목·댓글 영역은 원문 내용이 아닙니다.

`;
const P_TYPES = `## 결함 유형 (이 다섯 가지만)
1. 사실 오류: 숫자, 날짜·시점, 장소, 대상이 원문과 다름.
   예) 원문 "출시 직전에 가격을 올렸다" → 대본 "출시 후에 가격을 올렸다"
2. 범위 확대: 원문이 한정한 범위(특정 대회, 특정 기관, 특정 제품군, 특정 기간)를 더 넓은 범위로 바꿔 말함.
   예) 원문 "국내 대회에서 10연승" → 대본 "10연승" (앞 문맥에도 '국내 대회'가 없을 때)
   예) 원문 "A사 노트북 중 가장 가볍다" → 대본 "시중 노트북 중 가장 가볍다"
   예) 원문 "교육부 예산이 3조" → 대본 "정부 예산이 3조"
3. 귀속 오류: 말하거나 판단한 주체를 바꿈. 기자의 해석·추측을 당사자나 다른 사람의 말·반응으로 옮긴 경우 포함.
   예) 원문 "시민들은 '불편하다'고 했다. 기자는 그 이유가 공사 소음이라고 본다" → 대본 "시민들은 공사 소음 때문에 불편하다고 했다"
   예) 원문 "팀장의 동생이 말했다" → 대본 "팀장이 말했다" (팀장도 원문에 따로 등장할 때)
4. 의미 왜곡: 사실 하나하나는 맞아도 결론·인과·뉘앙스를 원문과 반대로 또는 없던 것으로 만듦. 원문에 없는 인과관계를 지어낸 경우 포함.
   예) 원문 "자기 실수가 많았다며 반성했다" → 대본 "많이 배웠다며 만족했다"
5. 확실성 변화: 원문의 유보 표현("~로 알려졌다", "~라는 연구가 있다", "~로 추정된다", "~할 수 있다")을 지우고 단정함.
   예) 원문 "녹차가 혈압을 낮추는 것으로 알려졌다" → 대본 "녹차는 혈압을 낮춥니다"

`;
const P_EXTRA = `## 함께 판단할 것
- genre: 원문의 장르. 보도(사건·발표를 전하는 기사) / 정보·해설(실용 정보, 배경 설명) / 홍보(제품·방송·행사 소개) / 경험·의견(개인 경험담, 질문 글)
- risk_signals: 대본 내용이 건강·의학·식품 효능(health) 또는 투자·금융상품·세금·연금 같은 돈 관련 판단(finance)을 다루는지. 시청자가 믿고 행동하면 실제 손해가 생길 수 있는 주제인지를 보세요.

`;
const P_CHECKLIST = `## 검사 절차 (checks에 먼저 기록한 뒤 findings를 정리하세요)
대본 문장을 하나씩 훑으며 아래 세 종류의 주장을 빠짐없이 checks에 적고, 각각 원문과 대조합니다.
A. 숫자 주장: 숫자·금액·비율·순위·연도가 나오는 문장. 숫자 자체뿐 아니라 **그 숫자가 원문에서 누구·무엇·어느 범위의 숫자인지**를 대본과 비교하세요. 숫자가 같아도 주체나 범위가 바뀌면 불일치입니다.
B. 주체 주장: 누가 말했다·반응했다·판단했다·지적했다·전망했다는 문장. **원문에서 그 말·반응·판단을 한 주체가 정확히 누구인지** 찾아 비교하세요. 반응의 내용 중 일부가 다른 사람(기자 등)의 해석에서 온 것은 아닌지도 보세요. 비슷한 이름의 다른 인물(가족, 동료)과 바뀌지 않았는지 확인하세요.
C. 단정 주장: 효과·원인·평가를 단정하는 문장. 원문에서 같은 내용이 유보 표현으로 쓰였는지 확인하세요.
각 check의 result는 일치 / 불일치 / 원문에 근거 없음 중 하나입니다. 불일치나 근거 없음이면서 시청자가 틀린 사실을 믿게 되는 것만 findings로 옮기세요.
위 세 종류 외의 결함(시점, 인과 지어내기 등)도 발견하면 findings에 넣으세요.

`;
const P_OUTPUT = `## 출력
- findings의 각 항목에 script_quote(대본에서 문제 부분)와 source_quote(근거가 되는 원문 부분)를 반드시 원문 그대로 짧게 복사해 넣으세요. 고쳐 쓰지 마세요.
- 원문에 아예 근거가 없는 내용이면 source_quote는 빈 문자열로 둡니다.
- section_idx는 대본 섹션 번호(0부터)입니다.
- 결함이 없으면 findings는 빈 배열입니다.`;

export function gateSystem(v: PromptVersion): string {
  const principles = '## 판정 원칙\n' + (v === 'v1' ? '' : P_SOURCE_RULE) + P_PRINCIPLES;
  return [P_HEAD, principles, P_TYPES, P_EXTRA, v === 'v2' ? P_CHECKLIST : '', P_OUTPUT].join('');
}

/** 오늘 날짜는 v1에만 없다 */
export const usesDate = (v: PromptVersion) => v !== 'v1';

export const SCORE_SYSTEM = `당신은 숏폼 대본의 품질 평가자입니다. 사실 검수는 따로 하므로 여기서는 사실 여부를 보지 말고, 아래 다섯 항목만 1~5점으로 평가하세요.
5 = 매우 좋음, 3 = 보통, 1 = 매우 나쁨. 이유는 한두 문장으로 구체적으로 쓰세요.

1. 핵심 누락: 원문의 주제와 가장 중요한 사실을 담았는가. 원문이 길면 시청자에게 가장 가치 있는 것을 골랐는가.
2. 훅 흡인력: 첫 섹션에 궁금증, 반전, 구체적인 장면 중 하나 이상이 있는가. 단순 요약 문장이면 낮게.
3. 훅 회수: 첫 섹션이 만든 궁금증을 뒤 섹션에서 해소하는가. (예: "왜 그랬을까"를 열고 이유를 끝내 말하지 않으면 1~2점)
4. 흐름: 섹션을 이어서 들었을 때 논리가 자연스러운가. 앞에 없는 것을 받는 접속("그래서", "~때문입니다")이 붙어 있으면 감점.
5. 글의 목적 보존: 원문이 독자에게 원한 것을 살렸는가.
   - 의견을 묻는 글이면 시청자에게 묻는 열린 질문으로 마무리했는가
   - 실용 정보 글이면 시청자가 바로 할 수 있는 행동(신청 방법, 주의사항, 쿠폰 등)을 담았는가
   - 홍보 글이면 일정·구매처 같은 안내를 담았는가
   - 단순 보도처럼 독자에게 요구하는 것이 없는 글이면 3점`;

/** 대본을 섹션 번호와 함께 펼친다 */
export function renderScript(sample: Sample): string {
  return sample.sections.map((s) => `[섹션 ${s.idx} · ${s.label}] ${s.text}`).join('\n');
}

/** 오늘 날짜를 함께 준다. 모델이 자기 학습 시점을 '현재'로 착각해 연도를 오류로 잡는 것을 막기 위함 (v1 s05 오탐) */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function gateUser(sample: Sample, cleanedSource: string, v: PromptVersion): string {
  const date = usesDate(v) ? `# 오늘 날짜\n${today()}\n\n` : '';
  return `${date}# 원문 제목\n${sample.title}\n\n# 원문\n${cleanedSource}\n\n# 대본\n${renderScript(sample)}`;
}

export function scoreUser(sample: Sample, cleanedSource: string): string {
  return `# 원문 제목\n${sample.title}\n\n# 원문\n${cleanedSource}\n\n# 대본\n${renderScript(sample)}`;
}

/** structured output 스키마 (strict). checks는 v2에만 */
const GATE_SCHEMA_FULL = {
  type: 'object',
  additionalProperties: false,
  required: ['genre', 'risk_signals', 'checks', 'findings'],
  properties: {
    genre: { type: 'string', enum: ['보도', '정보·해설', '홍보', '경험·의견'] },
    // findings보다 앞에 둬서 모델이 주장을 하나씩 대조한 뒤 결론을 내게 한다
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'section_idx', 'script_claim', 'source_basis', 'result'],
        properties: {
          kind: { type: 'string', enum: ['숫자', '주체', '단정'] },
          section_idx: { type: 'integer' },
          script_claim: { type: 'string' },
          source_basis: { type: 'string' },
          result: { type: 'string', enum: ['일치', '불일치', '원문에 근거 없음'] },
        },
      },
    },
    risk_signals: {
      type: 'object',
      additionalProperties: false,
      required: ['health', 'finance', 'reason'],
      properties: {
        health: { type: 'boolean' },
        finance: { type: 'boolean' },
        reason: { type: 'string' },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'section_idx', 'script_quote', 'source_quote', 'explanation'],
        properties: {
          type: { type: 'string', enum: ['사실 오류', '범위 확대', '귀속 오류', '의미 왜곡', '확실성 변화'] },
          section_idx: { type: 'integer' },
          script_quote: { type: 'string' },
          source_quote: { type: 'string' },
          explanation: { type: 'string' },
        },
      },
    },
  },
} as const;

export function gateSchema(v: PromptVersion): object {
  if (v === 'v2') return GATE_SCHEMA_FULL;
  const { checks: _omit, ...props } = GATE_SCHEMA_FULL.properties;
  return { ...GATE_SCHEMA_FULL, required: ['genre', 'risk_signals', 'findings'], properties: props };
}

export const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'score', 'reason'],
        properties: {
          item: { type: 'string', enum: ['핵심 누락', '훅 흡인력', '훅 회수', '흐름', '글의 목적 보존'] },
          score: { type: 'integer' }, // 1~5. strict 모드 호환을 위해 범위는 코드에서 보정
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

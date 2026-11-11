/**
 * 텍스트 유틸: 원문 정제, 정규화, 유사도.
 * 원문에는 포털 하단 안내문·관련기사 목록·자동요약 블록 같은 잡음이 섞여 들어온다 (s01, s03, s06, s10).
 * 판정기가 잡음을 사실로 착각하지 않도록, LLM에 넘기기 전에 걷어낸다.
 */

/** 이 줄부터 아래는 본문이 아니다 (포털·언론사 하단 영역) */
const END_MARKERS: RegExp[] = [
  /^Copyright\s*[ⓒ©]/i,
  /[ⓒ©].*(무단|All rights reserved)/i,
  /본문의 검색 링크는 AI 자동 인식/,
  /^☞/,
  /기사 섹션 분류 안내/,
  /이 기사는 언론사에서 .*분류했습니다/,
  /^함께 볼만한 뉴스/,
  /^베스트 댓글$/,
];

/** 이 줄들은 블록째 버린다: [시작 패턴, 끝 패턴(포함)] */
const DROP_BLOCKS: Array<[RegExp, RegExp]> = [
  // 다음 뉴스 자동요약 + 글자크기 설정 UI
  [/자동요약/, /\(예시\) 가장 빠른 뉴스/],
];

/** 한 줄짜리 잡음 */
const DROP_LINES: RegExp[] = [/글자크기/, /^\|?\s*\|?$/];

export function cleanSource(raw: string): string {
  const lines = raw.replace(/ /g, ' ').split('\n');
  const out: string[] = [];
  let dropUntil: RegExp | null = null;

  for (const line of lines) {
    const t = line.trim();
    if (dropUntil) {
      if (dropUntil.test(t)) dropUntil = null;
      continue;
    }
    if (END_MARKERS.some((re) => re.test(t))) break;
    const block = DROP_BLOCKS.find(([start]) => start.test(t));
    if (block) {
      dropUntil = block[1];
      continue;
    }
    if (DROP_LINES.some((re) => re.test(t))) continue;
    out.push(t);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 본문으로 볼 만한 분량. 40자 이상 줄의 글자 수 합.
 * 사이트 메뉴(짧은 단어 줄)만 가져온 경우(s04)를 걸러내기 위한 값.
 */
export function bodyChars(text: string): number {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 40)
    .reduce((n, l) => n + l.length, 0);
}

/** 비교용 정규화: 공백·따옴표·말줄임표 통일 */
export function normalize(s: string): string {
  return s
    .replace(/[‘’‚‛'`]/g, "'")
    .replace(/[“”„"]/g, '"')
    .replace(/…/g, '...')
    .replace(/‑|–|—/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const c = s.replace(/\s/g, '');
  const m = new Map<string, number>();
  for (let i = 0; i < c.length - 1; i++) {
    const b = c.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** 문자 bigram Dice 유사도 (0~1) */
export function dice(a: string, b: string): number {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  if (total === 0) return 0;
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return (2 * inter) / total;
}

/**
 * 인용문이 본문에 실제로 있는지.
 * 정확히 있으면 1, 아니면 같은 길이 창을 밀며 가장 비슷한 구간의 유사도를 돌려준다.
 * LLM이 인용을 살짝 다듬어 옮기는 경우를 허용하되, 지어낸 인용은 걸러내기 위함.
 */
export function quoteMatch(quote: string, haystack: string): number {
  const q = normalize(quote);
  const h = normalize(haystack);
  if (!q) return 0;
  if (h.includes(q)) return 1;
  const len = q.length;
  const step = Math.max(1, Math.floor(len / 4));
  let best = 0;
  for (let i = 0; i + Math.floor(len * 0.6) <= h.length; i += step) {
    const d = dice(q, h.slice(i, i + len));
    if (d > best) best = d;
    if (best >= 0.98) break;
  }
  return best;
}

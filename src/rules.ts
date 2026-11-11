/**
 * 규칙 기반 검사. LLM을 부르지 않고 결정적으로 판단할 수 있는 것만 둔다.
 * - 입력 부족: 게이트 (s04)
 * - 길이, 말투 혼용, 섹션 반복: 진단만
 */
import { bodyChars, dice } from './text.js';
import type { Diagnostic, Sample } from './types.js';

/** 본문 분량이 이보다 적으면 입력 부족. s04(0자)와 정상 샘플 중 가장 짧은 s06(약 1,000자) 사이에서 보수적으로 잡음 */
export const MIN_BODY_CHARS = 200;

export function checkInput(cleanedSource: string): string | null {
  const n = bodyChars(cleanedSource);
  if (n < MIN_BODY_CHARS) {
    return `원문 본문이 ${n}자뿐입니다 (기준 ${MIN_BODY_CHARS}자). 원문 추출이 실패했을 수 있으니 원문 텍스트를 직접 넣어 주세요.`;
  }
  return null;
}

export function diagnostics(sample: Sample): Diagnostic[] {
  const out: Diagnostic[] = [];

  // 길이: 회사 소개 기준 30~45초. 품질 기준이 아니라 사양이라 진단만 (docs/criteria.md)
  const sec = sample.total_sec ?? sample.sections.reduce((n, s) => n + (s.est_sec ?? 0), 0);
  if (sec < 30 || sec > 45) {
    out.push({ code: 'length', message: `예상 길이 ${sec.toFixed(1)}초 (서비스 소개 기준 30~45초 밖)` });
  }

  // 말투 혼용: 섹션 끝맺음이 해요체와 합니다체로 섞였는지
  const styles = new Set<string>();
  for (const s of sample.sections) {
    const t = s.text.trim().replace(/[.!?…"'”’)\]]+$/, '');
    if (/(습|ㅂ)?니다$/.test(t)) styles.add('합니다체');
    else if (/[요죠]$/.test(t)) styles.add('해요체');
  }
  if (styles.size > 1) {
    out.push({ code: 'tone_mix', message: '해요체와 합니다체가 섞여 있습니다' });
  }

  // 섹션 반복: 다른 섹션이나 제목을 거의 그대로 되풀이 (s04 3번째 섹션)
  const texts = sample.sections.map((s) => s.text);
  for (let i = 0; i < texts.length; i++) {
    const others = [...texts.slice(0, i), ...texts.slice(i + 1), sample.title];
    const worst = Math.max(...others.map((o) => dice(texts[i], o)));
    if (worst >= 0.7) {
      out.push({ code: 'repeat', message: `섹션 ${i + 1}이 다른 섹션이나 제목을 거의 반복합니다 (유사도 ${worst.toFixed(2)})` });
    }
  }

  return out;
}

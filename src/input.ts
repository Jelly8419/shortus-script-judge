/**
 * 손으로 붙여넣은 대본 텍스트를 섹션으로 나눈다 (npm run judge:one).
 */
import type { Section } from './types.js';

/** 쇼더스 나레이션 1.1배속 기준 공백 제외 글자 수/초 (수집한 55개 섹션의 중앙값 5.47, 범위 5.1~5.9) */
export const CHARS_PER_SEC = 5.47;

/**
 * 한 줄에 섹션 하나. "훅: 문장" / "훅 | 문장" / "[훅] 문장" / "문장" 모두 받는다.
 * 앞부분이 12자 이하일 때만 라벨로 본다 (본문 속 콜론을 라벨로 착각하지 않게).
 * 라벨이 없으면 첫 줄은 훅, 나머지는 포인트.
 */
export function parseScript(text: string): Section[] {
  const lines = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line, idx) => {
    const m = line.match(/^\[([^\]]{1,12})\]\s*(.+)$/) ?? line.match(/^([^:：|"'“]{1,12})\s*[:：|]\s*(.+)$/);
    const label = m ? m[1].trim() : idx === 0 ? '훅' : '포인트';
    const body = m ? m[2].trim() : line;
    return { idx, label, est_sec: +(body.replace(/\s/g, '').length / CHARS_PER_SEC).toFixed(1), text: body };
  });
}

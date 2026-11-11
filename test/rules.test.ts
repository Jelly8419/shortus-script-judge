import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { reclassify, resolveFindings, weightedScore } from '../src/judge.js';
import { checkInput, diagnostics } from '../src/rules.js';
import { bodyChars, cleanSource, quoteMatch } from '../src/text.js';
import type { Finding, Sample } from '../src/types.js';

const samples: Record<string, Sample> = Object.fromEntries(
  readFileSync('data/samples.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => {
    const s = JSON.parse(l) as Sample;
    return [s.id, s];
  }),
);

test('원문 정제: 포털 하단·관련기사·자동요약·댓글 영역 제거', () => {
  const s01 = cleanSource(samples.s01.source_text);
  assert.ok(!s01.includes('자동요약'), '다음 자동요약 블록');
  assert.ok(!s01.includes('글자크기'), '글자크기 UI');
  assert.ok(!s01.includes('하리수'), '하단 관련기사 목록');
  assert.ok(s01.includes('정부 전체 AI 예산의 약 57%'), '본문은 남아야 함');

  const s03 = cleanSource(samples.s03.source_text);
  assert.ok(!s03.includes('오분류 제보'));
  assert.ok(s03.includes("작년의 자신에게 지지 않았다"));

  const s06 = cleanSource(samples.s06.source_text);
  assert.ok(!s06.includes('함께 볼만한 뉴스'));
  assert.ok(s06.includes('재입사'));

  const s10 = cleanSource(samples.s10.source_text);
  assert.ok(!s10.includes('베스트 댓글'));
  assert.ok(s10.includes('무리시키는건지 궁금해요'));
});

test('입력 부족: s04만 걸리고 나머지는 통과', () => {
  for (const [id, s] of Object.entries(samples)) {
    const issue = checkInput(cleanSource(s.source_text));
    if (id === 's04') assert.ok(issue, 's04는 입력 부족이어야 함');
    else assert.equal(issue, null, `${id}는 입력 충분 (본문 ${bodyChars(cleanSource(s.source_text))}자)`);
  }
});

test('진단: 길이·말투 혼용·반복', () => {
  const codes = (id: string) => diagnostics(samples[id]).map((d) => d.code);
  assert.ok(codes('s02').includes('length'), 's02 28.1초');
  assert.ok(!codes('s05').includes('length'), 's05 44.7초');
  assert.ok(codes('s01').includes('tone_mix'), 's01 해요체+합니다체');
  assert.ok(!codes('s05').includes('tone_mix'), 's05 합니다체로 일관');
  assert.ok(codes('s04').includes('repeat'), 's04 3번째 섹션이 제목 반복');
  assert.ok(!codes('s05').includes('repeat'));
});

test('인용 매칭: 실제 인용은 1, 지어낸 인용은 낮음', () => {
  const src = cleanSource(samples.s05.source_text);
  assert.equal(quoteMatch('공격수 부문에서 27.6%의 득표율을 기록했다', src), 1);
  assert.ok(quoteMatch('케인은 공격수 부문 투표에서 꼴찌를 기록했다', src) < 0.8);
});

const f = (over: Partial<Finding>): Finding => ({
  type: '사실 오류', section_idx: 0, script_quote: '', source_quote: '', explanation: '', ...over,
});

test('보류 결정: 인용 검증 실패는 보류 사유가 아님', () => {
  const s = samples.s06;
  const script = s.sections.map((x) => x.text).join('\n');
  const src = cleanSource(s.source_text);
  const [real, fake] = resolveFindings(
    [
      f({ script_quote: '입주 직전에 퇴사하는 선택을 했어요', source_quote: '입주자 모집 공고일 직전에 허위로 병원을 퇴사했다가' }),
      f({ script_quote: '의사 부부가 해외로 도피했어요', source_quote: '해외 도피' }),
    ],
    script, src, { health: false, finance: false, reason: '' },
  );
  assert.equal(real.gating, true);
  assert.equal(fake.evidence_ok, false);
  assert.equal(fake.gating, false);
});

test('보류 결정: 범위 확대·귀속 오류는 원문 인용이 있어야 보류 사유', () => {
  const s = samples.s11;
  const script = s.sections.map((x) => x.text).join('\n');
  const [noSrc] = resolveFindings(
    [f({ type: '범위 확대', script_quote: '기존 스마트폰보다 훨씬 넓은 화면', source_quote: '' })],
    script, cleanSource(s.source_text), { health: false, finance: false, reason: '' },
  );
  assert.equal(noSrc.gating, false);
});

test('보류 결정: 확실성 변화는 건강·금융 위험 신호가 있을 때만', () => {
  const s = samples.s07;
  const script = s.sections.map((x) => x.text).join('\n');
  const src = cleanSource(s.source_text);
  const finding = f({ type: '확실성 변화', script_quote: '코코는 약 100개의 한글 단어를 알고', source_quote: '약 100개의 한글 단어를 안다고 알려져' });
  assert.equal(resolveFindings([finding], script, src, { health: false, finance: false, reason: '' })[0].gating, false);
  assert.equal(resolveFindings([finding], script, src, { health: true, finance: false, reason: '' })[0].gating, true);
});

test('가중 점수: 장르별 가중치 적용, 0~100', () => {
  const all5 = ['핵심 누락', '훅 흡인력', '훅 회수', '흐름', '글의 목적 보존'].map((item) => ({ item, score: 5, reason: '' })) as never;
  assert.equal(weightedScore(all5, '보도'), 100);
  const mixed = [
    { item: '핵심 누락', score: 1, reason: '' },
    { item: '글의 목적 보존', score: 5, reason: '' },
  ] as never;
  // 보도는 핵심 누락 3 : 목적 1 → 25, 정보·해설은 3 : 3 → 50
  assert.equal(weightedScore(mixed, '보도'), 25);
  assert.equal(weightedScore(mixed, '정보·해설'), 50);
});

test('유형 재분류: 원문 유보 표현이 대본에서 사라지면 사실 오류 → 확실성 변화', () => {
  // v2a 실제 응답: s07을 사실 오류로 분류 (원문 인용은 한 구간으로 바꿔 넣음)
  const s07 = f({ type: '사실 오류', script_quote: '코코는 약 100개의 한글 단어를 알고', source_quote: '약 100개의 한글 단어를 안다고 알려져' });
  assert.equal(reclassify(s07).type, '확실성 변화');
  assert.equal(reclassify(s07).original_type, '사실 오류');
  // 위험 신호 없으면 보류 아님
  const s = samples.s07;
  const r = resolveFindings([s07], s.sections.map((x) => x.text).join('\n'), cleanSource(s.source_text), { health: false, finance: false, reason: '' });
  assert.equal(r[0].gating, false);

  // 유보 표현과 무관한 진짜 사실 오류는 그대로
  const s06 = f({ type: '사실 오류', script_quote: '입주 직전에 퇴사', source_quote: '입주자 모집 공고일 직전에 허위로 병원을 퇴사했다가' });
  assert.equal(reclassify(s06).type, '사실 오류');
  // 대본도 유보하고 있으면 그대로
  const kept = f({ type: '사실 오류', script_quote: '효과가 있는 것으로 알려졌어요', source_quote: '효과가 있는 것으로 알려졌다' });
  assert.equal(reclassify(kept).type, '사실 오류');
});

test('유형 재분류: "것으로 보고 있다" 같은 전망 표현도 유보로 본다', () => {
  const i04 = f({ type: '사실 오류', script_quote: '매달 100만 원 중반에서 200만 원 안팎의 연금을 받게 됩니다', source_quote: '200만 원 안팎의 연금을 수령할 것으로 보고 있다' });
  assert.equal(reclassify(i04).type, '확실성 변화');
});

test('judge:one 입력 파싱: 라벨 형식 여러 가지, 라벨 없으면 훅/포인트', async () => {
  const { parseScript } = await import('../src/input.js');
  const s = parseScript('﻿훅: 첫 문장\r\n[통계] 둘째 문장\n행동 유도 | 셋째\n\n이번 시범 운영 기간 동안 달라지는 점: 좌석 수가 줄어듭니다');
  assert.deepEqual(s.map((x) => x.label), ['훅', '통계', '행동 유도', '포인트']);
  assert.equal(s[3].text.startsWith('이번 시범 운영'), true); // 콜론 앞이 12자를 넘으면 라벨이 아니라 본문
  const plain = parseScript('그냥 첫 줄\n그냥 둘째 줄');
  assert.deepEqual(plain.map((x) => x.label), ['훅', '포인트']);
});

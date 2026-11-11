/*
 * ShortUs 스튜디오 대본 수집기
 *
 * 쓰는 법
 *   1. 쇼더스 스튜디오에서 기사로 만든 숏폼 작업 화면을 연다 (어느 단계든 상관없음)
 *   2. 개발자도구 콘솔(F12 → Console)에 이 파일 내용을 붙여넣고 Enter
 *      (또는 북마클릿으로 등록해 클릭)
 *   3. 작업 1건이 브라우저 저장소에 누적된다. 같은 작업을 다시 실행하면 덮어쓴다.
 *   4. 모은 걸 내려받을 때: 콘솔에서  __shortusDownload()  실행 → samples.jsonl 저장
 *      비우기:  __shortusClear()
 *
 * 하는 일
 *   - 입력 단계(step=1)로 이동해 "제작에 사용한 원문"과 제목·출처·생성시각을 읽는다
 *   - 대본 단계(step=2)로 이동해 섹션별 라벨·예상 길이·문장과 목소리·총 길이를 읽는다
 *   - 아무것도 수정하거나 저장 버튼을 누르지 않는다 (화면 단계 전환만 함)
 *
 * 주의: 화면 구조(클래스명)에 의존하므로 서비스가 바뀌면 깨질 수 있다.
 *       영상 입력(후보 단계가 있는 흐름)은 대상이 아니라 건너뛴다.
 */
(async () => {
  const STORE_KEY = 'shortus_samples_v1';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const m = location.hash.match(/#\/shorts\/([0-9a-f-]{36})/);
  if (!m) return console.warn('[수집기] 숏폼 작업 화면이 아닙니다.');
  const jobId = m[1];
  const base = `#/shorts/${jobId}`;

  // 화면 요소가 나타날 때까지 기다린다 (최대 8초)
  async function waitFor(fn, label) {
    for (let i = 0; i < 40; i++) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error(`화면에서 ${label}을(를) 찾지 못했습니다`);
  }

  async function goStep(n) {
    const target = `${base}?step=${n}`;
    if (location.hash !== target) {
      location.hash = target;
      await sleep(600);
    }
  }

  // 영상 입력 흐름이면 단계 이름에 '후보'가 있다
  const stepNames = [...document.querySelectorAll('button')].map((b) => b.innerText.trim());
  if (stepNames.includes('후보')) {
    return console.warn('[수집기] 영상 입력 흐름이라 건너뜁니다 (판정 범위 밖).');
  }

  // ── 1) 입력 단계: 원문 ──
  await goStep(1);
  const sourceBody = await waitFor(
    () => document.querySelector('.card.source-card .source-summary-body'),
    '원문',
  );
  const summary = document.querySelector('.card.source-card.source-summary');
  const metaLines = summary ? [...summary.querySelectorAll('p.card-meta')].map((p) => p.innerText.trim()) : [];
  const meta = (k) => (metaLines.find((l) => l.startsWith(`${k}:`)) || '').replace(`${k}:`, '').trim();
  const title = summary?.querySelector('.source-summary-title')?.innerText.trim() || document.title;

  // ── 2) 대본 단계: 섹션 ──
  await goStep(2);
  const cards = await waitFor(() => {
    const c = [...document.querySelectorAll('.card.script-section')];
    return c.length && c.every((x) => x.querySelector('textarea')) ? c : null;
  }, '대본 섹션');

  const sections = cards.map((card, i) => {
    const row = card.querySelector('.script-section-row');
    const leaves = [...row.querySelectorAll('*')]
      .filter((e) => e.children.length === 0)
      .map((e) => e.textContent.trim())
      .filter(Boolean);
    const secText = leaves.find((t) => /^약 [\d.]+초$/.test(t)) || '';
    return {
      idx: i,
      label: leaves[0] || '',
      est_sec: secText ? Number(secText.match(/[\d.]+/)[0]) : null,
      text: card.querySelector('textarea').value.trim(),
    };
  });

  const leafTexts = [...document.querySelectorAll('main *')]
    .filter((e) => e.children.length === 0)
    .map((e) => e.textContent.trim());
  const totalLine = leafTexts.find((t) => /\/ 100초$/.test(t)) || '';
  const voiceLine = leafTexts.find((t) => /·\s*[\d.]+x$/.test(t)) || '';

  const sample = {
    job_id: jobId,
    studio_url: `${location.origin}${location.pathname}${base}`,
    title,
    source_url: meta('출처') || null,
    created: meta('생성') || null,
    language: meta('언어') || null,
    source_text: sourceBody.innerText.trim(),
    voice: voiceLine.split('·')[0].trim() || null,
    speed: voiceLine ? Number((voiceLine.match(/([\d.]+)x/) || [])[1]) : null,
    total_sec: totalLine ? Number(totalLine.split('/')[0]) : null,
    sections,
    collected_at: new Date().toISOString(),
    // 사람이 채울 칸 (라벨링 단계에서 사용)
    profile: null,
    human_note: null,
  };

  const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  all[jobId] = sample;
  localStorage.setItem(STORE_KEY, JSON.stringify(all));

  console.log(
    `[수집기] 저장 완료 (${Object.keys(all).length}건 누적): ${title}\n` +
      `  원문 ${sample.source_text.length}자 · 섹션 ${sections.length}개 · ${sample.total_sec}초`,
  );

  window.__shortusDownload = () => {
    const rows = Object.values(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
    const blob = new Blob([rows.map((r) => JSON.stringify(r)).join('\n') + '\n'], {
      type: 'application/x-ndjson',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'samples.jsonl';
    a.click();
    console.log(`[수집기] ${rows.length}건 내려받기`);
  };
  window.__shortusClear = () => {
    localStorage.removeItem(STORE_KEY);
    console.log('[수집기] 비움');
  };

  return sample;
})();

/* boot.js — 모든 탭 파일이 불린 뒤 마지막으로 불린다 (메인 소유) */
'use strict';
(async () => {
  await poll();
  // 탭마다 init() 을 한 번씩
  Object.keys(TABS).forEach(id => { try { TABS[id].init && TABS[id].init(ST); } catch (e) { console.error(id, e); } });
  try {
    const done = localStorage.getItem('justUpdatedTo');
    if (done && ST && ST.version === done) { localStorage.removeItem('justUpdatedTo'); msg('최신 버전입니다 (v' + ST.version + ')', 'ok'); }
    else if (done && ST && ST.update && !ST.update.available) { localStorage.removeItem('justUpdatedTo'); msg('최신 버전입니다', 'ok'); }
  } catch (_) {}
  // ★새로고침하면 늘 감시 중으로 연다(2026-08-25). 채널이 하나도 없을 때만 시작하기로 안내한다.
  try { localStorage.removeItem('마지막탭'); } catch (_) {}
  // 주소에 ?tab=t3 처럼 주면 그 탭으로 연다 (시험·바로가기용)
  const want = new URLSearchParams(location.search).get('tab');
  if (want && document.getElementById(want)) swTab(want);
  else if (ST && !(ST.channels || []).length) swTab('t5'); else swTab('t1');
  // ★setInterval 은 그때의 함수 객체를 붙잡는다 — 물러난 창이 계속 서버를 두드리지 않도록 poll 안에서 물러남을 본다.
  setInterval(() => { if (visibleNow()) poll(); }, 1500);
  document.addEventListener('visibilitychange', () => { if (visibleNow()) poll(); });
})();

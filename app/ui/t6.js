/* t6.js — 💬 의견 탭 (옛 화면 그대로: sendFeedback · loadFeedbackList · openFeedbackFile)
 *   POST /api/feedback {kind,title,body} → {ok, url}   (깃허브 작성 창 주소 — 내용이 채워져 있다)
 *   GET  /api/feedback/list              → {ok, items:[{number,title,url,labels:[],closed,at}]}  (실패는 {ok:false, why})
 *   POST /api/openfeedback               → 바탕화면 의견 파일을 연다
 */
'use strict';
(() => {
  const ISSUES = 'https://github.com/beautifulahin/garasadae-uploader/issues';
  // 게시판의 상태 표를 화면 색으로 옮긴다. 모르는 표는 회색으로 그냥 보여 준다.
  const 의견색 = {
    '🆕 접수': '#0075ca', '🔍 살펴보는 중': '#fbca04', '🔧 고침 · 배포 대기': '#2dd4a8',
    '✅ 완료': '#3fb950', '❓ 확인 필요': '#d876e3', '🙅 안 하기로': '#8b949e',
    '🐞 오류': '#f85149', '💡 요청': '#a371f7',
  };
  let loaded = false, kind = 'idea', sending = false;

  async function call(path, body) {
    try { return await (body === undefined ? api(path) : api(path, body)); }
    catch (_) { return { ok: false, why: '앱과 연결되지 않았습니다. 잠시 뒤 다시 시도해 주세요' }; }
  }
  /** 서버가 준 주소는 http(s) 만 링크로 쓴다 */
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : ISSUES;

  window.t6PickKind = b => {
    document.querySelectorAll('#t6 [data-fk]').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); kind = b.dataset.fk;
  };

  window.t6Send = async () => {
    if (sending) return;
    const title = $('fbTitle').value.trim(), body = $('fbBody').value.trim();
    if (!title) return msg('한 줄 요약을 입력해 주세요', 'err');
    if (!body) return msg('자세한 내용을 입력해 주세요', 'err');
    sending = true; $('fbSend').disabled = true;
    const r = await call('/api/feedback', { kind, title, body });
    sending = false; $('fbSend').disabled = false;
    const bad = r.error || (r.ok === false && (r.why || '보내지 못했습니다'));
    if (bad) return msg(bad, 'err');
    $('fbTitle').value = ''; $('fbBody').value = '';
    msg('의견을 저장했습니다. 깃허브 창에서 Submit 을 눌러주세요', 'ok');
    setTimeout(() => t6Load(true), 8000);          // Submit 을 누를 짬을 주고 목록을 새로 본다
    if (r.url) ext(safeUrl(r.url));
  };

  window.t6Load = async force => {
    if (loaded && !force) return;
    loaded = true;
    const box = $('fbList');
    box.textContent = '불러오는 중…';
    const r = await call('/api/feedback/list');
    const bad = r.error || (r.ok === false && (r.why || '목록을 불러오지 못했습니다'));
    if (bad) {
      box.innerHTML = `<span style="color:var(--t3)">${esc(bad)} — <a href="${attr(ISSUES)}" target="_blank" rel="noopener" style="color:var(--blue)">게시판에서 직접 보기</a></span>`;
      loaded = false;                              // 다음에 탭을 열 때 다시 시도한다
      return;
    }
    const items = r.items || [];
    if (!items.length) { box.innerHTML = '<span style="color:var(--t3)">아직 올라온 의견이 없습니다. 첫 의견을 남겨 주세요.</span>'; return; }
    box.innerHTML = items.map(x => {
      const labels = (x.labels || []).map(n => {
        const c = 의견색[n] || '#6e7681';
        return `<span class="badge" style="background:${c}22;color:${c}">${esc(n)}</span>`;
      }).join(' ') || `<span class="badge wait">${x.closed ? '닫힘' : '열림'}</span>`;
      const when = String(x.at || '').slice(0, 10);
      return `<div style="padding:9px 0;border-bottom:1px solid var(--bdr)">
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px">${labels}
          <span style="color:var(--t3);font-size:10px">${esc(when)}</span></div>
        <a href="${attr(safeUrl(x.url))}" target="_blank" rel="noopener" style="color:var(--t1);text-decoration:none">#${esc(x.number)} ${esc(x.title)}</a>
      </div>`;
    }).join('');
  };

  window.t6OpenFile = async () => {
    const r = await call('/api/openfeedback', {});
    if (r.error || r.ok === false) msg(r.error || r.why || '파일을 열지 못했습니다', 'err');
  };

  registerTab('t6', { show() { t6Load(false); } });
})();

/* t4.js — ⚙️ 설정 탭 (그리고 정적 안내인 🚀 시작하기 탭 t5 의 진행 칩)
 *
 * 서버와의 약속(API_명세.md §7 · §9 · §10)
 *   POST /api/settings/get → {ok, settings:{osNotify, telegram:{configured,recipients,source,alerts}, ai:{on,hasKey,model},
 *        policy:{made_for_kids,contains_synthetic_media,default_category}, paths:{백업대상,외장뿌리,영상뿌리,ffmpeg,ffprobe},
 *        autoStart:{on,supported}, browser, dataDir, exePath, version, tools:{ffprobe}, (있으면 쓴다: baseDir, defaultBaseDir, browsers:[{id,name}])}}
 *   POST /api/settings/save {바꿀 칸만 같은 모양}   POST /api/telegram/save {token,chatIds[]} · /test   POST /api/autostart {on}
 *   AI: 열쇠 연결·바꾸기는 공통 창(openAi → modals.js). 이 카드는 켜기·끄기와 모델: POST /api/ai/save {on?,model?} · /test {key?,model?} · /disconnect
 *   쿠팡: 연결·바꾸기는 공통 창(openCoupang). 이 카드는 상태와 설정: POST /api/coupang/get|save|test
 *   인스타그램·스레드: POST /api/meta/get → {available:{on,instagram,threads}, accounts[], channels[{alias,instagram,threads}], jobs[], summary, signin}
 *        POST /api/meta/signin/start|check|stop {provider} · /disconnect {key} · /bind {alias,provider,key} · /job/retry|check|resolve|cancel {id,provider,…}
 *   POST /api/env/check · /self/check · /archive/keep · /archive/mirror      POST /api/mode/clear
 *   (명세에 없음 · 메인에게 요청) POST /api/dir/pick {prompt,start} → {ok,path}  — 폴더 고르는 운영체제 창, 아무것도 바꾸지 않는다
 *
 * 저장 방식: ①~④ 카드는 「설정 저장」 한 번에, 텔레그램·AI·쿠팡은 카드마다 따로, 켜기/끄기 스위치는 누르는 즉시 적용한다.
 * 폴링이 입력 중인 칸을 지우지 않게: 손댄 카드(dirty)나 글을 쓰는 중인 칸은 다시 채우지 않는다.
 */
'use strict';
(() => {
  let S = null;                  // 마지막 settings/get 의 settings
  let CP = null;                 // 마지막 coupang/get 응답
  let MT = null;                 // 마지막 meta/get 응답 (인스타그램·스레드)
  let mtLogin = false, mtUrl = '', mtAt = 0;
  let dirty = false;             // ①~④ 카드에 저장하지 않은 변경이 있다
  let aiDirty = false, cpDirty = false;
  let loading = false;
  const busy = new Set();        // 누르는 즉시 적용하는 스위치가 서버에 갔다 오는 중
  const hold = new Map();        // 스위치 id → 이때(ms)까지는 서버 상태로 되돌리지 않는다 (방금 누른 것을 직전 폴링의 옛 상태가 덮지 않게)

  async function call(path, body) {
    try { return await api(path, body === undefined ? {} : body); }
    catch (_) { return { ok: false, why: '앱과 연결되지 않았습니다. 잠시 뒤 다시 시도해 주세요' }; }
  }
  const val = id => ($(id) ? $(id).value.trim() : '');
  const hasHide = (id, hide) => { const e = $(id); if (e) e.classList.toggle('hide', !!hide); };
  const text = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  const typingIn = id => { const e = $(id); return !!e && document.activeElement === e; };

  /* ---------------- 스위치 ---------------- */
  function swSet(id, on) {
    const t = $(id); if (!t) return;
    t.classList.toggle('on', !!on);
    const row = t.closest('.sw'); if (row) row.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  const swOn = id => getSw(id);
  /** 서버 상태로 칠하는 스위치 — 방금 누른 것은 잠깐 건드리지 않는다 */
  function swLive(id, on) { if (Date.now() < (hold.get(id) || 0)) return; swSet(id, on); }
  window.t4Sw = row => { const t = row.querySelector('.tgl'); swSet(t.id, !t.classList.contains('on')); dirty = true; };
  window.t4SwKey = (e, row) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); row.click(); } };

  /** 누르는 즉시 적용하는 스위치: 서버에 보내고, 안 되면 되돌린다 */
  async function instant(row, fn, okMsg) {
    const t = row.querySelector('.tgl'); const id = t.id;
    if (busy.has(id)) return;
    busy.add(id);
    const next = !t.classList.contains('on');
    swSet(id, next); hold.set(id, Date.now() + 10000);
    const r = await fn(next);
    busy.delete(id);
    if (!r || r.ok === false) { hold.delete(id); swSet(id, !next); return msg((r && r.why) || '바꾸지 못했습니다', 'err'); }
    hold.set(id, Date.now() + 2500);
    msg(typeof okMsg === 'function' ? okMsg(next, r) : okMsg, 'ok');
    poll();
  }
  window.t4AutoToggle = row => instant(row, on => call('/api/autostart', { on }),
    (on, r) => (r && r.message) || (on ? '컴퓨터를 켤 때 자동으로 실행됩니다' : '자동 실행을 껐습니다'));
  window.t4AiToggle = row => instant(row, on => call('/api/ai/save', { on }),
    on => on ? '제목·설명 자동 짓기를 켰습니다' : '제목·설명 자동 짓기를 껐습니다');
  window.t4CpToggle = row => instant(row, on => call('/api/coupang/save', { enabled: on }),
    on => on ? '쿠팡 자동 링크를 켰습니다' : '쿠팡 자동 링크를 껐습니다');

  /* ---------------- 불러오기 · 채우기 ---------------- */
  const CATS = [[1, '영화/애니메이션'], [2, '자동차'], [10, '음악'], [15, '동물'], [17, '스포츠'], [19, '여행/이벤트'], [20, '게임'],
    [22, '인물/블로그'], [23, '코미디'], [24, '엔터테인먼트'], [25, '뉴스/정치'], [26, '노하우/스타일'], [27, '교육'],
    [28, '과학기술'], [29, '비영리/사회운동']];

  async function load() {
    if (loading) return;
    loading = true;
    const [r, c, m] = await Promise.all([call('/api/settings/get', {}), call('/api/coupang/get', {}), call('/api/meta/get', {})]);
    loading = false;
    if (r.ok === false) msg(r.why || '설정을 불러오지 못했습니다', 'err'); else S = r.settings || {};
    if (c.ok !== false) CP = c;
    if (m.ok !== false) MT = m;
    mtAt = Date.now();
    fill();
  }

  function fill() {
    if (S) { fillInfo(); fillTg(); fillAuto(); if (!dirty) fillMain(); }
    fillAi();
    fillCp();
    fillMt();
  }

  function fillMain() {
    $('t4Base').value = S.baseDir || '';
    $('t4Base').placeholder = S.defaultBaseDir ? '비우면 기본 위치 (' + S.defaultBaseDir + ')' : '예: /Users/이름/업로드영상';
    hasHide('t4BaseDef', !S.defaultBaseDir);
    const bl = Array.isArray(S.browsers) ? S.browsers : [];
    let h = '<option value="">시스템 기본 브라우저</option>' + bl.map(b => `<option value="${attr(b.id)}">${esc(b.name || b.id)}</option>`).join('');
    if (S.browser && !bl.some(b => b.id === S.browser)) h += `<option value="${attr(S.browser)}">${esc(S.browser)}</option>`;
    $('t4Browser').innerHTML = h; $('t4Browser').value = S.browser || '';
    swSet('t4Notify', S.osNotify);
    swSet('t4TgAlert', S.telegram && S.telegram.alerts);
    const p = S.policy || {};
    swSet('t4Kids', p.made_for_kids); swSet('t4Synth', p.contains_synthetic_media);
    const cur = Number(p.default_category) || 22;
    let ch = CATS.map(([id, nm]) => `<option value="${id}">${esc(nm)} (${id})</option>`).join('');
    if (!CATS.some(([id]) => id === cur)) ch += `<option value="${cur}">기타 (${cur})</option>`;
    $('t4Cat').innerHTML = ch; $('t4Cat').value = String(cur);
    const pa = S.paths || {};
    $('t4PBackup').value = pa['백업대상'] || ''; $('t4PExt').value = pa['외장뿌리'] || ''; $('t4PRoot').value = pa['영상뿌리'] || '';
    $('t4PFfmpeg').value = pa.ffmpeg || ''; $('t4PFfprobe').value = pa.ffprobe || '';
    const tl = S.tools && S.tools.ffprobe;
    text('t4ToolLine', tl === 'native'
      ? 'ffprobe 를 찾지 못했지만 괜찮습니다 — 영상의 길이와 화면 비율은 파일에서 직접 읽고 있습니다.'
      : tl === 'path' ? 'ffprobe 를 찾아 쓰고 있습니다. 없어도 영상의 길이와 화면 비율은 파일에서 직접 읽을 수 있습니다.'
        : 'ffprobe 가 없어도 괜찮습니다 — 영상의 길이와 화면 비율은 파일에서 직접 읽습니다.');
  }

  function fillInfo() {
    text('t4Ver', 'v' + (S.version || (ST && ST.version) || '-'));
    text('t4Exe', S.exePath || '-');
    text('t4Data', S.dataDir || '-');
  }

  function fillAuto() {
    const a = S.autoStart || {};
    swLive('t4Auto', a.on);
    const hint = $('t4AutoHint');
    if (hint) hint.textContent = a.supported === false
      ? '— 이 운영체제에서는 쓸 수 없습니다'
      : '— 켜면 10분마다 올릴 시각과 심사 결과를 확인하는 작업도 함께 켭니다';
    const det = $('t4AutoDetail');
    if (det) det.textContent = a.supported !== false && a.serve !== undefined && a.tick !== undefined
      ? `지금: 프로그램 자동 실행 ${a.serve ? '켜짐' : '꺼짐'} · 10분 확인 작업 ${a.tick ? '켜짐' : '꺼짐'}` : '';
  }

  const SRC = { file: '이 컴퓨터의 설정 파일', env: '환경 변수', mixed: '설정 파일 + 환경 변수' };
  function fillTg() {
    const t = S.telegram || {};
    $('t4TgState').innerHTML = t.configured
      ? `<span class="t4-ok">✅ 설정됨</span> — 받는 사람 <b>${num(t.recipients)}</b>명${SRC[t.source] ? ' · ' + esc(SRC[t.source]) : ''}`
      : '아직 설정되지 않았습니다 (선택 사항입니다)';
    $('t4TgToken').placeholder = t.configured ? '저장됨 — 바꾸려면 새 토큰을 넣으세요' : '숫자:글자 꼴 (123456789:AA…)';
    hasHide('t4TgClear', !t.configured && !t.recipients);
  }

  /** AI: 서버 상태(ST.ai)가 가장 새롭다. 없으면 설정 응답을 쓴다 */
  function aiNow() {
    const o = S && S.ai ? { enabled: S.ai.on, hasKey: S.ai.hasKey, model: S.ai.model } : {};
    const a = Object.assign(o, (ST && ST.ai) || {});
    if (a.connected === undefined) a.connected = !!(a.enabled && a.hasKey);       // 서버가 connected 를 안 주면 켜져 있고 열쇠가 있는 것
    return a;
  }
  function fillAi() {
    const a = aiNow();
    swLive('t4AiOn', a.enabled);
    const chip = $('t4AiChip');
    if (chip) {
      chip.textContent = !a.hasKey ? '아직 연결 안 됨' : (a.enabled ? '연결됨 · 켜짐' : '연결됨 · 꺼짐');
      chip.className = 't4-chip ' + (!a.hasKey ? 'no' : (a.enabled ? 'ok' : ''));
    }
    const b = $('t4AiBtn');
    b.textContent = a.hasKey ? '✨ AI 연결됨 · 바꾸기' : '✨ AI 연결';
    b.classList.toggle('done', !!a.hasKey);
    $('t4AiKeyLine').innerHTML = a.hasKey
      ? '<span class="t4-ok">✅ 열쇠 저장됨</span> — 값은 화면에 보이지 않습니다. 바꾸려면 위 단추를 누르세요.'
      : '열쇠는 <b>본인 것</b>(구글 AI 스튜디오, 무료)을 씁니다. 위 단추를 누르면 <b>이 컴퓨터에 이미 있는 열쇠를 찾아</b> 보여 드립니다. 열쇠 값은 화면에 보이지 않습니다.';
    if (!aiDirty && !typingIn('t4AiModel')) $('t4AiModel').value = a.model || '';
    $('t4AiTestBtn').disabled = !a.hasKey;
    hasHide('t4AiClear', !a.hasKey);
    hasHide('t4AiNeed', !(ST && ST.ai && ST.ai.needsKey));
  }

  const MODE_NAME = { agency: '대행 관리자', owner: '채널 소유주' };
  function fillCp() {
    const live = (ST && ST.coupang) || {}, g = CP || {};
    const connected = live.connected !== undefined ? !!live.connected : !!g.connected;
    const chip = $('t4CpChip');
    chip.textContent = connected ? '연결됨' : '아직 연결 안 됨';
    chip.className = 't4-chip ' + (connected ? 'ok' : 'no');
    const b = $('t4CpBtn');
    b.textContent = connected ? '🛒 쿠팡 파트너스 연결됨 · 바꾸기' : '🛒 쿠팡 파트너스 연결';
    b.classList.toggle('done', connected);
    $('t4CpKeyLine').innerHTML = connected
      ? '<span class="t4-ok">✅ 열쇠 저장됨</span> — 값은 화면에 보이지 않습니다. 바꾸려면 위 단추를 누르세요.'
      : '열쇠 값은 화면에 보이지 않습니다(저장됨 여부만 표시). 연결하면 자동 링크가 켜집니다.';
    swLive('t4CpOn', live.enabled !== undefined ? live.enabled : g.enabled);
    $('t4CpTest').disabled = !connected;
    if (!cpDirty && CP) {
      if (!typingIn('t4CpMode')) $('t4CpMode').value = g.mode === 'rule' ? 'rule' : 'auto';
      if (!typingIn('t4CpMax')) $('t4CpMax').value = String(Math.min(3, Math.max(1, Number(g.maxLinks) || 1)));
      if (!typingIn('t4CpPer')) $('t4CpPer').value = g.perHour != null ? String(g.perHour) : '10';
      if (!typingIn('t4CpSub')) $('t4CpSub').value = g.defaultSubId || '';
      if (!typingIn('t4CpDisc')) $('t4CpDisc').value = g.disclosure || '';
    }
    text('t4CpAiLine', g.ai ? (g.ai.available ? 'AI 열쇠가 있어 「자동」은 AI 가 상품을 고릅니다.' : 'AI 열쇠가 없어 「자동」은 규칙으로 고릅니다.') : '');
    const u = live.usage || g.usage;
    text('t4CpUsage', u ? `호출 현황: ${num(u.used)} / ${num(u.limit)}회${u.resetMin ? ` · 초기화까지 ${num(u.resetMin)}분` : ''}` : '');
    const lt = g.lastTest;
    $('t4CpTestLine').innerHTML = lt
      ? `마지막 시험: ${lt.ok ? '<span class="t4-ok">✅ 통과</span>' : '<span class="t4-bad">❌ 실패</span>'}${lt.at ? ' (' + esc(mdHm(lt.at) || lt.at) + ')' : ''} — ${esc(lt.message || '')}`
      : '';
    const warns = [...(Array.isArray(g.warnings) ? g.warnings : []), live.warn].filter(Boolean).map(String);
    const wb = $('t4CpWarn');
    wb.classList.toggle('hide', !warns.length);
    wb.innerHTML = warns.length ? '<b>⚠️ 살펴볼 것</b><br>' + [...new Set(warns)].map(esc).join('<br>') : '';
  }

  /** 상태에서 바로 읽는 것들 (설정 응답이 없어도 그린다) */
  function paintLive(s) {
    text('t4ModeNow', MODE_NAME[s.mode] ? `${MODE_NAME[s.mode]}` : '아직 고르지 않았습니다');
    const t = s.tick;
    text('t4TickLine', t
      ? `심사 확인은 ${t.every || 10}분마다 합니다${t.last ? ' · 마지막 확인 ' + (mdHm(t.last) || t.last) : ''}${t.residentOn === undefined ? '' : ' · 백그라운드 확인 작업 ' + (t.residentOn ? '켜짐' : '꺼짐')}`
      : '');
    const u = s.update || {};
    text('t4UpNow', u.available ? `v${u.version} 이 있습니다 — 「새 버전 확인」을 누르면 받을 수 있습니다` : '최신 버전입니다');
    if (!S) text('t4Ver', 'v' + (s.version || '-'));
  }

  /* ---------------- ①~④ 설정 저장 ---------------- */
  window.t4Save = async () => {
    if (!S) return msg('설정을 아직 불러오지 못했습니다. 잠시 뒤 다시 눌러 주세요', 'err');
    const p = {};
    const base = val('t4Base'); if (base !== (S.baseDir || '')) p.baseDir = base;
    const br = $('t4Browser').value; if (br !== (S.browser || '')) p.browser = br;
    const nf = swOn('t4Notify'); if (nf !== !!S.osNotify) p.osNotify = nf;
    const al = swOn('t4TgAlert'); if (al !== !!(S.telegram && S.telegram.alerts)) p.telegramAlerts = al;     // 서버는 최상위 telegramAlerts 로 받는다
    const op = S.policy || {}, pol = {};
    const kids = swOn('t4Kids'); if (kids !== !!op.made_for_kids) pol.made_for_kids = kids;
    const syn = swOn('t4Synth'); if (syn !== !!op.contains_synthetic_media) pol.contains_synthetic_media = syn;
    const cat = Number($('t4Cat').value); if (cat && cat !== Number(op.default_category)) pol.default_category = cat;
    if (Object.keys(pol).length) p.policy = pol;
    const oa = S.paths || {}, paths = {};
    [['백업대상', 't4PBackup'], ['외장뿌리', 't4PExt'], ['영상뿌리', 't4PRoot'], ['ffmpeg', 't4PFfmpeg'], ['ffprobe', 't4PFfprobe']]
      .forEach(([k, id]) => { const nv = val(id); if (nv !== (oa[k] || '')) paths[k] = nv; });
    if (Object.keys(paths).length) p.paths = paths;
    if (!Object.keys(p).length) { dirty = false; return msg('바뀐 것이 없습니다'); }
    const b = $('t4SaveBtn'); b.disabled = true;
    const r = await call('/api/settings/save', p);
    b.disabled = false;
    if (r.ok === false) return msg(r.why || '저장하지 못했습니다', 'err');
    dirty = false;
    msg('저장했습니다', 'ok');
    await load();
    poll();
  };

  /** 폴더 고르는 운영체제 창(명세에 없음 — 안 되면 직접 적으면 된다) */
  window.t4PickDir = async (inputId, prompt) => {
    msg('폴더 선택창을 여는 중…');
    const r = await call('/api/dir/pick', { prompt: prompt || '폴더를 고르세요', start: val(inputId) });
    if (r.ok === false || !r.path) return msg(r.why || '선택이 취소되었습니다');
    $(inputId).value = r.path; dirty = true;
    msg('저장을 눌러 적용하세요');
  };
  window.t4DefaultBase = () => {
    if (!S || !S.defaultBaseDir) return;
    $('t4Base').value = S.defaultBaseDir; dirty = true;
    msg('저장을 눌러 적용하세요');
  };

  /* ---------------- 텔레그램 ---------------- */
  window.t4TgSave = async () => {
    const token = val('t4TgToken');
    const ids = val('t4TgChat').split(/[\s,，]+/).filter(Boolean).map(x => /^-?\d+$/.test(x) ? Number(x) : x);
    if (!token && !ids.length) return msg('저장할 내용이 없습니다. 지우려면 「설정 지우기」를 누르세요');
    if (!token) return msg('봇 토큰을 함께 넣어 주세요 (보안상 저장된 토큰은 다시 보여 드리지 않습니다)', 'err');
    if (!ids.length) return msg('받는 사람 번호를 하나 이상 넣어 주세요', 'err');
    const r = await call('/api/telegram/save', { token, chatIds: ids });
    if (r.ok === false) return msg(r.why || '저장하지 못했습니다', 'err');
    $('t4TgToken').value = '';
    msg('저장했습니다 — 「시험 보내기」로 확인해 보세요', 'ok');
    load();
  };
  window.t4TgTest = async () => {
    const r = await call('/api/telegram/test', {});
    if (r.ok === false) return msg(r.why || '보내지 못했습니다', 'err');
    msg(r.message || '보냈습니다 — 폰을 보세요', 'ok');
  };
  window.t4TgClear = async () => {
    const ok = await confirmBox({ emoji: '🔔', title: '텔레그램 설정을 지울까요?', danger: true, ok: '설정 지우기',
      body: '저장된 <b>봇 토큰과 받는 사람</b>을 지웁니다. 지우면 막힌 소식이 폰으로 가지 않습니다.' });
    if (!ok) return;
    const r = await call('/api/telegram/save', { token: '', chatIds: [] });
    if (r.ok === false) return msg(r.why || '지우지 못했습니다', 'err');
    $('t4TgToken').value = ''; $('t4TgChat').value = '';
    msg('텔레그램 설정을 지웠습니다');
    load();
  };

  /* ---------------- 🤖 AI 문안 ---------------- */
  // 열쇠 연결·바꾸기는 공통 창이 한다(openAi). 여기는 모델과 켜기·끄기, 시험, 연결 해제.
  window.t4AiSave = async () => {
    const model = val('t4AiModel');
    if (model === (aiNow().model || '')) return msg('바뀐 것이 없습니다');
    const r = await call('/api/ai/save', { model });
    if (r.ok === false) return msg(r.why || '저장하지 못했습니다', 'err');
    aiDirty = false;
    msg(model ? '모델을 저장했습니다' : '모델을 기본으로 되돌렸습니다', 'ok');
    await load(); poll();
  };
  window.t4AiTest = async () => {
    const model = val('t4AiModel');
    const h = $('t4AiHint'); h.textContent = '구글에 물어보는 중…';
    const r = await call('/api/ai/test', model ? { model } : {});
    const m = r.message || r.why || (r.ok === false ? '시험하지 못했습니다' : '확인했습니다');
    h.textContent = m;
    msg(m, r.ok === false ? 'err' : 'ok');
  };
  window.t4AiClear = async () => {
    const ok = await confirmBox({ emoji: '✨', title: 'AI 연결을 끊을까요?', danger: true, ok: '연결 해제',
      body: '이 컴퓨터에 저장된 <b>AI 열쇠를 지우고</b> 자동 문안을 끕니다.<br>문안이 없는 영상은 파일 이름이 제목으로 올라갑니다. 다시 쓰려면 열쇠를 새로 넣어야 합니다.' });
    if (!ok) return;
    const r = await call('/api/ai/disconnect', {});
    if (r.ok === false) return msg(r.why || '연결을 끊지 못했습니다', 'err');
    msg('AI 연결을 해제했습니다');
    await load(); poll();
  };

  /* ---------------- 🛒 쿠팡 파트너스 ---------------- */
  window.t4CpSave = async () => {
    const g = CP || {}, body = {};
    const mode = $('t4CpMode').value; if (mode !== (g.mode === 'rule' ? 'rule' : 'auto')) body.mode = mode;
    const max = Number($('t4CpMax').value); if (max !== Number(g.maxLinks || 1)) body.maxLinks = max;
    const perRaw = val('t4CpPer'), per = Number(perRaw);
    if (!perRaw || !Number.isInteger(per) || per < 1 || per > 100) return msg('시간당 검색 호출 한도는 1~100 사이 정수로 적어 주세요', 'err');
    if (per !== Number(g.perHour != null ? g.perHour : 10)) body.perHour = per;
    const sub = val('t4CpSub');
    if (sub && !/^[A-Za-z0-9]+$/.test(sub)) return msg('sub ID 는 영문·숫자만 쓸 수 있습니다', 'err');
    if (sub !== (g.defaultSubId || '')) body.defaultSubId = sub;
    const disc = val('t4CpDisc'); if (disc !== (g.disclosure || '')) body.disclosure = disc;
    if (!Object.keys(body).length) { cpDirty = false; return msg('바뀐 것이 없습니다'); }
    const r = await call('/api/coupang/save', body);
    if (r.ok === false) return msg(r.why || '저장하지 못했습니다', 'err');
    cpDirty = false;
    msg('쿠팡 설정을 저장했습니다', 'ok');
    await load(); poll();
  };
  window.t4CpTest = async () => {
    const b = $('t4CpTest'); b.disabled = true;
    text('t4CpTestLine', '연결을 시험하는 중…');
    const r = await call('/api/coupang/test', {});
    b.disabled = false;
    const sample = r.sample && r.sample.name ? ` (예: ${r.sample.name}${r.sample.price ? ' · ' + num(r.sample.price) + '원' : ''})` : '';
    const m = (r.message || r.why || (r.ok === false ? '시험하지 못했습니다' : '연결이 정상입니다')) + (r.ok === false ? '' : sample);
    msg(m, r.ok === false ? 'err' : 'ok');
    await load();
  };

  /* ---------------- 📷 인스타그램·스레드 ---------------- */
  const MT_NAME = { instagram: '인스타그램', threads: '스레드' };
  const MT_ICON = { instagram: '📷', threads: '🧵' };
  const MT_PHASE = { 영상대기: '유튜브 공개를 기다리는 중', 진행: '올리는 중', 끝: '' };
  const cutS = (t, n) => { const a = Array.from(String(t || '')); return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
  async function loadMt() {
    const m = await call('/api/meta/get', {});
    if (m.ok !== false) { MT = m; mtAt = Date.now(); }
    fillMt();
  }
  function fillMt() {
    const card = $('t4MtCard'); if (!card) return;
    const av = MT && MT.available;
    card.classList.toggle('hide', !(av && av.on));
    if (!(av && av.on)) return;
    hasHide('t4MtIgBtn', !av.instagram); hasHide('t4MtThBtn', !av.threads);
    hasHide('t4MtStop', !mtLogin); hasHide('t4MtCopy', !(mtLogin && mtUrl));
    // 사용 신청 안내 — 이메일·메일 문안·수락하는 곳은 서버(meta.ts 의 신청)가 주는 것만 쓴다
    const ap = MT.apply;
    if (ap) {
      const a = $('t4MtMail'); if (a) a.href = ap.mailto;
      text('t4MtMailTo', ap.email);
      text('t4MtAccIg', (ap.accept || {}).instagram || ''); text('t4MtAccTh', (ap.accept || {}).threads || '');
      hasHide('t4MtAccIgW', !av.instagram); hasHide('t4MtAccThW', !av.threads); hasHide('t4MtAccSep', !(av.instagram && av.threads));
    }
    hasHide('t4MtApply', !ap);
    const accts = MT.accounts || [];
    const chip = $('t4MtChip');
    chip.className = 't4-chip ' + (accts.length ? 'ok' : 'no');
    chip.textContent = accts.length ? `연결 ${accts.length}개` : '연결 안 됨';
    $('t4MtAccts').innerHTML = accts.map(a => {
      const warn = a.error ? `<div class="hintline t4-bad" style="width:100%">⚠ ${esc(a.error)}</div>` : '';
      const left = a.days_left != null ? `<span class="hintline" style="margin:0">로그인 만료까지 ${num(Math.max(0, a.days_left))}일 · 만료 전에 알아서 늘립니다</span>` : '';
      return `<div class="t4-mtrow"><span class="nm">${MT_ICON[a.provider] || ''} ${esc(MT_NAME[a.provider] || a.provider)} · <b>@${esc(a.username)}</b></span>${left}` +
        `<button type="button" class="tb" data-act="disc" data-key="${attr(a.key)}">연결 끊기</button>${warn}</div>`;
    }).join('');
    // 채널별 계정 고르기 — 고르는 중에는 다시 그리지 않는다
    const bind = $('t4MtBind');
    if (!(document.activeElement && bind.contains(document.activeElement))) {
      const opt = (prov, cur) => '<option value="">끔 (올리지 않음)</option>' + accts.filter(a => a.provider === prov)
        .map(a => `<option value="${attr(a.key)}"${a.key === cur ? ' selected' : ''}>@${esc(a.username)}</option>`).join('');
      const chs = MT.channels || [];
      bind.innerHTML = chs.length ? chs.map(c => {
        const sel = prov => (av[prov] ? `<select class="fin" data-bind="${prov}" data-ch="${attr(c.alias)}" aria-label="${attr(c.alias)} ${MT_NAME[prov]}">${opt(prov, c[prov] || '')}</select>` : '');
        return `<div class="t4-mtrow"><span class="nm">${esc(c.alias)}</span>${sel('instagram')}${sel('threads')}</div>`;
      }).join('') : '<div class="hintline">채널이 없습니다.</div>';
    }
    // 최근 결과
    const jobs = MT.jobs || [];
    $('t4MtJobs').innerHTML = jobs.length ? jobs.map(j => {
      const ph = j.shrink === '줄이는중' ? '릴스·스레드용으로 영상을 줄이는 중' : j.shrink === '대기' ? '릴스·스레드용으로 영상을 줄일 차례를 기다리는 중' : (MT_PHASE[j.phase] || '');
      const when = j.phase !== '끝' && j.go_after ? ` · ${mdHm(j.go_after)} 이후` : '';
      const rows = (j.targets || []).map(t => {
        const cls = t.state === '올림' ? 't4-ok' : (t.state === '실패' || t.state === '결과불명') ? 't4-bad' : '';
        const link = /^https:\/\//.test(t.url || '') ? ` <button type="button" class="tb" data-act="open" data-url="${attr(t.url)}">보기</button>` : '';
        const acts = (t.actions || []).map(a => ({
          retry: `<button type="button" class="tb on" data-act="retry" data-id="${attr(j.id)}" data-p="${attr(t.provider)}">다시 시도</button>`,
          check: `<button type="button" class="tb" data-act="check" data-id="${attr(j.id)}" data-p="${attr(t.provider)}">올라갔는지 찾아보기</button>`,
          resolve: `<button type="button" class="tb" data-act="yes" data-id="${attr(j.id)}" data-p="${attr(t.provider)}">올라갔음</button> ` +
            `<button type="button" class="tb" data-act="no" data-id="${attr(j.id)}" data-p="${attr(t.provider)}">안 올라갔음 · 다시 올리기</button>`,
        }[a] || '')).join(' ');
        return `<div class="hintline">${MT_ICON[t.provider] || ''} ${esc(t.name)}${t.username ? ' @' + esc(t.username) : ''} — <b class="${cls}">${esc(t.state)}</b>${link}` +
          `${t.why ? ' · ' + esc(t.why) : ''} ${acts}</div>`;
      }).join('');
      const cancel = j.cancelable ? ` <button type="button" class="tb" data-act="cancel" data-id="${attr(j.id)}">취소</button>` : '';
      return `<div class="t4-mtjob"><div class="tt">[${esc(j.channel)}] ${esc(cutS(j.title, 36))} <span style="color:var(--t3)">${esc(ph)}${esc(when)}</span>${cancel}</div>${rows}</div>`;
    }).join('') : '<div class="hintline">아직 없습니다.</div>';
  }
  /** 로그인 줄 — 연결 실패 안내는 길어서 토스트가 아니라 이 줄에 붉게 남긴다 */
  const mtLine = (t, bad) => { text('t4MtLine', t); const e = $('t4MtLine'); if (e) e.classList.toggle('t4-bad', !!bad); };
  window.t4MtCopyMail = () => { if (MT && MT.apply) cpy(MT.apply.email, '신청 메일 주소를 복사했습니다'); };
  window.t4MtLogin = async provider => {
    if (mtLogin) return msg('이미 로그인 창이 열려 있습니다');
    const r = await call('/api/meta/signin/start', { provider });
    if (r.ok === false) return msg(r.why || '로그인을 시작하지 못했습니다', 'err');
    mtLogin = true; mtUrl = r.url || '';
    mtLine('브라우저에서 로그인을 마쳐 주세요. 창이 열리지 않으면 「로그인 주소 복사」 뒤 브라우저에 붙여 넣으세요.');
    fillMt();
    for (let i = 0; i < 420 && mtLogin; i++) {
      await new Promise(res => setTimeout(res, 1500));
      const c = await call('/api/meta/signin/check', {});
      if (c.ok === false) {
        const why = c.why || '연결하지 못했습니다';
        mtLine(why, true); msg(why.length > 60 ? '연결하지 못했습니다 — 아래 안내를 확인해 주세요' : why, 'err'); break;
      }
      if (c.state === 'done') { mtLine(`${MT_NAME[c.provider] || ''} @${c.username} 연결됐습니다.`); msg(`@${c.username} 연결됐습니다`, 'ok'); break; }
    }
    mtLogin = false; mtUrl = '';
    await loadMt();
  };
  window.t4MtStop = async () => { await call('/api/meta/signin/stop', {}); mtLogin = false; mtUrl = ''; mtLine('로그인을 그만뒀습니다.'); fillMt(); };
  window.t4MtCopyUrl = () => { if (mtUrl) cpy(mtUrl, '로그인 주소를 복사했습니다'); };
  async function mtDo(path, body, ok) {
    const r = await call(path, body);
    if (r.ok === false) msg(r.why || '처리하지 못했습니다', 'err'); else if (ok) msg(typeof ok === 'function' ? ok(r) : ok, 'ok');
    await loadMt();
  }
  async function mtClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, id = b.dataset.id, p = b.dataset.p;
    if (act === 'open') { if (/^https:\/\//.test(b.dataset.url || '')) ext(b.dataset.url); return; }
    if (act === 'disc') {
      if (!confirm('이 컴퓨터에서 연결을 끊을까요? 채널에 걸어 둔 짝도 풀립니다. (메타 쪽 권한은 인스타그램·스레드 설정에서 직접 지울 수 있습니다)')) return;
      return mtDo('/api/meta/disconnect', { key: b.dataset.key }, '연결을 끊었습니다');
    }
    if (act === 'retry') return mtDo('/api/meta/job/retry', { id, provider: p }, '다시 시도합니다 — 곧 올라갑니다');
    if (act === 'check') return mtDo('/api/meta/job/check', { id, provider: p }, r => r.found ? '올라간 것을 찾았습니다' : (r.why || '찾지 못했습니다'));
    if (act === 'yes') return mtDo('/api/meta/job/resolve', { id, provider: p, outcome: '올림' }, '올라간 것으로 기록했습니다');
    if (act === 'no') {
      if (!confirm('정말 올라가지 않았나요? 인스타그램·스레드에서 직접 확인한 뒤에만 누르세요. 다시 올리면 같은 영상이 두 번 올라갈 수 있습니다.')) return;
      return mtDo('/api/meta/job/resolve', { id, provider: p, outcome: '안올라감' }, '다시 올립니다');
    }
    if (act === 'cancel') return mtDo('/api/meta/job/cancel', { id }, '올리기를 취소했습니다');
  }
  async function mtChange(e) {
    const s = e.target.closest('select[data-bind]'); if (!s) return;
    await mtDo('/api/meta/bind', { alias: s.dataset.ch, provider: s.dataset.bind, key: s.value }, s.value ? '이 채널은 그 계정에 올립니다' : '이 채널은 올리지 않습니다');
  }

  /* ---------------- 🧰 점검·보관 ---------------- */
  const RUNS = {
    env: ['/api/env/check', '환경 점검'], self: ['/api/self/check', '점검'],
    keep: ['/api/archive/keep', '오늘치 보관'], mirror: ['/api/archive/mirror', '외장 백업'],
  };
  window.t4Run = async (kind, btn) => {
    const d = RUNS[kind]; if (!d) return;
    const all = document.querySelectorAll('#t4 [data-run]');
    all.forEach(b => { b.disabled = true; });
    const out = $('t4Out'); out.classList.remove('hide'); out.textContent = `${d[1]} 중…`;
    const r = await call(d[0], {});
    all.forEach(b => { b.disabled = false; });
    let lines = Array.isArray(r.lines) ? r.lines.map(x => typeof x === 'string' ? x : JSON.stringify(x)) : [];
    if (!lines.length && typeof r.kept === 'number') {            // 오늘치 보관: {kept: 남긴 파일 수, days: 보관된 날 수}
      lines = [`오늘치 ${num(r.kept)}개 파일을 보관했습니다`].concat(r.days != null ? [`지금까지 보관된 날: ${num(r.days)}일치`] : []);
    }
    if (!lines.length) {
      const m = r.message || r.text || (r.ok === false ? (r.why || '실패했습니다') : '끝났습니다');
      const cnt = ['total', 'copied', 'deleted'].filter(k => r[k] != null).map(k => ({ total: '전체', copied: '복사', deleted: '지움' }[k] + ' ' + num(r[k])));
      lines = [String(m)].concat(cnt.length ? [cnt.join(' · ')] : []);
    }
    out.textContent = `[${d[1]}] ${r.ok === false ? '실패' : '끝'}\n` + lines.join('\n');
    msg(r.ok === false ? (r.why || `${d[1]} 중 문제가 있었습니다`) : `${d[1]}을(를) 마쳤습니다`, r.ok === false ? 'err' : 'ok');
  };

  /* ---------------- 🧭 운영 방식 ---------------- */
  window.t4ModeClear = async () => {
    const r = await call('/api/mode/clear', {});
    if (r.ok === false) return msg(r.why || '바꾸지 못했습니다', 'err');
    moReopenMode();
    msg('다시 골라 주세요');
  };

  /* ---------------- 다른 탭에서 오는 길 ---------------- */
  /** 설정 탭의 AI 카드로 (모델·켜기/끄기·연결 해제가 있는 곳) */
  window.t4GoAi = () => {
    swTab('t4');
    setTimeout(() => {
      const c = $('t4AiCard'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const k = $('t4AiBtn'); if (k) k.focus({ preventScroll: true });
    }, 80);
  };
  /** 시작하기 맨 아래 「내 구글 열쇠」 접힘 구역으로 */
  window.t5GoAdv = () => {
    swTab('t5');
    const d = $('t5Adv'); if (!d) return;
    d.open = true;
    setTimeout(() => d.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  /* ---------------- 탭 등록 ---------------- */
  registerTab('t4', {
    init() {
      // 손댄 카드는 폴링이 다시 채우지 않는다
      $('t4Main').addEventListener('input', e => { if (!/^t4Tg(Token|Chat)$/.test(e.target.id)) dirty = true; });
      $('t4Main').addEventListener('change', e => { if (!/^t4Tg(Token|Chat)$/.test(e.target.id)) dirty = true; });
      $('t4AiCard').addEventListener('input', e => { if (e.target.id === 't4AiModel') aiDirty = true; });
      $('t4CpCard').addEventListener('input', e => { if (/^t4Cp(Mode|Max|Per|Sub|Disc)$/.test(e.target.id)) cpDirty = true; });
      $('t4CpCard').addEventListener('change', e => { if (/^t4Cp(Mode|Max)$/.test(e.target.id)) cpDirty = true; });
      $('t4MtCard').addEventListener('click', mtClick);
      $('t4MtCard').addEventListener('change', mtChange);
    },
    show() { load(); },
    // 인스타·스레드 결과는 15초에 한 번만 다시 읽는다 (이 컴퓨터의 장부를 읽을 뿐 메타를 부르지 않는다)
    paint(s) { paintLive(s); fillAi(); fillCp(); if (!S && !loading) load(); else if (!loading && !mtLogin && Date.now() - mtAt > 15000) { mtAt = Date.now(); loadMt(); } },
  });

  /* ---------------- 🚀 시작하기(t5) — 정적 안내. 진행 칩과 초기화 시각만 채운다 ---------------- */
  const chip = (id, done, label) => { const e = $(id); if (!e) return; e.classList.toggle('done', !!done); e.textContent = (done ? '✓ ' : '') + label; };
  /** "16:10" → "오후 4시 10분" */
  const hmKo = hm => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')); if (!m) return ''; const h = +m[1], mi = +m[2]; return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시${mi ? ' ' + mi + '분' : ''}`; };
  const aiOn = a => !!(a && (a.connected !== undefined ? a.connected : (a.enabled && a.hasKey)));
  registerTab('t5', {
    paint(s) {
      const ch = s.channels || [], w = s.welcome || {};
      const nCh = w.channels != null ? w.channels : ch.length;
      const nAuth = w.authed != null ? w.authed : ch.filter(c => c.authed).length;
      const waiting = ch.reduce((a, c) => a + ((c.counts && c.counts['대기']) || 0), 0) + (s.queue || []).length;
      const total = (s.todayStats && s.todayStats['누적']) || 0;
      chip('t5c1', nCh > 0, nCh > 0 ? `① 채널 ${nCh}개 만듦` : '① 채널 이름 만들기');
      chip('t5c2', nAuth > 0, nAuth > 0 ? `② 구글 연결 ${nAuth}개` : '② 구글 계정 연결');
      chip('t5c3', waiting > 0 || total > 0, '③ 영상 넣기');
      chip('t5c4', aiOn(s.ai), '④ AI 열쇠 넣기 (선택)');
      chip('t5c5', !!(s.coupang && s.coupang.connected), '⑤ 쿠팡 파트너스 연결 (선택)');
      chip('t5c6', total > 0, '⑥ 올리기');
      const r = hmKo(s.quota && s.quota.reset); if (r && $('t5Reset')) $('t5Reset').textContent = r + '쯤';
      hasHide('t5AiNeed', !(s.ai && s.ai.needsKey));
      const cp = $('t5CpBtn'); if (cp) cp.textContent = s.coupang && s.coupang.connected ? '🛒 쿠팡 파트너스 연결됨 · 바꾸기' : '🛒 쿠팡 파트너스 연결';
      const ab = $('t5AiBtn'); if (ab) ab.textContent = aiOn(s.ai) ? '✨ AI 연결됨 · 바꾸기' : '✨ AI 연결';
    },
  });
})();

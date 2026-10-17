/* t3.js — 📺 채널 탭
 *
 * 인증 방식은 현재 업로더와 같다: 관리자 계정 하나로 로그인하고 로그인 창에서 채널만 바꿔 고른다. 구글 열쇠는 앱에 들어 있다.
 * 연결 방법 둘 — ① 구글 계정 연결(브라우저 로그인) ② 코드 인증(주소+8자리 코드, 승인하는 사람이 이 컴퓨터 앞에 없어도 됨).
 *
 * 서버와의 약속(API_명세.md §5 · §9 · §10)
 *   POST /api/add {name} · /order {names} · /rename {ch,name} · /remove {ch} · /folder {ch} · /folder/set {ch,path} · /open {path}
 *   POST /api/channel/update {ch,set:{키:값…}}  (값이 null 이면 그 칸을 지운다고 가정한다 — 메인에게 요청)
 *   POST /api/channel/policy {ch,daily_limit,kind,cap_uploads,day_start_hour,overflow_day_start_hour,publish_gap_minutes,review_lead_minutes} · /policy/clear
 *   POST /api/signin/start {ch?,secret?} · /check · /stop      POST /api/code/start {ch?} · /check {ch?} · /stop {ch?}
 *   POST /api/channel/check|logout {ch} · /api/profile/refresh {ch} · GET /studio?cid=
 *   POST /api/secret/state · /secret/save {kind,json|clientId,clientSecret} · /channel/secret {ch,json|clientId,clientSecret} · /channel/secret/clear
 *
 * 폴링이 입력 중인 칸을 지우지 않게: 카드를 머리·영역(경고·단추·폴더·이름·설정·일 한도·열쇠·삭제)으로 쪼개 영역마다 따로 다시 그린다.
 * 손댄 영역(dirty)이나 글을 쓰는 중인 영역은 건드리지 않고, 펼침 상태는 Set 에 보존한다.
 */
'use strict';
(() => {
  const open = new Set();                 // 펼친 카드(채널 이름)
  const uids = new Map(); let uidN = 0;   // 채널 이름 → 짧은 번호 (입력칸 id 용)
  const base = new Map();                 // `${채널}|영역` → 그 영역을 그릴 때의 원래 값 (저장할 때 바뀐 칸만 보내려고)
  let drag = null;                        // 끌고 있는 카드
  let secState = null;                    // 마지막 /api/secret/state
  let si = null;                          // 브라우저 로그인 진행 {ch,url,t0,state,timer,busy,res,why}
  let cd = null;                          // 코드 인증 진행 {ch,url,code,deadline,state,timer,tick,busy,res,why}
  let firstPaint = true;

  const SI_POLL = 1500;                   // 브라우저 로그인 확인 간격 — 이 컴퓨터 안의 상태만 읽는다
  const CD_POLL = 5000;                   // 코드 인증 확인 간격 — 구글이 정한 최소 간격(5초)을 지킨다(너무 잦으면 slow_down)

  async function call(path, body) {
    try { return await api(path, body === undefined ? {} : body); }
    catch (_) { return { ok: false, why: '앱과 연결되지 않았습니다. 잠시 뒤 다시 시도해 주세요' }; }
  }
  const uid = name => { if (!uids.has(name)) uids.set(name, 'c' + (++uidN)); return uids.get(name); };
  const chans = () => (ST && ST.channels) || [];
  const chan = name => chans().find(c => c.name === name) || null;
  const KEYFROM = { '내장': '내장 열쇠', '파일': '내 열쇠(파일)', '전용': '이 채널 전용 열쇠' };
  const HOW = { browser: '🔑 브라우저 로그인', device: '📟 코드 인증' };
  const fid = (n, k) => `t3f_${uid(n)}_${k.replace(/[^A-Za-z0-9_]/g, '_')}`;

  /* ================= 채널 설정 칸 표 ================= */
  // t: text 글 · list 쉼표 목록 · htags 해시태그(# 뗀 목록) · int 정수 · sel 고르기 · bool 켜기/끄기 · tri 정책따름/예/아니오
  const SPEC = {
    title_prefix: { t: 'text', label: '제목 머리글' },
    desc: { t: 'text', label: '기본 설명' },
    tags: { t: 'list', label: '태그' },
    prefix: { t: 'text', label: '파일 이름 머리말' },
    ai: { t: 'bool', def: true, label: 'AI 문안' },
    desc_head: { t: 'text', label: '고정 설명 머리말' },
    desc_tail: { t: 'text', label: '고정 설명 꼬리말' },
    fixed_tags: { t: 'htags', label: '고정 해시태그' },
    tone: { t: 'text', label: '말투 메모' },
    publish: { t: 'sel', def: 'schedule', label: '공개 방식' },
    after_review: { t: 'sel', def: 'public', label: '심사 뒤 공개 범위' },
    times: { t: 'list', time: true, label: '하루 공개 시각 후보' },
    long_slots: { t: 'list', time: true, label: '롱폼 하루 공개 칸' },
    pick: { t: 'sel', def: 'oldest', label: '고르는 방식' },
    after_upload: { t: 'sel', def: '', label: '올린 뒤 원본 처리' },
    daily_rule: { t: 'sel', def: 'views', alias: { auto: 'views' }, label: '오늘 올릴 개수 정하는 방식' },
    daily: { t: 'int', min: 1, max: 99, label: '매일 올릴 개수' },
    daily_fallback: { t: 'int', min: 0, max: 99, label: '조회수를 모를 때 개수' },
    audio_language: { t: 'sel', def: '', label: '언어' },
    approved_by: { t: 'text', label: '승인자' },
    made_for_kids: { t: 'tri', label: '아동용 표시' },
    thumb_watch: { t: 'bool', def: false, label: '썸네일 실패 감시' },
    '회수': { t: 'bool', def: false, label: '회수' },
    studio_profile: { t: 'text', label: '스튜디오 크롬 프로필' },
  };
  const N = {   // 서버 값/화면 값을 같은 꼴로 맞춘다(바뀌었나 견주려고)
    text: v => String(v ?? '').trim(),
    list: v => (Array.isArray(v) ? v : String(v ?? '').split(/[,，\n]+/)).map(x => String(x).trim()).filter(Boolean),
    htags: v => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,，\n\s]+/)).map(x => String(x).trim().replace(/^#+/, '')).filter(Boolean))],
    int: v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Math.trunc(Number(v)),
    sel: (v, sp) => { const s = String(v ?? ''); return (sp.alias && sp.alias[s]) || (s === '' ? sp.def : s); },
    bool: (v, sp) => (v === undefined || v === null) ? !!sp.def : !!v,
    tri: v => (v === true || v === 'true') ? 'true' : (v === false || v === 'false') ? 'false' : '',   // 서버는 불린, 화면은 글 — 둘 다 받는다
  };
  const OUT = {   // 바뀐 칸을 서버로 보낼 값 — 기본값으로 돌아오면 null(칸 지우기)
    text: v => v === '' ? null : v,
    list: v => v.length ? v : null,
    htags: v => v.length ? v : null,
    int: v => v,
    sel: v => v === '' ? null : v,
    bool: (v, sp) => v === !!sp.def ? null : v,
    tri: v => v === '' ? null : v === 'true',
  };
  const TIME = /^(\d{1,2}):(\d{2})$/;
  const fmtTime = x => { const m = TIME.exec(x); if (!m || +m[1] > 23 || +m[2] > 59) return null; return String(+m[1]).padStart(2, '0') + ':' + m[2]; };

  /* ================= 폼 부품 ================= */
  const AUTO = '<span style="font-weight:400;color:var(--t3);margin-left:6px">비우면 자동</span>';
  function inp(n, k, label, v, o = {}) {
    const id = fid(n, k);
    return `<div><label class="flabel" for="${id}">${label}${o.auto ? AUTO : ''}</label>
      <input class="fin" id="${id}" data-k="${k}"${o.type ? ` type="${o.type}"` : ''} value="${attr(v ?? '')}" placeholder="${attr(o.ph || '')}" autocomplete="off" spellcheck="false"${o.max ? ` maxlength="${o.max}"` : ''}${o.min != null ? ` min="${o.min}"` : ''}${o.maxn != null ? ` max="${o.maxn}"` : ''}/>${o.hint ? `<div class="hintline">${o.hint}</div>` : ''}</div>`;
  }
  function area(n, k, label, v, o = {}) {
    const id = fid(n, k);
    return `<div><label class="flabel" for="${id}">${label}${o.auto ? AUTO : ''}</label>
      <textarea class="fin" id="${id}" data-k="${k}" rows="${o.rows || 3}" placeholder="${attr(o.ph || '')}" spellcheck="false">${esc(v ?? '')}</textarea>${o.hint ? `<div class="hintline">${o.hint}</div>` : ''}</div>`;
  }
  function sel(n, k, label, opts, v, o = {}) {
    const id = fid(n, k);
    const list = opts.slice();
    if (v != null && !list.some(([val]) => val === v)) list.push([v, String(v)]);
    return `<div><label class="flabel" for="${id}">${label}</label>
      <select class="fin" id="${id}" data-k="${k}">${list.map(([val, lb]) => `<option value="${attr(val)}"${val === v ? ' selected' : ''}>${esc(lb)}</option>`).join('')}</select>${o.hint ? `<div class="hintline">${o.hint}</div>` : ''}</div>`;
  }
  function sw(k, label, small, on) {
    return `<div class="sw" role="switch" tabindex="0" aria-checked="${on ? 'true' : 'false'}" data-k="${k}" onclick="t3Sw(this)" onkeydown="t3SwKey(event,this)"><span>${label}${small ? ` <small style="color:var(--t3)">— ${small}</small>` : ''}</span><div class="tgl${on ? ' on' : ''}"></div></div>`;
  }
  window.t3Sw = row => {
    const t = row.querySelector('.tgl'); t.classList.toggle('on');
    row.setAttribute('aria-checked', t.classList.contains('on') ? 'true' : 'false');
    const s = row.closest('[data-sec]'); if (s) s.dataset.dirty = '1';
  };
  window.t3SwKey = (e, row) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); row.click(); } };

  /* ================= 카드: 머리 ================= */
  const headSig = c => [c.authed, c.needsReconnect, c.how, c.canPublish, c.keyFrom, c.title, c.handle, c.subs, c.avatar, c.folder, c.folderOk, c.todayUploaded, c.queued, c.reviewing, c.isLong];
  function headHtml(c) {
    const chips = [];
    // 로그인이 풀린 채널은 목록에서 사라지지 않는다 — 「다시 연결 필요」로 보인다(lastError 글은 그대로)
    if (c.needsReconnect) chips.push('<span class="chbadge no">다시 연결 필요</span>');
    else chips.push(c.authed ? '<span class="chbadge ok">연결됨</span>' : '<span class="chbadge no">미연결</span>');
    if (c.authed && c.how && HOW[c.how]) chips.push(`<span class="ch-tag">${HOW[c.how]}</span>`);
    if (c.authed && KEYFROM[c.keyFrom]) chips.push(`<span class="ch-tag">${esc(KEYFROM[c.keyFrom])}</span>`);
    if (c.authed && c.canPublish === false) chips.push('<span class="chbadge full">공개 권한 없음</span>');
    if (c.isLong) chips.push('<span class="ch-tag">롱폼 채널</span>');
    if (!c.folder) chips.push('<span class="chbadge full">폴더 미정</span>');
    else if (c.folderOk === false) chips.push('<span class="chbadge no">폴더 없음</span>');
    const img = c.avatar
      ? `<img src="${attr(c.avatar)}" alt=""/>`
      : '<div style="width:40px;height:40px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">📺</div>';
    const sub = [c.title && esc(c.title), c.handle && esc(c.handle), c.subs != null && c.subs !== '' ? '구독자 ' + num(c.subs) : '', esc(shortPath(c.folder) === '-' ? '폴더가 정해지지 않았습니다' : shortPath(c.folder))].filter(Boolean).join(' · ');
    return `<span class="t3-grip" title="끌어서 순서 바꾸기" aria-hidden="true">⠿</span>${img}
      <div class="chrow-i"><div class="chrow-nm">${esc(c.name)} ${chips.join(' ')}</div><div class="chrow-dc">${sub}</div></div>
      <div class="t3-stat">오늘 ${num(c.todayUploaded)}편 올림<small>발사 대기 ${num(c.queued)} · 심사 ${num(c.reviewing)}</small></div>
      <span class="chrow-arr">▶</span>`;
  }

  /* ================= 카드: 영역들 ================= */
  const warnSig = c => [c.authed, c.needsReconnect, c.canPublish, c.lastError, c.folder, c.folderOk];
  function warnHtml(c) {
    const o = [];
    if (c.lastError) o.push(`<div class="danger">⚠️ ${esc(c.lastError)}</div>`);
    if (c.needsReconnect) o.push('<div class="danger">🔑 <b>로그인이 풀렸습니다 — 다시 연결이 필요합니다.</b> 이 채널은 지금 영상을 올리지 못합니다. 아래 <b>다시 연결</b>을 누르면 기다리던 영상은 사라지지 않고 그대로 올라갑니다.</div>');
    else if (!c.authed) o.push('<div class="t3-note">🔑 아직 구글에 연결되지 않았습니다. 아래 <b>구글 계정 연결</b>을 눌러 이 채널을 가진 계정으로 로그인하고, 로그인 창에서 이 채널을 고르세요.</div>');
    else if (c.canPublish === false) o.push('<div class="danger">🌐 <b>공개 권한이 없습니다.</b> 로그인할 때 권한 세 칸 중 공개 전환 칸을 빼고 허용한 연결입니다. 이대로는 비공개로 올린 영상을 공개로 바꾸지 못합니다 — <b>다시 연결</b>하면서 세 칸을 모두 체크해 주세요.</div>');
    if (!c.folder) o.push('<div class="t3-note">📂 영상 폴더가 정해지지 않았습니다. 아래 <b>폴더 바꾸기</b>로 고르세요.</div>');
    else if (c.folderOk === false) o.push(`<div class="danger">📂 폴더를 찾을 수 없습니다: ${esc(c.folder)}<br>폴더를 옮기거나 지웠다면 아래에서 다시 골라 주세요.</div>`);
    return o.join('');
  }

  const actsSig = c => [c.authed, c.needsReconnect, c.how, c.channelId];
  function actsHtml(c) {
    const b = (act, label, on) => `<button type="button" class="tb${on ? ' on' : ''}" onclick="t3Act(this,'${act}')">${label}</button>`;
    return `<div class="t3-acts">
      ${c.authed ? b('check', '🔍 연결 점검', true) : ''}
      ${b('signin', (c.authed || c.needsReconnect) ? '🔑 다시 연결' : '🔑 구글 계정 연결', !c.authed || !!c.needsReconnect)}
      ${b('code', '📟 코드 인증')}
      ${c.authed ? b('profile', '🔄 채널 정보 새로 받기') + b('studio', '🎬 스튜디오 열기') + b('logout', '🚪 연결 해제') : ''}
      <span class="t3-sp"></span>
      <button type="button" class="tb" title="위로" aria-label="위로 옮기기" onclick="t3Act(this,'move-up')">▲</button>
      <button type="button" class="tb" title="아래로" aria-label="아래로 옮기기" onclick="t3Act(this,'move-down')">▼</button>
    </div>`;
  }

  const folderSig = c => [c.folder, c.folderOk, c.bound, c.counts];
  function folderHtml(c) {
    const n = c.name, cn = c.counts || {};
    const chip = !c.folder ? '<span class="chbadge full">결합 전</span>'
      : c.bound ? '<span class="chbadge ok">✓ 결합 완료</span>' : '<span class="chbadge no">⚠ 표식 없음</span>';
    return `<div class="subhead">📂 영상 폴더 ${chip}</div>
      <div class="t3-path" title="${attr(c.folder)}">${c.folder ? esc(c.folder) : '(정해지지 않음)'}</div>
      <div class="hintline" style="margin-top:0">대기 ${num(cn['대기'])} · 완료 ${num(cn['완료'])} · 검토필요 ${num(cn['검토필요'])}</div>
      <div class="t3-acts">
        <button type="button" class="tb on" onclick="t3Act(this,'open-folder')">📂 폴더 열기</button>
        <button type="button" class="tb" onclick="t3Act(this,'pick-folder')">📁 폴더 바꾸기</button>
        ${c.folder && !c.bound ? '<button type="button" class="tb" onclick="t3Act(this,\'bind\')">🏷 표식 새기기</button>' : ''}
      </div>
      <label class="flabel" for="${fid(n, 'path')}">경로를 직접 적어서 정하기</label>
      <div style="display:flex;gap:4px"><input class="fin" id="${fid(n, 'path')}" data-k="__path" value="${attr(c.folder || '')}" autocomplete="off" spellcheck="false" placeholder="/Users/이름/업로드영상/채널1"/>
      <button type="button" class="tb" onclick="t3Act(this,'set-folder')">적용</button></div>
      <div class="hintline">고르면 그 폴더에 이 채널의 표식을 새겨, 다음부터 폴더와 채널의 짝이 맞는지 스스로 확인합니다. 다른 채널이 쓰는 폴더는 고를 수 없습니다.</div>`;
  }

  const nameSig = c => [c.name];
  function nameHtml(c) {
    const id = fid(c.name, 'rename');
    return `<div class="subhead">✏️ 채널 이름</div>
      <div style="display:flex;gap:4px"><input class="fin" id="${id}" data-k="__name" value="${attr(c.name)}" maxlength="60" autocomplete="off" aria-label="채널 이름"/>
      <button type="button" class="tb" onclick="t3Act(this,'rename')">이름 바꾸기</button></div>
      <div class="hintline">실제 채널은 채널 ID 로 묶여 있어 이름을 바꿔도 연결이 풀리지 않습니다.</div>`;
  }

  const LANGS = [['', '지정 안 함'], ['ko', '한국어'], ['en', 'English'], ['ja', '日本語']];
  const confSig = c => [c.conf];
  function confHtml(c) {
    const n = c.name, f = (c.conf && typeof c.conf === 'object') ? c.conf : {};
    const V = k => N[SPEC[k].t](f[k], SPEC[k]);
    const cp = (f.coupang && typeof f.coupang === 'object') ? f.coupang : {};
    const mr = (f.meta_rule && typeof f.meta_rule === 'object') ? f.meta_rule : {};
    const isLong = !!(f.allow_not_short || f['롱폼']);
    return `
    <div class="subhead" style="margin-top:6px">📝 올릴 때 문안</div>
    <div class="grid2">
      ${inp(n, 'title_prefix', '올릴 때 제목 머리글', f.title_prefix, { ph: '예: 【쇼츠】', hint: '제목 앞에 붙는 글입니다. 비워 두면 붙이지 않습니다.' })}
      ${inp(n, 'tags', '태그 (쉼표로 구분)', V('tags').join(', '), { ph: '예: 정치, 뉴스', hint: '문안에 태그가 따로 없을 때 쓰는 기본 태그입니다.' })}
    </div>
    <div style="margin-top:10px">${area(n, 'desc', '기본 설명', f.desc, { rows: 3, hint: '문안에 설명이 따로 없을 때 쓰는 기본 설명입니다.' })}</div>
    <div style="margin-top:10px">${inp(n, 'prefix', '파일 이름 머리말 (섞임 방지)', f.prefix, { ph: '비우면 검사하지 않음', hint: '정해 두면 이 머리말로 시작하지 않는 파일은 「다른 채널 영상이 섞였다」고 보고 올리기 전에 멈춥니다.' })}</div>

    <div class="subhead">🤖 AI 문안</div>
    <div class="hintline" style="margin-top:0">문안(쪽지·txt)이 없는 영상은 올리기 직전에 AI 가 영상과 이 채널의 말투를 보고 제목·설명·해시태그를 짓습니다.
    <b>쇼츠는 짧게, 롱폼은 길게</b> 형식이 다르게 지어집니다. 아래 칸은 <b>비우면 자동</b>입니다.</div>
    ${sw('ai', '이 채널에서 AI 문안 쓰기', '기본 켜짐 · 끄면 이 채널만 파일 이름이 제목이 됩니다', V('ai'))}
    <div class="grid2" style="margin-top:6px">
      ${area(n, 'desc_head', '고정 설명 머리말', f.desc_head, { rows: 2, auto: true, hint: '자동으로 지은 설명 <b>앞</b>에 늘 붙일 글' })}
      ${area(n, 'desc_tail', '고정 설명 꼬리말', f.desc_tail, { rows: 2, auto: true, hint: '자동으로 지은 설명 <b>뒤</b>에 늘 붙일 글' })}
      ${inp(n, 'fixed_tags', '고정 해시태그', V('fixed_tags').join(', '), { ph: '# 없이 쉼표로 (예: 정치, 뉴스)', auto: true, hint: '늘 넣을 해시태그 — # 는 빼고 적습니다' })}
      ${inp(n, 'tone', '말투 메모', f.tone, { ph: '예: 반말로 짧게, 이모지 없이', auto: true, hint: '비우면 이 채널의 지난 영상을 보고 자동으로 맞춥니다' })}
    </div>

    <div class="subhead">🛒 쿠팡 자동 링크</div>
    <div class="hintline" style="margin-top:0">관련 상품이 없으면 자동으로 안 붙지만, <b>아예 끄고 싶으면 여기서 끄세요</b> (정치·뉴스 채널 등). 쿠팡 파트너스 열쇠는 ⚙️ 설정 탭에서 넣습니다.</div>
    ${sw('coupang.on', '이 채널에서 쿠팡 자동 링크 붙이기', '기본 켜짐', cp.on !== false)}
    <div class="grid2" style="margin-top:6px">
      ${sel(n, 'coupang.mode', '상품 고르는 방식', [['', '기본 (설정 탭을 따름)'], ['auto', 'AI·규칙 (AI 열쇠가 있으면 AI, 없으면 규칙)'], ['rule', '규칙만'], ['off', '끄기']], cp.mode || '')}
      ${inp(n, 'coupang.sub_id', 'sub ID (영문·숫자)', cp.sub_id, { ph: '비우면 설정 탭의 기본 sub ID', max: 40, hint: '쿠팡 수수료 집계에서 이 채널을 구분하는 코드입니다.' })}
    </div>

    <div class="subhead">📅 공개 방식</div>
    <div class="grid2">
      ${sel(n, 'publish', '공개 방식', [['schedule', '예약 공개 (정한 시각에)'], ['now', '심사 통과 뒤 바로']], V('publish'))}
      ${sel(n, 'after_review', '심사 뒤 공개 범위', [['public', '🌍 공개'], ['unlisted', '🔗 일부 공개 (링크가 있는 사람만)'], ['private', '🔒 비공개 (자동으로 공개하지 않음)']], V('after_review'))}
      ${inp(n, 'times', '하루 공개 시각 후보 (HH:MM, 쉼표로)', V('times').join(', '), { ph: '예: 09:15, 15:15', hint: '쇼츠가 공개될 시각 후보입니다.' })}
      ${inp(n, 'long_slots', '롱폼 하루 공개 칸 (HH:MM, 쉼표로)', V('long_slots').join(', '), { ph: '예: 19:00', hint: '롱폼은 이 시각 중 비어 있는 다음 칸에 공개 예약합니다.' })}
    </div>

    <div class="subhead">📥 영상 고르기·처리</div>
    <div class="grid2">
      ${sel(n, 'pick', '영상 고르는 방식', [['oldest', '오래된 것부터 (기본)'], ['order', '파일 이름 순서대로'], ['suggest', '앱이 추천 (내가 확인)'], ['manual', '내가 고른 것만']], V('pick'))}
      ${sel(n, 'after_upload', '올린 뒤 원본 처리', [['', '자동 (앱이 둔 사본이면 휴지통, 내 폴더면 업로드완료 폴더로)'], ['trash', '🗑 휴지통으로'], ['move', '📁 업로드완료 폴더로'], ['keep', '📌 그대로 두기']], V('after_upload'))}
    </div>
    <div class="t3-g3" style="margin-top:10px">
      ${sel(n, 'daily_rule', '오늘 올릴 개수 정하는 방식', [['views', '조회수를 보고 정하기'], ['fixed', '매일 같은 개수']], V('daily_rule'))}
      ${inp(n, 'daily', '매일 같은 개수일 때', f.daily, { type: 'number', min: 1, maxn: 99, ph: '1' })}
      ${inp(n, 'daily_fallback', '조회수를 모를 때 개수', f.daily_fallback, { type: 'number', min: 0, maxn: 99, ph: '1' })}
    </div>

    <details class="t3-sec"><summary>⚙️ 종류·언어·승인·자동 점검 (고급)</summary><div class="t3-sec-b">
      ${sw('__long', '쇼츠가 아니어도 올리기 (롱폼 채널)', '켜면 3분이 넘는 영상·가로 영상도 올립니다', isLong)}
      <div class="grid2" style="margin-top:6px">
        ${sel(n, 'audio_language', '언어', LANGS, V('audio_language'), { hint: '정하면 제목·음성 언어를 못박습니다. 지정 안 함이면 아무것도 넣지 않습니다.' })}
        ${inp(n, 'approved_by', '승인자', f.approved_by, { ph: '예: 담당자 이름', hint: '올릴 때 「누가 확인했나」로 함께 기록됩니다.' })}
        ${sel(n, 'made_for_kids', '아동용 표시 (이 채널만 다르게)', [['', '정책 따름 (설정 탭의 운영 원칙)'], ['true', '예 — 아동용'], ['false', '아니오 — 아동용 아님']], N.tri(f.made_for_kids), { hint: '법적 신고 항목입니다. 보통은 「정책 따름」으로 둡니다.' })}
        ${inp(n, 'studio_profile', '스튜디오를 열 크롬 프로필', f.studio_profile, { ph: '비우면 기본', hint: '「스튜디오 열기」가 열 크롬 프로필 이름입니다.' })}
      </div>
      ${sw('thumb_watch', '썸네일 실패 감시', '썸네일 올리기가 실패하면 표식을 남겨 10분마다 다시 시도합니다', V('thumb_watch'))}
      ${sw('회수', '저성과 영상 비공개로 돌리기 (회수)', '기본 꺼짐', V('회수'))}
      <div class="danger" style="margin-top:6px">⚠️ 켜면 <b>올린 지 7일이 넘었고 조회수가 1000 미만인 영상을 비공개로 돌립니다.</b>
      자동으로 다시 공개하지는 않습니다. 롱폼처럼 천천히 크는 채널은 켜지 않는 것이 좋습니다.${f['회수제외'] ? '<br><span style="color:var(--t3)">(이 채널은 예전 설정으로 「회수 제외」가 걸려 있습니다 — 이 칸은 그대로 보존됩니다.)</span>' : ''}</div>

      <div class="subhead">🌐 문안 규격 (해외 채널용)</div>
      <div class="hintline" style="margin-top:0">켜 둔 규격에 문안이 안 맞으면 올리기 전에 멈추고 알려 줍니다. 모두 비워 두면 검사하지 않습니다.</div>
      ${sw('meta.forbid_hangul', '한글이 한 글자라도 있으면 막기', '일본어·영어 채널용', !!mr.forbid_hangul)}
      ${sw('meta.forbid_shorts_tag', '#shorts 태그 막기', '', !!mr.forbid_shorts_tag)}
      ${sw('meta.forbid_cta', '구독·좋아요·알림 유도 줄 막기', '', !!mr.forbid_cta)}
      <div class="t3-g3" style="margin-top:6px">
        ${inp(n, 'meta.hashtags', '해시태그 정확한 개수', mr.hashtags, { type: 'number', min: 0, maxn: 30, ph: '비우면 검사 안 함' })}
        ${inp(n, 'meta.desc_min', '설명 최소 글자 수', mr.desc_min, { type: 'number', min: 0, maxn: 5000, ph: '비우면 검사 안 함' })}
        ${inp(n, 'meta.desc_max', '설명 최대 글자 수', mr.desc_max, { type: 'number', min: 0, maxn: 5000, ph: '비우면 검사 안 함' })}
      </div>
    </div></details>

    <div class="t3-sv">
      <button type="button" class="go" onclick="t3Act(this,'save-conf')">💾 이 채널 설정 저장</button>
      <button type="button" class="tb" onclick="t3Act(this,'revert-conf')">↩ 되돌리기</button>
    </div>`;
  }

  /* ---- 일 한도 정책 ---- */
  const POL_DEF = { daily_limit: 2, kind: '', cap_uploads: true, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50 };
  const POL_KEYS = ['daily_limit', 'kind', 'cap_uploads', 'day_start_hour', 'overflow_day_start_hour', 'publish_gap_minutes', 'review_lead_minutes'];
  /** 정책 칸 값: 서버가 policyConf 를 주면 그것, 아니면 한 줄 설명(describePolicy)에서 읽는다 */
  function polConf(c) {
    if (c.policyConf && typeof c.policyConf === 'object') return c.policyConf;
    const t = String(c.policy || ''); if (!t) return null;
    if (/승인한 영상만/.test(t)) return { approved: true };
    const m = /하루\s*(\d+)\s*편/.exec(t); if (!m) return null;
    const o = { daily_limit: +m[1], kind: /롱폼만/.test(t) ? '롱폼' : /쇼츠만/.test(t) ? '쇼츠' : '', cap_uploads: !/공개 예약만 제한/.test(t) };
    const st = /(\d{1,2})시 시작/.exec(t); if (st) o.day_start_hour = +st[1];
    const ov = /밀리면\s*(\d{1,2})시/.exec(t); if (ov) o.overflow_day_start_hour = +ov[1];
    const mins = re => { const x = re.exec(t); return x ? (x[1] ? +x[1] * 60 : 0) + (x[2] ? +x[2] : 0) : null; };
    const gap = mins(/공개 간격\s*(?:(\d+)시간)?\s*(?:(\d+)분)?/), lead = mins(/올린 뒤\s*(?:(\d+)시간)?\s*(?:(\d+)분)?\s*이후/);
    if (gap != null) o.publish_gap_minutes = gap;
    if (lead != null) o.review_lead_minutes = lead;
    return o;
  }
  const policySig = c => [c.policy, c.policyConf];
  function policyHtml(c) {
    const pc = polConf(c);
    const head = '<div class="subhead">📆 일 한도 (하루 몇 편까지)</div>';
    if (pc && pc.approved) {
      return head + `<div class="t3-note">${esc(c.policy)}<br>승인한 영상만 다루는 정책이라 여기서는 바꾸지 않습니다.</div>
        <div class="t3-acts"><button type="button" class="tb" onclick="t3Act(this,'clear-policy')">일 한도 해제</button></div>`;
    }
    const p = Object.assign({}, POL_DEF, pc || {});
    const n = c.name, f = k => `data-p="${k}"`;
    const nid = k => fid(n, 'pol_' + k);
    const H = '<div class="hintline">';
    return head + (pc ? `<div class="t3-ok">지금: ${esc(c.policy || '')}</div>` : '<div class="hintline" style="margin-top:0">아직 정하지 않았습니다. 정하면 이 채널은 하루에 N편까지만 올리고 공개하며, 넘치는 영상은 다음 날로 N편씩 밀려 예약됩니다.</div>') + `
      <div class="hintline"><b>롱폼/쇼츠를 구분해 올립니다</b> — 종류를 고르면 그 종류만 셉니다(쇼츠 한도가 롱폼을 먹지 않습니다). 구분 없이 세려면 「전부」를 고르세요.</div>
      <div class="grid2" style="margin-top:8px">
        <div><label class="flabel" for="${nid('daily_limit')}">하루 몇 편</label>
          <input class="fin" id="${nid('daily_limit')}" ${f('daily_limit')} type="number" min="1" max="99" value="${attr(p.daily_limit)}"/></div>
        <div><label class="flabel" for="${nid('kind')}">세는 종류</label>
          <select class="fin" id="${nid('kind')}" ${f('kind')}>
            <option value=""${!p.kind ? ' selected' : ''}>전부 (쇼츠·롱폼 구분 없음)</option>
            <option value="쇼츠"${p.kind === '쇼츠' ? ' selected' : ''}>쇼츠만</option>
            <option value="롱폼"${p.kind === '롱폼' ? ' selected' : ''}>롱폼만</option></select></div>
        <div><label class="flabel" for="${nid('cap_uploads')}">제한하는 것</label>
          <select class="fin" id="${nid('cap_uploads')}" ${f('cap_uploads')}>
            <option value="true"${p.cap_uploads !== false ? ' selected' : ''}>올리기와 공개 예약 모두</option>
            <option value="false"${p.cap_uploads === false ? ' selected' : ''}>공개 예약만 (올리기는 그대로)</option></select></div>
        <div><label class="flabel" for="${nid('day_start_hour')}">하루 시작 시각 (시)</label>
          <input class="fin" id="${nid('day_start_hour')}" ${f('day_start_hour')} type="number" min="0" max="23" value="${attr(p.day_start_hour)}"/>
          ${H}이 시각 전에는 올리지도 공개하지도 않습니다.</div></div>
        <div><label class="flabel" for="${nid('overflow_day_start_hour')}">밀릴 때 시작 시각 (시)</label>
          <input class="fin" id="${nid('overflow_day_start_hour')}" ${f('overflow_day_start_hour')} type="number" min="0" max="23" value="${attr(p.overflow_day_start_hour ?? '')}" placeholder="비우면 위와 같음"/>
          ${H}한도가 차서 다음 날로 밀릴 때 공개를 시작하는 시각입니다.</div></div>
        <div><label class="flabel" for="${nid('publish_gap_minutes')}">공개 간격 (분)</label>
          <input class="fin" id="${nid('publish_gap_minutes')}" ${f('publish_gap_minutes')} type="number" min="0" max="1440" value="${attr(p.publish_gap_minutes)}"/>
          ${H}공개와 공개 사이에 두는 최소 간격입니다.</div></div>
        <div><label class="flabel" for="${nid('review_lead_minutes')}">검토 선행 (분)</label>
          <input class="fin" id="${nid('review_lead_minutes')}" ${f('review_lead_minutes')} type="number" min="0" max="1440" value="${attr(p.review_lead_minutes)}"/>
          ${H}올린 뒤 검토가 끝나는 데 드는 시간 — 올린 뒤 이만큼 지나야 공개로 예약합니다.</div></div>
      </div>
      <div class="t3-sv">
        <button type="button" class="go" onclick="t3Act(this,'save-policy')">💾 일 한도 저장</button>
        ${pc ? '<button type="button" class="tb" onclick="t3Act(this,\'clear-policy\')">일 한도 해제</button>' : ''}
      </div>`;
  }

  /* ---- 이 채널 전용 열쇠 ---- */
  const secretSig = c => [c.secretFile, c.keyFrom];
  function secretHtml(c) {
    const n = c.name;
    return `<details class="t3-sec"><summary>🔑 이 채널만 다른 열쇠 쓰기 (고급)</summary><div class="t3-sec-b">
      <div class="p13" style="padding-top:8px">${c.secretFile
        ? `이 채널은 전용 열쇠 <code>${esc(c.secretFile)}</code> 로 연결됩니다.`
        : '지금은 공통 열쇠(내장 또는 위에서 넣은 열쇠)를 씁니다.'}</div>
      <div class="hintline">채널마다 다른 구글 프로젝트의 열쇠를 쓰고 싶을 때만 쓰세요. <b>내 열쇠를 쓰는 경우에만</b> 구글의 하루 호출 한도가 열쇠(프로젝트)마다 따로 계산됩니다.
      지정한 뒤에는 이 채널을 <b>다시 연결</b>해야 적용됩니다.</div>
      <div class="t3-acts">
        <button type="button" class="tb on" onclick="t3Act(this,'sec-pick')">📂 열쇠 JSON 파일 올리기</button>
        <input type="file" class="t3-file" accept=".json,application/json" onchange="t3Act(this,'sec-file')"/>
        ${c.secretFile ? '<button type="button" class="tb" onclick="t3Act(this,\'sec-clear\')">🗑 전용 열쇠 지우기</button>' : ''}
      </div>
      <div class="grid2">
        <div><label class="flabel" for="${fid(n, 'sec_id')}">또는 클라이언트 ID 붙여넣기</label>
          <input class="fin" id="${fid(n, 'sec_id')}" data-k="__sid" autocomplete="off" spellcheck="false" placeholder="....apps.googleusercontent.com"/></div>
        <div><label class="flabel" for="${fid(n, 'sec_pw')}">클라이언트 보안 비밀번호</label>
          <input class="fin" id="${fid(n, 'sec_pw')}" data-k="__spw" type="password" autocomplete="off" spellcheck="false" placeholder="GOCSPX-..."/></div>
      </div>
      <button type="button" class="tb on" style="margin-top:8px" onclick="t3Act(this,'sec-paste')">💾 전용 열쇠로 저장</button>
      <div class="hintline">「데스크톱 앱」 유형 열쇠여야 합니다. 열쇠는 이 컴퓨터에만 저장되고 화면에 다시 보이지 않습니다.</div>
    </div></details>`;
  }

  const dangerSig = c => [c.name];
  function dangerHtml() {
    return `<div class="subhead" style="color:var(--accent)">삭제</div>
      <button type="button" class="tb" onclick="t3Act(this,'remove')">🗑 채널 삭제</button>
      <div class="hintline">목록에서만 뺍니다. <b>올린 기록·영상 파일·폴더는 그대로</b> 남고, 유튜브에 올라간 영상도 그대로입니다.</div>`;
  }

  // 영역 목록: inputs=true 는 입력칸이 있어 손대는 중이면 다시 그리지 않는다
  const SECS = [
    { id: 'warn', sig: warnSig, html: warnHtml },
    { id: 'acts', sig: actsSig, html: actsHtml },
    { id: 'folder', sig: folderSig, html: folderHtml, inputs: true },
    { id: 'name', sig: nameSig, html: nameHtml, inputs: true },
    { id: 'conf', sig: confSig, html: confHtml, inputs: true, keep: true },
    { id: 'policy', sig: policySig, html: policyHtml, inputs: true },
    { id: 'secret', sig: secretSig, html: secretHtml, inputs: true },
    { id: 'danger', sig: dangerSig, html: dangerHtml },
  ];

  /* ================= 목록 맞추기 (키가 있는 갱신) ================= */
  const editing = node => { const a = document.activeElement; return !!(a && node.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
  function newCard(c) {
    const el = document.createElement('div');
    el.className = 'chrow'; el.dataset.ch = c.name; el.id = 't3r_' + uid(c.name);
    el.innerHTML = `<div class="chrow-h" data-sec="head" draggable="true" role="button" tabindex="0" aria-expanded="false" onclick="t3Act(this,'toggle')" onkeydown="t3HeadKey(event,this)"></div>
      <div class="chrow-b">${SECS.map(s => `<div data-sec="${s.id}"${s.inputs ? ' data-inputs="1"' : ''}></div>`).join('')}</div>`;
    return el;
  }
  window.t3HeadKey = (e, el) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t3Act(el, 'toggle'); } };

  function update(el, c, force) {
    const isOpen = open.has(c.name);
    el.classList.toggle('open', isOpen);
    const head = el.firstElementChild;
    head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    const hs = JSON.stringify(headSig(c));
    if (force || head.dataset.sig !== hs) { head.innerHTML = headHtml(c); head.dataset.sig = hs; }
    if (!isOpen) return;
    for (const sp of SECS) {
      const node = el.querySelector(`[data-sec="${sp.id}"]`);
      const sig = JSON.stringify(sp.sig(c));
      if (!force && node.dataset.sig === sig) continue;
      if (!force && sp.inputs && (node.dataset.dirty === '1' || editing(node))) continue;   // 손대는 중이면 건드리지 않는다
      node.innerHTML = sp.html(c);
      node.dataset.sig = sig; node.dataset.dirty = '';
      if (sp.keep) base.set(c.name + '|' + sp.id, JSON.parse(JSON.stringify(c.conf || {})));
    }
  }
  function reconcile(list) {
    const box = $('t3List');
    $('t3Empty').classList.toggle('hide', list.length > 0);
    const have = new Map([...box.children].map(el => [el.dataset.ch, el]));
    list.forEach((c, i) => {
      let el = have.get(c.name);
      if (el) have.delete(c.name); else el = newCard(c);
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      update(el, c);
    });
    have.forEach(el => el.remove());
  }
  const rowOf = name => [...$('t3List').children].find(el => el.dataset.ch === name) || null;
  /** 한 영역을 지금 데이터로 다시 그린다(저장한 뒤 곧바로 새 값을 보여 주려고) */
  function refreshSec(name, secId) {
    const el = rowOf(name), c = chan(name); if (!el || !c) return;
    const node = el.querySelector(`[data-sec="${secId}"]`); if (!node) return;
    node.dataset.sig = ''; node.dataset.dirty = '';
    update(el, c);
  }
  const blurIn = el => { const a = document.activeElement; if (a && el && el.contains(a) && a.blur) a.blur(); };

  /* ================= 폼 읽기 · 바뀐 칸 가리기 ================= */
  function readRaw(secEl) {
    const raw = {};
    secEl.querySelectorAll('[data-k]').forEach(el => {
      raw[el.dataset.k] = el.classList.contains('sw') ? el.querySelector('.tgl').classList.contains('on') : el.value;
    });
    return raw;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /** → {set} 또는 {err}. 바뀐 칸만 담는다 */
  function buildSet(f, raw) {
    const set = {};
    for (const [k, sp] of Object.entries(SPEC)) {
      if (!(k in raw)) continue;
      let cur = N[sp.t](raw[k], sp), old = N[sp.t](f[k], sp);
      if (sp.time) {
        const bad = cur.find(x => !fmtTime(x));
        if (bad) return { err: `「${sp.label}」은 09:15 처럼 시:분으로 적어 주세요 (잘못된 값: ${bad})` };
        cur = cur.map(fmtTime); old = old.map(x => fmtTime(x) || x);
      }
      if (sp.t === 'int') {
        if (String(raw[k]).trim() !== '' && cur === null) return { err: `「${sp.label}」은 숫자로 적어 주세요` };
        if (cur !== null && (cur < sp.min || cur > sp.max)) return { err: `「${sp.label}」은 ${sp.min}~${sp.max} 사이로 적어 주세요` };
      }
      if (!same(cur, old)) set[k] = OUT[sp.t](cur, sp);
    }
    // 쇼츠가 아니어도 올리기 — 롱폼 표시 두 칸을 같이 다룬다
    if ('__long' in raw) {
      const old = !!(f.allow_not_short || f['롱폼']);
      if (raw.__long !== old) { set.allow_not_short = raw.__long; if (!raw.__long && f['롱폼'] !== undefined) set['롱폼'] = null; }
    }
    // 쿠팡 자동 링크 — 한 덩어리
    {
      const old = (f.coupang && typeof f.coupang === 'object') ? f.coupang : {};
      const sub = String(raw['coupang.sub_id'] ?? '').trim();
      if (sub && !/^[A-Za-z0-9]+$/.test(sub)) return { err: '쿠팡 sub ID 는 영문·숫자만 쓸 수 있습니다' };
      const cur = { on: raw['coupang.on'] !== false, mode: String(raw['coupang.mode'] ?? ''), sub_id: sub };
      const was = { on: old.on !== false, mode: String(old.mode || ''), sub_id: String(old.sub_id || '').trim() };
      if (!same(cur, was)) {
        const keep = {}; for (const [k, v] of Object.entries(old)) if (!['on', 'mode', 'sub_id'].includes(k)) keep[k] = v;
        const next = Object.assign(keep, cur.on ? {} : { on: false }, cur.mode ? { mode: cur.mode } : {}, cur.sub_id ? { sub_id: cur.sub_id } : {});
        set.coupang = Object.keys(next).length ? next : null;
      }
    }
    // 문안 규격 — 한 덩어리
    {
      const old = (f.meta_rule && typeof f.meta_rule === 'object') ? f.meta_rule : {};
      const num0 = k => { const s = String(raw['meta.' + k] ?? '').trim(); if (s === '') return null; const x = Number(s); return Number.isInteger(x) && x >= 0 ? x : NaN; };
      const edit = {};
      for (const k of ['forbid_hangul', 'forbid_shorts_tag', 'forbid_cta']) if (raw['meta.' + k]) edit[k] = true;
      for (const k of ['hashtags', 'desc_min', 'desc_max']) {
        const x = num0(k);
        if (Number.isNaN(x)) return { err: '문안 규격의 개수·글자 수는 0 이상의 정수로 적어 주세요' };
        if (x !== null) edit[k] = x;
      }
      if (edit.desc_min != null && edit.desc_max != null && edit.desc_min > edit.desc_max) return { err: '설명 최소 글자 수가 최대보다 클 수 없습니다' };
      const known = ['forbid_hangul', 'forbid_shorts_tag', 'forbid_cta', 'hashtags', 'desc_min', 'desc_max'];
      const wasEdit = {}; for (const k of known) if (old[k]) wasEdit[k] = old[k];
      if (!same(sortObj(edit), sortObj(wasEdit))) {
        const keep = {}; for (const [k, v] of Object.entries(old)) if (!known.includes(k)) keep[k] = v;
        const next = Object.assign(keep, edit);
        set.meta_rule = Object.keys(next).length ? next : null;
      }
    }
    return { set };
  }
  const sortObj = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a < b ? -1 : 1));

  /* ================= 동작들 ================= */
  const A = {
    toggle(el, row, name) {
      if (open.has(name)) open.delete(name); else open.add(name);
      const c = chan(name); if (c) update(row, c);
    },
    'move-up': (el, row, name) => moveBy(row, name, -1),
    'move-down': (el, row, name) => moveBy(row, name, 1),

    /* ---- 연결 ---- */
    signin: (el, row, name) => siStart(name),
    recon: (el, row, name) => siStart(name),
    code: (el, row, name) => cdStart(name),
    'link-signin': () => siStart(''),
    'link-code': () => cdStart(''),
    async check(el, row, name) {
      msg('연결 상태를 확인하는 중…');
      const r = await call('/api/channel/check', { ch: name });
      if (r.ok === false) { msg(r.why || '확인에 실패했습니다', 'err'); return poll(); }
      msg(`✅ 정상입니다 — ${r.title || name}${r.units ? ` (할당량 ${r.units}점 사용)` : ''}`, 'ok');
      poll();
    },
    async logout(el, row, name) {
      const ok = await confirmBox({ emoji: '🚪', title: '구글 연결을 해제할까요?', danger: true, ok: '연결 해제',
        body: `채널 「<b>${esc(name)}</b>」의 연결을 해제합니다.<br><b>이 컴퓨터에 저장된 로그인 정보(토큰)만 지웁니다.</b> 영상·폴더·올린 기록은 그대로입니다.<br>다시 올리려면 구글 계정을 다시 연결해야 합니다.` });
      if (!ok) return;
      const r = await call('/api/channel/logout', { ch: name, confirm: true });
      if (r.ok === false) return msg(r.why || '연결을 해제하지 못했습니다', 'err');
      msg('연결을 해제했습니다');
      poll();
    },
    async profile(el, row, name) {
      msg('채널 정보를 받는 중…');
      const r = await call('/api/profile/refresh', { ch: name });
      if (r.ok === false) return msg(r.why || '채널 정보를 받지 못했습니다', 'err');
      msg('채널 이름·배너·프로필 사진을 새로 받았습니다', 'ok');
      poll();
    },
    async studio(el, row, name) {
      const c = chan(name);
      if (!c || !c.channelId) return msg('아직 연결되지 않은 채널입니다', 'err');
      try { await fetch('/studio?cid=' + encodeURIComponent(c.channelId)); msg('유튜브 스튜디오를 엽니다'); }
      catch (_) { msg('앱과 연결되지 않았습니다', 'err'); }
    },

    /* ---- 폴더 · 이름 · 삭제 ---- */
    async 'open-folder'(el, row, name) {
      const c = chan(name);
      if (!c || !c.folder) return msg('폴더가 아직 정해지지 않았습니다', 'err');
      const r = await call('/api/open', { path: c.folder });
      if (r.ok === false) msg(r.why || '폴더를 열지 못했습니다', 'err');
    },
    async 'pick-folder'(el, row, name) {
      msg('폴더 선택창을 여는 중…');
      const r = await call('/api/folder', { ch: name });
      if (r.ok === false) return msg(r.why || '폴더를 정하지 못했습니다');
      msg(`폴더를 정했습니다${r.n != null ? ` — 영상 ${num(r.n)}개` : ''}`, 'ok');
      refreshSec(name, 'folder'); poll();
    },
    async 'set-folder'(el, row, name) {
      const path = row.querySelector('[data-k="__path"]').value.trim();
      if (!path) return msg('폴더 경로를 적어 주세요', 'err');
      const r = await call('/api/folder/set', { ch: name, path });
      if (r.ok === false) return msg(r.why || '폴더를 정하지 못했습니다', 'err');
      msg(`폴더를 정했습니다${r.n != null ? ` — 영상 ${num(r.n)}개` : ''}`, 'ok');
      blurIn(row); refreshSec(name, 'folder'); poll();
    },
    async bind(el, row, name) {
      const c = chan(name); if (!c || !c.folder) return;
      const r = await call('/api/folder/set', { ch: name, path: c.folder });
      if (r.ok === false) return msg(r.why || '표식을 새기지 못했습니다', 'err');
      msg('폴더에 이 채널의 표식을 새겼습니다', 'ok');
      poll();
    },
    async rename(el, row, name) {
      const nu = row.querySelector('[data-k="__name"]').value.trim();
      if (!nu) return msg('이름을 입력해 주세요', 'err');
      if (nu === name) return msg('바뀐 것이 없습니다');
      const r = await call('/api/rename', { ch: name, name: nu });
      if (r.ok === false) return msg(r.why || '이름을 바꾸지 못했습니다', 'err');
      if (open.delete(name)) open.add(r.name || nu);
      msg('이름을 바꿨습니다. 채널 연결은 그대로입니다', 'ok');
      await poll();
    },
    async remove(el, row, name) {
      const ok = await confirmBox({ emoji: '🗑', title: '채널을 목록에서 뺄까요?', danger: true, ok: '채널 빼기',
        body: `「<b>${esc(name)}</b>」 채널을 목록에서 뺍니다.<br><b>올린 기록과 영상 파일, 폴더는 그대로 남습니다.</b> 유튜브에 올라간 영상도 그대로입니다.<br>이 컴퓨터에 저장된 연결(로그인 정보)과 채널 설정만 지웁니다.` });
      if (!ok) return;
      const r = await call('/api/remove', { ch: name, confirm: true });
      if (r.ok === false) return msg(r.why || '채널을 빼지 못했습니다', 'err');
      open.delete(name);
      msg('채널을 목록에서 뺐습니다');
      await poll();
    },

    /* ---- 채널별 설정 ---- */
    async 'save-conf'(el, row, name) {
      const secEl = row.querySelector('[data-sec="conf"]');
      const f = base.get(name + '|conf') || (chan(name) || {}).conf || {};
      const { set, err } = buildSet(f, readRaw(secEl));
      if (err) return msg(err, 'err');
      if (!Object.keys(set).length) { secEl.dataset.dirty = ''; return msg('바뀐 것이 없습니다'); }
      blurIn(secEl);
      el.disabled = true;
      const r = await call('/api/channel/update', { ch: name, set });
      el.disabled = false;
      if (r.ok === false) return msg(r.why || '저장하지 못했습니다', 'err');
      const c = chan(name); if (c && r.conf) c.conf = r.conf;
      secEl.dataset.dirty = '';
      msg('채널 설정을 저장했습니다', 'ok');
      refreshSec(name, 'conf'); poll();
    },
    'revert-conf'(el, row, name) { blurIn(row); refreshSec(name, 'conf'); msg('저장하지 않은 변경을 되돌렸습니다'); },

    /* ---- 일 한도 ---- */
    async 'save-policy'(el, row, name) {
      const g = k => { const e = row.querySelector(`[data-p="${k}"]`); return e ? e.value.trim() : ''; };
      const int = (k, lo, hi, label, blank) => {
        const s = g(k); if (s === '' && blank) return null;
        const x = Number(s);
        if (s === '' || !Number.isInteger(x) || x < lo || x > hi) throw new Error(`「${label}」은 ${lo}~${hi} 사이 정수로 적어 주세요`);
        return x;
      };
      let body;
      const had = polConf(chan(name) || {}) || {};                 // 지금 정해져 있는 값 — 지우려는지 알아보려고
      try {
        body = {
          ch: name,
          daily_limit: int('daily_limit', 1, 99, '하루 몇 편'),
          cap_uploads: g('cap_uploads') !== 'false',
          day_start_hour: int('day_start_hour', 0, 23, '하루 시작 시각'),
          publish_gap_minutes: int('publish_gap_minutes', 0, 1440, '공개 간격'),
          review_lead_minutes: int('review_lead_minutes', 0, 1440, '검토 선행'),
        };
        // 종류: 고르면 보내고, 「전부」로 바꾸는 것(지우기)은 null — 서버가 null 을 칸 지우기로 받아야 한다(메인에게 요청). 원래 없었으면 아예 안 보낸다.
        const kind = g('kind');
        if (kind) body.kind = kind; else if (had.kind) body.kind = null;
        // 밀릴 때 시작 시각: 비우면 「하루 시작 시각과 같음」이다 — null 은 서버가 0(자정)으로 읽으므로, 지울 때는 시작 시각과 같은 값을 보낸다(같은 뜻)
        const ov = int('overflow_day_start_hour', 0, 23, '밀릴 때 시작 시각', true);
        if (ov !== null) body.overflow_day_start_hour = ov;
        else if (had.overflow_day_start_hour != null) body.overflow_day_start_hour = body.day_start_hour;
      } catch (e) { return msg(e.message, 'err'); }
      const secEl = row.querySelector('[data-sec="policy"]');
      blurIn(secEl);
      const r = await call('/api/channel/policy', body);
      if (r.ok === false) return msg(r.why || '일 한도를 저장하지 못했습니다', 'err');
      secEl.dataset.dirty = '';
      msg(r.text ? '일 한도를 저장했습니다 — ' + r.text : '일 한도를 저장했습니다', 'ok');
      await poll(); refreshSec(name, 'policy');
    },
    async 'clear-policy'(el, row, name) {
      const ok = await confirmBox({ emoji: '📆', title: '일 한도를 해제할까요?', ok: '해제',
        body: `채널 「<b>${esc(name)}</b>」의 「하루 몇 편」 제한을 없앱니다.<br>이미 예약된 영상은 그대로입니다.` });
      if (!ok) return;
      const r = await call('/api/channel/policy/clear', { ch: name });
      if (r.ok === false) return msg(r.why || '해제하지 못했습니다', 'err');
      msg('일 한도를 해제했습니다');
      await poll(); refreshSec(name, 'policy');
    },

    /* ---- 이 채널 전용 열쇠 ---- */
    'sec-pick'(el, row) { const f = row.querySelector('input[type=file]'); if (f) f.click(); },
    async 'sec-file'(el, row, name) {
      const file = el.files && el.files[0]; if (!file) return;
      if (file.size > 200 * 1024) { el.value = ''; return msg('열쇠 파일이 너무 큽니다. 구글에서 받은 JSON 파일이 맞는지 확인해 주세요', 'err'); }
      const json = await file.text(); el.value = '';
      const r = await call('/api/channel/secret', { ch: name, json });
      if (r.ok === false) return msg(r.why || '열쇠를 저장하지 못했습니다', 'err');
      msg('이 채널 전용 열쇠를 저장했습니다 — 채널을 다시 연결해 주세요', 'ok');
      poll();
    },
    async 'sec-paste'(el, row, name) {
      const clientId = row.querySelector('[data-k="__sid"]').value.trim(), clientSecret = row.querySelector('[data-k="__spw"]').value.trim();
      if (!clientId || !clientSecret) return msg('클라이언트 ID 와 보안 비밀번호를 둘 다 넣어 주세요', 'err');
      const r = await call('/api/channel/secret', { ch: name, clientId, clientSecret });
      if (r.ok === false) return msg(r.why || '열쇠를 저장하지 못했습니다', 'err');
      row.querySelector('[data-k="__sid"]').value = ''; row.querySelector('[data-k="__spw"]').value = '';
      msg('이 채널 전용 열쇠를 저장했습니다 — 채널을 다시 연결해 주세요', 'ok');
      poll();
    },
    async 'sec-clear'(el, row, name) {
      const ok = await confirmBox({ emoji: '🔑', title: '전용 열쇠를 지울까요?', danger: true, ok: '전용 열쇠 지우기',
        body: `채널 「<b>${esc(name)}</b>」의 전용 열쇠 파일을 지우고 공통 열쇠를 씁니다.<br>이미 연결된 로그인은 그대로이고, 다시 연결할 때부터 공통 열쇠가 쓰입니다.` });
      if (!ok) return;
      const r = await call('/api/channel/secret/clear', { ch: name });
      if (r.ok === false) return msg(r.why || '지우지 못했습니다', 'err');
      msg('전용 열쇠를 지웠습니다');
      poll();
    },

    /* ---- 채널 추가 ---- */
    async add() {
      const inpEl = $('t3NewName'), name = inpEl.value.trim();
      if (!name) return msg('채널 이름을 입력해 주세요', 'err');
      const r = await call('/api/add', { name });
      if (r.ok === false) return msg(r.why || '채널을 만들지 못했습니다', 'err');
      const made = r.name || name;
      inpEl.value = '';
      open.add(made);
      await poll();
      const el = rowOf(made); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const go = await confirmBox({ emoji: '🔑', title: '지금 구글 계정을 연결할까요?', ok: '🔑 지금 연결', cancel: '나중에',
        body: `채널 「<b>${esc(made)}</b>」을 만들었습니다.<br>이어서 이 채널을 가진 구글 계정으로 로그인해 연결합니다.` });
      if (go) siStart(made);
    },

    /* ---- 내 구글 열쇠(고급) ---- */
    'gsec-pick-client': () => $('t3FileClient').click(),
    'gsec-pick-device': () => $('t3FileDevice').click(),
    'gsec-file-client': el => secFile('client', el),
    'gsec-file-device': el => secFile('device', el),
    'gsec-paste-client': () => $('t3PasteClient').classList.toggle('hide'),
    'gsec-paste-device': () => $('t3PasteDevice').classList.toggle('hide'),
    'gsec-save-client': () => secPaste('client', 't3PcId', 't3PcSec', 't3PasteClient'),
    'gsec-save-device': () => secPaste('device', 't3PdId', 't3PdSec', 't3PasteDevice'),
    'cd-stop': () => cdClose(true),
    'cd-copy': () => { if (cd && cd.code) cpy(cd.code, '코드를 복사했습니다 — 승인할 분께 보내세요'); },
    'cd-copyurl': () => { if (cd && cd.url) cpy(cd.url, '주소를 복사했습니다 — 승인할 분께 보내세요'); },
  };

  window.t3Act = (el, act) => {
    const row = el.closest && el.closest('.chrow');
    const name = row ? row.dataset.ch : ((el.dataset && el.dataset.ch) || '');
    const f = A[act]; if (!f) return;
    try {
      const r = f(el, row, name);
      if (r && typeof r.catch === 'function') r.catch(e => { console.error(e); msg('처리하는 중 문제가 생겼습니다', 'err'); });
    } catch (e) { console.error(e); msg('처리하는 중 문제가 생겼습니다', 'err'); }
  };

  /* ---- 순서 ---- */
  async function saveOrder(names) {
    const r = await call('/api/order', { names });
    if (r.ok === false) { msg(r.why || '순서를 바꾸지 못했습니다', 'err'); await poll(); return; }
    msg('순서를 바꿨습니다', 'ok');
  }
  function moveBy(row, name, d) {
    const box = $('t3List'), sib = d < 0 ? row.previousElementSibling : row.nextElementSibling;
    if (!sib) return;
    if (d < 0) box.insertBefore(row, sib); else box.insertBefore(sib, row);
    saveOrder([...box.children].map(x => x.dataset.ch));
  }
  function initDnd() {
    const box = $('t3List');
    box.addEventListener('dragstart', e => {
      const h = e.target.closest && e.target.closest('.chrow-h'); if (!h) return;
      const row = h.closest('.chrow');
      drag = { row, before: [...box.children].map(x => x.dataset.ch) };
      row.classList.add('t3-drag');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.dataset.ch); } catch (_) {} }
    });
    box.addEventListener('dragover', e => {
      if (!drag) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest && e.target.closest('.chrow');
      if (!over || over === drag.row) return;
      const r = over.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const ref = after ? over.nextSibling : over;
      if (ref !== drag.row) box.insertBefore(drag.row, ref);
    });
    box.addEventListener('drop', e => { if (drag) e.preventDefault(); });
    box.addEventListener('dragend', () => {
      if (!drag) return;
      const d = drag; drag = null;
      d.row.classList.remove('t3-drag');
      const now = [...box.children].map(x => x.dataset.ch);
      if (!same(now, d.before)) saveOrder(now);
    });
  }

  /* ================= 열쇠(고급) ================= */
  async function loadSecret() {
    const r = await call('/api/secret/state', {});
    if (r.ok === false) return;
    secState = r;
    const st = (own, emb) => own ? ['✓ 내 열쇠 파일 있음', 'ok'] : emb ? ['내장 열쇠 사용 중', ''] : ['⚠ 열쇠 없음', 'no'];
    const [ct, cc] = st(r.client, r.embedded && r.embedded.browser), [dt, dc] = st(r.device, r.embedded && r.embedded.device);
    const a = $('t3SecClient'), b = $('t3SecDevice');
    a.textContent = ct; a.className = 'chbadge ' + cc; b.textContent = dt; b.className = 'chbadge ' + dc;
    const bad = [];
    if (r.ready && r.ready.browser === false) bad.push('구글 로그인(🔑)');
    if (r.ready && r.ready.device === false) bad.push('코드 인증(📟)');
    $('t3SecLine').innerHTML = bad.length
      ? `<span class="t4-bad" style="color:var(--accent)">⚠️ ${bad.join('과 ')}에 쓸 열쇠가 없어 연결할 수 없습니다. 아래에 넣어 주세요.</span>`
      : `연결 준비가 되어 있습니다.${r.channels != null ? ` (연결된 채널 ${num(r.channels)}개${(r.missing || []).length ? ` · 아직 연결 안 된 채널 ${(r.missing || []).length}개` : ''})` : ''}`;
  }
  async function secFile(kind, el) {
    const file = el.files && el.files[0]; if (!file) return;
    if (file.size > 200 * 1024) { el.value = ''; return msg('열쇠 파일이 너무 큽니다. 구글에서 받은 JSON 파일이 맞는지 확인해 주세요', 'err'); }
    const json = await file.text(); el.value = '';
    const r = await call('/api/secret/save', { kind, json });
    if (r.ok === false) return msg(r.why || '열쇠를 저장하지 못했습니다', 'err');
    msg((kind === 'client' ? '구글 로그인용' : '코드 인증용') + ' 열쇠를 저장했습니다 — 채널을 다시 연결해 주세요', 'ok');
    loadSecret(); poll();
  }
  async function secPaste(kind, idId, secId, boxId) {
    const clientId = $(idId).value.trim(), clientSecret = $(secId).value.trim();
    if (!clientId || !clientSecret) return msg('클라이언트 ID 와 보안 비밀번호를 둘 다 넣어 주세요', 'err');
    const r = await call('/api/secret/save', { kind, clientId, clientSecret });
    if (r.ok === false) return msg(r.why || '열쇠를 저장하지 못했습니다', 'err');
    $(idId).value = ''; $(secId).value = ''; $(boxId).classList.add('hide');
    msg((kind === 'client' ? '구글 로그인용' : '코드 인증용') + ' 열쇠를 저장했습니다 — 채널을 다시 연결해 주세요', 'ok');
    loadSecret(); poll();
  }
  window.t3GoAdv = () => {
    swTab('t3');
    const d = $('t3Adv'); if (!d) return;
    d.open = true; loadSecret();
    setTimeout(() => d.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };
  /** 쓸 열쇠가 있나 — 이 채널 전용 열쇠가 있으면 공통 열쇠가 없어도 된다 */
  function ready(kind, name) {
    const r = ST && ST.welcome && ST.welcome.ready;
    if (!r || r[kind] !== false) return true;
    const c = name && chan(name);
    return !!(c && c.secretFile);
  }
  function notReady() {
    msg('이 프로그램에 들어 있는 구글 열쇠를 찾지 못했습니다. 「내 구글 열쇠 쓰기」에서 열쇠를 넣어 주세요', 'err');
    window.t3GoAdv();
  }

  /* ================= ① 브라우저 로그인 ================= */
  async function siStart(name) {
    if (si && si.state === 'waiting') { openModal('t3Si'); return; }                 // 이미 열려 있으면 그 창을 다시 보여 준다
    if (cd && cd.state === 'waiting') return msg('코드 인증이 진행 중입니다. 먼저 마치거나 취소해 주세요', 'err');
    if (!ready('browser', name)) return notReady();
    const body = {}; if (name) body.ch = name;
    const c = name && chan(name); if (c && c.secretFile) body.secret = c.secretFile;
    let r = await call('/api/signin/start', body);
    // 새로고침 등으로 서버에 옛 로그인이 아직 기다리고 있으면, 취소하고 새로 시작할지 묻는다
    if (r.ok === false && /이미 로그인 창/.test(String(r.why || ''))) {
      const go = await confirmBox({ emoji: '🔑', title: '이미 열려 있는 로그인이 있습니다', ok: '취소하고 새로 시작', cancel: '그대로 두기',
        body: '이전에 연 구글 로그인이 아직 기다리는 중입니다.<br>그것을 <b>취소하고 새로 시작</b>할까요?<br><span style="color:var(--t3)">방금 로그인을 마쳤다면 채널 카드에 이미 연결돼 있을 수 있습니다.</span>' });
      if (!go) return;
      await call('/api/signin/stop', {});
      r = await call('/api/signin/start', body);
    }
    if (r.ok === false) return msg(r.why || '로그인 창을 열지 못했습니다', 'err');
    siStop(); // 옛 타이머 정리
    si = { ch: name || '', url: r.url || '', t0: Date.now(), state: 'waiting', timer: null, busy: false, res: null, why: '' };
    siPaint(); openModal('t3Si');
    si.timer = setInterval(siTick, SI_POLL);
  }
  function siStop() { if (si && si.timer) { clearInterval(si.timer); si.timer = null; } }
  async function siTick() {
    const mine = si;
    if (!mine || mine.state !== 'waiting' || mine.busy) return;
    mine.busy = true;
    const r = await call('/api/signin/check', {});
    mine.busy = false;
    if (si !== mine || mine.state !== 'waiting') return;
    if (r.ok === false) { mine.state = 'fail'; mine.why = r.why || '연결되지 않았습니다'; siStop(); siPaint(); return; }
    if (r.state === 'done') {
      mine.state = 'done'; mine.res = r; siStop();
      if (r.key) open.add(r.key);
      chalkak();
      msg(`연결됐습니다 — ${r.title || r.key || ''}`, 'ok');
      siPaint(); poll();
      return;
    }
    siTime();
  }
  function siTime() {
    const e = $('t3SiTime'); if (!e || !si) return;
    const s = Math.floor((Date.now() - si.t0) / 1000);
    e.textContent = `기다린 지 ${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
  }
  function siPaint() {
    const m = si; if (!m) return;
    const who = m.ch ? `채널 「${esc(m.ch)}」 연결` : '새 채널 연결 (고른 유튜브 채널 이름으로 등록됩니다)';
    const btn = (cls, act, label) => `<button type="button" class="mbtn ${cls}" onclick="t3SiAct('${act}')">${label}</button>`;
    $('t3SiWho').innerHTML = who;
    if (m.state === 'waiting') {
      $('t3SiEmoji').textContent = '🔑';
      $('t3SiTitle').textContent = '구글 로그인을 기다리는 중';
      $('t3SiBody').innerHTML = `<p class="modal-desc">열린 브라우저 창에서 <b>로그인하고, 이번에 등록할 채널을 고르세요.</b><br>끝나면 이 창이 저절로 바뀝니다.</p>
        <div class="howto">
          <div><b>1</b> 이 채널을 가진 구글 계정으로 로그인합니다</div>
          <div><b>2</b> <b>계정·채널을 고르는 화면</b>에서 이번에 등록할 채널을 고릅니다</div>
          <div><b>3</b> 권한 세 칸(업로드·읽기·공개 전환)을 모두 체크하고 <b>허용</b>을 누릅니다</div>
        </div>
        <div class="hintline" id="t3SiTime" style="margin:-4px 0 10px"></div>
        <p class="modal-note">창이 안 보이나요? <b>주소 복사</b>를 눌러 브라우저 주소창에 붙여넣으세요.<br>
        ‘Google에서 확인하지 않은 앱’ 경고가 뜨면 <b>고급 → 이동</b>을 눌러 계속합니다.</p>`;
      $('t3SiBtns').innerHTML = btn('ghost', 'stop', '취소') + btn('ghost', 'copy', '📋 주소 복사') + btn('primary', 'open', '🔗 주소 다시 열기');
      siTime();
    } else if (m.state === 'done') {
      const r = m.res || {};
      $('t3SiEmoji').textContent = '✅';
      $('t3SiTitle').textContent = '연결됐습니다';
      $('t3SiBody').innerHTML = `<div class="modal-title" style="font-size:14px">${esc(r.title || '')}${r.key && r.key !== r.title ? ` <span style="color:var(--t3)">(이름: ${esc(r.key)})</span>` : ''}</div>
        <p class="modal-desc">채널 이름·배너·프로필 사진을 받아 두었습니다.${(r.replaced || []).length ? `<br>같은 채널이 있던 자리(${esc((r.replaced || []).join(', '))})를 갱신했습니다.` : ''}<br>채널 카드에서 영상 폴더를 확인하세요. 채널이 더 있으면 이어서 연결합니다.</p>`;
      $('t3SiBtns').innerHTML = btn('ghost', 'close', '닫기') + btn('primary', 'next', '➕ 다음 채널 이어서 연결');
    } else {
      $('t3SiEmoji').textContent = '❌';
      $('t3SiTitle').textContent = '연결하지 못했습니다';
      $('t3SiBody').innerHTML = `<p class="modal-desc" style="color:var(--accent)">${esc(m.why)}</p>`;
      $('t3SiBtns').innerHTML = btn('ghost', 'close', '닫기') + btn('primary', 'retry', '다시 시도');
    }
  }
  window.t3SiAct = act => {
    const m = si; if (!m) return;
    if (act === 'copy') return cpy(m.url, '주소를 복사했습니다 — 브라우저 주소창에 붙여넣으세요');
    if (act === 'open') return ext(m.url);
    if (act === 'stop' || act === 'close') return siClose();
    if (act === 'next') { siClose(false); return siStart(''); }
    if (act === 'retry') { const ch = m.ch; siClose(false); return siStart(ch); }
  };
  /** 창을 닫는다. 아직 기다리는 중이면 서버에 취소를 알린다 */
  function siClose(notify = true) {
    const m = si; si = null;
    if (m) { if (m.timer) clearInterval(m.timer); if (notify && m.state === 'waiting') call('/api/signin/stop', {}); }
    closeModal('t3Si');
  }

  /* ================= ② 코드 인증 ================= */
  async function cdStart(name) {
    if (cd && cd.state === 'waiting') { openModal('cd'); return; }
    if (si && si.state === 'waiting') return msg('구글 로그인이 진행 중입니다. 먼저 마치거나 취소해 주세요', 'err');
    if (!ready('device', name)) return notReady();
    const body = {}; if (name) body.ch = name;
    $('cdwho').innerHTML = name ? `채널 「${esc(name)}」 연결` : '새 채널 연결 (승인된 유튜브 채널 이름으로 등록됩니다)';
    const r = await call('/api/code/start', body);
    if (r.ok === false) return msg(r.why || '코드를 받지 못했습니다', 'err');
    cdKill();
    cd = { ch: name || '', url: r.url || '', code: String(r.code || ''), deadline: Date.now() + (Number(r.secs) || 1800) * 1000, state: 'waiting', timer: null, tick: null, busy: false, res: null, why: '' };
    cdPaint(); openModal('cd');
    cd.timer = setInterval(cdCheck, CD_POLL);
    cd.tick = setInterval(cdLeft, 1000);
  }
  function cdKill() { if (cd) { if (cd.timer) clearInterval(cd.timer); if (cd.tick) clearInterval(cd.tick); cd.timer = cd.tick = null; } }
  function cdLeft() {
    const e = $('cdleft'); if (!e || !cd || cd.state !== 'waiting') return;
    const s = Math.max(0, Math.round((cd.deadline - Date.now()) / 1000));
    e.textContent = s > 0 ? `승인을 기다리는 중… 남은 시간 ${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초` : '코드가 만료됐습니다';
    if (s <= 0 && cd.state === 'waiting') { cd.state = 'fail'; cd.why = '코드가 만료됐습니다. 새 코드를 받아 주세요.'; cdKill(); cdPaint(); call('/api/code/stop', cd.ch ? { ch: cd.ch } : {}); }
  }
  async function cdCheck() {
    const mine = cd;
    if (!mine || mine.state !== 'waiting' || mine.busy) return;
    mine.busy = true;
    const r = await call('/api/code/check', mine.ch ? { ch: mine.ch } : {});
    mine.busy = false;
    if (cd !== mine || mine.state !== 'waiting') return;
    if (r.ok === false) { mine.state = 'fail'; mine.why = r.why || '승인되지 않았습니다'; cdKill(); cdPaint(); return; }
    if (r.state === 'done') {
      mine.state = 'done'; mine.res = r; cdKill();
      if (r.key) open.add(r.key);
      chalkak();
      msg(`연결됐습니다 — ${r.title || r.key || ''}`, 'ok');
      cdPaint(); poll();
      return;
    }
    if (typeof r.left === 'number') mine.deadline = Date.now() + r.left * 1000;     // 서버가 센 남은 시간으로 맞춘다
    cdLeft();
  }
  function cdPaint() {
    const m = cd; if (!m) return;
    const btn = (id, cls, act, label) => `<button type="button" class="mbtn ${cls}"${id ? ` id="${id}"` : ''} onclick="t3Act(this,'${act}')">${label}</button>`;
    if (m.state === 'waiting') {
      $('cdEmoji').textContent = '📟'; $('cdTitle').textContent = '코드 인증';
      $('cdBody').innerHTML = `<p class="modal-desc" id="cdsay">승인할 분이 <b>자기 기기에서</b> 아래 주소를 열고 코드를 넣으면 됩니다.</p>
        <a class="t3-cdurl" id="cdurl" href="${attr(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a>
        <div class="t3-cdcode" id="cdcode" aria-live="polite">${esc(m.code)}</div>
        <div class="t3-left" id="cdleft"></div>
        <p class="modal-note">비밀번호가 오가지 않으며, 승인하는 분이 이 컴퓨터 앞에 없어도 됩니다.
        로그인 후 <b>채널을 고르고</b> 권한 세 칸(업로드·읽기·공개 전환)을 모두 허용해 달라고 알려 주세요.</p>`;
      $('cdBtns').innerHTML = btn('cdstop', 'ghost', 'cd-stop', '취소') + btn('cdcopy', 'ghost', 'cd-copy', '📋 코드 복사') + btn('cdcopyurl', 'primary', 'cd-copyurl', '📋 주소 복사');
      cdLeft();
    } else if (m.state === 'done') {
      const r = m.res || {};
      $('cdEmoji').textContent = '✅'; $('cdTitle').textContent = '연결됐습니다';
      $('cdBody').innerHTML = `<div class="modal-title" style="font-size:14px">${esc(r.title || '')}${r.key && r.key !== r.title ? ` <span style="color:var(--t3)">(이름: ${esc(r.key)})</span>` : ''}</div>
        <p class="modal-desc">채널 이름·배너·프로필 사진을 받아 두었습니다.<br>채널 카드에서 영상 폴더를 확인하세요. 채널이 더 있으면 이어서 연결합니다.</p>`;
      $('cdBtns').innerHTML = btn('cdstop', 'ghost', 'cd-stop', '닫기') + btn('', 'primary', 'cd-next', '➕ 다음 채널 이어서 연결');
    } else {
      $('cdEmoji').textContent = '❌'; $('cdTitle').textContent = '연결하지 못했습니다';
      $('cdBody').innerHTML = `<p class="modal-desc" style="color:var(--accent)">${esc(m.why)}</p>`;
      $('cdBtns').innerHTML = btn('cdstop', 'ghost', 'cd-stop', '닫기') + btn('', 'primary', 'cd-retry', '새 코드 받기');
    }
  }
  A['cd-next'] = () => { cdClose(false); return cdStart(''); };
  A['cd-retry'] = () => { const ch = cd ? cd.ch : ''; cdClose(false); return cdStart(ch); };
  /** 창을 닫는다. 아직 기다리는 중이면 서버에 취소를 알린다 */
  function cdClose(notify = true) {
    const m = cd; cd = null;
    if (m) { if (m.timer) clearInterval(m.timer); if (m.tick) clearInterval(m.tick); if (notify && m.state === 'waiting') call('/api/code/stop', m.ch ? { ch: m.ch } : {}); }
    closeModal('cd');
  }

  /* ================= 탭 등록 ================= */
  function paintLink(s) {
    const need = (s.channels || []).filter(c => c.needsReconnect), rc = $('t3Recon');
    rc.classList.toggle('hide', !need.length);
    const rsig = JSON.stringify(need.map(c => c.name));
    if (rc.dataset.sig !== rsig) {                  // 같으면 다시 그리지 않는다
      rc.dataset.sig = rsig;
      rc.innerHTML = need.length
        ? `🔑 <b>로그인이 풀려 다시 연결이 필요한 채널 ${need.length}개</b> — 다시 연결하면 기다리던 영상이 그대로 올라갑니다.<div class="t3-acts" style="margin-bottom:0">${need.map(c => `<button type="button" class="tb on" data-ch="${attr(c.name)}" onclick="t3Act(this,'recon')">🔑 ${esc(c.name)} 다시 연결</button>`).join('')}</div>`
        : '';
    }
    const r = s.welcome && s.welcome.ready, note = $('t3LinkNote');
    const bad = [];
    if (r && r.browser === false) bad.push('구글 로그인(🔑)');
    if (r && r.device === false) bad.push('코드 인증(📟)');
    note.classList.toggle('hide', !bad.length);
    note.innerHTML = bad.length ? `⚠️ ${bad.join('과 ')}에 쓸 구글 열쇠를 이 프로그램에서 찾지 못했습니다. 아래 <b>「내 구글 열쇠 쓰기」</b>에서 열쇠를 넣어 주세요. <button type="button" class="tb" onclick="t3GoAdv()">🔑 열쇠 넣는 곳으로</button>` : '';
  }
  registerTab('t3', {
    init(s) {
      initDnd();
      const box = $('t3List');
      box.addEventListener('input', e => { const s2 = e.target.closest && e.target.closest('[data-inputs]'); if (s2) s2.dataset.dirty = '1'; });
      box.addEventListener('change', e => { const s2 = e.target.closest && e.target.closest('[data-inputs]'); if (s2) s2.dataset.dirty = '1'; });
      registerModal('t3Si', () => siClose());
      registerModal('cd', () => cdClose());
    },
    show() { loadSecret(); },
    paint(s) {
      paintLink(s);
      if (drag) return;
      const list = s.channels || [];
      if (firstPaint) { firstPaint = false; if (list.length === 1) open.add(list[0].name); }
      reconcile(list);
    },
  });
})();

'use strict';
/* t2.js — 기록 탭 (올린 영상 · 유튜브와 맞추기 · 심사 확인 · 로그)
 *
 * 약속
 *  · 서버는 탭을 열 때와 사람이 누를 때만 부른다. paint()(1.5초마다)는 이미 받은 상태(ST)로 작은 안내만 고치고 서버를 부르지 않는다.
 *  · 목록은 30개씩 「더 보기」. 요약(날짜별·채널별)은 목록을 넘겨도 그대로다.
 *  · 로그 상자만 이 탭이 보이는 동안 6초마다 다시 읽는다(숨겨진 브라우저 탭·물러난 창은 쉰다).
 *  · 위험한 일(공개·비공개로 내리기)은 confirmBox() 로 한 번 더 묻는다.
 * 다른 파일과 이름이 겹치지 않게 전부 (() => {…})() 안에 넣고, onclick 에서 부르는 것만 window 로 내보낸다.
 */
(() => {
  const PAGE = 30;
  const R = {
    items: [], total: 0, byDay: {}, byChannel: {},
    ch: '', day: '',
    loaded: false, loading: false, more: false, error: '', end: false, at: 0, seq: 0,
  };
  let logBusy = false, lastLog = '', lastLogAt = 0, acting = false;
  const OPEN = new Set();   // 쿠팡 상품 목록을 펼쳐 둔 영상 — 목록을 다시 그려도 펼친 채로 둔다

  /** 대행/소유주에 따라 바뀌는 말(고객사↔채널). 서버가 안 주면 기본 말 */
  const W = k => (ST && ST.words && ST.words[k]) || k;
  const has = x => x !== null && x !== undefined;
  // 같은 글이면 다시 쓰지 않는다 — 1.5초마다 불리는 paint() 가 칩·목록을 깜빡이게 하거나 누르던 단추를 바꿔 치지 않게.
  // (브라우저가 되돌려 주는 innerHTML 은 우리가 쓴 글과 늘 조금 달라서, 비교는 마지막에 쓴 글로 한다)
  const memo = {};
  const setText = (id, t) => { const e = $(id); if (e && e.textContent !== t) e.textContent = t; };
  const setHtml = (id, h) => { const e = $(id); if (e && memo[id] !== h) { e.innerHTML = h; memo[id] = h; } };

  /** "MM/DD HH:MM". 서버가 UTC(Z)로 주면 이 컴퓨터 시각으로 바꿔 보여 준다 */
  function when(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (/T/.test(s) && /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
      const d = new Date(s);
      if (!isNaN(d)) return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    return mdHm(s) || s.slice(0, 16);
  }
  const mmdd = d => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5).replace('-', '/') : String(d));

  /** 공개 상태 → 알약 모양과 글. 공개/예약/비공개(검토대기)/비공개로 내림 */
  function visInfo(v) {
    v = String(v || '');
    if (v === 'public') return { cls: 'public', txt: '공개', pub: true, tip: '누구나 볼 수 있게 공개된 영상입니다' };
    if (v === 'unlisted') return { cls: 'unlisted', txt: '일부 공개', pub: true, tip: '주소를 아는 사람만 볼 수 있습니다' };
    if (v === '예약') return { cls: 't2-sched', txt: '예약', tip: '비공개로 올라가 있다가 정한 시각에 유튜브가 엽니다' };
    if (/검토대기|심사/.test(v)) return { cls: 'private', txt: '비공개 (검토대기)', wait: true, tip: '유튜브 심사가 끝나고 이상이 없으면 공개됩니다' };
    if (v === 'private' || v === '비공개') return { cls: 'private', txt: '비공개로 내림', tip: '비공개 상태입니다 — 자동으로 다시 공개되지 않습니다' };
    return { cls: 'private', txt: v || '상태 확인 전', tip: '' };
  }

  function timeChips(it, vi) {
    const out = [`<span class="t2-t"><i>올림</i><b>${esc(when(it.at) || '—')}</b></span>`];
    if (it.visibility === '예약') {
      out.push(`<span class="t2-t soon"><i>예약</i><b>${esc(when(it.publishAt) || '시각 기록 없음')}</b><em>그때 유튜브가 엽니다</em></span>`);
    } else if (vi.pub) {
      // 공개 시각은 공개된 것에만 붙인다. 아직 안 열린 영상에 시각을 보이면 이미 공개된 것으로 읽힌다.
      out.push(it.publishedAt
        ? `<span class="t2-t on"><i>공개</i><b>${esc(when(it.publishedAt))}</b></span>`
        : '<span class="t2-t"><i>공개</i><b>시각 기록 없음</b><em>유튜브와 맞추면 가져옵니다</em></span>');
    } else if (vi.wait && it.publishAt) {
      out.push(`<span class="t2-t soon"><i>예정</i><b>${esc(when(it.publishAt))}</b></span>`);
    }
    return `<div class="t2-tm">${out.join('')}</div>`;
  }

  /** 지표를 아직 안 읽은 영상은 0 을 띄우지 않는다 — 0 은 「조회가 없다」로 읽힌다 */
  function metrics(it) {
    if (!has(it.views) && !has(it.likes) && !has(it.comments)) {
      return '<div class="t2-met none">지표 없음<em>📊 성적 탭에서 다시 재면 채워집니다</em></div>';
    }
    const m = (lab, v, cls) => `<span class="t2-m ${cls || ''}"><i>${lab}</i><b>${has(v) ? num(v) : '—'}</b></span>`;
    return `<div class="t2-met">${m('조회', it.views, 'v')}${m('좋아요', it.likes)}${m('댓글', it.comments)}</div>`;
  }

  /** 제목·설명·해시태그가 어디서 왔나 — 사람이 고친 것 > 쪽지 > AI 자동 > 파일 이름 */
  const META = {
    '사람': { txt: '사람 문안', tip: '사람이 화면에서 고친 제목·설명·해시태그입니다' },
    '쪽지': { txt: '쪽지 문안', tip: '영상과 함께 온 쪽지에 적힌 제목·설명·해시태그입니다' },
    '자동': { txt: '✨ 자동 문안', tip: 'AI 가 영상 내용과 이 채널의 말투를 보고 자동으로 지은 제목·설명·해시태그입니다' },
    '파일이름': { txt: '파일 이름 문안', tip: '문안이 없어서 파일 이름을 제목으로 썼습니다', cls: 'warn' },
  };
  function metaPill(it) {
    let s = it.metaSource, extra = '';
    if (s && typeof s === 'object') {   // 칸마다 따로 올 수도 있다 — 하나라도 자동이면 자동으로 보이고, 자세한 건 풍선에
      extra = ` (제목 ${s.title || '-'} · 설명 ${s.desc || '-'} · 해시태그 ${s.tags || '-'})`;
      s = Object.values(s).includes('자동') ? '자동' : (s.title || '');
    }
    const m = META[s];
    return m ? `<span class="pill t2-src ${m.cls || ''}" title="${attr(m.tip + extra)}">${m.txt}</span>` : '';
  }

  /** 쿠팡 파트너스 링크 — 개수 칩(누르면 상품 목록) · 건너뛰었으면 까닭을 작은 노란 글씨로 */
  function linkRow(it) {
    const links = Array.isArray(it.links) ? it.links : [], id = String(it.id || '');
    const parts = [];
    if (links.length) {
      parts.push(`<button class="tb t2-lkchip ${OPEN.has(id) ? 'on' : ''}" data-v="${attr(id)}" onclick="t2Links(this)" title="이 영상 설명 끝에 들어간 쿠팡 파트너스 상품 링크를 펼칩니다">🛒 ${links.length}</button>`);
    } else if (it.linkStatus === '사람이넣음') {
      parts.push('<span class="t2-lkn" title="쪽지나 설명에 사람이 직접 넣은 쿠팡 링크가 있어 자동으로 찾지 않았습니다">🛒 사람이 넣은 링크</span>');
    }
    if (it.linkStatus === '건너뜀') {
      parts.push(`<span class="t2-lkw" title="쿠팡 링크 없이 올렸습니다 — 업로드를 막지는 않습니다">🛒 링크 건너뜀${it.linkWhy ? ' — ' + esc(it.linkWhy) : ''}</span>`);
    }
    return `<div class="t2-lkrow">${parts.join('')}</div>`;
  }
  function linkBlock(it) {
    const links = Array.isArray(it.links) ? it.links : [], id = String(it.id || '');
    if (!links.length) return '';
    const human = it.linkStatus === '사람이넣음';
    const rows = links.map((l, i) => {
      const url = String((l && l.url) || '');
      const ok = /^https?:\/\//i.test(url);   // 주소 모양이 아니면 눌러지는 링크로 만들지 않는다
      return `<div class="t2-lk"><span class="n">${i + 1}</span><span class="t" title="${attr(l && l.name)}">${esc((l && l.name) || '상품')}</span>`
        + (ok ? `<a href="${attr(url)}" target="_blank" rel="noopener" onclick="ext(this.href);return false" title="${attr(url)}">링크 열기 ↗</a>` : '<span class="t2-lkn">주소 없음</span>') + '</div>';
    }).join('');
    return `<div class="t2-lks ${OPEN.has(id) ? '' : 'hide'}" data-v="${attr(id)}"><div class="t2-lks-h">🛒 쿠팡 파트너스 상품 ${links.length}개<span>${human ? '사람이 넣은 링크입니다' : '설명 끝에 상품명과 링크가 붙어 올라갔습니다'}</span></div>${rows}</div>`;
  }

  function rowHtml(it) {
    const id = String(it.id || '');
    const vi = visInfo(it.visibility);
    // 서버가 준 주소라도 http(s) 가 아니면(javascript: 같은 것) 쓰지 않고 영상 ID 로 만든 기본 주소를 쓴다
    const safe = (u, d) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : d);
    const watch = safe(it.url, 'https://youtu.be/' + encodeURIComponent(id));
    const studio = safe(it.studioUrl, 'https://studio.youtube.com/video/' + encodeURIComponent(id) + '/edit');
    // 음악은 스튜디오 「편집기」 에서 넣는다 — 세부정보(/edit) 주소를 편집기(/editor)로 바꾼다
    const editor = studio.replace(/\/edit(?=$|[?#])/, '/editor');
    const music = editor !== studio ? editor : ('https://studio.youtube.com/video/' + encodeURIComponent(id) + '/editor');
    const canHide = vi.pub;   // 공개된 것만 내릴 수 있다. 이미 비공개면 단추를 만들지 않는다
    const lens = [it.sec != null ? fmtSec(it.sec) : '', it.size || ''].filter(Boolean).join(' · ');
    return `<div class="hrow t2-row" data-v="${attr(id)}">
      <a class="hrow-th" href="${attr(watch)}" target="_blank" rel="noopener" title="유튜브에서 봅니다"><img loading="lazy" src="https://i.ytimg.com/vi/${attr(encodeURIComponent(id))}/mqdefault.jpg" alt="" onerror="this.style.opacity=.15"/></a>
      <div class="hrow-i">
        <div class="hrow-t"><a href="${attr(watch)}" target="_blank" rel="noopener" title="${attr(it.t)}">${esc(it.t)}</a></div>
        <div class="hrow-m">📺 ${esc(it.ch)} ${kindPill(it.kind)}${lens ? ' · ' + esc(lens) : ''} ${metaPill(it)}</div>
        ${timeChips(it, vi)}
        ${metrics(it)}
        ${linkRow(it)}${linkBlock(it)}
        <div class="t2-acts">
          <a class="tb" href="${attr(watch)}" target="_blank" rel="noopener">▶ 유튜브에서 보기</a>
          <a class="tb" href="${attr(studio)}" target="_blank" rel="noopener" title="동영상 세부정보 — 제목·설명·썸네일을 바꾸는 곳">스튜디오</a>
          <a class="tb on" href="${attr(music)}" target="_blank" rel="noopener" title="편집기가 열리면 오디오 옆 ＋ 를 누르세요 (쇼츠는 편집기가 열리지 않을 수 있습니다)">🎵 음악·스튜디오</a>
          ${canHide ? `<button class="tb t2-hide" data-v="${attr(id)}" data-t="${attr(it.t)}" onclick="t2Hide(this)" title="유튜브에서 비공개로 돌립니다 — 지우는 것이 아니라 감추는 것이고, 사람이 내린 영상은 다시 자동으로 공개되지 않습니다">🔒 비공개로 내리기</button>` : ''}
        </div>
      </div>
      <span class="pv ${vi.cls}" title="${attr(vi.tip)}">${esc(vi.txt)}</span>
    </div>`;
  }

  /* ───────────── 그리기 ───────────── */
  function paintChips() {
    const names = ((ST && ST.channels) || []).map(c => c.name);
    let h = '';
    if (names.length > 1) {
      h += `<button class="${R.ch ? '' : 'on'}" data-ch="" onclick="t2Ch(this)">전체</button>`;
      h += names.map(n => `<button class="${R.ch === n ? 'on' : ''}" data-ch="${attr(n)}" onclick="t2Ch(this)">${esc(n)}</button>`).join('');
    }
    if (R.day) h += `<button class="on" data-d="${attr(R.day)}" onclick="t2Day(this.dataset.d)" title="날짜 거르기를 풉니다">📅 ${esc(mmdd(R.day))} ✕</button>`;
    setHtml('t2Filter', h);
  }

  function paintList() {
    const filt = !!(R.ch || R.day);
    const parts = [];
    if (R.ch) parts.push(R.ch);
    if (R.day) parts.push(mmdd(R.day));
    setText('t2Head', (parts.length ? parts.join(' · ') + ' — ' : '') + (R.loaded ? `${num(R.total)}개` : '불러오는 중'));
    setText('t2HeadR', '최신순 · 30개씩 · 누르면 유튜브로 갑니다');
    let h = '';
    if (R.error && !R.items.length) {
      h = `<div class="empty small"><div class="empty-i">⚠️</div><div class="empty-t">${esc(R.error)}</div><div class="empty-d"><button class="tb" onclick="t2Retry()">다시 불러오기</button></div></div>`;
    } else if (!R.loaded || (R.loading && !R.items.length)) {
      h = '<div class="empty small"><div class="empty-i">⏳</div><div class="empty-t">불러오는 중…</div></div>';
    } else if (!R.items.length) {
      h = filt
        ? '<div class="empty small"><div class="empty-i">🗂</div><div class="empty-t">조건에 맞는 영상이 없습니다</div><div class="empty-d">위의 거르기를 바꾸거나 풀어 보세요.</div></div>'
        : '<div class="empty"><div class="empty-i">🗂</div><div class="empty-t">아직 올린 영상이 없습니다</div><div class="empty-d">채널 폴더에 영상을 넣어보세요.</div></div>';
    } else {
      h = R.items.map(rowHtml).join('');
    }
    setHtml('t2List', h);
    // 더 보기
    let m = '';
    if (R.items.length && R.total > R.items.length && !R.end) {
      m = `<button class="go2" ${R.more ? 'disabled' : ''} onclick="t2More()">${R.more ? '불러오는 중…' : `더 보기 (${num(R.items.length)} / ${num(R.total)})`}</button>`;
    } else if (R.items.length > PAGE || (R.end && R.total > R.items.length)) {
      m = `<div class="t2-none" style="text-align:center">끝까지 봤습니다 — ${num(R.items.length)}개</div>`;
    }
    setHtml('t2More', m);
  }

  /** 서버가 주는 byDay 를 [{d, n, open, ch}] 로 — 칸 이름이 조금 달라도 읽는다 */
  function dayRows(by) {
    const out = [];
    for (const k of Object.keys(by || {})) {
      const v = by[k];
      const o = v && typeof v === 'object' ? v : { n: Number(v) || 0 };
      out.push({
        d: k,
        n: Number(o.n ?? o['수'] ?? o.count ?? o.total ?? 0) || 0,
        open: Number(o.open ?? o['공개'] ?? o.public ?? 0) || 0,
        ch: o.ch ?? o['채널'] ?? {},
      });
    }
    out.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
    return out;
  }

  function paintSide() {
    const rows = dayRows(R.byDay);
    const max = rows.reduce((a, r) => Math.max(a, r.n), 1);
    const total = rows.reduce((a, r) => a + r.n, 0);
    setHtml('t2Days', rows.length ? rows.map(r => {
      const tip = Object.entries(r.ch || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} ${n}`).join(' · ');
      return `<div class="t2-dr ${R.day === r.d ? 'on' : ''}" data-d="${attr(r.d)}" onclick="t2Day(this.dataset.d)" title="${attr((tip ? tip + ' — ' : '') + '누르면 이 날짜만 봅니다')}">
        <span class="d">${esc(mmdd(r.d))}</span><span class="bar"><i style="width:${Math.max(3, Math.round(r.n / max * 100))}%"></i></span><span class="n">${num(r.n)}</span><span class="o">${num(r.open)}</span></div>`;
    }).join('') : '<div class="t2-none">아직 기록이 없습니다</div>');
    setText('t2DaysFoot', rows.length ? `모두 ${num(total)}편 · ${rows.length}일` : '');

    setText('t2WkH', `📺 ${W('채널')}별 최근 7일`);
    const by = R.byChannel || {};
    const names = Object.keys(by);
    let wk = '';
    if (!names.length) {
      wk = '<div class="t2-none">최근에 올린 것이 없습니다</div>';
    } else if (names.every(n => by[n] && typeof by[n] === 'object')) {
      const days = [...new Set(names.flatMap(n => Object.keys(by[n])))].sort().slice(-7);
      wk = `<div class="t2-wk-h"><span>${esc(W('채널'))}</span>${days.map(d => `<span>${esc(String(d).slice(-2))}</span>`).join('')}</div>`
        + names.map(n => `<div class="t2-wk-r" title="${attr(n)}"><span class="c">${esc(n)}</span>${days.map(d => { const v = Number(by[n][d]) || 0; return `<span class="x ${v ? '' : 'zero'}">${v || '·'}</span>`; }).join('')}</div>`).join('')
        + (days.length ? `<div class="t2-foot">${esc(mmdd(days[0]))} ~ ${esc(mmdd(days[days.length - 1]))} · ${num(names.reduce((a, n) => a + days.reduce((b, d) => b + (Number(by[n][d]) || 0), 0), 0))}편</div>` : '');
    } else {
      // 날짜 없이 채널별 합계만 온 경우
      wk = names.map(n => `<div class="t2-wk-r"><span class="c" style="grid-column:1/6">${esc(n)}</span><span class="x" style="grid-column:6/9">${num(by[n])}편</span></div>`).join('');
    }
    setHtml('t2Wk', wk);
  }

  function paintAll() { paintChips(); paintList(); paintSide(); }

  /* ───────────── 읽기 ───────────── */
  async function load(more) {
    if (more && (R.more || R.loading)) return;
    const mine = ++R.seq;
    if (more) R.more = true; else { R.loading = true; R.more = false; }
    R.error = '';
    paintList();
    let r;
    try {
      const off = more ? R.items.length : 0;
      // 처음·다시 읽을 때는 지금 보이는 만큼을 한꺼번에 — 「더 보기」 로 펼친 목록이 접히지 않는다
      const limit = more ? PAGE : Math.min(Math.max(PAGE, R.items.length), 300);
      r = await api(`/api/records?offset=${off}&limit=${limit}&ch=${encodeURIComponent(R.ch)}&day=${encodeURIComponent(R.day)}`);
    } catch (e) {
      if (mine !== R.seq) return;   // 서버가 끊기면 core 가 점으로 알린다 — 여기서는 목록 자리에만 조용히 적는다
      R.loading = false; R.more = false; R.error = '앱에 연결되지 않아 기록을 불러오지 못했습니다';
      paintList();
      return;
    }
    if (mine !== R.seq) return;
    R.loading = false; R.more = false;
    if (!r || r.ok === false) {
      R.error = (r && r.why) || '기록을 불러오지 못했습니다';
      msg(R.error, 'err');
      paintList();
      return;
    }
    const got = Array.isArray(r.items) ? r.items : [];
    if (more) {
      const have = new Set(R.items.map(x => x.id));
      const add = got.filter(x => !have.has(x.id));
      R.items = R.items.concat(add);
      R.end = add.length === 0;   // 더 가져왔는데 새것이 없으면 끝이다
    } else {
      R.items = got; R.end = false;
    }
    R.total = Number.isFinite(Number(r.total)) ? Number(r.total) : R.items.length;
    if (r.byDay) R.byDay = r.byDay;
    if (r.byChannel) R.byChannel = r.byChannel;
    R.loaded = true; R.at = Date.now();
    if (Array.isArray(r.log) && !lastLog) setLog(r.log);
    paintAll();
  }

  /* ───────────── 로그 ───────────── */
  function setLog(lines) {
    const box = $('logBox');
    if (!box) return;
    const txt = (lines || []).join('\n') || '(로그 없음)';
    if (txt === lastLog) return;
    if (busySelecting()) return;   // 글자를 고르는 중이면 건드리지 않는다(다음 번에 다시 시도)
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = txt;
    lastLog = txt;
    if (atBottom) box.scrollTop = box.scrollHeight;   // 위로 올려 읽는 중이면 그 자리를 지킨다
  }
  async function logTick(force) {
    if (logBusy || Date.now() - lastLogAt < 2000) return;   // 탭을 열자마자 타이머가 겹쳐 두 번 읽지 않게
    if (!force && (tab !== 't2' || !visibleNow() || isWithdrawn())) return;
    logBusy = true; lastLogAt = Date.now();
    try { const r = await api('/api/log?n=80'); if (r) setLog(r.lines); }
    catch (_) { /* 서버가 끊긴 것은 core 가 알린다 */ }
    finally { logBusy = false; }
  }
  setInterval(() => logTick(false), 6000);

  /* ───────────── 눌렀을 때 ───────────── */
  /** 세 단추 중 하나가 도는 동안 나머지도 잠근다(같은 일을 두 번 시키지 않게) */
  async function action(btnId, busyText, fn) {
    if (acting) return;
    acting = true;
    const ids = ['t2BtnSync', 't2BtnCheck', 't2BtnPub'];
    const old = $(btnId).textContent;
    ids.forEach(i => { $(i).disabled = true; });
    $(btnId).textContent = busyText;
    try { await fn(); }
    catch (_) { /* 서버가 끊기면 core 가 알린다 */ }
    finally {
      $(btnId).textContent = old;
      ids.forEach(i => { $(i).disabled = false; });
      acting = false;
    }
  }

  function showRes(title, lines, chips) {
    const el = $('t2Res');
    const body = (lines || []).map(x => String(x)).join('\n') || '(보고할 내용이 없습니다)';
    el.className = 't2-res';
    el.innerHTML = `<div class="t2-res-h"><span>${esc(title)}</span>${(chips || []).join('')}<span class="sp"></span><button class="tb" onclick="t2ResClose()">닫기</button></div><pre class="logmini">${esc(body)}</pre>`;
  }

  window.t2ResClose = () => { $('t2Res').className = 'hide'; };
  /** 쿠팡 개수 칩 — 상품 목록을 펼치고 접는다(그 줄만 고친다 — 목록 전체를 다시 그리지 않는다) */
  window.t2Links = b => {
    const id = b.dataset.v;
    const on = !OPEN.has(id);
    if (on) OPEN.add(id); else OPEN.delete(id);
    b.classList.toggle('on', on);
    const box = [...document.querySelectorAll('#t2List .t2-lks')].find(x => x.dataset.v === id);
    if (box) box.classList.toggle('hide', !on);
    memo.t2List = null;   // 손으로 고쳤으니 마지막에 쓴 글과는 달라졌다 — 다음 그리기는 다시 쓴다
  };
  window.t2Retry = () => load(false);
  window.t2More = () => load(true);
  window.t2Ch = el => {
    const v = el.dataset.ch || '';
    if (v === R.ch) return;
    R.ch = v; R.items = []; R.end = false;
    paintChips();
    load(false);
  };
  window.t2Day = d => {
    R.day = (R.day === d) ? '' : String(d || '');
    R.items = []; R.end = false;
    paintChips(); paintSide();
    load(false);
  };

  window.t2Sync = () => action('t2BtnSync', '맞추는 중…', async () => {
    const r = await api('/api/sync/run', {});
    if (r.ok === false) return msg(r.why || '유튜브와 맞추지 못했습니다', 'err');
    showRes('🔄 유튜브와 맞춘 결과', r.lines, []);
    msg('유튜브와 맞췄습니다', 'ok');
    await load(false);
    poll();
  });

  window.t2Review = async publish => {
    if (acting) return;
    if (publish) {
      if (ST && ST.locked) return msg('올리기가 잠겨 있어 공개할 수 없습니다. 위쪽 🔒 잠금을 먼저 풀어 주세요', 'err');
      const n = ST && ST.review ? ST.review.length : 0;
      const ok = await confirmBox({
        emoji: '🚀', title: '심사 확인하고 공개할까요?',
        body: `심사를 확인해서 <b>이상 없는 영상이 실제로 공개됩니다.</b><br>공개된 영상은 시청자에게 바로 보입니다. 이상이 있는 영상은 공개하지 않고 남겨 둡니다.${n ? `<br>지금 심사 대기 <b>${n}건</b>` : ''}`,
        ok: '확인하고 공개', danger: true,
      });
      if (!ok) return;
    }
    await action(publish ? 't2BtnPub' : 't2BtnCheck', publish ? '공개하는 중…' : '확인하는 중…', async () => {
      const r = await api('/api/review/run', { publish });
      if (r.ok === false) return msg(r.why || '심사를 확인하지 못했습니다', 'err');
      const chips = [
        `<span class="t2-cnt ok">공개됨 ${num(r.opened)}</span>`,
        `<span class="t2-cnt">계속 대기 ${num(r.kept)}</span>`,
        `<span class="t2-cnt ${r.blocked ? 't2-w' : ''}">사람이 봐야 함 ${num(r.blocked)}</span>`,
      ];
      showRes(publish ? '🚀 심사 확인하고 공개한 결과' : '🩺 심사 확인 결과', r.lines, chips);
      msg(publish ? (r.opened ? `${num(r.opened)}건 공개했습니다` : '공개할 영상이 없었습니다') : '심사를 확인했습니다', 'ok');
      await load(false);
      poll();
    });
  };

  window.t2Hide = async b => {
    const v = b.dataset.v, name = b.dataset.t || '';
    const ok = await confirmBox({
      emoji: '🔒', title: '비공개로 내릴까요?',
      body: `<b>${esc(name)}</b><br>유튜브에서 이 영상을 <b>비공개</b>로 돌립니다. 지우는 것이 아니라 감추는 것이고, 언제든 스튜디오에서 다시 공개할 수 있습니다.<br><span class="t2-warnline">사람이 내린 영상은 다시 자동으로 공개되지 않습니다.</span>`,
      ok: '비공개로 내리기', danger: true,
    });
    if (!ok) return;
    b.disabled = true;
    const old = b.textContent;
    b.textContent = '내리는 중…';
    try {
      const r = await api('/api/video/hide', { v });
      if (r.ok === false) return msg(r.why || '비공개로 내리지 못했습니다', 'err');
      const it = R.items.find(x => x.id === v);
      if (it) it.visibility = 'private';
      msg(`비공개로 내렸습니다${r.name ? ' — ' + r.name : ''}`, 'ok');
      paintList();
      poll();   // 머리의 숫자(오늘 공개 수 등)도 바로 맞춘다
    } catch (_) { /* 서버가 끊기면 core 가 알린다 */ }
    finally { if (b.isConnected) { b.disabled = false; b.textContent = old; } }
  };

  registerTab('t2', {
    init() { paintAll(); },
    // 탭을 열 때 한 번 읽는다(3초 안에 다시 열면 그대로 둔다)
    show() {
      if (!R.loaded || Date.now() - R.at > 3000) load(false);
      logTick(true);
    },
    // 1.5초마다: 서버를 부르지 않고 이미 받은 상태로 작은 안내만 고친다
    paint(s) {
      const n = (s.review || []).length;
      setText('t2ReviewN', n ? `심사 대기 ${n}건` : '심사 대기 없음');
      $('t2Lock').classList.toggle('hide', !s.locked);
      paintChips();
    },
  });
})();

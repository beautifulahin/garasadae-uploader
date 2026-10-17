/* t1.js — 「감시 중」 탭 (화면 일꾼 A 소유)
 *
 * 옛 앱은 바탕화면 폴더를 감시해 자동으로 올렸다. 2.0 은 그 자리에 현재 업로더(파이썬)의 「현황」 방식을 둔다.
 *   사람이 영상 벽에서 고른다 → 장바구니에 담는다 → [올리기] → 서버가 「표」를 준다 → 확인 창에서 승인하면 → 올린다.
 *
 * 지킬 것
 *  · 올리는 일은 사람이 그 순간 누른 것만. 끌어다 놓기·영상 넘기기는 폴더에 넣거나 발사 대기에 담을 뿐이다.
 *  · 영상 벽(/api/inventory)은 채널·쪽이 바뀔 때, 새로고침을 눌렀을 때, 올리기가 끝났을 때, 영상을 치웠을 때만 다시 부른다.
 *    그 밖의 1.5초 상태에서는 ST.queue 로 「발사 대기」 표시만 고친다 (놀 때 서버를 두드리지 않는다).
 *  · 장바구니는 sessionStorage 로 새로고침을 견딘다 (파이썬 함정 3.2: 새로고침이 50개 고른 것을 날려 버렸다).
 *  · 입력 중(typing())이면 영상 벽·장바구니를 다시 그리지 않는다. 값은 그대로 두고 다음 박자에 다시 본다.
 *  · 경로는 서버가 준 글자 그대로 되돌려 보낸다. 맥은 NFD/NFC 가 섞이므로 같은지 비교할 때만 NFC 로 맞춘다.
 *
 * 시각의 뜻 (파이썬 run.py --at / shoot/retime 과 같게)
 *  · 장바구니의 「올리기 시각」 = 이 컴퓨터가 유튜브로 올리는 시각(발사). 비우면 지금 바로. 올린 뒤에는 늘 비공개 → 심사 → 공개.
 */
'use strict';
(() => {
  /* ================= 값·도구 ================= */
  const PAGE = 50;                       // 영상 벽 한 쪽
  const FOLD = 6;                        // 레인은 6개까지만 펴서 보인다
  const VIDEO_EXT = /\.(mp4|mov|m4v|avi|webm|mkv|flv|wmv|mpe?g|mts|m2ts)$/i;
  const WALL_RE = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
  const nfc = p => String(p ?? '').normalize('NFC');
  const ck = nfc;                        // 같은 파일인지 비교하는 열쇠
  const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const sepOf = p => (String(p).includes('\\') && !String(p).includes('/')) ? '\\' : '/';
  const dirOf = p => { const s = String(p || ''), i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i >= 0 ? s.slice(0, i) : ''; };
  const stem = n => String(n || '').replace(/\.[^./\\]+$/, '');
  const isAbs = p => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(String(p || ''));
  const num0 = v => { const n = Number(v); return isFinite(n) ? n : 0; };

  /** "2026-10-18T09:00:00" / "2026-10-18 09:00" → 이 컴퓨터 시각 그대로의 밀리초(시간대 영향 없이 벽시계 비교용) */
  function wallMs(s) { const m = WALL_RE.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : NaN; }
  /** 시각 글자 → <input type=datetime-local> 값 */
  function toInput(s) { const m = WALL_RE.exec(String(s || '')); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : ''; }
  /** datetime-local 값 → API 가 받는 "2026-10-19 09:00" */
  function fromInput(v) { const m = WALL_RE.exec(String(v || '')); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ''; }
  function fmtWall(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  const DAYN = ['일', '월', '화', '수', '목', '금', '토'];
  function dayLabel(ymd) { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); if (!m) return String(ymd || ''); const d = new Date(+m[1], +m[2] - 1, +m[3]); return `${+m[2]}/${+m[3]} (${DAYN[d.getDay()]})`; }

  const store = {
    get(k, d) { try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* 사생활 보호 모드 등 — 못 적어도 화면은 돈다 */ } },
  };

  /** 서버 호출 — 끊기면 던지지 않고 {ok:false, net:true} 로 돌려준다(끊김 점은 core 가 켠다) */
  async function call(path, body) {
    try { return await api(path, body); }
    catch (_) { return { ok: false, why: '서버에 닿지 않았습니다', net: true }; }
  }
  const fail = (r, d) => msg((r && r.why) || d || '하지 못했습니다', 'err');

  /* ================= 상태 ================= */
  const T1 = {
    ready: false, s: null, skew: 0,
    ch: '', page: 0,
    inv: null, invKey: '', invBusy: false, invErr: '', invAt: 0, invCnt: null, force: false,
    qSig: '', qSigAtLoad: '',
    cart: new Map(), cartDirty: false,         // 키 = NFC 경로
    last: {},                                  // 영역별로 마지막에 그린 글(같으면 다시 안 그린다)
    infoSig: null,                             // AI·쿠팡 상태 지문 — 바뀌면 카드의 문안·링크 줄을 다시 그린다
    fold: {}, fresh: new Set(), lnkOpen: new Set(),   // lnkOpen: 쿠팡 링크 목록을 펼쳐 둔 영상(NFC 경로)
    dropBusy: false,
    big: null, tx: null, tk: null, up: null, recv: null, say: null, ask: null, cal: null, calSeq: 0,
    logSig: '', logAt: 0, logBusy: false,
  };
  const CART_KEY = 't1.cart', CH_KEY = 't1.ch', SP_KEY = 't1.sp';
  const nowWall = () => new Date(Date.now() + T1.skew);

  function put(el, key, html) { if (!el || T1.last[key] === html) return false; T1.last[key] = html; el.innerHTML = html; return true; }
  function putText(el, key, txt) { if (!el || T1.last[key] === txt) return; T1.last[key] = txt; el.textContent = txt; }

  const chans = () => (T1.s && T1.s.channels) || [];
  const chanOf = n => chans().find(c => c.name === n) || null;
  const folderOf = n => (chanOf(n) || {}).folder || '';
  const cartCount = ch => { let n = 0; T1.cart.forEach(e => { if (!ch || e.ch === ch) n++; }); return n; };
  const wallItems = () => (T1.inv && T1.inv.items) || [];
  const invCh = () => (T1.inv && T1.inv.ch) || T1.ch;
  const nightBan = () => { const s = T1.s || {}; return !s.night || s.night.ban !== false; };
  const queueSet = () => new Set(((T1.s && T1.s.queue) || []).map(q => ck(q.file)));
  const inCart = f => T1.cart.has(ck(f));
  /** 발사 대기 중인가 — 서버가 영상 벽을 줄 때 적은 inQueue 는 그 뒤 발사 대기(ST.queue)가 안 바뀌었을 때만 믿는다(취소한 영상이 계속 막히지 않게) */
  const isQueued = (it, q = queueSet()) => (T1.qSig === T1.qSigAtLoad && !!it.inQueue) || q.has(ck(it.file));

  /** 이름만 아는 영상(휴지통·문안 창 제목용) */
  function infoOf(f) {
    return wallItems().find(it => ck(it.file) === ck(f)) || T1.cart.get(ck(f)) || { file: f, name: baseName(f), title: stem(baseName(f)) };
  }

  /* ================= 문안 출처 · 쿠팡 링크 (API 명세 §9·§10) =================
   * 글의 우선순위는 칸(제목·설명·해시태그)마다 따로: 사람이 화면에서 고친 것(.txt) > 쪽지(.json) > 자동(AI) > 파일 이름.
   * 항목(영상 벽·발사 대기·올리기 전 확인)에 붙어 오는 칸: meta{title,desc,tags,source{…},status} · links[{name,url}] · linkStatus.
   * 확인 창을 열었다고 AI 를 부르지는 않는다 — 이미 지어 둔 것(meta)만 보여 주고, 없으면 「올릴 때 자동으로」라고 알린다. */
  const aiReady = () => { const a = T1.s && T1.s.ai; return !!(a && a.enabled && a.hasKey); };
  const coupangOn = () => { const c = T1.s && T1.s.coupang; return !!(c && c.connected && c.enabled !== false); };
  const tagsArr = t => (Array.isArray(t) ? t : String(t || '').split(/[,\s]+/)).map(x => String(x).trim()).filter(Boolean);
  const joinTags = t => tagsArr(t).join(', ');
  const hashTags = t => tagsArr(t).map(x => '#' + x.replace(/^#/, '')).join(' ');
  const SRC_CLS = { '사람': 'kind-s', '쪽지': 'kind-l', '자동': 't1-auto', '파일이름': '' };
  const SRC_TIP = {
    '사람': '사람이 화면에서 고쳐 문안 파일(.txt)에 저장한 글입니다 — 자동으로 바뀌지 않습니다',
    '쪽지': '영상 옆 쪽지(.json)에 적힌 글입니다',
    '자동': 'AI 가 영상 내용과 이 채널의 말투를 보고 지은 글입니다 — 고쳐 저장하면 「사람」이 됩니다',
    '파일이름': '문안이 없어 파일 이름을 씁니다',
  };
  const srcPill = k => k ? `<span class="pill ${SRC_CLS[k] ?? ''}" title="${attr(SRC_TIP[k] || '')}">${k === '자동' ? '✨ ' : ''}${esc(k)}</span>` : '';
  /** 지금 유효한 글 — 자동으로 정해진 칸만 meta 에서 가져오고, 사람·쪽지·파일 이름은 항목 자체의 값을 쓴다 */
  function eff(it) {
    const m = it && it.meta, ms = (m && m.source) || {};
    const pick = (k, base) => (m && m[k] != null && m[k] !== '' && ms[k] === '자동') ? m[k] : base;
    return {
      title: pick('title', (it && (it.title || it.name)) || ''),
      desc: pick('desc', (it && it.desc) || ''),
      tags: tagsArr(pick('tags', (it && it.tags) || [])),
    };
  }
  /** 칸마다 어디서 온 글인가. 아직 정해진 문안이 없으면 null */
  function fieldSrc(it) {
    const ms = it && it.meta && it.meta.source;
    if (ms && typeof ms === 'object' && (ms.title || ms.desc || ms.tags)) return { title: ms.title || '', desc: ms.desc || '', tags: ms.tags || '' };
    const s = it && it.source;
    if (s && typeof s === 'string') { const k = /\.json$/i.test(s) ? '쪽지' : '사람'; return { title: k, desc: k, tags: k }; }
    return null;
  }
  /** 「문안 [사람]」 — 칸마다 출처가 다르면 「제목 [사람] 설명 [자동] …」. quiet 는 모르면 아무것도 안 그린다 */
  function srcHtml(it, o = {}) {
    const fs = fieldSrc(it), ef = eff(it);
    if (!fs) {
      if (o.quiet) return '';
      return aiReady()
        ? '📄 문안 <span class="pill t1-auto" title="문안 파일이 없어, 올릴 때 AI 가 영상 내용과 채널 말투를 보고 제목·설명·해시태그를 짓습니다">✨ 올릴 때 자동으로</span>'
        : `📄 문안 ${srcPill('파일이름')} <span>제목은 파일 이름 그대로</span>`;
    }
    const parts = [['제목', fs.title, !!ef.title], ['설명', fs.desc, !!ef.desc], ['태그', fs.tags, ef.tags.length > 0]].filter(p => p[1] && p[2]);
    if (!parts.length) return o.quiet ? '' : `📄 문안 ${srcPill(fs.title || fs.desc || fs.tags)}`;
    if (new Set(parts.map(p => p[1])).size === 1) return `📄 문안 ${srcPill(parts[0][1])}`;
    return '📄 ' + parts.map(p => `${p[0]} ${srcPill(p[1])}`).join(' ');
  }
  const LINK_ST = {
    '붙임': n => `쿠팡 링크 ${n}개 붙임`, '없음': () => '관련 상품이 없어 링크를 붙이지 않습니다', '건너뜀': () => '쿠팡 링크는 건너뜁니다',
    '사람이넣음': () => '설명에 직접 넣은 쿠팡 링크를 씁니다', '아직': () => '올릴 때 자동으로 고릅니다',
  };
  const LINK_TIP = {
    '붙임': '올릴 때 설명 끝에 상품 이름과 링크가 붙습니다', '없음': '정치·뉴스처럼 관련 상품이 없는 영상에는 억지로 넣지 않습니다',
    '건너뜀': '열쇠가 없거나 한도에 닿았거나 검색이 실패하면 링크만 건너뛰고 업로드는 그대로 합니다',
    '사람이넣음': '쪽지나 설명에 사람이 넣은 쿠팡 링크가 있으면 그것을 우선하고 자동 검색은 하지 않습니다',
    '아직': '올릴 때 설명 끝에 붙을 상품을 자동으로 고릅니다. 미리 고르려면 문안 고치기 창의 「미리 고르기」',
  };
  const okUrl = u => /^https?:\/\//i.test(String(u || ''));
  /** 쿠팡 링크 칩(「N개」 · 눌러서 펼침) · 상태 글 · 펼친 목록. 아무것도 보일 게 없으면 빈 글 */
  function linkParts(it) {
    const links = (Array.isArray(it && it.links) ? it.links : []).filter(l => l && okUrl(l.url));
    let st = (it && it.linkStatus) || '';
    if (!st) st = links.length ? '붙임' : (coupangOn() ? '아직' : '');
    if (!st && !links.length) return { chip: '', status: '', panel: '', row: '' };
    const f = attr(it.file), open = T1.lnkOpen.has(ck(it.file));
    const chip = links.length ? `<button class="pill kind-s t1-chip" data-a="lnk" data-f="${f}" onclick="t1Do(this)" title="눌러서 상품과 링크를 펼치거나 접습니다">🛒 ${links.length}</button>` : '';
    const sf = LINK_ST[st];
    const status = st ? `<span class="t1-lkst" title="${attr(LINK_TIP[st] || '')}">${esc(sf ? sf(links.length) : st)}</span>` : '';
    const panel = links.length ? `<div class="t1-lk${open ? '' : ' hide'}" data-f="${f}">${links.map(l =>
      `<div class="t1-lkr"><span class="n" title="${attr(l.name || '')}">${esc(cut(l.name || '상품', 44))}</span>`
      + `<button class="tb" data-a="ext" data-u="${attr(l.url)}" onclick="t1Do(this)" title="쿠팡 상품 페이지를 새 창으로 엽니다">열기 ↗</button></div>`).join('')}</div>` : '';
    return { chip, status, panel, row: `<div class="t1-lkl">${chip}${status}</div>` };
  }
  /** 영상 벽 카드 한 칸의 「문안 출처 + 링크」 덩어리 */
  function infoHtml(it) { const l = linkParts(it); return `<div class="t1-src">${srcHtml(it)}</div>${l.row}${l.panel}`; }
  /** 쿠팡 칩을 눌렀을 때 — 화면 어디에 같은 영상의 목록이 있든 함께 펼치고 접는다 */
  function toggleLinks(f) {
    const k = ck(f);
    if (T1.lnkOpen.has(k)) T1.lnkOpen.delete(k); else T1.lnkOpen.add(k);
    const open = T1.lnkOpen.has(k);
    document.querySelectorAll('.t1-lk').forEach(el => { if (ck(el.dataset.f) === k) el.classList.toggle('hide', !open); });
    delete T1.last.lanes; if (T1.s) paintLanes(T1.s);
  }
  /** 장바구니·확인 창에 보일 글만 담는다(길게 쌓이지 않게 자른다 — 서버로는 보내지 않는 표시용) */
  const slimMeta = m => m ? { title: m.title || '', desc: cut(m.desc || '', 400), tags: tagsArr(m.tags), source: m.source || null, status: m.status || '' } : null;
  const slimLinks = a => (Array.isArray(a) ? a : []).filter(l => l && l.url).map(l => ({ name: cut(l.name || '', 80), url: l.url }));
  const textFields = it => ({ desc: cut(it.desc || '', 400), tags: tagsArr(it.tags).slice(0, 20), source: it.source || null, meta: slimMeta(it.meta), links: slimLinks(it.links), linkStatus: it.linkStatus || '' });

  /* ================= 장바구니 ================= */
  function cartSave() { store.set(CART_KEY, [...T1.cart.values()]); }
  function entryFrom(it, ch) {
    const name = it.name || baseName(it.file);
    return { file: it.file, ch, name, title: eff(it).title || stem(name), kind: it.kind || '', sec: it.sec || 0, size: it.size || 0, at: '',
             thumb: it.thumb || null, dup: it.dup || '', why: it.why || '', kindOk: it.kindOk !== false, ...textFields(it) };
  }
  function cartAdd(it, ch) { if (inCart(it.file)) return false; T1.cart.set(ck(it.file), entryFrom(it, ch)); return true; }
  function cartRestore() {
    const arr = store.get(CART_KEY, []);
    if (!Array.isArray(arr)) return;
    arr.forEach(e => { if (e && e.file && e.ch) T1.cart.set(ck(e.file), { ...e, at: e.at || '' }); });
  }
  /** 영상 벽을 새로 읽었을 때 장바구니 칸의 제목·길이·문제를 최신으로 맞춘다 */
  function enrichCart(items) {
    let changed = false;
    items.forEach(it => {
      const e = T1.cart.get(ck(it.file)); if (!e) return;
      const nv = { name: it.name || e.name, title: eff(it).title || e.title, kind: it.kind || e.kind, sec: it.sec ?? e.sec, size: it.size ?? e.size,
                   thumb: it.thumb || null, dup: it.dup || '', why: it.why || '', kindOk: it.kindOk !== false, ...textFields(it) };
      for (const k in nv) { if (JSON.stringify(e[k]) !== JSON.stringify(nv[k])) { e[k] = nv[k]; changed = true; } }
    });
    if (changed) { cartSave(); T1.cartDirty = true; }
  }
  /** 폴더가 한 쪽뿐일 때만: 폴더에서 사라진 영상은 장바구니에서 뺀다(여러 쪽이면 다른 쪽에 있을 수 있어 건드리지 않는다) */
  function dropGhosts(inv, ch) {
    if (num0(inv.total) > PAGE || num0(inv.offset) !== 0) return;
    const have = new Set((inv.items || []).map(it => ck(it.file)));
    let n = 0;
    [...T1.cart.entries()].forEach(([k, e]) => { if (e.ch === ch && !have.has(k)) { T1.cart.delete(k); n++; } });
    if (n) { cartSave(); T1.cartDirty = true; msg(`폴더에서 사라진 영상 ${n}개를 장바구니에서 뺐습니다`); }
  }
  /** 이미 발사 대기에 들어간 영상은 장바구니에서 저절로 빠진다(올리기 뒤 정리도 이것으로 된다) */
  function pruneByQueue() {
    const q = queueSet(); if (!q.size) return;
    let n = 0;
    [...T1.cart.keys()].forEach(k => { if (q.has(k)) { T1.cart.delete(k); n++; } });
    if (n) { cartSave(); T1.cartDirty = true; }
  }

  /* ---- 문제 점검 (서버도 막지만 화면이 먼저 알려 준다) ---- */
  function atProblem(e) {
    if (!e.at) return null;
    const t = wallMs(e.at);
    if (isNaN(t)) return { lv: 'err', t: '올리기 시각을 읽지 못했습니다' };
    if (t < nowWall().getTime() + 2 * 60000) return { lv: 'err', t: '지났거나 2분 안의 시각입니다 — 지금 바로 올리려면 비워 두세요' };
    if (nightBan() && new Date(t).getHours() < 7) return { lv: 'warn', t: '자정~아침 7시는 발사 금지 시간입니다 — 거절될 수 있습니다' };
    return null;
  }
  function problemsOf(e, o = {}) {
    const out = [], c = chanOf(e.ch);
    if (!c) out.push({ lv: 'err', t: '채널 목록에 없는 채널입니다' });
    else {
      if (!c.authed) out.push({ lv: 'err', t: '구글 계정이 연결되지 않았거나 로그인이 풀려 올릴 수 없습니다' });
      else if (c.canPublish === false) out.push({ lv: 'err', t: '공개 권한이 없습니다 — 채널 탭에서 다시 연결해 주세요' });
      if (c.folderOk === false) out.push({ lv: 'err', t: '채널 폴더를 찾지 못했습니다' });
    }
    if (e.kindOk === false || e.why) out.push({ lv: 'err', t: '영상을 읽지 못했습니다' + (e.why ? ` — ${e.why}` : '') });
    if (e.dup) out.push({ lv: 'err', t: e.dup });
    if (!o.skipThumb && e.kind === '롱폼') {
      if (!e.thumb || !e.thumb.has) out.push({ lv: 'warn', t: '맞춤 썸네일이 없습니다' });
      else if (e.thumb.over) out.push({ lv: 'warn', t: '썸네일이 2MB 를 넘습니다' });
    }
    const a = atProblem(e); if (a) out.push(a);
    return out;
  }

  /* ================= 안내 배너 (#notReady) ================= */
  function paintBanner(s) {
    const cs = s.channels || [], authed = cs.filter(c => c.authed).length;
    let h = '';
    if (!cs.length) {
      h = '<div class="card warn"><h3>📺 아직 채널이 없습니다</h3>'
        + '<div class="p13">채널을 하나 만들고 구글 계정을 연결하면, 그 채널 폴더에 있는 영상을 여기서 골라 올릴 수 있습니다.</div>'
        + '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">'
        + '<button class="tb on" onclick="swTab(\'t5\')">🚀 시작하기 (구글 설정)</button>'
        + '<button class="tb" onclick="swTab(\'t3\')">📺 채널 추가</button></div></div>';
    } else if (!authed) {
      h = '<div class="card warn"><h3>🔑 구글 계정이 연결되지 않았습니다</h3>'
        + '<div class="p13">채널 탭에서 각 채널의 <b>구글 계정 연결</b> 을 눌러 주세요. 연결하기 전에는 영상을 고르고 담아 둘 수는 있어도 올리지는 못합니다.</div>'
        + '<button class="tb" style="margin-top:10px" onclick="swTab(\'t3\')">📺 채널 탭 열기</button></div>';
    } else {
      const bad = [];
      cs.forEach(c => {
        if (!c.authed) bad.push([c.name, c.lastError || '구글 계정이 연결되지 않았거나 로그인이 풀렸습니다']);
        else if (c.canPublish === false) bad.push([c.name, '공개 권한이 빠져 있습니다 — 다시 연결해 주세요']);
        else if (c.lastError) bad.push([c.name, c.lastError]);
      });
      if (bad.length) {
        // 올리려다 실패하기 전에 알린다 — 동의 화면이 「테스트」 면 7일마다 풀린다
        h = '<div class="card warn"><h3>🔑 로그인이 풀렸거나 연결되지 않은 채널이 있습니다</h3>'
          + '<div class="p13">이 채널은 지금 영상을 올리지 못합니다. 채널 탭에서 <b>구글 계정 연결</b> 을 눌러 다시 연결하면, 담아 둔 영상을 그대로 올릴 수 있습니다.</div>'
          + bad.map(b => `<div class="p13" style="margin-top:8px"><b>📺 ${esc(b[0])}</b><br><span style="color:var(--t3)">${esc(b[1])}</span></div>`).join('')
          + '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap"><button class="tb on" onclick="swTab(\'t3\')">📺 채널 탭 열기</button></div></div>';
      }
    }
    const fo = cs.filter(c => c.folderOk === false), bn = cs.filter(c => c.folderOk !== false && c.bound === false);
    if (fo.length) h += `<div class="card warn"><h3>📂 폴더를 찾지 못한 채널이 있습니다</h3><div class="p13">${fo.map(c => esc(c.name)).join(' · ')} — 채널 탭에서 폴더를 다시 정해 주세요.</div></div>`;
    if (bn.length) h += `<div class="card warn"><h3>📂 폴더 표식이 다른 채널과 맞지 않습니다</h3><div class="p13">${bn.map(c => esc(c.name)).join(' · ')} — 다른 채널의 폴더를 가리키고 있을 수 있습니다. 올리기 전에 채널 탭에서 확인해 주세요.</div></div>`;
    put($('notReady'), 'banner', h);
  }

  /* ================= 채널 탭 줄 ================= */
  function ensureChannel(s) {
    const cs = s.channels || [];
    if (!cs.length) {                                  // 채널이 모두 없어졌다 — 영상 벽도 비운다
      if (T1.ch || !T1.last.wall) { T1.ch = ''; T1.page = 0; T1.inv = null; T1.invKey = ''; T1.invErr = ''; renderWall(); }
      return;
    }
    if (!cs.some(c => c.name === T1.ch)) {             // 처음이거나 고른 채널이 없어졌다 — 기억해 둔 채널, 없으면 첫 채널
      const want = store.get(CH_KEY, '');
      T1.ch = cs.some(c => c.name === want) ? want : cs[0].name;
      T1.page = 0; T1.inv = null; T1.invKey = ''; T1.invErr = '';
      renderWall();                                    // 「불러오는 중…」 — 이어서 paint 가 loadInv 를 부른다
    }
  }
  function paintChips() {
    const cs = chans();
    const h = cs.length ? '<span class="t1-chlbl">어느 채널?</span>' + cs.map(c => {
      const w = num0(c.counts && c.counts['대기']), cn = cartCount(c.name);
      return `<button class="${c.name === T1.ch ? 'on' : ''}" data-a="chan" data-ch="${attr(c.name)}" onclick="t1Do(this)" title="${attr(c.title || c.name)}">`
        + `${esc(c.name)}${kindPill(c.isLong ? '롱폼' : '쇼츠')}<span class="t1-n" title="폴더에서 기다리는 영상">${w}</span>`
        + `${cn ? `<span class="t1-n" title="장바구니에 담은 영상">🛒${cn}</span>` : ''}${c.authed ? '' : ' 🔑'}</button>`;
    }).join('') : '';
    put($('t1Chips'), 'chips', h);
    const d = !cs.length ? '먼저 채널을 만들어 주세요'
      : `<b>${esc(T1.ch)}</b> 폴더로 들어갑니다 · 다른 채널로 보내려면 채널 이름 위에 놓거나, 이름을 눌러 바꾸세요`;
    put($('dropDesc'), 'dropdesc', d);
  }
  function selectChannel(name) {
    if (!name || name === T1.ch) return;
    T1.ch = name; T1.page = 0; T1.inv = null; T1.invKey = ''; T1.invErr = '';
    store.set(CH_KEY, name);
    $('t1PickReport').style.display = 'none';
    paintChips(); renderWall(); loadInv();
  }

  /* ================= 영상 벽 ================= */
  const addLabel = (picked, inq) => inq ? '⏰ 발사 대기 중' : picked ? '✓ 담음 — 누르면 빼기' : '＋ 장바구니에 담기';
  function thumbPath(it) {
    const t = it.thumb; if (!t || !t.has) return '';
    return t.path || (dirOf(it.file) + sepOf(it.file) + t.name);
  }
  /** 롱폼 맞춤 썸네일 칩 (있음 / 없음 / 2MB 초과) — 쇼츠에는 달지 않는다 */
  function thumbChip(it) {
    if (it.kind !== '롱폼') return '';
    const t = it.thumb, f = attr(it.file);
    if (!t || !t.has) return `<button class="pill warn t1-chip" data-a="thumb" data-f="${f}" onclick="t1Do(this)" title="영상 옆에 썸네일 그림이 없습니다 — 눌러서 자세히">🖼 썸네일 없음</button>`;
    if (t.over) return `<button class="pill warn t1-chip" data-a="thumb" data-f="${f}" onclick="t1Do(this)" title="2MB 를 넘습니다 — 눌러서 보기">⚠ 썸네일 2MB 초과</button>`;
    return `<button class="pill kind-s t1-chip" data-a="thumb" data-f="${f}" onclick="t1Do(this)" title="올라갈 썸네일 보기">🖼 썸네일 있음</button>`;
  }
  const dupSet = () => {
    const s = new Set(); ((T1.inv && T1.inv.dupGroups) || []).forEach(g => (g || []).forEach(p => s.add(ck(p)))); return s;
  };
  function cardHtml(it, q, dups) {
    const f = it.file, picked = inCart(f), inq = isQueued(it, q), bad = it.kindOk === false || !!it.why;
    const cls = ['t1-vd', picked ? 'picked' : '', inq ? 'inq' : '', bad ? 'bad' : '', T1.fresh.has(ck(f)) ? 'fresh' : ''].filter(Boolean).join(' ');
    const fa = attr(f), ttl = eff(it).title || it.name || baseName(f);
    return `<div class="${cls}" data-f="${fa}">
      <div class="t1-media" data-a="big" data-f="${fa}" onclick="t1Do(this)" title="크게 보기 (소리가 나옵니다)">
        <span class="t1-ph">🎬</span>
        <video data-src="/media?p=${encodeURIComponent(f)}#t=0.1" preload="metadata" muted playsinline></video>
        <span class="t1-k">${kindPill(it.kind)}</span>
        <span class="t1-qm" style="${inq ? '' : 'display:none'}">⏰ 발사 대기</span>
        ${dups.has(ck(f)) ? '<span class="t1-dupm"><span class="pill warn">🔁 같은 영상</span></span>' : ''}
        <span class="qc-dur">${it.sec ? fmtSec(it.sec) : '-'}</span>
      </div>
      <div class="t1-body">
        <div class="t1-ttl" title="${attr(it.name || '')}">${esc(ttl)}</div>
        <div class="t1-meta"><span>${fmtSize(it.size || 0)}</span>${it.w && it.h ? `<span>${it.w}×${it.h}</span>` : ''}${thumbChip(it)}</div>
        <div class="t1-info" data-f="${fa}">${infoHtml(it)}</div>
        ${it.dup ? `<div class="t1-warn err">🔁 ${esc(it.dup)}</div>` : ''}
        ${bad ? `<div class="t1-warn err">⚠ 읽지 못했습니다${it.why ? ' — ' + esc(it.why) : ''}</div>` : ''}
        <div class="t1-btns">
          <button class="t1-add" data-a="add" data-f="${fa}" onclick="t1Do(this)" ${inq || bad ? 'disabled' : ''}>${addLabel(picked, inq)}</button>
          <button class="tb" data-a="big" data-f="${fa}" onclick="t1Do(this)">🔍 크게 보기</button>
          <button class="tb" data-a="text" data-free="1" data-f="${fa}" onclick="t1Do(this)" ${inq ? 'disabled' : ''}>✏️ 문안 고치기</button>
          <button class="tb" data-a="hold" data-free="1" data-f="${fa}" onclick="t1Do(this)" ${inq ? 'disabled' : ''} title="올리지 않고 「검토필요」 폴더에 따로 둡니다">⏸ 검토필요로</button>
          <button class="tb" data-a="trash" data-free="1" data-f="${fa}" onclick="t1Do(this)" ${inq ? 'disabled' : ''} title="휴지통으로 보냅니다 — 되살릴 수 있습니다">🗑 휴지통</button>
        </div>
      </div>
    </div>`;
  }
  let IO = null;
  /** 보이는 카드의 영상만 첫 장면을 불러온다(50개를 한꺼번에 두드리지 않는다) */
  function observeVideos() {
    const vids = document.querySelectorAll('#t1Wall video[data-src]');
    if (IO) IO.disconnect();
    if (!('IntersectionObserver' in window)) { vids.forEach(v => { v.src = v.dataset.src; v.removeAttribute('data-src'); }); return; }
    IO = new IntersectionObserver(es => es.forEach(en => {
      if (!en.isIntersecting) return;
      const v = en.target; IO.unobserve(v);
      if (v.dataset.src) { v.src = v.dataset.src; v.removeAttribute('data-src'); }
    }), { rootMargin: '400px' });
    vids.forEach(v => IO.observe(v));
  }
  function pagerHtml() {
    const total = num0(T1.inv && T1.inv.total), pages = Math.max(1, Math.ceil(total / PAGE));
    if (pages <= 1) return total ? `<span class="hintline">모두 ${total}개</span>` : '';
    return `<button class="tb" data-a="page" data-d="-1" onclick="t1Do(this)" ${T1.page <= 0 ? 'disabled' : ''}>‹ 이전 ${PAGE}개</button>`
      + `<span>${T1.page + 1} / ${pages}</span><span class="hintline">모두 ${total}개 · 한 쪽에 ${PAGE}개</span>`
      + `<button class="tb" data-a="page" data-d="1" onclick="t1Do(this)" ${T1.page >= pages - 1 ? 'disabled' : ''}>다음 ${PAGE}개 ›</button>`;
  }
  function wallHeader() {
    const c = chanOf(T1.ch), total = num0(T1.inv && T1.inv.total);
    $('t1WallCh').textContent = T1.ch || '영상 벽';
    const bits = [];
    if (T1.inv) bits.push(`영상 ${total}개`);
    const cn = cartCount(T1.ch); if (cn) bits.push(`담음 ${cn}개`);
    if (c && c.queued) bits.push(`발사 대기 ${c.queued}개`);
    $('t1WallSub').textContent = bits.length ? ' — ' + bits.join(' · ') : '';
  }
  function renderWall() {
    const box = $('t1Wall'); if (!box) return;
    if (IO) IO.disconnect();
    wallHeader();
    let h = '';
    if (!T1.ch) {
      h = '<div class="empty small" style="grid-column:1/-1"><div class="empty-i">📺</div><div class="empty-t">채널이 없습니다</div><div class="empty-d">채널을 먼저 만들어 주세요.</div></div>';
    } else if (T1.invErr) {
      h = `<div class="empty small" style="grid-column:1/-1"><div class="empty-i">⚠️</div><div class="empty-t">영상 목록을 읽지 못했습니다</div><div class="empty-d">${esc(T1.invErr)}<br><button class="tb on" style="margin-top:8px" onclick="t1Refresh(true)">🔄 다시 읽기</button></div></div>`;
    } else if (!T1.inv) {
      h = '<div class="empty small" style="grid-column:1/-1"><div class="empty-i">⏳</div><div class="empty-t">영상 목록을 불러오는 중…</div></div>';
    } else if (!wallItems().length) {
      h = '<div class="empty small" style="grid-column:1/-1"><div class="empty-i">📭</div><div class="empty-t">이 채널 폴더에 올릴 영상이 없습니다</div><div class="empty-d">영상을 위에 끌어다 놓거나, 채널 폴더에 직접 넣은 뒤 <b>새로고침</b> 을 눌러 주세요.<br>제목은 영상 옆 문안 파일(.txt)이 정하고, 없으면 파일 이름이 제목이 됩니다.</div></div>';
    } else {
      const q = queueSet(), dups = dupSet();
      h = wallItems().map(it => cardHtml(it, q, dups)).join('');
    }
    box.innerHTML = h; T1.last.wall = h;
    const pg = pagerHtml(); put($('t1PagerTop'), 'pgtop', pg); put($('t1PagerBot'), 'pgbot', wallItems().length > 8 ? pg : '');
    put($('t1Dups'), 'dups', dupNoteHtml());
    observeVideos();
    if (T1.fresh.size) setTimeout(() => document.querySelectorAll('#t1Wall .t1-vd.fresh').forEach(e => e.classList.remove('fresh')), 4000);
    T1.fresh.clear();
  }
  function dupNoteHtml() {
    const g = (T1.inv && T1.inv.dupGroups) || [];
    if (!g.length) return '';
    const rows = g.slice(0, 6).map(a => '<div>' + (a || []).map(p => esc(baseName(p))).join(' = ') + '</div>').join('');
    return `<div class="t1-note err">🔁 <b>같은 영상이 둘 이상</b> 들어 있습니다 (크기와 길이가 같습니다)${rows}${g.length > 6 ? `<div>… 외 ${g.length - 6}묶음</div>` : ''}<div class="hintline">하나만 남기고 나머지는 🗑 휴지통으로 치우세요. 같은 영상을 두 번 올리면 중복으로 막힙니다.</div></div>`;
  }
  /** 담기·발사 대기 표시만 고친다 — 영상(video)은 다시 만들지 않는다 */
  function patchWall() {
    const q = queueSet();
    const by = new Map(wallItems().map(it => [ck(it.file), it]));
    document.querySelectorAll('#t1Wall .t1-vd').forEach(el => {
      const it = by.get(ck(el.dataset.f)); if (!it) return;
      const picked = inCart(it.file), inq = isQueued(it, q), bad = it.kindOk === false || !!it.why;
      el.classList.toggle('picked', picked); el.classList.toggle('inq', inq);
      const qm = el.querySelector('.t1-qm'); if (qm) qm.style.display = inq ? '' : 'none';
      const b = el.querySelector('.t1-add'); if (b) { const t = addLabel(picked, inq); if (b.textContent !== t) b.textContent = t; b.disabled = inq || bad; }
      el.querySelectorAll('[data-free]').forEach(x => { x.disabled = inq; });
    });
    wallHeader();
  }
  function curKey() { return `${T1.ch}|${T1.page}|${folderOf(T1.ch)}`; }
  async function loadInv() {
    if (!T1.ch) return;
    const key = curKey();
    if (!T1.force && key === T1.invKey) return;
    if (T1.invBusy) return;                       // 진행 중에 또 부르지 않는다 — 끝난 뒤 키가 달라졌으면 아래에서 한 번 더
    T1.invBusy = true; T1.force = false; T1.invKey = key;
    const ch = T1.ch, page = T1.page;
    const btn = $('t1RefreshBtn'); if (btn) btn.disabled = true;
    const r = await call(`/api/inventory?ch=${encodeURIComponent(ch)}&offset=${page * PAGE}&limit=${PAGE}`);
    T1.invBusy = false; if (btn) btn.disabled = false;
    if (ch !== T1.ch || page !== T1.page) { T1.invKey = ''; loadInv(); return; }   // 기다리는 동안 채널·쪽이 바뀌었다 — 옛 답은 버린다
    if (r.ok === false) {
      T1.invErr = r.why || '영상 목록을 읽지 못했습니다'; T1.inv = null;
    } else {
      T1.invErr = ''; T1.inv = r; T1.invAt = Date.now(); T1.qSigAtLoad = T1.qSig;
      const c = chanOf(ch); T1.invCnt = c && c.counts ? num0(c.counts['대기']) : null;
      if (!(r.items || []).length && num0(r.total) > 0 && page > 0) {           // 영상이 줄어 이 쪽이 비었다 → 마지막 쪽으로
        T1.page = Math.max(0, Math.ceil(num0(r.total) / PAGE) - 1); T1.invKey = ''; loadInv(); return;
      }
      enrichCart(r.items || []); dropGhosts(r, r.ch || ch);
    }
    renderWall();
    if (T1.cartDirty && !typing()) cartRender();
    paintChips(); paintCartAct(); paintStale();
  }
  function refresh(manual) {
    if (T1.invBusy) return;
    T1.force = true; loadInv();
    if (manual) poll();
  }
  function gotoPage(p) {
    const pages = Math.max(1, Math.ceil(num0(T1.inv && T1.inv.total) / PAGE));
    p = Math.max(0, Math.min(pages - 1, p));
    if (p === T1.page) return;
    T1.page = p; loadInv();
    const w = $('t1Wall'); if (w && w.scrollIntoView) w.scrollIntoView({ block: 'nearest' });
  }
  function paintStale() {
    const c = chanOf(T1.ch), el = $('t1Stale'); if (!el) return;
    let show = false;
    if (T1.inv && c && c.counts && T1.invCnt != null) {
      const now = num0(c.counts['대기']);
      if (now !== T1.invCnt) { if (Date.now() - T1.invAt < 6000) T1.invCnt = now; else show = true; }   // 방금 읽은 직후의 상태 지연은 봐준다
    }
    el.style.display = show ? '' : 'none';
  }

  /* ---- 담기 / 빼기 ---- */
  function afterCartChange() { patchWall(); paintChips(); cartRender(); paintCartAct(); }       // cartRender 가 레인(담은 것)도 다시 그린다
  function toggleCart(f) {
    const it = wallItems().find(x => ck(x.file) === ck(f)); if (!it) return;
    if (inCart(f)) T1.cart.delete(ck(f));
    else {
      if (isQueued(it)) return msg('이미 발사 대기에 있는 영상입니다', 'err');
      if (it.kindOk === false || it.why) return msg('읽지 못한 영상은 담을 수 없습니다', 'err');
      cartAdd(it, invCh());
    }
    cartSave(); afterCartChange();
  }
  async function cartClear() {
    if (!T1.cart.size) return;
    const ok = await confirmBox({ emoji: '🛒', title: '장바구니를 비울까요?', body: `담은 영상 ${T1.cart.size}개를 모두 뺍니다.<br>영상 파일은 그대로 있습니다.`, ok: '모두 빼기' });
    if (!ok) return;
    T1.cart.clear(); cartSave(); afterCartChange();
  }

  /* ---- 오늘 올릴 것 고르기 ---- */
  function dailyOf(c) {
    let lim = num0(c.dailyLimit);
    if (lim <= 0) { const m = /하루\s*(\d+)\s*편/.exec(c.policy || ''); lim = m ? +m[1] : 0; }
    if (lim <= 0 && c.conf) lim = num0(c.conf.daily);
    return lim > 0 ? lim : 0;
  }
  function togglePick() {
    const p = $('t1PickPanel'), on = p.style.display === 'none';
    p.style.display = on ? '' : 'none';
    if (!on) return;
    const c = chanOf(T1.ch) || {}, m = c.conf && c.conf.pick;
    if (['order', 'oldest', 'suggest', 'manual'].includes(m)) $('t1PickMode').value = m;
    const lim = dailyOf(c); $('t1PickN').value = lim ? Math.max(1, lim - num0(c.todayUploaded)) || lim : 3;
    $('t1PickHint').textContent = `「${T1.ch}」 폴더에서 고릅니다. 고른 영상은 장바구니에 담깁니다 — 올리기 전에 빼거나 더할 수 있습니다.`;
  }
  async function runPick() {
    if (!T1.ch) return msg('채널을 먼저 골라 주세요', 'err');
    const mode = $('t1PickMode').value, n = parseInt($('t1PickN').value, 10) || 0;
    if (n < 1) return msg('개수를 1 이상으로 적어 주세요', 'err');
    const body = { ch: T1.ch, mode, n };
    if (mode === 'manual') body.picked = [...T1.cart.values()].filter(e => e.ch === T1.ch).map(e => e.file);
    $('t1PickGo').disabled = true;
    const r = await call('/api/inventory/pick', body);
    $('t1PickGo').disabled = false;
    if (r.ok === false) return fail(r, '고르지 못했습니다');
    const q = queueSet(), by = new Map([...(r.items || []), ...wallItems()].map(it => [ck(it.file), it]));
    let added = 0;
    (r.chosen || []).forEach(x => {
      const file = typeof x === 'string' ? x : (x && x.file); if (!file || q.has(ck(file))) return;
      const it = by.get(ck(file)) || { file, name: baseName(file), title: stem(baseName(file)) };
      if (cartAdd(it, T1.ch)) added++;
    });
    cartSave(); afterCartChange();
    const lines = [].concat(r.note ? [r.note, ''] : [], r.report || []);
    const rep = $('t1PickReport'); rep.textContent = lines.join('\n'); rep.style.display = lines.length ? '' : 'none';
    msg(added ? `${added}개를 장바구니에 담았습니다` : '새로 담을 영상이 없습니다', added ? 'ok' : '');
  }

  /* ================= 장바구니 화면 ================= */
  function cartRender() {
    T1.cartDirty = false;
    const entries = [...T1.cart.values()], list = $('t1CartList');
    const ns = entries.filter(e => e.kind === '쇼츠').length, nl = entries.filter(e => e.kind === '롱폼').length;
    $('t1CartSub').textContent = entries.length
      ? ` — ${entries.length}개${ns ? ` · 쇼츠 ${ns}` : ''}${nl ? ` · 롱폼 ${nl}` : ''}${entries.length - ns - nl ? ` · 종류 확인 전 ${entries.length - ns - nl}` : ''}`
      : ' — 올릴 영상을 영상 벽에서 담아 주세요';
    let h = '';
    if (!entries.length) {
      h = '<div class="t1-cempty">🛒 아직 고른 영상이 없습니다<br>위 영상 벽에서 <b>장바구니에 담기</b> 를 누르거나 <b>오늘 올릴 것 고르기</b> 를 써 보세요.</div>';
    } else {
      const by = new Map();
      entries.forEach(e => { if (!by.has(e.ch)) by.set(e.ch, []); by.get(e.ch).push(e); });
      let idx = 0;
      by.forEach((arr, ch) => {
        h += `<div class="t1-cgrp"><div class="t1-cgh"><span>📺 ${esc(ch)}</span><i>${arr.length}개</i></div>`;
        arr.forEach(e => { h += crowHtml(e, idx++); });
        h += '</div>';
      });
    }
    put(list, 'cartlist', h);
    $('t1CartClearTop').disabled = !entries.length;
    paintLanes(T1.s);
  }
  function crowHtml(e, i) {
    const pr = problemsOf(e, { skipThumb: true }), hasErr = pr.some(p => p.lv === 'err'), f = attr(e.file), lp = linkParts(e);
    return `<div class="t1-crow${hasErr ? ' bad' : ''}" data-f="${f}">
      <div style="min-width:0">
        <div class="t1-ct">${kindPill(e.kind)}<span class="t" title="${attr(e.name)}">${esc(eff(e).title || e.title)}</span></div>
        <div class="t1-cm"><span>${esc(e.name)}</span>${e.sec ? `<span>${fmtSec(e.sec)}</span>` : ''}${e.size ? `<span>${fmtSize(e.size)}</span>` : ''}${thumbChip(e)}${pr.map(p => `<span class="pill ${p.lv === 'err' ? 'err' : 'warn'}" title="${attr(p.t)}">${esc(cut(p.t, 36))}</span>`).join('')}</div>
        <div class="t1-cm"><span class="t1-src">${srcHtml(e)}</span>${lp.chip}${lp.status}</div>
      </div>
      <div class="t1-cat">
        <label for="t1at${i}">올리기 시각 <small>(비우면 지금 바로)</small></label>
        <div class="row"><input type="datetime-local" step="60" id="t1at${i}" value="${attr(toInput(e.at))}" class="${atProblem(e) && atProblem(e).lv === 'err' ? 'bad' : ''}" data-a="at" data-f="${f}" onchange="t1Chg(this)">
        <button class="tb" data-a="atnow" data-f="${f}" onclick="t1Do(this)" title="시각을 비우고 지금 바로 올립니다">바로</button></div>
      </div>
      <div class="t1-cbtns">
        <button class="tb" data-a="text" data-f="${f}" onclick="t1Do(this)">✏️ 문안 고치기</button>
        ${e.kind === '롱폼' ? `<button class="tb" data-a="thumb" data-f="${f}" onclick="t1Do(this)">🖼 썸네일 확인</button>` : ''}
        <button class="tb" data-a="cdel" data-f="${f}" onclick="t1Do(this)">✕ 빼기</button>
      </div>
      ${lp.panel}
    </div>`;
  }
  function setAt(f, v, el) {
    const e = T1.cart.get(ck(f)); if (!e) return;
    e.at = v; cartSave();
    if (el) { const p = atProblem(e); el.classList.toggle('bad', !!(p && p.lv === 'err')); if (p) msg(p.t, p.lv === 'err' ? 'err' : ''); }
    else cartRender();
  }
  function spSave() { store.set(SP_KEY, { start: fromInput($('t1SpStart').value), gap: parseFloat($('t1SpGap').value) || 2 }); }
  function initSpread() {
    const sp = store.get(SP_KEY, null) || {};
    const d = nowWall(); d.setMinutes(Math.ceil((d.getMinutes() + 31) / 5) * 5, 0, 0);
    const start = sp.start && wallMs(sp.start) >= nowWall().getTime() + 120000 ? sp.start : fmtWall(d);
    $('t1SpStart').value = toInput(start);
    $('t1SpGap').value = sp.gap > 0 ? sp.gap : 2;
  }
  /** 간격 자동 배정 — 채널마다, 쇼츠·롱폼을 따로 같은 꼴끼리 시작 시각부터 간격대로 줄 세운다 */
  function spread() {
    const entries = [...T1.cart.values()];
    if (!entries.length) return msg('먼저 장바구니에 영상을 담아 주세요', 'err');
    const startV = fromInput($('t1SpStart').value), gap = parseFloat($('t1SpGap').value);
    if (!startV) return msg('시작 시각을 골라 주세요', 'err');
    if (!(gap >= 0.5 && gap <= 72)) return msg('간격은 0.5~72시간 사이로 적어 주세요', 'err');
    const start = wallMs(startV);
    if (start < nowWall().getTime() + 2 * 60000) return msg('시작 시각이 이미 지났거나 2분 안입니다. 더 뒤로 잡아 주세요', 'err');
    const ban = nightBan(), groups = new Map();
    entries.forEach(e => { const k = e.ch + '|' + (e.kind || '?'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); });
    let last = 0;
    groups.forEach(arr => {
      let t = start;
      arr.forEach((e, i) => {
        if (i > 0) t += gap * 3600000;
        const d = new Date(t);
        if (ban && d.getHours() < 7) { d.setHours(7, 0, 0, 0); t = d.getTime(); }   // 자정~아침 7시는 쏘지 않는다 — 그날 아침 7시로 민다
        e.at = fmtWall(new Date(t)); last = Math.max(last, t);
      });
    });
    spSave(); cartSave(); cartRender();
    msg(`${entries.length}개에 올리기 시각을 배정했습니다 — 마지막은 ${mdHm(fmtWall(new Date(last)))}`, 'ok');
  }
  function clearAt() {
    let n = 0; T1.cart.forEach(e => { if (e.at) { e.at = ''; n++; } });
    cartSave(); cartRender();
    msg(n ? '올리기 시각을 모두 비웠습니다 — 지금 바로 올립니다' : '비울 시각이 없습니다');
  }
  function paintCartAct() {
    const s = T1.s; if (!s) return;
    const n = T1.cart.size, up = s.upload || {}, running = !!up.running, locked = !!s.locked;
    const notes = [];
    if (locked) notes.push('<div class="t1-actnote err">🔒 올리기가 잠겨 있습니다 — 맨 위의 잠금을 풀어야 올릴 수 있습니다.</div>');
    const bads = new Set(); T1.cart.forEach(e => { const c = chanOf(e.ch); if (!c || !c.authed) bads.add(e.ch); });
    if (bads.size) notes.push(`<div class="t1-actnote warn">🔑 ${[...bads].map(esc).join(' · ')} 는 구글 계정이 연결되지 않아 올릴 수 없습니다 (채널 탭에서 연결)</div>`);
    if (s.paused) notes.push('<div class="t1-actnote">⏸ 일시정지 중입니다 — 지금 바로 올리기는 되지만, 발사 대기의 예약 쏘기는 멈춰 있습니다.</div>');
    let btns = '';
    if (running) btns += `<button class="tb on" onclick="t1OpenProg()">⏫ 올리는 중 (${num0(up.done)}/${num0(up.n)}) — 진행 보기</button>`;
    btns += `<button class="go t1-go" id="t1GoBtn" onclick="t1StartUpload()" ${(!n || locked || running) ? 'disabled' : ''}>📤 올리기 (${n}개)</button>`;
    put($('t1CartAct'), 'cartact', notes.join('') + `<div class="t1-actrow">${btns}</div>`);
  }

  /* ================= 올리기 : 표 → 확인 창 → 시작 → 진행 ================= */
  function flashRow(f) {
    const row = [...document.querySelectorAll('#t1CartList .t1-crow')].find(r => ck(r.dataset.f) === ck(f));
    if (row && row.scrollIntoView) { row.scrollIntoView({ block: 'center' }); row.classList.add('bad'); }
  }
  async function startUpload() {
    const s = T1.s || ST;
    if (s.locked) return msg('올리기가 잠겨 있습니다. 맨 위의 잠금을 풀어 주세요', 'err');
    if (s.upload && s.upload.running) { openProg(); return msg('지금 올리는 중입니다', 'err'); }
    const entries = [...T1.cart.values()];
    if (!entries.length) return msg('올릴 영상을 먼저 장바구니에 담아 주세요', 'err');
    for (const e of entries) {
      const p = atProblem(e);
      if (p && p.lv === 'err') { flashRow(e.file); return msg(`「${cut(e.title, 24)}」 — ${p.t}`, 'err'); }
    }
    const btn = $('t1GoBtn'); if (btn) btn.disabled = true;
    const r = await call('/api/upload/ticket', { files: entries.map(e => e.file) });
    if (btn) btn.disabled = false;
    if (r.ok === false) {
      if (Array.isArray(r.missing) && r.missing.length) {       // 서버가 「이 파일은 없다」 고 알려 주면 장바구니에서 뺀다
        r.missing.forEach(f => T1.cart.delete(ck(f))); cartSave(); afterCartChange();
        return msg(`폴더에 없는 영상 ${r.missing.length}개를 장바구니에서 뺐습니다. 다시 [올리기]를 눌러 주세요`, 'err');
      }
      return fail(r);
    }
    T1.tk = { t: r.t, n: num0(r.n) || entries.length, many: !!r.many, limit: num0(r.limit) || 20, at: Date.now(),
              files: entries.map(e => e.file), entries: entries.map(e => ({ ...e })), plan: Array.isArray(r.plan) ? r.plan : null, busy: false };
    openTicket();
  }
  /** 영상마다 한 줄 더 — 지금 정해진 글(출처 알약·설명 앞부분·해시태그)과 쿠팡 링크 상태, 문안 고치기 바로가기.
   *  확인 창을 열었다고 AI 를 부르지는 않는다(비용·시간). 이미 지어 둔 것(meta)만 보이고, 없으면 「올릴 때 자동으로 지어집니다」. */
  function tkSubRow(e) {
    const ef = eff(e), fs = fieldSrc(e), lp = linkParts(e), f = attr(e.file);
    let txt;
    if (!fs) {
      txt = aiReady() ? '<span class="d">제목·설명·해시태그는 올릴 때 자동으로 지어집니다 (영상 내용과 채널 말투를 봅니다)</span>'
                      : '<span class="d">설명·해시태그는 비어 있습니다</span>';
    } else {
      const d = String(ef.desc || '').replace(/\s+/g, ' ').trim();
      txt = `<span>설명 <span class="d">${d ? '“' + esc(cut(d, 70)) + '”' : '(비어 있음)'}</span></span>`
          + `<span>해시태그 <span class="d">${ef.tags.length ? esc(hashTags(ef.tags)) : '(없음)'}</span></span>`;
    }
    return `<tr class="t1-tr2"><td colspan="6"><div class="t1-tkline"><span class="t1-src">${srcHtml(e)}</span>${txt}${lp.chip}${lp.status}`
      + `<button class="tb" data-a="text" data-f="${f}" onclick="t1Do(this)" title="제목·설명·해시태그를 보고 고칩니다">✏️ 문안 고치기</button></div>${lp.panel}</td></tr>`;
  }
  function renderTicketRows() {
    const tk = T1.tk; if (!tk) return;
    const plan = new Map();
    (tk.plan || []).forEach(p => { if (p && p.file) plan.set(ck(p.file), p); });
    const sch = tk.entries.filter(e => e.at).length, ns = tk.entries.filter(e => e.kind === '쇼츠').length, nl = tk.entries.filter(e => e.kind === '롱폼').length;
    $('t1TkSub').textContent = `총 ${tk.entries.length}개${ns ? ` · 쇼츠 ${ns}` : ''}${nl ? ` · 롱폼 ${nl}` : ''} · 지금 바로 ${tk.entries.length - sch}개 · 시각 지정(발사 대기) ${sch}개`;
    const rows = tk.entries.map(e => {
      const p = plan.get(ck(e.file)) || {}, pr = problemsOf(e);
      (p.warn || p.issues || []).forEach(w => pr.push({ lv: 'warn', t: String(w) }));
      const pub = p.publishAt ? `<td class="mono">${esc(p.publishAt)}</td>` : '<td>올린 뒤 심사를 통과하면</td>';
      const fire = p.fireAt ? mdHm(p.fireAt) || p.fireAt : (e.at ? e.at : '지금 바로');
      return `<tr class="t1-tr1"><td>${esc(e.ch)}</td><td title="${attr(e.name)}">${esc(cut(eff(e).title || e.title, 46))}</td><td>${kindPill(e.kind) || '-'}</td>${pub}<td class="mono">${esc(fire)}</td>`
        + `<td>${pr.length ? pr.map(x => `<span class="iss ${x.lv === 'err' ? 'err' : ''}">${x.lv === 'err' ? '⛔' : '⚠'} ${esc(x.t)}</span>`).join('') : '<span class="ok">✓ 문제 없음</span>'}</td></tr>`
        + tkSubRow(e);
    }).join('');
    $('t1TkTbl').innerHTML = `<table class="t1-tbl"><thead><tr><th>채널</th><th>제목</th><th>종류</th><th>공개 시각</th><th>올리기 시각</th><th>확인할 것</th></tr></thead><tbody>${rows}</tbody></table>`;
    $('t1TkGo').textContent = `📤 올리기 (${tk.entries.length}개)`;
  }
  function openTicket() {
    const tk = T1.tk;
    renderTicketRows();
    const mb = $('t1TkManyBox'); mb.style.display = tk.many ? '' : 'none';
    $('t1TkMany').checked = false;
    $('t1TkManyTxt').textContent = `한 번에 ${tk.n}개를 올립니다. 한도(${tk.limit}개)를 넘습니다. 정말 맞습니다.`;
    $('t1TkGo').disabled = tk.many;
    openModal('t1MTicket');
  }
  /** 확인 창이 열린 채로 문안·링크가 바뀌면(문안 고치기 바로가기) 표의 줄을 다시 그린다 — 표(ticket)는 그대로 쓴다 */
  function refreshTicket() {
    const tk = T1.tk; if (!tk || !$('t1MTicket').classList.contains('on')) return;
    tk.entries = tk.entries.map(e => { const c = T1.cart.get(ck(e.file)); return c ? { ...c } : e; });
    const box = $('t1TkTbl'), top = box.scrollTop;
    renderTicketRows(); box.scrollTop = top;
  }
  function tkManyChg() { if (T1.tk) $('t1TkGo').disabled = T1.tk.many && !$('t1TkMany').checked; }
  function closeTicket() { closeModal('t1MTicket'); T1.tk = null; }
  async function tkGo() {
    const tk = T1.tk; if (!tk || tk.busy) return;
    if (tk.many && !$('t1TkMany').checked) return msg('한 번에 많이 올리는 것을 먼저 확인해 주세요', 'err');
    tk.busy = true; $('t1TkGo').disabled = true;
    // 표는 한 번만·2분 안에만 쓰인다 — 확인 창을 오래 두었으면 같은 목록으로 새 표를 받는다
    if (Date.now() - tk.at > 100000) {
      const r0 = await call('/api/upload/ticket', { files: tk.files });
      if (r0.ok === false) { tk.busy = false; tkManyChg(); return fail(r0); }
      tk.t = r0.t; tk.at = Date.now(); tk.many = !!r0.many;
      if (tk.many && !$('t1TkMany').checked) { tk.busy = false; openTicket(); return msg('오래 두어 새 표를 받았습니다. 한 번 더 확인해 주세요', 'err'); }
    }
    const at = {}; tk.entries.forEach(e => { if (e.at) at[e.file] = e.at; });
    const r = await call('/api/upload/start', { t: tk.t, files: tk.files, at, many: tk.many });
    tk.busy = false;
    if (r.ok === false) { tk.at = 0; tkManyChg(); return fail(r); }     // 표는 한 번 쓰면 끝 — 다음에는 새 표를 받는다
    chalkak();
    closeModal('t1MTicket');
    beginProgress(tk, num0(r.n));
    T1.tk = null; poll();
  }
  function resetProgUi() {
    $('t1PgEmoji').textContent = '⏫'; $('t1PgTitle').textContent = '올리는 중';
    $('t1PgFill').style.width = '0%'; $('t1PgPct').textContent = '0%'; $('t1PgFile').textContent = '…';
    $('t1PgLog').textContent = '시작하는 중…'; $('t1PgEl').textContent = '경과 0초'; $('t1PgCnt').textContent = '';
    $('t1PgStop').style.display = ''; $('t1PgStop').disabled = false; $('t1PgClose').textContent = '창 숨기기';
    $('t1PgHint').textContent = '창을 숨겨도 올리기는 계속됩니다. 다시 보려면 장바구니 아래의 「진행 보기」를 누르세요.';
  }
  function beginProgress(tk, n) {
    if (T1.up && T1.up.timer) clearInterval(T1.up.timer);
    const up = T1.up = { files: tk ? tk.files.slice() : [], startedAt: Date.now(), timer: null, busy: false, done: false, n: n || (tk ? tk.files.length : 0) };
    resetProgUi();
    $('t1PgSub').textContent = up.n ? `${up.n}개를 올립니다` : '';
    openModal('t1MProg');
    up.timer = setInterval(upTick, 1000);
    upTick();
  }
  function openProg() {
    if (!T1.up) {                    // 새로고침 뒤나 다른 창에서 시작한 올리기에 붙는다
      const u = (T1.s && T1.s.upload) || {};
      if (!u.running) return msg('지금 올리는 중인 것이 없습니다');
      beginProgress(null, num0(u.n)); return;
    }
    openModal('t1MProg');
  }
  async function upTick() {
    const up = T1.up; if (!up || up.busy || up.done) return;
    // 창을 숨겼고 상태도 아직 올리는 중이면 서버를 두드리지 않는다 — 끝난 것 같을 때만 확인한다
    const open = $('t1MProg').classList.contains('on'), run = T1.s && T1.s.upload && T1.s.upload.running;
    if (!open && run) return;
    up.busy = true;
    const k = await call('/api/upload/check', {});
    up.busy = false;
    if (T1.up !== up || up.done) return;
    if (k.ok === false) { if (!k.net && !up.errShown) { up.errShown = true; fail(k); } return; }
    paintProg(k);
    if (!k.running) finishUpload(k);
  }
  function paintProg(k) {
    const pr = k.progress || {}, pct = isFinite(+pr.pct) ? Math.max(0, Math.min(100, +pr.pct)) : (k.running ? 0 : 100);
    $('t1PgFill').style.width = pct + '%'; $('t1PgPct').textContent = Math.round(pct) + '%';
    $('t1PgFile').textContent = pr.file ? baseName(pr.file) : '…';
    const u = (T1.s && T1.s.upload) || {};
    $('t1PgCnt').textContent = num0(u.n) ? `${num0(u.done)} / ${num0(u.n)}개` : '';
    if (k.log != null) {
      const el = $('t1PgLog'), atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      if (el.textContent !== k.log) { el.textContent = k.log; if (atEnd || !el.dataset.seen) el.scrollTop = el.scrollHeight; el.dataset.seen = '1'; }
    }
  }
  function finishUpload(k) {
    const up = T1.up; if (!up) return;
    clearInterval(up.timer); up.timer = null; up.done = true;
    const ok = k.rc === 0 && !k.stopped;
    $('t1PgEmoji').textContent = k.stopped ? '🛑' : ok ? '✅' : '⚠️';
    $('t1PgTitle').textContent = k.stopped ? '중단했습니다' : ok ? '올렸습니다' : '멈췄습니다';
    $('t1PgStop').style.display = 'none'; $('t1PgClose').textContent = '닫기';
    if (ok) $('t1PgFill').style.width = '100%';
    $('t1PgHint').textContent = ok ? '시각을 정한 영상은 아래 「발사 대기」 칸에서, 바로 올린 영상은 「심사 대기」 칸에서 볼 수 있습니다.'
      : k.stopped ? '아직 시작하지 않은 영상은 올라가지 않았습니다. 보내던 한 개는 위 기록에서 실제 상태를 확인해 주세요. 못 올린 영상은 장바구니에 그대로 남아 있습니다.'
      : '위 기록에서 까닭을 확인해 주세요. 못 올린 영상은 장바구니에 그대로 남아 있습니다.';
    if (ok) { up.files.forEach(f => T1.cart.delete(ck(f))); cartSave(); T1.cartDirty = true; }
    if (!$('t1MProg').classList.contains('on')) msg(ok ? '올리기를 마쳤습니다' : k.stopped ? '올리기를 중단했습니다' : '올리기가 멈췄습니다 — 진행 창에서 확인하세요', ok ? 'ok' : 'err');
    T1.force = true; loadInv(); poll();
    if (!typing()) cartRender();
    T1.up = ok ? null : up;       // 실패·중단은 로그를 다시 볼 수 있게 남겨 둔다
  }
  function closeProg() { closeModal('t1MProg'); if (T1.up && T1.up.done) T1.up = null; }
  async function upStop() {
    const ok = await confirmBox({ emoji: '🛑', title: '지금 올리는 것을 멈출까요?',
      body: '· 아직 시작하지 않은 영상은 올라가지 않습니다<br>· 지금 보내는 중인 한 개는 이미 올라갔을 수 있습니다<br>&nbsp;&nbsp;(멈춘 뒤 실제 상태를 확인해 기록에 적어 드립니다)', ok: '멈추기', danger: true });
    if (!ok) return;
    $('t1PgStop').disabled = true; $('t1PgTitle').textContent = '멈추는 중';
    const r = await call('/api/upload/stop', {});
    if (r.ok === false) { $('t1PgStop').disabled = false; $('t1PgTitle').textContent = '올리는 중'; return fail(r); }
    msg(r.killed || '멈췄습니다', 'ok');
  }

  /* ================= 레인 (할 일의 흐름) ================= */
  function timerText(sec, mode) {
    if (mode === 'rv') {
      if (sec <= 0) return '곧 확인합니다';
      const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
      return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분 뒤 확인` : `${m}분 ${pad2(s)}초 뒤 확인`;
    }
    if (sec <= 0) return '곧 발사합니다 (다음 차례에)';
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    return (d > 0 ? d + '일 ' : '') + (d > 0 || h > 0 ? h + '시간 ' : '') + m + '분 ' + pad2(s) + '초 뒤 발사';
  }
  function tickTimers() {
    if (tab !== 't1' || !visibleNow()) return;
    const now = Date.now() + T1.skew;
    document.querySelectorAll('#t1 .t1-tmr[data-due]').forEach(el => {
      const due = wallMs(el.dataset.due);
      if (isNaN(due)) { el.textContent = ''; return; }
      const sec = (due - now) / 1000, rv = el.dataset.mode === 'rv';
      const t = timerText(sec, el.dataset.mode);
      if (el.textContent !== t) el.textContent = t;
      el.classList.toggle('hot', !rv && sec <= 600);
      el.classList.toggle('warn', !rv && sec > 600 && sec <= 3600);
    });
  }
  function laneHtml(key, title, color, rows, o = {}) {
    const open = !!T1.fold[key];
    const body = rows.length ? rows.map((r, i) => i >= FOLD ? r.replace('class="t1-it"', 'class="t1-it fold"') : r).join('') : `<div class="t1-lempty">${o.empty || '없음'}</div>`;
    const foot = rows.length > FOLD
      ? `<button data-a="fold" data-k="${key}" onclick="t1Do(this)">${open ? '접기 ▴' : `외 ${rows.length - FOLD}개 더 보기 ▾`}</button>` : (o.foot || '');
    return `<div class="t1-lane${open ? ' open' : ''}" style="--lc:${color}" data-lane="${key}">
      <div class="t1-lane-h"><span>${title}</span>${o.head || ''}<span class="n">${rows.length}</span></div>
      <div class="t1-lane-b">${body}</div><div class="t1-lane-f">${foot}</div></div>`;
  }
  function paintLanes(s) {
    if (!s || !$('t1Lanes')) return;
    // 1) 담은 것 (장바구니를 비춘다)
    const cartRows = [...T1.cart.values()].map(e => { const tt = eff(e).title || e.title; return `<div class="t1-it"><div class="t1-it-b"><b title="${attr(tt)}">${esc(cut(tt, 28))}</b>`
      + `<div class="t1-it-m">${kindPill(e.kind)}<span class="ch-tag">${esc(e.ch)}</span></div>`
      + `<div class="t1-it-s">${e.at ? '⏰ ' + esc(mdHm(e.at)) + ' 에 올림' : '지금 바로 올림'}</div></div>`
      + `<div class="t1-it-btn"><button class="tb" data-a="cdel" data-f="${attr(e.file)}" onclick="t1Do(this)" title="장바구니에서 뺍니다">✕</button></div></div>`; });
    // 2) 발사 대기
    const qRows = (s.queue || []).map(q => { const lp = linkParts(q), sp = srcHtml(q, { quiet: true }); return `<div class="t1-it"><div class="t1-it-b"><b title="${attr(q.title || q.name)}">${esc(cut(q.title || q.name, 28))}</b>`
      + `<div class="t1-it-m">${kindPill(q.kind)}<span class="ch-tag">${esc(q.alias || q.channel)}</span>${q.thumb ? '<span class="pill kind-s" title="맞춤 썸네일이 붙어 있습니다">🖼</span>' : ''}${lp.chip}</div>`
      + (sp ? `<div class="t1-src">${sp}</div>` : '') + (lp.status ? `<div class="t1-lkl">${lp.status}</div>` : '')
      + `<div class="t1-it-s">⏰ ${esc(mdHm(q.fireAt))} 올림${q.publishAt ? ` · ${esc(mdHm(q.publishAt))} 공개` : ''}</div>`
      + `<i class="t1-tmr" data-due="${attr(q.fireAt)}"></i>${q.late ? `<div class="t1-it-late">${esc(leftText(q.minutesLeft))} — 곧 올립니다</div>` : ''}${lp.panel}</div>`
      + `<div class="t1-it-btn"><button class="tb" data-a="retime" data-f="${attr(q.file)}" data-cur="${attr(q.fireAt)}" onclick="t1Do(this)" title="올리기 시각을 바꿉니다">시각</button>`
      + `<button class="tb" data-a="now" data-f="${attr(q.file)}" onclick="t1Do(this)" title="기다리지 않고 지금 올립니다">⚡ 지금</button>`
      + `<button class="tb" data-a="cancel" data-f="${attr(q.file)}" onclick="t1Do(this)" title="발사를 취소합니다">✕ 취소</button></div></div>`; });
    // 3) 심사 대기
    const rRows = (s.review || []).map(r => `<div class="t1-it"><div class="t1-it-b"><b title="${attr(r.t)}">${esc(cut(r.t, 28))}</b>`
      + `<div class="t1-it-m">${kindPill(r.kind)}<span class="ch-tag">${esc(r.ch)}</span>${r.human ? '<span class="pill err">사람 확인 필요</span>' : ''}${num0(r.n) > 0 ? `<span class="pill">확인 ${num0(r.n)}번</span>` : ''}</div>`
      + (r.next ? `<i class="t1-tmr" data-mode="rv" data-due="${attr(r.next)}"></i>` : '')
      + (r.gap ? `<div class="t1-it-late">${esc(r.gap)}</div>` : '')
      + (r.publishAt ? `<div class="t1-it-s">공개 예약 ${esc(mdHm(r.publishAt))}</div>` : '') + '</div></div>');
    // 4) 공개 예정·완료
    const tRows = (s.today || []).map(t => {
      const vis = t.visibility === 'public' ? '<span class="pill kind-s">공개됨</span>'
        : t.visibility === '예약' ? `<span class="pill kind-l">⏰ ${esc(t.reserve || '')} 공개 예정</span>`
        : `<span class="pill warn">${esc(t.visibility || '')}</span>`;
      return `<a class="t1-it" href="https://studio.youtube.com/video/${encodeURIComponent(t.id)}/edit" target="_blank" rel="noopener" title="스튜디오 편집기가 열립니다"><div class="t1-it-b"><b>${esc(cut(t.t, 28))}</b>`
        + `<div class="t1-it-m">${kindPill(t.kind)}<span class="ch-tag">${esc(t.ch)}</span>${vis}</div></div></a>`;
    });
    // 5) 문제
    const bRows = (s.brief || []).map(b => `<div class="t1-it"><div class="t1-it-b"><div class="t1-it-m"><span class="pill ${b.level === 'red' ? 'err' : 'warn'}">${b.level === 'red' ? '오류' : '살펴볼 것'}</span>${b.channel ? `<span class="ch-tag">${esc(b.channel)}</span>` : ''}</div>`
      + `<div style="font-size:11px;line-height:1.55;word-break:break-all">${esc(b.text)}</div>${b.at ? `<div class="t1-it-s">${esc(mdHm(b.at))}</div>` : ''}</div></div>`);
    const c = (s.issues && s.issues.counts) || {};
    const h = laneHtml('wait', '🛒 담은 것', 'var(--blue)', cartRows, { empty: '아직 고른 영상이 없습니다', foot: '올릴 영상을 고르면 여기 쌓입니다' })
      + laneHtml('shoot', '🔥 발사 대기', 'var(--accent)', qRows, { empty: '대기 중인 발사가 없습니다', foot: '정한 시각에 이 컴퓨터에서 올립니다', head: '<button class="t1-cal" onclick="t1OpenCal()" title="날짜별 예약 달력">달력 보기 ▸</button>' })
      + laneHtml('review', '🔎 심사 대기', 'var(--gold)', rRows, { empty: '심사 중인 영상이 없습니다', foot: '통과하면 자동으로 공개됩니다' })
      + laneHtml('open', '🌐 공개 예정·완료', 'var(--cyan)', tRows, { empty: '오늘 올린 영상이 없습니다', foot: '오늘 올린 것' })
      + laneHtml('bad', '⚠️ 문제', 'var(--accent)', bRows, { empty: num0(c.red) || num0(c.yellow) ? '위 신호등을 누르면 자세히 볼 수 있습니다' : '문제 없음', foot: '<button onclick="if(window.openIssues)openIssues()">자세히 보기</button>' });
    if (put($('t1Lanes'), 'lanes', h)) tickTimers();
  }

  /* ================= 오른쪽 판 ================= */
  function chCardsHtml(s) {
    const cs = s.channels || [];
    if (!cs.length) return '<div style="font-size:11px;color:var(--t3);padding:8px 0">등록된 채널이 없습니다</div>';
    return cs.map(c => {
      const lim = dailyOf(c), done = num0(c.todayUploaded);
      const left = c.dailyLeft != null && isFinite(+c.dailyLeft) ? +c.dailyLeft : (lim ? Math.max(0, lim - done) : null);
      const full = lim > 0 && left === 0;
      let badge = '<span class="chbadge no">미연결</span>';
      if (c.authed && c.canPublish === false) badge = '<span class="chbadge no">권한 부족</span>';      // 올릴 수 없는 사정이 한도보다 먼저다
      else if (c.authed && full) badge = '<span class="chbadge full">한도</span>';
      else if (c.authed) badge = '<span class="chbadge ok">연결됨</span>';
      const pct = lim > 0 ? Math.max(0, Math.min(100, num0(left) / lim * 100)) : 0;
      const subs = c.subsExact != null ? c.subsExact : c.subs;
      const warn = !c.authed || c.lastError;
      return `<div class="chcard${warn ? ' blocked' : ''}">
        <div class="chcard-top">
          ${c.avatar ? `<img src="${attr(c.avatar)}" alt="" onerror="this.style.display='none'"/>` : '<div style="width:34px;height:34px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0">📺</div>'}
          <div class="chcard-body"><div class="chcard-nm"><a href="#" data-a="chan" data-ch="${attr(c.name)}" onclick="t1Do(this);return false" style="color:inherit;text-decoration:none" title="이 채널의 영상 벽 보기">${esc(c.name)}</a> ${kindPill(c.isLong ? '롱폼' : '쇼츠')}</div>
          <div class="chcard-sub">${c.handle ? esc(c.handle) + ' · ' : ''}${subs != null ? '구독자 ' + num(subs) + '명' : esc(c.title || '유튜브 미연결')}</div></div>${badge}
        </div>
        ${lim > 0 ? `<div class="gauge"><div class="gauge-f" style="width:${pct}%"></div></div>` : ''}
        <div class="chcard-l"><span>오늘 올림 ${done}${lim ? ' / ' + lim : ''}개</span><span>${lim ? (full ? '한도 도달' : '남음 ' + num0(left) + '개') : '한도 없음'}</span></div>
        <div class="chcard-l" style="margin-top:3px"><span>폴더 ${num0(c.counts && c.counts['대기'])} · 발사 ${num0(c.queued)} · 심사 ${num0(c.reviewing)}</span><span></span></div>
        ${c.policy ? `<div class="t1-policy">📏 ${esc(c.policy)}</div>` : ''}
        ${c.lastError ? `<div class="chcard-warn">⛔ ${esc(c.lastError)}</div>` : ''}
        <div class="chcard-btns">
          <button class="tb" data-a="folder" data-ch="${attr(c.name)}" onclick="t1Do(this)">📂 폴더 열기</button>
          ${c.authed ? '' : '<button class="tb on" onclick="swTab(\'t3\')">🔑 연결하러 가기</button>'}
        </div></div>`;
    }).join('');
  }
  function quotaHtml(q) {
    if (!q) return '<div class="hintline">할당량을 아직 읽지 못했습니다</div>';
    const used = num0(q.units), left = num0(q.unitsLeft), total = used + left, pct = total ? Math.min(100, used / total * 100) : 0;
    let h = `<div class="gauge"><div class="gauge-f" style="width:${pct}%"></div></div>`
      + `<div class="gauge-l"><span>쓴 유닛 ${num(used)}</span><span>남음 ${num(left)}</span></div>`
      + `<div class="kv"><span>업로드</span><b>오늘 ${num0(q.uploads)}번 올림 · ${num0(q.uploadsLeft)}번 남음</b></div>`
      + `<div class="kv"><span>초기화</span><b>${esc(q.reset || '-')}</b></div>`;
    (q.projects || []).forEach(p => { h += `<div class="kv"><span>${esc(p.name)}</span><b>${num(p.units)} 유닛</b></div>`; });
    return h;
  }
  function paintSide(s) {
    put($('t1ChCards'), 'chcards', chCardsHtml(s));
    const t = s.todayStats || {};
    putText($('t1mToday'), 'mtoday', String(num0(t['올림']))); putText($('t1mWait'), 'mwait', String(num0(t['대기']))); putText($('t1mTotal'), 'mtotal', num(t['누적']));
    putText($('t1mHint'), 'mhint', `공개된 영상 ${num0(t['공개'])}개`);
    put($('t1Quota'), 'quota', quotaHtml(s.quota));
  }
  function paintRecent(s) {
    const list = s.recent || [];
    const h = list.length ? list.map(u => `<a class="thumb" href="https://studio.youtube.com/video/${encodeURIComponent(u.id)}/edit" target="_blank" rel="noopener" title="유튜브 스튜디오 편집기가 열립니다">`
      + `<img src="${attr(u.thumbUrl || 'https://i.ytimg.com/vi/' + u.id + '/mqdefault.jpg')}" alt="" onerror="this.style.opacity=.15"/>`
      + `<div class="thumb-t">${esc(u.t)}</div><div class="thumb-d">📺 ${esc(u.ch)} · ${esc(mdHm(u.at))}${u.kind ? ' · ' + esc(u.kind) : ''}</div></a>`).join('')
      : '<div style="grid-column:1/-1;padding:22px;text-align:center;color:var(--t3);font-size:11px;border:1px dashed var(--bdr);border-radius:var(--r)">아직 올린 영상이 없습니다</div>';
    put($('t1Recent'), 'recent', h);
    const c = chanOf(T1.ch) || chans()[0], b = $('t1StudioLink');
    if (b) b.style.display = c && c.channelId ? '' : 'none';
  }
  async function loadLog(force) {
    if (T1.logBusy) return;
    T1.logBusy = true;
    const r = await call('/api/log?n=20');
    T1.logBusy = false; T1.logAt = Date.now();
    if (r.ok === false) { if (force) fail(r); return; }
    const txt = (r.lines || []).slice(-20).join('\n') || '(기록 없음)', el = $('t1Log');
    if (el && el.textContent !== txt) { el.textContent = txt; el.scrollTop = el.scrollHeight; }
  }
  /** 일이 있었을 때만(쏘기·올리기·심사·틱) 최근 기록을 다시 읽는다 — 놀 때는 부르지 않는다 */
  function maybeLog(s) {
    const u = s.upload || {};
    const sig = [s.tick && s.tick.last, u.running, u.done, (s.queue || []).length, (s.review || []).length, s.todayStats && s.todayStats['올림']].join('|');
    if (sig === T1.logSig || Date.now() - T1.logAt < 3000) return;
    T1.logSig = sig; loadLog(false);
  }
  async function openStudio() {
    const c = chanOf(T1.ch) || chans()[0]; if (!c || !c.channelId) return;
    try {
      const r = await fetch('/studio?cid=' + encodeURIComponent(c.channelId));
      msg(r.ok ? '스튜디오를 열었습니다 — 이 채널로 바뀝니다' : '스튜디오를 열지 못했습니다', r.ok ? 'ok' : 'err');
    } catch (_) { msg('서버에 닿지 않았습니다', 'err'); }
  }
  async function openFolder(ch) {
    const c = chanOf(ch); if (!c || !c.folder) return msg('폴더를 알 수 없습니다', 'err');
    const r = await call('/api/open', { path: c.folder });
    if (r.ok === false) fail(r, '폴더를 열지 못했습니다');
  }

  /* ================= 끌어다 놓기 ================= */
  function setDropPct(p) { $('t1DropFill').style.width = p + '%'; $('t1DropPct').textContent = p + '%'; }
  function dropOne(file, ch, onProg) {
    return new Promise(res => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/drop?ch=${encodeURIComponent(ch)}&name=${encodeURIComponent(file.name)}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = e => { if (e.lengthComputable) onProg(e.loaded, e.total); };
      x.onload = () => { let j; try { j = JSON.parse(x.responseText); } catch (_) { j = { ok: false, why: `서버가 알 수 없는 답을 보냈습니다 (${x.status})` }; } res(j); };
      x.onerror = () => res({ ok: false, why: '서버에 닿지 않았습니다', net: true });
      x.onabort = () => res({ ok: false, why: '옮기기를 멈췄습니다' });
      x.send(file);
    });
  }
  /** 한 번에 한 파일씩 보낸다. 끝나면 영상 벽에 나타난다 — 담는 것은 사람이 한다 */
  async function sendFiles(files, ch) {
    ch = ch || T1.ch;
    if (!chans().length) return msg('먼저 채널을 만들어 주세요', 'err');
    if (!ch) return msg('채널을 먼저 골라 주세요', 'err');
    const list = [...files].filter(f => (f.type || '').startsWith('video/') || VIDEO_EXT.test(f.name));
    if (!list.length) return msg('영상 파일이 아닙니다', 'err');
    if (T1.dropBusy) return msg('지금 영상을 옮기는 중입니다. 끝난 뒤 다시 놓아 주세요', 'err');
    T1.dropBusy = true;
    $('t1DropProg').classList.add('on');
    let okN = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      $('t1DropTxt').textContent = `${i + 1}/${list.length} · ${cut(f.name, 40)} 옮기는 중`;
      setDropPct(0);
      const r = await dropOne(f, ch, (a, b) => setDropPct(b ? Math.round(a / b * 100) : 0));
      if (r.ok === false) { fail(r, `${f.name} 을(를) 옮기지 못했습니다`); break; }
      okN++; if (r.saved) T1.fresh.add(ck(r.saved));
    }
    T1.dropBusy = false; $('t1DropProg').classList.remove('on');
    if (!okN) return;
    msg(`${okN}개를 ${ch} 폴더에 넣었습니다 — 영상 벽에서 골라 담으세요`, 'ok');
    if (ch !== T1.ch) selectChannel(ch);
    T1.force = true; loadInv(); poll();
  }
  const hasFiles = e => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));

  /* ================= 영상 넘기기 (승인한 영상 → 채널 폴더 → 발사 대기) ================= */
  async function recvStart() {
    if (!chans().length) return msg('먼저 채널을 만들어 주세요', 'err');
    const r = await call('/api/file/pick', { kind: 'video', prompt: '채널로 넘길 영상을 고르세요' });
    if (r.ok === false) return /취소/.test(r.why || '') ? msg(r.why) : fail(r, '영상을 고르지 못했습니다');
    T1.recv = { path: r.path };
    $('t1RvFile').textContent = r.path; $('t1RvFile').title = r.path;
    $('t1RvCh').innerHTML = chans().map(c => `<option value="${attr(c.name)}" ${c.name === T1.ch ? 'selected' : ''}>${esc(c.name)}${c.authed ? '' : ' (연결 안 됨)'}</option>`).join('');
    ['t1RvTitle', 't1RvAt', 't1RvSlots', 't1RvWho'].forEach(id => { $(id).value = ''; });
    $('t1RvNow').checked = false;
    $('t1RvForm').style.display = ''; $('t1RvResult').style.display = 'none';
    $('t1RvGo').style.display = ''; $('t1RvGo').disabled = false; $('t1RvCancel').textContent = '취소';
    openModal('t1MRecv');
  }
  async function recvGo() {
    const rv = T1.recv; if (!rv) return;
    const ch = $('t1RvCh').value, at = fromInput($('t1RvAt').value), now = $('t1RvNow').checked;
    if (at && wallMs(at) < nowWall().getTime() + 2 * 60000) return msg('공개 시각이 이미 지났거나 2분 안입니다. 더 뒤로 잡거나 비워 주세요', 'err');
    const slots = $('t1RvSlots').value.split(/[\s,]+/).filter(x => /^\d{1,2}:\d{2}$/.test(x));
    const body = { ch, file: rv.path };
    const title = $('t1RvTitle').value.trim(), who = $('t1RvWho').value.trim();
    if (title) body.title = title; if (at) body.publishAt = at; if (slots.length) body.slots = slots; if (who) body.who = who; if (now) body.now = true;
    const ok = await confirmBox({ emoji: now ? '⚡' : '📥', title: now ? '지금 바로 올릴까요?' : '발사 대기에 담을까요?',
      body: `<b>${esc(baseName(rv.path))}</b> 를 <b>${esc(ch)}</b> 폴더로 복사하고 ${now ? '<b>바로 올립니다</b>(유튜브로 나갑니다)' : '발사 대기에 담습니다'}.<br>원본은 그대로 둡니다.${at ? `<br>공개 시각: ${esc(at)}` : ''}`,
      ok: now ? '바로 올리기' : '담기', danger: now });
    if (!ok) return;
    $('t1RvGo').disabled = true;
    const r = await call('/api/receive', body);
    $('t1RvGo').disabled = false;
    if (r.ok === false) return fail(r, '넘기지 못했습니다');
    $('t1RvForm').style.display = 'none'; $('t1RvGo').style.display = 'none'; $('t1RvCancel').textContent = '닫기';
    const kv = (k, v) => v ? `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>` : '';
    $('t1RvResult').innerHTML = `<div class="t1-note ok">✅ <b>${r.replaced ? '이미 발사 대기에 있어 파일만 새것으로 바꿨습니다' : '발사 대기에 담았습니다'}</b></div>`
      + kv('종류', r.kind) + kv('공개 시각', r.publishAt) + kv('올리기 시각', r.fireAt ? (mdHm(r.fireAt) || r.fireAt) : '') + kv('맞춤 썸네일', r.thumb ? '붙였습니다' : (r.kind === '롱폼' ? '없음' : ''))
      + ((r.lines || []).length ? `<pre class="logmini" style="margin-top:10px">${esc(r.lines.join('\n'))}</pre>` : '');
    $('t1RvResult').style.display = '';
    msg('영상을 넘겼습니다', 'ok');
    poll(); if (ch === T1.ch) { T1.force = true; loadInv(); }
  }

  /* ================= 크게 보기 ================= */
  /** 크게 보고 있는 영상 — 영상 벽이 다시 읽혀 순서가 바뀌었어도 같은 영상(없어졌으면 가까운 칸)을 가리킨다 */
  function bigItem() {
    if (!T1.big) return null;
    const items = wallItems(); if (!items.length) return null;
    let i = items.findIndex(it => ck(it.file) === T1.big.f);
    if (i < 0) i = Math.max(0, Math.min(T1.big.i, items.length - 1));
    T1.big.i = i; T1.big.f = ck(items[i].file);
    return items[i];
  }
  function openBig(f) {
    const i = wallItems().findIndex(it => ck(it.file) === ck(f)); if (i < 0) return;
    T1.big = { i, f: ck(f) }; showBig(); openModal('t1MBig');
  }
  function showBig() {
    const items = wallItems(), it = bigItem(); if (!it) return;
    const v = $('t1BigVid');
    v.src = '/media?p=' + encodeURIComponent(it.file);
    const p = v.play(); if (p && p.catch) p.catch(() => {});
    $('t1BigCh').textContent = '📺 ' + invCh();
    const ef = eff(it), lp = linkParts(it);
    $('t1BigT').textContent = ef.title || it.name;
    $('t1BigMeta').innerHTML = `${kindPill(it.kind)}<span>${it.sec ? fmtSec(it.sec) : '-'}</span><span>${fmtSize(it.size || 0)}</span>${it.w && it.h ? `<span>${it.w}×${it.h}</span>` : ''}<span>${esc(it.name)}</span>`;
    $('t1BigSrc').innerHTML = srcHtml(it);
    $('t1BigD').textContent = ef.desc || '(설명 없음)';
    $('t1BigG').textContent = ef.tags.join(', ') || '(해시태그 없음)';
    $('t1BigLk').innerHTML = lp.row + lp.panel.replace(' hide"', '"');          // 크게 보기 창에서는 상품 목록을 늘 펼쳐 둔다
    $('t1BigN').textContent = `${T1.big.i + 1} / ${items.length}`;
    bigButtons();
  }
  function bigButtons() {
    const it = bigItem(); if (!it) return;
    const inq = isQueued(it), picked = inCart(it.file);
    const b = $('t1BigAdd'); b.textContent = addLabel(picked, inq).replace('— 누르면 빼기', ''); b.disabled = inq || it.kindOk === false || !!it.why;
    $('t1BigTextBtn').disabled = inq;
  }
  function bigNav(d) {
    if (!T1.big) return;
    const n = wallItems().length; if (!n) return;
    bigItem(); T1.big.i = (T1.big.i + d + n) % n; T1.big.f = ck(wallItems()[T1.big.i].file); showBig();
  }
  function closeBig() {
    const v = $('t1BigVid');
    try { v.pause(); } catch (_) { /* 이미 멈춤 */ }
    v.removeAttribute('src'); try { v.load(); } catch (_) { /* 비운다 */ }
    closeModal('t1MBig'); T1.big = null;
  }

  /* ================= 문안 고치기 (칸마다 출처 · 자동 문안 · 관련 상품) =================
   * tx = { f, base, src, hint, busy, cpn }
   *  · base = 서버가 지금 쥐고 있는 글(처음엔 문안 파일의 값, 자동으로 지은 뒤엔 그 값). 칸이 base 와 다르면 「고침」.
   *  · src  = 칸마다 출처(사람·쪽지·자동·파일이름). 고쳐서 저장한 칸은 문안 파일(.txt)에 적혀 「사람」이 된다.
   *  · 창을 연다고 AI 를 부르지 않는다. 「자동으로 지어 보기」를 눌렀을 때만 부른다. */
  const TXF = [['title', 't1TxTitle', 't1TxSrcT'], ['desc', 't1TxDesc', 't1TxSrcD'], ['tags', 't1TxTags', 't1TxSrcG']];
  const txVals = () => ({ title: $('t1TxTitle').value, desc: $('t1TxDesc').value, tags: $('t1TxTags').value });
  function txChanged() {
    const tx = T1.tx, v = txVals();
    if (!tx || !tx.base) return { title: false, desc: false, tags: false };
    return { title: v.title !== tx.base.title, desc: v.desc !== tx.base.desc, tags: v.tags !== tx.base.tags };
  }
  const normSrc = s => (s && typeof s === 'object') ? { title: s.title || '', desc: s.desc || '', tags: s.tags || '' } : { title: '', desc: '', tags: '' };
  function paintTxSrc() {
    const tx = T1.tx; if (!tx) return;
    const ch = txChanged(), v = txVals();
    TXF.forEach(([k, , sid]) => {
      $(sid).innerHTML = ch[k] ? '<span class="pill kind-s" title="저장하면 문안 파일(.txt)에 적혀 「사람」이 됩니다">✏️ 고침 → 저장하면 사람</span>' : (v[k] ? srcPill(tx.src[k]) : '');
    });
    const auto = TXF.some(([k]) => tx.src[k] === '자동');
    $('t1TxAiAgain').style.display = auto ? '' : 'none';
    $('t1TxAiClear').style.display = auto ? '' : 'none';
  }
  function showProb(list) {
    const el = $('t1TxProb'), a = (list || []).filter(Boolean);
    el.innerHTML = a.length ? '⛔ <b>문안 검사에 걸렸습니다 — 이대로는 쓰이지 않습니다</b><br>' + a.map(x => '· ' + esc(x)).join('<br>') : '';
    el.style.display = a.length ? '' : 'none';
  }
  function aiNote(html) { const el = $('t1TxAiNote'); el.innerHTML = html || ''; el.style.display = html ? '' : 'none'; }
  const AI_GUIDE = '설정 탭에서 AI 열쇠(구글 AI 스튜디오의 무료 열쇠)를 넣으면, 문안이 없는 영상의 제목·설명·해시태그를 영상 내용과 이 채널의 말투를 보고 자동으로 지어 줍니다.';
  const aiKeyHtml = why => `<b>AI 열쇠가 없어 자동으로 지을 수 없습니다.</b>${why ? '<br>' + esc(why) : ''}<br>${AI_GUIDE}<br><button class="tb on" onclick="t1TxGoSettings()">⚙️ 설정 탭 열기</button>`;
  const needsKeyWhy = why => /열쇠|키\b|key/i.test(String(why || '')) || !!(T1.s && T1.s.ai && T1.s.ai.needsKey);
  function aiNoteDefault() {
    const a = (T1.s && T1.s.ai) || {};
    if (a.needsKey) return aiKeyHtml('');
    if (a.enabled === false) return '자동 문안이 꺼져 있습니다. 설정 탭에서 켤 수 있습니다. (켜지 않아도 직접 쓰는 것은 그대로 됩니다)';
    return '지어 보기만 한다고 올라가지는 않습니다. 사람이 정한 칸(문안 파일·쪽지)은 그대로 두고 비어 있는 칸만 지으며, 마음에 들지 않는 칸은 위에서 직접 고쳐 저장하세요.';
  }
  async function openText(f) {
    const it = infoOf(f);
    T1.tx = { f, base: null, src: normSrc(null), hint: '', busy: false,
              cpn: { status: it.linkStatus || '', links: slimLinks(it.links), queries: [], why: '', cached: false, block: '', busy: false } };
    $('t1TxName').textContent = it.name || baseName(f);
    TXF.forEach(([, id, sid]) => { $(id).value = ''; $(id).disabled = true; $(sid).innerHTML = ''; });
    $('t1TxBad').style.display = 'none'; showProb([]);
    $('t1TxSay').textContent = '문안을 읽는 중…'; $('t1TxSay').style.color = '';
    $('t1TxSaveBtn').disabled = true;
    $('t1TxAiAgain').style.display = 'none'; $('t1TxAiClear').style.display = 'none';
    aiNote(aiNoteDefault());
    delete T1.last.cpn; cpnPaint();
    openModal('t1MText');
    const r = await call('/api/text/get', { f });
    if (!T1.tx || T1.tx.f !== f) return;
    if (r.ok === false) { closeModal('t1MText'); T1.tx = null; return fail(r, '문안을 열지 못했습니다'); }
    const tx = T1.tx, m = it.meta;
    const fileSrc = r.source ? (/\.json$/i.test(String(r.source)) ? '쪽지' : '사람') : '';       // 문안 파일에서 온 글의 출처
    const vals = { title: r.title || '', desc: r.desc || '', tags: joinTags(r.tags) };
    let src;
    if (m && m.source) {         // 이미 지어 둔 글이 있으면 칸마다 출처를 그대로 따르고, 자동 칸은 올릴 때 쓰이는 글(meta)을 보여 준다
      src = normSrc(m.source);
      if (!vals.title && m.title) vals.title = m.title;
      if (!vals.desc && m.desc) vals.desc = m.desc;
      if (!vals.tags && tagsArr(m.tags).length) vals.tags = joinTags(m.tags);
      if (src.title === '자동' && m.title) vals.title = m.title;
      if (src.desc === '자동' && m.desc) vals.desc = m.desc;
      if (src.tags === '자동' && tagsArr(m.tags).length) vals.tags = joinTags(m.tags);
    } else {
      src = { title: vals.title ? (fileSrc || '파일이름') : '', desc: vals.desc ? fileSrc : '', tags: vals.tags ? fileSrc : '' };
    }
    tx.base = vals; tx.src = src;
    TXF.forEach(([k, id]) => { $(id).value = vals[k]; $(id).disabled = false; });
    $('t1TxSaveBtn').disabled = false;
    const bad = Array.isArray(r.bad) ? r.bad.filter(Boolean) : [];
    const box = $('t1TxBad');
    box.innerHTML = bad.map(b => '⚠ ' + esc(b)).join('<br>'); box.style.display = bad.length ? '' : 'none';
    tx.hint = r.source ? `불러온 곳: ${r.source} — 고치면 같은 문안 파일에 저장됩니다. 저장한 칸은 「사람」이 되어 자동으로 바뀌지 않습니다`
      : '문안 파일이 없습니다 — 저장하면 영상 옆에 문안 파일(.txt)이 만들어지고, 저장한 칸은 「사람」이 됩니다';
    $('t1TxSay').textContent = tx.hint;
    paintTxSrc();
    setTimeout(() => $('t1TxTitle').focus(), 30);
  }
  function txDirty() {
    const tx = T1.tx; if (!tx || !tx.base) return;
    const ch = txChanged(), d = ch.title || ch.desc || ch.tags;
    paintTxSrc();
    const s = $('t1TxSay');
    s.textContent = d ? '고쳤습니다 — 저장을 눌러야 반영됩니다. 저장한 칸은 「사람」이 되어 자동으로 바뀌지 않습니다' : tx.hint;
    s.style.color = d ? 'var(--gold)' : '';
  }
  function txRevert() {
    const tx = T1.tx; if (!tx || !tx.base) return;
    TXF.forEach(([k, id]) => { $(id).value = tx.base[k]; });
    paintTxSrc(); $('t1TxSay').textContent = '되돌렸습니다'; $('t1TxSay').style.color = '';
  }
  /** 자동으로 지어 보기 / 다시 짓기(force) — 사람·쪽지로 정해진 칸은 서버가 그대로 두고, 자동 칸만 짓는다 */
  async function txAi(force) {
    const tx = T1.tx; if (!tx || !tx.base || tx.busy) return;
    const ch = txChanged();
    if (ch.title || ch.desc || ch.tags) {
      const ok = await confirmBox({ emoji: '✨', title: '고친 내용이 사라집니다', body: '아직 저장하지 않은 고침이 있습니다.<br>자동으로 지으면 이 창의 글이 지은 글로 바뀝니다. 계속할까요?', ok: '계속' });
      if (!ok || !T1.tx || T1.tx.f !== tx.f) return;
    }
    tx.busy = true;
    const b = $(force ? 't1TxAiAgain' : 't1TxAiBtn'), old = b.textContent;
    b.disabled = true; b.textContent = '✨ 영상을 보며 짓는 중…';
    const r = await call('/api/ai/suggest', force ? { f: tx.f, force: true } : { f: tx.f });
    tx.busy = false; b.disabled = false; b.textContent = old;
    if (!T1.tx || T1.tx.f !== tx.f) return;
    if (r.ok === false) {
      if (needsKeyWhy(r.why)) { aiNote(aiKeyHtml(r.why)); return; }
      return fail(r, '자동으로 짓지 못했습니다');
    }
    // 서버가 돌려준 「지금 유효한 글」과 칸마다 출처
    tx.base = { title: r.title || '', desc: r.desc || '', tags: joinTags(r.tags) };
    tx.src = normSrc(r.source);
    TXF.forEach(([k, id]) => { $(id).value = tx.base[k]; });
    $('t1TxSay').textContent = tx.hint; $('t1TxSay').style.color = '';
    paintTxSrc();
    const probs = r.checks && Array.isArray(r.checks.problems) ? r.checks.problems : [];
    showProb(probs);
    const kind = r.kind ? ` (${esc(r.kind)} 꼴)` : '';
    if (r.status === '건너뜀') {
      aiNote(needsKeyWhy(r.why) ? aiKeyHtml(r.why) : `⚠ <b>자동으로 짓지 못했습니다.</b>${r.why ? '<br>' + esc(r.why) : ''}<br>업로드는 막지 않습니다 — 문안이 없으면 파일 이름이 제목으로 올라갑니다.`);
    } else if (r.status === '자동') {
      aiNote(`✨ <b>${r.cached ? '이미 지어 둔 글을 그대로 불러왔습니다' : '방금 자동으로 지었습니다'}</b>${kind} — 다시 부르지 않았습니다.<br>`
        + '사람·쪽지로 정한 칸은 그대로 두었습니다. 마음에 들지 않는 칸은 위에서 직접 고쳐 저장하세요 — 저장한 칸은 「사람」이 되어 다시 바뀌지 않습니다.');
    } else {
      aiNote(`이 영상의 문안은 이미 ${esc(r.status || '사람')}이(가) 정한 것이라 그대로 두었습니다.${kind}`);
    }
    applyMeta(tx.f, r);
  }
  async function txAiClear() {
    const tx = T1.tx; if (!tx) return;
    const ok = await confirmBox({ emoji: '✨', title: '자동으로 지은 기록을 지울까요?', body: '자동으로 지어 둔 제목·설명·해시태그 기록을 지우고, 올릴 때 다시 짓게 합니다.<br>사람이 저장한 글(.txt)과 쪽지는 그대로입니다.', ok: '기록 지우기' });
    if (!ok || !T1.tx || T1.tx.f !== tx.f) return;
    const r = await call('/api/ai/clear', { f: tx.f });
    if (r.ok === false) return fail(r);
    [wallItems().find(x => ck(x.file) === ck(tx.f)), T1.cart.get(ck(tx.f))].forEach(x => { if (x) x.meta = null; });
    cartSave(); refreshViews(tx.f);
    msg('자동으로 지은 기록을 지웠습니다 — 올릴 때 다시 짓습니다', 'ok');
    openText(tx.f);                                                                // 문안 파일의 값으로 다시 연다
  }
  /** 저장한 글을 화면 곳곳(영상 벽·장바구니·확인 창·크게 보기)에 같게 맞춘다 */
  function humanize(x, r, tags) {
    if (r.title) x.title = r.title;
    if (r.desc != null) x.desc = r.desc;
    x.tags = tags;
    if (!x.source) x.source = r.where || '문안.txt';
    if (x.meta) {          // 저장한 칸은 사람 — 비어 있는 칸은 자동으로 지은 글이 그대로 이어진다
      const ms = { ...(x.meta.source || {}) };
      if (r.title) { ms.title = '사람'; x.meta.title = r.title; }
      if (r.desc) { ms.desc = '사람'; x.meta.desc = r.desc; }
      if (tags.length) { ms.tags = '사람'; x.meta.tags = tags; }
      x.meta.source = ms;
    }
  }
  function applyText(f, r) {
    const tags = tagsArr(r.tags);
    const it = wallItems().find(x => ck(x.file) === ck(f));
    if (it) humanize(it, r, tags);
    const e = T1.cart.get(ck(f));
    if (e) { humanize(e, r, tags); e.desc = cut(e.desc || '', 400); e.title = eff(e).title || e.title; cartSave(); T1.cartDirty = true; }
    refreshViews(f);
  }
  /** 자동으로 지은 글·상품을 받았을 때 영상 벽 항목과 장바구니 칸에 같이 적어 둔다 */
  function applyMeta(f, r) {
    const meta = { title: r.title || '', desc: r.desc || '', tags: tagsArr(r.tags), source: r.source || null, status: r.status || '' };
    const it = wallItems().find(x => ck(x.file) === ck(f)), e = T1.cart.get(ck(f));
    [it, e].forEach(x => {
      if (!x) return;
      x.meta = x === e ? slimMeta(meta) : meta;
      if (Array.isArray(r.links)) x.links = x === e ? slimLinks(r.links) : r.links;
      if (r.linkStatus) x.linkStatus = r.linkStatus;
      if (r.kind && !x.kind) x.kind = r.kind;
    });
    if (e) { e.title = eff(e).title || e.title; cartSave(); T1.cartDirty = true; }
    if (T1.tx && T1.tx.f === f && Array.isArray(r.links)) { T1.tx.cpn.links = slimLinks(r.links); if (r.linkStatus) T1.tx.cpn.status = r.linkStatus; cpnPaint(); }
    refreshViews(f);
  }
  function applyLinks(f, links, status) {
    const it = wallItems().find(x => ck(x.file) === ck(f)), e = T1.cart.get(ck(f));
    [it, e].forEach(x => { if (!x) return; x.links = x === e ? slimLinks(links) : (links || []); x.linkStatus = status || ''; });
    if (e) { cartSave(); T1.cartDirty = true; }
    refreshViews(f);
  }
  /** 영상 벽 카드 한 칸의 제목·출처·링크만 다시 그린다(영상 video 는 건드리지 않는다) */
  function patchInfo(f) {
    const it = wallItems().find(x => ck(x.file) === ck(f)); if (!it) return;
    document.querySelectorAll('#t1Wall .t1-vd').forEach(el => {
      if (ck(el.dataset.f) !== ck(f)) return;
      const t = el.querySelector('.t1-ttl'); if (t) t.textContent = eff(it).title || it.name;
      const inf = el.querySelector('.t1-info'); if (inf) inf.innerHTML = infoHtml(it);
    });
  }
  /** AI·쿠팡 상태가 바뀌었을 때 — 영상 벽 카드·장바구니·확인 창·크게 보기의 「문안 출처 · 링크」 줄을 새 상태로 다시 그린다 */
  function repaintInfos() {
    const by = new Map(wallItems().map(it => [ck(it.file), it]));
    document.querySelectorAll('#t1Wall .t1-vd').forEach(el => {
      const it = by.get(ck(el.dataset.f)), inf = el.querySelector('.t1-info');
      if (it && inf) inf.innerHTML = infoHtml(it);
    });
    if (!typing()) cartRender(); else T1.cartDirty = true;
    refreshTicket();
    if (bigItem()) showBig();
  }
  function refreshViews(f) {
    patchInfo(f);
    if (!typing()) cartRender(); else T1.cartDirty = true;
    paintLanes(T1.s);
    refreshTicket();
    const bi = bigItem();
    if (bi && ck(bi.file) === ck(f)) showBig();
  }
  async function txSave() {
    const tx = T1.tx; if (!tx || !tx.base) return;
    $('t1TxSaveBtn').disabled = true;
    const r = await call('/api/text/save', { f: tx.f, ...txVals() });
    $('t1TxSaveBtn').disabled = false;
    if (r.ok === false) { $('t1TxSay').textContent = r.why || '저장하지 못했습니다'; $('t1TxSay').style.color = 'var(--accent)'; return; }
    tx.base = { title: r.title || '', desc: r.desc || '', tags: joinTags(r.tags) };
    TXF.forEach(([k, id]) => { $(id).value = tx.base[k]; });
    tx.src = { title: tx.base.title ? '사람' : '', desc: tx.base.desc ? '사람' : '', tags: tx.base.tags ? '사람' : '' };
    tx.hint = `${r.where || '문안 파일'} 에 저장했습니다 — 저장한 칸은 「사람」입니다`;
    $('t1TxSay').textContent = tx.hint; $('t1TxSay').style.color = 'var(--cyan)';
    showProb([]); paintTxSrc();
    applyText(tx.f, r);
    msg('문안을 저장했습니다', 'ok');
  }
  function closeText() { closeModal('t1MText'); T1.tx = null; delete T1.last.cpn; }
  const txGoSettings = () => { closeText(); swTab('t4'); };

  /* ---- 관련 상품 (쿠팡 파트너스) ---- */
  const CPN_ST = { '붙임': ['kind-s', '붙임'], '없음': ['', '관련 상품 없음'], '건너뜀': ['warn', '건너뜀'], '사람이넣음': ['kind-l', '직접 넣은 링크'], '아직': ['', '아직 안 골랐습니다'] };
  function cpnHtml() {
    const tx = T1.tx; if (!tx) return '';
    const c = tx.cpn, cp = (T1.s && T1.s.coupang) || {}, st = c.status || (c.links.length ? '붙임' : '아직'), sp = CPN_ST[st] || ['', st];
    let h = `<div class="t1-cpnh">🛒 관련 상품 <span class="pill ${sp[0]}">${esc(sp[1])}${st === '붙임' && c.links.length ? ` ${c.links.length}개` : ''}</span></div>`
      + '<div class="hintline" style="margin:0 0 6px">올릴 때 설명 끝에 상품 이름과 링크가 붙습니다. 여기서 미리 골라 두면 <b>나중에 올릴 때 같은 결과를 씁니다</b>(다시 검색하지 않습니다). 정치·뉴스처럼 관련 상품이 없는 영상에는 억지로 넣지 않습니다.</div>';
    if (!cp.connected) {
      h += '<div class="t1-note" style="margin-bottom:0">쿠팡 파트너스를 연결하지 않아 상품 링크는 붙지 않습니다. 내 열쇠를 넣으면 수수료가 내 계정으로 들어갑니다.<br><button class="tb on" onclick="t1CpnConnect()">🛒 쿠팡 파트너스 연결</button></div>';
    } else if (cp.enabled === false) {
      h += '<div class="t1-note">전체 자동 링크가 꺼져 있어 올릴 때는 붙지 않을 수 있습니다 (설정 탭에서 켤 수 있습니다).</div>';
    }
    if (cp.connected && cp.warn) h += `<div class="t1-note">⚠ ${esc(cp.warn)}</div>`;
    if (c.links.length) {
      h += '<div class="t1-lk">' + c.links.filter(l => okUrl(l.url)).map(l => `<div class="t1-lkr"><span class="n" title="${attr(l.name || '')}">${esc(cut(l.name || '상품', 48))}</span>`
        + `<button class="tb" data-a="ext" data-u="${attr(l.url)}" onclick="t1Do(this)" title="쿠팡 상품 페이지를 새 창으로 엽니다">열기 ↗</button></div>`).join('') + '</div>';
    }
    if ((c.queries || []).length) h += `<div class="t1-q">찾아본 말: ${c.queries.map(esc).join(' · ')}</div>`;
    if (c.why) h += `<div class="t1-q">${esc(c.why)}</div>`;
    if (c.cached) h += '<div class="t1-q">이미 골라 둔 결과를 그대로 보여 드립니다 (다시 검색하지 않았습니다).</div>';
    if (st === '사람이넣음') h += '<div class="t1-q">쪽지나 설명에 직접 넣은 쿠팡 링크가 있어 그것을 우선합니다 (자동 검색은 하지 않습니다).</div>';
    if (c.block) h += `<details><summary>설명 끝에 붙는 글 보기</summary><pre>${esc(c.block)}</pre></details>`;
    if (cp.connected) {
      const done = st === '붙임' || st === '없음' || st === '건너뜀';
      h += '<div class="t1-cpnbtns" style="margin-top:8px">'
        + (c.busy ? '<button class="tb" disabled>🛒 고르는 중…</button>'
          : (done ? '<button class="tb" onclick="t1CpnPick(true)" title="다시 검색해서 새로 고릅니다">다시 고르기</button><button class="tb" onclick="t1CpnClear()" title="고른 기록을 지워, 올릴 때 다시 고르게 합니다">고른 기록 지우기</button>'
                  : (st === '사람이넣음' ? '' : '<button class="tb on" onclick="t1CpnPick(false)" title="지금 이 영상에 맞는 상품을 골라 둡니다. 올릴 때 같은 결과를 씁니다">미리 고르기</button>')))
        + '</div>';
    }
    return h;
  }
  function cpnPaint() { put($('t1CpnBox'), 'cpn', cpnHtml()); }
  async function cpnPick(force) {
    const tx = T1.tx; if (!tx || tx.cpn.busy) return;
    tx.cpn.busy = true; cpnPaint();
    const r = await call('/api/coupang/pick', force ? { f: tx.f, force: true } : { f: tx.f });
    if (!T1.tx || T1.tx.f !== tx.f) return;
    tx.cpn.busy = false;
    if (r.ok === false) { cpnPaint(); return fail(r, '상품을 고르지 못했습니다'); }
    tx.cpn = { status: r.status || '', links: slimLinks(r.links), queries: r.queries || [], why: r.why || '', cached: !!r.cached, block: r.block || '', busy: false };
    cpnPaint();
    applyLinks(tx.f, r.links || [], r.status || '');
    const n = tx.cpn.links.length;
    msg(r.status === '붙임' ? `상품 ${n}개를 골랐습니다 — 올릴 때 같은 결과를 씁니다` : r.status === '없음' ? '관련 상품이 없어 링크는 붙이지 않습니다'
      : r.status === '건너뜀' ? `링크는 건너뜁니다${r.why ? ' — ' + r.why : ''}` : r.status === '사람이넣음' ? '직접 넣은 쿠팡 링크를 그대로 씁니다' : '상품을 골랐습니다',
      r.status === '붙임' ? 'ok' : '');
  }
  async function cpnClear() {
    const tx = T1.tx; if (!tx || tx.cpn.busy) return;
    const r = await call('/api/coupang/clear', { f: tx.f });
    if (r.ok === false) return fail(r);
    tx.cpn = { status: '아직', links: [], queries: [], why: '', cached: false, block: '', busy: false };
    cpnPaint(); applyLinks(tx.f, [], '아직');
    msg('고른 기록을 지웠습니다 — 올릴 때 다시 고릅니다');
  }
  /** 쿠팡 연결 창은 modals.js 가 전역으로 내보낸다(헤더 단추와 같은 창) */
  function cpnConnect() {
    if (typeof openCoupang === 'function') openCoupang();
    else { msg('설정 탭에서 쿠팡 파트너스를 연결해 주세요'); closeText(); swTab('t4'); }
  }

  /* ================= 휴지통 · 검토필요 · 썸네일 ================= */
  function dropFromCart(f) { if (T1.cart.delete(ck(f))) { cartSave(); T1.cartDirty = true; } }
  async function trashVideo(f) {
    const it = infoOf(f), name = it.name || baseName(f);
    const ok = await confirmBox({ emoji: '🗑', title: '휴지통으로 보낼까요?',
      body: `<b>${esc(name)}</b><br>영상 파일과 곁에 있는 문안(.txt)·쪽지·썸네일이 함께 휴지통으로 갑니다.<br>휴지통에서 되살릴 수 있습니다.`, ok: '휴지통으로', danger: true });
    if (!ok) return;
    const r = await call('/api/video/trash', { f });
    if (r.ok === false) return fail(r);
    msg(`「${cut(r.name || name, 24)}」 포함 ${num0(r.n) || 1}개를 휴지통으로 보냈습니다`, 'ok');
    dropFromCart(f); T1.force = true; loadInv(); poll();
    if (T1.big) closeBig();
  }
  async function holdVideo(f) {
    const it = infoOf(f), name = it.name || baseName(f);
    const why = await askBox({ emoji: '⏸', title: '검토필요로 치울까요?',
      body: `<b>${esc(name)}</b><br>올리지 않고 「검토필요」 폴더에 따로 둡니다. 나중에 다시 꺼낼 수 있습니다.`,
      label: '치우는 까닭 (선택)', placeholder: '예: 소리가 작음', ok: '치우기' });
    if (why === null) return;
    const r = await call('/api/video/hold', { f, reason: why.trim() || '화면에서 검토필요로 치움' });
    if (r.ok === false) return fail(r);
    msg(`「${cut(name, 24)}」 을 검토필요 폴더로 치웠습니다`, 'ok');
    dropFromCart(f); T1.force = true; loadInv(); poll();
    if (T1.big) closeBig();
  }
  function openThumb(f) {
    const it = infoOf(f), t = it.thumb, p = thumbPath(it);
    $('t1ThName').textContent = it.name || baseName(f);
    let h = '';
    if (!t || !t.has) {
      h = '<div class="t1-note">🖼 <b>맞춤 썸네일이 없습니다.</b><br>영상 옆에 썸네일 그림을 두면 롱폼에 맞춤 썸네일로 올라갑니다. 없으면 유튜브가 영상에서 고른 장면이 대표 그림이 됩니다.</div>';
    } else {
      h = (p ? `<img class="t1-thumbimg" src="/thumb?p=${encodeURIComponent(p)}" alt="올라갈 썸네일">` : '')
        + `<div class="kv"><span>파일</span><b>${esc(t.name || '')}</b></div>`
        + `<div class="kv"><span>크기</span><b>${t.bytes != null ? fmtSize(t.bytes) : '-'}</b></div>`
        + (t.w && t.h ? `<div class="kv"><span>해상도</span><b>${t.w}×${t.h}</b></div>` : '')
        + (t.over ? '<div class="t1-note" style="margin-top:10px">⚠ <b>2MB 를 넘습니다.</b> 올릴 때 줄여서 올라가며, 줄어들면서 흐려질 수 있습니다. 미리 2MB 안쪽으로 줄여 두면 가장 안전합니다.</div>' : '<div class="t1-note ok" style="margin-top:10px">✓ <b>2MB 안쪽입니다.</b> 이 그림이 그대로 맞춤 썸네일로 올라갑니다.</div>');
    }
    $('t1ThBody').innerHTML = h; openModal('t1MThumb');
  }

  /* ================= 한 줄 입력 창 ================= */
  function askBox(o) {
    return new Promise(res => {
      if (T1.ask) T1.ask(null);                  // 앞에 열린 입력 창이 있으면 취소로 닫는다
      $('t1AkEmoji').textContent = o.emoji || '✏️'; $('t1AkTitle').textContent = o.title || '';
      $('t1AkBody').innerHTML = o.body || ''; $('t1AkBody').style.display = o.body ? '' : 'none';
      $('t1AkLbl').textContent = o.label || '';
      const inp = $('t1AkIn'); inp.type = o.type || 'text'; inp.value = o.value || ''; inp.placeholder = o.placeholder || '';
      if (o.step) inp.step = o.step; else inp.removeAttribute('step');
      $('t1AkHint').textContent = o.hint || ''; $('t1AkOk').textContent = o.ok || '확인';
      T1.ask = v => { T1.ask = null; closeModal('t1MAsk'); res(v); };
      openModal('t1MAsk'); setTimeout(() => inp.focus(), 30);
    });
  }
  const askDone = yes => { if (T1.ask) T1.ask(yes ? $('t1AkIn').value : null); };

  /* ================= 발사 대기 만지기 ================= */
  async function retime(f, cur) {
    const name = baseName(f);
    const v = await askBox({ emoji: '⏰', title: '올리기 시각을 바꿉니다', type: 'datetime-local', step: 60, value: toInput(cur), label: '새 시각',
      body: `<b>${esc(name)}</b><br>그 시각까지 이 컴퓨터가 붙들고 있다가 올립니다.`,
      hint: '지난 시각과 2분 안의 시각은 쓸 수 없습니다. 밤(자정~아침 7시)은 심야 금지가 꺼져 있을 때만 됩니다.', ok: '이 시각으로 바꾸기' });
    if (v === null) return;
    const when = fromInput(v); if (!when) return msg('시각을 골라 주세요', 'err');
    const r = await call('/api/shoot/retime', { f, when });
    if (r.ok === false) return fail(r);
    msg(`올리기 시각을 바꿨습니다 — ${mdHm(r.fireAt) || when}`, 'ok');
    poll(); if ($('t1MCal').classList.contains('on')) loadCal();
  }
  async function shootCancel(f) {
    const name = baseName(f);
    const ok = await confirmBox({ emoji: '🔥', title: '발사를 취소할까요?',
      body: `<b>${esc(name)}</b><br>유튜브에는 <b>아직 올라가지 않았습니다.</b><br>영상 파일은 그대로 두고 발사 대기에서만 빠집니다.<br>언제든 다시 담을 수 있습니다.`, ok: '발사 취소', danger: true });
    if (!ok) return;
    const r = await call('/api/shoot/cancel', { f });
    if (r.ok === false) return fail(r);
    msg(`발사를 취소했습니다${r.left != null ? ` — 남은 발사 대기 ${r.left}건` : ''}`, 'ok');
    T1.force = true; loadInv(); poll(); if ($('t1MCal').classList.contains('on')) loadCal();
  }
  async function shootNow(f) {
    const name = baseName(f);
    const ok = await confirmBox({ emoji: '⚡', title: '지금 바로 올릴까요?',
      body: `<b>${esc(name)}</b><br>정한 시각을 기다리지 않고 <b>지금 유튜브로 올립니다.</b> 올린 뒤에는 비공개로 두고 심사를 거칩니다.`, ok: '지금 쏘기', danger: true });
    if (!ok) return;
    const r = await call('/api/shoot/now', { f });
    if (r.ok === false) return fail(r);
    msg(num0(r.fired) ? `지금 올렸습니다 (${r.fired}건)` : '올리지 못했습니다 — 기록을 확인해 주세요', num0(r.fired) ? 'ok' : 'err');
    T1.force = true; loadInv(); poll(); loadLog(false);
  }

  /* ================= 예약 달력 ================= */
  async function openCal() {
    openModal('t1MCal');
    $('t1CalBody').innerHTML = '<div class="t1-cempty" style="width:100%">불러오는 중…</div>'; $('t1CalTools').innerHTML = ''; $('t1CalSub').textContent = '';
    await loadCal();
  }
  async function loadCal() {
    const seq = ++T1.calSeq;
    const r = await call('/api/calendar');
    if (seq !== T1.calSeq) return;
    if (r.ok === false) { $('t1CalBody').innerHTML = `<div class="t1-cempty" style="width:100%">${esc(r.why || '달력을 읽지 못했습니다')}</div>`; return; }
    T1.cal = r; renderCal();
  }
  function renderCal() {
    const days = (T1.cal && T1.cal.days) || [];
    const total = days.reduce((a, d) => a + (d.items || []).length, 0);
    $('t1CalSub').textContent = total ? `발사 대기 ${total}건 · ${days.length}일 — 100편을 걸어도 어느 날 무엇이 나가는지 한눈에 봅니다` : '발사 대기가 비어 있습니다';
    if (!total) {
      $('t1CalTools').innerHTML = '';
      $('t1CalBody').innerHTML = '<div class="t1-cempty" style="width:100%">장바구니에서 <b>간격 자동 배정</b> 으로 며칠치를 걸면 여기에 날짜별로 보입니다</div>'; return;
    }
    const byCh = new Map();
    days.forEach(d => (d.items || []).forEach(it => { const k = it.channel || it.alias || ''; byCh.set(k, { n: (byCh.get(k) || { n: 0 }).n + 1, name: it.alias || it.channel || '' }); }));
    let tools = `<button class="tb d" data-a="cx" data-mode="all" data-k="" data-n="${total}" data-name="모든 예약" onclick="t1Do(this)">✕ 모든 예약 취소 · ${total}건</button>`;
    byCh.forEach((v, k) => { tools += `<button class="tb d" data-a="cx" data-mode="ch" data-k="${attr(k)}" data-n="${v.n}" data-name="${attr(v.name)}" onclick="t1Do(this)">${esc(cut(v.name, 14))} 전체 취소 · ${v.n}건</button>`; });
    $('t1CalTools').innerHTML = tools;
    const today = fmtWall(nowWall()).slice(0, 10);
    $('t1CalBody').innerHTML = days.map(d => {
      const its = d.items || [], groups = new Map();
      its.forEach(it => { const k = it.channel || it.alias || ''; if (!groups.has(k)) groups.set(k, { name: it.alias || it.channel || '', list: [] }); groups.get(k).list.push(it); });
      let col = '';
      groups.forEach(g => {
        col += `<div class="t1-schch">${esc(cut(g.name, 14))}<i>${g.list.length}건</i></div>`;
        g.list.forEach(it => {
          col += `<div class="t1-schit" title="${attr(it.title || it.name)}"><b>${esc(String(it.fireAt || '').slice(11, 16))}</b><span class="t">${esc(cut(it.title || it.name, 22))}</span>`
            + `<button class="ed" data-a="retime" data-f="${attr(it.file)}" data-cur="${attr(it.fireAt)}" onclick="t1Do(this)" title="올리기 시각 고치기">⏰</button>`
            + `<button class="x" data-a="cx" data-mode="one" data-k="${attr(it.file)}" data-n="1" data-name="${attr(it.title || it.name)}" onclick="t1Do(this)" title="이 예약만 취소">✕</button></div>`;
        });
      });
      return `<div class="t1-schcol${d.date === today ? ' today' : ''}"><div class="t1-schh">${esc(dayLabel(d.date))}<i>${its.length}건</i>`
        + `<button class="x" data-a="cx" data-mode="day" data-k="${attr(d.date)}" data-n="${its.length}" data-name="${attr(dayLabel(d.date))}" onclick="t1Do(this)" title="이 날짜 전체 취소">✕</button></div>${col}</div>`;
    }).join('');
  }
  async function schedCancel(mode, k, n, name) {
    const what = mode === 'all' ? `발사 대기 <b>${n}건 전부</b>` : mode === 'ch' ? `<b>${esc(name)}</b> 의 발사 대기 <b>${n}건</b>` : mode === 'day' ? `<b>${esc(name)}</b> 에 걸린 <b>${n}건</b>` : `<b>${esc(name)}</b>`;
    const ok = await confirmBox({ emoji: '🗓', title: '예약을 취소할까요?',
      body: `${what}을(를) 취소합니다.<br>유튜브에는 <b>아직 올라가지 않았습니다.</b> 영상 파일은 그대로 남고, 언제든 다시 담을 수 있습니다.`, ok: '예약 취소', danger: true });
    if (!ok) return;
    const r = await call('/api/sched/cancel', mode === 'all' ? { mode } : { mode, k });
    if (r.ok === false) return fail(r);
    msg(`예약 ${num0(r.removed)}건을 취소했습니다${r.left != null ? ` — 남은 발사 대기 ${r.left}건` : ''}`, 'ok');
    loadCal(); T1.force = true; loadInv(); poll();
  }

  /* ================= 올리기 전 확인 ================= */
  async function openPreview() {
    openModal('t1MPrev');
    $('t1PvBody').innerHTML = '<div class="t1-cempty">불러오는 중…</div>';
    const r = await call('/api/preview');
    if (r.ok === false) { $('t1PvBody').innerHTML = `<div class="t1-cempty">${esc(r.why || '미리 보기를 읽지 못했습니다')}</div>`; return; }
    const chs = r.channels || [];
    if (!chs.length) { $('t1PvBody').innerHTML = '<div class="t1-cempty">보여 드릴 채널이 없습니다</div>'; return; }
    const flat = v => Array.isArray(v) ? v.filter(Boolean).map(String) : (v ? [String(v)] : []);
    $('t1PvBody').innerHTML = chs.map(c => {
      const its = c.items || [];
      const rows = its.map(it => {
        const iss = flat(it.issues);
        const th = it.thumb == null || it.thumb === '' ? '-' : (it.thumb === true ? '✓' : it.thumb === false ? '없음' : esc(typeof it.thumb === 'object' ? (it.thumb.has ? '✓' : '없음') : String(it.thumb)));
        const lp = linkParts(it), sp = srcHtml(it, { quiet: true });
        return `<tr><td title="${attr(it.name || '')}">${esc(cut(eff(it).title || it.name, 40))}${sp ? `<div class="t1-src" style="margin-top:3px">${sp}</div>` : ''}</td><td>${kindPill(it.kind) || '-'}</td>`
          + `<td class="mono">${esc(it.publishAt || '-')}</td><td class="mono">${esc(it.fireAt ? (mdHm(it.fireAt) || it.fireAt) : '-')}</td><td>${esc(it.reason || '')}</td><td>${th}</td>`
          + `<td>${lp.row ? lp.row + lp.panel : '<span class="d" style="color:var(--t3)">-</span>'}</td>`
          + `<td>${iss.length ? iss.map(x => `<span class="iss err">⛔ ${esc(x)}</span>`).join('') : '<span class="ok">✓</span>'}</td></tr>`;
      }).join('');
      return `<div class="t1-pvch">📺 ${esc(c.ch)} <span class="t1-sub">${its.length}개</span></div>`
        + (c.note ? `<div class="hintline" style="margin:0 0 6px">${esc(c.note)}</div>` : '')
        + (its.length ? `<div class="t1-tblwrap"><table class="t1-tbl"><thead><tr><th>영상</th><th>종류</th><th>공개 시각</th><th>올리기 시각</th><th>까닭</th><th>썸네일</th><th>쿠팡 링크</th><th>확인할 것</th></tr></thead><tbody>${rows}</tbody></table></div>`
          : '<div class="hintline">오늘 올릴 영상이 없습니다</div>');
    }).join('');
  }

  /* ================= 말로 시키기 (해석만 — 실행은 사람이 올리기 흐름에서) ================= */
  const ACTION_NAME = { upload: '올리기', cart: '장바구니에 담기', uncart: '장바구니에서 빼기', status: '현황 보기', review: '심사 확인' };
  const PUBLISH_NAME = { schedule: '예약 공개', now: '바로 공개', immediate: '바로 공개', private: '비공개' };
  async function say() {
    const t = $('t1SayBox').value.trim();
    if (!t) { $('t1SayBox').focus(); return; }
    $('t1SayGo').disabled = true;
    const r = await call('/api/say/parse', { t });
    $('t1SayGo').disabled = false;
    if (r.ok === false) return fail(r, '못 알아들었습니다');
    T1.say = { q: t, r };
    renderSay(); openModal('t1MSay');
  }
  function renderSay() {
    const sy = T1.say; if (!sy) return;
    const r = sy.r, act = r.action, files = (r.paths && r.paths.length ? r.paths : r.files) || [];
    const row = (k, v) => (v == null || v === '') ? '' : `<div class="t1-sayrow"><span>${k}</span><span>${v}</span></div>`;
    $('t1SayQ').textContent = `「${sy.q}」`;
    let h = row('하려는 일', esc(ACTION_NAME[act] || '요청'))
      + row('채널', (r.channels || []).map(esc).join(' · ') || '(말하지 않음 — 지금 고른 채널)')
      + row('개수', r.count != null ? esc(r.count) + '개' : '')
      + row('올리기 시각', r.fireAt ? esc(mdHm(r.fireAt) || r.fireAt) + ' 에 올림' : (act === 'upload' || act === 'cart' ? '정하지 않음 (지금 바로)' : ''))
      + row('공개 방식', r.publish ? esc(PUBLISH_NAME[r.publish] || r.publish) : '')
      + row('고르는 방식', r.pick ? esc(r.pick) : '');
    if (files.length) {
      h += `<div class="t1-sayfiles">${files.slice(0, 40).map((x, i) => `${i + 1}. ${esc(baseName(x))}`).join('<br>')}${files.length > 40 ? `<br>… 외 ${files.length - 40}개` : ''}</div>`;
    }
    if ((r.warn || []).length) h += `<div class="t1-note">${r.warn.map(w => '⚠ ' + esc(w)).join('<br>')}</div>`;
    if ((r.status || []).length) h += `<pre class="logmini t1-logmini" style="margin-top:8px">${esc(r.status.join('\n'))}</pre>`;
    $('t1SayBody').innerHTML = h;
    const b = $('t1SayAdd'), can = (act === 'cart' || act === 'upload' || act === 'uncart') && (files.length > 0 || act === 'uncart');
    b.style.display = can ? '' : 'none';
    b.textContent = act === 'uncart' ? '이대로 빼기' : '이대로 담기';
  }
  /** 이름만 온 파일을 경로로 바꾼다 — 이미 읽은 쪽에 있으면 그것을, 없으면 그 채널 영상 벽을 쪽마다 훑어 찾는다 */
  async function resolveFiles(ch, refs) {
    const found = new Map(), want = new Set();
    const idx = new Map();
    const feed = items => items.forEach(it => { idx.set(ck(it.file), it); idx.set('n:' + nfc(it.name || baseName(it.file)), it); });
    if (T1.inv && invCh() === ch) feed(wallItems());
    const out = [], miss = [];
    refs.forEach(x => { const key = isAbs(x) ? ck(x) : 'n:' + nfc(x); if (!idx.has(key)) want.add(key); });
    for (let off = 0, tot = Infinity, n = 0; want.size && off < tot && n < 40; off += PAGE, n++) {
      if (n === 0 && T1.inv && invCh() === ch && num0(T1.inv.offset) === 0 && num0(T1.inv.total) <= PAGE) break;   // 한 쪽뿐이면 이미 다 읽었다
      const r = await call(`/api/inventory?ch=${encodeURIComponent(ch)}&offset=${off}&limit=${PAGE}`);
      if (r.ok === false) break;
      tot = num0(r.total); feed(r.items || []);
      [...want].forEach(k => { if (idx.has(k)) want.delete(k); });
    }
    refs.forEach(x => {
      const it = idx.get(isAbs(x) ? ck(x) : 'n:' + nfc(x));
      if (it) out.push(it); else if (isAbs(x)) out.push({ file: x, name: baseName(x), title: stem(baseName(x)) }); else miss.push(x);
    });
    return { out, miss };
  }
  async function sayCart() {
    const sy = T1.say; if (!sy) return;
    const r = sy.r, act = r.action, refs = (r.paths && r.paths.length ? r.paths : r.files) || [];
    if ((r.channels || []).length > 1) return msg('채널을 하나만 말해 주세요 — 한 번에 한 채널씩 담습니다', 'err');
    const ch = (r.channels || [])[0] || T1.ch;
    if (!chanOf(ch)) return msg(`「${ch}」 채널을 찾지 못했습니다`, 'err');
    $('t1SayAdd').disabled = true;
    if (act === 'uncart') {
      let n = 0;
      if (refs.length) { const names = new Set(refs.map(x => nfc(baseName(x)))); [...T1.cart.entries()].forEach(([k, e]) => { if (e.ch === ch && (names.has(nfc(e.name)) || names.has(nfc(baseName(e.file))))) { T1.cart.delete(k); n++; } }); }
      else [...T1.cart.entries()].forEach(([k, e]) => { if (e.ch === ch) { T1.cart.delete(k); n++; } });
      cartSave(); afterCartChange(); $('t1SayAdd').disabled = false; closeModal('t1MSay');
      return msg(`장바구니에서 ${n}개를 뺐습니다`, n ? 'ok' : '');
    }
    const { out, miss } = await resolveFiles(ch, refs);
    $('t1SayAdd').disabled = false;
    const q = queueSet();
    let added = 0, queued = 0;
    const at = r.fireAt ? fromInput(r.fireAt) : '';
    const atOk = at && wallMs(at) >= nowWall().getTime() + 2 * 60000;
    out.forEach(it => {
      if (isQueued(it, q)) { queued++; return; }
      if (cartAdd(it, ch)) { added++; if (atOk) T1.cart.get(ck(it.file)).at = at; }
    });
    cartSave(); afterCartChange(); closeModal('t1MSay');
    $('t1SayBox').value = '';
    const bits = [`${added}개를 장바구니에 담았습니다`];
    if (atOk) bits.push(`올리기 시각 ${mdHm(at)}`);
    if (at && !atOk) bits.push('말한 시각은 이미 지나 비워 두었습니다');
    if (queued) bits.push(`이미 발사 대기인 ${queued}개는 건너뜀`);
    if (miss.length) bits.push(`폴더에서 못 찾은 ${miss.length}개`);
    msg(bits.join(' · ') + ' — 올리려면 [올리기]를 누르세요', added ? 'ok' : 'err');
    if (ch !== T1.ch) selectChannel(ch);
  }

  /* ================= 클릭·입력 나눠 주기 ================= */
  const ACT = {
    chan: el => selectChannel(el.dataset.ch),
    page: el => gotoPage(T1.page + (+el.dataset.d || 0)),
    add: el => toggleCart(el.dataset.f),
    big: el => openBig(el.dataset.f),
    text: el => openText(el.dataset.f),
    trash: el => trashVideo(el.dataset.f),
    hold: el => holdVideo(el.dataset.f),
    thumb: el => openThumb(el.dataset.f),
    cdel: el => { T1.cart.delete(ck(el.dataset.f)); cartSave(); afterCartChange(); },
    atnow: el => setAt(el.dataset.f, '', null),
    retime: el => retime(el.dataset.f, el.dataset.cur),
    cancel: el => shootCancel(el.dataset.f),
    now: el => shootNow(el.dataset.f),
    fold: el => { T1.fold[el.dataset.k] = !T1.fold[el.dataset.k]; delete T1.last.lanes; paintLanes(T1.s); },
    cx: el => schedCancel(el.dataset.mode, el.dataset.k, el.dataset.n, el.dataset.name),
    folder: el => openFolder(el.dataset.ch),
    lnk: el => toggleLinks(el.dataset.f),
    ext: el => { const u = el.dataset.u; if (okUrl(u)) ext(u); else msg('열 수 없는 주소입니다', 'err'); },   // http(s) 만 새 창으로
  };
  const Do = el => { const fn = ACT[el && el.dataset && el.dataset.a]; if (fn) fn(el); };
  const Chg = el => { if (el.dataset.a === 'at') setAt(el.dataset.f, fromInput(el.value), el); };

  /* ================= 탭 등록 ================= */
  function paint(s) {
    if (!T1.ready || !s) return;                 // init 이 끝나기 전의 첫 상태는 init 이 직접 그린다
    T1.s = s;
    const sk = wallMs(s.now) - Date.now(); if (isFinite(sk)) T1.skew = sk;
    T1.qSig = (s.queue || []).map(q => ck(q.file)).join('|');
    const isig = (aiReady() ? 'a' : '-') + (coupangOn() ? 'c' : '-');     // 열쇠를 넣거나 쿠팡을 연결하면 「올릴 때 자동으로」 글이 달라진다
    const infoChanged = T1.infoSig !== null && isig !== T1.infoSig; T1.infoSig = isig;
    ensureChannel(s);
    paintBanner(s);
    paintChips();
    loadInv();
    pruneByQueue();
    if (infoChanged) repaintInfos();
    if (!typing()) { patchWall(); if (T1.cartDirty) cartRender(); }
    paintCartAct();
    paintLanes(s);
    paintSide(s);
    paintRecent(s);
    paintStale();
    paintAiNote(s);
    maybeLog(s);
    tickTimers();
    if (T1.big) bigButtons();
    if (T1.tx) cpnPaint();                       // 문안 창을 연 채로 쿠팡 연결을 끝냈다면 구역이 바뀐다(글이 같으면 다시 안 그린다)
  }
  /** 영상 벽 위의 작은 안내 — AI 열쇠가 없을 때·쿠팡이 한 줄 경고를 줄 때만 */
  function paintAiNote(s) {
    const a = s.ai || {}, c = s.coupang || {}, bits = [];
    if (a.needsKey) bits.push('✨ 자동 문안이 켜져 있지만 <b>AI 열쇠가 없습니다.</b> 문안(txt·쪽지)이 없는 영상은 파일 이름이 제목이 됩니다. <button class="tb on" onclick="swTab(\'t4\')">⚙️ 설정 탭에서 열쇠 넣기</button>');
    if (c.warn) bits.push('🛒 ' + esc(c.warn));
    put($('t1AiNote'), 'ainote', bits.length ? `<div class="t1-note">${bits.join('<br>')}</div>` : '');
  }
  function init(s) {
    T1.s = s; const sk = wallMs(s && s.now) - Date.now(); if (isFinite(sk)) T1.skew = sk;
    cartRestore(); T1.cartDirty = true;           // 새로고침 뒤에도 담은 것이 그대로 — 복원한 칸은 첫 박자에 그린다
    initSpread();
    // 끌어다 놓기 — 영상 칸을 누르면 파일 선택창, 끌어오면 바로 보낸다
    const dz = $('drop');
    dz.addEventListener('click', () => $('vfile').click());
    $('vfile').addEventListener('change', e => { sendFiles(e.target.files); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('hot'); }));
    dz.addEventListener('drop', e => { e.stopPropagation(); sendFiles(e.dataTransfer.files); });
    // 채널 이름 위에 놓으면 그 채널 폴더로
    const chips = $('t1Chips');
    chips.addEventListener('dragover', e => { const b = e.target.closest && e.target.closest('button[data-ch]'); if (b && hasFiles(e)) { e.preventDefault(); b.classList.add('t1-dragon'); } });
    chips.addEventListener('dragleave', e => { const b = e.target.closest && e.target.closest('button[data-ch]'); if (b) b.classList.remove('t1-dragon'); });
    chips.addEventListener('drop', e => {
      const b = e.target.closest && e.target.closest('button[data-ch]'); if (!b || !hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation(); b.classList.remove('t1-dragon'); sendFiles(e.dataTransfer.files, b.dataset.ch);
    });
    // 놓친 곳에 떨어뜨려도 브라우저가 영상 파일을 열어 버리지 않게 막는다(감시 중 탭일 때만 보낸다)
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (tab === 't1' && !document.querySelector('.modal.on') && !dz.contains(e.target) && !(e.target.closest && e.target.closest('#t1Chips'))) sendFiles(e.dataTransfer.files);
    });
    // 모달 닫기(Esc·바깥 누름)
    registerModal('t1MBig', closeBig);
    registerModal('t1MText', closeText);
    registerModal('t1MTicket', closeTicket);
    registerModal('t1MProg', closeProg);
    registerModal('t1MCal', () => closeModal('t1MCal'));
    registerModal('t1MPrev', () => closeModal('t1MPrev'));
    registerModal('t1MSay', () => closeModal('t1MSay'));
    registerModal('t1MRecv', () => closeModal('t1MRecv'));
    registerModal('t1MThumb', () => closeModal('t1MThumb'));
    registerModal('t1MAsk', () => askDone(false));
    setInterval(() => {
      tickTimers();
      const up = T1.up;
      if (up && !up.done) $('t1PgEl').textContent = `경과 ${fmtSec((Date.now() - up.startedAt) / 1000)}`;
    }, 1000);
    T1.ready = true;
    paint(s);
  }
  function show() { if (T1.ready) { T1.logSig = ''; } }
  registerTab('t1', { init, paint, show });

  /* ================= 화면 글에서 부르는 이름 (인라인 onclick) ================= */
  Object.assign(window, {
    t1Do: Do, t1Chg: Chg,
    t1Receive: recvStart, t1RecvGo: recvGo, t1CloseRecv: () => closeModal('t1MRecv'),
    t1Refresh: refresh, t1TogglePick: togglePick, t1RunPick: runPick,
    t1CartClear: cartClear, t1SpSave: spSave, t1Spread: spread, t1ClearAt: clearAt,
    t1StartUpload: startUpload, t1TkGo: tkGo, t1TkManyChg: tkManyChg, t1CloseTicket: closeTicket,
    t1OpenProg: openProg, t1CloseProg: closeProg, t1UpStop: upStop,
    t1OpenCal: openCal, t1CloseCal: () => closeModal('t1MCal'),
    t1OpenPreview: openPreview, t1ClosePv: () => closeModal('t1MPrev'),
    t1LoadLog: loadLog, t1Studio: openStudio,
    t1Say: say, t1SayCart: sayCart, t1CloseSay: () => closeModal('t1MSay'),
    t1BigNav: bigNav, t1BigEdit: () => { const it = bigItem(); if (it) { closeBig(); openText(it.file); } },
    t1BigToggle: () => { const it = bigItem(); if (it) { toggleCart(it.file); bigButtons(); } },
    t1CloseBig: closeBig,
    t1TxDirty: txDirty, t1TxAi: txAi, t1TxAiClear: txAiClear, t1TxRevert: txRevert, t1CloseText: closeText, t1TxSave: txSave, t1TxGoSettings: txGoSettings,
    t1CpnPick: cpnPick, t1CpnClear: cpnClear, t1CpnConnect: cpnConnect,
    t1CloseThumb: () => closeModal('t1MThumb'), t1AskDone: askDone,
  });
})();

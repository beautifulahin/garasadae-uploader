/* core.js — 모든 탭이 같이 쓰는 도우미 · 상태 폴링 · 탭 바꾸기 · 확인 창 (메인 소유 — 탭 일꾼은 고치지 않는다)
 *
 * 약속
 *  · 서버와의 약속은 API_명세.md 한 곳. 화면은 /api/state 를 1.5초마다 읽어 그린다(탭이 숨겨지면 멈춤).
 *  · 탭 파일은 registerTab('t1', { init(), paint(s), show() }) 로 자기를 등록한다.
 *      init()  첫 상태를 받은 뒤 딱 한 번
 *      paint(s) 상태가 올 때마다(그 탭이 보이는 동안만; onState 로 늘 받을 수도 있다)
 *      show()  그 탭으로 바뀔 때마다
 *  · 새 색·새 글꼴을 들이지 않는다. 옛 화면의 CSS 변수(--bg --accent --cyan …)와 부품(.card .tb .go .chsel .panel …)만 쓴다.
 */
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsEsc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
const attr = s => esc(s).replace(/`/g, '&#96;');
const fmtSize = b => b > 1073741824 ? (b / 1073741824).toFixed(2) + 'GB' : b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round((b || 0) / 1024)) + 'KB';
const num = v => Number(v || 0).toLocaleString();
const pad2 = n => String(n).padStart(2, '0');
/** 초 → 3:07 / 1:02:09 */
const fmtSec = s => { s = Math.round(Number(s) || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`; };
function shortPath(p) { if (!p) return '-'; const a = p.split(/[/\\]/); return a.length > 2 ? '…/' + a.slice(-2).join('/') : p; }
function baseName(p) { return String(p || '').split(/[/\\]/).pop(); }

/** 서버와 말한다. body 가 없으면 GET, 있으면 POST(JSON). 항상 JSON 을 돌려받는다. */
async function api(path, body) {
  const r = await fetch(path, body !== undefined
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  try { return await r.json(); } catch (_) { return { ok: false, why: `서버가 알 수 없는 답을 보냈습니다 (${r.status})` }; }
}
function ext(u) { window.open(u, '_blank', 'noopener'); }
function cpy(t, ok) {
  navigator.clipboard.writeText(t).then(() => msg(ok || '복사했습니다', 'ok'), () => msg('복사하지 못했습니다. 글자를 직접 선택해 복사해 주세요', 'err'));
}
function msg(t, k) { const e = $('toast'); e.textContent = t; e.className = 'toast show ' + (k || ''); clearTimeout(e._t); e._t = setTimeout(() => e.className = 'toast', 3600); }

/** 영상 종류 알약 */
function kindPill(kind) {
  if (kind === '롱폼') return '<span class="pill kind-l">롱폼</span>';
  if (kind === '쇼츠') return '<span class="pill kind-s">쇼츠</span>';
  return '';
}
/** 2026-10-19T09:00:00 / "2026-10-19 09:00" → "10/19 09:00" */
function mdHm(s) { const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || '')); return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : ''; }
/** 남은 분 → "3시간 12분 뒤" / "5분 뒤" / "⚠ 12분 늦음" */
function leftText(min) { if (min == null) return ''; if (min > 60) return `${Math.floor(min / 60)}시간 ${min % 60}분 뒤`; if (min > 0) return `${min}분 뒤`; return `⚠ ${-min}분 늦음`; }

const setSw = (id, on) => $(id) && $(id).classList.toggle('on', !!on);
const getSw = id => $(id) ? $(id).classList.contains('on') : false;
function tglSw(id) { $(id).classList.toggle('on'); }

/* ================= 탭 ================= */
const TABS = {};
const stateListeners = [];
let ST = null, tab = 't1';
/** 탭 파일이 자기를 등록한다 */
function registerTab(id, o) { TABS[id] = o || {}; }
/** 상태가 올 때마다(어느 탭이 보이든) 받고 싶은 쪽 */
function onState(fn) { stateListeners.push(fn); }
function swTab(id) {
  tab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === id));
  document.querySelectorAll('.tp').forEach(p => p.classList.toggle('on', p.id === id));
  try { TABS[id] && TABS[id].show && TABS[id].show(); } catch (e) { console.error(e); }
  if (ST) try { TABS[id] && TABS[id].paint && TABS[id].paint(ST); } catch (e) { console.error(e); }
}

/* ================= 모달 ================= */
const modalClosers = {};   // id → 닫는 함수. Esc·바깥 누름이 이것을 부른다
function registerModal(id, closeFn) { modalClosers[id] = closeFn; }
function openModal(id) { const m = $(id); if (m) m.classList.add('on'); }
function closeModal(id) { const m = $(id); if (m) m.classList.remove('on'); }
/** 업데이트 설치처럼 닫으면 안 되는 때 */
let modalLocked = () => false;
function lockModals(fn) { modalLocked = fn; }
function dismissTopModal() {
  if (modalLocked()) return false;
  const open = [...document.querySelectorAll('.modal.on')];
  if (!open.length) return false;
  const m = open[open.length - 1];
  const fn = modalClosers[m.id];
  if (fn) fn(); else m.classList.remove('on');
  return true;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') dismissTopModal(); });
document.addEventListener('mousedown', e => { if (e.target.classList && e.target.classList.contains('modal')) dismissTopModal(); });

/**
 * 확인 창 — 위험한 일(올리기·공개·휴지통·삭제·연결 해제) 앞에서 쓴다.
 *   confirmBox({ emoji, title, body(HTML), ok, cancel, danger }) → Promise<boolean>
 * 기존 모달 부품(.modal .modal-box .mbtn)만 쓴다.
 */
function confirmBox(o) {
  return new Promise(res => {
    const id = 'cfm' + Date.now();
    const m = document.createElement('div');
    m.className = 'modal on'; m.id = id;
    m.innerHTML = `<div class="modal-box">
      <div class="modal-emoji">${o.emoji || '❓'}</div>
      <h3>${esc(o.title || '진행할까요?')}</h3>
      ${o.body ? `<div class="modal-desc">${o.body}</div>` : ''}
      <div class="modal-btns">
        <button class="mbtn ghost" data-r="0">${esc(o.cancel || '취소')}</button>
        <button class="mbtn primary" data-r="1" ${o.danger ? 'style="background:var(--accent)"' : ''}>${esc(o.ok || '확인')}</button>
      </div></div>`;
    const done = v => { delete modalClosers[id]; m.remove(); res(v); };
    modalClosers[id] = () => done(false);
    m.querySelectorAll('[data-r]').forEach(b => b.onclick = () => done(b.dataset.r === '1'));
    document.body.appendChild(m);
    const ok = m.querySelector('[data-r="1"]'); if (ok) ok.focus();
  });
}

/* ================= 상태 읽기 ================= */
let wasUpdating = false, lostAt = 0, mouseDown = false, lastPaint = 0, 첫두드림 = true, 물러남 = false;
const 내표 = Math.random().toString(36).slice(2) + Date.now().toString(36);
document.addEventListener('mousedown', () => { mouseDown = true; });
document.addEventListener('mouseup', () => { mouseDown = false; });
/** 사용자가 글자를 고르는 중인가. 이때는 화면을 다시 그리지 않는다. (끌어서 고르는 도중 선택이 지워지던 일 · 2026-08-20) */
function busySelecting() {
  if (mouseDown) return true;
  const s = window.getSelection && window.getSelection();
  if (s && !s.isCollapsed && String(s).trim()) return true;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && (a.selectionStart !== a.selectionEnd)) return true;
  return false;
}
/** 입력칸에 글을 쓰고 있는 중인가 — 이때도 그 영역을 다시 그리지 않는다 */
function typing() { const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'button'); }

async function poll() {
  if (물러남) return;
  try {
    ST = await api('/api/state?tab=' + 내표 + (첫두드림 ? '&claim=1' : ''));
    첫두드림 = false;
    if (ST && ST.owner && ST.owner !== 내표) { 물러나기(); return; }
    if (lostAt) { location.reload(); return; }
    wasUpdating = !!(ST.update && ST.update.running);
    if (busySelecting() && Date.now() - lastPaint < 30000) return;
    lastPaint = Date.now();
    paint();
  } catch (e) {
    $('stTxt').textContent = wasUpdating ? '다시 시작하는 중…' : '앱 연결 끊김';
    $('dot').className = 'dot err';
    if (wasUpdating && !lostAt) lostAt = Date.now();
    stateListeners.forEach(fn => { try { fn(null, e); } catch (_) {} });
  }
}

function paint() {
  const s = ST, chans = s.channels || [];
  const authed = chans.filter(c => c.authed).length;
  // 헤더 상태
  if (!chans.length) { $('dot').className = 'dot err'; $('stTxt').textContent = '채널 없음'; }
  else if (!authed) { $('dot').className = 'dot err'; $('stTxt').textContent = '구글 미연결'; }
  else if (s.locked) { $('dot').className = 'dot err'; $('stTxt').textContent = '잠금 켜짐'; }
  else if (s.paused) { $('dot').className = 'dot'; $('stTxt').textContent = '일시정지'; }
  else { $('dot').className = 'dot on'; $('stTxt').textContent = `채널 ${chans.length}개 · 발사 대기 ${(s.queue || []).length}`; }
  $('pauseBtn').textContent = s.paused ? '▶️ 재개' : '⏸ 일시정지';
  $('lockBtn').textContent = s.locked ? '🔒 잠금 켜짐' : '🔓 잠금 꺼짐';
  $('lockBtn').classList.toggle('login', !!s.locked);
  const ban = !s.night || s.night.ban !== false;
  $('nightBtn').textContent = ban ? '🌙 심야 금지' : '🌙 심야 허용';
  $('nightBtn').classList.toggle('ok', !ban);
  // 쿠팡 파트너스 연결 단추 — 아직이면 눈에 띄게(.login), 연결된 뒤에는 「연결됨 · 바꾸기」(.ok)
  const cp = s.coupang || {};
  $('cpBtn').textContent = cp.connected ? '🛒 쿠팡 파트너스 연결됨 · 바꾸기' : '🛒 쿠팡 파트너스 연결';
  $('cpBtn').className = 'sm ' + (cp.connected ? 'ok' : 'login');
  // 신호등
  const is = s.issues || {}, lv = is.level || 'green', c = is.counts || {};
  $('lamp').className = 'lamp ' + lv;
  $('lampTxt').textContent = lv === 'red' ? `문제 ${c.red || 0}건` : lv === 'yellow' ? `살펴볼 것 ${c.yellow || 0}건` : '이상 없음';

  stateListeners.forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
  const t = TABS[tab];
  if (t && t.paint) { try { t.paint(s); } catch (e) { console.error(e); } }
}

async function togglePause() { const r = await api('/api/pause', { on: !(ST && ST.paused) }); if (r.ok === false) return msg(r.why, 'err'); msg(r.paused ? '예약 쏘기를 멈췄습니다' : '예약 쏘기를 재개합니다'); poll(); }
async function toggleLock() {
  const turnOn = !(ST && ST.locked);
  if (turnOn) {
    const ok = await confirmBox({ emoji: '🔒', title: '올리기를 잠글까요?', body: '잠그면 <b>업로드도 공개도 모두 멈춥니다.</b><br>풀기 전까지 아무것도 밖으로 나가지 않습니다.', ok: '잠그기' });
    if (!ok) return;
  }
  const r = await api('/api/upload/lock', { on: turnOn });
  if (r.ok === false) return msg(r.why, 'err');
  msg(r.locked ? '잠갔습니다 — 아무것도 올라가지 않습니다' : '잠금을 풀었습니다');
  poll();
}
async function toggleNight() {
  const r = await api('/api/night/toggle', {});
  if (r.ok === false) return msg(r.why, 'err');
  msg(r.ban ? '자정~아침 7시에는 쏘지 않습니다' : '밤에도 쏩니다(해외 시청자용)');
  poll();
}

/* ================= 창은 하나만 살려 둔다 ================= */
// ★브라우저는 스크립트가 연 창이 아니면 window.close() 를 막는다. 그래서 ① 먼저 스스로 닫아 보고 ② 그래도 살아 있으면 덮개를 씌운다.
function 물러나기() {
  if (물러남) return;
  물러남 = true;
  try { window.close(); } catch (_) {}
  setTimeout(() => {
    if ($('물러남덮개')) return;
    const d = document.createElement('div');
    d.id = '물러남덮개';
    d.innerHTML = '<div class="속"><h2>다른 창에서 열렸습니다</h2><p>업로더 화면은 한 번에 하나만 씁니다.<br>이 창은 닫으셔도 됩니다.</p><button onclick="다시주인()">여기서 계속 보기</button></div>';
    document.body.appendChild(d);
  }, 300);
}
function 다시주인() { 물러남 = false; 첫두드림 = true; const d = $('물러남덮개'); if (d) d.remove(); poll(); }
function isWithdrawn() { return 물러남; }

/* ================= 소리 (올리기 시작 때 찰칵 — 옛 화면과 같은 느낌) ================= */
function chalkak() {
  try {
    const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
    const ctx = new A(), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(1100, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(380, ctx.currentTime + 0.07);
    g.gain.setValueAtTime(0.08, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.1);
  } catch (_) {}
}

/** 숨겨진 탭(브라우저 탭)은 서버를 두드리지 않는다 */
function visibleNow() { return document.visibilityState !== 'hidden'; }

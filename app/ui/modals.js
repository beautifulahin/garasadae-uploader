/* modals.js — 공통 모달: 첫 갈림길 · 업데이트 · 자동 실행 · 서버가 묻는 일 · AI+쿠팡 열쇠 창 · 옛 판 이행 띠
 *
 * 한 번에 모달 하나만 띄운다. 우선순위: 업데이트 설치 중 > 열쇠 창(열어 둔 동안) > 첫 갈림길 > 업데이트 확인 > 자동 실행 질문 > 일반 질문 > 열쇠 창(처음 켠 사람).
 * 상태(ST)가 올 때마다 「지금 무엇을 보여야 하나」를 다시 정한다(onState). 닫은 것은 이번 접속 동안 다시 묻지 않는다.
 *
 * 서버와의 약속(API_명세.md)
 *   ST.mode === null            → 첫 갈림길 · POST /api/mode/set {m}
 *   ST.update {available,version,notes,running,pct}  (+ 있으면 쓴다: current page text error canInstall reason prompt{show,second})
 *   ST.ask {id,title,body,choices:[{id,label,primary}]}  → POST /api/ask/answer {id, choice}
 *   자동 실행 질문: ST.askAutoStart(옛 방식) 또는 id 가 auto 로 시작하는 ST.ask
 *   POST /api/update/check | decline {version} | install · POST /api/autostart {on, asked}
 *   옛 판 자료 이행: ST.migrate {hold,backupDir,missing,reasons,oldChannels,newChannels,at} → 화면 맨 위 빨간 띠 ·
 *     POST /api/migrate/retry {} | accept {confirm:true}
 *   열쇠 창(AI + 쿠팡 파트너스, 한 창 두 구역): ST.ai {enabled,hasKey,model,needsKey,connected,needsPrompt} · ST.coupang {connected,enabled,needsPrompt,usage,warn}
 *     창을 열 때마다 POST /api/finder/scan {} 로 이 컴퓨터에 있는 열쇠를 찾아(읽기만) 목록으로 보이고, 고르면 POST /api/finder/use {kind,id}.
 *     직접 입력: POST /api/ai/connect {key,model?} · /api/coupang/connect {accessKey,secretKey} · 해제: /api/ai/disconnect · /api/coupang/disconnect
 *     닫기: POST /api/prompt/later {} (AI·쿠팡 둘 다 「봤다」). needsPrompt 가 처음 true 가 되면 세션당 한 번만 띄운다.
 *     전역 함수 openAi() · openCoupang() 을 내보낸다 — 같은 창을 열되 해당 구역이 위로 온다. 헤더의 ✨ AI 연결 단추(#aiBtn)는 없으면 여기서 만든다.
 */
'use strict';
(() => {
  const RELEASES = 'https://github.com/beautifulahin/garasadae-uploader/releases/latest';
  const ALL = ['modeModal', 'upModal', 'autoModal', 'askModal', 'keyModal'];

  let upSkipped = '';            // 이번 접속에서 닫은 버전 — 다시 묻지 않는다
  let forkDismissed = false;     // 갈림길을 고르지 않고 닫았다
  let autoDone = false;          // 자동 실행 질문에 답했거나 닫았다
  let askDismissedId = '';       // 나중에 답하겠다고 닫은 질문
  let askShownId = '';           // 지금 화면에 그려 둔 질문
  let cur = '';                  // 지금 보이는 것: up-run | up-ask | mode | auto | ask | key | ''
  let wasUpdating = false, lostAt = 0;
  let keySeenMem = false;        // 열쇠 창을 이번 세션에 띄웠다(저장소를 못 쓰는 환경 대비)

  /** 서버가 끊겨도 던지지 않는다 — 눌러서 한 일은 이유를 보여 준다 */
  async function call(path, body) {
    try { return await api(path, body === undefined ? {} : body); }
    catch (_) { return { ok: false, why: '앱과 연결되지 않았습니다. 잠시 뒤 다시 시도해 주세요' }; }
  }
  const isAutoAsk = a => !!(a && a.id && /^auto/i.test(String(a.id)));
  const notesText = n => Array.isArray(n) ? n.map(x => String(x)).filter(Boolean).join('\n') : String(n || '');
  const verLine = u => u.current && u.version ? `${u.current} → ${u.version}` : (u.version ? `새 버전 ${u.version}` : '');

  /* ---------------- 업데이트 ---------------- */
  function upShowRun(u) {
    $('upTitle').textContent = '업데이트 하는 중입니다';
    $('upDesc').innerHTML = '새 버전을 받아서 교체하고 있습니다. 끝나면 저절로 다시 시작합니다.<br><b>설정과 로그인은 그대로 유지됩니다.</b> 잠시만 기다려 주세요.';
    $('upVer').textContent = verLine(u);
    $('upNotes').style.display = 'none';
    $('upProg').style.display = 'block'; $('upBtns').style.display = 'none'; $('upRemember').style.display = 'none';
    const pct = Math.max(0, Math.min(100, Math.round(Number(u.pct) || 0)));
    $('upBar').style.width = pct + '%'; $('upPct').textContent = pct + '%'; $('upText').textContent = u.text || '받아서 교체하는 중…';
    try { if (u.version) localStorage.setItem('justUpdatedTo', u.version); } catch (_) {}
  }
  function upShowAsk(u) {
    const second = !!(u.prompt && typeof u.prompt === 'object' && u.prompt.second);
    const manual = u.canInstall === false;     // 앱이 스스로 못 바꾸는 상태 — 내려받는 곳을 열어 준다
    $('upTitle').textContent = second ? '업데이트 받으시겠습니까?' : '업데이트 하시겠습니까?';
    if (manual) {
      $('upDesc').innerHTML = '새 버전이 나왔습니다.' + (u.reason ? '<br>' + esc(u.reason) : '') + '<br>아래 버튼으로 내려받는 곳을 열어 주세요.';
    } else if (second) {
      $('upDesc').innerHTML = '앞서 취소하셨습니다. 새 버전에는 오류 수정과 새 기능이 들어 있습니다.<br><b>이번에도 아니오를 누르시면 이 버전은 다시 묻지 않습니다.</b>';
    } else {
      $('upDesc').innerHTML = '새 버전이 나왔습니다. 확인을 누르면 프로그램이 알아서 받아서<br>교체하고 다시 시작합니다. <b>설정과 로그인은 그대로 유지됩니다.</b>';
    }
    $('upNo').textContent = second ? '아니오' : '취소';
    $('upYes').textContent = manual ? '내려받으러 가기' : (second ? '예' : '확인');
    $('upVer').textContent = verLine(u);
    const txt = notesText(u.notes), n = $('upNotes');
    if (txt) { n.textContent = txt; n.style.display = ''; } else n.style.display = 'none';
    $('upProg').style.display = 'none'; $('upBtns').style.display = 'flex'; $('upRemember').style.display = '';
  }
  // 서버의 prompt 는 불린이다(두 번 거절한 버전은 false = 다시 묻지 않음). 객체 {show, second} 로 오는 옛 모양도 받는다.
  const promptOff = u => u.prompt === false || !!(u.prompt && typeof u.prompt === 'object' && u.prompt.show === false);
  const upWantsConfirm = u => !!(u && u.available && u.version && u.version !== upSkipped && u.show !== false && !promptOff(u));

  let upErrSeen = '';
  /** 업데이트가 실패하면(error 가 생기면) 한 번 알린다 */
  function upErrPaint(u) {
    const e = String((u && u.error) || '');
    if (e && e !== upErrSeen) { upErrSeen = e; msg('업데이트 실패: ' + e, 'err'); }
    if (!e) upErrSeen = '';
  }

  window.moCloseUp = async () => {
    const u = ST && ST.update;
    if (u && u.version) upSkipped = u.version;
    closeModal('upModal'); cur = '';
    const r = await call('/api/update/decline', { version: u ? u.version : '' });
    if (r && r.times >= 2) msg('이 버전은 다시 묻지 않습니다. 설정 탭에서 언제든 받으실 수 있습니다');
    poll();
  };
  window.moDoUpdate = async () => {
    const u = (ST && ST.update) || {};
    if (u.canInstall === false) { ext(u.page || RELEASES); return; }
    try { localStorage.setItem('justUpdatedTo', u.version || ''); } catch (_) {}
    $('upProg').style.display = 'block'; $('upBtns').style.display = 'none'; $('upRemember').style.display = 'none';
    $('upText').textContent = '준비 중…';
    const r = await call('/api/update/install', {});
    if (r.ok === false) {
      $('upProg').style.display = 'none'; $('upBtns').style.display = 'flex'; $('upRemember').style.display = '';
      msg(r.why || r.error || '업데이트하지 못했습니다', 'err');
      if (r.page) ext(r.page);
    }
  };
  window.moUpPage = () => ext((ST && ST.update && ST.update.page) || RELEASES);
  /** 설정 탭의 「새 버전 확인」 */
  window.checkUp = async () => {
    msg('새 버전을 확인하는 중…');
    const u = await call('/api/update/check', {});
    if (u.ok === false) return msg(u.why || '확인하지 못했습니다', 'err');
    if (u.available) { upSkipped = ''; msg(`새 버전이 있습니다 (${u.version})`, 'ok'); poll(); }
    else msg('최신 버전을 쓰고 계십니다', 'ok');
  };

  /* ---------------- 첫 갈림길 ---------------- */
  window.moPickMode = async m => {
    const r = await call('/api/mode/set', { m });
    if (r.ok === false) return msg(r.why || '저장하지 못했습니다', 'err');
    forkDismissed = true;                      // 다음 상태가 올 때까지 다시 뜨지 않게 (mode 가 채워지면 되돌린다)
    closeModal('modeModal'); cur = '';
    msg(m === 'agency' ? '대행 관리자로 시작합니다' : '채널 소유주로 시작합니다', 'ok');
    poll();
  };
  /** 설정 탭에서 「다시 고르기」를 눌렀을 때 */
  window.moReopenMode = () => { forkDismissed = false; poll(); };

  /* ---------------- 자동 실행 ---------------- */
  const autoWanted = s => !autoDone && (!!s.askAutoStart || (isAutoAsk(s.ask) && s.ask.id !== askDismissedId));
  window.moAnswerAuto = async on => {
    autoDone = true;
    closeModal('autoModal'); cur = '';
    const a = ST && ST.ask;
    let r;
    if (isAutoAsk(a)) {
      const ch = a.choices || [];
      const yes = ch.find(c => c.primary) || ch[0], no = ch.find(c => c !== yes);
      const pick = on ? yes : no;
      askDismissedId = a.id;
      r = await call('/api/ask/answer', { id: a.id, choice: pick ? pick.id : (on ? 'yes' : 'no') });
    } else {
      r = await call('/api/autostart', { on: !!on, asked: true });
    }
    if (r.ok === false) msg(r.why || '저장하지 못했습니다', 'err');
    else msg(on ? '컴퓨터를 켤 때 자동으로 실행됩니다' : '자동 실행을 켜지 않았습니다. 설정에서 바꿀 수 있습니다', on ? 'ok' : '');
    poll();
  };

  /* ---------------- 서버가 묻는 일 ---------------- */
  const askWanted = s => !!(s.ask && s.ask.id && s.ask.id !== askDismissedId && !isAutoAsk(s.ask));
  function askRender(a) {
    askShownId = a.id;
    $('askEmoji').textContent = a.emoji || '❓';
    $('askTitle').textContent = a.title || '';
    $('askBody').innerHTML = esc(a.body || '').replace(/\n/g, '<br>');
    const box = $('askBtns'); box.innerHTML = '';
    const choices = (a.choices && a.choices.length) ? a.choices : [{ id: 'ok', label: '확인', primary: true }];
    choices.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mbtn ' + (c.primary ? 'primary' : 'ghost');
      b.textContent = c.label || c.id;
      b.onclick = async () => {
        askDismissedId = a.id; closeModal('askModal'); cur = '';
        const r = await call('/api/ask/answer', { id: a.id, choice: c.id });
        if (r.ok === false) msg(r.why || '답을 저장하지 못했습니다', 'err');
        poll();
      };
      box.appendChild(b);
    });
  }

  /* ---------------- 🔑 AI·쿠팡 파트너스 연결 — 한 창, 두 구역 ---------------- */
  const KEY_SEEN = 'keyPrompted';
  const keySeen = () => { try { return sessionStorage.getItem(KEY_SEEN) === '1'; } catch (_) { return keySeenMem; } };
  const keyMarkSeen = () => { keySeenMem = true; try { sessionStorage.setItem(KEY_SEEN, '1'); } catch (_) {} };
  /** 우리 모달이 아닌 것(확인 창·연결 창·알림 팝업 같은)이 떠 있나 */
  const foreignOpen = () => [...document.querySelectorAll('.modal.on')].some(m => !ALL.includes(m.id));
  const isOn = id => { const m = $(id); return !!(m && m.classList.contains('on')); };
  const val = id => ($(id) ? $(id).value.trim() : '');

  // 구역마다: 열려 있나 · 찾는 중인가 · 찾은 열쇠들(Found) · 고른 것 · 오류 · 시험 중인가
  const mk = () => ({ open: true, scanning: false, scanned: false, scanErr: '', found: [], sel: '', err: '', busy: false, just: 0, gone: 0 });
  const KY = { ai: mk(), coupang: mk() };
  const K_OF = { ai: 'Ai', coupang: 'Cp' };
  let keyTop = 'ai';
  const scanSeqs = { ai: 0, coupang: 0 };     // 구역마다 따로 센다 — 한쪽을 다시 찾아도 다른 쪽의 답이 버려지지 않게
  const NAME = { ai: 'AI', coupang: '쿠팡 파트너스' };
  const HELP_LINK = { ai: 'https://aistudio.google.com/apikey', coupang: 'https://partners.coupang.com/' };
  const RECENT = 20000;          // 방금 연결/해제한 구역은 서버 상태가 따라올 때까지 이 시간 동안 우리 쪽 결과를 믿는다

  const stateConn = k => {
    if (k === 'ai') { const a = (ST && ST.ai) || {}; return a.connected !== undefined ? !!a.connected : !!(a.enabled && a.hasKey); }
    return !!((ST && ST.coupang) || {}).connected;
  };
  const isConn = k => {
    const st = KY[k];
    if (Date.now() - st.just < RECENT) return true;
    if (Date.now() - st.gone < RECENT) return false;
    return stateConn(k);
  };
  const anyBusy = () => KY.ai.busy || KY.coupang.busy;
  const keyAutoWanted = s => !!((s.ai && s.ai.needsPrompt) || (s.coupang && s.coupang.needsPrompt)) && !keySeen() && !foreignOpen();

  function secHtml(k) {
    const K = K_OF[k], ai = k === 'ai';
    const field = (id, label, ph, extra = '') => `<label class="flabel" for="${id}"${extra}>${label}</label>
      <input class="fin" id="${id}" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore placeholder="${ph}"/>`;
    return `<div class="mo-sec-h"><b>${ai ? '✨ AI 연결' : '🛒 쿠팡 파트너스 연결'}</b> <span class="chbadge" id="ky${K}Chip">-</span><span class="mo-sp"></span>
        <button type="button" class="mlink" id="ky${K}Tog" onclick="moKeyToggle('${k}')">펼치기</button></div>
      <div class="mo-sec-b" id="ky${K}Body">
        <p class="mo-help">${ai
          ? '<b>구글 AI 스튜디오 열쇠</b> 한 개면 됩니다(무료). 쪽지·직접 쓴 문안이 없는 영상은 올리기 직전에 영상 내용과 채널 말투를 보고 <b>제목·설명·해시태그</b>를 자동으로 지어 넣습니다. 연결하면 자동 문안이 바로 켜집니다.'
          : '<b>쿠팡 파트너스 열쇠(Access Key·Secret Key)</b>를 넣으면 올리는 영상마다 <b>소재에 맞는 상품 링크</b>가 설명 끝에 자동으로 붙고, <b>수수료는 내 계정</b>으로 들어갑니다. 관련 상품이 없으면(정치·뉴스 등) 억지로 붙이지 않습니다.'}</p>
        <div class="mo-find" id="ky${K}Find"></div>
        <div class="mo-form">${ai
          ? field('kyAiKey', '구글 AI 스튜디오 열쇠', 'AIza…') + `<label class="flabel" for="kyAiModel" style="margin-top:10px">모델 <span style="font-weight:400;color:var(--t3)">(비우면 기본)</span></label>
            <input class="fin" id="kyAiModel" autocomplete="off" spellcheck="false" placeholder="비우면 기본 모델을 씁니다"/>`
          : field('kyCpAccess', 'Access Key', '파트너스 사이트에서 받은 Access Key') + field('kyCpSecret', 'Secret Key', '파트너스 사이트에서 받은 Secret Key', ' style="margin-top:10px"')}</div>
        <div class="mo-err" id="ky${K}Err" role="alert" style="display:none"></div>
        <div class="mo-acts">
          <button type="button" class="tb on" onclick="ext('${HELP_LINK[k]}')">🔗 ${ai ? '열쇠 받으러 가기' : '가입·열쇠 받는 곳 열기'}</button>
          <button type="button" class="mbtn primary" id="ky${K}Save" onclick="moKeySave('${k}')">연결 시험 후 저장</button>
        </div>
        <div class="mo-off" id="ky${K}OffRow"><button type="button" class="mlink" onclick="moKeyOff('${k}')">연결 해제 (저장된 열쇠 지우기)</button></div>
      </div>`;
  }
  // 뼈대는 한 번만 만든다 — 입력칸은 폴링이 다시 그리지 않는다
  $('kyAi').innerHTML = secHtml('ai');
  $('kyCp').innerHTML = secHtml('coupang');

  function setErr(k, t) { const e = $('ky' + K_OF[k] + 'Err'); e.textContent = t || ''; e.style.display = t ? '' : 'none'; KY[k].err = t || ''; }

  /** 구역 머리(연결 여부 알약·펼침·단추 글·자리). 입력칸은 건드리지 않는다 */
  function keyPaintHead(k) {
    const K = K_OF[k], st = KY[k], on = isConn(k);
    const chip = $('ky' + K + 'Chip');
    chip.textContent = on ? '✅ 연결됨' : '아직 연결 안 됨';
    chip.className = 'chbadge ' + (on ? 'ok' : 'full');
    $('ky' + K + 'Body').classList.toggle('hide', !st.open);
    $('ky' + K + 'Tog').textContent = st.open ? '접기' : (on ? '바꾸기' : '펼치기');
    $('ky' + K + 'Save').textContent = on ? '연결 시험 후 바꾸기' : '연결 시험 후 저장';
    $('ky' + K + 'OffRow').style.display = on ? '' : 'none';
    const keys = k === 'ai' ? ['kyAiKey'] : ['kyCpAccess', 'kyCpSecret'];
    keys.forEach((id, i) => {
      $(id).placeholder = on ? `저장됨 — 바꾸려면 새 ${k === 'ai' ? '열쇠' : (i ? 'Secret Key' : 'Access Key')} 를 넣으세요`
        : (k === 'ai' ? 'AIza…' : (i ? '파트너스 사이트에서 받은 Secret Key' : '파트너스 사이트에서 받은 Access Key'));
    });
    $('ky' + K).style.order = k === keyTop ? '0' : '1';
    $('ky' + K).classList.toggle('mo-sec-on', on);
  }
  function keyPaintAll() {
    keyPaintHead('ai'); keyPaintHead('coupang');
    const all = isConn('ai') && isConn('coupang');
    $('kyLater').textContent = all ? '닫기' : '나중에';
  }

  /** 「이 컴퓨터에서 찾은 열쇠」 — 열쇠 전체 값은 오지 않는다(가린 모습 masked 와 찾은 자리 where 만) */
  function keyPaintFind(k) {
    const K = K_OF[k], st = KY[k], box = $('ky' + K + 'Find');
    const head = '<div class="mo-find-h">🔍 이 컴퓨터에서 찾은 열쇠</div>';
    const again = `<button type="button" class="tb" ${st.scanning ? 'disabled' : ''} onclick="moKeyScan('${k}')">🔄 다시 찾기</button>`;
    const guide = k === 'ai'
      ? '구글 AI 스튜디오에서 무료 열쇠를 받아 아래 칸에 붙여넣으세요.'
      : '쿠팡 파트너스(partners.coupang.com)에 가입해 승인을 받은 뒤 <b>마케팅 도구 → 오픈 API</b> 에서 Access Key·Secret Key 를 받아 아래 칸에 넣으세요.';
    let h;
    if (st.scanning) {
      h = head + '<div class="mo-find-m"><span class="pulse">찾는 중…</span> 찾은 열쇠를 하나씩 시험하느라 최대 15초씩 걸릴 수 있습니다.</div>';
    } else if (st.scanErr) {
      h = head + `<div class="mo-find-m" style="color:var(--accent)">찾지 못했습니다 — ${esc(st.scanErr)}</div><div class="mo-acts">${again}</div>`;
    } else if (!st.scanned) {
      h = '';
    } else if (!st.found.length) {
      h = head + `<div class="mo-find-m">이 컴퓨터에서 찾은 열쇠가 없습니다. ${guide}</div><div class="mo-acts">${again}</div>`;
    } else {
      const rows = st.found.map(f => {
        const t = f.test, on = f.id === st.sel;
        const res = !t ? '<span class="mo-ft">시험하지 않았습니다</span>'
          : t.ok ? `<span class="mo-ft ok">✓ 통과${t.message ? ' — ' + esc(t.message) : ''}</span>`
            : `<span class="mo-ft bad">✗ ${esc(t.message || '시험에 통과하지 못했습니다')}</span>`;
        return `<label class="mo-fr${on ? ' on' : ''}"><input type="radio" name="kyPick${K}" value="${attr(f.id)}"${on ? ' checked' : ''} onchange="moKeyPick('${k}',this.value)"/>
          <span class="mo-fb"><span class="mo-fm">${esc(f.masked || '(가려진 열쇠)')}</span>
          <span class="mo-fw">찾은 자리: ${esc((f.where || []).join(' · ') || '알 수 없음')}</span>${res}</span></label>`;
      }).join('');
      h = head + rows + `<div class="mo-acts"><button type="button" class="mbtn primary" id="ky${K}Use" ${st.sel ? '' : 'disabled'} onclick="moKeyUse('${k}')">이걸로 쓰기</button>${again}</div>`
        + `<div class="mo-find-m" style="margin-top:6px">${st.sel ? '고른 열쇠를 저장 직전에 한 번 더 시험합니다. 저장은 「이걸로 쓰기」를 눌러야 됩니다.' : '쓸 열쇠를 고른 뒤 「이걸로 쓰기」를 누르세요. 못 쓰는 열쇠뿐이면 아래 칸에 직접 넣으세요.'}</div>`;
    }
    box.innerHTML = h;
    box.classList.toggle('hide', !h);
  }

  /** 찾기: 창을 열 때만 부른다(서버가 켜질 때나 뒤에서 몰래 찾지 않는다). 여러 번 눌러도 마지막 답만 쓴다 */
  window.moKeyScan = async kind => {
    const kinds = kind === 'ai' || kind === 'coupang' ? [kind] : ['ai', 'coupang'];
    const my = {}; kinds.forEach(k => { my[k] = ++scanSeqs[k]; });
    kinds.forEach(k => { const st = KY[k]; st.scanning = true; st.scanErr = ''; keyPaintFind(k); });
    const r = await call('/api/finder/scan', kinds.length === 1 ? { kind: kinds[0] } : {});
    // 더 새 찾기가 있거나 창이 닫힌 구역의 답은 버린다(순번이 달라졌다) — 나머지 구역은 그대로 쓴다
    kinds.filter(k => my[k] === scanSeqs[k]).forEach(k => {
      const st = KY[k]; st.scanning = false; st.scanned = true;
      if (r.ok === false) { st.scanErr = r.why || '알 수 없는 문제'; st.found = []; st.sel = ''; }
      else {
        st.found = Array.isArray(r[k]) ? r[k].filter(f => f && f.id) : [];
        const first = st.found.find(f => f.test && f.test.ok);   // 통과한 첫 줄을 기본으로 — 저장은 사람이 누른다
        st.sel = first ? first.id : '';
      }
      keyPaintFind(k);
    });
  };
  window.moKeyPick = (k, id) => {
    KY[k].sel = id;
    const K = K_OF[k];
    document.querySelectorAll(`#ky${K}Find .mo-fr`).forEach(r => r.classList.toggle('on', r.querySelector('input').value === id));
    const b = $('ky' + K + 'Use'); if (b) b.disabled = false;
  };

  window.moKeyToggle = k => { KY[k].open = !KY[k].open; keyPaintHead(k); };

  /** 연결에 성공한 뒤: 구역을 「연결됨」으로 접고, 둘 다 연결됐으면 창을 닫는다 */
  async function afterConnect(k) {
    const st = KY[k];
    st.just = Date.now(); st.gone = 0; st.open = false; st.found = []; st.scanned = false; st.sel = ''; setErr(k, '');
    ['kyAiKey', 'kyAiModel', 'kyCpAccess', 'kyCpSecret'].forEach(id => { if (k === (id.startsWith('kyAi') ? 'ai' : 'coupang')) $(id).value = ''; });
    keyPaintFind(k);
    msg(k === 'ai'
      ? '연결됐습니다 — 이제 문안이 없는 영상은 올리기 직전에 제목·설명·해시태그를 자동으로 지어 넣습니다. 채널별로 끄려면 채널 탭에서'
      : '연결됐습니다 — 이제 올리는 영상마다 소재에 맞는 상품 링크가 설명 끝에 자동으로 붙습니다. 채널별로 끄려면 설정에서', 'ok');
    await poll();
    keyPaintAll();
    if (isConn('ai') && isConn('coupang')) { scanSeqs.ai++; scanSeqs.coupang++; closeModal('keyModal'); cur = ''; }
  }
  function busy(k, on, label) {
    const K = K_OF[k], st = KY[k]; st.busy = on;
    const b = $('ky' + K + 'Save'); if (b) { if (on) { b.dataset.t0 = b.textContent; b.textContent = label || '시험하는 중…'; } else if (b.dataset.t0) { b.textContent = b.dataset.t0; delete b.dataset.t0; } b.disabled = on; }
    const u = $('ky' + K + 'Use'); if (u) u.disabled = on || !st.sel;
    $('kyLater').disabled = anyBusy();
  }
  /** 찾은 열쇠 쓰기 — 서버가 저장 직전에 한 번 더 시험한다 */
  window.moKeyUse = async k => {
    const st = KY[k]; if (st.busy || !st.sel) return;
    setErr(k, ''); busy(k, true, '시험하는 중…');
    const r = await call('/api/finder/use', { kind: k, id: st.sel });
    busy(k, false);
    if (r.ok === false) return setErr(k, r.why || '이 열쇠로 연결하지 못했습니다. 다시 찾기를 눌러 보세요');   // 저장되지 않았다
    await afterConnect(k);
  };
  /** 직접 입력한 열쇠 — 연결 시험에 통과해야 저장된다 */
  window.moKeySave = async k => {
    const st = KY[k]; if (st.busy) return;
    let path, body;
    if (k === 'ai') {
      const key = val('kyAiKey'), model = val('kyAiModel');
      if (!key) return setErr(k, 'AI 스튜디오 열쇠를 넣어 주세요');
      path = '/api/ai/connect'; body = model ? { key, model } : { key };
    } else {
      const accessKey = val('kyCpAccess'), secretKey = val('kyCpSecret');
      if (!accessKey || !secretKey) return setErr(k, 'Access Key 와 Secret Key 를 둘 다 넣어 주세요');
      path = '/api/coupang/connect'; body = { accessKey, secretKey };
    }
    setErr(k, ''); busy(k, true);
    const r = await call(path, body);
    busy(k, false);
    if (r.ok === false) return setErr(k, r.why || '연결하지 못했습니다. 열쇠를 다시 확인해 주세요');   // 저장되지 않았다 — 창을 닫지 않는다
    await afterConnect(k);
  };
  window.moKeyOff = async k => {
    if (KY[k].busy) return;
    const ai = k === 'ai';
    const ok = await confirmBox({
      emoji: ai ? '✨' : '🛒', title: ai ? 'AI 연결을 끊을까요?' : '쿠팡 파트너스 연결을 끊을까요?', danger: true, ok: '연결 해제',
      body: ai ? '이 컴퓨터에 저장된 <b>AI 열쇠를 지우고</b> 자동 문안을 끕니다.<br>이미 올린 영상은 그대로이고, 문안이 없는 영상은 파일 이름이 제목으로 올라갑니다. 다시 쓰려면 열쇠를 새로 넣어야 합니다.'
        : '이 컴퓨터에 저장된 <b>열쇠를 지우고</b> 자동 링크를 끕니다.<br>이미 올린 영상의 설명은 그대로입니다. 다시 쓰려면 열쇠를 새로 넣어야 합니다.',
    });
    if (!ok) return;
    const r = await call(ai ? '/api/ai/disconnect' : '/api/coupang/disconnect', {});
    if (r.ok === false) return msg(r.why || '연결을 끊지 못했습니다', 'err');
    const st = KY[k]; st.gone = Date.now(); st.just = 0; st.open = true;
    msg(ai ? 'AI 연결을 해제했습니다' : '쿠팡 파트너스 연결을 해제했습니다');
    keyPaintAll(); poll();
  };

  /** 창을 열 때마다 처음 모양으로 — 열쇠 값은 서버가 돌려주지 않으므로 입력칸은 늘 빈칸이다 */
  function keyPrepare(top) {
    keyTop = top || 'ai';
    ['ai', 'coupang'].forEach(k => {
      const st = KY[k];
      Object.assign(st, { scanning: false, scanned: false, scanErr: '', found: [], sel: '', err: '', busy: false });
      st.open = !isConn(k) || k === top;                         // 연결된 구역은 접어 둔다(헤더에서 그 구역을 눌렀을 때만 펼친다)
      setErr(k, '');
    });
    ['kyAiKey', 'kyAiModel', 'kyCpAccess', 'kyCpSecret'].forEach(id => { $(id).value = ''; });
    $('kyLater').disabled = false;
    keyPaintAll();
    keyPaintFind('ai'); keyPaintFind('coupang');
    const first = $(keyTop === 'ai' ? 'kyAiKey' : 'kyCpAccess');
    setTimeout(() => { try { if (KY[keyTop].open) first.focus(); } catch (_) {} }, 80);
    moKeyScan('all');                                            // 창을 열 때 한 번 — 이 컴퓨터에 이미 있는 열쇠를 찾는다
  }
  /** 닫는 모든 길(나중에 · X · Esc · 바깥 누름). 연결 안 된 구역이 있으면 「다시 자동으로 안 띄움」을 서버에 알린다 */
  async function keyDismiss() {
    if (anyBusy()) return;                                       // 시험하는 동안에는 닫지 않는다
    const need = !isConn('ai') || !isConn('coupang');
    ['kyAiKey', 'kyAiModel', 'kyCpAccess', 'kyCpSecret'].forEach(id => { $(id).value = ''; });
    scanSeqs.ai++; scanSeqs.coupang++;                           // 늦게 오는 찾기 답은 버린다
    closeModal('keyModal'); cur = '';
    if (need) { await call('/api/prompt/later', {}); poll(); }
  }
  window.moKeyClose = () => keyDismiss();
  /** 헤더 단추·설정 탭·시작하기가 부른다 — 같은 창, 해당 구역이 위로 */
  function keyEntry(top) {
    if (ST && ST.update && ST.update.running) return;            // 업데이트를 받는 동안에는 다른 창을 열지 않는다
    if (cur === 'key' && isOn('keyModal')) {                     // 이미 열려 있으면 그 구역을 위로 올리고 펼친다
      keyTop = top; KY[top].open = true; keyPaintAll();
      try { $(top === 'ai' ? 'kyAiKey' : 'kyCpAccess').focus(); } catch (_) {}
      return;
    }
    apply('key', ST || {}, top);
  }
  window.openAi = () => keyEntry('ai');
  window.openCoupang = () => keyEntry('coupang');

  /** 헤더의 ✨ AI 연결 단추 — ui.html 에 없으면 쿠팡 단추 옆에 만든다(있으면 그대로 쓴다).
   *  첫 상태가 오기 전, 이 파일이 불리는 즉시 만든다 — core.js 가 #aiBtn 을 칠하려 해도 비어 있지 않게 */
  function ensureAiBtn() {
    let b = $('aiBtn');
    if (b) return b;
    const cp = $('cpBtn'); if (!cp || !cp.parentNode) return null;
    b = document.createElement('button');
    b.type = 'button'; b.id = 'aiBtn'; b.className = 'sm login';
    b.title = '구글 AI 스튜디오 열쇠를 넣으면 올리기 직전에 제목·설명·해시태그를 자동으로 지어 넣습니다';
    b.textContent = '✨ AI 연결';
    b.onclick = () => window.openAi();
    cp.parentNode.insertBefore(b, cp.nextSibling);
    return b;
  }
  function paintAiBtn(s) {
    const b = ensureAiBtn(); if (!b) return;
    const a = s.ai || {}, on = a.connected !== undefined ? !!a.connected : !!(a.enabled && a.hasKey);
    b.textContent = on ? '✨ AI 연결됨 · 바꾸기' : '✨ AI 연결';
    b.className = 'sm ' + (on ? 'ok' : 'login');
  }
  ensureAiBtn();

  /* ---------------- 무엇을 보일지 정한다 ---------------- */
  function decide(s) {
    const u = s.update || {};
    if (u.running) return 'up-run';
    // 열쇠 창은 한 번 열면 닫을 때까지 다른 모달이 끼어들지 않는다 — 열쇠를 치는 중에 사라지면 안 된다
    if (cur === 'key' && isOn('keyModal')) return 'key';
    if (s.mode === null) { if (!forkDismissed) return 'mode'; }
    else forkDismissed = false;              // 고른 값이 채워졌다 — 다음에 비면 다시 묻는다
    if (upWantsConfirm(u)) return 'up-ask';
    if (autoWanted(s)) return 'auto';
    if (askWanted(s)) return 'ask';
    if (keyAutoWanted(s)) return 'key';      // 가장 낮은 차례 — 다른 모달이 닫힌 뒤에, 세션당 한 번
    return '';
  }
  const ID_OF = { 'up-run': 'upModal', 'up-ask': 'upModal', mode: 'modeModal', auto: 'autoModal', ask: 'askModal', key: 'keyModal' };
  function apply(want, s, top) {
    const target = ID_OF[want] || '';
    ALL.forEach(id => { if (id !== target) closeModal(id); });
    if (!target) { cur = ''; return; }
    if (want === 'up-run') upShowRun(s.update);
    else if (want === 'up-ask') { if (cur !== 'up-ask') upShowAsk(s.update); }          // 읽는 중에 다시 쓰지 않는다
    else if (want === 'ask') { if (cur !== 'ask' || askShownId !== s.ask.id) askRender(s.ask); }
    else if (want === 'key') {
      if (cur !== 'key') {
        // top 이 없으면 처음 켠 사람에게 자동으로 띄우는 경우 — 아직 안 본 쪽을 위로
        keyPrepare(top || (s.ai && s.ai.needsPrompt ? 'ai' : (s.coupang && s.coupang.needsPrompt ? 'coupang' : 'ai')));
        keyMarkSeen();
      }
    }
    openModal(target);
    cur = want;
  }

  /** 서버가 끊겼다. 업데이트 중이었다면 「다시 켜는 중」을 보여 준다(core 가 돌아오면 새로고침한다) */
  function lostPaint() {
    if (!wasUpdating) return;
    if (!lostAt) lostAt = Date.now();
    ALL.forEach(id => { if (id !== 'upModal') closeModal(id); });
    $('upTitle').textContent = '업데이트 하는 중입니다';
    $('upDesc').innerHTML = '새 버전으로 교체했습니다. 프로그램이 다시 켜지는 중입니다.<br><b>설정과 로그인은 그대로 유지됩니다.</b>';
    $('upNotes').style.display = 'none';
    $('upProg').style.display = 'block'; $('upBtns').style.display = 'none'; $('upRemember').style.display = 'none';
    $('upBar').style.width = '100%'; $('upPct').textContent = '100%';
    $('upText').textContent = (Date.now() - lostAt > 45000)
      ? '자동으로 다시 켜지지 않았습니다. 프로그램을 직접 실행해 주세요.'
      : '교체 완료 — 프로그램을 다시 켜는 중입니다…';
    openModal('upModal'); cur = 'up-run';
  }

  /* ---------------- ⛔ 옛 판 자료를 옮기다 멈춘 상태 (ST.migrate) ---------------- */
  // { hold:false } 또는 { hold:true, backupDir, missing:[글], reasons:[글], oldChannels, newChannels, at } — 빠진 것이 있으면 새 판이 올리기·공개를 멈춘다.
  // 모달이 아니라 화면 맨 위 띠다 — 아무것도 가리지 않고, 해결될 때까지(hold 가 거짓이 될 때까지) 늘 보인다.
  let migSig = '', migBusy = false;
  const cnt = v => Array.isArray(v) ? v.length : (v == null || v === '' ? null : Number(v));
  function migPaint(s) {
    const m = s.migrate || {}, bar = $('migBar');
    if (!m.hold) { bar.classList.add('hide'); migSig = ''; return; }
    bar.classList.remove('hide');
    const sig = JSON.stringify([m.backupDir, m.missing, m.reasons, m.oldChannels, m.newChannels, m.at]);
    if (sig === migSig) return;                      // 같으면 다시 그리지 않는다(펼쳐 둔 자세히가 접히지 않게)
    migSig = sig;
    $('migDir').textContent = m.backupDir || '(알 수 없음)';
    const li = a => (Array.isArray(a) ? a : (a ? [a] : [])).map(x => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('');
    const o = cnt(m.oldChannels), n = cnt(m.newChannels);
    $('migDetail').innerHTML =
      (o != null || n != null ? `<div>채널 수: 옛 판 <b>${o != null ? num(o) : '?'}</b>개 → 새 판 <b>${n != null ? num(n) : '?'}</b>개</div>` : '') +
      ((m.missing || []).length ? `<div><b>빠진 것</b></div><ul>${li(m.missing)}</ul>` : '') +
      ((m.reasons || []).length ? `<div><b>까닭</b></div><ul>${li(m.reasons)}</ul>` : '') +
      (m.at ? `<div style="color:var(--t3)">확인한 때: ${esc(mdHm(m.at) || m.at)}</div>` : '');
  }
  window.moMigDetail = () => {
    const d = $('migDetail'), open = d.classList.toggle('hide') === false;
    $('migMore').textContent = open ? '자세히 닫기' : '자세히 보기';
  };
  window.moMigCopy = () => { const m = (ST && ST.migrate) || {}; if (m.backupDir) cpy(m.backupDir, '복사본 경로를 복사했습니다'); };
  window.moMigRetry = async () => {
    if (migBusy) return;
    migBusy = true;
    const b = $('migRetry'), t0 = b.textContent; b.disabled = true; b.textContent = '옮기는 중…';
    const r = await call('/api/migrate/retry', {});
    migBusy = false; b.disabled = false; b.textContent = t0;
    if (r.ok === false) msg(r.why || '다시 옮기지 못했습니다', 'err');
    else msg(r.message || '다시 옮겼습니다 — 결과를 확인하는 중…', 'ok');
    poll();
  };
  window.moMigAccept = async () => {
    if (migBusy) return;
    const m = (ST && ST.migrate) || {};
    const ok = await confirmBox({ emoji: '⛔', title: '빠진 것이 있는 채로 새 판을 쓸까요?', danger: true, ok: '빠진 채로 새 판 쓰기',
      body: `옛 판 자료를 옮기다 <b>빠진 것</b>이 있었습니다. 받아들이면 빠진 것은 새 판에서 빠진 채로 쓰고, <b>멈춰 둔 올리기·공개가 다시 시작</b>됩니다.<br>옛 판 자료와 복사본${m.backupDir ? `(<code>${esc(m.backupDir)}</code>)` : ''}은 지워지지 않고 그대로 남습니다.<br><span style="color:var(--t3)">확실하지 않으면 먼저 「자세히 보기」로 빠진 것을 확인하고 「다시 옮기기」를 눌러 보세요.</span>` });
    if (!ok) return;
    migBusy = true;
    const r = await call('/api/migrate/accept', { confirm: true });
    migBusy = false;
    if (r.ok === false) msg(r.why || '받아들이지 못했습니다', 'err');
    else msg('빠진 것이 있는 채로 새 판을 쓰기로 했습니다 — 올리기와 공개를 다시 시작합니다', 'ok');
    poll();
  };
  // 빨간 띠는 헤더보다 위, 화면 맨 앞에 놓는다(헤더는 스크롤해도 붙어 있고 띠는 같이 올라간다)
  document.body.insertBefore($('migBar'), document.body.firstChild);

  onState((s) => {
    if (!s) { lostPaint(); return; }
    migPaint(s);
    paintAiBtn(s);
    upErrPaint(s.update);
    wasUpdating = !!(s.update && s.update.running);
    lostAt = 0;
    apply(decide(s), s);
  });

  registerModal('modeModal', () => { forkDismissed = true; closeModal('modeModal'); cur = ''; });
  registerModal('upModal', () => window.moCloseUp());
  registerModal('autoModal', () => window.moAnswerAuto(false));
  registerModal('askModal', () => { if (ST && ST.ask) askDismissedId = ST.ask.id; closeModal('askModal'); cur = ''; });
  registerModal('keyModal', () => keyDismiss());
  // 업데이트를 받아 교체하는 동안(또는 교체하고 다시 켜지는 동안)에는 닫을 수 없다
  lockModals(() => !!(ST && ST.update && ST.update.running) || (wasUpdating && lostAt > 0));
})();

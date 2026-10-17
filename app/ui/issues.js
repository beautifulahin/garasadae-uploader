'use strict';
/* issues.js — 문제·알림 팝업 + 「확인이 필요합니다」 브리핑 팝업
 *
 * 약속
 *  · 헤더의 신호등 알약(#lamp)은 core 가 칠한다. 이 파일은 그 알약을 눌렀을 때 부르는 openIssues() 만 내보낸다(중복해서 칠하지 않는다).
 *  · 문제 목록은 팝업을 열 때와 사람이 단추를 누른 뒤에만 읽는다(GET /api/issues) — 1.5초 폴링에 얹지 않는다.
 *  · 브리핑(ST.brief)은 상태가 올 때마다 새 알림(key)이 있는지만 본다. 같은 key 는 세션에 한 번만 띄우고, 닫으면 다시 안 뜬다.
 *  · 올리지 못한 파일 목록의 「확인하고 지우기」 는 파일을 지우는 게 아니라 이 목록에서 숨기는 것이다(같은 파일이 이유가 달라지면 다시 뜬다).
 */
(() => {
  const SEEN = 'iss-seen';     // localStorage — 확인하고 숨긴 올리지 못한 파일 {열쇠:1}
  const BRIEF = 'iss-brief';   // sessionStorage — 이번 세션에 이미 보여 준 브리핑 key {key:1}
  const I = { items: [], files: [], loaded: false, seq: 0, busy: false };
  let briefOpen = false;

  // 저장소 이름('localStorage'|'sessionStorage')으로 부른다 — 저장소를 쓰는 순간 던지는 브라우저(막힌 창)에서도 화면이 돌아가게 전부 try 안에서
  const jget = (store, k) => { try { return JSON.parse(window[store].getItem(k) || '{}') || {}; } catch (_) { return {}; } };
  const jset = (store, k, v) => { try { window[store].setItem(k, JSON.stringify(v)); } catch (_) { /* 저장이 막혀도 화면은 돌아간다 */ } };

  /* ───────────── 말 다듬기 ───────────── */
  const LV = { red: '오류', yellow: '주의', green: '정상' };
  const KIND = { coupang: '쿠팡 파트너스', ai: 'AI 문안' };
  /** 서버가 주는 kind 가 내부 이름(coupang·ai…)이면 사용자에게 보이는 말로 바꾼다 */
  function kindText(it) {
    const k = String(it.kind || '');
    if (KIND[k]) return KIND[k];
    if (!k || /^[a-z][a-z0-9_\-]*$/i.test(k)) return LV[it.level] || '알림';
    return k;
  }
  const fixText = it => (typeof it.fix === 'string' ? it.fix : (it.fix && it.fix.label) || '');
  /** 설정 탭으로 안내할 줄 — 쿠팡 파트너스 경고와 AI 열쇠 안내 */
  const goesToSettings = it => it.kind === 'coupang' || it.kind === 'ai';

  /** 올리지 못한 파일 한 줄을 풀어 둔다. 사람이 읽는 말(무슨일·왜·할일)과 기록 원문(raw)을 따로.
   *  새 꼴: {ch, file, what, why(사람이 읽는 까닭), fix, raw(기록 원문)} · 옛 꼴: {ch, file, why(원문), 고침:{무슨일,왜,할일}} 둘 다 읽는다 */
  function normFile(x) {
    const g = x['고침'] || {};
    return {
      ch: x.ch ?? x.channel ?? '', file: String(x.file || ''),
      what: x.what || g['무슨일'] || '올릴 수 없는 파일',
      why: g['왜'] || x.why || '',
      fix: fixText(x) || g['할일'] || '',
      raw: String(x.raw ?? x['원문'] ?? (g['왜'] ? (x.why ?? '') : '')),
    };
  }
  /** 같은 파일·같은 이유면 같은 열쇠. ffprobe 오류문에는 매번 달라지는 메모리 주소가 섞여서 그것을 떼고 본다 */
  function fileKey(f) {
    const why = (f.raw || f.why || '').replace(/0x[0-9a-f]+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return f.file + '|' + why;
  }
  // 확인하고 숨긴 파일 — 저장소가 막힌 창에서도 이 페이지 안에서는 숨어 있게 따로 기억한다
  const seenMem = {};
  const fileSeen = () => Object.assign({}, jget('localStorage', SEEN), seenMem);
  const visibleFiles = () => { const seen = fileSeen(); return I.files.map(normFile).filter(f => !seen[fileKey(f)]); };

  /* ───────────── 문제·알림 팝업 ───────────── */
  function itemHtml(it) {
    const lv = ['red', 'yellow', 'green'].includes(it.level) ? it.level : 'green';
    const fx = fixText(it);
    return `<div class="iss-it ${lv}">
      <div class="iss-h"><span class="iss-tag ${lv}">${esc(kindText(it))}</span>
        <b>${it.channel ? esc(it.channel) + ' · ' : ''}${esc(it.what)}</b>${it.auto ? '<span class="iss-auto" title="아래 「자동으로 고치기」 로 앱이 스스로 고칠 수 있습니다">자동으로 고칠 수 있음</span>' : ''}</div>
      ${it.why ? `<div class="iss-r"><i>왜</i><span>${esc(it.why)}</span></div>` : ''}
      ${fx || goesToSettings(it) ? `<div class="iss-r do"><i>할 일</i><span>▸ ${esc(fx || '설정 탭에서 확인해 주세요')}</span>${goesToSettings(it) ? '<button class="tb on" onclick="issGoSettings()">⚙️ 설정 열기</button>' : ''}</div>` : ''}
    </div>`;
  }
  function fileHtml(f) {
    return `<div class="iss-it red">
      <div class="iss-h"><b>${esc(f.what)}</b>${f.ch ? `<span class="iss-ch">${esc(f.ch)}</span>` : ''}<span class="iss-fn">${esc(baseName(f.file))}</span></div>
      ${f.why ? `<div class="iss-r"><i>왜</i><span>${esc(f.why)}</span></div>` : ''}
      ${f.fix ? `<div class="iss-r do"><i>할 일</i><span>▸ ${esc(f.fix)}</span></div>` : ''}
      ${f.raw ? `<details class="iss-raw"><summary>기록 원문</summary><pre>${esc(f.raw)}</pre></details>` : ''}
    </div>`;
  }
  const group = (title, list) => `<div class="iss-gh">${title} <span class="iss-sum">${list.length}건</span></div>${list.map(itemHtml).join('')}`;

  function render() {
    const red = I.items.filter(x => x.level === 'red'), yel = I.items.filter(x => x.level === 'yellow');
    const grn = I.items.filter(x => x.level !== 'red' && x.level !== 'yellow');
    const files = visibleFiles();
    const none = !red.length && !yel.length && !files.length;
    let h = '';
    if (none) h += '<div class="iss-empty"><div class="e">✅</div><b>이상 없음</b>지금 확인할 문제가 없습니다.</div>';
    if (red.length) h += group('🔴 오류 — 작업이 막혔습니다', red);
    if (yel.length) h += group('🟡 작업불이행·경고 — 곧 문제가 됩니다', yel);
    if (files.length) {
      h += `<div class="iss-gh">📁 올리지 못한 파일 <span class="iss-sum">${files.length}건</span><span class="sp"></span>`
        + '<button class="tb" onclick="issFilesCopy()" title="기록 원문을 복사합니다">원문 복사</button>'
        + '<button class="tb on" onclick="issFilesDone()" title="이 목록에서 숨깁니다 — 파일을 지우지는 않습니다. 새 문제가 생기면 다시 뜹니다">확인하고 지우기</button></div>'
        + files.map(fileHtml).join('');
    }
    if (grn.length) h += `<details class="iss-grn" ${none ? 'open' : ''}><summary>🟢 정상·진행 (${grn.length})</summary>${grn.map(itemHtml).join('')}</details>`;
    $('issBody').innerHTML = h;

    const acked = !!(ST && ST.issues && ST.issues.ackedToday);
    const hasAlert = red.length + yel.length + files.length > 0;
    $('issBtnCopy').disabled = $('issBtnAi').disabled = !hasAlert;
    $('issBtnFix').classList.toggle('hide', !red.concat(yel).some(x => x.auto));
    $('issBtnAck').classList.toggle('hide', !yel.length || acked);
    if (yel.length && acked) {
      $('issBody').insertAdjacentHTML('beforeend', '<div class="iss-note">✔ 오늘은 노란 알림을 확인했음으로 접어 두었습니다. 내일 다시 나옵니다.</div>');
    }
    $('issSum').textContent = hasAlert ? `오류 ${red.length}건 · 주의 ${yel.length}건${files.length ? ` · 파일 ${files.length}건` : ''}` : '이상 없음';
  }

  async function load() {
    const mine = ++I.seq;
    let r;
    try { r = await api('/api/issues'); }
    catch (_) {   // 서버가 끊기면 core 가 점으로 알린다 — 팝업 안에는 조용히 적는다
      if (mine === I.seq && !I.loaded) $('issBody').innerHTML = '<div class="iss-empty">앱에 연결되지 않아 문제 목록을 불러오지 못했습니다</div>';
      return;
    }
    if (mine !== I.seq) return;
    if (!r || r.ok === false) {
      msg((r && r.why) || '문제 목록을 불러오지 못했습니다', 'err');
      if (!I.loaded) $('issBody').innerHTML = `<div class="iss-empty">${esc((r && r.why) || '문제 목록을 불러오지 못했습니다')}</div>`;
      return;
    }
    const all = Array.isArray(r.items) ? r.items.filter(Boolean) : [];
    // 올리지 못한 파일: 별도 칸(files)으로 오거나, items 안에서 file 이 붙어 오는 줄
    I.files = [...(Array.isArray(r.files) ? r.files : []), ...all.filter(x => x.file)];
    I.items = all.filter(x => !x.file);
    I.loaded = true;
    render();
  }

  function openIssues() {
    if (briefOpen) closeBriefQuiet();
    openModal('issModal');
    if (!I.loaded) $('issBody').innerHTML = '<div class="iss-empty">불러오는 중…</div>';
    else render();
    load();
  }
  function closeIssues() { closeModal('issModal'); }
  window.openIssues = openIssues;
  window.closeIssues = closeIssues;
  registerModal('issModal', closeIssues);

  /** AI 앱·메모에 붙여 넣을 설명글 */
  function reportText() {
    const out = [`업로더 문제 보고 — ${I.items.filter(x => x.level !== 'green').length + visibleFiles().length}건`];
    for (const it of I.items.filter(x => x.level !== 'green')) {
      out.push(`[${kindText(it)}${it.channel ? ' · ' + it.channel : ''}] ${it.what}`);
      if (it.why) out.push(`  왜: ${it.why}`);
      if (fixText(it)) out.push(`  고치는 법: ${fixText(it)}`);
    }
    for (const f of visibleFiles()) {
      out.push(`[올리지 못한 파일${f.ch ? ' · ' + f.ch : ''}] ${f.file}`);
      if (f.what) out.push(`  무슨 일: ${f.what}`);
      if (f.why) out.push(`  왜: ${f.why}`);
      if (f.raw) out.push(`  기록 원문: ${f.raw}`);
    }
    return out.join('\n');
  }

  /** 단추 하나가 도는 동안 다른 단추를 잠가 같은 일을 두 번 시키지 않는다 */
  async function run(btnId, busyText, fn) {
    if (I.busy) return;
    I.busy = true;
    const b = $(btnId), old = b.textContent;
    b.disabled = true; b.textContent = busyText;
    try { await fn(); }
    catch (_) { /* 서버가 끊기면 core 가 알린다 */ }
    finally { b.textContent = old; b.disabled = false; I.busy = false; }
  }

  window.issCopy = () => run('issBtnCopy', '복사하는 중…', async () => {
    const r = await api('/api/issues/copy', {});
    if (r && r.ok !== false) return msg('문제 설명을 복사했습니다 — AI 앱이나 메모에 붙여 넣으세요', 'ok');
    cpy(reportText(), '문제 설명을 복사했습니다 — AI 앱이나 메모에 붙여 넣으세요');   // 서버가 못 했으면 이 화면에서 직접
  });

  window.issClaude = () => run('issBtnAi', '여는 중…', async () => {
    const r = await api('/api/claude/open', {});
    if (r && r.ok !== false) return msg('AI 앱을 열었습니다 — 문제 내용이 복사돼 있으니 ⌘V 로 붙여넣으세요', 'ok');
    // 앱을 못 열어도 설명글은 복사해 둔다 — 서버가 복사했을 수도 있지만 한 번 더 확실히
    try { await navigator.clipboard.writeText(reportText()); } catch (_) { /* 브라우저가 막으면 서버가 복사한 것에 기댄다 */ }
    msg(`${(r && r.why) || 'AI 앱을 열지 못했습니다'} — 문제 설명은 복사해 두었으니 AI 앱에 직접 붙여 넣어 주세요`, 'err');
  });

  window.issFix = async () => {
    if (I.busy) return;
    const list = I.items.filter(x => x.auto && x.level !== 'green');
    const ok = await confirmBox({
      emoji: '🛠', title: '자동으로 고칠까요?',
      body: `앱이 스스로 고칠 수 있는 <b>${list.length}건</b>을 고칩니다.${list.length ? '<br>' + list.slice(0, 5).map(x => '· ' + esc((x.channel ? x.channel + ' — ' : '') + x.what)).join('<br>') : ''}`,
      ok: '고치기',
    });
    if (!ok) return;
    await run('issBtnFix', '고치는 중…', async () => {
      const r = await api('/api/issues/fix', {});
      if (r.ok === false) return msg(r.why || '자동으로 고치지 못했습니다', 'err');
      msg(r.fixed ? `${num(r.fixed)}건을 자동으로 고쳤습니다` : '자동으로 고칠 것이 없었습니다', 'ok');
      await load();
      poll();
    });
  };

  window.issAck = () => run('issBtnAck', '접는 중…', async () => {
    const r = await api('/api/iss/ack', {});
    if (r.ok === false) return msg(r.why || '확인했음을 남기지 못했습니다', 'err');
    msg('확인했습니다 — 오늘은 노란 알림을 접어 둡니다. 내일 다시 나옵니다', 'ok');
    await poll();   // 신호등 알약의 숫자도 바로 바뀌게
    await load();
  });

  window.issGoSettings = () => { closeIssues(); closeBriefQuiet(); swTab('t4'); };

  window.issFilesCopy = () => {
    const files = visibleFiles();
    if (!files.length) return;
    cpy(files.map(f => `[${f.ch}] ${f.file}\n  ${f.raw || f.why || f.what}`).join('\n\n'), '원문을 복사했습니다 — AI 앱에 붙여 넣으세요');
  };
  window.issFilesDone = () => {
    const seen = fileSeen();
    for (const f of visibleFiles()) { seen[fileKey(f)] = 1; seenMem[fileKey(f)] = 1; }
    jset('localStorage', SEEN, seen);
    render();
    msg('확인한 문제를 숨겼습니다 — 새 문제가 생기면 다시 뜹니다', 'ok');
  };

  /* ───────────── 「확인이 필요합니다」 브리핑 ───────────── */
  const briefKey = x => String(x.key || `${x.level}|${x.channel}|${x.text}`);
  // 저장소가 막힌 창이어도 같은 알림이 닫을 때마다 다시 뜨지 않게, 이 페이지 안에서 본 것을 따로 기억한다
  const briefMem = {};
  const briefSeen = () => Object.assign({}, jget('sessionStorage', BRIEF), briefMem);
  function showBrief(items) {
    const seen = briefSeen();
    items.forEach(x => { seen[briefKey(x)] = 1; briefMem[briefKey(x)] = 1; });   // 띄우는 순간 적는다 — 닫든 말든 같은 알림은 이번 세션에 다시 안 뜬다
    jset('sessionStorage', BRIEF, seen);
    $('issBriefN').textContent = `${items.length}건`;
    $('issBriefList').innerHTML = items.map(x => {
      const lv = x.level === 'red' ? 'red' : 'yellow';
      return `<div class="iss-it ${lv}"><div class="iss-h"><span class="iss-tag ${lv}">${lv === 'red' ? '큰일' : '주의'}</span><b>${esc(x.text)}</b></div>`
        + `<div class="iss-meta">${x.channel ? esc(x.channel) + ' · ' : ''}${esc(mdHm(x.at) || '')}</div></div>`;
    }).join('');
    briefOpen = true;
    openModal('issBrief');
  }
  function closeBriefQuiet() { briefOpen = false; closeModal('issBrief'); }
  window.issBriefClose = closeBriefQuiet;
  window.issBriefMore = () => { closeBriefQuiet(); openIssues(); };
  registerModal('issBrief', closeBriefQuiet);

  /** 상태가 올 때마다: 아직 안 보여 준 알림이 있고, 사용자가 글을 쓰는 중이거나 다른 창이 열려 있지 않을 때만 띄운다 */
  onState(s => {
    if (!s || briefOpen || isWithdrawn()) return;
    const seen = briefSeen();
    const fresh = (Array.isArray(s.brief) ? s.brief : []).filter(x => x && !seen[briefKey(x)]);
    if (!fresh.length) return;
    if (typing() || document.querySelector('.modal.on')) return;   // 아직 안 적었으니 다음 상태에서 다시 본다
    showBrief(fresh);
  });
})();

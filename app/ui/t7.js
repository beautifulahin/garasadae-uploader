'use strict';
/* t7.js — 성적 탭 (채널 성적 카드 · 48시간 지표 · 끌어올림 · 건강 팝업)
 *
 * 약속
 *  · 숫자는 서버가 저장해 둔 것을 읽는다. 이 화면을 열거나 탭을 바꿔도 유튜브를 부르지 않는다.
 *    유튜브를 부르는 것은 사람이 「지금 다시 재기」 「분석 받기」 를 눌렀을 때뿐이다.
 *  · paint()(1.5초마다)는 서버를 부르지 않는다 — 이미 받은 상태(ST)로 채널 칩과 한도 줄만 고친다.
 *  · 자료 칸 이름은 app/statsview.ts 머리 주석의 표를 따른다(채널 카드 · 48시간 카드 · 끌어올림 카드).
 * 다른 파일과 이름이 겹치지 않게 전부 (() => {…})() 안에 넣고, onclick 에서 부르는 것만 window 로 내보낸다.
 */
(() => {
  const S = { data: null, cache: {}, ch: '', sec: 'ch', loading: false, error: '', at: 0, seq: 0, hseq: 0, view: {}, busy: false };
  try { const v = sessionStorage.getItem('t7sec'); if (v === 'ch' || v === 'rv' || v === 'lf') S.sec = v; } catch (_) {}

  const has = x => x !== null && x !== undefined;
  const han = v => (!has(v) ? '—' : Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '만' : num(v));
  const sgn = n => (n > 0 ? '+' : '') + num(n);
  const cards = x => (Array.isArray(x) ? x : x && Array.isArray(x.cards) ? x.cards : []);
  const NAME = { all: '영상별 누적', alltop: '영상별 누적', v7: '지난 7일', v28: '지난 28일', v90: '지난 90일', v48: '48시간' };

  // 같은 글이면 다시 쓰지 않는다(1.5초마다 불리는 paint() 가 칩을 깜빡이게 하지 않게).
  const memo = {};
  const setText = (id, t) => { const e = $(id); if (e && e.textContent !== t) e.textContent = t; };
  const setHtml = (id, h) => { const e = $(id); if (e && memo[id] !== h) { e.innerHTML = h; memo[id] = h; } };

  /* ───────────── 작은 도우미 ───────────── */
  /** 갱신 시각 → "10월 16일 14:03". 서버가 초(epoch)·글자·{text} 어느 것을 줘도 읽는다 */
  function atText(at) {
    if (!at) return '';   // 없음·0·빈 글은 「읽은 적 없음」
    if (typeof at === 'object') return at.text || at.refreshedText || atText(at.at ?? at.refreshedAt);
    if (typeof at === 'number') {
      const d = new Date(at > 1e12 ? at : at * 1000);
      return isNaN(d) ? '' : `${pad2(d.getMonth() + 1)}월 ${pad2(d.getDate())}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(at));
    return m ? `${m[2]}월 ${m[3]}일 ${m[4]}:${m[5]}` : String(at);
  }
  /** 같은 유튜브 채널을 두 이름(쇼츠용·롱폼용)으로 올려도 성적은 한 카드 — 먼저 등록한 이름만 센다 */
  function chanList() {
    const seen = new Set(), out = [];
    for (const c of ((ST && ST.channels) || [])) {
      const k = c.channelId || c.name;
      if (seen.has(k)) continue;
      seen.add(k); out.push(c.name);
    }
    return out;
  }
  const isLong = name => !!(((ST && ST.channels) || []).find(c => c.name === name) || {}).isLong;
  const findCard = name => cards(S.data && S.data.channels).find(c => c.name === name);
  const pick = list => (S.ch ? list.filter(c => c.name === S.ch) : list);
  const viewOf = name => S.view[name] || (S.view[name] = { m: 'all', sort: 'recent', list: 'ph', open: false });

  /* ───────────── 그래프 ───────────── */
  /** 영상 꼴(kind:"video") · 하루 꼴(kind:"day") 한 칸을 그리기 쉽게 풀어 둔다 */
  function modelOf(g, key) {
    const vals = Array.isArray(g.v) ? g.v : [], n = vals.length, day = g.kind === 'day';
    const cutA = g.cut || [], jamA = g.jam;
    // 모르는 날(잼=false)은 값이 없는 것이지 0 이 아니다. 최대·평균·합은 아는 날만으로 낸다.
    // 유튜브가 조회수를 정정해 총계가 줄어든 날(줄=true)도 하루치를 알 수 없는 날로 친다.
    const jam = vals.map((_, i) => (day ? (jamA ? !!jamA[i] && !cutA[i] : true) : true));
    const known = vals.filter((_, i) => jam[i]);
    let top = known.length ? Math.max.apply(null, known) : 0;
    const best = top > 0 ? vals.findIndex((x, i) => jam[i] && x === top) : -1;
    if (!(top > 0)) top = 1;
    const sum = known.reduce((a, b) => a + b, 0);
    return { g, key, day, n, vals, jam, known, top, best, sum, avg: known.length ? sum / known.length : 0, jamN: known.length, cutN: cutA.filter(Boolean).length };
  }
  function cardModel(c) {
    const v = viewOf(c.name), ch = c.chart || {};
    let key = v.m;
    if (key === 'all' && v.sort === 'top' && ch.alltop) key = 'alltop';
    const g = ch[key] || { v: [], lk: [], cm: [], lab: [], ttl: [], kind: key === 'all' || key === 'alltop' ? 'video' : 'day' };
    return modelOf(g, key);
  }
  function smooth(ps) {
    if (ps.length < 2) return '';
    let d = `M ${ps[0][0].toFixed(1)} ${ps[0][1].toFixed(1)}`;
    for (let i = 0; i < ps.length - 1; i++) {
      const [x0, y0] = ps[i], [x1, y1] = ps[i + 1], cx = (x0 + x1) / 2;
      d += ` C ${cx.toFixed(1)} ${y0.toFixed(1)} ${cx.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    return d;
  }
  let gid = 0;
  /** 그래프 한 장. 영상 꼴은 곡선+점, 하루 꼴은 막대(바닥 0 에서 올라옴)에 누적 곡선을 겹친다. 값은 마우스를 올리면 보인다 */
  function chartHtml(m, emptyMsg) {
    if (!m.n) return `<div class="t7-nowin">${esc(emptyMsg || '보여 줄 자료가 아직 없습니다')}</div>`;
    const W = 400, H = 120, P = 8, g = m.g, n = m.n, id = 't7g' + (++gid);
    const X = i => (n > 1 ? P + i * ((W - P * 2) / (n - 1)) : W / 2);
    const Y = v => H - P - (v / m.top) * (H - P * 2 - 12);
    const labs = g.lab || [], ttls = g.ttl || [];
    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--blue);stop-opacity:.34"/><stop offset="1" style="stop-color:var(--blue);stop-opacity:0"/></linearGradient></defs>`;
    for (const k of [0, 0.5, 1]) {
      const y = (H - P - k * (H - P * 2 - 12)).toFixed(1);
      s += `<line class="grid" x1="${P}" y1="${y}" x2="${W - P}" y2="${y}"/>`;
    }
    let cum = '';
    if (m.day) {
      // 날짜 눈금 — 막대가 한쪽에 몰려도 「그때는 안 올렸다」 로 읽히게
      const cols = Math.min(n, 8);
      for (let t = 1; t < cols; t++) {
        const x = (P + (t / cols) * (W - P * 2)).toFixed(1);
        s += `<line class="tick" x1="${x}" y1="${P}" x2="${x}" y2="${H - P}"/>`;
      }
      if (!g['누적만']) {
        const bw = Math.max(2, Math.min(22, ((W - P * 2) / Math.max(n, 1)) * 0.62));
        for (let i = 0; i < n; i++) {
          const x = (X(i) - bw / 2).toFixed(1);
          if (!m.jam[i]) {
            // 아직 기록이 없는 날 — 자리는 그대로 둔다(나중에 그 자리에 막대가 선다). 날마다 그래프 모양이 달라지지 않게.
            const why = g.cut && g.cut[i] ? '유튜브가 조회수를 정정한 날' : '아직 집계 전';
            s += `<rect class="slot" x="${x}" y="${P + 8}" width="${bw.toFixed(1)}" height="${H - P - (P + 8)}" rx="2"><title>${esc(labs[i] || '')} · ${why}</title></rect>`;
            continue;
          }
          const y = Y(m.vals[i]);
          s += `<rect class="bar${i === m.best ? ' best' : ''}" x="${x}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(H - P - y, m.vals[i] > 0 ? 1.5 : 0.8).toFixed(1)}" rx="2"><title>${esc(ttls[i] || labs[i] || '')} · ${han(m.vals[i])}회</title></rect>`;
        }
      }
      // 누적 곡선 — 하루치는 두 점을 빼야 나오지만 누적은 찍은 그대로라 언제나 값이 있다
      const nv = (g['누적'] && g['누적'].v) || [];
      if (nv.length) {
        const lo = Math.min.apply(null, nv), hi = Math.max.apply(null, nv), span = Math.max(hi - lo, 1);
        const np = nv.map((v, i) => [nv.length > 1 ? P + i * ((W - P * 2) / (nv.length - 1)) : W - P, H - P - 6 - ((v - lo) / span) * (H - P * 2 - 24)]);
        s += `<path class="line cum" d="${np.length > 1 ? smooth(np) : `M ${np[0][0].toFixed(1)} ${np[0][1].toFixed(1)} l .1 0`}"/>`;
        cum = `<span class="cumv">누적 ${han(nv[nv.length - 1])}</span>`;
      }
    } else {
      const pts = m.vals.map((v, i) => [X(i), Y(v)]);
      if (n > 1) {
        const d = smooth(pts);
        s += `<path d="${d} L ${pts[n - 1][0].toFixed(1)} ${H - P} L ${pts[0][0].toFixed(1)} ${H - P} Z" fill="url(#${id})" stroke="none"/><path class="line" d="${d}"/>`;
      }
      pts.forEach(([x, y], i) => {
        s += `<path class="t7-dot${i === m.best ? ' best' : ''}" d="M ${x.toFixed(1)} ${y.toFixed(1)} h .01"><title>${esc(ttls[i] || '')}\n${esc(labs[i] || '')} 올림 · ${han(m.vals[i])}회</title></path>`;
      });
    }
    const ay = Y(m.avg);
    if (m.known.length) s += `<line class="avg" x1="${P}" y1="${ay.toFixed(1)}" x2="${W - P}" y2="${ay.toFixed(1)}"/>`;
    s += '</svg>';
    // 평균 글씨가 맨 위에 붙으면 최대값과 겹친다 — 그럴 때는 선 아래로 내려 단다
    const avgTxt = m.known.length ? `<span class="yavg" style="top:${ay.toFixed(0)}px;transform:translateY(${ay < 26 ? '15%' : '-125%'})">평균 ${han(Math.round(m.avg))}</span>` : '';
    // 아는 값이 하나도 없으면 맨 위 숫자도 의미가 없다 — 빈 칸만 보인다
    const ymax = m.known.length ? `<span class="ymax">${han(m.top)}</span>` : '';
    return `<div class="t7-chart">${s}${ymax}${avgTxt}<span class="xfrom">${esc(g.from || labs[0] || '')}</span><span class="xto">${esc(g.to || labs[n - 1] || '')}</span>${cum}</div>`;
  }

  /** 그래프 밑 한 줄 — 이 그림이 무엇이고 어디서 온 값인지 스스로 밝힌다 */
  function noteText(c, m) {
    const g = m.g, n = m.n;
    if (!n) return '';
    if (!m.day) {
      const smp = c && c.chart && c.chart['전체'] && c.chart['전체']['표본'];
      const which = m.key === 'alltop' ? `채널 전체 ${smp ? num(smp) + '편 중 ' : ''}조회수 상위 ${n}개` : `최근 ${n}편 · 올린 순`;
      return `영상 하나하나가 지금까지 모은 조회수(평생 누적) · 가로축 올린 날 · ${which} · 표시분 합 ${han(m.sum)}회`;
    }
    let t;
    if (g.src === 'studio') {
      t = `유튜브 집계(스튜디오와 같은 값) · ${n}일 중 ${m.jamN}일 확정`;
      if (m.jamN < n) t += ' · 맨 끝 하루 이틀은 유튜브가 아직 집계 중';
      if (g.sum) t += ` · 시청 ${num(Math.round((g.sum.h || 0) * 10) / 10)}시간 · 구독자 ${sgn(g.sum.s || 0)}`;
    } else {
      // 바닥에 붙은 막대가 「조회 0」 인지 「아직 못 셈」 인지 말해 준다 — 기록이 하루뿐인 채널이 죽은 것처럼 보이지 않게
      t = `채널 전체의 하루하루 증가분(우리가 매일 찍어 뺀 값) · ${n}일 칸 중 ${m.jamN}일 채워짐`;
      if (m.jamN === 0) t += ' — 내일부터 채워집니다(하루 한 번 저절로 찍힙니다)';
      else if (m.jamN < n) t += ' · 빈 칸은 기록이 쌓이면 채워집니다';
    }
    if (m.cutN) t += ` · 유튜브 조회수 정정 ${m.cutN}일`;
    return t;
  }

  /* ───────────── 채널 성적 카드 ───────────── */
  function numsHtml(c, m, v) {
    const g = m.g, all = (c.chart && c.chart['전체']) || {};
    const nm = NAME[m.key] || NAME.all;
    let bigV, bigL, avgV, avgL;
    if (m.day) {
      bigV = m.jamN ? han(m.sum) : '—';
      bigL = `${nm} 조회수 합` + (m.jamN && m.jamN < m.n ? ` (${m.jamN}일치)` : '');
      avgV = m.jamN ? han(Math.round(m.avg)) : '—'; avgL = '하루 평균';
    } else {
      bigV = han(m.sum); bigL = `최근 ${m.n}개 누적 조회수`;
      // 영상별 누적 탭의 큰 숫자는 채널 전체 누적이다(10개 합을 크게 쓰면 채널 총량으로 오해한다)
      if (has(all.v)) { bigV = han(all.v); bigL = '채널 전체 누적 조회수' + (all.n ? ` · 영상 ${num(all.n)}개` : ''); }
      avgV = han(Math.round(m.avg)); avgL = '편당 평균';
    }
    // 좋아요·댓글: 영상 꼴은 표시된 영상들의 합, 하루 꼴은 스튜디오 요약(그 기간의 증감)
    const studio = g.sum && has(g.sum.lk);
    let lk = (g.lk || []).reduce((a, b) => a + b, 0), cm = (g.cm || []).reduce((a, b) => a + b, 0);
    if (studio) { lk = g.sum.lk; cm = g.sum.cm; }
    const noLk = m.day && !studio;   // 하루 꼴인데 요약이 없으면 모르는 것 — 0 으로 띄우지 않는다
    const suf = v.m === 'all' ? '' : ' · ' + nm;
    const cells = [
      `<div class="c big"><em>${bigV}</em><i>${esc(bigL)}</i></div>`,
      `<div class="c"><em>${avgV}</em><i>${avgL}</i></div>`,
      `<div class="c"><em>${noLk ? '—' : han(lk)}</em><i>좋아요${esc(suf)}</i></div>`,
      `<div class="c"><em>${noLk ? '—' : han(cm)}</em><i>댓글${esc(suf)}</i></div>`,
    ];
    // 시청시간 — 롱폼 채널에서는 이것이 조회수보다 중요하다(수확 조건이 시청시간). 스튜디오 요약이 있는 기간 탭에서만 나온다
    if (m.day && g.sum && has(g.sum.h)) {
      cells.push(`<div class="c" title="${attr(isLong(c.name) ? '롱폼 채널은 시청시간이 수확 조건입니다' : '쇼츠 채널은 조회수가 먼저이고, 시청시간은 참고입니다')}"><em>${num(Math.round(g.sum.h * 10) / 10)}시간</em><i>시청시간${esc(suf)}</i></div>`);
    }
    const sub = c.sub;
    if (sub) {
      if (has(sub.subs)) {
        const gr = sub.grow || {};
        const tail = has(gr.n)
          ? `<b class="${gr.n > 0 ? 'up' : gr.n < 0 ? 'dn' : 'flat'}">${sgn(gr.n)}</b> ${esc(gr.unit || '어제')}`
          : `<span class="wait" title="${attr(gr.why || '')}">${esc(gr.wait || '')}</span>`;
        cells.push(`<div class="c" title="${attr(sub.title || '')}"><em>${num(sub.subs)}</em><i>구독자 · ${tail}</i></div>`);
      } else {
        cells.push('<div class="c"><em>—</em><i>구독자 비공개</i></div>');
      }
    }
    // 나라 — 노출수는 API 가 안 줘서 지난 28일 조회수의 나라 비율로 잰다
    if (c.country) cells.push(`<div class="c" title="유튜브가 노출수는 안 줘서, 지난 28일 조회수의 나라 비율로 잽니다"><em class="geo">${esc(c.country)}</em><i>나라 · 28일 조회</i></div>`);
    return cells.join('');
  }

  function bestHtml(c, m) {
    const ttls = m.g.ttl || [], labs = m.g.lab || [];
    if (m.best >= 0) {
      return m.day
        ? `<div class="t7-best">가장 센 날 · <b>${esc(labs[m.best] || '')}</b> <span>${han(m.vals[m.best])}</span>회</div>`
        : `<div class="t7-best">가장 잘된 것 · <b>${esc(String(ttls[m.best] || '').slice(0, 34))}</b> <span>${han(m.vals[m.best])}</span>회</div>`;
    }
    return !m.day && c.best ? `<div class="t7-best">가장 잘된 것 · <b>${esc(String(c.best.title || '').slice(0, 34))}</b> <span>${han(c.best.views)}</span>회</div>` : '';
  }

  function spikeHtml(c) {
    const b = c.spikeBand || [];
    if (!b.length) return '';
    return `<div class="t7-spk" title="${attr(c.spike && c.spike['말'] || '')}"><span class="t">🔥 급등</span>${b.map(x => `<span><b>${esc(x['이름'])}</b> ${esc(x['배'])}<i>${esc(x['설명'])}</i></span>`).join('')}</div>`;
  }

  function healthBadge(c) {
    const h = c.health || {}, gr = h['등급'] || '몰라';
    const cls = gr === '좋음' ? 'g-ok' : gr === '주의' ? 'g-warn' : gr === '위험' ? 'g-bad' : 'g-unk';
    const txt = h['말'] || ({ 좋음: '🟢 건강', 주의: '🟡 주의', 위험: '🔴 확인 필요', 몰라: '⚪ 자료 부족' })[gr] || '⚪ 건강';
    return `<button class="t7-hb ${cls}" data-n="${attr(c.name)}" onclick="t7Health(this.dataset.n)" title="${attr((h['풍선'] || '') + '\n\n누르면 크게 봅니다')}">${esc(txt)}</button>`;
  }

  /** 수확 조건 숫자를 따로 읽는다 — 서버가 칸을 주면 그것을, 아니면 설명 글에서 */
  function harvestParts(h) {
    const o = { subs: null, shorts: null, hours: null, need: null };
    const n0 = s => Number(String(s).replace(/,/g, ''));
    if (h['기준'] && typeof h['기준'] === 'object') {
      o.subs = has(h['구독']) ? Number(h['구독']) : null;
      o.shorts = has(h['쇼츠조회']) ? Number(h['쇼츠조회']) : null;
      o.hours = has(h['롱폼시청']) ? Number(h['롱폼시청']) : null;
      o.need = { subs: Number(h['기준']['구독자']), shorts: Number(h['기준']['쇼츠조회90']), hours: Number(h['기준']['시청시간365']) };
      return o;
    }
    const d = String(h['설명'] || '');
    let m;
    if ((m = /^구독 ([\d,]+)/.exec(d))) o.subs = n0(m[1]);
    if ((m = /90일 쇼츠 참여조회 ([\d,]+)/.exec(d))) o.shorts = n0(m[1]);
    if ((m = /시청 ([\d,]+(?:\.\d+)?)h/.exec(d))) o.hours = n0(m[1]);
    if ((m = /기준\(구독 ([\d,]+)\/참여조회 ([\d,]+)만 또는 시청 ([\d,]+)h\)/.exec(d))) o.need = { subs: n0(m[1]), shorts: n0(m[2]) * 10000, hours: n0(m[3]) };
    return o.need ? o : null;
  }
  /** 「N차 수확」 막대 + 구독자 · 쇼츠 조회(90일) · 롱폼 시청시간(365일) 을 따로 */
  function harvestHtml(c, h) {
    if (!h) return '';
    const name = esc(h['이름'] || ((h['차수'] || 1) + '차'));
    const pct = Math.max(0, Math.min(99, parseInt(h['비율'], 10) || 0));
    const head = h['전부']
      ? `<b class="ok">${name} 충족</b><span class="t7-bar full"><i style="width:100%"></i></span>`
      : `<b>${name} 수확</b><span class="t7-bar"><i style="width:${pct}%"></i></span><span class="pc">${pct}%</span>`;
    const p = harvestParts(h);
    let rows = '', note = '';
    if (p && p.need) {
      const long = isLong(c.name);
      // 줄마다 한 덩어리: 위에 「이름 · 지금 / 기준 · 퍼센트」, 아래에 막대 — 격자에 섞어 놓으면 줄이 어긋난다
      const line = (label, cur, need, unit, me) => {
        const r = has(cur) && need ? Math.min(100, Math.floor(cur / need * 100)) : 0;
        return `<div class="t7-hpr"><div class="h"><span class="k ${me ? 'mine' : ''}">${label}</span><span class="v">${has(cur) ? num(cur) + unit : '자료 없음'} / ${num(need)}${unit}</span><span class="q">${has(cur) ? r + '%' : '—'}</span></div>`
          + `<span class="t7-bar ${r >= 100 ? 'full' : ''}"><i style="width:${r}%"></i></span></div>`;
      };
      rows = `<div class="t7-hp">${line('구독자', p.subs, p.need.subs, '명', false)}${line('쇼츠 조회 (90일 참여조회)', p.shorts, p.need.shorts, '회', !long)}${line('롱폼 시청시간 (365일)', p.hours, p.need.hours, '시간', long)}</div>`;
      note = '<div class="t7-hv-n">구독자와 함께, 쇼츠 조회 또는 롱폼 시청시간 중 한쪽만 채우면 됩니다 · 구독자는 ±10명 오차가 있을 수 있습니다</div>';
    }
    return `<div class="t7-hv" title="${attr(h['설명'] || '')}"><div class="t7-hv-h">${head}</div>${rows}${note}</div>`;
  }

  /* 영상 하나하나 표 */
  const perHour = r => (has(r.perHour) ? Number(r.perHour) : has(r.v48) ? r.v48 / 48 : 0);
  function listRows(c, mode) {
    const L = c.list || {}, rec = L.recent || [], top = L.top || [];
    if (mode === 'top') return top;
    if (mode === 'recent') return rec;
    // 시간당 조회수 톱 30 — 어제 올린 편과 방금 올린 편을 같은 자리에서 견주려면 시간으로 나눠야 한다
    const seen = new Set(), all = [];
    for (const r of [...top, ...rec]) {
      const k = r.id || r.title;
      if (seen.has(k)) continue;
      seen.add(k); all.push(r);
    }
    return all.sort((a, b) => perHour(b) - perHour(a) || (b.views || 0) - (a.views || 0)).slice(0, 30);
  }
  function listHtml(c, v) {
    const rows = listRows(c, v.list);
    const hs = rows.map(perHour).sort((a, b) => a - b);
    const med = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    const body = rows.map((r, i) => {
      const ph = perHour(r);
      // 가운데보다 많이 위면 청록, 가운데 아래면 흐리게 — 눈으로 바로 갈리게
      const col = ph > med * 1.5 ? 'var(--cyan)' : ph < med ? 'var(--t3)' : 'var(--t1)';
      const watch = r.id ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(r.id) : '';
      const t = esc(r.title);
      return `<tr><td class="rk">${i + 1}</td><td><div class="ti">${r.id ? `<img loading="lazy" src="https://i.ytimg.com/vi/${attr(encodeURIComponent(r.id))}/default.jpg" alt="" onerror="this.style.visibility='hidden'"/>` : ''}`
        + (watch ? `<a href="${attr(watch)}" target="_blank" rel="noopener" title="유튜브에서 보기 — ${attr(r.title)}">${t}</a>` : `<span>${t}</span>`)
        + `</div></td><td class="r" style="color:${col};font-weight:700">${han(Math.round(ph))}</td><td class="r">${han(r.views)}</td><td class="r">${has(r.likes) ? han(r.likes) : '—'}</td><td class="r">${has(r.comments) ? han(r.comments) : '—'}</td><td class="at">${esc(r.at || '')}</td></tr>`;
    }).join('');
    const opt = (val, txt) => `<option value="${val}" ${v.list === val ? 'selected' : ''}>${txt}</option>`;
    return `<details class="t7-list" data-n="${attr(c.name)}" ${v.open ? 'open' : ''} ontoggle="t7Open(this)">
      <summary>🏆 영상 하나하나 보기 (${rows.length}개)</summary>
      <div class="sel"><span>보는 차례</span><select class="sm" data-n="${attr(c.name)}" onchange="t7ListSel(this)" aria-label="영상 표를 보는 차례">${opt('ph', '시간당 조회수 톱 30')}${opt('top', '조회수 상위 30 (전체 영상)')}${opt('recent', '최근 올린 순')}</select></div>
      ${rows.length ? `<div class="t7-tblw"><table class="t7-tbl"><thead><tr><th></th><th>영상</th><th class="r" title="뜬 시간으로 나눈 조회수 — 올린 때가 달라도 견줄 수 있습니다">시간당</th><th class="r">조회수</th><th class="r">좋아요</th><th class="r">댓글</th><th>올린 날</th></tr></thead><tbody>${body}</tbody></table></div>` : '<div class="t7-foot" style="border:0;margin:0;padding:6px 0">영상 기록이 아직 없습니다</div>'}
    </details>`;
  }

  function cardHtml(c) {
    const v = viewOf(c.name), hv = (S.data.harvest || {})[c.name];
    const hot = !!(c.spike && c.spike['급등']);
    const head = `<div class="t7-ch"><b>${esc(c.label || c.name)}</b>${healthBadge(c)}${hv && hv['달성'] && !hv['전부'] ? '<span class="chbadge ok" title="1차 수확 조건 달성">수확달성</span>' : ''}<span class="sp"></span>`
      + `<span class="t7-daily" title="${attr(`오늘 목표 ${c.daily}개 중 ${c.todayUploaded}개 올림 — ${c.dailyWhy || ''}`)}">오늘 남은 권장 ${num(c.remaining)}개</span>`
      + `<button class="tb" data-n="${attr(c.name)}" onclick="t7Refresh(this.dataset.n)" title="이 채널만 다시 읽기 (약 3유닛)">↻</button></div>`;
    if (!c.hasPerf) {
      return `<div class="t7-card" data-name="${attr(c.name)}">${head}<div class="t7-nowin">아직 지표가 없습니다<br>위의 🔄 지금 다시 재기 를 눌러 처음 읽어 주세요</div>${harvestHtml(c, hv)}</div>`;
    }
    const m = cardModel(c);
    const tabs = [['all', '영상별 누적'], ['v7', '지난 7일'], ['v28', '지난 28일'], ['v90', '지난 90일']].map(([k, t]) =>
      `<button class="${v.m === k ? 'on' : ''}" data-n="${attr(c.name)}" data-m="${k}" onclick="t7Tab(this)" title="${k === 'all' ? '최근 영상들이 지금까지 모은 조회수 — 유튜브가 주는 값' : `${t} 채널 조회수 — 유튜브 스튜디오와 같은 값`}">${t}</button>`).join('');
    const sortSel = v.m === 'all' ? `<select class="sm" data-n="${attr(c.name)}" onchange="t7Sort(this)" title="영상별 누적을 어떤 차례로 볼지" aria-label="영상별 누적을 보는 차례"><option value="recent" ${v.sort === 'recent' ? 'selected' : ''}>최근 ${((c.chart && c.chart.all && c.chart.all.v) || []).length}개</option><option value="top" ${v.sort === 'top' ? 'selected' : ''}>조회수 상위 ${((c.chart && c.chart.alltop && c.chart.alltop.v) || []).length}개 (전체)</option></select>` : '';
    const emptyMsg = m.day ? `${NAME[m.key]}에 보여 줄 하루 조회수가 아직 없습니다` : '아직 지표가 없습니다';
    const foot = c.foot ? `<div class="t7-foot">대기 ${num(c.foot.wait)} · 완료 ${num(c.foot.done)} · 재고 ${Number(c.foot.days).toFixed(1)}일</div>` : '';
    return `<div class="t7-card ${hot ? 'hot' : ''}" data-name="${attr(c.name)}">${spikeHtml(c)}${head}
      <div class="t7-nums">${numsHtml(c, m, v)}</div>
      <div class="chsel t7-tabs">${tabs}${sortSel}</div>
      ${chartHtml(m, emptyMsg)}
      <div class="t7-xnote">${esc(noteText(c, m))}</div>
      ${bestHtml(c, m)}${harvestHtml(c, hv)}${listHtml(c, v)}${foot}</div>`;
  }

  function chHtml() {
    const list = pick(cards(S.data.channels));
    if (!list.length) {
      return '<div class="empty"><div class="empty-i">📊</div><div class="empty-t">아직 잴 것이 없습니다</div><div class="empty-d">영상을 올린 뒤 🔄 지금 다시 재기 를 누르면<br>조회수·좋아요·댓글을 여기에 모읍니다.</div></div>';
    }
    return `<div class="t7-grid">${list.map(cardHtml).join('')}</div>`;
  }

  /* ───────────── 48시간 지표 ───────────── */
  function rvHtml() {
    const raw = S.data.review;
    const list = pick(cards(raw));
    if (!list.length) {
      return '<div class="empty"><div class="empty-i">⏱</div><div class="empty-t">지표를 아직 안 읽었습니다</div><div class="empty-d">위의 🔄 지금 다시 재기 를 누르면<br>채널마다 최근 48시간을 읽어 옵니다.</div></div>';
    }
    const total = !S.ch && raw && !Array.isArray(raw) && has(raw.total48) ? raw.total48 : list.reduce((a, x) => a + (x.views48 || 0), 0);
    const body = list.map(c => {
      const g = (c.chart && c.chart.set && c.chart.set.v48) || { v: [], lab: [], ttl: [], kind: 'day' };
      const m = modelOf(g, 'v48');
      const note = c.likesKind === 'cumulative' ? '<i class="n" title="좋아요·댓글은 유튜브가 평생 누적만 줍니다 — 48시간 증가분은 기록이 쌓이면 나옵니다">누적</i>' : '';
      return `<div class="t7-rcard"><div class="t7-ch"><b>${esc(c.label || c.name)}</b><span class="sp"></span><button class="tb" data-n="${attr(c.name)}" onclick="t7Refresh(this.dataset.n)" title="이 채널만 다시 읽기 (약 3유닛)">↻</button></div>
        <div class="t7-rbig">${has(c.views48) ? num(c.views48) : '—'}<i>48시간 조회수</i></div>
        <div class="t7-rsub"><span>채널 누적 <b>${has(c.cumulative) ? num(c.cumulative) : '—'}</b></span><span>좋아요 <b>${num(c.likes)}</b>${note}</span><span>댓글 <b>${num(c.comments)}</b>${note}</span></div>
        ${chartHtml(m, '아직 48시간 기록이 없습니다')}<div class="t7-xnote">${esc(noteText(null, m))}</div></div>`;
    }).join('');
    return `<div class="sechead" style="margin-top:4px"><span>모든 채널 · 최근 48시간 합계 <span class="t7-rtot">${num(total)}</span>회</span><span class="sechead-r">지금 어느 채널이 잘 돌고 있나</span></div><div class="t7-rgrid">${body}</div>`;
  }

  /* ───────────── 끌어올림 ───────────── */
  function lfHtml() {
    const list = pick(cards(S.data.lift));
    const note = `<div class="t7-lfnote"><b>읽는 법</b> — <i class="k pull"></i> 그날 가장 많이 오른 영상, <i class="k ride"></i> 같은 날 덩달아 오른 영상입니다.
      유튜브가 한 편을 밀어 주면 새로 온 사람이 채널을 둘러보면서 다른 편까지 올라갑니다. 그런 편을 더 만들고, 그날 다음 편을 올리면 덩달아 얹힙니다.
      <span class="w">같은 날 함께 올랐다는 사실만 말합니다. 한쪽이 다른 쪽을 올렸다는 뜻은 아닙니다 — 바깥 사건이 둘 다 밀어 올렸을 수도 있습니다.</span></div>`;
    if (!list.length) {
      return note + '<div class="empty"><div class="empty-i">🚀</div><div class="empty-t">아직 볼 것이 없습니다</div><div class="empty-d">지표를 갱신할 때마다 한 점씩 쌓입니다.</div></div>';
    }
    const row = (x, kind) => `<div class="t7-lf-row ${kind}"><span class="t" title="${attr(x['제목'])}">${esc(String(x['제목'] || '').slice(0, 34))}</span><span class="b"><i style="width:${Math.max(3, Number(x['폭']) || 3)}%"></i></span><span class="v">+${num(x['증가'])}<em>${esc(x['배수글'] || '')}</em></span></div>`;
    const body = list.map(c => {
      const head = `<div class="t7-ch"><b>${esc(c.label || c.name)}</b><span class="sp"></span><span class="t7-lf-n">${esc(c['말'] || '')}</span></div>`;
      const ev = c.events || [];
      if (!ev.length) {
        return `<div class="t7-lfcard">${head}<div class="t7-lf-wait">영상 ${num(c['영상수'])}개 · 기록 ${num(c['점수'])}일<i>지표를 갱신할 때마다 한 점씩 쌓입니다. 이틀치가 모이면 그날그날의 벌이를 견줄 수 있습니다.</i></div></div>`;
      }
      return `<div class="t7-lfcard">${head}${ev.map(e => `<div class="t7-lf-ev"><div class="t7-lf-d">${esc(e['날'] || '')}<span>그날 합계 +${num(e['합계'])} · 평소 +${num(e['평소합'])}</span></div>`
        + row(e['끈것'] || {}, 'pull') + (e['딸린것'] || []).map(x => row(x, 'ride')).join('')
        + (e['더'] > 0 ? `<div class="t7-lf-more">외 ${num(e['더'])}개</div>` : '') + '</div>').join('')}</div>`;
    }).join('');
    return `${note}<div class="t7-lfwrap">${body}</div>`;
  }

  /* ───────────── 그리기 ───────────── */
  function paintChips() {
    const names = chanList();
    if (S.ch && !names.includes(S.ch)) S.ch = '';
    let h = '';
    if (names.length > 1) {
      h = `<button class="${S.ch ? '' : 'on'}" data-ch="" onclick="t7Ch(this)">전체</button>`
        + names.map(n => `<button class="${S.ch === n ? 'on' : ''}" data-ch="${attr(n)}" onclick="t7Ch(this)">${esc(n)}</button>`).join('');
    }
    setHtml('t7Filter', h);
  }
  function paintBar() {
    const d = S.data, at = d ? atText(d.at ?? d.refreshedAt ?? d.refreshedText) : '';
    setText('t7At', S.loading && !d ? '불러오는 중…' : at ? `마지막 갱신 ${at}` : d ? '아직 읽지 않았습니다' : '');
    document.querySelectorAll('#t7Seg button').forEach(b => b.classList.toggle('on', b.dataset.s === S.sec));
  }
  function paintQuota(s) {
    const q = s && s.quota;
    setHtml('t7Quota', q && has(q.units)
      ? `<span>유닛 남음 <b>${num(q.unitsLeft)}</b> · 오늘 ${num(q.units)} 씀</span><span>업로드 남음 <b>${num(q.uploadsLeft)}</b> · 오늘 ${num(q.uploads)} 씀</span><span>${esc(q.reset || '')} 초기화</span>`
      : '');
  }
  function paintBody() {
    let h;
    if (!S.data) {
      h = S.error
        ? `<div class="empty small"><div class="empty-i">⚠️</div><div class="empty-t">${esc(S.error)}</div><div class="empty-d"><button class="tb" onclick="t7Retry()">다시 불러오기</button></div></div>`
        : '<div class="empty small"><div class="empty-i">⏳</div><div class="empty-t">불러오는 중…</div></div>';
    } else h = S.sec === 'rv' ? rvHtml() : S.sec === 'lf' ? lfHtml() : chHtml();
    $('t7Body').innerHTML = h;   // 카드를 따로 갈아 끼우므로 마지막에 쓴 글 비교(memo)는 쓰지 않는다
    paintBar();
  }
  /** 카드 하나만 다시 그린다(탭·정렬을 바꿀 때) — 다른 카드와 펼친 표는 그대로 */
  function repaintCard(name) {
    const c = findCard(name);
    const el = [...document.querySelectorAll('#t7Body .t7-card')].find(x => x.dataset.name === name);
    if (!c || !el) return;
    const t = document.createElement('template');
    t.innerHTML = cardHtml(c);
    el.replaceWith(t.content.firstElementChild);
  }

  /* ───────────── 읽기 ───────────── */
  async function load() {
    const mine = ++S.seq;
    S.loading = true; S.error = '';
    if (!S.data) paintBody(); else paintBar();
    let r;
    try { r = await api('/api/stats?ch=' + encodeURIComponent(S.ch)); }
    catch (e) {   // 서버가 끊기면 core 가 점으로 알린다 — 여기서는 화면 자리에만 조용히 적는다
      if (mine !== S.seq) return;
      S.loading = false;
      if (!S.data) { S.error = '앱에 연결되지 않아 성적을 불러오지 못했습니다'; paintBody(); }
      return;
    }
    if (mine !== S.seq) return;
    S.loading = false;
    if (!r || r.ok === false) {
      S.error = (r && r.why) || '성적을 불러오지 못했습니다';
      msg(S.error, 'err');
      if (!S.data) paintBody(); else paintBar();
      return;
    }
    S.data = S.cache[S.ch] = r; S.at = Date.now();
    paintChips(); paintBody();
  }

  /* ───────────── 눌렀을 때 ───────────── */
  function say(t) {
    const el = $('t7Res');
    el.className = 't7-res';
    el.innerHTML = `<span>${t}</span><button class="tb" onclick="t7ResClose()">닫기</button>`;
  }
  window.t7ResClose = () => { $('t7Res').className = 'hide'; };
  window.t7Retry = () => load();
  window.t7Ch = el => {
    const v = el.dataset.ch || '';
    if (v === S.ch) return;
    S.ch = v; S.data = S.cache[v] || null;
    paintChips(); paintBody();
    load();
  };
  window.t7Sec = s => {
    S.sec = s;
    try { sessionStorage.setItem('t7sec', s); } catch (_) {}
    if (S.data) paintBody(); else paintBar();
  };
  window.t7Tab = el => { viewOf(el.dataset.n).m = el.dataset.m; repaintCard(el.dataset.n); };
  window.t7Sort = el => { viewOf(el.dataset.n).sort = el.value; repaintCard(el.dataset.n); };
  window.t7ListSel = el => { viewOf(el.dataset.n).list = el.value; repaintCard(el.dataset.n); };
  window.t7Open = el => { viewOf(el.dataset.n).open = el.open; };

  /** 두 단추 중 하나가 도는 동안 다른 하나도 잠근다 */
  async function busyRun(btnId, busyText, fn) {
    if (S.busy) return;
    S.busy = true;
    const ids = ['t7BtnRefresh', 't7BtnAn'], old = $(btnId).textContent;
    ids.forEach(i => { $(i).disabled = true; });
    $(btnId).textContent = busyText;
    try { await fn(); }
    catch (_) { /* 서버가 끊기면 core 가 알린다 */ }
    finally { $(btnId).textContent = old; ids.forEach(i => { $(i).disabled = false; }); S.busy = false; }
  }

  /** 지표 다시 읽기 — 사람이 누를 때만. name 이 비면 지금 고른 채널(없으면 전부) */
  window.t7Refresh = async name => {
    if (S.busy) return;
    const target = name || S.ch || 'all';
    const all = target === 'all';
    const authed = chanList().filter(n => ((ST.channels || []).find(c => c.name === n) || {}).authed);
    if (all && !authed.length) return msg('구글에 연결된 채널이 없어 잴 수 없습니다. 채널 탭에서 먼저 연결해 주세요', 'err');
    const units = all ? authed.length * 3 : 3;
    const label = all ? '모든 채널' : (findCard(target) || {}).label || target;
    const ok = await confirmBox({
      emoji: '🔄', title: all ? '모든 채널의 성적을 다시 잴까요?' : `${label} 성적을 다시 잴까요?`,
      body: `유튜브에 물어봅니다. <b>구글 호출이 채널당 약 3유닛 듭니다.</b><br>${all ? `채널 ${authed.length}개 → 약 ${units}유닛이 ` : '약 3유닛이 '}오늘 한도에서 빠집니다.`,
      ok: '다시 재기',
    });
    if (!ok) return;
    await busyRun('t7BtnRefresh', '재는 중…', async () => {
      const r = await api('/api/perf/refresh', { ch: target });
      if (r.ok === false) return msg(r.why || '성적을 다시 재지 못했습니다', 'err');
      msg(`${num(r.n)}개 채널의 성적을 다시 쟀습니다${has(r.units) ? ` (유닛 ${num(r.units)} 사용)` : ''}`, 'ok');
      await load();
      poll();
    });
  };

  window.t7Analytics = () => busyRun('t7BtnAn', '받는 중…', async () => {
    const r = await api('/api/analytics/refresh', {});
    if (r.ok === false) return msg(r.why || '분석을 받지 못했습니다', 'err');
    const nm = x => (typeof x === 'string' ? x : x && (x.name || x.ch || x.key) || '');
    const got = (r.received || []).map(nm).filter(Boolean), bad = (r.failed || []).map(nm).filter(Boolean);
    if (r.recent) {
      say('30분 안에 이미 받아 둔 분석이 있어 새로 받지 않았습니다.');
      msg('이미 최근에 받아 둔 분석입니다', 'ok');
    } else {
      say(`분석을 받았습니다 — 성공 ${got.length}개${got.length ? ` (${esc(got.join(', '))})` : ''}${bad.length ? ` · <span style="color:var(--accent)">실패 ${bad.length}개 (${esc(bad.join(', '))})</span>` : ''}`);
      msg(bad.length ? `분석을 받았지만 ${bad.length}개 채널은 실패했습니다` : '분석을 받았습니다', bad.length ? 'err' : 'ok');
    }
    await load();
  });

  /* ───────────── 건강 팝업 ───────────── */
  const DOT = { 좋음: '🟢', 주의: '🟡', 위험: '🔴', 몰라: '⚪' };
  function fillHealth(title, grade, lines) {
    const gr = DOT[grade] ? grade : '몰라';
    const cls = gr === '좋음' ? 'g-ok' : gr === '주의' ? 'g-warn' : gr === '위험' ? 'g-bad' : 'g-unk';
    $('t7HEmoji').textContent = DOT[gr];
    $('t7HTitle').textContent = `${title} 건강`;
    $('t7HGrade').innerHTML = `<span class="t7-hb ${cls}" style="cursor:default">${gr === '좋음' ? '건강' : gr === '위험' ? '확인 필요' : gr === '주의' ? '주의' : '자료 부족'}</span>`;
    const norm = x => {
      if (x && typeof x === 'object') return { k: x['항목'] ?? x.item ?? '', g: x['등급'] ?? x.grade ?? '몰라', v: x['말'] ?? x.text ?? '' };
      const m = /^\[(.+?)\]\s*(.*?)\s*—\s*(.*)$/.exec(String(x));
      return m ? { g: m[1], k: m[2], v: m[3] } : { k: '', g: '몰라', v: String(x) };
    };
    const rows = (lines || []).map(norm);
    $('t7HRows').innerHTML = rows.length ? rows.map(r => {
      const c = r.g === '위험' ? 'g-bad' : r.g === '주의' ? 'g-warn' : '';
      return `<div class="t7-hr ${c}"><i style="font-style:normal">${DOT[r.g] || '⚪'}</i><span class="k">${esc(r.k)}</span><span class="v">${esc(r.v)}</span></div>`;
    }).join('') : '<div class="t7-foot" style="border:0">판정할 내용이 아직 없습니다 — 🔄 지금 다시 재기 뒤에 다시 열어 보세요</div>';
  }
  window.t7Health = async name => {
    const c = findCard(name) || {}, h0 = c.health || {}, label = c.label || name, mine = ++S.hseq;
    fillHealth(label, h0['등급'] || '몰라', h0['줄들'] || []);   // 이미 받은 값으로 바로 연다
    openModal('t7Health');
    try {
      const r = await api('/api/health', { ch: name });   // 로컬 계산 — 유튜브를 부르지 않는다
      // 그 사이 닫았거나 다른 채널의 팝업을 열었으면 늦게 온 답으로 덮어쓰지 않는다
      if (mine === S.hseq && r && r.ok !== false && $('t7Health').classList.contains('on')) {
        fillHealth(label, r.grade ?? r['등급'] ?? h0['등급'] ?? '몰라', r.lines ?? r['줄들'] ?? h0['줄들'] ?? []);
      }
    } catch (_) { /* 서버가 끊기면 core 가 알린다 — 받아 둔 값은 이미 보인다 */ }
  };
  window.t7HealthClose = () => closeModal('t7Health');
  registerModal('t7Health', window.t7HealthClose);

  registerTab('t7', {
    init() { paintChips(); paintBody(); },
    // 탭을 열 때 한 번 읽는다(3초 안에 다시 열면 받아 둔 것을 그대로 쓴다)
    show() {
      if (!S.data || Date.now() - S.at > 3000) load();
    },
    // 1.5초마다: 서버를 부르지 않고 이미 받은 상태로 채널 칩·한도 줄만 고친다
    paint(s) { paintChips(); paintQuota(s); },
  });
})();

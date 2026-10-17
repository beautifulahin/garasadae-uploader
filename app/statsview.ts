// 화면에 줄 자료 묶음 — 채널 성적 · 48시간 지표 · 끌어올림. (파이썬 dashboard.py 의 _v_stats · _v_review · _v_lift · _chart_html 이 보여 주던 자료)
//
// **HTML 은 만들지 않는다.** 여기서는 JSON 으로 직렬화되는 값만 만들고, 그리는 일은 메인이 새 화면에서 한다.
// 유튜브를 한 번도 부르지 않는다 — 이미 저장된 성적.json · 구독기록.json · 영상기록.json · 잦은기록.json · 분석기록.json ·
// profiles.json · ledger.csv 만 읽는다(화면을 열 때·놀 때 유튜브 호출 0건). 새로 읽는 일은 perf.ts 의 perfFetch() 만 한다.
//
// ───────────────────────── 반환 모양 ─────────────────────────
// statsView(chans, extra?)  →  StatsView
//   agency          boolean   대행 관리자 방식인가(제목·문구가 달라진다)
//   head / subtitle string    「채널 성적」 / 「채널의 지난 영상까지 포함한 실제 지표 · …」
//   refreshedAt     number|null  마지막 갱신(초) · refreshedText 「10월 16일 14:03」 · 없으면 null / ""
//   quota           { 유닛, 유닛한도, 유닛남음, 유닛퍼센트, 업로드, 업로드한도, 업로드남음, 업로드퍼센트, 빠듯, 초기화 }
//   cards[]         같은 channel_id 는 한 카드로 합쳐 먼저 등록한 이름 하나만(_같은채널묶기), channels.json 차례대로
//     name, label, cid, handle      label = policy.json 「표시이름」 대응 이름(없으면 name)
//     hasPerf       성적을 한 번이라도 읽었나(false 면 「아직 지표가 없습니다」)
//     spike         급등 판정(spike.ts) · spikeBand[]  급등 띠에 띄울 {이름, 배, 설명}
//     health        { 등급, 줄들[{항목,등급,말}], 빛, 말, 풍선 }   건강 배지
//     daily, dailyWhy, todayUploaded, remaining    오늘 목표 · 근거 · 오늘 올림 · 오늘 남은 권장
//     nums          { total, totalIsChannel, videos, recentCount, avgRecent, likes, comments }
//                   total = 채널 전체 누적 조회수(없으면 최근 영상 합), videos = 채널 영상 수
//     sub           { subs, subsText, grow, title, … }   구독자 한 장(perf.ts SubSnap) · grow = 증감 딱지 자료
//     country       「한국 92% · 미국 5%」 또는 ""
//     chart         { all, alltop, 전체, v7, v28, v90, _영상? }  ← 원본 data-set 과 같은 열쇠(아래 ChartSet)
//     best          { title, views } | null    가장 잘된 것
//     list          { recent[], top[] }   영상 하나하나 표 두 벌(최근 순 / 조회수 상위) — {at,title,views,v48,likes,comments,id}
//     foot          { wait, done, days } | null  extra.foot 를 준 채널만
// reviewView(chans)  →  ReviewView  { total48, empty, cards[] }
//   cards[]  { name, label, views48(null=「—」), cumulative, likes, comments, likesKind("increase"|"cumulative"), chart:{init:"v48", set:{v48}} }
// liftView(chans)    →  LiftView    { cards[] }   각 { name, label, 말, 영상수, 점수, 됨, events[ {날,날짜,합계,평소합,끈것,딸린것,딸린것수,더} ] }
//
// ChartSet (그래프 한 벌) — 화면 그리기 코드가 읽는 열쇠 그대로
//   영상 꼴(kind:"video")  v 조회수[] · lk 좋아요[] · cm 댓글[] · lab 올린날[] · ttl 제목[] · from · to
//   하루 꼴(kind:"day")    v 하루 조회수[] · lab 「MM/DD」[] · ttl[] · jam 센 날인가[] · cut 유튜브가 정정한 날인가[] · from · to
//                          누적{v[],lab[]} 누적 곡선 · src:"studio" · sum{v,h,s,lk,cm,geo} 스튜디오 요약 · 대신{…영상 꼴, n} 하루치를 못 낼 때 갈아 끼울 영상들
//   전체{v,n,표본}         채널 전체 누적 조회수 · 영상 수 · 표본(전 영상 수)
//   _영상{제목:{v7,v28,v90,all}}  영상 하나만 볼 때 쓰는 묶음(각 칸에 지금누적·하루평균·좋아요·댓글·나이가 얹힌다)
//                          — perVideo:false 로 빼고 videoCharts() 로 따로 받을 수 있다(영상이 많으면 자료가 크다)
//
// 같은 channel_id 를 쇼츠용/롱폼용 두 이름으로 등록한 경우 지표는 하나여야 한다 — 같은 조회수가 두 카드에 뜨고 합계가 두 배가 되는 것을
// 막는다. 끌어올림(liftView)은 원본도 이름마다 따로 보여 주므로 합치지 않는다.
import { dataPath, log, readJson } from "./paths.ts";
import { addDays, dateOnly, instantToWall, wall, wallNow } from "./clock.ts";
import { isAgency, loadChannels } from "./channels.ts";
import type { Channels } from "./channels.ts";
import * as quota from "./quota.ts";
import { countrySummary, loadAnalytics, periodSummary } from "./analytics.ts";
import type { AnalyticsStore, PeriodSummary } from "./analytics.ts";
import { readLedger } from "./ledger.ts";
import type { LedgerRow } from "./ledger.ts";
import { evaluate } from "./health.ts";
import { allSummary, cumulativeFlow, channelDailyViews, loadSources, recentIncrease } from "./lift.ts";
import type { LiftSrc } from "./lift.ts";
import { dailyOf, perfLoad, spikeOf, subscriberSnapshot, uploadedToday } from "./perf.ts";
import type { PerfEntry, PerfRowSaved, SubSnap } from "./perf.ts";
import { loadProfiles } from "./profile.ts";
import type { SpikeResult } from "./spike.ts";
import { commaInt, cut, dayNum, fixed, mmdd, msgOf, pyInt, pyRound, signedComma } from "./stats.ts";

type Obj = Record<string, any>;

/* ============================================================ 작은 도우미 */

/** 짧은 숫자 글자: 없으면 「—」, 1만 이상은 「1.2만」, 아니면 쉼표. (파이썬: dashboard._n) */
export function shortNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v >= 10000 ? `${fixed(v / 10000, 1)}만` : commaInt(v);
}

/** policy.json 「표시이름」 — 화면에 보이는 채널 이름 대응표. 서버로 돌아가는 식별자에는 쓰지 않는다. (파이썬: dashboard._표시) */
async function loadLabels(): Promise<Record<string, string>> {
  const pol = await readJson<Obj>(dataPath("policy.json"), {});
  const t = pol.표시이름;
  return t && typeof t === "object" && !Array.isArray(t) ? t : {};
}
const labelOf = (labels: Record<string, string>, name: string): string =>
  Object.hasOwn(labels, name) ? String(labels[name]) : name;

/** 채널을 사람이 정한 차례대로. 설정에 없는 것은 뒤에 붙인다. (파이썬: dashboard._order) */
export function orderNames(names: string[], chans: Channels = loadChannels()): string[] {
  const 차례 = Object.keys(chans).filter((k) => !k.startsWith("_"));
  const 앞 = 차례.filter((n) => names.includes(n));
  const 뒤 = names.filter((n) => !앞.includes(n)).sort();
  return [...앞, ...뒤];
}

/**
 * **같은 유튜브 채널을 두 번 세지 않는다.** (파이썬: dashboard._같은채널묶기)
 * 한 채널을 두 이름으로 등록할 때가 있다 — 쇼츠와 롱폼처럼 폴더를 갈라 두려는 것이다. 올리는 쪽은 그래야 하지만
 * **지표는 같은 채널이므로 하나여야 한다.** 채널ID 가 같으면 **먼저 등록된 이름 하나만** 남긴다.
 */
export function mergeSameChannel(names: string[], chans: Channels = loadChannels()): string[] {
  const 본것 = new Set<string>();
  const 난것: string[] = [];
  for (const n of names) {
    const cid = String(chans[n]?.channel_id ?? "").trim();
    if (cid && 본것.has(cid)) continue; // 이미 같은 채널을 넣었다
    if (cid) 본것.add(cid);
    난것.push(n);
  }
  return 난것;
}

/* ============================================================ 그래프 한 벌 */

export interface VideoSet {
  v: number[]; lk: number[]; cm: number[]; lab: string[]; ttl: string[]; kind: "video"; from: string; to: string;
}
export interface DayDat { 날: string; 값: number; 잼: boolean; 줄: boolean; 몇편?: number | null; 뺀편?: number }
export interface DaySet {
  v: number[]; lk: number[]; cm: number[]; lab: string[]; ttl: string[]; jam: boolean[]; cut: boolean[];
  kind: "day"; from: string; to: string;
  누적: { v: number[]; lab: string[] };
  src?: "studio";
  sum?: { v: number; h: number; s: number; lk: number; cm: number; geo: string };
  대신?: VideoSet & { n: number };
  누적만?: boolean;
  [k: string]: unknown;
}
export interface ChartSet {
  all: VideoSet; alltop: VideoSet;
  전체: { v: number | null; n: number | null; 표본: number };
  v7: DaySet; v28: DaySet; v90: DaySet;
  _영상?: Record<string, Obj>;
}

interface Ctx { lift: LiftSrc; analytics: AnalyticsStore }

const 창길이 = { v7: 7, v28: 28, v90: 90 } as const;

function videoSet(무리: PerfRowSaved[], 오늘문자: string): VideoSet {
  return {
    v: 무리.map((r) => r.views),
    lk: 무리.map((r) => r.likes || 0),
    cm: 무리.map((r) => r.comments || 0),
    lab: 무리.map((r) => r.at),
    ttl: 무리.map((r) => cut(r.title, 44)),
    kind: "video",
    from: 무리.length ? 무리[0].at : "", to: 오늘문자,
  };
}

/** 총계의 차이로 낸 채널 하루치 — Analytics 도, 영상별 기록도 없을 때의 마지막 대비책. (파이썬: _총계차이) */
function 총계차이(name: string, 며칠: number, c: Ctx): DayDat[] {
  // 조심할 것 두 가지
  //  · 앞날 기록이 없으면 증가분을 **낼 수 없다**. 0 이 아니라 「모름」 이다. 0 으로 두면 조회가 없었던 날처럼 보인다.
  //  · 유튜브가 조회수를 정정하면 총계가 **줄어든다**. 그때 음수를 0 으로 누르면 역시 조회가 없었던 것처럼 보인다. 따로 표시한다.
  const 기록 = c.lift.subs[name] ?? {};
  const 오늘 = wallNow();
  const 난것: DayDat[] = [];
  let 앞값: number | null = null;
  for (let i = 며칠; i >= 0; i--) {
    const 날 = addDays(오늘, -i);
    const v = pyInt((기록[dateOnly(날)] ?? {}).views);
    let 늘 = 0, 셀수있나 = false, 줄었나 = false;
    if (v !== null && 앞값 !== null) {
      const 차 = v - 앞값;
      셀수있나 = true;
      if (차 < 0) 줄었나 = true; // 유튜브가 조회수를 정정했다
      else 늘 = 차;
    }
    if (v !== null) 앞값 = v;
    if (i === 며칠) continue; // 첫날은 비교 대상이 없다
    난것.push({ 날: mmdd(날), 값: 늘, 잼: 셀수있나, 줄: 줄었나 });
  }
  return 난것;
}

/**
 * 채널 하루하루 조회수. (파이썬: _하루하루)
 * ⓪ 유튜브가 집계한 실측 일별값(스튜디오와 같은 창구, 같은 값)을 먼저 쓴다 — 받아 둔 것이 있으면 무조건 이것.
 * ① 없으면 **영상별 증가분의 합**(유튜브가 한 영상을 정정해도 그 영상만 빼면 되므로 하루치가 통째로 안 날아간다).
 * ② 그것도 이틀치가 안 모였으면 채널 총계의 차이로 물러선다.
 */
async function 하루하루(name: string, 며칠: number, c: Ctx, 요?: PeriodSummary | null): Promise<DayDat[]> {
  if (요 === undefined) {
    try {
      요 = await periodSummary(name, 며칠, c.analytics);
    } catch (e) {
      await log(`  분석 읽기 실패 — ${name}: ${cut(msgOf(e), 90)}`);
      요 = null;
    }
  }
  if (요 && 요.하루.length) {
    const 날값 = new Map<string, number>(요.하루.map((x) => [x.날, x.값]));
    const 끝 = wallNow();
    const 난: DayDat[] = [];
    for (let i = 며칠 - 1; i >= 0; i--) {
      const k = mmdd(addDays(끝, -i));
      // 유튜브 줄에 없는 날 = 아직 집계 전(맨 끝 하루 이틀). 0 이 아니라 「모름」 으로 둬야 죽은 날처럼 안 보인다.
      난.push({ 날: k, 값: 날값.get(k) ?? 0, 잼: 날값.has(k), 줄: false, 몇편: null, 뺀편: 0 });
    }
    return 난;
  }
  try {
    const 영상 = await channelDailyViews(name, 며칠, c.lift);
    if (영상.some((x) => x.잼)) {
      return 영상.map((x) => ({ 날: x.날, 값: x.값, 잼: x.잼, 줄: false, 몇편: x.몇편, 뺀편: x.뺀편 }));
    }
  } catch (e) {
    await log(`  영상별 합산 실패 — ${name}: ${cut(msgOf(e), 70)}`);
  }
  return 총계차이(name, 며칠, c);
}

/**
 * 그 기간에 올린 영상들. 하루 조회수를 못 낼 때의 대비책이다. (파이썬: _그기간영상)
 * 채널 하루 조회수는 **이틀치 기록**이 있어야 나온다. 기록이 모자라거나 유튜브가 조회수를 정정해 총계가 줄어든 날이면 낼 수가 없다.
 * 그때 빈 화면을 주는 대신 **그 기간에 올린 영상**을 보여 준다. 완전히 같은 것은 아니지만 아무것도 없는 것보다 낫다.
 */
function 그기간영상(seq: PerfRowSaved[], 며칠: number): PerfRowSaved[] {
  const 끝 = wallNow();
  const 시작n = dayNum(addDays(끝, -(며칠 - 1)));
  const 끝n = dayNum(끝);
  const 난것: PerfRowSaved[] = [];
  for (const r of seq) {
    const 조각 = String(r.at ?? "").split("/").map(pyInt); // at 은 「MM/DD」 또는 「YY/MM/DD」
    if (조각.some((x) => x === null) || 조각.length < 2) continue;
    const [a, b, d3] = 조각 as number[];
    const [y, m, d] = 조각.length === 3 ? [2000 + a, b, d3] : [끝.getUTCFullYear(), a, b];
    const w = wall(y, m, d);
    if (w.getUTCMonth() + 1 !== m || w.getUTCDate() !== d) continue; // 2월 30일 같은 날짜는 읽지 못한 것
    const n = dayNum(w);
    if (시작n <= n && n <= 끝n) 난것.push(r);
  }
  return 난것;
}

/** 채널 하나의 그래프 한 벌에서 하루 꼴 한 칸(7·28·90일)을 만든다 */
async function 기간칸(name: string, seq: PerfRowSaved[], 며칠: number, c: Ctx, 오늘문자: string, geo: string): Promise<DaySet> {
  let 요3: PeriodSummary | null = null;
  try {
    요3 = await periodSummary(name, 며칠, c.analytics);
  } catch (e) {
    await log(`  분석 요약 실패 — ${name}: ${cut(msgOf(e), 90)}`);
  }
  const 날들 = await 하루하루(name, 며칠, c, 요3);
  const 셀수있는날 = 날들.filter((x) => x.잼 && !x.줄).length;
  const 칸: DaySet = {
    v: 날들.map((x) => x.값), lk: [], cm: [],
    lab: 날들.map((x) => x.날),
    ttl: 날들.map((x) => x.날 + " 하루 조회수"),
    jam: 날들.map((x) => x.잼),
    cut: 날들.map((x) => x.줄),
    kind: "day",
    from: 날들.length ? 날들[0].날 : "", to: 오늘문자,
    누적: { v: [], lab: [] },
  };
  // 누적 곡선 — **뺄셈이 없으므로 언제나 값이 있다.** 하루치(증가분)는 두 점을 빼야 나오지만 누적은 찍은 그대로다.
  // 기록이 막 시작됐을 때 그래프가 텅 비어 보이던 원인이 이것이었다.
  try {
    const 흐 = await cumulativeFlow(name, null, 며칠, c.lift);
    칸.누적 = { v: 흐.map((x) => x.값), lab: 흐.map((x) => x.때) };
  } catch (e) {
    await log(`  누적 흐름 실패 — ${name}: ${cut(msgOf(e), 60)}`);
  }
  // 스튜디오 값이 있으면 요약·누적도 그 출처로 맞춘다. 막대는 위(하루하루)에서 이미 Analytics 를 먼저 쓴다 —
  // 요약 숫자·누적 곡선만 스냅샷으로 남기면 한 카드에서 셈이 어긋난다.
  if (요3 && 요3.하루.length) {
    칸.src = "studio";
    // 나라 상위 2개는 28일 고정 기준 — 어느 기간 탭에서 봐도 같은 값이라 라벨에 (28일) 을 함께 적어 준다.
    칸.sum = { v: 요3.조회수, h: 요3.시청시간, s: 요3.구독자, lk: 요3.좋아요, cm: 요3.댓글, geo };
    let 누 = 0;
    const 누v: number[] = [], 누lab: string[] = [];
    for (const x of 요3.하루) { 누 += x.값; 누lab.push(x.날); 누v.push(누); }
    칸.누적 = { v: 누v, lab: 누lab };
  }
  // 하루 조회수를 하루도 못 내면 그 기간 영상으로 갈아 끼운다.
  if (셀수있는날 === 0) {
    const 그것 = 그기간영상(seq, 며칠);
    칸.대신 = { ...videoSet(그것, 오늘문자), n: 그것.length };
  }
  return 칸;
}

/** 영상 하나의 하루 조회수 (영상기록.json 의 이틀 사이 증가분). (파이썬: _영상하루) */
function 영상하루(c: Ctx, name: string, 제목: string, 며칠: number): { 날: string; 값: number; 잼: boolean }[] {
  const 날들 = ((c.lift.video[name] ?? {})[제목]) ?? {};
  const 끝 = wallNow();
  const 난것: { 날: string; 값: number; 잼: boolean }[] = [];
  for (let i = 며칠 - 1; i >= 0; i--) {
    const 날 = addDays(끝, -i);
    const a = 날들[dateOnly(addDays(날, -1))], b = 날들[dateOnly(날)];
    const 셀수있나 = a !== undefined && a !== null && b !== undefined && b !== null && b >= a;
    난것.push({ 날: mmdd(날), 값: 셀수있나 ? b - a : 0, 잼: 셀수있나 });
  }
  return 난것;
}

/**
 * 영상 하나만 보기 — 목록에서 제목을 누르면 위 그래프가 그 영상만 보여 준다.
 * 자료는 영상기록.json(하루 한 점)과 잦은기록.json(시각별 점). 채널 그래프와 **같은 뼈대**를 쓴다 — 28일이면 28칸, 빈 날은 빈 칸.
 * (파이썬: _v_stats 안의 「영상 하나만 보기」)
 */
async function 영상별묶음(name: string, seq: PerfRowSaved[], c: Ctx, 오늘문자: string): Promise<Record<string, Obj>> {
  const 영상별: Record<string, Obj> = Object.create(null); // 제목이 열쇠 — 상속 칸이 없는 사전
  for (const r of seq) {
    const 제 = r.title;
    const 한칸: Obj = {};
    for (const [키, 며칠] of Object.entries(창길이)) {
      const 날들 = 영상하루(c, name, 제, 며칠);
      const 흐2 = await cumulativeFlow(name, 제, 며칠, c.lift);
      한칸[키] = {
        v: 날들.map((x) => x.값), lk: [], cm: [],
        lab: 날들.map((x) => x.날),
        ttl: 날들.map((x) => x.날 + " 하루 조회수"),
        jam: 날들.map((x) => x.잼), cut: 날들.map(() => false),
        kind: "day",
        from: 날들.length ? 날들[0].날 : "", to: 오늘문자,
        누적: { v: 흐2.map((x) => x.값), lab: 흐2.map((x) => x.때) },
      };
    }
    // 「전체」 는 그 영상의 **누적 조회수 곡선**. 찍어 둔 점이 있으면 그것을 쓰고(가장 최신값이 여기 있다),
    // 없으면 지표 캐시의 값 하나.
    const 흐0 = await cumulativeFlow(name, 제, 400, c.lift);
    if (흐0.length) {
      한칸.all = {
        v: 흐0.map((x) => x.값), lk: [], cm: [],
        lab: 흐0.map((x) => x.때),
        ttl: 흐0.map((x) => `${x.때} 누적`),
        jam: 흐0.map(() => true), cut: 흐0.map(() => false),
        kind: "day", 누적: { v: 흐0.map((x) => x.값), lab: 흐0.map((x) => x.때) },
        from: 흐0[0].때, to: 오늘문자, 누적만: true,
      };
    } else {
      한칸.all = {
        v: [r.views], lk: [r.likes || 0], cm: [r.comments || 0],
        lab: [r.at], ttl: [cut(r.title, 44)], kind: "video", from: r.at, to: 오늘문자,
      };
    }
    // 숫자칸에 쓸 값들을 실어 둔다. 누적값들을 평균 내면 누적과 거의 같은 수가 나와 두 칸이 같은 말을 하게 된다
    // (1,698 vs 1,695 가 그랬다). 영상의 「평균」 은 **하루 평균 조회수**(누적 ÷ 나이)여야 한다.
    const 지금누적 = 흐0.length ? 흐0[흐0.length - 1].값 : r.views;
    const 나이 = Math.max(Number(r.age) || 0, 0.04);
    const 영상값 = { 지금누적, 하루평균: pyRound(지금누적 / 나이), 좋아요: r.likes ?? null, 댓글: r.comments ?? null, 나이 };
    for (const 키 of [...Object.keys(창길이), "all"]) Object.assign(한칸[키], 영상값);
    영상별[제] = 한칸;
  }
  return 영상별;
}

/**
 * 영상 하나하나의 그래프 묶음만 따로. 카드 자료가 너무 커서 영상별 묶음을 뺀(perVideo:false) 화면이 제목을 눌렀을 때
 * 한 채널 몫을 받아 가는 길이다. 반환은 statsView 의 chart._영상 과 같다.
 */
export async function videoCharts(name: string): Promise<Record<string, Obj>> {
  const perf = await perfLoad();
  const seq = [...(perf[name]?.rows ?? [])].reverse();
  return await 영상별묶음(name, seq, { lift: await loadSources(), analytics: await loadAnalytics() }, mmdd(wallNow()));
}

/* ============================================================ 채널 성적 */

export interface HealthView { 등급: string; 줄들: { 항목: string; 등급: string; 말: string }[]; 빛: string; 말: string; 풍선: string }
export interface ListRow { id: string; at: string; title: string; views: number; v48: number; likes: number | null; comments: number | null }

export interface StatsCard {
  name: string; label: string; cid: string; handle: string;
  hasPerf: boolean;
  spike: SpikeResult;
  spikeBand: { 이름: string; 배: string; 설명: string }[];
  health: HealthView;
  daily: number; dailyWhy: string; todayUploaded: number; remaining: number;
  nums: {
    total: number; totalIsChannel: boolean; videos: number | null; recentCount: number;
    avgRecent: number; likes: number; comments: number;
  };
  sub: SubSnap | null;
  country: string;
  chart: ChartSet;
  best: { title: string; views: number } | null;
  list: { recent: ListRow[]; top: ListRow[] };
  foot: { wait: number; done: number; days: number } | null;
}

export interface QuotaView {
  유닛: number; 유닛한도: number; 유닛남음: number; 유닛퍼센트: number;
  업로드: number; 업로드한도: number; 업로드남음: number; 업로드퍼센트: number;
  빠듯: boolean; 초기화: string;
}

export interface StatsView {
  agency: boolean; head: string; subtitle: string;
  refreshedAt: number | null; refreshedText: string;
  quota: QuotaView;
  cards: StatsCard[];
}

/** 급등 띠에 띄울 조각들 — 조회수/구독자 중 급등인 것만. (파이썬: _spike_band 의 자료) */
export function spikeBandOf(s: SpikeResult | null | undefined): { 이름: string; 배: string; 설명: string }[] {
  if (!s || !s.급등) return [];
  const 조각: { 이름: string; 배: string; 설명: string }[] = [];
  for (const [이름, r] of [["조회수", s.조회], ["구독자", s.구독]] as const) {
    if (!(r && r.급등)) continue;
    조각.push({
      이름, 배: r.배수 ? `${fixed(r.배수, 1)}배` : "새로 늘기 시작", // 파이썬은 「16.0배」 처럼 소수 한 자리까지 찍는다
      설명: `최근 3일 ${signedComma(r.최근)} · 직전 3일 ${signedComma(r.평소)}`,
    });
  }
  return 조각;
}

/** 건강 배지 자료 — 계산이 터져도 배지는 떠야 한다(자료 없는 배지는 눌러도 무반응이라 「안 뜬다」 는 오해를 낳는다). (파이썬: _건강배지) */
async function healthView(name: string, c: Ctx, perf: Record<string, Obj>, ledger: LedgerRow[]): Promise<HealthView> {
  try {
    const r = await evaluate(name, { analytics: c.analytics, perf, ledger });
    const 빛 = ({ 좋음: "🟢", 주의: "🟡", 위험: "🔴", 몰라: "⚪" } as Record<string, string>)[r.등급] ?? "⚪";
    const 주의들 = r.줄들.filter((x) => x.등급 === "주의" || x.등급 === "위험");
    const 말 = 빛 + " " + (r.등급 === "좋음" ? "건강" : r.등급 === "위험" ? "확인 필요" : r.등급 === "주의" ? `주의 ${주의들.length}건` : "자료 부족");
    return { 등급: r.등급, 줄들: r.줄들, 빛, 말, 풍선: r.줄들.map((x) => `[${x.등급}] ${x.항목} — ${x.말}`).join("\n") };
  } catch (e) {
    await log(`  건전성 계산 실패 — ${name}: ${cut(msgOf(e), 80)}`);
    return {
      등급: "몰라",
      줄들: [{ 항목: "계산", 등급: "몰라", 말: `건전성 계산 실패 — ${cut(msgOf(e), 80)}. 지표 갱신 후 다시 보세요` }],
      빛: "⚪", 말: "건전성 ?", 풍선: "건전성 계산 실패",
    };
  }
}

function quotaView(): QuotaView {
  const q = quota.today();
  const 유 = pyRound((q.유닛 / q.유닛한도) * 100);
  const 업 = pyRound((q.업로드 / q.업로드한도) * 100);
  return {
    유닛: q.유닛, 유닛한도: q.유닛한도, 유닛남음: q.유닛남음, 유닛퍼센트: Math.min(유, 100),
    업로드: q.업로드, 업로드한도: q.업로드한도, 업로드남음: q.업로드남음, 업로드퍼센트: Math.min(업, 100),
    빠듯: 유 > 80 || 업 > 80, 초기화: q.초기화,
  };
}

const 리스트줄 = (r: PerfRowSaved): ListRow => ({
  id: r.id ?? "", at: r.at, title: r.title, views: r.views,
  // 48시간: 올린 지 이틀 안이면 지금 조회수 그대로, 아니면 하루 평균 × 2
  v48: (r.age ?? 0) <= 2 ? r.views : pyRound((r.vpd ?? 0) * 2),
  likes: r.likes, comments: r.comments,
});

/** 한 카드 */
async function 카드(
  name: string, chans: Channels, perf: Record<string, PerfEntry>, c: Ctx, ctx: {
    labels: Record<string, string>; profs: Record<string, Obj>; subs: Record<string, SubSnap>;
    올림: Record<string, number>; ledger: LedgerRow[];
    foot?: Record<string, { wait: number; done: number; days: number }>; perVideo: boolean;
  },
): Promise<StatsCard> {
  const cf = chans[name] ?? ({} as Obj);
  const cid = String(cf.channel_id ?? "");
  const pr = ctx.profs[cid] ?? {};
  const entry = perf[name];
  const rows = entry?.rows ?? [];
  // 올린 순서대로(왼쪽이 옛날) 놓아야 추이가 읽힌다 — 받아 둔 전부(최근 30편)
  const seq = [...rows].reverse();
  const 오늘문자 = mmdd(wallNow());
  const vs = seq.map((r) => r.views);
  const tot = vs.reduce((a, b) => a + b, 0);
  const likes = seq.reduce((a, r) => a + (r.likes || 0), 0);
  const cmts = seq.reduce((a, r) => a + (r.comments || 0), 0);
  let best: PerfRowSaved | null = null;
  for (const r of seq) if (!best || r.views > best.views) best = r; // 같으면 먼저(옛 영상) 것

  // 상위 30 은 **채널 전 영상**에서 고른 것(갱신 때 저장) — 최근 30 재정렬로 옛 히트작이 빠지던 것을 고쳤다(09-08).
  // 옛 갱신 자료면(톱30 없음) 최근 30 정렬로 물러선다.
  const 상위원본: PerfRowSaved[] = entry?.톱30?.length
    ? entry.톱30
    : [...rows].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 30);
  const 상위 = [...상위원본].sort((a, b) => (b.age || 0) - (a.age || 0)); // 그래프는 시간축 — 올린 순서로

  const geo = await countrySummary(name, 2, c.analytics);
  const chart: ChartSet = {
    all: videoSet(seq, 오늘문자),
    alltop: videoSet(상위, 오늘문자),
    // 채널 전체 누적(유튜브 채널 통계) — 큰 숫자가 이것을 보여 준다
    전체: { v: pr.views ?? null, n: pr.videos ?? null, 표본: entry?.전체편수 || rows.length },
    v7: await 기간칸(name, seq, 7, c, 오늘문자, geo),
    v28: await 기간칸(name, seq, 28, c, 오늘문자, geo),
    v90: await 기간칸(name, seq, 90, c, 오늘문자, geo),
  };
  if (ctx.perVideo) chart._영상 = await 영상별묶음(name, seq, c, 오늘문자);

  const [daily, dailyWhy] = await dailyOf(name, cf);
  const spike = await spikeOf(name);
  const todayUploaded = ctx.올림[name] ?? 0;

  return {
    name, label: labelOf(ctx.labels, name), cid, handle: String(pr.handle ?? ""),
    hasPerf: entry !== undefined && entry.rows !== undefined,
    spike, spikeBand: spikeBandOf(spike),
    health: await healthView(name, c, perf, ctx.ledger),
    daily, dailyWhy, todayUploaded, remaining: Math.max(0, daily - todayUploaded),
    nums: {
      total: pr.views !== null && pr.views !== undefined ? pr.views : tot,
      totalIsChannel: pr.views !== null && pr.views !== undefined,
      videos: pr.videos ?? null,
      recentCount: seq.length,
      avgRecent: pyRound((vs.length ? tot : 0) / Math.max(seq.length, 1)),
      likes: likes, comments: cmts,
    },
    sub: ctx.subs[name] ?? null,
    country: geo,
    chart,
    best: best ? { title: best.title, views: best.views } : null,
    list: { recent: rows.map(리스트줄), top: 상위원본.map(리스트줄) },
    foot: ctx.foot?.[name] ?? null,
  };
}

/**
 * 채널 성적 화면의 자료. (파이썬: _v_stats)
 * `chans` 를 안 주면 channels.json 을 읽는다. `extra.foot` 는 폴더 쪽(대기·완료·재고)을 아는 메인이 채널 이름별로 넘기는 값이다
 * (이 계층은 폴더를 보지 않는다). `extra.perVideo=false` 면 영상 하나만 보기 묶음(chart._영상)을 빼서 자료를 줄인다.
 */
export async function statsView(
  chans: Channels = loadChannels(),
  extra: { foot?: Record<string, { wait: number; done: number; days: number }>; perVideo?: boolean } = {},
): Promise<StatsView> {
  const perf = await perfLoad();
  const c: Ctx = { lift: await loadSources(), analytics: await loadAnalytics() };
  const names = mergeSameChannel(Object.keys(chans).filter((n) => !n.startsWith("_")), chans);
  const ctx = {
    labels: await loadLabels(), profs: await loadProfiles(), subs: await subscriberSnapshot(chans),
    올림: uploadedToday(), ledger: readLedger(), foot: extra.foot, perVideo: extra.perVideo !== false,
  };
  const cards: StatsCard[] = [];
  for (const n of names) cards.push(await 카드(n, chans, perf, c, ctx));

  let 갱신: number | null = null;
  for (const n of names) {
    const t = perf[n]?._at;
    if (t) { 갱신 = t; break; }
  }
  let 갱신글 = "";
  if (갱신) {
    const w = instantToWall(new Date(갱신 * 1000));
    갱신글 = `${String(w.getUTCMonth() + 1).padStart(2, "0")}월 ${String(w.getUTCDate()).padStart(2, "0")}일 ` +
      `${String(w.getUTCHours()).padStart(2, "0")}:${String(w.getUTCMinutes()).padStart(2, "0")}`;
  }
  const agency = isAgency();
  const tip = agency ? "고객사별로 따로 냅니다. 다른 고객사 숫자는 섞이지 않습니다." : "채널별과 전체를 함께 봅니다.";
  return {
    agency, head: agency ? "채널 성적" : "내 채널 성적",
    subtitle: `채널의 지난 영상까지 포함한 실제 지표 · ${tip}`,
    refreshedAt: 갱신, refreshedText: 갱신글, quota: quotaView(), cards,
  };
}

/* ============================================================ 48시간 지표 */

export interface ReviewCard {
  name: string; label: string;
  /** 최근 이틀 하루 조회수의 합(센 날만). 하루도 못 셌으면 null — 화면은 「—」 */
  views48: number | null;
  /** 채널 누적 조회수(구독기록의 마지막 점). 없으면 null */
  cumulative: number | null;
  likes: number; comments: number;
  /** 좋아요·댓글이 48시간 증가분인가, 아직 잦은 기록이 모자라 누적인가. 유튜브는 좋아요·댓글을 **평생 누적만** 준다. */
  likesKind: "increase" | "cumulative";
  chart: { init: "v48"; set: { v48: DaySet } };
}
export interface ReviewView { total48: number; empty: boolean; cards: ReviewCard[] }

/**
 * **모든 채널의 48시간 조회수를 한 화면에.** (파이썬: _v_review)
 * 지금 어느 채널이 잘 돌고 있나. 그래프는 채널 성적과 같은 모양(초록 곡선 = 누적, 막대 = 하루치)이되 48시간 하나만 본다.
 * 지표를 한 번이라도 읽은 채널만 나온다(성적.json 에 있는 이름).
 */
export async function reviewView(chans: Channels = loadChannels()): Promise<ReviewView> {
  const perf = await perfLoad();
  const names = mergeSameChannel(orderNames(Object.keys(perf), chans), chans);
  if (!names.length) return { total48: 0, empty: true, cards: [] };

  const src = await loadSources();
  const labels = await loadLabels();
  const 오늘문자 = mmdd(wallNow());
  const cards: ReviewCard[] = [];
  let 합계 = 0;
  for (const name of names) {
    const rows = perf[name]?.rows ?? [];
    let 날들: Awaited<ReturnType<typeof channelDailyViews>> = [];
    try {
      날들 = await channelDailyViews(name, 2, src);
    } catch (e) {
      await log(`  ${name} 하루 조회수 실패 — ${cut(msgOf(e), 60)}`);
    }
    const 아는 = 날들.filter((x) => x.잼);
    const 하루 = 아는.reduce((a, x) => a + x.값, 0);
    합계 += 하루;
    let 흐: Awaited<ReturnType<typeof cumulativeFlow>> = [];
    try {
      흐 = await cumulativeFlow(name, null, 2, src);
    } catch (e) {
      await log(`  ${name} 누적 흐름 실패 — ${cut(msgOf(e), 60)}`);
    }
    let 증 = { 좋아요: 0, 댓글: 0 };
    try {
      증 = await recentIncrease(name, 48, src);
    } catch (e) {
      await log(`  ${name} 최근 증가 실패 — ${cut(msgOf(e), 60)}`);
    }
    const 증가있음 = !!(증.좋아요 || 증.댓글);
    cards.push({
      name, label: labelOf(labels, name),
      views48: 아는.length ? 하루 : null,
      cumulative: 흐.length ? 흐[흐.length - 1].값 : null,
      likes: 증가있음 ? 증.좋아요 : rows.reduce((a, r) => a + (r.likes || 0), 0),
      comments: 증가있음 ? 증.댓글 : rows.reduce((a, r) => a + (r.comments || 0), 0),
      likesKind: 증가있음 ? "increase" : "cumulative",
      chart: {
        init: "v48",
        set: {
          v48: {
            v: 날들.map((x) => x.값), lk: [], cm: [],
            lab: 날들.map((x) => x.날),
            ttl: 날들.map((x) => x.날 + " 하루 조회수"),
            jam: 날들.map((x) => x.잼),
            cut: 날들.map(() => false), // 이 화면의 하루치는 영상별 합이라 정정한 날을 따로 표시하지 않는다
            kind: "day",
            from: 날들.length ? 날들[0].날 : "", to: 오늘문자,
            누적: { v: 흐.map((x) => x.값), lab: 흐.map((x) => x.때) },
          },
        },
      },
    });
  }
  return { total48: 합계, empty: false, cards };
}

/* ============================================================ 끌어올림 */

export interface LiftItemView { 제목: string; 증가: number; 배수: number | null; 배수글: string; 폭: number; 평소: number }
export interface LiftEventView {
  /** 「10/16」 */ 날: string; 날짜: string; 합계: number; 평소합: number;
  끈것: LiftItemView; 딸린것: LiftItemView[]; 딸린것수: number; 더: number;
}
export interface LiftCard { name: string; label: string; 말: string; 영상수: number; 점수: number; 됨: boolean; events: LiftEventView[] }
export interface LiftView { cards: LiftCard[] }

/**
 * 끌어올림 — 한 영상이 뜰 때 다른 영상도 같이 올랐는가. (파이썬: _v_lift)
 * 상관이지 인과가 아니다. 같은 날 함께 올랐다는 사실만 말한다. 사건은 채널마다 최근 6건, 딸린 영상은 건마다 5개까지 싣는다.
 * 원본처럼 같은 channel_id 라도 이름마다 따로 보여 준다.
 */
export async function liftView(chans: Channels = loadChannels()): Promise<LiftView> {
  const names = Object.keys(chans).filter((n) => !n.startsWith("_"));
  const 요약들 = await allSummary(names);
  const labels = await loadLabels();
  const cards: LiftCard[] = [];
  for (const name of names) {
    const s = 요약들[name];
    const 사건 = s?.사건 ?? [];
    const events: LiftEventView[] = 사건.slice(0, 6).map((e) => {
      // 막대 길이는 그 건에서 가장 많이 오른 영상(끈 영상 포함 전부)을 100% 로 잡는다
      const 폭 = Math.max(...[e.끈것, ...e.딸린것].map((x) => x.증가)) || 1;
      const 항목 = (x: typeof e.끈것): LiftItemView => ({
        제목: x.제목, 증가: x.증가, 배수: x.배수, 배수글: x.배수 ? `${fixed(x.배수, 1)}배` : "새로",
        폭: Math.max(pyRound((x.증가 / 폭) * 100), 3), 평소: x.평소,
      });
      return {
        날: e.날짜.slice(5).replace(/-/g, "/"), 날짜: e.날짜, 합계: e.합계, 평소합: e.평소합,
        끈것: 항목(e.끈것), 딸린것: e.딸린것.slice(0, 5).map(항목), 딸린것수: e.딸린것.length,
        더: Math.max(e.딸린것.length - 5, 0),
      };
    });
    cards.push({
      name, label: labelOf(labels, name), 말: s?.말 ?? "", 영상수: s?.영상수 ?? 0, 점수: s?.점수 ?? 0, 됨: !!s?.됨, events,
    });
  }
  return { cards };
}

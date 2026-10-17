// 동반 상승 — 한 영상이 피드를 타면 다른 영상도 같이 오르는가. (파이썬 lift.py)
//
// 무엇을 보는가
//   유튜브가 어떤 영상을 밀어 주기 시작하면, 그 채널의 **다른 영상까지** 덩달아 조회수가 오르는 일이 있다. 새로 온 사람이
//   채널을 둘러보기 때문이다. 그 순간이 언제였는지, 어느 영상이 끌었고 어느 영상이 딸려 올라갔는지를 날짜별 조회수에서 짚어낸다.
//     · 무엇이 채널 전체를 끌어올리는 종류인지 알게 된다 — 그런 걸 더 만든다
//     · 밀어 주기가 시작된 날 다음 편을 올리면 덩달아 얹힌다 — 올릴 때를 잡는다
//
// 어떻게 재는가
//   영상마다 날마다 조회수를 적어 둔다(`영상기록.json`). 이틀 사이의 증가분을 각 영상의 「그날 벌이」 로 보고 판정한다.
//     끈 영상(견인)   그날 벌이가 자기 평소의 2배가 넘고, 채널에서 가장 많이 는 것
//     딸린 영상(동반) 그날 벌이가 자기 평소의 1.5배가 넘은 나머지들
//   평소는 그 영상의 **최근 14일 중앙값**이다. 평균이 아니라 중앙값을 쓰는 까닭은, 딱 하루 튄 날이 평균을 끌어올려
//   그다음부터 아무것도 안 걸리게 만들기 때문이다.
//
// 무엇을 안 하는가
//   이건 상관이지 인과가 아니다. 같은 날 같이 올랐다는 사실만 말한다. 「이 영상 때문에 저 영상이 올랐다」 고는 쓰지 않는다 —
//   바깥 사건(뉴스·계절)이 둘 다 밀어 올렸을 수도 있다.
//
// 비용: 0. 지표를 갱신할 때 이미 받아 오는 값을 그대로 적어 두는 것뿐이다.
//
// 파일 두 개 (이름·꼴은 파이썬과 같다 — 같은 파일을 두 프로그램이 읽어도 깨지지 않게)
//   영상기록.json  { 채널: { 제목: { "2026-08-28": 조회수 } } }                  하루 한 점
//   잦은기록.json  { 채널: { 제목: { "2026-08-28T14": {"v":조회,"l":좋아요,"c":댓글} } } }  시각별 점(5일치)
import { dataPath, log, readJson, withFileLock, writeJson } from "./paths.ts";
import { addDays, addHours, dateOnly, isoWall, parseWall, wall, wallNow } from "./clock.ts";
import type { Wall } from "./clock.ts";
import { loadSubs } from "./subs.ts";
import { cut, dayNum, median, mmdd, msgOf, parseDay, pyRound } from "./stats.ts";

type Obj = Record<string, any>;

export const 견인배수 = 2.0; // 끈 영상: 평소의 몇 배부터
export const 동반배수 = 1.5; // 딸린 영상: 평소의 몇 배부터
export const 최소증가 = 30; // 이보다 적게 는 것은 잡음으로 본다
export const 평소창 = 14; // 평소를 재는 날 수
export const 보관일 = 120; // 이보다 오래된 기록은 버린다
export const 잦은보관 = 5; // 일. 이보다 오래된 점은 버린다(파일이 커진다)

export const videoRecordPath = () => dataPath("영상기록.json");
export const frequentPath = () => dataPath("잦은기록.json");

/** 영상기록.json:  채널 → 제목 → 날짜 → 조회수 */
export type VideoRecord = Record<string, Record<string, Record<string, number>>>;
/** 잦은기록.json 의 한 점. 옛 기록은 조회수 하나만 숫자로 들어 있다. */
type FreqPoint = number | { v?: number | null; l?: number | null; c?: number | null } | null;
export type FrequentRecord = Record<string, Record<string, Record<string, FreqPoint>>>;

/** 한 번 읽어 여러 번 쓰려고 묶은 자료 — 화면 한 장이 영상 수십 개를 그릴 때 파일을 수십 번 읽지 않게 */
export interface LiftSrc {
  video: VideoRecord;
  frequent: FrequentRecord;
  subs: Record<string, Record<string, Obj>>;
}

export async function loadSources(): Promise<LiftSrc> {
  return {
    video: await readJson<VideoRecord>(videoRecordPath(), {}),
    frequent: await readJson<FrequentRecord>(frequentPath(), {}),
    subs: await loadSubs(),
  };
}

const 시각키 = (w: Wall) => isoWall(w).slice(0, 13); // "2026-08-28T14"

/** 잦은기록의 한 점에서 값을 꺼낸다. 옛 기록은 숫자 하나, 새 기록은 {v,l,c} — 둘 다 받는다. */
function 값(x: FreqPoint | undefined, 무엇: "v" | "l" | "c" = "v"): number | null | undefined {
  if (x !== null && typeof x === "object") return x[무엇];
  return 무엇 === "v" ? (x as number | null | undefined) : null;
}

/**
 * 제목을 열쇠로 칸을 얻는다. 제목은 유튜브에서 오는 글이라 「__proto__」 「constructor」 같은 이름이어도 전역 객체를 건드리면
 * 안 된다 — 자기 소유 칸만 보고, 없으면 새로 만든다.
 */
function 칸얻기<T>(o: Record<string, T>, k: string, 새: () => T): T {
  if (!Object.hasOwn(o, k)) o[k] = 새();
  return o[k];
}

const 키순서 = <T>(o: Record<string, T> | undefined): [string, T][] =>
  Object.entries(o ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

/* ============================================================ 적기 */

/**
 * 오늘 영상별 조회수를 남긴다. 같은 날 다시 부르면 덮어쓴다. (파이썬: lift.적기)
 * 영상을 제목으로 묶는다. 영상 ID 가 지표에 안 실려 있어서인데, 같은 채널 안에서 제목이 겹치는 일은 드물고
 * 겹쳐도 합쳐 보일 뿐 값이 틀어지지는 않는다.
 */
export async function record(name: string, rows: { title?: string; views?: number | null }[]): Promise<void> {
  if (!rows?.length) return;
  await withFileLock(dataPath("영상기록.lock"), async () => {
    const d = await readJson<VideoRecord>(videoRecordPath(), {});
    const 오늘 = dateOnly(wallNow());
    const 칸 = 칸얻기<Record<string, Record<string, number>>>(d, name, () => ({}));
    for (const r of rows) {
      const 제목 = String(r.title ?? "").trim();
      if (!제목) continue;
      칸얻기<Record<string, number>>(칸, 제목, () => ({}))[오늘] = Math.trunc(Number(r.views) || 0);
    }
    // 오래된 것은 버린다. 안 그러면 파일이 끝없이 자란다.
    const 자를날 = dateOnly(addDays(wallNow(), -보관일));
    for (const [제목, 날들] of Object.entries(칸)) {
      for (const 날 of Object.keys(날들)) if (날 < 자를날) delete 날들[날];
      if (!Object.keys(날들).length) delete 칸[제목];
    }
    try {
      await writeJson(videoRecordPath(), d, { indent: 0 });
    } catch (e) {
      // 조용히 넘기면 왜 기록이 안 쌓이는지 알 수 없다.
      await log(`  영상 기록을 저장하지 못했습니다 — ${msgOf(e)}`);
    }
  });
}

/**
 * 영상별 조회수를 **시각까지 붙여** 남긴다. (파이썬: lift.잦게적기)
 *
 * 왜 하루 한 점으로 모자란가
 *   하루 한 점만 찍으면 「어제 총계 − 오늘 총계」 가 나오기까지 **하루를 꼬박 기다려야** 한다. 그동안 그래프는 텅 비어 있다.
 *   몇 시간에 한 번 찍으면 **그날 안에** 움직임이 보인다. 비용은 찍을 때마다 채널당 1유닛 + 전체 1유닛이다.
 *   하루 12번 찍어도 130유닛 안팎 — 하루 10,000 의 1.3% 다. **아낄 이유가 없다.**
 * 조회수만 찍던 것을 **좋아요·댓글까지** 함께 찍는다 — 이미 받아 온 값이라 유닛이 더 들지 않는다. 이것이 없으면
 * 「48시간 좋아요」 를 낼 수가 없어, 카드에 누적 합계를 대신 띄우고 있었다(이름은 48시간인데 값은 전체였다).
 */
export async function recordFrequent(
  name: string, rows: { title?: string; views?: number | null; likes?: number | null; comments?: number | null }[],
): Promise<void> {
  if (!rows?.length) return;
  await withFileLock(dataPath("잦은기록.lock"), async () => {
    const d = await readJson<FrequentRecord>(frequentPath(), {});
    const 이제 = 시각키(wallNow());
    const 칸 = 칸얻기<Record<string, Record<string, FreqPoint>>>(d, name, () => ({}));
    for (const r of rows) {
      const 제목 = String(r.title ?? "").trim();
      if (!제목) continue;
      칸얻기<Record<string, FreqPoint>>(칸, 제목, () => ({}))[이제] = {
        v: Math.trunc(Number(r.views) || 0),
        l: r.likes !== null && r.likes !== undefined ? Math.trunc(Number(r.likes)) : null,
        c: r.comments !== null && r.comments !== undefined ? Math.trunc(Number(r.comments)) : null,
      };
    }
    const 자를때 = 시각키(addDays(wallNow(), -잦은보관));
    for (const [제목, 점들] of Object.entries(칸)) {
      for (const k of Object.keys(점들)) if (k < 자를때) delete 점들[k];
      if (!Object.keys(점들).length) delete 칸[제목];
    }
    try {
      await writeJson(frequentPath(), d, { indent: 0 });
    } catch (e) {
      await log(`  잦은 기록을 저장하지 못했습니다 — ${msgOf(e)}`);
    }
  });
}

/* ============================================================ 읽기 */

/** 최근 N시간 증가분 */
export interface RecentIncrease { 조회: number; 좋아요: number; 댓글: number; 잼: boolean; 편: number }

/**
 * 이 채널이 최근 N시간에 **얼마나 늘었나** — 조회·좋아요·댓글. (파이썬: lift.최근증가)
 * 영상별로 앞뒤 두 점을 빼서 더한다. 줄어든 영상(유튜브가 정정한 것)은 그 영상만 뺀다. 점이 둘 이상 있는 영상이
 * 하나도 없으면 못 낸다(잼=false).
 */
export async function recentIncrease(name: string, hours = 48, src?: LiftSrc): Promise<RecentIncrease> {
  const 칸 = ((src?.frequent ?? await readJson<FrequentRecord>(frequentPath(), {}))[name]) ?? {};
  const 자름 = 시각키(addHours(wallNow(), -hours));
  const 난것: RecentIncrease = { 조회: 0, 좋아요: 0, 댓글: 0, 잼: false, 편: 0 };
  for (const 점들 of Object.values(칸)) {
    const 쓸것 = 키순서(점들).filter(([k]) => k >= 자름);
    if (쓸것.length < 2) continue;
    const 처음 = 쓸것[0][1], 끝 = 쓸것[쓸것.length - 1][1];
    for (const [키, 이름] of [["v", "조회"], ["l", "좋아요"], ["c", "댓글"]] as const) {
      const a = 값(처음, 키), b = 값(끝, 키);
      if (a === null || a === undefined || b === null || b === undefined) continue;
      const 차 = b - a;
      if (차 > 0) 난것[이름] += 차;
    }
    난것.잼 = true;
    난것.편++;
  }
  return 난것;
}

/**
 * 이 영상이 **최근 N시간** 동안 몇 회 늘었나. (파이썬: lift.영상최근)
 * 잦은 기록에서 N시간 전 이후의 점들을 본다. 점이 둘 이상 있어야 낸다.
 */
export async function videoRecent(
  name: string, title: string, hours = 48, src?: LiftSrc,
): Promise<{ 값: number; 잼: boolean; 점: number; 처음: string }> {
  const 점들 = ((src?.frequent ?? await readJson<FrequentRecord>(frequentPath(), {}))[name] ?? {})[title] ?? {};
  const 자름 = 시각키(addHours(wallNow(), -hours));
  const 쓸것 = 키순서(점들).filter(([k]) => k >= 자름);
  if (쓸것.length < 2) return { 값: 0, 잼: false, 점: 쓸것.length, 처음: "" };
  const 늘 = (값(쓸것[쓸것.length - 1][1]) || 0) - (값(쓸것[0][1]) || 0);
  return { 값: Math.max(늘, 0), 잼: 늘 >= 0, 점: 쓸것.length, 처음: 쓸것[0][0] };
}

const 시각키읽기 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;

/**
 * **누적 조회수**를 시간 순으로. 뺄셈이 없으므로 점 하나만 있어도 값이 있다. (파이썬: lift.누적흐름)
 *
 * 하루치(증가분)는 두 점을 빼야 나오지만, 누적은 찍은 그대로가 값이다. 그래서 기록이 막 시작됐을 때도 **곡선이 그려진다.**
 * 제목이 있으면 그 영상, 없으면 채널 전체(구독기록의 총조회수).
 */
export async function cumulativeFlow(
  name: string, title: string | null, days: number, src?: LiftSrc,
): Promise<{ 때: string; 값: number }[]> {
  const s = src ?? await loadSources();
  const 끝 = wallNow();
  const 시작 = addDays(끝, -days).getTime();
  const 점 = new Map<number, number>(); // 시각 → 값

  if (title) {
    // 잦은 기록(시각별) + 하루 기록을 합친다. 촘촘한 쪽이 이긴다.
    const 칸 = (s.frequent[name] ?? {})[title] ?? {};
    for (const [k, v] of Object.entries(칸)) {
      const m = 시각키읽기.exec(k);
      if (!m) continue;
      const t = wall(+m[1], +m[2], +m[3], +m[4]).getTime();
      if (t >= 시작) 점.set(t, 값(v) || 0);
    }
    for (const [k, v] of Object.entries(((s.video[name] ?? {})[title]) ?? {})) {
      const d0 = parseWall(k);
      if (!d0) continue;
      const t = wall(d0.getUTCFullYear(), d0.getUTCMonth() + 1, d0.getUTCDate(), 23).getTime();
      if (t >= 시작 && !점.has(t)) 점.set(t, v);
    }
  } else {
    for (const [k, v] of Object.entries(s.subs[name] ?? {})) {
      const 뷰 = (v ?? {}).views;
      if (뷰 === null || 뷰 === undefined) continue;
      const d0 = parseDay(k);
      if (!d0) continue;
      const t = wall(d0.getUTCFullYear(), d0.getUTCMonth() + 1, d0.getUTCDate(), 23).getTime();
      if (t >= 시작) 점.set(t, Math.trunc(Number(뷰)));
    }
  }

  return [...점.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => {
    const w = new Date(t);
    return { 때: `${mmdd(w)} ${String(w.getUTCHours()).padStart(2, "0")}시`, 값: v };
  });
}

/** 채널의 하루하루 조회수 한 칸 */
export interface DayViews { 날: string; 값: number; 잼: boolean; 몇편: number; 뺀편: number }

/**
 * 채널의 하루하루 조회수를 **영상별 증가분의 합**으로 낸다. (파이썬: lift.채널하루조회)
 *
 * 왜 채널 총계를 안 쓰나
 *   예전에는 `구독기록.json` 의 채널 총계를 하루씩 빼서 냈다. 그 방식은 유튜브가 **조회수를 정정하면 그날이 통째로 날아간다.**
 *   총계가 줄면 음수가 나오는데 그건 「조회 0회」 가 아니라 「알 수 없음」 이라서다. 실제로 한 채널은 하루에 62,812 이 정정돼
 *   그래프가 통째로 비었다. 영상별로 세면 그 사고가 **한 영상에만 갇힌다.** 정정된 영상 하나만 빼고 나머지는 그대로 더하면 된다.
 */
export async function channelDailyViews(name: string, days: number, src?: LiftSrc): Promise<DayViews[]> {
  const 칸 = ((src?.video ?? await readJson<VideoRecord>(videoRecordPath(), {}))[name]) ?? {};
  const 끝 = wallNow();
  const 난것: DayViews[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const 날 = addDays(끝, -i);
    const 어제 = dateOnly(addDays(날, -1));
    const 오늘 = dateOnly(날);
    let 늘 = 0, 편 = 0, 뺀 = 0;
    for (const 날들 of Object.values(칸)) {
      const a = 날들[어제], b = 날들[오늘];
      if (a === undefined || a === null || b === undefined || b === null) continue;
      const 차 = b - a;
      if (차 < 0) { 뺀++; continue; } // 이 영상만 정정됐다 — 이 영상만 뺀다
      늘 += 차;
      편++;
    }
    난것.push({ 날: mmdd(날), 값: 늘, 잼: 편 > 0, 몇편: 편, 뺀편: 뺀 });
  }
  return 난것;
}

/** 날짜 → 그날 늘어난 조회수. 첫날은 알 수 없으니 뺀다. */
function 하루벌이(날들: Record<string, number>): Record<string, number> {
  const 차례 = Object.keys(날들).sort();
  const 난것: Record<string, number> = {};
  for (let i = 1; i < 차례.length; i++) {
    const 앞 = 차례[i - 1], 뒤 = 차례[i];
    const 폭 = dayNum(parseDay(뒤)!) - dayNum(parseDay(앞)!) || 1;
    난것[뒤] = pyRound((날들[뒤] - 날들[앞]) / 폭); // 빠진 날은 고르게 나눈다
  }
  return 난것;
}

export interface LiftItem { 제목: string; 증가: number; 배수: number | null; 평소: number }
export interface LiftEvent { 날짜: string; 끈것: LiftItem; 딸린것: LiftItem[]; 합계: number; 평소합: number }

/**
 * 동반 상승이 일어난 날들. 최근 것부터. (파이썬: lift.사건들)
 * 한 건은 {날짜, 끈것:{제목,증가,배수,평소}, 딸린것:[…], 합계, 평소합}
 */
export async function events(name: string, days = 30, src?: LiftSrc): Promise<LiftEvent[]> {
  const 칸 = ((src?.video ?? await readJson<VideoRecord>(videoRecordPath(), {}))[name]) ?? {};
  if (Object.keys(칸).length < 2) return [];

  const 벌이: Record<string, Record<string, number>> = {};
  for (const [제목, 날들] of Object.entries(칸)) 벌이[제목] = 하루벌이(날들);
  const 평소: Record<string, number> = {};
  for (const [제목, 날들] of Object.entries(벌이)) {
    const 값들 = 키순서(날들).slice(-평소창).map(([, v]) => v);
    평소[제목] = 값들.length ? median(값들) : 0;
  }

  const 끝 = dateOnly(wallNow());
  const 시작 = dateOnly(addDays(wallNow(), -(days - 1)));
  const 모든날 = [...new Set(Object.values(벌이).flatMap((v) => Object.keys(v)))].sort();

  const 난것: LiftEvent[] = [];
  for (const 날 of 모든날) {
    if (!(시작 <= 날 && 날 <= 끝)) continue;
    const 그날: LiftItem[] = [];
    for (const [제목, 날들] of Object.entries(벌이)) {
      const v = 날들[날];
      if (v === undefined || v === null || v < 최소증가) continue;
      const 기준 = 평소[제목] || 0;
      const 배 = 기준 > 0 ? v / 기준 : null;
      그날.push({ 제목, 증가: v, 배수: 배 ? pyRound(배, 1) : null, 평소: pyRound(기준) });
    }
    if (그날.length < 2) continue;
    그날.sort((a, b) => b.증가 - a.증가);
    const 끈것 = 그날[0];
    if (끈것.배수 !== null && 끈것.배수 < 견인배수) continue;
    const 딸린것 = 그날.slice(1).filter((x) => x.배수 === null || x.배수 >= 동반배수);
    if (!딸린것.length) continue;
    난것.push({
      날짜: 날, 끈것, 딸린것,
      합계: 그날.reduce((a, x) => a + x.증가, 0),
      평소합: pyRound(그날.reduce((a, x) => a + (평소[x.제목] ?? 0), 0)),
    });
  }
  난것.sort((a, b) => (a.날짜 < b.날짜 ? 1 : a.날짜 > b.날짜 ? -1 : 0));
  return 난것;
}

export interface LiftSummary { 영상수: number; 점수: number; 폭: number; 사건: LiftEvent[]; 됨: boolean; 말: string }

/** 채널 하나의 동반 상승 요약. (파이썬: lift.요약) */
export async function summary(name: string, days = 30, src?: LiftSrc): Promise<LiftSummary> {
  const 칸 = ((src?.video ?? await readJson<VideoRecord>(videoRecordPath(), {}))[name]) ?? {};
  const 점 = [...new Set(Object.values(칸).flatMap((v) => Object.keys(v)))].sort();
  let 폭 = 0;
  if (점.length >= 2) 폭 = dayNum(parseDay(점[점.length - 1])!) - dayNum(parseDay(점[0])!);
  const ev = 폭 >= 2 ? await events(name, days, src ?? { video: { [name]: 칸 }, frequent: {}, subs: {} }) : [];
  return {
    영상수: Object.keys(칸).length, 점수: 점.length, 폭, 사건: ev, 됨: 폭 >= 2,
    말: ev.length ? `${ev.length}번 있었습니다`
      : 폭 >= 2 ? "아직 동반 상승이 잡히지 않았습니다"
      : `${점.length}일째 기록 중 — ${Math.max(3 - 점.length, 1)}일 뒤부터 볼 수 있습니다`,
  };
}

/** 여러 채널의 요약. 하나가 터져도 나머지는 계속 간다. (파이썬: lift.all_summary) */
export async function allSummary(names: string[], days = 30, src?: LiftSrc): Promise<Record<string, LiftSummary>> {
  const s = src ?? await loadSources();
  const 난것: Record<string, LiftSummary> = {};
  for (const n of names) {
    try {
      난것[n] = await summary(n, days, s);
    } catch (e) {
      await log(`  ${n} 동반 상승 요약 실패 — ${cut(msgOf(e), 70)}`);
      난것[n] = { 영상수: 0, 점수: 0, 폭: 0, 사건: [], 됨: false, 말: "" };
    }
  }
  return 난것;
}

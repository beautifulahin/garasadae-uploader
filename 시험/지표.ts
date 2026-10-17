// 지표 시험 — 채널 성적 · 48시간 지표 · 끌어올림 · 급등 · 건강 · 편수 · 고르기 · 배운 것 · 구독 갱신 · 갱신 전체 흐름.
//
//   TZ=Asia/Seoul deno run -A --no-lock 시험/지표.ts
//
// 기대값의 출처
//   아래 「기대」 숫자·글자는 사람이 짐작해 적은 것이 아니다. **현재 업로더(파이썬) 원본 코드를 같은 자료 · 같은 시계(2026-10-17 12:00 한국)로 돌려
//   뽑은 값**이다 — spike.py · lift.py · 건강.py · 분석.py · picker.py · stats.py · insight.py · subs.py · profile.py · published.py,
//   그리고 dashboard.py 의 perf_fetch · _v_stats · _v_review · _v_lift 가 화면에 보여 주던 자료.
//   큰 덩어리(그래프 묶음 · 저장 파일)는 정렬한 JSON 의 SHA-256 앞 16글자로 둔다. 숫자 하나가 달라져도 바뀐다.
//   원본과 일부러 다르게 한 곳은 시험 안에 까닭을 적었다.
//
// 구글에는 한 번도 닿지 않는다: 가짜 서버(시험/가짜구글.ts)와 임시 폴더(시험/도구.ts 모래상자)만 쓴다.
import { 같나 as 원래같나, 결과, 구역, 던지나, 모래상자 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { dataPath, recordPath, writeJson } from "../app/paths.ts";
import { addDays, addHours, dateOnly, isoWall, systemZone, wall, wallNow } from "../app/clock.ts";
import { toCsv } from "../app/ledger.ts";
import * as quota from "../app/quota.ts";
import { loadChannels } from "../app/channels.ts";
import type { Channels } from "../app/channels.ts";
import {
  MATURE_HOURS, RECENT, SAMPLE, commaFixed, commaFloat, commaInt, cut, decideFromRows, dailyFor, fixed, median, mmdd,
  multiChannelMetrics, perfTable, pyInt, pyRound, recentPerformance, recentShorts, signedComma, statsOnce, uploadsPlaylist,
} from "../app/stats.ts";
import * as picker from "../app/picker.ts";
import { bestBucket, describe, DUR_BUCKETS, HOUR_BUCKETS, isoDurToSec, learn } from "../app/insight.ts";
import { allJudge, judge } from "../app/spike.ts";
import * as lift from "../app/lift.ts";
import * as analytics from "../app/analytics.ts";
import { evaluate } from "../app/health.ts";
import * as subs from "../app/subs.ts";
import * as perf from "../app/perf.ts";
import * as published from "../app/published.ts";
import * as sv from "../app/statsview.ts";
import { apiStatistics, loadProfiles, refreshStatistics, remember, saveProfiles, statisticsDue } from "../app/profile.ts";

type Obj = Record<string, any>;

/* ============================================================ 도우미 */

const 진짜Date = Date;
const 고정ms = Date.UTC(2026, 9, 17, 3, 0, 0); // 2026-10-17 12:00 한국

/** 시험 동안 「지금」을 2026-10-17 12:00 한국으로 못 박는다. 끝나면 되돌린다(다른 시험이 같은 프로세스에서 이어 돈다). */
async function 고정시계<T>(일: () => Promise<T>): Promise<T> {
  class 고정Date extends (진짜Date as any) {
    constructor(...a: any[]) { if (a.length === 0) super(고정ms); else super(...a); }
    static now() { return 고정ms; }
  }
  (globalThis as any).Date = 고정Date;
  try { return await 일(); } finally { (globalThis as any).Date = 진짜Date; }
}

/**
 * 열쇠를 글자 순으로 정렬한 JSON 글. 파이썬 쪽에서 `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` 로 뽑은 것과
 * 한 글자도 다르지 않아야 해시가 맞는다 — 그래서 객체를 만들어 정렬하지 않고 글을 직접 이어 붙인다
 * (자바스크립트 객체는 「7」 「28」 같은 숫자 열쇠를 글자 순이 아니라 숫자 순으로 앞에 세운다).
 */
function 정렬글(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(정렬글).join(",") + "]";
  if (x && typeof x === "object") {
    const o = x as Obj;
    const ks = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return "{" + ks.map((k) => JSON.stringify(k) + ":" + 정렬글(o[k])).join(",") + "}";
  }
  return JSON.stringify(x) ?? "null";
}
async function 해시(x: unknown): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(정렬글(x)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
/** 열쇠 차례가 달라도 같은 값이면 같다 (undefined 는 JSON 처럼 빠지거나 null) */
function 같나(무엇: string, 실제: unknown, 바람: unknown) { 원래같나(무엇, JSON.parse(정렬글(실제)), JSON.parse(정렬글(바람))); }
const 같은값 = 같나;
async function 같은해시(무엇: string, 실제: unknown, 바람: string) { 원래같나(무엇, await 해시(실제), 바람); }

/** JSON 으로 그대로 적을 수 없는 값이 어디 숨었나 — 화면은 이 자료를 JSON 으로 받는다 */
function 직렬화새는것(x: unknown, 길 = "$"): string[] {
  if (x === undefined) return []; // 객체 칸의 undefined 는 JSON 에서 빠질 뿐이다
  if (typeof x === "number") return Number.isFinite(x) ? [] : [`${길}: ${x}`];
  if (typeof x === "function" || typeof x === "symbol" || typeof x === "bigint") return [`${길}: ${typeof x}`];
  if (x === null || typeof x !== "object") return [];
  if (Array.isArray(x)) return x.flatMap((v, i) => (v === undefined ? [`${길}[${i}]: undefined`] : 직렬화새는것(v, `${길}[${i}]`)));
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) return [`${길}: ${proto?.constructor?.name ?? "?"}`];
  return Object.entries(x as Obj).flatMap(([k, v]) => 직렬화새는것(v, `${길}.${k}`));
}

const CID: Record<string, string> = Object.fromEntries([..."ABCDE"].map((x) => [x, "UC" + x.repeat(22)]));
const 하루 = (k: number): string => dateOnly(addDays(wallNow(), -k));
const 시각키 = (k: number): string => isoWall(addHours(wallNow(), -k)).slice(0, 13);
const 월일 = (k: number): string => mmdd(addDays(wallNow(), -k));
const p2 = (n: number) => String(n).padStart(2, "0");
const NOW_EPOCH = 1792206000; // 2026-10-17T12:00:00+09:00
const 범위 = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/* ============================================================ 시험 자료 (파이썬 쪽과 한 글자도 다르지 않게) */

export function 자료(): { 파일: Record<string, Obj>; 원장: Record<string, string>[] } {
  const F: Record<string, Obj> = {};
  F["channels.json"] = {
    "_메모": { "설명": "밑줄로 시작하는 칸은 채널이 아니다" },
    "채널A": { channel_id: CID.A, folder: "" },
    "채널A롱": { channel_id: CID.A, folder: "", 롱폼: true },
    "채널B": { channel_id: CID.B, folder: "", daily_rule: "fixed", daily: 3 },
    "채널C": { channel_id: CID.C, folder: "", daily_fallback: 2 },
    "채널D": { channel_id: CID.D, folder: "" },
  };
  F["profiles.json"] = {
    [CID.A]: { channel_id: CID.A, title: "채널A", handle: "@a", subscribers: 5056, subscribers_api: 5056, subscribers_exact: false,
      subscribers_source: "youtube_data_api", subscribers_at: NOW_EPOCH - 600, statistics_at: NOW_EPOCH - 600, views: 1020500, videos: 40 },
    [CID.B]: { channel_id: CID.B, title: "채널B", handle: "@b", subscribers: 120, subscribers_api: 120, subscribers_exact: true,
      subscribers_source: "youtube_data_api", subscribers_at: NOW_EPOCH - 600, statistics_at: NOW_EPOCH - 600, views: 40000, videos: 12 },
    [CID.C]: { channel_id: CID.C, title: "채널C", handle: "@c", subscribers: null, subscribers_api: null, subscribers_exact: false,
      subscribers_source: "youtube_data_api", statistics_at: NOW_EPOCH - 600, views: null, videos: 3 },
  };

  // ── 구독기록.json
  const 구독: Obj = {};
  const 합 = (i: number, f: (j: number) => number) => { let s = 0; for (let j = 1; j <= i; j++) s += f(j); return s; };
  const series = (name: string, fV: (i: number) => number | null, fS: (i: number) => number | null, n = 15, skip: number[] = []) => {
    const d: Obj = {};
    for (let i = 0; i < n; i++) {
      const k = n - 1 - i;
      if (skip.includes(k)) continue;
      d[하루(k)] = { subs: fS(i), views: fV(i), videos: 40 };
    }
    구독[name] = d;
  };
  const aViews = (i: number) => 1000000 + 합(i, (j) => (j <= 11 ? 1500 : 5500)); // 하루 1500, 마지막 3일은 5500
  const aSubs = (i: number) => 5000 + 합(i, (j) => (j <= 11 ? 4 : 44)); // 하루 4, 마지막 3일은 44
  series("채널A", aViews, aSubs);
  series("채널A롱", aViews, aSubs);
  series("채널B", (i) => 30000 + 2000 * i, (i) => 100 + i);
  series("채널C", (i) => (i !== 7 ? 70000 + 300 * i : null), (i) => (i < 6 ? 800 + 10 * i : null), 15, [5, 4]);
  // 급등 경계 사례: 날짜는 2026-03-01 부터(급등 판정은 오늘이 아니라 마지막 기록일 기준)
  const absSeries = (name: string, pts: [number, number, number | null][]) => {
    const d: Obj = {};
    for (const [dd, v, s] of pts) d[dateOnly(addDays(wall(2026, 3, 1), dd))] = { subs: s, views: v, videos: 1 };
    구독[name] = d;
  };
  absSeries("S새로", 범위(10).map((i) => [i, i <= 6 ? 1000 : 1000 + 400 * (i - 6), 50 + (i <= 6 ? 0 : 20 * (i - 6))]));
  absSeries("S잡음", 범위(10).map((i) => [i, 5000 + (i <= 6 ? 10 * i : 60 + 100 * (i - 6)), 200]));
  absSeries("S빠진날", [0, 3, 4, 5, 6, 7, 8, 9, 11].map((d) => [d, 2000 + 90 * d, 300 + 2 * d]));
  absSeries("S구독없음", 범위(8).map((i) => [i, 3000 + 700 * i, null]));
  absSeries("S부족", 범위(5).map((i) => [i, 100 * i, 10 * i]));
  absSeries("S두배", [700, 800, 900, 1000, 1100, 1200, 1300, 1500, 1700, 1900].map((v, i) => [i, v, 400])); // 직전 300 · 최근 600 = 정확히 2배
  absSeries("S하락", 범위(10).map((i) => [i, 9000 + (i <= 6 ? 800 * i : 4800 + 100 * (i - 6)), 400 + (i <= 6 ? 30 * i : 180 + (i - 6))]));
  F["구독기록.json"] = 구독;

  // ── 영상기록.json (영상별 하루 한 점)
  const inc = [100, 80, 60, 50, 40, 30];
  const bump = [1500, 500, 120, 5, 0, 0]; // j=7(2일 전)에 끌고 딸린 영상
  const vid: Obj = { "채널A": {}, "채널B": {} };
  for (let t = 0; t < 6; t++) {
    const d: Obj = {};
    let v = 1000 * (t + 1);
    for (let j = 0; j < 10; j++) {
      const k = 9 - j;
      if (t === 5 && j < 9) continue; // 마지막 영상은 점이 하나뿐(새 영상)
      if (j > 0) v += inc[t] + (j === 7 ? bump[t] : 0);
      d[하루(k)] = v;
    }
    vid["채널A"][`A영상${t + 1}`] = d;
  }
  for (let t = 0; t < 3; t++) {
    const d: Obj = {};
    let v = 500 * (t + 1);
    for (let j = 0; j < 6; j++) {
      const k = 5 - j;
      if (j > 0) v += 50 + (t === 1 && j === 4 ? 20 : 0);
      d[하루(k)] = v;
    }
    vid["채널B"][`B영상${t + 1}`] = d;
  }
  // 끌어올림 경계 사례(채널L): 평소가 0 인 영상(배수 못 냄) · 잡음 미만 · 끈 영상 배수 부족
  const L: Obj = {};
  const specs: Record<string, [number, number[]]> = {
    "L영상1": [100, [...Array(7).fill(0), 60]], // 내내 0 이다 오늘 +60 → 평소 0, 배수 못 냄
    "L영상2": [200, [...Array(7).fill(0), 45]], // 같은 날 +45
    "L영상3": [300, [...Array(7).fill(0), 29]], // +29 → 잡음 미만
    "L영상4": [400, [60, 60, 60, 66, 60, 60, 60, 60]], // 평소 60, 4일 전 +66 → 배수 1.1
    "L영상5": [500, [35, 35, 35, 40, 35, 35, 35, 35]],
  };
  for (const [name, [base, steps]] of Object.entries(specs)) {
    const d: Obj = {};
    let v = base;
    for (let jj = 0; jj < 8; jj++) { v += steps[jj]; d[하루(7 - jj)] = v; }
    L[name] = d;
  }
  vid["채널L"] = L;
  const M: Obj = {}; // 2일 전: 평소의 정확히 2.0배(끈) · 1.5배(딸림)
  for (const [name, [base, steps]] of Object.entries({ "M영상1": [1000, [100, 100, 100, 100, 100, 200, 100, 100]], "M영상2": [2000, [40, 40, 40, 40, 40, 60, 40, 40]] }) as [string, [number, number[]]][]) {
    const d: Obj = {};
    let v = base;
    for (let jj = 0; jj < 8; jj++) { v += steps[jj]; d[하루(7 - jj)] = v; }
    M[name] = d;
  }
  vid["채널M"] = M;
  vid["채널B"]["B영상1"][하루(1)] = vid["채널B"]["B영상1"][하루(2)] - 7; // 정정된 영상(총계가 줄어듦) 하나
  F["영상기록.json"] = vid;

  // ── 잦은기록.json (시각별 점 · 30시간)
  const fr: Obj = { "채널A": {}, "채널B": {} };
  for (let t = 0; t < 2; t++) {
    const d: Obj = {};
    [30, 27, 24, 21, 18, 15, 12, 9, 6, 3, 0].forEach((h, idx) => {
      d[시각키(h)] = { v: 2000 * (t + 1) + 10 * idx, l: 20 * (t + 1) + idx, c: 2 + Math.floor(idx / 3) };
    });
    fr["채널A"][`A영상${t + 1}`] = d;
  }
  {
    const d: Obj = {}; // 옛 꼴: 숫자 하나
    [40, 20, 5].forEach((h, idx) => { d[시각키(h)] = 900 + 15 * idx; });
    fr["채널A"]["A영상3"] = d;
  }
  fr["채널B"]["B영상1"] = { [시각키(6)]: { v: 700, l: null, c: null }, [시각키(1)]: { v: 730, l: null, c: null } };
  F["잦은기록.json"] = fr;

  // ── 분석기록.json (채널A: 어제까지 99일치)
  const 줄: any[][] = [], 종류: any[][] = [];
  for (let k = 99; k >= 1; k--) {
    const views = 500 + ((k * 7) % 50) + (k < 14 ? 100 : 0);
    줄.push([하루(k), views, views * 2, 3 + (k % 3), k % 2, Math.floor(views / 20), Math.floor(views / 100), k % 4]);
    종류.push([하루(k), "shorts", Math.floor((views * 8) / 10), views, Math.floor((views * 5) / 10)]);
    종류.push([하루(k), "long", Math.floor((views * 2) / 10), views * 3, Math.floor(views / 10)]);
  }
  const 받은때 = isoWall(wallNow());
  F["분석기록.json"] = {
    "채널A": { 받은때, 열: ["day", "views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost", "likes", "comments", "shares"], rows: 줄,
      나라28: { 합: 12000, 상위: [["KR", 11040], ["US", 600], ["JP", 300], ["VN", 40], ["BR", 20]] }, 종류 },
    "채널A롱": { 받은때, 열: ["day", "views"], rows: 범위(99).map((i) => { const k = 99 - i; return [하루(k), k >= 31 ? 900 : 200, 100, 2, 3, 0, 0, 0]; }) },
    "채널B": { 받은때, 열: ["day", "views"], rows: [5, 4, 3, 2, 1].map((k) => [하루(k), 20 + k, 40 + k, 0, 0, 0, 0, 0]),
      나라28: { 합: 30, 상위: [["KR", 28], ["US", 2]] } },
  };

  // ── 성적.json
  const row = (id: string, title: string, views: number, likes: number | null, comments: number | null, age: number, at: string, vpd: number) =>
    ({ id, title, views, likes, comments, vpd, age, at });
  const aRows = [
    row("a1", "A영상1", 1200, 10, 1, 0.5, 월일(0), 2400.0),
    row("a2", "A영상2", 54000, 400, 20, 1.2, 월일(1), 45000.0),
    row("a3", "A영상3", 800, null, null, 3.0, 월일(3), 266.7),
    row("a4", "A영상4", 15000, 90, 5, 8.0, 월일(8), 1875.0),
    row("a5", "A영상5", 300, 3, 0, 20.0, 월일(20), 15.0),
    row("a6", "A영상6", 2500, 21, 2, 45.0, 월일(45), 55.6),
  ];
  const 옛히트 = row("a0", "A옛히트", 90000, 1000, 50, 200.0, "26/04/20", 450.0);
  F["성적.json"] = {
    "채널A": { _at: NOW_EPOCH - 3600, daily: [2, "최근 3개 [800 · 15,000 · 300] 최고 15,000회 → 하루 2개"], rows: aRows,
      전체조회: [...aRows.map((r) => ({ id: r.id, views: r.views })), { id: "a0", views: 90000 },
        ...([[1, 800], [3, 100], [4, 2500], [6, 5000], [7, 150], [9, 2400], [10, 2600], [12, 500], [13, 3000]] as [number, number][])
          .map(([k, v]) => ({ id: "a" + p2(k), views: v }))],
      톱30: [옛히트, aRows[1], aRows[3], aRows[5], aRows[0], aRows[2], aRows[4]],
      전체편수: 40, insight: { learned: false, why: "7일 지난 영상이 3편뿐입니다 (최소 8편 필요)", _at: NOW_EPOCH - 3600 },
      차단: {}, 실종: [] },
    "채널B": { _at: NOW_EPOCH - 3600, daily: [3, "고정 3개"],
      rows: [row("b1", "B영상1", 900, 5, 0, 5.0, 월일(5), 180.0), row("b2", "B영상2", 4000, 50, 2, 6.0, 월일(6), 666.7), row("b3", "B영상3", 1700, 12, 1, 7.0, 월일(7), 242.9)],
      전체조회: [{ id: "b1", views: 900 }, { id: "b2", views: 4000 }, { id: "b3", views: 1700 }], 차단: { b2: 3 }, 실종: [] },
    "채널C": { _at: NOW_EPOCH - 8 * 86400, rows: [row("c1", "C영상1", 70, 1, 0, 40.0, 월일(40), 1.8), row("c2", "C영상2", 33, null, 0, 50.0, "25/08/30", 0.7)],
      실종: ["사라진 영상"] },
    "채널D": { rows: [] },
    "채널A롱": { _at: NOW_EPOCH - 3600, daily: [1, "아직"], rows: [row("l1", "롱폼1", 5000, 40, 3, 4.0, 월일(4), 1250.0)],
      전체조회: [{ id: "l1", views: 5000 }], 차단: {}, 실종: ["지워진 롱폼"] },
  };

  // ── 원장
  const 원장: Record<string, string>[] = [];
  const 줄넣기 = (업로드: string, 채널: string, id: string, 제목: string, 공개설정: string, 공개시각: string, 예약시각: string) =>
    원장.push({ 업로드시각: 업로드, 채널, 영상ID: id, 제목, 공개설정, 공개시각, 예약시각 });
  for (const k of [13, 12, 10, 9, 7, 6, 4, 3, 1]) 줄넣기(하루(k) + "T09:00:00", "채널A", "a" + p2(k), "A영상", "public", 하루(k) + " 18:00", "");
  줄넣기(하루(0) + "T08:00:00", "채널A", "today1", "오늘 올림", "예약", "", 하루(0) + " 20:00");
  줄넣기(하루(1) + "T09:10:00", "채널A", "res1", "예약", "예약", "", 하루(0) + " 07:00");
  for (const k of [13, 12, 11]) 줄넣기(하루(k) + "T09:00:00", "채널B", "b" + p2(k), "B영상", "public", 하루(k) + " 18:00", "");
  줄넣기(하루(3) + "T09:00:00", "채널B", "bres", "예약B", "예약", "", 하루(2) + " 07:00");
  for (const k of [13, 12, 11, 10]) 줄넣기(하루(k) + "T09:00:00", "채널C", "c" + p2(k), "C영상", "public", 하루(k) + " 18:00", "");
  줄넣기(하루(6) + "T09:00:00", "채널C", "cres", "예약C", "예약", "", 하루(5) + " 07:00");
  // 건강 시험용 채널E: 하루 조회가 큰 영상 하나 없이 바닥이 넷
  const eSpeeds: [number, number][] = [[6, 275], [7, 375], [8, 475], [9, 575], [10, 675], [11, 775], [12, 40], [13, 40], [14, 40], [15, 40]]; // (공개 며칠 전, 조회) — 성적을 3일 전에 읽었으니 하루 평균은 조회 ÷ (며칠 전 − 3.25)
  F["성적.json"]["채널E"] = { _at: NOW_EPOCH - 3600, rows: [row("e0", "E영상", 1, 0, 0, 1.0, 월일(1), 1.0)],
    전체조회: eSpeeds.map(([k, v]) => ({ id: "e" + p2(k), views: v })), 차단: {}, 실종: [] };
  for (const [k] of eSpeeds) 줄넣기(하루(k) + "T09:00:00", "채널E", "e" + p2(k), "E영상", "public", 하루(k) + " 18:00", "");

  // 건강 경계: 성장 정확히 0.8배(주의) · 0.5배(위험) · 이탈률 정확히 50%(주의) · 공백 5일(주의) / 4일(좋음)
  const 분석줄 = (v40: number, v10: number, gained: number, lost: number) =>
    범위(58).map((i) => { const k = 58 - i; return [하루(k), k === 40 ? v40 : k === 10 ? v10 : 0, 0, k === 10 ? gained : 0, k === 10 ? lost : 0, 0, 0, 0]; });
  F["분석기록.json"]["채널F"] = { 받은때, 열: ["day"], rows: 분석줄(1000, 800, 10, 5) };
  F["분석기록.json"]["채널G"] = { 받은때, 열: ["day"], rows: 분석줄(1000, 500, 4, 0) };
  for (const [이름, 날들] of [["채널H", [13, 12, 11, 5]], ["채널I", [13, 12, 7, 6, 1]]] as [string, number[]][]) {
    for (const k of 날들) 줄넣기(하루(k) + "T09:00:00", 이름, 이름.slice(-1).toLowerCase() + p2(k), "영상", "public", 하루(k) + " 18:00", "");
  }
  // 캐시가 며칠 묵은 채널: 분석 5일 · 성적 3일 (7일 안이면 아직 믿는다)
  F["분석기록.json"]["채널B"].받은때 = isoWall(addDays(wallNow(), -5));
  F["성적.json"]["채널E"]._at = NOW_EPOCH - 3 * 86400;

  F["policy.json"] = {
    "표시이름": { "채널A": "A표시" },
    "수확기준": [
      { 차수: 1, 이름: "1차", 구독자: 1000, 쇼츠조회90: 10000000, 시청시간365: 4000 },
      { 차수: 2, 이름: "2차", 구독자: 10000, 쇼츠조회90: 100000000, 시청시간365: 40000 },
    ],
  };
  F["구독갱신.json"] = { attempted_at: NOW_EPOCH - 600, updated: [CID.A, CID.B, CID.C], errors: { [CID.D]: "채널 총계를 읽지 못했습니다" }, exact_updated: [CID.B] };
  return { 파일: F, 원장 };
}

const 원장머리 = ["업로드시각", "채널", "영상ID", "제목", "파일", "길이초", "해상도", "아동용", "AI합성", "공개설정", "공개시각", "예약시각", "고객확인자", "확인일"];
async function 원장쓰기(줄들: Record<string, string>[]) {
  await Deno.writeTextFile(dataPath("ledger.csv"), toCsv([원장머리, ...줄들.map((r) => 원장머리.map((h) => r[h] ?? ""))]));
}

/** 자료를 모래상자의 자료 폴더에 심는다(원본 파이썬이 읽던 자리와 같은 이름) */
async function 심기(g: { 파일: Record<string, Obj>; 원장: Record<string, string>[] } = 자료()) {
  await Deno.mkdir(recordPath(), { recursive: true });
  for (const [이름, 값] of Object.entries(g.파일)) {
    await writeJson(이름 === "구독갱신.json" ? recordPath(이름) : dataPath(이름), 값);
  }
  await 원장쓰기(g.원장);
}

/* ============================================================ 가짜 세계 (갱신 시험 · 올린 영상 시험) */

interface 세계영상 {
  id: string; channelId: string; title: string; publishedAt: string; views: number; likes: number | null; comments: number | null;
  privacy: string; duration: string; blocked: string[];
}
export function 세계(nA = 35): { 채널: { id: string; title: string; handle: string; subs: number; views: number; videos: number }[]; 영상: 세계영상[] } {
  const 채널 = [
    { id: CID.A, title: "채널A", handle: "@a", subs: 5056, views: 1020500, videos: 40 },
    { id: CID.B, title: "채널B", handle: "@b", subs: 120, views: 40000, videos: 12 },
  ];
  const 영상: 세계영상[] = [];
  const 때 = (분전: number) => new 진짜Date(고정ms - 분전 * 60000).toISOString().replace(".000Z", "Z");
  for (let i = 0; i < nA; i++) {
    const sec = i % 6 === 0 ? 65 : 20 + i;
    영상.push({
      id: "vA" + p2(i), channelId: CID.A, title: `A영상${i}`, publishedAt: 때((i * 2 + 1) * 1440 + ((i * 7) % 24) * 60 + ((i * 13) % 60)),
      views: (((i * 37) % 11) + 1) * (nA + 1 - i) * 13, likes: i % 4 ? i * 3 : null, comments: i % 3 ? i : null,
      privacy: i === 3 ? "private" : "public", duration: sec >= 60 ? `PT${Math.floor(sec / 60)}M${sec % 60}S` : `PT${sec}S`, blocked: [],
    });
  }
  ([["public", []], ["private", []], ["public", ["KR", "US"]]] as [string, string[]][]).forEach(([privacy, blocked], j) => {
    영상.push({
      id: "vB" + p2(j), channelId: CID.B, title: `B영상${j}`, publishedAt: 때((3 + j * 5) * 1440 + j * 60), views: 900 + 400 * j,
      likes: 5 + j, comments: j, privacy, duration: "PT45S", blocked,
    });
  });
  return { 채널, 영상 };
}

function 세계세우기(g: 가짜구글, w = 세계()) {
  const 새로고침: Record<string, string> = { [CID.A]: "RT_A", [CID.B]: "RT_B", [CID.C]: "RT_C" };
  for (const c of w.채널) g.addChannel({ id: c.id, title: c.title, handle: c.handle, subs: c.subs, views: c.views, videos: c.videos }, 새로고침[c.id]);
  for (const v of w.영상) {
    g.addVideo({
      id: v.id, channelId: v.channelId, snippet: { title: v.title, publishedAt: v.publishedAt }, status: { privacyStatus: v.privacy },
      statistics: { viewCount: String(v.views), likeCount: v.likes === null ? undefined : String(v.likes), commentCount: v.comments === null ? undefined : String(v.comments) },
      contentDetails: { duration: v.duration, ...(v.blocked.length ? { regionRestriction: { blocked: v.blocked } } : {}) },
    });
  }
}

/** 채널 이름 → 토큰. 별칭(롱폼 이름)은 토큰이 없다 — 채널 ID 로 이어진다. */
async function 토큰심기(항목: Record<string, { cid: string; refresh: string }>) {
  await writeJson(dataPath("client_secret.json"), { installed: { client_id: "cid", client_secret: "sec" } });
  const s: Obj = {};
  for (const [키, v] of Object.entries(항목)) s[키] = { channel_id: v.cid, title: 키, refresh_token: v.refresh, added: "2026-10-01", scopes: ["https://www.googleapis.com/auth/youtube.readonly"] };
  await writeJson(dataPath("tokens.json"), s);
}

/** 가짜구글의 응답을 시험이 손볼 수 있게 감싼다(분석 API 는 빈 rows 만 주므로 rows 를 채운다 · 채널 목록에서 한 채널을 뺀다 …) */
function 손보기(g: 가짜구글, 고치기: (url: URL, res: Response) => Response | Promise<Response>) {
  const 원래 = g.handle;
  g.handle = async (input: string | URL | Request, init?: RequestInit) => {
    const res = await 원래(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return await 고치기(url, res);
  };
  g.install();
}
const 제이슨응답 = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/* ============================================================ 기대값 (원본 파이썬에서 뽑은 값) */

// 이 블록은 현재 업로더(파이썬) 원본을 같은 자료·같은 시계로 돌려 기계로 뽑아 옮겼다. 손으로 고치지 않는다.
const 기대: any = {
  "셈": {
    "round0": [0, 2, 2, 4, 0, -2, -2],
    "roundN": [[2.675, 2, 2.67], [0.125, 2, 0.12], [0.375, 2, 0.38], [1.005, 2, 1.0], [0.25, 1, 0.2], [0.35, 1, 0.3], [0.45, 1, 0.5], [1234.5678, 2, 1234.57], [-0.125, 2, -0.12], [2.5, 1, 2.5], [0.5, 0, 0.0], [7.0, 1, 7.0], [1e-07, 3, 0.0]],
    "fixed": [[0.5, 0, "0"], [1.5, 0, "2"], [2.5, 0, "2"], [1234.5, 0, "1234"], [0.125, 2, "0.12"], [0.375, 2, "0.38"], [2.675, 2, "2.67"], [0.05, 1, "0.1"], [9.99, 1, "10.0"], [100.0, 1, "100.0"], [-2.5, 0, "-2"], [3.14159, 3, "3.142"]],
    "commaFixed": [[1234.5, 0, "1,234"], [1234567.891, 2, "1,234,567.89"], [0.5, 0, "0"], [999.95, 1, "1,000.0"], [2662.5, 0, "2,662"], [-1234.5, 0, "-1,234"]],
  },
  "편수": {
    "daily_for": [1, 1, 2, 2, 4, 4, 2, 7, 1],
    "decide": {
      "all_young": [3, "48시간 지난 영상이 없습니다 — 기본 3개로 진행"],
      "custom_rule": [7, "최근 1개 [150] 최고 150회 → 하루 7개"],
      "empty": [2, "읽어 온 영상이 없습니다 — 기본 2개로 진행"],
      "exact_48h": [2, "최근 1개 [20,000] 최고 20,000회 → 하루 2개"],
      "mature_hours_72": [1, "72시간 지난 영상이 없습니다 — 기본 1개로 진행"],
      "mature_hours_72_ok": [2, "최근 1개 [20,000] 최고 20,000회 → 하루 2개"],
      "mix_young": [2, "최근 2개 [12,000 · 300] 최고 12,000회 → 하루 2개"],
      "none_views": [1, "최근 1개 [0] 최고 0회 → 하루 1개"],
      "recent3_not_oldest": [1, "최근 3개 [10 · 20 · 30] 최고 30회 → 하루 1개"],
    },
    "perf_table": ["  올린날          조회수     하루평균     좋아요     댓글  제목", "  ──────────────────────────────────────────────────────────────────────────", "  10-11      12.3만     4.1만   4,000    120  첫째 영상 제목이 서른 글자를 넘어가면 잘려서 나옵니다", "  10-11      9,999    3,333       —      —  둘째", "  10-12       1.0만    2,500     500      5  셋째 😀 이모지", "  10-14          0        0       0      0  넷째", "  10-14        250       62       7      1  다섯째", "  ──────────────────────────────────────────────────────────────────────────", "  5개 · 조회수 중앙값 9,999 · 최고 12.3만 · 좋아요율 3.2%"],
    "perf_table_empty": ["  올린 영상이 없습니다"],
    "perf_table_limit2": ["  올린날          조회수     하루평균     좋아요     댓글  제목", "  ──────────────────────────────────────────────────────────────────────────", "  10-11      12.3만     4.1만   4,000    120  첫째 영상 제목이 서른 글자를 넘어가면 잘려서 나옵니다", "  10-11      9,999    3,333       —      —  둘째", "  ──────────────────────────────────────────────────────────────────────────", "  2개 · 조회수 중앙값 6.7만 · 최고 12.3만 · 좋아요율 3.2%"],
    "perf_table_nolike": ["  올린날          조회수     하루평균     좋아요     댓글  제목", "  ──────────────────────────────────────────────────────────────────────────", "  10-11      9,999    3,333       —      —  둘째", "  10-14          0        0       0      0  넷째", "  ──────────────────────────────────────────────────────────────────────────", "  2개 · 조회수 중앙값 5,000 · 최고 9,999"],
  },
  "고르기_입력": [{"name": "a_세로정확.mp4", "info": {"w": 1080, "h": 1920, "sec": 30, "mb": 12.5, "display_w": 1080, "display_h": 1920, "codec": "h264"}, "age": 10}, {"name": "b_근사.mp4", "info": {"w": 1080, "h": 1900, "sec": 50, "mb": 20.2, "display_w": 1080, "display_h": 1900, "codec": "h264"}, "age": 4}, {"name": "c_가로.mp4", "info": {"w": 1920, "h": 1080, "sec": 200, "mb": 80, "display_w": 1920, "display_h": 1080, "codec": "h264"}, "age": 2}, {"name": "d_짧음.mp4", "info": {"w": 1080, "h": 1920, "sec": 10, "mb": 3, "display_w": 1080, "display_h": 1920, "codec": "h264"}, "age": 0.5}, {"name": "e_짧음복사.mp4", "info": {"w": 1080, "h": 1920, "sec": 10, "mb": 3, "display_w": 1080, "display_h": 1920, "codec": "h264"}, "age": 0.2}, {"name": "f_720.mp4", "info": {"w": 720, "h": 1280, "sec": 60, "mb": 9, "display_w": 720, "display_h": 1280, "codec": "h264"}, "age": 8}, {"name": "g_1600.mp4", "info": {"w": 900, "h": 1600, "sec": 100, "mb": 30, "display_w": 900, "display_h": 1600, "codec": "h264"}, "age": 1.5}, {"name": "h_사이.mp4", "info": {"w": 1080, "h": 1920, "sec": 44.9, "mb": 15, "display_w": 1080, "display_h": 1920, "codec": "h264"}, "age": 3.5}],
  "고르기": {
    "choose": {
      "manual": [["b_근사.mp4", "g_1600.mp4"], "직접 고른 2개 · 찾지 못함: 없음.mp4"],
      "manual_empty": [[], "직접 고르기 — 아직 고른 영상이 없습니다 (파일 이름으로 지정)"],
      "oldest": [["a_세로정확.mp4", "f_720.mp4", "b_근사.mp4"], "오래된 것부터 3개"],
      "order": [["a_세로정확.mp4", "b_근사.mp4", "c_가로.mp4"], "이름 순서대로 3개"],
      "suggest": [["a_세로정확.mp4", "h_사이.mp4", "f_720.mp4"], "추천 상위 3개 (직접 바꿀 수 있습니다)"],
      "suggest_ins": [["a_세로정확.mp4", "h_사이.mp4", "f_720.mp4"], "추천 상위 3개 (직접 바꿀 수 있습니다)"],
      "엉뚱한방식": [["a_세로정확.mp4", "f_720.mp4"], "오래된 것부터 2개"],
    },
    "days_left": [[0, "재고 0.0일치 — 곧 떨어집니다. 고객에게 영상을 요청하세요"], [1.5, "재고 1.5일치 — 곧 떨어집니다. 고객에게 영상을 요청하세요"], [4, "재고 4.0일치 — 슬슬 채워야 합니다"], [10, "재고 10.0일치"], [0, "하루 편수가 0입니다"], [1, "재고 1.0일치 — 곧 떨어집니다. 고객에게 영상을 요청하세요"], [4, "재고 4.0일치 — 슬슬 채워야 합니다"], [5, "재고 5.0일치"]],
    "dups": [["d_짧음.mp4", "e_짧음복사.mp4"]],
    "rank": [["a_세로정확.mp4", 100, ["9:16 정확", "30초 (흔한 길이대)", "10일 묵음", "1080p"]], ["h_사이.mp4", 93, ["9:16 정확", "45초 (흔한 길이대)", "4일 묵음", "1080p"]], ["f_720.mp4", 86, ["9:16 정확", "60초", "8일 묵음", "1280p"]], ["b_근사.mp4", 71, ["9:16 근사", "50초", "4일 묵음", "1900p"]], ["d_짧음.mp4", 71, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]], ["e_짧음복사.mp4", 71, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]], ["g_1600.mp4", 63, ["9:16 정확", "100초", "2일 전", "1600p"]], ["c_가로.mp4", 35, ["200초", "2일 전", "1080p"]]],
    "rank_ins": [["a_세로정확.mp4", 100, ["9:16 정확", "30초 ★이 채널 최적 30~45초", "10일 묵음", "1080p"]], ["h_사이.mp4", 97, ["9:16 정확", "45초 ★이 채널 최적 30~45초", "4일 묵음", "1080p"]], ["f_720.mp4", 75, ["9:16 정확", "60초", "8일 묵음", "1280p"]], ["b_근사.mp4", 73, ["9:16 근사", "50초 (최적에 근접)", "4일 묵음", "1900p"]], ["g_1600.mp4", 62, ["9:16 정확", "100초", "2일 전", "1600p"]], ["d_짧음.mp4", 60, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]], ["e_짧음복사.mp4", 60, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]], ["c_가로.mp4", 34, ["200초", "2일 전", "1080p"]]],
    "report": ["    추천 순위 (전체 8개 중 상위 5개 · 오늘 3개 예정)", "    ◆  1. [100점] a_세로정확.mp4                             9:16 정확 · 30초 (흔한 길이대) · 10일 묵음 · 1080p", "    ◆  2. [ 93점] h_사이.mp4                               9:16 정확 · 45초 (흔한 길이대) · 4일 묵음 · 1080p", "    ◆  3. [ 86점] f_720.mp4                              9:16 정확 · 60초 · 8일 묵음 · 1280p", "       4. [ 71점] b_근사.mp4                               9:16 근사 · 50초 · 4일 묵음 · 1900p", "       5. [ 71점] d_짧음.mp4                               9:16 정확 · 10초 · 오늘 들어옴 · 1080p", "       … 나머지 3개"],
    "score": {
      "a_세로정확.mp4": [100, ["9:16 정확", "30초 (흔한 길이대)", "10일 묵음", "1080p"]],
      "b_근사.mp4": [71, ["9:16 근사", "50초", "4일 묵음", "1900p"]],
      "c_가로.mp4": [35, ["200초", "2일 전", "1080p"]],
      "d_짧음.mp4": [71, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]],
      "e_짧음복사.mp4": [71, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]],
      "f_720.mp4": [86, ["9:16 정확", "60초", "8일 묵음", "1280p"]],
      "g_1600.mp4": [63, ["9:16 정확", "100초", "2일 전", "1600p"]],
      "h_사이.mp4": [93, ["9:16 정확", "45초 (흔한 길이대)", "4일 묵음", "1080p"]],
    },
    "score_ins": {
      "a_세로정확.mp4": [100, ["9:16 정확", "30초 ★이 채널 최적 30~45초", "10일 묵음", "1080p"]],
      "b_근사.mp4": [73, ["9:16 근사", "50초 (최적에 근접)", "4일 묵음", "1900p"]],
      "c_가로.mp4": [34, ["200초", "2일 전", "1080p"]],
      "d_짧음.mp4": [60, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]],
      "e_짧음복사.mp4": [60, ["9:16 정확", "10초", "오늘 들어옴", "1080p"]],
      "f_720.mp4": [75, ["9:16 정확", "60초", "8일 묵음", "1280p"]],
      "g_1600.mp4": [62, ["9:16 정확", "100초", "2일 전", "1600p"]],
      "h_사이.mp4": [97, ["9:16 정확", "45초 ★이 채널 최적 30~45초", "4일 묵음", "1080p"]],
    },
  },
  "배움": {
    "describe_in": {
      "no": {"learned": false, "why": "아직 인증 전입니다", "dur_tbl": {}, "hour_tbl": {}, "best_dur": null, "best_hour": null},
      "full": {
        "learned": true,
        "n": 32,
        "best_dur": [30, 45],
        "dur_tbl": {"(30, 45)": [1234.5, 4], "(15, 30)": [900.0, 5]},
        "best_hour": [22, 6],
        "hour_tbl": {"(22, 6)": [2000.0, 7], "(6, 10)": [100.0, 3]},
        "trend": 23.4,
        "cadence": 1.25,
        "median_views": 1014.5,
      },
      "down": {"learned": true, "n": 9, "best_dur": null, "dur_tbl": {}, "best_hour": null, "hour_tbl": {}, "trend": -15.0, "cadence": null, "median_views": 0},
      "flat": {"learned": true, "n": 9, "best_dur": null, "dur_tbl": {}, "best_hour": null, "hour_tbl": {}, "trend": 14.9, "cadence": 0.0, "median_views": 2.5},
    },
    "describe": {
      "down": ["최근 9편 · 조회수 중앙값 0회", "추세 하락 15%"],
      "flat": ["최근 9편 · 조회수 중앙값 2회"],
      "full": ["최근 32편 · 조회수 중앙값 1,014회", "가장 잘 되는 길이 30~45초 (중앙값 1,234회 · 4편)", "가장 잘 되는 시간 22~6시 (중앙값 2,000회 · 7편)", "추세 상승 23%", "업로드 간격 중앙값 1.2일"],
      "no": ["학습 안 함 — 아직 인증 전입니다"],
    },
    "rows": [{"views": 100, "sec": 10, "hour": 7}, {"views": 110, "sec": 12, "hour": 8}, {"views": 120, "sec": 14, "hour": 9}, {"views": 500, "sec": 20, "hour": 23}, {"views": 520, "sec": 22, "hour": 1}, {"views": 540, "sec": 24, "hour": 3}, {"views": 300, "sec": 33, "hour": 12}, {"views": 310, "sec": 34, "hour": 13}, {"views": 320, "sec": 35, "hour": 12}, {"views": 900, "sec": 50, "hour": 19}, {"views": 50, "sec": 100, "hour": 20}],
    "best_bucket": {
      "dur": [[15, 30], {"(0, 15)": [110, 3], "(15, 30)": [520, 3], "(30, 45)": [310, 3]}],
      "hour": [[22, 6], {"(10, 14)": [310, 3], "(22, 6)": [520, 3], "(6, 10)": [110, 3]}],
      "one_bucket": [null, {}],
      "tie": [[0, 15], {"(0, 15)": [10, 3], "(15, 30)": [10, 3]}],
    },
  },
  "daily": {
    "채널A": [2, "최근 3개 [800 · 15,000 · 300] 최고 15,000회 → 하루 2개"],
    "채널A롱": [1, "아직"],
    "채널B": [3, "고정 3개"],
    "채널C": [2, "아직 안 읽음 — [갱신]을 누르면 조회수로 정합니다"],
    "채널D": [1, "아직 안 읽음 — [갱신]을 누르면 조회수로 정합니다"],
  },
  "spike": {
    "채널A": {
      "구독": {"급등": true, "배수": 11, "최근": 132, "평소": 12},
      "급등": true,
      "남은날": 0,
      "말": "최근 3일 조회수 3.7배 · 구독자 11.0배 (직전 3일 대비)",
      "점수": 15,
      "조회": {"급등": true, "배수": 3.7, "최근": 16500, "평소": 4500},
    },
    "채널A롱": {
      "구독": {"급등": true, "배수": 11, "최근": 132, "평소": 12},
      "급등": true,
      "남은날": 0,
      "말": "최근 3일 조회수 3.7배 · 구독자 11.0배 (직전 3일 대비)",
      "점수": 15,
      "조회": {"급등": true, "배수": 3.7, "최근": 16500, "평소": 4500},
    },
    "채널B": {
      "구독": {"급등": false, "배수": null, "최근": 3, "평소": 3},
      "급등": false,
      "남은날": 0,
      "말": "최근 3일 조회 +6,000 · 직전 3일 +6,000",
      "점수": 15,
      "조회": {"급등": false, "배수": 1, "최근": 6000, "평소": 6000},
    },
    "채널C": {"구독": null, "급등": false, "남은날": 0, "말": "최근 3일 조회 +900 · 직전 3일 +900", "점수": 13, "조회": {"급등": false, "배수": 1, "최근": 900, "평소": 900}},
    "채널D": {"구독": null, "급등": false, "남은날": 6, "말": "기록이 없습니다", "점수": 0, "조회": null},
  },
  "spike_extra": {
    "S구독없음": {"구독": null, "급등": false, "남은날": 0, "말": "최근 3일 조회 +2,100 · 직전 3일 +2,100", "점수": 8, "조회": {"급등": false, "배수": 1, "최근": 2100, "평소": 2100}},
    "S두배": {
      "구독": {"급등": false, "배수": null, "최근": 0, "평소": 0},
      "급등": true,
      "남은날": 0,
      "말": "최근 3일 조회수 2.0배 (직전 3일 대비)",
      "점수": 10,
      "조회": {"급등": true, "배수": 2, "최근": 600, "평소": 300},
    },
    "S부족": {"구독": null, "급등": false, "남은날": 2, "말": "5일째 기록 중 — 2일 뒤부터 판정합니다", "점수": 5, "조회": null},
    "S빠진날": {
      "구독": {"급등": false, "배수": null, "최근": 6, "평소": 6},
      "급등": false,
      "남은날": 0,
      "말": "최근 3일 조회 +270 · 직전 3일 +270",
      "점수": 9,
      "조회": {"급등": false, "배수": null, "최근": 270, "평소": 270},
    },
    "S새로": {
      "구독": {"급등": true, "배수": null, "최근": 60, "평소": 0},
      "급등": true,
      "남은날": 0,
      "말": "최근 3일 조회수 늘기 시작 · 구독자 늘기 시작 (직전 3일 대비)",
      "점수": 10,
      "조회": {"급등": true, "배수": null, "최근": 1200, "평소": 0},
    },
    "S잡음": {
      "구독": {"급등": false, "배수": null, "최근": 0, "평소": 0},
      "급등": true,
      "남은날": 0,
      "말": "최근 3일 조회수 10.0배 (직전 3일 대비)",
      "점수": 10,
      "조회": {"급등": true, "배수": 10, "최근": 300, "평소": 30},
    },
    "S하락": {
      "구독": {"급등": false, "배수": null, "최근": 3, "평소": 90},
      "급등": false,
      "남은날": 0,
      "말": "최근 3일 조회 +300 · 직전 3일 +2,400",
      "점수": 10,
      "조회": {"급등": false, "배수": 0.1, "최근": 300, "평소": 2400},
    },
  },
  "spike_band": {"채널A": [["조회수", "3.7배", "최근 3일 +16,500 · 직전 3일 +4,500"], ["구독자", "11.0배", "최근 3일 +132 · 직전 3일 +12"]], "채널B": []},
  "subs_summary": {
    "채널A": {"말": "어제보다 +44명", "믿음": true, "이레": 148, "점수": 15, "최근": 5176, "하루": 44, "한달": null},
    "채널A롱": {"말": "어제보다 +44명", "믿음": true, "이레": 148, "점수": 15, "최근": 5176, "하루": 44, "한달": null},
    "채널B": {"말": "어제보다 +1명", "믿음": false, "이레": 7, "점수": 15, "최근": 114, "하루": 1, "한달": null},
    "채널C": {"말": "어제보다 +10명", "믿음": true, "이레": null, "점수": 6, "최근": 850, "하루": 10, "한달": null},
    "채널D": {"말": "기록을 오늘부터 쌓습니다", "믿음": false, "이레": null, "점수": 0, "최근": null, "하루": null, "한달": null},
  },
  "subs_flow": {
    "채널A": [["2026-10-08", 5020], ["2026-10-09", 5024], ["2026-10-10", 5028], ["2026-10-11", 5032], ["2026-10-12", 5036], ["2026-10-13", 5040], ["2026-10-14", 5044], ["2026-10-15", 5088], ["2026-10-16", 5132], ["2026-10-17", 5176]],
    "채널A롱": [["2026-10-08", 5020], ["2026-10-09", 5024], ["2026-10-10", 5028], ["2026-10-11", 5032], ["2026-10-12", 5036], ["2026-10-13", 5040], ["2026-10-14", 5044], ["2026-10-15", 5088], ["2026-10-16", 5132], ["2026-10-17", 5176]],
    "채널B": [["2026-10-08", 105], ["2026-10-09", 106], ["2026-10-10", 107], ["2026-10-11", 108], ["2026-10-12", 109], ["2026-10-13", 110], ["2026-10-14", 111], ["2026-10-15", 112], ["2026-10-16", 113], ["2026-10-17", 114]],
    "채널C": [["2026-10-08", 850]],
    "채널D": [],
  },
  "lift": {
    "A": {
      "누적흐름_영상": {
        "A영상1": [{"값": 1600, "때": "10/14 23시"}, {"값": 3200, "때": "10/15 23시"}, {"값": 2000, "때": "10/16 06시"}, {"값": 2010, "때": "10/16 09시"}, {"값": 2020, "때": "10/16 12시"}, {"값": 2030, "때": "10/16 15시"}, {"값": 2040, "때": "10/16 18시"}, {"값": 2050, "때": "10/16 21시"}, {"값": 3300, "때": "10/16 23시"}, {"값": 2060, "때": "10/17 00시"}, {"값": 2070, "때": "10/17 03시"}, {"값": 2080, "때": "10/17 06시"}, {"값": 2090, "때": "10/17 09시"}, {"값": 2100, "때": "10/17 12시"}, {"값": 3400, "때": "10/17 23시"}],
        "A영상3": [{"값": 3360, "때": "10/14 23시"}, {"값": 900, "때": "10/15 20시"}, {"값": 3540, "때": "10/15 23시"}, {"값": 915, "때": "10/16 16시"}, {"값": 3600, "때": "10/16 23시"}, {"값": 930, "때": "10/17 07시"}, {"값": 3660, "때": "10/17 23시"}],
        "A영상4": [{"값": 4300, "때": "10/14 23시"}, {"값": 4355, "때": "10/15 23시"}, {"값": 4405, "때": "10/16 23시"}, {"값": 4455, "때": "10/17 23시"}],
      },
      "누적흐름_영상400": {
        "A영상1": [{"값": 1000, "때": "10/08 23시"}, {"값": 1100, "때": "10/09 23시"}, {"값": 1200, "때": "10/10 23시"}, {"값": 1300, "때": "10/11 23시"}, {"값": 1400, "때": "10/12 23시"}, {"값": 1500, "때": "10/13 23시"}, {"값": 1600, "때": "10/14 23시"}, {"값": 3200, "때": "10/15 23시"}, {"값": 2000, "때": "10/16 06시"}, {"값": 2010, "때": "10/16 09시"}, {"값": 2020, "때": "10/16 12시"}, {"값": 2030, "때": "10/16 15시"}, {"값": 2040, "때": "10/16 18시"}, {"값": 2050, "때": "10/16 21시"}, {"값": 3300, "때": "10/16 23시"}, {"값": 2060, "때": "10/17 00시"}, {"값": 2070, "때": "10/17 03시"}, {"값": 2080, "때": "10/17 06시"}, {"값": 2090, "때": "10/17 09시"}, {"값": 2100, "때": "10/17 12시"}, {"값": 3400, "때": "10/17 23시"}],
        "A영상4": [{"값": 4000, "때": "10/08 23시"}, {"값": 4050, "때": "10/09 23시"}, {"값": 4100, "때": "10/10 23시"}, {"값": 4150, "때": "10/11 23시"}, {"값": 4200, "때": "10/12 23시"}, {"값": 4250, "때": "10/13 23시"}, {"값": 4300, "때": "10/14 23시"}, {"값": 4355, "때": "10/15 23시"}, {"값": 4405, "때": "10/16 23시"}, {"값": 4455, "때": "10/17 23시"}],
      },
      "누적흐름_채널": [{"값": 1013500, "때": "10/12 23시"}, {"값": 1015000, "때": "10/13 23시"}, {"값": 1016500, "때": "10/14 23시"}, {"값": 1022000, "때": "10/15 23시"}, {"값": 1027500, "때": "10/16 23시"}, {"값": 1033000, "때": "10/17 23시"}],
      "사건들": [{"끈것": {"배수": 16, "제목": "A영상1", "증가": 1600, "평소": 100}, "날짜": "2026-10-15", "딸린것": [{"배수": 7.2, "제목": "A영상2", "증가": 580, "평소": 80}, {"배수": 3, "제목": "A영상3", "증가": 180, "평소": 60}], "평소합": 330, "합계": 2455}],
      "영상최근": {
        "A영상1": {"값": 100, "잼": true, "점": 11, "처음": "2026-10-16T06"},
        "A영상2": {"값": 100, "잼": true, "점": 11, "처음": "2026-10-16T06"},
        "A영상3": {"값": 30, "잼": true, "점": 3, "처음": "2026-10-15T20"},
        "없는영상": {"값": 0, "잼": false, "점": 0, "처음": ""},
      },
      "요약": {
        "됨": true,
        "말": "1번 있었습니다",
        "사건": [{"끈것": {"배수": 16, "제목": "A영상1", "증가": 1600, "평소": 100}, "날짜": "2026-10-15", "딸린것": [{"배수": 7.2, "제목": "A영상2", "증가": 580, "평소": 80}, {"배수": 3, "제목": "A영상3", "증가": 180, "평소": 60}], "평소합": 330, "합계": 2455}],
        "영상수": 6,
        "점수": 10,
        "폭": 9,
      },
      "채널하루조회4": [{"값": 330, "날": "10/14", "몇편": 5, "뺀편": 0, "잼": true}, {"값": 2455, "날": "10/15", "몇편": 5, "뺀편": 0, "잼": true}, {"값": 330, "날": "10/16", "몇편": 5, "뺀편": 0, "잼": true}, {"값": 330, "날": "10/17", "몇편": 5, "뺀편": 0, "잼": true}],
      "최근증가10": {"댓글": 2, "잼": true, "조회": 60, "좋아요": 6, "편": 2},
      "최근증가48": {"댓글": 6, "잼": true, "조회": 230, "좋아요": 20, "편": 3},
    },
    "B": {
      "누적흐름_채널": [{"값": 48000, "때": "10/12 23시"}, {"값": 50000, "때": "10/13 23시"}, {"값": 52000, "때": "10/14 23시"}, {"값": 54000, "때": "10/15 23시"}, {"값": 56000, "때": "10/16 23시"}, {"값": 58000, "때": "10/17 23시"}],
      "사건들": [],
      "요약": {"됨": true, "말": "아직 동반 상승이 잡히지 않았습니다", "사건": [], "영상수": 3, "점수": 6, "폭": 5},
      "채널하루조회4": [{"값": 150, "날": "10/14", "몇편": 3, "뺀편": 0, "잼": true}, {"값": 150, "날": "10/15", "몇편": 3, "뺀편": 0, "잼": true}, {"값": 120, "날": "10/16", "몇편": 2, "뺀편": 1, "잼": true}, {"값": 207, "날": "10/17", "몇편": 3, "뺀편": 0, "잼": true}],
      "최근증가10": {"댓글": 0, "잼": true, "조회": 30, "좋아요": 0, "편": 1},
      "최근증가48": {"댓글": 0, "잼": true, "조회": 30, "좋아요": 0, "편": 1},
    },
    "D": {
      "누적흐름_채널": [],
      "사건들": [],
      "요약": {"됨": false, "말": "0일째 기록 중 — 3일 뒤부터 볼 수 있습니다", "사건": [], "영상수": 0, "점수": 0, "폭": 0},
      "채널하루조회4": [{"값": 0, "날": "10/14", "몇편": 0, "뺀편": 0, "잼": false}, {"값": 0, "날": "10/15", "몇편": 0, "뺀편": 0, "잼": false}, {"값": 0, "날": "10/16", "몇편": 0, "뺀편": 0, "잼": false}, {"값": 0, "날": "10/17", "몇편": 0, "뺀편": 0, "잼": false}],
      "최근증가10": {"댓글": 0, "잼": false, "조회": 0, "좋아요": 0, "편": 0},
      "최근증가48": {"댓글": 0, "잼": false, "조회": 0, "좋아요": 0, "편": 0},
    },
    "all_summary": {
      "채널A": {
        "됨": true,
        "말": "1번 있었습니다",
        "사건": [{"끈것": {"배수": 16, "제목": "A영상1", "증가": 1600, "평소": 100}, "날짜": "2026-10-15", "딸린것": [{"배수": 7.2, "제목": "A영상2", "증가": 580, "평소": 80}, {"배수": 3, "제목": "A영상3", "증가": 180, "평소": 60}], "평소합": 330, "합계": 2455}],
        "영상수": 6,
        "점수": 10,
        "폭": 9,
      },
      "채널B": {"됨": true, "말": "아직 동반 상승이 잡히지 않았습니다", "사건": [], "영상수": 3, "점수": 6, "폭": 5},
      "채널C": {"됨": false, "말": "0일째 기록 중 — 3일 뒤부터 볼 수 있습니다", "사건": [], "영상수": 0, "점수": 0, "폭": 0},
    },
    "extra": {
      "M사건들": [{"끈것": {"배수": 2, "제목": "M영상1", "증가": 200, "평소": 100}, "날짜": "2026-10-15", "딸린것": [{"배수": 1.5, "제목": "M영상2", "증가": 60, "평소": 40}], "평소합": 140, "합계": 260}],
      "M요약": {
        "됨": true,
        "말": "1번 있었습니다",
        "사건": [{"끈것": {"배수": 2, "제목": "M영상1", "증가": 200, "평소": 100}, "날짜": "2026-10-15", "딸린것": [{"배수": 1.5, "제목": "M영상2", "증가": 60, "평소": 40}], "평소합": 140, "합계": 260}],
        "영상수": 2,
        "점수": 8,
        "폭": 7,
      },
      "사건들": [{"끈것": {"배수": null, "제목": "L영상1", "증가": 60, "평소": 0}, "날짜": "2026-10-17", "딸린것": [{"배수": null, "제목": "L영상2", "증가": 45, "평소": 0}], "평소합": 95, "합계": 200}],
      "사건들3": [{"끈것": {"배수": null, "제목": "L영상1", "증가": 60, "평소": 0}, "날짜": "2026-10-17", "딸린것": [{"배수": null, "제목": "L영상2", "증가": 45, "평소": 0}], "평소합": 95, "합계": 200}],
      "요약": {
        "됨": true,
        "말": "1번 있었습니다",
        "사건": [{"끈것": {"배수": null, "제목": "L영상1", "증가": 60, "평소": 0}, "날짜": "2026-10-17", "딸린것": [{"배수": null, "제목": "L영상2", "증가": 45, "평소": 0}], "평소합": 95, "합계": 200}],
        "영상수": 5,
        "점수": 8,
        "폭": 7,
      },
      "채널하루조회": [{"값": 95, "날": "10/15", "몇편": 5, "뺀편": 0, "잼": true}, {"값": 95, "날": "10/16", "몇편": 5, "뺀편": 0, "잼": true}, {"값": 229, "날": "10/17", "몇편": 5, "뺀편": 0, "잼": true}],
    },
  },
  "분석": {
    "A7": {
      "공유": 9,
      "구독늘": 24,
      "구독자": 21,
      "구독줄": 3,
      "댓글": 36,
      "롱폼시청시간": 187.3,
      "받은때": "2026-10-17T12:00:00",
      "쇼츠조회": 2995,
      "쇼츠참여조회": 1872,
      "시청분": 7494,
      "시청시간": 124.9,
      "일수": 6,
      "조회수": 3747,
      "좋아요": 185,
      "하루": [{"값": 642, "날": "10/11"}, {"값": 635, "날": "10/12"}, {"값": 628, "날": "10/13"}, {"값": 621, "날": "10/14"}, {"값": 614, "날": "10/15"}, {"값": 607, "날": "10/16"}],
    },
    "A28": {
      "공유": 42,
      "구독늘": 108,
      "구독자": 94,
      "구독줄": 14,
      "댓글": 148,
      "롱폼시청시간": 774.8,
      "받은때": "2026-10-17T12:00:00",
      "쇼츠조회": 12386,
      "쇼츠참여조회": 7741,
      "시청분": 30992,
      "시청시간": 516.5,
      "일수": 27,
      "조회수": 15496,
      "좋아요": 763,
      "하루": [{"값": 539, "날": "09/20"}, {"값": 532, "날": "09/21"}, {"값": 525, "날": "09/22"}, {"값": 518, "날": "09/23"}, {"값": 511, "날": "09/24"}, {"값": 504, "날": "09/25"}, {"값": 547, "날": "09/26"}, {"값": 540, "날": "09/27"}, {"값": 533, "날": "09/28"}, {"값": 526, "날": "09/29"}, {"값": 519, "날": "09/30"}, {"값": 512, "날": "10/01"}, {"값": 505, "날": "10/02"}, {"값": 548, "날": "10/03"}, {"값": 641, "날": "10/04"}, {"값": 634, "날": "10/05"}, {"값": 627, "날": "10/06"}, {"값": 620, "날": "10/07"}, {"값": 613, "날": "10/08"}, {"값": 606, "날": "10/09"}, {"값": 649, "날": "10/10"}, {"값": 642, "날": "10/11"}, {"값": 635, "날": "10/12"}, {"값": 628, "날": "10/13"}, {"값": 621, "날": "10/14"}, {"값": 614, "날": "10/15"}, {"값": 607, "날": "10/16"}],
    },
    "나라": {"채널A": ["한국 92% · 미국 5%", "한국 92% · 미국 5% · 일본 2% · 베트남 0.3% · 브라질 0.2%", "2026-10-17T12:00:00"], "채널B": ["", "", "2026-10-12T12:00:00"], "채널C": ["", "", ""]},
    "해시": "fe1f371ab3c347b5",
  },
  "health": {
    "채널A": {
      "등급": "좋음",
      "줄들": [{"등급": "좋음", "말": "2026-10-14까지 28일 15,834회 (그 전 28일 대비 1.1배)", "항목": "성장"}, {"등급": "좋음", "말": "2026-10-14까지 28일 +111 −14", "항목": "구독"}, {"등급": "몰라", "말": "조회당 평균 120초 — 영상 길이별 비교 전에는 판정하지 않습니다", "항목": "시청"}, {"등급": "좋음", "말": "이 업로더에서 확인된 공개 9일 · 최대 공백 1일 이하 (예약 결과 미확인 1편)", "항목": "리듬"}, {"등급": "좋음", "말": "이 업로더 최근 8편 하루 조회 중앙 252회 · 2배↑ 2편 · 바닥 3편", "항목": "타율"}, {"등급": "좋음", "말": "검사한 영상에서 지역 차단·실종 흔적 없음", "항목": "저작권"}],
    },
    "채널A롱": {
      "등급": "위험",
      "줄들": [{"등급": "위험", "말": "2026-10-14까지 28일 5,600회 (그 전 28일 대비 0.2배)", "항목": "성장"}, {"등급": "주의", "말": "2026-10-14까지 28일 +56 −84 — 이탈률 150%", "항목": "구독"}, {"등급": "몰라", "말": "조회당 평균 30초 — 영상 길이별 비교 전에는 판정하지 않습니다", "항목": "시청"}, {"등급": "몰라", "말": "확인된 공개 기록이 없습니다", "항목": "리듬"}, {"등급": "몰라", "말": "이 업로더의 공개·48시간 경과 영상 0편 — 비교할 표본이 부족합니다", "항목": "타율"}, {"등급": "위험", "말": "올라갔던 영상 1편이 유튜브 응답에서 사라짐 — 지워진 롱폼… 스튜디오에서 확인하세요", "항목": "저작권"}],
    },
    "채널B": {
      "등급": "주의",
      "줄들": [{"등급": "몰라", "말": "2026-10-14까지 28일 72회 — 이전 28일 표본이 적어 추세는 판단하지 않습니다", "항목": "성장"}, {"등급": "몰라", "말": "2026-10-14까지 28일 +0 −0 — 표본이 적습니다", "항목": "구독"}, {"등급": "몰라", "말": "최근 조회 표본이 적어 시청 시간을 판단하지 않습니다", "항목": "시청"}, {"등급": "주의", "말": "이 업로더 기록은 예약이 모두 공개됐어도 공백 8일 (예약 결과 미확인 1편) — 다른 경로의 게시가 있다면 채널 실제 간격과 다를 수 있습니다", "항목": "리듬"}, {"등급": "몰라", "말": "이 업로더의 공개·48시간 경과 영상 0편 — 비교할 표본이 부족합니다", "항목": "타율"}, {"등급": "주의", "말": "지역 차단 영상 1편 — 스튜디오에서 원인을 확인하세요", "항목": "저작권"}],
    },
    "채널C": {
      "등급": "몰라",
      "줄들": [{"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "성장"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "구독"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "시청"}, {"등급": "몰라", "말": "예약 결과 미확인 1편 때문에 리듬 판정 보류 — 상태 맞춤으로 확인하세요", "항목": "리듬"}, {"등급": "몰라", "말": "영상 성적의 갱신 시각이 없거나 7일이 넘었습니다", "항목": "타율"}, {"등급": "몰라", "말": "영상 성적의 갱신 시각이 없거나 7일이 넘었습니다", "항목": "저작권"}],
    },
    "채널D": {
      "등급": "몰라",
      "줄들": [{"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "성장"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "구독"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "시청"}, {"등급": "몰라", "말": "확인된 공개 기록이 없습니다", "항목": "리듬"}, {"등급": "몰라", "말": "영상 성적의 갱신 시각이 없거나 7일이 넘었습니다", "항목": "타율"}, {"등급": "몰라", "말": "영상 성적의 갱신 시각이 없거나 7일이 넘었습니다", "항목": "저작권"}],
    },
  },
  "health_E": {
    "등급": "주의",
    "줄들": [{"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "성장"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "구독"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "시청"}, {"등급": "주의", "말": "이 업로더 기록상 최근 14일 중 8일 게시 · 최대 공백 5일 — 다른 경로의 게시가 있다면 채널 실제 간격과 다를 수 있습니다", "항목": "리듬"}, {"등급": "주의", "말": "이 업로더 최근 10편 하루 조회 중앙 100회 · 2배↑ 0편 · 바닥 4편", "항목": "타율"}, {"등급": "좋음", "말": "검사한 영상에서 지역 차단·실종 흔적 없음", "항목": "저작권"}],
  },
  "건강경계": {
    "채널F": {
      "등급": "주의",
      "줄들": [{"등급": "주의", "말": "2026-10-14까지 28일 800회 (그 전 28일 대비 0.8배)", "항목": "성장"}, {"등급": "주의", "말": "2026-10-14까지 28일 +10 −5 — 이탈률 50%", "항목": "구독"}, {"등급": "몰라", "말": "조회당 평균 0초 — 영상 길이별 비교 전에는 판정하지 않습니다", "항목": "시청"}, {"등급": "몰라", "말": "확인된 공개 기록이 없습니다", "항목": "리듬"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "타율"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "저작권"}],
    },
    "채널G": {
      "등급": "위험",
      "줄들": [{"등급": "위험", "말": "2026-10-14까지 28일 500회 (그 전 28일 대비 0.5배)", "항목": "성장"}, {"등급": "몰라", "말": "2026-10-14까지 28일 +4 −0 — 표본이 적습니다", "항목": "구독"}, {"등급": "몰라", "말": "조회당 평균 0초 — 영상 길이별 비교 전에는 판정하지 않습니다", "항목": "시청"}, {"등급": "몰라", "말": "확인된 공개 기록이 없습니다", "항목": "리듬"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "타율"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "저작권"}],
    },
    "채널H": {
      "등급": "주의",
      "줄들": [{"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "성장"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "구독"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "시청"}, {"등급": "주의", "말": "이 업로더 기록상 최근 14일 중 4일 게시 · 최대 공백 5일 — 다른 경로의 게시가 있다면 채널 실제 간격과 다를 수 있습니다", "항목": "리듬"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "타율"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "저작권"}],
    },
    "채널I": {
      "등급": "몰라",
      "줄들": [{"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "성장"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "구독"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "시청"}, {"등급": "좋음", "말": "이 업로더 기록상 최근 14일 중 5일 게시 · 최대 공백 4일", "항목": "리듬"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "타율"}, {"등급": "몰라", "말": "지표 갱신을 누르면 채워집니다", "항목": "저작권"}],
    },
  },
  "배우기": {
    "10": {"learned": false, "why": "7일 지난 영상이 7편뿐입니다 (최소 8편 필요)"},
    "11": {
      "best_dur": null,
      "best_hour": null,
      "cadence": 2.259027777777778,
      "dur_tbl": {},
      "hour_tbl": {},
      "learned": true,
      "median_views": 344.5,
      "n": 8,
      "trend": 29.411764705882355,
    },
  },
  "수확": {
    "각각": {
      "채널A": {
        "달성": false,
        "비율": 66,
        "설명": "구독 5,176 · 90일 쇼츠 참여조회 23,970 · 시청 2,662.5h · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널A롱": {
        "달성": false,
        "비율": 99,
        "설명": "구독 5,176 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널B": {
        "달성": false,
        "비율": 11,
        "설명": "구독 114 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널C": {
        "달성": false,
        "비율": 0,
        "설명": "구독 0 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널D": {
        "달성": false,
        "비율": 0,
        "설명": "구독 0 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
    },
    "직접A": {
      "달성": false,
      "비율": 66,
      "설명": "구독 5,176 · 90일 쇼츠 참여조회 23,970 · 시청 2,662.5h · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
      "이름": "1차",
      "전부": false,
      "차수": 1,
    },
    "묶음": {
      "채널A": {
        "달성": false,
        "비율": 99,
        "설명": "구독 5,176 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널A롱": {
        "달성": false,
        "비율": 99,
        "설명": "구독 5,176 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널B": {
        "달성": false,
        "비율": 11,
        "설명": "구독 114 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널C": {
        "달성": false,
        "비율": 0,
        "설명": "구독 0 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
      "채널D": {
        "달성": false,
        "비율": 0,
        "설명": "구독 0 · 90일 쇼츠 참여조회 자료 없음 · 시청 자료 없음 · 기준(구독 1,000/참여조회 1,000만 또는 시청 4,000h) · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인",
        "이름": "1차",
        "전부": false,
        "차수": 1,
      },
    },
  },
  "묶기": ["채널D", "채널A롱", "채널B", "모르는채널"],
  "차례": ["채널A", "채널A롱", "채널D", "모르는채널Y", "모르는채널Z"],
  "snapshot": {
    "채널A": {
      "at": 1792205400,
      "cid": CID.A,
      "exact": false,
      "source": "youtube_data_api",
      "subs": 5056,
      "title": "구독자 조회 10/17 11:50:00 · YouTube · 공개 수치 · 정확값 확인 대기 · 1분마다 조회",
    },
    "채널A롱": {
      "at": 1792205400,
      "cid": CID.A,
      "exact": false,
      "source": "youtube_data_api",
      "subs": 5056,
      "title": "구독자 조회 10/17 11:50:00 · YouTube · 공개 수치 · 정확값 확인 대기 · 1분마다 조회",
    },
    "채널B": {
      "at": 1792205400,
      "cid": CID.B,
      "exact": true,
      "source": "youtube_data_api",
      "subs": 120,
      "title": "구독자 조회 10/17 11:50:00 · YouTube · 1명 단위 · 1분마다 조회",
    },
    "채널C": {
      "at": 1792205400,
      "cid": CID.C,
      "exact": false,
      "source": "youtube_data_api",
      "subs": null,
      "title": "구독자 조회 10/17 11:50:00 · YouTube · 공개 수치 · 정확값 확인 대기 · 1분마다 조회",
    },
    "채널D": {
      "at": null,
      "cid": CID.D,
      "exact": false,
      "source": null,
      "subs": null,
      "title": "구독자 조회 기록 없음 · YouTube · 공개 수치 · 정확값 확인 대기 · 1분마다 조회 · 최근 조회 실패: 채널 총계를 읽지 못했습니다",
    },
  },
  "화면": {
    "갱신글": "10월 17일 11:00",
    "카드": [{"chart해시": "91fa7b88fe4b6830", "pd": "오늘 목표 2개 중 1개 올림 — 최근 3개 [800 · 15,000 · 300] 최고 15,000회 → 하루 2개", "남은": "1", "sum": ["102.0만", "채널 전체 누적 조회수 · 영상 40개"], "avg": "1.2만", "lk": "524", "cm": "28", "best": ["A영상2", "5.4만"], "geo": "한국 92% · 미국 5%", "건강": "좋음", "급등": "급등", "목록": [[["A영상1", "10/17", "1,200", "1,200", "10", "1"], ["A영상2", "10/16", "5.4만", "5.4만", "400", "20"], ["A영상3", "10/14", "800", "533", "—", "—"], ["A영상4", "10/09", "1.5만", "3,750", "90", "5"], ["A영상5", "09/27", "300", "30", "3", "0"], ["A영상6", "09/02", "2,500", "111", "21", "2"]], [["A옛히트", "26/04/20", "9.0만", "900", "1,000", "50"], ["A영상2", "10/16", "5.4만", "5.4만", "400", "20"], ["A영상4", "10/09", "1.5만", "3,750", "90", "5"], ["A영상6", "09/02", "2,500", "111", "21", "2"], ["A영상1", "10/17", "1,200", "1,200", "10", "1"], ["A영상3", "10/14", "800", "533", "—", "—"], ["A영상5", "09/27", "300", "30", "3", "0"]]], "상자": ["최근 6개", "조회수 상위 7개 (전체)"]}, {"chart해시": "d4628fd1259edb81", "pd": "오늘 목표 3개 중 0개 올림 — 고정 3개", "남은": "3", "sum": ["4.0만", "채널 전체 누적 조회수 · 영상 12개"], "avg": "2,200", "lk": "67", "cm": "3", "best": ["B영상2", "4,000"], "geo": "", "건강": "주의", "급등": "", "목록": [[["B영상1", "10/12", "900", "360", "5", "0"], ["B영상2", "10/11", "4,000", "1,333", "50", "2"], ["B영상3", "10/10", "1,700", "486", "12", "1"]], [["B영상2", "10/11", "4,000", "1,333", "50", "2"], ["B영상3", "10/10", "1,700", "486", "12", "1"], ["B영상1", "10/12", "900", "360", "5", "0"]]], "상자": ["최근 3개", "조회수 상위 3개 (전체)"]}, {"chart해시": "f329d49dbc23b83f", "pd": "오늘 목표 2개 중 0개 올림 — 아직 안 읽음 — [갱신]을 누르면 조회수로 정합니다", "남은": "2", "sum": ["103", "최근 2개 조회수"], "avg": "52", "lk": "1", "cm": "0", "best": ["C영상1", "70"], "geo": "", "건강": "몰라", "급등": "", "목록": [[["C영상1", "09/07", "70", "4", "1", "0"], ["C영상2", "25/08/30", "33", "1", "—", "0"]], [["C영상1", "09/07", "70", "4", "1", "0"], ["C영상2", "25/08/30", "33", "1", "—", "0"]]], "상자": ["최근 2개", "조회수 상위 2개 (전체)"]}, {"chart해시": "5335cec92fe81088", "pd": "오늘 목표 1개 중 0개 올림 — 아직 안 읽음 — [갱신]을 누르면 조회수로 정합니다", "남은": "1", "sum": ["0", "최근 0개 조회수"], "avg": "0", "lk": "0", "cm": "0", "best": null, "geo": "", "건강": "몰라", "급등": "", "목록": [[], []], "상자": ["최근 0개", "조회수 상위 0개 (전체)"]}],
    "풍선B": "[몰라] 성장 — 2026-10-14까지 28일 72회 — 이전 28일 표본이 적어 추세는 판단하지 않습니다\n[몰라] 구독 — 2026-10-14까지 28일 +0 −0 — 표본이 적습니다\n[몰라] 시청 — 최근 조회 표본이 적어 시청 시간을 판단하지 않습니다\n[주의] 리듬 — 이 업로더 기록은 예약이 모두 공개됐어도 공백 8일 (예약 결과 미확인 1편) — 다른 경로의 게시가 있다면 채널 실제 간격과 다를 수 있습니다\n[몰라] 타율 — 이 업로더의 공개·48시간 경과 영상 0편 — 비교할 표본이 부족합니다\n[주의] 저작권 — 지역 차단 영상 1편 — 스튜디오에서 원인을 확인하세요",
    "검토": [{"name": "채널A", "set해시": "dc56fcaf8e9180ca", "큰": "660", "누적": "103.3만", "좋": "20", "댓": "6", "누적표": false}, {"name": "채널B", "set해시": "f1de1105849cb56b", "큰": "327", "누적": "5.8만", "좋": "67", "댓": "3", "누적표": true}, {"name": "채널C", "set해시": "4be5b2dac3443016", "큰": "—", "누적": "7.4만", "좋": "1", "댓": "0", "누적표": true}, {"name": "채널D", "set해시": "f83279efe2dc83d5", "큰": "—", "누적": "—", "좋": "0", "댓": "0", "누적표": true}, {"name": "채널E", "set해시": "f83279efe2dc83d5", "큰": "—", "누적": "—", "좋": "0", "댓": "0", "누적표": true}],
    "검토합계": "987",
    "끌어": [{"head": "A표시", "n": "1번 있었습니다", "events": [{"d": ["10/15", "그날 합계 +2,455 · 평소 +330"], "more": "", "rows": [["pull", "A영상1", "100", "1,600", "16.0배"], ["ride", "A영상2", "36", "580", "7.2배"], ["ride", "A영상3", "11", "180", "3.0배"]]}]}, {"head": "채널A롱", "n": "0일째 기록 중 — 3일 뒤부터 볼 수 있습니다", "events": []}, {"head": "채널B", "n": "아직 동반 상승이 잡히지 않았습니다", "events": []}, {"head": "채널C", "n": "0일째 기록 중 — 3일 뒤부터 볼 수 있습니다", "events": []}, {"head": "채널D", "n": "0일째 기록 중 — 3일 뒤부터 볼 수 있습니다", "events": []}],
  },
  "찍기": {
    "반환": [1, 3, 0],
    "해시": {"구독기록.json": "e3ea65c2f6bdfd4e", "영상기록.json": "a29991d2ce21a285", "잦은기록.json": "6fc7bce764226581", "profiles.json": "e7f6e4a4af89ca2c"},
  },
  "갱신": {
    "입력": {
      "channels.json": {
        "_메모": {"설명": "밑줄로 시작하는 칸은 채널이 아니다"},
        "채널A": {"channel_id": CID.A, "folder": ""},
        "채널A롱": {"channel_id": CID.A, "folder": "", "롱폼": true},
        "채널B": {"channel_id": CID.B, "folder": "", "daily_rule": "fixed", "daily": 3},
      },
      "성적.json": {
        "채널A": {
          "_at": 1792106000,
          "daily": [9, "옛 근거"],
          "rows": [],
          "insight": {
            "learned": true,
            "n": 8,
            "best_dur": [30, 45],
            "dur_tbl": {"(30, 45)": [100, 3]},
            "best_hour": null,
            "hour_tbl": {},
            "trend": 3.5,
            "cadence": 1.5,
            "median_views": 120,
            "_at": 1792202400,
          },
        },
      },
      "ledger": [{"업로드시각": "2026-10-16T09:00:00", "채널": "채널B", "영상ID": "vBgone", "제목": "사라진 편", "공개설정": "public", "공개시각": "2026-10-16 18:00", "예약시각": ""}, {"업로드시각": "2026-10-15T09:00:00", "채널": "채널B", "영상ID": "vB00", "제목": "B영상0", "공개설정": "public", "공개시각": "2026-10-15 18:00", "예약시각": ""}],
      "policy.json": {"표시이름": {}},
    },
    "해시": {
      "성적.json": "398ff12f18d7c05d",
      "구독기록.json": "41f5cadbd29edf8d",
      "영상기록.json": "a29991d2ce21a285",
      "profiles.json": "c1a46a06983dd81f",
      "분석기록.json": "57c07049e8c6ea5b",
    },
    "배움글": ["최근 32편 · 조회수 중앙값 1,014회", "가장 잘 되는 길이 15~30초 (중앙값 2,568회 · 6편)", "가장 잘 되는 시간 22~6시 (중앙값 1,599회 · 10편)", "추세 상승 131%", "업로드 간격 중앙값 2.3일"],
  },
  "분석받기": {
    "호출": [{"dimensions": "day", "endDate": "2026-10-17", "ids": "channel==MINE", "metrics": "views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares", "sort": "day", "startDate": "2025-10-18"}, {"dimensions": "country", "endDate": "2026-10-17", "ids": "channel==MINE", "maxResults": "200", "metrics": "views", "sort": "-views", "startDate": "2026-09-20"}, {"dimensions": "day,creatorContentType", "endDate": "2026-10-17", "ids": "channel==MINE", "metrics": "views,estimatedMinutesWatched,engagedViews", "sort": "day", "startDate": "2025-10-18"}],
    "파일해시": "ef42c91fcbc2d585",
  },
  "올린": {
    "기본원장": {
      "채널A": [{"file": "", "title": "오늘 올림", "uploaded": "2026-10-17T08:00:00", "video_id": "today1"}, {"file": "", "title": "예약", "uploaded": "2026-10-16T09:10:00", "video_id": "res1"}, {"file": "", "title": "A영상", "uploaded": "2026-10-16T09:00:00", "video_id": "a01"}, {"file": "", "title": "A영상", "uploaded": "2026-10-14T09:00:00", "video_id": "a03"}, {"file": "", "title": "A영상", "uploaded": "2026-10-13T09:00:00", "video_id": "a04"}, {"file": "", "title": "A영상", "uploaded": "2026-10-11T09:00:00", "video_id": "a06"}, {"file": "", "title": "A영상", "uploaded": "2026-10-10T09:00:00", "video_id": "a07"}, {"file": "", "title": "A영상", "uploaded": "2026-10-08T09:00:00", "video_id": "a09"}, {"file": "", "title": "A영상", "uploaded": "2026-10-07T09:00:00", "video_id": "a10"}, {"file": "", "title": "A영상", "uploaded": "2026-10-05T09:00:00", "video_id": "a12"}, {"file": "", "title": "A영상", "uploaded": "2026-10-04T09:00:00", "video_id": "a13"}],
      "채널B": [{"file": "", "title": "예약B", "uploaded": "2026-10-14T09:00:00", "video_id": "bres"}, {"file": "", "title": "B영상", "uploaded": "2026-10-06T09:00:00", "video_id": "b11"}, {"file": "", "title": "B영상", "uploaded": "2026-10-05T09:00:00", "video_id": "b12"}, {"file": "", "title": "B영상", "uploaded": "2026-10-04T09:00:00", "video_id": "b13"}],
      "채널C": [{"file": "", "title": "예약C", "uploaded": "2026-10-11T09:00:00", "video_id": "cres"}, {"file": "", "title": "C영상", "uploaded": "2026-10-07T09:00:00", "video_id": "c10"}, {"file": "", "title": "C영상", "uploaded": "2026-10-06T09:00:00", "video_id": "c11"}, {"file": "", "title": "C영상", "uploaded": "2026-10-05T09:00:00", "video_id": "c12"}, {"file": "", "title": "C영상", "uploaded": "2026-10-04T09:00:00", "video_id": "c13"}],
      "채널E": [{"file": "", "title": "E영상", "uploaded": "2026-10-11T09:00:00", "video_id": "e06"}, {"file": "", "title": "E영상", "uploaded": "2026-10-10T09:00:00", "video_id": "e07"}, {"file": "", "title": "E영상", "uploaded": "2026-10-09T09:00:00", "video_id": "e08"}, {"file": "", "title": "E영상", "uploaded": "2026-10-08T09:00:00", "video_id": "e09"}, {"file": "", "title": "E영상", "uploaded": "2026-10-07T09:00:00", "video_id": "e10"}, {"file": "", "title": "E영상", "uploaded": "2026-10-06T09:00:00", "video_id": "e11"}, {"file": "", "title": "E영상", "uploaded": "2026-10-05T09:00:00", "video_id": "e12"}, {"file": "", "title": "E영상", "uploaded": "2026-10-04T09:00:00", "video_id": "e13"}, {"file": "", "title": "E영상", "uploaded": "2026-10-03T09:00:00", "video_id": "e14"}, {"file": "", "title": "E영상", "uploaded": "2026-10-02T09:00:00", "video_id": "e15"}],
      "채널H": [{"file": "", "title": "영상", "uploaded": "2026-10-12T09:00:00", "video_id": "h05"}, {"file": "", "title": "영상", "uploaded": "2026-10-06T09:00:00", "video_id": "h11"}, {"file": "", "title": "영상", "uploaded": "2026-10-05T09:00:00", "video_id": "h12"}, {"file": "", "title": "영상", "uploaded": "2026-10-04T09:00:00", "video_id": "h13"}],
      "채널I": [{"file": "", "title": "영상", "uploaded": "2026-10-16T09:00:00", "video_id": "i01"}, {"file": "", "title": "영상", "uploaded": "2026-10-11T09:00:00", "video_id": "i06"}, {"file": "", "title": "영상", "uploaded": "2026-10-10T09:00:00", "video_id": "i07"}, {"file": "", "title": "영상", "uploaded": "2026-10-05T09:00:00", "video_id": "i12"}, {"file": "", "title": "영상", "uploaded": "2026-10-04T09:00:00", "video_id": "i13"}],
    },
    "덧붙임": [{"업로드시각": "2026-10-15T09:00:00", "채널": "채널B", "영상ID": "vB00", "제목": "원장제목 B0", "파일": "/x/b0.mp4"}, {"업로드시각": "2026-10-16T09:00:00", "채널": "채널B", "영상ID": "vB01", "제목": "원장제목 B1(비공개)", "파일": "/x/b1.mp4"}, {"업로드시각": "2026-10-16T10:00:00", "채널": "채널B", "영상ID": "vB77", "제목": "유튜브에 없는 편", "파일": "/x/b7.mp4"}, {"업로드시각": "2026-10-14T10:00:00", "채널": "채널A", "영상ID": "vA00", "제목": "원장제목 A0", "파일": "/x/a0.mp4"}, {"업로드시각": "2026-10-13T10:00:00", "채널": "채널A", "영상ID": "vA05", "제목": "원장제목 A5", "파일": "/x/a5.mp4"}],
    "원장": {
      "채널A": [{"file": "", "title": "오늘 올림", "uploaded": "2026-10-17T08:00:00", "video_id": "today1"}, {"file": "", "title": "예약", "uploaded": "2026-10-16T09:10:00", "video_id": "res1"}, {"file": "", "title": "A영상", "uploaded": "2026-10-16T09:00:00", "video_id": "a01"}, {"file": "/x/a0.mp4", "title": "원장제목 A0", "uploaded": "2026-10-14T10:00:00", "video_id": "vA00"}, {"file": "", "title": "A영상", "uploaded": "2026-10-14T09:00:00", "video_id": "a03"}, {"file": "/x/a5.mp4", "title": "원장제목 A5", "uploaded": "2026-10-13T10:00:00", "video_id": "vA05"}, {"file": "", "title": "A영상", "uploaded": "2026-10-13T09:00:00", "video_id": "a04"}, {"file": "", "title": "A영상", "uploaded": "2026-10-11T09:00:00", "video_id": "a06"}, {"file": "", "title": "A영상", "uploaded": "2026-10-10T09:00:00", "video_id": "a07"}, {"file": "", "title": "A영상", "uploaded": "2026-10-08T09:00:00", "video_id": "a09"}, {"file": "", "title": "A영상", "uploaded": "2026-10-07T09:00:00", "video_id": "a10"}, {"file": "", "title": "A영상", "uploaded": "2026-10-05T09:00:00", "video_id": "a12"}, {"file": "", "title": "A영상", "uploaded": "2026-10-04T09:00:00", "video_id": "a13"}],
      "채널B": [{"file": "/x/b7.mp4", "title": "유튜브에 없는 편", "uploaded": "2026-10-16T10:00:00", "video_id": "vB77"}, {"file": "/x/b1.mp4", "title": "원장제목 B1(비공개)", "uploaded": "2026-10-16T09:00:00", "video_id": "vB01"}, {"file": "/x/b0.mp4", "title": "원장제목 B0", "uploaded": "2026-10-15T09:00:00", "video_id": "vB00"}, {"file": "", "title": "예약B", "uploaded": "2026-10-14T09:00:00", "video_id": "bres"}, {"file": "", "title": "B영상", "uploaded": "2026-10-06T09:00:00", "video_id": "b11"}, {"file": "", "title": "B영상", "uploaded": "2026-10-05T09:00:00", "video_id": "b12"}, {"file": "", "title": "B영상", "uploaded": "2026-10-04T09:00:00", "video_id": "b13"}],
      "채널C": [{"file": "", "title": "예약C", "uploaded": "2026-10-11T09:00:00", "video_id": "cres"}, {"file": "", "title": "C영상", "uploaded": "2026-10-07T09:00:00", "video_id": "c10"}, {"file": "", "title": "C영상", "uploaded": "2026-10-06T09:00:00", "video_id": "c11"}, {"file": "", "title": "C영상", "uploaded": "2026-10-05T09:00:00", "video_id": "c12"}, {"file": "", "title": "C영상", "uploaded": "2026-10-04T09:00:00", "video_id": "c13"}],
      "채널E": [{"file": "", "title": "E영상", "uploaded": "2026-10-11T09:00:00", "video_id": "e06"}, {"file": "", "title": "E영상", "uploaded": "2026-10-10T09:00:00", "video_id": "e07"}, {"file": "", "title": "E영상", "uploaded": "2026-10-09T09:00:00", "video_id": "e08"}, {"file": "", "title": "E영상", "uploaded": "2026-10-08T09:00:00", "video_id": "e09"}, {"file": "", "title": "E영상", "uploaded": "2026-10-07T09:00:00", "video_id": "e10"}, {"file": "", "title": "E영상", "uploaded": "2026-10-06T09:00:00", "video_id": "e11"}, {"file": "", "title": "E영상", "uploaded": "2026-10-05T09:00:00", "video_id": "e12"}, {"file": "", "title": "E영상", "uploaded": "2026-10-04T09:00:00", "video_id": "e13"}, {"file": "", "title": "E영상", "uploaded": "2026-10-03T09:00:00", "video_id": "e14"}, {"file": "", "title": "E영상", "uploaded": "2026-10-02T09:00:00", "video_id": "e15"}],
      "채널H": [{"file": "", "title": "영상", "uploaded": "2026-10-12T09:00:00", "video_id": "h05"}, {"file": "", "title": "영상", "uploaded": "2026-10-06T09:00:00", "video_id": "h11"}, {"file": "", "title": "영상", "uploaded": "2026-10-05T09:00:00", "video_id": "h12"}, {"file": "", "title": "영상", "uploaded": "2026-10-04T09:00:00", "video_id": "h13"}],
      "채널I": [{"file": "", "title": "영상", "uploaded": "2026-10-16T09:00:00", "video_id": "i01"}, {"file": "", "title": "영상", "uploaded": "2026-10-11T09:00:00", "video_id": "i06"}, {"file": "", "title": "영상", "uploaded": "2026-10-10T09:00:00", "video_id": "i07"}, {"file": "", "title": "영상", "uploaded": "2026-10-05T09:00:00", "video_id": "i12"}, {"file": "", "title": "영상", "uploaded": "2026-10-04T09:00:00", "video_id": "i13"}],
    },
    "live": {
      "vB00": {"comments": 0, "likes": 5, "per_day": 300, "privacy": "public", "published": "2026-10-14T12:00:00+09:00", "thumb": null, "title": "B영상0", "views": 900},
      "vB01": {
        "comments": 1,
        "likes": 6,
        "per_day": 161.6580310880829,
        "privacy": "private",
        "published": "2026-10-09T11:00:00+09:00",
        "thumb": null,
        "title": "B영상1",
        "views": 1300,
      },
      "vB02": {
        "comments": 2,
        "likes": 7,
        "per_day": 129.93630573248407,
        "privacy": "public",
        "published": "2026-10-04T10:00:00+09:00",
        "thumb": null,
        "title": "B영상2",
        "views": 1700,
      },
    },
    "모음": {
      "채널A": [{"file": "", "live": false, "title": "오늘 올림", "uploaded": "2026-10-17T08:00:00", "video_id": "today1"}, {"file": "", "live": false, "title": "예약", "uploaded": "2026-10-16T09:10:00", "video_id": "res1"}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-16T09:00:00", "video_id": "a01"}, {"comments": null, "file": "/x/a0.mp4", "likes": null, "live": true, "per_day": 468, "privacy": "public", "published": "2026-10-16T12:00:00+09:00", "thumb": null, "title": "A영상0", "uploaded": "2026-10-14T10:00:00", "video_id": "vA00", "views": 468}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-14T09:00:00", "video_id": "a03"}, {"comments": 5, "file": "/x/a5.mp4", "likes": 15, "live": true, "per_day": 351.60254468342924, "privacy": "public", "published": "2026-10-06T00:55:00+09:00", "thumb": null, "title": "A영상5", "uploaded": "2026-10-13T10:00:00", "video_id": "vA05", "views": 4030}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-13T09:00:00", "video_id": "a04"}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-11T09:00:00", "video_id": "a06"}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-10T09:00:00", "video_id": "a07"}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-08T09:00:00", "video_id": "a09"}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-07T09:00:00", "video_id": "a10"}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-05T09:00:00", "video_id": "a12"}, {"file": "", "live": false, "title": "A영상", "uploaded": "2026-10-04T09:00:00", "video_id": "a13"}],
      "채널B": [{"file": "/x/b7.mp4", "live": false, "title": "유튜브에 없는 편", "uploaded": "2026-10-16T10:00:00", "video_id": "vB77"}, {"comments": 1, "file": "/x/b1.mp4", "likes": 6, "live": true, "per_day": 161.6580310880829, "privacy": "private", "published": "2026-10-09T11:00:00+09:00", "thumb": null, "title": "B영상1", "uploaded": "2026-10-16T09:00:00", "video_id": "vB01", "views": 1300}, {"comments": 0, "file": "/x/b0.mp4", "likes": 5, "live": true, "per_day": 300, "privacy": "public", "published": "2026-10-14T12:00:00+09:00", "thumb": null, "title": "B영상0", "uploaded": "2026-10-15T09:00:00", "video_id": "vB00", "views": 900}, {"file": "", "live": false, "title": "예약B", "uploaded": "2026-10-14T09:00:00", "video_id": "bres"}, {"file": "", "live": false, "title": "B영상", "uploaded": "2026-10-06T09:00:00", "video_id": "b11"}, {"file": "", "live": false, "title": "B영상", "uploaded": "2026-10-05T09:00:00", "video_id": "b12"}, {"file": "", "live": false, "title": "B영상", "uploaded": "2026-10-04T09:00:00", "video_id": "b13"}],
      "채널D": [],
    },
  },
};

/* ============================================================ 시험 */

export async function 실행() {
  구역("시간대");
  if (systemZone() !== "Asia/Seoul") {
    같나("이 시험은 TZ=Asia/Seoul 로 돌려야 한다 (기대값이 한국 시각 기준)", systemZone(), "Asia/Seoul");
    return;
  }
  await 고정시계(async () => {
    quota.set추적(false); // 호출 자리 기록(스택 읽기)은 시험에 필요 없다
    try {
      셈도우미();
      편수와표();
      await 고르기();
      배운것();
      await 배우기경계();
      await 자료읽는쪽();
      await 끌어올림기록();
      await 스튜디오지표();
      await 구독갱신_원본시험();
      await 구독찍기();
      await 갱신전체흐름();
      await 호출수();
      await 올린영상();
    } finally {
      quota.set추적(true);
    }
  });
}

/* ──────────────── 셈 도우미: 파이썬과 같은 값·같은 글자 ──────────────── */

function 셈도우미() {
  구역("셈 도우미 (파이썬 round · format 과 같은 값)");
  같나("round: 정확히 한가운데는 짝수 쪽으로", [0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5].map((x) => pyRound(x)), 기대.셈.round0);
  같나("round(x, n): 2진수로 딱 떨어지는 한가운데도 짝수 쪽 · 아닌 값은 실제 크기대로", 기대.셈.roundN.map(([x, n]: [number, number]) => pyRound(x, n)), 기대.셈.roundN.map((r: number[]) => r[2]));
  같나("format .Nf", 기대.셈.fixed.map(([x, n]: [number, number]) => fixed(x, n)), 기대.셈.fixed.map((r: unknown[]) => r[2]));
  같나("format ,.Nf", 기대.셈.commaFixed.map(([x, n]: [number, number]) => commaFixed(x, n)), 기대.셈.commaFixed.map((r: unknown[]) => r[2]));
  같나("format ,  (정수)", [0, 7, 999, 1000, 1234567, -1234].map(commaInt), ["0", "7", "999", "1,000", "1,234,567", "-1,234"]);
  같나("format +,  (부호 늘 붙임)", [0, 5, -5, 1234, -1234567].map(signedComma), ["+0", "+5", "-5", "+1,234", "-1,234,567"]);
  같나("format ,  (실수 — 딱 떨어져도 .0)", [1234, 1234.5, 0, 2662.5, 99999999].map(commaFloat), ["1,234.0", "1,234.5", "0.0", "2,662.5", "99,999,999.0"]);
  같나("median", [median([3, 1, 2]), median([1, 2, 3, 4]), median([5]), median([2, 2, 9, 9])], [2, 2.5, 5, 5.5]);
  같나("글자 자르기는 글자 단위(이모지가 반 토막 나지 않는다)", [cut("가나다라마", 3), cut("😀😀😀", 2), cut("abc", 10), cut(null, 3)], ["가나다", "😀😀", "abc", ""]);
  같나("int() 가 읽는 것만 읽는다", [pyInt("12"), pyInt(" 12 "), pyInt("+7"), pyInt("1.5"), pyInt(1.9), pyInt(-1.9), pyInt(null), pyInt("abc"), pyInt(true), pyInt(NaN)],
    [12, 12, 7, null, 1, -1, null, null, 1, null]);
  같나("파이썬 상수와 같은 값", [RECENT, MATURE_HOURS, SAMPLE], [30, 48, 3]);
  같나("영상 길이 글자 PT1M23S → 초", ["PT1M23S", "PT45S", "PT1H2M3S", "PT0S", "", "P1D"].map(isoDurToSec), [83, 45, 3723, 0, 0, 0]);
}

/* ──────────────── 편수 · 표 ──────────────── */

function 편수와표() {
  구역("하루 편수 (조회수로 정하는 규칙)");
  const 줄 = (title: string, views: number, likes: number | null, cmts: number | null, pub: string, vpd: number) => ({
    id: "x", title, views, likes, comments: cmts, published: new 진짜Date(pub), age_days: 1, views_per_day: vpd,
    like_rate: likes !== null && views ? (likes / views) * 100 : null,
  });
  const 줄들 = [
    줄("첫째 영상 제목이 서른 글자를 넘어가면 잘려서 나옵니다 정말로 길어요", 123456, 4000, 120, "2026-10-10T15:30:00Z", 41152.0),
    줄("둘째", 9999, null, null, "2026-10-11T14:59:00Z", 3333.0),
    줄("셋째 😀 이모지", 10000, 500, 5, "2026-10-12T00:00:00Z", 2500.5),
    줄("넷째", 0, 0, 0, "2026-10-13T23:59:00Z", 0.0),
    줄("다섯째", 250, 7, 1, "2026-10-14T01:00:00Z", 62.5),
  ];
  같나("표: 올린 날은 한국 날짜 · 1만 이상은 「1.2만」 · 숨긴 칸은 「—」", perfTable(줄들), 기대.편수.perf_table);
  같나("표: 앞에서 2개만", perfTable(줄들, 2), 기대.편수.perf_table_limit2);
  같나("표: 영상이 없으면", perfTable([]), 기대.편수.perf_table_empty);
  같나("표: 좋아요율이 없으면 꼬리에 안 적는다", perfTable([줄들[1], 줄들[3]]), 기대.편수.perf_table_nolike);

  const r2 = [{ min_views: 100, daily: 7 }, { min_views: 0, daily: 2 }];
  같나("규칙 문턱 (10만 → 4 · 1만 → 2 · 그 밑 → 1) · 내 규칙", [0, 9999, 10000, 99999, 100000, 5_000_000].map((v) => dailyFor(v)).concat([dailyFor(50, r2), dailyFor(150, r2), dailyFor(5, [{ min_views: 100, daily: 7 }])]), 기대.편수.daily_for);
  const D = decideFromRows;
  같나("편수: 근거 글까지 원본과 같다", {
    empty: D([], null, 2),
    all_young: D([{ views: 100, age_days: 1.9 }], null, 3),
    exact_48h: D([{ views: 20000, age_days: 2 }], null, 1),
    recent3_not_oldest: D([{ views: 10, age_days: 3 }, { views: 20, age_days: 4 }, { views: 30, age_days: 5 }, { views: 500000, age_days: 60 }], null, 1),
    mix_young: D([{ views: 999999, age_days: 0.5 }, { views: 12000, age_days: 2.5 }, { views: 300, age_days: 9 }], null, 1),
    custom_rule: D([{ views: 150, age_days: 3 }], r2, 1),
    none_views: D([{ views: null, age_days: 3 }, { views: 5, age_days: null }], null, 1),
    mature_hours_72: D([{ views: 20000, age_days: 2.5 }], null, 1, 72),
    mature_hours_72_ok: D([{ views: 20000, age_days: 3.5 }], null, 1, 72),
  }, 기대.편수.decide);
  // 제일 오래된 영상으로 편수를 정할 뻔한 일(원본 2026-09)이 다시 없도록: 익은 것 중 **최근 3개**만 본다
  같나("가장 오래된 영상(50만)이 아니라 최근 3개(최고 30)로 정한다 → 1개", D([{ views: 10, age_days: 3 }, { views: 20, age_days: 4 }, { views: 30, age_days: 5 }, { views: 500000, age_days: 60 }], null, 1)[0], 1);
}

/* ──────────────── 고르기 ──────────────── */

async function 고르기() {
  구역("폴더에서 오늘 올릴 것 고르기 (picker)");
  await 모래상자(async (dir) => {
    const 목록: { name: string; info: any; age: number }[] = 기대.고르기_입력;
    await Deno.mkdir(`${dir}/pk`, { recursive: true });
    const L: picker.PickItem[] = [];
    for (const x of 목록) {
      const p = `${dir}/pk/${x.name}`;
      await Deno.writeFile(p, new Uint8Array([1]));
      const t = NOW_EPOCH - x.age * 86400; // 폴더에 들어온 지 며칠
      await Deno.utime(p, t, t);
      L.push({ path: p, info: x.info });
    }
    const 이름 = (p: string) => p.split("/").pop()!;
    const ins = { best_dur: [30, 45] };
    같나("점수와 근거", Object.fromEntries(L.map((x) => [이름(x.path), picker.score(x.path, x.info)])), 기대.고르기.score);
    같나("점수와 근거 (이 채널 최적 길이를 배운 뒤)", Object.fromEntries(L.map((x) => [이름(x.path), picker.score(x.path, x.info, ins)])), 기대.고르기.score_ins);
    같나("순위: 점수 높은 순 · 같으면 이름 순", picker.rank(L).map((r) => [이름(r.path), r.pts, r.why]), 기대.고르기.rank);
    같나("순위 (배운 뒤)", picker.rank(L, ins).map((r) => [이름(r.path), r.pts, r.why]), 기대.고르기.rank_ins);
    const 고름 = (mode: string, n: number, names?: string[] | null, i?: picker.InsightLike) => {
      const r = picker.choose(L, mode, n, names, i);
      return [r.chosen.map((x) => 이름(x.path)), r.note];
    };
    // 원본 안내문의 「--pick」 은 명령줄 옵션 이름이라 새 앱에서는 「직접 바꿀 수 있습니다」 로 바꿨다(기대값에 반영)
    같나("고르는 네 방식 (+ 모르는 방식은 오래된 순)", {
      order: 고름("order", 3), oldest: 고름("oldest", 3), suggest: 고름("suggest", 3), suggest_ins: 고름("suggest", 3, null, ins),
      manual: 고름("manual", 5, [`${dir}/pk/b_근사.mp4`, "g_1600.mp4", "없음.mp4"]), manual_empty: 고름("manual", 5, []), 엉뚱한방식: 고름("mystery", 2),
    }, 기대.고르기.choose);
    같나("이름만 바꿔 다시 들어온 같은 영상(길이 0.1초 · 크기 1KB)을 묶는다", picker.findDuplicates(L).map((g) => g.map(이름)), 기대.고르기.dups);
    같나("재고 며칠치", [[0, 2], [3, 2], [8, 2], [20, 2], [5, 0], [1, 1], [4, 1], [10, 2]].map(([w, d]) => { const r = picker.daysLeft(w, d); return [r.days, r.note]; }), 기대.고르기.days_left);
    같나("추천 목록 글", picker.report(L, 3, 5), 기대.고르기.report);
    같나("방식 이름", [...picker.MODES], ["order", "oldest", "suggest", "manual"]);
  });
}

/* ──────────────── 이 채널에서 배운 것 ──────────────── */

function 배운것() {
  구역("배운 것 (길이대 · 시간대 · 추세)");
  같나("설명 글", Object.fromEntries(Object.entries(기대.배움.describe_in).map(([k, v]) => [k, describe(v as any)])), 기대.배움.describe);
  const 행: { views: number; sec: number; hour: number }[] = 기대.배움.rows;
  같나("구간 고르기: 길이 · 시간(밤샘 구간은 22시~6시로 돌아 감는다) · 동점은 먼저 만난 구간 · 한 구간뿐이면 안 배운다", {
    dur: bestBucket(행, (r) => r.sec, DUR_BUCKETS),
    hour: bestBucket(행, (r) => r.hour, HOUR_BUCKETS, true),
    tie: bestBucket([1, 2, 3, 20, 21, 22].map((s) => ({ views: 10, sec: s })), (r) => r.sec, DUR_BUCKETS),
    one_bucket: bestBucket([1, 2, 3].map((s) => ({ views: 10, sec: s })), (r) => r.sec, DUR_BUCKETS),
  }, 기대.배움.best_bucket);
  // 구간표의 열쇠 글은 파이썬이 튜플 열쇠를 성적.json 에 저장하며 쓰던 「(30, 45)」 꼴이어야 두 프로그램이 같은 파일을 읽는다(위 기대값이 그 꼴이다)
}

async function 배우기경계() {
  구역("배우기 경계 — 올린 지 7일 지난 영상이 7편이면 안 배우고 8편이면 배운다");
  for (const nA of [10, 11]) {
    await 모래상자(async () => {
      const g = new 가짜구글();
      세계세우기(g, 세계(nA));
      g.install();
      await 토큰심기({ "채널A": { cid: CID.A, refresh: "RT_A" } });
      await writeJson(dataPath("channels.json"), { "채널A": { channel_id: CID.A, folder: "" } });
      같은값(`영상 ${nA}편 중 7일 지난 것으로 배운 결과`, await learn("채널A"), 기대.배우기[String(nA)]);
      g.uninstall();
    });
  }
  await 모래상자(async () => {
    // 인증 전 채널이면 던지지 않고 이유를 말한다 (원본: 「아직 인증 전입니다」)
    같나("인증 전", await learn("없는채널"), { learned: false, why: "아직 인증 전입니다" });
  });
}

/* ──────────────── 저장된 자료만 읽는 쪽 ──────────────── */

async function 자료읽는쪽() {
  await 모래상자(async () => {
    const g = new 가짜구글().install(); // 아무것도 흉내 내지 않는다 — 한 번이라도 불리면 안 된다
    await 심기();
    const chans = loadChannels();
    const names = Object.keys(chans);

    구역("급등 (최근 3일 vs 직전 3일)");
    {
      const o: Obj = {};
      for (const n of names) o[n] = await judge(n);
      같은값("채널별 판정 · 문구(배수는 「11.0배」 처럼 소수 한 자리)", o, 기대.spike);
      const e: Obj = {};
      for (const n of ["S새로", "S잡음", "S빠진날", "S구독없음", "S부족", "S하락", "S두배"]) e[n] = await judge(n);
      같은값("경계 사례: 직전이 0 이면 「늘기 시작」 · 잡음 바닥 미만 · 빠진 날은 하루치로 고쳐 3일에 맞춤 · 구독 없음 · 기록 부족 · 하락 · 정확히 2배(급등)", e, 기대.spike_extra);
      같은값("한꺼번에 불러도 같다", await allJudge(["채널A", "채널B"]), { 채널A: 기대.spike["채널A"], 채널B: 기대.spike["채널B"] });
      같나("급등 띠 조각", { 채널A: sv.spikeBandOf(await judge("채널A")).map((b) => [b.이름, b.배, b.설명]), 채널B: sv.spikeBandOf(await judge("채널B")).map((b) => [b.이름, b.배, b.설명]) }, 기대.spike_band);
    }

    구역("구독 기록 (하루 한 점)");
    {
      const s: Obj = {}, f: Obj = {};
      for (const n of names) { s[n] = await subs.summary(n); f[n] = await subs.flow(n, 10); }
      같은값("요약: 어제 대비 · 7일 · 30일 · 믿음(10명 이상 움직였을 때만) · 한 줄", s, 기대.subs_summary);
      같은값("흐름: 없는 날은 비운다(채우지 않는다)", f, 기대.subs_flow);
    }

    구역("끌어올림 (동반 상승)");
    {
      const A = 기대.lift.A;
      같은값("A 요약", await lift.summary("채널A"), A.요약);
      같은값("A 사건: 끈 영상 · 딸린 영상 · 합계 · 평소", await lift.events("채널A", 30), A.사건들);
      같은값("A 채널 하루 조회(영상별 증가분의 합)", await lift.channelDailyViews("채널A", 4), A.채널하루조회4);
      같은값("A 누적 흐름(채널)", await lift.cumulativeFlow("채널A", null, 5), A.누적흐름_채널);
      같은값("A 최근 48시간 증가", await lift.recentIncrease("채널A", 48), A.최근증가48);
      같은값("A 최근 10시간 증가", await lift.recentIncrease("채널A", 10), A.최근증가10);
      const 영상최근: Obj = {};
      for (const t of ["A영상1", "A영상2", "A영상3", "없는영상"]) 영상최근[t] = await lift.videoRecent("채널A", t, 48);
      같은값("A 영상별 최근 증가 (옛 꼴 숫자 점도 읽는다 · 없는 영상은 못 냄)", 영상최근, A.영상최근);
      const 흐: Obj = {}, 흐400: Obj = {};
      for (const t of ["A영상1", "A영상3", "A영상4"]) 흐[t] = await lift.cumulativeFlow("채널A", t, 3);
      for (const t of ["A영상1", "A영상4"]) 흐400[t] = await lift.cumulativeFlow("채널A", t, 400);
      같은값("A 영상별 누적 흐름(시각별 + 하루 점을 합쳐 촘촘한 쪽이 이긴다)", 흐, A.누적흐름_영상);
      같은값("A 영상별 누적 흐름 400일", 흐400, A.누적흐름_영상400);
      같은값("B 요약 · 하루 조회(정정된 영상만 뺀다) · 최근 증가", { 요약: await lift.summary("채널B"), 하루: await lift.channelDailyViews("채널B", 4), 증가: await lift.recentIncrease("채널B", 48) },
        { 요약: 기대.lift.B.요약, 하루: 기대.lift.B.채널하루조회4, 증가: 기대.lift.B.최근증가48 });
      같은값("D(기록 없음) 요약", await lift.summary("채널D"), 기대.lift.D.요약);
      같은값("채널 여럿 요약", await lift.allSummary(["채널A", "채널B", "채널C"]), 기대.lift.all_summary);
      같은값("경계 사례(L): 평소가 0 이면 배수 못 냄 · 29회는 잡음 · 끈 영상 배수 1.1 이면 건너뜀 / (M): 정확히 2.0배(끈) · 1.5배(딸림)은 걸린다", {
        요약: await lift.summary("채널L"), 사건들: await lift.events("채널L", 30), 사건들3: await lift.events("채널L", 3), 채널하루조회: await lift.channelDailyViews("채널L", 3),
        M요약: await lift.summary("채널M"), M사건들: await lift.events("채널M", 30),
      }, 기대.lift.extra);
    }

    구역("스튜디오 지표 저장본 읽기");
    {
      const o: Obj = {};
      for (const n of ["채널A", "채널B", "채널C"]) {
        o[n] = {
          "7": await analytics.periodSummary(n, 7), "28": await analytics.periodSummary(n, 28), "90": await analytics.periodSummary(n, 90), "365": await analytics.periodSummary(n, 365),
          나라2: await analytics.countrySummary(n, 2), 나라5: await analytics.countrySummary(n, 5), 받은때: await analytics.receivedAt(n),
        };
      }
      같은값("A 7일 요약 (스튜디오 개요와 같은 값)", o["채널A"]["7"], 기대.분석.A7);
      같은값("A 28일 요약", o["채널A"]["28"], 기대.분석.A28);
      같은값("나라 비율 글 · 받은 때", Object.fromEntries(Object.entries(o).map(([n, v]) => [n, [v.나라2, v.나라5, v.받은때]])), 기대.분석.나라);
      await 같은해시("전 채널 · 7/28/90/365일 요약 전부", o, 기대.분석.해시);
      같나("저장본이 없는 채널은 null · 빈 글", [await analytics.periodSummary("채널C", 28), await analytics.countrySummary("채널C"), await analytics.receivedAt("채널C")], [null, "", ""]);
      같나("조회가 50회 미만이면 나라 비율을 말하지 않는다", await analytics.countrySummary("채널B"), "");
    }

    구역("채널 건전성 (유튜브 호출 0건)");
    {
      const o: Obj = {};
      for (const n of names) o[n] = await evaluate(n);
      // 원본 안내문의 「./업로더 맞춤」 은 명령줄 이름이라 「상태 맞춤」 으로 바꿨다(기대값에 반영)
      같은값("여섯 항목 판정과 말 (성장 · 구독 · 시청 · 리듬 · 타율 · 저작권)", o, 기대.health);
      같은값("타율이 「주의」 로 나오는 경우(바닥 넷 · 터짐 없음) · 성적을 3일 전에 읽었어도 7일 안이면 믿는다", await evaluate("채널E"), 기대.health_E);
      const 경계: Obj = {};
      for (const n of ["채널F", "채널G", "채널H", "채널I"]) 경계[n] = await evaluate(n);
      같은값("경계: 성장 정확히 0.8배 → 주의 · 0.5배 → 위험 · 이탈률 정확히 50% → 주의 · 구독 얻은 게 5 미만이면 표본 부족 · 공백 5일 → 주의 / 4일 → 좋음", 경계, 기대.건강경계);
    }

    구역("수확 진행 · 묶기 · 순서");
    {
      const o: Obj = {};
      for (const n of names) o[n] = await perf.harvest(n);
      // 화면이 막대를 줄마다 그리려고 쓰는 숫자 칸(구독 · 쇼츠조회 · 롱폼시청 · 기준)은 옛 기대값에 없던 것이라 따로 본다
      const 옛칸 = (v: Obj) => Object.fromEntries(Object.entries(v).filter(([k]) => !["구독", "쇼츠조회", "롱폼시청", "기준"].includes(k)));
      const 옛칸들 = (m: Obj) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, 옛칸(v as Obj)]));
      같은값("채널별 수확 (구독 기록 · 분석 자료가 없으면 99% 에서 멈춘다)", 옛칸들(o), 기대.수확.각각);
      같은값("구독자를 직접 주면 그것을 쓴다", 옛칸(await perf.harvest("채널A", 5056)), 기대.수확.직접A);
      같은값("같은 channel_id 두 이름은 자료 있는 칸(롱폼 칸 먼저)의 값 하나로", 옛칸들(await perf.harvestMap(chans)), 기대.수확.묶음);
      같은값("화면용 숫자 칸: 구독 · 90일 쇼츠 참여조회 · 365일 롱폼 시청 · 지금 차수의 기준(구독자 · 쇼츠조회90 · 시청시간365)", {
        구독: o["채널A"].구독, 쇼츠조회: o["채널A"].쇼츠조회, 롱폼시청: o["채널A"].롱폼시청, 기준: o["채널A"].기준,
        자료없음: [o["채널B"].쇼츠조회, o["채널B"].롱폼시청],
      }, { 구독: 5176, 쇼츠조회: 23970, 롱폼시청: 2662.5, 기준: { 구독자: 1000, 쇼츠조회90: 10000000, 시청시간365: 4000 }, 자료없음: [null, null] });
      같나("같은 채널 두 번 세지 않기: 먼저 등록된 이름 하나", sv.mergeSameChannel(["채널D", "채널A롱", "채널A", "채널B", "모르는채널"], chans), 기대.묶기);
      같나("차례: channels.json 차례 + 모르는 이름은 뒤에 가나다순", sv.orderNames(["모르는채널Z", "채널D", "채널A롱", "모르는채널Y", "채널A"], chans), 기대.차례);
      같은값("오늘 올린 수 (원장 · 이 컴퓨터 날짜)", perf.uploadedToday(), { "채널A": 1 });
      같은값("오늘 몇 개: 고정 · 적어 둔 값 · 아직 안 읽음", Object.fromEntries(await Promise.all(names.map(async (n) => [n, await perf.dailyOf(n, chans[n])]))), 기대.daily);
    }

    await 구독자한장(chans);

    구역("화면 자료 — 채널 성적 · 48시간 · 끌어올림");
    await 화면자료(chans);

    같나("여기까지 읽기만 했다 — 유튜브 호출 0건", g.calls.length, 0);
    g.uninstall();
  });
}

async function 구독자한장(chans: Obj) {
  구역("구독자 한 장 (카드·성적표 양쪽에 같은 값)");
  const s = await perf.subscriberSnapshot(chans);
  const o: Obj = {};
  for (const [n, v] of Object.entries(s)) o[n] = { cid: v.cid, subs: v.subs, at: v.at, exact: v.exact, source: v.source, title: v.title };
  같은값("구독자 · 읽은 때 · 정확한가 · 풍선 도움말(최근 조회 실패까지)", o, 기대.snapshot);
  같나("같은 채널을 두 이름으로 등록해도 같은 값", s["채널A"].subs === s["채널A롱"].subs && s["채널A"].title === s["채널A롱"].title, true);
  같나("글: 「구독 5,056」 / 숨겼으면 「구독 비공개」", [s["채널A"].subsText, s["채널B"].subsText, s["채널C"].subsText, s["채널D"].subsText], ["구독 5,056", "구독 120", "구독 비공개", "구독 비공개"]);
  같나("증감 딱지: 어제 +44 / 기록이 하나도 없으면 딱지 없음", [s["채널A"].grow.n, s["채널A"].grow.unit, s["채널A"].grow.dir, s["채널D"].grow.chip, s["채널D"].grow.wait],
    [44, "어제", "up", false, "갱신을 누르세요"]);
  같나("밑줄 칸은 빠진다", Object.keys(s).includes("_메모"), false);
}

async function 화면자료(chans: Obj) {
  const SV = await sv.statsView(chans, { foot: { "채널A": { wait: 4, done: 9, days: 1.5 } } });
  같나("카드: 같은 채널은 한 장 · channels.json 차례", SV.cards.map((c) => c.name), ["채널A", "채널B", "채널C", "채널D"]);
  같나("머리글 · 마지막 갱신 · 대행 방식 문구", [SV.head, SV.refreshedText, SV.agency], ["채널 성적", 기대.화면.갱신글, true]);
  for (let i = 0; i < SV.cards.length; i++) {
    const c = SV.cards[i], e = 기대.화면.카드[i];
    같나(`[${c.name}] 이름표`, c.label, c.name === "채널A" ? "A표시" : c.name);
    await 같은해시(`[${c.name}] 그래프 묶음 전부(원본 data-set 과 같다)`, c.chart, e.chart해시);
    같나(`[${c.name}] 머리 숫자`, {
      pd: `오늘 목표 ${c.daily}개 중 ${c.todayUploaded}개 올림 — ${c.dailyWhy}`, 남은: String(c.remaining),
      sum: [sv.shortNum(c.nums.total), c.nums.totalIsChannel ? "채널 전체 누적 조회수" + (c.nums.videos ? ` · 영상 ${c.nums.videos}개` : "") : `최근 ${c.nums.recentCount}개 조회수`],
      avg: sv.shortNum(c.nums.avgRecent), lk: sv.shortNum(c.nums.likes), cm: sv.shortNum(c.nums.comments),
      best: c.best ? [cut(c.best.title, 34), sv.shortNum(c.best.views)] : null, geo: c.country,
      건강: c.health.등급, 급등: c.spikeBand.length ? "급등" : "",
    }, { pd: e.pd, 남은: e.남은, sum: e.sum, avg: e.avg, lk: e.lk, cm: e.cm, best: e.best, geo: e.geo, 건강: e.건강, 급등: e.급등 });
    같나(`[${c.name}] 영상 목록 두 벌 (최근 순 · 조회수 상위) — 올린 날 · 제목 · 조회 · 48시간 · 좋아요 · 댓글`, [
      c.list.recent.map((r) => [r.title, r.at, sv.shortNum(r.views), sv.shortNum(r.v48), r.likes !== null ? sv.shortNum(r.likes) : "—", r.comments !== null ? sv.shortNum(r.comments) : "—"]),
      c.list.top.map((r) => [r.title, r.at, sv.shortNum(r.views), sv.shortNum(r.v48), r.likes !== null ? sv.shortNum(r.likes) : "—", r.comments !== null ? sv.shortNum(r.comments) : "—"]),
    ], e.목록);
    같나(`[${c.name}] 정렬 상자 글`, [`최근 ${c.list.recent.length}개`, `조회수 상위 ${c.list.top.length}개 (전체)`], e.상자);
  }
  같나("바닥 줄: 폴더 쪽은 메인이 넘긴 값만 싣는다", SV.cards.map((c) => c.foot), [{ wait: 4, done: 9, days: 1.5 }, null, null, null]);
  같나("구독자 장 · 급등 띠는 카드에 실린다", [SV.cards[0].sub?.subsText, SV.cards[0].spikeBand.length, SV.cards[1].spikeBand.length], ["구독 5,056", 2, 0]);
  같은값("건강 배지 풍선 글(줄마다 [등급] 항목 — 말)", SV.cards[1].health.풍선, 기대.화면.풍선B);
  같나("JSON 으로 못 적는 값(NaN · 무한 · 날짜 객체 · 함수)이 화면 자료에 새지 않는다", 직렬화새는것(SV), []);
  {
    const 가볍게 = await sv.statsView(chans, { perVideo: false });
    같나("영상 하나만 보기 묶음(_영상)을 빼면 그 칸이 없다", 가볍게.cards.map((c) => "_영상" in c.chart), [false, false, false, false]);
    같나("나머지 그래프는 그대로", await 해시(가볍게.cards[0].chart.v28), await 해시(SV.cards[0].chart.v28));
    같나("따로 받은 영상별 묶음은 카드에 실린 것과 같다", await 해시(await sv.videoCharts("채널A")), await 해시(SV.cards[0].chart._영상));
  }

  const RV = await sv.reviewView(chans);
  같나("48시간: 한 번이라도 읽은 채널만 · 같은 채널 한 장 · 차례", RV.cards.map((c) => c.name), 기대.화면.검토.map((c: Obj) => c.name));
  for (let i = 0; i < RV.cards.length; i++) {
    const c = RV.cards[i], e = 기대.화면.검토[i];
    await 같은해시(`[${c.name}] 48시간 그래프`, c.chart.set, e.set해시);
    같나(`[${c.name}] 큰 숫자 · 누적 · 좋아요 · 댓글`, {
      큰: c.views48 === null ? "—" : sv.shortNum(c.views48), 누적: c.cumulative !== null ? sv.shortNum(c.cumulative) : "—",
      좋: sv.shortNum(c.likes), 댓: sv.shortNum(c.comments), 누적표: c.likesKind === "cumulative",
    }, { 큰: e.큰, 누적: e.누적, 좋: e.좋, 댓: e.댓, 누적표: e.누적표 });
  }
  같나("48시간 합계", sv.shortNum(RV.total48), 기대.화면.검토합계);
  같나("48시간 자료도 JSON 으로 적을 수 있는 값만", 직렬화새는것(RV), []);

  const LV = await sv.liftView(chans);
  같나("끌어올림: 이름마다 따로(원본도 합치지 않는다)", LV.cards.map((c) => c.label), 기대.화면.끌어.map((c: Obj) => c.head));
  for (let i = 0; i < LV.cards.length; i++) {
    const c = LV.cards[i], e = 기대.화면.끌어[i];
    같나(`[${c.name}] 사건 · 막대 길이 · 배수 글 · 외 N개`, {
      n: c.말,
      events: c.events.map((ev) => ({
        d: [ev.날, `그날 합계 +${commaInt(ev.합계)} · 평소 +${commaInt(ev.평소합)}`],
        rows: [["pull", cut(ev.끈것.제목, 34), String(ev.끈것.폭), commaInt(ev.끈것.증가), ev.끈것.배수글],
          ...ev.딸린것.map((x) => ["ride", cut(x.제목, 34), String(x.폭), commaInt(x.증가), x.배수글])],
        more: ev.더 ? String(ev.더) : "",
      })),
    }, { n: e.n, events: e.events });
  }

  같나("끌어올림 자료도 JSON 으로 적을 수 있는 값만", 직렬화새는것(LV), []);
  const Q = SV.quota;
  await quota.spend("videos.list", "", 8500);
  await quota.spend("videos.insert", "", 3);
  const Q2 = (await sv.statsView(chans, { perVideo: false })).quota;
  같나("할당량 칸: 쓴 만큼 · 퍼센트(100 으로 막음) · 80% 넘으면 빠듯", [Q2.유닛, Q2.유닛한도, Q2.유닛남음, Q2.유닛퍼센트, Q2.업로드, Q2.업로드남음, Q2.빠듯, Q.빠듯], [8500, 10000, 1500, 85, 3, 97, true, false]);
}

/* ──────────────── 끌어올림 기록하기 ──────────────── */

async function 끌어올림기록() {
  구역("영상별 조회수 적기 (영상기록 · 잦은기록)");
  await 모래상자(async () => {
    await lift.record("채널Z", [{ title: "  영상 가  ", views: 100 }, { title: "영상 나", views: 50 }, { title: "", views: 9 }, { title: "   ", views: 9 }]);
    await lift.record("채널Z", [{ title: "영상 가", views: 130 }]); // 같은 날 다시 → 덮어쓴다
    const 일기: Obj = JSON.parse(await Deno.readTextFile(dataPath("영상기록.json")));
    같나("제목 앞뒤 공백을 걷고 · 빈 제목은 건너뛰고 · 같은 날은 마지막 값으로", 일기, { "채널Z": { "영상 가": { [하루(0)]: 130 }, "영상 나": { [하루(0)]: 50 } } });
    // 오래된 점은 버린다(120일), 점이 다 사라진 영상은 칸째 뺀다
    await writeJson(dataPath("영상기록.json"), { "채널Z": { "오래된 영상": { [하루(121)]: 10, [하루(130)]: 5 }, "반쯤": { [하루(121)]: 1, [하루(119)]: 2 } } });
    await lift.record("채널Z", [{ title: "새 영상", views: 7 }]);
    같나("120일보다 오래된 점은 버리고 점이 다 사라진 영상은 뺀다", JSON.parse(await Deno.readTextFile(dataPath("영상기록.json"))),
      { "채널Z": { "반쯤": { [하루(119)]: 2 }, "새 영상": { [하루(0)]: 7 } } });

    await lift.recordFrequent("채널Z", [{ title: "영상 가", views: 130, likes: 4, comments: null }, { title: "영상 나", views: 50 }]);
    const 잦음: Obj = JSON.parse(await Deno.readTextFile(dataPath("잦은기록.json")));
    같나("시각(시 단위)마다 한 점 · 좋아요·댓글은 모르면 null", 잦음, { "채널Z": { "영상 가": { [시각키(0)]: { v: 130, l: 4, c: null } }, "영상 나": { [시각키(0)]: { v: 50, l: null, c: null } } } });
    await writeJson(dataPath("잦은기록.json"), { "채널Z": { "옛": { [시각키(6 * 24)]: 5 }, "가끔": { [시각키(6 * 24)]: 5, [시각키(24)]: { v: 9, l: 1, c: 1 } } } });
    await lift.recordFrequent("채널Z", [{ title: "새", views: 1 }]);
    같나("5일(120시간)보다 오래된 점은 버린다", Object.keys(JSON.parse(await Deno.readTextFile(dataPath("잦은기록.json")))["채널Z"]).sort(), ["가끔", "새"]);

    // 제목은 유튜브에서 오는 글이다 — 「__proto__」 「constructor」 같은 이름이어도 전역 객체를 건드리면 안 된다
    await lift.record("채널P", [{ title: "__proto__", views: 5 }, { title: "constructor", views: 7 }, { title: "toString", views: 9 }]);
    await lift.recordFrequent("채널P", [{ title: "__proto__", views: 5 }, { title: "constructor", views: 7 }]);
    같나("제목이 __proto__ 여도 전역 객체가 오염되지 않는다", [({} as Obj)[하루(0)], ({} as Obj)[시각키(0)], (Object as unknown as Obj)[하루(0)], (Object as unknown as Obj)[시각키(0)]], [undefined, undefined, undefined, undefined]);
    const 읽음: Obj = JSON.parse(await Deno.readTextFile(dataPath("영상기록.json")));
    같나("constructor · toString 같은 이름의 영상도 제 칸에 남는다", [읽음["채널P"]["constructor"], 읽음["채널P"]["toString"]], [{ [하루(0)]: 7 }, { [하루(0)]: 9 }]);
  });
}

/* ──────────────── 스튜디오 지표 받기 ──────────────── */

async function 스튜디오지표() {
  구역("스튜디오 지표 받기 (YouTube Analytics · 별도 통)");
  await 모래상자(async () => {
    const g = new 가짜구글();
    g.addChannel({ id: CID.A, title: "채널A" }, "RT_A");
    g.addChannel({ id: CID.B, title: "채널B" }, "RT_B");
    const 일 = [5, 4, 3, 2, 1].map((k) => [하루(k), 100 + k, 200 + k, 3, 1, 9, 2, 1]);
    const 나라 = [["KR", 90], ["US", 7], ["JP", 3]];
    const 종류 = [[하루(2), "shorts", 80, 160, 60], [하루(2), "long", 20, 400, 10], [하루(1), "shorts", 70, 150, 55]];
    손보기(g, (url, res) => {
      if (url.pathname !== "/v2/reports" || !res.ok) return res; // 주입한 오류는 그대로 둔다
      const d = url.searchParams.get("dimensions");
      return 제이슨응답({ columnHeaders: [], rows: d === "day" ? 일 : d === "country" ? 나라 : 종류 });
    });
    await 토큰심기({ "채널A": { cid: CID.A, refresh: "RT_A" }, "채널B": { cid: CID.B, refresh: "RT_B" } });

    const n = await analytics.fetchChannel("채널A", 365);
    같나("받은 날 수", n, 5);
    const 호출 = g.calls.filter((c) => c.name === "analytics.query").map((c) => c.query);
    같은값("요청 세 번: 일별 · 나라별(지난 28일) · 쇼츠/롱폼 구분 — 날짜 · 지표 · 정렬이 원본과 같다", 호출, 기대.분석받기.호출);
    const 저장 = JSON.parse(await Deno.readTextFile(dataPath("분석기록.json")));
    await 같은해시("분석기록.json 에 남은 것", 저장["채널A"], 기대.분석받기.파일해시);
    같나("저장 꼴: 받은때(벽시계) · 열 · rows · 나라28 · 종류", Object.keys(저장["채널A"]).sort(), ["rows", "나라28", "받은때", "열", "종류"].sort());
    같나("나라28 은 합과 상위 5", 저장["채널A"].나라28, { 합: 100, 상위: [["KR", 90], ["US", 7], ["JP", 3]] });
    같나("quota: 별도 통에서 나간다 — 메인 지갑 0 · analytics.query 3", [quota.today().유닛, quota.today().내역["analytics.query"]], [0, 3]);

    // 한 채널이 터져도 나머지는 계속 간다
    g.failNext(/youtubeanalytics/, 403, { error: { message: "분석 권한 없음", errors: [{ reason: "forbidden" }] } }, 1);
    const 여럿 = await analytics.fetchAll(["채널A", "채널B"], true);
    같나("모두 받기: 첫 채널은 실패(null) · 다음은 받는다", [여럿["채널A"], 여럿["채널B"]], [null, 5]);
    같나("등록 안 된 채널은 던진다(모두 받기 안에서는 null)", (await analytics.fetchAll(["없는채널"], true))["없는채널"], null);
    await 던지나("한 채널만 받을 때는 그대로 던진다", () => analytics.fetchChannel("없는채널"), /등록되지 않은 채널/);

    // 사람이 「갱신」 을 눌렀을 때의 30분 간격 (파이썬 serve._분석갱신)
    analytics.resetThrottle();
    g.clearCalls();
    const a1 = await analytics.refreshThrottled(["채널A", "채널B"], 1000);
    const 호출1 = g.calls.filter((c) => c.name === "analytics.query").length;
    const a2 = await analytics.refreshThrottled(["채널A", "채널B"], 1000 + 1799);
    const 호출2 = g.calls.filter((c) => c.name === "analytics.query").length;
    const a3 = await analytics.refreshThrottled(["채널A", "채널B"], 1000 + 1800);
    const 호출3 = g.calls.filter((c) => c.name === "analytics.query").length;
    같나("30분 안 재호출은 부르지 않고 「최근에 받음」 · 30분이 지나면 다시 받는다", [a1.최근, a1.받음, 호출1, a2.최근, a2.받음, 호출2, a3.최근, 호출3], [false, ["채널A", "채널B"], 6, true, ["채널A", "채널B"], 6, false, 12]);
    g.uninstall();
  });
}

/* ──────────────── 구독 갱신 (원본 tests/test_subscriber_refresh.py · test_manual_subscriber_refresh.py 와 같은 기대값) ──────────────── */

async function 구독갱신_원본시험() {
  구역("구독자 갱신 — 원본 시험의 기대값 그대로");
  const 채널들 = { long: { channel_id: "one" }, short: { channel_id: "one" }, other: { channel_id: "two" }, _settings: {} } as unknown as Channels;
  /** 원본 setUp 과 같은 처음 상태: 채널 one 의 프로필(로컬 그림 · 아이디 · 옛 구독자 5930) + 가짜 서버(one 8320명, two 0명) */
  const 준비 = async (o: { oneSubs?: number | null; twoSubs?: number | null } = {}) => {
    const g = new 가짜구글();
    g.addChannel({ id: "one", title: "원", handle: "@example", subs: o.oneSubs === undefined ? 8320 : o.oneSubs, views: 25, videos: 2 }, "RT_ONE");
    g.addChannel({ id: "two", title: "둘", subs: o.twoSubs === undefined ? 0 : o.twoSubs, views: 0, videos: 0 }, "RT_TWO");
    g.install();
    await 토큰심기({ tok: { cid: "one", refresh: "RT_ONE" } });
    await saveProfiles({ one: { channel_id: "one", subscribers: 5930, handle: "@example", art: { avatar: "local.jpg" }, statistics_at: 10 } });
    return g;
  };
  const 채널호출 = (g: 가짜구글) => g.calls.filter((c) => c.name === "channels.list");

  await 모래상자(async () => {
    const g = await 준비();
    const r = await refreshStatistics(채널들, { now: 100 });
    같나("한 번에 물어본다: 같은 채널을 두 번 세지 않고 id=one,two · 부품 statistics", [채널호출(g).length, 채널호출(g)[0].query.id, 채널호출(g)[0].query.part], [1, "one,two", "statistics"]);
    같나("오류 없음", r.errors, {});
    const p = await loadProfiles();
    같나("구독자 8320 · 로컬 그림 · 아이디는 그대로 · 둘째 채널 0명", [p.one.subscribers, p.one.art, p.one.handle, p.two.subscribers], [8320, { avatar: "local.jpg" }, "@example", 0]);
    const 기록 = await subs.loadSubs();
    같나("두 이름(long · short)에 같은 점이 남는다", 기록.long, 기록.short);
    같나("밑줄 칸(_settings)은 기록하지 않는다", Object.keys(기록).sort(), ["long", "other", "short"]);
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비();
    for (const now of [100, 101, 120, 159]) await refreshStatistics(채널들, { now });
    같나("탭이 여럿이어도 1분 안에는 한 번만 물어본다", 채널호출(g).length, 1);
    await refreshStatistics(채널들, { now: 160 });
    같나("1분이 지나면 다시", 채널호출(g).length, 2);
    await refreshStatistics(채널들, { now: 161, force: true });
    같나("사람이 새로고침을 누르면(force) 1분 안이어도 새로 읽는다", 채널호출(g).length, 3);
    같나("시계가 거꾸로 가면 기다리지 않고 다시 읽는다", [await statisticsDue(100), await statisticsDue(161.5), await statisticsDue(221)], [true, false, true]);
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비();
    g.failNext(/youtube\/v3\/channels/, 500, { error: { message: "unavailable" } });
    const 상태 = await refreshStatistics(채널들, { now: 100 });
    await refreshStatistics(채널들, { now: 110 });
    const p = await loadProfiles();
    같나("실패하면 값 · 읽은 때를 지키고 재시도는 1분 간격으로 늦춘다", [상태.errors.request !== undefined, p.one.subscribers, p.one.statistics_at, 채널호출(g).length], [true, 5930, 10, 1]);
    같나("실패한 날은 구독 기록 파일도 만들지 않는다", await Deno.stat(subs.subsPath()).then(() => true, () => false), false);
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비({ oneSubs: null, twoSubs: null });
    await refreshStatistics(채널들, { now: 100 });
    const p = await loadProfiles();
    같나("구독자를 숨기면 0 을 지어내지 않는다 (null)", [p.one.subscribers, p.two.subscribers], [null, null]);
    같나("숨긴 날은 구독 기록에도 안 남는다", await Deno.stat(subs.subsPath()).then(() => true, () => false), false);
    같나("총계 꼴 둘 모두 null: 숨김 표시 · subscriberCount 없음", [apiStatistics({ subscriberCount: "8320", hiddenSubscriberCount: true }, 1).subscribers, apiStatistics({ viewCount: "1" }, 1).subscribers], [null, null]);
    같나("1000명 미만은 1명 단위로 정확 · 이상은 아님", [apiStatistics({ subscriberCount: "999" }, 1).subscribers_exact, apiStatistics({ subscriberCount: "1000" }, 1).subscribers_exact], [true, false]);
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비();
    손보기(g, async (url, res) => { // 응답에서 채널 one 을 뺀다
      if (url.pathname !== "/youtube/v3/channels" || !url.searchParams.get("id")) return res;
      const j = await res.json();
      return 제이슨응답({ ...j, items: (j.items ?? []).filter((x: Obj) => x.id !== "one") });
    });
    const 상태 = await refreshStatistics(채널들, { now: 100 });
    같나("응답에서 빠진 채널은 기존 값을 지키고 오류를 알린다", [Object.keys(상태.errors), (await loadProfiles()).one.subscribers], [["one"], 5930]);
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비();
    await Promise.all(범위(8).map(() => refreshStatistics(채널들, { now: 100 })));
    같나("동시에 여덟 곳에서 물어도 요청은 한 번", 채널호출(g).length, 1);
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비();
    await refreshStatistics(채널들, { now: 100 });
    const 이름들 = await perf.subscriberSnapshot(채널들);
    같나("스냅샷: 카드·성적표 양쪽에 8320 · 같은 채널 두 이름은 같은 값 · 둘째 채널은 0 · 밑줄 칸 없음",
      [이름들.long.subsText, 이름들.long.subs, 이름들.long.title === 이름들.short.title && 이름들.long.subs === 이름들.short.subs, 이름들.other.subsText, "_settings" in 이름들], ["구독 8,320", 8320, true, "구독 0", false]);
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비();
    await saveProfiles({ one: { channel_id: "one", subscribers: 61700, handle: "@example" } });
    const s = await perf.subscriberSnapshot({ long: { channel_id: "one" } } as unknown as Channels);
    같나("큰 구독자 수도 API 정밀도 그대로 61,700", s.long.subsText, "구독 61,700");
    g.uninstall();
  });

  await 모래상자(async () => {
    const g = await 준비();
    // 원본 test_daily_collection_also_updates_display_store_and_aliases: 하루 한 번 찍기가 표시용 저장소와 두 이름 모두를 갱신한다
    const 쇼츠롱 = { long: { channel_id: "one" }, short: { channel_id: "one" } };
    await writeJson(dataPath("channels.json"), 쇼츠롱);
    같나("오늘 찍기: 같은 채널은 한 번만 물어 1개 채널을 찍었다고 센다", await subs.snapToday(true), 1);
    const p = await loadProfiles();
    const 기록 = await subs.loadSubs();
    같나("프로필 8320 · 두 이름(long · short)의 점이 같다", [p.one.subscribers, 기록.long, 기록.short], [8320, 기록.short, 기록.short]);
    같나("점의 내용: 구독 · 조회 · 영상 수 · 정확한가 · 출처", 기록.long[하루(0)], { subs: 8320, views: 25, videos: 2, exact: false, source: "youtube_data_api" });
    g.uninstall();
  });

  await 모래상자(async () => {
    // 원본 test_manual_data_read_does_not_downgrade_studio_precision: 공개 근삿값이 주인의 정확값을 낮추거나 읽은 때를 새것인 척 못 한다
    await remember({ channel_id: "one", subscribers: 8321, subscribers_exact: true, subscribers_source: "youtube_studio_dashboard", subscribers_at: 100 });
    const p = await remember({ channel_id: "one", ...apiStatistics({ subscriberCount: "8320" }, 160) });
    같나("정확값 8321 을 지키고 읽은 때(100)도 지킨다 · 공개 값은 따로 8320", [p.subscribers, p.subscribers_at, p.subscribers_api], [8321, 100, 8320]);
    // 같은 정확도로 새로 읽은 값은 새것으로 바뀐다
    const q2 = await remember({ channel_id: "one", subscribers: 8400, subscribers_exact: true, subscribers_source: "youtube_studio_dashboard", subscribers_at: 200 });
    같나("정확값끼리는 새 값이 이긴다", [q2.subscribers, q2.subscribers_at], [8400, 200]);
  });

  await 모래상자(async () => {
    // 원본 test_studio_failure_without_prior_precise_count_is_explicit — 이 앱은 스튜디오 화면을 읽는 장치가 없다.
    // 그래서 1,000명 이상의 정확값은 늘 「확인 대기」 이고, 그 까닭이 풍선 도움말에 적힌다(원본은 스튜디오 오류 글, 여기는 고정 문구).
    const g = await 준비();
    await refreshStatistics(채널들, { now: 100 });
    const s = (await perf.subscriberSnapshot(채널들)).long;
    같나("정확하지 않다고 밝힌다", [s.exact, s.title.includes("정확값 확인 대기"), s.title.includes("최근 조회 실패: 정확한 구독자 수는 스튜디오 화면에서만 읽힙니다")], [false, true, true]);
    g.uninstall();
  });

  await 모래상자(async () => {
    // 원본 test_rendering_screen_does_not_refresh_statistics: 화면을 그리는 것만으로는 구독 총계를 새로 읽지 않는다
    const g = await 준비();
    await 심기();
    await writeJson(dataPath("channels.json"), 채널들);
    await sv.statsView(채널들);
    await sv.reviewView(채널들);
    await sv.liftView(채널들);
    await perf.subscriberSnapshot(채널들);
    같나("화면 자료를 만들어도 유튜브 호출 0건", g.calls.length, 0);
    g.uninstall();
  });
}

/* ──────────────── 오늘 찍기 · 영상 찍기 ──────────────── */

async function 구독찍기() {
  구역("하루 기록 자동 찍기 (오늘찍기 · 영상찍기)");
  await 모래상자(async () => {
    const w = 세계();
    const g = new 가짜구글();
    세계세우기(g, w);
    g.install();
    await 토큰심기({ "채널A": { cid: CID.A, refresh: "RT_A" }, "채널B": { cid: CID.B, refresh: "RT_B" } });
    await writeJson(dataPath("channels.json"), {
      "_메모": {}, "채널A": { channel_id: CID.A, folder: "" }, "채널A롱": { channel_id: CID.A, folder: "" },
      "채널B": { channel_id: CID.B, folder: "" }, "채널D": { channel_id: CID.D, folder: "" },
    });
    await writeJson(dataPath("구독기록.json"), { "채널B": { [하루(0)]: { subs: 1, views: 2, videos: 3 } } }); // 채널B 는 오늘 점이 이미 있다
    const n1 = await subs.snapToday(true);
    const n2 = await subs.snapVideos(true);
    const n3 = await subs.snapVideos(true);
    같나("오늘 찍기 1개(A 한 번에 두 이름 · B 는 이미 있음 · D 는 인증 전이라 실패) · 영상 찍기 3개 · 2시간 안이라 또 찍지 않는다", [n1, n2, n3], 기대.찍기.반환);
    const 읽기 = async (이름: string) => JSON.parse(await Deno.readTextFile(이름.startsWith("기록/") ? recordPath(이름.slice(3)) : dataPath(이름)));
    for (const f of ["구독기록.json", "영상기록.json", "잦은기록.json", "profiles.json"]) {
      const 실제 = await 읽기(f);
      if (f === "구독기록.json") {
        // 실패한 채널D 는 「오늘 해봤다」 표식(못함)을 남긴다 — 하루 종일 같은 채널을 되풀이해 부르지 않으려고
        같나("실패 표식: 채널D 오늘 칸에 못함 글이 남는다", Object.keys(실제["채널D"][하루(0)]).sort(), ["못함", "subs", "videos", "views"].sort());
        같나("실패 표식의 점 값은 모두 null", [실제["채널D"][하루(0)].subs, 실제["채널D"][하루(0)].views, 실제["채널D"][하루(0)].videos], [null, null, null]);
      }
      await 같은해시(`${f} 에 남은 것(원본과 같다)`, 실제, 기대.찍기.해시[f]);
    }
    같나("영상 찍은 때 표식은 기록/영상찍은때.txt 에 초 단위 숫자로 남는다 (파이썬도 같은 파일을 float 으로 읽는다)", Number((await Deno.readTextFile(recordPath("영상찍은때.txt"))).trim()), 고정ms / 1000);
    같나("채널 목록 읽기 몫: 영상 찍기 한 번 = 채널당 1(목록) + 전체 1(일괄 통계) 안팎", g.calls.filter((c) => c.name === "playlistItems.list").length, 2);
    g.uninstall();
  });
}

/* ──────────────── 갱신 전체 흐름 (지표 갱신 단추가 하는 일) ──────────────── */

async function 갱신전체흐름() {
  구역("지표 갱신 전체 흐름 (perfFetch) — 원본 perf_fetch 와 저장 파일이 같다");
  await 모래상자(async () => {
    const g = new 가짜구글();
    세계세우기(g);
    g.install();
    const 입력 = 기대.갱신.입력;
    await Deno.mkdir(recordPath(), { recursive: true });
    await writeJson(dataPath("channels.json"), 입력["channels.json"]);
    await writeJson(dataPath("성적.json"), 입력["성적.json"]);
    await writeJson(dataPath("policy.json"), 입력["policy.json"]);
    await 원장쓰기(입력.ledger);
    await 토큰심기({ "채널A": { cid: CID.A, refresh: "RT_A" }, "채널B": { cid: CID.B, refresh: "RT_B" } });

    const 이름들 = ["채널A", "채널A롱", "채널B"];
    const 결과값 = await perf.perfFetch(이름들);
    const 읽기 = async (f: string) => JSON.parse(await Deno.readTextFile(dataPath(f)));
    for (const f of ["성적.json", "구독기록.json", "영상기록.json", "profiles.json", "분석기록.json"]) {
      await 같은해시(`${f} (원본이 만든 것과 같다)`, await 읽기(f), 기대.갱신.해시[f]);
    }
    같나("돌려주는 값은 저장된 성적과 같다", 결과값, await 읽기("성적.json"));

    const 성적 = await 읽기("성적.json");
    같나("하루 편수: 쇼츠 고정 3 · 나머지는 방금 받아 온 줄로 계산(유닛 0) — 근거 글", [성적["채널A"].daily, 성적["채널B"].daily, 성적["채널A롱"].daily],
      [[1, "최근 3개 [2,275 · 3,978 · 858] 최고 3,978회 → 하루 1개"], [3, "고정 3개"], [1, "최근 3개 [2,275 · 3,978 · 858] 최고 3,978회 → 하루 1개"]]);
    같나("영상 수: 최근 30편 / 전 영상 35편 / 상위 30편", [성적["채널A"].rows.length, 성적["채널A"].전체조회.length, 성적["채널A"].톱30.length, 성적["채널A"].전체편수], [30, 35, 30, 35]);
    같나("조회수 상위 30 은 채널 전 영상에서 고른다(최근 30 재정렬이 아니다)", 성적["채널A"].톱30[0].views >= 성적["채널A"].톱30[29].views, true);
    같나("저작권 흔적: 지역 차단 영상 · 사라진 영상(원장에 있는데 유튜브에 없음)", [성적["채널B"].차단, 성적["채널B"].실종, 성적["채널A"].차단, 성적["채널A"].실종], [{ vB02: 2 }, ["사라진 편"], {}, []]);
    같나("배운 것: 20시간 안에 배운 채널A 는 그대로 · 처음인 별칭은 새로 · 영상이 모자란 채널B 는 못 배움",
      [성적["채널A"].insight._at, 성적["채널A롱"].insight.learned, 성적["채널A롱"].insight.n, 성적["채널B"].insight.learned, 성적["채널B"].insight.why],
      [NOW_EPOCH - 3600, true, 32, false, "7일 지난 영상이 2편뿐입니다 (최소 8편 필요)"]);
    const 학습 = 성적["채널A롱"].insight;
    같나("배운 것 내용: 가장 잘 되는 길이 · 시간대 · 업로드 간격", [학습.best_dur, 학습.best_hour, 학습.median_views, Object.keys(학습.dur_tbl).sort()], [[15, 30], [22, 6], 1014, ["(15, 30)", "(30, 45)", "(45, 60)", "(60, 90)"]]);
    같나("배운 것을 글로", describe(학습), 기대.갱신.배움글);
    같나("갱신 시각(초)", 성적["채널A"]._at, NOW_EPOCH);
    const 구독 = await 읽기("구독기록.json");
    같나("구독 기록: 세 이름 모두 오늘 한 점", [Object.keys(구독).sort(), 구독["채널B"][하루(0)]], [["채널A", "채널A롱", "채널B"], { subs: 120, views: 40000, videos: 12 }]);
    같나("영상 기록: 이름마다 영상별 오늘 조회수", [Object.keys((await 읽기("영상기록.json"))["채널A"]).length, (await 읽기("영상기록.json"))["채널B"]["B영상0"][하루(0)]], [30, 900]);

    // 호출 수: 원본은 별칭이 같은 목록·같은 영상을 한 번 더 읽었다 — 새 앱은 한 번만 읽는다(결과는 같다)
    const 호출 = (이름: string) => g.calls.filter((c) => c.name === 이름).length;
    같나("호출: 목록 4(채널 2 + 배우기 2) · 일괄 통계 5 · 낱개 7 · 채널 3 — 메인 지갑 14유닛 · 별도 통(일괄 통계 5 + 분석 6)",
      [호출("playlistItems.list"), 호출("videos.batchGetStats"), 호출("videos.list"), 호출("channels.list"), quota.today().유닛, quota.오늘별도통()], [4, 5, 7, 3, 14, 11]);

    // 두 번째 갱신: 배운 것을 어제 것으로 쓰니 채널당 3유닛 (원본 주석: 채널당 목록 1 + 통계 1 + 구독자 1)
    g.clearCalls();
    const 앞유닛 = quota.today().유닛;
    await perf.perfFetch(["채널A", "채널B"]);
    // 채널당 목록 1 + 구독자 1 + 저작권 1 = 3 (원본 주석). 이 세계에는 비공개 영상이 채널마다 하나씩 있어 일괄 통계가 못 주는 것을 낱개로 다시 묻는 몫이 채널당 1 더 붙는다.
    같나("두 번째 갱신: 배운 것은 그대로 쓴다 — 채널당 3유닛 + 비공개 낱개 1", quota.today().유닛 - 앞유닛, 2 * (3 + 1));
    const 둘째 = await 읽기("성적.json");
    같나("두 번째 갱신에서도 배운 것의 시각은 그대로", 둘째["채널B"].insight._at, 성적["채널B"].insight._at);

    // 「전체 갱신」 을 두 번 눌러도 유튜브에 두 번 묻지 않는다(같은 이름 묶음이 돌고 있으면 그 일에 합류)
    g.clearCalls();
    const 일1 = perf.perfFetch(["채널A"]);
    const 일2 = perf.perfFetch(["채널A"]);
    await Promise.all([일1, 일2]);
    같나("같은 이름 묶음을 동시에 두 번 시켜도 한 번만 읽는다", [일1 === 일2, g.calls.filter((c) => c.name === "playlistItems.list").length, g.calls.filter((c) => c.name === "channels.list").length], [true, 1, 1]);
    await perf.perfFetch(["채널A"]);
    같나("끝난 뒤에 다시 누르면 새로 읽는다", g.calls.filter((c) => c.name === "channels.list").length, 2);
    g.uninstall();
  });
}

/* ──────────────── 호출 수 · 놀 때 0건 ──────────────── */

async function 호출수() {
  구역("호출 수 — 놀 때는 0건, 갱신 한 번은 채널당 3유닛");
  await 모래상자(async () => {
    // 채널 셋, 영상 다섯씩 모두 공개 — 원본 주석의 「채널당 대략 3유닛」 을 그대로 잰다
    const g = new 가짜구글();
    const 셋 = ["X", "Y", "Z"].map((x, i) => ({ id: "UC" + x.repeat(22), 이름: "채널" + x, 새로고침: "RT_" + x, i }));
    for (const c of 셋) {
      g.addChannel({ id: c.id, title: c.이름, subs: 100 * (c.i + 1), views: 1000, videos: 5 }, c.새로고침);
      for (let k = 0; k < 5; k++) {
        g.addVideo({ id: `v${c.이름.slice(-1)}${k}`, channelId: c.id, snippet: { title: `${c.이름} 영상${k}`, publishedAt: new 진짜Date(고정ms - (k + 1) * 86400000 * 3).toISOString() },
          statistics: { viewCount: String(100 * (k + 1)), likeCount: "1", commentCount: "0" } });
      }
    }
    g.install();
    await 토큰심기(Object.fromEntries(셋.map((c) => [c.이름, { cid: c.id, refresh: c.새로고침 }])));
    await writeJson(dataPath("channels.json"), Object.fromEntries(셋.map((c) => [c.이름, { channel_id: c.id, folder: "" }])));
    await Deno.mkdir(recordPath(), { recursive: true });

    const 이름들 = 셋.map((c) => c.이름);
    await perf.perfFetch(이름들);
    같나("첫 갱신(배우기 포함): 채널당 목록 1 · 구독자 1 · 저작권 1 · 배우기 목록 1 = 4유닛", quota.today().유닛, 12);
    같나("별도 통: 일괄 통계 (전 채널 한 번 + 배우기 채널마다 한 번)", quota.today().내역["videos.batchGetStats"], 4);
    const 앞 = quota.today().유닛;
    await perf.perfFetch(이름들);
    같나("다음 갱신: 배운 것을 하루 동안 그대로 써서 채널당 3유닛 (10채널이면 30)", quota.today().유닛 - 앞, 9);

    // 놀 때: 저장된 값만 읽는다
    g.clearCalls();
    const chans = loadChannels();
    await perf.perfFor(chans); await perf.perfLoad(); await perf.hasPerf("채널X"); await perf.dailyCached("채널X"); await perf.insightCached("채널X");
    await perf.dailyOf("채널X", chans["채널X"]); await perf.harvest("채널X"); await perf.harvestMap(chans); await perf.growSummary("채널X"); await perf.spikeOf("채널X");
    await perf.subscriberSnapshot(chans); perf.uploadedToday();
    await sv.statsView(chans); await sv.reviewView(chans); await sv.liftView(chans); await sv.videoCharts("채널X");
    await evaluate("채널X"); await judge("채널X"); await lift.summary("채널X"); await lift.allSummary(이름들);
    await analytics.periodSummary("채널X", 28); await analytics.countrySummary("채널X"); await subs.summary("채널X"); await subs.flow("채널X");
    published.fromLedger();
    같나("화면을 열 때·놀 때 유튜브 호출 0건", g.calls.length, 0);

    // 같은 영상을 두 번 묻지 않는다: 별칭이 같은 채널이면 목록은 한 번
    g.clearCalls();
    await writeJson(dataPath("channels.json"), { "채널X": { channel_id: 셋[0].id, folder: "" }, "채널X롱": { channel_id: 셋[0].id, folder: "" } });
    const 지표 = await multiChannelMetrics(["채널X", "채널X롱"], null);
    같나("같은 채널 두 이름: 목록 1번 · 일괄 통계 1번 · 두 이름이 같은 줄을 받는다",
      [g.calls.filter((c) => c.name === "playlistItems.list").length, g.calls.filter((c) => c.name === "videos.batchGetStats").length, 지표["채널X"].length, 지표["채널X"].map((r) => r.id).join() === 지표["채널X롱"].map((r) => r.id).join()],
      [1, 1, 5, true]);
    g.uninstall();
  });

  구역("읽기 도구 하나하나 (가짜 서버)");
  await 모래상자(async () => {
    const g = new 가짜구글();
    g.addChannel({ id: CID.A, title: "채널A", subs: 10, views: 10, videos: 3 }, "RT_A");
    g.addVideo({ id: "p1", channelId: CID.A, snippet: { title: "공개", publishedAt: new 진짜Date(고정ms - 5 * 86400000).toISOString() }, statistics: { viewCount: "500", likeCount: "7", commentCount: "2" } });
    g.addVideo({ id: "p2", channelId: CID.A, snippet: { title: "비공개", publishedAt: new 진짜Date(고정ms - 4 * 86400000).toISOString() }, status: { privacyStatus: "private" },
      statistics: { viewCount: "50", likeCount: undefined, commentCount: undefined } }); // 좋아요·댓글을 숨긴 영상
    g.addVideo({ id: "p3", channelId: CID.A, snippet: { title: "방금", publishedAt: new 진짜Date(고정ms - 3600000).toISOString() }, statistics: { viewCount: "5" } });
    g.install();
    await 토큰심기({ "채널A": { cid: CID.A, refresh: "RT_A" } });
    await writeJson(dataPath("channels.json"), { "채널A": { channel_id: CID.A, folder: "" } });

    같나("업로드 재생목록 id 는 채널ID 에서 계산한다(0유닛)", [await uploadsPlaylist("채널A"), g.calls.length], ["UU" + "A".repeat(22), 0]);
    const 통계 = await statsOnce(["p1", "p2", "p3", "없음"], "채널A");
    같나("일괄 통계는 공개만 주고 빠진 것(비공개)은 주인 자격으로 낱개로 다시 묻는다 · 없는 영상은 끝내 없다",
      [Object.keys(통계).sort(), 통계["p1"].views, 통계["p1"].likes, 통계["p2"].likes, 통계["p2"].comments], [["p1", "p2", "p3"], 500, 7, null, null]);
    g.clearCalls();
    await statsOnce(["p1", "p2"], "채널A", false);
    같나("대비책을 끄면 비공개를 다시 묻지 않는다(여러 채널을 묶어 부를 때)", g.calls.filter((c) => c.name === "videos.list").length, 0);

    const 성숙 = await recentShorts("채널A");
    같나("편수 판단용: 올린 지 48시간이 지난 것만 · 최근 것부터", 성숙.map((v) => [v.id, v.views]), [["p2", 50], ["p1", 500]]);
    const 최근 = await recentPerformance("채널A");
    같나("성과를 눈으로 보려는 것: 방금 올린 것도 올린 순서 그대로(최근이 앞)", 최근.map((r) => r.id), ["p3", "p2", "p1"]);
    같나("좋아요를 숨긴 영상은 null · 좋아요율(%)과 하루 평균", [최근[1].likes, 최근[1].comments, 최근[2].likes, fixed(최근[2].like_rate ?? 0, 1), 최근[2].views_per_day > 0], [null, null, 7, "1.4", true]);
    g.uninstall();
  });
}

/* ──────────────── 올린 영상 ──────────────── */

async function 올린영상() {
  구역("올린 영상 자료 (원장 + 지금 지표)");
  await 모래상자(async () => {
    const g = new 가짜구글();
    세계세우기(g);
    g.install();
    await 토큰심기({ "채널A": { cid: CID.A, refresh: "RT_A" }, "채널B": { cid: CID.B, refresh: "RT_B" } });
    const 기본 = 자료();
    await 심기(기본);
    같나("원장에서: 채널별 · 최근 것이 앞", published.fromLedger(), 기대.올린.기본원장);

    const 덧: Record<string, string>[] = 기대.올린.덧붙임;
    await 원장쓰기([...기본.원장, ...덧]);
    같나("영상 파일 이름이 있는 줄도 같이", published.fromLedger(), 기대.올린.원장);
    const 정리 = (m: Obj) => Object.fromEntries(Object.entries(m).map(([k, v]) => {
      const { published_at: _a, ...나머지 } = v as Obj;
      return [k, { ...나머지, per_day: Math.round((나머지.per_day ?? 0) * 1e6) / 1e6 }];
    }));
    const 기대정리 = (m: Obj) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...(v as Obj), per_day: Math.round(((v as Obj).per_day ?? 0) * 1e6) / 1e6, published: String((v as Obj).published).replace("+09:00", "") }]));
    같나("지금 지표: 조회 · 좋아요 · 댓글 · 올린 때(한국 시각) · 하루 평균 · 공개 여부 · 제목(유튜브 것) · 썸네일 — 인증 안 된 영상은 빠진다",
      정리(await published.liveStats("채널B", ["vB00", "vB01", "vB02", "vB77"])), 기대정리(기대.올린.live));
    같나("영상이 하나도 없으면 빈 값", await published.liveStats("채널B", []), {});
    같나("인증 전 채널은 지표만 못 읽을 뿐 던지지 않는다", await published.liveStats("없는채널", ["x"]), {});
    const chans = loadChannels();
    const 모음 = await published.collect({ "채널A": chans["채널A"], "채널B": chans["채널B"], "채널D": chans["채널D"] });
    const 모음정리 = Object.fromEntries(Object.entries(모음).map(([n, rows]) => [n, rows.map((r) => {
      const { published_at: _a, ...나머지 } = r as Obj;
      return "per_day" in 나머지 ? { ...나머지, per_day: Math.round(나머지.per_day * 1e6) / 1e6 } : 나머지;
    })]));
    const 기대모음 = Object.fromEntries(Object.entries(기대.올린.모음).map(([n, rows]) => [n, (rows as Obj[]).map((r) => {
      return "published" in r ? { ...r, per_day: Math.round(r.per_day * 1e6) / 1e6, published: String(r.published).replace("+09:00", "") } : r;
    })]));
    같나("채널별 모으기: 원장 + 지금 지표 · 유튜브에 없는 편은 live=false · 제목은 유튜브 것을 먼저", 모음정리, 기대모음);
    g.uninstall();
  });
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

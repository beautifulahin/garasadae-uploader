// 이 채널에서 무엇이 통했는지 과거 성적으로 배운다. (파이썬 insight.py)
//
// 왜 필요한가
//   지금 추천은 모든 채널에 같은 잣대(15~45초가 좋다)를 댄다. 그런데 채널마다 다르다. 어떤 채널은 20초가, 어떤 채널은 60초가
//   잘 된다. 아침이 잘 되는 채널이 있고 밤이 잘 되는 채널이 있다. **그 채널 자기 기록에서 배우는 편이 항상 낫다.**
//
// 무엇을 보나 (전부 Data API 로 얻는다 · 채널당 2유닛)
//   · 길이대별 조회수 중앙값   → 이 채널에 맞는 길이
//   · 업로드 시각대별 중앙값   → 이 채널에 맞는 시간
//   · 최근 추세               → 오르는 중인가 꺾였나
//   · 업로드 간격             → 꾸준한가 띄엄띄엄인가
//
// 정직하게 말하는 부분
//   표본이 적으면 우연이 패턴처럼 보인다. 그래서 **구간마다 최소 3편**, 전체 8편 미만이면 아예 학습하지 않고 일반 기준으로
//   돌아간다. 배운 게 없으면 없다고 말한다. 또 오래된 영상일수록 조회수가 쌓이므로, **올린 지 7일 지난 것만** 비교한다.
//
// 저장 꼴
//   성적.json 에 들어가므로 파이썬이 쓰던 꼴을 그대로 낸다: best_dur/best_hour 는 [시작, 끝], 구간표의 열쇠는 "(30, 45)" 글자,
//   값은 [중앙값, 편수]. (파이썬은 튜플 열쇠를 저장할 때 글자로 바꿨다 — 읽어 온 뒤에도 describe() 가 되도록 처음부터 그 꼴로 낸다.)
import { log } from "./paths.ts";
import { instantToWall } from "./clock.ts";
import type { Wall } from "./clock.ts";
import { LookupError, ytFor } from "./ytcore.ts";
import { batchGetStats, playlistItems, videosList } from "./youtube.ts";
import { commaFixed, cut, fixed, median, msgOf, uploadsPlaylist } from "./stats.ts";

type Obj = Record<string, any>;

export const MIN_TOTAL = 8; // 이보다 적으면 학습하지 않는다
export const MIN_BUCKET = 3; // 구간별 최소 표본
export const MATURE_DAYS = 7; // 조회수가 어느 정도 쌓인 뒤에 비교한다

export const DUR_BUCKETS: [number, number][] = [[0, 15], [15, 30], [30, 45], [45, 60], [60, 90], [90, 180]];
export const HOUR_BUCKETS: [number, number][] = [[6, 10], [10, 14], [14, 18], [18, 22], [22, 6]];

/** 배운 것. 못 배웠으면 learned=false 와 까닭(why). */
export interface Insight {
  learned: boolean;
  why?: string;
  n?: number;
  best_dur?: [number, number] | null;
  /** "(30, 45)" → [중앙값, 편수] */
  dur_tbl?: Record<string, [number, number]>;
  best_hour?: [number, number] | null;
  hour_tbl?: Record<string, [number, number]>;
  /** 최근 절반 대 이전 절반 중앙값 변화, 백분율 */
  trend?: number;
  /** 업로드 간격 중앙값(일) */
  cadence?: number | null;
  median_views?: number;
  /** 배운 때(초) — perf.ts 가 20시간 동안 다시 안 배우려고 붙인다 */
  _at?: number;
}

/** PT1M23S → 83 */
export function isoDurToSec(s: string): number {
  let num = "", out = 0;
  const cur: Record<string, number> = { H: 3600, M: 60, S: 1 };
  for (const ch of String(s ?? "").replace("PT", "")) {
    if (/\d/.test(ch)) num += ch;
    else if (ch in cur && num) { out += Number(num) * cur[ch]; num = ""; }
  }
  return out;
}

interface HistRow { id: string; title: string; views: number; sec: number; kst: Wall }

/** 이 채널의 지난 영상 최대 40편 (올린 지 7일 지난 것만). (파이썬: insight.fetch_history) */
export async function fetchHistory(channelKey: string, want = 40): Promise<HistRow[]> {
  const yt = await ytFor(channelKey);
  // 업로드 목록 id 는 채널ID 에서 계산한다 — 예전에는 channels.list 를 한 번 더 불렀다(채널당 1유닛).
  const up = await uploadsPlaylist(channelKey);
  if (!up) return [];

  const ids: string[] = [];
  let token: string | undefined;
  while (ids.length < want) {
    const pl = await playlistItems(yt, up, { part: "contentDetails", maxResults: 50, pageToken: token });
    ids.push(...(pl.items ?? []).map((i: Obj) => i.contentDetails.videoId as string));
    token = pl.nextPageToken || undefined;
    if (!token) break;
  }

  const cutoff = Date.now() - MATURE_DAYS * 86_400_000;
  const out: HistRow[] = [];
  for (let i = 0; i < Math.min(ids.length, want); i += 50) {
    const 묶 = ids.slice(i, i + 50);
    // batchGetStats 는 **별도 통**(Video Batch Get Stats, 하루 10,000)에서 나간다. 메인 지갑(Queries per day)을 안 건드린다 —
    // 2026-08-28 에 콘솔 숫자로 확인했다(우리 60건 = Queries 46 + Batch 14). 그래서 통계는 이쪽으로 보내는 편이 언제나 이득이다.
    // 다만 공개 영상만 주므로, 빠진 것은 videos.list 로 마저 받는다.
    const 받은 = new Map<string, Obj>(); // 파이썬 dict 처럼 넣은 차례를 지킨다
    try {
      for (const v of await batchGetStats(yt, 묶, "snippet,statistics,contentDetails")) 받은.set(v.id, v);
    } catch (e) {
      await log(`  일괄 통계가 안 돼 낱개로 갑니다 — ${cut(msgOf(e), 60)}`);
    }
    const 빠진 = 묶.filter((x) => !받은.has(x));
    if (빠진.length) {
      for (const v of await videosList(yt, 빠진, "snippet,statistics,contentDetails")) 받은.set(v.id, v);
    }
    for (const v of 받은.values()) {
      const pub = new Date(v.snippet.publishedAt);
      if (pub.getTime() > cutoff) continue;
      out.push({
        id: v.id,
        title: v.snippet.title,
        views: Math.trunc(Number(v.statistics?.viewCount ?? 0)) || 0,
        sec: isoDurToSec(v.contentDetails.duration),
        kst: instantToWall(pub, "Asia/Seoul"),
      });
    }
  }
  out.sort((a, b) => b.kst.getTime() - a.kst.getTime());
  return out;
}

const 열쇠 = (b: [number, number]) => `(${b[0]}, ${b[1]})`;

/** 구간별 중앙값 중 가장 높은 구간. 표본이 3편 넘는 구간이 둘은 있어야 말한다. (파이썬: insight._best_bucket) */
export function bestBucket(
  rows: { views: number }[], keyFn: (r: any) => number, buckets: [number, number][], wrap = false,
): [[number, number] | null, Record<string, [number, number]>] {
  // 파이썬 dict 처럼 처음 만난 구간 차례를 지킨다(중앙값이 같으면 먼저 만난 구간이 이긴다)
  const groups = new Map<string, { b: [number, number]; v: number[] }>();
  for (const r of rows) {
    const val = keyFn(r);
    for (const [lo, hi] of buckets) {
      const inside = !wrap || lo < hi ? lo <= val && val < hi : val >= lo || val < hi;
      if (inside) {
        const k = 열쇠([lo, hi]);
        const g = groups.get(k);
        if (g) g.v.push(r.views); else groups.set(k, { b: [lo, hi], v: [r.views] });
        break;
      }
    }
  }
  const usable = [...groups.values()].filter((g) => g.v.length >= MIN_BUCKET);
  if (usable.length < 2) return [null, {}];
  let best = usable[0];
  for (const g of usable) if (median(g.v) > median(best.v)) best = g;
  const tbl: Record<string, [number, number]> = {};
  for (const g of usable) tbl[열쇠(g.b)] = [median(g.v), g.v.length];
  return [best.b, tbl];
}

/** 이 채널에서 배운 것. 배운 게 없으면 learned=false. (파이썬: insight.learn) */
export async function learn(channelKey: string): Promise<Insight> {
  let rows: HistRow[];
  try {
    rows = await fetchHistory(channelKey);
  } catch (e) {
    const why = e instanceof LookupError || e instanceof Deno.errors.NotFound
      ? "아직 인증 전입니다"
      : `기록을 못 읽었습니다(${cut(msgOf(e), 44)})`;
    return { learned: false, why };
  }

  if (rows.length < MIN_TOTAL) {
    return { learned: false, why: `${MATURE_DAYS}일 지난 영상이 ${rows.length}편뿐입니다 (최소 ${MIN_TOTAL}편 필요)` };
  }

  const [bestDur, durTbl] = bestBucket(rows, (r) => r.sec, DUR_BUCKETS);
  const [bestHr, hrTbl] = bestBucket(rows, (r) => (r as HistRow).kst.getUTCHours(), HOUR_BUCKETS, true);

  // 추세: 최근 절반 vs 이전 절반
  const half = Math.floor(rows.length / 2);
  const recent = rows.slice(0, half).map((r) => r.views), older = rows.slice(half).map((r) => r.views);
  let trend = 0;
  if (older.length && median(older) > 0) trend = ((median(recent) - median(older)) / median(older)) * 100;

  // 업로드 간격(일)
  const gaps: number[] = [];
  for (let i = 0; i < rows.length - 1; i++) gaps.push((rows[i].kst.getTime() - rows[i + 1].kst.getTime()) / 86_400_000);
  const cadence = gaps.length ? median(gaps) : null;

  return {
    learned: true, n: rows.length,
    best_dur: bestDur, dur_tbl: durTbl,
    best_hour: bestHr, hour_tbl: hrTbl,
    trend, cadence,
    median_views: median(rows.map((r) => r.views)),
  };
}

/** 사람이 읽을 요약. (파이썬: insight.describe) */
export function describe(ins: Insight): string[] {
  if (!ins.learned) return [`학습 안 함 — ${ins.why ?? ""}`];
  const out = [`최근 ${ins.n}편 · 조회수 중앙값 ${commaFixed(ins.median_views ?? 0, 0)}회`];
  if (ins.best_dur) {
    const [lo, hi] = ins.best_dur;
    const [med, n] = ins.dur_tbl![열쇠([lo, hi])];
    out.push(`가장 잘 되는 길이 ${lo}~${hi}초 (중앙값 ${commaFixed(med, 0)}회 · ${n}편)`);
  }
  if (ins.best_hour) {
    const [lo, hi] = ins.best_hour;
    const [med, n] = ins.hour_tbl![열쇠([lo, hi])];
    out.push(`가장 잘 되는 시간 ${lo}~${hi}시 (중앙값 ${commaFixed(med, 0)}회 · ${n}편)`);
  }
  const trend = ins.trend ?? 0;
  if (Math.abs(trend) >= 15) out.push(`추세 ${trend > 0 ? "상승" : "하락"} ${fixed(Math.abs(trend), 0)}%`);
  if (ins.cadence) out.push(`업로드 간격 중앙값 ${fixed(ins.cadence, 1)}일`);
  return out;
}

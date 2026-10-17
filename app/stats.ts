// 조회수를 보고 하루 업로드 편수를 정한다. (파이썬 stats.py)
//
// 규칙 (channels.json 의 rule 로 바꿀 수 있다)
//   최근 쇼츠 3개 중 가장 높은 조회수가
//       10만 이상  →  하루 4개
//        1만 이상  →  하루 2개
//        그 미만   →  하루 1개
//
// ★ 성숙 기간이 핵심이다 ★
//   방금 올린 영상은 조회수가 0에 가깝다. 그것까지 「최근 3개」에 넣으면 아무리 잘 나가는 채널도
//   영원히 하루 1개에 묶인다. 그래서 **올린 지 MATURE_HOURS(48시간) 지난 영상만** 센다.
//
// 할당량 (새 앱은 google.call 이 모든 호출을 자동으로 센다 — 여기서 손으로 세지 않는다)
//   채널당 3유닛(채널정보 1 + 목록 1 + 통계 1). 업로드 목록 id 는 채널ID 에서 계산하고(0유닛),
//   통계는 videos:batchGetStats 로 전 채널을 한 번에 받는다(별도 통).
//
// 이 파일 맨 위 「셈 도우미」는 지표 계열 파일 전부가 쓴다 — 파이썬 원본이 만든 성적.json 같은 파일을 두 프로그램이
// 함께 읽으므로, 반올림·글자 꼴이 원본과 같아야 한다.
import { log } from "./paths.ts";
import { instantToWall, parseWall } from "./clock.ts";
import type { Wall } from "./clock.ts";
import { loadChannels } from "./channels.ts";
import { LookupError, loadStore, ytFor } from "./ytcore.ts";
import { batchGetStats, channelMine, playlistItems, uploadsPlaylistId, videosList } from "./youtube.ts";

type Obj = Record<string, any>;

/* ============================================================ 셈 도우미 (파이썬과 같은 값·글자) */

/**
 * 파이썬 round(x) / round(x, nd).  파이썬은 정확히 한가운데(.5)일 때 **짝수 쪽**으로 반올림한다(2.5 → 2, 3.5 → 4).
 * 자바스크립트 Math.round 는 위쪽이라 정확히 .5 인 값에서만 다르다 — 같은 성적.json 을 두 프로그램이 읽으니 맞춘다.
 */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  if (nd === 0) return roundHalfEven(x);
  // 2진수로 정확히 한가운데인 값(0.25, 0.125 …)만 짝수 쪽으로. 0.35 처럼 2진수로 정확하지 않은 값은
  // 실제 크기대로(0.3499…) 반올림해야 파이썬과 같다 — toFixed 가 정확한 값으로 계산해 준다.
  const t = x * 2 ** (nd + 1);
  if (Number.isInteger(t) && Math.abs(t) % 2 === 1) {
    const scale = 10 ** nd;
    return roundHalfEven(x * scale) / scale;
  }
  return Number(x.toFixed(nd));
}

function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** 파이썬 f"{x:.{nd}f}" */
export function fixed(x: number, nd = 0): string {
  if (!Number.isFinite(x)) return String(x);
  const t = x * 2 ** (nd + 1);
  if (Number.isInteger(t) && Math.abs(t) % 2 === 1) return pyRound(x, nd).toFixed(nd);
  return x.toFixed(nd);
}

/** 숫자 글자의 정수 자리에 쉼표를 넣는다 ("1234.5" → "1,234.5") */
export function commaStr(s: string): string {
  const m = /^(-?)(\d+)(.*)$/.exec(s);
  if (!m) return s;
  return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + m[3];
}
/** 파이썬 f"{n:,}" (정수) */
export const commaInt = (n: number): string => commaStr(String(Math.trunc(n)));
/** 파이썬 f"{x:,.{nd}f}" */
export const commaFixed = (x: number, nd = 0): string => commaStr(fixed(x, nd));
/** 파이썬 f"{n:+,}" — 부호를 늘 붙인다(0 도 「+0」) */
export const signedComma = (n: number): string => (n < 0 ? "-" : "+") + commaInt(Math.abs(n));
/** 파이썬 f"{x:,}" 를 실수에 쓴 꼴 — 정수로 딱 떨어져도 「1,234.0」 이 된다 */
export function commaFloat(x: number): string {
  const s = String(x);
  return commaStr(/^-?\d+$/.test(s) ? s + ".0" : s);
}

/** 파이썬 statistics.median */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 파이썬 s[:n] — 글자(코드 포인트) 기준. 이모지가 반 토막 나지 않는다. */
export function cut(s: unknown, n: number): string {
  return Array.from(String(s ?? "")).slice(0, n).join("");
}

/** 파이썬 int(v) 가 읽을 수 있는 것만: 숫자는 버림, 정수 글자는 읽고, 나머지는 null (ValueError/TypeError 자리) */
export function pyInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string") {
    const t = v.trim();
    return /^[+-]?\d+$/.test(t) ? Number(t) : null;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/** 파이썬 date.fromisoformat — "YYYY-MM-DD" 만 읽는다(시각이 붙은 글자는 못 읽은 것). 벽시계 0시. */
export function parseDay(s: unknown): Wall | null {
  const t = String(s ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? parseWall(t) : null;
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** strftime("%m/%d") */
export const mmdd = (w: Wall): string => `${p2(w.getUTCMonth() + 1)}/${p2(w.getUTCDate())}`;
/** 벽시계 날짜를 「하루 번호」로 — 날짜끼리 빼서 일수를 낼 때 */
export const dayNum = (w: Wall): number => Math.floor(w.getTime() / 86_400_000);
/** 오류 문구 */
export const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ============================================================ 값 */

export const MATURE_HOURS = 48; // 이 시간이 지난 영상만 편수 판단에 쓴다
export const SAMPLE = 3; // 편수 규칙이 보는 개수
/** 받아 두는 개수 — 화면은 10개씩 보여 주고 「조회수 상위 10개」 는 이 30편 안에서 고른다. 50까지는 호출 수가 같다(한 페이지). */
export const RECENT = 30;

export interface Rule { min_views: number; daily: number }
export const DEFAULT_RULE: Rule[] = [
  { min_views: 100_000, daily: 4 },
  { min_views: 10_000, daily: 2 },
  { min_views: 0, daily: 1 },
];

/** 영상 한 편의 통계 (파이썬 통계한번에 의 값) */
export interface StatLine { views: number; likes: number | null; comments: number | null; published: Date | null }

/** 채널 지표 한 줄 (파이썬 여러채널지표·recent_performance 의 줄) */
export interface PerfRow {
  id: string; title: string; views: number; likes: number | null; comments: number | null;
  published: Date | null; age_days: number; views_per_day: number;
  /** recent_performance 만 채운다 — 조회수 대비 좋아요, 백분율 */
  like_rate?: number | null;
}

const 하루ms = 86_400_000;

/* ============================================================ 업로드 목록 */

/**
 * 그 채널의 「업로드」 재생목록 id. **유닛을 쓰지 않는다.** (파이썬: stats.업로드목록)
 *
 * 유튜브는 채널ID `UCxxxx` 의 업로드 목록을 언제나 `UUxxxx` 로 만든다. 앞 두 글자만 바꾸면 된다.
 * 예전에는 이것을 알아내려고 채널마다 channels.list 를 한 번씩 불렀다 — 10채널이면 10유닛이 그냥 나갔다.
 * 채널ID 를 모르면 어쩔 수 없이 물어본다(1유닛).
 */
export async function uploadsPlaylist(channelKey: string): Promise<string | null> {
  const cid = loadChannels()[channelKey]?.channel_id || loadStore()[channelKey]?.channel_id || "";
  const calc = uploadsPlaylistId(cid);
  if (calc) return calc;
  try {
    const yt = await ytFor(channelKey);
    const it = await channelMine(yt, "contentDetails");
    return it ? (it.contentDetails.relatedPlaylists.uploads as string) : null;
  } catch (e) {
    await log(`  ${channelKey} 업로드 목록을 알아내지 못했습니다 — ${cut(msgOf(e), 70)}`);
    return null;
  }
}

/* ============================================================ 통계 읽기 */

/**
 * 영상 여러 개의 통계를 **호출 한 번(1유닛)** 으로 가져온다. (파이썬: stats.통계한번에)
 *
 * videos:batchGetStats 는 공개 영상이면 채널을 넘나들며 준다. 그래서 채널이 몇 개든 한 번이면 된다.
 * 비공개 영상은 안 주므로, 빠진 것만 그 채널 자격증명으로 videos.list 에 다시 묻는다(이것도 1유닛).
 * `fallback` — 대비책을 여기서도 돌리고 부르는 쪽에서도 돌리면 **두 번 나간다.** 여러 채널을 묶어 부를 때는 끄고,
 * 채널별로 한 번만 돌린다.
 */
export async function statsOnce(
  ids: string[], channelKey: string, fallback = true,
): Promise<Record<string, StatLine>> {
  const out: Record<string, StatLine> = Object.create(null); // 영상 id 가 열쇠 — 상속 칸이 없는 사전
  if (!ids.length) return out;

  const put = (v: Obj) => {
    const st = v.statistics ?? {}, sn = v.snippet ?? {};
    const at: string = sn.publishedAt || sn.publishTime || "";
    const d = at ? new Date(at) : null;
    out[v.id] = {
      views: pyInt(st.viewCount ?? 0) ?? 0,
      likes: "likeCount" in st ? pyInt(st.likeCount) : null,
      comments: "commentCount" in st ? pyInt(st.commentCount) : null,
      published: d && !Number.isNaN(d.getTime()) ? d : null,
    };
  };

  const yt = await ytFor(channelKey);
  for (let i = 0; i < ids.length; i += 50) {
    const 묶음 = ids.slice(i, i + 50);
    try {
      for (const v of await batchGetStats(yt, 묶음, "statistics,snippet")) put(v);
    } catch (e) {
      await log(`  일괄 통계가 안 돼 낱개로 물어봅니다 — ${cut(msgOf(e), 70)}`);
    }
    const 빠진 = 묶음.filter((x) => !(x in out));
    if (빠진.length && fallback) {
      // 비공개 영상은 일괄 조회가 안 준다. 주인 자격증명으로 다시 묻는다.
      try {
        for (const v of await videosList(yt, 빠진, "statistics,snippet")) put(v);
      } catch (e) {
        await log(`  비공개 ${빠진.length}개를 못 읽었습니다 — ${cut(msgOf(e), 70)}`);
      }
    }
  }
  return out;
}

/**
 * 여러 채널의 지표를 **가장 적은 유닛**으로 읽는다. (파이썬: stats.여러채널지표)
 *
 *   비용  채널당 1유닛(목록) + 전체 통틀어 1유닛(일괄 통계) + 비공개가 있으면 조금 더
 *         예전: 채널당 3유닛 → 10채널이면 30 / 지금: 10채널이면 11
 *   줄인 법  · 업로드 목록 id 는 채널ID 에서 **계산**한다(0유닛)
 *            · 제목·영상id 는 playlistItems.list 가 한 번에 준다(1유닛) — 예전에는 id 만 받고 제목은 videos.list 로 또 물었다
 *            · 통계는 batchGetStats 로 **전 채널을 한 번에** 받는다(1유닛)
 *
 * `want` — null 이면 **전 영상**을 받는다(페이지당 1유닛, 50개씩). 「조회수 상위 30」 이 최근 30편 안에서만 골라져
 * 옛 히트작이 통째로 빠지던 것(2026-09-08 지적)의 답이다.
 */
export async function multiChannelMetrics(
  channelKeys: string[], want: number | null = RECENT,
): Promise<Record<string, PerfRow[]>> {
  const 묶음: Record<string, string[]> = {};
  const 제목: Record<string, string> = Object.create(null);
  const 소속: Record<string, string> = Object.create(null);
  const 차례 = [...new Set(channelKeys)]; // 파이썬 dict 처럼 처음 나온 차례를 지킨다
  // 한 채널을 두 이름으로 등록했으면(쇼츠용/롱폼용) 같은 목록을 두 번 읽는 셈이다 — 먼저 읽은 이름의 목록을 그대로 쓴다.
  // (원본은 이름마다 읽어 같은 유닛이 두 번 나갔다. 결과는 같다.)
  const 설정 = loadChannels();
  const 읽은채널 = new Map<string, string>(); // channel_id → 먼저 읽은 이름

  for (const name of 차례) {
    const cid = 설정[name]?.channel_id || "";
    const 먼저 = cid ? 읽은채널.get(cid) : undefined;
    if (먼저 !== undefined) { 묶음[name] = [...(묶음[먼저] ?? [])]; continue; }
    if (cid) 읽은채널.set(cid, name);
    const up = await uploadsPlaylist(name);
    if (!up) { 묶음[name] = []; continue; }
    const ids: string[] = [];
    let token: string | undefined;
    try {
      const yt = await ytFor(name);
      while (true) {
        const pl = await playlistItems(yt, up, { part: "snippet,contentDetails", maxResults: 50, pageToken: token });
        for (const it of pl.items ?? []) {
          const vid = it.contentDetails.videoId as string;
          ids.push(vid);
          제목[vid] = it.snippet?.title ?? "";
          소속[vid] = name;
        }
        token = pl.nextPageToken || undefined;
        if (!token || (want !== null && ids.length >= want)) break;
      }
    } catch (e) {
      await log(`  ${name} 목록을 읽지 못했습니다 — ${cut(msgOf(e), 70)}`);
      묶음[name] = [];
      continue;
    }
    묶음[name] = want === null ? ids : ids.slice(0, want);
  }

  const 모든id = [...new Set(차례.flatMap((n) => 묶음[n] ?? []))]; // 별칭이 같은 영상을 되풀이해 싣는 일이 없게 한 번씩만
  if (!모든id.length) return Object.fromEntries(channelKeys.map((n) => [n, [] as PerfRow[]]));

  // 통계는 한 번에. 자격증명은 아무 채널 것이나 되지만, 비공개 대비책이 그 채널 것으로 다시 물어야 하므로
  // 채널별로 나눠 부른다.
  const 통계: Record<string, StatLine> = Object.create(null);
  const 첫채널 = channelKeys.find((n) => 묶음[n]?.length) ?? channelKeys[0];
  Object.assign(통계, await statsOnce(모든id, 첫채널, false));
  const 빠진 = 모든id.filter((v) => !(v in 통계));
  for (const name of channelKeys) { // 비공개는 주인에게만 보인다
    const 남은 = 빠진.filter((v) => 소속[v] === name);
    if (남은.length) Object.assign(통계, await statsOnce(남은, name));
  }

  const 이제 = Date.now();
  const 난것: Record<string, PerfRow[]> = {};
  for (const name of channelKeys) {
    const 줄: PerfRow[] = [];
    for (const vid of 묶음[name] ?? []) {
      const st = 통계[vid];
      if (!st) continue;
      const pub = st.published;
      const age = pub ? Math.max((이제 - pub.getTime()) / 하루ms, 0.04) : 0.04;
      줄.push({
        id: vid, title: 제목[vid] ?? "",
        views: st.views, likes: st.likes, comments: st.comments,
        published: pub, age_days: age, views_per_day: st.views / age,
      });
    }
    난것[name] = 줄;
  }
  return 난것;
}

/** 성숙 기간이 지난 최근 영상들의 (조회수, 게시일). (파이썬: stats.recent_shorts) */
export async function recentShorts(
  channelKey: string, want = SAMPLE, matureHours = MATURE_HOURS,
): Promise<{ id: string; views: number; published: Date; title: string }[]> {
  const yt = await ytFor(channelKey);
  const uploads = await uploadsPlaylist(channelKey); // 0유닛 — 채널ID 에서 계산
  if (!uploads) throw new LookupError("채널 정보를 읽지 못했습니다");

  // 넉넉히 받아 놓고 성숙한 것만 골라낸다(최근 것 중 덜 익은 게 섞여 있으므로).
  const pl = await playlistItems(yt, uploads, { part: "contentDetails", maxResults: Math.min(want * 4, 50) });
  const ids: string[] = (pl.items ?? []).map((i: Obj) => i.contentDetails.videoId);
  if (!ids.length) return [];

  const vs = await videosList(yt, ids.slice(0, 50), "statistics,snippet");
  const cutoff = Date.now() - matureHours * 3_600_000;
  const out: { id: string; views: number; published: Date; title: string }[] = [];
  for (const v of vs) {
    const pub = new Date(v.snippet.publishedAt);
    if (pub.getTime() > cutoff) continue; // 아직 덜 익었다 — 편수 판단에서 뺀다
    out.push({ id: v.id, views: pyInt(v.statistics?.viewCount ?? 0) ?? 0, published: pub, title: cut(v.snippet.title, 40) });
  }
  out.sort((a, b) => b.published.getTime() - a.published.getTime());
  return out.slice(0, want);
}

/**
 * 직전 N개의 조회수·좋아요·댓글. (파이썬: stats.recent_performance)
 * 성과를 눈으로 보려는 것이므로 성숙 기간을 따지지 않고 **올린 순서 그대로** 가져온다.
 * 할당량: 채널당 **2유닛**(목록 1 + 통계 1).
 */
export async function recentPerformance(channelKey: string, want = RECENT): Promise<PerfRow[]> {
  const yt = await ytFor(channelKey);
  const up = await uploadsPlaylist(channelKey); // 0유닛
  if (!up) return [];

  const pl = await playlistItems(yt, up, { part: "contentDetails", maxResults: Math.min(want, 50) });
  const ids: string[] = (pl.items ?? []).map((i: Obj) => i.contentDetails.videoId).slice(0, want);
  if (!ids.length) return [];

  const vs = await videosList(yt, ids, "statistics,snippet,contentDetails");
  const rows: PerfRow[] = [];
  for (const v of vs) {
    const st = v.statistics ?? {};
    const pubD = new Date(v.snippet.publishedAt);
    const pub = Number.isNaN(pubD.getTime()) ? null : pubD;
    const views = pyInt(st.viewCount ?? 0) ?? 0;
    const likes = "likeCount" in st ? pyInt(st.likeCount) : null; // 숨김일 수 있다
    const cmts = "commentCount" in st ? pyInt(st.commentCount) : null; // 꺼져 있을 수 있다
    const ageD = pub ? Math.max((Date.now() - pub.getTime()) / 하루ms, 0.04) : 0.04;
    rows.push({
      id: v.id, title: v.snippet.title, views, likes, comments: cmts, published: pub, age_days: ageD,
      // 오래된 영상일수록 조회수가 쌓이므로, 나란히 놓고 비교하려면 하루치로 나눈다
      views_per_day: views / ageD,
      // 참여율 — 조회수 대비 좋아요. 0 나눗셈을 피한다
      like_rate: likes !== null && views ? (likes / views) * 100 : null,
    });
  }
  rows.sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0));
  return rows;
}

/** 터미널에 그대로 찍을 수 있는 표. 숫자는 자리를 맞춘다. (파이썬: stats.perf_table) */
export function perfTable(rows: PerfRow[], limit = RECENT): string[] {
  if (!rows.length) return ["  올린 영상이 없습니다"];

  const k = (n: number | null | undefined): string => {
    if (n === null || n === undefined) return "  —";
    if (n >= 10000) return `${fixed(n / 10000, 1)}만`;
    return commaInt(n);
  };

  const out = [`  ${"올린날".padEnd(7)} ${"조회수".padStart(8)} ${"하루평균".padStart(8)} ${"좋아요".padStart(7)} ${"댓글".padStart(6)}  제목`];
  out.push("  " + "─".repeat(74));
  for (const r of rows.slice(0, limit)) {
    const when = r.published ? (() => { const w = instantToWall(r.published, "Asia/Seoul"); return `${p2(w.getUTCMonth() + 1)}-${p2(w.getUTCDate())}`; })() : "";
    out.push(
      `  ${when.padEnd(7)} ${k(r.views).padStart(8)} ${k(pyRound(r.views_per_day)).padStart(8)} ` +
        `${k(r.likes).padStart(7)} ${k(r.comments).padStart(6)}  ${cut(r.title, 30)}`,
    );
  }

  const vs = rows.slice(0, limit).map((r) => r.views);
  const lr = rows.slice(0, limit).map((r) => r.like_rate).filter((x): x is number => x !== null && x !== undefined);
  out.push("  " + "─".repeat(74));
  let tail = `  ${vs.length}개 · 조회수 중앙값 ${k(pyRound(median(vs)))} · 최고 ${k(Math.max(...vs))}`;
  if (lr.length) tail += ` · 좋아요율 ${fixed(median(lr), 1)}%`;
  out.push(tail);
  return out;
}

/* ============================================================ 하루 편수 정하기 */

/**
 * 이미 손에 든 줄들로 편수를 정한다. **유닛을 쓰지 않는다.** (파이썬: stats.decide_from_rows)
 *
 * decide() 는 같은 일을 하려고 recent_shorts() 를 불렀다. 그런데 화면을 갱신할 때는 바로 앞에서
 * 여러채널지표() 가 **같은 채널의 같은 영상들을** 이미 받아 왔다. 채널마다 2유닛이 그대로 두 번 나가고 있었다
 * (10채널이면 20유닛). 여기서는 받아 온 것을 그대로 쓴다.
 * rows 는 {views, age_days} 를 가진 줄들이면 된다.
 */
export function decideFromRows(
  rows: { views?: number | null; age_days?: number | null }[],
  rule?: Rule[] | null, fallback = 1, matureHours = MATURE_HOURS,
): [number, string] {
  if (!rows.length) return [fallback, `읽어 온 영상이 없습니다 — 기본 ${fallback}개로 진행`];
  let 익음 = rows.filter((r) => (r.age_days || 0) * 24 >= matureHours);
  if (!익음.length) return [fallback, `${matureHours}시간 지난 영상이 없습니다 — 기본 ${fallback}개로 진행`];
  // 익은 것 중 **최근** 것부터 SAMPLE 개. age_days 가 작을수록 최근이다.
  // (한 번 반대로 정렬해서 제일 오래된 영상으로 편수를 정할 뻔했다)
  익음 = [...익음].sort((a, b) => (a.age_days || 0) - (b.age_days || 0)).slice(0, SAMPLE);
  const peak = Math.max(...익음.map((r) => Math.trunc(r.views || 0)));
  const n = dailyFor(peak, rule);
  const each = 익음.map((r) => commaInt(Math.trunc(r.views || 0))).join(" · ");
  return [n, `최근 ${익음.length}개 [${each}] 최고 ${commaInt(peak)}회 → 하루 ${n}개`];
}

export function dailyFor(peakViews: number, rule?: Rule[] | null): number {
  for (const step of rule && rule.length ? rule : DEFAULT_RULE) {
    if (peakViews >= step.min_views) return step.daily;
  }
  return 1;
}

/** (오늘 올릴 편수, 사람이 읽을 근거) (파이썬: stats.decide) */
export async function decide(channelKey: string, rule?: Rule[] | null, fallback = 1): Promise<[number, string]> {
  let vids: Awaited<ReturnType<typeof recentShorts>>;
  try {
    vids = await recentShorts(channelKey);
  } catch (e) {
    // 인증 전이거나 네트워크가 없을 수도 있다. 편수 판단은 부가 기능이므로 여기서 막히면 앱 전체가 멈춘다 —
    // 기본값으로 넘어간다.
    const why = e instanceof LookupError || e instanceof Deno.errors.NotFound
      ? "아직 인증 전입니다"
      : `조회수를 못 봤습니다(${cut(msgOf(e), 44)})`;
    return [fallback, `${why} — 기본 ${fallback}개로 진행`];
  }
  if (!vids.length) return [fallback, `${MATURE_HOURS}시간 지난 영상이 없습니다 — 기본 ${fallback}개로 진행`];

  const peak = Math.max(...vids.map((v) => v.views));
  const n = dailyFor(peak, rule);
  const each = vids.map((v) => commaInt(v.views)).join(" · ");
  return [n, `최근 ${vids.length}개 [${each}] 최고 ${commaInt(peak)}회 → 하루 ${n}개`];
}

// 올린 영상을 확인한다 — 채널별로, 실시간 지표와 함께. (파이썬 published.py 의 자료 만들기)
//
// 원장(ledger.csv)에 남은 업로드 이력을 바탕으로 유튜브에서 **지금 지표**를 가져온다. 조회수 · 좋아요 · 댓글 · 하루평균.
// 이 파일은 자료만 만든다 — 화면(HTML)은 메인이 새 화면에서 그린다.
//
// 할당량: videos.list 는 한 번에 50개까지 묶어 물어볼 수 있다. 30개 채널에 각 60편이면 1,800편 → 36회 호출 → 36유닛.
// 사람이 「올린 영상」 을 열어 달라고 했을 때만 부른다(놀 때는 0건).
import { recordLine } from "./paths.ts";
import { readLedger } from "./ledger.ts";
import { ytFor } from "./ytcore.ts";
import { videosList } from "./youtube.ts";
import { instantToWall, isoWall } from "./clock.ts";
import type { Channels } from "./channels.ts";
import { cut, msgOf } from "./stats.ts";

/** 한 화면에 30개(가로10 × 세로3) */
export const PAGE = 30;

/** 원장에서 읽은 영상 한 편 */
export interface LedgerVideo { video_id: string; title: string; file: string; uploaded: string }

/** 유튜브가 지금 알려 준 값 */
export interface LiveStat {
  views: number; likes: number | null; comments: number | null;
  /** 올린 때, 한국 시각(KST) 벽시계 글자 — 2026-10-16T16:00:00 */
  published: string;
  /** 유튜브가 준 올린 때 그대로(UTC) */
  published_at: string;
  per_day: number; privacy: string; title: string; thumb: string | null;
}

/** 원장 + 지금 지표를 합친 한 줄 */
export type PublishedRow = LedgerVideo & Partial<LiveStat> & { live: boolean };

/** {채널: [{video_id, title, file, uploaded}]} — 최근 것이 앞. (파이썬: published.from_ledger) */
export function fromLedger(): Record<string, LedgerVideo[]> {
  const out: Record<string, LedgerVideo[]> = {};
  for (const row of readLedger()) {
    const vid = (row["영상ID"] ?? "").trim();
    const ch = (row["채널"] ?? "").trim();
    if (!vid || !ch) continue;
    (out[ch] ??= []).push({
      video_id: vid, title: row["제목"] ?? "", file: row["파일"] ?? "", uploaded: row["업로드시각"] ?? "",
    });
  }
  // 같은 시각이면 원장에 적힌 차례를 지킨다(파이썬 sort(reverse=True) 도 같은 값의 차례를 안 바꾼다)
  for (const ch of Object.keys(out)) out[ch].sort((a, b) => (a.uploaded < b.uploaded ? 1 : a.uploaded > b.uploaded ? -1 : 0));
  return out;
}

/**
 * {video_id: {views, likes, comments, published, per_day, privacy, title, thumb}} — 지금 값. (파이썬: published.live_stats)
 * 인증이 안 된 채널이면 빈 값. 한 묶음이 실패해도 나머지는 계속 간다.
 */
export async function liveStats(channelKey: string, videoIds: string[]): Promise<Record<string, LiveStat>> {
  if (!videoIds.length) return {};
  let yt;
  try {
    yt = await ytFor(channelKey);
  } catch (e) {
    await recordLine("서버.log", `올린 영상 지표 — ${channelKey} 도구를 못 만들었습니다(${cut(msgOf(e), 60)})`);
    return {}; // 아직 인증 전 — 지표만 못 읽을 뿐 목록은 보여 준다
  }
  const got: Record<string, LiveStat> = {};
  for (let i = 0; i < videoIds.length; i += 50) { // 한 번에 50개까지
    const chunk = videoIds.slice(i, i + 50);
    let items;
    try {
      items = await videosList(yt, chunk, "statistics,snippet,status");
    } catch (e) {
      await recordLine("서버.log", `올린 영상 지표 — ${channelKey} ${chunk.length}편 못 읽음(${cut(msgOf(e), 60)})`);
      continue; // 이 묶음만 못 읽은 것이다 — 줄마다 live=false 로 보인다
    }
    for (const v of items) {
      const st = v.statistics ?? {}, sn = v.snippet ?? {};
      const pub = new Date(sn.publishedAt);
      const age = Math.max((Date.now() - pub.getTime()) / 86_400_000, 0.04);
      const views = Math.trunc(Number(st.viewCount ?? 0)) || 0;
      const th = sn.thumbnails ?? {};
      got[v.id] = {
        views,
        likes: "likeCount" in st ? Math.trunc(Number(st.likeCount)) : null,
        comments: "commentCount" in st ? Math.trunc(Number(st.commentCount)) : null,
        published: Number.isNaN(pub.getTime()) ? "" : isoWall(instantToWall(pub, "Asia/Seoul")),
        published_at: String(sn.publishedAt ?? ""),
        per_day: views / age,
        privacy: v.status?.privacyStatus ?? "",
        title: sn.title ?? "",
        thumb: (th.medium ?? th.default ?? {}).url ?? null,
      };
    }
  }
  return got;
}

/** 채널별 올린 영상 + 지금 지표. (파이썬: published.collect) */
export async function collect(chans: Channels): Promise<Record<string, PublishedRow[]>> {
  const led = fromLedger();
  const out: Record<string, PublishedRow[]> = {};
  for (const [name, cf] of Object.entries(chans)) {
    if (name.startsWith("_") || !cf || typeof cf !== "object") continue;
    const rows = led[name] ?? led[cf.channel_id ?? ""] ?? [];
    const ids = rows.map((r) => r.video_id);
    const stat = await liveStats(cf.channel_id || name, ids);
    out[name] = rows.map((r) => {
      const s = stat[r.video_id];
      return { ...r, ...(s ?? {}), title: s?.title || r.title, live: !!s };
    });
  }
  return out;
}

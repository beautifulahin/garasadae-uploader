// 올린 뒤 어떻게 됐나 — 조회수·좋아요·댓글을 다시 물어 와 세워 둔다.
//
// 왜 있나
//   올리는 것으로 끝이었다. **무엇이 먹혔는지**는 유튜브 스튜디오를 따로 열어야
//   알 수 있었고, 그래서 다음 편을 만들 때 참고가 안 됐다.
//
// 어떻게 되나
//   이미 받아 둔 `youtube.readonly` 권한으로 된다 — **다시 로그인할 일이 없다.**
//   한 번에 50편까지 묶어 묻고 그래도 1점이다(업로드 한 편이 1600점).
//
// ★핵심 눈금은 **시간당 조회수**다. 어제 올린 편과 오늘 올린 편을 조회수 총량으로
//   견주면 오래된 것이 무조건 이긴다. 시간으로 나눠야 같은 자리에서 견줄 수 있다.

import { Channel, Config, State, StatRec, loadTokens, log } from "./paths.ts";
import { fetchStats, LIST_COST } from "./youtube.ts";

/** 며칠 치까지 다시 물어볼까. 오래된 편은 이미 굳어서 다시 물을 값이 없다. */
const 볼날 = 45;
/** 한 번에 물어볼 최대 편수 */
const 최대 = 200;

/**
 * 성적을 새로 잰다.
 *
 * @returns 쓴 사용량(점). 부른 쪽에서 채널 할당량에 더한다.
 */
export async function refreshStats(
  cfg: Config,
  state: State,
  채널들: Channel[],
  쓴점적기?: (ch: Channel, n: number) => void,
): Promise<{ 잰편수: number; 점: number; 오류: string }> {
  const 문턱 = Date.now() - 볼날 * 86400_000;
  let 잰편수 = 0, 점 = 0, 오류 = "";

  for (const ch of 채널들) {
    if (!(await loadTokens(ch.id))) continue;              // 아직 연결 안 한 채널
    const ids = state.uploads
      .filter((u) => u.channelId === ch.id && u.id)
      .filter((u) => {
        const t = Date.parse(u.at);
        return !Number.isFinite(t) || t >= 문턱;
      })
      .slice(0, 최대)
      .map((u) => u.id);
    if (!ids.length) continue;

    try {
      const { items, missing, calls } = await fetchStats(cfg, ch, ids);
      점 += calls * LIST_COST;
      쓴점적기?.(ch, calls * LIST_COST);      // 할당량은 채널(구글 프로젝트)별로 센다
      const 이제 = Date.now();
      for (const it of items) {
        const 앞 = state.stats[it.id];
        state.stats[it.id] = {
          views: it.views,
          likes: it.likes,
          comments: it.comments,
          at: 이제,
          title: it.title || 앞?.title,
          privacy: it.privacy || 앞?.privacy,
        };
      }
      // 돌려주지 않은 것은 사라진 영상이다. 지우지 말고 표시만 남긴다 —
      // 지워 버리면 "왜 없어졌지?" 를 물어볼 자리가 없어진다.
      for (const id of missing) {
        state.stats[id] = { ...(state.stats[id] ?? { views: 0, likes: 0, comments: 0 }), at: 이제, gone: true };
      }
      잰편수 += items.length;
    } catch (e) {
      오류 = e instanceof Error ? e.message : String(e);
      await log(`   ⚠️  [${ch.name}] 성적을 못 읽었습니다: ${오류}`);
    }
  }

  state.statsAt = Date.now();
  return { 잰편수, 점, 오류 };
}

export interface StatsRow {
  id: string;
  title: string;
  channelId: string;
  channelName: string;
  at: string;
  privacy: string;
  views: number;
  likes: number;
  comments: number;
  /** 시간당 조회수 — 오래된 편과 갓 올린 편을 같은 자리에서 견주는 눈금 */
  perHour: number;
  /** 올린 지 몇 시간 */
  hours: number;
  /** 참여도 — 조회수 대비 좋아요+댓글, 만분율 */
  engage: number;
  gone: boolean;
  measured: boolean;
}

/** 화면에 세울 줄들. 시간당 조회수가 높은 것부터. */
export function statsRows(state: State): StatsRow[] {
  const rows: StatsRow[] = [];
  for (const u of state.uploads) {
    const s: StatRec | undefined = state.stats[u.id];
    const t = Date.parse(u.at);
    const hours = Number.isFinite(t) ? Math.max(0.25, (Date.now() - t) / 3600_000) : 0;
    const views = s?.views ?? 0;
    rows.push({
      id: u.id,
      // 손으로 제목을 고쳤을 수 있다 — 유튜브가 아는 쪽을 먼저 쓴다
      title: s?.title || u.title,
      channelId: u.channelId,
      channelName: u.channelName,
      at: u.at,
      privacy: s?.privacy || u.privacy,
      views,
      likes: s?.likes ?? 0,
      comments: s?.comments ?? 0,
      perHour: hours ? Math.round((views / hours) * 10) / 10 : 0,
      hours: Math.round(hours * 10) / 10,
      engage: views ? Math.round(((s!.likes + s!.comments) / views) * 10000) / 100 : 0,
      gone: !!s?.gone,
      measured: !!s,
    });
  }
  return rows.sort((a, b) => b.perHour - a.perHour);
}

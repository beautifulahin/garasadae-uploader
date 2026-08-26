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

import { Channel, Config, State, StatRec, UploadRec, loadTokens, localStamp, log } from "./paths.ts";
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
      // 돌려주지 않은 것은 사라진 영상이다. 갓 올린 것(3시간 안)은 아직 처리 중일 수
      // 있으니 「사라짐」 표시만 남기고, **올린 지 3시간이 지났는데도 없으면 기록에서 뺀다**
      // (사용자 지시 2026-08-26: "화면 안 나오는 영상 지워줘 — 몇 시간 지나도 똑같이
      //  보이면 지워"). 유튜브에서 지운 편이 첫 화면 「최근 올린 영상」에 빈 칸으로
      //  남아 있었다.
      for (const id of missing) {
        const u = state.uploads.find((x) => x.id === id);
        const 올린지 = u ? 이제 - Date.parse(u.at) : 0;
        if (u && Number.isFinite(올린지) && 올린지 > 3 * 3600_000) {
          state.uploads = state.uploads.filter((x) => x.id !== id);
          delete state.stats[id];
          await log(`   🗑  [${ch.name}] 유튜브에서 사라진 편을 기록에서 뺐습니다: ${u.title}`);
          continue;
        }
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
  /** 뜬 지 몇 시간 — 예약 공개면 **뜬 때**부터 센다 */
  hours: number;
  /** 시간을 어디부터 셌나 (RFC3339). 예약이 걸렸으면 그 시각, 아니면 올린 때 */
  since: string;
  /** 아직 안 뜬 편 — 예약 시각이 아직 안 왔다. 견줄 수 없으니 줄 끝으로 보낸다 */
  pending: boolean;
  /** 참여도 — 조회수 대비 좋아요+댓글, 만분율 */
  engage: number;
  gone: boolean;
  measured: boolean;

  /* ── 제목 갈아끼우기 전·후 (2026-08-22) ─────────────────────
     ★바꾸기만 하고 결과를 안 재면 A/B 가 아니라 그냥 바꾼 것이다. */
  /** 제목을 갈아끼운 편인가 */
  swapped: boolean;
  /** 바꾸기 전 제목 */
  titleA: string;
  /** 바꾸기 **전** 구간의 시간당 조회수 */
  perHourA: number;
  /** 바꾼 **뒤** 구간의 시간당 조회수 */
  perHourB: number;
}

/** 제목을 갈아끼운 편의 앞뒤 성적.
 *
 * 앞 구간 = 뜬 때 → 갈아끼운 때, 그동안 모은 조회수(viewsAtRetitle)
 * 뒤 구간 = 갈아끼운 때 → 지금, 그 뒤로 더 붙은 조회수(views - viewsAtRetitle)
 *
 * ★쇼츠는 뒤로 갈수록 힘이 빠지는 것이 보통이라, **뒤가 앞보다 높으면** 바꾼 보람이
 *   있었다고 볼 만하다. 판단은 사람이 한다 — 여기서는 두 숫자를 나란히 놓기만 한다.
 */
function 제목갈이(u: UploadRec, 기준ms: number, 지금조회: number) {
  const 잰때 = u.retitledAt ?? 0;
  if (!잰때 || !Number.isFinite(기준ms) || 잰때 <= 기준ms) {
    return { swapped: false, titleA: "", perHourA: 0, perHourB: 0 };
  }
  const 앞시간 = Math.max(0.25, (잰때 - 기준ms) / 3600_000);
  const 뒤시간 = Math.max(0.25, (Date.now() - 잰때) / 3600_000);
  const 앞조회 = u.viewsAtRetitle ?? 0;
  const 뒤조회 = Math.max(0, 지금조회 - 앞조회);
  const 둥글 = (n: number) => Math.round(n * 10) / 10;
  return {
    swapped: true,
    titleA: u.titleA ?? "",
    perHourA: 둥글(앞조회 / 앞시간),
    perHourB: 둥글(뒤조회 / 뒤시간),
  };
}

/** 화면에 세울 줄들. 시간당 조회수가 높은 것부터. */
export function statsRows(state: State): StatsRow[] {
  const rows: StatsRow[] = [];
  for (const u of state.uploads) {
    const s: StatRec | undefined = state.stats[u.id];
    /* ★시간당 조회수는 **뜬 때**부터 세야 한다 (2026-08-22).
       공개 슬롯을 쓰면 새벽에 올려 저녁에 뜨는 일이 흔한데, 올린 때부터 세면
       뜬 지 한 시간짜리가 열네 시간짜리로 계산돼 **열네 배로 깎였다.**
       성적 탭은 이 눈금으로 줄을 세우므로, 예약해서 올린 편이 무조건 바닥에 깔렸다. */
    const 뜬때 = Date.parse(u.publishAt || "");
    const 올린때 = Date.parse(u.at);
    const t = Number.isFinite(뜬때) ? 뜬때 : 올린때;
    const 아직 = Number.isFinite(t) && t > Date.now();
    const hours = !아직 && Number.isFinite(t) ? Math.max(0.25, (Date.now() - t) / 3600_000) : 0;
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
      /* ★이 컴퓨터 시간 꼴로 적는다. `toISOString()` 은 세계표준시라, 화면이
         그대로 잘라 쓰면 아홉 시간 어긋난다 (실수기록 3번과 같은 함정). */
      since: Number.isFinite(t) ? localStamp(new Date(t)) : u.at,
      pending: 아직,
      engage: views ? Math.round(((s!.likes + s!.comments) / views) * 10000) / 100 : 0,
      gone: !!s?.gone,
      measured: !!s,
      ...제목갈이(u, t, views),
    });
  }
  // 아직 안 뜬 편은 성적이 없는 것이지 못한 것이 아니다 — 줄 끝에 따로 놓는다
  return rows.sort((a, b) =>
    (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || b.perHour - a.perHour
  );
}

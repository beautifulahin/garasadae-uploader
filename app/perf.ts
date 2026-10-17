// 채널 성적 자료 — 지표를 읽어(갱신) 성적.json 에 두고, 화면은 그 저장본만 본다. (파이썬 dashboard.py 의 자료 계산 부분)
//
// 가장 중요한 약속
//   **화면을 열 때·놀 때는 유튜브를 부르지 않는다.** 읽는 시점은 사람이 정한다 — 「전체 갱신」 또는 채널별 ↻ 를 누를 때만
//   perfFetch() 가 돈다. 할당량은 하루치가 정해져 있고 업로드와 같은 프로젝트를 쓴다. 화면을 열 때마다 몰래 API 를 부르면
//   언제 얼마나 쓰는지 사람이 알 수 없다. (perfFor/perfLoad/dailyCached/… 는 전부 파일만 읽는다.)
//
// 성적.json 꼴 (파이썬이 쓰던 것과 같다)
//   { 채널이름: { _at, daily:[편수, 근거], rows:[…최근 30편], 전체조회:[{id,views}], 톱30:[…], 전체편수, insight, 차단, 실종, err } }
import { dataPath, log, readJson, recordLine, withFileLock, writeJson, 줄서서 } from "./paths.ts";
import { dateOnly, instantToWall, wallNow } from "./clock.ts";
import type { Wall } from "./clock.ts";
import { loadChannels } from "./channels.ts";
import type { ChannelConf, Channels } from "./channels.ts";
import { readLedger } from "./ledger.ts";
import { resolve, ytFor } from "./ytcore.ts";
import { videosList } from "./youtube.ts";
import { fetchProfile, loadProfiles, remember, statisticsState } from "./profile.ts";
import { loadSubs, record as recordSubs, summary as subsSummary } from "./subs.ts";
import type { SubSummary } from "./subs.ts";
import { judge } from "./spike.ts";
import type { SpikeResult } from "./spike.ts";
import { fetchAll, periodSummary } from "./analytics.ts";
import { learn } from "./insight.ts";
import type { Insight } from "./insight.ts";
import * as lift from "./lift.ts";
import {
  RECENT, commaFloat, commaInt, cut, decideFromRows, mmdd, msgOf, multiChannelMetrics, pyInt, pyRound, recentPerformance,
} from "./stats.ts";
import type { PerfRow, Rule } from "./stats.ts";

type Obj = Record<string, any>;

export const perfPath = () => dataPath("성적.json");

/** 성적.json 에 남는 영상 한 줄 */
export interface PerfRowSaved {
  id: string; title: string; views: number; likes: number | null; comments: number | null;
  /** 하루 평균 조회수 */
  vpd: number;
  /** 올린 지 며칠 */
  age: number;
  /** 올린 날 글자 — 올해면 「10/16」, 아니면 「25/10/16」 (원본처럼 유튜브가 준 UTC 날짜) */
  at: string;
}

export interface PerfEntry {
  _at?: number;
  daily?: [number, string] | null;
  rows: PerfRowSaved[];
  전체조회?: { id: string; views: number }[];
  톱30?: PerfRowSaved[];
  전체편수?: number;
  insight?: Insight;
  차단?: Record<string, number>;
  실종?: string[];
  err?: string;
}
export type PerfCache = Record<string, PerfEntry>;

/* ============================================================ 저장본 읽고 쓰기 */

/** 성적 저장본 전체. 없거나 깨졌으면 빈 값. */
export async function perfLoad(): Promise<PerfCache> {
  return await readJson<PerfCache>(perfPath(), {});
}

/**
 * 성적 저장본을 쓴다. 못 써도 하던 일은 멈추지 않지만 이유는 남긴다 — 조용히 넘기면 왜 성적이 안 남는지 알 수 없다.
 * (파이썬은 JSON 으로 못 적는 꼴 — 튜플 열쇠 — 때문에 저장이 통째로 실패해 성적까지 날아간 일이 있었다. 여기서는 그럴 꼴이 없다.)
 */
export async function perfSave(d: PerfCache): Promise<void> {
  try {
    await writeJson(perfPath(), d, { indent: 0 });
  } catch (e) {
    await log(`  성적을 저장하지 못했습니다 — ${e instanceof Error ? e.name : "오류"}: ${msgOf(e)}`);
  }
}

/**
 * 읽고 → 고치고 → 쓰기를 파일 잠금 안에서 한다. 갱신이 도는 동안 다른 곳(편수 기록 · 배운 것 기록)이 같은 파일을
 * 고쳐도 서로 덮어쓰지 않는다. (파이썬은 읽어 둔 통째를 마지막에 덮어써서 그 사이의 기록이 날아갈 수 있었다.)
 */
export async function perfUpdate<T>(고치기: (d: PerfCache) => T | Promise<T>): Promise<T> {
  const r = await withFileLock(dataPath("성적.lock"), async () => {
    const d = await perfLoad();
    const out = await 고치기(d);
    await perfSave(d);
    return out;
  });
  return r as T;
}

/**
 * 오늘 몇 개 올릴지 — **저장된 값만** 본다. 구글에 묻지 않는다. (파이썬: run.daily_for_channel 의 live=False)
 * 고정이면 그 숫자, 아니면 갱신 때 적어 둔 값, 아직 안 읽었으면 기본값과 안내 문구.
 * 화면을 여는 것만으로 할당량이 나가면 안 된다 — 갱신은 사람이 누른다.
 */
export async function dailyOf(name: string, cf: Obj = {}): Promise<[number, string]> {
  if (cf.daily_rule === "fixed") {
    const n = 필수정수(cf.daily ?? 1);
    return [n, `고정 ${n}개`];
  }
  const got = await dailyCached(name);
  if (got) return got;
  return [필수정수(cf.daily_fallback ?? 1), "아직 안 읽음 — [갱신]을 누르면 조회수로 정합니다"];
}

/** 적어 둔 「오늘 몇 개」. 없으면 null. */
export async function dailyCached(name: string): Promise<[number, string] | null> {
  const d = (await perfLoad())[name]?.daily;
  return d ? [Math.trunc(Number(d[0])), String(d[1])] : null;
}

/** 저장해 둔 「무엇이 통했나」. 없으면 null — 구글에 묻지 않는다. */
export async function insightCached(name: string): Promise<Insight | null> {
  return (await perfLoad())[name]?.insight || null;
}

export async function insightRemember(name: string, ins: Insight): Promise<void> {
  await perfUpdate((c) => { (c[name] ??= { rows: [] }).insight = ins; });
}

/** 이 채널 지표를 한 번이라도 읽었는가. */
export async function hasPerf(name: string): Promise<boolean> {
  const rows = (await perfLoad())[name]?.rows;
  return rows !== undefined && rows !== null;
}

export async function dailyRemember(name: string, r: [number, string]): Promise<void> {
  await perfUpdate((c) => { (c[name] ??= { rows: [] }).daily = [Math.trunc(Number(r[0])), String(r[1])]; });
}

/** 화면에 쓸 성적. **저장된 값만** 읽는다. 구글에 묻지 않는다. (파이썬: perf_for) */
export async function perfFor(_chans?: Channels): Promise<PerfCache> {
  return await perfLoad();
}

/* ============================================================ 읽어 오기 (사람이 갱신을 눌렀을 때만) */

const 올해글자 = (pub: Date | null): string => {
  if (!pub) return "";
  // 원본은 유튜브가 준 시각(UTC)의 날짜를 그대로 적는다 — 같은 파일을 두 프로그램이 읽으므로 같은 날짜가 나와야 한다.
  const y = pub.getUTCFullYear();
  const mm = String(pub.getUTCMonth() + 1).padStart(2, "0"), dd = String(pub.getUTCDate()).padStart(2, "0");
  return y === wallNow().getUTCFullYear() ? `${mm}/${dd}` : `${String(y % 100).padStart(2, "0")}/${mm}/${dd}`;
};

function 줄바꾸기(r: PerfRow): PerfRowSaved {
  return {
    // 영상ID 를 함께 남긴다. 제목으로 짝을 찾으면 제목이 바뀐 영상을 놓친다(실제로 10개 중 4개를 못 찾았다). id 는 안 바뀐다.
    id: r.id ?? "", title: r.title, views: r.views, likes: r.likes, comments: r.comments,
    vpd: pyRound(r.views_per_day, 1), age: pyRound(r.age_days, 2), at: 올해글자(r.published),
  };
}

const 배움_묵힘초 = 20 * 3600;

/** 지금 도는 갱신 — 같은 이름 묶음을 또 시키면 새로 돌리지 않고 이 일에 합류한다 */
const 진행중 = new Map<string, Promise<PerfCache>>();

/**
 * 구글에 실제로 물어본다. (파이썬: dashboard.perf_fetch — 「지표 갱신」 단추가 하는 일)
 *
 * 비용 (2026-08-28 에 크게 줄였다)
 *   채널당 1유닛(목록) + 전체 1유닛(일괄 통계) + 채널당 1유닛(구독자) + 채널당 1유닛(저작권 흔적)
 *   배운 것(길이·시간대)은 20시간 안에는 어제 것을 쓴다 — 아니면 채널당 1~2유닛이 더 든다.
 *   스튜디오 지표(Analytics)는 딴 지갑이라 Data API 유닛이 안 나간다.
 * 무엇을 없앴나
 *   · channels.list 로 업로드 목록 id 를 묻던 것 → 채널ID 에서 계산(0유닛)
 *   · 통계를 채널마다 따로 묻던 것 → batchGetStats 로 전 채널 한 번에
 *   · **편수 규칙이 같은 영상을 다시 받아 오던 것** → 손에 든 줄로 계산 (이게 제일 컸다)
 *
 * 한 번 읽은 값은 파일에 남는다. 시간이 지났다고 알아서 다시 묻지 않는다 — 언제 새로 읽을지는 사람이 정한다.
 */
export function perfFetch(names: string[]): Promise<PerfCache> {
  // 「전체 갱신」 을 두 번 눌러도 유튜브에 두 번 묻지 않는다: 같은 이름 묶음이 이미 돌고 있으면 그 일에 합류한다.
  // 이름 묶음이 다르면 차례로 선다(두 갱신이 성적.json 을 동시에 고치지 않게). 끝난 뒤에 누르면 새로 읽는다.
  const 열쇠 = [...new Set(names)].sort().join("\u0000");
  const 돌고있음 = 진행중.get(열쇠);
  if (돌고있음) return 돌고있음;
  const 일 = 줄서서("성적갱신", () => perfFetchNow(names)).finally(() => 진행중.delete(열쇠));
  진행중.set(열쇠, 일);
  return 일;
}

async function perfFetchNow(names: string[]): Promise<PerfCache> {
  const cache = await perfLoad();
  const chans = loadChannels();

  // 목록·통계를 **한꺼번에** 받는다. 채널을 하나씩 도는 것보다 훨씬 싸다.
  let 모두: Record<string, PerfRow[]> = {};
  try {
    모두 = await multiChannelMetrics(names, null); // 전 영상 — 상위 30용
  } catch (e) {
    await log(`  지표를 한꺼번에 읽지 못했습니다 — ${e instanceof Error ? e.name : "오류"}: ${cut(msgOf(e), 80)}`);
  }

  // 스튜디오 지표(Analytics)도 **같은 갱신 버튼**으로 함께 받는다. 토큰이 없는 이름(같은 채널의 롱폼 별칭)은 걸러야 조용하다.
  try {
    await fetchAll(names.filter((n) => resolve(n)), true);
  } catch (e) {
    await log(`  스튜디오 지표 받기 실패 — ${e instanceof Error ? e.name : "오류"}: ${cut(msgOf(e), 80)}`);
  }

  const 건드림: string[] = [];
  for (const name of names) {
    const rows전체 = 모두[name];
    // 이후 계산(오늘 편수·통한 것)은 예전대로 **최근 30편**으로 — 전 영상을 먹이면 잣대가 옛 영상에 끌려간다.
    let rows: PerfRow[] | null = rows전체 !== undefined ? rows전체.slice(0, RECENT) : null;
    if (rows === null) {
      try {
        rows = await recentPerformance(name); // 대비책
      } catch (e) {
        (cache[name] ??= { rows: [] }).err = cut(msgOf(e), 80);
        건드림.push(name);
        continue;
      }
    }
    건드림.push(name);
    const keep = cache[name]?.daily ?? null;
    // ★ 배운 것도 미리 챙긴다. 바로 아래에서 cache[name] 을 통째로 갈아 끼우므로, 여기서 안 빼 두면 옛 값이 지워지고
    //   캐시가 영영 안 먹는다. (실제로 그래서 하루 한 번만 읽게 해 놓고도 매번 다시 읽었다)
    const 옛배움 = cache[name]?.insight;
    const 항목: PerfEntry = {
      _at: Date.now() / 1000,
      daily: keep,
      rows: rows.map(줄바꾸기),
    };
    cache[name] = 항목;

    // 기본 rows 는 최근 업로드 30편이라 예약 비공개가 앞을 채우면 건강 검사가 공개 영상 타율을 하나도 못 본다. 이미 받은 전체
    // 영상의 ID·조회수만 보관한다. 공개 여부는 건강 검사가 평가 시점의 원장으로 걸러서, 나중에 맞춤을 해도 지표를 다시
    // 받지 않아도 된다.
    항목.전체조회 = (rows전체 ?? rows).filter((r) => r.id).map((r) => ({ id: r.id, views: r.views }));
    // 조회수 상위 30 — **채널 전 영상**에서 고른다(최근 30 재정렬이 아니다). 옛 히트작이 들어오도록.
    if (rows전체 && rows전체.length) {
      항목.톱30 = [...rows전체].sort((a, b) => b.views - a.views).slice(0, 30).map(줄바꾸기);
      항목.전체편수 = rows전체.length;
    }
    // 영상별 조회수를 오늘 날짜로 남긴다. 동반 상승을 보려면 「어제 얼마였나」 가 있어야 하는데, 지표는 누적값 하나만 준다.
    // 추가 비용은 0이다.
    try {
      await lift.record(name, 항목.rows);
    } catch (e) {
      await log(`  영상 기록 실패 — ${name}: ${cut(msgOf(e), 70)}`);
    }

    // 조회수가 바뀌면 오늘 편수도, 무엇이 통했는지도 달라진다. 같이 다시 본다.
    // 주의: 여기서 부르는 함수들이 성적.json 을 **다시 읽어 덮어쓰면** 방금 담은 rows 가 통째로 날아간다(실제로 그 사고가 있었다).
    // 그래서 결과만 받아 손에 든 cache 에 적고, 파일 저장은 맨 끝에 한 번만.
    try {
      const cf: ChannelConf | Obj = chans[name] ?? {};
      let n: number, why: string;
      if (cf.daily_rule === "fixed") {
        n = 필수정수(cf.daily ?? 1);
        why = `고정 ${n}개`;
      } else {
        // ★ 방금 받아 온 rows 로 계산한다 — 유닛 0. 예전에는 decide() 가 같은 영상을 다시 받아 왔다.
        [n, why] = decideFromRows(rows, cf.rule as Rule[] | undefined, 필수정수(cf.daily_fallback ?? 1));
      }
      항목.daily = [n, why];
    } catch (e) {
      await log(`  하루 편수 계산 실패 — ${name}: ${cut(msgOf(e), 70)}`);
    }

    // 배운 것(어느 길이·어느 시간대가 통하나)은 하루에도 거의 안 바뀐다. 그런데 갱신할 때마다 채널당 영상 40개를 다시
    // 읽고 있었다. 갱신 한 번에 채널당 2호출이 여기서만 나갔다. 하루 한 번이면 충분하다.
    const 옛: Partial<Insight> = 옛배움 ?? {};
    const 지금 = Date.now() / 1000;
    const 묵힘 = 지금 - Number(옛._at || 0);
    if (옛.learned !== undefined && 옛.learned !== null && 묵힘 < 배움_묵힘초) {
      항목.insight = 옛 as Insight; // 어제 배운 것을 그대로 쓴다
    } else {
      try {
        const got = await learn(name);
        got._at = 지금;
        항목.insight = got;
      } catch (e) {
        await log(`  배운 것 갱신 실패 — ${name}: ${cut(msgOf(e), 60)}`);
        if (Object.keys(옛).length) 항목.insight = 옛 as Insight;
      }
    }

    // 구독자 수를 오늘치로 한 점 남긴다(1유닛). 갱신을 누를 때만 찍히므로 하루에 한 번 눌러 두면 추이가 쌓인다.
    try {
      const pr = await remember(await fetchProfile(name));
      await recordSubs(name, pr.subscribers, pr.views, pr.videos);
    } catch (e) {
      await log(`  구독자 기록 실패 — ${name}: ${cut(msgOf(e), 70)}`);
    }

    // ── 저작권 흔적 — 갱신에 편승(채널당 1유닛) ──────────────────
    // 지역 차단(regionRestriction)은 소유권 주장이 걸렸다는 강한 흔적이고, 원장의 최근 영상이 목록 응답에서 사라졌으면
    // 내려간 것일 수 있다. 채널 경고 수 자체는 API 가 안 준다(스튜디오 전용).
    try {
      const rows2 = 항목.rows;
      const ids2: string[] = rows2.filter((r) => r.id).map((r) => r.id);
      // 재생목록에서 같이 사라진 영상은 rows 만으론 못 잡는다(한 채널 한 편이 실제로 그랬다). **원장의 최근 편**도 함께 물어본다.
      const 제목표: Record<string, string> = {};
      const 최근원장 = readLedger().filter((r) => (r["채널"] ?? "").trim() === name).slice(-10);
      for (const r of 최근원장) {
        const vid2 = (r["영상ID"] ?? "").trim();
        if (vid2 && !ids2.includes(vid2)) {
          ids2.push(vid2);
          제목표[vid2] = cut(r["제목"] ?? "", 30);
        }
      }
      const 물을것 = ids2.slice(0, 50);
      const 차단: Record<string, number> = {};
      let 실종2: string[] = [];
      if (물을것.length) {
        const yt2 = await ytFor(name);
        const 받은 = await videosList(yt2, 물을것, "contentDetails,status");
        const 돌아온 = new Set<string>();
        for (const it2 of 받은) {
          돌아온.add(it2.id);
          const 막힌: unknown[] = it2.contentDetails?.regionRestriction?.blocked ?? [];
          if (막힌.length) 차단[it2.id] = 막힌.length;
        }
        // 물었는데 응답에 없는 id = 유튜브에서 사라진 영상
        const 안온 = new Set(물을것.filter((v) => !돌아온.has(v)));
        실종2 = [
          ...rows2.filter((r) => 안온.has(r.id)).map((r) => cut(r.title, 30)),
          ...물을것.filter((v) => 안온.has(v) && v in 제목표).map((v) => 제목표[v]),
        ];
      }
      항목.차단 = 차단;
      항목.실종 = 실종2;
    } catch (e) {
      await log(`  저작권 흔적 스캔 실패 — ${name}: ${cut(msgOf(e), 70)}`);
    }
  }

  // 저장은 맨 끝에 한 번. 읽는 동안 다른 곳이 고친 다른 채널 칸은 지우지 않고, 이번에 건드린 칸만 갈아 끼운다.
  return await perfUpdate((cur) => {
    for (const name of 건드림) cur[name] = cache[name];
    return structuredClone(cur);
  });
}

/** 파이썬 int(값) — 못 읽으면 던진다(바깥의 try 가 그 채널의 편수 계산만 건너뛴다) */
function 필수정수(v: unknown): number {
  const n = pyInt(v);
  if (n === null) throw new Error(`정수가 아닙니다: ${String(v)}`);
  return n;
}

/* ============================================================ 급등 · 구독 증감 · 수확 */

/** 최근 3일 급등 판정. 없어도 화면은 떠야 하므로 감싼다. (파이썬: _spike) */
export async function spikeOf(name: string): Promise<SpikeResult> {
  try {
    return await judge(name);
  } catch (e) {
    await recordLine("서버.log", `급등 판정 실패 — ${name}: ${cut(msgOf(e), 70)}`);
    return { 급등: false, 조회: null, 구독: null, 말: "", 점수: 0, 남은날: 0 };
  }
}

/** 구독자 증감. 기록이 없어도 화면은 떠야 하므로 감싼다. (파이썬: _subgrow) */
export async function growSummary(name: string): Promise<SubSummary> {
  try {
    return await subsSummary(name);
  } catch (e) {
    await recordLine("서버.log", `구독자 증감 요약 실패 — ${name}: ${cut(msgOf(e), 70)}`);
    return { 점수: 0, 최근: null, 하루: null, 이레: null, 한달: null, 믿음: false, 말: "" };
  }
}

export interface Harvest {
  차수: number; 비율: number; 전부: boolean; 달성: boolean; 이름?: string; 설명?: string;
  /** 화면이 막대를 줄마다 그리려고 쓰는 숫자들 (없으면 화면이 설명 글에서 읽는다) */
  구독?: number; 쇼츠조회?: number | null; 롱폼시청?: number | null;
  기준?: { 구독자: number; 쇼츠조회90: number; 시청시간365: number };
}

/**
 * 「N차 수확」 진행. 기준은 policy.json 의 「수확기준」 한 곳(읽기 전용). 예외는 삼킨다. (파이썬: _수확)
 * `subs` 를 주면 그것을 구독자 수로 쓴다 — 같은 channel_id 로 묶인 칸은 대표 칸의 구독자를 써야 한다.
 */
export async function harvest(name: string, subs?: number | null): Promise<Harvest> {
  const 빈: Harvest = { 차수: 1, 비율: 0, 전부: false, 달성: false };
  try {
    const pol = await readJson<Obj>(dataPath("policy.json"), {});
    const 기준: Obj[] = Array.isArray(pol.수확기준) ? pol.수확기준 : [];
    if (!기준.length) return 빈;

    let 구독: number | null | undefined;
    if (subs !== null && subs !== undefined) {
      구독 = subs;
    } else {
      const pr = await readJson<Obj>(dataPath("profiles.json"), {});
      const hit = Object.values(pr).find((v) => v && typeof v === "object" && (v as Obj).title === name) as Obj | undefined;
      구독 = hit ? hit.subscribers ?? null : null;
    }
    // 매일 기록되는 구독기록.json 의 최근 값을 우선(profiles 는 갱신이 멈춰 있을 수 있다)
    {
      const g = (await loadSubs())[name] ?? {};
      const 날들 = Object.keys(g).sort();
      if (날들.length) 구독 = g[날들[날들.length - 1]]?.subs || 구독;
    }

    let 조회: number | null = null, 시청: number | null = null;
    try {
      const a = await periodSummary(name, 90), b = await periodSummary(name, 365);
      조회 = a ? a.쇼츠참여조회 : null;
      시청 = b ? b.롱폼시청시간 : null;
    } catch (e) {
      await log(`  수확 막대 자료를 못 읽었습니다 — ${name}: ${cut(msgOf(e), 60)}`);
    }

    const 비: number[] = [];
    for (const t of 기준) {
      const sr = (구독 || 0) / t.구독자;
      const 경로 = ([[조회, "쇼츠조회90"], [시청, "시청시간365"]] as const)
        .filter(([x]) => x !== null).map(([x, k]) => (x as number) / t[k]);
      비.push(경로.length ? Math.min(sr, Math.max(...경로)) : Math.min(sr, 0.99)); // 조회·시청 자료 없으면 충족으로 안 친다
    }
    const 달성 = 비[0] >= 1;
    const 이름 = (t: Obj) => t.이름 || `${t.차수}차`;
    const tip = (t: Obj) =>
      `구독 ${commaInt(구독 || 0)} · 90일 쇼츠 참여조회 ${조회 !== null ? commaInt(조회) : "자료 없음"}` +
      ` · 시청 ${시청 !== null ? `${commaFloat(시청)}h` : "자료 없음"}` +
      ` · 기준(구독 ${commaInt(t.구독자)}/참여조회 ${commaInt(Math.floor(t.쇼츠조회90 / 10000))}만 또는 시청 ${commaInt(t.시청시간365)}h)` +
      " · 구독자는 ±10 오차 가능 · 업로드 3편 조건은 별도 확인";
    const n = 비.findIndex((r) => r < 1);
    const 숫자 = (t: Obj) => ({
      구독: 구독 || 0, 쇼츠조회: 조회, 롱폼시청: 시청,
      기준: { 구독자: Number(t.구독자) || 0, 쇼츠조회90: Number(t.쇼츠조회90) || 0, 시청시간365: Number(t.시청시간365) || 0 },
    });
    if (n < 0) {
      const 끝 = 기준[기준.length - 1];
      return { 차수: 끝.차수, 이름: 이름(끝), 비율: 100, 전부: true, 달성: true, 설명: tip(끝), ...숫자(끝) };
    }
    return { 차수: 기준[n].차수, 이름: 이름(기준[n]), 비율: Math.trunc(비[n] * 100), 전부: false, 달성, 설명: tip(기준[n]), ...숫자(기준[n]) };
  } catch (e) {
    await recordLine("서버.log", `수확 진행을 못 셌습니다 — ${name}: ${cut(msgOf(e), 70)}`);
    return 빈;
  }
}

/**
 * 채널 이름마다 「N차 수확」 진행을 한꺼번에. (파이썬: dashboard.gather 의 수확 묶음)
 * 같은 channel_id 를 두 이름으로 등록했으면(쇼츠용/롱폼용) 분석 자료가 channel_id 하나 기준이라 수확 막대를 **한 번만** 잰다.
 * 자료가 있는 칸(롱폼 칸 우선)의 값을 쓰고, 구독자는 channel_id 의 것을 쓴다.
 */
export async function harvestMap(chans: Channels = loadChannels()): Promise<Record<string, Harvest>> {
  const profs = await loadProfiles();
  const 묶음 = new Map<string, string[]>();
  for (const [n, cf] of Object.entries(chans)) {
    if (n.startsWith("_") || !cf?.channel_id) continue;
    묶음.set(cf.channel_id, [...(묶음.get(cf.channel_id) ?? []), n]);
  }
  const 값: Record<string, Harvest> = {};
  for (const [cid, ns0] of 묶음) {
    if (ns0.length < 2) continue;
    const 롱폼 = (n: string) => !!(chans[n].allow_not_short || chans[n].롱폼);
    // 롱폼 칸 먼저(파이썬 sorted(key=not 롱폼) — 같은 값끼리는 등록한 차례를 지킨다)
    const ns = [...ns0].sort((a, b) => Number(!롱폼(a)) - Number(!롱폼(b)));
    let 용 = ns[0];
    try {
      for (const n of ns) {
        if ((await periodSummary(n, 90)) || (await periodSummary(n, 365))) { 용 = n; break; }
      }
    } catch (e) {
      await recordLine("서버.log", `수확 묶음 — 분석 자료를 못 읽었습니다: ${cut(msgOf(e), 60)}`);
    }
    값[cid] = await harvest(용, profs[cid]?.subscribers || 0);
  }
  const out: Record<string, Harvest> = {};
  for (const [n, cf] of Object.entries(chans)) {
    if (n.startsWith("_")) continue;
    const cid = cf?.channel_id ?? "";
    out[n] = cid && cid in 값 ? 값[cid] : await harvest(n);
  }
  return out;
}

/* ============================================================ 구독자 한 장 (자료만 — 화면은 메인이 그린다) */

/** 구독자 증감 딱지를 그리는 데 필요한 값 */
export interface GrowView {
  /** 증감(어제 → 없으면 7일 → 30일). 비교할 점이 없으면 null */
  n: number | null;
  /** 합계 칸에 붙이는 말: 어제 / 일주일 / 한 달 */
  unit: string;
  /** 카드 딱지에 붙이는 말: 어제 / 주 / 달 */
  unitShort: string;
  /** n 이 없을 때 보여 줄 말 */
  wait: string;
  /** 그 까닭 (풍선 도움말) */
  why: string;
  /** 카드 딱지 풍선 도움말 (subgrow.말) */
  tip: string;
  dir: "up" | "dn" | "flat" | "wait";
  /** 카드 딱지를 보여 줄까 — 기록이 한 점도 없으면 false */
  chip: boolean;
}

/** 증감을 아직 못 낼 때, 언제 나오는지를 말해 준다. 「쌓는 중」 만 띄우면 언제까지 기다려야 하는지 알 수 없다. (파이썬: _grow_word) */
export function growWord(g: Partial<SubSummary>): string {
  const 점 = g.점수 || 0;
  if (점 === 0) return "갱신을 누르세요";
  if (점 === 1) return "내일부터";
  return `${점}일째 변동 10명 미만`;
}

export function growWhy(g: Partial<SubSummary>): string {
  const 점 = g.점수 || 0;
  if (점 <= 1) {
    return "구독자 증감은 어제 값과 비교해서 냅니다. 오늘이 첫 기록이라 비교할 대상이 없습니다. 내일 갱신하면 숫자가 나옵니다.";
  }
  return "YouTube API는 구독자 수를 유효숫자 3자리로 내림해 줍니다. 표시 단위보다 작은 변화는 숫자가 그대로일 수 있습니다.";
}

/** 구독자 증감 딱지 자료. 반올림(10명 단위) 때문에 못 믿는 값을 0 이라고 적으면 늘고 있는 채널이 멈춘 것처럼 보인다. (파이썬: _grow_chip / _subs_num) */
export function growView(g: Partial<SubSummary>): GrowView {
  let n: number | null = g.하루 ?? null;
  let unit = "어제", unitShort = "어제";
  if (n === null) {
    for (const [k, u, us] of [["이레", "일주일", "주"], ["한달", "한 달", "달"]] as const) {
      if (g[k] !== null && g[k] !== undefined) { n = g[k] as number; unit = u; unitShort = us; break; }
    }
  }
  return {
    n, unit, unitShort, wait: growWord(g), why: growWhy(g), tip: g.말 ?? "",
    dir: n === null ? "wait" : n > 0 ? "up" : n < 0 ? "dn" : "flat",
    chip: !!g.점수,
  };
}

/** 채널 하나의 구독자 한 장 */
export interface SubSnap {
  cid: string;
  handle: string;
  /** 구독자 수. 숨겼으면 null */
  subs: number | null;
  /** 구독자를 읽은 때(초) */
  at: number | null;
  /** 1명 단위로 정확한가 */
  exact: boolean;
  source: string | null;
  /** 「구독 8,320」 / 「구독 비공개」 */
  subsText: string;
  grow: GrowView;
  subgrow: SubSummary;
  /** 풍선 도움말 */
  title: string;
}

/**
 * 이미 받은 구독 총계를 카드·성적표 양쪽에 같은 꼴로 보낸다. 유튜브를 부르지 않는다. (파이썬: subscriber_snapshot — 자료 부분)
 * 같은 채널을 두 이름으로 등록해도(쇼츠/롱폼) 같은 값이 나온다.
 */
export async function subscriberSnapshot(chans: Channels): Promise<Record<string, SubSnap>> {
  const profs = await loadProfiles();
  const state = await statisticsState();
  const result: Record<string, SubSnap> = {};
  for (const [name, cf] of Object.entries(chans)) {
    if (name.startsWith("_")) continue;
    const cid = cf.channel_id ?? "";
    const pr = profs[cid] ?? {};
    const subgrow = await growSummary(name);
    const at: number | null = pr.subscribers_at || pr.statistics_at || null;
    const error = state.exact_errors?.[cid] || state.errors?.[cid] || state.errors?.request;
    const w: Wall | null = at ? instantToWall(new Date(at * 1000)) : null;
    const when = w
      ? `${mmdd(w)} ${String(w.getUTCHours()).padStart(2, "0")}:${String(w.getUTCMinutes()).padStart(2, "0")}:${String(w.getUTCSeconds()).padStart(2, "0")}`
      : "기록 없음";
    const source = pr.subscribers_source === "youtube_studio_dashboard" ? "스튜디오 정확값" : "YouTube";
    const precision = pr.subscribers_exact ? "1명 단위" : "공개 수치 · 정확값 확인 대기";
    const subs: number | null = pr.subscribers ?? null;
    result[name] = {
      cid, handle: pr.handle ?? "", subs, at,
      exact: !!pr.subscribers_exact, source: pr.subscribers_source ?? null,
      subsText: subs !== null ? `구독 ${commaInt(subs)}` : "구독 비공개",
      grow: growView(subgrow), subgrow,
      title: `구독자 조회 ${when} · ${source} · ${precision} · 1분마다 조회` + (error ? ` · 최근 조회 실패: ${error}` : ""),
    };
  }
  return result;
}

/** 오늘(이 컴퓨터 날짜) 채널별로 몇 개 올라갔나 — 원장에서 센다. (파이썬: _오늘올린수) */
export function uploadedToday(): Record<string, number> {
  const 오늘 = dateOnly(wallNow());
  const 난: Record<string, number> = {};
  for (const r of readLedger()) {
    if ((r["업로드시각"] ?? "").slice(0, 10) === 오늘) {
      const ch = (r["채널"] ?? "").trim();
      난[ch] = (난[ch] ?? 0) + 1;
    }
  }
  return 난;
}

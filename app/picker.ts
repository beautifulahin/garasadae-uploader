// 수백 개가 쌓인 폴더에서 오늘 올릴 것을 고른다. (파이썬 picker.py)
//
// 고객사마다 방식을 정할 수 있다 (channels.json 의 pick).
//   "order"    파일 이름 순서대로. 연재물처럼 순서가 중요한 채널.
//   "oldest"   폴더에 들어온 지 오래된 것부터. 묵히지 않고 소진한다. (기본값)
//   "suggest"  앱이 점수를 매겨 추천하고, 관리자가 확인해서 고른다.
//   "manual"   관리자가 고른 것만 올린다. 고르지 않으면 아무것도 올리지 않는다.
//
// 추천 점수는 무엇으로 매기나
//   유튜브가 쇼츠를 어떻게 밀어줄지는 아무도 모른다. 그러니 「잘 될 영상」을 맞히는 척하지 않는다.
//   대신 **탈락하지 않을 영상**과 **오래 묵은 영상**을 위로 올린다.
//     · 세로 9:16 에 가까울수록          (규격에 정확히 맞음)
//     · 15~45초                          (쇼츠에서 가장 흔한 길이대)
//     · 폴더에 오래 있었을수록            (묵히지 않는다)
//     · 해상도 1080 세로에 가까울수록     (다운스케일 손실 없음)
//   근거는 화면에 함께 보여준다. 관리자가 납득하고 고를 수 있어야 추천이 쓸모 있다.
import { baseName, recordLine } from "./paths.ts";
import type { MediaInfo } from "./shorts.ts";
import { cut, fixed, pyRound } from "./stats.ts";

export const MODES = ["order", "oldest", "suggest", "manual"] as const;

/** 영상 파일과 잰 값 한 짝 */
export interface PickItem { path: string; info: MediaInfo }

/** 이 채널에서 배운 것 (insight.ts) — 잘 됐던 길이대만 쓴다 */
export interface InsightLike { best_dur?: [number, number] | number[] | null }

export interface Ranked { path: string; info: MediaInfo; pts: number; why: string[] }

/**
 * 파일이 폴더에 들어온 때(수정 시각, 밀리초). 읽을 수 없으면 「방금」 으로 친다 — 가장 나중에 고른다.
 * (원본은 파일이 사라지면 stat 에서 그대로 터졌다 — 고르는 도중 한 파일이 사라졌다고 목록 전체가 멈추지 않게 하되, 흔적은 남긴다.)
 */
function mtimeMs(path: string): number {
  try {
    return Deno.statSync(path).mtime?.getTime() ?? Date.now();
  } catch (e) {
    void recordLine("서버.log", `고르기 — ${baseName(path)} 의 수정 시각을 못 읽어 방금 들어온 것으로 칩니다(${cut(e instanceof Error ? e.message : String(e), 60)})`);
    return Date.now();
  }
}

/** 0~100 점과 그 근거. ins 를 주면 그 채널이 실제로 잘 됐던 길이를 우선한다. (파이썬: picker.score) */
export function score(path: string, info: MediaInfo, ins?: InsightLike | null): [number, string[]] {
  let pts = 0;
  const why: string[] = [];

  const ratio = info.w / info.h;
  const off = Math.abs(ratio - 9 / 16);
  if (off < 0.005) { pts += 30; why.push("9:16 정확"); }
  else if (off < 0.02) { pts += 22; why.push("9:16 근사"); }
  else pts += 8;

  const sec = info.sec;
  const learned = ins?.best_dur;
  if (learned) {
    // 이 채널이 실제로 잘 됐던 길이대를 쓴다. 일반 기준보다 항상 낫다.
    const [lo, hi] = learned;
    if (lo <= sec && sec < hi) { pts += 34; why.push(`${fixed(sec, 0)}초 ★이 채널 최적 ${lo}~${hi}초`); }
    else if (lo - 15 <= sec && sec < hi + 15) { pts += 22; why.push(`${fixed(sec, 0)}초 (최적에 근접)`); }
    else { pts += 9; why.push(`${fixed(sec, 0)}초`); }
  } else if (15 <= sec && sec <= 45) {
    pts += 30; why.push(`${fixed(sec, 0)}초 (흔한 길이대)`);
  } else if ((8 <= sec && sec < 15) || (45 < sec && sec <= 90)) {
    pts += 20; why.push(`${fixed(sec, 0)}초`);
  } else {
    pts += 10; why.push(`${fixed(sec, 0)}초`);
  }

  const days = (Date.now() - mtimeMs(path)) / 86_400_000;
  if (days >= 7) { pts += 25; why.push(`${fixed(days, 0)}일 묵음`); }
  else if (days >= 3) { pts += 18; why.push(`${fixed(days, 0)}일 묵음`); }
  else if (days >= 1) { pts += 12; why.push(`${fixed(days, 0)}일 전`); }
  else { pts += 6; why.push("오늘 들어옴"); }

  if (info.h >= 1920) { pts += 15; why.push("1080p"); }
  else if (info.h >= 1280) { pts += 11; why.push(`${info.h}p`); }
  else { pts += 5; why.push(`${info.h}p`); }

  return [Math.min(pts, 100), why];
}

/** 점수 높은 것부터. 같으면 이름 순. (파이썬: picker.rank) */
export function rank(items: PickItem[], ins?: InsightLike | null): Ranked[] {
  const out = items.map((x) => {
    const [pts, why] = score(x.path, x.info, ins);
    return { path: x.path, info: x.info, pts, why };
  });
  out.sort((a, b) => b.pts - a.pts || (baseName(a.path) < baseName(b.path) ? -1 : baseName(a.path) > baseName(b.path) ? 1 : 0));
  return out;
}

/**
 * (고른 것, 안내문) — items 는 이미 검사를 통과한 것들이다. (파이썬: picker.choose)
 * manual 에서 이름을 경로로 주든 파일 이름으로 주든 같게 본다(예전에는 경로를 넘기면 조용히 0개가 골라졌다).
 */
export function choose(
  items: PickItem[], mode: string, n: number, pickedNames?: string[] | null, ins?: InsightLike | null,
): { chosen: PickItem[]; note: string } {
  const m = (MODES as readonly string[]).includes(mode) ? mode : "oldest";

  if (m === "manual") {
    const want = new Set((pickedNames ?? []).map((x) => baseName(x)));
    if (!want.size) return { chosen: [], note: "직접 고르기 — 아직 고른 영상이 없습니다 (파일 이름으로 지정)" };
    const got = items.filter((x) => want.has(baseName(x.path)));
    const have = new Set(got.map((x) => baseName(x.path)));
    const missing = [...want].filter((x) => !have.has(x)).sort();
    let note = `직접 고른 ${got.length}개`;
    if (missing.length) note += ` · 찾지 못함: ${missing.join(", ")}`;
    return { chosen: got.slice(0, n), note };
  }

  if (m === "order") {
    const picked = [...items].sort((a, b) => (baseName(a.path) < baseName(b.path) ? -1 : baseName(a.path) > baseName(b.path) ? 1 : 0)).slice(0, n);
    return { chosen: picked, note: `이름 순서대로 ${picked.length}개` };
  }

  if (m === "suggest") {
    const picked = rank(items, ins).slice(0, n).map((r) => ({ path: r.path, info: r.info }));
    return { chosen: picked, note: `추천 상위 ${picked.length}개 (직접 바꿀 수 있습니다)` };
  }

  const picked = items.map((x) => ({ x, t: mtimeMs(x.path) })).sort((a, b) => a.t - b.t).slice(0, n).map((o) => o.x);
  return { chosen: picked, note: `오래된 것부터 ${picked.length}개` };
}

/** 추천 목록을 근거와 함께 줄로 돌려준다. (파이썬: picker.report — 찍는 대신 줄을 돌려준다) */
export function report(items: PickItem[], n: number, limit = 12, ins?: InsightLike | null): string[] {
  const ranked = rank(items, ins);
  const out = [`    추천 순위 (전체 ${ranked.length}개 중 상위 ${Math.min(limit, ranked.length)}개 · 오늘 ${n}개 예정)`];
  ranked.slice(0, limit).forEach((r, k) => {
    const idx = k + 1;
    const mark = idx <= n ? "◆" : " ";
    out.push(`    ${mark} ${String(idx).padStart(2)}. [${String(r.pts).padStart(3)}점] ${cut(baseName(r.path), 38).padEnd(38)} ${r.why.join(" · ")}`);
  });
  if (ranked.length > limit) out.push(`       … 나머지 ${ranked.length - limit}개`);
  return out;
}

/**
 * 같은 영상이 이름만 바꿔 여러 번 들어온 경우를 **묶어서** 돌려준다. (파이썬: picker.find_duplicates)
 * 길이(0.1초)와 파일 크기(1KB)가 모두 같으면 사실상 같은 파일로 본다. 중복을 올리면 슬롯도 낭비하고 유튜브가 duplicate 로
 * 거부할 수도 있다. 짝마다 한 줄씩 찍으면 6개가 겹칠 때 15줄이 나와 읽을 수 없으므로 무리로 묶는다.
 */
export function findDuplicates(items: PickItem[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const { path, info } of items) {
    const key = `${pyRound(info.sec, 1)}|${pyRound(info.mb * 1024)}`;
    const g = groups.get(key);
    if (g) g.push(path); else groups.set(key, [path]);
  }
  return [...groups.values()].filter((v) => v.length > 1)
    .map((v) => [...v].sort((a, b) => (baseName(a) < baseName(b) ? -1 : baseName(a) > baseName(b) ? 1 : 0)));
}

/** 이 폴더 재고가 며칠치인지. 떨어지기 전에 고객에게 요청해야 한다. (파이썬: picker.days_left) */
export function daysLeft(waiting: number, daily: number): { days: number; note: string } {
  if (daily <= 0) return { days: 0, note: "하루 편수가 0입니다" };
  const d = waiting / daily;
  if (d < 2) return { days: d, note: `재고 ${fixed(d, 1)}일치 — 곧 떨어집니다. 고객에게 영상을 요청하세요` };
  if (d < 5) return { days: d, note: `재고 ${fixed(d, 1)}일치 — 슬슬 채워야 합니다` };
  return { days: d, note: `재고 ${fixed(d, 1)}일치` };
}

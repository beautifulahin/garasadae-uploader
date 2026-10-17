// 폴더를 훑어 올린다 — 채널마다 검증 → 종류 판정 → 고르기 → 시각 정하기 → 담기/올리기. (파이썬: run.py)
//
//   run(false)                 무엇이 어떻게 될지만 본다 (아무것도 바꾸지 않음)
//   run(true, picks, ats, o)   실제로 올린다
//   cmdStatus / cmdCheck / cmdPreview / cmdLearn   현황·점검·미리보기 자료·성적
//
// 하는 일
//   오늘 편수를 정한다 → 폴더를 훑는다 → 이 채널 것이 맞는지 검증 → 쇼츠/롱폼 판정 → 같은 영상 묶음 경고 → 고른다
//   → 시각을 정한다 → (정한 시각까지) 발사대기에 담거나 그 자리에서 올린다 → 올린 파일은 '업로드완료' 로, 걸린 파일은 '검토필요' 로
//   공개는 올린 지 30분 뒤 심사를 확인한 다음에 한다(review.ts).
//
// 화면·명령줄이 같이 쓰도록 **print 가 아니라 say(줄) 콜백과 반환값(구조체)** 으로 말한다.
// 미리보기와 실제는 **같은 계산**(planChannel)에서 나온다 — 따로 세면 언젠가 어긋난다(함정 1.1: 「1개」라고 띄우고 7개가 올라갔다).
//
// 원본(파이썬)과 일부러 다른 점
//   · 쇼츠와 롱폼은 시각을 따로 셈한다(원본은 한 줄로 셌다). 공개 간격 규칙이 이미 꼴끼리 따로이기 때문이다(2026-09-25).
//   · 창에 다 못 넣는 편수는 다음 날로 이어 붙인다(원본은 마지막 시각에 겹쳐 쌓았다 — 4시간 간격이 깨졌다).
//   · 자동 계획은 오늘 이미 올렸거나 오늘 쏘려고 담아 둔 편수를 오늘 몫에서 뺀다 → 같은 날 두 번 돌려도 두 번 담지 않는다.
//   · 시각을 못 읽는 --at 은 올리지 않는다(원본은 조용히 「심사 후 즉시 공개」로 바꿔 바로 올렸다).
//   · 그 자리에서 올리는 것도 「담고(add) 곧바로 쏘는(fire)」 한 길로 보낸다 — 예약 작업과 같은 잠금·출구검사·알림·하루 한도 편성을 지나고,
//     일 한도에 걸려도 실패로 끝나지 않고 다음 날 대기열로 밀린다. 한밤(00~07시) 발사 금지 스위치도 같이 따른다(켜 둔 채 한밤에 누르면
//     큐에서 아침을 기다린다). (원본은 그 자리 올리기가 따로 있어 원장에 동시에 쓸 수 있었다.)
//   · 올리기가 동시에 둘 돌지 않게 잠근다(.run.lock).
import { baseName, cut, dataPath, recordLine, stemOf, withFileLock } from "./paths.ts";
import {
  addDays, addMinutes, dateOnly, isoWall, minuteWall, parseWall, systemZone, type Wall, wallNow,
} from "./clock.ts";
import { channelsPath, type Channels, type ChannelConf, loadChannels, verifyAll } from "./channels.ts";
import { loadStore, LookupError } from "./ytcore.ts";
import { checkChannelConf, checkFile, type UploadedMap } from "./verify.ts";
import {
  bar, future, MIN_GAP_MIN, normalizeWindow, plan as planTimes, SPARE_MIN, timeline, todayStr, type Window,
} from "./schedule.ts";
import { check, type Kind, saveCache } from "./shorts.ts";
import type { MediaInfo } from "./shorts.ts";
import { choose, daysLeft, findDuplicates, rank as rankItems, report as pickReport } from "./picker.ts";
import { expandHome, markHold, pendingFiles, summary } from "./folders.ts";
import { add, fire, isLimitError, readQueue } from "./queue.ts";
import { type Job, uploadOne } from "./upload.ts";
import type { UploadHandle } from "./youtube.ts";
import { isLocked } from "./safety.ts";
import { DailyLimitReached, isApprovedPolicy, policyForChannel, reflow } from "./daily.ts";
import { GAP_HOURS, lastReservation } from "./receive.ts";
import { CHECK_AT } from "./review.ts";
import { commaFixed, decide, fixed, median, msgOf, perfTable, pyInt, recentPerformance } from "./stats.ts";
import { describe as describeInsight, type Insight, learn } from "./insight.ts";
import { dailyCached, dailyRemember, insightCached, insightRemember, perfLoad } from "./perf.ts";
import { readLedger, uploadedNames } from "./ledger.ts";
import { loadFor } from "./sidecar.ts";

type Obj = Record<string, any>;

/** 한 줄씩 말하는 길 — 콘솔이면 console.log, 화면이면 화면 기록으로 흘려보낸다 */
export type Say = (line: string) => void;

const nfc = (s: string) => s.normalize("NFC");
const 없음: Say = () => {};

/* ============================================================ 채널 불러오기 · 오늘 몇 개 */

/**
 * channels.json 의 채널들(이름이 _ 로 시작하는 메모 칸은 뺀다). 파일이 아직 없으면 빈 사전이 맞는 답이다. (파이썬: run.load_channels)
 * 예전에 여기서 프로그램을 끝내 버려 서버가 첫 화면을 **빈 응답**으로 죽인 적이 있다(2026-09-15 배포 시험).
 */
export function loadChannelsPlan(say: Say = console.log): Channels {
  let 있나 = true;
  try { Deno.statSync(channelsPath()); } catch { 있나 = false; }
  if (!있나) {
    say("  채널 설정이 아직 없습니다(channels.json) — 화면의 채널 탭에서 넣으면 됩니다");
    return {};
  }
  return loadChannels();
}

/**
 * 오늘 몇 개 올릴지 정한다. [편수, 근거 글] (파이썬: run.daily_for_channel)
 *
 * 조회수를 보고 정하는 규칙은 유튜브에 물어야 알 수 있고 채널당 1.5초쯤 걸린다. 화면을 열 때마다 물으면 매번 기다리게 되고
 * 할당량도 샌다. 그래서 한 번 알아낸 값을 적어 두고(성적.json), 다시 읽는 시점은 사람이 정한다(live=true 일 때만 묻는다).
 */
export async function dailyForChannel(name: string, cf: ChannelConf, live = false): Promise<[number, string]> {
  if (cf.daily_rule === "fixed") {
    const n = pyInt(cf.daily ?? 1) ?? 1;
    return [n, `고정 ${n}개`];
  }
  const 기본 = pyInt(cf.daily_fallback ?? 1) ?? 1;
  if (!live) {
    const got = await dailyCached(name);
    if (got) return got;
    // 아직 안 읽었으면 여기서 구글에 묻지 않는다 — 화면을 여는 것만으로 할당량이 나가면 안 된다. 갱신은 사람이 누른다.
    return [기본, "아직 안 읽음 — [갱신]을 누르면 조회수로 정합니다"];
  }
  const r = await decide(cf.channel_id || name, cf.rule, 기본);
  await dailyRemember(name, r);
  return r;
}

/* ============================================================ 점검 · 현황 */

export interface CheckRow { name: string; ok: boolean; folder: string; problems: string[] }
export interface CheckResult { rows: CheckRow[]; total: number; bad: number }

/** 채널 설정이 온전한지 본다. (파이썬: run.cmd_check) */
export async function cmdCheck(chans: Channels, say: Say = console.log): Promise<CheckResult> {
  const tokens = loadStore();
  const rows: CheckRow[] = [];
  say(`채널 ${Object.keys(chans).length}개 점검\n`);
  let bad = 0;
  for (const [name, cf] of Object.entries(chans)) {
    const problems = checkChannelConf(name, cf, tokens);
    rows.push({ name, ok: problems.length === 0, folder: String(cf.folder ?? ""), problems });
    if (problems.length) {
      bad++;
      say(`  ✕ ${name}`);
      for (const b of problems) say(`      ${b}`);
    } else {
      say(`  ✓ ${name}  (${cf.folder})`);
    }
  }
  say(`\n이상 없음 ${rows.length - bad}개 · 손봐야 할 것 ${bad}개`);
  return { rows, total: rows.length, bad };
}

/** 저장해 둔 성적 줄들 — 열쇠는 채널 이름(성적.json)인데 부르는 쪽은 채널ID 를 줄 수도 있다 */
async function 저장된성적(key: string): Promise<Obj[]> {
  const cache = await perfLoad();
  if (cache[key]?.rows?.length) return cache[key].rows as unknown as Obj[];
  for (const [n, cf] of Object.entries(loadChannels())) {
    if (cf.channel_id === key && cache[n]?.rows?.length) return cache[n].rows as unknown as Obj[];
  }
  return [];
}

/**
 * 직전 성과를 한 줄로. 현황판에 자동으로 따라붙는다. (파이썬: run.perf_brief)
 * 기본은 **저장해 둔 성적만** 읽는다(유튜브를 안 부른다). live 일 때만 새로 묻는다 — 원본은 현황을 볼 때마다 채널당 2유닛을 썼다.
 */
export async function perfBrief(key: string, o: { live?: boolean } = {}): Promise<string> {
  let 조회: number[] = [], 좋아요율: number[] = [], 댓글: number[] = [];
  try {
    if (o.live) {
      const rows = await recentPerformance(key);
      조회 = rows.map((r) => r.views);
      좋아요율 = rows.map((r) => r.like_rate).filter((x): x is number => x !== null && x !== undefined);
      댓글 = rows.map((r) => r.comments).filter((x): x is number => x !== null && x !== undefined);
    } else {
      const rows = await 저장된성적(key);
      조회 = rows.map((r) => Number(r.views) || 0);
      좋아요율 = rows.filter((r) => r.likes !== null && r.likes !== undefined && Number(r.views))
        .map((r) => (Number(r.likes) / Number(r.views)) * 100);
      댓글 = rows.map((r) => r.comments).filter((x) => x !== null && x !== undefined).map(Number);
    }
  } catch {
    return ""; // 성적이 없다고 현황이 안 떠서는 안 된다
  }
  if (!조회.length) return "";
  const k = (n: number) => n >= 10000 ? `${fixed(n / 10000, 1)}만` : commaFixed(n, 0);
  const bits = [`직전 ${조회.length}개 중앙 ${k(median(조회))}`, `최고 ${k(Math.max(...조회))}`];
  if (좋아요율.length) bits.push(`좋아요 ${fixed(median(좋아요율), 1)}%`);
  if (댓글.length) bits.push(`댓글 중앙 ${fixed(median(댓글), 0)}`);
  return bits.join(" · ");
}

export interface FolderCount { 대기: number; 완료: number; 검토필요: number }
export interface StatusRow {
  name: string; folder: string;
  /** 폴더를 못 읽으면 null */
  count: FolderCount | null;
  daily: number; why: string;
  /** 재고가 며칠치인가 */
  days: number | null;
  brief: string;
}
export interface StatusResult { rows: StatusRow[]; total: FolderCount }

/** 채널별 현황과 오늘 편수를 본다. (파이썬: run.cmd_status) */
export async function cmdStatus(chans: Channels, say: Say = console.log, o: { live?: boolean } = {}): Promise<StatusResult> {
  const rows: StatusRow[] = [];
  for (const [name, cf] of Object.entries(chans)) {
    const folder = expandHome(String(cf.folder ?? ""));
    let isDir = false;
    try { isDir = !!folder && Deno.statSync(folder).isDirectory; } catch { /* 폴더가 없다 */ }
    if (!isDir) {
      rows.push({ name, folder, count: null, daily: 0, why: "폴더 없음", days: null, brief: "" });
      continue;
    }
    const count = await summary(folder);
    const [n, why] = await dailyForChannel(name, cf, !!o.live);
    const { days } = daysLeft(count.대기, n);
    rows.push({ name, folder, count, daily: n, why, days, brief: await perfBrief(cf.channel_id || name, o) });
  }

  const peak = Math.max(1, ...rows.filter((r) => r.count).map((r) => r.count!.대기 + r.count!.완료));
  say("");
  say(`  ${"고객사".padEnd(20)} ${"대기".padStart(4)} ${"완료".padStart(4)} ${"검토".padStart(4)}  ${"재고".padStart(6)}  진행 · 직전 성과`);
  say("  " + "─".repeat(78));
  const 빈칸 = `  ${"".padEnd(20)} ${"".padStart(4)} ${"".padStart(4)} ${"".padStart(4)}  ${"".padStart(6)}  `;
  for (const r of rows) {
    if (!r.count) {
      say(`  ${r.name.padEnd(20)} ${"—".padStart(4)} ${"—".padStart(4)} ${"—".padStart(4)}  ${"—".padStart(6)}  ⚠ ${r.why}`);
      continue;
    }
    const flag = (r.days ?? 0) < 2 ? "⚠" : " ";
    say(`  ${r.name.padEnd(20)} ${String(r.count.대기).padStart(4)} ${String(r.count.완료).padStart(4)} ` +
      `${String(r.count.검토필요).padStart(4)}  ${fixed(r.days ?? 0, 1).padStart(5)}일${flag} ${bar(r.count.대기, peak, 14, "▓")}`);
    say(`${빈칸}${bar(r.count.완료, peak, 14, "█")}  오늘 ${r.daily}개 — ${r.why}`);
    if (r.brief) say(`${빈칸}${r.brief}`);
  }
  const sum = (k: keyof FolderCount) => rows.reduce((a, r) => a + (r.count ? r.count[k] : 0), 0);
  const total: FolderCount = { 대기: sum("대기"), 완료: sum("완료"), 검토필요: sum("검토필요") };
  say("  " + "─".repeat(78));
  say(`  ${"합계".padEnd(20)} ${String(total.대기).padStart(4)} ${String(total.완료).padStart(4)} ${String(total.검토필요).padStart(4)}       ▓ 대기   █ 완료`);
  say("");
  return { rows, total };
}

export interface GuardResult { ok: boolean; fatal: string[]; warn: string[] }

/** 실행 전 점검. 빨강(치명)이 있으면 올리지 않는다. (파이썬: run.guard) */
export async function guard(chans: Channels, _go: boolean, say: Say = console.log): Promise<GuardResult> {
  const { fatal, warn } = await verifyAll(chans);
  for (const w of warn) say(`  ⚠ ${w}`);
  if (fatal.length) {
    say("\n폴더 확인이 필요해 실행하지 않습니다.\n");
    for (const f of fatal) say(`  ✕ ${f}`);
    say("\n채널 탭에서 폴더를 다시 정하거나 channels.json 을 고치세요.");
    return { ok: false, fatal, warn };
  }
  if (warn.length) say("");
  return { ok: true, fatal, warn };
}

/**
 * 맨 위 신호등 한 줄. (파이썬: run.lamp_line)
 * 문제를 모으는 일은 다른 모듈의 몫이라 숫자를 받아서 말만 만든다 — 화면은 그 숫자를 그대로 쓰면 된다.
 */
export function lampLine(c: { red: number; yellow: number }, say: Say = console.log): string {
  const 글 = c.red
    ? `  ● 오류 ${c.red}건 · 작업불이행·경고 ${c.yellow}건`
    : c.yellow ? `  ● 작업불이행·경고 ${c.yellow}건` : "  ● 정상";
  say("\n" + 글);
  return 글;
}

/* ============================================================ 계획 (미리보기와 실제가 함께 쓴다) */

/** 폴더에서 집어 올린, 검사를 통과한 영상 한 편 */
export interface Cand { path: string; name: string; info: MediaInfo; kind: Kind }

/** 한 편이 어떤 길로 나가나 — now: 그 자리에서 올림 · queue: 정한 시각까지 붙들어 둠 · approved: 승인형(담고 바로 쏨) */
export type Route = "now" | "queue" | "approved";

export interface PlannedItem {
  cand: Cand;
  /** 전체 후보 중 추천 순위 (고르기 방식과 상관없이 매긴다) */
  rank: number | null;
  /** 정한 시각 "YYYY-MM-DD HH:MM" — 없으면 심사가 끝나는 대로 */
  when: string | null;
  timeBy: "user" | "auto";
  route: Route;
  /** 발사대기에 담기는 그 모양 */
  job: Job;
  /** 일 한도 편성을 거친 뒤의 예상 — 올리기 시각(ISO)·공개 시각("YYYY-MM-DD HH:MM") */
  fireAt: string;
  publishAt: string;
  /** 한도 때문에 미뤄졌다면 그 말 */
  deferred: string;
  reason: string;
  /** 계획 단계에서 막힌 까닭 (예: 시각을 못 읽음) — 있으면 올리지 않는다 */
  error: string;
}

export interface HeldFile { path: string; name: string; reasons: string[]; unreadable: boolean }

export interface ChannelPlan {
  name: string; channelId: string; folder: string; cf: ChannelConf;
  /** 폴더에서 올릴 차례를 기다리는 전체 수 (거르기 전) */
  stockCount: number;
  daily: number; dailyWhy: string;
  mode: string; pickMode: string; directNow: boolean;
  passed: Cand[]; held: HeldFile[];
  note: string; stockNote: string; restCount: number;
  duplicates: string[][];
  chosen: Cand[]; spare: Cand[];
  items: PlannedItem[];
  /** 시각을 어떻게 정했나 */
  timeNote: string;
  approved: boolean;
  /** 어떤 길로 오든 같은 문을 지나게 — 일감에 달리는 승인 표시 */
  ranks: Map<string, { rank: number; pts: number; why: string[] }>;
}

interface Ctx {
  go: boolean; say: Say; now: Wall;
  /** 직접 고르기: 고른 파일 이름들(NFC) — 없으면 자동 계획 */
  want: Set<string> | null;
  /** 파일 이름(NFC) → 사람이 정한 시각 */
  at: Map<string, string>;
  who: string; liveInsight: boolean;
  ledgerNames: UploadedMap;
  /** 긴급중단 손잡이 · 전송 진행(파일·보낸·전체 바이트) — 화면의 올리기 창이 읽는다 */
  handle?: UploadHandle;
  onProgress?: (file: string, sent: number, total: number) => void;
}

const 승인표 = (c: Ctx) => `${c.who} (${c.want ? "사람이 고름(--pick)" : "계획대로 맡김(--auto-ok)"})`;

/** 이 채널(칸)의 영상 중 오늘 이미 올렸거나 오늘 쏘려고 담아 둔 수 — 오늘 몫에서 뺀다 */
function 오늘이미(folder: string, now: Wall): number {
  const norm = (p: string) => nfc(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(expandHome(folder));
  if (!base) return 0;
  const 안인가 = (p: string) => norm(p).startsWith(base + "/");
  const 오늘 = dateOnly(now);
  let n = 0;
  try {
    for (const r of readLedger()) {
      if ((r["업로드시각"] ?? "").slice(0, 10) === 오늘 && 안인가(r["파일"] ?? "")) n++;
    }
  } catch { /* 원장을 못 읽으면 셀 수 없다 — 아래 큐만 센다 */ }
  for (const j of readQueue()) {
    // 오늘 쏘거나 이미 밀린 것 (내일 이후로 잡힌 것은 내일의 몫이다)
    if (String(j["쏠때"] ?? "").slice(0, 10) <= 오늘 && 안인가(String(j["file"] ?? ""))) n++;
  }
  return n;
}

async function 배운것(name: string, cf: ChannelConf, live: boolean): Promise<Insight> {
  const 저장 = await insightCached(name);
  if (저장?.learned) return 저장;
  if (!live) return 저장 ?? { learned: false, why: "아직 읽지 않았습니다 — 갱신을 누르면 읽습니다" };
  const ins = await learn(cf.channel_id || name);
  if (ins.learned) {
    try { await insightRemember(name, ins); } catch { /* 저장은 덤이다 */ }
  }
  return ins;
}

/** 계획 시각 글 'YYYY-MM-DD HH:MM' 의 하루 더하기 */
function 날더하기(date: string, k: number, 없을때: Wall): string {
  const w = /^\d{4}-\d{2}-\d{2}$/.test(date) ? parseWall(date) : null;
  return dateOnly(addDays(w ?? 없을때, k));
}

/**
 * 한 꼴(쇼츠 또는 롱폼)의 n 편이 올라갈 시각들. 오늘 창에 다 못 넣으면 다음 날로 이어 붙인다.
 * floor — 이 시각보다 이르면 이 시각 이후로 (같은 꼴의 마지막 예약 뒤)
 */
function 시각셈(
  n: number, date: string, seed: string, fixedTimes: string[] | null, win: Window, now: Wall, floor: Wall | null,
): { slots: string[]; note: string } {
  const slots: string[] = [];
  let note = "";
  let 바닥 = floor;
  for (let 날 = 0; slots.length < n && 날 < 60; 날++) {
    const d = 날더하기(date, 날, now);
    const 남은 = n - slots.length;
    const [ts, 노트] = fixedTimes ? [fixedTimes.slice(0, 남은), "설정한 시각"] as [string[], string] : planTimes(d, seed, 남은, win);
    if (날 === 0) note = 노트;
    if (!ts.length) break;
    const full = future(d, ts, win, MIN_GAP_MIN, SPARE_MIN, now, 바닥);
    slots.push(...full);
    const 끝 = parseWall(full[full.length - 1]);
    if (끝) 바닥 = addMinutes(끝, MIN_GAP_MIN); // 다음 날로 넘어가도 4시간 간격은 지킨다
  }
  return { slots, note };
}

/** 한 채널을 훑어 오늘 할 일을 계획한다. 파일은 go 일 때 「검토필요」로 옮기는 것 말고는 건드리지 않는다. */
async function planChannel(name: string, cf: ChannelConf, c: Ctx): Promise<ChannelPlan | null> {
  const say = c.say;
  let waiting: string[];
  try {
    waiting = await pendingFiles(String(cf.folder ?? ""), say);
  } catch (e) {
    say(`[${name}] ⚠ ${msgOf(e)}`);
    return null;
  }
  // 지정한 파일이 있으면 그 채널 안에서도 그것만 본다
  const 전체대기수 = waiting.length; // 거르기 전 — 재고는 이걸로 센다
  if (c.want) waiting = waiting.filter((f) => c.want!.has(nfc(baseName(f))));
  if (!waiting.length) return null;

  let daily: number, why: string;
  let 전체일몫 = 0; // 오늘 몫에서 뺀 것을 되돌린 원래 하루 편수 — 재고가 며칠치인지는 이것으로 잰다
  if (c.want) {
    [daily, why] = [waiting.length, `직접 고른 ${waiting.length}개`];
  } else {
    [daily, why] = await dailyForChannel(name, cf);
    전체일몫 = daily;
    // 같은 날 두 번 돌려도 두 번 담지 않는다: 오늘 이미 올렸거나 담은 만큼은 오늘 몫에서 뺀다
    const 이미 = 오늘이미(String(cf.folder ?? ""), c.now);
    if (이미 > 0) {
      daily = Math.max(0, daily - 이미);
      why += ` · 오늘 이미 ${이미}편 올렸거나 담음`;
    }
  }
  const mode = String(cf.publish ?? "schedule");
  // 직접 고르고 시각을 안 정했으면 실제로 즉시 나간다 — 말도 그렇게 한다.
  //   (채널 기본이 schedule 이라고 「예약 발행」을 띄우면 완료 화면에서 어긋난다. 실제로 그랬다.)
  const 직접즉시 = !!c.want && !waiting.some((f) => c.at.has(nfc(baseName(f))));
  const 즉시말 = mode === "now" || 직접즉시;
  say(`\n[${name}]  대기 ${waiting.length}건 · ${why} · ${즉시말 ? "즉시 발행" : "예약 발행"}`);

  // ── 1단계: 검증과 검사를 먼저 끝낸다. 업로드가 실패해도 정리는 되어 있어야 한다.
  const passed: Cand[] = [];
  const held: HeldFile[] = [];
  for (const f of waiting) {
    const nm = baseName(f);
    const [okCh, whyCh] = await checkFile(f, cf, c.ledgerNames);
    if (!okCh) {
      say(`  ${nm}  검토필요 — ${whyCh[0]}`);
      if (c.go) { try { await markHold(f, whyCh); } catch (e) { say(`    검토필요 폴더로 옮기지 못했습니다 — ${cut(msgOf(e), 80)}`); } }
      held.push({ path: f, name: nm, reasons: whyCh, unreadable: false });
      continue;
    }
    let chk: Awaited<ReturnType<typeof check>>;
    try {
      chk = await check(f);
    } catch (e) {
      say(`  ${nm}  읽을 수 없음 — ${msgOf(e)}`);
      const 까닭 = `파일을 읽을 수 없음: ${msgOf(e)}`;
      if (c.go) { try { await markHold(f, [까닭]); } catch (x) { say(`    검토필요 폴더로 옮기지 못했습니다 — ${cut(msgOf(x), 80)}`); } }
      held.push({ path: f, name: nm, reasons: [까닭], unreadable: true });
      continue;
    }
    say(`  ${nm}  ${chk.kind} (${chk.info.w}x${chk.info.h} · ${fixed(chk.info.sec, 1)}초)`);
    passed.push({ path: f, name: nm, info: chk.info, kind: chk.kind });
  }

  // ── 중복 경고: 같은 영상이 이름만 바꿔 두 번 들어온 경우
  const duplicates = findDuplicates(passed);
  for (const grp of duplicates) {
    const 이름들 = grp.slice(0, 3).map(baseName).join(", ");
    say(`    ⚠ 같은 영상 ${grp.length}개로 보입니다 — ${이름들}${grp.length > 3 ? ` 외 ${grp.length - 3}개` : ""}`);
  }

  // ── 2단계: 어떤 것을 올릴지 고른다.
  const pickMode = String(cf.pick ?? "oldest");
  let ins: Insight | null = null;
  if (pickMode === "suggest") {
    ins = await 배운것(name, cf, c.liveInsight);
    let 말: string[];
    try { 말 = describeInsight(ins); } catch { 말 = ["배운 것을 읽지 못했습니다 — 저장본이 깨졌습니다(갱신하면 새로 읽습니다)"]; }
    for (const line of 말) say(`    · ${line}`);
    if (!c.go && passed.length) for (const line of pickReport(passed, daily, 12, ins)) say(line);
  }
  const 고른이름 = c.want ? waiting.map(baseName).filter((n) => c.want!.has(nfc(n))) : null;
  const picked = choose(passed, c.want ? "manual" : pickMode, daily, 고른이름, ins);
  const byPath = new Map(passed.map((x) => [x.path, x]));
  const chosen = picked.chosen.map((x) => byPath.get(x.path)!).filter(Boolean);
  say(`    ${picked.note}`);
  const rest = passed.length - chosen.length;
  // ★ 재고는 언제나 **채널 전체**로 센다. 직접 고른 개수로 세면 대기 94개인 채널에서
  //   「재고 1.0일 — 곧 떨어집니다」가 나온다. (업로드 완료 화면의 거짓 경고가 이것이었다)
  let 재고셈: [number, number];
  if (c.want) {
    const [참일몫] = await dailyForChannel(name, cf);
    재고셈 = [Math.max(0, 전체대기수 - chosen.length), Math.max(1, 참일몫)];
  } else {
    재고셈 = [passed.length, 전체일몫];
  }
  const stockNote = daysLeft(...재고셈).note;
  if (rest > 0) say(`    나머지 ${rest}개는 폴더에 그대로 둡니다 · ${stockNote}`);
  else if (passed.length <= daily) say(`    ${stockNote}`);

  const ranked = new Map<string, { rank: number; pts: number; why: string[] }>();
  rankItems(passed, ins).forEach((r, i) => ranked.set(r.path, { rank: i + 1, pts: r.pts, why: r.why }));

  // ── 3단계: 시각을 정한다 — 4시간 이상 띄우고 정각을 피한다(같은 날엔 재현된다). 쇼츠와 롱폼은 따로.
  const approvedPolicy = (() => { const p = policyForChannel(String(cf.channel_id || name)); return !!p && isApprovedPolicy(p.cfg); })();
  const 정책있음 = !!policyForChannel(String(cf.channel_id || name));
  const date = String(cf.date || todayStr(0, c.now));
  const win = normalizeWindow(cf.window);
  const 고정 = Array.isArray(cf.times) && cf.times.length ? cf.times.map(String) : null;
  const 꼴별시각 = new Map<Kind, string[]>();
  const 노트들: string[] = [];
  const 자동 = !c.want; // 사람이 짚은 파일에는 계획 시각을 붙이지 않는다(--at 으로 정한 것만)
  if (chosen.length && !즉시말 && 자동) {
    for (const kind of ["쇼츠", "롱폼"] as const) {
      const n = chosen.filter((x) => x.kind === kind).length;
      if (!n) continue;
      // 같은 꼴의 마지막 공개 예약 뒤에 이어 붙인다 — 일 한도 정책이 걸린 채널은 편성기가 맡는다
      let floor: Wall | null = null;
      if (!고정 && !정책있음) {
        const 끝 = await lastReservation(name, kind === "롱폼");
        if (끝) floor = addMinutes(끝, GAP_HOURS * 60 - CHECK_AT[0]);
      }
      const seed = String(cf.channel_id || name) + (kind === "롱폼" ? "|롱폼" : "");
      const r = 시각셈(n, date, seed, 고정, win, c.now, floor);
      꼴별시각.set(kind, r.slots);
      const 꼴표 = chosen.some((x) => x.kind !== kind) ? `[${kind}] ` : "";
      const 짧게 = r.slots.map((x) => x.slice(0, 10) === date ? x.slice(11) : x.slice(5));
      say(`    예상 시각  ${꼴표}${짧게.join(" · ")}   (${r.note}${floor && r.slots[0] ? " · 같은 꼴의 마지막 예약 뒤로 이어 붙임" : ""})`);
      // 하루 줄은 **실제로 정해진** 오늘 시각만 그린다(밀린 것까지 그리면 줄과 위의 말이 어긋난다)
      const 오늘칸 = r.slots.filter((x) => x.slice(0, 10) === date).map((x) => x.slice(11));
      if (오늘칸.length) say(`    ${꼴표}${win[0]}시 ${timeline(오늘칸, win)} ${win[1]}시`);
      const 밀림 = r.slots.filter((x) => x.slice(0, 10) !== date);
      if (밀림.length) {
        say(`    · ${밀림.length}개는 오늘 안에 다 못 넣어 ${[...new Set(밀림.map((x) => x.slice(0, 10)))].join(", ")} 로 넘겼습니다`);
      }
      노트들.push(chosen.some((x) => x.kind !== kind) ? `${kind}: ${r.note}` : r.note);
    }
  }

  // ── 4단계: 일감을 만든다. 미리보기가 보여 주는 값과 실제로 담기는 값이 같은 곳에서 나온다.
  const 승인형지연 = Number(policyForChannel(String(cf.channel_id || name))?.cfg.publish_delay_minutes ?? 10);
  const 꼴순서 = new Map<Kind, number>();
  const items: PlannedItem[] = [];
  const pre = String(cf.title_prefix ?? "");
  for (const cand of chosen) {
    const idx = 꼴순서.get(cand.kind) ?? 0;
    꼴순서.set(cand.kind, idx + 1);
    const 정한글 = c.at.get(nfc(cand.name));
    let when: string | null = null;
    let timeBy: "user" | "auto" = "auto";
    let error = "";
    if (정한글) {
      // 사람이 화면에서 고른 시각은 약속이므로 그대로 지킨다. 못 읽는 시각은 **올리지 않는다**.
      const w = parseWall(정한글);
      if (w) { when = minuteWall(w); timeBy = "user"; }
      else error = `시각을 읽지 못했습니다 — ${JSON.stringify(정한글)} (예: 2026-08-28 14:20) · 올리지 않았습니다`;
    } else if (mode === "now" || c.want) {
      when = null; // 사람이 짚었는데 시각을 안 정했다 = 「지금 올려라」다. 채널 기본(schedule)의 계획 시각을 붙이지 않는다.
    } else {
      const s = 꼴별시각.get(cand.kind) ?? [];
      when = s[idx] ?? s[s.length - 1] ?? null;
    }
    if (approvedPolicy) {
      // 승인한 영상은 올린 뒤 정한 분 뒤에 예약한다 — 사람이 시각을 안 정했으면 지금 + 그 분
      if (!정한글) when = minuteWall(addMinutes(c.now, 승인형지연));
      timeBy = "user";
    }
    const long = cand.kind === "롱폼";
    const job: Job = {
      channel: cf.channel_id || name,
      file: cand.path,
      // 제목·설명·태그는 영상 옆 txt 가 정한다(upload 가 읽는다). 여기서 파일명을 넣으면 그 값이 이겨서
      // 화면에 보이던 제목과 실제로 올라가는 제목이 달라진다. 머리말이 정해진 고객사만 예외로 파일명을 쓴다.
      title: pre ? pre + stemOf(cand.name) : "",
      desc: cf.desc ?? "",
      tags: cf.tags ?? [],
      publish_at: when ?? null,
      approved_by: cf.approved_by ?? "",
      영상종류: cand.kind, 롱폼: long, allow_not_short: long,
      time_by: timeBy,
      // ── 사람 승인 표시: 출구검사(safety)가 이것을 본다. 없으면 안 올라간다. ──────────
      //   --pick 은 사람이 파일을 짚은 것이고, --auto-ok 는 계획대로 맡기겠다고 사람이 밝힌 것이다. 둘 다 없으면 여기까지 못 온다.
      _승인: 승인표(c),
    };
    const nowMs = c.now.getTime();
    const w = when ? parseWall(when) : null;
    const route: Route = approvedPolicy ? "approved" : (w && w.getTime() > nowMs + 60_000 ? "queue" : "now");
    const rk = ranked.get(cand.path);
    const 방식말 = c.want ? "직접 고른 영상"
      : pickMode === "suggest" && rk ? `추천 ${rk.rank}위 [${rk.pts}점] ${rk.why.join(" · ")}`
      : pickMode === "order" ? `이름 순서 ${chosen.indexOf(cand) + 1}번째`
      : `폴더에 오래 있던 순 ${chosen.indexOf(cand) + 1}번째`;
    items.push({
      cand, rank: rk?.rank ?? null, when, timeBy, route, job,
      fireAt: route === "queue" && w ? isoWall(w) : "", publishAt: approvedPolicy && when ? when : "",
      deferred: "", reason: `${방식말} · ${정한글 ? "사람이 정한 시각" : 고정 ? "설정한 시각" : 자동 && !즉시말 ? "계획 시각" : "바로 올림"}`,
      error,
    });
  }

  const plan: ChannelPlan = {
    name, channelId: String(cf.channel_id ?? ""), folder: expandHome(String(cf.folder ?? "")), cf,
    stockCount: 전체대기수, daily, dailyWhy: why, mode, pickMode, directNow: 직접즉시,
    passed, held, note: picked.note, stockNote, restCount: rest, duplicates, chosen,
    spare: passed.filter((x) => !chosen.includes(x)),
    items, timeNote: 노트들.join(" · "), approved: approvedPolicy, ranks: ranked,
  };
  await 편성미리보기(plan, c.now);
  return plan;
}

/**
 * 일 한도 정책이 걸린 채널은 담는 순간 편성기가 시각을 바꾼다 — 같은 계산(reflow)을 미리 돌려 예상 시각에 반영한다.
 * 원장을 못 읽는 등 계산이 안 되면 건너뛴다(미리보기가 없다고 올리기가 막히지는 않는다).
 */
async function 편성미리보기(plan: ChannelPlan, now: Wall): Promise<void> {
  if (!policyForChannel(plan.channelId || plan.name)) return;
  const 일감 = plan.items.filter((it) => !it.error);
  if (!일감.length) return;
  try {
    const q = readQueue();
    const 가짜: Job[] = 일감.map((it) => ({
      ...it.job,
      publish_at: it.route === "queue" ? "" : (it.job.publish_at ?? ""),
      쏠때: isoWall(it.route === "queue" && it.when ? parseWall(it.when) ?? now : now),
      담은때: isoWall(now),
    }));
    const 결과 = reflow([...q, ...가짜]).slice(q.length);
    일감.forEach((it, i) => {
      const r = 결과[i];
      if (!r) return;
      it.fireAt = String(r["쏠때"] ?? "");
      it.publishAt = String(r["publish_at"] ?? "");
      if (it.route !== "queue" && it.fireAt.slice(0, 10) > dateOnly(now)) {
        it.deferred = "하루 한도로 다음 날 이후로 미룹니다";
      } else if (it.route === "queue" && it.when && it.fireAt.slice(0, 16) !== isoWall(parseWall(it.when) ?? now).slice(0, 16)) {
        it.deferred = `하루 한도로 ${it.fireAt.slice(5, 16).replace("T", " ")} 로 편성됩니다`;
      }
    });
  } catch (e) {
    await recordLine("서버.log", `편성 미리보기를 건너뜁니다 — ${cut(msgOf(e), 80)}`);
  }
}

/* ============================================================ 실행 */

export interface RunItem {
  channel: string; file: string; name: string; kind: Kind | "";
  /** preview 미리보기 · uploaded 올림 · queued 발사대기 · held 검토필요 · failed 실패 */
  action: "preview" | "uploaded" | "queued" | "held" | "failed";
  /** 정한 시각 ("YYYY-MM-DD HH:MM") — 없으면 심사 후 바로 */
  when: string | null;
  /** 발사대기에 담겼다면 실제 올리기 시각(ISO, 일 한도 편성 뒤) */
  fireAt: string;
  videoId: string;
  note: string;
}

export interface RunResult {
  /** 실제로 했나(true) 보기만 했나(false) — 보기만 할 때 up·queued 는 「그렇게 될 것」의 수다 */
  go: boolean;
  /** 비어 있지 않으면 아무것도 하지 않고 돌아온 까닭 */
  refused: string;
  up: number; queued: number; held: number; failed: number;
  channels: string[];
  items: RunItem[];
  /** 지정했는데 어느 채널 폴더에서도 못 찾은 파일 */
  notFound: string[];
  /** say 로 나간 줄 전부 */
  lines: string[];
}

export interface RunOpts {
  /** 고르지 않고 go 만 줄 때, 앱이 알아서 고르는 것을 허락한다 (--auto-ok) */
  autoOk?: boolean;
  /** 누가 시켰나 — 일감의 승인 표시 앞머리. 명령줄이면 「명령줄 --승인」 */
  who?: string;
  say?: Say;
  /** 시험이 시계를 바꿔 끼운다 (순간) */
  clock?: Date;
  /** 신호등 숫자를 내는 곳 (문제를 모으는 모듈이 있으면 연결) */
  lamp?: () => Promise<{ red: number; yellow: number }>;
  /** suggest 방식에서 배운 것을 저장본이 없으면 유튜브에 물어 읽는다 (기본: 저장본만) */
  liveInsight?: boolean;
  /** 긴급중단 손잡이 — handle.aborted 를 참으로 바꾸면 전송을 조각 사이에서 멈춘다 */
  handle?: UploadHandle;
  /** 전송 진행 알림 (파일 경로 · 보낸 바이트 · 전체 바이트) */
  onProgress?: (file: string, sent: number, total: number) => void;
}

const 거부문 = {
  잠김: "\n  올리기가 잠겨 있습니다. 아무것도 올리지 않았습니다.\n  풀려면 화면 오른쪽 위 자물쇠를 풀어 주세요.\n",
  안고름: "\n  올릴 영상을 고르지 않았습니다." +
    "\n  이대로 두면 앱이 오늘 계획대로 알아서 골라 올립니다." +
    "\n" +
    "\n  · 고른 것만 올리려면   --pick 파일명 ..." +
    "\n  · 계획대로 맡기려면    --go --auto-ok" +
    "\n  · 무엇이 올라갈지 보려면  --pick 없이 --go 도 빼고 실행\n",
};

/**
 * 폴더를 훑어 올린다. (파이썬: run.run + __main__ 의 문지기)
 *
 * go=false 이면 아무것도 바꾸지 않고 계획만 말한다.
 * picks — 사람이 짚은 파일(이름 또는 경로). 주면 **그 파일이 있는 채널만** 돈다(함정 1.1: 1개를 골랐는데 7개가 올라갔다).
 * ats   — "파일=시각" 들. 사람이 정한 시각이라 그대로 지킨다.
 *
 * 함정 6.2: picks 없이 go 만 주면 거부한다 — 손이 미끄러지거나 스크립트가 잘못 돌면 고객 채널에 영상이 그대로 올라간다.
 * 정말 맡기려면 o.autoOk 를 따로 줘야 한다.
 */
export async function run(go: boolean, picks?: string[], ats?: string[], o: RunOpts = {}): Promise<RunResult> {
  const lines: string[] = [];
  const say: Say = (s) => { lines.push(s); (o.say ?? console.log)(s); };
  const res: RunResult = {
    go, refused: "", up: 0, queued: 0, held: 0, failed: 0, channels: [], items: [], notFound: [], lines,
  };
  const 거부 = (글: string) => { res.refused = 글.trim(); say(글); return res; };

  const 골랐나 = !!picks?.length;
  if (go && isLocked()) return 거부(거부문.잠김);
  if (go && !골랐나 && !o.autoOk) return 거부(거부문.안고름);

  const now = wallNow(systemZone(), o.clock);
  let chans = loadChannelsPlan(say);
  if (o.lamp) {
    try { lampLine(await o.lamp(), say); } catch (e) { say(`\n  신호등을 읽지 못했습니다 — ${cut(msgOf(e), 80)}`); }
  }
  const g = await guard(chans, go, say);
  if (!g.ok) { res.refused = g.fatal.join(" / "); return res; }

  // 파일을 직접 지정했으면 그 파일이 있는 채널만 돈다.
  //   예전에는 지정해도 나머지 채널이 각자 규칙대로 다 올라갔다. 화면에는 「1개」라고 띄우고 실제로는 7개가 올라간 사고가 있었다.
  const want = 골랐나 ? new Set(picks!.map((x) => nfc(baseName(x)))) : null;
  const at = new Map<string, string>();
  for (const x of ats ?? []) {
    const i = x.indexOf("=");
    if (i > 0 && i < x.length - 1) at.set(nfc(baseName(x.slice(0, i))), x.slice(i + 1));
  }
  if (want) {
    const keep: Channels = {};
    for (const [n, cf] of Object.entries(chans)) {
      const folder = expandHome(String(cf.folder ?? ""));
      if (!folder) continue;
      const names = new Set<string>();
      try { for await (const e of Deno.readDir(folder)) names.add(nfc(e.name)); } catch { continue; }
      if ([...want].some((w) => names.has(w))) keep[n] = cf;
    }
    if (!Object.keys(keep).length) {
      say("\n  지정한 파일을 어느 채널 폴더에서도 찾지 못했습니다.");
      res.notFound = [...want].sort();
      for (const w of res.notFound) say(`    · ${w}`);
      return res;
    }
    const 건너뜀 = Object.keys(chans).filter((n) => !(n in keep));
    chans = keep;
    say(`\n  직접 고르기 — 채널 ${Object.keys(keep).length}개 · 영상 ${want.size}개`);
    if (건너뜀.length) say(`  건너뜀: ${건너뜀.join(", ")}`);
  }

  const 일한다 = async (): Promise<void> => {
    const ctx: Ctx = {
      go, say, now, want, at,
      who: (o.who ?? "").trim() || "명령줄 --승인", liveInsight: !!o.liveInsight,
      ledgerNames: uploadedNames(), handle: o.handle, onProgress: o.onProgress,
    };
    for (const [name, cf] of Object.entries(chans)) {
      // 한 채널이 뜻밖의 일로 넘어져도 나머지 채널은 계속 간다 (여러 채널을 도는 반복이 통째로 멈추면 안 된다)
      try {
        const plan = await planChannel(name, cf, ctx);
        if (!plan) continue;
        res.channels.push(name);
        res.held += plan.held.length;
        for (const h of plan.held) {
          res.items.push({ channel: name, file: h.path, name: h.name, kind: "", action: "held", when: null, fireAt: "", videoId: "", note: h.reasons[0] ?? "" });
        }
        await 올리기(plan, ctx, res);
        // 이번에 올라간 이름을 다음 채널의 중복 검사가 보게 한다 (파일마다 원장을 읽던 원본과 같은 결과)
        if (go) ctx.ledgerNames = uploadedNames();
      } catch (e) {
        say(`[${name}] ⚠ 처리하다 멈췄습니다 — ${(e as Error)?.name ?? "오류"}: ${cut(msgOf(e), 100)}`);
        await recordLine("올리기.log", `채널중단  [${name}] ${(e as Error)?.name ?? "오류"}: ${cut(msgOf(e), 180)}`);
        res.failed++;
      }
    }
    await saveCache(); // 잰 값을 남긴다 — 다음에 훨씬 빨라진다
  };

  if (!go) await 일한다();
  else {
    // 올리기는 동시에 둘이 돌지 않는다 — 같은 영상을 두 번 올리는 일을 막는 마지막 안전망이다.
    const r = await withFileLock(dataPath(".run.lock"), 일한다, { wait: false });
    if (r === null) return 거부("\n  다른 올리기가 진행 중입니다. 끝난 뒤에 다시 해 주세요.\n");
  }

  const 꼬리 = go ? "" : "   (미리보기 — 아무것도 바꾸지 않았습니다)";
  say(`\n올림 ${res.up}건` + (res.queued ? ` · 발사대기 ${res.queued}건` : "") + ` · 검토필요 ${res.held}건` +
    (res.failed ? ` · 실패 ${res.failed}건` : "") + 꼬리);
  if (res.queued) say("  발사대기는 아직 올라간 것이 아닙니다 — 정한 시각에 쏘고 나서 편수에 잡힙니다.");
  if (go && res.up) say("공개는 올린 지 30분 뒤 심사를 확인한 다음에 합니다.");
  return res;
}

/** 계획한 일감을 말하거나(미리보기) 실제로 보낸다 */
async function 올리기(plan: ChannelPlan, c: Ctx, res: RunResult): Promise<void> {
  const say = c.say;
  const { name } = plan;
  for (const [i, it] of plan.items.entries()) {
    const nm = it.cand.name, f = it.cand.path;
    const base: RunItem = {
      channel: name, file: f, name: nm, kind: it.cand.kind, action: "preview", when: it.when, fireAt: it.fireAt, videoId: "", note: "",
    };
    if (it.error) {
      say(`  ${nm}  ${it.error}`);
      res.failed++;
      res.items.push({ ...base, action: "failed", note: it.error });
      continue;
    }

    if (!c.go) {
      // 미리보기는 일감에 담긴 값을 그대로 보여준다. 따로 계산하면 화면과 실제가 어긋난다. 실제로 그런 적이 있다.
      const tail = it.when ? `${it.when.slice(5, 16).replace("-", "/")} 예약` : "심사 후 즉시 공개";
      say(`  ${i + 1}. ${cut(nm, 34).padEnd(34)} → ${tail.padEnd(16)} ${it.cand.info.w}x${it.cand.info.h} · ${fixed(it.cand.info.sec, 0)}초` +
        (it.deferred ? `   ※ ${it.deferred}` : ""));
      res.up++;
      res.items.push({ ...base, note: it.deferred });
      continue;
    }

    try {
      // ── 아직 쏠 때가 아니면 **여기 붙들어 둔다** ──────────
      //   예전에는 예약을 걸어도 파일이 곧바로 유튜브로 갔다. 고객 채널에 미리 가 있는 셈이었다.
      //   이제는 정한 시각까지 이 컴퓨터에 남아 있다가 그때 올라간다.
      if (it.route === "queue") {
        // 쏘는 시각은 큐(쏠때)가 관리한다. publish_at 까지 들고 가면 발사 시점에 이미 지난 예약을 유튜브에 넘기게 된다.
        // 설계는 「그 시각에 올림 → 30분 검토 → 통과 즉시 공개」다.
        const 일감 = { ...it.job, publish_at: "" };
        const 시각 = parseWall(it.when!)!;
        if (!await add(일감, isoWall(시각), say)) throw new Error("발사대기에 담지 못했습니다(승인 표시가 없음)");
        const 실제 = 담긴시각(f);
        res.queued++;
        res.items.push({ ...base, action: "queued", fireAt: 실제 });
        const 달라짐 = 실제.slice(0, 16) !== isoWall(시각).slice(0, 16);
        say(`  ${cut(nm, 34)}  발사대기 — ${(실제 || it.when!).slice(0, 16).replace("T", " ")} 에 쏩니다` + (달라짐 ? "  (하루 한도로 편성됨)" : ""));
        await recordLine("올리기.log", `대기   [${name}] ${nm}  발사예정 ${실제 || it.when}`);
        continue;
      }
      await 바로쏘기(it, c, res, base);
    } catch (e) {
      const 말 = msgOf(e);
      say(`  ${nm}  업로드 실패 — ${말.slice(0, 110)}`);
      // 실패는 화면에서 흘러가 버린다. 나중에 「왜 안 올라갔지」를 되짚으려면 남아 있어야 한다.
      await recordLine("올리기.log", `실패   [${name}] ${nm}  ${(e as Error)?.name ?? "오류"}: ${말.slice(0, 180)}`);
      res.failed++;
      res.items.push({ ...base, action: "failed", note: 말 });
    }
  }
}

/**
 * 그 자리에서 올린다 — 담고(add) 곧바로 쏜다(fire). 승인형 정책 채널도 같은 길이다.
 *
 * 왜 담았다가 쏘나: 올리는 길을 하나로 모은다. 예약 작업의 발사와 같은 잠금(.발사.lock)·같은 출구검사·같은 알림·같은 하루 한도 편성을
 * 지나므로, 두 길이 동시에 원장에 줄을 적다가 한쪽이 사라지는 일이 없다. 일 한도에 걸리면 실패가 아니라 큐에서 다음 날로 밀린다.
 * 못 쏘는 사정(한밤 금지·다른 전송 중·한도)이면 큐에 남고, 사람이 알아야 하는 실패는 failed 로 알린다.
 */
async function 바로쏘기(it: PlannedItem, c: Ctx, res: RunResult, base: RunItem): Promise<void> {
  const f = it.cand.path;
  // 긴급중단이 눌렸으면 아직 시작하지 않은 영상은 발사대기에도 담지 않는다(담으면 다음 차례에 다시 올라간다)
  if (c.handle?.aborted) {
    res.failed++;
    res.items.push({ ...base, action: "failed", note: "긴급중단 — 올리지 않았습니다" });
    return;
  }
  if (!await add(it.job, isoWall(c.now), c.say)) throw new Error("발사대기에 담지 못했습니다(승인 표시가 없음)");
  let 영상id = "";
  let 막힘: unknown = null;
  const 쏨 = await fire({
    file: f, now: c.now, say: c.say,
    uploader: async (job) => {
      try {
        const id = await uploadOne(job, { say: c.say, handle: c.handle, onProgress: c.onProgress ? (sent, total) => c.onProgress!(f, sent, total) : undefined });
        영상id = id ?? "";
        return id;
      } catch (e) {
        막힘 = e; // fire 가 알림·기록·큐 유지를 하도록 다시 던진다
        throw e;
      }
    },
  });
  if (쏨 > 0) {
    res.up++;
    res.items.push({ ...base, action: "uploaded", videoId: 영상id });
  } else if (막힘 && !(막힘 instanceof DailyLimitReached) && !isLimitError(막힘)) {
    // 올리다 실패했다. fire 가 이미 말하고 알렸다 — 큐에 남아 다음 차례에 다시 쏜다.
    // (하루 업로드 한도 429 는 실패가 아니다 — fire 가 남은 것을 다음 초기화로 미뤘으니 아래의 「기다림」으로 센다.)
    res.failed++;
    res.items.push({ ...base, action: "failed", fireAt: 담긴시각(f), note: msgOf(막힘) });
  } else {
    // 지금은 못 쏜다(하루 한도 · 한밤 금지 · 다른 전송 중) — 큐에서 기다린다.
    const 실제 = 담긴시각(f);
    res.queued++;
    res.items.push({ ...base, action: "queued", fireAt: 실제, note: 막힘 ? msgOf(막힘) : "" });
    c.say(`  ${cut(it.cand.name, 34)}  지금은 못 쏩니다 — 발사대기 ${실제.slice(0, 16).replace("T", " ")} 에 쏩니다`);
  }
}

/** 발사대기에 실제로 담긴 올리기 시각 (일 한도 편성 뒤의 값) */
function 담긴시각(file: string): string {
  return String(readQueue().find((x) => x.file === file)?.["쏠때"] ?? "");
}

/* ============================================================ 미리보기 자료 (HTML 이 아니라 JSON) */

export interface PreviewItem {
  file: string; name: string; title: string; kind: Kind;
  /** 오늘 몫 밖의 여분 (대기) */
  spare: boolean;
  rank: number | null;
  /** 그 자리에서 바로 올라가는가 */
  immediate: boolean;
  /** 올리기 시각(ISO, 일 한도 편성 뒤). 바로 올리면 빈 글 */
  fireAt: string;
  /** 공개 시각 "YYYY-MM-DD HH:MM". 비어 있으면 올린 뒤 심사가 끝나는 대로(약 30분 뒤) 공개 */
  publishAt: string;
  publishWord: string;
  deferred: string;
  reason: string;
  info: { w: number; h: number; sec: number };
}

export interface PreviewChannel {
  name: string; channelId: string; folder: string;
  mode: string; pickMode: string;
  daily: number; dailyWhy: string;
  note: string; timeNote: string; stockNote: string;
  items: PreviewItem[];
  held: { file: string; name: string; reason: string }[];
  duplicates: string[][];
}

export interface PreviewResult { channels: PreviewChannel[]; total: number; lines: string[] }

/**
 * 오늘 올릴 것을 채널별로 보여 줄 자료. (파이썬: run.cmd_preview — 원본은 HTML 을 만들어 띄웠다. 여기서는 자료만 돌려준다.)
 * 아무것도 바꾸지 않고, 기본은 유튜브도 부르지 않는다(저장해 둔 편수·배운 것만 쓴다). o.live 면 새로 읽는다.
 */
export async function cmdPreview(
  chans: Channels, o: { say?: Say; clock?: Date; liveInsight?: boolean } = {},
): Promise<PreviewResult> {
  const lines: string[] = [];
  const say: Say = (s) => { lines.push(s); o.say?.(s); };
  const now = wallNow(systemZone(), o.clock);
  const ctx: Ctx = {
    go: false, say: 없음, now, want: null, at: new Map(),
    who: "미리보기", liveInsight: !!o.liveInsight, ledgerNames: uploadedNames(),
  };
  const out: PreviewChannel[] = [];
  let total = 0;
  for (const [name, cf] of Object.entries(chans)) {
    let plan: ChannelPlan | null;
    try {
      plan = await planChannel(name, cf, ctx);
    } catch (e) {
      say(`[${name}] ⚠ 훑다가 멈췄습니다 — ${(e as Error)?.name ?? "오류"}: ${cut(msgOf(e), 100)}`);
      continue; // 한 채널이 넘어져도 나머지는 계속
    }
    if (!plan || (!plan.chosen.length && !plan.spare.length && !plan.held.length)) continue;
    const toItem = async (cand: Cand, it?: PlannedItem): Promise<PreviewItem> => {
      let title = cand.name.replace(/\.[^.]+$/, "");
      try { title = (await loadFor(cand.path)).title || title; } catch { /* 제목을 못 읽으면 파일 이름 */ }
      // 그 자리에서 바로 올라가나: 정한 시각을 기다리는 길(queue)이 아니고, 한도로 미뤄지지도 않았다
      const 바로 = !!it && it.route !== "queue" && !it.deferred;
      return {
        file: cand.path, name: cand.name, title, kind: cand.kind, spare: !it,
        rank: plan.ranks.get(cand.path)?.rank ?? null,
        immediate: 바로,
        fireAt: it && !바로 ? it.fireAt : "",
        publishAt: it?.publishAt ?? "",
        publishWord: !it ? "대기" : it.publishAt ? "예약 공개" : `올린 ${CHECK_AT[0]}분 뒤 심사 확인 후 바로 공개`,
        deferred: it?.deferred ?? "",
        reason: it ? (it.error || it.reason) : "여분 — 오늘 몫 밖(폴더에서 대기)",
        info: { w: cand.info.w, h: cand.info.h, sec: cand.info.sec },
      };
    };
    const items: PreviewItem[] = [];
    for (const it of plan.items) items.push(await toItem(it.cand, it));
    for (const sp of plan.spare) items.push(await toItem(sp));
    total += items.length;
    out.push({
      name, channelId: plan.channelId, folder: plan.folder, mode: plan.mode, pickMode: plan.pickMode,
      daily: plan.daily, dailyWhy: plan.dailyWhy, note: plan.note, timeNote: plan.timeNote, stockNote: plan.stockNote,
      items, held: plan.held.map((h) => ({ file: h.path, name: h.name, reason: h.reasons[0] ?? "" })),
      duplicates: plan.duplicates,
    });
  }
  await saveCache();
  if (!out.length) say("\n  올릴 것이 없습니다.");
  else say(`\n  채널 ${out.length}개 · 영상 ${total}개를 훑었습니다.`);
  return { channels: out, total, lines };
}

/* ============================================================ 성적 · 배운 것 */

export interface LearnRow { name: string; key: string; error: string; insight: Insight | null }

/** 채널마다 직전 성적과, 무엇이 통했는지를 함께 본다. 사람이 시킨 것이라 유튜브에 직접 묻는다. (파이썬: run.cmd_learn) */
export async function cmdLearn(chans: Channels, say: Say = console.log): Promise<LearnRow[]> {
  const out: LearnRow[] = [];
  for (const [name, cf] of Object.entries(chans)) {
    const key = cf.channel_id || name;
    say(`\n${"═".repeat(78)}\n  ${name}\n${"═".repeat(78)}`);
    let error = "";
    try {
      const rows = await recentPerformance(key);
      if (rows.length) for (const line of perfTable(rows)) say(line);
    } catch (e) {
      error = e instanceof LookupError || e instanceof Deno.errors.NotFound ? "아직 인증 전입니다" : msgOf(e).slice(0, 60);
      say(`  성적을 못 읽었습니다 — ${error}`);
    }
    say("");
    const ins = await learn(key);
    for (const line of describeInsight(ins)) say(`  · ${line}`);
    out.push({ name, key, error, insight: ins });
  }
  return out;
}

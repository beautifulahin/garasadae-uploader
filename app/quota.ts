// 오늘 API 할당량을 얼마나 썼는지 센다. (파이썬 quota.py)
//
// 구글은 남은 양을 알려 주지 않는다. 그래서 앱이 부른 만큼을 직접 세어 둔다.
// 두 주머니가 따로 있다.
//   일반    하루 10,000 유닛 — 조회·수정에 쓴다
//   업로드  하루 100건       — videos.insert 는 자기 주머니를 쓴다(1건 = 일반 2유닛 안팎)
// 기준 시각은 태평양 자정(한국 시간 오후 4~5시).
//
// 2.0.0 — 옛 앱은 「업로드 1건 = 1,600유닛, 하루 6개」로 셌다. 틀린 계산이었다(파이썬 참고/할당량.md,
//   2026-08-28 실측). 지금은 모든 호출이 google.ts 한 곳을 지나며 자동으로 세어진다.
//   구글 프로젝트(클라이언트)가 여럿이면 프로젝트별로 따로 센다 — 주머니가 프로젝트마다 따로니까.
import { dataPath, readJsonSync, recordLine, recordPath, withFileLock, writeJson, log } from "./paths.ts";
import { instantToWall, quotaDay, systemZone, untilQuotaReset, wallToInstant, parseWall } from "./clock.ts";
import { readLedger } from "./ledger.ts";

export const DAILY = 10000; // 일반 주머니
export const UPLOAD_DAILY = 100; // 업로드 주머니
export const READ_CAP = 6000; // 읽기에만 거는 하루 상한(폭주 막이) — 올리기 몫은 늘 남는다

/** 구글이 정한 호출별 값. 횟수가 아니라 이 값을 더해야 한다. (파이썬 값표) */
export const 값표: Record<string, number> = {
  "videos.insert": 2, // 실측 (예전 1600 · 2026-06-01 인하)
  "captions.insert": 400,
  "search.list": 1, // 1유닛이지만 하루 100회에 묶인다 — 안 쓴다
  "videos.update": 50,
  "videos.delete": 50,
  "thumbnails.set": 50,
  "playlistItems.insert": 50,
};
const 기본값 = 1;

/** 읽기 상한에서 빼는 호출(올리기·쓰기는 세되 막지 않는다) */
const 안막을것 = new Set([
  "videos.insert", "thumbnails.set", "captions.insert", "playlistItems.insert",
  "videos.update", "videos.delete",
  "videos.batchGetStats", // 별도 통에서 나가므로 메인 지갑 상한과 무관하다
]);
/** 각자 딴 지갑을 쓰는 호출 */
const 별도통 = new Set(["videos.batchGetStats", "analytics.query"]);

export const 유닛 = (이름: string) => 값표[이름] ?? 기본값;

export class 하루치넘음 extends Error {
  constructor(m: string) { super(m); this.name = "하루치넘음"; }
}

interface Bucket { 유닛: number; 업로드: number; 내역: Record<string, number> }
interface Meter extends Bucket { 날짜: string; 프로젝트?: Record<string, Bucket> }

const 파일 = () => dataPath("할당량.json");
const 잠금 = () => dataPath("할당량.lock");

function 빈통(): Bucket { return { 유닛: 0, 업로드: 0, 내역: {} }; }

function 읽기(): Meter {
  const d = readJsonSync<Partial<Meter>>(파일(), {});
  const 오늘 = quotaDay();
  if (d.날짜 !== 오늘) return { 날짜: 오늘, ...빈통(), 프로젝트: {} };
  return { 날짜: 오늘, 유닛: d.유닛 ?? 0, 업로드: d.업로드 ?? 0, 내역: d.내역 ?? {}, 프로젝트: d.프로젝트 ?? {} };
}

/** 주소·방식을 보고 어느 API 인지 알아낸다. (파이썬 _이름) */
export function nameOf(url: string, method = "GET"): string {
  // `videos:batchGetStats` 는 주소가 콜론으로 이어진다. 별도 통(Video Batch Get Stats)에서 나가므로 따로 센다.
  if (url.includes("videos:batchGetStats")) return "videos.batchGetStats";
  // 스튜디오 지표 창구. Data API 와 완전히 다른 API 라 통도 따로다.
  if (url.includes("youtubeanalytics")) return "analytics.query";
  const m = /\/youtube\/v3\/([A-Za-z]+)/.exec(url);
  if (!m) return "";
  const 자원 = m[1];
  const 이름 = ({
    videos: "videos.list", channels: "channels.list", playlistItems: "playlistItems.list",
    search: "search.list", commentThreads: "commentThreads.list", thumbnails: "thumbnails.set",
    captions: "captions.insert",
  } as Record<string, string>)[자원] ?? 자원;
  let out = 이름;
  if (자원 === "videos" && (url.includes("/upload/") || url.includes("uploadType="))) out = "videos.insert";
  // videos.update(PUT)가 주소만 보고 videos.list(1유닛)로 세어져 계량기가 틀린 적이 있다 → 방식을 본다
  const 방식 = method.toUpperCase();
  if (out === "videos.list" && (방식 === "PUT" || 방식 === "DELETE")) out = 방식 === "PUT" ? "videos.update" : "videos.delete";
  return out;
}

/** 호출이 나가기 전에 부른다: 부른 자리 적기 → 폭주 감지 → 상한 확인 → 세기 */
export async function watch(이름: string, project = ""): Promise<void> {
  await 부른곳적기(이름);
  await 폭주인가(이름);
  막을까(이름, project);
  await spend(이름, project);
}

/* ─────────── 폭주 막이 ─────────── */
// 짧은 시간에 호출이 몰리면 그것은 언제나 되풀이(loop)다. 사람이 손으로 1분에 60번 누를 수는 없다.
export const 폭주기준초 = 60;
export const 폭주횟수 = 120; // 10채널 전체 갱신이 30초에 42건 — 정상 갱신마다 울리면 안 된다
const 최근호출: number[] = [];
let 마지막경보 = 0;

async function 폭주인가(이름: string) {
  const 지금 = Date.now() / 1000;
  최근호출.push(지금);
  while (최근호출.length && 지금 - 최근호출[0] > 폭주기준초) 최근호출.shift();
  if (최근호출.length <= 폭주횟수) return;
  if (마지막경보 && 지금 - 마지막경보 < 300) return; // 한 번 알렸으면 한동안 조용히
  마지막경보 = 지금;
  const 말 = `유튜브 호출이 ${폭주기준초}초에 ${최근호출.length}건 나갔습니다 (마지막: ${이름}). 되풀이가 도는 중일 수 있습니다.`;
  await log(`⚠ ${말}`);
  await recordLine("서버.log", `폭주감지  ${말}`);
}

/** 누가 이 호출을 시켰는지 남긴다. 「무엇을 몇 번」만으로는 범인을 못 잡는다. */
export let 추적 = true;
export function set추적(on: boolean) { 추적 = on; }

async function 부른곳적기(이름: string) {
  if (!추적) return;
  let 자리 = "";
  try {
    const lines = (new Error().stack ?? "").split("\n").slice(1);
    for (const l of lines) {
      if (/\/(quota|google|ytcore)\.ts/.test(l) || l.includes("ext:") || l.includes("node:")) continue;
      const m = /at (?:async )?(?:(\S+) \()?(?:file:\/\/)?([^):]+?):(\d+):\d+\)?/.exec(l);
      if (m) {
        자리 = `${m[2].split("/").pop()}:${m[3]} ${m[1] ?? ""}`.trim();
        break;
      }
    }
  } catch { /* 무시 */ }
  try {
    await Deno.mkdir(recordPath(), { recursive: true });
    await Deno.writeTextFile(recordPath("부른곳.log"), `${이름}\t${자리}\n`, { append: true, create: true });
  } catch { /* 무시 */ }
}

/* ─────────── 세기 ─────────── */

export async function spend(what: string, project = "", times = 1): Promise<void> {
  await withFileLock(잠금(), async () => {
    const d = 읽기();
    const 담기 = (b: Bucket) => {
      b.내역[what] = (b.내역[what] ?? 0) + times;
      if (what === "videos.insert") b.업로드 = (b.업로드 ?? 0) + times;
      else if (!별도통.has(what)) b.유닛 = (b.유닛 ?? 0) + 유닛(what) * times;
    };
    담기(d);
    if (project) {
      d.프로젝트 ??= {};
      담기(d.프로젝트[project] ??= 빈통());
    }
    try { await writeJson(파일(), d, { indent: 0 }); } catch { /* 못 적어도 하던 일을 멈추지 않는다 */ }
  });
}

function 통(project: string): Bucket {
  const d = 읽기();
  if (project && d.프로젝트?.[project]) return d.프로젝트[project];
  return project ? 빈통() : d;
}

/** 읽기로 쓴 **유닛**. 횟수가 아니다. */
export function 읽기쓴양(project = ""): number {
  const b = 통(project);
  return Object.entries(b.내역).filter(([k]) => !안막을것.has(k))
    .reduce((a, [k, v]) => a + 유닛(k) * v, 0);
}

function 막을까(이름: string, project: string) {
  if (안막을것.has(이름)) return;
  const 쓴 = 읽기쓴양(project);
  if (쓴 >= READ_CAP) {
    throw new 하루치넘음(
      `오늘 읽기 몫 ${READ_CAP.toLocaleString()}유닛을 다 썼습니다(현재 ${쓴.toLocaleString()}). ` +
        `올리기는 그대로 됩니다. 태평양 자정에 되살아납니다.`,
    );
  }
}

/** 오늘 메인 지갑(Queries per day)에서 나간 유닛 */
export function 오늘유닛(project = ""): number {
  const b = 통(project);
  return Object.entries(b.내역).filter(([k]) => !별도통.has(k)).reduce((a, [k, v]) => a + 유닛(k) * v, 0);
}

/** 별도 통(Video Batch Get Stats)에서 나간 몫 */
export function 오늘별도통(project = ""): number {
  const b = 통(project);
  return Object.entries(b.내역).filter(([k]) => 별도통.has(k)).reduce((a, [k, v]) => a + 유닛(k) * v, 0);
}

/** 오늘 몇 개나 더 올릴 수 있나 — 지갑이 먼저 비기 때문에 이 숫자가 진짜 한도다. */
export function 남은올리기(project = ""): number {
  return Math.max(0, Math.floor((DAILY - 오늘유닛(project)) / 유닛("videos.insert")));
}

/** 원장에 남은 오늘치 업로드 수 — 세는 기능을 나중에 붙였으므로 원장도 함께 본다(태평양 날짜 기준) */
function 원장오늘(): number {
  const 오늘 = quotaDay();
  let n = 0;
  try {
    for (const r of readLedger()) {
      const raw = r["업로드시각"] ?? "";
      const w = parseWall(raw);
      const t = w ? dateOf(instantToWall(wallToInstant(w, systemZone()), "America/Los_Angeles")) : raw.slice(0, 10);
      if (t === 오늘) n++;
    }
  } catch { return 0; }
  return n;
}
const dateOf = (w: Date) => `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}-${String(w.getUTCDate()).padStart(2, "0")}`;

export interface QuotaToday {
  날짜: string; 유닛: number; 유닛남음: number; 유닛한도: number;
  업로드: number; 업로드남음: number; 업로드한도: number;
  내역: Record<string, number>; 초기화: string;
}

/** 오늘 쓴 양과 남은 양. 저장된 합계를 믿지 않고 내역에서 다시 센다(보정·버그로 표류해도 표시는 실제와 같다). */
export function today(): QuotaToday {
  const d = 읽기();
  const 쓴유닛 = Object.entries(d.내역)
    .filter(([k]) => !별도통.has(k) && k !== "videos.insert")
    .reduce((a, [k, v]) => a + 유닛(k) * v, 0);
  const 쓴업로드 = Math.max(d.업로드 ?? 0, 원장오늘());
  return {
    날짜: d.날짜,
    유닛: 쓴유닛,
    유닛남음: Math.max(DAILY - 쓴유닛, 0),
    유닛한도: DAILY,
    업로드: 쓴업로드,
    업로드남음: Math.max(UPLOAD_DAILY - 쓴업로드, 0),
    업로드한도: UPLOAD_DAILY,
    내역: d.내역,
    초기화: untilQuotaReset(),
  };
}

/** 프로젝트별 쓴 양 — 구글 프로젝트가 둘 이상일 때 화면이 보여 준다 */
export function todayByProject(): Record<string, { 유닛: number; 업로드: number; 내역: Record<string, number> }> {
  const d = 읽기();
  const out: Record<string, { 유닛: number; 업로드: number; 내역: Record<string, number> }> = {};
  for (const [pid, b] of Object.entries(d.프로젝트 ?? {})) {
    out[pid] = {
      유닛: Object.entries(b.내역).filter(([k]) => !별도통.has(k) && k !== "videos.insert")
        .reduce((a, [k, v]) => a + 유닛(k) * v, 0),
      업로드: b.업로드 ?? 0,
      내역: b.내역,
    };
  }
  return out;
}

/** 구글 콘솔 숫자와 우리 숫자를 맞대 본다. (파이썬 재보기) */
export function 재보기(구글이말한: number): string {
  const 우리 = 오늘유닛();
  const 차 = 구글이말한 - 우리;
  if (Math.abs(차) <= Math.max(20, 구글이말한 * 0.05)) {
    return `맞습니다 — 우리 ${우리.toLocaleString()} · 구글 ${구글이말한.toLocaleString()}`;
  }
  return `어긋납니다 — 우리 ${우리.toLocaleString()} · 구글 ${구글이말한.toLocaleString()} (차이 ${차 >= 0 ? "+" : ""}${차.toLocaleString()})\n` +
    `  값표가 낡았거나 못 센 호출이 있습니다.`;
}

/** 터미널에 찍는 요약 (`할당량` 명령) */
export function report(): string {
  const t = today();
  const L = [
    `오늘(${t.날짜} 태평양 기준)`,
    `  일반    남음 ${t.유닛남음.toLocaleString()}   (${t.유닛.toLocaleString()} / ${t.유닛한도.toLocaleString()} 유닛 씀)`,
    `  업로드  남음 ${t.업로드남음}   (${t.업로드} / ${t.업로드한도} 건 씀)`,
    `  초기화  ${t.초기화}`,
  ];
  const 내역 = Object.entries(t.내역).sort((a, b) => b[1] - a[1]);
  if (내역.length) {
    L.push("", "  무엇에 썼나");
    for (const [k, v] of 내역) L.push(`    ${k.padEnd(22)} ${String(v).padStart(4)}회  (${(유닛(k) * v).toLocaleString()} 유닛)`);
  }
  return L.join("\n");
}

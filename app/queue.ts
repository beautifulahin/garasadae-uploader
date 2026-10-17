// 발사대기 — 정한 시각까지 **파일을 이 컴퓨터에 붙들어 두었다가** 그때 올린다. (파이썬: 발사대기.py)
//
// 왜 이렇게 하나
//   예전에는 예약을 걸어도 파일이 곧바로 유튜브로 갔다. 유튜브에는 비공개로 도착해 있고, 정한 시각에 공개만 시켰다.
//   결과는 비슷해 보이지만 고객 채널에 영상이 미리 가 있다는 점이 다르다.
//   이제는 정한 시각까지 파일이 여기 남아 있다가, 그 시각에 비로소 올라간다. 올라간 뒤 30분에 검토하고, 통과하면 바로 공개한다.
//
//       (예) 내일 09:06 예약
//            오늘  → 발사대기 칸에 담겨 있음 (유튜브에 아무것도 없음)
//            09:06 → 유튜브로 올라감(비공개)
//            09:36 → 검토 한 번
//            09:36 → 공개
//
// 감수해야 하는 것: **그 시각에 이 컴퓨터가 켜져 있고 외장이 붙어 있어야 한다.** 꺼져 있으면 그 영상은 안 올라간다.
// 대신 시각이 지나도 큐에 그대로 남아 있으므로, 컴퓨터를 켜면 다음 차례에 곧바로 올라간다(늦게라도 나간다).
//
// 누가 쏘나: 예약 작업이 10분마다 fire() 를 부른다. 사람이 앱에서 「지금 쏘기」를 눌러 앞당길 수도 있다.
import { baseName, cut, dataPath, readJsonSync, recordLine, withFileLock, writeJson } from "./paths.ts";
import { addDays, addHours, isoWall, minuteWall, nextQuotaReset, parseNaive, systemZone, wallNow } from "./clock.ts";
import { isLocked } from "./safety.ts";
import { normalizeJob } from "./shorts.ts";
import { DailyLimitReached, reflow } from "./daily.ts";
import { type Job, uploadOne } from "./upload.ts";
import { confFor } from "./channels.ts";
import { resolve } from "./ytcore.ts";
import { externalRoot } from "./tools.ts";
import { markDone } from "./folders.ts";
import { failNotice, launchNotice } from "./notify.ts";
import { GoogleError } from "./google.ts";

/** 이보다 오래 늦은 것은 사람에게 묻는다 (초) */
export const LATE_LIMIT = 24 * 3600;

const queueFile = () => dataPath("발사대기.json");
const nightFile = () => dataPath("심야발사.json");

/* ============================================================ 심야 금지 */

/** 자정~아침 7시 발사 금지 스위치. 기본은 켬. 해외 시청자를 노리는 채널을 돌릴 때는 화면의 🌙 스위치로 풀 수 있다. (파이썬 심야금지) */
export function nightBan(): boolean {
  try {
    const v = readJsonSync<Record<string, unknown> | null>(nightFile(), null);
    if (!v || typeof v !== "object") return true;
    return v["금지"] === undefined ? true : !!v["금지"];
  } catch {
    return true; // 못 읽으면 안전한 쪽(금지)
  }
}

/** 스위치를 뒤집고 새 값을 돌려준다 (파이썬 심야바꾸기) */
export async function toggleNight(): Promise<boolean> {
  const 지금 = !nightBan();
  await writeJson(nightFile(), { "금지": 지금 }, { indent: 0 });
  return 지금;
}

/* ============================================================ 일시정지 (예약 쏘기만 멈춘다) */

const pauseFile = () => dataPath("일시정지.json");

/** 화면의 「일시정지」 — 켜면 예약 작업(심사확인)이 발사대기를 쏘지 않는다. 사람이 누른 「지금 쏘기」·올리기는 그대로 된다. 파일이 진실이다(예약 작업은 다른 프로세스). */
export function paused(): boolean {
  try { return !!readJsonSync<{ 멈춤?: boolean }>(pauseFile(), {}).멈춤; } catch { return false; }
}
export async function setPaused(on: boolean): Promise<boolean> {
  await writeJson(pauseFile(), { 멈춤: !!on, 바꾼때: isoWall(wallNow()) });
  return !!on;
}

/* ============================================================ 목록 읽기·쓰기 */

/** 파일 그대로 (정렬·편성 없이). 못 읽으면 소리 내고 빈 목록. (파이썬 _읽기) */
export function readQueue(): Job[] {
  try {
    const d = readJsonSync<unknown>(queueFile(), []);
    return Array.isArray(d) ? (d as Job[]) : [];
  } catch (e) {
    console.log(`  발사대기 목록을 읽지 못했습니다 — ${(e as Error).message}`);
    return [];
  }
}

/** 일 한도 편성을 거쳐 쓴다 — 어떤 길로 담겼든 채널의 하루 편수를 넘지 않게 한다. (파이썬 _쓰기) */
async function writeQueue(d: Job[]): Promise<void> {
  await writeJson(queueFile(), reflow(d), { indent: 1 });
}

/**
 * 화면 서버·예약 작업·명령줄이 같은 파일을 만지므로 읽고-고치고-쓰기를 한 번에 한다.
 * (파이썬은 이 잠금이 없어서, 동시에 담고 빼면 한쪽이 덮어쓰일 수 있었다.)
 */
async function editQueue<T>(고치기: (q: Job[]) => { q: Job[]; out: T }): Promise<T> {
  const r = await withFileLock(dataPath(".queue.lock"), async () => {
    const { q, out } = 고치기(readQueue());
    await writeQueue(q);
    return out;
  });
  return r as T;
}

/** 쏠 시각이 이른 것부터. (파이썬 목록) */
export function list(): Job[] {
  // 파이썬 sorted(key=쏠때) 와 같게 글자 그대로 비교한다
  return readQueue().sort((a, b) => {
    const x = String(a.쏠때 ?? ""), y = String(b.쏠때 ?? "");
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * 정한 시각에 쏘도록 담는다. 같은 파일이 이미 있으면 시각만 고친다. (파이썬 담기)
 * job 에는 `_승인` 이 들어 있어야 한다 — 담는 순간이 사람이 허락한 순간이고, 쏠 때 그 표시를 그대로 들고 나간다.
 */
export async function add(job: Job, fireAt: string, say: (s: string) => void = console.log): Promise<boolean> {
  if (!job._승인) {
    say(`  승인 표시가 없어 담지 않았습니다 — ${baseName(String(job.file ?? ""))}`);
    return false;
  }
  const j = await normalizeJob(job); // 읽지 못하는 파일은 여기서 던진다 — 큐에 못 들어간다
  const 파일 = String(j.file ?? "");
  return await editQueue((q) => {
    const 있음 = q.find((x) => x.file === 파일);
    if (있음) {
      있음.쏠때 = fireAt;
      for (const k of ["영상종류", "롱폼", "allow_not_short"]) 있음[k] = j[k as keyof typeof j];
      return { q, out: true };
    }
    q.push({ ...j, 쏠때: fireAt, 담은때: isoWall(wallNow()) });
    return { q, out: true };
  });
}

/** 큐에서 뺀다. 뺄 것이 있었으면 true. (파이썬 빼기) */
export async function remove(file: string): Promise<boolean> {
  return await editQueue((q) => {
    const 새 = q.filter((x) => x.file !== file);
    return { q: 새, out: 새.length !== q.length };
  });
}

/**
 * 여러 개를 **한 번의 쓰기**로 뺀다 — 달력의 묶음 취소용. (파이썬 빼기들)
 * 86건을 하나씩 빼면 파일을 86번 다시 쓰게 된다. 비교는 NFC 로 — 외장 경로는 NFD 로 풀려 있을 수 있다.
 */
export async function removeMany(files: string[]): Promise<number> {
  const 표 = new Set(files.map((f) => String(f).normalize("NFC")));
  return await editQueue((q) => {
    const 새 = q.filter((x) => !표.has(String(x.file ?? "").normalize("NFC")));
    return { q: 새, out: q.length - 새.length };
  });
}

/** 쏠 시각이 된 것 (파이썬 쏠때된것) */
export function due(now: Date = wallNow()): Job[] {
  return list().filter((x) => {
    const t = parseNaive(String(x.쏠때 ?? ""));
    return !!t && t.getTime() <= now.getTime();
  });
}

/** 이 항목이 쏘기까지 남은 분. 이미 지났으면 음수. (파이썬 남은시간) */
export function minutesLeft(x: Job, now: Date = wallNow()): number {
  const t = parseNaive(String(x.쏠때 ?? ""));
  if (!t) return 0;
  return Math.floor((t.getTime() - now.getTime()) / 1000 / 60);
}

/** 유튜브 하루 업로드 한도가 풀리는 다음 시각(태평양 자정 + 10분)을 이 컴퓨터 시각 문자열로. (파이썬 다음한도초기화) */
export function nextReset(now: Date = new Date()): string {
  return isoWall(nextQuotaReset(now, systemZone()));
}

/** 하루 업로드 한도에 걸렸다는 응답인가. (2026-09-19 채널 하루 편수 한도(400)도 같이 미룬다) */
export function isLimitError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e) + " " + String((e as { body?: string })?.body ?? "");
  return ["429", "quotaExceeded", "Quota exceeded", "exceeded the number of videos", "uploadLimitExceeded"].some((k) => m.includes(k));
}

/* ============================================================ 쏘기 */

export interface FireOpts {
  quiet?: boolean;
  /** 이 파일 하나만 쏜다 (화면의 「지금 쏘기」) */
  file?: string;
  say?: (line: string) => void;
  /** 시험이 시계를 바꿔 끼운다 (벽시계) */
  now?: Date;
  /** 올리기를 시험이 대신한다 */
  uploader?: (job: Job) => Promise<string | null>;
  onProgress?: (sent: number, total: number) => void;
}

/** 기존 예약 실행과 즉시 전송을 직렬화해 같은 영상을 동시에 올리지 않는다. 쏜 편수를 돌려준다. (파이썬 쏘기) */
export async function fire(o: FireOpts = {}): Promise<number> {
  const 말 = o.quiet ? () => {} : (o.say ?? console.log);
  const r = await withFileLock(dataPath(".발사.lock"), () => fireLocked(o, 말), { wait: false });
  if (r === null) {
    말("  다른 전송이 진행 중입니다 — 대기열을 유지합니다");
    return 0;
  }
  return r;
}

async function fireLocked(o: FireOpts, 말: (s: string) => void): Promise<number> {
  if (isLocked()) {
    말("  올리기가 잠겨 있어 아무것도 쏘지 않았습니다");
    return 0;
  }
  const 지금 = o.now ?? wallNow();

  // 자정~아침 7시는 발사 금지(🌙 스위치로 풀 수 있음). 어떤 경로로 시각이 잡혔든 이 시간대에는 쏘지 않는다.
  if (nightBan() && 지금.getUTCHours() < 7) {
    말("  발사 금지 시간대(자정~07시) — 아침 7시 이후에 쏩니다");
    return 0;
  }

  // 밀린 작업과 새 즉시 요청도 채널의 하루 편수를 넘지 않게 전송 전에 다시 편성한다.
  const 기존 = readQueue();
  const 편성 = reflow(기존);
  if (JSON.stringify(편성) !== JSON.stringify(기존)) {
    await withFileLock(dataPath(".queue.lock"), () => writeQueue(편성));
  }
  let 쏠것 = due(지금);
  if (o.file !== undefined) 쏠것 = 쏠것.filter((j) => j.file === o.file);
  if (!쏠것.length) {
    말("  쏠 차례가 된 것이 없습니다");
    return 0;
  }

  let 쏨 = 0;
  for (const job of 쏠것) {
    const f = String(job.file ?? "");
    const 이름 = baseName(f);
    const 채0 = String(job._alias || job.channel || "");
    let 있음 = false;
    try { 있음 = (await Deno.stat(f)).isFile; } catch { /* 없다 */ }
    if (!있음) {
      // 외장이 통째로 안 붙은 것은 파일이 없는 게 아니라 **못 보는 것**이다. 여기서 빼 버리면 예약이 사라진다. 붙을 때까지 큐를 지킨다.
      const 뿌리 = externalRoot();
      let 뿌리있음 = true;
      try { await Deno.stat(뿌리); } catch { 뿌리있음 = false; }
      if (f.startsWith(뿌리) && !뿌리있음) {
        말(`  ${이름} — 외장이 안 붙어 있어 이번 차례는 건너뜁니다(큐 유지)`);
        continue;
      }
      말(`  ${이름} — 파일이 사라져 큐에서 뺍니다`);
      await remove(f);
      // 텔레그램만 보내면 놓친다(실제로 놓쳤다) — 장부에도 남긴다. 이 줄은 브리핑 팝업(「확인이 필요합니다」)이 읽는다.
      await recordLine("올리기.log", `발사무산 [${채0}] ${이름}  파일이 제자리에 없어 큐에서 뺌  (예정 ${job.쏠때 ?? ""})`);
      try { await failNotice(채0, 이름, "파일이 사라져 큐에서 뺐습니다 — 사람이 봐야 합니다"); } catch { /* 알림 실패는 본 일을 막지 않는다 */ }
      continue;
    }
    try {
      // 담을 때 사람이 허락한 것이므로 그 표시를 그대로 들고 나간다. 출구검사가 이것을 본다.
      // 문안 열쇠가 빠진 항목(복원 등으로 손으로 만든 것)도 안 죽게 기본값을 채운다 — 제목·설명은 어차피 영상 옆 txt 가 이긴다.
      const 일감: Job = { title: "", desc: "", tags: [], allow_not_short: false, time_by: "user", ...job };
      const 영상id = (await (o.uploader ? o.uploader(일감) : uploadOne(일감, { say: 말, onProgress: o.onProgress }))) ?? "";
      await remove(f);
      쏨++;
      말(`  쏨   ${이름}  (예정 ${job.쏠때 ?? ""})`);
      // 텔레그램으로 알린다. **실패해도 올리기를 막지 않는다.**
      try {
        let 채 = String(job._alias || job.channel || "");
        try { 채 = resolve(채) ?? 채; } catch { /* 이름을 못 찾으면 그대로 */ }
        const 제 = String(job._title || job.title || baseName(f).replace(/\.[^.]+$/, ""));
        await launchNotice(채, 제, 영상id, String(job.쏠때 ?? ""), list().length, String(job.publish_at ?? ""));
      } catch (e) {
        말(`    알림 실패 — ${(e as Error).name}: ${cut((e as Error).message, 60)}`);
      }
      try {
        await markDone(f, confFor(String(job.channel ?? "")) ?? confFor(채0));
      } catch (e) {
        말(`    파일 정리 실패 — ${cut((e as Error).message, 60)}`);
      }
      await recordLine("올리기.log", `발사   [${job.channel ?? ""}] ${이름}  예정 ${job.쏠때 ?? ""}`);
    } catch (e) {
      if (e instanceof DailyLimitReached) {
        await withFileLock(dataPath(".queue.lock"), () => writeQueue(readQueue())); // 편성을 다시 맞춘다
        // 한도는 채널마다 다르다 — 예외가 가진 문구를 그대로 보인다
        말(`  ${이름} — ${(e as Error).message} (큐 유지)`);
        continue;
      }
      // 사람이 긴급중단을 눌렀다 — 실패가 아니다. 알리지 않고, 다시 쏘지 않게 발사대기에서 빼고, 남은 것도 멈춘다(멈추라고 눌렀는데 다음 차례에 다시 올라가면 안 된다).
      if (e instanceof GoogleError && e.reason === "aborted") {
        말(`  ${이름} — 사람이 중단해 발사대기에서 뺍니다`);
        await remove(f);
        await recordLine("올리기.log", `중단   [${채0}] ${이름}  사람이 긴급중단 — 발사대기에서 뺌`);
        break;
      }
      const 까닭 = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 120);
      // ── 하루 업로드 한도(429 · Video Uploads) ───────────────────
      //   한도에 걸리면 남은 것을 하나씩 더 두드려 봐야 전부 거절된다. (실측: 88번째부터 62편이 줄줄이 429)
      //   여기서 멈추고 남은 것 전부를 다음 초기화(태평양 자정 + 10분) 뒤로 미룬다.
      if (isLimitError(e)) {
        const 다음 = nextReset();
        const 남은 = new Set(쏠것.map((j) => String(j.file ?? "")));
        const n = await editQueue((q) => {
          let 센 = 0;
          for (const x of q) {
            if (남은.has(String(x.file ?? "")) && String(x.쏠때 ?? "") < 다음) {
              x.쏠때 = 다음;
              센++;
              // ★공개 예약도 **하루씩 미룬다** (「오늘 막혔으면 내일, 내일 막히면 모레」). 올릴 때 이미 지난 예약이면
              //   검토 뒤 곧바로 공개돼 버리므로, 올리기+1시간 뒤가 될 때까지 같은 시각으로 하루씩 민다.
              const pa = x.publish_at;
              if (pa) {
                let t = parseNaive(String(pa));
                const 한계 = addHours(parseNaive(다음)!, 1);
                if (t) {
                  while (t.getTime() < 한계.getTime()) t = addDays(t, 1);
                  x.publish_at = minuteWall(t);
                }
              }
            }
          }
          return { q, out: 센 };
        });
        말(`  하루 업로드 한도에 걸렸습니다 — 남은 ${n}편을 ${다음} 로 미룹니다`);
        await recordLine("올리기.log", `한도미룸  ${n}편 → ${다음}  (${이름})`);
        break;
      }
      말(`  ${이름} — 쏘지 못했습니다: ${까닭.slice(0, 90)}`);
      try { await failNotice(채0, 이름, 까닭); } catch { /* 알림 실패는 본 일을 막지 않는다 */ }
      // 장부에도 — 텔레그램은 흘러가고, 팝업은 이 줄을 읽는다.
      await recordLine("올리기.log", `발사실패 [${채0}] ${이름}  ${까닭}  (큐에 남아 다음 차례에 다시 쏩니다)`);
    }
  }
  return 쏨;
}

/** 명령줄·화면용: 대기 목록을 사람이 읽는 줄로 (파이썬 __main__ 출력) */
export function describe(now: Date = wallNow()): string[] {
  const d = list();
  if (!d.length) return ["발사대기에 담긴 것이 없습니다."];
  const 줄 = [`발사대기 ${d.length}건`];
  for (const x of d) {
    const 남 = minutesLeft(x, now);
    const 상 = 남 > 60 ? `${Math.floor(남 / 60)}시간 ${남 % 60}분 뒤` : 남 > 0 ? `${남}분 뒤` : `⚠ ${-남}분 늦음 — 다음 차례에 쏩니다`;
    let 이름 = String(x._alias || x.channel || "");
    try { 이름 = resolve(이름) ?? 이름; } catch { /* 그대로 */ }
    줄.push(`  ${String(x.쏠때 ?? "").slice(0, 16)}  [${이름}] ${cut(baseName(String(x.file ?? "")), 34)}`);
    줄.push(`    ${상}`);
  }
  return 줄;
}

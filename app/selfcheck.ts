// 놀 때는 유튜브를 부르지 않는다 — 그것을 **시험으로** 못 박는다. (파이썬: 점검.py)
//
// 왜 이 파일이 있나
//   2026-08-27 에 하루치 10,000유닛이 사라졌다. 원인을 찾는 데 오래 걸린 이유는 하나였다. **아무도 재고 있지 않았다.**
//   그때 새던 것은 두 군데였다.
//     · 화면을 그릴 때마다 채널 수만큼 videos.list      (지표 캐시로 막음)
//     · 검토 루틴이 대기가 없어도 sync 로 채널 전체 훑기 (지목 조회로 바꿈)
//   둘 다 「가만히 있을 때 조용해야 하는 자리」였다. 사람이 아무것도 안 눌렀는데 호출이 나가면 그것은 언제나 새는 것이다.
//   그래서 규칙을 이렇게 세운다.
//
//       사람이 시키지 않았는데 나가는 유튜브 호출은 0건이어야 한다.
//
//   이 파일은 그 규칙을 실제로 돌려서 확인한다. 누가 나중에 뜨거운 자리에 호출을 하나 더 얹으면 **여기서 걸린다.**
//
// 어떻게 재나
//   모든 유튜브 호출은 google.ts 한 곳을 지나며 호출이 **나가기 전에** 세어진다(quota.watch → 기록/부른곳.log).
//   그래서 한도가 바닥나 있어도, 오프라인이어도 센다. 검사하는 동안은 GARASADAE_OFFLINE=1 로 막아 두어
//   새는 자리가 있어도 진짜 유튜브에는 닿지 않고 숫자만 잡힌다. (이미 켜져 있으면 존중하고, 끝나면 원래대로 돌려놓는다.)
//
// 조심한 것
//   · 진단 도구는 읽기만 한다. 공개 함수를 부르는 점검 때문에 대기 중인 영상이 실제로 공개된 사고가 있었다(2026-08-28).
//     그래서 검토 루틴은 항상 공개 안 함(false)으로, 그것도 **임시 데이터 폴더**에서 돌린다.
//   · 이어올리기는 execute() 가 아니라 청크 PUT 으로 나간다 — 감싸는 자리를 하나 빠뜨리면 업로드가 통째로 안 세어진다.
//     그래서 원장에 적힌 오늘 업로드 수와 계량기를 맞대 본다.
import * as quota from "./quota.ts";
import { dataPath, recordPath } from "./paths.ts";
import { dateOnly, instantToWall, isoWall, parseWall, quotaDay, systemZone, wallNow, wallToInstant } from "./clock.ts";
import { readLedger } from "./ledger.ts";
import { describePending, run as reviewRun } from "./review.ts";
import { describe as describeQueue, due as queueDue, list as queueList } from "./queue.ts";
import { loadSubs } from "./subs.ts";
import { cmdPreview, cmdStatus, dailyForChannel, loadChannelsPlan } from "./plan.ts";
import { recallOn, run as recallRun } from "./recall.ts";
import { perfFor } from "./perf.ts";
import { msgOf } from "./stats.ts";

const 없음 = () => {};

/** 가만히 있을 때 돌아야 하는 자리 하나 */
export interface IdleCheck {
  name: string;
  /** 새면 왜 안 되는지 (보고에 그대로 나간다) */
  why: string;
  fn: () => unknown | Promise<unknown>;
  /** 임시 데이터 폴더에서 돌린다 (진짜 기록을 건드리지 않게) */
  sandbox?: boolean;
  /** 임시 폴더를 채운다 (sandbox 일 때) */
  setup?: () => Promise<void>;
}

export interface IdleRow { name: string; calls: number; callers: string[]; note: string; leaked: boolean }

export interface SelfCheckReport {
  rows: IdleRow[];
  /** 오늘(태평양 날짜) 원장에 적힌 업로드 수 / 계량기가 센 videos.insert */
  ledger: number;
  meter: number;
  /** 올리기 셈이 새는가 (원장이 계량기보다 많다 = 올렸는데 안 셌다) */
  leakInsert: boolean;
  bad: number;
  lines: string[];
}

async function 줄수(path: string): Promise<string[]> {
  try { return (await Deno.readTextFile(path)).split("\n").filter((x) => x !== ""); } catch { return []; }
}

/** 함수를 돌리는 동안 나간 유튜브 호출 수를 센다. (파이썬: 점검._센다) */
async function 센다(c: IdleCheck): Promise<{ n: number; callers: string[]; note: string }> {
  const 앞추적 = quota.추적;
  quota.set추적(true); // 누가 불렀는지까지 남게
  const 기록 = recordPath("부른곳.log");
  await Deno.mkdir(recordPath(), { recursive: true }).catch(() => {});
  const 앞 = (await 줄수(기록)).length;
  let note = "";
  try {
    await c.fn();
  } catch (e) {
    note = `  (돌리다 멈춤: ${(e as Error)?.name ?? "오류"}: ${msgOf(e).slice(0, 70)})`;
  } finally {
    quota.set추적(앞추적);
  }
  const 줄 = await 줄수(기록);
  const 난것 = [...new Set(줄.slice(앞).map((x) => x.trim()))].sort();
  return { n: 줄.length - 앞, callers: 난것, note };
}

/** 임시 데이터 폴더에서 일을 한다. 끝나면 원래 폴더로 돌아오고 임시 폴더는 지운다. */
async function 임시폴더에서<T>(setup: (() => Promise<void>) | undefined, 일: () => Promise<T>): Promise<T> {
  const 앞 = Deno.env.get("GARASADAE_DATA_DIR");
  const dir = await Deno.makeTempDir({ prefix: "garasadae_점검_" });
  Deno.env.set("GARASADAE_DATA_DIR", `${dir}/데이터`);
  try {
    await Deno.mkdir(recordPath(), { recursive: true });
    if (setup) await setup();
    return await 일();
  } finally {
    if (앞 === undefined) Deno.env.delete("GARASADAE_DATA_DIR"); else Deno.env.set("GARASADAE_DATA_DIR", 앞);
    try { await Deno.remove(dir, { recursive: true }); } catch { /* 임시 폴더가 남아도 된다 */ }
  }
}

/** 원장에 적힌 오늘 업로드 수와 계량기가 센 videos.insert 수. (파이썬: 점검._올리기셈맞나) */
export function uploadCounts(): { ledger: number; meter: number } {
  const 오늘 = quotaDay();
  let ledger = 0;
  for (const r of readLedger()) {
    const w = parseWall(r["업로드시각"] ?? "");
    if (!w) continue;
    // 원장 시각은 이 컴퓨터 시각이고, 구글의 하루는 태평양 날짜다
    if (dateOnly(instantToWall(wallToInstant(w, systemZone()), "America/Los_Angeles")) === 오늘) ledger++;
  }
  return { ledger, meter: quota.today().내역["videos.insert"] ?? 0 };
}

/**
 * 가만히 있을 때 새는 자리들. 모두 읽기만 한다.
 * (실제로 돌리는 서버·예약 작업이 가만히 있을 때 부르는 것과 같은 함수들이다.)
 */
export function defaultChecks(): IdleCheck[] {
  return [
    {
      name: "화면 한 번 그리기",
      why: "사람이 갱신을 누르지 않았으면 저장해 둔 지표만 읽어야 한다",
      fn: async () => {
        const chans = loadChannelsPlan(없음);
        await cmdStatus(chans, 없음);
        await cmdPreview(chans);
        await perfFor(chans);
        describePending();
        describeQueue();
      },
    },
    {
      name: "문제 모으기(신호등)",
      why: "맨 위 신호등은 화면마다 그려진다. 문제를 모으다 유튜브를 부르면 화면을 열 때마다 새는 것이다",
      // 글자 그대로 동적으로 부른다 — 모듈이 아직 없거나 고장 나도 점검 전체가 멈추지 않고(「돌리다 멈춤」으로 알린다), 실행 파일을 구울 때는 함께 묶인다
      fn: async () => {
        const ISS = await import("./issues.ts");
        await ISS.collect(loadChannelsPlan(없음), dailyForChannel);
      },
    },
    {
      name: "검토 루틴(대기 없음·볼 차례 아님)",
      why: "볼 차례가 아니면 유튜브에 물어볼 일도 없다. 점검은 공개 안 함(false)으로만 부른다",
      sandbox: true,
      setup: async () => {
        // 방금 올린 영상(30분 안 됨)과 사람에게 넘긴 영상 — 둘 다 아직 기계가 물어볼 차례가 아니다
        const 지금 = isoWall(wallNow());
        await Deno.writeTextFile(dataPath("pending.json"), JSON.stringify([
          { channel: "점검채널", video_id: "idle_new", title: "방금 올린 영상", publish_at: null, uploaded: 지금, 확인수: 0, 사람확인: false, 시각정한이: "auto" },
          { channel: "점검채널", video_id: "idle_human", title: "사람에게 넘긴 영상", publish_at: null, uploaded: 지금, 확인수: 1, 사람확인: true, 시각정한이: "auto", 마지막확인: 지금 },
        ]));
      },
      fn: async () => { await reviewRun(false, ""); },
    },
    {
      name: "발사대기 훑기(쏘지 않음)",
      why: "대기 목록을 읽고 쏠 때가 된 것을 가리는 일은 파일만 읽는다",
      fn: () => { queueList(); queueDue(); describeQueue(); },
    },
    {
      name: "상태 읽기",
      why: "화면이 5초·20초마다 부르는 자리다. 여기서 새면 치명적이다",
      fn: async () => { quota.today(); await loadSubs(); },
    },
    {
      name: "저성과 회수(꺼져 있으면)",
      why: "꺼 둔 기능은 유튜브를 부르지 않는다 (켠 채널이 있으면 한 시간에 한 번 부르는 것이 설계라 여기서는 건너뛴다)",
      fn: async () => { if (!recallOn()) await recallRun({ say: 없음 }); },
    },
  ];
}

export interface SelfCheckOpts {
  say?: (line: string) => void;
  /** 검사하는 동안 오프라인 가드를 켠다 (기본 켬). 서버 안에서 부를 때는 끄고 부르지 말고 명령줄에서 돌릴 것 */
  guardOffline?: boolean;
  /** 점검할 자리들 (기본: defaultChecks) */
  checks?: IdleCheck[];
}

/** 검사를 돌려 보고서를 만든다. 아무것도 바꾸지 않는다. */
export async function runChecks(checks: IdleCheck[] = defaultChecks(), o: SelfCheckOpts = {}): Promise<SelfCheckReport> {
  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); (o.say ?? console.log)(s); };
  const 앞가드 = Deno.env.get("GARASADAE_OFFLINE");
  if (o.guardOffline !== false) Deno.env.set("GARASADAE_OFFLINE", "1");
  const rows: IdleRow[] = [];
  let bad = 0;
  let counts = { ledger: 0, meter: 0 };
  try {
    say("");
    for (const c of checks) {
      const r = c.sandbox ? await 임시폴더에서(c.setup, () => 센다(c)) : await 센다(c);
      const leaked = r.n > 0;
      rows.push({ name: c.name, calls: r.n, callers: r.callers, note: r.note, leaked });
      say(`  [${leaked ? "샌다" : "통과"}] ${c.name.padEnd(22)} 유튜브 호출 ${r.n}건`);
      if (r.note) say(r.note);
      if (leaked) {
        bad++;
        say(`         ${c.why}`);
        for (const x of r.callers.slice(0, 6)) say(`         → ${x}`);
      }
    }
    say("");
    counts = uploadCounts();
  } finally {
    if (앞가드 === undefined) Deno.env.delete("GARASADAE_OFFLINE"); else Deno.env.set("GARASADAE_OFFLINE", 앞가드);
  }

  // 계량기가 원장보다 **많은** 것은 누수가 아니다 — 사람이 스튜디오에서 지운 영상의 원장 줄을 정리하면 그렇게 된다(호출은 실제로 있었다).
  // 무서운 것은 반대 방향: 올렸는데 계량기가 안 셌을 때다.
  const { ledger, meter } = counts;
  if (meter > ledger) {
    say(`  [참고] 계량기 ${meter}편 > 원장 ${ledger}편 — 원장 정리(삭제 영상) 차이일 수 있습니다. 기록/원장정리.log 를 보세요.`);
  }
  const leakInsert = ledger > meter;
  if (leakInsert) {
    bad++;
    say(`  [샌다] 올리기 셈이 안 맞습니다 — 원장 ${ledger}편 · 계량기 ${meter}편`);
    say("         이어올리기는 한 번에 보내지 않고 조각으로 나갑니다. 끝났을 때 quota.spend(videos.insert) 를 세는 자리를 보세요.");
  } else {
    say(`  [통과] 올리기 셈                 원장 ${ledger}편 ${ledger === meter ? "=" : "·"} 계량기 ${meter}편`);
  }
  say("");
  if (bad) {
    say(`  ${bad}개 자리에서 문제가 있습니다.`);
    say("  위 내용을 보고 고치세요.\n");
  } else {
    say("  가만히 있을 때 유튜브 호출 0건 — 규칙을 지키고 있습니다.\n");
  }
  return { rows, ledger, meter, leakInsert, bad, lines };
}

/** 명령줄: 종료 코드를 돌려준다 (문제가 있으면 1). (파이썬: 점검.main) */
export async function main(o: SelfCheckOpts = {}): Promise<number> {
  const rep = await runChecks(o.checks ?? defaultChecks(), o);
  return rep.bad ? 1 : 0;
}

if (import.meta.main) Deno.exit(await main());

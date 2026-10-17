// 심사확인 — 10분마다 한 번 도는 점검. (파이썬: 심사확인.sh)
//
// 순서가 정해져 있다 — 쏠 시각이 된 것을 먼저 올리고, 그 다음에 검토한다. 순서가 반대면 방금 올린 것을 그 자리에서 검토하려 들어 헛돈다.
//   ① 쏘기(발사대기) → ② 검토·공개 → ③ 썸네일 재시도 → ④ 저성과 회수(켠 채널만) → ⑤ 구독·영상 지표 찍기 → ⑥ 보관(+외장 백업) → ⑦ 밤 10시 뒤 하루 요약 → ⑧ 기록 자르기
//
// 누가 돌리나: 화면 서버가 켜져 있는 동안은 서버가 10분마다, 꺼져 있으면 예약 작업(맥 launchd · 윈도우 작업 스케줄러)이 `심사확인` 명령으로.
//   둘이 겹쳐 돌지 않게 파일 잠금(.심사확인.lock)과 「마지막으로 돈 때」(기록/심사확인.last)로 막는다.
// 놀 때(올릴 것도 검토할 것도 없을 때)는 유튜브를 한 번도 부르지 않는다 — 구독·영상 지표만 하루 한 점(채널당 1유닛) 찍는다.
import { dataPath, readJsonSync, recordLine, recordPath, trimLogs, withFileLock, writeTextAtomic } from "./paths.ts";
import { isoWall, parseNaive, wallNow, type Wall } from "./clock.ts";
import { appSettings } from "./settings.ts";
import * as Q from "./queue.ts";
import * as R from "./review.ts";
import * as T from "./thumbs.ts";
import * as RC from "./recall.ts";
import * as SB from "./subs.ts";
import * as AR from "./archive.ts";
import * as NF from "./notify.ts";
import { pathConfig } from "./tools.ts";
import { holdReason } from "./hold.ts";

export interface TickOpts {
  say?: (line: string) => void;
  /** 시험이 시계를 바꿔 끼운다 (벽시계) */
  now?: Wall;
  /** 마지막으로 돈 때·간격을 무시하고 지금 돈다 (화면의 「지금 확인」·명령줄) */
  force?: boolean;
  /** 쏘기를 시험이 대신한다 */
  fire?: () => Promise<number>;
}

export interface TickResult {
  /** 돌지 않은 까닭(비어 있으면 돌았다) */
  skipped: string;
  fired: number;
  reviewed: { opened: number; kept: number; blocked: number } | null;
  /** 단계별 한 줄 */
  steps: { name: string; ok: boolean; note: string }[];
  lines: string[];
}

const lastFile = () => recordPath("심사확인.last");
const mirrorFile = () => recordPath("외장백업.last");

/** 마지막으로 돈 때 (벽시계). 없으면 null */
export function lastTick(): Wall | null {
  try { return parseNaive(Deno.readTextFileSync(lastFile()).trim()); } catch { return null; }
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);

export async function tick(o: TickOpts = {}): Promise<TickResult> {
  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); o.say?.(s); };
  const res: TickResult = { skipped: "", fired: 0, reviewed: null, steps: [], lines };
  const now = o.now ?? wallNow();

  // 이행 보류 중이면 아무것도 하지 않는다 — 쏘기도 공개도 회수도 지표 찍기도 (옛 판 자료를 옮긴 결과가 확인될 때까지 새 판은 쉰다)
  const 보류 = holdReason();
  if (보류) { res.skipped = `이행 보류 중 — ${보류}`; return res; }

  // 겹쳐 돌지 않게: 마지막으로 돈 지 (간격-1)분이 안 지났으면 건너뛴다 — 화면 서버와 예약 작업이 둘 다 있을 때 한 번만 돈다
  const every = appSettings().tickMinutes;
  const last = lastTick();
  if (!o.force && last && (now.getTime() - last.getTime()) / 60_000 < Math.max(1, every - 1)) {
    res.skipped = `방금(${isoWall(last).slice(11, 16)}) 돌았습니다`;
    return res;
  }
  const got = await withFileLock(dataPath(".심사확인.lock"), async () => {
    say(`───────── ${isoWall(now).replace("T", " ")} ─────────`);
    await writeTextAtomic(lastFile(), isoWall(now));

    const step = async (name: string, f: () => Promise<string | void>) => {
      try {
        const note = (await f()) ?? "";
        res.steps.push({ name, ok: true, note });
      } catch (e) {
        res.steps.push({ name, ok: false, note: msgOf(e) });
        say(`  ${name} 실패 — ${msgOf(e)}`);
      }
    };

    // ① 쏘기 — 잠금·일시정지·심야 금지는 안에서 따진다. 일시정지면 예약 쏘기만 멈춘다(검토·공개는 계속).
    await step("쏘기", async () => {
      if (Q.paused()) { say("  일시정지 중이라 예약 쏘기는 건너뜁니다"); return "일시정지"; }
      res.fired = await (o.fire ? o.fire() : Q.fire({ quiet: true, say, now }));
      return `${res.fired}편`;
    });
    // ② 검토·공개 (누가 = 예약작업)
    await step("검토·공개", async () => {
      const r = await R.run(true, "예약작업", { say });
      res.reviewed = { opened: r.opened, kept: r.kept, blocked: r.blocked };
      return `공개 ${r.opened} · 보류 ${r.kept} · 차단 ${r.blocked}`;
    });
    // ③ 썸네일 재시도 — 표식이 없으면 유튜브 호출 0건
    await step("썸네일", async () => {
      const r = await T.retryPending();
      return `확인 ${r.확인} · 붙임 ${r.붙임}`;
    });
    // ④ 저성과 회수 — 채널이 켠 곳만, 한 시간에 한 번만 실제로 돈다
    await step("회수", async () => {
      const r = await RC.run({ say });
      return `후보 ${r.rows.length}`;
    });
    // ⑤ 구독자·영상 지표를 하루 한 점씩 — 이미 찍힌 날은 그냥 지나간다(채널당 하루 1유닛)
    await step("지표 찍기", async () => {
      const a = await SB.snapToday(true);
      const b = await SB.snapVideos(true);
      return `구독 ${a} · 영상 ${b}`;
    });
    // ⑥ 보관 — 하루 한 번 날짜를 붙여 얼려 둔다. 외장 백업은 사용자가 대상을 정해 둔 때만, 6시간에 한 번.
    await step("보관", async () => {
      const n = await AR.keepToday(true);
      let 백업 = "";
      if (pathConfig()["백업대상"]) {
        const at = (() => { try { return parseNaive(Deno.readTextFileSync(mirrorFile()).trim()); } catch { return null; } })();
        if (!at || (now.getTime() - at.getTime()) / 3600_000 >= 6) {
          const m = await AR.mirror(true);
          await writeTextAtomic(mirrorFile(), isoWall(now));
          백업 = ` · 외장 백업 ${m.code === 0 ? "복사 " + m.copied : m.code === 2 ? "외장 없음" : "실패"}`;
        }
      }
      return `보관 ${n}${백업}`;
    });
    // ⑦ 밤 10시가 지났으면 오늘 정리를 한 번 보낸다(하루 한 번만 — 안에서 막는다)
    await step("하루 요약", async () => {
      if (now.getUTCHours() < 22) return "아직";
      return (await NF.daySummary(true)) ? "보냄" : "건너뜀";
    });
    // ⑧ 기록이 너무 커지지 않게 정리한다(심사확인만이 아니라 전부)
    await step("기록 정리", async () => { const r = await trimLogs(); return `${r.length}개`; });

    for (const s of res.steps) await recordLine("심사확인.log", `${s.ok ? "·" : "✗"} ${s.name}  ${s.note}`);
    return true;
  }, { wait: false });
  if (got === null) res.skipped = "다른 심사확인이 돌고 있습니다";
  void readJsonSync;
  return res;
}

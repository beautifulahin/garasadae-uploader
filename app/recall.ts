// 저성과 회수 — 올린 지 일주일이 지났는데 조회수가 1000 에 못 미치면 비공개로 되돌린다. (파이썬: 회수.py)
//
// 규칙 (원본: 2026-10-05 「유튜브에 일주일 1000 조회수 미만은 비공개로 돌려」)
//   올린 지 **7일(168시간) 넘은** 공개 영상 가운데 누적 조회수가 **1000 미만**이면 비공개로 돌린다.
//   상한 나이는 없다 — 7일 넘은 옛 영상도 걸린다. 한 번 1000 을 넘긴 편은 계속 공개다(매번 다시 재지만 1유닛/50편).
//
// ★ 기본은 꺼져 있다 ★ (원본은 켜져 있고 「회수제외」 로 뺐다 — 공개 앱은 반대로 한다)
//   영상을 내리는 일은 되돌리려면 사람이 스튜디오에서 직접 공개해야 한다. 그래서 채널 설정에 `회수: true` 를 적은
//   채널만 돈다. `회수제외: true` 는 켠 채널 안에서 그 이름(칸)의 영상을 빼는 용도로 원본과 같게 둔다
//   (롱폼처럼 느리게 오래 크는 영상을 쇼츠 잣대로 재면 멀쩡한 것을 내리게 된다).
//   한 유튜브 채널을 두 이름(쇼츠용·롱폼용)으로 등록했으면 원장에는 토큰 첫 이름으로 적히므로, 같은 채널의 어느 칸이든 켰으면 켠 채널이다.
//
// 어떻게 도나
//   예약 작업이 10분마다 부르지만 **한 시간에 한 번만** 실제로 돈다(55분 스로틀). 조회수는 batchGetStats 한 방(딴 지갑 1유닛)으로
//   본다. 한 바퀴에 최대 30편만 내린다(내리기 1편 50유닛 — 업로드 몫을 남긴다).
//
// 내린 것은
//   · 비공개로 내리는 것은 반드시 영상바꾸기(읽고 합쳐 쓰기) 한 길로 — privacyStatus 만 보내면 퍼가기·통계 공개·합성 표시가 지워진다
//   · 「사람이 내린 영상」 명단(수동비공개)에 올린다 — 어떤 자동 루틴도 다시 공개하지 못한다. 되살리려면 사람이 스튜디오에서.
//   · 원장 공개설정을 「저성과비공개」로 적는다 — 다시는 검사 안 한다
//   · 텔레그램으로 알린다(무엇을 왜 내렸는지)
import { cut, recordLine, recordPath, writeTextAtomic } from "./paths.ts";
import { diffMinutes, isoWall, parseNaive, systemZone, type Wall, wallNow } from "./clock.ts";
import { type Channels, loadChannels } from "./channels.ts";
import { patchLedger, readLedger } from "./ledger.ts";
import { isLocked, manualPrivateAdd } from "./safety.ts";
import { resolve, ytFor, 영상바꾸기 } from "./ytcore.ts";
import { commaInt, fixed, msgOf, statsOnce } from "./stats.ts";
import { send } from "./notify.ts";

export const VIEWS_BAR = 1000; // 이 미만이면 내린다
export const MIN_AGE_HOURS = 168; // 일주일이 안 됐으면 아직 기회를 준다
export const MAX_PER_ROUND = 30; // 한 바퀴에 내리는 최대 편수
export const THROTTLE_MIN = 55; // 이보다 자주는 안 돈다
export const LOWERED = "저성과비공개"; // 원장 공개설정에 적는 말

const 표식 = () => recordPath("회수마지막.txt");

export interface RecallCandidate { id: string; channel: string; title: string; ageHours: number }

/** 이 채널 설정 칸이 회수를 켰나 — 칸 이름·채널ID 어느 쪽으로 찾아도 된다 */
function 설정칸(채널: string, chans: Channels) {
  if (chans[채널]) return chans[채널];
  return Object.values(chans).find((v) => v.channel_id && v.channel_id === 채널) ?? null;
}

/** 켠 채널이 하나라도 있나 (없으면 이 기능은 통째로 꺼져 있다) */
export function recallOn(chans: Channels = loadChannels()): boolean {
  return Object.values(chans).some((cf) => cf["회수"] === true && !cf.회수제외);
}

/** 원장 줄의 채널 이름이 회수 대상인가 */
export function recallable(채널: string, chans: Channels = loadChannels()): boolean {
  const cf = 설정칸(채널, chans);
  if (!cf) return false; // 설정에 없는 이름은 켜지 않았다
  if (cf.회수제외) return false; // 켠 채널 안에서 빼 둔 칸
  if (cf["회수"] === true) return true;
  const cid = cf.channel_id;
  return !!cid && Object.values(chans).some((v) => v.channel_id === cid && v["회수"] === true && !v.회수제외);
}

/** 원장에서 「공개 · 올린 지 7일 넘음 · 회수를 켠 채널」 인 줄을 모은다. (파이썬: 회수._후보) */
export function candidates(now: Wall = wallNow(), chans: Channels = loadChannels()): RecallCandidate[] {
  if (!recallOn(chans)) return [];
  const out: RecallCandidate[] = [];
  for (const r of readLedger()) {
    if ((r["공개설정"] ?? "").trim() !== "public") continue; // 예약·비공개·이미 내린 것은 제외
    const 채널 = (r["채널"] ?? "").trim();
    if (!recallable(채널, chans)) continue;
    const 올림 = parseNaive(r["업로드시각"] ?? "");
    if (!올림) continue;
    const id = (r["영상ID"] ?? "").trim();
    if (!id) continue;
    const ageHours = diffMinutes(now, 올림) / 60;
    if (MIN_AGE_HOURS < ageHours) out.push({ id, channel: 채널, title: (r["제목"] ?? "").slice(0, 40), ageHours });
  }
  return out;
}

export type RecallVerdict = "pass" | "low" | "noreply" | "lowered" | "later" | "failed" | "locked";
export interface RecallRow extends RecallCandidate { views: number | null; verdict: RecallVerdict; note: string }

export interface RecallResult {
  /** 이번에 비공개로 내린 편수 */
  lowered: number;
  /** 후보(7일 넘은 공개 영상) 수 */
  candidates: number;
  /** "" 돌았다 · off 꺼져 있다 · throttle 아직 차례가 아니다 · error 조회수를 못 읽었다 */
  skipped: "" | "off" | "throttle" | "error";
  rows: RecallRow[];
  lines: string[];
}

export interface RecallOpts {
  /** 스로틀을 무시하고 지금 한 바퀴 (--지금) */
  force?: boolean;
  /** 후보와 조회수만 보고 아무것도 바꾸지 않는다 (--보기) */
  dryRun?: boolean;
  say?: (line: string) => void;
  /** 시험이 시계를 바꿔 끼운다 (순간) */
  clock?: Date;
  /** 시험이 조회수 읽기를 바꿔 끼운다 */
  stats?: (ids: string[], c: RecallCandidate[]) => Promise<Record<string, { views: number }>>;
}

async function 기본조회수(ids: string[], c: RecallCandidate[]): Promise<Record<string, { views: number }>> {
  // 아무 채널의 자격증명이든 된다 — 공개 영상이면 채널을 넘나들며 준다. 비공개는 안 주므로 「응답 없음」이 된다.
  const 열쇠 = c.map((x) => x.channel).find((ch) => resolve(ch)) ?? c[0].channel;
  return await statsOnce(ids, 열쇠, false);
}

/**
 * 한 바퀴 돈다. (파이썬: 회수.돌기)
 * 꺼져 있으면 아무것도 안 한다 — 유튜브도 부르지 않는다. 돌기(강제, 보기만) = run({ force, dryRun }).
 */
export async function run(o: RecallOpts = {}): Promise<RecallResult> {
  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); (o.say ?? console.log)(s); };
  const res: RecallResult = { lowered: 0, candidates: 0, skipped: "", rows: [], lines };
  const now = wallNow(systemZone(), o.clock);
  const chans = loadChannels();

  if (!recallOn(chans)) {
    res.skipped = "off";
    // 예약 작업이 10분마다 부르는 길에서는 조용히, 사람이 시킨 길(보기·지금)에서만 말한다
    if (o.dryRun || o.force) say("  저성과 회수는 꺼져 있습니다 — 채널 설정에 「회수: true」 를 적은 채널이 없습니다.");
    return res;
  }

  if (!o.dryRun && !o.force) {
    try {
      const 앞 = parseNaive(Deno.readTextFileSync(표식()).trim());
      const 지난분 = 앞 ? diffMinutes(now, 앞) : Infinity;
      if (지난분 >= 0 && 지난분 < THROTTLE_MIN) {
        res.skipped = "throttle"; // 아직 차례가 아니다
        return res;
      }
    } catch { /* 표식이 없으면 차례다 */ }
  }
  const 표식쓰기 = async () => {
    try { await writeTextAtomic(표식(), isoWall(now)); } catch (e) { await recordLine("서버.log", `회수 표식을 못 적었습니다 — ${msgOf(e)}`); }
  };

  const 후보 = candidates(now, chans);
  res.candidates = 후보.length;
  if (!후보.length) {
    if (o.dryRun) say("  올린 지 일주일 넘은 공개 영상이 없습니다.");
    else await 표식쓰기();
    return res;
  }

  let 통계: Record<string, { views: number }>;
  try {
    통계 = await (o.stats ?? 기본조회수)(후보.map((x) => x.id), 후보);
  } catch (e) {
    // 조회수를 모르는 채로 내리지 않는다.
    // 실패도 표식에 남긴다(함정 5.8) — 안 남기면 10분마다 도는 작업이 한도가 바닥난 날 하루 종일 같은 호출을 되풀이한다.
    // 그러면 다음 시도는 한 시간 뒤다. 사람이 곧바로 다시 보려면 force.
    res.skipped = "error";
    say(`  조회수를 읽지 못했습니다 — ${cut(msgOf(e), 90)}  (한 시간 뒤에 다시 봅니다)`);
    if (!o.dryRun) await 표식쓰기();
    return res;
  }

  for (const x of 후보) {
    const st = 통계[x.id];
    const row: RecallRow = { ...x, views: st ? st.views : null, verdict: "pass", note: "" };
    res.rows.push(row);
    if (!st) { // 응답에 없음 — 이미 내려갔거나 비공개
      row.verdict = "noreply";
      say(`  ${x.title}  응답 없음(이미 비공개?) — 건너뜀`);
      continue;
    }
    const 표 = `[${x.channel}] ${x.title}  ${commaInt(st.views)}회 · ${fixed(x.ageHours, 0)}시간`;
    if (st.views >= VIEWS_BAR) { say(`  통과  ${표}`); continue; }
    row.verdict = "low";
    if (o.dryRun) { say(`  내릴 것  ${표}  (조회 ${VIEWS_BAR} 미만)`); continue; }
    if (res.lowered >= MAX_PER_ROUND) {
      row.verdict = "later";
      say(`  다음 바퀴로  ${표}  (한 바퀴 최대 ${MAX_PER_ROUND}편)`);
      continue;
    }
    if (isLocked()) {
      row.verdict = "locked";
      say("  올리기 잠금 중 — 회수도 멈춥니다");
      break;
    }
    // ── 실제로 내린다 ──
    try {
      // 읽고 합쳐서 쓴다(ytcore.영상바꾸기). privacyStatus 만 보내면 퍼가기·통계 공개·합성 표시가 지워졌다(전 채널 실측).
      // 아동용 표시(selfDeclaredMadeForKids)도 지금 값 그대로 간다.
      const yt = await ytFor(x.channel);
      await 영상바꾸기(yt, x.id, { status: { privacyStatus: "private" } });
      row.verdict = "lowered";
      res.lowered++;
      say(`  내림  ${표}`);
    } catch (e) {
      row.verdict = "failed";
      row.note = msgOf(e);
      say(`  실패  ${표} — ${(e as Error)?.name ?? "오류"}: ${cut(msgOf(e), 80)}`);
      continue;
    }
    // 여기부터는 이미 내려갔다 — 뒷정리가 하나 안 되어도 나머지는 한다 (다만 소리 내어 남긴다)
    try { await manualPrivateAdd(x.id, x.channel, x.title); } catch (e) { await recordLine("서버.log", `수동비공개 명단에 못 올렸습니다 — ${x.id}: ${msgOf(e)}`); }
    try { await patchLedger(x.id, { 공개설정: LOWERED }); } catch (e) { await recordLine("서버.log", `원장에 저성과비공개를 못 적었습니다 — ${x.id}: ${msgOf(e)}`); }
    await recordLine("올리기.log", `저성과비공개  [${x.channel}] ${x.title}  ${st.views}회/${fixed(x.ageHours, 0)}h  ${x.id}`);
    await send(
      `📉 저성과 회수\n채널  ${x.channel}\n영상  ${x.title}\n올린 지 ${fixed(x.ageHours, 0)}시간 · 조회 ${st.views}회 ` +
        `(기준 ${VIEWS_BAR} 미만)\n비공개로 돌렸습니다. 되살리려면 스튜디오에서 직접 공개하세요.`,
    );
  }

  if (!o.dryRun) await 표식쓰기();
  return res;
}

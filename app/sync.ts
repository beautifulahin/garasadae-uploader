// 기록과 유튜브의 실제 상태를 맞춘다. (파이썬: sync.py)
//
// 왜 필요한가
//   앱만 세상을 바꾸는 게 아니다. 사람이 스튜디오에서 직접 공개하기도 하고, 올린 영상을 지우기도 하고,
//   앱을 거치지 않고 올리기도 한다. 그때마다 손으로 고치면 언젠가 어긋난 채로 남는다. 실제로 그랬다.
//   이 파일은 유튜브를 진실로 보고, 우리 기록을 거기에 맞춘다.
//
// 하는 일
//   1. 원장의 공개 설정·공개 시각·예약 시각을 실제 값으로 고친다
//   2. 유튜브에서 사라진 영상(유령)을 심사 대기·원장에서 뺀다
//   3. 같은 영상이 두 번 기록된 것을 합친다
//   4. 채널을 채널ID 로 적어 둔 옛 기록을 별칭으로 바꾼다
//   5. 이미 공개된 것을 심사 대기에서 뺀다
//
// 아무것도 지우지 않는다 — 유튜브에 없는 것만 목록에서 뺀다. 뺀 원장 줄은 기록/원장정리.log 에 그대로 옮겨 적는다
// (스튜디오에서 지운 영상을 다시 올릴 수 있게 길은 열되, 기록은 남는다).
//
// ★ 모르는 것과 없는 것은 다르다 ★
//   물어보지 못했을 때(인증이 없다·네트워크·할당량)는 CouldNotAsk 로 멈추고 그 채널 기록은 **손대지 않는다**.
//   빈 결과를 「하나도 없다」로 읽으면 원장을 통째로 지운다. 실제로 그 사고가 났다 — 할당량이 떨어진 날 기록 7건이 다 날아갔다.
//
// 원본과 다른 점 (일부러)
//   · 물어보는 동안 새로 올라간 영상의 줄은 절대 안 건드린다: 물어본 영상 id 만 판정한다. 원본은 맨 처음 읽어 둔 원장을 통째로
//     다시 써서, 그 사이에 적힌 줄이 사라질 수 있었다. 심사 대기도 잠그고 고친다(updatePending).
//   · 「이미 공개된 것을 심사 대기에서 뺀다」: 원본은 이 비교를 글자와 사전(dict)끼리 해서 한 번도 맞지 않았다 — 여기서는 문서대로 한다.
//   · 한국시각 고정이 아니라 이 컴퓨터 시각으로 적는다(원장의 다른 시각들과 같은 기준).
//   · 한 번에 하나만 돈다(.sync.lock) — 화면의 「갱신」을 연달아 눌러도 두 번 묻지 않는다.
import { dataPath, recordLine, recordPath, withFileLock, writeTextAtomic } from "./paths.ts";
import { instantToWall, minuteWall, systemZone } from "./clock.ts";
import { csvCell, readLedgerRaw, writeLedgerRaw } from "./ledger.ts";
import { loadPending, updatePending } from "./review.ts";
import { resolve, ytFor } from "./ytcore.ts";
import { videosList } from "./youtube.ts";

type Obj = Record<string, any>;

/** 유튜브에 물어보지 못했다. **없다는 뜻이 아니다.** (파이썬: sync.못물음) */
export class CouldNotAsk extends Error {
  constructor(m: string) { super(m); this.name = "CouldNotAsk"; }
}

/** 영상 하나의 실제 모습 */
export interface VideoState {
  /** public · unlisted · private · 예약(비공개이면서 공개 예정 시각이 걸림) */
  공개설정: string;
  /** 공개된 시각(유튜브가 준 UTC 글). 예약이면 빈 글 */
  공개시각: string;
  /** 예약 시각(UTC 글) */
  예약: string;
}

/** 유튜브가 주는 UTC 시각(2026-08-28T05:50:00Z)을 이 컴퓨터 시각 글 「2026-08-28 14:50」으로 바꾼다. (파이썬: sync._한국시각) */
export function localTime(iso: string): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso.slice(0, 16).replace("T", " ");
  return minuteWall(instantToWall(t, systemZone()));
}

/**
 * 영상ID → 실제 모습.  (파이썬: sync._states)
 *
 * ★ 물어보지 못했을 때는 CouldNotAsk 를 던진다. 빈 사전을 돌려주면 안 된다 — 부르는 쪽이 그것을 「유튜브에 하나도 없다」로 읽고
 *   원장을 통째로 지운다.
 * status 와 snippet 을 함께 받는다: videos.list 는 부품을 몇 개 받든 호출 한 번에 1유닛이라 공짜다.
 * snippet.publishedAt 은 「공개된 시각」이다 — 비공개로 올렸다가 나중에 공개하면 그 공개 시점으로 바뀐다(구글 문서 기준).
 */
export async function states(alias: string, vids: string[]): Promise<Record<string, VideoState>> {
  let yt;
  try {
    yt = await ytFor(alias);
  } catch (e) {
    throw new CouldNotAsk(`${alias} — ${e instanceof Error && e.name === "LookupError" ? "인증이 없습니다" : (e as Error).message.slice(0, 120)}`);
  }
  if (!vids.length) return {};
  let items: Obj[];
  try {
    items = await videosList(yt, vids, "status,snippet");
  } catch (e) {
    throw new CouldNotAsk(`${alias} — ${(e as Error).name}: ${String((e as Error).message ?? e).slice(0, 120)}`);
  }
  const out: Record<string, VideoState> = {};
  for (const v of items) {
    const st = v.status ?? {};
    // 예약(publishAt)이 걸린 비공개는 「공개」도 「그냥 비공개」도 아니다. 유튜브가 들고 있다가 그 시각에 연다.
    // 따로 표시해야 화면에 「공개됨」으로 잘못 나오지 않는다.
    const 상태 = st.publishAt && st.privacyStatus === "private" ? "예약" : String(st.privacyStatus ?? "");
    out[v.id] = {
      공개설정: 상태,
      공개시각: 상태 === "예약" ? "" : String(v.snippet?.publishedAt ?? ""),
      예약: String(st.publishAt ?? ""),
    };
  }
  return out;
}

/* ============================================================ 돌린 지 얼마나 됐나 */

const 표식 = () => recordPath("맞추기시각.txt");

/** 마지막 맞추기 뒤로 이만큼(시간) 지났나. 한 번도 안 돌렸으면 참. (파이썬: sync.돌린지) */
export function syncDue(hours: number, now: Date = new Date()): boolean {
  let 마지막: number;
  try {
    마지막 = Number(Deno.readTextFileSync(표식()).trim());
  } catch {
    return true;
  }
  if (!Number.isFinite(마지막)) return true;
  return now.getTime() / 1000 - 마지막 >= hours * 3600;
}

/** 지금 돌았다고 적는다. (파이썬: sync.돌았다고적기) */
export async function markSynced(now: Date = new Date()): Promise<void> {
  try {
    await writeTextAtomic(표식(), String(now.getTime() / 1000));
  } catch (e) {
    await recordLine("서버.log", `맞추기 시각을 적지 못했습니다 — ${(e as Error).name}: ${(e as Error).message}`);
  }
}

/* ============================================================ 맞추기 */

export interface SyncChanges { ledger: number; ghost: number; dup: number; name: number }

export interface SyncResult extends SyncChanges {
  total: number;
  /** 물어본 채널 / 못 물어본 채널(까닭) — 못 물어본 채널의 기록은 손대지 않았다 */
  asked: string[];
  notAsked: { alias: string; why: string }[];
  /** 이미 다른 맞추기가 돌고 있어 하지 않았다 */
  skipped: boolean;
  lines: string[];
}

export interface SyncOpts {
  say?: (line: string) => void;
  /** 시험이 유튜브에 묻는 자리를 바꿔 끼운다 */
  asker?: (alias: string, ids: string[]) => Promise<Record<string, VideoState>>;
  now?: Date;
}

/**
 * 원장을 실제와 맞춘다. (파이썬: sync.run) — 화면의 「갱신」 단추가 부르는 함수.
 *
 * **채널 하나당 videos.list 한 번**(50개까지)이 나간다. 원장에 이름이 오른 채널이 많을수록 비싸진다. 그래서 아무 데서나 부르면 안 된다 —
 * 5분마다 도는 작업이 이것을 무조건 부르던 시절에 하루 1,000건이 넘게 나갔다(2026-08-27). 부르는 쪽에서 syncDue() 로 간격을 지킬 것.
 */
export async function run(quiet = false, o: SyncOpts = {}): Promise<SyncResult> {
  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); if (!quiet) (o.say ?? console.log)(s); };
  const res: SyncResult = { ledger: 0, ghost: 0, dup: 0, name: 0, total: 0, asked: [], notAsked: [], skipped: false, lines };

  const r = await withFileLock(dataPath(".sync.lock"), () => 맞추기(say, res, o), { wait: false });
  if (r === null) {
    res.skipped = true;
    say("  이미 맞추는 중입니다 — 끝나면 다시 눌러 주세요");
  }
  res.total = res.ledger + res.ghost + res.dup + res.name;
  return res;
}

async function 맞추기(say: (s: string) => void, res: SyncResult, o: SyncOpts): Promise<void> {
  await markSynced(o.now);

  // ── 채널별로 실제 상태를 한 번에 물어본다 ────────────────────
  // 별칭이든 채널ID 든 토큰 저장소의 이름으로. 줄마다 토큰 파일을 다시 읽지 않게 이번 판에서는 한 번만 푼다.
  const 풂 = new Map<string, string | null>();
  const 이름풀기 = (ch: string): string | null => {
    if (!풂.has(ch)) 풂.set(ch, resolve(ch));
    return 풂.get(ch)!;
  };
  const 키 = (ch: string) => 이름풀기(ch) ?? ch;
  const 묶음 = new Map<string, Set<string>>();
  const 담기 = (ch: string, id: string) => {
    if (!id) return; // id 없는 줄은 물어볼 수도, 판정할 수도 없다
    const k = 키(ch);
    if (!묶음.has(k)) 묶음.set(k, new Set());
    묶음.get(k)!.add(id);
  };
  for (const p of loadPending()) 담기(p.channel, p.video_id);
  const 처음 = readLedgerRaw();
  if (처음) {
    const 머리 = 처음[0];
    const c채널 = 머리.indexOf("채널"), c영상 = 머리.indexOf("영상ID");
    if (c채널 >= 0 && c영상 >= 0) for (const r of 처음.slice(1)) 담기(r[c채널] ?? "", r[c영상] ?? "");
  }

  const 실제 = new Map<string, VideoState>();
  const 물어본채널 = new Set<string>();
  const 물어본id = new Set<string>(); // 이번에 실제로 물어본 영상 — 이것만 판정한다
  const 묻기 = o.asker ?? states;
  for (const [alias, ids] of 묶음) {
    const 목록 = [...ids].sort();
    try {
      const got = await 묻기(alias, 목록);
      for (const [id, v] of Object.entries(got)) 실제.set(id, v);
      for (const id of 목록) 물어본id.add(id);
      물어본채널.add(alias);
      res.asked.push(alias);
    } catch (e) {
      const why = e instanceof CouldNotAsk ? e.message : `${alias} — ${(e as Error).name}: ${String((e as Error).message ?? e).slice(0, 120)}`;
      res.notAsked.push({ alias, why });
      say(`  물어보지 못했습니다 — ${why}`);
      say("  이 채널 기록은 **손대지 않습니다**(모르는 것과 없는 것은 다릅니다).");
    }
  }
  const 판정할까 = (ch: string, id: string) => !!id && 물어본채널.has(키(ch)) && 물어본id.has(id);

  // ── 1) 원장: 채널 이름과 공개 설정을 실제에 맞춘다 ────────────
  //   물어보는 동안 새로 적힌 줄이 있을 수 있으니, 잠그고 **지금 것을 다시 읽어** 고친다.
  await withFileLock(dataPath(".ledger.lock"), async () => {
    const raw = readLedgerRaw();
    if (!raw) return;
    const 머리 = raw[0];
    const col = (이름: string) => 머리.indexOf(이름);
    const c채널 = col("채널"), c영상 = col("영상ID"), c제목 = col("제목"), c설정 = col("공개설정"), c공개 = col("공개시각"), c예약 = col("예약시각");
    if (c채널 < 0 || c영상 < 0) return;
    const 본 = new Set<string>();
    const 남길: string[][] = [];
    const 뺀줄: string[][] = [];
    let 고침 = false;
    for (const r of raw.slice(1)) {
      while (r.length < 머리.length) r.push("");
      const 제목 = (r[c제목] ?? "").slice(0, 34);
      let 줄바뀜 = false;
      const 이름 = 이름풀기(r[c채널]);
      if (이름 && 이름 !== r[c채널]) { r[c채널] = 이름; res.name++; 고침 = true; }
      const id = r[c영상];
      if (id) {
        if (본.has(id)) { res.dup++; 고침 = true; continue; } // 같은 영상이 두 번 적혔다
        본.add(id);
      }
      if (!판정할까(r[c채널], id)) { 남길.push(r); continue; } // 못 물어본 채널·물어보지 않은 줄은 그대로 둔다
      const 난것 = 실제.get(id);
      if (!난것) {
        say(`  원장에서 뺌 (유튜브에 없음) — ${제목}`);
        res.ghost++; 고침 = true;
        뺀줄.push(r);
        continue;
      }
      const st = 난것.공개설정;
      if (c설정 >= 0 && r[c설정] !== st) {
        say(`  공개설정 고침 — ${제목.slice(0, 30)}  ${r[c설정]} → ${st}`);
        r[c설정] = st; 줄바뀜 = true;
      }
      // 공개시각을 채운다. 이미 적혀 있으면 손대지 않는다 (우리가 공개시킨 순간을 적어 둔 것이 더 정확하다).
      if (c공개 >= 0 && st === "public" && !r[c공개]) {
        const 때 = localTime(난것.공개시각);
        if (때) { r[c공개] = 때; say(`  공개시각 채움 — ${제목.slice(0, 26)}  ${때}`); 줄바뀜 = true; }
      }
      // 스튜디오에서 예약 시각을 바꾼 경우, 옛 계획일을 남겨 두면 건전성 검사가 이미 공개됐는지 모르는 예약으로 계속 센다.
      if (c예약 >= 0 && st === "예약") {
        const 실제예약 = localTime(난것.예약);
        if (실제예약 && r[c예약] !== 실제예약) {
          say(`  예약시각 고침 — ${제목.slice(0, 26)}  ${r[c예약]} → ${실제예약}`);
          r[c예약] = 실제예약; 줄바뀜 = true;
        }
      }
      if (줄바뀜) { res.ledger++; 고침 = true; }
      남길.push(r);
    }
    if (!고침) return;
    // 뺀 줄은 먼저 기록에 옮겨 적는다 — 지우는 게 아니라 치우는 것이다.
    for (const r of 뺀줄) await recordLine("원장정리.log", `유령 정리  ${머리.map((h, i) => `${h}=${csvCell(r[i] ?? "")}`).join(" | ")}`);
    await writeLedgerRaw([머리, ...남길]);
  });

  // ── 2) 심사 대기: 사라진 것·이미 공개된 것을 뺀다 ─────────────
  await updatePending((items) => {
    const 본 = new Set<string>();
    const 남길 = [];
    for (const p of items) {
      const 이름 = 키(p.channel);
      if (이름 !== p.channel) { p.channel = 이름; res.name++; }
      if (p.video_id) {
        if (본.has(p.video_id)) { res.dup++; continue; }
        본.add(p.video_id);
      }
      if (!판정할까(p.channel, p.video_id)) { 남길.push(p); continue; } // 못 물어본 채널은 그대로 둔다
      const 난것 = 실제.get(p.video_id);
      if (!난것) {
        say(`  심사 대기에서 뺌 (유튜브에 없음) — ${String(p.title ?? "").slice(0, 34)}`);
        res.ghost++;
        continue;
      }
      if (난것.공개설정 === "public" || 난것.공개설정 === "unlisted") {
        say(`  심사 대기에서 뺌 (이미 공개) — ${String(p.title ?? "").slice(0, 34)}`);
        res.ghost++;
        continue;
      }
      남길.push(p);
    }
    return 남길;
  });

  const 총 = res.ledger + res.ghost + res.dup + res.name;
  if (총) say(`\n  맞춤 ${총}건 — 공개설정 ${res.ledger} · 유령 ${res.ghost} · 중복 ${res.dup} · 이름 ${res.name}`);
  else if (!res.notAsked.length) say("  기록과 유튜브가 일치합니다.");
}

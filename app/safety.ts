// 올리기 안전장치 — 사람이 그 순간 누른 것만 통과시킨다. (파이썬: safety.py)
//
// 왜 필요한가
//   올리기 입구가 주소 하나(`/api/upload/start?f=...`)였다. 주소만 다시 열리면 진짜 업로드가 시작된다.
//   그런데 주소는 사람이 누르지 않아도 다시 열린다 — 브라우저를 껐다 켜면 열려 있던 탭을 되살리고,
//   북마크·방문 기록·새로고침(F5)·브라우저의 미리 읽기(prefetch)로도 다시 열린다.
//   고객 채널에 영상이 올라가는 일이다. 되돌릴 수 없다. 그래서 「주소를 알면 올라간다」를 「그 순간 눌러야 올라간다」로 바꾼다.
//
// 어떻게 막나
//   1. 표(ticket)   누를 때 표를 한 장 받는다. 한 번 쓰면 없어지고 2분이면 만료된다.
//   2. 어디서 왔나  주소창에 치고 들어온 것·다른 사이트에서 부른 것·브라우저가 미리 읽는 것은 거절한다(Sec-Fetch-*).
//   3. 개수         한 번에 20개가 넘으면 따로 한 번 더 확인받는다.
//   4. 되풀이       같은 영상 묶음을 90초 안에 또 올리려 하면 손이 미끄러진 것으로 본다.
//   5. 잠금         사람이 잠가 두면 무슨 수를 써도 올라가지 않는다.
//   막은 것도 통과시킨 것도 전부 `기록/올리기감시.log` 에 남는다.
//
// 이 파일에는 문이 세 개 있다 — 입구(allowUpload: 누른 순간만) · 출구(exitGate: 업로드 직전 마지막 문턱) ·
// 공개(publishGate: 비공개 → 공개 전환 직전 문턱). 어느 길로 오든 같은 문을 지나게 하려고 여기 한 곳에 둔다.
import { baseName, dataPath, dirName, readJsonSync, recordLine, recordPath, writeJson } from "./paths.ts";
import { confFor, loadChannels } from "./channels.ts";
import { readLedgerStrict, type LedgerRow } from "./ledger.ts";
import { ledgerRowIsLong } from "./shorts.ts";
import { addMinutes, isoWall, parseNaive, shortWall, type Wall, wallNow } from "./clock.ts";
import { policyForChannel, requirePublication } from "./daily.ts";
import { checkText } from "./metacheck.ts";
import { findText } from "./sidecar.ts";
import { splitHashFromDesc } from "./ai.ts";
import { holdReason } from "./hold.ts";

export const TICKET_TTL = 120; // 표는 2분 뒤 만료된다 (초)
export const MAX_AT_ONCE = 20; // 이보다 많으면 한 번 더 확인받는다
export const REPEAT_GUARD = 90; // 같은 묶음을 이 시간 안에 또 부르면 거절 (초)
/** 2026-09-18 사장님 지시: 2시간 간격으로 올려 (원래 4) — 쇼츠는 쇼츠끼리, 롱폼은 롱폼끼리 잰다 */
export const PUBLISH_GAP_HOURS = 2;
/** 공개를 시킬 수 있는 이 — 밝히지 않으면 공개가 안 나간다 */
export const PUBLISHERS = ["예약작업", "사람"];

const lockFile = () => dataPath("올리기잠금.json");
const manualFile = () => dataPath("수동비공개.json");

/** 왜 막았는지 사람 말로 담는다 (파이썬 거절) */
export class Refusal extends Error {}
/** 출구 검사에서 걸렸다. 이 영상은 올리면 안 된다 (파이썬 출구막힘) */
export class ExitBlocked extends Error {}
/** 공개 전환이 막혔다 (파이썬 공개막힘) */
export class PublishBlocked extends Error {}

const 적기 = (말: string) => recordLine("올리기감시.log", 말);

/* ============================================================ 시계 (시험이 바꿔 끼운다) */
let 지금초 = () => performance.now() / 1000;
/** 시험용: 표 만료·되풀이 막기를 기다리지 않고 시험한다 */
export function setSafetyClock(f: (() => number) | null) { 지금초 = f ?? (() => performance.now() / 1000); }

/* ============================================================ 잠금 */

export function isLocked(): boolean {
  try { return !!readJsonSync<{ 잠김?: boolean }>(lockFile(), {}).잠김; } catch { return false; }
}

/** 올리기를 잠그거나 푼다. 잠기면 업로드도 공개도 멈춘다 (밖으로 나가는 일은 다 멈춤) */
export async function setLocked(on: boolean): Promise<boolean> {
  await writeJson(lockFile(), { "잠김": !!on, "바꾼때": isoWall(wallNow()) });
  await 적기(`잠금 ${on ? "켜짐" : "풀림"}`);
  return !!on;
}

/* ============================================================ 표 */

interface Ticket { 난때: number; 지문: string; 수: number }
const 표: Map<string, Ticket> = new Map();
const 최근: Map<string, number> = new Map(); // 묶음지문 → 마지막으로 시작한 시각

/** 영상 묶음을 하나의 짧은 값으로. 순서가 달라도 같은 묶음이면 같다. (파이썬 지문) */
export function fingerprint(files: string[]): string {
  // 파이썬은 sha256 앞 24자. 값이 서로만 맞으면 되므로(같은 프로세스 안에서만 비교) 같은 해시 글자를 쓴다.
  const enc = new TextEncoder();
  const parts: number[] = [];
  for (const f of files.map(String).sort()) {
    parts.push(...enc.encode(f), 0);
  }
  return hash24(new Uint8Array(parts));
}

// SubtleCrypto 는 비동기라 문을 async 로 만들어야 하는데, 문은 짧게 동기로 두고 싶다 → 작은 동기 SHA-256 을 쓴다.
function hash24(data: Uint8Array): string {
  return sha256Hex(data).slice(0, 24);
}

/** 누른 그 순간에만 준다. 한 장은 한 번 쓴다. (파이썬 표주기) */
export function giveTicket(files: string[]): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const t = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // 오래된 것은 치운다. 쌓아 둘 이유가 없다.
  for (const [k, v] of [...표]) if (지금초() - v.난때 > TICKET_TTL) 표.delete(k);
  표.set(t, { 난때: 지금초(), 지문: fingerprint(files), 수: files.length });
  return t;
}

/**
 * 브라우저가 알려 주는 「이 요청이 어디서 났는지」를 본다. (파이썬 _사람이누른건가)
 * Sec-Fetch-* 는 브라우저가 붙이고 페이지 쪽에서 위조할 수 없다. 없으면(아주 옛 브라우저) 표 검사에 맡긴다.
 */
export function whyNotHuman(headers: Headers | null | undefined): string {
  if (!headers) return "";
  const g = (k: string) => (headers.get(k) ?? "").toLowerCase();
  if (g("sec-purpose").includes("prefetch") || g("purpose") === "prefetch") return "브라우저가 미리 읽는 요청입니다";
  const site = g("sec-fetch-site");
  if (site && site !== "same-origin") return `다른 곳에서 부른 요청입니다(${site})`;
  if (g("sec-fetch-mode") === "navigate") return "주소창·북마크·탭 복원으로 들어온 요청입니다";
  const dest = g("sec-fetch-dest");
  if (dest && dest !== "empty") return `페이지가 자원으로 부른 요청입니다(${dest})`;
  return "";
}

/** 올려도 되는지 본다. 안 되면 Refusal 을 왜 안 되는지와 함께 던진다. (파이썬 통과시킬까) */
export async function allowUpload(
  token: string,
  files: string[],
  headers?: Headers | null,
  opts: { many?: boolean } = {},
): Promise<void> {
  const n = files.length;
  if (isLocked()) {
    await 적기(`거절 — 잠겨 있음 · ${n}개`);
    throw new Refusal("올리기가 잠겨 있습니다. 화면 오른쪽 위 자물쇠를 풀어 주세요.");
  }
  // 이행 보류 중 — 표를 쓰거나 「조금 전에 올린 묶음」으로 적기 전에 바로 막는다 (풀린 뒤 곧바로 다시 누를 수 있게)
  const 보류 = holdReason();
  if (보류) {
    await 적기(`거절 — 이행 보류 · ${n}개`);
    throw new Refusal(보류);
  }
  const 왜 = whyNotHuman(headers);
  if (왜) {
    await 적기(`거절 — ${왜} · ${n}개`);
    throw new Refusal(`${왜}\n앱 화면에서 직접 눌러 주세요.`);
  }
  if (!token) {
    await 적기(`거절 — 표 없음 · ${n}개`);
    throw new Refusal("올리기 표가 없습니다. 앱 화면에서 다시 눌러 주세요.");
  }
  const t = 표.get(token);
  표.delete(token); // 꺼내는 순간 없앤다 — 한 번만 쓴다
  if (!t) {
    await 적기(`거절 — 이미 쓴 표이거나 없는 표 · ${n}개`);
    throw new Refusal(
      "이미 쓴 요청입니다.\n새로고침이나 뒤로가기로는 다시 올라가지 않습니다. 올리시려면 화면에서 다시 골라 주세요.",
    );
  }
  if (지금초() - t.난때 > TICKET_TTL) {
    await 적기(`거절 — 표 만료 · ${n}개`);
    throw new Refusal("시간이 지났습니다. 화면에서 다시 눌러 주세요.");
  }
  const 이번 = fingerprint(files);
  if (이번 !== t.지문) {
    await 적기(`거절 — 표와 영상 묶음이 다름 · ${n}개`);
    throw new Refusal("고른 영상이 바뀌었습니다. 화면에서 다시 눌러 주세요.");
  }
  if (n > MAX_AT_ONCE && !opts.many) {
    await 적기(`거절 — 한 번에 ${n}개(한도 ${MAX_AT_ONCE})`);
    throw new Refusal(`한 번에 ${n}개는 너무 많습니다(한도 ${MAX_AT_ONCE}개).\n정말 맞다면 화면에서 한 번 더 확인해 주세요.`);
  }
  const 앞서 = 최근.get(이번);
  if (앞서 !== undefined && 지금초() - 앞서 < REPEAT_GUARD) {
    await 적기(`거절 — 같은 묶음을 ${Math.floor(지금초() - 앞서)}초 만에 다시 · ${n}개`);
    throw new Refusal("조금 전에 올린 것과 같은 영상들입니다.\n두 번 눌린 것 같아 멈췄습니다. 정말이라면 잠시 뒤에 다시 해 주세요.");
  }
  최근.set(이번, 지금초());
  await 적기(`통과 — ${n}개  ${files.slice(0, 4).map(baseName).join(", ")}` + (n > 4 ? " …" : ""));
}

/* ============================================================ 원장 읽기 (모르면 막는다) */

type Seen = [string, string, string]; // 업로드시각, 채널, 영상ID
let 원장캐시: { 때: number; 값: Map<string, Seen> } = { 때: -1, 값: new Map() };

/** 원장을 {파일이름·전체경로: (시각, 채널, 영상id)} 로. 파일이 바뀔 때만 다시 읽는다. (파이썬 _올린것읽기) */
function seenFiles(): Map<string, Seen> {
  const f = dataPath("ledger.csv");
  let 때: number;
  try {
    const st = Deno.statSync(f);
    때 = st.mtime ? st.mtime.getTime() : 0;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return new Map();
    throw new ExitBlocked(`원장을 읽지 못해 중복을 확인할 수 없습니다 — ${(e as Error).message}`);
  }
  if (원장캐시.때 === 때) return 원장캐시.값;
  const 난것 = new Map<string, Seen>();
  try {
    for (const r of readLedgerStrict()) {
      const 경로 = (r["파일"] ?? "").trim();
      if (!경로) continue;
      const 줄: Seen = [r["업로드시각"] ?? "", r["채널"] ?? "", r["영상ID"] ?? ""];
      난것.set(baseName(경로), 줄);
      난것.set(경로, 줄);
    }
  } catch (e) {
    // 원장을 못 읽으면 중복을 알 수 없다. **모르면 막는다.**
    throw new ExitBlocked(`원장을 읽지 못해 중복을 확인할 수 없습니다 — ${(e as Error).message}`);
  }
  원장캐시 = { 때, 값: 난것 };
  return 난것;
}

let 폴더캐시: { 때: number; 값: Record<string, string> } = { 때: -1, 값: {} };
/** {채널이름: 폴더}. 설정이 바뀔 때만 다시 읽는다. (파이썬 _폴더읽기) */
function folderMap(): Record<string, string> {
  let 때 = 0;
  try { 때 = Deno.statSync(dataPath("channels.json")).mtime?.getTime() ?? 0; } catch { /* 없으면 0 */ }
  if (폴더캐시.때 === 때 && Object.keys(폴더캐시.값).length) return 폴더캐시.값;
  const 난것: Record<string, string> = {};
  try {
    for (const [n, v] of Object.entries(loadChannels())) 난것[n] = String(v.folder ?? "").trim();
  } catch { /* 설정을 못 읽으면 짝 검사를 건너뛴다 — 아래 파일 실재 검사는 그대로 */ }
  폴더캐시 = { 때, 값: 난것 };
  return 난것;
}

/** 시험이 원장·설정을 바꾼 뒤 캐시를 비운다 */
export function resetSafetyCache() { 원장캐시 = { 때: -1, 값: new Map() }; 폴더캐시 = { 때: -1, 값: {} }; }

/* ============================================================ 출구 */

/** 경로 b 가 폴더 a 안에 있나 (파이썬 relative_to) */
export function inside(file: string, folder: string): boolean {
  // 없는 파일은 realPath 가 던진다 — 폴더까지만 풀고 파일 이름을 붙인다(파이썬 resolve() 가 하는 일). 맥은 /var → /private/var 처럼 링크가 있다.
  const real = (p: string): string => {
    try { return Deno.realPathSync(p); } catch { /* 없는 자리 */ }
    const dir = dirName(p);
    if (dir && dir !== p) {
      const base = real(dir);
      const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
      return base.replace(/[\\/]+$/, "") + sep + baseName(p);
    }
    return p;
  };
  const f = real(file), d = real(folder).replace(/[\\/]+$/, "");
  const sep = d.includes("\\") && !d.includes("/") ? "\\" : "/";
  return f === d || f.startsWith(d + sep);
}

/**
 * **업로드 직전 마지막 문턱.** 여기를 통과 못 하면 절대 안 올라간다. (파이썬 출구검사)
 *
 * 왜 출구에 두나: 업로드를 일으킬 수 있는 길이 여럿이다(화면 단추 · 명령줄 · 발사대기 쏘기). 길마다 문을 다는 대신
 * 출구 하나에 달아, 새 길이 생겨도 이 문을 지나게 한다. 롱폼도 쇼츠와 같은 문을 지난다(종류 판정은 승인·검사를 대신하지 않는다).
 *
 * 무엇을 보나 (하나라도 걸리면 거절): 1 잠금 · 2 사람 승인 · 3 중복(원장) · 4 채널-폴더 짝 · 5 파일 실재 · 6 문안 규격(채널 설정이 있을 때)
 */
export async function exitGate(job: Record<string, unknown>, path: string): Promise<void> {
  const 채널 = String(job["channel"] || job["_alias"] || "?");
  const 이름 = baseName(path);

  // 0) 이행 보류 — 옛 판 자료를 옮긴 결과에서 빠진 것이 나와 새 판이 멈춰 있다(hold.ts). 풀기 전에는 어느 길로 와도 안 올라간다.
  const 보류 = holdReason();
  if (보류) throw new ExitBlocked(`${보류} — ${이름}`);

  // 1) 잠금
  if (isLocked()) throw new ExitBlocked(`올리기가 잠겨 있습니다 — ${이름}`);

  // 2) 사람 승인 — 어느 길로 왔든 '사람이 시켰다' 는 표시를 job 에 달고 와야 한다.
  const 승인 = job["_승인"];
  if (!승인) {
    throw new ExitBlocked(`사람 승인 표시가 없습니다 — ${이름}\n  앱에서 고르거나, 명령줄이면 --승인 을 주어야 합니다.`);
  }

  // 3) 중복 — 원장에 이미 있는 파일은 두 번 올리지 않는다. 원장은 파일이 바뀔 때만 다시 읽는다
  //    (영상마다 다시 읽으면 묶음 업로드가 그만큼 느려진다. 검사는 신분 확인일 뿐 전송 속도에 얹히면 안 된다.)
  const 올린것 = seenFiles();
  const 맞은것 = 올린것.get(이름) ?? 올린것.get(path);
  if (맞은것) {
    throw new ExitBlocked(`이미 올린 파일입니다 — ${이름}\n  ${맞은것[0]} [${맞은것[1]}] https://youtu.be/${맞은것[2]}`);
  }

  // 4) 채널-폴더 짝 — 남의 고객 영상이 딸려 나가는 것을 막는다
  // job 의 channel 은 별칭일 수도 채널 ID 일 수도 있다 — 별칭 표에 없으면 confFor 로 한 번 더 푼다 (못 풀어서 짝 검사를 건너뛰는 일이 없게)
  const 폴더 = folderMap()[채널] || String(confFor(채널)?.folder ?? "").trim();
  if (폴더 && !inside(path, 폴더)) {
    throw new ExitBlocked(
      `이 파일은 '${채널}' 폴더의 것이 아닙니다 — ${이름}\n  채널 폴더: ${폴더}\n  파일 위치: ${dirName(path)}\n` +
        "  고객이 뒤바뀌면 되돌릴 수 없습니다. 확인하세요.",
    );
  }

  // 5) 파일 실재
  try {
    if (!Deno.statSync(path).isFile) throw new Error("not file");
  } catch {
    throw new ExitBlocked(`파일이 사라졌습니다 — ${path}`);
  }

  // 6) 문안 규격 — 채널 설정에 meta_rule 이 있을 때만(파이썬은 특정 채널 하나의 규격이었다 — 설정으로 일반화).
  //    한글이 섞였거나 해시태그 개수·#shorts 금지 등 규격을 못 지킨 글은 내보내지 않는다.
  //    잴 글: 올리기 직전에 정해진 최종 문안(job._meta — AI 가 짓거나 사람이 쓴 것 어느 쪽이든)이 있으면 그것, 없으면 영상 옆 곁글(.txt).
  const 규격 = loadChannels()[String(job["channel"] || job["_alias"] || "")]?.meta_rule;
  if (규격 && Object.keys(규격).length) {
    const m = job["_meta"] as { title?: string; desc?: string; tags?: string[] } | undefined;
    let 글 = "";
    let tags = Array.isArray(job["tags"]) ? (job["tags"] as unknown[]).map(String) : undefined;
    if (m && typeof m.title === "string") {
      const hs = splitHashFromDesc(String(m.desc ?? "")).hashtags;
      글 = `[제목]\n${m.title}\n\n[설명]\n${m.desc ?? ""}\n\n[해시태그]\n${hs.map((h) => "#" + h).join(" ")}\n`;
      tags = (m.tags ?? []).map(String);
    } else {
      const 곁 = await findText(path);
      if (!곁) throw new ExitBlocked(`문안 규격 미달 — ${이름}: 곁파일(.txt) 없음`);
      try { 글 = await Deno.readTextFile(곁); } catch (e) { throw new ExitBlocked(`문안 규격을 잴 수 없습니다 — ${이름}: ${(e as Error).message}`); }
    }
    const 흠 = checkText(규격, 글, tags);
    if (흠.length) throw new ExitBlocked(`문안 규격 미달 — ${이름}: ${흠.join(", ")}`);
  }

  await 적기(`출구통과  [${채널}] ${이름}  승인=${승인}`);
}

/* ============================================================ 사람이 내린 영상 */
// 공개됐던 영상을 사람이 「비공개로 돌리기」로 내리면, 어떤 자동 루틴도(검토·예약·재시도 무엇이든) 그 영상을 다시 공개하면 안 된다.
// 내린 데는 이유가 있다 — 기계는 그 이유를 모른다.

export interface ManualPrivate { video_id: string; 채널?: string; 제목?: string; 내린때?: string }

export function manualPrivateList(): ManualPrivate[] {
  try {
    const v = readJsonSync<unknown>(manualFile(), []);
    return Array.isArray(v) ? (v as ManualPrivate[]) : [];
  } catch (e) {
    // 못 읽으면 모두 막힌 것으로 치는 쪽이 안전하지만, 그러면 정상 공개까지 다 선다. 읽기 실패는 소리 내고 빈 목록으로 간다.
    console.log(`  수동비공개 명단을 읽지 못했습니다 — ${(e as Error).message}`);
    return [];
  }
}

export async function manualPrivateAdd(videoId: string, 채널 = "", 제목 = ""): Promise<void> {
  const d = manualPrivateList();
  if (d.some((x) => x.video_id === videoId)) return;
  d.push({ video_id: videoId, 채널, 제목: 제목.slice(0, 60), 내린때: isoWall(wallNow()) });
  await writeJson(manualFile(), d, { indent: 1 });
}

export const manualPrivateHas = (videoId: string) => manualPrivateList().some((x) => x.video_id === videoId);

/** 사람이 다시 공개하기로 했을 때만 부른다. */
export async function manualPrivateRemove(videoId: string): Promise<boolean> {
  const d = manualPrivateList();
  const 새 = d.filter((x) => x.video_id !== videoId);
  if (새.length === d.length) return false;
  await writeJson(manualFile(), 새, { indent: 1 });
  return true;
}

/* ============================================================ 채널당 공개 간격 */
// 검토가 밀렸다가 한꺼번에 풀리면 한 채널에 영상 두세 개가 같은 시각에 공개될 수 있다. 그렇게 몰아 나가면 채널이 스팸처럼 보인다.
// 공개(실제)든 예약(예정)이든, 이 채널의 마지막 공개와 간격 안쪽이면 막는다. 자동이든 사람이든 같은 문을 지난다.

/** 원장에서 그 영상의 꼴(롱폼 true · 쇼츠 false) — 모르면 null(예전처럼 전부와 잰다). (파이썬 _영상롱폼) */
function videoIsLong(채널: string, 영상: string): boolean | null {
  if (!영상) return null;
  try {
    for (const r of readLedgerStrict()) {
      if ((r["채널"] ?? "").trim() === 채널 && (r["영상ID"] ?? "").trim() === 영상) return ledgerRowIsLong(r);
    }
  } catch { return null; }
  return null;
}

/** 원장에서 이 채널의 공개시각·예약시각을 전부 모은다(long 이 true/false 면 같은 꼴만). (파이썬 _채널공개시각들) */
export function channelPublishTimes(채널: string, exclude = "", long: boolean | null = null): Wall[] {
  const 난것: Wall[] = [];
  let rows: LedgerRow[];
  try {
    rows = readLedgerStrict();
  } catch (e) {
    // 원장을 못 읽으면 간격을 알 수 없다 — 여는 쪽이 아니라 막는 쪽으로.
    throw new PublishBlocked(`원장을 읽지 못해 공개 간격을 확인할 수 없습니다 — ${(e as Error).message}`);
  }
  for (const r of rows) {
    if ((r["채널"] ?? "").trim() !== 채널) continue;
    if (exclude && (r["영상ID"] ?? "").trim() === exclude) continue; // 자기 자신의 예약과는 재지 않는다
    if (long !== null && ledgerRowIsLong(r) !== long) continue; // 쇼츠는 쇼츠끼리, 롱폼은 롱폼끼리 (2026-09-25)
    for (const 칸 of ["공개시각", "예약시각"]) {
      const v = (r[칸] ?? "").trim();
      if (!v) continue;
      const t = parseNaive(v);
      if (t) 난것.push(t);
    }
  }
  return 난것;
}

/** 이 채널을 지금(또는 열릴때에) 공개해도 간격이 지켜지는가. (파이썬 공개간격검사) */
export function publishGapCheck(채널: string, 열릴때?: Wall | null, 영상 = ""): void {
  // 승인형 일 한도 정책이 있는 채널은 그 정책이 간격을 정한다 (파이썬 승인형 편성기의 applies → require_publication)
  const 정책 = policyForChannel(채널);
  if (정책 && 정책.cfg.schema === "approved-daily-v1") {
    requirePublication(채널, 열릴때 ?? null, 영상);
    return;
  }
  const 기준 = 열릴때 ?? wallNow();
  const 최소분 = PUBLISH_GAP_HOURS * 60;
  for (const t of channelPublishTimes(채널, 영상, videoIsLong(채널, 영상))) {
    if (Math.abs(기준.getTime() - t.getTime()) < 최소분 * 60_000) {
      const 가능 = addMinutes(t, 최소분);
      throw new PublishBlocked(
        `공개 간격 ${PUBLISH_GAP_HOURS}시간 미달 — [${채널}] 은 ${shortWall(t)} 공개(예약)와 겹칩니다. ` +
          `${shortWall(가능)} 이후에 열 수 있습니다`,
      );
    }
  }
}

/* ============================================================ 공개 */

export interface PendingLike { video_id?: string; title?: string; channel?: string; 확인수?: number; [k: string]: unknown }

/**
 * **공개 전환 직전 문턱.** 업로드와 별개로 여기도 잠근다. (파이썬 공개검사)
 *
 * 왜 필요한가: 점검 도구가 공개 함수를 부르는 바람에, 사람이 점검만 하려고 눌렀는데 대기 중인 영상이 실제로 공개된 사고가 있었다.
 * 업로드는 출구검사로 막아 뒀는데 공개는 아무나 부를 수 있었다. 자동 공개는 설계 의도이므로(검토 끝나면 바로 공개) 사람 승인을
 * 요구하면 안 된다. 대신 **누가 불렀는지 밝히게** 한다. 밝히지 않으면 안 나간다.
 *
 * 검사: 0 사람이 내린 영상 · 1 부른 이가 밝혀졌나(예약작업 또는 사람) · 2 잠금 · 3 검토를 실제로 했나(확인수 ≥ 1) · 4 공개 간격
 */
export async function publishGate(누가: string, it: PendingLike, 열릴때?: Wall | null): Promise<void> {
  const title = String(it?.title ?? "");
  const vid = String(it?.video_id ?? "");
  if (vid && manualPrivateHas(vid)) {
    throw new PublishBlocked(
      `사람이 비공개로 내린 영상입니다(${vid}) — 자동 공개 금지. 다시 공개하려면 사람이 명단에서 풀어야 합니다`,
    );
  }
  if (!PUBLISHERS.includes(누가)) {
    throw new PublishBlocked(
      `누가 공개를 시켰는지 밝혀지지 않았습니다 — ${title.slice(0, 24)}\n` +
        "  공개 함수는 누가='예약작업'|'사람' 을 밝히고 불러야 합니다.\n  진단·시험 코드에서는 공개를 부르지 마세요.",
    );
  }
  if (isLocked()) throw new PublishBlocked(`올리기가 잠겨 있어 공개도 멈춥니다 — ${title.slice(0, 24)}`);
  const 보류 = holdReason();
  if (보류) throw new PublishBlocked(`${보류} — ${title.slice(0, 24)}`);
  if (Number(it?.확인수 ?? 0) < 1) {
    throw new PublishBlocked(`아직 검토하지 않았습니다 — ${title.slice(0, 24)}\n  올린 지 30분 뒤 한 번 확인하고 나서 공개합니다.`);
  }
  // 채널당 공개 간격 — 어떤 경우에도 지킨다. 예약을 걸 때는 그 예약 시각(열릴때) 기준으로 잰다.
  publishGapCheck(String(it?.channel ?? ""), 열릴때, vid);
  await 적기(`공개통과  [${it?.channel ?? ""}] ${title.slice(0, 30)}  누가=${누가}`);
}

/* ============================================================ 명령줄·화면용 한 줄 요약 */

export async function statusLines(): Promise<string[]> {
  const 줄 = [
    `올리기 잠금  ${isLocked() ? "켜짐 — 아무것도 올라가지 않습니다" : "꺼짐"}`,
    `한 번 한도   ${MAX_AT_ONCE}개`,
    `표 유효      ${TICKET_TTL}초 · 한 번만 사용`,
  ];
  try {
    const t = (await Deno.readTextFile(recordPath("올리기감시.log"))).split(/\r?\n/).filter(Boolean).slice(-6);
    if (t.length) 줄.push("", "최근 기록", ...t.map((x) => "  " + x));
  } catch { /* 기록이 아직 없다 */ }
  return 줄;
}

/* ============================================================ SHA-256 (동기) */
// 표의 지문에만 쓰는 작은 구현. 외부 라이브러리 없이 동기로 계산하려고 직접 둔다.
function sha256Hex(data: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padLen = (((data.length + 9 + 63) >> 6) << 6);
  const m = new Uint8Array(padLen);
  m.set(data);
  m[data.length] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padLen - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

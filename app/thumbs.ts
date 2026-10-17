// 썸네일 — 영상 옆 맞춤 그림 찾기 · 올리기 · 실패하면 표식을 남겨 다시 붙이기 · 이미 올라간 영상의 썸네일 점검/교체
//   (파이썬: thumbs.py + 썸네일수정.py + upload.py 의 find_thumb · THUMB_* · 썸네일실패까닭 · 썸네일실패남기기)
//
// ───────── 맞춤 썸네일이 왜 따로 신경 쓰이나 ─────────
//   쇼츠는 유튜브가 영상에서 뽑아 쓰지만 롱폼은 썸네일이 곧 클릭률이다. 올리기 전에 「올라갈 그림 그 자체」를 눈으로 봐야 하고
//   (없는데 있는 줄 알고 올리면 되돌릴 수 없다), 2MB 를 넘으면 유튜브가 거부하므로 미리 걸러 알려 준다.
//   thumbnails.set 은 youtube.upload 권한이면 되므로 코드 인증(TV 방식)으로도 된다. 한 번에 50유닛.
//
// ───────── 실패 표식과 다시 붙이기 ─────────
//   실제로 있었던 일: 새 채널이 전화번호 인증 전이라 thumbnails.set 이 403 으로 실패했는데 경고 한 줄로 끝나서 아무도 몰랐다.
//   원본은 특정 채널 하나에만 「기록 + 알림 + 표식(썸네일대기.json)」 셋을 남기고 10분 주기 작업이 다시 붙였다. 여기서는 채널 설정
//   `thumb_watch: true` 인 채널이 부르는 recordFailure 로 일반화했다(부르는 쪽이 설정을 보고 정한다 — upload.ts).
//   표식이 없으면 retryPending 은 유튜브를 한 번도 부르지 않는다.
//
//   ★원본과 다른 점 하나: 표식에 그림 **사본**을 함께 남긴다(`썸네일대기/<영상id>.<확장자>`).
//     원본은 제작기가 따로 두는 폴더에서 그림을 다시 찾았지만, 여기서는 올린 뒤 영상과 곁 파일(그림 포함)이
//     휴지통이나 「업로드완료」 폴더로 옮겨지므로 몇 분 뒤 재시도할 때 원래 자리에는 그림이 없다.
//   ★재시도 간격은 늘리고(10→30→60→120→240분) 6번째 실패에서 포기한다. 포기하면 표식에서 빼고 알린다
//     (원본은 4시간 간격으로 영영 계속했다 — 실패마다 50유닛이 든다).
import { baseName, cut, dataPath, dirName, exists, extOf, join, recordLine, recordPath, readJson, withFileLock, withSuffix, writeJson } from "./paths.ts";
import { addMinutes, isoWall, parseWall, wallNow } from "./clock.ts";
import { doFetch, GoogleError } from "./google.ts";
import { loadChannels, sameChannelNames } from "./channels.ts";
import { readLedger } from "./ledger.ts";
import { findTool } from "./tools.ts";
import { thumbnailsSet, videosList } from "./youtube.ts";
import { ytFor } from "./ytcore.ts";
import type { Yt } from "./ytcore.ts";
import { send } from "./notify.ts";

type Obj = Record<string, any>;

export const THUMB_EXT = [".jpg", ".jpeg", ".png"] as const;
/** 유튜브 썸네일 한도 2MB */
export const THUMB_MAX = 2 * 1024 * 1024;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 기록은 한 줄에 한 건이다 — 오류 글에 줄바꿈이 있으면 「 ⏎ 」로 바꾼다 (paths.ts 의 log() 와 같은 약속. recordLine 은 그대로 적는다) */
const 기록 = (파일: string, 줄: string) => recordLine(파일, 줄.replace(/\s*\r?\n\s*/g, " ⏎ "));
const dec = new TextDecoder();

/* ============================================================ 그림 머리에서 크기 읽기 */
// ffmpeg 없이 PNG 의 IHDR · JPEG 의 SOF 만 읽는다. 파일 전체를 읽지 않고 필요한 머리 몇십 바이트만 읽어서,
// 화면이 영상 수백 개의 썸네일 정보를 한꺼번에 물어도 부담이 없다.

export interface ImageInfo { format: "JPEG" | "PNG"; w: number; h: number }
type ReadAt = (pos: number, n: number) => Promise<Uint8Array>;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = (b: Uint8Array, o: number) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];

async function parseImage(read: ReadAt): Promise<ImageInfo | null> {
  const head = await read(0, 8);
  if (head.length >= 8 && PNG_SIG.every((v, i) => head[i] === v)) {
    let pos = 8;
    for (let n = 0; n < 8; n++) { // 맨 앞에 다른 조각(예: 아이폰 최적화 PNG 의 CgBI)이 끼어도 IHDR 까지 훑는다
      const h = await read(pos, 8);
      if (h.length < 8) return null;
      const len = u32(h, 0);
      if (String.fromCharCode(h[4], h[5], h[6], h[7]) === "IHDR") {
        const d = await read(pos + 8, 8);
        if (d.length < 8) return null;
        const w = u32(d, 0), hh = u32(d, 4);
        return w > 0 && hh > 0 ? { format: "PNG", w, h: hh } : null;
      }
      pos += 12 + len; // 길이 4 + 이름 4 + 내용 + 검사값 4
    }
    return null;
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
    let pos = 2;
    for (let n = 0; n < 400; n++) {
      const m2 = await read(pos, 2);
      if (m2.length < 2 || m2[0] !== 0xff) return null; // 표식을 놓쳤다 — 깨진 파일
      let marker = m2[1];
      pos += 2;
      while (marker === 0xff) { // 표식 앞의 채움 바이트
        const one = await read(pos, 1);
        if (!one.length) return null;
        marker = one[0];
        pos += 1;
      }
      // 길이가 없는 표식(SOI · TEM · RSTn)은 건너뛴다. EOI·SOS 까지 크기를 못 찾았으면 없는 것이다.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9 || marker === 0xda) return null;
      const lb = await read(pos, 2);
      if (lb.length < 2) return null;
      const len = u16(lb, 0);
      if (len < 2) return null;
      // SOF0~SOF15 중 표(DHT=C4) · 예약(C8) · 산술부호표(CC) 는 크기 표식이 아니다
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const d = await read(pos + 2, 5); // 정밀도 1 · 높이 2 · 폭 2
        if (d.length < 5) return null;
        const hh = u16(d, 1), w = u16(d, 3);
        return w > 0 && hh > 0 ? { format: "JPEG", w, h: hh } : null;
      }
      pos += len;
    }
  }
  return null;
}

function fileReader(f: Deno.FsFile): ReadAt {
  return async (pos, n) => {
    await f.seek(pos, Deno.SeekMode.Start);
    const buf = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const k = await f.read(buf.subarray(got));
      if (k === null) break;
      got += k;
    }
    return buf.subarray(0, got);
  };
}

/** 그림 파일의 종류와 크기. 그림이 아니거나 머리가 깨졌으면 null(「모름」). */
export async function imageInfo(path: string): Promise<ImageInfo | null> {
  let f: Deno.FsFile;
  try {
    f = await Deno.open(path, { read: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) await 기록("서버.log", `그림 머리를 못 읽었습니다 — ${baseName(path)}: ${errMsg(e).slice(0, 80)}`);
    return null;
  }
  try {
    return await parseImage(fileReader(f));
  } catch (e) {
    await 기록("서버.log", `그림 머리를 못 읽었습니다 — ${baseName(path)}: ${errMsg(e).slice(0, 80)}`);
    return null;
  } finally {
    try { f.close(); } catch { /* 이미 닫혔다 */ }
  }
}

/** 이미 메모리에 있는 그림 바이트의 종류와 크기 */
export function imageInfoOfBytes(bytes: Uint8Array): Promise<ImageInfo | null> {
  return parseImage(async (pos, n) => bytes.subarray(pos, pos + n));
}

/* ============================================================ 영상 옆 그림 찾기 */

export type ThumbFound = { path: string } | { skippedBig: string } | null;

/**
 * 영상 옆의 같은 이름 그림. 없으면 null. 2MB 를 넘으면 {skippedBig}(넘은 그림의 경로) — 유튜브가 거부하므로 올리지 않고
 * 부르는 쪽이 「건너뜁니다」라고 알린다. (파이썬 find_thumb)
 * ★확장자 차례(.jpg → .jpeg → .png)로 처음 만난 그림이 그 영상의 그림이다. 처음 것이 2MB 를 넘으면 다음 확장자를 찾지 않는다 — 원본과 같다.
 */
export async function findThumb(video: string): Promise<ThumbFound> {
  for (const ext of THUMB_EXT) {
    const t = withSuffix(video, ext);
    let st: Deno.FileInfo;
    try { st = await Deno.stat(t); } catch { continue; } // 없으면 다음 확장자
    if (!st.isFile) continue;
    if (st.size > THUMB_MAX) return { skippedBig: t };
    return { path: t };
  }
  return null;
}

export interface CustomThumb {
  있음: boolean;
  이름: string;
  크기: number;
  /** 2MB 를 넘어 유튜브가 거부할 것인가 */
  넘침: boolean;
  /** 그림 크기 — 16:9 가 아니면 유튜브가 잘라 낸다. 못 읽으면 0 */
  가로: number;
  세로: number;
  /** 그림 파일의 경로 (화면이 보여 줄 때 쓴다) */
  path: string;
}

/**
 * 영상 옆에 둔 **맞춤 썸네일**을 본다 — 실제로 유튜브에 올라갈 그림. (파이썬 thumbs.custom)
 * 카드에 뜨는 그림은 영상에서 뽑은 첫 화면이고 그건 유튜브에 안 올라간다. 올라갈 그림 그 자체를 볼 수 있어야 한다.
 * 화면용 축소 그림(data URI)은 만들지 않는다 — 브라우저가 path 의 파일을 줄여서 보여 준다.
 * 영상 첫 장면 캐시(파이썬 thumbs.get)도 만들지 않는다 — 브라우저가 `<video>` 로 직접 보여 준다.
 */
export async function custom(video: string): Promise<CustomThumb> {
  for (const ext of THUMB_EXT) {
    const p = withSuffix(video, ext);
    let st: Deno.FileInfo;
    try { st = await Deno.stat(p); } catch { continue; } // 없으면 다음 확장자
    if (!st.isFile) continue;
    const info = await imageInfo(p);
    return { 있음: true, 이름: baseName(p), 크기: st.size, 넘침: st.size > THUMB_MAX, 가로: info?.w ?? 0, 세로: info?.h ?? 0, path: p };
  }
  return { 있음: false, 이름: "", 크기: 0, 넘침: false, 가로: 0, 세로: 0, path: "" };
}

/* ============================================================ 올리기 */

/** 실패 까닭 한 줄 — 유튜브가 준 오류는 「403 <유튜브가 준 말>」, 그 밖은 「종류: 말」. (파이썬 썸네일실패까닭) */
export function failureReason(e: unknown): string {
  const one = (s: string) => cut(s.replace(/\r?\n/g, " "), 150);
  if (e instanceof GoogleError && e.status) {
    let msg = "";
    try { msg = String(JSON.parse(e.body)?.error?.message ?? ""); } catch { /* 몸이 JSON 이 아니면 아래 */ }
    // GoogleError.message 는 이미 「403 내용」 꼴이라 번호를 한 번 더 붙이지 않게 앞 번호를 뗀다
    if (!msg) msg = e.message.replace(/^\d{3}\s*/, "") || e.reason;
    return one(`${e.status} ${msg}`);
  }
  if (e instanceof Error) return one(`${e.name}: ${e.message}`);
  return one(String(e));
}

export interface ThumbSetResult {
  ok: boolean;
  /** 사람이 읽는 한 줄 */
  message: string;
  /** 실패했을 때의 원래 오류 — recordFailure 에 그대로 넘긴다 */
  error?: unknown;
}

/** 확장자로 정한 이름 (그림 내용을 알면 아래 mimeFor 가 내용을 우선한다) */
const mimeOfExt = (ext: string) => (ext === ".png" ? "image/png" : "image/jpeg");

/**
 * 그림 한 장을 썸네일로 올린다. 던지지 않고 결과를 돌려준다. (파이썬 upload.py 의 thumbnails().set 부분)
 * 2MB · 확장자를 먼저 본다. Content-Type 은 확장자가 아니라 **그림 내용**으로 정한다 — 이름만 .jpg 인 PNG 를 보내면
 * 유튜브는 Content-Type 으로 판단하므로 거부한다(이름은 서버에 가지 않는다).
 */
export async function setThumbnailFor(yt: Yt, videoId: string, path: string): Promise<ThumbSetResult> {
  const name = baseName(path);
  const ext = extOf(path);
  if (!(THUMB_EXT as readonly string[]).includes(ext)) {
    return { ok: false, message: `썸네일은 jpg · jpeg · png 만 됩니다 — ${name}` };
  }
  let st: Deno.FileInfo;
  try { st = await Deno.stat(path); } catch { return { ok: false, message: `썸네일 파일을 찾을 수 없습니다 — ${name}` }; }
  if (!st.isFile) return { ok: false, message: `썸네일 파일이 아닙니다 — ${name}` };
  if (st.size === 0) return { ok: false, message: `썸네일 파일이 비어 있습니다 — ${name}` };
  if (st.size > THUMB_MAX) {
    return { ok: false, message: `썸네일이 2MB를 넘습니다 — ${name} (${(st.size / 1024 / 1024).toFixed(1)}MB)` };
  }
  try {
    const bytes = await Deno.readFile(path);
    const info = await imageInfoOfBytes(bytes);
    const mime = info ? (info.format === "PNG" ? "image/png" : "image/jpeg") : mimeOfExt(ext);
    await thumbnailsSet(yt, videoId, bytes, mime);
    return { ok: true, message: `썸네일 올림 — ${name}` };
  } catch (e) {
    return { ok: false, message: `썸네일은 못 올렸습니다 — ${failureReason(e)}`, error: e };
  }
}

/* ============================================================ 실패 표식 */

export interface PendingThumb {
  video_id: string;
  /** 채널 이름(별칭) — 다시 붙일 때 이 이름으로 도구를 만든다 */
  채널: string;
  /** 영상 파일 이름 */
  파일: string;
  /** 올릴 때 그림이 있던 자리 */
  썸네일: string;
  /** 그림 사본(데이터 폴더 안) — 영상과 곁 파일이 옮겨진 뒤에도 다시 붙일 수 있게 */
  보관본?: string;
  썸네일_sha256: string;
  까닭: string;
  시각: string;
  /** 다시 붙이다 실패한 횟수 */
  시도: number;
  /** 이 시각 전에는 다시 안 해 본다(벽시계 글자). 처음엔 null — 다음 차례에 바로 */
  다음시도: string | null;
  마지막확인?: string;
}

export const pendingPath = () => dataPath("썸네일대기.json");
const pendingLock = () => dataPath("썸네일대기.lock");
const keepDirOf = () => dataPath("썸네일대기");

const isEntry = (x: unknown): x is PendingThumb =>
  !!x && typeof x === "object" && typeof (x as Obj).video_id === "string" && !!(x as Obj).video_id;

/** 표식 목록. 파일이 없거나 비었으면 []. */
export async function loadPending(): Promise<PendingThumb[]> {
  const d = await readJson<unknown>(pendingPath(), []);
  return Array.isArray(d) ? d.filter(isEntry) : [];
}

/**
 * 표식 목록을 잠그고 고친다. 업로드 쪽(recordFailure)과 예약 작업(retryPending)이 겹쳐 쓰다 서로의 줄을 지우지 않게.
 * 알아볼 수 없는 칸(video_id 가 없는 것)은 건드리지 않고 그대로 뒤에 둔다.
 */
async function editPending(고치기: (list: PendingThumb[]) => PendingThumb[]): Promise<void> {
  await withFileLock(pendingLock(), async () => {
    const raw = await readJson<unknown>(pendingPath(), []);
    const arr = Array.isArray(raw) ? raw : [];
    const next = 고치기(arr.filter(isEntry));
    await writeJson(pendingPath(), [...next, ...arr.filter((x) => !isEntry(x))]);
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const safeId = (s: string) => s.replace(/[^\w-]/g, "_");

/**
 * 썸네일을 못 올렸을 때 — 기록 · 표식 · 알림 셋을 남긴다. 셋은 서로 막지 않고 예외는 밖으로 내지 않는다. (파이썬 썸네일실패남기기)
 * 영상은 이미 올라갔으므로 여기서 어떤 일이 나도 업로드 흐름을 멈추면 안 된다.
 * 같은 영상의 표식이 이미 있으면 새 것으로 바꾼다(시도 횟수도 처음부터).
 */
export async function recordFailure(
  name: string, path: string, vid: string, thumbPath: string, err: unknown,
): Promise<void> {
  const 까닭 = failureReason(err);
  const 파일 = baseName(path);
  await 기록("올리기.log", `썸네일실패 [${name}] ${파일} ${vid} ${까닭}`);

  try {
    let sha = "", 보관본 = "";
    try {
      const bytes = await Deno.readFile(thumbPath);
      sha = await sha256Hex(bytes);
      await Deno.mkdir(keepDirOf(), { recursive: true });
      보관본 = join(keepDirOf(), safeId(vid) + extOf(thumbPath));
      const tmp = `${보관본}.${Date.now().toString(36)}.tmp`;
      await Deno.writeFile(tmp, bytes);
      await Deno.rename(tmp, 보관본);
    } catch (e) {
      // 사본을 못 남겨도 표식은 남긴다 — 다시 붙일 때 원래 자리에서라도 찾아본다
      보관본 = "";
      await 기록("서버.log", `썸네일 그림 사본을 못 남겼습니다 — ${baseName(thumbPath)}: ${errMsg(e).slice(0, 80)}`);
    }
    const 새: PendingThumb = {
      video_id: vid, 채널: name, 파일, 썸네일: thumbPath, ...(보관본 ? { 보관본 } : {}), 썸네일_sha256: sha,
      까닭, 시각: isoWall(wallNow()), 시도: 0, 다음시도: null,
    };
    await editPending((list) => [...list.filter((x) => x.video_id !== vid), 새]);
  } catch (e) {
    await 기록("서버.log", `썸네일 재시도 표식을 못 남겼습니다 — ${errMsg(e).slice(0, 90)}`);
  }

  const 인증 = /403/.test(까닭) && /thumbnail/i.test(까닭);
  await send([
    "⚠️ 썸네일 실패",
    `채널  ${name}`,
    `영상  ${cut(파일, 60)}`,
    `주소  https://youtu.be/${vid}`,
    `까닭  ${cut(까닭, 180)}`,
    "",
    "영상은 올라갔지만 썸네일이 안 붙었습니다. 시간을 두고 다시 붙여 봅니다." +
      (인증 ? " 채널 전화번호 인증이 먼저 필요합니다(youtube.com/verify)." : ""),
  ].join("\n"));
}

/* ============================================================ 다시 붙이기 */

/** 실패 n 번째 뒤 다음 시도까지(분) — 실패마다 50유닛이라 간격을 벌린다 (원본: 0 · 10 · 30 · 60 · 120 · 240) */
export const RETRY_WAIT_MIN = [10, 30, 60, 120, 240];
/** 이만큼 실패하면 포기한다 */
export const MAX_ATTEMPTS = 6;
/** 채널 상태(longUploadsStatus)가 이 값이면 전화번호 인증 전이다 — 인증은 사람이 한다 */
const NEEDS_VERIFY = ["eligible", "disallowed"];
const VERIFY_MSG = "채널 전화번호 인증 필요(youtube.com/verify)";
/** 인증을 기다리는 표식은 이만큼 간격으로만 채널 상태를 물어본다(분) */
const VERIFY_RECHECK_MIN = 60;

export interface RetrySummary {
  /** 이번에 살펴본(시각이 된) 표식 */
  확인: number;
  붙임: number;
  /** 시도했지만 안 돼서 다음으로 미룸 */
  실패: number;
  포기: number;
  /** 아직 시각이 안 됨 */
  대기: number;
  /** 채널이 인증 전이라 보내지 않고 기다림 */
  인증대기: number;
}

/** 다시 붙일 그림: 사본 → 원래 자리 순. 기록된 sha 와 다르면 쓰지 않는다(다른 판의 그림을 붙이지 않는다). */
async function pickThumb(e: PendingThumb): Promise<{ path: string; bytes: Uint8Array } | { why: string }> {
  const cands = [e.보관본, e.썸네일].filter((x): x is string => !!x);
  let 다른판 = "";
  for (const c of new Set(cands)) {
    if (!(await exists(c))) continue;
    let bytes: Uint8Array;
    try { bytes = await Deno.readFile(c); } catch { continue; } // 못 읽는 후보는 건너뛰고 다음 후보를 본다 — 모두 못 읽으면 아래에서 「못 찾음」으로 말한다
    if (!e.썸네일_sha256 || (await sha256Hex(bytes)) === e.썸네일_sha256) return { path: c, bytes };
    다른판 ||= c;
  }
  return { why: 다른판 ? `썸네일 그림은 있지만 기록된 sha 와 다르다(다른 판일 수 있음): ${다른판}` : `썸네일 그림을 못 찾음: ${cands.join(" · ") || "(자리 기록 없음)"}` };
}

type Outcome = { kind: "붙임" } | { kind: "인증대기"; 까닭: string } | { kind: "실패"; 까닭: string };

/** 표식 하나를 다시 붙여 본다. 던지지 않는다. */
async function tryOne(e: PendingThumb): Promise<Outcome> {
  const pick = await pickThumb(e);
  if ("why" in pick) return { kind: "실패", 까닭: pick.why }; // 유튜브를 부르지 않는다 — 돈이 안 든다
  let yt: Yt;
  try { yt = await ytFor(e.채널); } catch (x) { return { kind: "실패", 까닭: `채널 도구를 만들지 못함: ${errMsg(x).slice(0, 100)}` }; }

  // 인증 전인 채널에는 보내지 않는다 — 보내 봤자 403 이고 50유닛만 든다. 상태 확인은 1유닛.
  try {
    const r = await yt.get("/youtube/v3/channels", { part: "status", mine: true });
    const lus = r.items?.[0]?.status?.longUploadsStatus;
    if (typeof lus === "string" && NEEDS_VERIFY.includes(lus)) {
      return { kind: "인증대기", 까닭: `${VERIFY_MSG} (longUploadsStatus=${lus})` };
    }
  } catch (x) {
    return { kind: "실패", 까닭: `채널 상태를 못 읽음: ${failureReason(x)}` };
  }

  const info = await imageInfoOfBytes(pick.bytes);
  try {
    await thumbnailsSet(yt, e.video_id, pick.bytes, info ? (info.format === "PNG" ? "image/png" : "image/jpeg") : mimeOfExt(extOf(pick.path)));
    return { kind: "붙임" };
  } catch (x) {
    return { kind: "실패", 까닭: failureReason(x) };
  }
}

let 도는중 = false;

/** 표식 한 줄을 바꾸거나(새 값) 지운다(null). 도는 사이 새로 쌓인 다른 표식은 그대로 둔다. */
function applyEntry(id: string, 새: PendingThumb | null): Promise<void> {
  return editPending((cur) => (새 ? cur.map((x) => (x.video_id === id ? 새 : x)) : cur.filter((x) => x.video_id !== id)));
}

/**
 * 표식에 남은 썸네일을 다시 붙여 본다. 예약 작업이 10분마다 부르는 문이다. (파이썬: 제작기 쪽 _thumb_wait)
 *   · 표식이 없으면 유튜브를 한 번도 부르지 않는다.
 *   · 다음 시도 시각이 안 된 표식은 건드리지 않는다.
 *   · 채널이 전화번호 인증 전이면 보내지 않고 기다린다(실패 횟수에 안 센다 — 사람이 인증하면 저절로 붙는다).
 *   · 성공하면 표식과 그림 사본을 지우고 알린다. 실패하면 간격을 늘려 미루고, 3번째에 한 번 알리며, 6번째에 포기하고 알린다.
 *   · 결과는 표식마다 바로 적는다 — 도중에 앱이 꺼져도 이미 붙인 것을 다음 차례에 또 보내(50유닛) 낭비하지 않게.
 *     그래서 도는 사이 새로 쌓인 표식도 잃지 않는다. 두 군데서 겹쳐 돌지 않는다.
 * 던지지 않는다.
 */
export async function retryPending(): Promise<RetrySummary> {
  const sum: RetrySummary = { 확인: 0, 붙임: 0, 실패: 0, 포기: 0, 대기: 0, 인증대기: 0 };
  if (도는중) return sum;
  도는중 = true;
  try {
    const list = await loadPending();
    if (!list.length) return sum; // 표식이 없으면 유튜브를 한 번도 안 부른다
    for (const e of list) {
      try {
        const 때 = e.다음시도 ? parseWall(e.다음시도) : null;
        if (때 && wallNow().getTime() < 때.getTime()) { sum.대기++; continue; }
        sum.확인++;
        const 결과 = await tryOne(e);
        const now = wallNow();
        const 확인시각 = isoWall(now);
        if (결과.kind === "붙임") {
          sum.붙임++;
          await applyEntry(e.video_id, null);
          if (e.보관본) {
            try { await Deno.remove(e.보관본); }
            catch (x) { if (!(x instanceof Deno.errors.NotFound)) await 기록("서버.log", `썸네일 사본을 못 지웠습니다 — ${baseName(e.보관본)}: ${errMsg(x).slice(0, 60)}`); }
          }
          await 기록("올리기.log", `썸네일재시도성공 [${e.채널}] ${e.파일} ${e.video_id} ${(Number(e.시도) || 0) + 1}번째`);
          await send(["✅ 썸네일 붙음", `채널  ${e.채널}`, `영상  ${cut(e.파일, 60)}`, `주소  https://youtu.be/${e.video_id}`].join("\n"));
        } else if (결과.kind === "인증대기") {
          sum.인증대기++;
          await applyEntry(e.video_id, { ...e, 까닭: 결과.까닭, 마지막확인: 확인시각, 다음시도: isoWall(addMinutes(now, VERIFY_RECHECK_MIN)) });
        } else {
          const n = (Number(e.시도) || 0) + 1;
          if (n >= MAX_ATTEMPTS) {
            sum.포기++;
            await applyEntry(e.video_id, null); // 그림 사본은 남긴다 — 사람이 직접 올릴 때 쓸 수 있다
            await 기록("올리기.log", `썸네일포기 [${e.채널}] ${e.파일} ${e.video_id} ${n}번 실패 ${cut(결과.까닭, 100)}`);
            await send([
              "⚠️ 썸네일 포기", `채널  ${e.채널}`, `영상  ${cut(e.파일, 60)}`, `주소  https://youtu.be/${e.video_id}`,
              `까닭  ${cut(결과.까닭, 160)}`, "",
              `다시 붙이기를 ${n}번 했지만 안 됩니다. 앱은 더 시도하지 않습니다. 유튜브 스튜디오에서 직접 바꿔 주세요.` +
                (e.보관본 ? `\n그림 사본: ${e.보관본}` : ""),
            ].join("\n"));
          } else {
            sum.실패++;
            const 분 = RETRY_WAIT_MIN[Math.min(n, RETRY_WAIT_MIN.length) - 1];
            await applyEntry(e.video_id, { ...e, 시도: n, 까닭: 결과.까닭, 마지막확인: 확인시각, 다음시도: isoWall(addMinutes(now, 분)) });
            await 기록("올리기.log", `썸네일재시도실패 [${e.채널}] ${e.파일} ${e.video_id} ${n}번째 ${cut(결과.까닭, 100)}`);
            if (n === 3) {
              await send([
                "⚠️ 썸네일 아직 안 붙음", `채널  ${e.채널}`, `영상  ${cut(e.파일, 60)}`, `주소  https://youtu.be/${e.video_id}`,
                `까닭  ${cut(결과.까닭, 160)}`, "", `다시 붙이기를 ${n}번 했지만 안 됩니다. 사람이 봐야 합니다.`,
              ].join("\n"));
            }
          }
        }
      } catch (x) {
        // 표식 하나가 이상해도 나머지는 계속 간다
        await 기록("서버.log", `썸네일 다시 붙이기 중 오류(${e.video_id}) — ${errMsg(x).slice(0, 110)}`);
      }
    }
  } catch (x) {
    await 기록("서버.log", `썸네일 다시 붙이기 중 오류 — ${errMsg(x).slice(0, 110)}`);
  } finally {
    도는중 = false;
  }
  return sum;
}

/* ============================================================ 이미 올라간 영상의 썸네일 점검 · 교체 (파이썬 썸네일수정.py) */
// 기본은 읽기, apply 를 줄 때만 교체한다. 교체 전에 원본 썸네일과 영상 정보를 파일로 보관하고, 요청 직전에 request.json 에
// 「보냈다」고 적고, 교체 뒤에는 썸네일 말고 다른 정보가 안 바뀌었는지 확인한다. 자동으로 다시 보내지 않는다(automatic_retry: false).
// 결과 파일은 `기록/썸네일수정/<시각>_<영상id>/`(점검은 `_점검`) 에 원본과 같은 이름으로 남는다.

/** 썸네일 점검·교체를 못 한 까닭 — 메시지가 그대로 사람에게 보인다. result 는 남긴 결과 파일 내용(있으면). */
export class ThumbError extends Error {
  constructor(m: string, public result?: Obj) { super(m); this.name = "ThumbError"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 동시에 limit 개까지만 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 영상 정보에서 가장 큰 썸네일 주소 */
function pictureOf(video: Obj): string | null {
  const th = video.snippet?.thumbnails ?? {};
  for (const k of ["maxres", "standard", "high", "medium", "default"]) if (th[k]?.url) return String(th[k].url);
  return null;
}

/** 키 순서에 상관없이 같은 값이면 같은 글이 되게 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v as Obj).sort().map((k) => JSON.stringify(k) + ":" + stable((v as Obj)[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

/** 썸네일을 뺀 나머지 — 교체 전후로 이게 같아야 한다 */
function unchangedPart(video: Obj): string {
  const { thumbnails: _t, ...snippet } = (video.snippet ?? {}) as Obj;
  return stable({ snippet, status: video.status ?? {}, contentDetails: video.contentDetails ?? {} });
}

/**
 * 유튜브 썸네일 내려받기. 같은 주소가 캐시에서 옛 그림을 돌려주는 일이 있어(확정된 교체 뒤에도) 이미지 서버 주소엔 매번 다른
 * 쪽지를 붙여 캐시를 비켜 간다 — 이렇게 해도 thumbnails.set 을 또 보내지 않는다.
 */
async function download(url: string): Promise<Uint8Array> {
  let u = url;
  try {
    const p = new URL(url);
    if (p.hostname === "i.ytimg.com") {
      p.searchParams.set("thumb_check", `${Date.now()}${Math.floor(Math.random() * 1e6)}`);
      u = p.toString();
    }
  } catch { /* 주소로 읽히지 않으면 그대로 시도한다 */ }
  const res = await doFetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export interface Similarity { mean_absolute_rgb_error?: number; matches: boolean; read_error?: string }

/**
 * 그림을 320×180 원시 RGB 로 푼다. 유튜브가 4:3 에 검은 띠를 두른 그림을 줄 때는 가운데 16:9 만 잘라 쓴다.
 * ★ffmpeg 는 파일 이름의 확장자로 디코더를 고른다(.jpg 면 JPEG 로 읽는다). 이름과 내용이 다른 그림(보관할 때 늘 .jpg 로
 *   저장하는 원본 썸네일이 PNG 일 때 등)을 못 풀므로, 그림 **내용**으로 종류를 알아내 표준입력으로 넘기며 디코더를 지정한다.
 *   종류를 모르는 그림만 파일 이름 그대로 ffmpeg 가 알아보게 한다. (파이썬은 Pillow 가 내용으로 읽었다)
 */
async function rawRgb(ffmpeg: string, file: string, crop169: boolean): Promise<Uint8Array> {
  const vf = "format=rgb24," +
    (crop169 ? "crop=iw:round(iw*9/16):0:trunc((ih-round(iw*9/16))/2)," : "") + "scale=320:180";
  const info = await imageInfo(file);
  const 입력 = info ? ["-f", "image2pipe", "-c:v", info.format === "PNG" ? "png" : "mjpeg", "-i", "pipe:0"] : ["-i", file];
  const child = new Deno.Command(ffmpeg, {
    args: ["-v", "error", ...입력, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    stdin: info ? "piped" : "null", stdout: "piped", stderr: "piped",
  }).spawn();
  const 결과 = child.output(); // 읽기를 먼저 걸어 둔다 — 쓰는 동안 파이프가 막히지 않게
  if (info) {
    const w = child.stdin.getWriter();
    try {
      await w.write(await Deno.readFile(file));
      await w.close();
    } catch { /* ffmpeg 가 다 읽기 전에 닫았다 — 아래에서 종료 코드로 알게 된다 */ }
  }
  const out = await 결과;
  if (out.code !== 0) throw new Error(`ffmpeg 가 그림을 풀지 못했습니다: ${dec.decode(out.stderr).trim().slice(0, 100)}`);
  if (out.stdout.length !== 320 * 180 * 3) throw new Error("그림을 풀었지만 크기가 맞지 않습니다");
  return out.stdout;
}

/**
 * 두 그림이 같은지 — 320×180 으로 줄여 평균 절대 오차를 잰다(9 미만이면 같다). (파이썬 similarity — Pillow 대신 ffmpeg)
 * 디코더가 없는 Deno 라 ffmpeg 가 필요하다. 없으면 null(「비교 못 함」).
 */
async function similarity(ffmpeg: string, localFile: string, remoteFile: string): Promise<Similarity> {
  try {
    const ri = await imageInfo(remoteFile);
    const a = await rawRgb(ffmpeg, localFile, false);
    const b = await rawRgb(ffmpeg, remoteFile, !!ri && Math.abs(ri.w / ri.h - 4 / 3) < 0.01);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    const error = s / a.length;
    return { mean_absolute_rgb_error: Math.round(error * 1000) / 1000, matches: error < 9 };
  } catch (e) {
    return { matches: false, read_error: errMsg(e) };
  }
}

/** thumbnails.set 이 거절당한 모습을 result.json 에 적을 꼴로 (파이썬 write_failure) */
function failureRecord(e: unknown): Obj {
  const r: Obj = { status: "request_failed_or_unknown", reason: errMsg(e), automatic_retry: false };
  if (e instanceof GoogleError) {
    let reasons: unknown[] = [];
    try { reasons = (JSON.parse(e.body)?.error?.errors ?? []).map((x: Obj) => x?.reason); } catch { /* 몸이 JSON 이 아니다 */ }
    if (e.status === 429 && reasons.includes("uploadRateLimitExceeded")) {
      Object.assign(r, { status: "rejected_thumbnail_rate_limit", accepted: false, http_status: 429, youtube_reason: "uploadRateLimitExceeded", retry_after_limit_clears: true });
    }
  }
  return r;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const p3 = (n: number) => String(n).padStart(3, "0");

/** 결과를 담을 새 폴더. 이미 있으면 던진다(파이썬 exist_ok=False — 남의 결과를 덮지 않는다). */
async function makeOutDir(outDir: string | undefined, suffix: string): Promise<string> {
  let dir = outDir;
  if (!dir) {
    const w = wallNow();
    const stamp = `${w.getUTCFullYear()}${p2(w.getUTCMonth() + 1)}${p2(w.getUTCDate())}_${p2(w.getUTCHours())}${p2(w.getUTCMinutes())}${p2(w.getUTCSeconds())}` +
      `_${p3(Date.now() % 1000)}${p3(Math.floor(Math.random() * 1000))}`;
    dir = recordPath("썸네일수정", stamp + suffix);
  }
  await Deno.mkdir(dirName(dir), { recursive: true });
  try {
    await Deno.mkdir(dir);
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) throw new ThumbError(`결과 폴더가 이미 있습니다 — ${dir}`);
    throw e;
  }
  return dir;
}

/** 채널 이름 → 채널 id. 등록된 채널이 아니면 던진다. */
function channelIdOf(channelKey: string): string {
  const cid = loadChannels()[channelKey]?.channel_id;
  if (!cid) throw new ThumbError("등록된 채널 이름을 지정하세요");
  return cid;
}

interface SavedOriginal { id: string; status: "saved" | "no_thumbnail" | "unavailable"; url?: string; path?: string; sha256?: string; error?: string }

/** 결과 폴더를 만들고 영상 정보(before.json)와 지금 걸린 썸네일 그림을 보관한다 */
async function preserve(items: Obj[], outDir: string | undefined, suffix: string): Promise<{ dir: string; saved: SavedOriginal[] }> {
  const dir = await makeOutDir(outDir, suffix);
  await writeJson(join(dir, "before.json"), items);
  const saved = await mapLimit(items, 4, async (v): Promise<SavedOriginal> => {
    const url = pictureOf(v);
    if (!url) return { id: v.id, status: "no_thumbnail" };
    try {
      const data = await download(url);
      const target = join(dir, `${v.id}_before.jpg`);
      await Deno.writeFile(target, data);
      return { id: v.id, url, path: target, sha256: await sha256Hex(data), status: "saved" };
    } catch (e) {
      return { id: v.id, status: "unavailable", error: errMsg(e) };
    }
  });
  await writeJson(join(dir, "original_thumbnails.json"), saved);
  return { dir, saved };
}

export interface InspectResult {
  directory: string;
  videos: { id: string; title: string; privacy: string }[];
}

/**
 * 채널의 롱폼(원장에서 길이 180초 초과)을 읽어 현재 정보와 썸네일을 보관한다. 읽기뿐이라 유튜브에는 아무것도 바꾸지 않는다.
 * 원장의 채널 칸이 같은 채널의 다른 이름(쇼츠용·롱폼용)이어도 같이 본다. (파이썬 --inspect-longforms)
 */
export async function inspectLongforms(channelKey: string, outDir?: string): Promise<InspectResult> {
  const cid = channelIdOf(channelKey);
  const 이름들 = sameChannelNames(channelKey);
  const rows = readLedger().filter((r) => 이름들.has(r["채널"] ?? "") && (parseFloat(r["길이초"] ?? "") || 0) > 180);
  const ids = [...new Set(rows.map((r) => r["영상ID"]).filter(Boolean))];
  const yt = await ytFor(channelKey);
  const items = ids.length ? await videosList(yt, ids, "snippet,status,contentDetails") : [];
  for (const v of items) {
    if (v.snippet?.channelId !== cid) throw new ThumbError("영상의 실제 채널이 요청한 채널과 다릅니다");
  }
  const { dir } = await preserve(items, outDir, "_점검");
  await writeJson(join(dir, "ledger_rows.json"), rows);
  return {
    directory: dir,
    videos: items.map((v) => ({ id: String(v.id), title: String(v.snippet?.title ?? ""), privacy: String(v.status?.privacyStatus ?? "") })),
  };
}

export interface ReplaceOpts {
  /** true 일 때만 실제로 교체한다. 기본은 미리보기(원격 변경 없음) */
  apply?: boolean;
  outDir?: string;
  /** 교체 뒤 반영을 기다리는 간격(밀리초, 기본 2000) — 시험은 0 */
  waitMs?: number;
}

export type ReplaceStatus = "preview" | "already_matches" | "verified" | "accepted_pending_thumbnail_propagation";

export interface ReplaceResult {
  status: ReplaceStatus;
  directory: string;
  /** 사람이 읽는 한 줄 */
  message: string;
  /** request.json 에 적은 내용 */
  request: Obj;
  similarity?: Similarity;
}

/**
 * 영상 하나의 썸네일을 그림 파일로 바꾼다. apply 가 없으면 미리보기 — 원격은 아무것도 안 바뀐다. (파이썬 썸네일수정.py)
 * 안전 장치
 *   · 영상의 실제 채널이 요청한 채널과 같아야 한다
 *   · 그림은 640px 이상 · 16:9 · JPEG/PNG · 2MB 이하
 *   · 교체 전에 원본 썸네일을 파일로 보관한다 (못 보관하면 교체하지 않는다)
 *   · 이미 같은 그림이면 보내지 않는다 — 같은지 재려면 ffmpeg 가 필요해서, apply 인데 ffmpeg 가 없으면 아무것도 보내지 않고 멈춘다
 *   · 요청 직전에 request.json 에 submitted 를 적는다. 요청은 한 번만 보낸다
 *   · 교체 뒤 썸네일 말고 다른 정보가 달라졌으면 멈춘다(더 고치지 않는다)
 */
export async function replaceThumbnail(
  channelKey: string, videoId: string, imagePath: string, o: ReplaceOpts = {},
): Promise<ReplaceResult> {
  const cid = channelIdOf(channelKey);
  if (!videoId || !imagePath) throw new ThumbError("영상ID와 썸네일 파일을 지정하세요");
  const yt = await ytFor(channelKey);
  const items = await videosList(yt, [videoId], "snippet,status,contentDetails");
  for (const v of items) {
    if (v.snippet?.channelId !== cid) throw new ThumbError("영상의 실제 채널이 요청한 채널과 다릅니다");
  }
  if (items.length !== 1) throw new ThumbError("영상을 찾을 수 없습니다");
  const { dir, saved } = await preserve(items, o.outDir, `_${videoId}`);

  const data = await Deno.readFile(imagePath);
  const info = await imageInfoOfBytes(data);
  if (!info || info.w < 640 || Math.abs(info.w / info.h - 16 / 9) > 0.02) {
    throw new ThumbError("썸네일은 640px 이상, 16:9 JPEG/PNG여야 합니다");
  }
  if (data.length > THUMB_MAX) throw new ThumbError("썸네일이 2MB를 넘습니다");
  const mime = info.format === "PNG" ? "image/png" : "image/jpeg";

  const record: Obj = {
    video_id: videoId, channel_id: cid, image: imagePath, sha256: await sha256Hex(data), bytes: data.length,
    size: [info.w, info.h], submitted: false, automatic_retry: false,
  };
  await writeJson(join(dir, "request.json"), record);
  const title = String(items[0].snippet?.title ?? "");

  if (!o.apply) {
    return { status: "preview", directory: dir, request: record, message: `미리보기 — 원격 변경 없음 (${title})` };
  }

  if (saved[0].status !== "saved") throw new ThumbError("원본 썸네일 보관 실패 — 교체 요청하지 않음");
  // 비교를 못 하면 보내지 않는다 — 「이미 같은 그림」을 가릴 수 없는 채로 요청하면 같은 그림을 또 보내 50유닛을 쓸 수 있다
  const 멈춤 = async (reason: string, 말: string): Promise<never> => {
    const r = { status: "stopped_cannot_compare", submitted: false, reason };
    await writeJson(join(dir, "result.json"), r);
    throw new ThumbError(`${말} — 교체하지 않았습니다`, r);
  };
  const ffmpeg = await findTool("ffmpeg");
  if (!ffmpeg) return await 멈춤("ffmpeg 가 없어 같은 그림인지 비교할 수 없다", "ffmpeg 가 없어 지금 걸린 그림과 같은지 비교할 수 없습니다(ffmpeg 를 설치하면 됩니다)");
  const already = await similarity(ffmpeg, imagePath, saved[0].path!);
  if (already.read_error) return await 멈춤(already.read_error, `지금 걸린 그림이나 새 그림을 읽지 못해 같은지 비교할 수 없습니다(${cut(already.read_error, 80)})`);
  if (already.matches) {
    await writeJson(join(dir, "result.json"), { status: "already_matches", submitted: false });
    return { status: "already_matches", directory: dir, request: record, similarity: already, message: "이미 같은 썸네일입니다 — 교체 요청 없음" };
  }

  // ── 여기서부터 되돌릴 수 없다: 보냈다고 먼저 적고 한 번만 보낸다
  record.submitted = true;
  record.submitted_at = new Date().toISOString();
  await writeJson(join(dir, "request.json"), record);
  try {
    const response = await thumbnailsSet(yt, videoId, data, mime);
    await writeJson(join(dir, "response.json"), response);
  } catch (e) {
    const fr = failureRecord(e);
    await writeJson(join(dir, "result.json"), fr);
    throw new ThumbError(`썸네일 교체 요청이 거절됐습니다 — ${failureReason(e)}`, fr);
  }

  let match: Similarity = { matches: false };
  for (let attempt = 0; attempt < 6; attempt++) {
    const after = (await videosList(yt, [videoId], "snippet,status,contentDetails"))[0];
    if (!after) throw new ThumbError("교체 뒤 영상을 다시 읽지 못했습니다");
    await writeJson(join(dir, "after.json"), after);
    if (unchangedPart(items[0]) !== unchangedPart(after)) {
      throw new ThumbError("썸네일 외 원격 정보가 달라졌습니다 — 추가 수정하지 않음");
    }
    const url = pictureOf(after);
    try {
      if (!url) throw new Error("유튜브가 돌려준 썸네일 주소가 없다");
      const got = await download(url);
      const f = join(dir, "after.jpg");
      await Deno.writeFile(f, got);
      match = await similarity(ffmpeg, imagePath, f);
    } catch (e) {
      match = { matches: false, read_error: errMsg(e) };
    }
    if (match.matches) break;
    if (attempt < 5) await sleep(o.waitMs ?? 2000);
  }
  const status: ReplaceStatus = match.matches ? "verified" : "accepted_pending_thumbnail_propagation";
  await writeJson(join(dir, "result.json"), {
    status, thumbnail_similarity: match, other_metadata_unchanged: true, automatic_retry: false,
  });
  return {
    status, directory: dir, request: record, similarity: match,
    message: match.matches
      ? "교체했고, 유튜브에 걸린 그림이 우리 그림과 같음을 확인했습니다"
      : "교체 요청은 받아들여졌지만 아직 새 그림이 보이지 않습니다(반영이 늦을 수 있습니다) — 다시 보내지 않습니다",
  };
}


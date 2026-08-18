// YouTube Data API v3 — resumable 업로드 (중단 지점 이어올리기 포함)
import { Config, log } from "./paths.ts";
import { accessToken } from "./auth.ts";

const CHUNK = 8 * 1024 * 1024;               // 256KB 배수여야 함
export const UPLOAD_COST = 1600;             // 업로드 1건당 쿼터
export const DAILY_QUOTA = 10000;

/** 오류 성격 — 재시도 정책이 달라진다 */
export type ErrKind =
  | "config"     // 사용자가 구글 설정을 고쳐야 함 (재시도해도 소용없음)
  | "quota"      // 오늘 한도 소진 (내일 재개)
  | "temporary"  // 일시적 (재시도하면 됨)
  | "fatal";     // 이 파일 자체의 문제

export class UploadError extends Error {
  constructor(message: string, public kind: ErrKind = "fatal", public helpUrl = "") {
    super(message);
    this.name = "UploadError";
  }
}

export interface VideoMeta {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  language: string;
  privacy: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
}

export interface UploadResult {
  id: string;
  snippet?: { title?: string };
  status?: { privacyStatus?: string };
}

export function buildBody(m: VideoMeta) {
  const snippet: Record<string, unknown> = {
    title: (m.title || "제목 없음").slice(0, 100),
    description: (m.description || "").slice(0, 5000),
    tags: m.tags.filter(Boolean).slice(0, 30),
    categoryId: String(m.categoryId || "22"),
  };
  if (m.language) {
    snippet.defaultLanguage = m.language;
    snippet.defaultAudioLanguage = m.language;
  }
  return {
    snippet,
    status: {
      privacyStatus: m.privacy || "private",
      selfDeclaredMadeForKids: !!m.madeForKids,
    },
  };
}

export async function uploadVideo(
  cfg: Config,
  path: string,
  meta: VideoMeta,
  onProgress: (sent: number, total: number) => void,
  cancelled: () => boolean = () => false,
): Promise<UploadResult> {
  const size = (await Deno.stat(path)).size;
  const token = await accessToken(cfg);

  // 1) 업로드 세션 열기
  const q = new URLSearchParams({ uploadType: "resumable", part: "snippet,status" });
  if (!meta.notifySubscribers) q.set("notifySubscribers", "false");

  const init = await fetch(`https://www.googleapis.com/upload/youtube/v3/videos?${q}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": "video/*",
    },
    body: JSON.stringify(buildBody(meta)),
  });
  if (!init.ok) throw await apiError(init);
  const session = init.headers.get("location");
  if (!session) throw new UploadError("업로드 세션 주소를 받지 못했습니다.", "temporary");

  // 2) 조각 단위로 전송 (실패하면 서버에 위치를 물어보고 이어서)
  const f = await Deno.open(path, { read: true });
  try {
    let offset = 0;
    let fails = 0;
    while (offset < size) {
      if (cancelled()) throw new UploadError("사용자가 취소했습니다.", "fatal");
      const len = Math.min(CHUNK, size - offset);
      const buf = new Uint8Array(len);
      await f.seek(offset, Deno.SeekMode.Start);
      let read = 0;
      while (read < len) {
        const n = await f.read(buf.subarray(read));
        if (n === null) break;
        read += n;
      }
      const end = offset + read - 1;

      let res: Response;
      try {
        res = await fetch(session, {
          method: "PUT",
          redirect: "manual",
          headers: { "Content-Range": `bytes ${offset}-${end}/${size}` },
          body: buf.subarray(0, read),
        });
      } catch (e) {
        fails++;
        if (fails > 5) throw new UploadError(`네트워크가 불안정합니다: ${e instanceof Error ? e.message : e}`, "temporary");
        const wait = 2 ** fails;
        await log(`   ⚠️  네트워크 오류, ${wait}초 후 재시도`);
        await sleep(wait * 1000);
        offset = await resumeOffset(session, size, offset);
        continue;
      }

      if (res.status === 200 || res.status === 201) {
        onProgress(size, size);
        return await res.json() as UploadResult;
      }
      if (res.status === 308) {
        await res.body?.cancel();
        const range = res.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : end + 1;
        fails = 0;
        onProgress(offset, size);
        continue;
      }
      if ([500, 502, 503, 504].includes(res.status)) {
        await res.body?.cancel();
        fails++;
        if (fails > 5) throw new UploadError(`유튜브 서버가 응답하지 않습니다 (${res.status})`, "temporary");
        const wait = 2 ** fails;
        await log(`   ⚠️  ${res.status} 오류, ${wait}초 후 재시도`);
        await sleep(wait * 1000);
        offset = await resumeOffset(session, size, offset);
        continue;
      }
      throw await apiError(res);
    }
    throw new UploadError("업로드가 끝났는데 응답이 없습니다.", "temporary");
  } finally {
    try { f.close(); } catch { /* 무시 */ }
  }
}

async function resumeOffset(session: string, size: number, fallback: number): Promise<number> {
  try {
    const r = await fetch(session, {
      method: "PUT",
      redirect: "manual",
      headers: { "Content-Range": `bytes */${size}` },
    });
    if (r.status === 308) {
      await r.body?.cancel();
      const range = r.headers.get("range");
      return range ? Number(range.split("-")[1]) + 1 : 0;
    }
    await r.body?.cancel();
    if (r.ok) return size;
  } catch { /* 무시 */ }
  return fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface VerifyResult {
  ok: boolean;        // 유튜브에서 실제로 확인됨
  status: string;     // uploaded · processed · failed · rejected · deleted
  message: string;
}

/**
 * 업로드한 영상이 정말 내 채널에 올라갔는지 유튜브에 다시 물어본다.
 * 파일을 지우기 전에 이 확인을 통과해야 한다. (1 unit)
 */
export async function verifyVideo(cfg: Config, videoId: string): Promise<VerifyResult> {
  const token = await accessToken(cfg);
  const url = "https://www.googleapis.com/youtube/v3/videos" +
    `?part=status,snippet&id=${encodeURIComponent(videoId)}`;

  // 반영에 몇 초 걸릴 수 있어 몇 번 다시 물어본다
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      const j = await r.json();
      if (r.ok) {
        const item = j.items?.[0];
        if (item) {
          const st: string = item.status?.uploadStatus ?? "";
          if (st === "failed" || st === "rejected" || st === "deleted") {
            const why = item.status?.failureReason ?? item.status?.rejectionReason ?? "";
            return { ok: false, status: st, message: `유튜브가 영상을 거부했습니다 (${st}${why ? ": " + why : ""})` };
          }
          return { ok: true, status: st || "uploaded", message: "유튜브에서 확인되었습니다" };
        }
      }
    } catch { /* 다음 시도 */ }
    if (i < 3) await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, status: "unknown", message: "유튜브에서 영상을 확인하지 못했습니다" };
}

/** 유튜브 오류를 한국어 안내 + 재시도 정책으로 바꾼다. */
async function apiError(res: Response): Promise<UploadError> {
  let txt = "";
  try { txt = await res.text(); } catch { /* 무시 */ }
  let reason = "", detail = "", status = "";
  try {
    const j = JSON.parse(txt);
    reason = j.error?.errors?.[0]?.reason ?? "";
    detail = j.error?.message ?? "";
    status = j.error?.status ?? "";
  } catch { detail = txt.slice(0, 200); }

  // ① API 자체가 꺼져 있는 경우 — 가장 흔한 최초 설정 실수
  if (status === "PERMISSION_DENIED" && /has not been used in project|is disabled/i.test(detail)) {
    const proj = detail.match(/project (\d+)/)?.[1] ?? "";
    const link = proj
      ? `https://console.cloud.google.com/apis/library/youtube.googleapis.com?project=${proj}`
      : "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
    return new UploadError(
      "구글 클라우드에서 'YouTube Data API v3' 가 아직 켜져 있지 않습니다. " +
      "아래 버튼으로 열어 '사용' 을 누른 뒤, 1~2분 기다렸다가 다시 시도하세요.",
      "config", link,
    );
  }

  if (res.status === 401 || reason === "authorizationRequired") {
    return new UploadError("로그인이 만료되었습니다. 설정 탭에서 다시 연결해 주세요.", "config");
  }

  const table: Record<string, [string, ErrKind, string]> = {
    quotaExceeded: ["오늘 쓸 수 있는 구글 API 사용량을 모두 썼습니다. 내일 자동으로 다시 시작합니다.", "quota", ""],
    rateLimitExceeded: ["요청이 너무 잦습니다. 잠시 후 자동으로 다시 시도합니다.", "temporary", ""],
    uploadLimitExceeded: ["이 채널의 하루 업로드 한도를 넘었습니다. 내일 다시 시도합니다.", "quota", ""],
    youtubeSignupRequired: ["이 구글 계정에 유튜브 채널이 없습니다. 유튜브에서 채널을 먼저 만들어 주세요.", "config", "https://www.youtube.com/create_channel"],
    accessNotConfigured: ["구글 클라우드에서 YouTube Data API v3 를 켜야 합니다.", "config", "https://console.cloud.google.com/apis/library/youtube.googleapis.com"],
    forbidden: ["권한이 없습니다. 연결한 구글 계정과 채널을 확인해 주세요.", "config", ""],
    invalidVideoMetadata: ["제목이나 설명이 유튜브 규칙에 맞지 않습니다. 특수문자를 줄여보세요.", "fatal", ""],
    invalidTitle: ["제목에 쓸 수 없는 문자가 있습니다. (< 나 > 기호는 쓸 수 없습니다)", "fatal", ""],
    invalidDescription: ["설명에 쓸 수 없는 문자가 있습니다.", "fatal", ""],
    mediaBodyRequired: ["영상 파일이 비어 있습니다.", "fatal", ""],
    invalidCategoryId: ["카테고리 설정이 올바르지 않습니다. 설정 탭에서 다시 골라주세요.", "config", ""],
    invalidFilename: ["파일 이름에 문제가 있습니다. 이름을 바꿔서 다시 넣어주세요.", "fatal", ""],
    failedPrecondition: ["업로드 조건이 맞지 않습니다. 채널 상태를 확인해 주세요.", "config", ""],
    backendError: ["유튜브 쪽 일시적인 오류입니다. 잠시 후 다시 시도합니다.", "temporary", ""],
  };
  const hit = table[reason];
  if (hit) return new UploadError(hit[0], hit[1], hit[2]);

  if (res.status >= 500) {
    return new UploadError(`유튜브 서버 오류 (${res.status}). 잠시 후 다시 시도합니다.`, "temporary");
  }
  if (res.status === 403) {
    return new UploadError(`권한 오류: ${detail || "확인이 필요합니다"}`, "config");
  }
  return new UploadError(`업로드 실패 (${res.status}) ${detail}`, "fatal");
}

// YouTube Data API v3 — resumable 업로드 (중단 지점 이어올리기 포함)
import { Channel, Config, log } from "./paths.ts";
import { accessToken } from "./auth.ts";
import { ErrKind, UploadError } from "./errors.ts";
export { UploadError };
export type { ErrKind };

const CHUNK = 8 * 1024 * 1024;               // 256KB 배수여야 함
export const UPLOAD_COST = 1600;             // 업로드 1건당 쿼터
export const THUMB_COST = 50;                // 배너(썸네일) 1건당 쿼터
export const LIST_COST = 1;                  // 목록으로 읽기 — 한 번에 50편까지 1점
export const WRITE_COST = 50;                // 댓글 달기·제목 고치기 각각 50점
export const DAILY_QUOTA = 10000;

export interface VideoMeta {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  language: string;
  privacy: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
  /** 예약 공개 시각 (RFC3339). 비공개로 올린 것만 예약된다. */
  publishAt?: string;
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
  const status: Record<string, unknown> = {
    privacyStatus: m.privacy || "private",
    selfDeclaredMadeForKids: !!m.madeForKids,
  };
  // ★예약은 **비공개일 때만** 걸린다. 공개로 올리면서 예약을 주면 유튜브가 통째로
  //   무시하고 바로 공개해 버린다 — 그러면 예약한 줄 알고 있다가 뒤늦게 안다.
  if (m.publishAt && status.privacyStatus === "private") {
    status.publishAt = m.publishAt;
  }
  return { snippet, status };
}

export async function uploadVideo(
  cfg: Config,
  ch: Channel,
  path: string,
  meta: VideoMeta,
  onProgress: (sent: number, total: number) => void,
  cancelled: () => boolean = () => false,
): Promise<UploadResult> {
  const size = (await Deno.stat(path)).size;
  const token = await accessToken(cfg, ch);

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
        const 이어 = await resumeOffset(session, size, offset);
        if (이어.끝났나) { onProgress(size, size); return 이어.결과; }
        offset = 이어.offset;
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
        const 이어 = await resumeOffset(session, size, offset);
        if (이어.끝났나) { onProgress(size, size); return 이어.결과; }
        offset = 이어.offset;
        continue;
      }
      throw await apiError(res);
    }
    // 보낼 것은 다 보냈는데 마무리 응답을 못 받은 자리다. **다시 올리기 전에** 묻는다 —
    // 이미 올라가 있으면 그 답을 그대로 쓴다. 그래도 모르면 '잠깐 오류' 로 두지 않는다.
    // 되풀이해 올리는 것보다, 사람이 유튜브를 한 번 보는 편이 낫다.
    const 마지막 = await resumeOffset(session, size, size);
    if (마지막.끝났나) { onProgress(size, size); return 마지막.결과; }
    throw new UploadError(
      "보낼 것은 다 보냈는데 유튜브가 마무리 응답을 주지 않았습니다 — " +
        "유튜브 스튜디오에서 올라갔는지 확인해 주세요(다시 올리면 두 번 올라갈 수 있습니다).",
      "fatal",
    );
  } finally {
    try { f.close(); } catch { /* 무시 */ }
  }
}

/** 어디까지 받았는지 물어본 결과. **이미 다 올라간 경우까지** 알려 준다. */
type 이어받기 = { 끝났나: false; offset: number } | { 끝났나: true; 결과: UploadResult };

/** 세션에 "어디까지 받았니" 하고 묻는다.
 *
 * ★여기서 **끝난 것을 못 알아보면 같은 영상이 두 번 올라간다.**
 *   마지막 조각을 보내다 회선이 끊겨도 유튜브는 그 조각을 다 받았을 수 있다.
 *   그때 이 물음에는 308 이 아니라 **200/201 과 영상 정보**가 온다.
 *   예전에는 그 몸을 버리고 `size` 만 돌려줬다 — 그러면 바깥 고리가
 *   「업로드가 끝났는데 응답이 없습니다」 를 '잠깐 오류' 로 던지고, 감시가
 *   그 편을 **처음부터 다시 올렸다.** 올라간 줄 모르니 중복 막기도 못 잡는다.
 */
async function resumeOffset(session: string, size: number, fallback: number): Promise<이어받기> {
  try {
    const r = await fetch(session, {
      method: "PUT",
      redirect: "manual",
      headers: { "Content-Range": `bytes */${size}` },
    });
    if (r.status === 308) {
      await r.body?.cancel();
      const range = r.headers.get("range");
      return { 끝났나: false, offset: range ? Number(range.split("-")[1]) + 1 : 0 };
    }
    if (r.ok) {
      const j = await r.json() as UploadResult;
      if (j?.id) return { 끝났나: true, 결과: j };       // 이미 다 올라갔다
      return { 끝났나: false, offset: size };
    }
    await r.body?.cancel();
  } catch { /* 무시 */ }
  return { 끝났나: false, offset: fallback };
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
/** 배너(썸네일)를 얹는다. 쪽지에 그림이 적혀 있을 때만 부른다.
 *
 * ★올리기가 끝난 **뒤에** 따로 부른다. 유튜브가 영상과 썸네일을 한 번에 안 받는다.
 * ★여기서 실패해도 영상은 이미 올라가 있다 — 그래서 던지지 않고 알려만 준다.
 */
export async function setThumbnail(
  cfg: Config,
  ch: Channel,
  videoId: string,
  path: string,
): Promise<{ ok: boolean; message: string }> {
  let 그림: Uint8Array<ArrayBuffer>;
  try {
    그림 = await Deno.readFile(path);
  } catch (e) {
    return { ok: false, message: `배너 그림을 못 읽었습니다 (${e instanceof Error ? e.message : e})` };
  }
  if (그림.byteLength > 2 * 1024 * 1024) {
    return { ok: false, message: `배너가 2MB를 넘습니다 (${(그림.byteLength / 1048576).toFixed(1)}MB)` };
  }
  const 확장 = path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  try {
    const token = await accessToken(cfg, ch);
    const r = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": 확장 },
        body: new Blob([그림], { type: 확장 }),
      },
    );
    if (!r.ok) {
      const 몸 = await r.text();
      // 채널이 인증 안 되어 있으면 사용자 썸네일 자체가 막힌다 — 흔한 일이라 따로 알린다
      const 막힘 = 몸.includes("forbidden") || r.status === 403;
      return {
        ok: false,
        message: 막힘
          ? "채널이 아직 전화 인증을 안 해서 배너를 못 올립니다 (유튜브 스튜디오에서 인증)"
          : `배너 실패 (${r.status})`,
      };
    }
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: `배너 실패 (${e instanceof Error ? e.message : e})` };
  }
}

export async function verifyVideo(cfg: Config, ch: Channel, videoId: string): Promise<VerifyResult> {
  const token = await accessToken(cfg, ch);
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

/* ============================================================ 성적 읽기 */

export interface StatItem {
  id: string;
  views: number;
  likes: number;
  comments: number;
  title: string;
  privacy: string;
}

/**
 * 올린 영상들의 조회수·좋아요·댓글을 한꺼번에 물어본다.
 *
 * ★한 번에 **50편까지** 물을 수 있고 그래도 **1점**이다(업로드 한 편이 1600점인
 *   것에 견주면 거저다). 그래서 50편씩 끊어 부른다.
 * ★`youtube.readonly` 권한으로 된다 — 이미 받아 둔 것이라 다시 로그인할 일이 없다.
 * ★돌려주지 않은 id 는 **사라진 영상**이다(지웠거나 유튜브가 내렸다). 부른 쪽에서
 *   가려낼 수 있게 `missing` 으로 따로 알린다.
 */
export async function fetchStats(
  cfg: Config,
  ch: Channel,
  ids: string[],
): Promise<{ items: StatItem[]; missing: string[]; calls: number }> {
  const items: StatItem[] = [];
  const found = new Set<string>();
  let calls = 0;
  if (!ids.length) return { items, missing: [], calls };

  const token = await accessToken(cfg, ch);
  for (let i = 0; i < ids.length; i += 50) {
    const 묶음 = ids.slice(i, i + 50);
    const url = "https://www.googleapis.com/youtube/v3/videos" +
      `?part=statistics,snippet,status&id=${묶음.map(encodeURIComponent).join(",")}`;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    calls++;
    if (!r.ok) throw await apiError(r);
    const j = await r.json();
    for (const it of j.items ?? []) {
      found.add(it.id);
      items.push({
        id: it.id,
        views: Number(it.statistics?.viewCount ?? 0),
        likes: Number(it.statistics?.likeCount ?? 0),
        comments: Number(it.statistics?.commentCount ?? 0),
        title: it.snippet?.title ?? "",
        privacy: it.status?.privacyStatus ?? "",
      });
    }
  }
  return { items, missing: ids.filter((id) => !found.has(id)), calls };
}

/* ============================================================ 뒷일 (force-ssl) */

/**
 * 영상에 댓글을 단다 — 올린 직후의 '첫 댓글'.
 *
 * ★유튜브 API 에는 **댓글을 고정하는 길이 없다.** 다는 것까지가 끝이고, 고정은
 *   스튜디오에서 손으로 눌러야 한다. 없는 기능을 있는 척하지 않는다.
 * ★`youtube.force-ssl` 권한이 있어야 한다. 없으면 403 이 온다.
 * ★던지지 않는다 — 영상은 이미 올라가 있다. 안 되면 까닭만 돌려준다.
 */
export async function insertComment(
  cfg: Config,
  ch: Channel,
  videoId: string,
  text: string,
): Promise<{ ok: boolean; message: string }> {
  const 글 = text.trim().slice(0, 9000);
  if (!글) return { ok: false, message: "댓글에 적을 글이 비어 있습니다" };
  try {
    const token = await accessToken(cfg, ch);
    const r = await fetch(
      "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          snippet: { videoId, topLevelComment: { snippet: { textOriginal: 글 } } },
        }),
      },
    );
    if (!r.ok) return { ok: false, message: await 권한말(r, "댓글") };
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: `댓글 실패 (${e instanceof Error ? e.message : e})` };
  }
}

/**
 * 이미 올린 영상의 제목을 갈아끼운다.
 *
 * ★`videos.update` 는 **보낸 것으로 통째로 덮는다.** 제목만 보내면 설명·태그가
 *   지워진다. 그래서 지금 것을 먼저 읽어 와서 제목만 바꿔 되돌려 준다.
 * ★categoryId 는 안 보내면 거부당한다 — 읽어 온 것을 그대로 실어 보낸다.
 */
export async function updateVideoTitle(
  cfg: Config,
  ch: Channel,
  videoId: string,
  title: string,
): Promise<{ ok: boolean; message: string; before: string }> {
  const 새제목 = title.trim().slice(0, 100);
  if (!새제목) return { ok: false, message: "바꿀 제목이 비어 있습니다", before: "" };
  try {
    const token = await accessToken(cfg, ch);
    const g = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
      { headers: { Authorization: "Bearer " + token } },
    );
    if (!g.ok) return { ok: false, message: await 권한말(g, "제목 바꾸기"), before: "" };
    const 지금 = (await g.json()).items?.[0];
    if (!지금) return { ok: false, message: "그 영상을 찾지 못했습니다", before: "" };
    const sn = 지금.snippet ?? {};
    const before: string = sn.title ?? "";
    if (before === 새제목) return { ok: true, message: "이미 그 제목입니다", before };

    const r = await fetch("https://www.googleapis.com/youtube/v3/videos?part=snippet", {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=UTF-8",
      },
      // ★읽어 온 snippet 을 통째로 되돌려 주면서 제목만 바꾼다.
      body: JSON.stringify({ id: videoId, snippet: { ...sn, title: 새제목 } }),
    });
    if (!r.ok) return { ok: false, message: await 권한말(r, "제목 바꾸기"), before };
    return { ok: true, message: "", before };
  } catch (e) {
    return { ok: false, message: `제목 바꾸기 실패 (${e instanceof Error ? e.message : e})`, before: "" };
  }
}

/** 403 이면 십중팔구 권한을 안 받은 것이다 — 그렇게 말해 준다. */
async function 권한말(r: Response, 무엇: string): Promise<string> {
  let txt = "";
  try { txt = await r.text(); } catch { /* 무시 */ }
  if (r.status === 403 || /insufficient|forbidden|scope/i.test(txt)) {
    return `${무엇} 권한이 없습니다 — 채널 탭에서 그 채널을 **다시 연결**해야 합니다`;
  }
  let detail = "";
  try { detail = JSON.parse(txt).error?.message ?? ""; } catch { detail = txt.slice(0, 120); }
  return `${무엇} 실패 (${r.status}) ${detail}`.trim();
}

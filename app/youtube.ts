// YouTube Data API v3 · Analytics API 를 부르는 얇은 도구들.
//
// 모든 호출은 google.ts 의 call() 을 지나 자동으로 센다. 여기서는 주소와 부품(part)만 안다.
// 한 번에 50개까지 묶어 물어도 호출 1번(1유닛)이다 — 그래서 50개씩 끊어 부른다.
import { call, doFetch, GoogleError, toGoogleError, ANALYTICS, WWW, YT } from "./google.ts";
import type { Yt } from "./ytcore.ts";
import * as quota from "./quota.ts";
import { log } from "./paths.ts";

type Obj = Record<string, any>;

/** 이 채널의 정보 한 건 (channels.list mine=true) */
export async function channelMine(yt: Yt, part = "snippet"): Promise<Obj | null> {
  const r = await yt.get("/youtube/v3/channels", { part, mine: true });
  return r.items?.[0] ?? null;
}

/** 채널 id 여러 개의 총계 (한 번에 50개) */
export async function channelsById(yt: Yt, ids: string[], part = "statistics"): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt.get("/youtube/v3/channels", { part, id: ids.slice(i, i + 50).join(",") });
    out.push(...(r.items ?? []));
  }
  return out;
}

/** 영상 id 여러 개 (videos.list — 50개씩 묶어 1유닛) */
export async function videosList(yt: Yt, ids: string[], part: string): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt.get("/youtube/v3/videos", { part, id: ids.slice(i, i + 50).join(",") });
    out.push(...(r.items ?? []));
  }
  return out;
}

/**
 * 영상 통계를 별도 통(Video Batch Get Stats)에서 한 방에. 공개 영상만 주고 비공개는 빠진다.
 * 메인 지갑(Queries per day)을 안 건드린다.
 */
export async function batchGetStats(yt: Yt, ids: string[], part = "statistics,snippet"): Promise<Obj[]> {
  const out: Obj[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt.get("/youtube/v3/videos:batchGetStats",
      { part, id: ids.slice(i, i + 50).join(",") }, { base: YT });
    out.push(...(r.items ?? []));
  }
  return out;
}

/** 업로드 재생목록 id — 채널 ID(UCxxxx)의 앞 두 글자만 UU 로 바꾸면 된다(0유닛). */
export function uploadsPlaylistId(channelId: string): string {
  return channelId.startsWith("UC") && channelId.length > 10 ? "UU" + channelId.slice(2) : "";
}

export async function playlistItems(
  yt: Yt, playlistId: string, o: { part?: string; maxResults?: number; pageToken?: string } = {},
): Promise<Obj> {
  return await yt.get("/youtube/v3/playlistItems", {
    part: o.part ?? "snippet,contentDetails", playlistId, maxResults: o.maxResults ?? 50, pageToken: o.pageToken,
  });
}

/** 썸네일 올리기 (youtube.upload 권한이면 된다 · 2MB 이하 · 50유닛) */
export async function thumbnailsSet(yt: Yt, videoId: string, bytes: Uint8Array, mime: string): Promise<Obj> {
  return await call(await yt.bearer(), "POST", "/upload/youtube/v3/thumbnails/set", {
    query: { videoId }, body: bytes, headers: { "Content-Type": mime },
  });
}

/** YouTube Analytics (스튜디오와 같은 창구 · 별도 통) */
export async function analyticsQuery(yt: Yt, q: Record<string, string | number>): Promise<Obj> {
  return await yt.get("/v2/reports", q as Record<string, string>, { base: ANALYTICS });
}

/* ============================================================ 이어올리기 (resumable) */

const CHUNK = 8 * 1024 * 1024; // 256KB 배수여야 함
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UploadHandle { aborted: boolean }

/** 서버가 어디까지 받았는지 묻는다. 이미 다 올라간 경우까지 알려 준다. */
type Resume = { done: false; offset: number } | { done: true; result: Obj };

async function resumeOffset(session: string, size: number, fallback: number): Promise<Resume> {
  try {
    const r = await doFetch(session, { method: "PUT", redirect: "manual", headers: { "Content-Range": `bytes */${size}` } });
    if (r.status === 308) {
      await r.body?.cancel();
      const range = r.headers.get("range");
      return { done: false, offset: range ? Number(range.split("-")[1]) + 1 : 0 };
    }
    if (r.ok) {
      // 마지막 조각을 보내다 회선이 끊겨도 유튜브는 그 조각을 다 받았을 수 있다. 그때는 영상 정보가 온다.
      const j = await r.json() as Obj;
      if (j?.id) return { done: true, result: j };
      return { done: false, offset: size };
    }
    await r.body?.cancel();
  } catch { /* 무시 */ }
  return { done: false, offset: fallback };
}

export interface InsertOpts {
  notifySubscribers?: boolean;
  onProgress?: (sent: number, total: number) => void;
  handle?: UploadHandle;
  /** 이어올리기 재시도 대기 배율(시험은 0) */
  waitScale?: number;
}

/**
 * 영상을 올린다 (videos.insert · resumable). 끊기면 서버에 위치를 물어 이어 올린다.
 * 보낼 것은 다 보냈는데 마무리 응답이 없으면 **다시 올리지 않고** 먼저 묻는다 — 이미 올라가 있으면 그 답을 쓴다.
 * 그래도 모르면 오류로 둔다(되풀이해 올리는 것보다 사람이 유튜브를 한 번 보는 편이 낫다).
 * 계량은 다 끝났을 때 한 번만 센다(조각마다 세면 안 된다).
 */
export async function insertVideo(
  yt: Yt, filePath: string, body: Obj, o: InsertOpts = {},
): Promise<Obj> {
  const size = (await Deno.stat(filePath)).size;
  const bearer = await yt.bearer();
  const q = new URLSearchParams({ uploadType: "resumable", part: "snippet,status" });
  if (o.notifySubscribers === false) q.set("notifySubscribers", "false");
  const init = await doFetch(`${WWW}/upload/youtube/v3/videos?${q}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + bearer.token,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": "video/*",
    },
    body: JSON.stringify(body),
  });
  if (!init.ok) throw await toGoogleError(init);
  const session = init.headers.get("location");
  if (!session) throw new GoogleError("업로드 세션 주소를 받지 못했습니다.", 0, "temporary");
  await init.body?.cancel();

  const scale = o.waitScale ?? 1;
  const f = await Deno.open(filePath, { read: true });
  const 끝냄 = async (j: Obj): Promise<Obj> => {
    o.onProgress?.(size, size);
    await quota.spend("videos.insert", bearer.project);
    return j;
  };
  try {
    let offset = 0;
    let fails = 0;
    while (offset < size) {
      if (o.handle?.aborted) throw new GoogleError("사용자가 중단했습니다.", 0, "aborted");
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
        res = await doFetch(session, {
          method: "PUT", redirect: "manual",
          headers: { "Content-Range": `bytes ${offset}-${end}/${size}` },
          body: buf.subarray(0, read),
        });
      } catch (e) {
        fails++;
        if (fails > 5) throw new GoogleError(`네트워크가 불안정합니다: ${e instanceof Error ? e.message : e}`, 0, "temporary");
        const wait = 2 ** fails;
        await log(`   ⚠️  연결 끊김, ${wait}초 후 이어올리기 ${fails}/6`);
        await sleep(wait * 1000 * scale);
        const 이어 = await resumeOffset(session, size, offset);
        if (이어.done) return await 끝냄(이어.result);
        offset = 이어.offset;
        continue;
      }
      if (res.status === 200 || res.status === 201) return await 끝냄(await res.json() as Obj);
      if (res.status === 308) {
        await res.body?.cancel();
        const range = res.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : end + 1;
        fails = 0;
        o.onProgress?.(offset, size);
        continue;
      }
      if ([500, 502, 503, 504].includes(res.status)) {
        await res.body?.cancel();
        fails++;
        if (fails > 5) throw new GoogleError(`유튜브 서버가 응답하지 않습니다 (${res.status})`, res.status, "temporary");
        const wait = 2 ** fails;
        await log(`   ⚠️  ${res.status} 오류, ${wait}초 후 이어올리기 ${fails}/6`);
        await sleep(wait * 1000 * scale);
        const 이어 = await resumeOffset(session, size, offset);
        if (이어.done) return await 끝냄(이어.result);
        offset = 이어.offset;
        continue;
      }
      throw await toGoogleError(res);
    }
    const 마지막 = await resumeOffset(session, size, size);
    if (마지막.done) return await 끝냄(마지막.result);
    throw new GoogleError(
      "보낼 것은 다 보냈는데 유튜브가 마무리 응답을 주지 않았습니다 — 유튜브 스튜디오에서 올라갔는지 확인해 주세요" +
        "(다시 올리면 두 번 올라갈 수 있습니다).", 0, "no-final",
    );
  } finally {
    try { f.close(); } catch { /* 무시 */ }
  }
}

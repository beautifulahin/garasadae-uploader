// 쇼츠/롱폼 판정 — 올리기 전에 파일을 직접 재서 종류를 가른다. (파이썬 shorts.py)
//
// 유튜브는 **길이와 화면비만 보고 자동으로** 쇼츠를 판정한다. 조건을 벗어나면 일반 영상(롱폼)으로 올라가고,
// 올린 뒤에는 바꿀 수 없다. 업로더는 파일마다 종류를 구분하고, 정상적인 롱폼도 같은 승인 경로로 받는다.
//
// 판정 기준 (2026-08 확인 · https://support.google.com/youtube/answer/15424877)
//   길이   3분(180초) 이하    — 2024년 10월에 60초에서 늘어났다
//   화면비 정사각형 또는 세로  — 유튜브 공식 신규 업로드 기준
//   해상도 1080p 이하 권장
//   #Shorts 해시태그는 필요 없다
//
// 재는 법: ffprobe 가 있으면 파이썬과 똑같이 ffprobe, 없으면 mediaprobe.ts 가 파일 머리를 직접 읽는다.
// 읽기 실패·길이/해상도 누락·비정상 값은 종류를 꾸며내지 않고 오류로 둔다(롱폼으로 치지 않는다).
import { dataPath, readJsonSync, writeJson } from "./paths.ts";
import { findTool } from "./tools.ts";
import { probeNative } from "./mediaprobe.ts";
import type { RawMedia } from "./mediaprobe.ts";

export const MAX_SEC = 180;
export const MAX_HEIGHT = 1920;
export const CACHE_VERSION = 2;

export type Kind = "쇼츠" | "롱폼";

export interface MediaInfo {
  w: number; h: number; display_w: number; display_h: number; codec: string; sec: number; mb: number;
}
type Obj = Record<string, any>;

/* ─────────── 조사 결과 보관 ───────────
   ffprobe 는 파일 하나에 20ms 쯤 걸린다. 영상은 한 번 만들어지면 바뀌지 않으므로,
   크기와 수정시각이 그대로면 지난번에 알아낸 값을 그대로 쓴다. (영상정보.json) */
const 캐시파일 = () => dataPath("영상정보.json");
let 캐시: Record<string, Obj> | null = null;
let 더러움 = false;

function 캐시읽기(): Record<string, Obj> {
  if (!캐시) 캐시 = readJsonSync<Record<string, Obj>>(캐시파일(), {});
  return 캐시;
}

/** 알아낸 값을 남긴다. 다음에 화면을 열 때 훨씬 빨라진다. */
export async function saveCache(): Promise<void> {
  if (!더러움 || !캐시) return;
  try {
    await writeJson(캐시파일(), 캐시, { indent: 0 });
    더러움 = false;
  } catch { /* 못 남겨도 그만이다 */ }
}
/** 시험: 캐시를 비운다 */
export function resetCache() { 캐시 = null; 더러움 = false; }

async function stampOf(path: string): Promise<string | null> {
  try {
    const st = await Deno.stat(path);
    return `${st.size}:${Math.trunc((st.mtime?.getTime() ?? 0) / 1000)}`;
  } catch { return null; }
}

/** 실측값으로 신규 업로드의 종류를 판정한다. 잘못된 값은 오류다. */
export function classify(info: Obj): Kind {
  const 없음 = () => new Error("영상 길이·해상도를 확인할 수 없습니다");
  const num = (v: unknown): number => {
    if (v === undefined || v === null) throw 없음();
    return Number(v);
  };
  const sec = num(info.sec), w = num(info.w), h = num(info.h);
  const dw = "display_w" in info ? num(info.display_w) : w;
  const dh = "display_h" in info ? num(info.display_h) : h;
  if ([sec, w, h, dw, dh].some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error("영상 길이·해상도가 올바르지 않습니다");
  }
  return sec <= MAX_SEC && dw <= dh ? "쇼츠" : "롱폼";
}

/** 날 값(ffprobe 또는 직접 읽기)에서 파이썬과 같은 식으로 표시 크기를 계산한다 */
export function infoFromRaw(raw: RawMedia): MediaInfo {
  let { w, h } = raw;
  const [a, b] = raw.sar;
  let displayW = a > 0 && b > 0 ? (w * a) / b : w;
  let displayH: number;
  // 파이썬: round(float(rotation)) % 180 == 90  (음수도 양수 나머지로)
  const rot = ((Math.round(raw.rotation) % 180) + 180) % 180;
  if (rot === 90) {
    [displayW, displayH] = [h, displayW];
    [w, h] = [h, w];
  } else {
    displayH = h;
  }
  const info: MediaInfo = { w, h, display_w: displayW, display_h: displayH, codec: raw.codec || "?", sec: raw.sec, mb: raw.bytes / 1048576 };
  classify(info); // 읽혔더라도 길이·해상도가 없는 파일은 통과시키지 않는다.
  return info;
}

async function probeFfprobe(ffprobe: string, path: string): Promise<RawMedia> {
  const out = await new Deno.Command(ffprobe, {
    args: ["-v", "error", "-print_format", "json", "-show_entries",
      "stream=codec_type,codec_name,width,height,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=duration,size",
      path],
    stdout: "piped", stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(`파일을 읽지 못했습니다: ${new TextDecoder().decode(out.stderr).trim().slice(0, 120)}`);
  }
  const data = JSON.parse(new TextDecoder().decode(out.stdout));
  const vs = (data.streams ?? []).find((s: Obj) => s.codec_type === "video");
  if (!vs) throw new Error("영상 트랙이 없습니다");
  const sarText = String(vs.sample_aspect_ratio || "1:1");
  const [sa, sb] = sarText.split(":").map(Number);
  const sar: [number, number] = Number.isFinite(sa) && Number.isFinite(sb) ? [sa, sb] : [1, 1];
  const side = (vs.side_data_list ?? []).find((s: Obj) => "rotation" in s);
  const rotation = Number(side ? side.rotation : (vs.tags?.rotate ?? 0)) || 0;
  return {
    w: Number(vs.width), h: Number(vs.height), sar, rotation, codec: vs.codec_name ?? "?",
    sec: Number(data.format?.duration), bytes: Number(data.format?.size),
  };
}

/** 지금 파일을 잰다 (캐시 없이) */
export async function probeNow(path: string): Promise<MediaInfo> {
  const ffprobe = await findTool("ffprobe");
  const raw = ffprobe ? await probeFfprobe(ffprobe, path) : await probeNative(path);
  return infoFromRaw(raw);
}

/** 파일을 잰다. 크기·수정시각이 그대로면 지난번 값을 쓴다. */
export async function probe(path: string): Promise<MediaInfo> {
  const stamp = await stampOf(path);
  if (stamp) {
    const got = 캐시읽기()[path];
    if (got && got._s === stamp && got._v === CACHE_VERSION) {
      const { _s, _v, ...info } = got;
      return info as MediaInfo;
    }
  }
  const info = await probeNow(path);
  if (stamp) {
    캐시읽기()[path] = { ...info, _s: stamp, _v: CACHE_VERSION };
    더러움 = true;
  }
  return info;
}

/** 일감에 실제 파일로 잰 종류 표시만 채운다. 승인·시각은 보존한다. (원본 객체는 건드리지 않는다) */
export async function normalizeJob<T extends Obj>(job: T, info?: MediaInfo): Promise<T & { 영상종류: Kind; 롱폼: boolean; allow_not_short: boolean }> {
  const i = info ?? await probe(String(job.file));
  const kind = classify(i);
  return { ...job, 영상종류: kind, 롱폼: kind === "롱폼", allow_not_short: kind === "롱폼" };
}

export interface ShortsCheck { ok: boolean; notes: string[]; info: MediaInfo; kind: Kind }

/** (쇼츠로 인정될까, 사유 목록, 실측값) */
export async function check(path: string): Promise<ShortsCheck> {
  const info = await probe(path);
  const kind = classify(info);
  const bad: string[] = [];
  if (info.sec > MAX_SEC) bad.push(`길이 ${info.sec.toFixed(1)}초 — 180초를 넘습니다`);
  if ((info.display_w ?? info.w) > (info.display_h ?? info.h)) bad.push(`가로 ${info.w}x${info.h} — 롱폼입니다`);
  const warn: string[] = [];
  if (info.h > MAX_HEIGHT) warn.push(`세로 ${info.h}px — 1080p(1920) 초과, 다운스케일됩니다`);
  return { ok: kind === "쇼츠", notes: [...bad, ...warn], info, kind };
}

/** 원장 한 줄(길이초·해상도·업로드시각)이 롱폼인가 — 공개 간격·하루 한도·회수가 같은 잣대로 쓴다.
 *  2024-10-15 이전에 올린 정사각형 영상의 과거 분류는 보존한다. (파이썬 safety._롱폼줄) */
export function ledgerRowIsLong(r: Record<string, string | undefined>): boolean {
  let w = 0, h = 0;
  const m = /^(\d+)x(\d+)$/.exec((r["해상도"] ?? "0x0").trim());
  if (m) { w = +m[1]; h = +m[2]; }
  const sec = parseFloat(r["길이초"] ?? "") || 0;
  const uploaded = String(r["업로드시각"] ?? "").slice(0, 10);
  if (uploaded && uploaded < "2024-10-15") return sec > 180 || !!(w && h && w >= h);
  if (sec > 0 && w > 0 && h > 0) return classify({ sec, w, h }) === "롱폼";
  return sec > 180 || !!(w && h && w > h);
}

/** 지금 어느 판독기를 쓰나 (점검 화면용) */
export async function probeKind(): Promise<string> {
  return (await findTool("ffprobe")) ? "ffprobe" : "내장 판독기";
}

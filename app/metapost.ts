// 인스타그램 릴스·스레드 자동 올리기 — 유튜브 영상이 공개되는 때에 맞춰 같은 쇼츠를 올린다.
//
// 흐름
//   upload.ts   → enqueue()   : 유튜브에 비공개로 올린 직후, 이 영상을 올릴지 정하고(채널 설정·영상 쪽지) 글·규격을 미리 따져 장부에 적는다. 영상은 메타대기/ 에 한 벌 둔다.
//   review.ts   → markPublic(): 심사를 통과해 공개가 되면(예약이면 열릴 시각이 되면) 올려도 되는 때로 바꾼다. markDropped() 는 공개가 안 되는 영상을 접는다.
//   tick.ts     → run()       : 올려도 되는 것을 실제로 올린다(마지막 단계 — 유튜브 일을 늦추지 않는다).
//
// 지키는 약속
//   · 유튜브 일에 영향이 없다: 위의 부르는 자리는 모두 실패해도 던지지 않는다(부르는 쪽이 한 번 더 감싼다). 결과는 장부(메타올리기.json)에만 적힌다.
//   · 두 번 올리지 않는다: 「올려 줘」 요청을 보내기 **전에** 장부에 `게시요청중` 을 적는다. 응답을 못 받고 끊겼으면 다음에 보더라도 다시 보내지 않고 `결과불명` 으로 두고,
//     계정의 최근 게시물을 읽어(보기만 한다) 올라갔는지 확인한다. 사람이 확인해 「안 올라갔다」고 해야만 다시 올린다.
//     (컨테이너 만들기·상태 보기는 되풀이해도 해가 없다 — 되풀이를 막는 것은 「게시」 한 단계뿐이다.)
//   · 쇼츠(세로·180초 이하)만 올린다. 롱폼·가로는 까닭을 적고 건너뛴다. 릴스·스레드 영상 규격에 안 맞으면 올리지 않고 까닭을 적는다.
//     단, 다시 인코딩하면 풀리는 문제(크기·가로폭·비트레이트·음성/영상 코덱·프레임 수)뿐이면 건너뛰지 않고 릴스·스레드용 사본으로 줄여서 올린다(ffmpeg 필요).
//     줄이기는 오래 걸려서 enqueue 가 아니라 run(tick ⑨)에서 한 번에 한 건씩 한다. 원본은 건드리지 않고, 메타대기/ 의 사본만 만든다.
//   · 모든 호출은 google.ts 의 doFetch 한 문을 지난다. 토큰은 meta.ts 가 준다(만료 전 갱신 포함) — 이 파일은 토큰 값을 기록·화면에 싣지 않는다.
//   · 메타는 공개 주소의 영상만 가져간다(릴스 올리기는 내려받을 주소가 필요하다). 중계 서버의 임시 보관(R2)에 올려 일회용 주소를 받고, 끝나면 바로 지운다.
//     스레드는 방금 올린 인스타 영상의 media_url 을 먼저 쓰고, 안 되면 같은 임시 보관을 쓴다.
import { cut, dataPath, existsSync, extOf, IS_MAC, join, readJsonSync, recordLine, withFileLock, writeJson } from "./paths.ts";
import { doFetch } from "./google.ts";
import { embeddedMeta } from "./embedded.ts";
import { confFor } from "./channels.ts";
import { findTool } from "./tools.ts";
import { type MediaInfo, probeNow } from "./shorts.ts";
import {
  bindingOf, explainMeta, freshToken, loadStore, MetaApiError, MetaAuthError, PROV, PROVIDERS, toMetaError, 이름, type Provider,
} from "./meta.ts";

type Obj = Record<string, any>;

/* ============================================================ 장부 모양 */

/** 대기 = 아직 시작 전 · 올리는중 = 영상 보내기~처리 기다리기(되풀이해도 해 없음) · 게시요청중 = 「게시」를 보냈고 답을 못 받음(★되풀이 금지)
 *  올림 · 실패(사람이 다시 시도 누를 수 있음) · 결과불명(올라갔는지 모름 — 확인 필요) · 건너뜀(올리지 않기로 함) · 취소 */
export type TState = "대기" | "올리는중" | "게시요청중" | "올림" | "실패" | "결과불명" | "건너뜀" | "취소";

export interface Target {
  account: string;
  username: string;
  state: TState;
  why?: string;
  tries: number;
  at: string;
  /** 다음에 다시 볼 시각 (일시 오류·한도 때) */
  next_at?: string;
  container?: string;
  /** 스레드가 영상을 가져간 길: instagram_media_url(방금 올린 인스타 영상) · staging(중계 서버 임시 보관) */
  route?: "instagram_media_url" | "staging";
  routes_failed?: string[];
  requested_at?: string;
  media_id?: string;
  url?: string;
  /** 결과불명 확인을 읽어 본 횟수 · 마지막 시각 */
  checks?: number;
  checked_at?: string;
}

export interface Staged {
  id: string;
  get_url: string;
  get_expires_at: string;
  delete_sig: string;
  uploaded_at: string;
  bytes: number;
  deleted?: boolean;
  /** 지우기를 보냈는데 지워졌다는 답을 받지 못했다 — 까닭 · 시도 횟수(run 이 몇 번 더 해 본다. 어차피 중계가 1시간 뒤 지운다) */
  delete_why?: string;
  delete_tries?: number;
  /** 마지막으로 지워 본 때 — 다시 해 보기는 이로부터 10분 뒤에 */
  delete_at?: string;
}

/**
 * 릴스·스레드 규격에 맞게 다시 인코딩해야 하는 일감의 표시.
 * 대기 = 아직 안 줄임 · 줄이는중 = ffmpeg 가 도는 중(앱이 꺼졌다 켜지면 이 상태는 믿지 않고 처음부터 다시) · 끝 = 사본을 만들어 확인했거나 더는 안 함 · 실패 = ffmpeg 가 실패(사람이 「다시 시도」)
 */
export interface Shrink {
  state: "대기" | "줄이는중" | "끝" | "실패";
  /** 줄일 원본의 사본(하드링크, 안 되면 복사) — 줄이기가 끝나면 지운다. 원본 파일은 건드리지 않는다 */
  src: string;
  /** 줄여야 하는 계정(영상 규격이 맞지 않는 쪽) */
  needs: Provider[];
  /** 줄여야 하는 까닭(규격 문제들) */
  why: string;
  tries: number;
  started_at?: string;
}

export interface MetaJob {
  /** 유튜브 영상 번호 — 한 영상에 일감은 하나뿐이다 */
  id: string;
  channel: string;
  title: string;
  made: string;
  kind: string;
  /** 영상대기 = 유튜브 공개를 기다림 · 진행 = 올려도 됨 · 끝 = 더 할 일 없음 */
  phase: "영상대기" | "진행" | "끝";
  /** 이 시각 뒤에 올린다 (공개가 확인된 때, 예약이면 열리는 시각 뒤) */
  go_after?: string;
  public_at?: string;
  done_at?: string;
  yt_url: string;
  /** 메타대기/ 에 둔 영상 (줄이기가 끝나기 전에는 비어 있다) */
  file: string;
  /** 다시 인코딩이 필요한 일감만 있다 */
  shrink?: Shrink;
  info?: { w: number; h: number; sec: number; mb: number; codec: string };
  text: { caption: string; threads: string; topic: string };
  targets: Partial<Record<Provider, Target>>;
  staged?: Staged;
}
export interface Ledger { jobs: Record<string, MetaJob> }

const ledgerFile = () => dataPath("메타올리기.json");
const waitDir = () => dataPath("메타대기");
const KEEP_FILE_DAYS = 7;
const KEEP_RECORD_DAYS = 60;
const MAX_RECORDS = 300;

export function loadJobs(): Ledger {
  const d = readJsonSync<Ledger>(ledgerFile(), { jobs: {} });
  return d && typeof d === "object" && d.jobs && typeof d.jobs === "object" ? d : { jobs: {} };
}

/** 장부를 잠그고 고친다 (화면 서버·예약 작업이 겹쳐 쓰지 않게) */
async function updateJobs<T>(고치기: (l: Ledger) => T | Promise<T>): Promise<T> {
  const r = await withFileLock(dataPath(".메타올리기.lock"), async () => {
    const l = loadJobs();
    const out = await 고치기(l);
    await writeJson(ledgerFile(), l, { indent: 2 });
    return out;
  });
  return r as T;
}

const iso = (d: Date) => d.toISOString();
const 분 = 60_000;
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);

/* ============================================================ 글 만들기 */

const 해시꼴 = /#[\p{L}\p{N}_]+/gu;
const 태그다듬 = (t: string) => t.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
/** 유튜브 전용 꼬리표는 인스타·스레드에서 뜻이 없다 */
const 뺄태그 = new Set(["shorts", "short", "youtubeshorts", "쇼츠"]);
/** 글자 수(UTF-16 단위 — 인스타가 세는 것보다 같거나 크게 잡는다) */
const 길이 = (s: string) => s.length;
/** 길이 단위로 자른다 — 한 글자(이모지 포함)를 반으로 가르지 않는다 */
function 자르기(s: string, max: number): string {
  let n = 0, out = "";
  for (const ch of s) { if (n + ch.length > max) break; n += ch.length; out += ch; }
  return out;
}

/** 줄이 해시태그뿐인가 */
const 태그줄 = (l: string) => { const t = l.trim(); return !!t && t.replace(해시꼴, "").trim() === ""; };

export const IG_CAPTION_MAX = 2200;
export const IG_TAG_MAX = 30;
export const TH_TEXT_MAX = 500;

/** 모은 해시태그 — 설명 끝줄의 태그 + 따로 받은 태그, 같은 것·유튜브 전용 제외 */
function collectTags(descTail: string[], tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...descTail, ...tags]) {
    const t = 태그다듬(String(raw));
    if (!t || 뺄태그.has(t.toLowerCase()) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** 설명 → (본문, 끝줄에서 떼어 낸 해시태그들). 본문 안에 낀 해시태그는 그대로 둔다. */
function splitDesc(desc: string): { body: string; tail: string[] } {
  const lines = String(desc ?? "").replace(/\r\n?/g, "\n").trim().split("\n");
  const tail: string[] = [];
  while (lines.length && (!lines[lines.length - 1].trim() || 태그줄(lines[lines.length - 1]))) {
    const l = lines.pop()!;
    if (l.trim()) tail.unshift(...(l.match(해시꼴) ?? []));
  }
  return { body: lines.join("\n").trim(), tail };
}

/**
 * 인스타그램 설명 = 제목 + 설명 + 해시태그. 2200자 · 해시태그 30개를 넘지 않게 자른다(제목·해시태그는 지키고 설명을 먼저 줄인다).
 * 설명 안에 낀 해시태그도 30개에 들어가므로 같이 센다.
 */
export function buildCaption(title: string, desc: string, tags: string[] = []): { text: string; hashtags: number; trimmed: boolean } {
  const t0 = String(title ?? "").replace(/\s+/g, " ").trim();
  const { body: b0, tail } = splitDesc(desc);
  let trimmed = false;
  // 본문 안의 해시태그가 30개를 넘으면 넘는 것은 # 만 뗀다
  let body = b0;
  let n = 0;
  body = body.replace(해시꼴, (m) => { n++; if (n > IG_TAG_MAX) { trimmed = true; return m.slice(1); } return m; });
  const inline = Math.min(n, IG_TAG_MAX);
  const inlineSet = new Set((b0.match(해시꼴) ?? []).map((x) => x.slice(1).toLowerCase()));
  const all = collectTags(tail, tags).filter((x) => !inlineSet.has(x.toLowerCase()));
  const room = Math.max(0, IG_TAG_MAX - inline);
  if (all.length > room) trimmed = true;
  const tagLine = (k: number) => all.slice(0, k).map((x) => "#" + x).join(" ");
  const compose = (bodyText: string, k: number, title: string) =>
    [title, bodyText, tagLine(k)].filter((x) => x.trim()).join("\n\n");

  let title1 = t0, k = Math.min(all.length, room);
  let text = compose(body, k, title1);
  if (길이(text) > IG_CAPTION_MAX) {
    trimmed = true;
    // ① 설명을 줄인다
    const fixed = compose("", k, title1).length + (body ? 2 : 0);
    const left = IG_CAPTION_MAX - fixed;
    body = left > 1 ? 자르기(body, left - 1).replace(/\s+$/, "") + "…" : "";
    text = compose(body, k, title1);
    // ② 그래도 길면 해시태그를 뒤에서부터 덜어 낸다
    while (길이(text) > IG_CAPTION_MAX && k > 0) { k--; text = compose(body, k, title1); }
    // ③ 마지막으로 제목을 자른다
    if (길이(text) > IG_CAPTION_MAX) { title1 = 자르기(title1, IG_CAPTION_MAX - 1) + "…"; text = title1; }
  }
  return { text, hashtags: (text.match(해시꼴) ?? []).length, trimmed };
}

/** 스레드가 글자를 세는 값: 이모지 같은 4바이트 글자는 4로 센다(보수적으로) */
function thLen(s: string): number {
  let n = 0;
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0xffff ? 4 : 1;
  return n;
}
function thCut(s: string, max: number): string {
  let n = 0, out = "";
  for (const ch of s) {
    const w = (ch.codePointAt(0) ?? 0) > 0xffff ? 4 : 1;
    if (n + w > max) break;
    n += w; out += ch;
  }
  return out;
}

/**
 * 스레드 글 = 제목 + 짧은 설명(500자). 글 안의 해시태그는 떼고, 주제 태그는 규칙(1~50자 · 「.」「&」 없음)에 맞는 첫 태그를 하나만 따로 보낸다.
 */
export function buildThreadsText(title: string, desc: string, tags: string[] = []): { text: string; topic: string } {
  const t0 = String(title ?? "").replace(해시꼴, "").replace(/\s+/g, " ").trim();
  const { body, tail } = splitDesc(desc);
  const cand = collectTags([...tail, ...(body.match(해시꼴) ?? [])], tags);
  const topic = cand.find((x) => x.length >= 1 && x.length <= 50 && !/[.&]/.test(x)) ?? "";
  // 설명은 첫 문단만, 해시태그는 뗀다
  const short = (body.split(/\n\s*\n/)[0] ?? "").replace(해시꼴, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const full = [t0, short].filter(Boolean).join("\n\n");
  let text = full;
  if (thLen(text) > TH_TEXT_MAX) {
    const head = t0 ? t0 + "\n\n" : "";
    const room = TH_TEXT_MAX - thLen(head) - 1;
    text = t0 && room > 4 ? head + thCut(short, room).replace(/\s+$/, "") + "…" : thCut(full, TH_TEXT_MAX - 1) + "…";
  }
  return { text: text || "영상", topic };
}

/* ============================================================ 영상 규격 미리 따지기 */

export interface ExtraProbe { fps: number | null; audio: string | null; bitrate: number | null }
let 추가조사시험: ((path: string) => Promise<ExtraProbe | null>) | undefined;
/** 시험: ffprobe 대신 추가 조사 결과를 끼운다 (undefined 면 원래대로) */
export function setExtraProbeForTest(f: ((path: string) => Promise<ExtraProbe | null>) | undefined) { 추가조사시험 = f; }

/** 프레임 수·음성 코덱·비트레이트 — ffprobe 가 있을 때만 잰다(없거나 실패하면 null = 이 항목은 확인하지 않는다) */
async function extraProbe(path: string): Promise<ExtraProbe | null> {
  if (추가조사시험) return await 추가조사시험(path);
  try {
    const ff = await findTool("ffprobe");
    if (!ff) return null;
    const out = await new Deno.Command(ff, {
      args: ["-v", "error", "-print_format", "json", "-show_entries", "stream=codec_type,codec_name,avg_frame_rate:format=bit_rate", path],
      stdout: "piped", stderr: "null",
    }).output();
    if (out.code !== 0) return null;
    const d = JSON.parse(new TextDecoder().decode(out.stdout));
    const v = (d.streams ?? []).find((s: Obj) => s.codec_type === "video");
    const a = (d.streams ?? []).find((s: Obj) => s.codec_type === "audio");
    const [n, m] = String(v?.avg_frame_rate ?? "").split("/").map(Number);
    const fps = m ? n / m : Number.isFinite(n) && n > 0 ? n : null;
    const br = Number(d.format?.bit_rate);
    return { fps: fps && Number.isFinite(fps) ? fps : null, audio: a ? String(a.codec_name ?? "?") : null, bitrate: Number.isFinite(br) && br > 0 ? br : null };
  } catch { return null; }
}

const 코덱이름 = (c: string): "h264" | "hevc" | "other" | "unknown" => {
  const x = String(c ?? "").toLowerCase();
  if (!x || x === "?") return "unknown";
  if (/h\.?264|avc/.test(x)) return "h264";
  if (/hevc|h\.?265|hvc1|hev1/.test(x)) return "hevc";
  return "other";
};

/** soft = problems 중 다시 인코딩하면 풀리는 것(크기·가로폭·비트레이트·음성/영상 코덱·프레임 수·파일 형식). 나머지(길이·화면비)는 다시 인코딩해도 안 풀린다. */
export interface SpecResult { problems: string[]; notes: string[]; soft: string[] }

/** 릴스(인스타그램) 영상 규격 — 2026-10 공식 문서 기준. 하나라도 어긋나면 올리지 않는다. */
export function reelsProblems(info: MediaInfo, file: string, extra: ExtraProbe | null): SpecResult {
  const problems: string[] = [], notes: string[] = [], soft: string[] = [];
  const add = (m: string, 고침 = false) => { problems.push(m); if (고침) soft.push(m); };
  const ext = extOf(file).toLowerCase().replace(/^\./, "");
  if (ext !== "mp4" && ext !== "mov") add(`파일 형식이 mp4·mov 가 아닙니다 (${ext || "알 수 없음"})`, true);
  if (info.mb > 300) add(`크기 ${info.mb.toFixed(0)}MB — 릴스는 300MB 까지입니다`, true);
  if (info.sec < 3) add(`길이 ${info.sec.toFixed(1)}초 — 릴스는 3초 이상이어야 합니다`);
  if (info.sec > 15 * 60) add(`길이 ${Math.round(info.sec)}초 — 릴스는 15분까지입니다`);
  const dw = info.display_w ?? info.w, dh = info.display_h ?? info.h;
  if (dw > 1920) add(`가로 ${Math.round(dw)}px — 릴스는 1920px 까지입니다`, true);
  const ratio = dh ? dw / dh : 0;
  if (!(ratio >= 0.01 && ratio <= 10)) add(`화면비가 허용 범위(0.01~10)를 벗어났습니다`);
  const c = 코덱이름(info.codec);
  if (c === "other") add(`영상 코덱 ${info.codec} — H.264 또는 HEVC 만 받습니다`, true);
  else if (c === "unknown") notes.push("영상 코덱을 읽지 못해 확인하지 않았습니다");
  if (extra) {
    if (extra.fps != null && (extra.fps < 22.9 || extra.fps > 60.1)) add(`초당 ${extra.fps.toFixed(1)}프레임 — 릴스는 23~60프레임입니다`, true);
    if (extra.audio && extra.audio.toLowerCase() !== "aac") add(`음성 코덱 ${extra.audio} — 릴스는 AAC 만 받습니다`, true);
    if (extra.bitrate != null && extra.bitrate > 25_000_000) add(`비트레이트 ${(extra.bitrate / 1e6).toFixed(0)}Mbps — 릴스는 25Mbps 까지입니다`, true);
  } else {
    notes.push("프레임 수·음성·비트레이트는 확인하지 못했습니다(ffprobe 없음)");
  }
  return { problems, notes, soft };
}

/** 스레드 영상 규격 — 길이 5분 · 1GB · mp4/mov · H.264/HEVC */
export function threadsProblems(info: MediaInfo, file: string, extra: ExtraProbe | null): SpecResult {
  const problems: string[] = [], notes: string[] = [], soft: string[] = [];
  const add = (m: string, 고침 = false) => { problems.push(m); if (고침) soft.push(m); };
  const ext = extOf(file).toLowerCase().replace(/^\./, "");
  if (ext !== "mp4" && ext !== "mov") add(`파일 형식이 mp4·mov 가 아닙니다 (${ext || "알 수 없음"})`, true);
  if (info.mb > 300) add(`크기 ${info.mb.toFixed(0)}MB — 임시 보관은 300MB 까지입니다`, true);
  if (info.sec > 300) add(`길이 ${Math.round(info.sec)}초 — 스레드 영상은 5분까지입니다`);
  const dw = info.display_w ?? info.w;
  if (dw > 1920) add(`가로 ${Math.round(dw)}px — 스레드는 1920px 까지입니다`, true);
  const c = 코덱이름(info.codec);
  if (c === "other") add(`영상 코덱 ${info.codec} — H.264 또는 HEVC 만 받습니다`, true);
  if (extra?.fps != null && (extra.fps < 22.9 || extra.fps > 60.1)) add(`초당 ${extra.fps.toFixed(1)}프레임 — 스레드는 23~60프레임입니다`, true);
  return { problems, notes, soft };
}

/* ============================================================ 릴스·스레드용으로 줄이기 (ffmpeg) */

export interface ShrinkPlan {
  /** 줄인 뒤 화면 크기 — 긴 변 1920 · 짧은 변 1080 안에 비율을 지켜 맞춘다(이미 작으면 그대로) */
  w: number;
  h: number;
  /** 프레임 수를 바꿀 때만 값이 있다(23~60 밖일 때 30) */
  fps: number | null;
  /** 영상 비트레이트 목표·최대 (bps) */
  vbps: number;
  maxbps: number;
}

const 줄인음성bps = 128_000;
/** 줄인 사본이 이 크기(바이트) 안에 넉넉히 들게 비트레이트를 정한다 — 한도는 300MB */
const 줄인크기예산 = 220 * 1048576;

/** 줄이는 방법을 정한다 (계산만 한다) */
export function shrinkPlan(info: MediaInfo, extra: ExtraProbe | null): ShrinkPlan {
  const dw = info.display_w ?? info.w, dh = info.display_h ?? info.h;
  const f = Math.min(1, 1080 / Math.min(dw, dh), 1920 / Math.max(dw, dh));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const fps = extra?.fps != null && (extra.fps < 22.9 || extra.fps > 60.1) ? 30 : null;
  const 한도 = info.sec > 0 ? Math.floor((줄인크기예산 * 8) / info.sec) - 줄인음성bps : 8_000_000;
  const vbps = Math.max(300_000, Math.min(8_000_000, 한도));
  return { w: even(dw * f), h: even(dh * f), fps, vbps, maxbps: Math.min(10_000_000, Math.round(vbps * 1.25)) };
}

/** ffmpeg 인자 — H.264(yuv420p) · AAC · +faststart. enc 는 h264_videotoolbox(맥) 또는 libx264 */
export function shrinkArgs(src: string, out: string, plan: ShrinkPlan, enc: string): string[] {
  const v = enc === "libx264"
    ? ["-c:v", "libx264", "-preset", "fast", "-profile:v", "high"]
    : ["-c:v", enc];
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
    "-vf", `scale=${plan.w}:${plan.h},setsar=1`,
    ...(plan.fps ? ["-r", String(plan.fps)] : []),
    ...v, "-pix_fmt", "yuv420p", "-b:v", String(plan.vbps), "-maxrate", String(plan.maxbps), "-bufsize", String(plan.maxbps * 2),
    "-c:a", "aac", "-b:a", String(줄인음성bps), "-ac", "2", "-ar", "48000",
    "-movflags", "+faststart", "-f", "mp4", out,
  ];
}

export type Transcoder = (ff: string, args: string[], ms: number) => Promise<{ code: number; stderr: string }>;
let 인코더시험: Transcoder | undefined;
/** 시험: 진짜 ffmpeg 대신 가짜 실행기를 끼운다 (undefined 면 원래대로) */
export function setTranscoderForTest(f: Transcoder | undefined) { 인코더시험 = f; }

async function ffmpeg실행(ff: string, args: string[], ms: number): Promise<{ code: number; stderr: string }> {
  if (인코더시험) return await 인코더시험(ff, args, ms);
  try {
    const r = await new Deno.Command(ff, { args, stdin: "null", stdout: "null", stderr: "piped", signal: AbortSignal.timeout(ms) }).output();
    const tail = new TextDecoder().decode(r.stderr).trim().split("\n").filter(Boolean).pop() ?? "";
    return { code: r.code, stderr: tail.slice(0, 140) };
  } catch (e) {
    return { code: -1, stderr: e instanceof Error && e.name === "TimeoutError" ? "시간이 너무 오래 걸려 멈췄습니다" : msgOf(e) };
  }
}

const 원본이름 = (id: string, src: string) => join(waitDir(), `${id}.원본${extOf(src).toLowerCase() || ".mp4"}`);
const 임시이름 = (id: string) => join(waitDir(), `${id}.줄이는중.mp4`);
const 완성이름 = (id: string) => join(waitDir(), `${id}.mp4`);
const 지우기 = async (f?: string) => { if (f) { try { await Deno.remove(f); } catch { /* 없다 */ } } };
const 파일크기 = async (f: string) => { try { return (await Deno.stat(f)).size; } catch { return 0; } };
const 없음까닭 = (soft: string[]) =>
  `${soft.some((x) => /크기|가로|비트레이트/.test(x)) ? "영상이 커서 줄여야" : "영상을 다시 인코딩해야"} 하는데 ffmpeg 가 없습니다 — ${soft.join(" · ")} (ffmpeg 를 설치하면 줄여서 올립니다)`;

/* ============================================================ 담기 (업로드 직후) */

export interface EnqueueArgs {
  videoId: string;
  /** 채널 별칭 */
  channel: string;
  file: string;
  title: string;
  desc: string;
  tags: string[];
  info: MediaInfo;
  kind: string;
  /** 영상 쪽지·일감이 정한 켜고 끄기 — 없으면 채널 설정을 따른다 */
  flags?: { instagram?: boolean; threads?: boolean };
  now?: Date;
}

export interface EnqueueResult { queued: boolean; why: string; /** 릴스·스레드 규격에 맞게 줄인 뒤 올린다 */ shrink?: boolean }

const 뜻 = (e: unknown) => msgOf(e);
/** 로그에 남길 글에서 주소(서명이 붙은 것 포함)를 뺀다 */
const 주소뺀 = (t: string) => t.replace(/https?:\/\/\S+/g, "(주소)");

/** 메타대기/ 에 영상 한 벌을 둔다 — 하드링크(같은 디스크면 공간을 안 쓴다), 안 되면 복사. 줄일 영상(`원본`)은 형식을 바꾸지 않고 그대로 둔다. */
async function stageLocal(src: string, id: string, 원본 = false): Promise<string> {
  await Deno.mkdir(waitDir(), { recursive: true });
  const dst = 원본 ? 원본이름(id, src) : join(waitDir(), `${id}${extOf(src).toLowerCase() === ".mov" ? ".mov" : ".mp4"}`);
  try { await Deno.remove(dst); } catch { /* 없다 */ }
  try { await Deno.link(src, dst); } catch { await Deno.copyFile(src, dst); }
  return dst;
}

/**
 * 유튜브에 올린 영상을 인스타·스레드 올리기 장부에 담는다. 이 채널에 계정이 걸려 있거나 영상 쪽지가 켠 영상만 담는다(기본은 꺼짐).
 * 롱폼·가로·길이 미달/초과는 담기는 하되 「건너뜀」과 까닭을 적어 화면에 보이게 한다.
 * 다시 인코딩하면 풀리는 규격 문제(크기·가로폭 등)만 있으면 건너뛰지 않고 `shrink` 표시와 함께 대기로 둔다 — 실제 줄이기는 run 이 한다(여기서는 오래 걸리는 일을 하지 않는다).
 */
export async function enqueue(a: EnqueueArgs): Promise<EnqueueResult> {
  const now = a.now ?? new Date();
  const store = loadStore();
  const bind = bindingOf(confFor(a.channel));
  const want: Partial<Record<Provider, { account: string; username: string } | { skip: string }>> = {};
  for (const p of PROVIDERS) {
    const flag = a.flags?.[p];
    if (flag === false) continue;
    const key = bind[p];
    if (!key) {
      if (flag === true) want[p] = { skip: `이 채널에 ${이름[p]} 계정이 걸려 있지 않습니다 — 설정에서 골라 주세요` };
      continue;
    }
    const tok = store[key];
    if (!tok) { want[p] = { skip: `${이름[p]} 연결이 끊겼습니다 — 설정에서 다시 연결해 주세요` }; continue; }
    want[p] = { account: key, username: tok.username || tok.user_id };
  }
  if (!Object.keys(want).length) return { queued: false, why: "꺼짐" };

  const targets: Partial<Record<Provider, Target>> = {};
  const skipAll = (why: string) => {
    for (const p of PROVIDERS) {
      const w = want[p];
      if (!w) continue;
      targets[p] = { account: "account" in w ? w.account : "", username: "username" in w ? w.username : "", state: "건너뜀", why, tries: 0, at: iso(now) };
    }
  };

  const cap = buildCaption(a.title, a.desc, a.tags);
  const th = buildThreadsText(a.title, a.desc, a.tags);
  const dw = a.info.display_w ?? a.info.w, dh = a.info.display_h ?? a.info.h;
  let file = "";
  let shrink: Shrink | undefined;
  if (a.kind !== "쇼츠" || dw > dh) {
    skipAll(`쇼츠(세로 3분 이하)만 올립니다 — 이 영상은 ${a.kind === "쇼츠" ? "가로" : "롱폼"}입니다`);
  } else {
    const extra = await extraProbe(a.file);
    const R = reelsProblems(a.info, a.file, extra), T = threadsProblems(a.info, a.file, extra);
    const ff = R.soft.length || T.soft.length ? await findTool("ffmpeg") : "";
    const needs: Provider[] = [], 고칠것: string[] = [];
    for (const p of PROVIDERS) {
      const w = want[p];
      if (!w) continue;
      if ("skip" in w) { targets[p] = { account: "", username: "", state: "건너뜀", why: w.skip, tries: 0, at: iso(now) }; continue; }
      const sp = p === "instagram" ? R : T;
      const hard = sp.problems.filter((x) => !sp.soft.includes(x));
      if (hard.length) {
        targets[p] = { ...w, state: "건너뜀", why: `영상 규격이 맞지 않아 올리지 않습니다 — ${hard.join(" · ")}`, tries: 0, at: iso(now) };
      } else if (sp.soft.length && !ff) {
        targets[p] = { ...w, state: "건너뜀", why: 없음까닭(sp.soft), tries: 0, at: iso(now) };
      } else if (sp.soft.length) {
        targets[p] = { ...w, state: "대기", why: `릴스·스레드 규격에 맞게 줄여서 올립니다 — ${sp.soft.join(" · ")}`, tries: 0, at: iso(now) };
        needs.push(p);
        for (const x of sp.soft) if (!고칠것.includes(x)) 고칠것.push(x);
      } else {
        targets[p] = { ...w, state: "대기", tries: 0, at: iso(now) };
      }
    }
    if (Object.values(targets).some((t) => t.state === "대기")) {
      if (needs.length) shrink = { state: "대기", src: await stageLocal(a.file, a.videoId, true), needs, why: 고칠것.join(" · "), tries: 0 };
      else file = await stageLocal(a.file, a.videoId);
    }
  }
  const active = Object.values(targets).some((t) => t.state === "대기");
  const job: MetaJob = {
    id: a.videoId, channel: a.channel, title: cut(a.title, 80), made: iso(now), kind: a.kind,
    phase: active ? "영상대기" : "끝", ...(active ? {} : { done_at: iso(now) }),
    yt_url: `https://youtu.be/${a.videoId}`, file, ...(shrink ? { shrink } : {}),
    info: { w: a.info.w, h: a.info.h, sec: Math.round(a.info.sec * 10) / 10, mb: Math.round(a.info.mb * 10) / 10, codec: a.info.codec },
    text: { caption: cap.text, threads: th.text, topic: th.topic }, targets,
  };
  const made = await updateJobs((l) => { if (l.jobs[a.videoId]) return false; l.jobs[a.videoId] = job; return true; });
  if (!made) return { queued: false, why: "이미 있음" };
  for (const p of PROVIDERS) {
    const t = targets[p];
    if (t) await recordLine("올리기.log", `${이름[p]} ${t.state === "건너뜀" ? "건너뜀" : "예약"}  [${a.channel}] ${cut(a.title, 40)}${t.why ? "  — " + cut(t.why, 100) : "  유튜브 공개 뒤 올림"}`);
  }
  return { queued: true, why: active ? "대기" : "건너뜀", ...(shrink ? { shrink: true } : {}) };
}

/* ============================================================ 공개됨 · 접힘 (심사 쪽에서 부른다) */

/**
 * 유튜브 영상이 공개됐다(또는 공개 예약이 걸렸다) — 올려도 되는 때를 정한다. 예약이면 열리는 시각 2분 뒤부터 올린다.
 * 일감이 없으면 아무것도 안 한다. 네트워크를 쓰지 않는다.
 */
export async function markPublic(videoId: string, o: { publishAt?: string | null; now?: Date } = {}): Promise<boolean> {
  const now = o.now ?? new Date();
  let when = now;
  const at = o.publishAt ? Date.parse(o.publishAt) : NaN;
  if (Number.isFinite(at) && at > now.getTime()) when = new Date(at + 2 * 분);
  return await updateJobs((l) => {
    const j = l.jobs[videoId];
    if (!j || j.phase !== "영상대기") return false;
    j.phase = "진행";
    j.go_after = iso(when);
    j.public_at = iso(now);
    return true;
  });
}

/** 유튜브에서 공개가 안 되는 영상(거부·삭제·사람이 내림) — 대기 중인 올리기를 접는다 */
export async function markDropped(videoId: string, why: string, o: { now?: Date } = {}): Promise<boolean> {
  const now = o.now ?? new Date();
  const hit = await updateJobs((l) => {
    const j = l.jobs[videoId];
    if (!j || j.phase === "끝") return false;
    for (const t of Object.values(j.targets)) {
      if (t && t.state === "대기") { t.state = "취소"; t.why = `유튜브에서 공개되지 않아 접었습니다 — ${why}`; t.at = iso(now); }
    }
    settle(j, now);
    return true;
  });
  if (hit) { await recordLine("올리기.log", `인스타·스레드 접음  ${videoId}  ${cut(why, 80)}`); await cleanup(videoId, now); }
  return hit;
}

/* ============================================================ 올리기 실행 */

export interface RunCtx {
  now?: Date;
  say?: (line: string) => void;
  /** 시험은 즉시 돌려준다 */
  sleep?: (ms: number) => Promise<void>;
  /** 인스타 처리 확인 간격(문서: 1분) · 스레드 게시 전 기다림(문서: 30초) */
  pollMs?: number;
  threadsWaitMs?: number;
  maxPolls?: number;
  /** 사건이 일어난 때를 재는 시계 — 시험이 끼운다. 없으면 now 를 고정으로 준 시험은 그 now, 아니면 실제 지금 */
  clock?: () => Date;
  /** (run 이 채운다) now 를 시험이 고정해서 줬다 */
  fixed?: boolean;
}
export interface RunResult { posted: number; failed: number; unknown: number; waiting: number; busy: boolean; /** 이번에 릴스·스레드용으로 줄인 영상 수 */ shrunk: number }

/**
 * 장부에 적는 「사건이 일어난 때」. now 는 run 이 시작한 때라서, 오래 걸리는 일(영상 보내기·처리 기다리기·줄이기) 뒤의 사건에 그대로 쓰면
 * 실제보다 이른 시각이 찍힌다 — 게시를 요청한 때(requested_at)·끝난 때(done_at)·마지막으로 건드린 때(at)는 이걸로 적는다.
 */
function stamp(ctx: { now: Date; clock?: () => Date; fixed?: boolean }): Date {
  return ctx.clock ? ctx.clock() : ctx.fixed ? ctx.now : new Date();
}

const 활동 = new Set<TState>(["대기", "올리는중", "게시요청중"]);

/** 더 할 일이 없으면 끝난 일감으로 표시한다 */
function settle(j: MetaJob, now: Date) {
  if (j.phase === "끝") return;
  if (Object.values(j.targets).every((t) => !t || !활동.has(t.state))) { j.phase = "끝"; j.done_at = iso(now); }
}

async function patchTarget(id: string, p: Provider, f: (t: Target, j: MetaJob) => void, now: Date): Promise<void> {
  await updateJobs((l) => {
    const j = l.jobs[id];
    const t = j?.targets[p];
    if (!j || !t) return;
    f(t, j);
    t.at = iso(now);
    settle(j, now);
  });
}

const 하이퍼 = (p: Provider) => `${PROV[p].graph}/${PROV[p].ver}`;
const call = (url: string, init: RequestInit = {}, ms = 60_000) => doFetch(url, { ...init, signal: AbortSignal.timeout(ms) });

async function graphGet(p: Provider, path: string, token: string, params: Record<string, string> = {}): Promise<Obj> {
  const res = await call(`${하이퍼(p)}${path}?${new URLSearchParams({ ...params, access_token: token })}`);
  if (!res.ok) throw await toMetaError(res);
  return await res.json().catch(() => ({})) as Obj;
}

async function graphPost(p: Provider, path: string, token: string, params: Record<string, string>): Promise<Obj> {
  const res = await call(`${하이퍼(p)}${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, access_token: token }),
  });
  if (!res.ok) throw await toMetaError(res);
  return await res.json().catch(() => ({})) as Obj;
}

/* ─────────── 임시 보관 (중계 서버 R2) ─────────── */

/**
 * retry=false 는 다시 해도 소용없다는 뜻. 중계가 「이번 달 무료 한도」로 닫았으면(monthly_free_cap) capUntil 에 다시 열리는 시각이 들어 있고,
 * 그때까지 자동으로 다시 하지 않는다. retryMin 은 일시적인 막힘(보관함이 가득 참)이 풀릴 만한 때까지의 분.
 */
class StageError extends Error {
  constructor(m: string, public retry = true, public o: { capUntil?: string; retryMin?: number } = {}) { super(m); this.name = "StageError"; }
}

/** 「11월 1일」 — 이 컴퓨터의 날짜로 */
const 월일 = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };

async function ensureStaged(id: string, p: Provider, token: string, now: Date): Promise<Staged> {
  const job = loadJobs().jobs[id];
  if (!job) throw new StageError("일감이 없습니다", false);
  const cur = job.staged;
  if (cur && !cur.deleted && Date.parse(cur.get_expires_at) - now.getTime() > 20 * 분) return cur;
  const conf = await embeddedMeta();
  if (!conf) throw new StageError("메타 연결 정보가 이 판에 들어 있지 않습니다", false);
  if (!job.file || !existsSync(job.file)) throw new StageError("올릴 영상 파일이 정리되어 없습니다", false);
  if (cur && !cur.deleted) await deleteStaged(id, now);
  const st = await Deno.stat(job.file);
  const ext = extOf(job.file).toLowerCase() === ".mov" ? "mov" : "mp4";
  const r = await call(`${conf.worker_url}/stage/ticket`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: PROV[p].prefix, token, size: st.size, ext }),
  });
  const j = await r.json().catch(() => ({})) as Obj;
  if (!r.ok || !j.ok) {
    // 중계가 R2 의 이번 달 무료 한도에 닿아 닫았다 — 과금이 생기지 않게 멈춘 것이다. 다음 구간이 열릴 때까지 다시 시도하지 않는다.
    if (j.code === "monthly_free_cap" && Number.isFinite(Date.parse(String(j.reopens_at)))) {
      throw new StageError(`이번 달 무료 한도 도달 — ${월일(String(j.reopens_at))}에 다시 열림`, false, { capUntil: new Date(String(j.reopens_at)).toISOString() });
    }
    // 동시에 보관할 수 있는 양이 찼다 — 곧(보관 중인 영상이 지워지면) 풀리는 일시적인 막힘
    if (j.code === "stage_full") {
      throw new StageError("임시 보관함이 가득 차 있어 잠시 뒤 다시 시도합니다", true, { retryMin: Math.min(60, Math.max(10, Math.ceil((Number(j.retry_after) || 600) / 60))) });
    }
    throw new StageError(`임시 보관 요청이 거절됐습니다 (${r.status}${j.why ? " — " + String(j.why) : ""})`, r.status >= 500 || r.status === 429);
  }
  // 파일을 통째로 읽어 보낸다 — 조각 스트림으로 보내면 Content-Length 가 빠져 R2 가 받지 않는다 (300MB 상한)
  const bytes = await Deno.readFile(job.file);
  const put = await call(String(j.put_url), { method: "PUT", headers: { "content-type": ext === "mov" ? "video/quicktime" : "video/mp4" }, body: bytes }, 20 * 60_000);
  if (!put.ok) throw new StageError(`임시 보관에 올리지 못했습니다 (${put.status})`, put.status >= 500);
  await put.body?.cancel().catch(() => {});
  const staged: Staged = {
    id: String(j.id), get_url: String(j.get_url), get_expires_at: String(j.get_expires_at), delete_sig: String(j.delete_sig),
    uploaded_at: iso(now), bytes: st.size,
  };
  await updateJobs((l) => { if (l.jobs[id]) l.jobs[id].staged = staged; });
  return staged;
}

/**
 * 임시 보관본을 지운다(중계 서버가 1시간 뒤에도 지운다).
 * 지워졌다는 답(2xx, 또는 이미 없다는 404)을 받았을 때만 「지움」으로 적는다. 그 밖(거절·5xx·끊김)은 지우지 못했다고 적고 서명은 남긴다 — run 이 몇 번 더 해 본다.
 */
async function deleteStaged(id: string, now: Date): Promise<void> {
  const job = loadJobs().jobs[id];
  const s = job?.staged;
  if (!job || !s || s.deleted) return;
  let why = "";
  try {
    const conf = await embeddedMeta();
    if (!conf) why = "메타 연결 정보가 없습니다";
    else {
      const r = await call(`${conf.worker_url}/stage/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: s.id, sig: s.delete_sig }) }, 30_000);
      await r.body?.cancel().catch(() => {});
      if (!r.ok && r.status !== 404) why = `중계 서버가 ${r.status} 로 답했습니다`;
    }
  } catch (e) { why = msgOf(e); }
  if (why) {
    await updateJobs((l) => { const x = l.jobs[id]?.staged; if (x && !x.deleted) { x.delete_why = why; x.delete_tries = (x.delete_tries ?? 0) + 1; x.delete_at = iso(now); } });
    await recordLine("올리기.log", `임시 보관본을 지우지 못했습니다  [${job.channel}] ${cut(job.title, 30)}  ${cut(why, 100)}  (중계 서버가 1시간 뒤 지웁니다)`);
    return;
  }
  await updateJobs((l) => { const x = l.jobs[id]; if (x?.staged) { x.staged.deleted = true; x.staged.get_url = ""; x.staged.delete_sig = ""; delete x.staged.delete_why; delete x.staged.delete_at; } });
}

/** 일감이 둔 영상 파일을 모두 치운다(올릴 영상 · 줄이려고 둔 원본 사본 · 줄이다 만 임시 파일). 원래 영상은 건드리지 않는다. */
async function 파일치우기(j: MetaJob): Promise<void> {
  for (const f of [j.file, j.shrink?.src, 임시이름(j.id)]) await 지우기(f);
}

/** 더 이어 갈 올리기가 없으면 임시 보관본과(다시 시도할 일이 없으면) 내 사본을 지운다 */
async function cleanup(id: string, now: Date): Promise<void> {
  const j = loadJobs().jobs[id];
  if (!j) return;
  if (Object.values(j.targets).some((t) => t && 활동.has(t.state))) return;
  if (j.staged && !j.staged.deleted) await deleteStaged(id, now);
  const 다시할일 = Object.values(j.targets).some((t) => t && (t.state === "실패" || t.state === "결과불명"));
  if ((j.file || j.shrink?.src) && !다시할일) {
    await 파일치우기(j);
    await updateJobs((l) => { const x = l.jobs[id]; if (x) { x.file = ""; if (x.shrink) x.shrink.src = ""; } });
  }
}

/* ─────────── 한 계정 올리기 ─────────── */

type Outcome = { kind: "done" } | { kind: "wait" } | { kind: "stop" };

/** 에러를 장부에 반영한다 — 일시 오류·한도는 나중에 다시, 그 밖은 실패 */
async function onError(id: string, p: Provider, e: unknown, step: string, ctx: Required<Pick<RunCtx, "now">> & RunCtx): Promise<void> {
  const now = stamp(ctx);
  // 이번 달 무료 한도로 닫힘 — 실패가 아니다. 대기 그대로 두고 다시 열리는 시각까지 건드리지 않는다(시도 횟수도 올리지 않는다).
  if (e instanceof StageError && e.o.capUntil) {
    const until = e.o.capUntil;
    await patchTarget(id, p, (t) => { t.next_at = until; t.why = e.message; }, now);
    const j = loadJobs().jobs[id];
    await recordLine("올리기.log", `${이름[p]} 보류  [${j?.channel ?? ""}] ${cut(j?.title ?? "", 40)}  ${step} — ${e.message}`);
    return;
  }
  const retry = (e instanceof MetaApiError && (e.kind === "temp" || e.kind === "limit")) || (e instanceof StageError && e.retry);
  const why = e instanceof StageError ? e.message : e instanceof MetaAuthError ? e.message : explainMeta(e);
  let gave = false;
  await patchTarget(id, p, (t) => {
    t.tries++;
    if (retry && t.tries < 5) {
      const gap = e instanceof StageError && e.o.retryMin ? e.o.retryMin : e instanceof MetaApiError && e.kind === "limit" ? 60 : 10;
      t.next_at = iso(new Date(now.getTime() + gap * 분));
      t.why = `${step} 중 오류 — 나중에 다시 시도합니다 (${why})`;
    } else {
      t.state = "실패"; t.why = `${step} 실패 — ${why}`; delete t.next_at; delete t.container; gave = true;
    }
  }, now);
  const j = loadJobs().jobs[id];
  if (gave) await recordLine("올리기.log", `${이름[p]} 실패  [${j?.channel ?? ""}] ${cut(j?.title ?? "", 40)}  ${step} — ${cut(why, 110)}`);
}

async function 상태기다리기(
  p: Provider, container: string, token: string, ctx: RunCtx, first: number,
): Promise<"finished" | "pending" | { error: string }> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = p === "instagram" ? (ctx.pollMs ?? 60_000) : (ctx.threadsWaitMs ?? 30_000);
  const max = ctx.maxPolls ?? 5;
  if (first > 0) await sleep(first);
  for (let i = 0; i < max; i++) {
    const g = await graphGet(p, `/${container}`, token, { fields: p === "instagram" ? "status_code,status" : "status,error_message" });
    const code = String(g.status_code ?? g.status ?? "").toUpperCase();
    if (code === "FINISHED") return "finished";
    if (code === "ERROR" || code === "EXPIRED") {
      // 메타가 준 값 전부(상태 + 까닭)를 남긴다 — 까닭 없이 「ERROR」 한 단어만 오는 일이 있어서
      const detail = String(g.error_message ?? (g.status && String(g.status).toUpperCase() !== code ? g.status : "") ?? "").trim();
      return { error: (detail ? `${code}: ${detail}` : code).slice(0, 200) };
    }
    if (code === "PUBLISHED") return "finished";
    if (i < max - 1) await sleep(gap);
  }
  return "pending";
}

/** 방금 올린 인스타 영상의 내려받기 주소 (스레드가 쓰는 첫 번째 길) — 못 얻으면 null */
async function instagramMediaUrl(job: MetaJob, now: Date): Promise<string | null> {
  const ig = job.targets.instagram;
  if (!ig || ig.state !== "올림" || !ig.media_id) return null;
  try {
    const token = await freshToken(ig.account, { now });
    const g = await graphGet("instagram", `/${ig.media_id}`, token, { fields: "media_url" });
    const u = String(g.media_url ?? "");
    return /^https:\/\//.test(u) ? u : null;
  } catch { return null; }
}

async function runTarget(id: string, p: Provider, ctx: RunCtx & { now: Date }, out: RunResult): Promise<void> {
  const now = ctx.now;
  const T = () => stamp(ctx);
  const say = ctx.say ?? (() => {});
  const job = loadJobs().jobs[id];
  let t = job?.targets[p];
  if (!job || !t) return;
  const tag = `[${job.channel}] ${cut(job.title, 30)}`;

  // 「게시」를 보내고 답을 못 받은 채 끊긴 것 — 절대 다시 보내지 않는다. 올라갔는지 읽어 보고, 모르면 사람에게 넘긴다.
  if (t.state === "게시요청중") {
    await patchTarget(id, p, (x) => { x.state = "결과불명"; x.why = "올리기 요청을 보낸 뒤 답을 받기 전에 끊겼습니다 — 올라갔는지 확인이 필요합니다"; }, T());
    await recordLine("올리기.log", `${이름[p]} 결과불명  ${tag}  게시 요청 뒤 끊김 — 다시 보내지 않음`);
    out.unknown++;
    await autoCheck(id, p, T());
    return;
  }
  if (t.state === "결과불명") { out.unknown++; await autoCheck(id, p, T()); return; }
  if (t.state !== "대기" && t.state !== "올리는중") return;
  if (t.next_at && Date.parse(t.next_at) > now.getTime()) { out.waiting++; return; }

  // 스레드는 인스타가 끝나길 잠시 기다린다 (방금 올린 인스타 영상 주소를 먼저 쓰려고) — 2시간 넘게 끌면 기다리지 않는다
  if (p === "threads") {
    const ig = job.targets.instagram;
    const igLater = !!ig?.next_at && Date.parse(ig.next_at) > now.getTime() + 15 * 분;
    if (ig && 활동.has(ig.state) && !igLater && now.getTime() - Date.parse(job.go_after ?? job.made) < 120 * 분) { out.waiting++; return; }
  }

  try {
    const token = await freshToken(t.account, { now });
    const P = PROV[p];
    const store = loadStore()[t.account];
    const uid = store?.user_id ?? "me";

    // ① 영상 주소
    let videoUrl = "";
    let route: Target["route"] = "staging";
    let justCreated = false;
    if (!t.container) {
      if (p === "threads" && !(t.routes_failed ?? []).includes("instagram_media_url")) {
        const u = await instagramMediaUrl(job, T());
        if (u) { videoUrl = u; route = "instagram_media_url"; }
      }
      if (!videoUrl) videoUrl = (await ensureStaged(id, p, token, now)).get_url;
      // ② 컨테이너 — 영상을 메타가 가져가게 한다 (되풀이해도 해가 없다)
      const params: Record<string, string> = p === "instagram"
        ? { media_type: "REELS", video_url: videoUrl, caption: job.text.caption, share_to_feed: "true" }
        : { media_type: "VIDEO", video_url: videoUrl, text: job.text.threads, ...(job.text.topic ? { topic_tag: job.text.topic } : {}) };
      const g = await graphPost(p, `/${uid}/${p === "instagram" ? "media" : "threads"}`, token, params);
      const cid = String(g.id ?? "");
      if (!cid) throw new MetaApiError("컨테이너 번호가 오지 않았습니다");
      await patchTarget(id, p, (x) => { x.state = "올리는중"; x.container = cid; x.route = route; delete x.next_at; }, T());
      justCreated = true;
      t = loadJobs().jobs[id]?.targets[p] ?? t;
      say(`  ${이름[p]}  ${tag}  영상 보냄${p === "threads" ? ` (${route === "instagram_media_url" ? "인스타 영상 주소" : "임시 보관"})` : ""}`);
    }
    const container = t.container!;

    // ③ 메타가 영상을 처리할 때까지 기다린다
    const st = await 상태기다리기(p, container, token, ctx, p === "threads" && justCreated ? (ctx.threadsWaitMs ?? 30_000) : 0);
    if (st === "pending") {
      await patchTarget(id, p, (x) => { x.next_at = iso(new Date(T().getTime() + 5 * 분)); x.why = "메타가 영상을 처리하는 중입니다"; }, T());
      out.waiting++;
      return;
    }
    if (typeof st === "object") {
      // 스레드: 인스타 영상 주소를 메타가 못 가져갔으면 임시 보관 길로 한 번 더
      if (p === "threads" && t.route === "instagram_media_url") {
        // 넘어가기 전에 메타가 준 까닭을 남긴다(주소·서명은 뺀다) — 안 남기면 왜 임시 보관 길로 갔는지 알 길이 없다
        await recordLine("올리기.log", `${이름[p]} 인스타 영상 주소 길 실패  ${tag}  컨테이너 ${container} — ${cut(주소뺀(st.error), 160)}  → 임시 보관 길로 바꿈`);
        await patchTarget(id, p, (x) => { x.routes_failed = [...(x.routes_failed ?? []), "instagram_media_url"]; delete x.container; delete x.route; x.why = `인스타 영상 주소로는 안 돼 임시 보관 길로 바꿉니다 (${st.error})`; }, T());
        return await runTarget(id, p, ctx, out);
      }
      await patchTarget(id, p, (x) => { x.state = "실패"; x.why = `메타가 영상을 받아들이지 않았습니다 — ${st.error}`; delete x.container; delete x.next_at; }, T());
      await recordLine("올리기.log", `${이름[p]} 실패  ${tag}  처리 오류 — ${cut(st.error, 100)}`);
      out.failed++;
      return;
    }

    // ④ 게시 — ★되풀이 금지 구간. 요청을 보내기 전에 「게시요청중」을 적는다(적을 때 아직 올리는중이어야 한다).
    const 적음 = await updateJobs((l) => {
      const x = l.jobs[id]?.targets[p];
      if (!x || x.state !== "올리는중" || x.container !== container) return false;
      const 지금 = iso(T());   // 요청을 보내기 직전의 실제 시각 — 결과불명 확인이 이 시각으로 최근 게시물을 가린다
      x.state = "게시요청중"; x.requested_at = 지금; x.at = 지금;
      return true;
    });
    if (!적음) return;
    let mediaId = "";
    let definitive = false, err: unknown = null;
    try {
      const g = await graphPost(p, `/${uid}/${p === "instagram" ? "media_publish" : "threads_publish"}`, token, { creation_id: container });
      mediaId = String(g.id ?? "");
    } catch (e) {
      err = e;
      // 메타가 「안 됐다」고 분명히 답한 것(4xx)만 올라가지 않았다고 본다. 5xx·끊김·시간 초과는 올라갔는지 모른다.
      definitive = e instanceof MetaApiError && e.status > 0 && e.status < 500;
    }
    if (mediaId) {
      await patchTarget(id, p, (x) => { x.state = "올림"; x.media_id = mediaId; delete x.why; delete x.next_at; }, T());
      let url = "";
      try {
        const g = await graphGet(p, `/${mediaId}`, token, { fields: "permalink" });
        url = String(g.permalink ?? "");
      } catch { /* 주소를 못 얻어도 올라간 것은 맞다 */ }
      if (url) await patchTarget(id, p, (x) => { x.url = url; }, T());
      await recordLine("올리기.log", `${이름[p]} 올림  ${tag}  ${mediaId}${url ? "  " + url : ""}`);
      say(`  ${이름[p]}  ${tag}  올림 ${url}`);
      out.posted++;
      return;
    }
    if (definitive && err instanceof MetaApiError) {
      if (err.code === 9007 || err.subcode === 2207027) {
        // 아직 영상이 덜 처리됐다 — 올라가지 않았다. 다시 기다린다.
        await patchTarget(id, p, (x) => { x.state = "올리는중"; x.next_at = iso(new Date(T().getTime() + 2 * 분)); x.why = "메타가 아직 영상을 처리하는 중입니다"; delete x.requested_at; }, T());
        out.waiting++;
        return;
      }
      await patchTarget(id, p, (x) => { x.state = "실패"; x.why = `올리기 요청이 거절됐습니다 — ${explainMeta(err)}`; delete x.container; delete x.requested_at; delete x.next_at; }, T());
      await recordLine("올리기.log", `${이름[p]} 실패  ${tag}  게시 거절 — ${cut(explainMeta(err), 100)}`);
      out.failed++;
      return;
    }
    await patchTarget(id, p, (x) => { x.state = "결과불명"; x.why = `올리기 요청 뒤 분명한 답을 받지 못했습니다 (${err ? msgOf(err) : "답에 번호 없음"}) — 올라갔는지 확인이 필요합니다`; }, T());
    await recordLine("올리기.log", `${이름[p]} 결과불명  ${tag}  게시 뒤 답 없음 — 다시 보내지 않음`);
    out.unknown++;
    await autoCheck(id, p, T());
  } catch (e) {
    await onError(id, p, e, "올리기", ctx);
    const after = loadJobs().jobs[id]?.targets[p];
    if (after?.state === "실패") out.failed++; else out.waiting++;
  }
}

/* ============================================================ 결과불명 확인 (읽기만) */

/** 계정의 최근 게시물에서 방금 올리려던 것을 찾는다. 찾으면 올림으로 바꾼다. 다시 올리지는 않는다. */
export async function checkUnknown(id: string, p: Provider, o: { now?: Date } = {}): Promise<{ found: boolean; why: string }> {
  const now = o.now ?? new Date();
  const job = loadJobs().jobs[id];
  const t = job?.targets[p];
  if (!job || !t) return { found: false, why: "일감을 찾을 수 없습니다" };
  if (t.state !== "결과불명") return { found: t.state === "올림", why: `지금 상태는 「${t.state}」입니다` };
  let found: { id: string; url: string } | null = null;
  let why = "";
  try {
    const token = await freshToken(t.account, { now });
    const uid = loadStore()[t.account]?.user_id ?? "me";
    const sent = Date.parse(t.requested_at ?? "") || now.getTime();
    const mine = (p === "instagram" ? job.text.caption : job.text.threads).replace(/\s+/g, " ").trim().slice(0, 30);
    const g = p === "instagram"
      ? await graphGet(p, `/${uid}/media`, token, { fields: "id,caption,permalink,timestamp", limit: "10" })
      : await graphGet(p, `/${uid}/threads`, token, { fields: "id,text,permalink,timestamp", limit: "10" });
    for (const m of (Array.isArray(g.data) ? g.data : []) as Obj[]) {
      const text = String(p === "instagram" ? m.caption ?? "" : m.text ?? "").replace(/\s+/g, " ").trim();
      const ts = Date.parse(String(m.timestamp ?? ""));
      if (mine && text.startsWith(mine) && (!Number.isFinite(ts) || ts >= sent - 5 * 분)) { found = { id: String(m.id), url: String(m.permalink ?? "") }; break; }
    }
    why = found ? "계정의 최근 게시물에서 찾았습니다" : "계정의 최근 게시물에서 찾지 못했습니다";
  } catch (e) {
    why = `확인하지 못했습니다 — ${explainMeta(e)}`;
  }
  await patchTarget(id, p, (x) => {
    x.checks = (x.checks ?? 0) + 1; x.checked_at = iso(now);
    if (found) { x.state = "올림"; x.media_id = found.id; if (found.url) x.url = found.url; delete x.why; }
    else x.why = `${t.why?.split(" — 확인:")[0] ?? ""} — 확인: ${why}`.trim();
  }, now);
  if (found) await recordLine("올리기.log", `${이름[p]} 올림  [${job.channel}] ${cut(job.title, 40)}  ${found.id} (결과불명 확인으로 찾음)`);
  await cleanup(id, now);
  return { found: !!found, why };
}

/** 실행 중에 자동으로 읽어 보기 — 30분에 한 번, 모두 4번까지 (읽기뿐이라 해가 없다) */
async function autoCheck(id: string, p: Provider, now: Date): Promise<void> {
  const t = loadJobs().jobs[id]?.targets[p];
  if (!t || t.state !== "결과불명") return;
  if ((t.checks ?? 0) >= 4) return;
  if (t.checked_at && now.getTime() - Date.parse(t.checked_at) < 30 * 분) return;
  await checkUnknown(id, p, { now });
}

/* ============================================================ 한 번 돌기 (예약 작업이 부른다) */

async function pruneOld(now: Date): Promise<void> {
  const l = loadJobs();
  const dead: string[] = [], fileOld: string[] = [], stale: string[] = [];
  for (const [id, j] of Object.entries(l.jobs)) {
    const age = now.getTime() - Date.parse(j.done_at ?? j.made);
    if (j.phase === "영상대기" && now.getTime() - Date.parse(j.made) > 14 * 24 * 60 * 분) stale.push(id);
    if (j.phase === "끝" && age > KEEP_RECORD_DAYS * 24 * 60 * 분) dead.push(id);
    else if (j.phase === "끝" && (j.file || j.shrink?.src) && age > KEEP_FILE_DAYS * 24 * 60 * 분) fileOld.push(id);
  }
  for (const id of stale) await markDropped(id, "14일이 지나도 유튜브 공개가 확인되지 않았습니다", { now });
  for (const id of fileOld) {
    await 파일치우기(l.jobs[id]);
    await updateJobs((x) => { const y = x.jobs[id]; if (y) { y.file = ""; if (y.shrink) y.shrink.src = ""; } });
  }
  const left = Object.keys(loadJobs().jobs).length - dead.length;
  if (dead.length || left > MAX_RECORDS) {
    await updateJobs((x) => {
      for (const id of dead) delete x.jobs[id];
      const done = Object.values(x.jobs).filter((j) => j.phase === "끝").sort((a, b) => a.made.localeCompare(b.made));
      let over = Object.keys(x.jobs).length - MAX_RECORDS;
      for (const j of done) { if (over-- <= 0) break; delete x.jobs[j.id]; }
    });
  }
}

/* ─────────── 릴스·스레드용으로 줄이기 (run 이 한 번에 한 건) ─────────── */

/** 줄이기가 아직 남은 일감 — 영상이 아직 없으니 올리지 않는다 */
const 줄이기남음 = (j: MetaJob) => !!j.shrink && (j.shrink.state === "대기" || j.shrink.state === "줄이는중");

/**
 * 앱이 꺼졌다 켜졌을 때 「줄이는중」으로 남은 것은 믿지 않는다 — 줄이기는 run 의 잠금 안에서만 하므로, 잠금을 잡은 지금 줄이고 있는 곳은 없다.
 * 반쯤 만든 임시 파일은 지우고 처음부터 다시 줄인다.
 */
async function 끊긴줄이기정리(): Promise<void> {
  const ids = Object.values(loadJobs().jobs).filter((j) => j.shrink?.state === "줄이는중").map((j) => j.id);
  if (!ids.length) return;
  await updateJobs((l) => { for (const id of ids) { const x = l.jobs[id]?.shrink; if (x?.state === "줄이는중") x.state = "대기"; } });
  for (const id of ids) {
    await 지우기(임시이름(id));
    await recordLine("올리기.log", `영상 줄이기가 도중에 끊겨 있었습니다 — 처음부터 다시 줄입니다  ${id}`);
  }
}

/** 줄이기를 그만둔다 — 줄여야 하는 쪽만 결과를 적고(실패: 사람이 다시 시도할 수 있음 · 건너뜀: 안 됨), 줄이지 않아도 되는 쪽은 원본 사본 그대로 올린다 */
async function 줄이기포기(id: string, 결과: "실패" | "건너뜀", why: string, now: Date): Promise<void> {
  const j0 = loadJobs().jobs[id];
  await updateJobs((l) => {
    const j = l.jobs[id], sh = j?.shrink;
    if (!j || !sh) return;
    let 남음 = false;
    for (const p of PROVIDERS) {
      const t = j.targets[p];
      if (!t || t.state !== "대기") continue;
      if (sh.needs.includes(p)) { t.state = 결과; t.why = why; t.at = iso(now); } else 남음 = true;
    }
    sh.state = 결과 === "실패" ? "실패" : "끝";
    if (남음 && sh.src && existsSync(sh.src)) j.file = sh.src;
    settle(j, now);
  });
  await recordLine("올리기.log", `영상 줄이기 ${결과}  [${j0?.channel ?? ""}] ${cut(j0?.title ?? "", 30)}  ${cut(why, 110)}`);
  await cleanup(id, now);
}

/** 줄일 일감 한 건을 고른다 — 이미 공개되어 기다리는 것 먼저, 그다음 오래된 것 */
function 줄일일감(): string | null {
  const c = Object.values(loadJobs().jobs)
    .filter((j) => 줄이기남음(j) && Object.values(j.targets).some((t) => t?.state === "대기"))
    .sort((a, b) => (a.phase === "진행" ? 0 : 1) - (b.phase === "진행" ? 0 : 1) || a.made.localeCompare(b.made));
  return c[0]?.id ?? null;
}

async function shrinkJob(id: string, ctx: RunCtx & { now: Date }, out: RunResult): Promise<void> {
  const say = ctx.say ?? (() => {});
  const T = () => stamp(ctx);
  const j0 = loadJobs().jobs[id];
  const sh = j0?.shrink;
  if (!j0 || !sh) return;
  const tag = `[${j0.channel}] ${cut(j0.title, 30)}`;
  const ff = await findTool("ffmpeg");
  if (!ff) return await 줄이기포기(id, "건너뜀", 없음까닭(sh.why ? sh.why.split(" · ") : []), T());
  if (!sh.src || !existsSync(sh.src)) return await 줄이기포기(id, "건너뜀", "영상 사본이 정리되어 없어 줄이지 못했습니다", T());
  if (sh.tries >= 4) return await 줄이기포기(id, "실패", `${sh.tries}번 줄이려 했지만 끝내지 못했습니다 (도중에 앱이 꺼졌을 수 있습니다)`, T());

  const tmp = 임시이름(id), fin = 완성이름(id);
  // 반쯤 만든 파일과, 확인이 끝났다고 장부에 적지 못한 완성본은 믿지 않는다 — 처음부터 다시 만든다
  await 지우기(tmp);
  await 지우기(fin);
  await updateJobs((l) => { const x = l.jobs[id]?.shrink; if (x) { x.state = "줄이는중"; x.tries++; x.started_at = iso(T()); } });
  say(`  영상 줄이는 중  ${tag}  (릴스·스레드 규격)`);
  const 시작 = performance.now();

  let info: MediaInfo;
  try { info = await probeNow(sh.src); } catch (e) { return await 줄이기포기(id, "실패", `원본 영상을 읽지 못했습니다 — ${msgOf(e)}`, T()); }
  const plan = shrinkPlan(info, await extraProbe(sh.src));
  const ms = Math.min(60, Math.max(10, Math.ceil(info.sec / 60) * 3)) * 분;
  // 맥은 하드웨어 인코더를 먼저, 없거나 실패하면 libx264 (윈도우·리눅스는 libx264)
  let used = "", last = "";
  for (const enc of IS_MAC ? ["h264_videotoolbox", "libx264"] : ["libx264"]) {
    const r = await ffmpeg실행(ff, shrinkArgs(sh.src, tmp, plan, enc), ms);
    if (r.code === 0 && (await 파일크기(tmp)) > 0) { used = enc; break; }
    last = r.stderr || `종료 코드 ${r.code}`;
    await 지우기(tmp);
  }
  if (!used) return await 줄이기포기(id, "실패", `영상을 줄이지 못했습니다 — ${last}`, T());

  // 만든 것을 다시 재어 규격에 맞는지 본다 — 그래도 안 맞으면 그때 건너뜀
  let ni: MediaInfo;
  try { ni = await probeNow(tmp); } catch (e) { await 지우기(tmp); return await 줄이기포기(id, "건너뜀", `줄인 영상을 읽지 못했습니다 — ${msgOf(e)}`, T()); }
  const nx = await extraProbe(tmp);
  const 틀림: Partial<Record<Provider, string[]>> = {};
  let 쓸수있음 = false;
  for (const p of PROVIDERS) {
    if (loadJobs().jobs[id]?.targets[p]?.state !== "대기") continue;
    const pr = (p === "instagram" ? reelsProblems : threadsProblems)(ni, fin, nx).problems;
    if (pr.length) 틀림[p] = pr; else 쓸수있음 = true;
  }
  if (쓸수있음) {
    try { await Deno.rename(tmp, fin); } catch (e) { await 지우기(tmp); return await 줄이기포기(id, "실패", `줄인 영상을 제자리에 두지 못했습니다 — ${msgOf(e)}`, T()); }
  } else await 지우기(tmp);

  const 소수 = (n: number) => Math.round(n * 10) / 10;
  const 요약 = `${Math.round(info.display_w ?? info.w)}x${Math.round(info.display_h ?? info.h)} ${info.mb.toFixed(0)}MB → ${ni.w}x${ni.h} ${ni.mb.toFixed(0)}MB`;
  const kept = await updateJobs((l) => {
    const j = l.jobs[id], x = j?.shrink;
    if (!j || !x) return 0;
    let n = 0;
    for (const p of PROVIDERS) {
      const t = j.targets[p];
      if (!t || t.state !== "대기") continue;
      const bad = 틀림[p];
      if (bad) { t.state = "건너뜀"; t.why = `줄여 보았지만 규격에 맞지 않아 올리지 않습니다 — ${bad.join(" · ")}`; } else { n++; t.why = `릴스·스레드용으로 줄였습니다 (${요약})`; }
      t.at = iso(T());
    }
    x.state = "끝";
    if (n) { j.file = fin; j.info = { w: ni.w, h: ni.h, sec: 소수(ni.sec), mb: 소수(ni.mb), codec: ni.codec }; x.src = ""; }
    settle(j, T());
    return n;
  });
  if (kept) await 지우기(sh.src); else await 지우기(fin);
  const 초 = Math.round((performance.now() - 시작) / 1000);
  await recordLine("올리기.log", `영상 줄임  ${tag}  ${요약}  (${used} · ${초}초)${Object.keys(틀림).length ? "  규격 미달: " + Object.keys(틀림).map((p) => 이름[p as Provider]).join("·") : ""}`);
  say(`  영상 줄임  ${tag}  ${요약}`);
  if (kept) out.shrunk++;
  await cleanup(id, T());
}

/**
 * 올려도 되는 일감을 실제로 올린다. 올릴 것이 없으면 메타를 한 번도 부르지 않는다.
 * 다른 곳에서 이미 돌고 있으면(예약 작업·화면의 「지금 올리기」) 기다리지 않고 busy 로 돌아간다 — 두 군데서 같은 영상을 올리지 않게.
 * 릴스·스레드용으로 줄여야 하는 영상은 올릴 것을 모두 올린 뒤 한 번에 한 건만 줄인다(바로 올릴 때가 됐으면 이어서 올린다).
 */
export async function run(c: RunCtx = {}): Promise<RunResult> {
  const out: RunResult = { posted: 0, failed: 0, unknown: 0, waiting: 0, busy: false, shrunk: 0 };
  const ctx = { ...c, now: c.now ?? c.clock?.() ?? new Date(), fixed: !!c.now };
  const got = await withFileLock(dataPath(".메타올리기.run.lock"), async () => {
    try { await pruneOld(ctx.now); } catch { /* 청소는 올리기를 막지 않는다 */ }
    try { await 끊긴줄이기정리(); } catch { /* 정리는 올리기를 막지 않는다 */ }
    const 때됨 = (j: MetaJob) => j.phase === "진행" && (!j.go_after || Date.parse(j.go_after) <= ctx.now.getTime());
    const 올리기 = async (id: string) => {
      const j = loadJobs().jobs[id];
      if (!j) return;
      for (const p of PROVIDERS) {
        const t = loadJobs().jobs[id]?.targets[p];
        if (!t) continue;
        try { await runTarget(id, p, ctx, out); } catch (e) { await recordLine("올리기.log", `${이름[p]} 오류  [${j.channel}] ${msgOf(e)}`); out.failed++; }
      }
      await cleanup(id, ctx.now);
    };
    const due = Object.values(loadJobs().jobs).filter(때됨).sort((a, b) => a.made.localeCompare(b.made));
    for (const j of due) {
      if (줄이기남음(j)) { out.waiting++; continue; }
      await 올리기(j.id);
    }
    // 줄이기 — 한 번에 한 건 (오래 걸린다). 줄이는 데 실패해도 위에서 한 올리기·유튜브 일에는 번지지 않는다.
    try {
      const id = 줄일일감();
      if (id) {
        await shrinkJob(id, ctx, out);
        const j = loadJobs().jobs[id];
        if (j && 때됨(j) && !줄이기남음(j)) await 올리기(id);
      }
    } catch (e) { await recordLine("올리기.log", `영상 줄이기 오류  ${msgOf(e)}`); }
    // 지우지 못한 임시 보관본은 몇 번 더 지워 본다
    for (const j of Object.values(loadJobs().jobs)) {
      const s = j.staged;
      if (j.phase === "끝" && s && !s.deleted && s.delete_why && (s.delete_tries ?? 0) < 3 && Date.parse(s.delete_at ?? "") + 10 * 분 <= ctx.now.getTime()) await deleteStaged(j.id, stamp(ctx)).catch(() => {});
    }
    // 결과불명으로 남은 것은 공개 시각과 관계없이 읽어 본다
    for (const j of Object.values(loadJobs().jobs)) {
      if (j.phase !== "끝") continue;
      for (const p of PROVIDERS) if (j.targets[p]?.state === "결과불명") await autoCheck(j.id, p, stamp(ctx)).catch(() => {});
    }
    return true;
  }, { wait: false });
  if (got === null) out.busy = true;
  return out;
}

/** 오래된 일감 하나를 지금 올려 본다 (화면의 「지금 올리기」·다시 시도 뒤) — 같은 run 을 쓴다 */
export const runNow = run;

/* ============================================================ 화면이 쓰는 것 */

export interface TargetView {
  provider: Provider; name: string; account: string; username: string; state: TState; why: string; url: string; media_id: string; tries: number;
  /** 화면이 보일 단추: retry(다시 시도) · check(올라갔는지 확인) · resolve(사람이 확인해 정함) */
  actions: string[];
  route: string;
}
export interface JobView {
  id: string; channel: string; title: string; made: string; phase: string; yt_url: string; go_after: string; kind: string;
  /** 릴스·스레드용으로 줄이는 중이면 「대기」 또는 「줄이는중」, 아니면 빈 글 */
  shrink: string;
  targets: TargetView[]; cancelable: boolean;
}

/** 최근 일감들 — ★토큰 값은 없다 */
export function listJobs(limit = 30): JobView[] {
  return Object.values(loadJobs().jobs)
    .sort((a, b) => b.made.localeCompare(a.made))
    .slice(0, limit)
    .map((j) => ({
      id: j.id, channel: j.channel, title: j.title, made: j.made, phase: j.phase, yt_url: j.yt_url, go_after: j.go_after ?? "", kind: j.kind,
      shrink: 줄이기남음(j) ? j.shrink!.state : "",
      cancelable: Object.values(j.targets).some((t) => t && t.state === "대기"),
      targets: PROVIDERS.flatMap((p) => {
        const t = j.targets[p];
        if (!t) return [];
        const actions: string[] = [];
        if (t.state === "실패") actions.push("retry");
        if (t.state === "결과불명") actions.push("check", "resolve");
        return [{
          provider: p, name: 이름[p], account: t.account, username: t.username, state: t.state, why: t.why ?? "", url: t.url ?? "", media_id: t.media_id ?? "",
          tries: t.tries, actions, route: t.route ?? "",
        }];
      }),
    }));
}

/** 실패한 올리기를 사람이 다시 시도하게 한다 (영상 파일이 남아 있어야 한다) */
export async function retryTarget(id: string, p: Provider, o: { now?: Date } = {}): Promise<void> {
  const now = o.now ?? new Date();
  const ok = await updateJobs((l) => {
    const j = l.jobs[id];
    const t = j?.targets[p];
    if (!j || !t || t.state !== "실패") return "「실패」인 것만 다시 시도할 수 있습니다";
    // 영상을 줄이다 실패한 것은 줄이기부터 다시 한다(원본 사본이 남아 있어야 한다)
    const 줄여야함 = j.shrink?.state === "실패" && j.shrink.needs.includes(p);
    if (줄여야함) { if (!j.shrink!.src || !existsSync(j.shrink!.src)) return "영상 사본이 이미 정리되어 다시 줄일 수 없습니다"; }
    else if (!j.file || !existsSync(j.file)) return "영상 사본이 이미 정리되어 다시 올릴 수 없습니다";
    if (줄여야함) { j.shrink!.state = "대기"; j.shrink!.tries = 0; j.file = ""; }
    t.state = "대기"; t.tries = 0; delete t.container; delete t.next_at; delete t.route; delete t.routes_failed; delete t.requested_at;
    t.why = "사람이 다시 시도를 눌렀습니다"; t.at = iso(now);
    j.phase = "진행"; j.go_after = iso(now); delete j.done_at;
    return "";
  });
  if (ok) throw new Error(ok);
}

/** 올라갔는지 모르는 것을 사람이 확인해 정한다. 「안 올라갔다」를 고른 때에만 다시 올릴 수 있게 된다. */
export async function resolveTarget(id: string, p: Provider, outcome: "올림" | "안올라감", o: { now?: Date; url?: string } = {}): Promise<void> {
  const now = o.now ?? new Date();
  const bad = await updateJobs((l) => {
    const j = l.jobs[id];
    const t = j?.targets[p];
    if (!j || !t || t.state !== "결과불명") return "「결과불명」인 것만 정할 수 있습니다";
    if (outcome === "올림") {
      t.state = "올림"; t.why = "사람이 올라간 것을 확인했습니다"; if (o.url) t.url = o.url.slice(0, 300);
    } else {
      if (!j.file || !existsSync(j.file)) return "영상 사본이 이미 정리되어 다시 올릴 수 없습니다";
      t.state = "대기"; t.tries = 0; delete t.container; delete t.next_at; delete t.route; delete t.routes_failed; delete t.requested_at;
      t.why = "사람이 올라가지 않은 것을 확인해 다시 올립니다";
      j.phase = "진행"; j.go_after = iso(now); delete j.done_at;
    }
    t.at = iso(now);
    settle(j, now);
    return "";
  });
  if (bad) throw new Error(bad);
  await recordLine("올리기.log", `${이름[p]} 사람이 확인  ${id}  ${outcome}`);
  await cleanup(id, now);
}

/** 아직 시작 안 한 올리기를 접는다 */
export async function cancelJob(id: string, o: { now?: Date } = {}): Promise<boolean> {
  const now = o.now ?? new Date();
  const hit = await updateJobs((l) => {
    const j = l.jobs[id];
    if (!j) return false;
    let any = false;
    for (const t of Object.values(j.targets)) if (t && t.state === "대기") { t.state = "취소"; t.why = "사람이 취소했습니다"; t.at = iso(now); any = true; }
    settle(j, now);
    return any;
  });
  if (hit) { await recordLine("올리기.log", `인스타·스레드 취소  ${id}`); await cleanup(id, now); }
  return hit;
}

/** 화면 상단에 보일 요약 한 줄 */
export function summary(): { waiting: number; unknown: number; failed: number } {
  let waiting = 0, unknown = 0, failed = 0;
  for (const j of Object.values(loadJobs().jobs)) {
    for (const t of Object.values(j.targets)) {
      if (!t) continue;
      if (활동.has(t.state)) waiting++;
      else if (t.state === "결과불명") unknown++;
      else if (t.state === "실패") failed++;
    }
  }
  return { waiting, unknown, failed };
}

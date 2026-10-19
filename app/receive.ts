// 영상 받기 — 승인한 영상을 채널 폴더로 **복사**하고 발사대기에 담는다. (파이썬: 가라사대받기.py)
//
//   받기 <채널> <영상.mp4> [--쪽지 쪽지.json] [--제목 ..] [--설명파일 ..] [--공개 "YYYY-MM-DD HH:MM"] [--칸 "09:15,15:15"] [--즉시]
//
//  · 영상은 **복사**한다 — 원본은 그대로 둔다.
//  · 채널 폴더에 영상 + 제목 파일(.txt)을 두고, 발사대기에 담는다.
//  · 공개 시각: --공개 > 쪽지의 publishAt(앞으로의 시각일 때) > 그 채널의 마지막 예약 + 2시간.
//    0~7시 칸은 07:00 으로 민다. 올리기는 공개 24시간 전(늦어도 지금)에 한다.
//  · 올라가면 folders.markDone 이 이 폴더의 영상·제목 파일을 정리한다(휴지통 또는 업로드완료).
//
//  쇼츠/롱폼 구분(파이썬과 같다)
//  · 종류는 사용자가 우기는 것이 아니라 **실제 파일**(길이·화면비)로 정한다. 롱폼은 쇼츠 조건(9:16·3분)을 재지 않는다.
//  · 공개 시각은 롱폼끼리/쇼츠끼리 따로 셈한다. 쇼츠의 「마지막 예약 + 2시간」 셈에 롱폼이 들어가면
//    며칠 앞 롱폼 예약 뒤로 쇼츠가 통째로 밀린다. 롱폼은 --칸 의 하루 시각 중 롱폼 마지막 예약 다음 칸(지금+3시간 뒤).
//  · 롱폼은 영상 옆 「*썸네일*」 그림을 같은 이름 그림으로 복사해 맞춤 썸네일로 올린다(2MB 넘으면 jpg 로 줄임).
import { baseName, dirName, extOf, IS_MAC, IS_WIN, join, stemOf } from "./paths.ts";
import {
  addHours, addMinutes, instantToWall, isoWall, minuteWall, parseInstant, parseNaive, parseWall, shortWall, systemZone, wall,
  wallNow, type Wall,
} from "./clock.ts";
import { ledgerRowIsLong, normalizeJob, classify, probe } from "./shorts.ts";
import { readLedger } from "./ledger.ts";
import { loadPending } from "./review.ts";
import { add, list as queueList, fire } from "./queue.ts";
import { type ChannelConf, loadChannels } from "./channels.ts";
import { notePath, readNote, readSections, type Note } from "./sidecar.ts";
import { ytFor } from "./ytcore.ts";
import { aiUsable } from "./ai.ts";
import { playlistItems, uploadsPlaylistId } from "./youtube.ts";
import { policyForChannel } from "./daily.ts";
import { checkText, cleanForRule, fitTags } from "./metacheck.ts";
import { findTool } from "./tools.ts";
import { expandHome } from "./folders.ts";

type Obj = Record<string, any>;

/** 공개 간격 — 같은 꼴끼리 이만큼 벌린다 (파이썬 간격 = 2시간) */
export const GAP_HOURS = 2;
/** 썸네일 한도 */
const THUMB_MAX = 2 * 1024 * 1024;

export interface ReceiveOpts {
  /** 쪽지(json) 경로. 없으면 영상 옆 같은 이름 .json 을 찾는다 */
  note?: string;
  title?: string;
  descFile?: string;
  /** 공개 시각 "YYYY-MM-DD HH:MM" (이 컴퓨터 시각) */
  publishAt?: string;
  /** 승인 표시 — 발사대기 일감의 승인 표시·출구 기록에 그대로 남는다 */
  who?: string;
  /** 롱폼 하루 공개 칸 "09:15,15:15" */
  slots?: string[];
  /** 바로 올린다(공개 예약은 유지) */
  now?: boolean;
  say?: (line: string) => void;
  /** 시험이 시계를 바꿔 끼운다 */
  clock?: Date;
  /** 유튜브 중복 확인을 시험이 대신한다 */
  youtubeHas?: (key: string, names: string[]) => Promise<string>;
  /** 즉시 쏘기를 시험이 대신한다 */
  fireNow?: (file: string) => Promise<number>;
}

export interface ReceiveResult {
  dst: string;
  long: boolean;
  /** 공개 시각 (벽시계) */
  publishAt: string;
  /** 올리기 시각 */
  fireAt: string;
  thumb: string | null;
  /** 이미 발사대기에 있어 파일만 새것으로 바꿨다 */
  replaced: boolean;
}

/* ============================================================ 채널 찾기 */

/** 채널 이름(별칭) 또는 채널ID → [별칭, 설정]. 못 찾으면 쓸 수 있는 이름을 알려 준다. (파이썬 짝) */
export function findChannel(name: string): [string, ChannelConf] {
  const chans = loadChannels();
  if (chans[name]) return [name, chans[name]];
  for (const [k, v] of Object.entries(chans)) if (v.channel_id && v.channel_id === name) return [k, v];
  const names = Object.keys(chans);
  throw new Error(`모르는 채널: ${name} — 쓸 수 있는 것: ${names.length ? names.join(", ") : "(아직 연결한 채널이 없습니다)"}`);
}

/** 같은 channel_id 를 가진 칸 이름 전부 (쇼츠용·롱폼용 두 칸이 한 유튜브 채널일 때 · 파이썬 _같은채널).
 * 원장·pending 의 채널 칸은 upload 가 resolve 로 토큰 첫 이름으로 적으니, 칸 이름으로만 찾으면 제 기록을 놓친다. */
export function sameChannelKeys(key: string): Set<string> {
  const chans = loadChannels();
  const cid = chans[key]?.channel_id;
  const out = new Set<string>([key]);
  for (const [n, v] of Object.entries(chans)) if (cid && v.channel_id === cid) out.add(n);
  return out;
}

/* ============================================================ 자료 모으기 */

/** 쪽지 > 영상 옆 곁파일 > .기록.json  →  (제목, 설명, 해시태그, 공개, 비공개태그)  (파이썬 _자료모으기) */
async function gather(video: string, notePathArg?: string): Promise<{
  title: string; desc: string; tags: string[]; publishAt: string | null; privateTags: string[]; note: Note | null;
  /** 제목을 실제로 어디선가 받았나(쪽지·곁글·기록) — false 면 title 은 파일 이름으로 메운 것이다 */
  titleGiven: boolean;
}> {
  let 제목 = "", 설명 = "";
  let 태그: string[] = [];
  let 비공개: string[] = [];
  let 공개: string | null = null;
  let note: Note | null = null;
  const 쪽지 = notePathArg ?? (await Deno.stat(notePath(video)).then(() => notePath(video), () => ""));
  if (쪽지) {
    note = await readNote(쪽지);
    if (!note && notePathArg) throw new Error(`쪽지를 읽지 못했습니다: ${notePathArg}`);
    if (note) {
      제목 = note.title ?? "";
      설명 = note.description ?? "";
      공개 = note.publishAt ?? null;
      비공개 = note.tags ?? [];
    }
  }
  const 옆 = [join(dirName(video), "유튜브_설명과태그.txt"), join(dirName(video), stemOf(baseName(video)) + ".txt")];
  for (const f of 옆) {
    if (!제목) {
      try {
        const st = await Deno.stat(f);
        if (st.isFile) {
          const r = readSections((await Deno.readTextFile(f)).replace(/^﻿/, ""));
          제목 = r.title; 설명 = r.desc; 태그 = r.tags;
        }
      } catch { /* 없으면 다음 */ }
    }
  }
  const 기록 = join(dirName(video), stemOf(baseName(video)) + ".기록.json");
  if (!제목) {
    try {
      제목 = String((JSON.parse(await Deno.readTextFile(기록)) as Obj).제목흰 ?? "") || "";
    } catch { /* 없으면 그만 */ }
  }
  if (!태그.length && 설명.trim()) {
    const 마지막 = 설명.split(/\r?\n/).pop() ?? "";
    태그 = 마지막.match(/#\S+/g) ?? [];
  }
  return { title: 제목 || stemOf(baseName(video)), desc: 설명, tags: 태그, publishAt: 공개, privateTags: 비공개, note, titleGiven: !!제목 };
}

/**
 * 채널 폴더 곁파일(.txt)의 글 — 올릴 때 sidecar.parseText 가 읽는다([해시태그] 칸은 설명 맨 아래에 붙는다).
 * ★비어 있는 칸은 쓰지 않는다 — 빈 「[제목]」 칸이나 파일 이름으로 메운 제목이 txt 에 박히면 사람이 정한 것으로 보여
 *   AI 자동 문안이 그 칸을 채우지 못한다(우선순위: 사람이 고친 것 > 쪽지 > 자동 > 파일 이름).
 */
export function sideText(t: string, d: string, tags: string[]): string {
  const 칸: string[] = [];
  if (t.trim()) 칸.push(`[제목]\n${t}`);
  if (d.trim()) 칸.push(`[설명]\n${d}`);
  if (tags.length) 칸.push(`[해시태그]\n${tags.join(" ")}`);
  return 칸.length ? 칸.join("\n\n") + "\n" : "";
}

/** 일감의 유튜브 태그 칸 — 해시태그(# 뗌). 문안 규격이 있고 쪽지에 비공개 태그가 있으면 한도(500자)에 맞춰 싣는다. (파이썬 _태그칸) */
function tagField(cf: ChannelConf, tags: string[], privateTags: string[]): string[] {
  const 칸 = tags.map((x) => x.replace(/^#+/, ""));
  if (cf.meta_rule && Object.keys(cf.meta_rule).length && privateTags.length) {
    const fit = fitTags(privateTags);
    return fit.length ? fit : 칸;
  }
  return 칸;
}

/* ============================================================ 중복 막기 */

const norm = (x: string) => String(x ?? "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

/** 장부(원장)에 같은 파일·같은 제목이 이미 있나. 있으면 까닭 글, 없으면 "" (파이썬 _이미올렸나) */
export function alreadyUploaded(key: string, 이름: string, 제목: string): string {
  const 같은 = sameChannelKeys(key); // 롱폼·쇼츠 두 칸이 한 유튜브 채널 — 채널 단위로 중복을 본다
  for (const r of readLedger()) {
    if (!같은.has(r["채널"] ?? "")) continue;
    if (baseName(r["파일"] ?? "") === 이름) return `같은 파일이 이미 올라갔다 — https://youtu.be/${r["영상ID"]}`;
    if (제목 && (r["제목"] ?? "").trim() === 제목.trim()) return `같은 제목이 이미 올라갔다 — https://youtu.be/${r["영상ID"]}`;
  }
  return "";
}

/** 그 채널 유튜브에 같은 제목(또는 제목을 품은 제목)이 이미 있나 — 다른 프로그램으로 올린 것까지 잡는다. 최근 300편. (파이썬 _유튜브에있나) */
export async function onYoutube(key: string, names: string[]): Promise<string> {
  const 찾을것 = names.map(norm).filter((x) => x.length >= 6);
  if (!찾을것.length) return "";
  const [alias, cf] = findChannel(key);
  const yt = await ytFor(alias);
  const cid = cf.channel_id || yt.entry.channel_id;
  if (!cid) return "";
  const up = uploadsPlaylistId(cid);
  let tok: string | undefined;
  for (let i = 0; i < 6; i++) {
    const r = await playlistItems(yt, up, { part: "snippet", maxResults: 50, pageToken: tok });
    for (const it of r.items ?? []) {
      const t = String(it.snippet?.title ?? "");
      if (찾을것.some((k) => k && norm(t).includes(k))) {
        return `유튜브에 이미 있다 — 「${t}」 https://youtu.be/${it.snippet?.resourceId?.videoId}`;
      }
    }
    tok = r.nextPageToken;
    if (!tok) break;
  }
  return "";
}

/* ============================================================ 공개 시각 셈 */

/** 0~7시 칸은 07:00 으로 민다 (파이썬 _칸) */
function dayStart(t: Wall): Wall {
  return t.getUTCHours() < 7 ? wall(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 7, 0, 0) : t;
}

/** 시각 글(Z·오프셋 있든 없든) → 이 컴퓨터 벽시계 */
function toLocalWall(text: string): Wall | null {
  const t = parseInstant(text);
  return t ? instantToWall(t, systemZone()) : null;
}

/**
 * 그 채널의 마지막 공개 예약 — **같은 꼴끼리만**(쇼츠는 쇼츠, 롱폼은 롱폼). (파이썬 _마지막예약)
 * 이미 쏜 것은 발사대기·pending 에서 빠지므로 장부까지 본다 — 안 그러면 앞 편들이 다 발사된 뒤 넘긴 편이 「지금+50분」으로 떨어져
 * 앞 편들보다 먼저 공개된다(실측).
 */
export async function lastReservation(key: string, long: boolean): Promise<Wall | null> {
  const 같은 = sameChannelKeys(key);
  const cid = loadChannels()[key]?.channel_id;
  const ts: Wall[] = [];
  const rows = readLedger();
  const 롱id = new Set<string>();
  for (const r of rows) if (같은.has(r["채널"] ?? "") && ledgerRowIsLong(r)) 롱id.add((r["영상ID"] ?? "").trim());
  for (const j of queueList()) {
    if (j.channel !== cid || !j.publish_at) continue;
    // 파일이 보이면 저장된 옛 표시보다 실제 종류를 우선한다.
    let actual: Obj = j;
    try { if ((await Deno.stat(String(j.file))).isFile) actual = await normalizeJob(j); } catch { /* 파일이 안 보이면 저장된 표시 */ }
    if (!!(actual.롱폼 || actual.allow_not_short) !== long) continue;
    const t = parseNaive(String(j.publish_at));
    if (t) ts.push(t);
  }
  for (const it of loadPending()) {
    const p = it.publish_at;
    if (!같은.has(String(it.channel)) || !p) continue;
    if (롱id.has(String(it.video_id ?? "")) !== long) continue;
    const t = toLocalWall(p);
    if (t) ts.push(t);
  }
  for (const r of rows) {
    if (!같은.has(r["채널"] ?? "") || !(r["예약시각"] ?? "")) continue;
    // 꼴은 safety 의 롱폼 줄 잣대와 같다 (길이초·해상도만 본다)
    if (ledgerRowIsLong({ "길이초": r["길이초"], "해상도": r["해상도"] }) !== long) continue;
    const t = parseNaive(r["예약시각"]);
    if (t) ts.push(t);
  }
  return ts.length ? new Date(Math.max(...ts.map((x) => x.getTime()))) : null;
}

/**
 * 롱폼 하루 칸(예: 09:15·15:15) 중 롱폼 마지막 예약 뒤·지금+3시간 뒤의 첫 칸. (파이썬 _다음칸)
 * 3시간 = 올리기(10분 주기) + 30분 뒤 첫 확인 + 9분짜리 처리 덜 끝나 한 번 더 도는 1시간 — 90분이면
 * 확인이 예약 시각을 넘겨 「지금 공개」로 어긋날 수 있다.
 */
export async function nextSlot(key: string, slots: string[], now: Wall): Promise<Wall> {
  const 시각들 = slots.map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(x);
    if (!m) throw new Error(`칸 시각을 읽지 못했습니다: ${x} (예: 09:15)`);
    return [+m[1], +m[2]] as [number, number];
  }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!시각들.length) throw new Error("롱폼 칸이 비었습니다");
  const 끝 = await lastReservation(key, true);
  const 바닥 = new Date(Math.max(addHours(now, 3).getTime(), 끝 ? addMinutes(끝, 1).getTime() : now.getTime()));
  let 날 = wall(바닥.getUTCFullYear(), 바닥.getUTCMonth() + 1, 바닥.getUTCDate());
  for (let i = 0; i < 400; i++) {
    for (const [h, m] of 시각들) {
      const 후보 = wall(날.getUTCFullYear(), 날.getUTCMonth() + 1, 날.getUTCDate(), h, m);
      if (후보.getTime() >= 바닥.getTime()) return 후보;
    }
    날 = new Date(날.getTime() + 86_400_000);
  }
  throw new Error("롱폼 칸을 못 찾았다");
}

/* ============================================================ 썸네일 */

async function run(cmd: string, args: string[]): Promise<boolean> {
  try {
    const r = await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).output();
    return r.success;
  } catch { return false; }
}

/** 2MB 를 넘는 그림을 jpg 로 줄인다: 맥은 sips, 그 밖(또는 맥에서 실패)은 ffmpeg, 윈도우는 PowerShell 순서로. (파이썬은 sips 만) */
export async function shrinkImage(src: string, out: string): Promise<boolean> {
  // 명령이 0 으로 끝났다고 믿지 않는다 — 맥의 sips 는 입력을 못 읽어도 0 으로 끝난다. 결과 파일이 실제로 생겼고 2MB 이하인지 본다.
  const 됐나 = async () => { try { const s = await Deno.stat(out); return s.isFile && s.size > 0 && s.size <= THUMB_MAX; } catch { return false; } };
  if (IS_MAC && await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", src, "--out", out]) && await 됐나()) return true;
  const ff = await findTool("ffmpeg");
  if (ff && await run(ff, ["-y", "-loglevel", "error", "-i", src, "-q:v", "4", out]) && await 됐나()) return true;
  if (IS_WIN) {
    const ps = `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${src.replace(/'/g, "''")}'); ` +
      `$i.Save('${out.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Jpeg); $i.Dispose()`;
    if (await run("powershell", ["-NoProfile", "-Command", ps]) && await 됐나()) return true;
  }
  try { await Deno.remove(out); } catch { /* 없으면 그만 */ }
  return false;
}

const IMG = [".png", ".jpg", ".jpeg"];

async function exists(p: string): Promise<boolean> { try { await Deno.stat(p); return true; } catch { return false; } }

/**
 * 맞춤 썸네일 — 영상 옆 그림을 dst 와 같은 이름으로 둔다(upload 의 findThumb 이 줍는다). (파이썬 _썸네일붙이기)
 * 찾는 순서: ① 쪽지의 thumbnail ② 영상과 같은 이름 그림 ③ 영상 옆 「*썸네일*」 그림(롱폼만 — 파이썬과 같다)
 */
export async function attachThumb(mp4: string, dst: string, long: boolean, note?: Note | null): Promise<string | null> {
  const 후보: string[] = [];
  if (note?.thumbnail) {
    const p = note.thumbnail.startsWith("/") || /^[A-Za-z]:[\\/]/.test(note.thumbnail) ? note.thumbnail : join(dirName(mp4), note.thumbnail);
    if (await exists(p)) 후보.push(p);
  }
  for (const x of IMG) {
    const p = join(dirName(mp4), stemOf(baseName(mp4)) + x);
    if (await exists(p)) 후보.push(p);
  }
  if (long) {
    const names: string[] = [];
    for await (const e of Deno.readDir(dirName(mp4))) if (e.isFile && e.name.includes("썸네일") && IMG.includes(extOf(e.name).toLowerCase())) names.push(e.name);
    names.sort();
    for (const n of names) 후보.push(join(dirName(mp4), n));
  }
  if (!후보.length) return null;
  const src = 후보[0];
  const dstStem = join(dirName(dst), stemOf(baseName(dst)));
  for (const 옛 of IMG) {
    const p = dstStem + 옛;
    if (p !== src && await exists(p)) await Deno.remove(p);
  }
  if ((await Deno.stat(src)).size <= THUMB_MAX) {
    const out = dstStem + extOf(src).toLowerCase();
    if (out !== src) await Deno.copyFile(src, out);
    return out;
  }
  const out = dstStem + ".jpg";
  if (!(await shrinkImage(src, out))) throw new Error(`썸네일이 2MB를 넘는데 줄이지 못했습니다 — ${baseName(src)} (맥은 기본 도구, 그 밖은 ffmpeg 가 있으면 줄입니다. 그림을 2MB 아래로 줄여 주세요)`);
  return out;
}

/* ============================================================ 넘기기 */

/** 승인한 영상을 채널 폴더로 복사하고 발사대기에 담는다. (파이썬 넘기기) */
export async function receive(channel: string, video: string, o: ReceiveOpts = {}): Promise<ReceiveResult> {
  const say = o.say ?? console.log;
  const [key, cf] = findChannel(channel);
  const mp4 = expandHome(video);
  let st: Deno.FileInfo | null = null;
  try { st = await Deno.stat(mp4); } catch { /* 아래 */ }
  if (!st?.isFile) throw new Error(`영상이 없다: ${mp4}`);
  if (!cf.folder) throw new Error(`[${key}] 채널에 폴더가 아직 없습니다. 채널 탭에서 폴더를 정해 주세요.`);

  // 종류는 실제 파일로 정한다 (--롱폼 같은 우김은 따르지 않는다)
  const long = classify(await probe(mp4)) === "롱폼";
  const g = await gather(mp4, o.note);
  let t = g.title, d = g.desc, tags = g.tags;
  if (o.title) t = o.title;
  if (o.descFile) d = await Deno.readTextFile(o.descFile);
  // 제목을 실제로 받았나 — 아니면 곁글을 쓰지 않는다(파일 이름으로 메운 제목이 txt 에 박히면 사람이 정한 것으로 보여 AI 자동 문안이 못 채운다)
  const 제목줌 = g.titleGiven || !!o.title;
  const 곁글 = () => sideText(제목줌 ? t : "", d, tags);
  const 곁글쓰기 = async (폴더: string, 이름: string) => {
    const 글 = 곁글();
    if (글) await Deno.writeTextFile(join(폴더, stemOf(이름) + ".txt"), 글);
  };
  const 이름 = stemOf(baseName(mp4)) + extOf(baseName(mp4));
  const 폴더 = expandHome(cf.folder);
  const dst = join(폴더, 이름);

  // ── 문안 규격(채널 설정의 meta_rule) — 복사·발사대기 담기 **전에** 잰다 ────────────
  //   담은 뒤에 경고만 찍으면 흠 있는 편이 큐에 남은 채 10분마다 출구에서 막힌다. 못 지나면 넘기지 않는다.
  //   재는 글은 아래에서 채널 폴더에 쓸 곁파일 글 그대로, 비공개 태그도 일감에 실릴 그대로다.
  //   (제목이 없고 AI 가 올리기 직전에 지을 채널이면 지금은 잴 글이 없다 — 지은 글은 올리기 직전에 같은 규격으로 잰다)
  const AI가채움 = !제목줌 && aiUsable(key).ok;
  if (cf.meta_rule && Object.keys(cf.meta_rule).length && !AI가채움) {
    [t, d, tags] = (() => { const r = cleanForRule(cf.meta_rule!, t, d, tags); return [r.title, r.desc, r.tags]; })();
    const 흠 = checkText(cf.meta_rule, sideText(t, d, tags), tagField(cf, tags, g.privateTags));
    if (흠.length) throw new Error(`넘기지 않는다 — 문안 규격 미달(${흠.join(", ")}). 곁파일·쪽지를 고쳐 다시 넘기세요`);
  }

  // ── 같은 편이 아직 안 쏜 채 발사대기에 있나 ────────────────────────────────────
  const 큐에 = queueList().find((x) => x.file === dst);
  if (큐에) {
    if (!long) {
      // 담기는 같은 파일이면 쏠 시각만 고쳐 공개 시각·태그는 옛것, 영상·곁파일만 새것이 된다 — 다시 구운 편을 또 넘길 때. 두 번 담지 않는다.
      throw new Error(
        `넘기지 않는다 — 이미 발사대기에 있다: [${key}] ${이름}  공개 ${큐에.publish_at} · 올리기 ${String(큐에.쏠때 ?? "").slice(0, 16)} — ` +
          "같은 편을 두 번 담지 않는다(새 판으로 바꾸려면 발사대기에서 그 편을 먼저 뺀다)",
      );
    }
    // 같은 롱폼을 두 번 넘기면 칸을 다시 셈해 publish_at 과 쏠때가 어긋난다 — 칸은 그대로 두고 파일만 새것으로(완성 뒤 고쳐 다시 구운 판)
    await Deno.mkdir(폴더, { recursive: true });
    await Deno.copyFile(mp4, dst);
    await 곁글쓰기(폴더, 이름);
    const 표지 = await attachThumb(mp4, dst, long, g.note);
    say(`  · 이미 발사대기에 있다: [${key}] ${이름}  공개 ${큐에.publish_at} · 올리기 ${String(큐에.쏠때 ?? "").slice(0, 16)} — 칸은 그대로, 파일만 새것으로`);
    return { dst, long, publishAt: String(큐에.publish_at ?? ""), fireAt: String(큐에.쏠때 ?? ""), thumb: 표지, replaced: true };
  }

  const 왜 = alreadyUploaded(key, 이름, t) || await (o.youtubeHas ?? onYoutube)(key, [t, stemOf(baseName(mp4))]);
  if (왜) throw new Error(`넘기지 않는다 — ${왜}`);

  await Deno.mkdir(폴더, { recursive: true });
  let 같음 = false;
  try { 같음 = (await Deno.stat(dst)).size === st.size; } catch { /* 없다 */ }
  if (!같음) await Deno.copyFile(mp4, dst); // ★복사 — 원본은 그대로
  await 곁글쓰기(폴더, 이름);
  const 표지 = await attachThumb(mp4, dst, long, g.note);

  const 지금 = (() => { const w = wallNow(systemZone(), o.clock); return new Date(Math.floor(w.getTime() / 60_000) * 60_000); })();
  let when: Wall | null = null;
  const 승인형 = policyForChannel(key);
  for (const 후보 of [o.publishAt, g.publishAt]) {
    if (!후보) continue;
    const x = toLocalWall(String(후보));
    if (!x) continue;
    const 최소분 = 승인형?.cfg.schema === "approved-daily-v1" ? 2 : 45;
    if (x.getTime() > addMinutes(지금, 최소분).getTime()) { when = x; break; }
  }
  if (!when && 승인형?.cfg.schema === "approved-daily-v1") when = addMinutes(지금, Number(승인형.cfg.publish_delay_minutes ?? 10));
  const 칸 = o.slots?.length ? o.slots : (Array.isArray(cf.long_slots) ? cf.long_slots as string[] : undefined);
  if (!when && long && 칸) when = await nextSlot(key, 칸, 지금);
  if (!when) {
    const 끝 = await lastReservation(key, long);
    when = dayStart(new Date(Math.max(addMinutes(지금, 50).getTime(), 끝 ? addHours(끝, GAP_HOURS).getTime() : 지금.getTime())));
  }
  let 쏠때 = new Date(Math.max(지금.getTime(), addHours(when, -24).getTime()));
  if (o.now) 쏠때 = 지금;

  const job: Obj = {
    channel: cf.channel_id || key, file: dst, title: "", desc: "",
    tags: tagField(cf, tags, g.privateTags), publish_at: minuteWall(when),
    approved_by: String(cf.approved_by ?? ""), allow_not_short: long, time_by: "user",
    _승인: `${o.who || "사람 승인"} (${minuteWall(지금)})`,
  };
  if (long) job.롱폼 = true;
  // 영상 쪽지가 이 영상만 인스타·스레드를 켜거나 껐다면 올릴 때까지 일감에 실어 둔다(쪽지 json 은 채널 폴더로 복사되지 않는다)
  if (g.note && (g.note.instagram !== undefined || g.note.threads !== undefined)) job.메타올림 = { instagram: g.note.instagram, threads: g.note.threads };
  await add(job, isoWall(쏠때), say);
  // 일일 한도로 조정된 실제 큐 시각을 표시하고, 미래 항목을 즉시 쏘지 않는다.
  const queued = queueList().find((row) => row.file === dst);
  let 공개표시 = when, 올리기표시 = 쏠때;
  if (queued) {
    공개표시 = parseNaive(String(queued.publish_at)) ?? when;
    올리기표시 = parseNaive(String(queued.쏠때)) ?? 쏠때;
  }
  say(`  · 발사대기에 담았다: [${key}] ${이름}  공개 ${shortWall(공개표시)} · 올리기 ${shortWall(올리기표시)}` +
    (long ? ` · 롱폼 · 썸네일 ${표지 ? baseName(표지) : "없음"}` : ""));
  if (o.now && 올리기표시.getTime() <= wallNow(systemZone(), o.clock).getTime()) {
    say("  · 이 영상만 즉시 전송합니다");
    await (o.fireNow ?? ((f: string) => fire({ file: f, say })))(dst);
  } else if (o.now) {
    say("  · 하루 편수 한도로 미뤄졌다 — 해당 날짜에 자동 전송합니다");
  }
  return { dst, long, publishAt: minuteWall(공개표시), fireAt: isoWall(올리기표시), thumb: 표지, replaced: false };
}

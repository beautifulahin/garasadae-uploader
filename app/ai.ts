// AI 문안 — 영상마다, 채널마다 맞는 제목·설명·해시태그를 자동으로 짓는다. (2.0 부터 기본 켜짐)
//
// 사장님 지시(2026-10): 「제목, 설명, 해시태그도 각 사용자의 영상에 맞게 알아서 들어가게 셋팅해줘」.
//
// 어떻게 맞추나 — **영상 내용 + 그 채널의 말투**를 함께 AI 에게 준다
//   ① 영상 자체를 읽힌다(구글 AI 스튜디오 파일 올리기 → 읽기 → **곧바로 지움**). 너무 큰 영상은 작은 사본(앞 10분)으로.
//   ② 이미 받은 youtube.readonly 로 그 채널의 최근·잘된 영상들의 제목·설명·해시태그 표본을 읽어(하루 한 번 · 2유닛) 말투·길이·구성을 닮게 한다.
//   ③ 채널 설정: 말투 메모(tone) · 고정 설명 머리말/꼬리말 · 고정 해시태그 · 문안 규격(meta_rule) · 언어(audio_language).
//   ④ 꼴을 가른다: 쇼츠(180초 이하 세로·정사각)는 짧은 제목·짧은 설명·#shorts, 롱폼은 넉넉한 설명. 판정은 이식한 쇼츠 판정(shorts.ts) 그대로.
//
// 약속
//   · **열쇠는 사용자 각자의 것**(구글 AI 스튜디오 무료 등급). 앱에는 아무 열쇠도 없다. 열쇠가 없으면 지금처럼 파일 이름이 제목이 된다.
//   · 우선순위(칸마다): **사람이 화면에서 고친 것(.txt) > 쪽지(.json) > 자동 생성 > 파일 이름**. 자동으로 지은 것은 .txt 에 쓰지 않고 따로 기록한다
//     (그래야 사람이 정한 것으로 오해되지 않는다). 사람이 화면에서 고쳐 저장하면 그때 .txt 가 되어 그 칸은 「사람」이 된다.
//   · 지은 결과는 **문안 검사를 통과해야만** 쓴다(제목 100자·설명 5000자·태그 500자·< > 금지·채널 문안 규격). 안 되면 한 번 더 지어 보고, 그래도 안 되면 포기한다.
//   · 같은 영상은 결과를 기록해 다시 부르지 않는다(AI문안기록.json). 실패는 30분 뒤에 다시.
//   · **실패해도 업로드를 막지 않는다**(fail-open). 막히면 문제 목록에 한 줄 안내만 남는다.
//   · 열쇠 값은 화면·로그·응답 어디에도 나오지 않는다.
import { baseName, cut, dataPath, log, readJson, recordLine, withFileLock, writeJson } from "./paths.ts";
import { doFetch } from "./google.ts";
import { appSettings, saveAppSettings } from "./settings.ts";
import { type ChannelConf, confFor, type MetaRule } from "./channels.ts";
import { entryFor, ytFor } from "./ytcore.ts";
import { playlistItems, uploadsPlaylistId, videosList } from "./youtube.ts";
import { checkText, cleanForRule, countHangul, fitTags } from "./metacheck.ts";
import { DESC_MAX, loadForDetailed, TAG_MAX, TITLE_MAX } from "./sidecar.ts";
import type { Kind } from "./shorts.ts";
import { findTool } from "./tools.ts";
import { isoWall, wallNow } from "./clock.ts";

type Obj = Record<string, any>;

const 파일API = "https://generativelanguage.googleapis.com";
export const 기본모델 = "gemini-3.5-flash-lite"; // 실측 24초. flash 는 29초로 조금 낫다
/** 이보다 큰 영상·긴 영상은 작은 사본으로 읽힌다(올리는 데만 한참 걸리고 무료 등급도 버겁다) */
const 큰영상 = 300 * 1024 * 1024;
const 긴영상초 = 15 * 60;
/** 작은 사본의 길이 — 앞 10분이면 소재를 알기에 충분하다 */
const 사본초 = 10 * 60;
const 재시도분 = 30;

export const AI_FALLBACK_WHY = {
  off: "AI 문안이 꺼져 있습니다",
  noKey: "AI 열쇠가 없습니다 — 설정에서 열쇠를 넣으면 제목·설명·해시태그를 자동으로 지어 줍니다",
  chanOff: "이 채널은 AI 문안을 껐습니다",
} as const;

/* ============================================================ 설정·상태 */

export interface AiState {
  enabled: boolean; hasKey: boolean; model: string; needsKey: boolean;
  /** 열쇠를 넣었고 켜져 있다 — 헤더 단추가 「AI 연결됨 · 바꾸기」 로 바뀐다 */
  connected: boolean;
  /** 열쇠 입력 창을 아직 한 번도 안 보여 줬고 열쇠도 없다 — 화면이 한 번 띄운다 */
  needsPrompt: boolean;
}

/** 화면 상태(/api/state)에 싣는 칸 — 열쇠 값은 없다 */
export function aiState(): AiState {
  const s = appSettings();
  const hasKey = !!s.aiKey.trim();
  return { enabled: !!s.aiTitles, hasKey, model: s.aiModel || "", needsKey: !!s.aiTitles && !hasKey, connected: hasKey && !!s.aiTitles, needsPrompt: !s.aiPrompted && !hasKey };
}

/** 입력 창을 봤다고 기록한다 (「나중에」·닫기) — 다시 자동으로 띄우지 않는다 */
export async function markAiPrompted(): Promise<void> {
  if (!appSettings().aiPrompted) await saveAppSettings({ aiPrompted: true });
}

/**
 * 연결 시험 후 저장 — 열쇠가 통과하면 저장하고 **바로 자동 문안을 켠다**(따로 켤 필요 없게). 틀리면 아무것도 저장하지 않는다.
 * 열쇠 값은 반환값·로그 어디에도 없다.
 */
export async function connectKey(key: string, model?: string): Promise<{ ok: boolean; message: string }> {
  const k = key.trim();
  if (!k) return { ok: false, message: "열쇠를 넣어 주세요." };
  const t = await testKey(k, model);
  if (!t.ok) return t;
  await saveAiSettings({ key: k, on: true, ...(model !== undefined ? { model } : {}) });
  await markAiPrompted();
  return { ok: true, message: "AI 열쇠가 연결됐습니다 — 이제 문안(쪽지·txt)이 없는 영상은 올리기 직전에 제목·설명·해시태그가 자동으로 지어집니다." };
}

/** 열쇠를 지우고 끈다 */
export async function disconnectAi(): Promise<void> {
  await saveAppSettings({ aiKey: "", aiTitles: false });
}

/** 이 채널에서 자동 문안을 쓸 수 있나 (전체 켜짐 + 열쇠 + 채널이 끄지 않음) */
export function aiUsable(channel: string): { ok: boolean; why: string } {
  const st = aiState();
  if (!st.enabled) return { ok: false, why: AI_FALLBACK_WHY.off };
  if (!st.hasKey) return { ok: false, why: AI_FALLBACK_WHY.noKey };
  if (confFor(channel)?.ai === false) return { ok: false, why: AI_FALLBACK_WHY.chanOff };
  return { ok: true, why: "" };
}

/** 문제 목록용 안내 한 줄: 켜져 있는데 열쇠가 없다 / 최근에 못 지은 영상이 있다. 없으면 null. (issues.ts 가 부른다) */
export function aiNotice(): { level: "yellow"; kind: "ai"; channel: string; what: string; why: string; fix: { label: string }; auto: false } | null {
  const st = aiState();
  if (st.needsKey) {
    return {
      level: "yellow", kind: "ai", channel: "", what: "AI 열쇠를 넣으면 제목·설명·해시태그를 자동으로 지어 줍니다",
      why: "문안(쪽지·txt)이 없는 영상은 지금은 파일 이름이 제목으로 올라갑니다", fix: { label: "설정 탭에서 AI 열쇠 넣기" }, auto: false,
    };
  }
  const last = lastErrorSync();
  if (st.enabled && last && Date.now() - Date.parse(last.atIso) < 24 * 3600_000) {
    return {
      level: "yellow", kind: "ai", channel: last.channel || "", what: "AI 문안을 만들지 못한 영상이 있습니다",
      why: `${last.why}${last.file ? ` (${baseName(last.file)})` : ""} — 그 영상은 파일 이름 제목으로 올라갔습니다`, fix: { label: "설정 탭에서 AI 열쇠 확인" }, auto: false,
    };
  }
  return null;
}

/* ============================================================ 구글 AI 스튜디오 (진짜 길 — 시험은 setAiBackend 로 갈아 끼운다) */

export interface AiBackend {
  /** 영상을 읽고 문안 JSON 글을 돌려준다 */
  meta(req: { path: string; prompt: string; schema: Obj; model: string; key: string }): Promise<string>;
  /** 글만 보고 JSON 글을 돌려준다 */
  text(req: { prompt: string; schema: Obj; model: string; key: string }): Promise<string>;
}
let 뒤: AiBackend | null = null;
/** 시험: 구글 AI 스튜디오 대신 가짜를 끼운다. null 이면 진짜로. */
export function setAiBackend(b: AiBackend | null) { 뒤 = b; }

const 열쇠가림 = (s: string) => s.replace(/key=[^&\s"']+/g, "key=***");

async function 보내고받기(url: string, init: RequestInit, 이름: string): Promise<Response> {
  // 503(붐빔)·429(한도)·5xx 는 잠깐 쉬었다 다시 — 실측에서 503 이 실제로 났다
  let 마지막 = "";
  for (let i = 0; i < 3; i++) {
    const r = await doFetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
    if (r.ok) return r;
    마지막 = `${r.status} ${(await r.text()).slice(0, 200)}`;
    if (r.status !== 429 && r.status !== 503 && r.status < 500) break;
    await new Promise((s) => setTimeout(s, 4000 * (i + 1)));
  }
  throw new Error(`${이름}: ${열쇠가림(마지막)}`);
}

async function 올리기(경로: string, 키: string): Promise<{ 이름: string; 주소: string }> {
  const 크기 = (await Deno.stat(경로)).size;
  const 시작 = await 보내고받기(`${파일API}/upload/v1beta/files?key=${키}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(크기), "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "upload" } }),
  }, "올릴 자리 받기");
  const 올릴곳 = 시작.headers.get("X-Goog-Upload-URL");
  await 시작.body?.cancel();
  if (!올릴곳) throw new Error("올릴 자리를 받지 못했습니다.");
  const f = await Deno.open(경로, { read: true });
  const r = await doFetch(올릴곳, {
    method: "POST",
    headers: { "Content-Length": String(크기), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: f.readable,
  });
  if (!r.ok) throw new Error(`영상 올리기: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { 이름: j.file.name, 주소: j.file.uri };
}

async function 읽힐때까지(이름: string, 키: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await doFetch(`${파일API}/v1beta/${이름}?key=${키}`);
    if (!r.ok) { await r.body?.cancel(); throw new Error(`영상 상태: ${r.status}`); }
    const j = await r.json();
    if (j.state === "ACTIVE") return;
    if (j.state === "FAILED") throw new Error("구글이 이 영상을 읽지 못했습니다.");
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("영상을 읽는 데 2분이 넘게 걸려 그만두었습니다.");
}

async function 지우기(이름: string, 키: string): Promise<void> {
  try {
    const r = await doFetch(`${파일API}/v1beta/${이름}?key=${키}`, { method: "DELETE" });
    await r.body?.cancel();
  } catch { /* 못 지워도 구글이 48시간 뒤 스스로 지운다 */ }
}

async function 생성(모델: string, 키: string, parts: Obj[], schema: Obj, 이름: string): Promise<string> {
  const r = await 보내고받기(`${파일API}/v1beta/models/${모델}:generateContent?key=${키}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", responseSchema: schema } }),
  }, 이름);
  const j = await r.json();
  return String(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
}

const 진짜: AiBackend = {
  async meta({ path, prompt, schema, model, key }) {
    let 올린것: { 이름: string; 주소: string } | null = null;
    try {
      올린것 = await 올리기(path, key);
      await 읽힐때까지(올린것.이름, key);
      return await 생성(model, key, [{ file_data: { mime_type: "video/mp4", file_uri: 올린것.주소 } }, { text: prompt }], schema, "제목 짓기");
    } finally {
      if (올린것) await 지우기(올린것.이름, key); // 남의 서버에 남겨 두지 않는다
    }
  },
  async text({ prompt, schema, model, key }) {
    return await 생성(model, key, [{ text: prompt }], schema, "글 짓기");
  },
};
const 길 = () => 뒤 ?? 진짜;

const 시험문장 = "안녕이라고만 답해라.";

/** 설정 화면의 「연결 시험」 — 열쇠가 살아 있는지만 가볍게 본다. key 가 비면 저장된 열쇠. */
export async function testKey(key?: string, model?: string): Promise<{ ok: boolean; message: string }> {
  const k = (key ?? "").trim() || appSettings().aiKey.trim();
  if (!k) return { ok: false, message: "열쇠를 넣어 주세요." };
  const m = (model ?? "").trim() || appSettings().aiModel || 기본모델;
  const 잘됨 = "열쇠가 정상입니다. 이제 문안이 없는 영상은 제목·설명·해시태그가 자동으로 지어집니다.";
  try {
    if (뒤) {
      await 뒤.text({ prompt: 시험문장, schema: { type: "OBJECT", properties: { a: { type: "STRING" } } }, model: m, key: k });
      return { ok: true, message: 잘됨 };
    }
    const r = await doFetch(`${파일API}/v1beta/models/${m}:generateContent?key=${k}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: 시험문장 }] }] }), signal: AbortSignal.timeout(30_000),
    });
    const 글 = await r.text();
    if (r.ok) return { ok: true, message: 잘됨 };
    if (r.status === 400 || r.status === 403) return { ok: false, message: "열쇠가 잘못되었거나 권한이 없습니다. 다시 확인해 주세요." };
    if (r.status === 429) return { ok: false, message: "구글이 잠시 한도를 걸었습니다(429). 조금 뒤에 다시 시험해 보세요." };
    return { ok: false, message: `구글이 거절했습니다 (${r.status}). ${열쇠가림(글.slice(0, 120))}` };
  } catch (e) {
    return { ok: false, message: `연결하지 못했습니다 — ${열쇠가림(e instanceof Error ? e.message : String(e))}` };
  }
}

/** 설정 저장 — 열쇠는 이 컴퓨터의 앱설정.json(권한 600)에만, 응답엔 값이 없다 */
export async function saveAiSettings(p: { on?: boolean; key?: string; model?: string; clearKey?: boolean }): Promise<AiState> {
  const patch: Obj = {};
  if (p.on !== undefined) patch.aiTitles = !!p.on;
  if (p.model !== undefined) patch.aiModel = String(p.model).trim().slice(0, 80);
  if (p.clearKey) patch.aiKey = "";
  else if (p.key !== undefined && p.key.trim()) patch.aiKey = p.key.trim();
  await saveAppSettings(patch);
  return aiState();
}

/* ============================================================ 채널의 말투 표본 (youtube.readonly — 하루 한 번 2유닛) */

export interface Sample { title: string; desc: string; tags: string[]; views: number; sec: number; kind: Kind; at: string }
const 표본파일 = () => dataPath("채널말투표본.json");
const 표본유지초 = 24 * 3600;

/** ISO 8601 길이(PT1M20S) → 초 */
export function isoDurationSec(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(d ?? ""));
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + Math.round(+(m[4] ?? 0));
}

/**
 * 그 채널의 지난 영상에서 말투 표본을 뽑는다 — 같은 꼴(쇼츠/롱폼)의 잘된 영상 몇 개 + 최근 영상 몇 개.
 * 하루 한 번만 읽고 기록해 둔다(playlistItems 1 + videos.list 1 = 2유닛). 어떤 오류도 밖으로 던지지 않는다(표본 없이 지으면 된다).
 * 공개된 영상만 쓴다 — 비공개·검토 대기 중인 영상은 우리가 자동으로 올린 것일 수 있어 말투 표본이 아니다.
 */
export async function channelSamples(channel: string, kind: Kind, now: Date = new Date()): Promise<Sample[]> {
  try {
    const { key, entry } = entryFor(channel);
    const cid = entry.channel_id || confFor(channel)?.channel_id || "";
    if (!cid) return [];
    const 표 = await readJson<Record<string, { at: number; items: Sample[] }>>(표본파일(), {});
    let 담음 = 표[cid];
    if (!담음 || (now.getTime() - 담음.at) / 1000 > 표본유지초) {
      const yt = await ytFor(key);
      const list = await playlistItems(yt, uploadsPlaylistId(cid), { part: "contentDetails", maxResults: 50 });
      const ids: string[] = (list.items ?? []).map((x: Obj) => String(x.contentDetails?.videoId ?? x.snippet?.resourceId?.videoId ?? "")).filter(Boolean);
      const vids = ids.length ? await videosList(yt, ids.slice(0, 50), "snippet,statistics,contentDetails,status") : [];
      const items: Sample[] = [];
      for (const v of vids) {
        if (v.status?.privacyStatus && v.status.privacyStatus !== "public") continue;
        const sec = isoDurationSec(v.contentDetails?.duration ?? "");
        items.push({
          title: String(v.snippet?.title ?? ""), desc: String(v.snippet?.description ?? "").slice(0, 600),
          tags: Array.isArray(v.snippet?.tags) ? v.snippet.tags.map(String).slice(0, 12) : [],
          views: Number(v.statistics?.viewCount ?? 0) || 0, sec,
          // 길이만으로 가른 근사 — 화면비는 API 가 안 준다(내 영상의 정확한 판정은 올릴 때 파일로 한다)
          kind: sec > 0 && sec <= 180 ? "쇼츠" : "롱폼", at: String(v.snippet?.publishedAt ?? ""),
        });
      }
      담음 = { at: now.getTime(), items };
      await withFileLock(dataPath("채널말투표본.lock"), async () => {
        const cur = await readJson<Record<string, unknown>>(표본파일(), {});
        cur[cid] = 담음;
        await writeJson(표본파일(), cur);
      });
    }
    return pickSamples(담음.items, kind);
  } catch (e) {
    await recordLine("AI.log", `말투 표본을 못 읽음 [${channel}] ${err(e).slice(0, 120)}`);
    return [];
  }
}

/** 같은 꼴의 잘된 영상 4개 + 같은 꼴의 최근 3개(겹치면 뺀다). 같은 꼴이 3개 미만이면 다른 꼴로 채워 6개까지. */
export function pickSamples(all: Sample[], kind: Kind): Sample[] {
  const same = all.filter((x) => x.kind === kind && x.title);
  const other = all.filter((x) => x.kind !== kind && x.title);
  const top = [...same].sort((a, b) => b.views - a.views).slice(0, 4);
  const recent = [...same].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 3);
  const out: Sample[] = [];
  for (const x of [...top, ...recent]) if (!out.includes(x)) out.push(x);
  if (out.length < 3) for (const x of [...other].sort((a, b) => b.views - a.views)) { if (out.length >= 6) break; out.push(x); }
  return out;
}

/* ============================================================ 문안 정리·검사 (checktext · 메타검사 이식분 + 유튜브가 거부하는 것) */

export interface Meta { title: string; desc: string; tags: string[] }
export interface Checked { meta: Meta; problems: string[] }

const 금지글자 = /[<>]/g;
const 제어글자 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const 라벨 = /^(제목|설명|해시태그|태그|title|description|tags?)$/i;
const 태그한도글자 = 30;

/** 코드포인트 단위 자르기 — 이모지를 반으로 가르지 않는다 */
const 자르기 = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const 글자수 = (s: string) => Array.from(s).length;
const 줄이기 = (s: string, n: number) => 자르기(s.replace(/\s+/g, " ").trim(), n);

/**
 * 유튜브가 거부하는 것·깨지는 것을 미리 정리한다. 제목 한 줄 · < > 는 전각으로(뜻은 남기고 거부는 피한다) · 제목 100자 · 설명 5000자 · 태그 500자.
 * 사람이 쓴 글에도 같은 정리를 한다 — 올리는 순간 invalidDescription 으로 전송 끝에 거부당하면 되돌릴 수 없다.
 */
export function sanitizeMeta(m: Meta, o: { descLimit?: number } = {}): Meta {
  const 전각 = (s: string) => s.replace(/</g, "＜").replace(/>/g, "＞");
  const title = 자르기(전각(String(m.title ?? "")).replace(제어글자, "").replace(/\s*[\r\n]+\s*/g, " ").replace(/\s{2,}/g, " ").trim(), TITLE_MAX);
  const limit = Math.min(DESC_MAX, o.descLimit ?? DESC_MAX);
  let desc = 전각(String(m.desc ?? "")).replace(/\r\n?/g, "\n").replace(제어글자, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (글자수(desc) > limit) desc = 자르기(desc, limit).trimEnd();
  const tags = fitTags(
    (m.tags ?? []).map((t) => 자르기(String(t).replace(금지글자, "").replace(/[,"]/g, "").replace(/\s{2,}/g, " ").trim().replace(/^#+/, ""), 태그한도글자)).filter(Boolean),
    TAG_MAX - 10,
  );
  return { title, desc, tags };
}

/** 설명 맨 아래의 해시태그 줄을 떼어 낸다 */
export function splitHashFromDesc(desc: string): { body: string; hashtags: string[] } {
  const lines = desc.split("\n");
  const tags: string[] = [];
  while (lines.length && /^\s*(#\S+\s*)+$/.test(lines[lines.length - 1])) {
    for (const h of (lines.pop()!.match(/#\S+/g) ?? []).reverse()) tags.unshift(h.replace(/^#+/, ""));
  }
  return { body: lines.join("\n").trimEnd(), hashtags: tags };
}

/** 곁글(.txt) 꼴 글 — 문안 규격 검사(checkText)가 읽는 꼴 */
function toSideText(m: Meta): string {
  const 해시 = splitHashFromDesc(m.desc).hashtags;
  return `[제목]\n${m.title}\n\n[설명]\n${m.desc}\n\n[해시태그]\n${해시.map((h) => "#" + h).join(" ")}\n`;
}

/** 정리한 문안을 검사한다 — 흠 목록(비면 통과). 채널의 문안 규격(meta_rule)이 있으면 그 규격으로도 잰다. */
export function checkMetaText(m: Meta, rule?: MetaRule | null): string[] {
  const 흠: string[] = [];
  if (!m.title.trim()) 흠.push("제목이 비었습니다");
  else if (라벨.test(m.title.trim()) || /[═━]/.test(m.title)) 흠.push(`제목이 이상합니다(라벨/구분선?): ${m.title.slice(0, 30)}`);
  if (글자수(m.title) > TITLE_MAX) 흠.push(`제목이 ${TITLE_MAX}자를 넘습니다`);
  if (글자수(m.desc) > DESC_MAX) 흠.push(`설명이 ${DESC_MAX}자를 넘습니다`);
  const 해시 = (m.desc.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (해시 > 15) 흠.push(`해시태그가 ${해시}개 — 15개를 넘으면 유튜브가 모두 무시합니다`);
  if (/[<>]/.test(m.title + m.desc + m.tags.join(""))) 흠.push("< > 글자가 있습니다");
  if (rule && Object.keys(rule).length) 흠.push(...checkText(rule, toSideText(m), m.tags));
  return 흠;
}

/** 정리 → 규격에 맞게 다듬기 → 검사. 흠이 남으면 problems 에 담는다. */
export function finalizeMeta(m: Meta, o: { rule?: MetaRule | null; descLimit?: number } = {}): Checked {
  let meta = sanitizeMeta(m, o);
  const rule = o.rule && Object.keys(o.rule).length ? o.rule : null;
  if (rule) {
    // 규격이 있으면: CTA 줄·#shorts·해시태그 줄을 정리하고 태그를 규격 개수로 맞춘 뒤(받기와 같은 정리), 해시태그를 설명 맨 아래에 다시 붙인다
    const sp = splitHashFromDesc(meta.desc);
    const hs = sp.hashtags.length ? sp.hashtags : meta.tags;
    const c = cleanForRule(rule, meta.title, sp.body, hs);
    const hashtags = c.tags.map((t) => String(t).replace(/^#+/, ""));
    meta = sanitizeMeta({
      title: c.title, desc: c.desc + (hashtags.length ? `\n\n${hashtags.map((h) => "#" + h).join(" ")}` : ""),
      tags: meta.tags.filter((t) => !rule.forbid_shorts_tag || t.toLowerCase() !== "shorts"),
    }, o);
  }
  return { meta, problems: checkMetaText(meta, rule) };
}

/* ============================================================ 프롬프트 */

const 문안스키마 = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    description: { type: "STRING" },
    hashtags: { type: "ARRAY", items: { type: "STRING" } },
    keywords: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["title", "description", "hashtags", "keywords"],
};

/** 채널이 쓰는 언어 이름 — 문안 규격이 한글 금지이거나 언어 칸이 한국어가 아니면 그 언어로 짓게 한다 */
export function languageFor(conf: ChannelConf | null): string {
  const lang = String(conf?.audio_language ?? "").toLowerCase();
  if (lang.startsWith("ja")) return "일본어";
  if (lang.startsWith("en")) return "영어";
  if (lang && !lang.startsWith("ko")) return lang;
  if (conf?.meta_rule?.forbid_hangul) return "일본어 또는 영어(한글 금지)";
  return "한국어";
}

export interface PromptInput {
  kind: Kind;
  channel: string;
  conf: ChannelConf | null;
  sec: number;
  w: number;
  h: number;
  have: { title?: string; desc?: string; tags?: string[] };
  samples: Sample[];
  fileName: string;
  feedback?: string[];
}

/** 지시글 — 영상 내용 + 채널 말투 + 꼴(쇼츠/롱폼) + 규격 */
export function buildMetaPrompt(o: PromptInput): string {
  const lang = languageFor(o.conf);
  const rule = o.conf?.meta_rule ?? null;
  const 줄: string[] = [];
  줄.push(`이 영상을 보고 유튜브에 올릴 제목·설명·해시태그를 ${lang}로 지어라. 영상에 **실제로 나온 내용**만 쓴다. 없는 사실·인물·숫자·가격·장소를 지어내지 마라. 낚시성 거짓 과장 금지.`);
  줄.push("");
  줄.push("[이 영상]");
  줄.push(`- 종류: ${o.kind}${o.kind === "쇼츠" ? " (180초 이하 세로·정사각 짧은 영상)" : " (긴 영상)"}`);
  줄.push(`- 길이 ${Math.round(o.sec)}초 · 화면 ${o.w}x${o.h}`);
  줄.push(`- 파일 이름: ${o.fileName}`);
  const have: string[] = [];
  if (o.have.title) have.push(`- 제목(이미 정해짐 — 바꾸지 말고 여기에 맞춰라): ${o.have.title}`);
  if (o.have.desc) have.push(`- 설명(이미 정해짐 — 바꾸지 말고 여기에 맞춰라): ${줄이기(o.have.desc, 400)}`);
  if (o.have.tags?.length) have.push(`- 태그(이미 정해짐): ${o.have.tags.join(", ")}`);
  if (have.length) { 줄.push(""); 줄.push("[이미 사람이 정한 것]"); 줄.push(...have); }
  if (o.samples.length) {
    줄.push("");
    줄.push("[이 채널의 지난 영상 — 잘된 순과 최근 영상이다. 말투·길이·구성·이모지와 해시태그 쓰임을 **닮게** 지어라. 내용은 베끼지 마라]");
    o.samples.forEach((x, i) => {
      줄.push(`${i + 1}) 조회 ${x.views.toLocaleString("en-US")} · ${x.kind}`);
      줄.push(`   제목: ${줄이기(x.title, 120)}`);
      if (x.desc) 줄.push(`   설명: ${줄이기(x.desc, 300)}`);
      if (x.tags.length) 줄.push(`   태그: ${x.tags.slice(0, 8).join(", ")}`);
    });
  } else {
    줄.push("");
    줄.push("[이 채널의 지난 영상 표본이 없다 — 자연스럽고 담백한 말투로 지어라]");
  }
  const tone = String(o.conf?.tone ?? "").trim();
  if (tone) { 줄.push(""); 줄.push(`[말투 메모 — 채널 주인이 적은 것이다. 표본보다 이것이 앞선다]\n${줄이기(tone, 400)}`); }
  const fixed = (o.conf?.fixed_tags ?? []).map((t) => String(t).replace(/^#+/, "")).filter(Boolean);
  if (fixed.length) 줄.push(`\n[고정 해시태그 — 따로 붙으니 hashtags 에 또 넣지 마라] ${fixed.map((t) => "#" + t).join(" ")}`);
  if (o.conf?.desc_head || o.conf?.desc_tail) 줄.push("\n[채널의 고정 머리말·꼬리말은 따로 붙으니 description 에 쓰지 마라]");
  줄.push("");
  줄.push("[형식]");
  if (o.kind === "쇼츠") {
    줄.push("- title: 40자 안팎 한 줄. 첫 낱말부터 궁금하게(과장·거짓 금지).");
    줄.push("- description: 짧게 2~3줄(핵심 한두 문장 + 한 줄 마무리). 300자 안쪽. 해시태그는 여기 쓰지 말고 hashtags 에.");
    줄.push(`- hashtags: 3~5개${rule?.forbid_shorts_tag ? "(#shorts 는 넣지 마라)" : "(shorts 를 하나 포함)"}. 낱말 하나씩, 공백·기호 없이.`);
    줄.push("- keywords: 검색용 태그 5~8개.");
  } else {
    줄.push("- title: 60자 안팎 한 줄. 검색에 걸리는 핵심 낱말을 앞에.");
    줄.push("- description: 6~12줄. 첫 두 줄에 핵심(검색 결과에 보이는 부분), 이어서 내용 요약·다룬 순서. **모르는 시각(타임스탬프)은 쓰지 마라.** 1500자 안쪽. 해시태그는 여기 쓰지 말고 hashtags 에.");
    줄.push("- hashtags: 3~5개(shorts 는 넣지 마라). 낱말 하나씩, 공백·기호 없이.");
    줄.push("- keywords: 검색용 태그 8~12개.");
  }
  줄.push("");
  줄.push("[금지] < > 글자 · 제목 100자·설명 5000자 초과 · 같은 문장 반복" + (rule?.forbid_cta ? " · 구독·좋아요·알림 유도 문구" : ""));
  if (rule?.hashtags != null) 줄.push(`[채널 규격] 해시태그는 정확히 ${rule.hashtags}개.`);
  if (rule?.desc_min != null || rule?.desc_max != null) 줄.push(`[채널 규격] 설명 본문은 ${rule.desc_min ?? 0}~${rule.desc_max ?? "제한 없음"}자.`);
  if (rule?.forbid_hangul) 줄.push("[채널 규격] 한글을 한 글자도 쓰지 마라.");
  if (o.feedback?.length) { 줄.push(""); 줄.push("[앞서 지은 글이 검사에 걸렸다 — 아래를 고쳐서 다시 지어라]"); for (const f of o.feedback) 줄.push(`- ${f}`); }
  줄.push("");
  줄.push('JSON 으로만 답한다: {"title":"","description":"","hashtags":[],"keywords":[]}');
  return 줄.join("\n");
}

/* ============================================================ 기록 (같은 영상은 다시 부르지 않는다) */

export interface AutoRecord {
  file: string;
  channel: string;
  at: string;
  status: "자동" | "건너뜀";
  why: string;
  model: string;
  kind: Kind;
  title: string;
  /** 머리말·꼬리말·해시태그 줄까지 합친 설명 */
  desc: string;
  tags: string[];
  problems: string[];
  samples: number;
  /** 건너뜀 기록을 이 시각(ms) 전에는 다시 시도하지 않는다 */
  retryAfter?: number;
}

const 기록파일 = () => dataPath("AI문안기록.json");
const 기록최대 = 500;

async function 키(file: string): Promise<string | null> {
  try { const s = await Deno.stat(file); return `${file}|${s.size}|${s.mtime ? s.mtime.getTime() : 0}`; } catch { return null; }
}
function 키동기(file: string): string | null {
  try { const s = Deno.statSync(file); return `${file}|${s.size}|${s.mtime ? s.mtime.getTime() : 0}`; } catch { return null; }
}

function 기록읽기동기(): Record<string, Obj> {
  try { return JSON.parse(Deno.readTextFileSync(기록파일())); } catch { return {}; }
}

/** 이미 지어 둔 문안만 읽는다(서버를 부르지 않는다 — 미리보기·화면용). 건너뜀 기록은 null. */
export function metaRecordFor(file: string): { title: string; description: string; tags: string[]; at: string; status: "자동" } | null {
  const k = 키동기(file);
  if (!k) return null;
  const r = 기록읽기동기()[k] as AutoRecord | undefined;
  if (!r || r.status !== "자동") return null;
  return { title: r.title, description: r.desc, tags: r.tags, at: r.at, status: "자동" };
}

function lastErrorSync(): { atIso: string; why: string; channel?: string; file?: string } | null {
  const e = 기록읽기동기()["_last_error"];
  return e && e.atIso ? { atIso: String(e.atIso), why: String(e.why ?? ""), channel: e.channel, file: e.file } : null;
}

async function 기록쓰기(k: string, r: AutoRecord, 오류?: { why: string; channel: string; file: string }): Promise<void> {
  await withFileLock(dataPath("AI문안기록.lock"), async () => {
    const cur = await readJson<Record<string, any>>(기록파일(), {});
    cur[k] = r;
    if (오류) cur["_last_error"] = { atIso: new Date().toISOString(), ...오류 };
    else if (r.status === "자동") delete cur["_last_error"];
    const ents = Object.entries(cur).filter(([x]) => !x.startsWith("_"));
    if (ents.length > 기록최대) {
      ents.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
      for (const [x] of ents.slice(기록최대)) delete cur[x];
    }
    await writeJson(기록파일(), cur);
  });
}

/** 그 영상의 자동 기록을 지워 다시 짓게 한다 */
export async function clearMetaRecord(file: string): Promise<boolean> {
  const k = await 키(file);
  if (!k) return false;
  return !!(await withFileLock(dataPath("AI문안기록.lock"), async () => {
    const cur = await readJson<Record<string, any>>(기록파일(), {});
    if (!(k in cur)) return false;
    delete cur[k];
    await writeJson(기록파일(), cur);
    return true;
  }));
}

/* ============================================================ 영상 읽히기 준비 (큰 영상은 작은 사본으로) */

async function 읽힐영상(file: string, sec: number): Promise<{ path: string; cleanup: () => Promise<void>; note: string }> {
  const 크기 = (await Deno.stat(file)).size;
  if (크기 <= 큰영상 && sec <= 긴영상초) return { path: file, cleanup: async () => {}, note: "" };
  const ff = await findTool("ffmpeg");
  if (!ff) throw new Error(`영상이 커서(${(크기 / 1048576).toFixed(0)}MB · ${Math.round(sec / 60)}분) 읽히지 못했습니다 — ffmpeg 가 있으면 작은 사본으로 읽습니다`);
  const dir = await Deno.makeTempDir({ prefix: "garasadae_ai_" });
  const out = `${dir}/사본.mp4`;
  const r = await new Deno.Command(ff, {
    args: ["-y", "-loglevel", "error", "-i", file, "-t", String(사본초), "-vf", "scale=-2:360,fps=6", "-c:v", "libx264", "-crf", "34", "-preset", "veryfast", "-c:a", "aac", "-b:a", "32k", "-ac", "1", out],
    stdout: "null", stderr: "piped", signal: AbortSignal.timeout(6 * 60_000),
  }).output();
  if (!r.success) {
    try { await Deno.remove(dir, { recursive: true }); } catch { /* 무시 */ }
    throw new Error("작은 사본을 만들지 못했습니다 — " + new TextDecoder().decode(r.stderr).slice(0, 100));
  }
  return { path: out, cleanup: async () => { try { await Deno.remove(dir, { recursive: true }); } catch { /* 무시 */ } }, note: `앞 ${Math.round(사본초 / 60)}분의 작은 사본으로 읽었습니다` };
}

/* ============================================================ 자동 문안 짓기 */

export interface AutoInput {
  channel: string;
  file: string;
  kind: Kind;
  sec: number;
  w: number;
  h: number;
  /** 사람·쪽지가 이미 정한 칸 (프롬프트에 맞춰라 하고 알려 준다) */
  have?: { title?: string; desc?: string; tags?: string[] };
  force?: boolean;
  now?: Date;
}
export interface AutoResult { status: "자동" | "건너뜀"; why: string; cached: boolean; record: AutoRecord | null }

const 진행 = new Map<string, Promise<AutoResult>>();

/**
 * 자동으로 제목·설명·해시태그를 짓는다(같은 영상은 기록을 재사용). 어떤 오류도 던지지 않고 「건너뜀」 + 까닭을 돌려준다.
 * 같은 영상이 동시에 두 번 불려도(미리보기 + 업로드) 한 번만 짓는다.
 */
export async function autoMeta(o: AutoInput): Promise<AutoResult> {
  const k = await 키(o.file);
  if (!k) return { status: "건너뜀", why: "파일이 없습니다", cached: false, record: null };
  const 돌고 = 진행.get(k);
  if (돌고) return await 돌고;
  const p = (async (): Promise<AutoResult> => {
    try { return await autoMetaInner(o, k); } catch (e) { return { status: "건너뜀", why: `AI 문안 오류 — ${err(e).slice(0, 120)}`, cached: false, record: null }; } finally { 진행.delete(k); }
  })();
  진행.set(k, p);
  return await p;
}

async function autoMetaInner(o: AutoInput, k: string): Promise<AutoResult> {
  const now = o.now ?? new Date();
  const use = aiUsable(o.channel);
  if (!use.ok) return { status: "건너뜀", why: use.why, cached: false, record: null };
  const 옛 = (await readJson<Record<string, AutoRecord>>(기록파일(), {}))[k];
  if (옛 && !o.force) {
    if (옛.status === "자동") return { status: "자동", why: "", cached: true, record: 옛 };
    // 실패는 30분이 지난 뒤에 다시 — 그 사이에는 다시 부르지 않는다
    if (옛.retryAfter && now.getTime() < 옛.retryAfter) return { status: "건너뜀", why: 옛.why, cached: true, record: 옛 };
  }
  const settings = appSettings();
  const model = settings.aiModel || 기본모델;
  const conf = confFor(o.channel);
  const rule = conf?.meta_rule ?? null;
  const samples = await channelSamples(o.channel, o.kind, now);
  const 못지음 = async (why: string, 재시도 = true): Promise<AutoResult> => {
    const rec: AutoRecord = {
      file: o.file, channel: o.channel, at: isoWall(wallNow()), status: "건너뜀", why, model, kind: o.kind,
      title: "", desc: "", tags: [], problems: [], samples: samples.length,
      ...(재시도 ? { retryAfter: now.getTime() + 재시도분 * 60_000 } : {}),
    };
    await 기록쓰기(k, rec, { why, channel: o.channel, file: o.file });
    await recordLine("AI.log", `건너뜀 [${o.channel}] ${baseName(o.file)} — ${why}`);
    return { status: "건너뜀", why, cached: false, record: rec };
  };

  let 사본: Awaited<ReturnType<typeof 읽힐영상>>;
  try {
    사본 = await 읽힐영상(o.file, o.sec);
  } catch (e) {
    return await 못지음(err(e), false);
  }
  try {
    let feedback: string[] | undefined;
    let 마지막흠: string[] = [];
    for (let 번 = 0; 번 < 2; 번++) {
      const prompt = buildMetaPrompt({ kind: o.kind, channel: o.channel, conf, sec: o.sec, w: o.w, h: o.h, have: o.have ?? {}, samples, fileName: baseName(o.file), feedback });
      let raw: Obj;
      try {
        const text = await 길().meta({ path: 사본.path, prompt, schema: 문안스키마, model, key: settings.aiKey.trim() });
        raw = JSON.parse(text);
      } catch (e) {
        return await 못지음(구글오류글(e));
      }
      const made = composeFromAi(raw, { conf, kind: o.kind, rule });
      const chk = finalizeMeta(made, { rule });
      if (!chk.problems.length) {
        const rec: AutoRecord = {
          file: o.file, channel: o.channel, at: isoWall(wallNow()), status: "자동", why: 사본.note, model, kind: o.kind,
          title: chk.meta.title, desc: chk.meta.desc, tags: chk.meta.tags, problems: [], samples: samples.length,
        };
        await 기록쓰기(k, rec);
        await recordLine("AI.log", `지음 [${o.channel}] ${baseName(o.file)} ${o.kind} — 「${cut(chk.meta.title, 40)}」${사본.note ? " · " + 사본.note : ""}`);
        return { status: "자동", why: "", cached: false, record: rec };
      }
      마지막흠 = chk.problems;
      feedback = chk.problems; // 한 번 더 — 걸린 것을 알려 주고 다시 짓게 한다
    }
    return await 못지음(`지은 글이 문안 검사를 통과하지 못했습니다 — ${마지막흠.join(" · ").slice(0, 160)}`);
  } finally {
    await 사본.cleanup();
  }
}

const err = (e: unknown) => 열쇠가림(e instanceof Error ? e.message : String(e));
function 구글오류글(e: unknown): string {
  const m = err(e);
  if (/ 403 | 400 /.test(m) || /API key/i.test(m)) return `AI 열쇠가 잘못되었거나 권한이 없습니다 — 설정에서 다시 확인하세요 (${m.slice(0, 80)})`;
  if (/429/.test(m)) return "구글 AI 한도에 걸렸습니다(429) — 잠시 뒤에 다시 시도합니다";
  return `AI 가 문안을 짓지 못했습니다 — ${m.slice(0, 120)}`;
}

/** AI 가 돌려준 칸들 → 채널 설정(머리말·꼬리말·고정 해시태그)과 꼴 규칙을 입힌 문안 */
export function composeFromAi(raw: Obj, o: { conf: ChannelConf | null; kind: Kind; rule: MetaRule | null }): Meta {
  const clean = (t: unknown) => String(t).trim().replace(/^#+/, "").replace(/\s+/g, "");
  const hs = (Array.isArray(raw.hashtags) ? raw.hashtags : []).map(clean).filter(Boolean);
  // 한글 금지 규격이면 한글이 든 검색 태그는 버린다(AI 가 한두 개 섞어 주면 글 전체를 버리지 않고 그것만 뺀다)
  const kw = (Array.isArray(raw.keywords) ? raw.keywords : []).map((t: unknown) => String(t).trim().replace(/^#+/, "")).filter(Boolean)
    .filter((t: string) => !(o.rule?.forbid_hangul && countHangul(t) > 0));
  const fixed = (o.conf?.fixed_tags ?? []).map(clean).filter(Boolean);
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const t of [...fixed, ...hs]) {
    const low = t.toLowerCase();
    if (seen.has(low)) continue;
    if (low === "shorts" && (o.kind !== "쇼츠" || o.rule?.forbid_shorts_tag)) continue; // 롱폼에는 #shorts 를 안 붙인다
    seen.add(low);
    hashtags.push(t);
  }
  if (o.kind === "쇼츠" && !o.rule?.forbid_shorts_tag && !seen.has("shorts")) hashtags.push("shorts");
  const hashtags15 = hashtags.slice(0, 15); // 15개를 넘으면 유튜브가 해시태그를 모두 무시한다
  const body = [String(o.conf?.desc_head ?? "").trim(), String(raw.description ?? "").trim(), String(o.conf?.desc_tail ?? "").trim()].filter(Boolean).join("\n\n");
  const desc = body + (hashtags15.length ? `\n\n${hashtags15.map((h) => "#" + h).join(" ")}` : "");
  return { title: String(raw.title ?? ""), desc, tags: [...hashtags15, ...kw] };
}

/* ============================================================ 영상 하나의 유효한 문안 (사람 > 쪽지 > 자동 > 파일 이름) */

export type Source = "사람" | "쪽지" | "자동" | "파일이름" | "없음";
export interface Resolved {
  title: string;
  desc: string;
  tags: string[];
  source: { title: Source; desc: Source; tags: Source };
  status: "자동" | "사람" | "쪽지" | "건너뜀";
  why: string;
  cached: boolean;
  kind: Kind;
  checks: { ok: boolean; problems: string[] };
}

export interface ResolveInput {
  channel: string;
  file: string;
  kind: Kind;
  sec: number;
  w: number;
  h: number;
  /** 일감에 직접 적힌 값(화면·명령줄에서 사람이 준 것) */
  job?: { title?: unknown; desc?: unknown; tags?: unknown };
  /** false 면 지어 둔 것만 쓰고 AI 를 부르지 않는다(미리보기) */
  generate?: boolean;
  force?: boolean;
  now?: Date;
  /** 설명 뒤에 붙을 글(쿠팡 블록)을 위해 비워 둘 글자 수 */
  reserve?: number;
}

const stemOf = (p: string) => baseName(p).replace(/\.[^.]+$/, "").slice(0, TITLE_MAX);

/**
 * 영상 하나에 실제로 붙을 제목·설명·태그와 그 출처. 칸마다 따로 정한다:
 *   일감에 직접 적은 값·영상 옆 txt(사람이 쓰거나 화면에서 고친 것) = 「사람」 > 쪽지(.json·정보.json) = 「쪽지」 > AI 자동 = 「자동」 > 파일 이름
 * generate 가 true 이고 비어 있는 칸이 있으면 AI 로 짓는다(기록이 있으면 재사용). 어떤 오류도 던지지 않는다 — 못 지으면 파일 이름으로.
 */
export async function resolveMeta(o: ResolveInput): Promise<Resolved> {
  const det = await loadForDetailed(o.file);
  const jobTitle = typeof o.job?.title === "string" ? o.job.title.trim() : "";
  const jobDesc = typeof o.job?.desc === "string" ? o.job.desc.trim() : "";
  const jobTags = Array.isArray(o.job?.tags) ? (o.job!.tags as unknown[]).map(String).filter(Boolean) : [];
  const 출처 = (given: boolean, fromJob: boolean): Source => (fromJob ? "사람" : given ? (det.kind === "txt" ? "사람" : "쪽지") : "없음");
  const src = {
    title: 출처(det.titleGiven, !!jobTitle),
    desc: 출처(det.descGiven, !!jobDesc),
    tags: 출처(det.tagsGiven, jobTags.length > 0),
  };
  let title = jobTitle || (det.titleGiven ? det.title : "");
  let desc = jobDesc || (det.descGiven ? det.desc : "");
  let tags = jobTags.length ? jobTags : det.tagsGiven ? det.tags : [];
  let why = "";
  let cached = false;
  if (src.title === "없음" || src.desc === "없음" || src.tags === "없음") {
    const use = aiUsable(o.channel);
    let auto: AutoResult | null = null;
    if (!use.ok) why = use.why;
    else if (o.generate === false) {
      // 지어 둔 것이 있으면 쓴다(호출 없음)
      const r = metaRecordFor(o.file);
      if (r) auto = { status: "자동", why: "", cached: true, record: { file: o.file, channel: o.channel, at: r.at, status: "자동", why: "", model: "", kind: o.kind, title: r.title, desc: r.description, tags: r.tags, problems: [], samples: 0 } };
      else why = "올릴 때 자동으로 지어집니다";
    } else {
      auto = await autoMeta({ channel: o.channel, file: o.file, kind: o.kind, sec: o.sec, w: o.w, h: o.h, have: { title: title || undefined, desc: desc || undefined, tags: tags.length ? tags : undefined }, force: o.force, now: o.now });
      if (auto.status !== "자동") why = auto.why;
    }
    if (auto?.record && auto.status === "자동") {
      cached = auto.cached;
      if (src.title === "없음") { title = auto.record.title; src.title = "자동"; }
      if (src.desc === "없음") { desc = auto.record.desc; src.desc = "자동"; }
      if (src.tags === "없음") { tags = auto.record.tags; src.tags = "자동"; }
    }
  }
  if (!title) { title = stemOf(o.file); src.title = "파일이름"; }
  const rule = confFor(o.channel)?.meta_rule ?? null;
  // 최종 정리: 어느 출처든 유튜브가 거부하는 것(< > · 길이)은 미리 막는다. 문안 규격 검사의 흠은 알리기만 한다(사람이 쓴 글을 마음대로 고치지 않는다).
  const fin = sanitizeMeta({ title, desc, tags }, { descLimit: DESC_MAX - Math.max(0, o.reserve ?? 0) });
  const problems = checkMetaText(fin, rule);
  const status: Resolved["status"] = [src.title, src.desc, src.tags].includes("자동") ? "자동"
    : det.kind === "txt" || jobTitle || jobDesc ? "사람" : det.kind === "note" || det.kind === "info" ? "쪽지" : "건너뜀";
  return { title: fin.title, desc: fin.desc, tags: fin.tags, source: src, status, why, cached, kind: o.kind, checks: { ok: problems.length === 0, problems } };
}

/* ============================================================ 쿠팡 파트너스용 상품 검색어 (영상 소재 → 0~3개) */

export interface 상품밑감 {
  title: string;
  desc: string;
  tags: string[];
  /** 채널 이름 — 말투가 아니라 소재 파악에만 쓴다 */
  channel?: string;
  kind?: "쇼츠" | "롱폼";
}

const 상품스키마 = { type: "OBJECT", properties: { queries: { type: "ARRAY", items: { type: "STRING" } } }, required: ["queries"] };

/**
 * 이 영상 소재와 **진짜 관련 있는** 쿠팡 상품 검색어를 0~3개 돌려준다. 열쇠가 없거나 꺼져 있거나 실패하면 null
 * (부르는 쪽이 규칙으로 넘어간다). 빈 목록은 「관련 상품이 없다」는 AI 의 판단이다 — 억지로 상품을 만들지 않는다.
 */
export async function productQueries(밑: 상품밑감): Promise<{ queries: string[] } | null> {
  const use = 밑.channel ? aiUsable(밑.channel) : { ok: aiState().enabled && aiState().hasKey, why: "" };
  if (!use.ok) return null;
  const s = appSettings();
  const prompt = [
    "다음은 유튜브 영상의 제목·설명·태그다. 이 영상 소재와 **진짜 관련 있는** 쿠팡 상품 검색어를 0~3개 골라라.",
    "- 영상에 실제로 나오는 제품·물건, 또는 그 영상을 본 사람이 곧바로 사고 싶어 할 구체적인 물건 이름만(예: 「텀블러」「등산화」「전기장판」).",
    "- 정치·뉴스·사건사고·연예 가십·특정 인물 이야기·논란·감정 글처럼 상품과 무관하면 **빈 목록**으로 답한다. 억지로 만들지 마라.",
    "- 브랜드·상표를 지어내지 마라. 영상에 나온 것이 아니면 일반 명사로.",
    "- 검색어는 한국어 명사구 1~3 낱말.",
    "",
    `제목: ${밑.title}`,
    `설명: ${줄이기(밑.desc, 600)}`,
    `태그: ${밑.tags.slice(0, 12).join(", ")}`,
    밑.kind ? `종류: ${밑.kind}` : "",
    "",
    'JSON 으로만 답한다: {"queries":[]}',
  ].filter((x) => x !== "").join("\n");
  try {
    const text = await 길().text({ prompt, schema: 상품스키마, model: s.aiModel || 기본모델, key: s.aiKey.trim() });
    const j = JSON.parse(text);
    const q = (Array.isArray(j.queries) ? j.queries : []).map((x: unknown) => 줄이기(String(x), 40)).filter(Boolean) as string[];
    return { queries: [...new Set(q)].slice(0, 3) };
  } catch (e) {
    await log(`   ⚠️  상품 검색어를 AI 로 못 지었습니다 — ${err(e).slice(0, 100)}`);
    return null;
  }
}

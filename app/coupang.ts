// 쿠팡 파트너스 자동 링크 — 영상마다 소재에 맞는 상품 링크를 골라 설명 끝에 붙인다. (파이썬 업로더에는 없는 기능)
//
// 사용자 지시(2026-10-17)
//   "영상 올릴 때 영상마다·소재마다 쿠팡 파트너스(쿠파스) 링크를 알아서 선별해서 넣게 · 각 사용자에 맞춰서 연결되게"
//
// 왜 이런 꼴인가 — **열쇠는 각자 넣는다**
//   수수료는 링크에 실린 파트너스 계정으로 간다. 만든 사람의 열쇠를 앱에 박으면 남의 영상 수수료가 만든 사람에게 가고,
//   배포 파일에서 열쇠를 뽑아 쓸 수도 있다. 그래서 사용자마다 자기 Access Key·Secret Key 를 넣고(connect),
//   그 열쇠는 이 컴퓨터의 데이터 폴더 `쿠팡파트너스.json`(권한 600)에만 둔다.
//   ★열쇠 값은 어떤 반환값·로그·오류 글에도 나오지 않는다(scrub). 화면은 「저장됨」(connected) 참·거짓만 본다.
//   ★계정을 바꾸면(다른 Access Key) 옛 계정의 추적 링크가 든 검색 캐시·기록을 비운다 — 안 비우면 새 계정 사용자의
//     영상에 옛 계정 링크가 붙어 수수료가 엉뚱한 곳으로 간다.
//
// 어떻게 하나
//   ① 영상 소재 → 검색어 0~3개 (AI 열쇠가 있으면 AI, 없거나 규칙 모드면 보수적인 규칙)
//   ② 쿠팡 파트너스 상품 검색 API — productUrl 이 이미 내 추적 링크다(subId 로 채널을 구분해 실린다)
//   ③ 상품명이 검색어와 관련 있는 것만, 중복을 빼고, 최대 3개
//   ④ 설명 끝에 「상품명 + 링크」 블록과 고지문(쿠팡 파트너스 약관상 필수)
//
// ★실패해도 **업로드를 막지 않는다(fail-open)**: 한도·열쇠 오류·시간 초과는 전부 「건너뜀」으로 돌려주고 링크만 빠진다.
//   pickForVideo / forUpload 는 어떤 일이 있어도 던지지 않는다.
// ★관련 상품이 없으면(뉴스·정치 등) 억지로 안 붙인다. 사람이 이미 쿠팡 링크를 넣었으면 그것이 우선이고 자동 검색은 안 한다.
// ★한도: 검색 API 는 계정당 시간당 약 10회(딥링크는 별도 50회). 호출 시각을 `쿠팡호출.json` 에 남기고 최근 1시간 것만 센다.
//   두 영상이 동시에 올라가도 한도를 넘지 않게 **세고 적는 일을 파일 잠금 안에서** 한다(호출 직전에 자리를 먼저 잡는다).
// ★열쇠 시험(probeKeys)과 연결(connect)은 같은 검사 한 길(verifyKeys)을 쓴다. 시험은 아무것도 저장하지 않고 호출 횟수만 센다.
//
// 데이터 폴더 파일
//   쿠팡파트너스.json   열쇠·설정 (권한 600)      쿠팡호출.json   호출 시각 {search:[ms…], deeplink:[ms…]}
//   쿠팡링크기록.json   영상별 결과(최근 500개)    쿠팡검색캐시.json  키워드+subId 별 검색 결과(24시간, 최대 200개)
//   기록/쿠팡.log       한 줄 기록(열쇠 값 없이)    앱설정.json 의 coupangPrompted  입력 창을 이미 보여 줬나
import { baseName, cut, dataPath, readJson, readJsonSync, recordLine, withFileLock, writeJson } from "./paths.ts";
import { isoWall, systemZone, wallNow } from "./clock.ts";
import { doFetch } from "./google.ts";
import { confFor } from "./channels.ts";
import { appSettings, saveAppSettings } from "./settings.ts";
import { productQueries } from "./ai.ts";

/* ============================================================ 공개 꼴 */

/** 쿠팡 파트너스 고지문 — 링크를 붙인 글에는 반드시 있어야 한다(약관). */
export const DEFAULT_DISCLOSURE = "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.";

export interface Link { name: string; url: string; price?: number }
export type PickStatus = "붙임" | "없음" | "건너뜀" | "사람이넣음";
export interface Pick { status: PickStatus; links: Link[]; queries: string[]; why: string; at: string; block: string }
export interface Settings {
  enabled: boolean;
  mode: "auto" | "rule";
  maxLinks: number;
  perHour: number;
  disclosure: string;
  defaultSubId: string;
  /** 열쇠가 저장돼 있나 (값은 안 돌려준다) */
  connected: boolean;
  lastTest: { ok: boolean; at: string; message: string } | null;
}
/** saveSettings 가 받는 칸 (이 파일 안에서는 global Pick 유틸리티 타입이 가려지므로 풀어서 적는다) */
export type SettingsPatch = Partial<{
  enabled: boolean; mode: "auto" | "rule"; maxLinks: number; perHour: number; disclosure: string; defaultSubId: string;
}>;
export interface PickInput {
  channel: string; file: string; title: string; desc: string; tags: string[];
  kind?: "쇼츠" | "롱폼"; force?: boolean; now?: Date;
  /** 시험이 끼운다. 기본은 ./ai.ts 의 productQueries (null = AI 를 못 씀 → 규칙으로) */
  aiQueries?: (o: { title: string; desc: string; tags: string[]; channel: string; kind?: string }) => Promise<{ queries: string[] } | null>;
}

/* ============================================================ 값 */

const BASE = "https://api-gateway.coupang.com";
const API_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1";
const SEARCH_PATH = `${API_PATH}/products/search`;
const DEEPLINK_PATH = `${API_PATH}/deeplink`;

const SEARCH_LIMIT = 10;          // 검색 한 번에 받는 상품 수 (API 최대)
const DEEPLINK_PER_HOUR = 50;     // 딥링크는 검색과 따로 센다
const HOUR_MS = 3_600_000;
const CACHE_MS = 24 * HOUR_MS;    // 같은 키워드+subId 검색 결과를 쓰는 기간
const RETRY_MS = 30 * 60_000;     // 건너뛴 영상을 다시 시도하는 간격
const MAX_RECORDS = 500;
const MAX_CACHE = 200;
const MAX_SEARCHES = 2;           // 영상 한 편에 검색어 최대 2개 (시간당 10회를 아끼려고)
const TEST_WORD = "텀블러";       // 연결 시험에 쓰는 아무 상품 낱말
let timeoutMs = 15_000;
/** 시험: 시간 초과 길이를 줄인다 (null 이면 15초) */
export function setTimeoutForTest(ms: number | null) { timeoutMs = ms ?? 15_000; }

const FILE = {
  keys: () => dataPath("쿠팡파트너스.json"),
  calls: () => dataPath("쿠팡호출.json"),
  records: () => dataPath("쿠팡링크기록.json"),
  cache: () => dataPath("쿠팡검색캐시.json"),
  lock: () => dataPath("쿠팡.lock"),
};
const LOG = "쿠팡.log";

/* ============================================================ 서명 (HMAC-SHA256) */

const enc = new TextEncoder();

/**
 * 쿠팡 파트너스 서명. message = signedDate + METHOD + path + query (query 에 `?` 를 붙이지 않고, path 와 query 사이 구분도 없다).
 * ★서명한 query 글자는 **실제로 보내는 query 글자와 똑같아야** 한다 — 한 글자만 달라도 401.
 */
export async function sign(secret: string, signedDate: string, method: string, path: string, query = ""): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(signedDate + method + path + query));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** UTC 기준 YYMMDDTHHMMSSZ — 예 251017T123456Z. (서버가 자기 시계와 몇 분 안으로 맞는지 본다) */
export function signedDateOf(d: Date = new Date()): string {
  const t = d.toISOString(); // 2025-10-17T12:34:56.789Z
  return `${t.slice(2, 4)}${t.slice(5, 7)}${t.slice(8, 10)}T${t.slice(11, 13)}${t.slice(14, 16)}${t.slice(17, 19)}Z`;
}

/**
 * query 에 들어갈 값 인코딩. encodeURIComponent 는 `'` 를 그대로 두는데, fetch 의 주소 정리가 그것을 `%27` 로 바꿔 보내서
 * 서명한 글자와 보낸 글자가 달라진다 — 미리 바꿔 둔다. (`!*()~` 는 주소 정리가 건드리지 않는다)
 */
const encodeQ = (s: string) => encodeURIComponent(s).replace(/'/g, "%27");

/* ============================================================ 저장 파일 */

interface KeyFile {
  access_key?: string; secret_key?: string; enabled?: boolean; mode?: string;
  max_links?: number; per_hour?: number; disclosure?: string; default_sub_id?: string;
  last_test?: { ok: boolean; at: string; message: string } | null;
  last_error?: { at: string; why: string; channel: string; file: string } | null;
  [k: string]: unknown;
}
interface Creds { access: string; secret: string }

const keysIn = (d: KeyFile) => typeof d.access_key === "string" && d.access_key.trim() !== "" &&
  typeof d.secret_key === "string" && d.secret_key.trim() !== "";

function readCreds(): Creds | null {
  const d = readJsonSync<KeyFile>(FILE.keys(), {});
  return keysIn(d) ? { access: String(d.access_key).trim(), secret: String(d.secret_key).trim() } : null;
}

function clampInt(v: unknown, lo: number, hi: number, d: number): number {
  if (v === undefined || v === null || v === "") return d;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
/** subId 는 영문·숫자만, 30자 (쿠팡이 다른 글자를 받지 않는다) */
const cleanSubId = (v: unknown) => String(v ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 30);
/** 고지문: 한 줄, 꺾쇠 없음(유튜브 설명에 못 쓴다), 비면 기본 문구 */
function cleanDisclosure(v: unknown): string {
  const t = cut(String(v ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim(), 300);
  return t || DEFAULT_DISCLOSURE;
}

/** 지금 설정. 열쇠 값은 담지 않는다. (파일을 매번 읽는다 — 작고, 화면이 바꾼 값이 곧바로 보이게) */
export function loadSettings(): Settings {
  const d = readJsonSync<KeyFile>(FILE.keys(), {});
  const lt = d.last_test;
  return {
    enabled: d.enabled === true,
    mode: d.mode === "rule" ? "rule" : "auto",
    maxLinks: clampInt(d.max_links, 1, 3, 3),
    perHour: clampInt(d.per_hour, 1, 100, 10),
    disclosure: cleanDisclosure(d.disclosure),
    defaultSubId: cleanSubId(d.default_sub_id),
    connected: keysIn(d),
    lastTest: lt && typeof lt === "object"
      ? { ok: !!lt.ok, at: String(lt.at ?? ""), message: String(lt.message ?? "") }
      : null,
  };
}

export function hasKeys(): boolean {
  return keysIn(readJsonSync<KeyFile>(FILE.keys(), {}));
}

/** 이 모듈의 파일을 만지는 짧은 일은 전부 한 잠금 안에서 (프로세스 사이에서도). 같은 잠금을 겹쳐 잡으면 멈추니 **겹쳐 부르지 않는다.** */
async function locked<T>(일: () => Promise<T>): Promise<T> {
  return (await withFileLock(FILE.lock(), 일)) as T;
}

/** 바꾼 칸만 적는다. 열쇠는 여기서 안 다룬다(바꾸려면 connect). */
export async function saveSettings(patch: SettingsPatch): Promise<void> {
  await locked(async () => {
    const d = await readJson<KeyFile>(FILE.keys(), {});
    if (patch.enabled !== undefined) d.enabled = !!patch.enabled;
    if (patch.mode !== undefined) d.mode = patch.mode === "rule" ? "rule" : "auto";
    if (patch.maxLinks !== undefined) d.max_links = clampInt(patch.maxLinks, 1, 3, 3);
    if (patch.perHour !== undefined) d.per_hour = clampInt(patch.perHour, 1, 100, 10);
    if (patch.disclosure !== undefined) d.disclosure = cleanDisclosure(patch.disclosure);
    if (patch.defaultSubId !== undefined) d.default_sub_id = cleanSubId(patch.defaultSubId);
    await writeJson(FILE.keys(), d, { secret: true });
  });
}

/* ============================================================ 글 다듬기 · 숨기기 */

const stampOf = (now: Date): string => {
  try { return isoWall(wallNow(systemZone(), now)); } catch { return ""; } // 시각이 이상해도 기록을 못 남길 이유는 아니다
};

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 글 속에 열쇠·서명이 섞여 있으면 가린다 — 서버가 요청을 되받아 적는 오류 글이 있을 수 있다. */
function scrub(text: string, creds?: Creds | null): string {
  let t = String(text ?? "");
  for (const v of [creds?.access, creds?.secret]) if (v && v.length >= 4) t = t.split(v).join("***");
  return t.replace(/signature=[0-9a-f]{16,}/gi, "signature=***").replace(/access-key=[^\s,]+/gi, "access-key=***");
}

/** 상품명: 한 줄로, 꺾쇠는 뺀다(유튜브 설명에 못 쓴다). 줄바꿈이 섞여 있으면 가짜 줄이 끼어들 수 있다. */
const cleanName = (s: unknown) => String(s ?? "").replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/** 40자(코드포인트)까지, 넘으면 … 로 끝낸다 */
function shortName(n: string, max = 40): string {
  const cps = Array.from(n);
  return cps.length <= max ? n : cps.slice(0, max - 1).join("").trimEnd() + "…";
}

/** 파트너스 추적 링크인가 — 쿠팡이 준 주소만 설명에 싣는다(응답이 깨졌거나 바뀌어도 엉뚱한 주소가 영상에 붙지 않게). */
function isPartnerUrl(u: unknown): u is string {
  if (typeof u !== "string" || /[<>\s]/.test(u)) return false;
  try {
    const x = new URL(u);
    return x.protocol === "https:" && (x.hostname === "link.coupang.com" || x.hostname === "coupa.ng");
  } catch { return false; } // 주소 꼴이 아니면 추적 링크가 아니다
}

/* ============================================================ 설명 글 붙이기 */

// coupang.com(하위 주소 포함)·coupa.ng 주소. 앞뒤가 영숫자·하이픈이면 다른 낱말의 일부(예: notcoupang.com, coupangplay.com)라 뺀다.
const HUMAN_LINK = /(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*coupang\.com(?![a-z0-9-])|(?:^|[^a-z0-9-])coupa\.ng(?![a-z0-9-])/i;
const DISCLOSURE_RE = /쿠팡\s*파트너스\s*활동의\s*일환/;

/** 사람이 쿠팡 주소를 넣었나 (coupang.com / link.coupang.com / coupa.ng) */
export function hasHumanLink(text: string): boolean {
  return HUMAN_LINK.test(String(text ?? ""));
}
/** 고지문(「쿠팡 파트너스 활동의 일환」)이 이미 있나 */
export function hasDisclosure(text: string): boolean {
  return DISCLOSURE_RE.test(String(text ?? ""));
}

const BLOCK_HEAD = "🛒 영상에 나온 소재와 관련된 상품";

/**
 * 설명 끝에 붙일 블록. 링크가 없으면 빈 글. 맨 앞의 `\n` 은 설명과 사이를 띄우는 빈 줄이다(applyBlock 이 빈 줄을 정확히 한 줄로 맞춘다).
 *   (장바구니 그림) 영상에 나온 소재와 관련된 상품        ← BLOCK_HEAD
 *   (점) 상품명(40자까지)
 *     https://link.coupang.com/…                          ← 상품마다 이 두 줄
 *   (빈 줄) 고지문
 */
export function buildBlock(links: Link[], disclosure?: string): string {
  const lines: string[] = [];
  for (const l of links ?? []) {
    const url = String(l?.url ?? "").trim();
    const name = shortName(cleanName(l?.name));
    if (!url || !name) continue;
    lines.push(`• ${name}`, `  ${url}`);
  }
  if (!lines.length) return "";
  return `\n${BLOCK_HEAD}\n${lines.join("\n")}\n\n${cleanDisclosure(disclosure)}`;
}

/**
 * 설명 끝에 블록을 붙인다. 합쳐서 limit(5000)자(코드포인트) 안이 되게 **설명 쪽을 줄인다** — 블록(링크·고지문)은 한 글자도 안 깎는다.
 * 코드포인트로 세므로 이모지(서로게이트 쌍)를 반으로 가르지 않는다. 이미 같은 블록이 붙어 있으면 두 번 붙이지 않는다.
 */
export function applyBlock(desc: string, block: string, limit = 5000): string {
  const orig = String(desc ?? "");
  const tail = String(block ?? "").replace(/^\n+/, "").replace(/\s+$/, "");
  if (!tail) return orig;
  const base = orig.replace(/\s+$/, "");
  if (base.includes(tail)) return orig;
  const sep = base ? "\n\n" : "";
  const room = limit - Array.from(tail).length - sep.length;
  if (room < 0) return cut(orig, limit); // 블록이 한도보다 길면 붙이지 않는다 (있을 수 없는 일이지만 설명을 깨뜨리진 않는다)
  const head = Array.from(base).length > room ? cut(base, room).replace(/\s+$/, "") : base;
  return head ? head + sep + tail : tail;
}

/* ============================================================ 호출 한도 (시간당) */

interface CallsFile { search?: number[]; deeplink?: number[] }
type CallKind = "search" | "deeplink";

/** 최근 1시간 안의 호출 시각들 (오래된 것부터). 지금보다 한 시간 넘게 앞선 값(시계가 크게 틀어졌던 흔적)도 버린다. */
function liveTimes(list: unknown, now: Date): number[] {
  const t = now.getTime();
  return (Array.isArray(list) ? list : []).map(Number)
    .filter((x) => Number.isFinite(x) && t - x < HOUR_MS && x - t < HOUR_MS)
    .sort((a, b) => a - b);
}
/** 한 칸이 풀릴 때까지 남은 분 — 가득 찼을 때 (used - limit + 1)번째 오래된 호출이 빠지면 한 칸이 난다 */
function waitMinutes(live: number[], limit: number, now: Date): number {
  const t = live[Math.max(0, live.length - limit)];
  return Math.max(1, Math.ceil((t + HOUR_MS - now.getTime()) / 60_000));
}

/** 검색 호출 현황. resetMin = 가득 찼을 때 한 칸이 풀리기까지 남은 분(가득 차지 않았으면 0). */
export function usage(now: Date = new Date()): { used: number; limit: number; resetMin: number } {
  const limit = loadSettings().perHour;
  const live = liveTimes(readJsonSync<CallsFile>(FILE.calls(), {}).search, now);
  return { used: live.length, limit, resetMin: live.length >= limit ? waitMinutes(live, limit, now) : 0 };
}

/** 호출 자리를 잡는다 — 세고 적는 일을 한 잠금 안에서 해야 동시에 온 두 영상이 한도를 넘지 않는다. */
async function reserve(kind: CallKind, limit: number, now: Date): Promise<{ ok: true } | { ok: false; waitMin: number }> {
  return await locked(async () => {
    const d = await readJson<CallsFile>(FILE.calls(), {});
    const live = liveTimes(d[kind], now);
    if (live.length >= limit) return { ok: false as const, waitMin: waitMinutes(live, limit, now) };
    live.push(now.getTime());
    live.sort((a, b) => a - b);
    d[kind] = live;
    await writeJson(FILE.calls(), d, { indent: 0 });
    return { ok: true as const };
  });
}

/* ============================================================ 쿠팡 부르기 */

type ErrKind = "key" | "limit" | "local-limit" | "timeout" | "net" | "http" | "data";
class CoupangError extends Error {
  constructor(public kind: ErrKind, message: string) { super(message); this.name = "CoupangError"; }
}
const MSG_KEY = "열쇠가 틀렸거나 파트너스 최종 승인 전입니다 — 쿠팡 파트너스에서 Access Key·Secret Key 를 다시 확인해 주세요 (컴퓨터 시계가 크게 틀려도 같은 오류가 납니다)";
const MSG_429 = "쿠팡 파트너스 호출 한도에 걸렸습니다 (시간당 약 10회) — 잠시 뒤에 다시 시도합니다";

interface Ctx { now: Date; perHour: number; creds: Creds }

/** 쿠팡 응답 몸에서 사람이 읽을 한마디 (열쇠는 가려서) */
function bodyHint(j: unknown, creds: Creds): string {
  const o = j as { message?: unknown; rMessage?: unknown } | null;
  const m = String(o?.rMessage || o?.message || "").trim();
  return m ? ` — ${cut(scrub(m, creds), 80)}` : "";
}

/**
 * 쿠팡 API 한 번. 한도 자리를 먼저 잡고(reserve) → 서명 → 보내기 → 읽기. 실패는 전부 CoupangError.
 * 시간 초과는 15초(응답 몸을 읽는 동안도 포함).
 */
async function callApi(c: Ctx, kind: CallKind, method: "GET" | "POST", path: string, query: string, body?: unknown): Promise<any> {
  const limit = kind === "search" ? c.perHour : DEEPLINK_PER_HOUR;
  const r = await reserve(kind, limit, c.now);
  if (!r.ok) {
    throw new CoupangError("local-limit", `호출 한도(시간당 ${limit}회)를 다 써서 건너뜁니다 — 약 ${r.waitMin}분 뒤에 다시 시도할 수 있습니다`);
  }
  const signedDate = signedDateOf();
  const signature = await sign(c.creds.secret, signedDate, method, path, query);
  // Content-Type 은 몸이 없는 GET 에도 싣는다 — 쿠팡 공식 예제가 모든 요청에 같이 보낸다
  const headers: Record<string, string> = {
    Authorization: `CEA algorithm=HmacSHA256, access-key=${c.creds.access}, signed-date=${signedDate}, signature=${signature}`,
    "Content-Type": "application/json;charset=UTF-8",
  };
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const url = BASE + path + (query ? "?" + query : "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  let status = 0, text = "";
  try {
    const res = await doFetch(url, { method, headers, body: payload, signal: ctl.signal });
    status = res.status;
    text = await res.text();
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? "";
    if (ctl.signal.aborted || name === "TimeoutError" || name === "AbortError") {
      throw new CoupangError("timeout", `쿠팡 서버가 ${Math.round(timeoutMs / 1000)}초 안에 답하지 않았습니다`);
    }
    throw new CoupangError("net", `쿠팡 서버에 연결하지 못했습니다 — ${cut(scrub(msgOf(e), c.creds), 100)}`);
  } finally {
    clearTimeout(timer);
  }
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* 아래에서 형식 오류로 알린다 */ }
  if (status === 401 || status === 403) throw new CoupangError("key", MSG_KEY);
  if (status === 429) throw new CoupangError("limit", MSG_429);
  if (status < 200 || status >= 300) {
    throw new CoupangError("http", `쿠팡 서버가 오류로 답했습니다 (HTTP ${status})${bodyHint(j, c.creds)}`);
  }
  if (!j || typeof j !== "object") throw new CoupangError("data", "쿠팡이 알아볼 수 없는 답을 보냈습니다 (JSON 이 아님)");
  const rc = String(j.rCode ?? "");
  if (rc !== "" && rc !== "0") {
    if (rc === "401" || rc === "403") throw new CoupangError("key", MSG_KEY);
    if (rc === "429") throw new CoupangError("limit", MSG_429);
    throw new CoupangError("data", `쿠팡이 요청을 받아들이지 않았습니다 (코드 ${cut(scrub(rc, c.creds), 10)})${bodyHint(j, c.creds)}`);
  }
  if (rc === "" && j.data === undefined) throw new CoupangError("data", "쿠팡이 알아볼 수 없는 답을 보냈습니다 (결과 칸이 없음)");
  return j;
}

/** catch 에서 잡은 것을 CoupangError 로 (우리 쪽 예상 못한 오류도 한국어 한 줄로) */
function asErr(e: unknown, creds?: Creds | null): CoupangError {
  return e instanceof CoupangError ? e : new CoupangError("net", `예상 못한 오류 — ${cut(scrub(msgOf(e), creds), 120)}`);
}

/* ============================================================ 상품 검색 · 캐시 */

interface Product { id: string; name: string; price: number; url: string }

function normProduct(r: any): Product | null {
  const name = cleanName(r?.productName);
  if (!name) return null;
  return { id: String(r?.productId ?? "").trim(), name, price: Number(r?.productPrice) || 0, url: String(r?.productUrl ?? "").trim() };
}

/** 쿠팡에 검색 한 번 (캐시 없이). 열쇠 시험도 이 길을 쓴다. */
async function fetchSearch(c: Ctx, keyword: string, subId: string): Promise<Product[]> {
  const query = `keyword=${encodeQ(keyword)}&limit=${SEARCH_LIMIT}` + (subId ? `&subId=${encodeQ(subId)}` : "");
  const j = await callApi(c, "search", "GET", SEARCH_PATH, query);
  const raw = j?.data?.productData;
  return (Array.isArray(raw) ? raw : []).map(normProduct).filter((p): p is Product => !!p);
}

interface CacheEntry { ms: number; products: Product[] }
type CacheFile = Record<string, CacheEntry>;
const cacheKey = (kw: string, subId: string) => `${kw.trim().toLowerCase()}|${subId}`;

async function cacheGet(key: string, now: Date): Promise<Product[] | null> {
  const e = (await readJson<CacheFile>(FILE.cache(), {}))[key];
  if (!e || !Array.isArray(e.products) || now.getTime() - e.ms >= CACHE_MS) return null;
  return e.products;
}
async function cachePut(key: string, products: Product[], now: Date): Promise<void> {
  await locked(async () => {
    const d = await readJson<CacheFile>(FILE.cache(), {});
    d[key] = { ms: now.getTime(), products };
    const keys = Object.keys(d);
    if (keys.length > MAX_CACHE) {
      keys.sort((a, b) => (d[a].ms ?? 0) - (d[b].ms ?? 0));
      for (const k of keys.slice(0, keys.length - MAX_CACHE)) delete d[k];
    }
    await writeJson(FILE.cache(), d, { indent: 0 });
  });
}

/** 같은 키워드+subId 는 24시간 동안 다시 부르지 않는다 (시간당 10회를 아끼려고). force 면 캐시를 건너뛰고 새로 받아 덮는다. */
async function searchCached(c: Ctx, keyword: string, subId: string, force: boolean): Promise<Product[]> {
  const key = cacheKey(keyword, subId);
  if (!force) {
    const hit = await cacheGet(key, c.now);
    if (hit) return hit;
  }
  const products = await fetchSearch(c, keyword, subId);
  try {
    await cachePut(key, products, c.now);
  } catch (e) {
    await recordLine(LOG, `검색 캐시를 못 적었습니다 — ${cut(scrub(msgOf(e), c.creds), 100)}`); // 캐시는 덤이다 — 결과는 그대로 쓴다
  }
  return products;
}

/* ============================================================ 관련도 · 중복 · 링크 만들기 */

/** 글자·숫자만 남긴 비교용 글 */
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** 검색어의 낱말들 (2자 이상. 모두 한 글자뿐이면 검색어 통째로) */
function queryTokens(q: string): string[] {
  const toks = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  return toks.length ? toks : [squash(q)].filter(Boolean);
}
/** 상품명이 낱말을 하나라도 담았나 (띄어쓰기가 달라도 맞게 공백 뺀 글도 본다) */
function nameHas(name: string, toks: string[]): boolean {
  const n = name.toLowerCase(), s = squash(name);
  return toks.some((t) => n.includes(t) || s.includes(squash(t)));
}

/**
 * 거의 같은 이름인가 — 같거나, 한쪽이 다른 쪽의 80% 이상을 담거나, 앞 10자가 같으면(같은 상품의 색·용량 판)
 * 같은 상품으로 본다. 한 영상에 같은 상품 세 판이 나란히 붙는 것을 막는다.
 */
function nearSame(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 6 && l.includes(s) && s.length / l.length >= 0.8) return true;
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i >= 10;
}

/** 검색어별 후보 목록에서 번갈아 한 개씩 고른다 (검색어가 둘이면 둘 다 한 개씩 들어가게). 같은 상품ID·거의 같은 이름은 뺀다. */
function selectProducts(lists: Product[][], n: number): Product[] {
  const out: Product[] = [], names: string[] = [];
  for (let i = 0; out.length < n; i++) {
    let any = false;
    for (const l of lists) {
      if (i >= l.length) continue;
      any = true;
      const p = l[i], sq = squash(p.name);
      if (out.some((x) => p.id && x.id === p.id) || names.some((nm) => nearSame(nm, sq))) continue;
      out.push(p); names.push(sq);
      if (out.length >= n) break;
    }
    if (!any) break;
  }
  return out;
}

/** 고른 상품 → 링크. link.coupang.com 이면 그대로, 아니면 딥링크 API 한 번으로 바꾼다(실패한 상품은 뺀다). */
async function makeLinks(c: Ctx, picks: Product[], subId: string): Promise<{ links: Link[]; err: CoupangError | null }> {
  const found: (Link | null)[] = picks.map((p) =>
    isPartnerUrl(p.url) ? { name: p.name, url: p.url, ...(p.price > 0 ? { price: p.price } : {}) } : null
  );
  const need = picks.map((p, i) => (found[i] || !/^\d+$/.test(p.id) ? -1 : i)).filter((i) => i >= 0);
  let err: CoupangError | null = null;
  if (need.length) {
    const urls = need.map((i) => `https://www.coupang.com/vp/products/${picks[i].id}`);
    try {
      const j = await callApi(c, "deeplink", "POST", DEEPLINK_PATH, "", { coupangUrls: urls, ...(subId ? { subId } : {}) });
      const data: any[] = Array.isArray(j?.data) ? j.data : [];
      need.forEach((i, k) => {
        const item = data.find((x) => x?.originalUrl === urls[k]) ?? (data.length === need.length ? data[k] : undefined);
        const u = [item?.shortenUrl, item?.landingUrl].find(isPartnerUrl);
        if (u) found[i] = { name: picks[i].name, url: u, ...(picks[i].price > 0 ? { price: picks[i].price } : {}) };
      });
    } catch (e) {
      err = asErr(e, c.creds);
    }
  }
  return { links: found.filter((l): l is Link => !!l), err };
}

/* ============================================================ 검색어 만들기 (규칙) */

// 규칙 모드(AI 열쇠가 없을 때)는 **보수적으로**: 억지로 붙이느니 안 붙인다. 아래 목록은 그 보수성의 재료다.

// 뉴스·정치·사건사고 영상에는 상품 링크를 붙이지 않는다 — 시청자가 거슬려 하고, 사건 피해자 영상에 물건을 파는 모양이 되기 쉽다.
// 제목·태그에 아래 낱말이 하나라도 들어 있으면(부분 일치) 검색도 하지 않는다. 「사고」(사다+고)처럼 쇼핑 글에도 흔한 낱말은 뺐다.
const NEWS_WORDS = [
  "뉴스", "속보", "단독", "기자", "보도", "news", "breaking",
  "정치", "대통령", "국회", "의원", "여당", "야당", "정당", "대선", "총선", "선거", "탄핵", "청와대", "대통령실", "정부", "장관", "총리",
  "검찰", "경찰", "법원", "재판", "판결", "구속", "체포", "수사", "기소", "영장",
  "사건", "교통사고", "추돌", "사망", "사상자", "부상자", "화재", "폭행", "살인", "범죄", "피의자", "피해자",
  "전쟁", "시위", "테러", "참사", "붕괴", "폭발", "추락", "실종", "지진", "태풍", "재난",
  "논란", "의혹", "비리", "갑질",
];

// 상품 이름이 아닌 흔한 낱말 — 태그·제목에 늘 있어서 검색어로 쓰면 아무 상품이나 걸린다.
const STOP = new Set<string>([
  "영상", "쇼츠", "숏츠", "shorts", "short", "유튜브", "youtube", "채널", "구독", "좋아요", "알림", "댓글", "공유", "썸네일",
  "브이로그", "vlog", "일상", "오늘", "어제", "내일", "이번", "다음", "지금", "요즘", "최근", "올해", "작년",
  "추천", "리뷰", "후기", "정보", "꿀팁", "방법", "하는법", "이야기", "소개", "비교", "정리", "모음", "순위", "베스트", "인기",
  "진짜", "정말", "너무", "완전", "그냥", "아주", "매우", "가장", "제일", "최고", "대박", "레전드", "충격", "실화", "반전", "놀라운",
  "여러분", "안녕하세요", "감사합니다", "이것", "그것", "저것", "이거", "그거", "저거", "우리", "사람", "사람들", "한국", "세계",
  "있는", "없는", "하는", "되는", "같은", "hd", "fyp", "viral",
]);

// 낱말 끝의 조사. 「텀블러를」→「텀블러」. 이·가·도·만·로·에 는 뺐다 — 고양이·옷걸이·손잡이처럼 낱말의 일부인 경우가 많다.
const PARTICLES = ["에서는", "이라고", "에서", "으로", "까지", "부터", "처럼", "에게", "한테", "라고", "에는", "보다", "은", "는", "을", "를", "와", "과", "의"];
function stripParticle(w: string): string {
  for (const p of PARTICLES) if (w.length - p.length >= 2 && w.endsWith(p)) return w.slice(0, -p.length);
  return w;
}

/** 글에서 상품 낱말 후보 (2자 이상, 숫자로 시작하는 것과 불용어 제외) */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const w = stripParticle(raw);
    if (w.length < 2 || /^\p{N}/u.test(w) || STOP.has(w) || STOP.has(raw)) continue;
    out.push(w);
  }
  return out;
}
/** 후보: 태그 → 제목 → 설명 앞부분 차례(태그가 소재를 가장 직접 말한다). 첫 후보 하나만 검색한다. */
function ruleCandidates(title: string, desc: string, tags: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  const add = (txt: string) => { for (const w of wordsOf(txt)) if (!seen.has(w)) { seen.add(w); out.push(w); } };
  for (const t of tags) add(t);
  add(title);
  add(cut(desc, 300));
  return out.slice(0, 5);
}
const newsWordIn = (title: string, tags: string[]): string | null => {
  const hay = `${title} ${tags.join(" ")}`.toLowerCase();
  return NEWS_WORDS.find((w) => hay.includes(w)) ?? null;
};

/** AI 가 준 검색어 다듬기 — 한 줄, 꺾쇠 없음, 50자, 중복 없음, 최대 3개 */
function cleanQueries(list: unknown[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const x of list) {
    const q = cut(String(x ?? "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim(), 50);
    const k = q.toLowerCase();
    if (!q || seen.has(k)) continue;
    seen.add(k); out.push(q);
    if (out.length >= 3) break;
  }
  return out;
}

/** 기본 검색어 만들기 = ai.ts 의 productQueries. 꼴이 달라도 종류 칸만 맞춰 건넨다. */
const defaultAi: NonNullable<PickInput["aiQueries"]> = (x) =>
  productQueries({ ...x, kind: x.kind === "쇼츠" || x.kind === "롱폼" ? x.kind : undefined });

/* ============================================================ 영상별 기록 */

interface Rec {
  file: string; channel: string; at: string; ms: number; status: PickStatus;
  links: Link[]; queries: string[]; why: string; block: string; videoId?: string;
}
type RecFile = Record<string, Rec>;

/** 영상을 가리키는 열쇠 = 파일경로|크기|수정시각ms (파일이 바뀌면 다른 영상으로 본다) */
function keyOf(file: string): string {
  let size = 0, mtime = 0;
  try {
    const st = Deno.statSync(file);
    size = st.size;
    mtime = Math.trunc(st.mtime?.getTime() ?? 0);
  } catch { /* 파일이 없으면 0|0 — 미리보기·시험에서 가짜 경로도 같은 열쇠로 모인다 */ }
  return `${file}|${size}|${mtime}`;
}

// 영상 벽이 영상마다 recordFor 를 부른다 — 파일이 안 바뀌었으면 다시 읽지 않는다(바뀌면 inode·크기·수정시각이 달라진다).
let recMemo: { sig: string; value: RecFile } | null = null;
function recsSync(): RecFile {
  const p = FILE.records();
  try {
    const st = Deno.statSync(p);
    const sig = `${p}:${st.ino ?? 0}:${st.size}:${st.mtime?.getTime() ?? 0}`;
    if (recMemo?.sig === sig) return recMemo.value;
    const value = readJsonSync<RecFile>(p, {});
    recMemo = { sig, value };
    return value;
  } catch { return {}; } // 기록 파일이 아직 없다
}

async function putRecord(key: string, rec: Rec): Promise<void> {
  await locked(async () => {
    const d = await readJson<RecFile>(FILE.records(), {});
    if (d[key]?.videoId && !rec.videoId) rec.videoId = d[key].videoId; // 올린 영상 id 는 다시 골라도 잃지 않는다
    d[key] = rec;
    const keys = Object.keys(d);
    if (keys.length > MAX_RECORDS) {
      keys.sort((a, b) => (d[a].ms ?? 0) - (d[b].ms ?? 0));
      for (const k of keys.slice(0, keys.length - MAX_RECORDS)) delete d[k];
    }
    await writeJson(FILE.records(), d, { indent: 0 });
    recMemo = null;
  });
}

/** 기록 → Pick. 붙임은 지금 고지문으로 블록을 다시 만든다(고지문을 고친 뒤에도 최신 글이 붙게). */
function fromRec(rec: Rec, s: Settings): Pick {
  const links = Array.isArray(rec.links) ? rec.links : [];
  return {
    status: rec.status, links, queries: Array.isArray(rec.queries) ? rec.queries : [], why: String(rec.why ?? ""), at: String(rec.at ?? ""),
    block: rec.status === "붙임" ? buildBlock(links, s.disclosure) : String(rec.block ?? ""),
  };
}

/** 영상 한 편의 기록을 읽는다 (호출 없음 — 화면·미리보기용) */
export function recordFor(file: string): (Pick & { videoId?: string }) | null {
  const rec = recsSync()[keyOf(file)];
  if (!rec) return null;
  const p = fromRec(rec, loadSettings());
  return rec.videoId ? { ...p, videoId: rec.videoId } : p;
}

/** 올린 영상의 id 를 기록에 붙인다 (기록이 없으면 아무것도 안 한다) */
export async function attachVideoId(file: string, videoId: string): Promise<void> {
  const key = keyOf(file);
  await locked(async () => {
    const d = await readJson<RecFile>(FILE.records(), {});
    if (!d[key]) return;
    d[key].videoId = String(videoId);
    await writeJson(FILE.records(), d, { indent: 0 });
    recMemo = null;
  });
}

/** 그 영상의 기록을 지워 다시 고르게 한다. 지울 것이 있었으면 true */
export async function clearRecord(file: string): Promise<boolean> {
  const key = keyOf(file);
  return await locked(async () => {
    const d = await readJson<RecFile>(FILE.records(), {});
    if (!d[key]) return false;
    delete d[key];
    await writeJson(FILE.records(), d, { indent: 0 });
    recMemo = null;
    return true;
  });
}

/* ============================================================ 영상 고르기 */

/** 마지막 오류를 열쇠 파일에 적어 둔다(열쇠 값 없이). 열쇠 파일이 아직 없으면 만들지 않는다. */
async function noteError(why: string, channel: string, file: string, now: Date): Promise<void> {
  try {
    await locked(async () => {
      const d = await readJson<KeyFile>(FILE.keys(), {});
      if (!keysIn(d)) return;
      d.last_error = { at: stampOf(now), why, channel, file: baseName(file) };
      await writeJson(FILE.keys(), d, { secret: true });
    });
  } catch (e) {
    await recordLine(LOG, `마지막 오류를 못 적었습니다 — ${cut(scrub(msgOf(e)), 100)}`);
  }
}

/** 결과를 기록과 로그에 남긴다. 못 남겨도 결과는 그대로 돌려준다. key = 고르기 시작할 때 구한 영상 열쇠 */
async function settle(o: PickInput, now: Date, p: Pick, key: string): Promise<void> {
  try {
    await putRecord(key, {
      file: o.file, channel: o.channel, at: p.at, ms: now.getTime(),
      status: p.status, links: p.links, queries: p.queries, why: p.why, block: p.block,
    });
  } catch (e) {
    await recordLine(LOG, `영상 기록을 못 적었습니다 — ${cut(scrub(msgOf(e)), 100)}`);
  }
  await recordLine(LOG, `[${o.channel}] ${baseName(o.file)} — ${p.status}${p.links.length ? ` ${p.links.length}건` : ""}: ${cut(p.why, 120)}`);
  if (p.status === "건너뜀") await noteError(p.why, o.channel, o.file, now);
}

async function giveUp(o: PickInput, now: Date, why: string, queries: string[]): Promise<Pick & { cached: boolean }> {
  const p: Pick = { status: "건너뜀", links: [], queries, why, at: stampOf(now), block: "" };
  try { await settle(o, now, p, keyOf(o.file)); } catch { /* settle 이 이미 로그를 남기고 삼킨다 — 여기서 던지면 안 된다 */ }
  return { ...p, cached: false };
}

function modeFor(channel: string, s: Settings): "auto" | "rule" {
  const m = confFor(channel)?.coupang?.mode;
  return m === "auto" || m === "rule" ? m : s.mode;
}

async function askAi(o: PickInput, text: { title: string; desc: string; tags: string[] }): Promise<{ queries: string[] } | null> {
  const fn = o.aiQueries ?? defaultAi;
  try {
    const r = await fn({ ...text, channel: o.channel, kind: o.kind });
    return r && Array.isArray(r.queries) ? r : null;
  } catch (e) {
    await recordLine(LOG, `AI 검색어 만들기에 실패해 규칙으로 갑니다 — ${cut(scrub(msgOf(e)), 120)}`);
    return null;
  }
}

async function pickInner(o: PickInput, now: Date): Promise<Pick & { cached: boolean }> {
  const s = loadSettings();
  const at = stampOf(now);
  const key = keyOf(o.file);
  const mk = (status: PickStatus, why: string, extra: Partial<Pick> = {}): Pick & { cached: boolean } =>
    ({ status, links: [], queries: [], why, at, block: "", ...extra, cached: false });
  const done = async (p: Pick & { cached: boolean }) => { await settle(o, now, p, key); return p; };

  // 1. 켜짐·열쇠·채널 — 꺼진 것은 기록도 안 남긴다(다시 켠 뒤 30분을 기다리게 하지 않으려고)
  if (!s.enabled) return mk("건너뜀", "쿠팡 파트너스 자동 링크가 꺼져 있습니다");
  const creds = readCreds();
  if (!s.connected || !creds) return mk("건너뜀", "쿠팡 파트너스 열쇠가 없습니다 — 설정에서 연결해 주세요");
  const cc = confFor(o.channel)?.coupang;
  if (cc?.on === false || cc?.mode === "off") return mk("건너뜀", "이 채널은 쿠팡 링크를 붙이지 않도록 정해져 있습니다");

  const title = String(o.title ?? ""), desc = String(o.desc ?? "");
  const tags = (Array.isArray(o.tags) ? o.tags : []).map((t) => String(t ?? "").replace(/^#+/, "").trim()).filter(Boolean);

  // 2. 사람이 넣은 쿠팡 링크 — 그것이 우선이다. 자동 검색은 안 하고, 고지문이 없을 때 고지문만 붙인다
  if (hasHumanLink(desc) || hasHumanLink(title)) {
    const need = !hasDisclosure(desc);
    return await done(mk("사람이넣음", need
      ? "설명에 이미 쿠팡 링크가 있어 자동 검색은 하지 않고 고지문만 붙입니다"
      : "설명에 이미 쿠팡 링크와 고지문이 있어 그대로 둡니다", { block: need ? "\n" + s.disclosure : "" }));
  }

  // 3. 같은 영상(파일경로|크기|수정시각)에서 이미 정한 것은 다시 검색하지 않는다. 건너뜀은 30분 뒤에 다시 시도한다.
  if (!o.force) {
    const old = (await readJson<RecFile>(FILE.records(), {}))[key];
    if (old) {
      const age = now.getTime() - (old.ms ?? 0);
      if (old.status === "붙임" || old.status === "없음") return { ...fromRec(old, s), cached: true };
      if (old.status === "건너뜀" && age >= 0 && age < RETRY_MS) return { ...fromRec(old, s), cached: true };
      // 사람이넣음 기록은 쓰지 않는다 — 2번에서 지금 설명을 보고 새로 정한다(링크를 지웠으면 바뀌어야 한다)
    }
  }

  // 4. 검색어
  const ctx: Ctx = { now, perHour: s.perHour, creds };
  const subId = subIdFor(o.channel);
  let queries: string[] | null = null; // null = AI 를 못 써서 규칙으로
  let ruleWord = "";
  if (modeFor(o.channel, s) === "auto") {
    const ai = await askAi(o, { title, desc, tags });
    if (ai) {
      queries = cleanQueries(ai.queries);
      // 빈 목록은 AI 의 판단이다: 이 영상과 관련된 상품이 없다 → 호출 없이 확정
      if (!queries.length) return await done(mk("없음", "AI 가 이 영상과 관련된 상품이 없다고 판단했습니다"));
    }
  }
  if (queries === null) {
    const news = newsWordIn(title, tags);
    if (news) return await done(mk("없음", `뉴스·정치·사건사고 영상으로 보여(「${news}」) 상품 링크를 붙이지 않습니다`));
    const cand = ruleCandidates(title, desc, tags);
    if (!cand.length) return await done(mk("없음", "제목·태그에서 상품으로 찾을 만한 낱말이 없습니다"));
    ruleWord = cand[0];
    queries = [ruleWord];
  }
  queries = queries.slice(0, MAX_SEARCHES);

  // 5. 검색 — 검색어마다 한도 확인 → 캐시 → 호출. 오류는 키워드 탓이 아니니 첫 오류에서 멈춘다.
  const lists: Product[][] = [];
  const asked: string[] = [];
  let err: CoupangError | null = null;
  for (const q of queries) {
    let products: Product[];
    try {
      products = await searchCached(ctx, q, subId, !!o.force);
    } catch (e) {
      err = asErr(e, creds);
      break;
    }
    asked.push(q);
    if (ruleWord) {
      // 규칙으로 고른 낱말은 검색 결과 위 10개 중 3개 이상이 상품명에 그 낱말을 담아야 「상품 낱말」로 인정한다
      const hits = products.slice(0, SEARCH_LIMIT).filter((p) => nameHas(p.name, [q]));
      if (hits.length < 3) return await done(mk("없음", `「${q}」는 상품 이름으로 확실하지 않아(검색 결과 중 ${hits.length}개만 일치) 붙이지 않습니다`, { queries: asked }));
      lists.push(hits);
    } else {
      const toks = queryTokens(q);
      lists.push(products.filter((p) => nameHas(p.name, toks)));
    }
  }
  const picks = selectProducts(lists, s.maxLinks);
  if (!picks.length) {
    if (err) return await done(mk("건너뜀", err.message, { queries: asked.length ? asked : queries }));
    return await done(mk("없음", `검색 결과에 「${asked.join("」·「")}」와 관련된 상품이 없습니다`, { queries: asked }));
  }

  // 6. 링크 — 추적 링크가 아닌 상품은 딥링크로 바꾼다
  const made = await makeLinks(ctx, picks, subId);
  if (!made.links.length) {
    if (made.err) return await done(mk("건너뜀", made.err.message, { queries: asked }));
    return await done(mk("없음", "고른 상품의 파트너스 링크를 만들지 못했습니다", { queries: asked }));
  }
  const links = made.links;
  // 둘째 검색어가 한도·오류로 막혔어도 첫째 결과로 붙인다 — 다만 까닭은 남겨 둔다
  const partial = err ? ` (일부 검색은 건너뜀 — ${cut(err.message, 60)})` : "";
  return await done(mk("붙임", `검색어 「${asked.join("」·「")}」로 상품 ${links.length}개를 골랐습니다${partial}`, {
    links, queries: asked, block: buildBlock(links, s.disclosure),
  }));
}

// 같은 영상을 동시에 두 곳(미리보기·올리기)이 고르면 한 번만 검색하게 묶는다
const inflight = new Map<string, Promise<Pick & { cached: boolean }>>();

/**
 * 영상 한 편에 붙일 상품을 고른다. **던지지 않는다** — 어떤 단계든 오류는 「건너뜀」+까닭으로 돌려준다.
 * 고른 결과는 영상별로 기록해 두고, 같은 영상은 다시 검색하지 않는다(force 면 다시).
 */
export async function pickForVideo(o: PickInput): Promise<Pick & { cached: boolean }> {
  const now = o.now ?? new Date();
  const key = keyOf(o.file) + (o.force ? "|force" : "");
  const running = inflight.get(key);
  if (running) return { ...(await running), cached: true };
  const job = (async () => {
    try {
      return await pickInner(o, now);
    } catch (e) {
      // 여기까지 새는 오류는 우리 쪽 어긋남이다 — 그래도 올리기를 막지 않고 까닭만 남긴다
      return await giveUp(o, now, `쿠팡 링크를 고르다 예상 못한 오류가 났습니다 — ${cut(scrub(msgOf(e), readCreds()), 120)}`, []);
    }
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

/**
 * 올리기 직전에 부른다: 설명 끝에 블록을 붙여 돌려준다. 이 채널에 꺼져 있으면 설명 그대로·pick null.
 * ★어떤 오류도 밖으로 던지지 않는다 — 쿠팡 쪽 사정으로 업로드가 막히면 안 된다.
 */
export async function forUpload(o: PickInput): Promise<{ desc: string; pick: Pick | null }> {
  try {
    if (!channelOn(o.channel)) return { desc: o.desc, pick: null };
    const pick = await pickForVideo(o);
    return { desc: pick.block ? applyBlock(o.desc, pick.block) : o.desc, pick };
  } catch (e) {
    await recordLine(LOG, `forUpload 에서 예상 못한 오류 — 설명은 그대로 올립니다: ${cut(scrub(msgOf(e), readCreds()), 120)}`);
    return { desc: o.desc, pick: null };
  }
}

/* ============================================================ 채널 · 입력 창 */

/** 이 채널에 자동 링크가 켜져 있나: 전체 켜짐 + 열쇠 있음 + 채널 coupang.on 이 false 가 아님 + 채널 mode 가 off 가 아님 */
export function channelOn(channelKey: string): boolean {
  const s = loadSettings();
  if (!s.enabled || !s.connected) return false;
  const c = confFor(channelKey)?.coupang;
  return !(c?.on === false || c?.mode === "off");
}

/** 수수료 집계용 구분 코드: 채널 sub_id > 전체 기본 > 빈 글 (영문·숫자만, 30자) */
export function subIdFor(channelKey: string): string {
  return cleanSubId(confFor(channelKey)?.coupang?.sub_id) || loadSettings().defaultSubId;
}

/** 열쇠 입력 창을 처음 보여 줄 때인가 — 한 번도 안 보여 줬고 열쇠도 없을 때만 */
export function needsPrompt(): boolean {
  return !appSettings().coupangPrompted && !hasKeys();
}
export async function markPrompted(): Promise<void> {
  await saveAppSettings({ coupangPrompted: true });
}

/* ============================================================ 연결 · 해제 */

/** 연결 시험: 열쇠가 살아 있는지 검색 한 번으로 본다 (캐시·기록은 건드리지 않는다) */
async function probe(c: Ctx): Promise<{ ok: true; sample: { name: string; price: number } | null } | { ok: false; message: string }> {
  try {
    const first = (await fetchSearch(c, TEST_WORD, ""))[0];
    return { ok: true, sample: first ? { name: shortName(first.name), price: first.price } : null };
  } catch (e) {
    return { ok: false, message: asErr(e, c.creds).message };
  }
}

/** 계정에 묶인 것(옛 계정의 추적 링크가 든 검색 캐시·아직 안 올린 영상의 붙임/건너뜀 기록·호출 횟수)을 비운다. 잠금 안에서 부를 것. */
async function purgeAccountBound(): Promise<void> {
  await writeJson(FILE.cache(), {}, { indent: 0 });
  await writeJson(FILE.calls(), {}, { indent: 0 });
  const d = await readJson<RecFile>(FILE.records(), {});
  for (const [k, r] of Object.entries(d)) {
    // 이미 올린 영상(videoId)은 지난 일이라 그대로 두고, 없음·사람이넣음은 계정과 무관하다
    if ((r.status === "붙임" || r.status === "건너뜀") && !r.videoId) delete d[k];
  }
  await writeJson(FILE.records(), d, { indent: 0 });
  recMemo = null;
}

const tidyKey = (v: unknown) => String(v ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
// 요청 머리글에 실리는 값이라 눈에 보이는 영문·숫자·기호뿐이어야 한다(공백·한글이 끼면 요청 자체가 만들어지지 않는다)
const KEY_OK = /^[\x21-\x7e]+$/;

/** 열쇠 두 칸을 다듬고(앞뒤 공백·따옴표 걷기) 모양을 본다. 통과하면 다듬은 열쇠, 아니면 사용자에게 보일 까닭. */
function tidyPair(accessKey: unknown, secretKey: unknown): { creds: Creds } | { message: string } {
  const access = tidyKey(accessKey), secret = tidyKey(secretKey);
  if (!access || !secret) return { message: "Access Key 와 Secret Key 를 둘 다 넣어 주세요" };
  if (!KEY_OK.test(access) || !KEY_OK.test(secret)) {
    return { message: "열쇠에 공백이나 한글 같은 알 수 없는 글자가 들어 있습니다 — 쿠팡 파트너스에서 복사한 그대로 붙여 넣어 주세요" };
  }
  return { creds: { access, secret } };
}

/**
 * 열쇠가 맞는지 검색 1회로 본다 — **아무것도 저장하지 않는다**(남는 것은 호출 횟수와 기록 한 줄뿐).
 * connect 와 probeKeys 가 이 한 길을 같이 쓴다(시험 코드가 두 벌이 되지 않게). 시간당 호출 한도도 똑같이 센다.
 * 통과하면 다듬은 열쇠를 돌려주지만 그것은 connect 가 저장하는 데에만 쓰고 밖으로 내보내지 않는다.
 */
async function verifyKeys(accessKey: unknown, secretKey: unknown, now: Date): Promise<
  { ok: true; creds: Creds; sample: { name: string; price: number } | null } | { ok: false; message: string }
> {
  const k = tidyPair(accessKey, secretKey);
  if ("message" in k) return { ok: false, message: k.message };
  const r = await probe({ now, perHour: loadSettings().perHour, creds: k.creds });
  if (!r.ok) {
    await recordLine(LOG, `열쇠 시험 실패 — ${cut(r.message, 120)}`);
    return { ok: false, message: r.message };
  }
  await recordLine(LOG, "열쇠 시험 성공");
  return { ok: true, creds: k.creds, sample: r.sample };
}

/**
 * 열쇠만 시험해 보여 준다 — 저장하지 않는다(쿠팡파트너스.json·앱설정.json·last_test·켜짐·입력 창 기록 전부 그대로).
 * 예: 이 컴퓨터에서 찾은 열쇠를 저장하기 전에 먼저 맞는지 보여 줄 때. 검색 1회를 쓰고 시간당 한도(기본 10회)에 센다 —
 * 한도에 닿았으면 부르지 않고 ok false. 열쇠 값은 반환값·기록·오류 글 어디에도 나오지 않는다.
 */
export async function probeKeys(accessKey: string, secretKey: string): Promise<{ ok: boolean; message: string; sample: { name: string; price: number } | null }> {
  const v = await verifyKeys(accessKey, secretKey, new Date());
  if (!v.ok) return { ok: false, message: v.message, sample: null };
  return { ok: true, message: `열쇠가 맞습니다 — 시험 검색에 성공했습니다${v.sample ? ` (예: ${v.sample.name})` : ""}`, sample: v.sample };
}

/**
 * 열쇠를 넣는다: **검색 1회로 확인해 통과하면 저장**하고 자동 링크를 켠다(입력 창도 본 것으로 기록).
 * 틀리면 아무것도 저장하지 않는다. 다른 계정으로 바꾸는 것이면 옛 계정에 묶인 캐시·기록을 비운다.
 */
export async function connect(accessKey: string, secretKey: string): Promise<{ ok: boolean; message: string; sample: { name: string; price: number } | null }> {
  const now = new Date();
  const v = await verifyKeys(accessKey, secretKey, now);
  if (!v.ok) return { ok: false, message: v.message, sample: null };
  const { creds, sample } = v;
  const message = `연결됐습니다 — 시험 검색에 성공했습니다${sample ? ` (예: ${sample.name})` : ""}. 이제 올리는 영상마다 관련 상품 링크를 자동으로 붙입니다.`;
  try {
    await locked(async () => {
      const d = await readJson<KeyFile>(FILE.keys(), {});
      const changed = String(d.access_key ?? "").trim() !== creds.access;
      d.access_key = creds.access;
      d.secret_key = creds.secret;
      d.enabled = true;
      // 처음 저장할 때 나머지 설정 칸도 같이 적는다 — 손으로 열어 봐도 무엇을 바꿀 수 있는지 보인다 (이미 있는 값은 그대로)
      d.mode ??= "auto";
      d.max_links ??= 3;
      d.per_hour ??= 10;
      d.disclosure ??= DEFAULT_DISCLOSURE;
      d.default_sub_id ??= "";
      d.last_test = { ok: true, at: stampOf(now), message };
      delete d.last_error;
      await writeJson(FILE.keys(), d, { secret: true });
      if (changed) await purgeAccountBound();
    });
    await saveAppSettings({ coupangPrompted: true });
  } catch (e) {
    const m = `열쇠는 맞지만 이 컴퓨터에 저장하지 못했습니다 — ${cut(scrub(msgOf(e), creds), 100)}`;
    await recordLine(LOG, m);
    return { ok: false, message: m, sample: null };
  }
  await recordLine(LOG, "연결 성공 — 쿠팡 파트너스 열쇠를 저장했습니다");
  return { ok: true, message, sample };
}

/** 저장된 열쇠로 연결 시험. 결과는 last_test 에 남는다. */
export async function testConnection(): Promise<{ ok: boolean; message: string; sample: { name: string; price: number } | null; usage: { used: number; limit: number; resetMin: number } }> {
  const creds = readCreds();
  if (!creds) return { ok: false, message: "쿠팡 파트너스 열쇠가 없습니다 — 먼저 연결해 주세요", sample: null, usage: usage() };
  const now = new Date();
  const r = await probe({ now, perHour: loadSettings().perHour, creds });
  const message = r.ok ? `연결이 정상입니다${r.sample ? ` (예: ${r.sample.name})` : ""}` : r.message;
  try {
    await locked(async () => {
      const d = await readJson<KeyFile>(FILE.keys(), {});
      d.last_test = { ok: r.ok, at: stampOf(now), message };
      if (r.ok) delete d.last_error;
      await writeJson(FILE.keys(), d, { secret: true });
    });
  } catch (e) {
    await recordLine(LOG, `시험 결과를 못 적었습니다 — ${cut(scrub(msgOf(e), creds), 100)}`);
  }
  return { ok: r.ok, message, sample: r.ok ? r.sample : null, usage: usage(now) };
}

/** 열쇠를 지우고 끈다. 옛 계정에 묶인 캐시·기록도 함께 비운다. 마지막 설정(모드·고지문 등)은 남긴다. */
export async function disconnect(): Promise<void> {
  await locked(async () => {
    const d = await readJson<KeyFile>(FILE.keys(), {});
    delete d.access_key;
    delete d.secret_key;
    delete d.last_test;
    delete d.last_error;
    d.enabled = false;
    await writeJson(FILE.keys(), d, { secret: true });
    await purgeAccountBound();
  });
  await recordLine(LOG, "연결 해제 — 열쇠를 지우고 자동 링크를 껐습니다");
}

/* ============================================================ 문제 목록 */

/** 문제 목록(노랑)에 올릴 것: ① 켜졌는데 열쇠가 없음 ② 최근 24시간에 건너뛴 영상이 있음(한도·실패·열쇠 오류) */
export function warnings(now: Date = new Date()): { level: "yellow"; kind: "coupang"; channel: string; what: string; why: string; fix: null; auto: false }[] {
  const out: { level: "yellow"; kind: "coupang"; channel: string; what: string; why: string; fix: null; auto: false }[] = [];
  const s = loadSettings();
  if (s.enabled && !s.connected) {
    out.push({
      level: "yellow", kind: "coupang", channel: "", what: "쿠팡 파트너스 자동 링크가 켜져 있는데 열쇠가 없습니다",
      why: "설정의 「쿠팡 파트너스 연결」에서 Access Key·Secret Key 를 다시 넣어 주세요.", fix: null, auto: false,
    });
  }
  if (s.enabled) {
    const recent = Object.values(recsSync())
      .filter((r) => r.status === "건너뜀" && Math.abs(now.getTime() - (r.ms ?? 0)) < 24 * HOUR_MS)
      .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
    const byChannel = new Map<string, Rec[]>();
    for (const r of recent) byChannel.set(r.channel, [...(byChannel.get(r.channel) ?? []), r]);
    for (const [channel, list] of byChannel) {
      out.push({
        level: "yellow", kind: "coupang", channel, what: `쿠팡 링크를 못 붙이고 건너뛴 영상이 ${list.length}건 있습니다 (최근 24시간)`,
        why: list[0].why || "까닭을 기록하지 못했습니다", fix: null, auto: false,
      });
    }
  }
  return out;
}

// 구글으로 나가는 모든 요청이 지나는 **단 하나의 문**.
//
// 왜 한 곳인가
//   ① 계량: 유튜브에 나가는 호출은 전부 여기서 센다(quota.ts). 부르는 자리마다 손으로 적던
//      시절에 9,300 유닛이 셈 밖으로 샜다(파이썬 참고/할당량.md).
//   ② 시험: 시험은 여기에 **가짜 응답**을 끼워 넣는다(setFetch). 실제 업로드·공개·인증 요청이
//      한 건도 안 나가게 하려면 문이 하나여야 한다.
//   ③ 안전: GARASADAE_OFFLINE=1 이면 가짜가 없을 때 네트워크를 아예 막는다.
import { log } from "./paths.ts";
import * as quota from "./quota.ts";

export const WWW = "https://www.googleapis.com";
export const YT = "https://youtube.googleapis.com";
export const ANALYTICS = "https://youtubeanalytics.googleapis.com";
export const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
export const OAUTH_DEVICE = "https://oauth2.googleapis.com/device/code";
export const OAUTH_REVOKE = "https://oauth2.googleapis.com/revoke";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let 쓸fetch: FetchFn | null = null;
/** 시험: 가짜 fetch 를 끼운다. null 이면 진짜(또는 오프라인 차단)로 돌아간다. */
export function setFetch(f: FetchFn | null) { 쓸fetch = f; }

export function offline(): boolean {
  try { return Deno.env.get("GARASADAE_OFFLINE") === "1"; } catch { return false; }
}

export function doFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (쓸fetch) return 쓸fetch(input, init);
  if (offline()) {
    return Promise.reject(new Error("오프라인 시험 모드 — 실제 네트워크 요청을 막았습니다"));
  }
  return fetch(input, init);
}

/** 구글이 돌려준 오류를 사람 말로 다루기 좋게 담는다. */
export class GoogleError extends Error {
  constructor(
    message: string,
    public status = 0,
    public reason = "",
    public apiStatus = "",
    public body = "",
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

/** 응답 몸을 읽어 GoogleError 로 만든다. */
export async function toGoogleError(res: Response): Promise<GoogleError> {
  let txt = "";
  try { txt = await res.text(); } catch { /* 무시 */ }
  let reason = "", detail = "", apiStatus = "";
  try {
    const j = JSON.parse(txt);
    reason = j.error?.errors?.[0]?.reason ?? "";
    detail = j.error?.message ?? "";
    apiStatus = j.error?.status ?? "";
    // OAuth 오류(invalid_grant 등)는 다른 꼴이다
    if (!detail && typeof j.error === "string") {
      reason = j.error;
      detail = j.error_description ?? j.error;
    }
  } catch { detail = txt.slice(0, 200); }
  return new GoogleError(`${res.status} ${detail}`.trim(), res.status, reason, apiStatus, txt);
}

export interface Bearer {
  /** 이 요청에 쓸 접근 토큰 */
  token: string;
  /** 어느 구글 프로젝트(클라이언트)의 몫으로 셀까 */
  project: string;
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export function buildUrl(base: string, path: string, query: Query = {}): string {
  const u = new URL(path.startsWith("http") ? path : base + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      // id=a&id=b 꼴이 아니라 한 줄로 쉼표를 쓰는 곳이 대부분이다 — 부르는 쪽이 정한다
      u.searchParams.set(k, v.join(","));
    } else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

export interface CallOpts {
  base?: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** 계량 이름을 직접 정할 때 (보통은 주소·방식으로 알아낸다) */
  name?: string;
  /** 계량을 건너뛴다(OAuth 호출 등 — 유튜브 유닛이 아니다) */
  noMeter?: boolean;
  signal?: AbortSignal;
}

/**
 * 구글 API 를 부르고 JSON 을 돌려준다. 오류는 GoogleError.
 * 호출이 나가기 **전에** 센다 — 403 으로 튕겨도 숫자는 잡힌다(파이썬 quota 와 같은 자리).
 */
export async function call(
  auth: Bearer | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: CallOpts = {},
): Promise<any> {
  const url = buildUrl(opts.base ?? WWW, path, opts.query);
  if (!opts.noMeter) {
    const name = opts.name ?? quota.nameOf(url, method);
    if (name) await quota.watch(name, auth?.project ?? "");
  }
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (auth?.token) headers["Authorization"] = "Bearer " + auth.token;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === "string" || opts.body instanceof Uint8Array || opts.body instanceof Blob) {
      body = opts.body as BodyInit;
    } else {
      headers["Content-Type"] ??= "application/json; charset=UTF-8";
      body = JSON.stringify(opts.body);
    }
  }
  const res = await doFetch(url, { method, headers, body, signal: opts.signal });
  if (!res.ok) throw await toGoogleError(res);
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** 오류 문구를 사람이 읽는 말로 (브리핑·화면이 쓴다) */
export function explainGoogle(e: unknown): string {
  if (e instanceof GoogleError) {
    if (e.reason === "uploadLimitExceeded") return "이 채널의 하루 업로드 한도에 걸렸습니다.";
    if (e.reason === "quotaExceeded" || /quota/i.test(e.message)) {
      return "오늘 쓸 수 있는 유튜브 할당량을 다 썼습니다.";
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/* ─────────── 한도(할당량) 오류를 가려낸다 ───────────
 * 구글이 한도 때문에 거절하는 모양은 둘로 갈린다. 뜻이 달라서 사용자에게 다르게 말해야 한다.
 *   · quotaExceeded       — 이 구글 프로젝트(열쇠)의 하루 할당량을 다 썼다. 같은 열쇠를 쓰는 모든 채널이 같이 막힌다.
 *   · uploadLimitExceeded — 이 채널의 하루 업로드 한도에 걸렸다(유튜브가 채널마다 정한 한도). 다른 채널은 올릴 수 있다.
 * 「429」라는 글자가 오류 글 어딘가에 들어 있다고 한도로 보지 않는다 — 파일 이름·번호에 429 가 든 다른 오류까지 한도로 오인해 남은 영상을 다음 날로 미룰 수 있었다.
 * 한도로 보는 것은 ① HTTP 상태가 429 ② 구글이 준 이유(reason)가 한도 이유 ③ 구글이 보낸 한도 문장뿐이다. */

export type LimitKind = "프로젝트" | "채널" | "요청";
export interface LimitInfo {
  kind: LimitKind;
  /** 구글이 준 이유 (예: quotaExceeded · uploadLimitExceeded) — 없으면 "" */
  reason: string;
  /** 구글이 보낸 오류 글의 첫 줄 (태그를 떼고 짧게) */
  first: string;
  /** 사용자에게 보이는 한 줄 이름 */
  name: string;
  /** 무슨 뜻이고 누가 막히는지 */
  words: string;
}

const 프로젝트이유 = new Set(["quotaExceeded", "dailyLimitExceeded"]);
const 채널이유 = new Set(["uploadLimitExceeded"]);

/** 오류 글의 첫 줄 — 구글이 넣은 HTML 태그는 떼고 길이를 줄인다 */
export function firstLine(m: unknown, max = 140): string {
  return String(m ?? "").split("\n")[0].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 한도 오류면 어떤 한도인지, 아니면 null */
export function limitInfo(e: unknown): LimitInfo | null {
  const msg = String((e as Error)?.message ?? e ?? "");
  const body = String((e as { body?: string })?.body ?? "");
  const status = Number((e as { status?: number })?.status ?? 0);
  const reason = e instanceof GoogleError ? e.reason : String((e as { reason?: string })?.reason ?? "");
  const text = msg + " " + body;
  let kind: LimitKind | null = null;
  let why = reason;
  if (채널이유.has(reason)) kind = "채널";
  else if (프로젝트이유.has(reason)) kind = "프로젝트";
  else if (/uploadLimitExceeded|exceeded the number of videos/i.test(text)) { kind = "채널"; why = why || "uploadLimitExceeded"; }
  else if (/quotaExceeded|Quota exceeded/i.test(text)) { kind = "프로젝트"; why = why || "quotaExceeded"; }
  else if (status === 429 || /^(HTTP\s*)?429(\s|$)/.test(msg)) kind = "요청";
  if (!kind) return null;
  const first = firstLine(msg);
  if (kind === "프로젝트") {
    return { kind, reason: why, first, name: `프로젝트 할당량 소진(${why || "quotaExceeded"})`,
      words: "이 구글 열쇠(프로젝트)의 하루 할당량을 다 썼습니다. 같은 열쇠를 쓰는 모든 채널이 오늘은 같이 막힙니다." };
  }
  if (kind === "채널") {
    return { kind, reason: why, first, name: `채널 하루 업로드 한도(${why || "uploadLimitExceeded"})`,
      words: "이 채널이 오늘 올릴 수 있는 편수를 유튜브가 정한 한도까지 채웠습니다. 열쇠(프로젝트) 할당량과는 따로 세는 한도입니다." };
  }
  return { kind, reason: why, first, name: "구글이 요청을 거절함(HTTP 429)",
    words: "구글이 요청이 너무 많다며 잠시 막았습니다. 어떤 한도인지 이유(reason)는 오지 않았습니다." };
}

export async function noteOffline() {
  if (offline()) await log("(오프라인 시험 모드 — 구글에 아무것도 보내지 않습니다)");
}

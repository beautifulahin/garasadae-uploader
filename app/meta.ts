// 인스타그램·스레드 연결 — 로그인(중계 서버 경유) · 토큰 보관 · 만료 전 갱신 · 연결 끊기 · 채널 짝짓기.
//
// 어떻게 로그인하나 (사용자는 로그인만 한다)
//   앱 → 브라우저로 중계 서버 /ig/start 를 연다 → 메타 로그인 창 → 중계 /ig/callback 이 코드를 토큰으로 바꿔 5분만 보관
//   → 브라우저가 http://127.0.0.1:<포트>/meta/done 으로 돌아온다(★주소에 토큰은 없다) → 앱이 verifier 를 보여 주고 토큰을 한 번 받아 간다.
//   메타 앱 비밀은 중계 서버에만 있고 이 앱에는 없다. 토큰을 쓰는 호출(올리기·갱신)은 모두 앱이 메타로 직접 한다.
//
// 지키는 약속 (유튜브 토큰과 같은 방식)
//   · 토큰은 `메타토큰.json` 에만 있다 — 맥·리눅스 권한 600, 잠그고 고친다. 어떤 화면 응답·기록에도 값을 싣지 않는다.
//   · 모든 메타 호출은 google.ts 의 doFetch 한 문을 지난다 (시험은 setFetch, 오프라인 시험은 막힌다).
//   · 만료 전에 알아서 갱신한다(60일 토큰 · 만료 10일 전부터, 발급 24시간 뒤부터 가능). 갱신이 안 되면 사람 말로 까닭을 남긴다.
//   · 연결 정보(중계 주소·앱 번호)가 실행 파일에 없으면 이 기능은 화면에 나타나지 않는다(embedded.ts).
import { doFetch } from "./google.ts";
import { dataPath, readJson, readJsonSync, recordLine, withFileLock, writeJson } from "./paths.ts";
import { embeddedMeta } from "./embedded.ts";
import { editChannels, loadChannels } from "./channels.ts";

export type Provider = "instagram" | "threads";
export const PROVIDERS: Provider[] = ["instagram", "threads"];
export const 이름: Record<Provider, string> = { instagram: "인스타그램", threads: "스레드" };

/** 메타 호출 주소 (2026-10 공식 문서) — 인스타그램 로그인은 graph.instagram.com, 스레드는 graph.threads.com */
export const PROV: Record<Provider, { prefix: "ig" | "th"; graph: string; ver: string; refreshGrant: string; scopes: string[] }> = {
  instagram: { prefix: "ig", graph: "https://graph.instagram.com", ver: "v26.0", refreshGrant: "ig_refresh_token", scopes: ["instagram_business_basic", "instagram_business_content_publish"] },
  threads: { prefix: "th", graph: "https://graph.threads.com", ver: "v1.0", refreshGrant: "th_refresh_token", scopes: ["threads_basic", "threads_content_publish"] },
};

const 일 = 24 * 3600_000;
/** 만료 이 기간 안으로 들어오면 갱신한다 */
export const REFRESH_BEFORE_MS = 10 * 일;
/** 갱신은 발급(갱신) 24시간 뒤부터 된다 — 메타 규칙 */
export const REFRESH_MIN_AGE_MS = 1 * 일;
/** 갱신이 실패한 뒤 같은 계정을 다시 두드리기까지의 간격 */
const RETRY_GAP_MS = 6 * 3600_000;

export interface MetaToken {
  provider: Provider;
  user_id: string;
  username: string;
  account_type?: string;
  access_token: string;
  /** 만료 시각 (ISO 순간) */
  expires_at: string;
  refreshed_at: string;
  added: string;
  scopes?: string[];
  /** 갱신을 마지막으로 시도한 때 */
  tried_at?: string;
  /** 사람이 다시 로그인해야 하는 까닭 (있으면 화면에 보인다) */
  error?: { at: string; why: string };
  [k: string]: unknown;
}
export type MetaStore = Record<string, MetaToken>;

export const storePath = () => dataPath("메타토큰.json");
export const accountKey = (p: Provider, uid: string) => `${PROV[p].prefix}:${uid}`;
export const providerOfKey = (k: string): Provider | null => (k.startsWith("ig:") ? "instagram" : k.startsWith("th:") ? "threads" : null);

export function loadStore(): MetaStore {
  return readJsonSync<MetaStore>(storePath(), {});
}
/** 토큰 저장소를 잠그고 고친다 (화면 서버·예약 작업이 겹쳐 쓰지 않게) */
export async function updateStore<T>(고치기: (s: MetaStore) => T | Promise<T>): Promise<T> {
  const r = await withFileLock(dataPath("메타토큰.lock"), async () => {
    const s = await readJson<MetaStore>(storePath(), {});
    const out = await 고치기(s);
    await writeJson(storePath(), s, { secret: true });
    return out;
  });
  return r as T;
}

/* ============================================================ 메타가 돌려주는 오류 */

export class MetaAuthError extends Error {
  constructor(m: string) { super(m); this.name = "MetaAuthError"; }
}

/** 종류: auth = 다시 로그인 필요 · limit = 하루/시간 한도 · perm = 권한·심사 · temp = 메타 쪽 일시 오류 · other */
export type MetaErrKind = "auth" | "limit" | "perm" | "temp" | "other";

export class MetaApiError extends Error {
  constructor(message: string, public status = 0, public code = 0, public subcode = 0, public kind: MetaErrKind = "other", public body = "") {
    super(message);
    this.name = "MetaApiError";
  }
}

/** 응답 몸을 읽어 MetaApiError 로 만든다 */
export async function toMetaError(res: Response): Promise<MetaApiError> {
  let txt = "";
  try { txt = await res.text(); } catch { /* 무시 */ }
  let code = 0, sub = 0, detail = txt.slice(0, 160);
  try {
    const j = JSON.parse(txt);
    code = Number(j.error?.code ?? 0) || 0;
    sub = Number(j.error?.error_subcode ?? 0) || 0;
    detail = String(j.error?.error_user_msg || j.error?.message || detail);
  } catch { /* 글 그대로 */ }
  return new MetaApiError(`${res.status} ${detail}`.trim(), res.status, code, sub, kindOf(res.status, code, sub, detail), txt);
}

function kindOf(status: number, code: number, sub: number, msg: string): MetaErrKind {
  if (code === 190 || [458, 459, 460, 463, 467].includes(sub) || /access token|session has expired|Error validating/i.test(msg)) return "auth";
  if ([4, 17, 32, 613].includes(code) || sub === 2207042 || /rate limit|too many|reached the limit|limit reached/i.test(msg)) return "limit";
  if ([3, 10, 200, 283].includes(code) || (code >= 200 && code < 300) || /permission|not authorized|app role|testers?/i.test(msg)) return "perm";
  if (status >= 500 || [1, 2].includes(code)) return "temp";
  return "other";
}

/** 화면에 보일 한 줄 — 원문은 짧게 덧붙인다 */
export function explainMeta(e: unknown): string {
  if (e instanceof MetaAuthError) return e.message;
  if (!(e instanceof MetaApiError)) return (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);
  const 원문 = e.message.replace(/^\d+\s+/, "").slice(0, 120);
  switch (e.kind) {
    case "auth": return `로그인이 풀렸거나 만료됐습니다 — 설정에서 다시 연결해 주세요 (${원문})`;
    case "limit": return `메타의 올리기 한도에 걸렸습니다 — 시간을 두고 다시 시도합니다 (${원문})`;
    case "perm": return `권한이 없습니다 — 메타 앱 심사가 끝나기 전에는 앱 역할(테스터)로 초대된 계정만 올릴 수 있습니다 (${원문})`;
    case "temp": return `메타 쪽 일시 오류입니다 (${원문})`;
    default: return 원문 || `메타 오류 ${e.status}`;
  }
}

/* ============================================================ 쓸 수 있는가 · 계정 목록 */

export interface MetaAvail { on: boolean; instagram: boolean; threads: boolean }

/** 이 판에 인스타·스레드 연결 정보가 들어 있나 — 없으면 화면에 나타나지 않는다 */
export async function available(): Promise<MetaAvail> {
  const c = await embeddedMeta();
  const ig = !!(c && c.worker_url && c.ig_app_id), th = !!(c && c.worker_url && c.th_app_id);
  return { on: ig || th, instagram: ig, threads: th };
}

export interface AccountView {
  key: string; provider: Provider; username: string; user_id: string;
  expires_at: string; days_left: number; error?: string; account_type?: string;
}

/** 화면에 보일 연결 계정들 — ★토큰 값은 없다 */
export function accountsView(now = new Date()): AccountView[] {
  return Object.entries(loadStore()).map(([key, t]) => ({
    key, provider: t.provider, username: t.username || t.user_id, user_id: t.user_id,
    expires_at: t.expires_at, days_left: Math.floor((Date.parse(t.expires_at) - now.getTime()) / 일),
    ...(t.error ? { error: t.error.why } : {}), ...(t.account_type ? { account_type: t.account_type } : {}),
  })).sort((a, b) => (a.provider === b.provider ? a.username.localeCompare(b.username) : a.provider < b.provider ? -1 : 1));
}

/* ============================================================ 브라우저 로그인 (중계 서버 경유) */

export interface MetaSignInState {
  running: boolean;
  provider: Provider | null;
  url?: string;
  done?: { key: string; username: string; provider: Provider };
  why?: string;
}
/** 진행 중인 로그인 하나 (화면이 meta/signin/check 로 묻는다) */
export const signin: { state: MetaSignInState; stop?: () => void } = { state: { running: false, provider: null } };

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const 결과쪽 = (제목: string, 본문: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${제목}</title>` +
      `<body style="background:#0b0b11;color:#ededf4;font-family:-apple-system,'Malgun Gothic',sans-serif;text-align:center;padding:90px 20px">${본문}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** 메타가 돌려준 오류 이름 → 사람 말 */
function explainLogin(code: string, why = ""): string {
  if (code === "access_denied") return "연결을 허락하지 않으셨습니다";
  if (code === "exchange_failed") return `메타와 토큰을 바꾸지 못했습니다${why ? " — " + why : ""}`;
  return `${code || "알 수 없는 오류"}${why ? " — " + why : ""}`;
}

/**
 * 로그인을 시작한다. 중계 서버의 시작 주소를 돌려주고, 끝나면 signin.state 가 바뀐다.
 * 부르는 쪽(화면 서버)이 주소를 브라우저로 연다.
 */
export async function startSignIn(provider: Provider, o: { now?: () => Date; timeoutMs?: number } = {}): Promise<{ url: string; done: Promise<{ key: string; username: string }> }> {
  if (signin.state.running) throw new Error("이미 로그인 창이 열려 있습니다");
  const av = await available();
  const conf = await embeddedMeta();
  if (!conf || !av[provider]) throw new Error(`이 판에는 ${이름[provider]} 연결 정보가 들어 있지 않습니다`);
  const worker = conf.worker_url;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));

  let port = 0;
  let resolveCb!: (v: { ok?: boolean; error?: string; why?: string }) => void;
  const cb = new Promise<{ ok?: boolean; error?: string; why?: string }>((r) => { resolveCb = r; });
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: (a) => { port = a.port; } }, (req) => {
    const u = new URL(req.url);
    if (u.pathname !== "/meta/done") return new Response("not found", { status: 404 });
    if (u.searchParams.get("n") !== nonce) {
      return 결과쪽("연결 실패", `<h2 style="color:#ff4466">❌ 확인값이 맞지 않습니다</h2><p style="color:#8e8ea8">앱에서 다시 시도해 주세요.</p>`);
    }
    const ok = u.searchParams.get("ok") === "1";
    const error = u.searchParams.get("error") ?? "";
    resolveCb(ok ? { ok: true } : { error: error || "unknown", why: u.searchParams.get("why") ?? "" });
    return ok
      ? 결과쪽("연결 완료", `<h2 style="color:#2dd4a8">✅ 연결됐습니다</h2><p style="color:#5a5a72;font-size:13px">이 창을 닫고 앱으로 돌아가세요.</p><script>setTimeout(()=>window.close(),2500)</script>`)
      : 결과쪽("연결 실패", `<h2 style="color:#ff4466">❌ 연결하지 못했습니다</h2><p style="color:#8e8ea8">${esc(explainLogin(error, u.searchParams.get("why") ?? ""))}</p>`);
  });
  for (let i = 0; i < 50 && !port; i++) await new Promise((r) => setTimeout(r, 10));
  const q = new URLSearchParams({ port: String(port), challenge, nonce });
  const url = `${worker}/${PROV[provider].prefix}/start?${q}`;
  signin.state = { running: true, provider, url };
  const 끝 = () => { try { srv.shutdown(); } catch { /* 이미 꺼짐 */ } };
  signin.stop = () => { resolveCb({ error: "취소했습니다" }); 끝(); };

  const done = (async () => {
    try {
      const timer = setTimeout(() => resolveCb({ error: "10분이 지나 로그인을 접었습니다" }), o.timeoutMs ?? 10 * 60_000);
      const got = await cb;
      clearTimeout(timer);
      if (!got.ok) throw new Error(got.error && /[가-힣]/.test(got.error) ? got.error : explainLogin(got.error ?? "", got.why));
      // 토큰은 주소로 오지 않았다 — 이제 verifier 를 보여 주고 한 번만 받아 간다
      const r = await doFetch(`${worker}/pickup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verifier }) });
      const j = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (!r.ok || !j.ok) throw new Error(`토큰을 받아 오지 못했습니다${j.why ? " — " + String(j.why) : ""}`);
      if (j.provider !== provider || typeof j.access_token !== "string" || !j.access_token || !j.user_id) throw new Error("중계 서버의 답이 올바르지 않습니다");
      const now = (o.now ?? (() => new Date()))();
      const key = accountKey(provider, String(j.user_id));
      const tok: MetaToken = {
        provider, user_id: String(j.user_id), username: String(j.username ?? ""), account_type: j.account_type ? String(j.account_type) : undefined,
        access_token: j.access_token, expires_at: new Date(now.getTime() + (Number(j.expires_in) || 60 * 일 / 1000) * 1000).toISOString(),
        refreshed_at: now.toISOString(), added: now.toISOString(), scopes: PROV[provider].scopes,
      };
      await updateStore((s) => { s[key] = tok; });
      await recordLine("올리기.log", `${이름[provider]} 연결  @${tok.username || tok.user_id}`);
      signin.state = { running: false, provider, done: { key, username: tok.username || tok.user_id, provider } };
      return { key, username: tok.username || tok.user_id };
    } catch (e) {
      signin.state = { running: false, provider, why: String(e instanceof Error ? e.message : e).slice(0, 200) };
      throw e;
    } finally {
      끝();
    }
  })();
  done.catch(() => {});
  return { url, done };
}

/* ============================================================ 토큰 쓰기 · 만료 전 갱신 */

async function parseRefresh(res: Response): Promise<{ token: string; expires_in: number }> {
  if (!res.ok) throw await toMetaError(res);
  const j = await res.json().catch(() => ({})) as Record<string, unknown>;
  const token = String(j.access_token ?? "");
  if (!token) throw new MetaApiError("갱신 답에 토큰이 없습니다");
  return { token, expires_in: Number(j.expires_in) || 60 * 일 / 1000 };
}

/** 갱신이 필요한 때인가 (네트워크 없이 따진다) */
export function needsRefresh(t: MetaToken, now: Date): boolean {
  const left = Date.parse(t.expires_at) - now.getTime();
  const age = now.getTime() - Date.parse(t.refreshed_at);
  const tried = t.tried_at ? now.getTime() - Date.parse(t.tried_at) : Infinity;
  return left <= REFRESH_BEFORE_MS && left > 0 && age >= REFRESH_MIN_AGE_MS && tried >= RETRY_GAP_MS;
}

/**
 * 이 계정의 토큰 값을 돌려준다. 만료가 가까우면 먼저 갱신한다. 이미 만료됐으면 MetaAuthError.
 * 갱신이 실패해도 아직 만료 전이면 지금 토큰을 그대로 돌려준다(올리기를 막지 않는다) — 까닭은 기록에 남는다.
 */
export async function freshToken(key: string, o: { now?: Date } = {}): Promise<string> {
  const now = o.now ?? new Date();
  const cur = loadStore()[key];
  if (!cur) throw new MetaAuthError("연결이 끊긴 계정입니다 — 설정에서 다시 연결해 주세요");
  if (Date.parse(cur.expires_at) <= now.getTime()) {
    await 오류적기(key, `로그인이 만료됐습니다(${cur.expires_at.slice(0, 10)}) — 설정에서 다시 연결해 주세요`, now);
    throw new MetaAuthError(`${이름[cur.provider]} 로그인이 만료됐습니다 — 설정에서 다시 연결해 주세요`);
  }
  if (!needsRefresh(cur, now)) return cur.access_token;
  const P = PROV[cur.provider];
  try {
    const r = await doFetch(`${P.graph}/refresh_access_token?${new URLSearchParams({ grant_type: P.refreshGrant, access_token: cur.access_token })}`);
    const got = await parseRefresh(r);
    await updateStore((s) => {
      const t = s[key];
      if (!t) return;
      t.access_token = got.token;
      t.expires_at = new Date(now.getTime() + got.expires_in * 1000).toISOString();
      t.refreshed_at = now.toISOString();
      t.tried_at = now.toISOString();
      delete t.error;
    });
    await recordLine("올리기.log", `${이름[cur.provider]} 토큰 갱신  @${cur.username || cur.user_id}  → ${new Date(now.getTime() + got.expires_in * 1000).toISOString().slice(0, 10)}`);
    return got.token;
  } catch (e) {
    await updateStore((s) => { if (s[key]) s[key].tried_at = now.toISOString(); });
    if (e instanceof MetaApiError && e.kind === "auth") await 오류적기(key, explainMeta(e), now);
    await recordLine("올리기.log", `${이름[cur.provider]} 토큰 갱신 실패  @${cur.username || cur.user_id}  ${explainMeta(e).slice(0, 100)}`);
    return cur.access_token;
  }
}

async function 오류적기(key: string, why: string, now: Date) {
  await updateStore((s) => {
    const t = s[key];
    if (!t || t.error?.why === why) return;
    t.error = { at: now.toISOString(), why };
  });
}

/** 예약 작업이 부른다 — 갱신할 때가 된 계정만 메타를 부른다(없으면 호출 0건) */
export async function refreshDue(o: { now?: Date } = {}): Promise<{ checked: number; due: number }> {
  const now = o.now ?? new Date();
  const s = loadStore();
  let due = 0;
  for (const [key, t] of Object.entries(s)) {
    if (!needsRefresh(t, now) && Date.parse(t.expires_at) > now.getTime()) continue;
    due++;
    try { await freshToken(key, { now }); } catch { /* 까닭은 기록에 남았다 */ }
  }
  return { checked: Object.keys(s).length, due };
}

/* ============================================================ 연결 끊기 · 채널 짝짓기 */

/** 이 컴퓨터에서 연결을 끊는다 — 토큰을 지우고 채널에 걸린 짝도 푼다. 메타 쪽 권한은 사용자가 메타 설정에서 지울 수 있다. */
export async function disconnect(key: string): Promise<boolean> {
  const had = await updateStore((s) => { const x = key in s; delete s[key]; return x; });
  if (!had) return false;
  await editChannels((d) => {
    for (const cf of Object.values(d)) {
      const m = (cf as Record<string, unknown> | null)?.meta as Record<string, unknown> | undefined;
      if (!m || typeof m !== "object") continue;
      for (const p of PROVIDERS) if (m[p] === key) delete m[p];
      if (!Object.keys(m).length) delete (cf as Record<string, unknown>).meta;
    }
  });
  await recordLine("올리기.log", `${이름[providerOfKey(key) ?? "instagram"]} 연결 끊음  ${key}`);
  return true;
}

export interface ChannelBind { instagram?: string; threads?: string }

/** 채널 칸에 걸린 인스타·스레드 계정 (없으면 빈 객체 = 꺼짐) */
export function bindingOf(conf: { meta?: unknown } | null | undefined): ChannelBind {
  const m = conf?.meta;
  if (!m || typeof m !== "object") return {};
  const out: ChannelBind = {};
  for (const p of PROVIDERS) { const v = (m as Record<string, unknown>)[p]; if (typeof v === "string" && v) out[p] = v; }
  return out;
}

/** 이 채널이 올릴 계정을 고른다. key 가 null/빈 값이면 끈다(기본). 연결된 계정만 고를 수 있다. */
export async function bindChannel(alias: string, provider: Provider, key: string | null): Promise<void> {
  if (!loadChannels()[alias]) throw new Error(`모르는 채널입니다 — ${alias}`);
  if (key) {
    const t = loadStore()[key];
    if (!t || t.provider !== provider) throw new Error(`연결된 ${이름[provider]} 계정이 아닙니다`);
  }
  await editChannels((d) => {
    const cf = d[alias] as Record<string, any>;
    const m: Record<string, unknown> = cf.meta && typeof cf.meta === "object" ? cf.meta : {};
    if (key) m[provider] = key; else delete m[provider];
    if (Object.keys(m).length) cf.meta = m; else delete cf.meta;
  });
}

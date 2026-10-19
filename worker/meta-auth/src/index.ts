// 가라사대 업로더 — 인스타그램·스레드 로그인 중계 (Cloudflare Worker)
//
// 왜 있나
//   메타 앱의 「앱 비밀」은 실행 파일(누구나 받아 가는 앱) 안에 넣을 수 없다. 로그인 코드를 토큰으로 바꾸는 일 — 앱 비밀이 필요한
//   그 한 단계만 이 중계가 맡는다. 앱 쪽에는 앱 비밀이 없다. 토큰을 쓰는 모든 호출(올리기·갱신)은 앱이 메타로 직접 한다.
//
// 길 (모두 공개 주소 · 앱 비밀은 wrangler secret 으로만 들어온다 — 이 파일·저장소에는 값이 없다)
//   GET  /ig/start · /th/start          앱이 연 브라우저가 처음 닿는 곳. 서명한 state 를 만들어 메타 로그인 창으로 보낸다.
//   GET  /ig/callback · /th/callback    메타가 로그인 뒤 돌려보내는 곳. 코드 → 장기 토큰으로 바꿔 KV 에 5분만 둔다.
//                                       브라우저는 http://127.0.0.1:<포트>/meta/done 으로 돌아간다 — ★주소에 토큰을 싣지 않는다.
//   POST /pickup                        앱이 verifier 를 보여 주고 토큰을 한 번만 받아 간다 (받으면 바로 지운다 · PKCE 와 같은 꼴).
//   POST /stage/ticket · /stage/delete  영상 임시 보관(R2): 일회용 업로드 주소·읽기 주소를 주고, 올린 뒤 지운다. 1시간 지난 것은 크론이 지운다.
//   GET  /s/<id>.<mp4|mov>              메타 서버가 영상을 가져가는 서명된 읽기 주소 (1시간 · 이어받기 범위 지원)
//   POST /ig|th/deauthorize · /ig|th/delete   메타가 요구하는 연결 해제·데이터 삭제 알림 (signed_request 를 앱 비밀로 확인한다)
//   GET  /deletion?code=                삭제 요청 처리 상태 쪽
//
// 저장하는 것: KV 에 로그인 직후 5분간의 토큰(받아 가면 즉시 삭제) · 하루 사용량 숫자 · 삭제 요청 번호. R2 에 1시간 이하의 영상 임시본.
// 영상·토큰·계정 정보를 이 중계가 오래 갖고 있지 않는다.
//
// 이 파일은 Cloudflare 전용 형식을 쓰지 않는 평범한 TypeScript 다(바깥 의존 없음) — 시험이 가짜 KV·R2·메타 서버로 그대로 부른다.

/* ============================================================ 환경 꼴 */

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface R2Object { body: ReadableStream<Uint8Array> | null; size: number; uploaded: Date }
export interface R2Bucket {
  get(key: string, opts?: { range?: { offset: number; length?: number } }): Promise<R2Object | null>;
  head(key: string): Promise<{ size: number; uploaded: Date } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
}
export interface Env {
  META_KV: KV;
  STAGE: R2Bucket;
  /** 메타 앱 (인스타그램 로그인 · 스레드) — 앱 번호는 공개돼도 되지만 앱 비밀은 secret */
  IG_APP_ID: string; IG_APP_SECRET: string;
  TH_APP_ID: string; TH_APP_SECRET: string;
  /** state · 읽기 주소 · 삭제 서명에 쓰는 아무 긴 글 (secret) */
  SIGN_KEY: string;
  /** R2 일회용 업로드 주소(S3 서명)를 만들 때 쓰는 R2 API 토큰 */
  R2_ACCOUNT_ID: string; R2_BUCKET: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string;
  /** 이 중계의 바깥 주소 (비우면 들어온 요청의 주소를 쓴다) */
  PUBLIC_URL?: string;
}
export interface Deps { fetch: typeof fetch; now: () => number; random: (n: number) => Uint8Array }
const 실제: Deps = { fetch: (...a) => fetch(...a), now: () => Date.now(), random: (n) => crypto.getRandomValues(new Uint8Array(n)) };

/* ============================================================ 메타 쪽 약속 (2026-10 공식 문서 기준) */

type Kind = "ig" | "th";
interface Prov {
  이름: "instagram" | "threads";
  authorize: string; scope: string; token: string; longLived: string; grant: string; me: string;
  id: (e: Env) => string; secret: (e: Env) => string;
}
const PROV: Record<Kind, Prov> = {
  ig: {
    이름: "instagram",
    authorize: "https://www.instagram.com/oauth/authorize",
    scope: "instagram_business_basic,instagram_business_content_publish",
    token: "https://api.instagram.com/oauth/access_token",
    longLived: "https://graph.instagram.com/access_token", grant: "ig_exchange_token",
    me: "https://graph.instagram.com/v26.0/me?fields=user_id,username,account_type",
    id: (e) => e.IG_APP_ID, secret: (e) => e.IG_APP_SECRET,
  },
  th: {
    이름: "threads",
    authorize: "https://threads.com/oauth/authorize",
    scope: "threads_basic,threads_content_publish",
    token: "https://graph.threads.com/oauth/access_token",
    longLived: "https://graph.threads.com/access_token", grant: "th_exchange_token",
    me: "https://graph.threads.com/v1.0/me?fields=id,username",
    id: (e) => e.TH_APP_ID, secret: (e) => e.TH_APP_SECRET,
  },
};

/** 영상 한 편의 크기 한도 — 인스타 릴스 300MB (스레드는 더 크지만 같은 임시본을 쓴다) */
export const STAGE_MAX_BYTES = 300 * 1024 * 1024;
const 로그인유효 = 10 * 60_000;      // state 가 살아 있는 시간
const 토큰보관초 = 300;              // 로그인 직후 토큰을 KV 에 두는 시간 (받아 가면 바로 지운다)
const 업로드주소초 = 600;            // R2 업로드 주소가 살아 있는 시간
const 읽기주소ms = 60 * 60_000;      // 메타가 영상을 가져가는 주소가 살아 있는 시간 = 임시본 수명
const 하루한도 = 40;                 // 사용자 한 명이 하루에 임시본을 요청할 수 있는 횟수

/* ============================================================ 작은 도구 */

const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(key: string | Uint8Array, msg: string): Promise<Uint8Array> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
/** 시간이 일정한 비교 — 서명 맞추기 공격을 막는다 */
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const 쪽 = (status: number, 제목: string, 본문: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${제목}</title>` +
      `<body style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:520px;margin:70px auto;padding:0 20px;line-height:1.7"><h2>${제목}</h2><p>${본문}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
const 짧게 = (s: unknown, n = 120) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

function baseUrl(env: Env, url: URL): string {
  return (env.PUBLIC_URL || url.origin).replace(/\/+$/, "");
}

/* ============================================================ 서명한 state — 중계는 로그인 도중 아무것도 기억하지 않는다 */

interface StateBody { k: Kind; p: number; c: string; n: string; e: number }

async function signState(env: Env, body: StateBody): Promise<string> {
  const b = b64u(enc.encode(JSON.stringify(body)));
  return `${b}.${b64u(await hmac(env.SIGN_KEY, "state:" + b))}`;
}
async function readState(env: Env, s: string, now: number): Promise<StateBody | null> {
  const [b, sig] = s.split(".");
  if (!b || !sig) return null;
  if (!safeEq(b64u(await hmac(env.SIGN_KEY, "state:" + b)), sig)) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(unb64u(b))) as StateBody;
    if (!v || (v.k !== "ig" && v.k !== "th") || typeof v.p !== "number" || typeof v.c !== "string" || typeof v.n !== "string" || typeof v.e !== "number") return null;
    return v.e > now ? v : null;
  } catch { return null; }
}

/* ============================================================ 로그인: 시작 → 콜백 → 가져가기 */

async function start(env: Env, url: URL, kind: Kind, deps: Deps): Promise<Response> {
  const P = PROV[kind];
  if (!P.id(env) || !P.secret(env)) return 쪽(503, "아직 준비되지 않았습니다", "이 중계에 메타 앱 정보가 들어 있지 않습니다. 운영자에게 알려 주세요.");
  const port = Number(url.searchParams.get("port"));
  const challenge = url.searchParams.get("challenge") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  // 돌아갈 곳은 이 컴퓨터(127.0.0.1)의 높은 포트뿐이다 — 아무 주소로나 보내 주는 중계가 되지 않게
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 쪽(400, "잘못된 요청입니다", "앱에서 다시 시도해 주세요. (포트)");
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return 쪽(400, "잘못된 요청입니다", "앱에서 다시 시도해 주세요. (확인값)");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return 쪽(400, "잘못된 요청입니다", "앱에서 다시 시도해 주세요. (일련번호)");
  const state = await signState(env, { k: kind, p: port, c: challenge, n: nonce, e: deps.now() + 로그인유효 });
  const q = new URLSearchParams({
    client_id: P.id(env), redirect_uri: `${baseUrl(env, url)}/${kind}/callback`, response_type: "code", scope: P.scope, state,
  });
  if (kind === "ig") q.set("force_authentication", "1"); // 이미 로그인된 계정으로 조용히 넘어가지 않고 계정을 고르게 한다
  return new Response(null, { status: 302, headers: { location: `${P.authorize}?${q}`, "cache-control": "no-store" } });
}

interface Exchanged { provider: "instagram" | "threads"; access_token: string; expires_in: number; user_id: string; username: string; account_type: string }

/** 메타의 숫자 번호(17자리)는 자바스크립트 숫자로 읽으면 끝자리가 틀어진다 — 글 그대로에서 뽑는다 */
export const 번호뽑기 = (raw: string, key: string): string => new RegExp(`"${key}"\\s*:\\s*"?(\\d+)"?`).exec(raw)?.[1] ?? "";

async function exchange(env: Env, deps: Deps, kind: Kind, code: string, redirectUri: string): Promise<Exchanged> {
  const P = PROV[kind];
  const r1 = await deps.fetch(P.token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: P.id(env), client_secret: P.secret(env), grant_type: "authorization_code", redirect_uri: redirectUri, code }),
  });
  const raw1 = await r1.text();
  if (!r1.ok) throw new Error(`코드 교환 실패 ${r1.status} ${짧게(raw1, 100)}`);
  let short = "";
  try {
    const j = JSON.parse(raw1);
    short = String((Array.isArray(j.data) ? j.data[0]?.access_token : j.access_token) ?? "");
  } catch { /* 아래에서 막는다 */ }
  if (!short) throw new Error("짧은 토큰을 받지 못했습니다");
  const uid0 = 번호뽑기(raw1, "user_id");

  const r2 = await deps.fetch(`${P.longLived}?${new URLSearchParams({ grant_type: P.grant, client_secret: P.secret(env), access_token: short })}`);
  const raw2 = await r2.text();
  if (!r2.ok) throw new Error(`장기 토큰 교환 실패 ${r2.status} ${짧게(raw2, 100)}`);
  const j2 = JSON.parse(raw2);
  const token = String(j2.access_token ?? "");
  if (!token) throw new Error("장기 토큰을 받지 못했습니다");

  const r3 = await deps.fetch(`${P.me}&${new URLSearchParams({ access_token: token })}`);
  const raw3 = await r3.text();
  if (!r3.ok) throw new Error(`계정 정보 확인 실패 ${r3.status} ${짧게(raw3, 100)}`);
  const me = JSON.parse(raw3);
  const uid = (kind === "ig" ? 번호뽑기(raw3, "user_id") : 번호뽑기(raw3, "id")) || uid0;
  if (!uid) throw new Error("계정 번호를 확인하지 못했습니다");
  return {
    provider: P.이름, access_token: token, expires_in: Number(j2.expires_in) || 60 * 24 * 3600,
    user_id: uid, username: String(me.username ?? ""), account_type: String(me.account_type ?? ""),
  };
}

async function callback(env: Env, url: URL, kind: Kind, deps: Deps): Promise<Response> {
  const st = await readState(env, url.searchParams.get("state") ?? "", deps.now());
  if (!st || st.k !== kind) return 쪽(400, "로그인을 확인하지 못했습니다", "시간이 지났거나 이미 쓴 주소입니다. 앱에서 연결 단추를 다시 눌러 주세요.");
  // ★토큰은 이 주소에 싣지 않는다 — 브라우저 기록·화면에 남지 않게. 앱이 verifier 로 따로 가져간다.
  const back = (q: Record<string, string>) =>
    new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${st.p}/meta/done?${new URLSearchParams({ n: st.n, ...q })}`, "cache-control": "no-store" } });
  const err = url.searchParams.get("error");
  if (err) return back({ ok: "0", error: 짧게(err, 60), why: 짧게(url.searchParams.get("error_description") ?? "", 100) });
  const code = (url.searchParams.get("code") ?? "").replace(/#_$/, "");
  if (!code) return back({ ok: "0", error: "no_code" });
  try {
    const got = await exchange(env, deps, kind, code, `${baseUrl(env, url)}/${kind}/callback`);
    await env.META_KV.put(`pu:${st.c}`, JSON.stringify(got), { expirationTtl: 토큰보관초 });
    return back({ ok: "1" });
  } catch (e) {
    return back({ ok: "0", error: "exchange_failed", why: 짧게(e instanceof Error ? e.message : e) });
  }
}

async function pickup(env: Env, req: Request): Promise<Response> {
  let v = "";
  try { v = String((await req.json() as { verifier?: unknown }).verifier ?? ""); } catch { /* 아래에서 막는다 */ }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(v)) return json({ ok: false, why: "verifier 모양이 맞지 않습니다" }, 400);
  const key = `pu:${b64u(await sha256(v))}`;
  const got = await env.META_KV.get(key);
  if (!got) return json({ ok: false, why: "받아 갈 토큰이 없습니다(이미 가져갔거나 5분이 지남)" }, 404);
  await env.META_KV.delete(key); // 한 번만
  return json({ ok: true, ...JSON.parse(got) });
}

/* ============================================================ 영상 임시 보관 (R2) */

/**
 * S3 서명(SigV4) 쿼리 방식 주소 — R2 가 S3 호환 서명을 받는다. 일회용 업로드 주소를 만들 때 쓴다.
 * AWS 문서의 예제(GET · examplebucket)와 같은 값이 나오는지 시험으로 확인한다.
 */
export async function sigV4Presign(o: {
  method: string; host: string; path: string; region: string; service: string; accessKey: string; secretKey: string;
  expires: number; at: Date; scheme?: string;
}): Promise<string> {
  const iso = o.at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20130524T000000Z
  const day = iso.slice(0, 8);
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const enc2 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const q: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"], ["X-Amz-Credential", `${o.accessKey}/${scope}`], ["X-Amz-Date", iso],
    ["X-Amz-Expires", String(o.expires)], ["X-Amz-SignedHeaders", "host"],
  ];
  const canonQuery = q.map(([k, v]) => [enc2(k), enc2(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonPath = o.path.split("/").map(enc2).join("/");
  const canon = [o.method, canonPath, canonQuery, `host:${o.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", iso, scope, hex(await sha256(canon))].join("\n");
  let k = await hmac("AWS4" + o.secretKey, day);
  k = await hmac(k, o.region); k = await hmac(k, o.service); k = await hmac(k, "aws4_request");
  return `${o.scheme ?? "https"}://${o.host}${canonPath}?${canonQuery}&X-Amz-Signature=${hex(await hmac(k, toSign))}`;
}

const 이름꼴 = /^[0-9a-f]{32}\.(mp4|mov)$/;

async function tokenOwner(deps: Deps, kind: Kind, token: string): Promise<string | null> {
  const u = kind === "ig" ? "https://graph.instagram.com/v26.0/me?fields=user_id" : "https://graph.threads.com/v1.0/me?fields=id";
  try {
    const r = await deps.fetch(`${u}&${new URLSearchParams({ access_token: token })}`);
    if (!r.ok) return null;
    return (kind === "ig" ? 번호뽑기(await r.text(), "user_id") : 번호뽑기(await r.text(), "id")) || null;
  } catch { return null; }
}

async function stageTicket(env: Env, req: Request, url: URL, deps: Deps): Promise<Response> {
  let b: { provider?: unknown; token?: unknown; size?: unknown; ext?: unknown } = {};
  try { b = await req.json(); } catch { return json({ ok: false, why: "요청 모양이 맞지 않습니다" }, 400); }
  const kind = b.provider === "ig" || b.provider === "th" ? b.provider : null;
  const size = Number(b.size);
  const ext = b.ext === "mov" ? "mov" : b.ext === "mp4" ? "mp4" : "";
  if (!kind || typeof b.token !== "string" || !b.token) return json({ ok: false, why: "계정 정보가 없습니다" }, 400);
  if (!ext) return json({ ok: false, why: "mp4 또는 mov 만 받습니다" }, 400);
  if (!Number.isInteger(size) || size < 1 || size > STAGE_MAX_BYTES) return json({ ok: false, why: "영상 크기는 300MB 까지입니다" }, 400);
  // 아무나 우리 저장소를 쓰지 못하게 — 이 메타 앱으로 로그인한 계정의 유효한 토큰이어야 한다
  const uid = await tokenOwner(deps, kind, b.token);
  if (!uid) return json({ ok: false, why: "계정 확인에 실패했습니다(토큰이 맞지 않거나 만료)" }, 401);
  const day = new Date(deps.now()).toISOString().slice(0, 10);
  const rk = `rl:${kind}:${uid}:${day}`;
  const used = Number(await env.META_KV.get(rk)) || 0;
  if (used >= 하루한도) return json({ ok: false, why: "오늘 임시 보관 횟수를 넘었습니다" }, 429);
  await env.META_KV.put(rk, String(used + 1), { expirationTtl: 90_000 });

  const id = hex(deps.random(16));
  const name = `${id}.${ext}`;
  const now = deps.now();
  const put = await sigV4Presign({
    method: "PUT", host: `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, path: `/${env.R2_BUCKET}/stage/${name}`, region: "auto", service: "s3",
    accessKey: env.R2_ACCESS_KEY_ID, secretKey: env.R2_SECRET_ACCESS_KEY, expires: 업로드주소초, at: new Date(now),
  });
  const exp = now + 읽기주소ms;
  const sig = b64u(await hmac(env.SIGN_KEY, `get:${name}:${exp}`));
  return json({
    ok: true, id, name, put_url: put, put_expires_in: 업로드주소초,
    get_url: `${baseUrl(env, url)}/s/${name}?e=${exp}&s=${sig}`, get_expires_at: new Date(exp).toISOString(),
    delete_sig: b64u(await hmac(env.SIGN_KEY, `del:${id}`)),
  });
}

async function stageDelete(env: Env, req: Request): Promise<Response> {
  let b: { id?: unknown; sig?: unknown } = {};
  try { b = await req.json(); } catch { return json({ ok: false, why: "요청 모양이 맞지 않습니다" }, 400); }
  const id = String(b.id ?? "");
  if (!/^[0-9a-f]{32}$/.test(id)) return json({ ok: false, why: "번호 모양이 맞지 않습니다" }, 400);
  if (!safeEq(b64u(await hmac(env.SIGN_KEY, `del:${id}`)), String(b.sig ?? ""))) return json({ ok: false, why: "서명이 맞지 않습니다" }, 403);
  await env.STAGE.delete([`stage/${id}.mp4`, `stage/${id}.mov`]);
  return json({ ok: true });
}

async function stageServe(env: Env, req: Request, url: URL, name: string, deps: Deps): Promise<Response> {
  if (!이름꼴.test(name)) return new Response("not found", { status: 404 });
  const exp = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("s") ?? "";
  if (!Number.isFinite(exp) || exp <= deps.now()) return new Response("expired", { status: 410 });
  if (!safeEq(b64u(await hmac(env.SIGN_KEY, `get:${name}:${exp}`)), sig)) return new Response("forbidden", { status: 403 });
  const key = `stage/${name}`;
  const head = await env.STAGE.head(key);
  if (!head) return new Response("not found", { status: 404 });
  // 크론이 늦어도 1시간 넘은 임시본은 내주지 않는다
  if (head.uploaded.getTime() + 읽기주소ms + 5 * 60_000 < deps.now()) return new Response("expired", { status: 410 });
  const type = name.endsWith(".mov") ? "video/quicktime" : "video/mp4";
  const heads: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
  let offset = 0, length = head.size, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (m && (m[1] || m[2])) {
    if (m[1]) { offset = Number(m[1]); length = (m[2] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1) - offset + 1; }
    else { const n = Math.min(Number(m[2]), head.size); offset = head.size - n; length = n; }
    if (offset >= head.size || length < 1) return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
    status = 206;
    heads["content-range"] = `bytes ${offset}-${offset + length - 1}/${head.size}`;
  }
  heads["content-length"] = String(length);
  if (req.method === "HEAD") return new Response(null, { status, headers: heads });
  const obj = await env.STAGE.get(key, status === 206 ? { range: { offset, length } } : undefined);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, { status, headers: heads });
}

/** 크론 — 1시간 지난 임시본을 지운다 (R2 의 수명 규칙은 최소 1일이라 이 크론이 1시간을 지킨다) */
export async function cleanStage(env: Env, deps: Deps = 실제): Promise<number> {
  let cursor: string | undefined, n = 0;
  const limit = deps.now() - 읽기주소ms;
  for (let i = 0; i < 50; i++) {
    const page = await env.STAGE.list({ prefix: "stage/", cursor, limit: 500 });
    const old = page.objects.filter((o) => o.uploaded.getTime() < limit).map((o) => o.key);
    if (old.length) { await env.STAGE.delete(old); n += old.length; }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return n;
}

/* ============================================================ 메타가 부르는 연결 해제 · 데이터 삭제 알림 */

/** signed_request = base64url(서명).base64url(JSON) — 앱 비밀로 HMAC-SHA256 을 확인한다 */
export async function readSignedRequest(secret: string, signed: string): Promise<{ user_id?: string } | null> {
  const [sig, payload] = signed.split(".");
  if (!sig || !payload || !secret) return null;
  const want = b64u(await hmac(secret, payload));
  if (!safeEq(want, sig.replace(/=+$/, ""))) return null;
  try { return JSON.parse(new TextDecoder().decode(unb64u(payload))) as { user_id?: string }; } catch { return null; }
}

async function metaNotice(env: Env, req: Request, url: URL, kind: Kind, what: "deauthorize" | "delete", deps: Deps): Promise<Response> {
  let signed = "";
  try { signed = String((await req.formData()).get("signed_request") ?? ""); } catch { /* 아래에서 막는다 */ }
  const p = await readSignedRequest(PROV[kind].secret(env), signed);
  if (!p) return json({ ok: false, why: "서명을 확인하지 못했습니다" }, 400);
  // 이 중계는 사용자별 정보를 따로 저장하지 않는다(토큰은 5분 뒤 스스로 사라지고, 앱의 토큰은 사용자의 컴퓨터에만 있다).
  if (what === "deauthorize") return json({ ok: true });
  const code = hex(deps.random(8));
  await env.META_KV.put(`del:${code}`, JSON.stringify({ at: new Date(deps.now()).toISOString(), provider: PROV[kind].이름 }), { expirationTtl: 90 * 24 * 3600 });
  return json({ url: `${baseUrl(env, url)}/deletion?code=${code}`, confirmation_code: code });
}

async function deletionPage(env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code") ?? "";
  const got = /^[0-9a-f]{16}$/.test(code) ? await env.META_KV.get(`del:${code}`) : null;
  if (!got) return 쪽(404, "삭제 요청을 찾지 못했습니다", "확인 번호가 맞지 않거나 90일이 지났습니다.");
  return 쪽(200, "삭제 요청이 처리되었습니다",
    `확인 번호 <b>${code}</b> · 이 서비스는 사용자의 인스타그램·스레드 정보를 서버에 저장하지 않습니다. ` +
    "로그인 직후 5분 동안만 두었다 가져가면 지우는 임시 토큰이 전부이고, 앱의 토큰은 사용자의 컴퓨터에만 있습니다. 컴퓨터의 연결을 끊으면 그 토큰도 지워집니다.");
}

/* ============================================================ 길 나누기 */

export async function handle(req: Request, env: Env, deps: Deps = 실제): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;
  try {
    if (m === "GET" && p === "/") return 쪽(200, "가라사대 업로더 로그인 중계", "인스타그램·스레드 연결을 돕는 서버입니다. 사용자 정보를 서버에 두지 않습니다.");
    let r: RegExpExecArray | null;
    if ((r = /^\/(ig|th)\/(start|callback)$/.exec(p)) && m === "GET") {
      return r[2] === "start" ? await start(env, url, r[1] as Kind, deps) : await callback(env, url, r[1] as Kind, deps);
    }
    if (m === "POST" && p === "/pickup") return await pickup(env, req);
    if (m === "POST" && p === "/stage/ticket") return await stageTicket(env, req, url, deps);
    if (m === "POST" && p === "/stage/delete") return await stageDelete(env, req);
    if ((r = /^\/s\/([^/]+)$/.exec(p)) && (m === "GET" || m === "HEAD")) return await stageServe(env, req, url, r[1], deps);
    if ((r = /^\/(ig|th)\/(deauthorize|delete)$/.exec(p)) && m === "POST") return await metaNotice(env, req, url, r[1] as Kind, r[2] as "deauthorize" | "delete", deps);
    if (m === "GET" && p === "/deletion") return await deletionPage(env, url);
    return new Response("not found", { status: 404 });
  } catch (e) {
    return json({ ok: false, why: 짧게(e instanceof Error ? e.message : e) }, 500);
  }
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
  scheduled: (_event: unknown, env: Env) => cleanStage(env),
};

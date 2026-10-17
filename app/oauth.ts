// 인증 — 관리자 계정 하나로 로그인하고 채널만 바꿔 고른다. (파이썬 auth.py · device.py · serve._signin)
//
// 방식이 둘이다. 어느 쪽으로 받든 같은 자리(tokens.json)에 같은 모양으로 저장하므로 나머지 기능은 차이를 모른다.
//
//  ① 브라우저 로그인 (루프백 + PKCE) — `prompt=select_account consent`
//     이 컴퓨터에서 구글 로그인 창이 열린다. 계정을 고른 뒤 **이번에 등록할 채널**을 고른다.
//     consent 가 없으면 리프레시 토큰이 다시 나오지 않는다.
//     콜백은 임시 포트(0번 → 운영체제가 빈 포트를 줌)에서 받는다. 데스크톱 클라이언트는 어느 루프백 포트든 받아 준다.
//
//  ② 코드 인증 (TV 및 입력 제한 기기) — 여덟 자리 코드를 불러 주고, 상대가 자기 기기에서 승인한다.
//     승인하는 사람이 이 컴퓨터 앞에 없어도 된다. 비밀번호가 오가지 않는다.
//     device_secret.json(TV 유형 클라이언트)이 따로 필요하다. 데스크톱 클라이언트로는 이 방식이 안 된다.
//
// 요청하는 범위는 세 개뿐이다. 넷째를 섞으면 코드 인증과 기존 열쇠가 죽는다.
import { call, doFetch, GoogleError, OAUTH_AUTH, OAUTH_DEVICE, OAUTH_TOKEN, toGoogleError } from "./google.ts";
import {
  accessToken, AuthError, clientFor, deviceSecretsPath, explainOAuth, loadStore, pickClient, projectIdOf, putEntry,
  SCOPES, secretsPath,
} from "./ytcore.ts";
import type { ClientConf, TokenEntry } from "./ytcore.ts";
import { embeddedState, parseClientJson } from "./embedded.ts";
import { dataPath, exists, IS_WIN, log, readJson, writeJson } from "./paths.ts";
import { ensureChannelSlot } from "./channels.ts";
import { downloadArt, fetchProfile, remember } from "./profile.ts";
import { isoWall, wallNow } from "./clock.ts";

type Obj = Record<string, any>;

/* ============================================================ 열쇠 파일 넣기 */

export type ClientKind = "client" | "device";

/** 구글에서 받은 JSON 글(또는 ID·비밀번호)을 검사해 제자리에 둔다. 권한 600. */
export async function saveClientFile(
  kind: ClientKind, input: { json?: string; clientId?: string; clientSecret?: string },
): Promise<{ where: string; kind: ClientKind }> {
  let conf: Obj;
  if (input.json !== undefined) {
    let d: Obj;
    try { d = JSON.parse(input.json); } catch { throw new Error("JSON 파일이 아닙니다"); }
    conf = (d.installed ?? d.web ?? d) as Obj;
    if (!conf.client_id) throw new Error("client_id 가 없습니다. 받은 파일이 맞는지 확인하세요.");
    if (d.web && !d.installed) throw new Error("「웹 애플리케이션」 유형입니다. 「데스크톱 앱」(또는 코드 인증은 「TV 및 입력 제한 기기」)으로 다시 만들어 주세요.");
  } else {
    const id = (input.clientId ?? "").trim(), sec = (input.clientSecret ?? "").trim();
    if (!id.includes("apps.googleusercontent.com")) throw new Error("클라이언트 ID 형식이 올바르지 않습니다. (....apps.googleusercontent.com)");
    if (!sec) throw new Error("클라이언트 보안 비밀번호를 입력해 주세요.");
    conf = { client_id: id, client_secret: sec };
  }
  // 구글이 주는 파일과 같은 꼴(installed)로 적는다
  const out = {
    installed: {
      client_id: String(conf.client_id),
      project_id: conf.project_id ?? "",
      auth_uri: conf.auth_uri ?? OAUTH_AUTH,
      token_uri: conf.token_uri ?? OAUTH_TOKEN,
      auth_provider_x509_cert_url: conf.auth_provider_x509_cert_url ?? "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: String(conf.client_secret ?? ""),
      redirect_uris: conf.redirect_uris ?? ["http://localhost"],
    },
  };
  const dest = kind === "client" ? secretsPath() : deviceSecretsPath();
  await writeJson(dest, out, { secret: true });
  return { where: dest, kind };
}

/** 채널마다 따로 쓰는 클라이언트 파일을 데이터 폴더에 둔다 (파이썬 --secret). 파일 이름을 돌려준다. */
export async function saveChannelClientFile(name: string, conf: { clientId: string; clientSecret: string }): Promise<string> {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "채널";
  const file = `client_secret_${safe}.json`;
  await writeJson(dataPath(file), {
    installed: {
      client_id: conf.clientId, client_secret: conf.clientSecret, auth_uri: OAUTH_AUTH, token_uri: OAUTH_TOKEN,
      redirect_uris: ["http://localhost"],
    },
  }, { secret: true });
  return file;
}

/** 채널 전용 열쇠를 구글에서 받은 JSON 글 그대로 넣는다 (화면에서 파일을 올릴 때). 파일 이름을 돌려준다. */
export async function saveChannelClientJson(name: string, json: string): Promise<string> {
  const c = parseClientJson(json);
  if (!c) throw new Error("열쇠 JSON 이 아니거나 client_id 가 없습니다");
  try {
    const d = JSON.parse(json) as Obj;
    if (d.web && !d.installed) throw new Error("「웹 애플리케이션」 유형입니다. 「데스크톱 앱」으로 다시 만들어 주세요.");
  } catch (e) { if (e instanceof Error && e.message.includes("웹 애플리케이션")) throw e; }
  return await saveChannelClientFile(name, { clientId: c.client_id, clientSecret: c.client_secret });
}

/**
 * 열쇠가 어디까지 준비됐나 (serve secret/state)
 *   client/device  — 데이터 폴더에 사용자가 넣은 열쇠 파일이 있나
 *   embedded       — 이 앱에 묶여 온 내장 열쇠가 있나 (값은 보이지 않는다)
 *   ready          — 새 연결을 시작할 수 있나 (내 파일 또는 내장 열쇠 중 하나)
 */
export async function clientState(): Promise<{
  client: boolean; device: boolean; channels: number;
  embedded: { browser: boolean; device: boolean }; ready: { browser: boolean; device: boolean };
}> {
  const store = loadStore();
  const done = new Set(Object.values(store).map((v) => v.channel_id).filter(Boolean));
  const client = await exists(secretsPath()), device = await exists(deviceSecretsPath());
  const embedded = await embeddedState();
  return {
    client, device, channels: done.size, embedded,
    ready: { browser: client || embedded.browser, device: device || embedded.device },
  };
}

/* ============================================================ 등록(저장) — 두 방식이 같이 쓴다 */

export interface RegisterResult { key: string; channel_id: string; title: string; replaced: string[]; slotMade: boolean }

/**
 * 받은 리프레시 토큰으로 어느 채널인지 확인하고 목록에 넣는다.
 * 같은 채널이 다른 이름으로 이미 있으면 그 자리를 갱신한다(중복 방지).
 * 등록 직후 채널정보·배너·프로필 사진을 받아 두고, channels.json 에 자리를 만든다.
 */
export async function registerToken(o: {
  alias?: string; refresh: string; accessToken?: string; how: "browser" | "device"; granted?: string[]; secretFile?: string;
  /** "내장" = 이 앱에 묶여 온 열쇠로 연결했다 */
  client?: string;
}): Promise<RegisterResult> {
  const entry: TokenEntry = {
    channel_id: "", title: "", refresh_token: o.refresh, added: isoWall(wallNow()),
    how: o.how, scopes: o.granted?.length ? o.granted : [...SCOPES],
  };
  if (o.secretFile) entry.secret = o.secretFile;
  if (o.client) entry.client = o.client;
  const token = o.accessToken ?? await accessToken(entry);
  const conf = await clientFor(entry);
  const items = (await call({ token, project: projectIdOf(conf.client_id) }, "GET", "/youtube/v3/channels",
    { query: { part: "snippet", mine: true } })).items ?? [];
  if (!items.length) throw new Error("이 인증에 연결된 채널이 없습니다. 채널 선택을 확인하세요.");
  const cid: string = items[0].id, title: string = items[0].snippet?.title ?? "";
  entry.channel_id = cid;
  entry.title = title;
  const key = o.alias?.trim() || title;
  const replaced = await putEntry(key, entry);
  const slotMade = await ensureChannelSlot(key, cid);
  try {
    const prof = await fetchProfile(key);
    prof.art = await downloadArt(prof);
    await remember(prof);
  } catch (e) {
    await log(`  채널정보를 못 받았습니다(${String(e instanceof Error ? e.message : e).slice(0, 60)}) — 채널 탭의 「정보 새로 받기」로 받으세요`);
  }
  return { key, channel_id: cid, title, replaced, slotMade };
}

/* ============================================================ ① 브라우저 로그인 */

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface SignInState {
  running: boolean;
  alias: string | null;
  url?: string;
  done?: { key: string; title: string; channel_id: string };
  why?: string;
}
/** 진행 중인 브라우저 로그인 하나 (화면이 signin/check 로 묻는다) */
export const signin: { state: SignInState; stop?: () => void } = { state: { running: false, alias: null } };

const 결과쪽 = (제목: string, 본문: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${제목}</title>` +
      `<body style="background:#0b0b11;color:#ededf4;font-family:-apple-system,'Malgun Gothic',sans-serif;text-align:center;padding:90px 20px">${본문}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/**
 * 브라우저 로그인을 시작한다. 구글 로그인 주소를 돌려주고, 끝나면 signin.state 가 바뀐다.
 * 부르는 쪽(화면 서버·명령줄)이 주소를 브라우저로 연다.
 */
export async function startSignIn(alias: string | null, secretFile?: string): Promise<{ url: string; done: Promise<RegisterResult> }> {
  if (signin.state.running) throw new Error("이미 로그인 창이 열려 있습니다");
  // 브라우저 로그인은 반드시 데스크톱 유형 열쇠로 한다 (이 채널 전용 파일 → 데이터 폴더의 client_secret.json → 앱에 묶인 열쇠 순서).
  //   TV 유형(device_secret.json)으로는 루프백 로그인이 안 된다.
  let conf: ClientConf, mark: { secret?: string; client?: string };
  try {
    ({ conf, mark } = await pickClient("browser", secretFile));
  } catch (e) {
    throw new Error(e instanceof AuthError ? e.message : "구글 로그인용 열쇠를 찾지 못했습니다");
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const stateKey = crypto.randomUUID();

  let port = 0;
  let resolveCb!: (v: { code?: string; error?: string }) => void;
  const cb = new Promise<{ code?: string; error?: string }>((r) => { resolveCb = r; });
  const srv = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: (a) => { port = a.port; } }, (req) => {
    const u = new URL(req.url);
    if (u.searchParams.has("code") || u.searchParams.has("error")) {
      if (u.searchParams.get("state") !== stateKey) {
        return 결과쪽("인증 실패", `<h2 style="color:#ff4466">❌ 인증 상태가 일치하지 않습니다</h2><p style="color:#8e8ea8">앱에서 다시 시도해 주세요.</p>`);
      }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      resolveCb(err || !code ? { error: err ?? "인증 코드를 받지 못했습니다" } : { code });
      return err || !code
        ? 결과쪽("인증 실패", `<h2 style="color:#ff4466">❌ 인증에 실패했습니다</h2><p style="color:#8e8ea8">${esc(explainOAuth(err ?? ""))}</p>`)
        : 결과쪽("연결 완료", `<h2 style="color:#2dd4a8">✅ 연결됐습니다</h2><p style="color:#5a5a72;font-size:13px">이 창을 닫고 앱으로 돌아가세요.</p><script>setTimeout(()=>window.close(),2500)</script>`);
    }
    return new Response("not found", { status: 404 });
  });
  // onListen 은 거의 즉시 불린다
  for (let i = 0; i < 50 && !port; i++) await new Promise((r) => setTimeout(r, 10));
  const redirect = `http://127.0.0.1:${port}`;
  const q = new URLSearchParams({
    client_id: conf.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    // select_account 를 함께 보내야 계정·채널 고르는 화면이 매번 뜬다. consent 만 보내면 구글이 지난번
    // 고른 것으로 조용히 넘어가, 채널이 여러 개인 사람이 다른 채널을 붙일 방법이 없어진다.
    prompt: "select_account consent",
    state: stateKey,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const url = `${OAUTH_AUTH}?${q}`;
  signin.state = { running: true, alias, url };
  const 끝 = () => { try { srv.shutdown(); } catch { /* 이미 꺼짐 */ } };
  signin.stop = () => { resolveCb({ error: "취소했습니다" }); 끝(); };

  const done = (async () => {
    try {
      const timer = setTimeout(() => resolveCb({ error: "10분이 지나 로그인을 접었습니다" }), 10 * 60_000);
      const got = await cb;
      clearTimeout(timer);
      // 구글이 돌려준 오류 코드(access_denied 등)는 사람이 읽는 말로 — 우리 쪽 한국어 사유(취소·시간 초과)는 그대로 지나간다
      if (got.error || !got.code) throw new Error(got.error ? explainOAuth(got.error) : "인증 코드를 받지 못했습니다");
      const body = new URLSearchParams({
        client_id: conf.client_id, client_secret: conf.client_secret, code: got.code,
        code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirect,
      });
      const r = await doFetch(conf.token_uri || OAUTH_TOKEN, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
      });
      if (!r.ok) {
        const e = await toGoogleError(r);
        throw new Error(explainOAuth(e.reason, e.message));
      }
      const j = await r.json();
      if (!j.refresh_token) {
        throw new Error("리프레시 토큰을 못 받았습니다. 구글 계정 > 보안 > 서드파티 앱에서 기존 권한을 삭제한 뒤 다시 연결해 주세요.");
      }
      const granted = typeof j.scope === "string" ? j.scope.split(" ").filter(Boolean) : undefined;
      const res = await registerToken({
        alias: alias ?? undefined, refresh: j.refresh_token, accessToken: j.access_token, how: "browser", granted,
        secretFile: mark.secret, client: mark.client,
      });
      signin.state = { running: false, alias, done: { key: res.key, title: res.title, channel_id: res.channel_id } };
      return res;
    } catch (e) {
      signin.state = { running: false, alias, why: String(e instanceof Error ? e.message : e).slice(0, 200) };
      throw e;
    } finally {
      끝();
    }
  })();
  done.catch(() => {}); // 부르는 쪽이 안 받아도 프로그램이 끝나지 않게
  return { url, done };
}

/* ============================================================ ② 코드 인증 (디바이스) */

export interface DeviceSession {
  device_code: string;
  user_code: string;
  verification_url?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  _client_id: string;
  _client_secret: string;
  _started: number;
  /** 토큰 항목에 남길 열쇠 표식 (내장 열쇠로 시작했으면 client:"내장") */
  _mark?: { secret?: string; client?: string };
}
/** 진행 중인 코드 인증 (채널이름 → 세션) */
export const codeSessions = new Map<string, DeviceSession>();

export class NotReady extends Error {
  constructor(m: string) { super(m); this.name = "NotReady"; }
}

async function deviceClient(): Promise<{ conf: ClientConf; mark: { secret?: string; client?: string } }> {
  try {
    return await pickClient("device");
  } catch (e) {
    throw new NotReady(
      (e instanceof AuthError ? e.message : "device_secret.json 을 읽지 못했습니다") + "\n" +
        "Cloud 콘솔 → 사용자 인증 정보 → OAuth 클라이언트 만들기에서 유형을 'TV 및 입력 제한 기기' 로 골라 받은 파일을 넣어 주세요.\n" +
        "(데스크톱 클라이언트로는 이 방식이 동작하지 않습니다)",
    );
  }
}

/** 구글은 아직 승인 안 됨도 400 으로 준다. 본문을 읽어야 구분된다. */
async function postForm(url: string, form: Record<string, string>): Promise<Obj> {
  const r = await doFetch(url, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form), signal: AbortSignal.timeout(30000),
  });
  try { return await r.json(); } catch { throw new NotReady(`구글 응답을 읽지 못했습니다 (${r.status})`); }
}

/** 1단계: 화면에 띄울 주소와 코드를 받아 온다. */
export async function deviceStart(): Promise<DeviceSession> {
  const { conf, mark } = await deviceClient();
  const got = await postForm(OAUTH_DEVICE, { client_id: conf.client_id, scope: SCOPES.join(" ") });
  if (!got.device_code) throw new NotReady(got.error_description || got.error || "코드를 받지 못했습니다");
  return { ...got, _client_id: conf.client_id, _client_secret: conf.client_secret, _started: Date.now() / 1000, _mark: mark } as DeviceSession;
}

export type PollState =
  | { state: "waiting" } | { state: "slow" } | { state: "expired" }
  | { state: "denied"; why: string }
  | { state: "ok"; refresh: string; access: string; scope?: string };

/** 2단계: 한 번만 물어본다. */
export async function devicePoll(session: DeviceSession): Promise<PollState> {
  const got = await postForm(OAUTH_TOKEN, {
    client_id: session._client_id,
    client_secret: session._client_secret ?? "",
    device_code: session.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const err = got.error;
  if (err === "authorization_pending") return { state: "waiting" };
  if (err === "slow_down") return { state: "slow" };
  if (err === "expired_token") return { state: "expired" };
  if (err === "access_denied" || err === "admin_policy_enforced") return { state: "denied", why: got.error_description || err };
  if (err) return { state: "denied", why: got.error_description || err };
  if (!got.refresh_token) return { state: "denied", why: "리프레시 토큰이 오지 않았습니다. 동의 화면을 다시 진행하세요." };
  return { state: "ok", refresh: got.refresh_token, access: got.access_token ?? "", scope: got.scope };
}

/** 터미널에서 쓸 때: 승인될 때까지 기다렸다가 리프레시 토큰을 돌려준다. */
export async function deviceWait(session: DeviceSession, onTick?: (left: number) => void): Promise<PollState & { state: "ok" }> {
  let gap = Number(session.interval ?? 5);
  const limit = session._started + Number(session.expires_in ?? 1800);
  while (Date.now() / 1000 < limit) {
    const r = await devicePoll(session);
    if (r.state === "ok") return r;
    if (r.state === "slow") gap += 5;
    else if (r.state === "expired" || r.state === "denied") {
      throw new NotReady(r.state === "denied" ? r.why : "코드가 만료됐습니다. 다시 시작하세요.");
    }
    onTick?.(Math.floor(limit - Date.now() / 1000));
    await new Promise((res) => setTimeout(res, gap * 1000));
  }
  throw new NotReady("시간이 다 됐습니다. 다시 시작하세요.");
}

/** 3단계: 어느 채널인지 확인하고 저장한다. 브라우저 로그인과 같은 자리·같은 모양. */
export async function deviceSave(
  refresh: string, alias?: string, o: { access?: string; scope?: string; mark?: { secret?: string; client?: string } } = {},
): Promise<RegisterResult> {
  const granted = o.scope ? o.scope.split(" ").filter(Boolean) : undefined;
  return await registerToken({
    alias, refresh, accessToken: undefined, how: "device", granted, secretFile: o.mark?.secret, client: o.mark?.client,
  });
}

export { GoogleError, IS_WIN };

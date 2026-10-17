// 공통 — 자격증명(토큰) 보관과 유튜브 호출 도구. (파이썬 ytcore.py)
//
// 위임받은 관리자 계정 하나로 여러 채널에 올리기 위한 뼈대.
// 채널마다 OAuth 사용자 인증을 한 번씩 받아 리프레시 토큰을 `tokens.json` 에 보관한다.
//
// 지키는 약속 (파이썬 참고/함정.md 에서 가져온 것)
//   · 토큰마다 **발급 당시의 범위(scopes)를 같이 적는다.** 전역 SCOPES 를 바꿔도 옛 토큰이 안 죽게
//     (범위 하나를 더했다가 토큰 8개가 invalid_scope 로 한꺼번에 죽은 일이 있다).
//   · 인증 객체를 캐시하지 않는다 — 채널이 섞인다. (접근 토큰만 만료 전까지 메모리에 잠깐)
//   · 못 찾으면 LookupError — 여러 채널을 도는 반복이 통째로 멈추지 않게 던지는 꼴을 정해 둔다.
//   · 모든 videos.update 는 영상바꾸기() 한 길을 지난다: 지금 값을 읽고 → 바꿀 칸만 합치고 → 쓴다.
import { call, GoogleError, OAUTH_TOKEN, doFetch, toGoogleError, WWW } from "./google.ts";
import type { Bearer, Query } from "./google.ts";
import { dataPath, readJson, readJsonSync, recordLine, withFileLock, writeJson } from "./paths.ts";
import { readLedger } from "./ledger.ts";
import { embeddedClient, type ClientConf, type EmbeddedKind } from "./embedded.ts";

export type { ClientConf, EmbeddedKind };

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  // 공개 전환(videos.update)에 필요하다. 업로드 권한만으로는 403 이 난다.
  //   force-ssl 이 아니라 youtube 를 쓴다 — 코드 인증(TV 방식)이 force-ssl 을 받아 주지 않는다.
  "https://www.googleapis.com/auth/youtube",
];
/** 공개 전환 권한이 생기기 전에 받은 토큰들이 가진 범위 (옛 앱 토큰도 이 범위다) */
export const SCOPES_LEGACY = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
export const PUBLISH_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

// ── 못 하는 일 (파이썬 2026-08-28 확정) ─────────────────────────
//   코드 인증(TV 방식)이 받는 범위는 위 셋뿐이다. 그래서 아래는 앞으로도 못 한다.
//     자막 업로드(captions.insert) · 댓글 쓰기/읽기(force-ssl) · 정확한 일별 구독 증감 · 채널 프로필 사진 바꾸기
//   영상 썸네일(thumbnails.set)은 youtube.upload 로 충분해서 된다.

export interface TokenEntry {
  channel_id: string;
  title: string;
  refresh_token: string;
  added: string;
  scopes?: string[];
  /** device = 코드 인증 · browser = 브라우저 로그인 */
  how?: string;
  /** 이 채널만 쓰는 클라이언트 파일 이름(데이터 폴더 안) */
  secret?: string;
  /** "내장" = 이 앱에 묶여 온 열쇠로 연결했다 (그 토큰은 항상 그 열쇠로 갱신한다) */
  client?: string;
  [k: string]: unknown;
}
export type Store = Record<string, TokenEntry>;

export class LookupError extends Error {
  constructor(m: string) { super(m); this.name = "LookupError"; }
}
/** 로그인·설정을 고쳐야 하는 문제 (재시도해도 소용없음) */
export class AuthError extends Error {
  constructor(m: string, public helpUrl = "") { super(m); this.name = "AuthError"; }
}

export const secretsPath = () => dataPath("client_secret.json");
export const deviceSecretsPath = () => dataPath("device_secret.json");
export const storePath = () => dataPath("tokens.json");

export function canPublish(entry: TokenEntry): boolean {
  const sc = entry.scopes && entry.scopes.length ? entry.scopes : SCOPES_LEGACY;
  return PUBLISH_SCOPES.some((x) => sc.includes(x));
}

/** tokens.json 읽기 (비밀 파일 — 내용을 밖으로 내보내지 않는다) */
export function loadStore(): Store {
  return readJsonSync<Store>(storePath(), {});
}

/** 토큰 저장소를 잠그고 고친다. 다른 프로세스(예약 작업)와 겹쳐 쓰지 않게. */
export async function updateStore<T>(고치기: (s: Store) => T | Promise<T>): Promise<T> {
  const r = await withFileLock(dataPath("tokens.lock"), async () => {
    const s = await readJson<Store>(storePath(), {});
    const out = await 고치기(s);
    await writeJson(storePath(), s, { secret: true });
    return out;
  });
  return r as T;
}

export async function saveStore(data: Store): Promise<void> {
  await writeJson(storePath(), data, { secret: true });
}

/**
 * 같은 채널이 이미 다른 별칭으로 있으면 그 자리를 갱신한다(중복 방지). 반환: 지운 옛 별칭들
 *
 * `merge: false` 는 **옛 판 자료를 옮길 때만** 쓴다 — 옛 판에서는 같은 유튜브 채널을 이름 둘로 등록한 사람이 있고, 각각 제 로그인 정보
 * (제 구글 열쇠로 받은 것)를 갖는다. 하나로 합치면 살아 있는 쪽을 지울 수도 있어서, 옮길 때는 둘 다 그대로 둔다.
 */
export async function putEntry(key: string, entry: TokenEntry, o: { merge?: boolean } = {}): Promise<string[]> {
  return await updateStore((s) => {
    const removed: string[] = [];
    if (o.merge !== false) {
      for (const [k, v] of Object.entries(s)) {
        if (v.channel_id && v.channel_id === entry.channel_id) { delete s[k]; removed.push(k); }
      }
    }
    s[key] = entry;
    return removed;
  });
}

/** 별칭이든 채널ID든 저장소의 열쇠로 바꾼다. 없으면 null. */
export function resolve(key: string): string | null {
  const s = loadStore();
  if (key in s) return key;
  for (const [k, v] of Object.entries(s)) if (v.channel_id === key) return k;
  return null;
}

/** channels.json 의 그 이름 칸에 적힌 channel_id (한 채널을 두 이름으로 등록한 경우를 잇는다) */
function channelIdOfName(name: string): string {
  const conf = readJsonSync<Record<string, { channel_id?: string }>>(dataPath("channels.json"), {});
  const v = conf[name];
  return v && typeof v === "object" ? (v.channel_id ?? "") : "";
}

/** 이 이름(별칭·채널ID·덧붙인 이름)으로 토큰 항목을 찾는다. 못 찾으면 LookupError. */
export function entryFor(key: string): { key: string; entry: TokenEntry } {
  const s = loadStore();
  if (s[key]) return { key, entry: s[key] };
  for (const [k, v] of Object.entries(s)) if (v.channel_id === key) return { key: k, entry: v };
  const cid = channelIdOfName(key);
  if (cid) for (const [k, v] of Object.entries(s)) if (v.channel_id === cid) return { key: k, entry: v };
  throw new LookupError(`등록되지 않은 채널: ${key} — 먼저 채널 탭에서 구글 계정을 연결하세요.`);
}

/* ─────────── 클라이언트(구글에서 받은 열쇠 파일) ─────────── */

export async function readClientFile(file: string): Promise<ClientConf> {
  const d = await readJson<Record<string, unknown>>(file, {});
  const conf = ((d.installed ?? d.web ?? d) as Record<string, unknown>);
  if (!conf.client_id) throw new AuthError(`${file.split(/[\\/]/).pop()} 에서 client_id 를 찾지 못했습니다`);
  return {
    client_id: String(conf.client_id),
    client_secret: String(conf.client_secret ?? ""),
    token_uri: String(conf.token_uri ?? OAUTH_TOKEN),
  };
}

const 있나 = (f: string) => Deno.stat(f).then(() => true, () => false);

/**
 * 이 토큰을 발급한 클라이언트를 고른다. (파이썬 _client_for)
 *   토큰은 발급한 클라이언트로만 갱신된다. 코드 인증(TV 클라이언트)으로 받은 토큰을 데스크톱
 *   클라이언트로 갱신하면 구글이 unauthorized_client 로 거부한다(실제로 그랬다).
 *
 * 순서
 *   1) 이 채널만 쓰는 열쇠 파일(entry.secret) — 채널마다 제 클라이언트를 따로 쓸 수 있다
 *   2) 내장 열쇠로 연결했다고 적힌 토큰(entry.client === "내장") — 데이터 폴더에 다른 열쇠 파일이 생겨도 이 토큰은 내장 열쇠로 갱신
 *   3) 데이터 폴더의 열쇠 파일(사용자가 직접 넣은 것 · 옛 앱 사용자가 넣은 것) — 코드 인증 토큰은 device_secret.json
 *   4) 이 앱에 묶여 온 내장 열쇠
 *   5) 마지막으로 다른 종류의 파일이라도 시도한다 (파이썬과 같다)
 */
export async function clientFor(entry: TokenEntry): Promise<ClientConf> {
  const kind: EmbeddedKind = entry.how === "device" ? "device" : "browser";
  if (entry.secret) {
    // 전용 파일이 없거나 깨졌을 때: 어디서 무엇을 고치는지 말한다 (읽기 함수의 일반 오류 글 대신)
    try { return await readClientFile(dataPath(entry.secret)); } catch {
      throw new AuthError(`이 채널 전용 열쇠 파일(${entry.secret})을 읽지 못했습니다. 채널 탭에서 다시 지정해 주세요.`);
    }
  }
  if (entry.client === "내장") {
    const c = await embeddedClient(kind);
    if (c) return c;
    throw new AuthError("이 채널은 이 앱에 내장된 열쇠로 연결됐는데, 지금 쓰는 판에는 내장 열쇠가 없습니다. 내장 열쇠가 든 판을 쓰거나 채널을 다시 연결해 주세요.");
  }
  const mine = kind === "device" ? deviceSecretsPath() : secretsPath();
  if (await 있나(mine)) return await readClientFile(mine);
  const emb = await embeddedClient(kind);
  if (emb) return emb;
  const other = kind === "device" ? secretsPath() : deviceSecretsPath();
  if (await 있나(other)) return await readClientFile(other);
  throw new AuthError(
    kind === "device"
      ? "코드 인증용 열쇠 파일(device_secret.json)이 없습니다. 채널 탭의 「내 열쇠 쓰기」에서 넣어 주세요."
      : "구글 로그인용 열쇠 파일(client_secret.json)이 없습니다. 채널 탭의 「내 열쇠 쓰기」에서 넣어 주세요.",
  );
}

/** 새로 연결할 때 쓸 열쇠와, 토큰 항목에 남길 표식 */
export interface PickedClient { conf: ClientConf; mark: { secret?: string; client?: string } }

/**
 * 새 연결(브라우저 로그인·코드 인증)이 쓸 클라이언트를 고른다.
 *   · 채널 전용 파일을 지정했으면 그것(항목에 secret 로 남김)
 *   · 데이터 폴더에 사용자가 넣은 열쇠 파일이 있으면 그것 (옛 방식 그대로, 표식 없음)
 *   · 아무것도 없으면 이 앱에 묶여 온 내장 열쇠 (항목에 client:"내장" 으로 남김)
 */
export async function pickClient(kind: EmbeddedKind, secretFile?: string): Promise<PickedClient> {
  if (secretFile) {
    try { return { conf: await readClientFile(dataPath(secretFile)), mark: { secret: secretFile } }; } catch {
      throw new AuthError(`전용 열쇠 파일(${secretFile})을 읽지 못했습니다`);
    }
  }
  const mine = kind === "device" ? deviceSecretsPath() : secretsPath();
  if (await 있나(mine)) return { conf: await readClientFile(mine), mark: {} };
  const emb = await embeddedClient(kind);
  if (emb) return { conf: emb, mark: { client: "내장" } };
  throw new AuthError(
    kind === "device"
      ? "코드 인증용 열쇠가 없습니다. 이 판에는 내장 열쇠가 없어, 채널 탭의 「내 열쇠 쓰기」에서 device_secret.json 을 넣어야 합니다."
      : "구글 로그인용 열쇠가 없습니다. 이 판에는 내장 열쇠가 없어, 채널 탭의 「내 열쇠 쓰기」에서 client_secret.json 을 넣어야 합니다.",
  );
}

/** 구글 프로젝트를 가르는 짧은 이름 — 클라이언트 ID 로 만든다(원문을 밖에 안 둔다) */
export function projectIdOf(clientId: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < clientId.length; i++) {
    const c = clientId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/* ─────────── 접근 토큰 ─────────── */

const 접근토큰 = new Map<string, { token: string; until: number }>();

/** OAuth 오류를 한국어 안내로 */
export function explainOAuth(reason: string, desc = ""): string {
  const map: Record<string, string> = {
    invalid_client: "클라이언트 ID 또는 보안 비밀번호가 올바르지 않습니다. 열쇠 파일을 다시 확인해 주세요.",
    invalid_grant: "인증이 만료되었거나 취소되었습니다. 다시 연결해 주세요. (동의 화면이 '테스트' 상태면 7일마다 풀립니다 — '프로덕션'으로 게시하세요)",
    redirect_uri_mismatch: "리디렉션 주소가 등록되지 않았습니다. 클라이언트 유형이 '데스크톱 앱'인지 확인해 주세요.",
    access_denied: "구글 로그인 창에서 권한을 거부하셨습니다.",
    unauthorized_client: "이 클라이언트는 해당 권한을 쓸 수 없습니다. 코드 인증으로 받은 토큰은 TV 클라이언트로만 갱신됩니다.",
    invalid_scope: "요청한 권한 범위를 구글이 받아 주지 않습니다. 이 채널을 다시 연결해 주세요.",
  };
  return map[reason] ?? `${reason || "인증 실패"}${desc ? ": " + desc : ""}`;
}

function consoleLinkFor(reason: string): string {
  if (reason === "invalid_client" || reason === "unauthorized_client") return "https://console.cloud.google.com/apis/credentials";
  if (reason === "invalid_grant") return "https://console.cloud.google.com/apis/credentials/consent";
  return "";
}

/**
 * 이 항목의 접근 토큰을 돌려준다. 만료됐으면 조용히 갱신한다.
 * 갱신할 때는 **그 토큰이 실제로 받은 범위**를 쓴다 — 앱이 요구하는 범위를 늘려도 옛 토큰은 옛 권한만
 * 갖고 있고, 더 넓은 범위를 달라고 하면 구글이 invalid_scope 로 거절한다.
 */
/* ─────────── 인증 상태 기록 — 화면이 유튜브를 부르지 않고도 「로그인이 풀렸다」를 알려 주려고 ─────────── */
// 접근 토큰을 받으려다 실패한 채널을 적어 두고(인증상태.json), 성공하면 지운다. 화면은 이 파일만 읽는다.
const 인증상태파일 = () => dataPath("인증상태.json");
/** 그 채널의 마지막 인증 실패(없으면 null). 파일만 읽는다 — 유튜브를 부르지 않는다. */
export function authErrorOf(channelId: string): { at: string; why: string } | null {
  if (!channelId) return null;
  const v = readJsonSync<Record<string, { at: string; why: string }>>(인증상태파일(), {})[channelId];
  return v && v.why ? v : null;
}
async function 인증상태적기(channelId: string, why: string | null) {
  if (!channelId) return;
  try {
    const cur = readJsonSync<Record<string, { at: string; why: string }>>(인증상태파일(), {});
    if (why === null && !(channelId in cur)) return; // 지울 것이 없으면 쓰지 않는다
    if (why !== null && cur[channelId]?.why === why) return; // 같은 말이면 다시 쓰지 않는다
    if (why === null) delete cur[channelId]; else cur[channelId] = { at: new Date().toISOString(), why };
    await writeJson(인증상태파일(), cur);
  } catch { /* 기록일 뿐이다 */ }
}

export async function accessToken(entry: TokenEntry): Promise<string> {
  const 열쇠 = entry.refresh_token.slice(-24);
  const 있음 = 접근토큰.get(열쇠);
  if (있음 && 있음.until > Date.now()) return 있음.token;
  const conf = await clientFor(entry);
  const body = new URLSearchParams({
    client_id: conf.client_id,
    client_secret: conf.client_secret,
    refresh_token: entry.refresh_token,
    grant_type: "refresh_token",
    scope: (entry.scopes && entry.scopes.length ? entry.scopes : SCOPES_LEGACY).join(" "),
  });
  const r = await doFetch(conf.token_uri || OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const e = await toGoogleError(r);
    const 말 = explainOAuth(e.reason, e.message);
    await 인증상태적기(entry.channel_id, 말);
    throw new AuthError(말, consoleLinkFor(e.reason));
  }
  const j = await r.json();
  if (!j.access_token) throw new AuthError("접근 토큰을 받지 못했습니다");
  접근토큰.set(열쇠, { token: j.access_token, until: Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000 });
  await 인증상태적기(entry.channel_id, null);
  return j.access_token as string;
}

/** 시험·로그아웃 때 메모리에 둔 접근 토큰을 비운다 */
export function forgetAccessTokens() { 접근토큰.clear(); }

/* ─────────── 유튜브 호출 도구 (파이썬 service_for 가 돌려주던 것) ─────────── */

export interface Yt {
  key: string;
  entry: TokenEntry;
  /** 구글 프로젝트 이름표 — 할당량을 프로젝트별로 센다 */
  project: string;
  get(path: string, query?: Query, o?: { base?: string; name?: string }): Promise<any>;
  post(path: string, query?: Query, body?: unknown, o?: { base?: string; name?: string }): Promise<any>;
  put(path: string, query?: Query, body?: unknown, o?: { base?: string; name?: string; raw?: boolean }): Promise<any>;
  del(path: string, query?: Query): Promise<any>;
  bearer(): Promise<Bearer>;
}

/** 채널 키(별칭 또는 채널ID)로 호출 도구를 만든다. 못 찾으면 LookupError. */
export async function ytFor(key: string): Promise<Yt> {
  const { key: k, entry } = entryFor(key);
  const conf = await clientFor(entry);
  const project = projectIdOf(conf.client_id);
  const bearer = async (): Promise<Bearer> => ({ token: await accessToken(entry), project });
  const yt: Yt = {
    key: k, entry, project, bearer,
    get: async (p, q, o) => call(await bearer(), "GET", p, { query: q, ...(o ?? {}) }),
    post: async (p, q, b, o) => call(await bearer(), "POST", p, { query: q, body: b, ...(o ?? {}) }),
    put: async (p, q, b, o) => {
      // 그물: 영상바꾸기를 안 거치고 videos.update 를 직접 부르는 코드도 지워지지 않게
      // 「읽고 합쳐 쓰기」로 돌린다. (파이썬 _보호된서비스)
      if (!o?.raw && /\/youtube\/v3\/videos\/?$/.test(p) && b && typeof b === "object" && (b as Obj).id) {
        const body = b as Obj;
        const r = await 영상바꾸기(yt, String(body.id), {
          status: (body.status as Obj) ?? null, snippet: (body.snippet as Obj) ?? null,
        });
        return r;
      }
      return call(await bearer(), "PUT", p, { query: q, body: b, base: o?.base, name: o?.name });
    },
    del: async (p, q) => call(await bearer(), "DELETE", p, { query: q }),
  };
  return yt;
}

/** 예전 토큰에 빠진 채널 id 를 한 번 메운다 (옛 앱 토큰 이행 뒤 첫 사용에서) */
export async function fillChannelId(key: string): Promise<string> {
  const s = loadStore();
  const e = s[key];
  if (!e) return "";
  if (e.channel_id) return e.channel_id;
  try {
    const yt = await ytFor(key);
    const r = await yt.get("/youtube/v3/channels", { part: "snippet", mine: true });
    const it = r.items?.[0];
    if (!it) return "";
    await updateStore((st) => {
      if (st[key]) { st[key].channel_id = it.id; st[key].title = st[key].title || it.snippet?.title || key; }
    });
    return it.id as string;
  } catch { return ""; }
}

/* ─────────── videos.update 는 읽고 합쳐서 쓴다 ─────────── */
// videos.update 는 보낸 부품(part)의 칸을 통째로 갈아 끼운다. 보내지 않은 칸은 지워진다.
// 실측: 공개 전환·비공개 내리기가 status 에 privacyStatus/publishAt 만 보내서 전 채널 영상의
// embeddable·publicStatsViewable 이 False 로, containsSyntheticMedia 가 빈칸으로 바뀌었다.
// 그래서 모든 videos.update 는 영상바꾸기() 한 곳을 지난다.
export const 상태_쓰는칸 = ["privacyStatus", "publishAt", "embeddable", "publicStatsViewable",
  "selfDeclaredMadeForKids", "containsSyntheticMedia", "license"];
export const 머리_쓰는칸 = ["title", "description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage"];

type Obj = Record<string, unknown>;

export function 지난때인가(t: string): boolean {
  const w = Date.parse(String(t).replace("Z", "+00:00").replace(/ /, "T"));
  return Number.isFinite(w) && w <= Date.now();
}

export function 상태합치기(지금: Obj | null | undefined, 바꿀: Obj | null | undefined): Obj {
  const 지 = { ...(지금 ?? {}) };
  const 바 = { ...(바꿀 ?? {}) };
  const 몸: Obj = {};
  for (const k of 상태_쓰는칸) if (k !== "publishAt" && 지[k] !== undefined && 지[k] !== null) 몸[k] = 지[k];
  for (const [k, v] of Object.entries(바)) {
    if (k === "publishAt") continue;
    if (v === null || v === undefined) delete 몸[k];
    else 몸[k] = v;
  }
  let 예약: unknown;
  if ("privacyStatus" in 바 || "publishAt" in 바) {
    예약 = 바["publishAt"];
    // 부르는 쪽이 직접 준 예약이 이미 지났으면 조용히 빼지 않고 실패로 알린다 — 빼면
    // 「비공개·예약 없음」이 성공으로 적혀 영영 안 열린다.
    if (예약 && 몸["privacyStatus"] === "private" && 지난때인가(String(예약))) {
      throw new Error(`예약 시각이 이미 지났습니다 — publishAt ${예약} (비공개·예약 없음으로 남지 않게 보내지 않습니다)`);
    }
  } else {
    예약 = 지["publishAt"];
  }
  if (예약 && 몸["privacyStatus"] === "private" && !지난때인가(String(예약))) 몸["publishAt"] = 예약;
  return 몸;
}

export function 머리합치기(지금: Obj | null | undefined, 바꿀: Obj | null | undefined): Obj {
  const 지 = { ...(지금 ?? {}) };
  const 몸: Obj = {};
  for (const k of 머리_쓰는칸) if (지[k] !== undefined && 지[k] !== null) 몸[k] = 지[k];
  for (const [k, v] of Object.entries(바꿀 ?? {})) {
    if (v === null || v === undefined) delete 몸[k];
    else 몸[k] = v;
  }
  return 몸;
}

function 원장합성값(videoId: string): boolean | null {
  try {
    for (const r of readLedger()) {
      if (r["영상ID"] === videoId && (r["AI합성"] === "True" || r["AI합성"] === "False")) return r["AI합성"] === "True";
    }
  } catch { /* 무시 */ }
  return null;
}

export function 본문만들기(videoId: string, 지금: Obj | null, status?: Obj | null, snippet?: Obj | null): { part: string; body: Obj } {
  const 지 = 지금 ?? {};
  const body: Obj = { id: videoId };
  const 부품: string[] = [];
  if (snippet) {
    body.snippet = 머리합치기(지.snippet as Obj, snippet);
    부품.push("snippet");
  }
  if (status) {
    let st = status;
    // videos.list 가 containsSyntheticMedia 를 돌려주지 않는다 — 지금 값을 못 읽으면 올릴 때 원장에
    // 적은 AI합성 값을 싣는다(안 실으면 그 표시가 지워진다).
    if (!("containsSyntheticMedia" in ((지.status as Obj) ?? {})) && !("containsSyntheticMedia" in st)) {
      const 합성 = 원장합성값(videoId);
      if (합성 !== null) st = { ...st, containsSyntheticMedia: 합성 };
    }
    body.status = 상태합치기(지.status as Obj, st);
    부품.push("status");
  }
  if (!부품.length) throw new Error("바꿀 부품(status·snippet)이 없습니다");
  return { part: 부품.join(","), body };
}

/** 퍼가기·통계 공개가 어디서 꺼지나 — 유닛 없이 남기는 기록 */
export async function 상태살피기(곳: string, videoId: string, 보낸: Obj | null, 받은: Obj | null) {
  try {
    const 칸 = ["embeddable", "publicStatsViewable"];
    const s = 보낸 ?? {}, r = 받은 ?? {};
    const 꺼짐 = 칸.filter((k) => r[k] === false);
    const 말 = `${곳}  ${videoId}  보냄 ` + 칸.map((k) => `${k}=${s[k]}`).join(" ") +
      "  → 받음 " + 칸.map((k) => `${k}=${r[k]}`).join(" ") + ` privacy=${r["privacyStatus"]}` +
      (꺼짐.length ? `  ✗ 꺼짐(${꺼짐.join(",")})` : "");
    await recordLine("상태확인.log", 말);
  } catch { /* 무슨 일이 있어도 안 멈춘다 */ }
}

/**
 * 모든 videos.update 가 지나는 길. 지금 값 읽기 → 바꿀 칸만 합치기 → 쓰기.
 * 지금: 이미 같은 영상을 videos.list 로 받아 둔 항목(해당 부품이 들어 있어야 한다). 없으면 한 번 읽는다(1유닛).
 */
export async function 영상바꾸기(
  yt: Yt, videoId: string,
  o: { status?: Obj | null; snippet?: Obj | null; 지금?: Obj | null },
): Promise<Obj> {
  const 필요 = [["snippet", o.snippet], ["status", o.status]].filter(([, v]) => v).map(([p]) => p as string);
  if (!필요.length) throw new Error("바꿀 부품(status·snippet)이 없습니다");
  let 지금 = o.지금 ?? null;
  if (!지금 || 필요.some((p) => !(p in 지금!))) {
    const r = await yt.get("/youtube/v3/videos", { part: 필요.join(","), id: videoId });
    const got = r.items ?? [];
    if (!got.length) throw new LookupError(`영상을 찾을 수 없습니다 — ${videoId} (지웠거나 다른 채널)`);
    지금 = got[0];
  }
  const { part, body } = 본문만들기(videoId, 지금, o.status ?? null, o.snippet ?? null);
  const 결과 = await yt.put("/youtube/v3/videos", { part }, body, { raw: true });
  if ("status" in body) await 상태살피기("바꿈", videoId, body.status as Obj, (결과 as Obj)?.status as Obj);
  return 결과;
}

export { GoogleError, WWW };

// 구글 OAuth 2.0 (설치형 앱 · 루프백 + PKCE) — 채널마다 따로 로그인한다
import {
  Channel, Config, Tokens, credsOf, findChannel, loadTokens, log, saveTokens,
} from "./paths.ts";
import { UploadError } from "./errors.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const SCOPE =
  "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 로그인을 시작한 채널별로 대기 상태를 들고 있는다 (여러 채널을 이어서 연결할 수 있게) */
const pending = new Map<string, { verifier: string; redirect: string; channelId: string }>();

export class ChannelError extends Error {
  constructor(message: string, public helpUrl = "") { super(message); }
}

export async function authUrl(cfg: Config, ch: Channel): Promise<string> {
  const { clientId } = credsOf(cfg, ch);
  if (!clientId) throw new Error("이 채널의 클라이언트 ID가 없습니다.");

  const bytes = crypto.getRandomValues(new Uint8Array(48));
  const verifier = b64url(bytes.buffer);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  // 구글은 루프백 리디렉션에 경로를 허용하지 않는다. 어느 채널인지는 state 에 실어 보낸다.
  const stateKey = crypto.randomUUID();
  const redirect = `http://127.0.0.1:${cfg.port}`;
  pending.set(stateKey, { verifier, redirect, channelId: ch.id });

  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: stateKey,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${q}`;
}

/** 콜백에서 받은 code 를 토큰으로 바꾼다. 어느 채널인지는 state 로 알아낸다. */
export async function exchange(
  cfg: Config,
  code: string,
  stateKey: string,
): Promise<{ channel: Channel; tokens: Tokens }> {
  const p = pending.get(stateKey);
  if (!p) throw new Error("인증 상태가 일치하지 않습니다. 프로그램에서 다시 연결해 주세요.");
  pending.delete(stateKey);

  const ch = findChannel(cfg, p.channelId);
  if (!ch) throw new Error("연결하려던 채널을 찾을 수 없습니다.");
  const { clientId, clientSecret } = credsOf(cfg, ch);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: p.verifier,
    grant_type: "authorization_code",
    redirect_uri: p.redirect,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(explain(j));
  if (!j.refresh_token) {
    throw new Error(
      "refresh_token 이 발급되지 않았습니다. 구글 계정 > 보안 > 서드파티 앱에서 기존 권한을 삭제한 뒤 다시 로그인해 주세요.",
    );
  }
  const tok: Tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000,
  };
  await saveTokens(ch.id, tok);
  await checkChannel(ch.id, tok);
  await log(`✅ [${ch.name}] 인증 완료${tok.channel ? ` · ${tok.channel.title}` : ` · ⚠️ ${tok.channelError}`}`);
  return { channel: ch, tokens: tok };
}

export async function accessToken(cfg: Config, ch: Channel): Promise<string> {
  const tok = await loadTokens(ch.id);
  if (!tok) throw new UploadError(`[${ch.name}] 아직 구글 계정이 연결되지 않았습니다. 채널 탭에서 연결해 주세요.`, "config");
  if (tok.access_token && (tok.expires_at ?? 0) > Date.now()) return tok.access_token;

  const { clientId, clientSecret } = credsOf(cfg, ch);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tok.refresh_token,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new UploadError(explain(j), "config", consoleLinkFor(j));
  tok.access_token = j.access_token;
  tok.expires_at = Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000;
  await saveTokens(ch.id, tok);
  return tok.access_token!;
}

/** 채널 정보를 받아 토큰 파일에 기록한다. 실패하면 원인과 해결 링크를 남긴다. */
export async function checkChannel(channelId: string, tok: Tokens): Promise<Tokens> {
  try {
    tok.channel = await fetchChannel(tok.access_token!);
    tok.channelError = "";
    tok.channelErrorUrl = "";
  } catch (e) {
    tok.channel = undefined;
    const m = e instanceof ChannelError ? e : new ChannelError(e instanceof Error ? e.message : String(e));
    tok.channelError = m.message;
    tok.channelErrorUrl = m.helpUrl;
  }
  await saveTokens(channelId, tok);
  return tok;
}

export async function fetchChannel(token: string) {
  const r = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
    { headers: { Authorization: "Bearer " + token } },
  );
  const j = await r.json();
  if (!r.ok) {
    const detail: string = j.error?.message ?? "";
    if (/has not been used in project|is disabled/i.test(detail)) {
      const proj = detail.match(/project (\d+)/)?.[1] ?? "";
      throw new ChannelError(
        "구글 클라우드에서 'YouTube Data API v3' 가 아직 켜져 있지 않습니다. " +
        "아래 버튼으로 열어 '사용' 을 누른 뒤 1~2분 기다렸다가 '연결 점검' 을 눌러주세요.",
        proj
          ? `https://console.cloud.google.com/apis/library/youtube.googleapis.com?project=${proj}`
          : "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
      );
    }
    throw new ChannelError(detail || `채널 정보를 가져오지 못했습니다 (${r.status})`);
  }
  const c = j.items?.[0];
  if (!c) {
    throw new ChannelError(
      "이 구글 계정에 유튜브 채널이 없습니다. 유튜브에서 채널을 먼저 만들어 주세요.",
      "https://www.youtube.com/create_channel",
    );
  }
  return {
    id: c.id ?? "",
    title: c.snippet?.title ?? "",
    thumb: c.snippet?.thumbnails?.medium?.url ?? c.snippet?.thumbnails?.default?.url ?? "",
    subs: c.statistics?.subscriberCount ?? "0",
    views: c.statistics?.viewCount ?? "0",
    videos: c.statistics?.videoCount ?? "0",
    handle: c.snippet?.customUrl ?? "",
  };
}

export async function revoke(channelId: string) {
  const tok = await loadTokens(channelId);
  if (!tok) return;
  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tok.refresh_token }),
    });
  } catch { /* 무시 */ }
}

/** 고칠 수 있는 오류라면 어디로 가야 하는지 알려준다. */
function consoleLinkFor(j: Record<string, string>): string {
  if (j.error === "invalid_client" || j.error === "unauthorized_client") {
    return "https://console.cloud.google.com/apis/credentials";
  }
  if (j.error === "invalid_grant") return "https://console.cloud.google.com/apis/credentials/consent";
  return "";
}

/** 구글 오류 응답을 한국어 안내로 바꾼다. */
function explain(j: Record<string, string>): string {
  const e = j.error ?? "";
  const d = j.error_description ?? "";
  const map: Record<string, string> = {
    invalid_client: "클라이언트 ID 또는 보안 비밀번호가 올바르지 않습니다. 채널 설정에서 다시 확인해 주세요.",
    invalid_grant: "인증이 만료되었거나 취소되었습니다. 다시 로그인해 주세요. (OAuth 동의 화면이 '테스트' 상태면 7일마다 만료됩니다 — '프로덕션'으로 게시하세요)",
    redirect_uri_mismatch: "리디렉션 주소가 등록되지 않았습니다. OAuth 클라이언트 유형이 '데스크톱 앱'인지 확인해 주세요.",
    access_denied: "구글 로그인 창에서 권한을 거부하셨습니다.",
    unauthorized_client: "이 클라이언트는 해당 권한을 쓸 수 없습니다. 클라이언트 유형이 '데스크톱 앱'인지 확인해 주세요.",
  };
  return map[e] ?? `${e || "인증 실패"}${d ? ": " + d : ""}`;
}

// 인스타그램·스레드 로그인 중계(Cloudflare Worker) 시험 — 가짜 KV·R2·메타 서버로 handle() 을 그대로 부른다.
// 실제 Cloudflare·메타에는 한 번도 닿지 않는다. 값(앱 번호·비밀·서명 키)은 모두 이 파일 안의 가짜다.
import { 같나, 구역, 참인가 } from "./도구.ts";
import {
  b64u, cleanStage, type Deps, type Env, handle, type KV, type R2Bucket, readSignedRequest, sigV4Presign, STAGE_MAX_BYTES, 번호뽑기,
} from "../worker/meta-auth/src/index.ts";

type Obj = Record<string, any>;
const 분 = 60_000;
const BASE = "https://relay.example.test";
const 비밀 = { IG_APP_SECRET: "ig-secret-for-test", TH_APP_SECRET: "th-secret-for-test", SIGN_KEY: "sign-key-for-test-only", R2_SECRET_ACCESS_KEY: "r2-secret-for-test" };

const enc = new TextEncoder();
const sha = async (t: string) => b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(t))));
const hmacB64u = async (key: string, msg: string) => {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg))));
};

/* ───────────── 가짜 저장소 ───────────── */

class 가짜KV implements KV {
  m = new Map<string, { v: string; exp: number | null }>();
  puts: { key: string; ttl?: number }[] = [];
  boom = false;
  constructor(private now: () => number) {}
  async get(k: string) {
    if (this.boom) throw new Error("KV 가 고장났다");
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp !== null && e.exp <= this.now()) { this.m.delete(k); return null; }
    return e.v;
  }
  async put(k: string, v: string, o?: { expirationTtl?: number }) {
    this.puts.push({ key: k, ttl: o?.expirationTtl });
    this.m.set(k, { v, exp: o?.expirationTtl ? this.now() + o.expirationTtl * 1000 : null });
  }
  async delete(k: string) { this.m.delete(k); }
}

class 가짜R2 implements R2Bucket {
  m = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  put(key: string, bytes: Uint8Array, uploaded: Date) { this.m.set(key, { bytes, uploaded }); }
  async get(key: string, opts?: { range?: { offset: number; length?: number } }) {
    const o = this.m.get(key);
    if (!o) return null;
    const r = opts?.range;
    const part = r ? o.bytes.slice(r.offset, r.length != null ? r.offset + r.length : undefined) : o.bytes;
    return { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(part); c.close(); } }), size: o.bytes.length, uploaded: o.uploaded };
  }
  async head(key: string) { const o = this.m.get(key); return o ? { size: o.bytes.length, uploaded: o.uploaded } : null; }
  async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) this.m.delete(k); }
  async list(o?: { prefix?: string; cursor?: string; limit?: number }) {
    // 이어 읽기 표시는 마지막으로 준 열쇠 — 중간에 지워도 건너뛰지 않는다(진짜 R2 와 같다)
    const all = [...this.m.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "") && (!o?.cursor || k > o.cursor)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const lim = o?.limit ?? 1000;
    const page = all.slice(0, lim);
    const truncated = all.length > lim;
    return { objects: page.map(([key, v]) => ({ key, uploaded: v.uploaded })), truncated, cursor: truncated ? page[page.length - 1][0] : undefined };
  }
}

/* ───────────── 가짜 메타 ───────────── */

interface MetaCall { url: string; method: string; form: Record<string, string>; query: Record<string, string>; host: string; path: string }

function 가짜메타서버(o: { fail?: boolean } = {}) {
  const calls: MetaCall[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const form = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
    const query = Object.fromEntries(url.searchParams);
    calls.push({ url: url.toString(), method, form, query, host: url.host, path: url.pathname });
    const txt = (body: string, status = 200) => new Response(body, { status });
    if (o.fail && url.pathname.includes("access_token") && method === "POST") return txt('{"error_message":"This authorization code has expired"}', 400);
    const ig = url.host.includes("instagram"), th = url.host.includes("threads");
    // 코드 → 짧은 토큰 (사용자 번호는 일부러 17자리 숫자 — 자바스크립트 숫자로 읽으면 틀어진다)
    if (method === "POST" && url.pathname === "/oauth/access_token") {
      if (form.code !== "THECODE") return txt('{"error_message":"Invalid code"}', 400);
      return ig ? txt('{"data":[{"access_token":"SHORT-IG","user_id":17841400000000001,"permissions":"instagram_business_basic"}]}')
        : txt('{"access_token":"SHORT-TH","user_id":26310000000000002}');
    }
    if (method === "GET" && url.pathname === "/access_token") {
      const want = ig ? "SHORT-IG" : "SHORT-TH";
      if (query.access_token !== want) return txt('{"error":{"message":"bad short token","code":190}}', 400);
      return txt(`{"access_token":"${ig ? "LONG-IG" : "LONG-TH"}","token_type":"bearer","expires_in":5184000}`);
    }
    if (method === "GET" && /\/me$/.test(url.pathname)) {
      const want = ig ? "LONG-IG" : "LONG-TH";
      if (query.access_token !== want) return txt('{"error":{"message":"Invalid OAuth access token","code":190}}', 400);
      if (ig) return txt('{"user_id":17841400000000001,"username":"릴스계정","account_type":"BUSINESS"}');
      return txt('{"id":"26310000000000002","username":"스레드계정"}');
    }
    return txt("{}", 404);
  }) as typeof fetch;
  return { fetch: f, calls };
}

/* ───────────── 환경 만들기 ───────────── */

function 세상(o: { fail?: boolean; secrets?: boolean } = {}) {
  const 시계 = { t: Date.UTC(2026, 9, 19, 5, 0, 0) };
  const now = () => 시계.t;
  const kv = new 가짜KV(now), r2 = new 가짜R2();
  let 번호 = 0;
  const meta = 가짜메타서버({ fail: o.fail });
  const deps: Deps = {
    fetch: meta.fetch, now,
    random: (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = ++번호 & 255; return b; },
  };
  const env: Env = {
    META_KV: kv, STAGE: r2,
    IG_APP_ID: "ig-app-id", IG_APP_SECRET: o.secrets === false ? "" : 비밀.IG_APP_SECRET,
    TH_APP_ID: "th-app-id", TH_APP_SECRET: o.secrets === false ? "" : 비밀.TH_APP_SECRET,
    SIGN_KEY: 비밀.SIGN_KEY, R2_ACCOUNT_ID: "acct123", R2_BUCKET: "stage-bucket", R2_ACCESS_KEY_ID: "r2-access-id", R2_SECRET_ACCESS_KEY: 비밀.R2_SECRET_ACCESS_KEY,
    PUBLIC_URL: BASE,
  };
  const call = (method: string, path: string, init: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) =>
    handle(new Request(`${BASE}${path}`, {
      method, headers: { ...(init.json ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      body: init.json ? JSON.stringify(init.json) : init.form ? new URLSearchParams(init.form) : undefined,
    }), env, deps);
  return { env, deps, kv, r2, meta, 시계, call };
}

const VERIFIER = "verifier-" + "v".repeat(50); // 43~128 자
const 시작값 = async (port = 51234) => ({ port, verifier: VERIFIER, challenge: await sha(VERIFIER), nonce: "nonce-" + "n".repeat(20) });
const 시작주소 = (kind: "ig" | "th", s: { port: number; challenge: string; nonce: string }) =>
  `/${kind}/start?${new URLSearchParams({ port: String(s.port), challenge: s.challenge, nonce: s.nonce })}`;

export async function 실행() {
  구역("중계 — 기본 길 · 시작(start)");
  {
    const w = 세상();
    const root = await w.call("GET", "/");
    같나("첫 쪽", [root.status, (await root.text()).includes("로그인 중계")], [200, true]);
    같나("모르는 주소·방법은 404", [(await w.call("GET", "/nope")).status, (await w.call("GET", "/pickup")).status, (await w.call("POST", "/ig/start")).status], [404, 404, 404]);

    const s = await 시작값();
    const r = await w.call("GET", 시작주소("ig", s));
    const loc = new URL(r.headers.get("location")!);
    같나("인스타그램 시작: 메타 로그인 창으로 302", [r.status, loc.origin + loc.pathname], [302, "https://www.instagram.com/oauth/authorize"]);
    같나("로그인 창 인자", [loc.searchParams.get("client_id"), loc.searchParams.get("redirect_uri"), loc.searchParams.get("response_type"), loc.searchParams.get("scope"), loc.searchParams.get("force_authentication")],
      ["ig-app-id", `${BASE}/ig/callback`, "code", "instagram_business_basic,instagram_business_content_publish", "1"]);
    const state = loc.searchParams.get("state")!;
    const body = JSON.parse(atob(state.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
    같나("state 안에는 포트·확인값·일련번호·만료만 있다(비밀 없음)", [Object.keys(body).sort().join(), body.p, body.c, body.n], ["c,e,k,n,p", s.port, s.challenge, s.nonce]);
    참인가("주소 어디에도 앱 비밀·서명 키가 없다", !r.headers.get("location")!.includes(비밀.IG_APP_SECRET) && !r.headers.get("location")!.includes(비밀.SIGN_KEY));

    const t = await w.call("GET", 시작주소("th", s));
    const tl = new URL(t.headers.get("location")!);
    같나("스레드 시작", [tl.origin + tl.pathname, tl.searchParams.get("client_id"), tl.searchParams.get("scope"), tl.searchParams.get("force_authentication")], ["https://threads.com/oauth/authorize", "th-app-id", "threads_basic,threads_content_publish", null]);

    for (const [무엇, q] of [
      ["포트가 1024 미만", { ...s, port: 80 }], ["포트가 65535 초과", { ...s, port: 70000 }], ["포트가 숫자가 아님", { ...s, port: "abc" as unknown as number }],
      ["확인값 모양이 틀림", { ...s, challenge: "짧음" }], ["일련번호가 너무 짧음", { ...s, nonce: "abc" }],
    ] as [string, Obj][]) {
      const x = await w.call("GET", 시작주소("ig", q as never));
      같나(`거절: ${무엇}`, [x.status, x.headers.get("location")], [400, null]);
    }
    const 비밀없음 = 세상({ secrets: false });
    같나("앱 정보가 없는 중계는 준비 안 됨(503)", (await 비밀없음.call("GET", 시작주소("ig", s))).status, 503);
  }

  구역("중계 — 콜백(callback): 코드 → 토큰 · 주소에 토큰을 싣지 않는다 · KV 5분");
  {
    const w = 세상();
    const s = await 시작값();
    const st = new URL((await w.call("GET", 시작주소("ig", s))).headers.get("location")!).searchParams.get("state")!;
    const r = await w.call("GET", `/ig/callback?${new URLSearchParams({ code: "THECODE#_", state: st })}`);
    const back = r.headers.get("location")!;
    같나("앱으로 돌아가는 302 (이 컴퓨터의 높은 포트 · 일련번호 · 성공)", [r.status, back], [302, `http://127.0.0.1:${s.port}/meta/done?n=${s.nonce}&ok=1`]);
    참인가("돌아가는 주소에 토큰·사용자 정보가 없다", !/LONG|SHORT|token|1784|릴스/.test(decodeURIComponent(back)));
    const [c1, c2, c3] = w.meta.calls;
    같나("메타 호출 ①: 코드 교환 — 끝의 「#_」는 뗀다 · 앱 비밀·같은 돌아올 주소", [c1.host, c1.method, c1.form.code, c1.form.client_secret, c1.form.redirect_uri, c1.form.client_id], ["api.instagram.com", "POST", "THECODE", 비밀.IG_APP_SECRET, `${BASE}/ig/callback`, "ig-app-id"]);
    같나("메타 호출 ②: 장기 토큰으로 교환", [c2.host, c2.query.grant_type, c2.query.access_token, c2.query.client_secret], ["graph.instagram.com", "ig_exchange_token", "SHORT-IG", 비밀.IG_APP_SECRET]);
    같나("메타 호출 ③: 내 계정 확인", [c3.path, c3.query.fields, c3.query.access_token], ["/v26.0/me", "user_id,username,account_type", "LONG-IG"]);
    같나("호출은 세 번뿐", w.meta.calls.length, 3);
    const 보관 = w.kv.m.get(`pu:${s.challenge}`);
    같나("KV 에는 확인값(해시)을 열쇠로 5분만 둔다", [w.kv.puts.map((p) => [p.key, p.ttl])], [[[`pu:${s.challenge}`, 300]]]);
    const 담김 = JSON.parse(보관!.v);
    같나("보관한 내용: 17자리 번호가 틀어지지 않는다", [담김.provider, 담김.user_id, 담김.username, 담김.account_type, 담김.expires_in, 담김.access_token], ["instagram", "17841400000000001", "릴스계정", "BUSINESS", 5184000, "LONG-IG"]);

    // 가져가기
    const bad = await w.call("POST", "/pickup", { json: { verifier: "x".repeat(60) } });
    같나("다른 verifier 로는 못 가져간다", [bad.status, (await bad.json()).ok], [404, false]);
    같나("verifier 모양이 맞지 않으면 400", (await w.call("POST", "/pickup", { json: { verifier: "짧음" } })).status, 400);
    같나("본문이 json 이 아니면 400", (await w.call("POST", "/pickup", { headers: { "content-type": "text/plain" } })).status, 400);
    const ok = await w.call("POST", "/pickup", { json: { verifier: s.verifier } });
    const got = await ok.json();
    같나("올바른 verifier 로는 가져간다", [ok.status, got.ok, got.provider, got.access_token, got.user_id, got.username], [200, true, "instagram", "LONG-IG", "17841400000000001", "릴스계정"]);
    같나("가져가면 바로 지워진다 — 두 번째는 없다", [w.kv.m.has(`pu:${s.challenge}`), (await w.call("POST", "/pickup", { json: { verifier: s.verifier } })).status], [false, 404]);
    참인가("응답은 캐시하지 않는다", ok.headers.get("cache-control") === "no-store");
  }
  {
    const w = 세상();
    const s = await 시작값();
    const st = new URL((await w.call("GET", 시작주소("th", s))).headers.get("location")!).searchParams.get("state")!;
    const r = await w.call("GET", `/th/callback?${new URLSearchParams({ code: "THECODE", state: st })}`);
    같나("스레드 콜백", [r.status, r.headers.get("location")], [302, `http://127.0.0.1:${s.port}/meta/done?n=${s.nonce}&ok=1`]);
    같나("스레드 교환 호출", [w.meta.calls[0].host, w.meta.calls[0].form.client_secret, w.meta.calls[1].query.grant_type, w.meta.calls[2].path], ["graph.threads.com", 비밀.TH_APP_SECRET, "th_exchange_token", "/v1.0/me"]);
    const got = await (await w.call("POST", "/pickup", { json: { verifier: s.verifier } })).json();
    같나("스레드 가져가기", [got.provider, got.user_id, got.username, got.access_token], ["threads", "26310000000000002", "스레드계정", "LONG-TH"]);
  }
  {
    const w = 세상();
    const s = await 시작값();
    const st = new URL((await w.call("GET", 시작주소("ig", s))).headers.get("location")!).searchParams.get("state")!;
    const 돌아옴 = async (path: string) => { const r = await w.call("GET", path); return [r.status, r.headers.get("location")]; };
    같나("메타가 거절을 알려 오면 앱으로 알린다", await 돌아옴(`/ig/callback?${new URLSearchParams({ error: "access_denied", error_description: "The user denied", state: st })}`),
      [302, `http://127.0.0.1:${s.port}/meta/done?n=${s.nonce}&ok=0&error=access_denied&why=The+user+denied`]);
    같나("코드가 없으면", await 돌아옴(`/ig/callback?${new URLSearchParams({ state: st })}`), [302, `http://127.0.0.1:${s.port}/meta/done?n=${s.nonce}&ok=0&error=no_code`]);
    const x = await w.call("GET", `/ig/callback?${new URLSearchParams({ code: "틀린코드", state: st })}`);
    const xl = new URL(x.headers.get("location")!);
    같나("코드 교환이 실패하면 앱으로 알리고 KV 에는 아무것도 두지 않는다", [x.status, xl.searchParams.get("ok"), xl.searchParams.get("error"), w.kv.puts.length], [302, "0", "exchange_failed", 0]);
    같나("스레드 쪽 state 로 인스타 콜백을 부르면(종류가 다름) 거절", (await w.call("GET", `/th/callback?${new URLSearchParams({ code: "THECODE", state: st })}`)).status, 400);
    같나("고친 state", (await w.call("GET", `/ig/callback?${new URLSearchParams({ code: "THECODE", state: st.slice(0, -2) + "xx" })}`)).status, 400);
    같나("state 가 없으면", (await w.call("GET", "/ig/callback?code=THECODE")).status, 400);
    같나("거절된 요청은 메타를 부르지 않았다(첫 시도 이후 호출 수)", w.meta.calls.length, 1);
    w.시계.t += 11 * 분;
    같나("10분이 지난 state 는 거절", (await w.call("GET", `/ig/callback?${new URLSearchParams({ code: "THECODE", state: st })}`)).status, 400);

    // 5분이 지나면 KV 에서 사라진다
    const w2 = 세상();
    const s2 = await 시작값();
    const st2 = new URL((await w2.call("GET", 시작주소("ig", s2))).headers.get("location")!).searchParams.get("state")!;
    await w2.call("GET", `/ig/callback?${new URLSearchParams({ code: "THECODE", state: st2 })}`);
    w2.시계.t += 301_000;
    같나("가져가지 않은 토큰은 5분 뒤 스스로 사라진다", (await w2.call("POST", "/pickup", { json: { verifier: s2.verifier } })).status, 404);

    const w3 = 세상({ fail: true });
    const s3 = await 시작값();
    const st3 = new URL((await w3.call("GET", 시작주소("ig", s3))).headers.get("location")!).searchParams.get("state")!;
    const r3 = await w3.call("GET", `/ig/callback?${new URLSearchParams({ code: "THECODE", state: st3 })}`);
    같나("메타가 코드 교환을 거절하면 사람 말로 알린다", [new URL(r3.headers.get("location")!).searchParams.get("error"), new URL(r3.headers.get("location")!).searchParams.get("why")!.includes("코드 교환 실패 400")], ["exchange_failed", true]);
  }

  구역("중계 — 임시 보관 티켓(stage/ticket) · 읽기 주소(/s) · 삭제 · 크론 정리");
  {
    const w = 세상();
    const 표 = (o: Obj) => w.call("POST", "/stage/ticket", { json: { provider: "ig", token: "LONG-IG", size: 1234, ext: "mp4", ...o } });
    const t = await 표({});
    const j = await t.json();
    같나("티켓 발급", [t.status, j.ok, /^[0-9a-f]{32}$/.test(j.id), j.name === `${j.id}.mp4`, j.put_expires_in], [200, true, true, true, 600]);
    const put = new URL(j.put_url);
    같나("업로드 주소: R2(S3 서명) · 이 버킷의 stage/ 안 · 10분", [put.host, put.pathname, put.searchParams.get("X-Amz-Expires"), put.searchParams.get("X-Amz-SignedHeaders"), /^[0-9a-f]{64}$/.test(put.searchParams.get("X-Amz-Signature")!)],
      ["acct123.r2.cloudflarestorage.com", `/stage-bucket/stage/${j.id}.mp4`, "600", "host", true]);
    같나("서명 날짜는 중계의 시계", put.searchParams.get("X-Amz-Date"), "20261019T050000Z");
    const get = new URL(j.get_url);
    같나("읽기 주소: 이 중계의 /s/ · 1시간", [get.origin + get.pathname, Number(get.searchParams.get("e")) - w.시계.t, j.get_expires_at], [`${BASE}/s/${j.name}`, 3600_000, new Date(w.시계.t + 3600_000).toISOString()]);
    참인가("응답 어디에도 R2 비밀·서명 키·토큰이 없다", !JSON.stringify(j).includes(비밀.R2_SECRET_ACCESS_KEY) && !JSON.stringify(j).includes(비밀.SIGN_KEY) && !JSON.stringify(j).includes("LONG-IG"));
    같나("확인한 계정: 인스타그램 그래프의 내 번호 조회", w.meta.calls.map((c) => [c.host, c.path, c.query.fields]), [["graph.instagram.com", "/v26.0/me", "user_id"]]);
    같나("스레드 토큰도 받는다", [(await 표({ provider: "th", token: "LONG-TH" })).status, w.meta.calls.at(-1)!.host], [200, "graph.threads.com"]);
    같나("mov 도 받는다", (await (await 표({ ext: "mov" })).json()).name.endsWith(".mov"), true);
    for (const [무엇, o, 상태] of [
      ["토큰이 틀리면 401", { token: "남의토큰" }, 401], ["토큰이 없으면 400", { token: "" }, 400], ["종류가 틀리면 400", { provider: "fb" }, 400],
      ["확장자가 mp4·mov 가 아니면 400", { ext: "avi" }, 400], ["크기 0", { size: 0 }, 400], ["300MB 초과", { size: STAGE_MAX_BYTES + 1 }, 400], ["소수 크기", { size: 1.5 }, 400],
    ] as [string, Obj, number][]) 같나(`거절: ${무엇}`, (await 표(o)).status, 상태);
    같나("본문이 깨졌으면 400", (await w.call("POST", "/stage/ticket", { headers: { "content-type": "text/plain" } })).status, 400);
    같나("300MB 딱 맞으면 된다", (await 표({ size: STAGE_MAX_BYTES })).status, 200);

    // 하루 한도 — 같은 계정 하루 40번
    const w2 = 세상();
    let 마지막 = 0;
    for (let i = 0; i < 41; i++) 마지막 = (await w2.call("POST", "/stage/ticket", { json: { provider: "ig", token: "LONG-IG", size: 10, ext: "mp4" } })).status;
    같나("같은 계정이 하루 40번을 넘으면 429", 마지막, 429);
    w2.시계.t += 25 * 3600_000;
    같나("다음 날에는 다시 된다", (await w2.call("POST", "/stage/ticket", { json: { provider: "ig", token: "LONG-IG", size: 10, ext: "mp4" } })).status, 200);

    // 읽기 주소
    const w3 = 세상();
    const 발급 = await (await w3.call("POST", "/stage/ticket", { json: { provider: "ig", token: "LONG-IG", size: 100, ext: "mp4" } })).json();
    const 몸통 = new Uint8Array(100).map((_, i) => i);
    w3.r2.put(`stage/${발급.name}`, 몸통, new Date(w3.시계.t));
    const 읽기 = new URL(발급.get_url);
    const 경로 = `${읽기.pathname}${읽기.search}`;
    const 전체 = await w3.call("GET", 경로);
    같나("읽기: 200 · 영상 형식 · 이어받기 가능", [전체.status, 전체.headers.get("content-type"), 전체.headers.get("accept-ranges"), 전체.headers.get("content-length"), (await 전체.arrayBuffer()).byteLength], [200, "video/mp4", "bytes", "100", 100]);
    const 부분 = await w3.call("GET", 경로, { headers: { range: "bytes=10-19" } });
    같나("범위 요청 10-19", [부분.status, 부분.headers.get("content-range"), 부분.headers.get("content-length"), [...new Uint8Array(await 부분.arrayBuffer())]], [206, "bytes 10-19/100", "10", [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]]);
    const 뒤 = await w3.call("GET", 경로, { headers: { range: "bytes=90-" } });
    같나("범위 요청 90-끝", [뒤.status, 뒤.headers.get("content-range"), (await 뒤.arrayBuffer()).byteLength], [206, "bytes 90-99/100", 10]);
    const 끝 = await w3.call("GET", 경로, { headers: { range: "bytes=-5" } });
    같나("범위 요청 끝에서 5", [끝.status, 끝.headers.get("content-range"), [...new Uint8Array(await 끝.arrayBuffer())]], [206, "bytes 95-99/100", [95, 96, 97, 98, 99]]);
    같나("범위가 파일 밖이면 416", (await w3.call("GET", 경로, { headers: { range: "bytes=500-600" } })).status, 416);
    const 머리 = await w3.call("HEAD", 경로);
    같나("HEAD", [머리.status, 머리.headers.get("content-length"), (await 머리.arrayBuffer()).byteLength], [200, "100", 0]);
    같나("서명이 틀리면 403", (await w3.call("GET", 경로.replace(/s=[^&]+/, "s=AAAA"))).status, 403);
    같나("만료 시각을 고치면 403", (await w3.call("GET", 경로.replace(/e=\d+/, `e=${Number(읽기.searchParams.get("e")) + 1}`))).status, 403);
    같나("이름 모양이 틀리면 404", (await w3.call("GET", "/s/../../etc?e=1&s=x")).status, 404);
    같나("없는 영상은 404", (await w3.call("GET", `/s/${"0".repeat(32)}.mp4?e=${Number(읽기.searchParams.get("e"))}&s=${await hmacB64u(비밀.SIGN_KEY, `get:${"0".repeat(32)}.mp4:${읽기.searchParams.get("e")}`)}`)).status, 404);
    w3.시계.t += 3600_000 + 1;
    같나("1시간이 지나면 410(주소 만료)", (await w3.call("GET", 경로)).status, 410);

    // 크론이 늦었을 때도 1시간 넘은 임시본은 내주지 않는다
    const w4 = 세상();
    const 발급4 = await (await w4.call("POST", "/stage/ticket", { json: { provider: "ig", token: "LONG-IG", size: 100, ext: "mp4" } })).json();
    w4.r2.put(`stage/${발급4.name}`, new Uint8Array(100), new Date(w4.시계.t - 2 * 3600_000));
    const u4 = new URL(발급4.get_url);
    같나("임시본이 1시간 넘었으면 서명이 맞아도 410", (await w4.call("GET", `${u4.pathname}${u4.search}`)).status, 410);

    // 삭제
    const w5 = 세상();
    const 발급5 = await (await w5.call("POST", "/stage/ticket", { json: { provider: "ig", token: "LONG-IG", size: 100, ext: "mov" } })).json();
    w5.r2.put(`stage/${발급5.name}`, new Uint8Array(5), new Date(w5.시계.t));
    같나("서명이 틀린 삭제는 403 · 그대로 남는다", [(await w5.call("POST", "/stage/delete", { json: { id: 발급5.id, sig: "틀림" } })).status, w5.r2.m.size], [403, 1]);
    같나("번호 모양이 틀린 삭제는 400", (await w5.call("POST", "/stage/delete", { json: { id: "abc", sig: 발급5.delete_sig } })).status, 400);
    같나("올바른 삭제", [(await w5.call("POST", "/stage/delete", { json: { id: 발급5.id, sig: 발급5.delete_sig } })).status, w5.r2.m.size], [200, 0]);
    같나("없는 것을 또 지워도 오류가 아니다", (await w5.call("POST", "/stage/delete", { json: { id: 발급5.id, sig: 발급5.delete_sig } })).status, 200);

    // 크론 정리 — 1시간 지난 것만, 여러 쪽에 걸쳐도 끝까지
    const w6 = 세상();
    for (let i = 0; i < 1100; i++) w6.r2.put(`stage/${String(i).padStart(32, "0")}.mp4`, new Uint8Array(1), new Date(w6.시계.t - (i % 2 ? 2 : 0.5) * 3600_000));
    w6.r2.put("other/keep.txt", new Uint8Array(1), new Date(w6.시계.t - 9 * 3600_000));
    const 지움 = await cleanStage(w6.env, w6.deps);
    같나("크론: 1시간 지난 550개만 지운다(1100개 · 두 쪽)", [지움, w6.r2.m.size, w6.r2.m.has("other/keep.txt")], [550, 551, true]);
  }

  구역("중계 — 메타의 연결 해제·데이터 삭제 알림 (signed_request)");
  {
    const w = 세상();
    const 서명 = async (secret: string, body: Obj) => { const p = b64u(enc.encode(JSON.stringify(body))); return `${await hmacB64u(secret, p)}.${p}`; };
    const sr = await 서명(비밀.IG_APP_SECRET, { user_id: "17841400000000001", algorithm: "HMAC-SHA256" });
    같나("서명을 확인하고 내용을 읽는다", (await readSignedRequest(비밀.IG_APP_SECRET, sr))?.user_id, "17841400000000001");
    같나("다른 비밀로는 읽지 못한다", await readSignedRequest("엉뚱한비밀", sr), null);
    같나("내용을 고치면 읽지 못한다", await readSignedRequest(비밀.IG_APP_SECRET, sr.split(".")[0] + "." + b64u(enc.encode('{"user_id":"1"}'))), null);
    같나("비밀이 비어 있으면 읽지 못한다", await readSignedRequest("", sr), null);
    같나("모양이 틀리면 null", await readSignedRequest(비밀.IG_APP_SECRET, "점없음"), null);

    const d = await w.call("POST", "/ig/deauthorize", { form: { signed_request: sr } });
    같나("연결 해제 알림 확인", [d.status, await d.json()], [200, { ok: true }]);
    같나("연결 해제는 저장하는 것이 없다", w.kv.puts.length, 0);
    const x = await w.call("POST", "/ig/delete", { form: { signed_request: sr } });
    const xj = await x.json();
    같나("데이터 삭제 알림: 확인 번호와 상태 주소를 돌려준다", [x.status, /^[0-9a-f]{16}$/.test(xj.confirmation_code), xj.url === `${BASE}/deletion?code=${xj.confirmation_code}`], [200, true, true]);
    같나("확인 번호는 90일 보관", w.kv.puts.map((p) => [p.key.startsWith("del:"), p.ttl]), [[true, 90 * 24 * 3600]]);
    const 쪽 = await w.call("GET", `/deletion?code=${xj.confirmation_code}`);
    const 글 = await 쪽.text();
    같나("상태 쪽: 확인 번호와 저장하지 않는다는 설명", [쪽.status, 글.includes(xj.confirmation_code), 글.includes("저장하지 않습니다")], [200, true, true]);
    같나("없는 번호", [(await w.call("GET", "/deletion?code=0123456789abcdef")).status, (await w.call("GET", "/deletion?code=짧음")).status], [404, 404]);
    같나("서명이 틀린 알림은 400", [(await w.call("POST", "/ig/delete", { form: { signed_request: "a.b" } })).status, (await w.call("POST", "/ig/deauthorize", { form: {} })).status], [400, 400]);
    같나("인스타그램 비밀로 서명한 알림을 스레드 길에 보내면 400", (await w.call("POST", "/th/delete", { form: { signed_request: sr } })).status, 400);
    const sth = await 서명(비밀.TH_APP_SECRET, { user_id: "26310000000000002" });
    같나("스레드 비밀로 서명한 알림은 스레드 길에서 된다", (await w.call("POST", "/th/delete", { form: { signed_request: sth } })).status, 200);
  }

  구역("중계 — 서명 계산 · 번호 읽기 · 고장났을 때");
  {
    // AWS 문서의 쿼리 서명 예제 (GET · examplebucket · 20130524) — 같은 값이 나와야 한다
    const u = await sigV4Presign({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1", service: "s3",
      accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", expires: 86400, at: new Date("2013-05-24T00:00:00Z"),
    });
    같나("SigV4 쿼리 서명이 AWS 문서 예제와 같다", new URL(u).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");

    같나("번호는 글에서 그대로 뽑는다(숫자·글자 모두)", [번호뽑기('{"user_id":17841400000000001}', "user_id"), 번호뽑기('{"id":"26310000000000002"}', "id"), 번호뽑기("{}", "id")], ["17841400000000001", "26310000000000002", ""]);
    같나("자바스크립트 숫자로 읽으면 틀어지는 번호", String(JSON.parse('{"a":17841400000000001}').a) !== "17841400000000001", true);

    const w = 세상();
    w.kv.boom = true;
    const r = await w.call("POST", "/pickup", { json: { verifier: VERIFIER } });
    const j = await r.json();
    같나("저장소가 고장나도 500 과 한 줄 까닭(내부 정보 없음)", [r.status, j.ok, typeof j.why, String(j.why).includes("\n")], [500, false, "string", false]);
  }
}

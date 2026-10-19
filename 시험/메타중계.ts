// 인스타그램·스레드 로그인 중계(Cloudflare Worker) 시험 — 가짜 KV·R2·메타 서버로 handle() 을 그대로 부른다.
// 실제 Cloudflare·메타에는 한 번도 닿지 않는다. 값(앱 번호·비밀·서명 키)은 모두 이 파일 안의 가짜다.
import { 같나, 구역, 참인가 } from "./도구.ts";
import {
  b64u, cleanStage, type Deps, type Env, handle, type KV, type LedgerNamespace, type R2Bucket, readSignedRequest, sigV4Presign, STAGE_MAX_BYTES, 번호뽑기,
} from "../worker/meta-auth/src/index.ts";
import {
  cycleBounds, type LedgerEnv, type LedgerState, R2_FREE, R2Ledger, readLedgerConfig, 티켓A예약, 티켓B여유,
} from "../worker/meta-auth/src/ledger.ts";

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
  /** 중계가 R2 에 한 호출 수 (요금 분류: head·get = Class B · list = Class A · delete = 무료). 시험 쪽 put() 은 앱이 올리는 것이라 따로 센다. */
  ops = { get: 0, head: 0, list: 0, delete: 0 };
  /** 앱이 받은 주소로 올린 횟수 (= Class A) — 시험이 put() 으로 흉내 낼 때마다 하나 오른다 */
  puts = 0;
  put(key: string, bytes: Uint8Array, uploaded: Date) { this.puts++; this.m.set(key, { bytes, uploaded }); }
  async get(key: string, opts?: { range?: { offset: number; length?: number } }) {
    this.ops.get++;
    const o = this.m.get(key);
    if (!o) return null;
    const r = opts?.range;
    const part = r ? o.bytes.slice(r.offset, r.length != null ? r.offset + r.length : undefined) : o.bytes;
    return { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(part); c.close(); } }), size: o.bytes.length, uploaded: o.uploaded };
  }
  async head(key: string) { this.ops.head++; const o = this.m.get(key); return o ? { size: o.bytes.length, uploaded: o.uploaded } : null; }
  async delete(keys: string | string[]) { this.ops.delete++; for (const k of Array.isArray(keys) ? keys : [keys]) this.m.delete(k); }
  async list(o?: { prefix?: string; cursor?: string; limit?: number }) {
    this.ops.list++;
    // 이어 읽기 표시는 마지막으로 준 열쇠 — 중간에 지워도 건너뛰지 않는다(진짜 R2 와 같다)
    const all = [...this.m.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "") && (!o?.cursor || k > o.cursor)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const lim = o?.limit ?? 1000;
    const page = all.slice(0, lim);
    const truncated = all.length > lim;
    return { objects: page.map(([key, v]) => ({ key, uploaded: v.uploaded, size: v.bytes.length })), truncated, cursor: truncated ? page[page.length - 1][0] : undefined };
  }
}

/**
 * 가짜 장부 이름공간 — 진짜 장부 클래스(R2Ledger)를 그대로 쓰고 저장소와 「한 번에 하나씩 처리」만 흉내 낸다.
 * serial=false 로 하면 직렬화를 끈 고장난 가짜가 되어, 시험이 동시 다툼을 실제로 잡아내는지 대조할 수 있다.
 */
class 가짜장부 implements LedgerNamespace {
  store = new Map<string, unknown>();
  serial = true;
  boom = false;
  calls: { op: string; [k: string]: unknown }[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  constructor(public cfg: LedgerEnv) {}
  idFromName(name: string) { return name; }
  get(_id: unknown) { return { fetch: (req: Request) => this.fetch(req) }; }
  /** 저장소 쪽 읽기·쓰기는 한 번 양보한다 — 직렬화가 꺼져 있으면 이때 다른 요청이 끼어든다 */
  private 양보 = () => new Promise<void>((r) => setTimeout(r, 0));
  private async fetch(req: Request): Promise<Response> {
    if (this.boom) throw new Error("장부가 고장났다");
    try { this.calls.push(await req.clone().json()); } catch { /* 깨진 요청도 장부 객체까지 그대로 간다 */ }
    const state = {
      storage: {
        get: async <T>(k: string) => { await this.양보(); const v = this.store.get(k); return (v === undefined ? undefined : structuredClone(v)) as T | undefined; },
        put: async (k: string, v: unknown) => { await this.양보(); this.store.set(k, structuredClone(v)); },
      },
      blockConcurrencyWhile: <T>(cb: () => Promise<T>): Promise<T> => {
        if (!this.serial) return cb();
        const p = this.chain.then(() => cb(), () => cb());
        this.chain = p.catch(() => {});
        return p;
      },
    };
    return new R2Ledger(state, this.cfg).fetch(req);
  }
  /** 지금 장부 내용 (시험이 직접 읽고 심는다) */
  state(): LedgerState | undefined { return this.store.get("L") as LedgerState | undefined; }
  seed(s: Partial<LedgerState>) { this.store.set("L", { v: 1, cycle: "2026-10-01", a: 0, b: 0, peak: {}, tix: {}, ...(this.state() ?? {}), ...s }); }
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

function 세상(o: { fail?: boolean; secrets?: boolean; ledger?: boolean; cfg?: LedgerEnv } = {}) {
  const 시계 = { t: Date.UTC(2026, 9, 19, 5, 0, 0) };
  const now = () => 시계.t;
  const kv = new 가짜KV(now), r2 = new 가짜R2();
  const 장부 = new 가짜장부(o.cfg ?? {});
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
    PUBLIC_URL: BASE, ...(o.cfg ?? {}),
    ...(o.ledger === false ? {} : { LEDGER: 장부 }),
  };
  const call = (method: string, path: string, init: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}) =>
    handle(new Request(`${BASE}${path}`, {
      method, headers: { ...(init.json ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      body: init.json ? JSON.stringify(init.json) : init.form ? new URLSearchParams(init.form) : undefined,
    }), env, deps);
  return { env, deps, kv, r2, meta, 시계, call, 장부 };
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
    같나("메타가 거절 까닭(error_reason)까지 보내오면 함께 앱으로 알린다", await 돌아옴(`/ig/callback?${new URLSearchParams({ error: "access_denied", error_reason: "user_denied", error_description: "The user denied your request", state: st })}`),
      [302, `http://127.0.0.1:${s.port}/meta/done?n=${s.nonce}&ok=0&error=access_denied&reason=user_denied&why=The+user+denied+your+request`]);
    {
      const stT = new URL((await w.call("GET", 시작주소("th", s))).headers.get("location")!).searchParams.get("state")!;
      const desc = "Bad code=SECRETCODE12345 and EAAGm0PX4ZDZDabcdefghijklmnopqrstuvwxyz0123456789 end";
      const r = await w.call("GET", `/th/callback?${new URLSearchParams({ error: "invalid_request", error_description: desc, state: stT })}`);
      const loc = new URL(r.headers.get("location")!);
      참인가("거절 설명에 토큰·코드 값이 섞여 와도 앱으로 넘기지 않는다", r.status === 302 && !loc.href.includes("SECRETCODE12345") && !loc.href.includes("ijklmnopqrstuvwxyz0123456789")
        && (loc.searchParams.get("why") ?? "").includes("end") && loc.searchParams.get("error") === "invalid_request");
    }
    {
      const r = await w.call("GET", `/ig/callback?${new URLSearchParams({ error: "access_denied", error_reason: "user_denied" })}`);
      const html = await r.text();
      참인가("state 없이 거절만 오면(앱으로 돌려보낼 곳을 모름) 이 쪽에서 까닭을 말한다 — 시간이 지난 주소라고 하지 않는다", r.status === 400 && html.includes("메타가 로그인을 거절했습니다 (메타가 알려 준 오류: access_denied)") && html.includes("사용 신청이 안 된 계정") && !html.includes("이미 쓴 주소"));
      const x = await (await w.call("GET", `/ig/callback?${new URLSearchParams({ error: "<script>alert(1)</script>" })}`)).text();
      참인가("  오류 이름이 이상한 글자면 화면에 싣지 않는다(스크립트 주입 없음)", !x.includes("<script>alert") && x.includes("메타가 로그인을 거절했습니다."));
    }
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
    같나("크론: 한 번에 400개까지만 지운다(1시간 지난 550개 · 1100개 · 세 쪽)", [지움, w6.r2.m.size, w6.r2.m.has("other/keep.txt")], [400, 701, true]);
    const 다음 = await cleanStage(w6.env, w6.deps);
    같나("다음 크론이 나머지 150개를 지운다 · 1시간 안 된 550개와 다른 폴더는 그대로", [다음, w6.r2.m.size, w6.r2.m.has("other/keep.txt")], [150, 551, true]);
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

  await 무료한도시험();

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


/* ═══════════════════════════ R2 무료 한도 장부 ═══════════════════════════ */

type 세상값 = ReturnType<typeof 세상>;
const 하루 = 86_400_000;
const 표만들기 = (w: 세상값, o: Obj = {}) => w.call("POST", "/stage/ticket", { json: { provider: "ig", token: "LONG-IG", size: 1000, ext: "mp4", ...o } });
/** 관리용 사용량 보기 — 서명한 10분 토큰 */
async function 사용량(w: 세상값, o: { exp?: number; sig?: string; 토큰없음?: boolean } = {}) {
  const exp = o.exp ?? w.시계.t + 10 * 분;
  const sig = o.sig ?? await hmacB64u(비밀.SIGN_KEY, `usage:${exp}`);
  return w.call("GET", "/usage", { headers: o.토큰없음 ? {} : { authorization: `Bearer ${exp}.${sig}` } });
}
const 문턱 = { a: R2_FREE.classA * 0.8, b: R2_FREE.classB * 0.8 };
const 읽기주소 = async (w: 세상값, name: string) => {
  const exp = w.시계.t + 3600_000;
  return `/s/${name}?e=${exp}&s=${await hmacB64u(비밀.SIGN_KEY, `get:${name}:${exp}`)}`;
};

async function 무료한도시험() {
  구역("무료 한도 — 설정값 · 구간 계산");
  {
    같나("기본값: 80% · 동시 보관 2GB · 달력 월(1일)", readLedgerConfig({}), { ratio: 0.8, stageMaxBytes: 2_000_000_000, cycleDay: 1 });
    같나("비율은 0 초과 0.95 이하만 — 틀린 값은 기본값으로(한도가 풀리지 않게)", [
      readLedgerConfig({ R2_CAP_RATIO: "0.5" }).ratio, readLedgerConfig({ R2_CAP_RATIO: "1.5" }).ratio, readLedgerConfig({ R2_CAP_RATIO: "0" }).ratio,
      readLedgerConfig({ R2_CAP_RATIO: "abc" }).ratio, readLedgerConfig({ R2_CAP_RATIO: "0.99" }).ratio,
    ], [0.5, 0.8, 0.8, 0.8, 0.8]);
    같나("동시 보관 상한: 너무 작으면 기본값 · 너무 크면 무료 용량의 문턱(8GB)으로 깎는다", [
      readLedgerConfig({ R2_STAGE_MAX_BYTES: "5" }).stageMaxBytes, readLedgerConfig({ R2_STAGE_MAX_BYTES: "99999999999" }).stageMaxBytes, readLedgerConfig({ R2_STAGE_MAX_BYTES: "500000000" }).stageMaxBytes,
    ], [2_000_000_000, 8_000_000_000, 500_000_000]);
    같나("구간 시작일은 1~28 만", [readLedgerConfig({ R2_CYCLE_DAY: "31" }).cycleDay, readLedgerConfig({ R2_CYCLE_DAY: "0" }).cycleDay, readLedgerConfig({ R2_CYCLE_DAY: "17" }).cycleDay, readLedgerConfig({ R2_CYCLE_DAY: "x" }).cycleDay], [1, 1, 17, 1]);
    const iso = (ms: number) => new Date(ms).toISOString();
    const b1 = cycleBounds(Date.UTC(2026, 9, 19, 5), 1);
    같나("달력 월: 10월 19일 → 10/1 ~ 11/1", [iso(b1.start), iso(b1.next)], ["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    const b2 = cycleBounds(Date.UTC(2026, 9, 19, 5), 17);
    같나("17일 시작: 10월 19일 → 10/17 ~ 11/17", [iso(b2.start), iso(b2.next)], ["2026-10-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z"]);
    const b3 = cycleBounds(Date.UTC(2026, 9, 10, 5), 17);
    같나("17일 시작: 10월 10일 → 9/17 ~ 10/17", [iso(b3.start), iso(b3.next)], ["2026-09-17T00:00:00.000Z", "2026-10-17T00:00:00.000Z"]);
    const b4 = cycleBounds(Date.UTC(2027, 0, 5), 17);
    같나("해가 바뀔 때도 맞다: 1월 5일 → 전년 12/17 ~ 1/17", [iso(b4.start), iso(b4.next)], ["2026-12-17T00:00:00.000Z", "2027-01-17T00:00:00.000Z"]);
    같나("요금 문서의 무료 한도 값", [R2_FREE.classA, R2_FREE.classB, R2_FREE.gbMonth], [1_000_000, 10_000_000, 10]);
  }

  구역("무료 한도 — 호출하기 전에 장부에 먼저 적는다 (쓰기 3건 예약 · 읽기 · 지우기)");
  {
    const w = 세상();
    const t = await (await 표만들기(w, { size: 5000 })).json();
    같나("티켓 한 장: 장부에 쓰기 3건(올리기 1 + 다시 시도 2) + 보관 5000바이트가 먼저 잡힌다", [t.ok, w.장부.state()!.a, w.장부.state()!.b, w.장부.state()!.tix[t.name]?.sz, w.장부.state()!.peak["2026-10-19"]], [true, 티켓A예약, 0, 5000, 5000]);
    w.r2.put(`stage/${t.name}`, new Uint8Array(5000), new Date(w.시계.t));
    const 경로 = (() => { const u = new URL(t.get_url); return `${u.pathname}${u.search}`; })();
    await w.call("GET", 경로);
    같나("영상 읽기(GET) 한 번 = 읽기 2건(머리 확인 + 내용) · R2 도 실제로 2번 불렸다", [w.장부.state()!.b, w.r2.ops.head + w.r2.ops.get], [2, 2]);
    await w.call("HEAD", 경로);
    같나("HEAD 는 1건", [w.장부.state()!.b, w.r2.ops.head + w.r2.ops.get], [3, 3]);
    await w.call("GET", 경로.replace(/s=[^&]+/, "s=AAAA"));
    await w.call("GET", `/s/zzz.mp4?e=${w.시계.t + 1000}&s=x`);
    같나("서명이 틀린 읽기·이름이 틀린 읽기는 장부도 R2 도 건드리지 않는다", [w.장부.state()!.b, w.r2.ops.head + w.r2.ops.get, w.장부.calls.filter((c) => c.op === "read").length], [3, 3, 2]);
    같나("지우기: 보관 목록에서 빠진다(하루 최고치는 남는다)", [(await w.call("POST", "/stage/delete", { json: { id: t.id, sig: t.delete_sig } })).status, Object.keys(w.장부.state()!.tix).length, w.장부.state()!.peak["2026-10-19"]], [200, 0, 5000]);
    const u = await (await 사용량(w)).json();
    같나("사용량 보기: 센 숫자 · 문턱 · 구간", [u.class_a.used, u.class_a.soft_cap, u.class_b.used, u.class_b.soft_cap, u.storage.soft_cap_gb_month, u.cycle.next_start, u.blocked], [3, 문턱.a, 3, 문턱.b, 8, "2026-11-01T00:00:00.000Z", []]);
  }

  구역("무료 한도 — 문턱 직전은 통과, 직후는 거절 (쓰기 · 읽기 · 보관 용량)");
  {
    const w = 세상();
    w.장부.seed({ a: 문턱.a - 티켓A예약 });
    const 직전 = await 표만들기(w);
    같나("쓰기: 문턱에 정확히 닿는 마지막 한 장은 통과", [직전.status, w.장부.state()!.a], [200, 문턱.a]);
    const rk = "rl:ig:17841400000000001:2026-10-19";
    const 직후 = await 표만들기(w);
    const j = await 직후.json();
    같나("바로 다음은 거절: 503 · monthly_free_cap · 어느 한도인지 · 다음 열림 시각", [직후.status, j.ok, j.code, j.resource, j.reopens_at], [503, false, "monthly_free_cap", "class_a", "2026-11-01T00:00:00.000Z"]);
    참인가("거절 답에는 업로드·읽기 주소가 없고, 사람이 읽을 이유와 Retry-After 가 있다", !j.put_url && !j.get_url && j.why.includes("무료 한도") && j.why.includes("11월 1일") && Number(직후.headers.get("retry-after")) > 0);
    같나("거절된 요청은 하루 횟수(40번)도 쓰지 않았다 · 장부 숫자도 그대로", [w.kv.m.get(rk)?.v, w.장부.state()!.a], ["1", 문턱.a]);
    같나("거절돼도 R2 는 한 번도 안 불렸다", [w.r2.ops.get, w.r2.ops.head, w.r2.ops.list, w.r2.ops.delete], [0, 0, 0, 0]);

    // 읽기
    const wb = 세상();
    const t = await (await 표만들기(wb)).json();
    wb.r2.put(`stage/${t.name}`, new Uint8Array(100), new Date(wb.시계.t));
    const 경로 = (() => { const u = new URL(t.get_url); return `${u.pathname}${u.search}`; })();
    wb.장부.seed({ b: 문턱.b - 2 });
    const g1 = await wb.call("GET", 경로);
    같나("읽기: 문턱에 정확히 닿는 읽기 2건은 통과", [g1.status, wb.장부.state()!.b], [200, 문턱.b]);
    const ops = wb.r2.ops.head + wb.r2.ops.get;
    const g2 = await wb.call("GET", 경로);
    const h2 = await wb.call("HEAD", 경로);
    같나("그 다음 GET·HEAD 는 403 — R2 를 부르지 않는다", [g2.status, h2.status, wb.r2.ops.head + wb.r2.ops.get - ops, wb.장부.state()!.b], [403, 403, 0, 문턱.b]);
    wb.장부.seed({ b: 문턱.b - 1 });
    같나("읽기 1건만 남았을 땐 HEAD(1건)는 되고 GET(2건)은 막힌다", [(await wb.call("HEAD", 경로)).status, (await wb.call("GET", 경로)).status], [200, 403]);

    // 새 보관을 받을 때 읽기 여유(메타가 읽어 갈 몫)가 없으면 받지 않는다
    const wc = 세상();
    wc.장부.seed({ b: 문턱.b - 티켓B여유 });
    같나("새 보관은 읽기 여유 20건이 남아 있어야 받는다: 딱 20건 남으면 통과", (await 표만들기(wc)).status, 200);
    wc.장부.seed({ b: 문턱.b - 티켓B여유 + 1 });
    const 읽기막힘 = await 표만들기(wc);
    같나("19건 남으면 거절(class_b)", [읽기막힘.status, (await 읽기막힘.json()).resource], [503, "class_b"]);

    // 보관 용량(한 달 GB-월 추정) — 하루 최고 보관량의 합 ÷ 30
    const wd = 세상();
    const 날들 = (합: number) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, 합 / 18]));
    wd.장부.seed({ peak: 날들(2.39e11) });
    const 용량통과 = await 표만들기(wd, { size: 300_000_000 });
    같나("보관 용량: 이번 달 추정이 8GB-월을 안 넘으면 통과", [용량통과.status, (await 사용량(wd).then((r) => r.json())).storage.gb_month_estimate], [200, 7.977]);
    const we = 세상();
    we.장부.seed({ peak: 날들(2.399e11) });
    const 용량막힘 = await 표만들기(we, { size: 300_000_000 });
    const jw = await 용량막힘.json();
    같나("넘기게 되면 거절(storage) — 다음 달 열림", [용량막힘.status, jw.code, jw.resource, jw.reopens_at], [503, "monthly_free_cap", "storage", "2026-11-01T00:00:00.000Z"]);
  }

  구역("무료 한도 — 동시에 마지막 한 칸을 다투면 하나만 통과한다");
  {
    const w = 세상();
    w.장부.seed({ a: 문턱.a - 티켓A예약 });
    const 답 = await Promise.all(Array.from({ length: 5 }, () => 표만들기(w)));
    같나("쓰기: 마지막 한 칸에 5개가 동시에 와도 1개만 통과", [답.filter((r) => r.status === 200).length, 답.filter((r) => r.status === 503).length, w.장부.state()!.a], [1, 4, 문턱.a]);

    const wr = 세상();
    const t = await (await 표만들기(wr)).json();
    wr.r2.put(`stage/${t.name}`, new Uint8Array(100), new Date(wr.시계.t));
    const 경로 = (() => { const u = new URL(t.get_url); return `${u.pathname}${u.search}`; })();
    wr.장부.seed({ b: 문턱.b - 2 });
    const 읽 = await Promise.all(Array.from({ length: 4 }, () => wr.call("GET", 경로)));
    같나("읽기: 마지막 2건에 GET 4개가 동시에 와도 1개만 통과 · R2 도 1번(2건)만 불렸다", [읽.filter((r) => r.status === 200).length, 읽.filter((r) => r.status === 403).length, wr.r2.ops.head + wr.r2.ops.get], [1, 3, 2]);

    // 동시 보관 총용량 상한도 같다
    const ws = 세상({ cfg: { R2_STAGE_MAX_BYTES: String(2 * 1024 * 1024) } });
    const 용 = await Promise.all(Array.from({ length: 3 }, () => 표만들기(ws, { size: 1_500_000 })));
    같나("동시 보관 상한(2MiB): 1.5MB 3장이 동시에 와도 1장만 통과", [용.filter((r) => r.status === 200).length, 용.filter((r) => r.status === 429).length], [1, 2]);

    // 대조군: 직렬화를 끈 고장난 가짜에서는 둘 이상 통과한다 — 위 시험이 실제로 다툼을 잡는다는 증거
    const wx = 세상();
    wx.장부.serial = false;
    wx.장부.seed({ a: 문턱.a - 티켓A예약 });
    const 대조 = await Promise.all(Array.from({ length: 5 }, () => 표만들기(wx)));
    참인가("대조군(직렬화 없음): 같은 다툼에서 여러 개가 통과해 버린다 — 장부가 한 번에 하나씩 처리하는 것에 기댄다는 뜻", 대조.filter((r) => r.status === 200).length > 1);
  }

  구역("무료 한도 — 동시 보관 총용량 상한 (곧 풀리는 일시적인 막힘)");
  {
    const w = 세상({ cfg: { R2_STAGE_MAX_BYTES: String(2 * 1024 * 1024) } });
    const a = await (await 표만들기(w, { size: 1_200_000 })).json();
    const r = await 표만들기(w, { size: 1_200_000 });
    const j = await r.json();
    같나("총용량이 넘으면 429 · stage_full(달 한도와 다른 이유) · 다시 해 볼 시간", [r.status, j.code, j.resource, j.retry_after > 0, j.reopens_at], [429, "stage_full", undefined, true, undefined]);
    같나("거절된 보관은 장부에 안 잡힌다", [Object.keys(w.장부.state()!.tix).length, w.장부.state()!.a], [1, 티켓A예약]);
    await w.call("POST", "/stage/delete", { json: { id: a.id, sig: a.delete_sig } });
    같나("앞의 영상을 지우면 바로 받는다", (await 표만들기(w, { size: 1_200_000 })).status, 200);
    w.장부.seed({ tix: {} });
    w.시계.t += 100 * 분;
    같나("앱이 알리지 않아도 보관 표는 1시간 반 뒤 스스로 빠진다", [(await 표만들기(w, { size: 2_000_000 })).status, Object.keys(w.장부.state()!.tix).length], [200, 1]);
  }

  구역("무료 한도 — 달이 바뀌면 센 숫자를 새로 시작하되, 보관 중인 영상은 계속 센다");
  {
    const w = 세상();
    w.시계.t = Date.UTC(2026, 9, 31, 23, 59, 0);
    w.장부.seed({ a: 문턱.a, b: 문턱.b });
    const 막힘 = await 표만들기(w);
    같나("10월 31일 밤: 막혀 있다 · 열리는 때는 11월 1일 00:00 UTC", [막힘.status, (await 막힘.json()).reopens_at], [503, "2026-11-01T00:00:00.000Z"]);
    w.시계.t = Date.UTC(2026, 10, 1, 0, 0, 1);
    const 열림 = await 표만들기(w);
    같나("11월 1일 00:00:01: 열린다 · 쓰기·읽기 숫자가 새로 시작", [열림.status, w.장부.state()!.cycle, w.장부.state()!.a, w.장부.state()!.b, Object.keys(w.장부.state()!.peak)], [200, "2026-11-01", 티켓A예약, 0, ["2026-11-01"]]);

    const wk = 세상();
    wk.시계.t = Date.UTC(2026, 9, 31, 23, 50, 0);
    await 표만들기(wk, { size: 7000 });
    wk.시계.t = Date.UTC(2026, 10, 1, 0, 10, 0);
    const u = await (await 사용량(wk)).json();
    같나("달이 바뀌어도 아직 있는 영상은 새 구간의 보관 용량에 센다(쓰기 숫자는 0)", [u.class_a.used, u.storage.stored_bytes_now, u.storage.today_peak_bytes, u.cycle.start], [0, 7000, 7000, "2026-11-01T00:00:00.000Z"]);

    const w17 = 세상({ cfg: { R2_CYCLE_DAY: "17" } });
    w17.장부.seed({ cycle: "2026-10-17", a: 문턱.a });
    같나("청구일 17일로 설정하면 다음 열림도 11월 17일", (await (await 표만들기(w17)).json()).reopens_at, "2026-11-17T00:00:00.000Z");
    w17.시계.t = Date.UTC(2026, 10, 17, 0, 0, 5);
    같나("11월 17일이 되면 열린다", (await 표만들기(w17)).status, 200);

    const wb = 세상();
    wb.장부.seed({ cycle: "2026-11-01", a: 123 });
    await 표만들기(wb);
    같나("시계가 거꾸로 가도 센 숫자는 지워지지 않는다(위쪽으로만 센다)", wb.장부.state()!.a, 123 + 티켓A예약);
  }

  구역("무료 한도 — 장부가 없거나 고장나면 R2 를 쓰지 않는다 (지우기·청소는 계속)");
  {
    for (const [무엇, o] of [["장부 연결이 없음", { ledger: false }], ["장부가 고장남", {}]] as [string, Obj][]) {
      const w = 세상(o);
      if (무엇 === "장부가 고장남") w.장부.boom = true;
      const r = await 표만들기(w);
      const j = await r.json();
      같나(`${무엇}: 티켓을 내주지 않는다(503 · ledger_unavailable) · 하루 횟수도 안 쓴다`, [r.status, j.code, j.put_url, w.kv.m.size], [503, "ledger_unavailable", undefined, 0]);
      const name = "ab".repeat(16) + ".mp4";
      w.r2.put(`stage/${name}`, new Uint8Array(10), new Date(w.시계.t));
      const g = await w.call("GET", await 읽기주소(w, name));
      같나(`${무엇}: 읽기도 막는다(503) · R2 를 부르지 않는다`, [g.status, w.r2.ops.head + w.r2.ops.get], [503, 0]);
      const id = "cd".repeat(16);
      w.r2.put(`stage/${id}.mp4`, new Uint8Array(10), new Date(w.시계.t));
      const d = await w.call("POST", "/stage/delete", { json: { id, sig: await hmacB64u(비밀.SIGN_KEY, `del:${id}`) } });
      같나(`${무엇}: 지우기는 그대로 된다`, [d.status, w.r2.m.has(`stage/${id}.mp4`)], [200, false]);
      w.r2.put("stage/" + "ef".repeat(16) + ".mp4", new Uint8Array(10), new Date(w.시계.t - 2 * 3600_000));
      const 지움 = await cleanStage(w.env, w.deps);
      같나(`${무엇}: 크론은 낡은 영상을 계속 지운다`, [지움, w.r2.ops.list], [1, 1]);
    }
    const w = 세상();
    const r = await w.장부.get("r2").fetch(new Request("https://ledger.internal/op", { method: "POST", body: "깨진 글" }));
    같나("장부 객체는 깨진 요청을 400 으로 거절한다", r.status, 400);
  }

  구역("무료 한도 — 지우기는 한도에 닿아도 멈추지 않는다 · 크론의 목록 조회는 장부에 적는다");
  {
    const w = 세상();
    const t = await (await 표만들기(w)).json();
    w.r2.put(`stage/${t.name}`, new Uint8Array(10), new Date(w.시계.t));
    w.장부.seed({ a: R2_FREE.classA, b: R2_FREE.classB });
    const d = await w.call("POST", "/stage/delete", { json: { id: t.id, sig: t.delete_sig } });
    같나("쓰기·읽기가 모두 100% 여도 지우기는 된다", [d.status, w.r2.m.size], [200, 0]);

    // 크론: 목록 조회 한 쪽 = Class A 1건 — 부르기 전에 적는다
    const wc = 세상();
    const 낡음 = "a1".repeat(16) + ".mp4", 새것 = "b2".repeat(16) + ".mp4", 큰것 = "c3".repeat(16) + ".mp4", 낯섬 = "d4".repeat(16) + ".mp4";
    const 표 = (n: string, sz: number) => { wc.장부.seed({ tix: { ...(wc.장부.state()?.tix ?? {}), [n]: { sz, at: wc.시계.t, ex: wc.시계.t + 90 * 분 } } }); };
    표(낡음, 100); 표(새것, 100); 표(큰것, 100);
    wc.r2.put(`stage/${낡음}`, new Uint8Array(100), new Date(wc.시계.t - 2 * 3600_000));
    wc.r2.put(`stage/${새것}`, new Uint8Array(100), new Date(wc.시계.t - 10 * 분));
    wc.r2.put(`stage/${큰것}`, new Uint8Array(3 * 1024 * 1024), new Date(wc.시계.t - 10 * 분)); // 100바이트라고 해 놓고 3MiB 를 올림
    wc.r2.put(`stage/${낯섬}`, new Uint8Array(777), new Date(wc.시계.t - 5 * 분));              // 우리가 낸 주소가 아닌 영상
    const 지움 = await cleanStage(wc.env, wc.deps);
    const 남음 = [...wc.r2.m.keys()].map((k) => k.slice(6, 8)).sort();
    같나("크론: 1시간 넘은 것 · 말한 크기보다 큰 것을 지운다 · 정상과 낯선 영상은 둔다", [지움, 남음], [2, ["b2", "d4"]]);
    같나("크론: 목록 조회 1건을 장부에 적었다 · R2 도 1번 불렸다", [wc.장부.state()!.a, wc.r2.ops.list], [1, 1]);
    같나("낯선 영상도 보관 용량에 센다(777바이트) · 지운 것은 목록에서 빠졌다", [wc.장부.state()!.tix[낯섬]?.sz, Object.keys(wc.장부.state()!.tix).sort()], [777, [낯섬, 새것].sort()]);
    같나("지우기 전의 실제 양(3MiB)이 그날 최고치에 들어갔다", wc.장부.state()!.peak["2026-10-19"] >= 3 * 1024 * 1024, true);

    // 문턱(80%)을 넘어도 크론은 돈다 — 무료 한도 자체(100%)에 닿으면 목록을 부르지 않는다
    const wd = 세상();
    wd.r2.put("stage/" + "e5".repeat(16) + ".mp4", new Uint8Array(10), new Date(wd.시계.t - 2 * 3600_000));
    wd.장부.seed({ a: 문턱.a + 100_000 });
    같나("쓰기가 문턱(80%)을 넘었어도 크론은 낡은 영상을 지운다", [await cleanStage(wd.env, wd.deps), wd.r2.ops.list], [1, 1]);
    const we = 세상();
    we.r2.put("stage/" + "e5".repeat(16) + ".mp4", new Uint8Array(10), new Date(we.시계.t - 2 * 3600_000));
    we.장부.seed({ a: R2_FREE.classA });
    같나("쓰기가 무료 한도 100% 면 목록 조회 자체를 하지 않는다(과금 호출 금지)", [await cleanStage(we.env, we.deps), we.r2.ops.list], [0, 0]);
  }

  구역("무료 한도 — 센 숫자는 실제 R2 호출 수보다 같거나 크다 (여러 일을 섞어서)");
  {
    const w = 세상();
    const 표들: Obj[] = [];
    for (let i = 0; i < 6; i++) 표들.push(await (await 표만들기(w, { size: 2000 + i })).json());
    for (const t of 표들.slice(0, 4)) w.r2.put(`stage/${t.name}`, new Uint8Array(2000), new Date(w.시계.t));  // 앱이 4개를 올림
    for (const t of 표들.slice(0, 3)) {
      const u = new URL(t.get_url);
      await w.call("GET", `${u.pathname}${u.search}`);
      await w.call("HEAD", `${u.pathname}${u.search}`);
      await w.call("GET", `${u.pathname}${u.search}`, { headers: { range: "bytes=0-9" } });
    }
    await w.call("POST", "/stage/delete", { json: { id: 표들[0].id, sig: 표들[0].delete_sig } });
    w.시계.t += 2 * 3600_000;
    await cleanStage(w.env, w.deps);
    const s = w.장부.state()!;
    const 실제A = w.r2.puts + w.r2.ops.list, 실제B = w.r2.ops.head + w.r2.ops.get;
    참인가(`쓰기: 장부 ${s.a}건 ≥ 실제 ${실제A}건 (올리기 ${w.r2.puts} + 목록 ${w.r2.ops.list})`, s.a >= 실제A);
    참인가(`읽기: 장부 ${s.b}건 ≥ 실제 ${실제B}건`, s.b >= 실제B && 실제B > 0);
    같나("2시간 뒤 크론이 남은 영상을 모두 지웠다", w.r2.m.size, 0);
  }

  구역("무료 한도 — 사용량 보기(/usage)는 서명한 짧은 토큰이 있어야 한다");
  {
    const w = 세상();
    await 표만들기(w);
    const ok = await 사용량(w);
    const 글 = await ok.text();
    같나("올바른 토큰: 200 · 캐시 안 함", [ok.status, ok.headers.get("cache-control")], [200, "no-store"]);
    참인가("답에 비밀·토큰이 없다", !글.includes(비밀.SIGN_KEY) && !글.includes(비밀.R2_SECRET_ACCESS_KEY) && !글.includes("LONG-IG"));
    const 거절들: [string, Response][] = [
      ["토큰 없음", await 사용량(w, { 토큰없음: true })],
      ["서명이 틀림", await 사용량(w, { sig: "A".repeat(43) })],
      ["이미 만료", await 사용량(w, { exp: w.시계.t - 1000 })],
      ["만료가 1시간보다 멀다(오래 쓰는 토큰 금지)", await 사용량(w, { exp: w.시계.t + 2 * 3600_000 })],
    ];
    for (const [무엇, r] of 거절들) {
      const b = await r.text();
      같나(`거절: ${무엇} → 401 · 숫자를 하나도 알려주지 않는다`, [r.status, /class_a|used|cap/.test(b)], [401, false]);
    }
    같나("GET 만 된다", (await w.call("POST", "/usage")).status, 404);
    const 없음 = 세상({ ledger: false });
    같나("장부 연결이 없으면 503", (await 사용량(없음)).status, 503);
  }
}

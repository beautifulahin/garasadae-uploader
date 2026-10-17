// 쿠팡 파트너스 자동 링크 시험 — 서명 · 연결 · 설정 · 영상 고르기 · 한도 · 설명 붙이기 · 문제 목록.
//
// 쿠팡에는 한 번도 닿지 않는다: 쿠팡 주소(api-gateway.coupang.com)만 받는 가짜 서버를 setFetch 로 끼운다.
// 가짜 서버는 진짜 서버처럼 **서명을 다시 계산해** 맞는지 본다(열쇠가 틀리거나 서명한 글자와 보낸 글자가 다르면 401).
// 열쇠는 가짜(test-access / test-secret)뿐이다.
import { 같나, 구역, 모래상자, 참인가 } from "./도구.ts";
import { setFetch } from "../app/google.ts";
import { dataDir, dataPath, exists, readJsonSync, recordPath, writeJson } from "../app/paths.ts";
import { editChannels } from "../app/channels.ts";
import { appSettings } from "../app/settings.ts";
import * as cp from "../app/coupang.ts";

const 열쇠 = { access: "test-access", secret: "test-secret" };
const 검색경로 = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search";
const 딥링크경로 = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";
const 분 = 60_000;
const 시간 = 3_600_000;

/* ───────────── 가짜 쿠팡 서버 ───────────── */

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
/** 서버 쪽 서명 계산 — 앱의 sign() 을 부르지 않고 따로 짠다(둘이 같이 틀려도 통과하는 일이 없게) */
async function hmac(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

interface 호출 {
  method: string; path: string; query: string; body: any; auth: string; ctype: string;
  hasSignal: boolean; keyword: string; subId: string;
  /** 서버가 서명을 다시 계산해 보니 맞았나 */
  signedOk: boolean;
  /** signed-date 가 지금과 2분 안인가 */
  fresh: boolean;
}
/** 앞으로 올 응답을 이걸로 바꾼다. 아무 칸도 없으면(`{}`) 평소대로 */
interface 강제 { status?: number; body?: string; throws?: unknown; hang?: boolean }

class 가짜쿠팡 {
  calls: 호출[] = [];
  /** 이 서버가 아는 열쇠 */
  access = 열쇠.access;
  secret = 열쇠.secret;
  /** 검색어 → 상품 목록 (없는 검색어는 빈 목록) */
  catalog = new Map<string, any[]>();
  /** 앞으로 올 응답을 차례로 바꾼다 (하나씩 쓰고 사라진다) */
  queue: 강제[] = [];

  install() { setFetch(this.handle); return this; }
  검색() { return this.calls.filter((c) => c.path === 검색경로); }
  딥링크() { return this.calls.filter((c) => c.path === 딥링크경로); }

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href); // 진짜 fetch 처럼 주소를 한 번 정리한다 — 서명한 글자와 보낸 글자가 어긋나는지 여기서 드러난다
    if (url.hostname !== "api-gateway.coupang.com") throw new Error(`쿠팡 말고 다른 곳으로 나갔다: ${url.hostname}`);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const query = url.search.startsWith("?") ? url.search.slice(1) : "";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const sp = new URLSearchParams(query);
    const m = /^CEA algorithm=HmacSHA256, access-key=([^,]+), signed-date=(\d{6}T\d{6}Z), signature=([0-9a-f]{64})$/.exec(auth);
    const signedOk = !!m && m[1] === this.access && m[3] === await hmac(this.secret, m[2] + method + url.pathname + query);
    let fresh = false;
    if (m) {
      const d = m[2];
      const t = Date.UTC(2000 + +d.slice(0, 2), +d.slice(2, 4) - 1, +d.slice(4, 6), +d.slice(7, 9), +d.slice(9, 11), +d.slice(11, 13));
      fresh = Math.abs(Date.now() - t) < 2 * 분;
    }
    this.calls.push({
      method, path: url.pathname, query, body, auth, ctype: new Headers(init?.headers).get("content-type") ?? "", hasSignal: init?.signal instanceof AbortSignal,
      keyword: sp.get("keyword") ?? "", subId: sp.get("subId") ?? "", signedOk, fresh,
    });
    const f = this.queue.shift();
    if (f?.throws !== undefined) throw f.throws;
    if (f?.hang) await new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason)));
    if (f?.status !== undefined || f?.body !== undefined) return new Response(f.body ?? "{}", { status: f.status ?? 200 });
    if (!signedOk) return json({ code: "ERROR", message: "Invalid signature or access key" }, 401);
    if (url.pathname === 검색경로) {
      const kw = sp.get("keyword") ?? "";
      const productData = (this.catalog.get(kw) ?? []).map((p) => ({
        ...p, productUrl: p.productUrl ?? `https://link.coupang.com/re/AFFSDP?lptag=AF0&subid=${sp.get("subId") ?? ""}&itemId=${p.productId}`,
      }));
      return json({ rCode: "0", rMessage: "", data: { productData, landingUrl: "https://link.coupang.com/re/AFFSDP?x=1" } });
    }
    if (url.pathname === 딥링크경로) {
      const urls: string[] = body?.coupangUrls ?? [];
      return json({
        rCode: "0", rMessage: "",
        data: urls.map((u) => ({ originalUrl: u, shortenUrl: `https://link.coupang.com/a/dl${u.split("/").pop()}`, landingUrl: `https://link.coupang.com/re/AFFSDP?u=${u.split("/").pop()}` })),
      });
    }
    return json({ code: "ERROR", message: "모르는 주소" }, 404);
  };
}

const 상품 = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  productId: id, productName: name, productPrice: 10000 + id, productImage: "https://img.example/x.jpg",
  categoryName: "생활", isRocket: true, isFreeShipping: false, ...extra,
});

/* ───────────── 도우미 ───────────── */

/** 열쇠가 저장되고 켜진 상태를 직접 만든다 (connect 를 안 거치니 호출 기록이 깨끗하다). 한도 시험이 아니면 시간당 100회로 넉넉히 */
async function 켜기(extra: Record<string, unknown> = {}) {
  await writeJson(dataPath("쿠팡파트너스.json"), { access_key: 열쇠.access, secret_key: 열쇠.secret, enabled: true, per_hour: 100, ...extra }, { secret: true });
}
async function 영상(dir: string, n: number): Promise<string> {
  const p = `${dir}/영상${n}.mp4`;
  await Deno.writeTextFile(p, "x".repeat(10 + n));
  return p;
}
const 입력 = (file: string, o: Partial<cp.PickInput> = {}): cp.PickInput =>
  ({ channel: "채널A", file, title: "영상 제목", desc: "설명 글", tags: [], ...o });
const ai = (...q: string[]) => async () => ({ queries: q });
const 고르기 = (file: string, o: Partial<cp.PickInput> = {}) => cp.pickForVideo(입력(file, o));
const 분뒤 = (t: Date, n: number) => new Date(t.getTime() + n * 분);

async function 파일들(dir: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...await 파일들(p));
    else if (e.isFile) out.push([p, await Deno.readTextFile(p).catch(() => "")]);
  }
  return out;
}
/** 열쇠 파일 말고 다른 곳(기록·캐시·로그·앱설정)에 열쇠 값이 새어 있으면 그 파일 이름들 */
async function 새는곳(): Promise<string[]> {
  return (await 파일들(dataDir()))
    .filter(([p, t]) => !p.endsWith("/쿠팡파트너스.json") && !p.includes("쿠팡파트너스.json.깨짐_") && (t.includes("test-secret") || t.includes("test-access")))
    .map(([p]) => p.slice(dataDir().length));
}

/* ───────────── 시험 ───────────── */

async function 서명시험() {
  구역("서명 (파이썬으로 따로 계산해 둔 시험 벡터)");
  const q = "keyword=%ED%85%80%EB%B8%94%EB%9F%AC&limit=10&subId=ch1";
  같나("검색 GET 서명", await cp.sign("test-secret", "251017T123456Z", "GET", 검색경로, q), "0fa29012e32bb1d3dd57b10bb82bc9d6e2750baa6d7f96505caa9d2a5df5a570");
  같나("딥링크 POST 서명 (query 없음)", await cp.sign("test-secret", "251017T123456Z", "POST", 딥링크경로), "e9ad758d68fc87b943bd9c14c0102cc836bfd3df88c884ebcf1029a830f031fe");
  같나("query 를 빈 글로 줘도 같다", await cp.sign("test-secret", "251017T123456Z", "POST", 딥링크경로, ""), "e9ad758d68fc87b943bd9c14c0102cc836bfd3df88c884ebcf1029a830f031fe");
  같나("열쇠가 다르면 서명도 다르다", (await cp.sign("other", "251017T123456Z", "GET", 검색경로, q)) === "0fa29012e32bb1d3dd57b10bb82bc9d6e2750baa6d7f96505caa9d2a5df5a570", false);
  같나("signedDateOf: UTC YYMMDDTHHMMSSZ", cp.signedDateOf(new Date("2025-10-17T12:34:56.789Z")), "251017T123456Z");
  같나("signedDateOf: 연초 자정", cp.signedDateOf(new Date("2026-01-02T00:00:05Z")), "260102T000005Z");
  참인가("signedDateOf: 지금 시각도 같은 꼴", /^\d{6}T\d{6}Z$/.test(cp.signedDateOf()));
}

async function 연결시험() {
  구역("연결 — 검색 1회로 확인하고 통과하면 저장, 틀리면 저장하지 않는다");
  await 모래상자(async () => {
    const fake = new 가짜쿠팡().install();
    fake.catalog.set("텀블러", [상품(1, "스테인리스 텀블러 500ml")]);

    fake.access = "other-access"; // 서버가 아는 Access Key 는 다른 것
    const bad = await cp.connect(열쇠.access, 열쇠.secret);
    같나("틀린 열쇠(401): ok false", bad.ok, false);
    참인가("틀린 열쇠: 까닭이 한국어 (최종 승인 안내)", /승인/.test(bad.message));
    같나("틀린 열쇠: sample 없음", bad.sample, null);
    같나("틀린 열쇠는 저장하지 않는다 (열쇠 파일이 안 생긴다)", await exists(dataPath("쿠팡파트너스.json")), false);
    같나("틀린 열쇠: 연결 안 됨", cp.loadSettings().connected, false);
    같나("틀린 열쇠: 입력 창을 본 것으로 치지 않는다", appSettings().coupangPrompted, false);

    fake.access = 열쇠.access; fake.secret = "other-secret"; // Secret 만 틀림 — 서명이 안 맞는다
    const badSecret = await cp.connect(열쇠.access, 열쇠.secret);
    같나("Secret 만 틀려도(서명 불일치) 거절", [badSecret.ok, await exists(dataPath("쿠팡파트너스.json"))], [false, false]);

    fake.secret = 열쇠.secret;
    const n0 = fake.calls.length;
    for (const [a, s] of [["", "x"], ["한글 열쇠", "x"], ["a b", "x"], ["x", ""]] as const) {
      같나(`열쇠 입력 검사 「${a}」/「${s}」: 거절하고 호출하지 않는다`, (await cp.connect(a, s)).ok, false);
    }
    같나("입력이 이상하면 쿠팡을 부르지 않는다", fake.calls.length, n0);

    const ok = await cp.connect(`  ${열쇠.access} `, `"${열쇠.secret}"`); // 앞뒤 공백·따옴표는 걷는다
    같나("맞는 열쇠: ok", ok.ok, true);
    참인가("맞는 열쇠: 한국어 안내", /연결됐습니다/.test(ok.message));
    같나("맞는 열쇠: sample 이름·가격", ok.sample, { name: "스테인리스 텀블러 500ml", price: 10001 });
    const st = cp.loadSettings();
    같나("저장됨: connected", st.connected, true);
    같나("연결하면 자동 링크가 켜진다", st.enabled, true);
    같나("입력 창을 본 것으로 기록", appSettings().coupangPrompted, true);
    같나("lastTest 가 남는다", [st.lastTest?.ok, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(st.lastTest?.at ?? "")], [true, true]);
    if (Deno.build.os !== "windows") {
      같나("열쇠 파일 권한 600", (await Deno.stat(dataPath("쿠팡파트너스.json"))).mode! & 0o777, 0o600);
    }
    같나("loadSettings 에 열쇠 값이 없다", JSON.stringify(st).includes("test-"), false);
    같나("connect 반환값에 열쇠가 없다", /test-(access|secret)/.test(JSON.stringify(ok)), false);

    const c = fake.calls.at(-1)!;
    같나("요청 머리글 꼴 (CEA algorithm=HmacSHA256 …)", /^CEA algorithm=HmacSHA256, access-key=test-access, signed-date=\d{6}T\d{6}Z, signature=[0-9a-f]{64}$/.test(c.auth), true);
    같나("서버가 서명을 다시 계산해 맞았다 (서명한 query = 보낸 query)", c.signedOk, true);
    같나("signed-date 가 지금 시각", c.fresh, true);
    같나("시간 초과 신호가 실렸다 (AbortSignal)", c.hasSignal, true);
    같나("Content-Type 은 GET 에도 실린다", c.ctype, "application/json;charset=UTF-8");
    같나("처음 저장할 때 설정 칸이 모두 적힌다",
      (({ mode, max_links, per_hour, disclosure, default_sub_id, enabled }) => ({ mode, max_links, per_hour, disclosure, default_sub_id, enabled }))(readJsonSync<any>(dataPath("쿠팡파트너스.json"), {})),
      { mode: "auto", max_links: 3, per_hour: 10, disclosure: cp.DEFAULT_DISCLOSURE, default_sub_id: "", enabled: true });
    같나("연결 시험 query (subId 없음)", c.query, "keyword=%ED%85%80%EB%B8%94%EB%9F%AC&limit=10");

    // 시험 연결
    const t1 = await cp.testConnection();
    같나("testConnection: ok", [t1.ok, t1.sample?.name], [true, "스테인리스 텀블러 500ml"]);
    같나("testConnection: 호출 현황이 함께 온다", [t1.usage.used, t1.usage.limit], [1, 10]);
    // 서버가 오류 글에 요청을 되받아 적어도 열쇠가 새지 않는다
    fake.queue.push({ status: 500, body: JSON.stringify({ message: `bad: test-secret test-access signature=${"a".repeat(64)}` }) });
    const t2 = await cp.testConnection();
    같나("testConnection: 서버 오류는 ok false", t2.ok, false);
    같나("오류 글에서 열쇠·서명이 가려진다", /test-secret|test-access|a{20}/.test(t2.message), false);
    같나("lastTest 에 실패가 남는다", cp.loadSettings().lastTest?.ok, false);
    같나("lastTest 글에도 열쇠가 없다", /test-secret|test-access/.test(cp.loadSettings().lastTest?.message ?? ""), false);
    같나("다시 시험하면 lastTest 가 정상으로", [(await cp.testConnection()).ok, cp.loadSettings().lastTest?.ok], [true, true]);
    같나("열쇠가 열쇠 파일 밖으로 새지 않았다 (기록·캐시·로그·앱설정)", await 새는곳(), []);
    참인가("쿠팡 기록(로그)이 남아 있다", (await Deno.readTextFile(recordPath("쿠팡.log"))).includes("연결 성공"));
  });

  await 모래상자(async () => {
    new 가짜쿠팡().install();
    const t = await cp.testConnection();
    같나("열쇠가 없으면 시험도 안내만", [t.ok, /열쇠가 없습니다/.test(t.message), t.sample], [false, true, null]);
  });
}

async function 열쇠만시험시험() {
  구역("열쇠만 시험 (probeKeys) — 저장하지 않는다, 호출 한도는 똑같이 센다");
  const 키파일 = () => dataPath("쿠팡파트너스.json");
  const 앱설정 = () => dataPath("앱설정.json");
  const 읽기 = async (p: string) => await Deno.readTextFile(p).catch(() => null);

  await 모래상자(async () => {
    const fake = new 가짜쿠팡().install();
    fake.catalog.set("텀블러", [상품(1, "스테인리스 텀블러 500ml")]);
    const 전 = (await 파일들(dataDir())).map(([p]) => p.slice(dataDir().length));

    const ok = await cp.probeKeys(`  ${열쇠.access} `, `"${열쇠.secret}"`); // 앞뒤 공백·따옴표는 connect 처럼 걷는다
    같나("맞는 열쇠: ok · 샘플 이름·가격", [ok.ok, ok.sample], [true, { name: "스테인리스 텀블러 500ml", price: 10001 }]);
    참인가("맞는 열쇠: 한국어 안내", /열쇠가 맞습니다/.test(ok.message));
    같나("열쇠 파일·앱설정이 생기지 않는다", [await exists(키파일()), await exists(앱설정())], [false, false]);
    같나("연결·켜짐·시험 기록·입력 창 기록이 그대로", [cp.loadSettings().connected, cp.loadSettings().enabled, cp.loadSettings().lastTest, appSettings().coupangPrompted, cp.needsPrompt()],
      [false, false, null, false, true]);
    같나("남는 것은 잠금·호출 횟수·기록 한 줄뿐 (영상 기록·검색 캐시는 안 만든다)",
      (await 파일들(dataDir())).map(([p]) => p.slice(dataDir().length)).filter((p) => !전.includes(p)).sort(), ["/기록/쿠팡.log", "/쿠팡.lock", "/쿠팡호출.json"]);
    같나("호출 횟수는 센다 (검색 1회)", [cp.usage().used, fake.검색().length], [1, 1]);
    const c = fake.calls.at(-1)!;
    같나("connect 와 같은 요청 (서명이 서버에서 맞다 · query)", [c.signedOk, c.query], [true, "keyword=%ED%85%80%EB%B8%94%EB%9F%AC&limit=10"]);

    fake.access = "other-access";
    const bad = await cp.probeKeys(열쇠.access, 열쇠.secret);
    같나("틀린 열쇠: ok false · 승인 안내 · 샘플 없음", [bad.ok, /승인/.test(bad.message), bad.sample], [false, true, null]);
    같나("틀린 열쇠도 저장하지 않는다", [await exists(키파일()), await exists(앱설정())], [false, false]);
    같나("틀린 열쇠도 호출 횟수는 센다", cp.usage().used, 2);
    fake.access = 열쇠.access;

    const n0 = fake.calls.length;
    for (const [a, s] of [["", "x"], ["한글 열쇠", "x"], ["a b", "x"], ["x", ""]] as const) {
      같나(`열쇠 입력 검사 「${a}」/「${s}」: 거절하고 호출하지 않는다`, (await cp.probeKeys(a, s)).ok, false);
    }
    같나("입력이 이상하면 쿠팡을 부르지 않는다 · 횟수도 안 센다", [fake.calls.length, cp.usage().used], [n0, 2]);

    fake.queue.push({ status: 500, body: JSON.stringify({ message: `echo test-secret test-access signature=${"c".repeat(64)}` }) });
    const echo = await cp.probeKeys(열쇠.access, 열쇠.secret);
    같나("서버가 열쇠를 되받아 적어도 반환에 없다", [echo.ok, /test-secret|test-access|c{20}/.test(JSON.stringify(echo))], [false, false]);
    같나("반환값·기록(로그)·그 밖 어느 파일에도 열쇠 값이 없다 (저장한 적이 없으니 열쇠 파일도 없다)", [/test-(secret|access)/.test(JSON.stringify([ok, bad, echo])), await 새는곳()], [false, []]);
    참인가("기록에는 한 줄씩 남는다", /열쇠 시험 성공/.test(await Deno.readTextFile(recordPath("쿠팡.log"))) && /열쇠 시험 실패/.test(await Deno.readTextFile(recordPath("쿠팡.log"))));
  });

  // 이미 연결된 상태에서 다른 열쇠를 시험해도 저장된 것은 한 글자도 안 바뀐다 (계정을 바꾼 것으로 치지 않으니 캐시·기록도 그대로)
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    fake.catalog.set("텀블러", [상품(1, "텀블러 A")]);
    같나("준비: 계정 가로 연결", (await cp.connect(열쇠.access, 열쇠.secret)).ok, true);
    await cp.saveSettings({ maxLinks: 2, defaultSubId: "keep1" });
    const f = await 영상(dir, 1);
    await 고르기(f, { aiQueries: ai("텀블러") });
    const 키전 = await 읽기(키파일()), 앱전 = await 읽기(앱설정());
    const 기록전 = await 읽기(dataPath("쿠팡링크기록.json")), 캐시전 = await 읽기(dataPath("쿠팡검색캐시.json"));

    fake.access = "acc-b"; fake.secret = "sec-b"; // 서버는 이제 계정 나의 열쇠만 안다
    const b = await cp.probeKeys("acc-b", "sec-b");
    같나("다른 계정 열쇠도 시험은 된다", [b.ok, b.sample?.name], [true, "텀블러 A"]);
    const bad = await cp.probeKeys("acc-b", "틀린-secret");
    같나("틀린 열쇠는 ok false", bad.ok, false);
    같나("열쇠 파일·앱설정(coupangPrompted)·last_test 가 그대로", [await 읽기(키파일()) === 키전, await 읽기(앱설정()) === 앱전], [true, true]);
    같나("영상 기록·검색 캐시도 그대로 (계정을 바꾼 것으로 치지 않는다)", [await 읽기(dataPath("쿠팡링크기록.json")) === 기록전, await 읽기(dataPath("쿠팡검색캐시.json")) === 캐시전, cp.recordFor(f)?.status], [true, true, "붙임"]);
    같나("저장된 연결은 그대로 쓸 수 있다", [cp.loadSettings().connected, cp.loadSettings().enabled, cp.loadSettings().maxLinks, cp.loadSettings().defaultSubId], [true, true, 2, "keep1"]);
    참인가("저장된 열쇠는 계정 가 그대로다 (서버는 이제 계정 나만 아니까 testConnection 은 거절당한다)", !(await cp.testConnection()).ok);
  });

  // 한도: 똑같이 센다
  await 모래상자(async () => {
    const fake = new 가짜쿠팡().install();
    fake.catalog.set("텀블러", [상품(1, "텀블러 A")]);
    await writeJson(dataPath("쿠팡호출.json"), { search: Array.from({ length: 10 }, () => Date.now()) }, { indent: 0 });
    const r = await cp.probeKeys(열쇠.access, 열쇠.secret);
    같나("한도(검색 10회)에 닿았으면 호출하지 않는다", [r.ok, /한도/.test(r.message), r.sample, fake.calls.length], [false, true, null, 0]);
    같나("저장도 하지 않는다", [await exists(키파일()), await exists(앱설정())], [false, false]);
    await cp.saveSettings({ perHour: 20 }); // 사용자가 시간당 상한을 올렸으면 그 상한을 따른다 (connect 와 같다)
    const r2 = await cp.probeKeys(열쇠.access, 열쇠.secret);
    같나("설정한 시간당 상한을 따른다", [r2.ok, fake.검색().length, cp.usage().used], [true, 1, 11]);
    같나("saveSettings 로 만든 파일에는 열쇠가 없다 (probeKeys 가 쓴 게 아니다)", /test-(secret|access)/.test(await 읽기(키파일()) ?? ""), false);
  });
}

async function 설정시험() {
  구역("입력 창을 보여 줄 때 (needsPrompt)");
  await 모래상자(async () => {
    같나("처음(안 보여 줬고 열쇠도 없음): 띄운다", cp.needsPrompt(), true);
    await cp.markPrompted();
    같나("markPrompted 뒤: 다시 안 띄운다", cp.needsPrompt(), false);
  });
  await 모래상자(async () => {
    await 켜기();
    같나("열쇠가 있으면 안 띄운다", cp.needsPrompt(), false);
  });
  await 모래상자(async () => {
    const fake = new 가짜쿠팡().install();
    fake.catalog.set("텀블러", [상품(1, "텀블러")]);
    같나("connect 전", cp.needsPrompt(), true);
    await cp.connect(열쇠.access, 열쇠.secret);
    같나("connect 뒤: 안 띄운다", cp.needsPrompt(), false);
    await cp.disconnect();
    같나("연결을 풀어도 다시 띄우지 않는다 (스스로 푼 것이다)", cp.needsPrompt(), false);
  });

  구역("채널별 켜기·끄기 (channelOn) · 구분 코드 (subIdFor)");
  await 모래상자(async () => {
    await editChannels((d) => {
      d["채널꺼짐"] = { channel_id: "", folder: "", coupang: { on: false } };
      d["채널모드끔"] = { channel_id: "", folder: "", coupang: { mode: "off" } };
      d["채널규칙"] = { channel_id: "", folder: "", coupang: { mode: "rule", sub_id: "ab-12_x" } };
      d["채널긴코드"] = { channel_id: "", folder: "", coupang: { sub_id: "z".repeat(40) } };
      d["채널코드깨짐"] = { channel_id: "", folder: "", coupang: { sub_id: "--__" } };
      d["채널ID있음"] = { channel_id: "UC" + "x".repeat(22), folder: "", coupang: { on: false } };
    });
    await writeJson(dataPath("쿠팡파트너스.json"), { enabled: true }, { secret: true });
    같나("켜졌는데 열쇠가 없으면 꺼진 것", cp.channelOn("채널A"), false);
    await 켜기({ enabled: false });
    같나("열쇠가 있어도 전체가 꺼져 있으면 꺼진 것", cp.channelOn("채널A"), false);
    await 켜기();
    같나("전체 켜짐+열쇠: 설정 없는 채널은 켜짐", cp.channelOn("채널A"), true);
    같나("채널 coupang.on=false: 꺼짐", cp.channelOn("채널꺼짐"), false);
    같나("채널 coupang.mode=off: 꺼짐", cp.channelOn("채널모드끔"), false);
    같나("채널 mode=rule 은 켜짐", cp.channelOn("채널규칙"), true);
    같나("채널ID 로 불러도 채널 설정을 찾는다", cp.channelOn("UC" + "x".repeat(22)), false);

    같나("subIdFor: 영문·숫자만 남긴다", cp.subIdFor("채널규칙"), "ab12x");
    같나("subIdFor: 30자까지", cp.subIdFor("채널긴코드"), "z".repeat(30));
    같나("subIdFor: 설정이 없으면 빈 글", cp.subIdFor("채널A"), "");
    await cp.saveSettings({ defaultSubId: "my-code 9" });
    같나("전체 기본 구분 코드도 걸러서 저장", cp.loadSettings().defaultSubId, "mycode9");
    같나("subIdFor: 채널 값이 없으면 전체 기본", cp.subIdFor("채널A"), "mycode9");
    같나("subIdFor: 채널 값이 우선", cp.subIdFor("채널규칙"), "ab12x");
    같나("subIdFor: 채널 값이 걸러져 비면 전체 기본", cp.subIdFor("채널코드깨짐"), "mycode9");
  });

  구역("설정 저장 (saveSettings / loadSettings)");
  await 모래상자(async () => {
    같나("기본값", cp.loadSettings(), { enabled: false, mode: "auto", maxLinks: 3, perHour: 10, disclosure: cp.DEFAULT_DISCLOSURE, defaultSubId: "", connected: false, lastTest: null });
    await writeJson(dataPath("쿠팡파트너스.json"), { access_key: "k", secret_key: "s", enabled: true, 내가_적은_칸: 7 }, { secret: true });
    await cp.saveSettings({ mode: "rule", maxLinks: 9, perHour: 1000, disclosure: "  내 고지문  " });
    let s = cp.loadSettings();
    같나("모드·최대 링크(3 으로)·시간당(100 으로)·고지문", [s.mode, s.maxLinks, s.perHour, s.disclosure], ["rule", 3, 100, "내 고지문"]);
    await cp.saveSettings({ maxLinks: 0, perHour: 0, disclosure: "   ", mode: "엉뚱" as unknown as "auto" });
    s = cp.loadSettings();
    같나("0 은 1 로 · 빈 고지문은 기본 문구로 · 모르는 모드는 auto", [s.maxLinks, s.perHour, s.disclosure, s.mode], [1, 1, cp.DEFAULT_DISCLOSURE, "auto"]);
    같나("바꾸지 않은 칸(열쇠·내가 적은 칸)은 그대로", [readJsonSync<any>(dataPath("쿠팡파트너스.json"), {}).access_key, readJsonSync<any>(dataPath("쿠팡파트너스.json"), {}).내가_적은_칸], ["k", 7]);
    if (Deno.build.os !== "windows") {
      같나("저장해도 권한 600", (await Deno.stat(dataPath("쿠팡파트너스.json"))).mode! & 0o777, 0o600);
    }
    await cp.saveSettings({ enabled: false });
    같나("enabled 를 끌 수 있다", cp.loadSettings().enabled, false);
  });
}

async function 글붙이기시험() {
  구역("사람이 넣은 링크 알아보기 (hasHumanLink)");
  for (const [글, 바람] of [
    ["https://link.coupang.com/a/abcd", true], ["https://www.coupang.com/vp/products/123", true], ["coupang.com/np/search?q=a", true],
    ["https://m.coupang.com/vm/products/9", true], ["단축 https://coupa.ng/bXyZ12 입니다", true], ["HTTPS://LINK.COUPANG.COM/A/B", true],
    ["쿠팡에서 샀어요", false], ["https://notcoupang.com/x", false], ["https://www.coupangplay.com/x", false],
    ["https://example.com/?r=coupa.ngx", false], ["", false],
  ] as const) 같나(`hasHumanLink 「${글.slice(0, 40)}」`, cp.hasHumanLink(글), 바람);

  구역("블록 만들기 (buildBlock) · 설명에 붙이기 (applyBlock)");
  const links = [{ name: "상품 A", url: "https://link.coupang.com/a/aaa" }, { name: "가".repeat(50), url: "https://link.coupang.com/a/bbb" }];
  const b = cp.buildBlock(links);
  같나("블록 모양 (상품명 40자까지, 넘으면 …)", b,
    "\n🛒 영상에 나온 소재와 관련된 상품\n• 상품 A\n  https://link.coupang.com/a/aaa\n• " + "가".repeat(39) + "…\n  https://link.coupang.com/a/bbb\n\n" + cp.DEFAULT_DISCLOSURE);
  같나("링크가 없으면 블록도 없다", cp.buildBlock([]), "");
  같나("내 고지문을 쓸 수 있다", cp.buildBlock(links, "내 고지문").endsWith("\n\n내 고지문"), true);
  같나("정확히 40자인 이름은 그대로", cp.buildBlock([{ name: "나".repeat(40), url: "https://link.coupang.com/a/c" }]).includes("• " + "나".repeat(40) + "\n"), true);
  같나("이름의 줄바꿈·꺾쇠는 정리한다", cp.buildBlock([{ name: "A\n<b>B</b>", url: "https://link.coupang.com/a/c" }]).includes("• A bB/b\n"), true);

  같나("설명 끝에 빈 줄 하나를 두고 붙는다", cp.applyBlock("설명 글", b), "설명 글\n\n" + b.slice(1));
  같나("설명 끝 공백·줄바꿈은 다듬어서 붙인다", cp.applyBlock("설명 글\n\n\n  ", b), "설명 글\n\n" + b.slice(1));
  같나("설명이 비면 앞 빈 줄 없이 블록만", cp.applyBlock("", b), b.slice(1));
  같나("블록이 비면 설명 그대로", cp.applyBlock("설명", ""), "설명");
  같나("두 번 붙이지 않는다", cp.applyBlock(cp.applyBlock("설명", b), b), cp.applyBlock("설명", b));
  const 긴 = cp.applyBlock("가".repeat(6000), b);
  같나("5000자(코드포인트) 딱 맞게", Array.from(긴).length, 5000);
  같나("블록은 온전히 끝에 붙는다", 긴.endsWith(b.slice(1)), true);
  같나("줄어든 것은 설명 쪽이다", 긴.startsWith("가".repeat(4000)) && !긴.slice(0, 4000).includes("🛒"), true);
  const 이모지 = cp.applyBlock("😀".repeat(5000), b);
  같나("이모지(서로게이트 쌍)를 반으로 가르지 않는다", /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(이모지), false);
  같나("이모지 설명도 5000자(코드포인트) 이내이고 블록은 온전", [Array.from(이모지).length <= 5000, 이모지.endsWith(b.slice(1))], [true, true]);
  같나("한도를 줄이면 그에 맞춘다", Array.from(cp.applyBlock("가".repeat(900), b, 400)).length <= 400 && cp.applyBlock("가".repeat(900), b, 400).endsWith(b.slice(1)), true);
  같나("블록이 한도보다 길면 붙이지 않고 설명만 자른다", cp.applyBlock("가".repeat(100), b, 50), "가".repeat(50));
}

async function 고르기시험() {
  구역("영상 고르기 — AI 가 검색어를 준 경우 · 기록 재사용 · force");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    await editChannels((d) => { d["채널A"] = { channel_id: "", folder: "", coupang: { sub_id: "ch1" } }; });
    fake.catalog.set("텀블러", [상품(1, "스탠리 텀블러 591ml"), 상품(2, "보온 보냉 텀블러 500ml"), 상품(3, "전혀 상관 없는 선풍기")]);
    const f1 = await 영상(dir, 1);
    const 같은입력 = { title: "텀블러 추천", desc: "집에서 쓰는 텀블러", tags: ["텀블러"], aiQueries: ai("텀블러") };

    const r = await 고르기(f1, 같은입력);
    같나("관련 상품이 있으면 붙임", r.status, "붙임");
    같나("관련 없는 상품은 뺀다 (링크 2개)", r.links.map((l) => l.name), ["스탠리 텀블러 591ml", "보온 보냉 텀블러 500ml"]);
    참인가("링크는 쿠팡이 준 추적 주소", r.links.every((l) => l.url.startsWith("https://link.coupang.com/")));
    같나("가격이 담긴다", r.links[0].price, 10001);
    같나("검색어가 기록된다", r.queries, ["텀블러"]);
    참인가("블록에 상품명·링크·고지문", r.block.includes("• 스탠리 텀블러 591ml") && r.block.includes(r.links[0].url) && r.block.includes(cp.DEFAULT_DISCLOSURE));
    같나("처음 고른 것은 cached false", r.cached, false);
    참인가("시각(at)은 벽시계 글자", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(r.at));
    같나("검색은 1회", fake.검색().length, 1);
    같나("subId 가 요청에 실렸다", fake.검색()[0].subId, "ch1");
    같나("요청 query = 시험 벡터와 같은 꼴", fake.검색()[0].query, "keyword=%ED%85%80%EB%B8%94%EB%9F%AC&limit=10&subId=ch1");
    참인가("subId 가 링크에 들어 있다", r.links[0].url.includes("subid=ch1"));
    참인가("모든 요청의 서명이 서버에서 맞았다 · 신호가 실렸다", fake.calls.every((c) => c.signedOk && c.fresh && c.hasSignal));
    같나("recordFor: 같은 결과", [cp.recordFor(f1)?.status, cp.recordFor(f1)?.links.length, cp.recordFor(f1)?.block === r.block], ["붙임", 2, true]);
    같나("기록이 없는 영상은 null", cp.recordFor(await 영상(dir, 99)), null);

    const r2 = await 고르기(f1, { ...같은입력, aiQueries: ai("전혀 다른 검색어") });
    같나("같은 영상 재호출: 기록 재사용 (AI 가 다른 답을 줘도 호출 0건)", [r2.cached, r2.status, fake.검색().length], [true, "붙임", 1]);
    같나("재사용해도 같은 링크", r2.links, r.links);
    const r3 = await 고르기(f1, { ...같은입력, force: true });
    같나("force: 다시 검색한다 (캐시도 건너뛴다)", [r3.cached, r3.status, fake.검색().length], [false, "붙임", 2]);

    await cp.attachVideoId(f1, "vid123");
    같나("attachVideoId", cp.recordFor(f1)?.videoId, "vid123");
    await 고르기(f1, { ...같은입력, force: true });
    같나("다시 골라도 올린 영상 id 는 남는다", cp.recordFor(f1)?.videoId, "vid123");
    같나("기록이 없는 영상에 attachVideoId 를 해도 아무 일 없다", await cp.attachVideoId(await 영상(dir, 98), "v"), undefined);
    같나("clearRecord: 지웠다", [await cp.clearRecord(f1), cp.recordFor(f1)], [true, null]);
    같나("clearRecord: 이미 없으면 false", await cp.clearRecord(f1), false);
    같나("지운 뒤엔 다시 고른다 (캐시된 검색 결과를 쓰니 호출은 늘지 않는다)", [(await 고르기(f1, 같은입력)).cached, fake.검색().length], [false, 3]);
  });

  구역("영상 고르기 — 관련 상품 없음 · 뉴스 · 사람이 넣은 링크");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    // 같은 영상은 파일을 한 번만 만든다 — 다시 쓰면 수정시각이 바뀌어 다른 영상이 된다
    const [f1, f2, f3, f4, f5, f6, f7] = [await 영상(dir, 1), await 영상(dir, 2), await 영상(dir, 3), await 영상(dir, 4), await 영상(dir, 5), await 영상(dir, 6), await 영상(dir, 7)];

    const a = await 고르기(f1, { aiQueries: ai() });
    같나("AI 가 빈 목록이면 없음 (확정) · 호출 0건", [a.status, a.queries, fake.calls.length], ["없음", [], 0]);
    const a2 = await 고르기(f1, { aiQueries: ai("텀블러") });
    같나("없음도 기록이 이긴다 (재호출 0건)", [a2.cached, a2.status, fake.calls.length], [true, "없음", 0]);

    const n1 = await 고르기(f2, { title: "속보: 대통령 발언 논란", aiQueries: async () => null });
    같나("AI 못 씀 + 뉴스 제목 → 없음 · 호출 0건", [n1.status, fake.calls.length, /뉴스·정치·사건사고/.test(n1.why)], ["없음", 0, true]);
    const n2 = await 고르기(f3, { title: "일상", tags: ["교통사고", "블랙박스"], aiQueries: async () => null });
    같나("태그의 사건사고 낱말도 본다", [n2.status, fake.calls.length], ["없음", 0]);
    fake.catalog.set("텀블러", [상품(1, "텀블러 하나"), 상품(2, "텀블러 둘"), 상품(3, "텀블러 셋")]);
    const n3 = await 고르기(f4, { title: "오늘 사고 싶은 텀블러", tags: ["텀블러"], aiQueries: async () => null });
    같나("「사고 싶은」(사다)은 뉴스 낱말로 보지 않는다 (규칙으로 검색까지 가서 붙임)", [n3.status, fake.검색().length], ["붙임", 1]);

    const 전 = fake.calls.length;
    const h = await 고르기(f5, { desc: "제품은 https://link.coupang.com/a/abc 에서", aiQueries: ai("텀블러") });
    같나("사람이 넣은 링크 (고지문 없음) → 사람이넣음", [h.status, h.links, h.queries], ["사람이넣음", [], []]);
    같나("고지문 한 줄만 붙인다 (빈 줄 + 고지문)", h.block, "\n" + cp.DEFAULT_DISCLOSURE);
    같나("자동 검색은 안 한다 (호출 0건)", fake.calls.length - 전, 0);
    같나("recordFor 에도 남는다", cp.recordFor(f5)?.status, "사람이넣음");
    const h2 = await 고르기(f6, { desc: `https://coupa.ng/abcd\n\n${cp.DEFAULT_DISCLOSURE}`, aiQueries: ai("텀블러") });
    같나("고지문이 이미 있으면 아무것도 안 붙인다", [h2.status, h2.block], ["사람이넣음", ""]);
    const h3 = await 고르기(f5, { desc: "링크를 지웠어요", aiQueries: ai() });
    같나("링크를 지우면 사람이넣음 기록에 묶이지 않고 새로 정한다", h3.status, "없음");
    const u = await cp.forUpload(입력(f7, { desc: "내 글 https://www.coupang.com/vp/products/5", aiQueries: ai("텀블러") }));
    같나("forUpload: 사람이 넣은 링크 + 고지문 없음 → 고지문만 끝에", u.desc, `내 글 https://www.coupang.com/vp/products/5\n\n${cp.DEFAULT_DISCLOSURE}`);
  });

  구역("영상 고르기 — 규칙 모드 (상품명이 3개 이상 일치해야 인정)");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기({ mode: "rule" });
    const 안부름 = async () => { throw new Error("규칙 모드에서는 AI 를 부르면 안 된다"); };
    fake.catalog.set("텀블러", [상품(1, "텀블러 A"), 상품(2, "텀블러 B"), 상품(3, "선풍기"), 상품(4, "머그컵"), 상품(5, "물병")]);
    const r = await 고르기(await 영상(dir, 1), { title: "텀블러 세척 방법", tags: ["텀블러"], aiQueries: 안부름 });
    같나("상품명 일치가 3개 미만(2개)이면 없음", [r.status, r.queries, fake.검색().length], ["없음", ["텀블러"], 1]);
    참인가("까닭에 일치한 개수가 있다", /2개/.test(r.why));

    fake.catalog.set("머그컵", [상품(11, "머그컵 하나"), 상품(12, "머그컵 둘"), 상품(13, "머그컵 셋"), 상품(14, "머그컵 넷"), 상품(15, "접시")]);
    const r2 = await 고르기(await 영상(dir, 2), { title: "머그컵 후기", tags: [], aiQueries: 안부름 });
    같나("3개 이상 일치하면 붙임 (최대 3개)", [r2.status, r2.links.length, r2.queries], ["붙임", 3, ["머그컵"]]);
    같나("낱말 후보 하나로 검색 1회뿐", fake.검색().length, 2);

    fake.catalog.set("가방", [상품(21, "가방 가"), 상품(22, "가방 나"), 상품(23, "가방 다")]);
    const r3 = await 고르기(await 영상(dir, 3), { title: "가방을 샀어요", tags: ["일상", "추천"], aiQueries: 안부름 });
    같나("조사(을)를 떼고 불용어(일상·추천)는 건너뛴다", [r3.status, r3.queries], ["붙임", ["가방"]]);
    const r4 = await 고르기(await 영상(dir, 4), { title: "2024 브이로그 쇼츠", tags: ["일상", "shorts"], desc: "", aiQueries: 안부름 });
    같나("쓸 낱말이 하나도 없으면 없음 (검색 안 함)", [r4.status, fake.검색().length], ["없음", 3]);

    await cp.saveSettings({ mode: "auto" });
    await editChannels((d) => { d["채널규칙"] = { channel_id: "", folder: "", coupang: { mode: "rule" } }; });
    const r5 = await 고르기(await 영상(dir, 5), { channel: "채널규칙", title: "머그컵 후기", tags: [], aiQueries: 안부름 });
    같나("채널 mode=rule 이면 전체가 auto 여도 규칙으로 (AI 안 부름)", r5.status, "붙임");
  });

  구역("영상 고르기 — 시간당 호출 한도 (같은 시간 11번째는 건너뜀)");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기({ per_hour: 10 });
    const T0 = new Date();
    const 파일: string[] = [];
    for (let i = 1; i <= 12; i++) {
      파일.push(await 영상(dir, i));
      fake.catalog.set(`상품${i}`, [상품(100 + i, `상품${i} 본품`)]);
    }
    for (let i = 0; i < 10; i++) {
      const r = await 고르기(파일[i], { now: T0, aiQueries: ai(`상품${i + 1}`) });
      if (r.status !== "붙임") 참인가(`한도 안의 ${i + 1}번째는 붙임`, false);
    }
    같나("한도 안에서는 검색 10회", fake.검색().length, 10);
    같나("usage: 10/10 · 풀릴 때까지 60분", cp.usage(T0), { used: 10, limit: 10, resetMin: 60 });
    같나("usage: 30분 뒤엔 남은 30분", cp.usage(분뒤(T0, 30)), { used: 10, limit: 10, resetMin: 30 });
    같나("usage: 61분 뒤엔 비었다", cp.usage(분뒤(T0, 61)), { used: 0, limit: 10, resetMin: 0 });

    const r11 = await 고르기(파일[10], { now: T0, aiQueries: ai("상품11") });
    같나("11번째: 건너뜀", r11.status, "건너뜀");
    참인가("까닭에 한도와 남은 분", /호출 한도/.test(r11.why) && /60분/.test(r11.why));
    같나("호출은 나가지 않았다", fake.검색().length, 10);
    같나("건너뜀도 기록된다", cp.recordFor(파일[10])?.status, "건너뜀");
    const w = cp.warnings(T0);
    같나("문제 목록에 오른다 (노랑·채널·건수)", [w.length, w[0]?.level, w[0]?.kind, w[0]?.channel, /1건/.test(w[0]?.what ?? "")], [1, "yellow", "coupang", "채널A", true]);

    const r11b = await 고르기(파일[10], { now: 분뒤(T0, 10), aiQueries: ai("상품11") });
    같나("30분 안에는 다시 시도하지 않는다 (기록 그대로)", [r11b.cached, r11b.status, fake.검색().length], [true, "건너뜀", 10]);
    const r11c = await 고르기(파일[10], { now: 분뒤(T0, 31), aiQueries: ai("상품11") });
    참인가("31분 뒤엔 다시 시도하지만 아직 한도 (남은 29분)", !r11c.cached && r11c.status === "건너뜀" && /29분/.test(r11c.why));
    같나("이때도 호출은 나가지 않았다", fake.검색().length, 10);
    const r11d = await 고르기(파일[10], { now: 분뒤(T0, 65), aiQueries: ai("상품11") });
    같나("한 시간이 지나면 풀려서 붙임", [r11d.status, fake.검색().length, cp.usage(분뒤(T0, 65)).used], ["붙임", 11, 1]);
    같나("성공하면 건너뜀 경고가 사라진다", cp.warnings(분뒤(T0, 65)).length, 0);
  });

  구역("영상 고르기 — 동시에 여러 편이 올라가도 한도를 넘지 않는다");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기({ per_hour: 10 });
    const T = new Date();
    const 파일: string[] = [];
    for (let i = 1; i <= 12; i++) {
      파일.push(await 영상(dir, i));
      fake.catalog.set(`상품${i}`, [상품(200 + i, `상품${i} 본품`)]);
    }
    const rs = await Promise.all(파일.map((f, i) => 고르기(f, { now: T, aiQueries: ai(`상품${i + 1}`) })));
    같나("동시에 12편: 검색은 정확히 10회", fake.검색().length, 10);
    같나("붙임 10 · 건너뜀 2", [rs.filter((r) => r.status === "붙임").length, rs.filter((r) => r.status === "건너뜀").length], [10, 2]);
    같나("호출 시각 기록도 10건", cp.usage(T).used, 10);

    const g = await 영상(dir, 50);
    fake.catalog.set("같은영상", [상품(300, "같은영상 본품")]);
    await cp.saveSettings({ perHour: 100 });
    const [x, y] = await Promise.all([고르기(g, { aiQueries: ai("같은영상") }), 고르기(g, { aiQueries: ai("같은영상") })]);
    같나("같은 영상을 동시에 둘이 골라도 검색은 한 번", [fake.검색().filter((c) => c.keyword === "같은영상").length, x.status, y.status, y.cached], [1, "붙임", "붙임", true]);
  });

  구역("영상 고르기 — 오류는 던지지 않고 건너뜀 (500 · 잘못된 JSON · 시간 초과 · 연결 끊김 · 401 · 429)");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    let n = 0;
    const 시도 = async (강제: 강제[], 바람: RegExp, 이름: string) => {
      n++;
      const f = await 영상(dir, 100 + n);
      fake.catalog.set(`오류${n}`, [상품(400 + n, `오류${n} 상품`)]);
      fake.queue.push(...강제);
      let r: Awaited<ReturnType<typeof cp.pickForVideo>> | null = null;
      try { r = await 고르기(f, { aiQueries: ai(`오류${n}`) }); } catch (e) { 참인가(`${이름}: 던지면 안 된다 — ${e}`, false); }
      if (!r) return;
      같나(`${이름}: 건너뜀`, r.status, "건너뜀");
      참인가(`${이름}: 까닭이 한국어로 (${r.why.slice(0, 50)})`, 바람.test(r.why));
      같나(`${이름}: 링크 없음 · 블록 없음`, [r.links, r.block], [[], ""]);
      같나(`${이름}: 기록됨`, cp.recordFor(f)?.status, "건너뜀");
    };
    await 시도([{ status: 500, body: "서버 오류" }], /HTTP 500/, "HTTP 500");
    await 시도([{ status: 200, body: "<html>점검 중</html>" }], /알아볼 수 없는 답/, "JSON 아님");
    await 시도([{ status: 200, body: JSON.stringify({ rCode: "400", rMessage: "잘못된 요청" }) }], /코드 400/, "rCode 오류");
    await 시도([{ status: 200, body: JSON.stringify({ hello: 1 }) }], /알아볼 수 없는 답/, "결과 칸 없음");
    await 시도([{ throws: new DOMException("The signal has been aborted", "TimeoutError") }], /15초 안에 답하지/, "시간 초과(던져진 TimeoutError)");
    await 시도([{ throws: new TypeError("connection refused") }], /연결하지 못했습니다/, "연결 끊김");
    await 시도([{ status: 429, body: "{}" }], /호출 한도/, "HTTP 429");
    await 시도([{ status: 403, body: "{}" }], /최종 승인/, "HTTP 403");
    await 시도([{ status: 200, body: JSON.stringify({ rCode: "401", rMessage: "x" }) }], /최종 승인/, "rCode 401");

    cp.setTimeoutForTest(40);
    try { await 시도([{ hang: true }], /답하지 않았습니다/, "진짜 시간 초과(응답이 안 옴)"); } finally { cp.setTimeoutForTest(null); }

    fake.access = "other-access";
    await 시도([], /최종 승인/, "열쇠가 틀림(서버가 401)");
    같나("마지막 오류가 열쇠 파일에 남는다 (채널·파일 이름·까닭)",
      (({ channel, file, why }) => [channel, /^영상\d+\.mp4$/.test(file), /승인/.test(why)])(readJsonSync<any>(dataPath("쿠팡파트너스.json"), {}).last_error), ["채널A", true, true]);
    같나("오류 글·기록에 열쇠가 새지 않았다", await 새는곳(), []);
    const w = cp.warnings();
    같나("건너뜀 경고는 채널별로 한 줄", [w.length, w[0]?.channel, /[0-9]+건/.test(w[0]?.what ?? "")], [1, "채널A", true]);
  });

  구역("영상 고르기 — 오류 글에 열쇠가 새지 않는다 · 예상 못한 오류도 던지지 않는다");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    fake.catalog.set("텀블러", [상품(1, "텀블러")]);
    fake.queue.push({ status: 500, body: JSON.stringify({ message: "Authorization CEA access-key=test-access secret test-secret signature=" + "b".repeat(64) }) });
    const r = await 고르기(await 영상(dir, 1), { aiQueries: ai("텀블러") });
    같나("서버가 요청을 되받아 적어도 까닭에 열쇠·서명이 없다", [r.status, /test-secret|test-access|b{20}/.test(r.why)], ["건너뜀", false]);
    fake.queue.push({ throws: new TypeError("connect failed for test-secret") });
    const r2 = await 고르기(await 영상(dir, 2), { aiQueries: ai("텀블러") });
    같나("연결 오류 글에도 열쇠가 없다", /test-secret/.test(r2.why), false);

    const 터짐 = { toString() { throw new Error("뜻밖의 오류"); } } as unknown as string;
    const r3 = await 고르기(await 영상(dir, 3), { aiQueries: async () => ({ queries: [터짐] }) });
    같나("우리 쪽 예상 못한 오류도 던지지 않고 건너뜀", [r3.status, /예상 못한 오류/.test(r3.why)], ["건너뜀", true]);
    const u = await cp.forUpload(입력(await 영상(dir, 4), { desc: "원래 설명", aiQueries: async () => ({ queries: [터짐] }) }));
    같나("forUpload: 그래도 설명은 그대로", [u.desc, u.pick?.status], ["원래 설명", "건너뜀"]);
    const u2 = await cp.forUpload({ channel: "채널A", file: await 영상(dir, 5), title: null, desc: "설명", tags: undefined } as unknown as cp.PickInput);
    같나("forUpload: 이상한 입력(제목 null · 태그 없음)에도 던지지 않는다", u2.desc.startsWith("설명"), true);
    같나("로그·기록에 열쇠가 없다", await 새는곳(), []);
  });

  구역("영상 고르기 — 추적 링크가 아닌 상품은 딥링크로");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    await editChannels((d) => { d["채널A"] = { channel_id: "", folder: "", coupang: { sub_id: "ch1" } }; });
    fake.catalog.set("보온병", [
      상품(11, "보온병 대용량", { productUrl: "https://www.coupang.com/vp/products/11" }),
      상품(12, "보온병 소형"),
      상품(13, "보온병 휴대용", { productUrl: "https://example.com/phish" }),
    ]);
    const r = await 고르기(await 영상(dir, 1), { aiQueries: ai("보온병") });
    같나("딥링크는 한 번에 묶어 1회", fake.딥링크().length, 1);
    같나("딥링크 몸 (추적 링크가 아닌 두 상품 · subId)", fake.딥링크()[0].body, { coupangUrls: ["https://www.coupang.com/vp/products/11", "https://www.coupang.com/vp/products/13"], subId: "ch1" });
    같나("딥링크 서명은 query 없이 (서버가 맞다고 봤다)", [fake.딥링크()[0].query, fake.딥링크()[0].signedOk, fake.딥링크()[0].method], ["", true, "POST"]);
    같나("차례를 지키고 딥링크 결과를 쓴다", r.links.map((l) => l.url), [
      "https://link.coupang.com/a/dl11", "https://link.coupang.com/re/AFFSDP?lptag=AF0&subid=ch1&itemId=12", "https://link.coupang.com/a/dl13",
    ]);
    참인가("엉뚱한 주소가 설명에 실리지 않는다", !r.block.includes("example.com"));

    fake.catalog.set("차량용품", [상품(31, "차량용품 하나", { productUrl: "https://www.coupang.com/vp/products/31" })]);
    fake.queue.push({}, { status: 500, body: "{}" }); // 검색은 정상, 딥링크는 실패
    const r2 = await 고르기(await 영상(dir, 2), { aiQueries: ai("차량용품") });
    같나("딥링크가 실패하고 남은 링크도 없으면 건너뜀", [r2.status, /HTTP 500/.test(r2.why)], ["건너뜀", true]);

    fake.catalog.set("충전기", [상품(41, "충전기 하나"), 상품(42, "충전기 둘", { productUrl: "https://www.coupang.com/vp/products/42" })]);
    fake.queue.push({}, { status: 500, body: "{}" });
    const r3 = await 고르기(await 영상(dir, 3), { aiQueries: ai("충전기") });
    같나("딥링크가 실패한 상품만 빠지고 나머지는 붙는다", [r3.status, r3.links.map((l) => l.name)], ["붙임", ["충전기 하나"]]);
  });

  구역("영상 고르기 — 관련도 · 중복 제거 · 최대 링크 수 · 검색어 둘");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    fake.catalog.set("무선 이어폰", [
      상품(21, "무선 이어폰 블루투스 5.3"),
      상품(21, "무선 이어폰 블루투스 5.3 (같은 상품ID)"),
      상품(22, "무선 이어폰 블루투스 5.3 화이트"),
      상품(23, "게이밍 이어폰 노이즈캔슬링"),
      상품(24, "스마트폰 케이스"),
      상품(25, "무선 청소기 이어폰?"),
    ]);
    const r = await 고르기(await 영상(dir, 1), { aiQueries: ai("무선 이어폰") });
    같나("관련 없는 것·같은 ID·거의 같은 이름을 빼고 3개", r.links.map((l) => l.name), ["무선 이어폰 블루투스 5.3", "게이밍 이어폰 노이즈캔슬링", "무선 청소기 이어폰?"]);

    await cp.saveSettings({ maxLinks: 1 });
    const r1 = await 고르기(await 영상(dir, 2), { aiQueries: ai("무선 이어폰") });
    같나("최대 링크 수 1", [r1.links.length, fake.검색().length], [1, 1]);
    await cp.saveSettings({ maxLinks: 3 });

    fake.catalog.set("키보드", [상품(31, "무선 키보드 <script>x</script>\n가짜 줄 • 가짜")]);
    const rk = await 고르기(await 영상(dir, 3), { aiQueries: ai("키보드") });
    참인가("상품명의 꺾쇠·줄바꿈이 정리된다", rk.links.length === 1 && !/[<>\n]/.test(rk.links[0].name));
    같나("블록은 상품 한 건에 두 줄", rk.block.split("\n• ").length - 1, 1);

    fake.catalog.set("텀블러", [상품(41, "텀블러 A"), 상품(42, "텀블러 B")]);
    fake.catalog.set("텀블러 세척솔", [상품(43, "텀블러 세척솔 C"), 상품(44, "텀블러 세척솔 D")]);
    const n0 = fake.검색().length;
    const r2 = await 고르기(await 영상(dir, 4), { aiQueries: ai("텀블러", "텀블러 세척솔", "세 번째 검색어") });
    같나("검색어가 셋이어도 검색은 최대 2회", fake.검색().length - n0, 2);
    같나("검색어마다 번갈아 한 개씩", r2.links.map((l) => l.name), ["텀블러 A", "텀블러 세척솔 C", "텀블러 B"]);
    같나("기록된 검색어는 실제로 검색한 둘", r2.queries, ["텀블러", "텀블러 세척솔"]);

    fake.catalog.set("It's 컵", [상품(51, "It's 컵 세트")]);
    const rq = await 고르기(await 영상(dir, 5), { aiQueries: ai("It's 컵") });
    같나("작은따옴표가 든 검색어도 서명이 맞는다 (보낸 글자 = 서명한 글자)", [rq.status, fake.검색().at(-1)!.signedOk, fake.검색().at(-1)!.query.includes("It%27s")], ["붙임", true, true]);
  });

  구역("영상 고르기 — 둘째 검색이 한도로 막혀도 첫째 결과로 붙인다");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기({ per_hour: 1 });
    fake.catalog.set("머그컵", [상품(61, "머그컵 하나")]);
    const rp = await 고르기(await 영상(dir, 6), { aiQueries: ai("머그컵", "머그컵 뚜껑") });
    같나("둘째 검색이 한도로 막혀도 첫째 결과로 붙인다 (까닭은 남긴다)", [rp.status, rp.queries, /일부 검색은 건너뜀/.test(rp.why), fake.검색().length], ["붙임", ["머그컵"], true, 1]);
  });

  구역("영상 고르기 — 검색 캐시 24시간 · 건너뜀은 30분 뒤 재시도");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    await editChannels((d) => {
      d["채널A"] = { channel_id: "", folder: "", coupang: { sub_id: "ch1" } };
      d["채널B"] = { channel_id: "", folder: "", coupang: { sub_id: "ch2" } };
    });
    fake.catalog.set("텀블러", [상품(1, "텀블러 A"), 상품(2, "텀블러 B")]);
    const T = new Date();
    const a = await 고르기(await 영상(dir, 1), { now: T, aiQueries: ai("텀블러") });
    const b = await 고르기(await 영상(dir, 2), { now: T, aiQueries: ai("텀블러") });
    같나("다른 영상이 같은 키워드를 쓰면 검색 캐시를 쓴다", [a.status, b.status, fake.검색().length], ["붙임", "붙임", 1]);
    await 고르기(await 영상(dir, 3), { now: 분뒤(T, 23 * 60), aiQueries: ai("텀블러") });
    같나("23시간 뒤에도 캐시", fake.검색().length, 1);
    await 고르기(await 영상(dir, 4), { now: 분뒤(T, 25 * 60), aiQueries: ai("텀블러") });
    같나("25시간 뒤엔 다시 검색", fake.검색().length, 2);
    const c = await 고르기(await 영상(dir, 5), { channel: "채널B", now: 분뒤(T, 25 * 60 + 1), aiQueries: ai("텀블러") });
    같나("subId 가 다르면 캐시를 따로 쓴다 (링크에 들어가는 구분 코드가 달라서)", [fake.검색().length, fake.검색().at(-1)!.subId, c.links[0].url.includes("subid=ch2")], [3, "ch2", true]);

    fake.catalog.set("머그컵", [상품(11, "머그컵 A")]);
    const f = await 영상(dir, 6);
    fake.queue.push({ status: 500, body: "{}" });
    const x = await 고르기(f, { now: T, aiQueries: ai("머그컵") });
    const 호출1 = fake.검색().length;
    const y = await 고르기(f, { now: 분뒤(T, 10), aiQueries: ai("머그컵") });
    같나("실패는 30분 안에 다시 시도하지 않는다", [x.status, y.cached, y.status, fake.검색().length], ["건너뜀", true, "건너뜀", 호출1]);
    const z = await 고르기(f, { now: 분뒤(T, 31), aiQueries: ai("머그컵") });
    같나("30분이 지나면 다시 시도해서 성공", [z.cached, z.status, fake.검색().length], [false, "붙임", 호출1 + 1]);
  });

  구역("영상 고르기 — 꺼짐 · 열쇠 없음 · 채널 끔 (호출도 기록도 없다)");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await editChannels((d) => { d["채널끔"] = { channel_id: "", folder: "", coupang: { on: false } }; });
    const f = await 영상(dir, 1);
    const 확인 = async (이름: string, ch = "채널A") => {
      const r = await 고르기(f, { channel: ch, aiQueries: ai("텀블러") });
      같나(`${이름}: 건너뜀 · 호출 0건 · 기록 없음`, [r.status, fake.calls.length, cp.recordFor(f)], ["건너뜀", 0, null]);
      return r;
    };
    참인가("열쇠도 설정도 없음: 까닭", /꺼져/.test((await 확인("처음 상태")).why));
    await writeJson(dataPath("쿠팡파트너스.json"), { enabled: true }, { secret: true });
    참인가("켜졌는데 열쇠 없음: 까닭", /열쇠가 없습니다/.test((await 확인("열쇠 없음")).why));
    await 켜기({ enabled: false });
    await 확인("전체 꺼짐");
    await 켜기();
    참인가("채널 끔: 까닭", /이 채널/.test((await 확인("채널 끔", "채널끔")).why));
    같나("forUpload: 꺼진 채널은 설명 그대로 · pick null", await cp.forUpload(입력(f, { channel: "채널끔", desc: "그대로", aiQueries: ai("텀블러") })), { desc: "그대로", pick: null });
  });

  구역("올리기 직전 (forUpload) — 설명 끝에 블록");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    await 켜기();
    fake.catalog.set("텀블러", [상품(1, "텀블러 A"), 상품(2, "텀블러 B")]);
    const f = await 영상(dir, 1);
    const u = await cp.forUpload(입력(f, { desc: "원래 설명\n\n#태그", aiQueries: ai("텀블러") }));
    같나("성공: 설명 끝에 블록이 붙는다", [u.pick?.status, u.desc.startsWith("원래 설명\n\n#태그\n\n🛒 영상에 나온 소재와 관련된 상품\n• 텀블러 A\n"), u.desc.endsWith(cp.DEFAULT_DISCLOSURE)], ["붙임", true, true]);
    같나("블록 앞은 빈 줄 하나", u.desc.includes("#태그\n\n🛒") && !u.desc.includes("\n\n\n"), true);
    const u2 = await cp.forUpload(입력(f, { desc: "원래 설명\n\n#태그", aiQueries: ai("다른검색어") }));
    같나("같은 영상은 기록을 재사용한다 (같은 글)", [u2.desc, u2.pick?.status], [u.desc, "붙임"]);
    fake.queue.push({ status: 500, body: "{}" });
    fake.catalog.set("머그컵", [상품(11, "머그컵")]);
    const u3 = await cp.forUpload(입력(await 영상(dir, 2), { desc: "그대로 올라가야 함", aiQueries: ai("머그컵") }));
    같나("쿠팡이 실패해도 설명은 그대로 (fail-open)", [u3.desc, u3.pick?.status], ["그대로 올라가야 함", "건너뜀"]);
    const u4 = await cp.forUpload(입력(await 영상(dir, 3), { desc: "AI 가 던져도", aiQueries: async () => { throw new Error("AI 오류"); }, title: "속보 뉴스" }));
    같나("AI 가 던지면 규칙으로 (뉴스 제목이면 없음) · 설명 그대로", [u4.desc, u4.pick?.status], ["AI 가 던져도", "없음"]);
    await cp.saveSettings({ disclosure: "내 고지문입니다" });
    const u5 = await cp.forUpload(입력(f, { desc: "원래 설명\n\n#태그", aiQueries: ai("텀블러") }));
    같나("고지문을 고치면 기록을 재사용해도 새 고지문이 붙는다", [u5.pick?.status, u5.desc.endsWith("\n\n내 고지문입니다")], ["붙임", true]);
  });
}

async function 문제목록시험() {
  구역("문제 목록 (warnings)");
  await 모래상자(async (dir) => {
    같나("아무것도 안 켰으면 경고 없음", cp.warnings(), []);
    await writeJson(dataPath("쿠팡파트너스.json"), { enabled: true }, { secret: true });
    const w = cp.warnings();
    같나("켜졌는데 열쇠가 없으면 노랑 경고 하나", [w.length, w[0]?.level, w[0]?.kind, w[0]?.channel, w[0]?.fix, w[0]?.auto], [1, "yellow", "coupang", "", null, false]);
    참인가("경고 글", /열쇠가 없습니다/.test(w[0].what) && w[0].why.length > 0);
    await writeJson(dataPath("쿠팡파트너스.json"), { enabled: false }, { secret: true });
    같나("꺼져 있으면 경고 없음", cp.warnings(), []);

    const fake = new 가짜쿠팡().install();
    await 켜기();
    const T = new Date();
    fake.queue.push({ status: 500, body: "{}" }, { status: 500, body: "{}" });
    await 고르기(await 영상(dir, 1), { now: T, aiQueries: ai("가") });
    await 고르기(await 영상(dir, 2), { now: T, channel: "채널B", aiQueries: ai("나") });
    const ws = cp.warnings(T);
    같나("건너뛴 영상은 채널별로 한 줄씩", ws.map((x) => x.channel).sort(), ["채널A", "채널B"]);
    참인가("건너뜀 경고에 건수와 까닭", /1건/.test(ws[0].what) && /HTTP 500/.test(ws[0].why));
    같나("23시간 뒤에도 보인다", cp.warnings(분뒤(T, 23 * 60)).length, 2);
    같나("25시간 뒤엔 사라진다", cp.warnings(분뒤(T, 25 * 60)).length, 0);
  });
}

async function 계정바꾸기시험() {
  구역("해제 · 다른 계정으로 바꾸기 — 옛 계정의 추적 링크를 비운다");
  await 모래상자(async (dir) => {
    const fake = new 가짜쿠팡().install();
    fake.catalog.set("텀블러", [상품(1, "텀블러 A")]);
    fake.access = "acc-a1"; fake.secret = "sec-a1";
    같나("계정 가: 연결", (await cp.connect("acc-a1", "sec-a1")).ok, true);
    await cp.saveSettings({ maxLinks: 2, defaultSubId: "keep1" });

    const 올림 = await 영상(dir, 1), 안올림 = await 영상(dir, 2), 없음 = await 영상(dir, 3);
    await 고르기(올림, { aiQueries: ai("텀블러") });
    await cp.attachVideoId(올림, "vidA");
    await 고르기(안올림, { aiQueries: ai("텀블러") });
    await 고르기(없음, { aiQueries: ai() });
    같나("준비: 붙임 2 · 없음 1", [올림, 안올림, 없음].map((f) => cp.recordFor(f)?.status), ["붙임", "붙임", "없음"]);

    await cp.connect("acc-a1", "sec-a1");
    같나("같은 계정으로 다시 연결하면 아무것도 안 지운다", [올림, 안올림, 없음].map((f) => cp.recordFor(f)?.status), ["붙임", "붙임", "없음"]);

    fake.access = "acc-b"; fake.secret = "sec-b";
    같나("계정 나: 연결", (await cp.connect("acc-b", "sec-b")).ok, true);
    같나("옛 계정의 링크가 든 기록(아직 안 올린 영상)은 비운다", cp.recordFor(안올림), null);
    같나("이미 올린 영상 기록과 「없음」 기록은 남긴다", [cp.recordFor(올림)?.videoId, cp.recordFor(없음)?.status], ["vidA", "없음"]);
    const 전 = fake.검색().length;
    const 새 = await 고르기(안올림, { aiQueries: ai("텀블러") });
    같나("검색 캐시도 비워서 새 계정으로 다시 검색한다", [새.status, fake.검색().length - 전, fake.calls.at(-1)!.signedOk], ["붙임", 1, true]);
    같나("바뀐 계정의 설정(최대 링크·구분 코드)은 그대로", [cp.loadSettings().maxLinks, cp.loadSettings().defaultSubId], [2, "keep1"]);

    await cp.disconnect();
    const s = cp.loadSettings();
    같나("해제: 열쇠 없음 · 꺼짐 · 시험 기록 없음", [s.connected, s.enabled, s.lastTest, cp.hasKeys()], [false, false, null, false]);
    같나("해제: 설정(최대 링크·구분 코드)은 남는다", [s.maxLinks, s.defaultSubId], [2, "keep1"]);
    같나("해제: 열쇠 파일에 열쇠 값이 없다", /acc-b|sec-b/.test(await Deno.readTextFile(dataPath("쿠팡파트너스.json"))), false);
    같나("해제: 안 올린 영상의 붙임 기록은 비운다", cp.recordFor(안올림), null);
    같나("해제: 올린 영상 기록은 남는다", cp.recordFor(올림)?.videoId, "vidA");
    같나("해제 뒤에는 채널이 켜져 있지 않다", cp.channelOn("채널A"), false);
    같나("해제는 두 번 해도 안전", await cp.disconnect(), undefined);
  });
}

export async function 실행() {
  await 서명시험();
  await 연결시험();
  await 열쇠만시험시험();
  await 설정시험();
  await 글붙이기시험();
  await 고르기시험();
  await 문제목록시험();
  await 계정바꾸기시험();
}

if (import.meta.main) {
  const { 결과 } = await import("./도구.ts");
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

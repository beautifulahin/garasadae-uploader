// 서버 시험 — 진짜 화면 서버(app/server.ts)를 임시 포트에 띄워 HTTP 로 두드린다.
//
// 구글·유튜브·쿠팡에는 한 번도 닿지 않는다: 가짜 구글(시험/가짜구글.ts)과 임시 폴더(모래상자)뿐이고, 서버는 127.0.0.1 의 빈 포트에서만 돈다.
//   · 문지기(Host · Origin · 내용 종류 · Sec-Fetch · 공개 안내 페이지 예외)가 모두 서는지
//   · 읽는 길(GET)이 아무것도 안 바꾸는지 · 영상 재생(구간 요청) · 정적 파일 · 폴더 밖 파일 거절
//   · 첫 실행 창 상태(쿠팡 + AI) · 열쇠 찾기 길 · 올리기 한 편 통째(표 → 시작 → 진행 → 원장) · 이행 보류 · 채널 지우기 확인
//   · 서버가 10분마다 심사확인을 도는지 · 끄면 멈추는지
import { 가짜MP4, 같나, 결과, 구역, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 가짜채널id, 영상두기, 채널준비 } from "./바탕.ts";
import { startServer, type RunningServer } from "../app/server.ts";
import { dataDir, dataPath, exists, join, readJsonSync, recordPath } from "../app/paths.ts";
import { setAiBackend } from "../app/ai.ts";
import { setFinderEnv } from "../app/finder.ts";
import { setHold } from "../app/hold.ts";
import { setFetch } from "../app/google.ts";
import { readLedger } from "../app/ledger.ts";
import { loadChannels } from "../app/channels.ts";
import { APP_NAME, APP_VERSION } from "../app/paths.ts";

type Obj = Record<string, any>;

const JSONH = { "content-type": "application/json" };
const 사람 = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };

function 도우미(s: RunningServer) {
  const get = async (path: string, headers: Record<string, string> = {}) => await fetch(s.url + path, { headers });
  const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    await fetch(s.url + path, { method: "POST", headers: { ...JSONH, ...headers }, body: JSON.stringify(body) });
  const j = async (r: Response) => (await r.json()) as Obj;
  return { get, post, j, state: async () => await j(await get("/api/state")) };
}

/** Host 머리글을 바꿔 보내려고 TCP 로 직접 말한다 (fetch 는 Host 를 마음대로 못 바꾼다) */
async function raw(port: number, 요청: string): Promise<{ status: number; head: string; body: string }> {
  const c = await Deno.connect({ hostname: "127.0.0.1", port });
  await c.write(new TextEncoder().encode(요청));
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(65536);
  for (;;) {
    const n = await c.read(buf).catch(() => null);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
  }
  try { c.close(); } catch { /* 이미 닫힘 */ }
  const all = new TextDecoder().decode(new Uint8Array(chunks.flatMap((x) => [...x])));
  const [head, ...rest] = all.split("\r\n\r\n");
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0), head, body: rest.join("\r\n\r\n") };
}

async function 해시들(dir: string, 건너뜀: (rel: string) => boolean): Promise<Record<string, string>> {
  const o: Record<string, string> = {};
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name), rel = p.slice(dir.length);
      if (건너뜀(rel)) continue;
      if (e.isDirectory) await walk(p);
      else if (e.isFile) {
        const h = await crypto.subtle.digest("SHA-256", await Deno.readFile(p));
        o[rel] = [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
      }
    }
  };
  await walk(dir);
  return o;
}

async function 띄우기<T>(일: (s: RunningServer, dir: string, g: 가짜구글) => Promise<T>, opts: { tick?: boolean; firstTickMs?: number } = {}): Promise<T> {
  return await 모래상자(async (dir) => {
    const g = new 가짜구글().install();
    const s = await startServer({ port: 0, tick: opts.tick ?? false, autoUpdate: false, firstTickMs: opts.firstTickMs });
    try { return await 일(s, dir, g); } finally { await s.shutdown(); g.uninstall(); }
  });
}

/* ═══════════════════════════ 1. 문지기 ═══════════════════════════ */

async function 문지기시험() {
  구역("서버 — 켜기 · 정적 파일 · 상태");
  await 띄우기(async (s) => {
    const h = 도우미(s);
    참인가("빈 포트에서 켜졌다 (127.0.0.1 만)", s.port > 0 && s.url === `http://127.0.0.1:${s.port}`);
    const r = await h.get("/alive");
    같나("/alive", [r.status, await r.text()], [200, "ok"]);
    const page = await h.get("/");
    const html = await page.text();
    참인가("/ 는 화면 한 장 (조각이 모두 채워졌다)", page.status === 200 && page.headers.get("content-type")!.startsWith("text/html") && html.toLowerCase().includes("<!doctype html") && !html.includes("<!--@include"));
    같나("화면은 캐시하지 않는다", page.headers.get("cache-control"), "no-store");
    const js = await h.get("/ui/core.js");
    참인가("/ui/core.js 는 자바스크립트", js.status === 200 && js.headers.get("content-type")!.startsWith("text/javascript"));
    await js.arrayBuffer();
    for (const bad of ["/ui/../paths.ts", "/ui/.숨김.js", "/ui/없는파일.js", "/ui/core.ts"]) {
      const x = await h.get(bad); await x.arrayBuffer();
      같나(`정적 파일 밖은 안 내준다 — ${bad}`, x.status, 404);
    }
    const st = await h.state();
    같나("상태: 앱 이름 · 버전 · 마지막 답이 ok", [st.ok, st.version, st.app], [true, APP_VERSION, APP_NAME]);
    같나("상태에 새 칸들이 있다 (ai · coupang · migrate · update · updating)", ["ai", "coupang", "migrate", "update", "updating"].filter((k) => !(k in st)), []);
    같나("방금 켠 서버는 이행 보류가 아니다", st.migrate, { hold: false });
    같나("버전이 2.0.0 이다", APP_VERSION, "2.0.0");
  });

  구역("서버 — 문지기 (Host · Origin · 내용 종류 · 방법 · Sec-Fetch)");
  await 띄우기(async (s) => {
    const h = 도우미(s);
    const 나쁜host = await raw(s.port, `GET /api/state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
    같나("엉뚱한 Host(DNS 되돌림 공격)는 403", 나쁜host.status, 403);
    const 좋은host = await raw(s.port, `GET /alive HTTP/1.1\r\nHost: localhost:${s.port}\r\nConnection: close\r\n\r\n`);
    같나("localhost:포트 는 통과", 좋은host.status, 200);
    const 다른포트 = await raw(s.port, `GET /alive HTTP/1.1\r\nHost: 127.0.0.1:${s.port + 1}\r\nConnection: close\r\n\r\n`);
    같나("다른 포트를 가리키는 Host 는 403", 다른포트.status, 403);

    const 남의사이트 = await h.post("/api/upload/lock", { on: false }, { origin: "https://evil.example" });
    같나("다른 사이트(Origin)에서 시키면 403", 남의사이트.status, 403); await 남의사이트.arrayBuffer();
    const 안내페이지POST = await h.post("/api/upload/lock", { on: false }, { origin: "https://beautifulahin.github.io" });
    같나("공개 안내 페이지도 공개 길 세 개 말고는 못 시킨다 (403)", 안내페이지POST.status, 403); await 안내페이지POST.arrayBuffer();
    const 안내페이지GET = await h.get("/api/state", { origin: "https://beautifulahin.github.io" });
    같나("공개 안내 페이지는 상태를 읽을 수 있다 (CORS 머리글)", [안내페이지GET.status, 안내페이지GET.headers.get("access-control-allow-origin")], [200, "https://beautifulahin.github.io"]);
    await 안내페이지GET.arrayBuffer();
    const 안내페이지검사 = await h.post("/api/update/check", {}, { origin: "https://beautifulahin.github.io" });
    같나("update/check 는 공개 길이라 CORS 머리글이 붙는다", [안내페이지검사.status, 안내페이지검사.headers.get("access-control-allow-origin")], [200, "https://beautifulahin.github.io"]);
    await 안내페이지검사.arrayBuffer();
    const 예비 = await fetch(s.url + "/api/state", { method: "OPTIONS", headers: { origin: "https://beautifulahin.github.io", "access-control-request-method": "GET" } });
    같나("OPTIONS(예비 요청)는 204", 예비.status, 204); await 예비.arrayBuffer();
    const 다른사이트OPTIONS = await fetch(s.url + "/api/state", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    같나("다른 사이트의 OPTIONS 는 403", 다른사이트OPTIONS.status, 403); await 다른사이트OPTIONS.arrayBuffer();

    const 글 = await fetch(s.url + "/api/upload/lock", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    같나("POST 는 JSON 이어야 한다 — text/plain 은 415", 글.status, 415); await 글.arrayBuffer();
    const 깨짐 = await fetch(s.url + "/api/upload/lock", { method: "POST", headers: JSONH, body: "{깨진" });
    같나("깨진 JSON 은 400", 깨짐.status, 400); await 깨짐.arrayBuffer();
    const 크다 = await fetch(s.url + "/api/upload/lock", { method: "POST", headers: JSONH, body: JSON.stringify({ x: "가".repeat(5 * 1024 * 1024) }) });
    같나("몸이 너무 크면 413", 크다.status, 413); await 크다.arrayBuffer();
    const 방법 = await h.get("/api/upload/lock");
    같나("POST 전용 길에 GET 은 405", 방법.status, 405); await 방법.arrayBuffer();
    const 없는길 = await h.get("/api/없는길");
    같나("모르는 길은 404", 없는길.status, 404); await 없는길.arrayBuffer();
    const 크로스 = await h.get("/api/state", { "sec-fetch-site": "cross-site" });
    같나("Sec-Fetch-Site: cross-site 인 읽기도 403", 크로스.status, 403); await 크로스.arrayBuffer();
    const 같은곳 = await h.get("/api/state", { "sec-fetch-site": "same-origin" });
    같나("same-origin 은 통과", 같은곳.status, 200); await 같은곳.arrayBuffer();
    const drop내용 = await fetch(s.url + "/api/drop?ch=채널A&name=a.mp4", { method: "POST", headers: JSONH, body: "{}" });
    같나("drop 은 파일 바이트(octet-stream)로만 받는다 (JSON 은 415)", drop내용.status, 415); await drop내용.arrayBuffer();
    const 오류글 = await h.post("/api/없는시킴", {});
    const 오류 = await h.j(오류글);
    같나("실패 답은 {ok:false, why} + 옛 안내 페이지가 읽는 error", [오류.ok, typeof 오류.why, 오류.error === 오류.why], [false, "string", true]);
  });
}

/* ═══════════════════════════ 2. 읽는 길은 아무것도 안 바꾼다 · 영상 재생 ═══════════════════════════ */

async function 읽기시험() {
  구역("서버 — 읽는 길(GET)은 아무것도 안 바꾼다");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    const a = await 채널준비(dir, g, { name: "채널A", c: "a" });
    await 영상두기(a.folder, "a1.mp4", { txt: "제목\n\n설명\n\n#태그" });
    const 건너뜀 = (rel: string) => rel.startsWith("/기록/") || rel.endsWith(".lock") || rel.endsWith(".tmp");
    // 한 번 읽어 캐시 파일이 생길 건 생기게 한 뒤, 두 번째·세 번째 읽기가 아무것도 안 바꾸는지 본다
    for (const p of ["/api/state", "/api/issues", "/api/calendar", "/api/brief", "/api/log", "/api/records", "/api/stats"]) { const r = await h.get(p); await r.arrayBuffer(); }
    const 앞 = await 해시들(dataDir(), 건너뜀);
    const 호출앞 = g.calls.length;
    for (const p of ["/api/state", "/api/issues", "/api/calendar", "/api/brief", "/api/log", "/api/records", "/api/stats", "/api/state"]) {
      const r = await h.get(p);
      같나(`GET ${p} 은 200`, r.status, 200); await r.arrayBuffer();
    }
    같나("읽는 길을 여러 번 불러도 데이터 폴더가 한 글자도 안 바뀐다 (기록/ 제외)", await 해시들(dataDir(), 건너뜀), 앞);
    같나("읽는 길은 구글을 한 번도 안 불렀다 (저장된 기록·파일만 읽는다)", g.calls.length - 호출앞, 0);
  });

  구역("서버 — 영상 재생(구간 요청) · 폴더 밖 파일 거절");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    const a = await 채널준비(dir, g, { name: "채널A", c: "a" });
    const v = await 영상두기(a.folder, "a1.mp4", { mb: 1 });
    const 크기 = (await Deno.stat(v)).size;
    const 전체 = await h.get(`/media?p=${encodeURIComponent(v)}`);
    같나("등록된 폴더 안의 영상은 내준다", [전체.status, 전체.headers.get("content-type"), 전체.headers.get("accept-ranges"), Number(전체.headers.get("content-length"))], [200, "video/mp4", "bytes", 크기]);
    const 바이트 = new Uint8Array(await 전체.arrayBuffer());
    같나("받은 바이트 수가 파일 크기와 같다", 바이트.length, 크기);
    const 구간 = await fetch(`${s.url}/media?p=${encodeURIComponent(v)}`, { headers: { range: "bytes=100-199" } });
    같나("구간 요청은 206 + Content-Range", [구간.status, 구간.headers.get("content-range"), Number(구간.headers.get("content-length"))], [206, `bytes 100-199/${크기}`, 100]);
    const 구간바이트 = new Uint8Array(await 구간.arrayBuffer());
    같나("구간 내용이 파일의 그 자리와 같다", [...구간바이트], [...바이트.slice(100, 200)]);
    const 끝구간 = await fetch(`${s.url}/media?p=${encodeURIComponent(v)}`, { headers: { range: `bytes=${크기 - 10}-` } });
    같나("끝까지 열린 구간(bytes=N-)도 된다", [끝구간.status, Number(끝구간.headers.get("content-length"))], [206, 10]); await 끝구간.arrayBuffer();
    const 범위밖 = await fetch(`${s.url}/media?p=${encodeURIComponent(v)}`, { headers: { range: `bytes=${크기 + 5}-${크기 + 9}` } });
    같나("범위를 벗어난 구간은 416", 범위밖.status, 416); await 범위밖.arrayBuffer();
    // 폴더 밖
    const 밖 = join(dir, "비밀.mp4"); await Deno.writeFile(밖, new Uint8Array([1, 2, 3]));
    const x1 = await h.get(`/media?p=${encodeURIComponent(밖)}`); 같나("등록된 폴더 밖의 영상은 403", x1.status, 403); await x1.arrayBuffer();
    const x2 = await h.get(`/media?p=${encodeURIComponent(join(a.folder, "..", "비밀.mp4"))}`); 같나("../ 로 빠져나가도 403", x2.status, 403); await x2.arrayBuffer();
    const x3 = await h.get(`/media?p=${encodeURIComponent(join(dataDir(), "tokens.json"))}`); 같나("로그인 정보 파일은 영상 길로 못 읽는다 (403)", x3.status, 403); await x3.arrayBuffer();
    const 글 = join(a.folder, "메모.txt"); await Deno.writeTextFile(글, "x");
    const x4 = await h.get(`/media?p=${encodeURIComponent(글)}`); 같나("영상이 아닌 파일은 403", x4.status, 403); await x4.arrayBuffer();
    const x5 = await h.get(`/thumb?p=${encodeURIComponent(v)}`); 같나("/thumb 은 그림 파일만 (영상은 403)", x5.status, 403); await x5.arrayBuffer();
    const x6 = await h.get("/art?f=../tokens.json"); 같나("/art 는 폴더 밖 이름을 거절한다 (400)", x6.status, 400); await x6.arrayBuffer();
    const x7 = await h.get("/studio?cid=아무거나"); 같나("/studio 는 채널 ID 모양이 아니면 400", x7.status, 400); await x7.arrayBuffer();
  });
}

async function 끌어놓기시험() {
  구역("서버 — 화면에 끌어다 놓기(/api/drop): 채널 폴더에 저장 · 같은 이름은 번호 · 영상이 아니면 거절");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    const a = await 채널준비(dir, g, { name: "채널A", c: "a" });
    const 보내기 = async (이름: string, 바이트: Uint8Array, ch = "채널A") =>
      await h.j(await fetch(`${s.url}/api/drop?ch=${encodeURIComponent(ch)}&name=${encodeURIComponent(이름)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: 바이트 as Uint8Array<ArrayBuffer> }));
    const 영상 = 가짜MP4({ w: 1080, h: 1920, sec: 30 });
    const r1 = await 보내기("끌어온 영상.mp4", 영상);
    같나("끌어다 놓은 영상이 채널 폴더에 저장되고 종류까지 읽는다", [r1.ok, r1.name, r1.kind, r1.size, await exists(join(a.folder, "끌어온 영상.mp4"))], [true, "끌어온 영상.mp4", "쇼츠", 영상.length, true]);
    같나("저장된 바이트가 보낸 것과 같다", [...await Deno.readFile(join(a.folder, "끌어온 영상.mp4"))], [...영상]);
    const r2 = await 보내기("끌어온 영상.mp4", 영상);
    같나("같은 이름이면 덮어쓰지 않고 번호를 붙인다", [r2.ok, r2.name, await exists(join(a.folder, "끌어온 영상 (2).mp4"))], [true, "끌어온 영상 (2).mp4", true]);
    같나("받는 중에 쓰던 임시 파일이 남지 않는다", [...Deno.readDirSync(a.folder)].some((e) => e.name.endsWith(".받는중")), false);
    const r3 = await 보내기("메모.txt", new Uint8Array([1, 2, 3]));
    같나("영상 확장자가 아니면 거절", [r3.ok, String(r3.why).includes("영상 파일")], [false, true]);
    const r4 = await 보내기(".숨김.mp4", 영상);
    같나("숨김 파일 이름은 거절", r4.ok, false);
    const r5 = await 보내기("../밖으로.mp4", 영상);
    같나("../ 가 든 이름은 이름만 남기고 폴더 안에 저장한다 (밖으로 못 나간다)", [r5.ok, r5.name, await exists(join(dir, "밖으로.mp4"))], [true, "밖으로.mp4", false]);
    const r6 = await 보내기("a.mp4", 영상, "없는채널");
    같나("모르는 채널은 거절", r6.ok, false);
  });
}

async function 정책시험() {
  구역("서버 — 채널 일 한도 정책 저장: 값 넣기 · 빈 칸(null)은 그 칸을 지운다 · 정책 숫자(policyConf)");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    await 채널준비(dir, g, { name: "채널A", c: "a" });
    const 칸 = async () => ((await h.state()).channels as Obj[]).find((c) => c.name === "채널A")!;
    같나("처음에는 정책이 없다", [(await 칸()).policy, (await 칸()).policyConf], [null, null]);
    const r1 = await h.j(await h.post("/api/channel/policy", { ch: "채널A", daily_limit: 3, kind: "롱폼", cap_uploads: true, day_start_hour: 6, overflow_day_start_hour: 5, publish_gap_minutes: 90 }));
    const c1 = (await 칸()).policyConf;
    같나("정책을 쓰면 숫자가 그대로 보인다", [r1.ok, c1.daily_limit, c1.kind, c1.cap_uploads, c1.day_start_hour, c1.overflow_day_start_hour, c1.publish_gap_minutes], [true, 3, "롱폼", true, 6, 5, 90]);
    await h.post("/api/channel/policy", { ch: "채널A", daily_limit: 3, kind: null, overflow_day_start_hour: null });
    const c2 = (await 칸()).policyConf;
    같나("kind·overflow_day_start_hour 를 null 로 보내면 그 칸이 지워진다 (쇼츠·롱폼 전부로 되돌아간다) · 나머지는 그대로", [c2.daily_limit, c2.kind, c2.overflow_day_start_hour, c2.day_start_hour, c2.publish_gap_minutes], [3, null, null, 6, 90]);
    const 나쁨 = await h.j(await h.post("/api/channel/policy", { ch: "채널A", daily_limit: 0 }));
    같나("하루 편수가 1~100 밖이면 거절", 나쁨.ok, false);
    const 지움 = await h.j(await h.post("/api/channel/policy/clear", { ch: "채널A" }));
    같나("정책 지우기", [지움.removed, (await 칸()).policy], [true, null]);
  });
}

/* ═══════════════════════════ 3. 첫 실행 창 · 열쇠 찾기 · 쿠팡 · AI ═══════════════════════════ */

const 열쇠 = (이름: string) => ("AIza" + 이름 + "x".repeat(40)).slice(0, 39);
const 좋은열쇠 = 열쇠("GOODaaaaaaaaaaaaaaaaaaaaaaaaaaaaAB12");
const 접근 = "TESTACCESSKEY0001", 비밀 = "TESTSECRETKEYTESTSECRETKEY0001";

async function 열쇠창시험() {
  구역("서버 — 첫 실행 창: 쿠팡 + AI 한 창 (한 번만 · 나중에·닫기 · 직접 입력)");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    setAiBackend({ meta: () => Promise.reject(new Error("쓰지 않는다")), text: ({ key }) => (key.includes("GOOD") ? Promise.resolve("{}") : Promise.reject(new Error("열쇠가 거절됐습니다"))) });
    let st = await h.state();
    같나("처음에는 두 구역 모두 창을 띄우라고 한다", [st.ai.needsPrompt, st.coupang.needsPrompt, st.ai.connected, st.coupang.connected], [true, true, false, false]);
    const 나중 = await h.j(await h.post("/api/prompt/later", {}));
    st = await h.state();
    같나("「나중에」/닫기를 누르면 둘 다 다시 안 띄운다", [나중.ok, st.ai.needsPrompt, st.coupang.needsPrompt], [true, false, false]);
    const 새로고침 = await h.state();
    같나("새로고침해도(상태를 다시 읽어도) 다시 띄우라고 하지 않는다", [새로고침.ai.needsPrompt, 새로고침.coupang.needsPrompt], [false, false]);

    // AI 직접 입력 — 틀린 열쇠는 저장 안 됨, 맞는 열쇠는 연결 + 자동 문안 켜짐
    const 틀림 = await h.j(await h.post("/api/ai/connect", { key: 열쇠("BADcccccccccccccccccccccccccccccccEF56") }));
    같나("틀린 열쇠는 저장하지 않고 이유를 말한다", [틀림.ok, typeof 틀림.why, (await h.state()).ai.connected], [false, "string", false]);
    const 맞음 = await h.j(await h.post("/api/ai/connect", { key: 좋은열쇠 }));
    st = await h.state();
    같나("맞는 열쇠는 연결 + 자동 문안 켜짐", [맞음.ok, st.ai.connected, st.ai.enabled, st.ai.hasKey], [true, true, true, true]);
    같나("응답·상태 어디에도 열쇠 전체 값이 없다", JSON.stringify([맞음, st]).includes(좋은열쇠), false);
    const 끊기 = await h.j(await h.post("/api/ai/disconnect", {}));
    같나("연결 해제 = 열쇠 지우고 끔", [끊기.ok, (await h.state()).ai.connected, (await h.state()).ai.hasKey], [true, false, false]);
    setAiBackend(null);
  });

  구역("서버 — 이 컴퓨터에서 열쇠 찾기 (창을 열 때만 · 가려서 · 통과한 것만 저장)");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    setAiBackend({ meta: () => Promise.reject(new Error("쓰지 않는다")), text: ({ key }) => (key.includes("GOOD") ? Promise.resolve("{}") : Promise.reject(new Error("열쇠가 거절됐습니다"))) });
    setFinderEnv((k) => (k === "GEMINI_API_KEY" ? 좋은열쇠 : undefined));
    // 쿠팡: 가짜 쿠팡 하나 (접근키가 맞을 때만 받아 준다)
    setFetch((input, init) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const m = /access-key=([^,]+),/.exec(new Headers(init?.headers).get("authorization") ?? "");
      if (new URL(href).hostname !== "api-gateway.coupang.com") return g.handle(input, init);
      if (m?.[1] !== 접근) return Promise.resolve(new Response(JSON.stringify({ code: "ERROR" }), { status: 401 }));
      return Promise.resolve(new Response(JSON.stringify({ rCode: "0", rMessage: "", data: { productData: [{ productId: 1, productName: "가짜 상품", productPrice: 1000, productUrl: "https://link.coupang.com/re/AFFSDP?x=1" }], landingUrl: "https://link.coupang.com/re/AFFSDP" } }), { status: 200 }));
    });
    await Deno.mkdir(join(Deno.env.get("GARASADAE_HOME")!, ".volcano", "keys"), { recursive: true });
    await Deno.writeTextFile(join(Deno.env.get("GARASADAE_HOME")!, ".volcano", "keys", "coupang_partners"), `${접근}:${비밀}\n`);

    const 앞 = await h.state();
    같나("찾기 전에는 아무것도 저장돼 있지 않다 (서버가 켜질 때 몰래 찾지 않는다)", [앞.ai.hasKey, 앞.coupang.connected], [false, false]);
    const r = await h.j(await h.post("/api/finder/scan", {}));
    같나("찾았다 — AI 하나 · 쿠팡 하나, 둘 다 시험 통과", [r.ok, r.ai.length, r.coupang.length, r.ai[0].test.ok, r.coupang[0].test.ok], [true, 1, 1, true, true]);
    같나("가려서 보인다 (AIza…끝4자리 / 쿠팡은 비밀키 있음)", [r.ai[0].masked, r.coupang[0].masked.endsWith("· 비밀키 있음")], ["AIza…" + 좋은열쇠.slice(-4), true]);
    같나("응답에 열쇠 전체 값이 없다", [좋은열쇠, 접근, 비밀].filter((k) => JSON.stringify(r).includes(k)), []);
    같나("찾기만으로는 저장되지 않는다", [(await h.state()).ai.hasKey, (await h.state()).coupang.connected], [false, false]);
    const 쓰기AI = await h.j(await h.post("/api/finder/use", { kind: "ai", id: r.ai[0].id }));
    const 쓰기쿠팡 = await h.j(await h.post("/api/finder/use", { kind: "coupang", id: r.coupang[0].id }));
    const st = await h.state();
    같나("「이걸로 쓰기」 한 번씩 → 둘 다 연결 · 자동 켜짐 · 창 기록", [쓰기AI.ok, 쓰기쿠팡.ok, st.ai.connected, st.coupang.connected, st.coupang.enabled, st.ai.needsPrompt, st.coupang.needsPrompt], [true, true, true, true, true, false, false]);
    const 또 = await h.j(await h.post("/api/finder/use", { kind: "ai", id: r.ai[0].id }));
    같나("한 번 쓴 id 를 다시 쓰면 거절한다", [또.ok, String(또.why).includes("다시 찾기")], [false, true]);
    const 모름 = await h.j(await h.post("/api/finder/use", { kind: "ai", id: "없는id" }));
    같나("모르는 id 도 거절한다", 모름.ok, false);
    setAiBackend(null); setFinderEnv(null); setFetch(null); g.install();
    await h.post("/api/coupang/disconnect", {});
  });
}

/* ═══════════════════════════ 4. 올리기 한 편 통째 ═══════════════════════════ */

async function 올리기시험() {
  구역("서버 — 올리기 한 편 통째 (표 → 시작 → 진행 → 원장 · 표는 한 번만 · 잠금 · 폴더 밖 거절)");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    g.instantProcessing = true;
    const a = await 채널준비(dir, g, { name: "채널A", c: "a", conf: { publish: "now", after_upload: "keep" } });
    const v = await 영상두기(a.folder, "a1.mp4", { sec: 30, txt: "시험 제목\n\n설명 한 줄\n\n#태그1 #태그2" });

    const 표없이 = await h.j(await h.post("/api/upload/start", { files: [v], t: "" }, 사람));
    같나("표 없이 시작하면 거절한다", [표없이.ok, String(표없이.why).includes("표")], [false, true]);
    const 주소창 = await h.j(await h.post("/api/upload/ticket", { files: [v] }, 사람));
    const 이상한출처 = await h.j(await h.post("/api/upload/start", { files: [v], t: 주소창.t }, { ...사람, "sec-fetch-site": "cross-site" }));
    같나("다른 곳에서 부른 시작은 거절한다 (표도 소모된다)", [이상한출처.ok], [false]);

    const 표 = await h.j(await h.post("/api/upload/ticket", { files: [v, join(dir, "없는파일.mp4")] }, 사람));
    같나("표: 폴더에 없는 파일이 있으면 표를 주지 않고 missing 으로 알린다 (화면이 장바구니에서 빼고 다시 누른다)", [표.ok, 표.t, 표.missing?.length], [false, undefined, 1]);
    const 밖 = join(dir, "밖.mp4"); await Deno.writeFile(밖, new Uint8Array([1]));
    const 표밖 = await h.j(await h.post("/api/upload/ticket", { files: [밖] }, 사람));
    const 밖시작 = await h.j(await h.post("/api/upload/start", { files: [밖], t: 표밖.t }, 사람));
    같나("등록된 채널 폴더 밖의 파일은 시작을 거절한다", [밖시작.ok, String(밖시작.why).includes("밖")], [false, true]);

    const 표2 = await h.j(await h.post("/api/upload/ticket", { files: [v] }, 사람));
    const 시작 = await h.j(await h.post("/api/upload/start", { files: [v], t: 표2.t }, 사람));
    같나("표가 맞으면 시작한다", [시작.ok, 시작.n], [true, 1]);
    let 끝 = false;
    for (let i = 0; i < 100 && !끝; i++) {
      const c = await h.j(await h.post("/api/upload/check", {}));
      끝 = !c.running;
      if (!끝) await new Promise((r) => setTimeout(r, 100));
    }
    참인가("진행이 끝났다", 끝);
    const 원장 = readLedger();
    같나("원장에 한 줄 (채널 · 제목 · 파일)", [원장.length, 원장[0]?.["채널"], 원장[0]?.["제목"], 원장[0]?.["파일"]?.endsWith("a1.mp4")], [1, "채널A", "시험 제목", true]);
    참인가("가짜 구글에 영상이 하나 올라갔다 (비공개로)", g.videos.size === 1 && [...g.videos.values()][0].status.privacyStatus === "private");
    const 다시 = await h.j(await h.post("/api/upload/start", { files: [v], t: 표2.t }, 사람));
    같나("같은 표를 다시 쓰면 거절한다 (새로고침·뒤로가기로는 안 올라간다)", [다시.ok, String(다시.why).includes("이미 쓴")], [false, true]);
    const 표3 = await h.j(await h.post("/api/upload/ticket", { files: [v] }, 사람));
    const 또올림 = await h.j(await h.post("/api/upload/start", { files: [v], t: 표3.t }, 사람));
    참인가("이미 올라간 파일을 새 표로 다시 올리려 해도 출구에서 막힌다 (중복) — 원장은 그대로", await (async () => {
      for (let i = 0; i < 60; i++) { const c = await h.j(await h.post("/api/upload/check", {})); if (!c.running) break; await new Promise((r) => setTimeout(r, 100)); }
      return readLedger().length === 1 && g.videos.size === 1;
    })());
    void 또올림;

    // 잠금
    const 잠금 = await h.j(await h.post("/api/upload/lock", { on: true }));
    같나("잠그면 locked", [잠금.locked, (await h.state()).locked], [true, true]);
    const 잠긴표 = await h.j(await h.post("/api/upload/ticket", { files: [v] }, 사람));
    같나("잠그면 표도 안 준다", [잠긴표.ok], [false]);
    await h.post("/api/upload/lock", { on: false });
  });
}

/* ═══════════════════════════ 5. 이행 보류 · 채널 지우기 확인 ═══════════════════════════ */

async function 보류시험() {
  구역("서버 — 이행 보류: 올리기 멈춤 · 빨간 줄 · 다시 옮기기(풀림)");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    g.instantProcessing = true;
    const a = await 채널준비(dir, g, { name: "채널A", c: "a", conf: { publish: "now", after_upload: "keep" } });
    const v = await 영상두기(a.folder, "a1.mp4", { sec: 30, txt: "시험 제목" });
    await setHold({ backupDir: join(dataDir(), "백업", "이행전_가짜"), oldDir: dataDir(), reasons: ["시험으로 건 멈춤"], missing: ["[채널A] 로그인 정보가 새 앱에 온전히 옮겨지지 않았습니다"], oldChannels: 1, newChannels: 1 });
    const st = await h.state();
    같나("상태에 멈춤이 보인다 (복사본 위치 · 빠진 것)", [st.migrate.hold, st.migrate.backupDir.endsWith("이행전_가짜"), st.migrate.missing.length], [true, true, 1]);
    const 줄 = await h.j(await h.get("/api/issues"));
    const 빨강 = 줄.items.find((x: Obj) => x.level === "red" && x.what.includes("옛 판 자료를 새 판으로 옮긴 결과"));
    같나("문제 목록 맨 위에 빨간 줄 + 다시 옮기기", [줄.items[0] === 빨강 || 줄.items[0]?.what === 빨강?.what, 빨강?.fix?.api], [true, "/api/migrate/retry"]);
    const 표 = await h.j(await h.post("/api/upload/ticket", { files: [v] }, 사람));
    같나("멈춤 중에는 표도 안 준다 — 까닭에 복사본 위치", [표.ok, String(표.why).includes("옛 판 자료를 새 판으로 옮긴 결과"), String(표.why).includes("이행전_가짜")], [false, true, true]);
    const 억지시작 = await h.j(await h.post("/api/upload/start", { files: [v], t: "아무표" }, 사람));
    같나("표 없이 억지로 시작해도 멈춤이 먼저 막는다 (표·되풀이 기록을 쓰지 않는다)", [억지시작.ok, String(억지시작.why).includes("옛 판 자료를 새 판으로 옮긴 결과")], [false, true]);
    같나("멈춤 중에는 아무것도 올라가지 않았다", [readLedger().length, g.videos.size], [0, 0]);
    const 심사 = await h.j(await h.post("/api/tick", {}));
    참인가("심사확인도 멈춘다", JSON.stringify(심사).includes("이행 보류") || 심사.skipped?.includes?.("이행 보류") || 심사.lines?.length === 0);

    const 받아들이기 = await h.j(await h.post("/api/migrate/accept", {}));
    같나("받아들이기는 확인 표시(confirm) 없이는 거절", [받아들이기.ok, (await h.state()).migrate.hold], [false, true]);
    const 다시 = await h.j(await h.post("/api/migrate/retry", {}));
    같나("다시 옮기기: 옮길 옛 자료가 더는 없으면 멈춤을 풀어 준다", [다시.ok, (await h.state()).migrate], [true, { hold: false }]);
    const 표2 = await h.j(await h.post("/api/upload/ticket", { files: [v] }, 사람));
    await h.post("/api/upload/start", { files: [v], t: 표2.t }, 사람);
    for (let i = 0; i < 100; i++) { const c = await h.j(await h.post("/api/upload/check", {})); if (!c.running) break; await new Promise((r) => setTimeout(r, 100)); }
    같나("풀린 뒤에는 올라간다", readLedger().length, 1);
  });

  구역("서버 — 채널·로그인을 지우는 길은 확인 표시(confirm)가 있어야만");
  await 띄우기(async (s, dir, g) => {
    const h = 도우미(s);
    await 채널준비(dir, g, { name: "채널A", c: "a" });
    await 채널준비(dir, g, { name: "채널B", c: "b" });
    const 빼기없음 = await h.j(await h.post("/api/remove", { ch: "채널B" }));
    같나("채널 빼기: confirm 이 없으면 거절 — 채널이 그대로", [빼기없음.ok, Object.keys(loadChannels())], [false, ["채널A", "채널B"]]);
    const 해제없음 = await h.j(await h.post("/api/channel/logout", { ch: "채널B" }));
    같나("연결 해제: confirm 이 없으면 거절 — 로그인 정보가 그대로", [해제없음.ok, Object.keys(readJsonSync<Obj>(dataPath("tokens.json"), {}))], [false, ["채널A", "채널B"]]);
    const 해제 = await h.j(await h.post("/api/channel/logout", { ch: "채널B", confirm: true }));
    같나("연결 해제: confirm 이 있으면 그 채널 로그인만 지운다 (채널 칸은 그대로)", [해제.ok, Object.keys(readJsonSync<Obj>(dataPath("tokens.json"), {})), Object.keys(loadChannels())], [true, ["채널A"], ["채널A", "채널B"]]);
    const 빼기 = await h.j(await h.post("/api/remove", { ch: "채널B", confirm: true }));
    같나("채널 빼기: confirm 이 있으면 그 채널만 빠진다", [빼기.ok, Object.keys(loadChannels())], [true, ["채널A"]]);
  });
}

/* ═══════════════════════════ 6. 서버가 도는 동안의 심사확인 ═══════════════════════════ */

async function 틱시험() {
  구역("서버 — 서버가 켜져 있는 동안 심사확인을 스스로 돈다 · 끄면 멈춘다");
  await 모래상자(async (dir) => {
    const g = new 가짜구글().install();
    await 채널준비(dir, g, { name: "채널A", c: "a" });
    const s = await startServer({ port: 0, tick: true, autoUpdate: false, firstTickMs: 100 });
    try {
      for (let i = 0; i < 80 && !(await exists(recordPath("심사확인.last"))); i++) await new Promise((r) => setTimeout(r, 100));
      참인가("켠 지 얼마 안 돼 첫 심사확인이 돌았다 (기록/심사확인.last)", await exists(recordPath("심사확인.last")));
      const st = await 도우미(s).state();
      같나("상태의 tick.last 가 채워졌다 · 서버가 돌리는 중(residentOn)", [st.tick.last.length > 0, st.tick.residentOn], [true, true]);
    } finally { await s.shutdown(); }
    const 끈뒤 = await Deno.readTextFile(recordPath("심사확인.last"));
    await new Promise((r) => setTimeout(r, 400));
    같나("서버를 끄면 더는 돌지 않는다", await Deno.readTextFile(recordPath("심사확인.last")), 끈뒤);
    g.uninstall();
  });

  구역("서버 — 심사확인이 도는 중에 꺼도 프로세스가 남지 않는다 (꺼진 뒤 다음 차례를 걸지 않는다)");
  await 모래상자(async (dir) => {
    // 별도 프로세스에서: 서버를 켜자마자(심사확인이 막 돌기 시작할 때) 꺼 본다 — 새 타이머가 남으면 10분 동안 프로세스가 안 끝난다
    const 글 = join(dir, "끄기시험.ts");
    await Deno.writeTextFile(글, `
import { startServer } from ${JSON.stringify(new URL("../app/server.ts", import.meta.url).href)};
for (let i = 0; i < 6; i++) {
  const s = await startServer({ port: 0, tick: true, autoUpdate: false, firstTickMs: 1 });
  await new Promise((r) => setTimeout(r, 5 + i * 7));
  await s.shutdown();
}
console.log("꺼짐");
`);
    const 시작 = Date.now();
    const p = new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-lock", 글], stdout: "piped", stderr: "piped", env: { GARASADAE_OFFLINE: "1", GARASADAE_NO_DESKTOP: "1" } }).spawn();
    const 끝 = await Promise.race([p.output().then((o) => ({ ok: true as const, o })), new Promise<{ ok: false }>((r) => setTimeout(() => r({ ok: false }), 40_000))]);
    if (!끝.ok) { try { p.kill(); } catch { /* 이미 끝 */ } }
    같나("여섯 번 켜자마자 꺼도 프로세스가 40초 안에 끝난다 (남은 타이머 없음)", 끝.ok && new TextDecoder().decode(끝.o.stdout).includes("꺼짐"), true);
    참인가("실제로는 몇 초 안에 끝난다", Date.now() - 시작 < 30_000);
  });

  구역("서버 — 서버를 끄면 포트를 놓는다");
  await 모래상자(async () => {
    const s = await startServer({ port: 0, tick: false, autoUpdate: false });
    const port = s.port;
    await s.shutdown();
    let 아직 = true;
    try { const c = await Deno.connect({ hostname: "127.0.0.1", port }); c.close(); } catch { 아직 = false; }
    같나("끈 뒤에는 그 포트에 연결이 안 된다", 아직, false);
  });
}

export async function 실행() {
  await 문지기시험();
  await 읽기시험();
  await 끌어놓기시험();
  await 정책시험();
  await 열쇠창시험();
  await 올리기시험();
  await 보류시험();
  await 틱시험();
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

void 가짜채널id;

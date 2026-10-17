// 브라우저 시험 — 진짜 서버를 임시 상자에 띄우고 헤드리스 크롬으로 진짜 화면을 열어 사람처럼 누른다.
//
// 모의 서버로 만든 화면이 진짜 서버와 맞물리는지 보는 마지막 관문이다(화면 약속 시험은 칸 이름만 본다).
//   · 탭 일곱을 돌며 자바스크립트 예외·실패한 요청이 없는지
//   · 영상 벽의 카드를 담고 → 올리기 → 확인 창 → 올리기 → 진행 창 → 진짜 서버가 가짜 구글에 올린 영상이 원장에 남는지
//   · 열쇠 창이 이 컴퓨터(가짜 집)에서 찾은 열쇠를 보이고, 「이걸로 쓰기」 한 번으로 연결되는지
//   · 이행 보류 띠와 「다시 옮기기」
// 크롬이 없으면 건너뛴다(기본 시험 모음에는 넣지 않았다 — `deno run -A 시험/브라우저.ts`). 바깥 이름 풀이는 크롬에서 막아 구글 글꼴·유튜브 그림 요청이 나가지 않는다.
// 구글·유튜브·쿠팡에는 한 번도 닿지 않는다: 서버 안에 가짜 구글이 끼워져 있다.
import { 같나, 결과, 구역, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 영상두기, 채널준비 } from "./바탕.ts";
import { startServer } from "../app/server.ts";
import { appendLedger, readLedger } from "../app/ledger.ts";
import { setHold } from "../app/hold.ts";
import { setAiBackend } from "../app/ai.ts";
import { dataDir, join } from "../app/paths.ts";

const 크롬후보 = [
  Deno.env.get("GARASADAE_CHROME") ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean);

async function 크롬찾기(): Promise<string> {
  for (const p of 크롬후보) { try { if ((await Deno.stat(p)).isFile) return p; } catch { /* 다음 */ } }
  return "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface 쪽 {
  ev: (expr: string) => Promise<unknown>;
  go: (url: string) => Promise<void>;
  errs: string[];
  bad: string[];
  reqs: string[];
  close: () => Promise<void>;
}

async function 크롬열기(chrome: string): Promise<쪽 | null> {
  const dbg = 9300 + Math.floor(Math.random() * 600);
  const prof = await Deno.makeTempDir({ prefix: "garasadae_브라우저시험_" });
  const proc = new Deno.Command(chrome, {
    args: ["--headless=new", `--remote-debugging-port=${dbg}`, `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu",
      "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "--window-size=1400,1000", "about:blank"],
    stdout: "null", stderr: "null",
  }).spawn();
  let ver: unknown = null;
  for (let i = 0; i < 80 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${dbg}/json/version`)).json(); } catch { await sleep(250); } }
  if (!ver) { try { proc.kill(); } catch { /* 이미 끝 */ } return null; }
  const tgt = await (await fetch(`http://127.0.0.1:${dbg}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const errs: string[] = [], bad: string[] = [], reqs: string[] = [];
  // 바깥 이름 풀이를 막았으니 글꼴·유튜브 그림이 안 뜨는 것은 오류가 아니다
  const 바깥 = (t: string) => /ERR_NAME_NOT_RESOLVED|fonts\.googleapis|i\.ytimg|ERR_INTERNET_DISCONNECTED/.test(t);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? m.error); pend.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") errs.push("예외: " + String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split("\n")[0]);
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const t = m.params.args.map((a: { value?: unknown; description?: string }) => String(a.value ?? a.description ?? "")).join(" ");
      if (!바깥(t)) errs.push("콘솔 오류: " + t.slice(0, 200));
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      const t = `${m.params.entry.text} ${m.params.entry.url ?? ""}`;
      if (!바깥(t)) errs.push("로그: " + t.slice(0, 200));
    } else if (m.method === "Network.requestWillBeSent") reqs.push(`${m.params.request.method} ${m.params.request.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80)}`);
    else if (m.method === "Network.responseReceived") {
      const r = m.params.response;
      if (r.status >= 400 && !바깥(r.url)) bad.push(`${r.status} ${r.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80)}`);
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  for (const d of ["Runtime", "Log", "Page", "Network"]) await send(d + ".enable");
  return {
    errs, bad, reqs,
    ev: async (expr) => ((await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown } }).result?.value,
    go: async (url) => { await send("Page.navigate", { url }); },
    close: async () => { try { ws.close(); } catch { /* 이미 닫힘 */ } try { proc.kill(); } catch { /* 이미 끝 */ } await sleep(300); },
  };
}

export async function 실행() {
  const chrome = await 크롬찾기();
  if (!chrome) { console.log("  (크롬이 없어 브라우저 시험은 건너뜁니다 — GARASADAE_CHROME 으로 알려 줄 수 있습니다)"); return; }

  구역("브라우저 — 진짜 화면 + 진짜 서버 (탭 일곱 · 담기→올리기 · 열쇠 찾기 · 이행 보류 띠)");
  await 모래상자(async (dir) => {
    const g = new 가짜구글();
    const a = await 채널준비(dir, g, { name: "채널A", c: "a", conf: { times: ["09:00", "18:00"], publish: "now", after_upload: "keep" } });
    await 영상두기(a.folder, "a1.mp4", { sec: 30, txt: "첫 제목\n\n설명 한 줄\n\n#태그1 #태그2" });
    await 영상두기(a.folder, "a2.mp4");
    for (let i = 1; i <= 3; i++) {
      g.addVideo({ id: `V${i}`, channelId: a.id, snippet: { title: `올린 영상 ${i}`, publishedAt: new Date(Date.now() - i * 86400000).toISOString() }, statistics: { viewCount: String(100 * i) } });
      await appendLedger({ 업로드시각: `2026-10-1${i}T09:00:00`, 채널: "채널A", 영상ID: `V${i}`, 제목: `올린 영상 ${i}`, 파일: `/f/${i}.mp4`, 길이초: "40.0", 해상도: "1080x1920", 공개설정: "public" });
    }
    setAiBackend({ meta: () => Promise.reject(new Error("쓰지 않는다")), text: ({ key }) => (key.includes("GOOD") ? Promise.resolve("{}") : Promise.reject(new Error("거절됨"))) });
    const home = Deno.env.get("GARASADAE_HOME")!;
    await Deno.mkdir(join(home, ".volcano", "keys"), { recursive: true });
    await Deno.writeTextFile(join(home, ".volcano", "keys", "gemini"), "AIza" + "GOOD" + "x".repeat(31) + "\n");
    const s = await startServer({ port: 0, tick: false, autoUpdate: false });
    const p = await 크롬열기(chrome);
    if (!p) { await s.shutdown(); 같나("크롬을 띄웠다", false, true); return; }
    try {
      await p.go(s.url + "/");
      await sleep(3500);
      같나("화면이 떴다 (제목)", await p.ev("document.title"), "가라사대 업로더");
      const 탭들 = (await p.ev("[...document.querySelectorAll('.tab')].map(t=>t.dataset.tab||t.id)")) as string[];
      같나("탭 일곱", 탭들, ["t1", "t2", "t7", "t3", "t4", "t5", "t6"]);
      for (const t of 탭들) {
        const 앞 = p.errs.length;
        await p.ev(`swTab('${t}'), true`);
        await sleep(1500);
        같나(`탭 ${t}: 자바스크립트 오류 없음`, p.errs.slice(앞), []);
      }

      // 담기 → 올리기 → 확인 창 → 올리기
      await p.ev("swTab('t1'), true"); await sleep(2000);
      같나("영상 벽에 카드가 나왔다", await p.ev("document.querySelectorAll('#t1Wall button').length > 0"), true);
      같나("첫 카드 「담기」", await p.ev("(()=>{const b=[...document.querySelectorAll('#t1Wall button')].find(b=>b.textContent.includes('담기')); if(!b) return false; b.click(); return true})()"), true);
      await sleep(600);
      같나("장바구니에 한 줄", await p.ev("document.querySelectorAll('#t1CartList > *').length"), 1);
      같나("「올리기」 → 확인 창이 열린다", await p.ev("(()=>{const b=document.getElementById('t1GoBtn'); if(!b) return false; b.click(); return true})()"), true);
      await sleep(1500);
      같나("확인 창 열림 · 표에 한 개", [await p.ev("document.getElementById('t1MTicket')?.classList.contains('on')"), String(await p.ev("document.getElementById('t1TkSub')?.textContent")).includes("총 1개")], [true, true]);
      같나("확인 창의 「올리기」", await p.ev("(()=>{const b=document.getElementById('t1TkGo'); if(!b) return false; b.click(); return true})()"), true);
      for (let i = 0; i < 80 && readLedger().length < 4; i++) await sleep(250);
      같나("진짜 서버가 올렸다 — 원장에 한 줄 더 (비공개 업로드)", [readLedger().length, g.videos.size], [4, 4]);
      await sleep(1500);
      참인가("진행 창에 끝났다는 글이 나온다", String(await p.ev("document.getElementById('t1PgTitle')?.textContent")).includes("올렸습니다"));
      같나("올리기 흐름에 자바스크립트 오류·실패한 요청이 없다", [p.errs, p.bad], [[], []]);

      // 열쇠 창 — 이 컴퓨터에서 찾은 열쇠
      await p.ev("(typeof closeModal==='function') && document.querySelectorAll('.modal.on').forEach(m=>closeModal(m.id)), true"); await sleep(300);
      await p.ev("openAi(), true"); await sleep(5000);
      const 줄 = (await p.ev("[...document.querySelectorAll('#kyAiFind .mo-fr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim())")) as string[];
      같나("열쇠 창이 이 컴퓨터에서 찾은 열쇠를 가려서 보인다 (찾은 자리와 시험 통과)", [줄.length, 줄[0]?.includes("AIza…xxxx"), 줄[0]?.includes("~/.volcano/keys/gemini"), 줄[0]?.includes("통과")], [1, true, true, true]);
      같나("화면에 열쇠 전체 값이 없다", String(await p.ev("document.body.innerText")).includes("AIza" + "GOOD" + "x".repeat(31)), false);
      같나("「이걸로 쓰기」", await p.ev("(()=>{ if(typeof moKeyUse!=='function') return false; moKeyUse('ai'); return true })()"), true);
      await sleep(3500);
      같나("연결됐다 — 헤더 단추가 바뀌고 상태가 connected", [await p.ev("document.getElementById('aiBtn')?.textContent?.trim()"), (await (await fetch(s.url + "/api/state")).json()).ai.connected], ["✨ AI 연결됨 · 바꾸기", true]);

      // 이행 보류 띠
      await setHold({ backupDir: join(dataDir(), "백업", "이행전_가짜"), oldDir: dataDir(), reasons: ["시험으로 건 멈춤"], missing: ["[채널A] 로그인 정보가 새 앱에 온전히 옮겨지지 않았습니다"], oldChannels: 1, newChannels: 1 });
      await sleep(4000);
      같나("이행 보류 띠가 맨 위에 뜬다 (복사본 위치 · 다시 옮기기)", [
        await p.ev("(()=>{const b=document.getElementById('migBar'); return !!b && !b.classList.contains('hide') && b.offsetHeight>0})()"),
        String(await p.ev("document.getElementById('migBar')?.textContent")).includes("이행전_가짜"),
      ], [true, true]);
      같나("끝까지 자바스크립트 오류·실패한 요청이 없다", [p.errs, p.bad], [[], []]);
    } finally { await p.close(); await s.shutdown(); setAiBackend(null); g.uninstall(); }
  });
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

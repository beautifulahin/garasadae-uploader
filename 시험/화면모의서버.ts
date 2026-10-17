// 화면 모의 서버 — 진짜 서버(app/server.ts) 없이 화면만 띄워 보는 도구. 구글에는 한 번도 닿지 않는다.
//
//   deno run -A --no-lock 시험/화면모의서버.ts [포트=8899]
//
// 규칙
//  · `/` 는 app/ui.html + app/ui/*.html 을 합친 한 장, `/ui/파일` 은 app/ui/ 의 파일.
//  · `/api/<경로>` 는 시험/모의/api_<경로의 /를 _로>.json 파일을 그대로 돌려준다(예: /api/inventory → api_inventory.json).
//    파일이 없으면 `{"ok":true}`. 몸이 있는 요청(POST)은 같은 파일 이름에 `.post` 를 붙인 파일(api_x.post.json)이 있으면 그것을 먼저 쓴다.
//  · 요청은 콘솔에 한 줄씩 남는다(어떤 약속으로 부르는지 화면 쪽에서 확인용).
//  · 영상(/media)·그림(/thumb, /art)은 아주 작은 자리표시 그림으로 답한다.
import { composePage, readAsset } from "../app/uipage.ts";

const port = Number(Deno.args[0] ?? 8899);
const MOCK = new URL("./모의/", import.meta.url);
// 1x1 투명 PNG
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

async function fixture(name: string): Promise<string | null> {
  try { return await Deno.readTextFile(new URL(name, MOCK)); } catch { return null; }
}

Deno.serve({ port, hostname: "127.0.0.1" }, async (req) => {
  const u = new URL(req.url);
  const p = decodeURIComponent(u.pathname);
  if (p === "/" || p === "/index.html") return new Response(await composePage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (p.startsWith("/ui/")) {
    const a = await readAsset(p.slice(4));
    return a ? new Response(a.body as BodyInit, { headers: { "content-type": a.type, "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
  }
  if (p === "/alive") return new Response("ok");
  if (p === "/favicon.ico") return new Response(null, { status: 204 });
  if (p === "/thumb" || p === "/art") return new Response(PNG, { headers: { "content-type": "image/png" } });
  if (p === "/media") return new Response(PNG, { headers: { "content-type": "image/png" } });   // 영상 자리표시 — 404 로 두면 화면 시험에 콘솔 오류 소음이 생긴다
  if (p.startsWith("/api/")) {
    const key = "api_" + p.slice(5).replaceAll("/", "_");
    let body = "";
    if (req.method !== "GET") { try { body = await req.text(); } catch { /* 몸이 없다 */ } }
    console.log(`${req.method} ${p}${u.search}${body ? "  " + body.slice(0, 160) : ""}`);
    const txt = (req.method !== "GET" ? await fixture(key + ".post.json") : null) ?? await fixture(key + ".json") ?? '{"ok":true}';
    return new Response(txt, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response("not found", { status: 404 });
});
console.log(`화면 모의 서버 — http://127.0.0.1:${port}/`);

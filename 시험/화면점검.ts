// 화면 점검 — 앱을 띄우지 않고 합쳐진 화면(ui.html + ui/*.html)과 화면 코드(ui/*.js)의 짜임새를 본다.
//
// 지금까지 실제로 냈던 실수를 다시 내지 않으려는 검사기다 (2026-08-19 실제 사고: style 묶음을 잃어 팝업이 본문에 나열됨).
//   · 필수 스타일이 있나 · 중괄호가 맞나 · 팝업이 기본으로 숨겨지나
//   · id 중복 · 태그 짝 · 이어 붙이는 조각이 모두 읽혔나 · 불러오는 스크립트가 모두 있나
//   · 버튼이 부르는 함수가 실제로 전역에 있나 (조각 안 즉시실행 함수에 갇힌 함수를 부르는 실수까지)
//   · 화면 코드 문법 · getElementById 로 찾는 id 가 실제로 있나 · 서버에 없는 길을 부르지 않나
import { 같나, 결과, 구역, 참인가 } from "./도구.ts";
import { composePage, readAsset } from "../app/uipage.ts";
import { buildRoutes, newAppState } from "../app/routes.ts";

const 필수CSS = [".modal{", ".modal.on{", ".modal-box{", ".mbtn{", ".panel{", ".tabs{", ".tab{", ".hdr{", ".card{", ".toast{", ".go{", ".tb{", ".kv{", ".seg{", ".tgl{"];

/** 화면이 바로 아는 전역 이름 (브라우저가 주는 것) */
const 브라우저전역 = new Set(["alert", "confirm", "prompt", "open", "close", "print", "event", "this", "window", "document", "if", "return", "void", "history", "location", "setTimeout", "setInterval", "fetch", "console", "Math", "Number", "String", "JSON", "Array", "Object", "Promise", "encodeURIComponent", "decodeURIComponent", "parseInt", "parseFloat", "navigator", "clearTimeout", "stopPropagation", "preventDefault", "getSelection"]);

const 소스들: { 이름: string; 글: string }[] = [];

/** `{` 바로 뒤에서 시작해 짝이 맞는 `}` 까지의 객체 글에서, 맨 바깥 칸의 키 이름들(안쪽 중괄호·괄호·문자열 속은 건너뛴다) */
function 맨위키(src: string, from: number): string[] {
  let depth = 1, top = "", 문자열 = "";
  for (let i = from; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (문자열) { if (c === "\\") i++; else if (c === 문자열) 문자열 = ""; continue; }
    if (c === "'" || c === '"' || c === "`") { 문자열 = c; continue; }
    if (c === "{" || c === "(" || c === "[") { depth++; continue; }
    if (c === "}" || c === ")" || c === "]") { depth--; continue; }
    if (depth === 1) top += c;
  }
  return [...top.matchAll(/(?:^|[,\s])([A-Za-z_$][\w$]*)\s*(?::|,|$)/g)].map((m) => m[1]);
}

async function 읽기() {
  const html = await composePage();
  const 스크립트주소 = [...html.matchAll(/<script[^>]*\ssrc="(\/ui\/[^"]+)"/g)].map((m) => m[1].slice(4));
  const js: Record<string, string> = {};
  for (const n of 스크립트주소) {
    const a = await readAsset(n);
    js[n] = a ? new TextDecoder().decode(a.body) : "";
  }
  return { html, 스크립트주소, js };
}

/** 태그 짝 — <script>·<style> 안은 건너뛰고, 닫는 태그가 열린 것과 맞는지 */
function 태그균형(html: string): string[] {
  const 본문 = html.replace(/<script[\s\S]*?<\/script>/gi, "<script></script>").replace(/<style[\s\S]*?<\/style>/gi, "<style></style>").replace(/<!--[\s\S]*?-->/g, "");
  const 비어있는 = new Set(["meta", "link", "br", "img", "input", "hr", "source", "area", "base", "col", "embed", "wbr", "track", "param"]);
  const stack: string[] = [];
  const 문제: string[] = [];
  for (const m of 본문.matchAll(/<\/?([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const 닫음 = m[0].startsWith("</"), 이름 = m[1].toLowerCase();
    if (비어있는.has(이름) || m[2] === "/") continue;
    if (!닫음) { stack.push(이름); continue; }
    if (stack[stack.length - 1] === 이름) stack.pop();
    else if (stack.includes(이름)) { while (stack.length && stack[stack.length - 1] !== 이름) 문제.push(`<${stack.pop()}> 안 닫힘`); stack.pop(); }
    else 문제.push(`</${이름}> 짝 없음`);
  }
  for (const s of stack) 문제.push(`<${s}> 안 닫힘`);
  return 문제;
}

export async function 실행() {
  const { html, 스크립트주소, js } = await 읽기();
  const all = html + "\n" + Object.values(js).join("\n");

  구역("화면 — 스타일과 짜임새");
  const 빠진 = 필수CSS.filter((n) => !html.includes(n));
  같나(`필수 CSS 규칙 ${필수CSS.length}종이 모두 있다`, 빠진, []);
  const 블록 = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  같나(`style 블록 ${블록.length}개의 중괄호가 맞는다`, 블록.map((b, i) => [i + 1, (b.match(/\{/g) ?? []).length - (b.match(/\}/g) ?? []).length]).filter(([, d]) => d !== 0), []);
  const modal = /\.modal\{([^}]*)\}/.exec(html);
  참인가("팝업(.modal)은 기본으로 숨겨진다 — 본문에 나열되지 않는다", !!modal && modal[1].includes("display:none"));
  참인가("조각 읽기 실패 표시가 없다 (<!--@include …--> 가 모두 채워졌다)", !/를 읽지 못했습니다 -->/.test(html) && !/<!--@include /.test(html));

  구역("화면 — id 와 태그");
  // JS 가 만드는 글(템플릿 문자열)의 id 는 런타임에 하나씩이라 HTML 만 본다
  const ids = [...html.replace(/<script[\s\S]*?<\/script>/gi, "").matchAll(/\sid="([^"$`{}]+)"/g)].map((m) => m[1]);
  const 중복 = Object.entries(ids.reduce((o: Record<string, number>, k) => (o[k] = (o[k] ?? 0) + 1, o), {})).filter(([, n]) => n > 1).map(([k]) => k);
  같나(`id 중복 없음 (${ids.length}개)`, 중복, []);
  같나("태그가 모두 짝이 맞는다", 태그균형(html), []);

  구역("화면 — 스크립트");
  같나(`불러오는 스크립트 ${스크립트주소.length}개가 모두 실제로 있다`, 스크립트주소.filter((n) => !js[n]), []);
  const 문법: string[] = [];
  for (const [n, src] of Object.entries(js)) {
    try { new Function(src); } catch (e) { 문법.push(`${n}: ${(e as Error).message}`); }
  }
  같나("화면 코드 문법 오류 없음", 문법, []);

  // 버튼이 부르는 함수 — 전역(window 에 달았거나 맨 윗줄 선언)에 있어야 한다
  const 정의 = new Set<string>();
  for (const src of [html.match(/<script>[\s\S]*?<\/script>/g)?.join("\n") ?? "", ...Object.values(js)]) {
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) 정의.add(m[1]);
    for (const m of src.matchAll(/Object\.assign\(\s*window\s*,\s*\{/g)) for (const k of 맨위키(src, m.index! + m[0].length)) 정의.add(k);
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) 정의.add(m[1]);
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) 정의.add(m[1]);
  }
  const 부름 = new Map<string, Set<string>>();
  for (const [출처, src] of [["ui.html+조각", html], ...Object.entries(js)] as [string, string][]) {
    for (const m of src.matchAll(/\son(?:click|input|change|submit|keydown|keyup|focus|blur|dragover|drop|dragenter|dragleave|mouseover|mouseout|load|error)=\\?["']([^"'`]*)/g)) {
      for (const f of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (브라우저전역.has(f[1])) continue;
        if ((부름.get(f[1]) ?? 부름.set(f[1], new Set()).get(f[1])!).add(출처)) continue;
      }
    }
  }
  const 없는함수 = [...부름.entries()].filter(([n]) => !정의.has(n)).map(([n, 출처]) => `${n} (${[...출처].join(", ")})`);
  같나(`버튼이 부르는 함수 ${부름.size}개가 모두 전역에 있다`, 없는함수, []);

  // getElementById / $() 로 찾는 id 가 실제로 있나 (HTML 이나 JS 가 만드는 글 어디에든)
  const 찾는id = new Set<string>();
  for (const src of Object.values(js)) {
    for (const m of src.matchAll(/(?:getElementById|\$)\(\s*['"]([\w\-]+)['"]\s*\)/g)) 찾는id.add(m[1]);
  }
  const 있는id = new Set([...all.matchAll(/\sid=\\?["']([\w\-${}.]+)\\?["']/g)].map((m) => m[1]));
  const 없는id = [...찾는id].filter((k) => !있는id.has(k) && ![...있는id].some((x) => x.includes("${") && new RegExp("^" + x.replace(/\$\{[^}]*\}/g, ".*") + "$").test(k)));
  같나(`getElementById 로 찾는 id ${찾는id.size}개가 모두 어딘가에 있다`, 없는id, []);

  구역("화면 — 서버와의 약속");
  const 길 = buildRoutes(newAppState() as never);
  const 있는길 = new Set([...Object.keys(길.get), ...Object.keys(길.post)]);
  const 쓰는길 = new Map<string, Set<string>>();
  for (const [출처, src] of [["ui.html", html], ...Object.entries(js)] as [string, string][]) {
    for (const m of src.matchAll(/['"`]\/api\/([A-Za-z0-9_\/\-]+)(?:\?[^'"`]*)?['"`]/g)) {
      (쓰는길.get(m[1]) ?? 쓰는길.set(m[1], new Set()).get(m[1])!).add(출처);
    }
  }
  같나(`화면이 부르는 길 ${쓰는길.size}개가 모두 서버에 있다`, [...쓰는길.entries()].filter(([k]) => !있는길.has(k)).map(([k, v]) => `${k} (${[...v].join(", ")})`), []);
  void 소스들;
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

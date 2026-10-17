// 화면 조각을 한 장으로 합치고(ui.html + ui/*.html) 정적 파일(ui/*.js)을 내준다.
//
// 화면은 탭마다 파일이 따로다: app/ui.html 이 껍데기이고, `<!--@include t1.html-->` 자리에 app/ui/t1.html 이 들어간다.
// 컴파일된 실행 파일에서는 `deno compile --include app/ui.html --include app/ui` 로 함께 묶여 있다.
// 개발 중(`deno run`)에는 매 요청마다 디스크에서 읽어, 파일을 고치고 새로고침만 하면 바로 보인다.

const UI_DIR = new URL("./ui/", import.meta.url);
const SHELL = new URL("./ui.html", import.meta.url);

const TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
};

/** 이름이 안전한가 — 폴더를 벗어나는 것(../)·숨김 파일·모르는 확장자는 내주지 않는다 */
export function safeAssetName(name: string): boolean {
  return /^[\p{L}\p{N}_.\-]+$/u.test(name) && !name.startsWith(".") && !name.includes("..") && /\.(js|css|html|svg|png|ico)$/.test(name);
}

export async function readAsset(name: string): Promise<{ body: Uint8Array; type: string } | null> {
  if (!safeAssetName(name)) return null;
  try {
    const body = await Deno.readFile(new URL(name, UI_DIR));
    return { body, type: TYPES[name.split(".").pop()!] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** ui.html 의 `<!--@include 이름.html-->` 자리를 ui/이름.html 로 채운 한 장 */
export async function composePage(): Promise<string> {
  let html = await Deno.readTextFile(SHELL);
  const names = [...html.matchAll(/<!--@include ([\p{L}\p{N}_.\-]+)-->/gu)].map((m) => m[1]);
  for (const n of new Set(names)) {
    let part = "";
    try {
      part = await Deno.readTextFile(new URL(n, UI_DIR));
    } catch {
      part = `<!-- ${n} 를 읽지 못했습니다 -->`;
    }
    html = html.split(`<!--@include ${n}-->`).join(part);
  }
  return html;
}

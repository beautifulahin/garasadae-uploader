// 운영체제 도구 — 폴더·주소 열기 · 폴더/파일 선택창 · 잠 안 자기 · 클립보드 · **자동 실행 등록**.
// (옛 앱 v1.8.4 의 platform.ts 를 새 paths.ts 에 맞춰 다시 쓴 것. 알림은 notify.ts, 휴지통은 trash.ts 가 한다 — 여기에는 없다.)
//
// 자동 실행은 작업이 **둘**이다 (파이썬 업로더의 launchd 작업 둘과 같은 구조):
//   · serve  — 로그인할 때 화면 서버를 띄운다 (`<실행파일> --background`). 죽으면 다시 띄운다.
//   · review — 10분마다 심사확인 한 번 (`<실행파일> 심사확인`). 서버가 죽어 있어도 심사 결과는 챙긴다.
//   맥: LaunchAgent 둘(`<APP_ID>.serve` · `<APP_ID>.review`) · 윈도우: 시작 프로그램 .vbs + 작업 스케줄러 · 리눅스: .desktop (+ cron 안내)
//
// 지키는 약속
//   · 명령은 전부 한 문(`setRunner`)을 지난다 — 시험은 가짜 실행기를 끼워 launchctl·schtasks·선택창을 한 번도 진짜로 안 부른다.
//   · 시험은 진짜 `~/Library/LaunchAgents` 에 쓰지 않는다: 모든 자리는 homeDir() 을 지나므로 GARASADAE_HOME 으로 돌린다.
//   · 이 앱이 만든 파일에는 표식(MARK)을 박는다. **표식이 없는 같은 이름의 작업은 남의 것**(예: 파이썬 업로더)이라
//     덮어쓰지도 끄지도 않는다 — 켜려 하면 오류로 멈춘다. (남의 작업을 bootout 하면 그쪽이 죽는다.)
import {
  APP_ID, APP_NAME, cut, dataPath, env, exists, fromBase64, homeDir, IS_MAC, IS_WIN, isDir, join, log, recordPath,
  writeTextAtomic, 줄서서,
} from "./paths.ts";
import { dateOnly, wallNow } from "./clock.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ============================================================ 운영체제 · 명령 실행기 */

export type Os = "mac" | "win" | "linux";
let osForTest: Os | null = null;
/** 시험: 다른 운영체제 길로 간다 (null 이면 지금 컴퓨터) */
export function setOsForTest(os: Os | null) { osForTest = os; }
const currentOs = (): Os => osForTest ?? (IS_MAC ? "mac" : IS_WIN ? "win" : "linux");

export interface CmdOpts {
  /** 표준 입력으로 넣을 글 (클립보드) */
  input?: string;
  /** 값은 명령 글에 끼우지 않고 환경변수로 넘긴다 — 따옴표·역슬래시가 든 글에 깨지거나 명령으로 읽히지 않게 */
  env?: Record<string, string>;
  /** 띄워 놓고 기다리지 않는다 (폴더·주소 열기) */
  detach?: boolean;
  /** 출력을 받지 않고 끝나기만 기다린다 (뒤에 남는 도구가 출력 통로를 붙잡고 있는 경우: xclip · wl-copy) */
  quiet?: boolean;
}
export interface CmdResult { code: number; stdout: string; stderr: string }
export type CmdRunner = (cmd: string, args: string[], opts?: CmdOpts) => Promise<CmdResult>;

/** 오프라인 시험이거나 GARASADAE_NO_DESKTOP=1 이면 진짜 명령을 아예 안 부른다 — 시험 중에 선택창·브라우저가 뜨지 않게 */
const desktopOff = () => env("GARASADAE_OFFLINE") === "1" || env("GARASADAE_NO_DESKTOP") === "1";

const realRunner: CmdRunner = async (cmd, args, opts = {}) => {
  if (desktopOff()) return { code: 126, stdout: "", stderr: "시험 모드 — 명령을 실행하지 않았습니다" };
  try {
    const pipe = opts.detach || opts.quiet ? "null" : "piped";
    const child = new Deno.Command(cmd, {
      args, env: opts.env,
      stdin: opts.input !== undefined ? "piped" : "null", stdout: pipe, stderr: pipe,
    }).spawn();
    if (opts.input !== undefined) {
      const w = child.stdin.getWriter();
      await w.write(enc.encode(opts.input));
      await w.close();
    }
    if (opts.detach) { child.unref?.(); return { code: 0, stdout: "", stderr: "" }; }
    if (opts.quiet) return { code: (await child.status).code, stdout: "", stderr: "" };
    const out = await child.output();
    return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  } catch (e) {
    // 없는 명령(NotFound)도 여기로 온다 — 127 은 「명령이 없다」는 뜻으로 부르는 쪽이 읽는다
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

let runner: CmdRunner = realRunner;
/** 시험: 가짜 명령 실행기를 끼운다 (null 이면 진짜로) */
export function setRunner(r: CmdRunner | null) { runner = r ?? realRunner; }
const run = (cmd: string, args: string[], opts?: CmdOpts) => runner(cmd, args, opts);
/** 열어 놓고 잊는다 — 명령이 있고 시작되면 true (explorer 처럼 성공해도 종료 코드가 1 인 것이 있어 코드는 안 본다) */
async function fire(cmd: string, args: string[], extra: CmdOpts = {}): Promise<boolean> {
  const r = await run(cmd, args, { detach: true, ...extra });
  if (r.code === 127) await log(`(명령 실행 실패: ${cmd} — ${cut(r.stderr, 80)})`);
  return r.code !== 127;
}

/* ============================================================ 실행 파일 · 개발 실행 판별 */

let exeOverride: string[] | null = null;
/** 시험: 실행 파일을 이 명령줄로 친다 (컴파일 판인 것처럼). null 이면 원래대로 */
export function setExeForTest(argv: string[] | null) { exeOverride = argv ? [...argv] : null; }

/** 개발 중(deno run)인가 아닌가. 개발 중에는 자동 시작을 등록하지 않는다. */
export function isCompiled(): boolean {
  if (exeOverride) return true;
  const p = Deno.execPath().toLowerCase();
  return !(p.endsWith("/deno") || p.endsWith("deno.exe"));
}

/** 개발 실행일 때 main.ts 의 자리 (이 파일과 같은 폴더) */
function mainTsPath(): string {
  const p = decodeURIComponent(new URL("./main.ts", import.meta.url).pathname);
  return IS_WIN ? p.replace(/^\//, "").replace(/\//g, "\\") : p;
}

/** 이 프로그램을 다시 띄우는 명령줄 (실행 파일 + 앞 인자들). 컴파일 판이면 실행 파일 하나. */
export function exeArgv(): string[] {
  if (exeOverride) return [...exeOverride];
  if (isCompiled()) return [Deno.execPath()];
  return [Deno.execPath(), "run", "-A", mainTsPath()];
}

/** 사람이 읽는 꼴의 실행 명령 — 컴파일 판은 실행 파일 경로, 개발 실행은 `deno run -A <main.ts>` */
export function exePath(): string {
  const a = exeArgv();
  return a.length === 1 ? a[0] : a.map((x) => /\s/.test(x) ? `"${x}"` : x).join(" ");
}

/* ============================================================ 올리는 동안 잠들지 않게 붙든다 */
// 맥이 잠들면 업로드가 멈춘다. 큰 편을 걸어 두고 자리를 뜨면 아침에 와서야 「왜 안 올라갔지?」를 알게 된다.
//   ★`caffeinate -i` 는 **화면만 꺼지고 시스템은 안 자게** 한다. 뚜껑을 닫으면 그래도 잔다 — 그건 맥이 양보하지 않는 자리다.
//   ★올리는 **동안만** 붙든다. 늘 붙들면 안 쓸 때도 컴퓨터가 안 잔다.
//   ★붙들이는 이 프로그램이 죽으면 저도 따라 죽는다(-w / Wait-Process / tail --pid) — 고아로 남아 잠을 막지 않게.

export interface Hold { kill(): void }
export type HoldSpawner = (cmd: string, args: string[], env?: Record<string, string>) => Hold | null;

const realHold: HoldSpawner = (cmd, args, e) => {
  if (desktopOff()) return null;
  try {
    const child = new Deno.Command(cmd, { args, env: e, stdout: "null", stderr: "null", stdin: "null" }).spawn();
    // 바로 놓아 둔다 — 붙들이가 이벤트 고리를 잡고 있으면 작업이 끝나도 프로그램이 안 끝난다(명령줄 판)
    child.unref?.();
    return { kill: () => { try { child.kill(); } catch { /* 이미 죽었다 */ } } };
  } catch { return null; }          // 없는 명령이면 그냥 넘어간다
};
let holdSpawner: HoldSpawner = realHold;
/** 시험: 가짜 붙들이를 끼운다 */
export function setHoldSpawner(s: HoldSpawner | null) { holdSpawner = s ?? realHold; }

let hold: Hold | null = null;
let holdWarned = false;
export const isAwakeHeld = () => hold !== null;

// 윈도우: SetThreadExecutionState 를 부른 쓰레드가 살아 있는 동안만 효과가 있다 → 숨은 PowerShell 이 이 프로그램을 기다리며 쥔다
const PS_AWAKE = `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$api = Add-Type -MemberDefinition $sig -Name 'GuAwake' -Namespace 'Gu' -PassThru
[void]$api::SetThreadExecutionState([uint32]2147483649)
try { Wait-Process -Id ([int]$env:GU_PID) } catch { }`.trim();

export function keepAwake(): void {
  if (hold) return;
  const pid = String(Deno.pid);
  const os = currentOs();
  hold = os === "mac" ? holdSpawner("caffeinate", ["-i", "-w", pid])
    : os === "win" ? holdSpawner("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", PS_AWAKE], { GU_PID: pid })
    : holdSpawner("systemd-inhibit", ["--what=idle:sleep", `--who=${APP_NAME}`, "--why=업로드 중", "--mode=block", "tail", `--pid=${pid}`, "-f", "/dev/null"]);
  if (!hold && !holdWarned && !desktopOff()) {
    holdWarned = true;
    void log("(잠 깨워두기를 켜지 못했습니다 — 이 컴퓨터에는 그 명령이 없습니다. 올리는 동안 컴퓨터가 잠들면 멈출 수 있습니다)");
  }
}

export function allowSleep(): void {
  if (!hold) return;
  try { hold.kill(); } catch { /* 이미 죽었다 */ }
  hold = null;
}

/** 옛 이름 (v1 의 코드가 그대로 부른다) */
export const 잠깨워두기 = keepAwake;
export const 잠깨우기끝 = allowSleep;

/* ============================================================ 폴더 · 주소 열기 */

export async function openPath(p: string): Promise<boolean> {
  const t = p.startsWith("-") ? `./${p}` : p;      // 「-」로 시작하면 명령의 옵션으로 읽힌다
  const os = currentOs();
  if (os === "mac") return await fire("open", [t]);
  if (os === "win") return await fire("explorer", [t.replace(/\//g, "\\")]);
  return await fire("xdg-open", [t]);
}

/** 이 컴퓨터에서 쓸 수 있는 브라우저 목록 */
export async function listBrowsers(): Promise<{ id: string; name: string }[]> {
  const found: { id: string; name: string }[] = [];
  const os = currentOs();
  if (os === "mac") {
    const macApps = [
      ["Google Chrome", "크롬"], ["Safari", "사파리"], ["Microsoft Edge", "엣지"],
      ["Firefox", "파이어폭스"], ["Whale", "웨일"], ["Arc", "Arc"], ["Brave Browser", "브레이브"],
    ];
    // 시스템 폴더와 내 폴더(~/Applications) 둘 다 본다 — 관리자 권한 없이 깐 브라우저도 찾는다
    for (const [app, label] of macApps) {
      if (await exists(`/Applications/${app}.app`) || await exists(join(homeDir(), "Applications", `${app}.app`))) {
        found.push({ id: app, name: label });
      }
    }
  } else if (os === "win") {
    const winApps = [
      ["chrome.exe", "크롬"], ["msedge.exe", "엣지"], ["firefox.exe", "파이어폭스"],
      ["whale.exe", "웨일"], ["brave.exe", "브레이브"],
    ];
    const roots = [env("PROGRAMFILES"), env("PROGRAMFILES(X86)"), env("LOCALAPPDATA")].filter(Boolean);
    const paths: Record<string, string[]> = {
      "chrome.exe": ["Google\\Chrome\\Application\\chrome.exe"],
      "msedge.exe": ["Microsoft\\Edge\\Application\\msedge.exe"],
      "firefox.exe": ["Mozilla Firefox\\firefox.exe"],
      "whale.exe": ["Naver\\Naver Whale\\Application\\whale.exe"],
      "brave.exe": ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
    };
    for (const [exe, label] of winApps) {
      for (const root of roots) {
        for (const rel of paths[exe] ?? []) {
          if (await exists(join(root, rel))) { found.push({ id: exe, name: label }); break; }
        }
        if (found.some((f) => f.id === exe)) break;
      }
    }
  } else {
    const linuxApps = [
      ["google-chrome", "크롬"], ["chromium", "크로미엄"], ["chromium-browser", "크로미엄"], ["firefox", "파이어폭스"],
      ["brave-browser", "브레이브"], ["microsoft-edge", "엣지"],
    ];
    const dirs = env("PATH").split(":").filter(Boolean);
    for (const [bin, label] of linuxApps) {
      for (const d of dirs) {
        if (await exists(join(d, bin))) { found.push({ id: bin, name: label }); break; }
      }
    }
  }
  return found;
}

/** 주소를 연다. http(s) 만 연다 — 다른 갈래(file: · 앱 주소)는 아무 프로그램이나 띄울 수 있어 막는다. 열렸다고 믿을 수 있으면 true */
export async function openUrl(u: string, browser = ""): Promise<boolean> {
  const url = String(u ?? "").trim();
  if (!/^https?:\/\//i.test(url)) {
    await log(`(주소를 열지 않았습니다 — http 로 시작하는 주소만 엽니다: ${cut(url, 40)})`);
    return false;
  }
  const os = currentOs();
  if (os === "mac") return await fire("open", browser ? ["-a", browser, url] : [url]);
  if (os === "win") {
    // cmd 의 start 는 주소 안의 & 를 명령 끊기로 읽는다 — 셸을 거치지 않는 길로 연다
    if (browser) {
      return await fire("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
        "Start-Process -FilePath $env:GU_BROWSER -ArgumentList ('\"' + $env:GU_URL + '\"')"],
        { env: { GU_BROWSER: browser, GU_URL: url } });
    }
    return await fire("rundll32", ["url.dll,FileProtocolHandler", url]);
  }
  return await fire(browser || "xdg-open", [url]);
}

/* ── 이미 열려 있는 우리 탭을 다시 쓴다 ──────────────────────────────
   사용자 지시(2026-08-21): "새 창을 기존 창과 중복으로 띄우되 리프레쉬로 대체를 하든지, 새 창을 안 띄우고 기존 창을 이용하든지."

   ★왜 화면 쪽(ui.html)만으로는 안 되나 — 브라우저는 **스크립트가 열지 않은 탭의 window.close() 를 막는다.**
     그래서 옛 창은 덮개만 씌운 채 그대로 남았다. 닫지 못한다면 **애초에 새 탭을 안 만들면 된다.**
     여기서는 브라우저에게 「그 주소를 이미 띄운 탭을 찾아, 그 자리에서 다시 불러라」고 시킨다.
   ★주소는 스크립트 글에 끼우지 않고 인자(argv)로 넘긴다 — 따옴표·역슬래시가 든 주소에 스크립트가 깨지지 않게.

   되면 true. 자동화 권한이 없거나 그런 탭이 없으면 false → 부르는 쪽이 새로 연다. */
const 크롬계열 = ["Google Chrome", "Brave Browser", "Microsoft Edge", "Whale", "Vivaldi", "Chromium", "Opera"];

async function runningBrowsers(): Promise<string[]> {
  const r = await run("/bin/ps", ["-Ao", "comm="]);
  const 것 = new Set<string>();
  for (const 앱 of [...크롬계열, "Safari"]) {
    if (r.stdout.includes(`/${앱}.app/Contents/MacOS/`)) 것.add(앱);
  }
  return [...것];
}

function tabScript(앱: string): string {
  const 사파리 = 앱 === "Safari";
  const 고르기 = 사파리 ? "set current tab of w to tab ti of w" : "set active tab index of w to ti";
  return `on run argv
  set wantBase to item 1 of argv
  set newUrl to item 2 of argv
  tell application "${앱}"
    if it is not running then return "0"
    repeat with wi from 1 to (count windows)
      set w to window wi
      repeat with ti from 1 to (count tabs of w)
        if (URL of tab ti of w) starts with wantBase then
          set URL of tab ti of w to newUrl
          ${고르기}
          set index of w to 1
          activate
          return "1"
        end if
      end repeat
    end repeat
  end tell
  return "0"
end run`;
}

export async function reuseBrowserTab(base: string, url: string, browser = ""): Promise<boolean> {
  if (currentOs() !== "mac") return false;
  const 볼것 = [...new Set([browser, ...(await runningBrowsers())].filter(Boolean))];
  for (const 앱 of 볼것) {
    if (앱 !== "Safari" && !크롬계열.includes(앱)) continue;      // 파이어폭스·Arc 는 못 시킨다
    const r = await run("osascript", ["-e", tabScript(앱), base, url]);
    if (r.code === 0 && r.stdout.trim() === "1") {
      await log(`· 이미 열려 있던 ${앱} 탭을 다시 썼다 — 새 창을 안 띄운다`);
      return true;
    }
  }
  return false;
}
/** 옛 이름 (v1 의 코드가 그대로 부른다) */
export const 쓰던탭에다시 = reuseBrowserTab;

/* ============================================================ 폴더 · 파일 선택창 */
// 한글 윈도우의 콘솔은 한글을 UTF-8 로 내보내지 않는다. 경로를 Base64(영문·숫자뿐)로 받아 이쪽에서 되돌린다.
// 선택창에 줄 글(안내문·시작 자리)은 환경변수로 넘긴다 — 스크립트 글에 끼우지 않는다.

/** 확장자 목록 정리 — ["json", ".JPG", "*.png"] → ["json", "jpg", "png"] (영문·숫자만 남긴다) */
function normExts(filters?: string[]): string[] {
  const out: string[] = [];
  for (const f of filters ?? []) {
    const e = String(f).trim().replace(/^\*?\./, "").toLowerCase();
    if (/^[a-z0-9]+$/.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

const PS_PICK_FOLDER = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:GU_PROMPT
$d.ShowNewFolderButton = $true
if ($env:GU_START) { $d.SelectedPath = $env:GU_START }
$t = New-Object System.Windows.Forms.Form
$t.TopMost = $true
if ($d.ShowDialog($t) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($d.SelectedPath)))
}
$t.Dispose()`.trim();

const PS_PICK_FILE = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = $env:GU_PROMPT
if ($env:GU_START) { $d.InitialDirectory = $env:GU_START }
if ($env:GU_FILTER) { $d.Filter = $env:GU_FILTER }
$t = New-Object System.Windows.Forms.Form
$t.TopMost = $true
if ($d.ShowDialog($t) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($d.FileName)))
}
$t.Dispose()`.trim();

const POWERSHELL_STA = ["-STA", "-NoProfile", "-WindowStyle", "Hidden", "-Command"];

/** OS 기본 폴더 선택창을 띄운다. 취소하면 null. */
export async function pickFolder(start = "", prompt = "영상을 저장할 폴더를 선택하세요"): Promise<string | null> {
  try {
    const os = currentOs();
    if (os === "mac") {
      const 자리 = start && await isDir(start) ? " default location ((POSIX file (item 2 of argv)) as alias)" : "";
      const script = `on run argv
tell application "System Events" to activate
set f to choose folder with prompt (item 1 of argv)${자리}
return POSIX path of f
end run`;
      const r = await run("osascript", ["-e", script, prompt, start]);
      const out = r.stdout.trim();
      return r.code === 0 && out ? out.replace(/\/$/, "") : null;
    }
    if (os === "win") {
      const r = await run("powershell", [...POWERSHELL_STA, PS_PICK_FOLDER], { env: { GU_PROMPT: prompt, GU_START: start } });
      return fromBase64(r.stdout.trim()) || null;
    }
    let r = await run("zenity", ["--file-selection", "--directory", `--title=${prompt}`, ...(start ? [`--filename=${start.replace(/\/?$/, "/")}`] : [])]);
    if (r.code === 127) r = await run("kdialog", ["--getexistingdirectory", start || homeDir(), "--title", prompt]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch (e) {
    await log(`(폴더 선택창을 띄우지 못했습니다 — ${cut(e instanceof Error ? e.message : String(e), 80)})`);
    return null;      // 취소는 여기로 오지 않는다(종료 코드로 null) — 여기는 선택창을 띄울 수 없는 환경
  }
}

/**
 * OS 파일 선택창. 취소하면 null.
 * filters 는 허용할 확장자 목록(점 없이) — 예: ["json"] · ["jpg", "png"]. 비우면 모든 파일.
 */
export async function pickFile(prompt: string, start = "", filters?: string[]): Promise<string | null> {
  try {
    const exts = normExts(filters);
    const os = currentOs();
    if (os === "mac") {
      // 확장자는 영문·숫자만 남긴 것이라 스크립트 글에 바로 넣어도 안전하다
      const 종류 = exts.length ? ` of type {${exts.map((e) => `"${e}"`).join(", ")}}` : "";
      const 자리 = start && await isDir(start) ? " default location ((POSIX file (item 2 of argv)) as alias)" : "";
      const script = `on run argv
tell application "System Events" to activate
set f to choose file with prompt (item 1 of argv)${종류}${자리}
return POSIX path of f
end run`;
      const r = await run("osascript", ["-e", script, prompt, start]);
      const out = r.stdout.trim();
      return r.code === 0 && out ? out : null;
    }
    if (os === "win") {
      const filter = exts.length
        ? `지원 파일 (${exts.map((e) => `*.${e}`).join(";")})|${exts.map((e) => `*.${e}`).join(";")}|모든 파일 (*.*)|*.*`
        : "";
      const r = await run("powershell", [...POWERSHELL_STA, PS_PICK_FILE], { env: { GU_PROMPT: prompt, GU_START: start, GU_FILTER: filter } });
      return fromBase64(r.stdout.trim()) || null;
    }
    const 글 = exts.map((e) => `*.${e}`).join(" ");
    let r = await run("zenity", ["--file-selection", `--title=${prompt}`,
      ...(start ? [`--filename=${start.replace(/\/?$/, "/")}`] : []), ...(exts.length ? [`--file-filter=지원 파일 | ${글}`] : [])]);
    if (r.code === 127) {
      r = await run("kdialog", ["--getopenfilename", start || homeDir(), exts.length ? `${글}|지원 파일` : "*", "--title", prompt]);
    }
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch (e) {
    await log(`(파일 선택창을 띄우지 못했습니다 — ${cut(e instanceof Error ? e.message : String(e), 80)})`);
    return null;
  }
}

/* ============================================================ 클립보드 */

/** 글을 클립보드에 넣는다. 됐으면 true. */
export async function clipboardWrite(text: string): Promise<boolean> {
  const os = currentOs();
  if (os === "mac") return (await run("pbcopy", [], { input: text })).code === 0;
  if (os === "win") {
    // clip.exe 는 콘솔 코드 페이지로 읽어 한글이 깨진다 — 환경변수(UTF-16)로 넘기는 PowerShell 이 먼저
    const r = await run("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", "Set-Clipboard -Value $env:GU_TEXT"],
      { env: { GU_TEXT: text } });
    if (r.code === 0) return true;
    return (await run("clip", [], { input: text })).code === 0;
  }
  const 순서: [string, string[]][] = env("WAYLAND_DISPLAY")
    ? [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]]
    : [["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]], ["wl-copy", []]];
  for (const [cmd, args] of 순서) {
    if ((await run(cmd, args, { input: text, quiet: true })).code === 0) return true;
  }
  return false;
}

/* ============================================================ 자동 실행 (두 작업) */

/** 이 앱이 만든 자동 실행 파일에 박는 표식. 표식이 없는 같은 이름의 파일은 남의 것이다. */
const MARK = "garasadae-uploader:autostart v2";
const TICK_SECONDS = 600;
const TICK_MINUTES = TICK_SECONDS / 60;

export const SERVE_LABEL = `${APP_ID}.serve`;
export const REVIEW_LABEL = `${APP_ID}.review`;

/** 같은 이름의 다른 프로그램 작업이 이미 있어 켤 수 없다 — 아무것도 쓰지 않았다 */
export class AutoStartConflict extends Error {
  constructor(message: string, public files: string[]) { super(message); this.name = "AutoStartConflict"; }
}

export interface AutoStartStatus {
  /** 하나라도 켜져 있다 (꺼도 둘 다 치우고, 다시 켜도 모자란 것을 채운다) */
  on: boolean;
  /** 로그인 때 서버를 띄우는 작업 */
  serve: boolean;
  /** 10분마다 심사확인을 하는 작업 */
  tick: boolean;
  /** 이 컴퓨터·이 판에서 두 작업을 이 앱이 다 다룰 수 있나 */
  supported: boolean;
  /** 어떤 방식인지 — 지원이 안 되면 왜 안 되는지 */
  how: string;
  /** 옛 판(v1) 방식의 자동 시작 파일이 남아 있다 — 켜기를 다시 누르면 새 방식으로 갈아끼운다 */
  legacy: boolean;
  /** 같은 이름인데 이 앱이 만든 것이 아닌 작업(다른 프로그램) — 있으면 켤 수 없다 */
  conflict: string[];
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const regEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function readText(path: string): Promise<string | null> {
  try { return await Deno.readTextFile(path); } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}
const isOurs = (text: string | null) => text !== null && text.includes(MARK);

/** 옛 파일을 지우지 않고 옆으로 치운다 — `<이름>.이전_<날짜>` (같은 날 또 치우면 _2, _3…) */
async function moveAside(path: string, toDir?: string): Promise<string> {
  const stamp = dateOnly(wallNow()).replace(/-/g, "");
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const base = toDir ? join(toDir, name) : path;
  if (toDir) await Deno.mkdir(toDir, { recursive: true });
  let dest = `${base}.이전_${stamp}`;
  for (let n = 2; await exists(dest); n++) dest = `${base}.이전_${stamp}_${n}`;
  await Deno.rename(path, dest);
  return dest;
}

/** 작업 둘이 켜진 자리에서도 같은 데이터 폴더를 쓰게 — 따로 정한 자리가 있으면 그대로 넘긴다 */
function passEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["GARASADAE_DATA_DIR", "GARASADAE_HOME"]) if (env(k)) out[k] = env(k);
  return out;
}

const uidOf = () => { try { return Deno.uid() ?? 0; } catch { return 0; } };

/* ── 맥: LaunchAgent 둘 ──────────────────────────────────────── */

const launchAgentsDir = () => join(homeDir(), "Library", "LaunchAgents");
const macPlistPath = (label: string) => join(launchAgentsDir(), `${label}.plist`);
/** 옛 판(v1)의 plist — 이름이 APP_ID 그대로이고 접미가 없다 */
const legacyMacPlist = () => macPlistPath(APP_ID);

interface MacJob { kind: "serve" | "review"; label: string; path: string; text: string }

/**
 * LaunchAgent 글. (파이썬 업로더의 serve · review plist 와 같은 구조)
 *  · serve : RunAtLoad + KeepAlive.
 *      ★KeepAlive 를 `true` 로 두지 않고 「실패로 끝났을 때만 다시」(SuccessfulExit=false)로 둔다.
 *        이미 돌고 있을 때 또 띄워지면 새 판은 「이미 실행 중」이라며 코드 0 으로 끝나는데, `true` 이면 그걸
 *        끝없이 다시 띄운다. 그리고 사람이 앱에서 일부러 종료한 것(코드 0)도 몇 초 뒤에 되살아난다.
 *        죽거나 오류로 끝난 것(코드 ≠ 0 · 신호)만 다시 띄운다.
 *  · review: StartInterval 600 · RunAtLoad 없음 — 로그인하자마자 한 번 돌 까닭이 없다(서버가 곧 돈다).
 */
function macJobs(): MacJob[] {
  const exe = exeArgv();
  const mk = (kind: MacJob["kind"], label: string, args: string[], logFile: string): MacJob => {
    const L: string[] = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<!-- ${MARK} · 이 앱이 만든 파일입니다. 끄려면 앱의 설정에서 끄세요. -->`,
      `<plist version="1.0">`,
      `<dict>`,
      `\t<key>Label</key>`, `\t<string>${xmlEscape(label)}</string>`,
      `\t<key>ProgramArguments</key>`, `\t<array>`, ...args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`), `\t</array>`,
      `\t<key>RunAtLoad</key>`, kind === "serve" ? `\t<true/>` : `\t<false/>`,
    ];
    if (kind === "serve") {
      L.push(`\t<key>KeepAlive</key>`, `\t<dict>`, `\t\t<key>SuccessfulExit</key>`, `\t\t<false/>`, `\t</dict>`,
        `\t<key>ThrottleInterval</key>`, `\t<integer>30</integer>`);
    } else {
      L.push(`\t<key>StartInterval</key>`, `\t<integer>${TICK_SECONDS}</integer>`);
    }
    L.push(`\t<key>StandardOutPath</key>`, `\t<string>${xmlEscape(logFile)}</string>`,
      `\t<key>StandardErrorPath</key>`, `\t<string>${xmlEscape(logFile)}</string>`);
    const e = passEnv();
    if (Object.keys(e).length) {
      L.push(`\t<key>EnvironmentVariables</key>`, `\t<dict>`);
      for (const [k, v] of Object.entries(e)) L.push(`\t\t<key>${xmlEscape(k)}</key>`, `\t\t<string>${xmlEscape(v)}</string>`);
      L.push(`\t</dict>`);
    }
    L.push(`</dict>`, `</plist>`, ``);
    return { kind, label, path: macPlistPath(label), text: L.join("\n") };
  };
  return [
    mk("serve", SERVE_LABEL, [...exe, "--background"], recordPath("자동실행_서버.log")),
    mk("review", REVIEW_LABEL, [...exe, "심사확인"], recordPath("자동실행_심사확인.log")),
  ];
}

/** 옛 판(v1)이 만든 plist 인가 — 이름이 APP_ID 이고, 라벨이 APP_ID 이고, `--background` 를 부르고, 우리 표식이 없다 */
function looksLegacyPlist(text: string | null): boolean {
  if (text === null || text.includes(MARK)) return false;
  if (!new RegExp(`<key>Label</key>\\s*<string>${regEscape(xmlEscape(APP_ID))}</string>`).test(text)) return false;
  return text.includes("--background") && !/python|\/bin\/sh|live_backend/i.test(text);
}

async function launchLoaded(label: string): Promise<boolean> {
  return (await run("launchctl", ["print", `gui/${uidOf()}/${label}`])).code === 0;
}

/**
 * 이 프로세스를 띄운 launchd 작업의 이름 — launchd 가 XPC_SERVICE_NAME 으로 알려 준다.
 * ★자기 자신을 띄운 작업을 bootout 하면 **자기가 죽는다.** 업데이트는 같은 자리의 실행 파일을 갈아끼우므로, 옛 판 자동 시작이
 *   띄운 프로세스가 바로 이 새 판일 수 있다 — 그때 옛 작업을 내리면 새 작업을 올리기 전에 끝나서 자동 시작이 통째로 사라진다.
 *   그래서 자기 작업은 파일만 치우고(다음 로그인부터 적용) 내리지 않는다.
 */
const selfLabel = () => env("XPC_SERVICE_NAME");

/** 옛 판 plist 를 내리고 옆으로 치운다. 치웠으면 치운 자리(자기를 띄운 작업이면 self=true: 내리지 않았다). */
async function retireLegacyMac(): Promise<{ moved: string; self: boolean } | null> {
  const p = legacyMacPlist();
  if (!looksLegacyPlist(await readText(p))) return null;
  const self = selfLabel() === APP_ID;
  if (!self) await run("launchctl", ["bootout", `gui/${uidOf()}/${APP_ID}`]);
  return { moved: await moveAside(p), self };
}

async function macStatus(): Promise<AutoStartStatus> {
  const [serve, review] = macJobs();
  const sCur = await readText(serve.path), rCur = await readText(review.path);
  const conflict: string[] = [];
  if (sCur !== null && !isOurs(sCur)) conflict.push(serve.label);
  if (rCur !== null && !isOurs(rCur)) conflict.push(review.label);
  const legacy = looksLegacyPlist(await readText(legacyMacPlist()));
  const sOn = isOurs(sCur) || legacy;          // 옛 판 plist 도 로그인 때 서버를 띄우고 있다
  const tOn = isOurs(rCur);
  let supported = true;
  let how = `맥 LaunchAgent 둘 — 로그인 때 서버(${SERVE_LABEL}) · ${TICK_MINUTES}분마다 심사확인(${REVIEW_LABEL})`;
  if (!isCompiled()) { supported = false; how = "개발 실행(deno run) 중에는 자동 시작을 등록하지 않습니다"; }
  else if (conflict.length) {
    supported = false;
    how = `같은 이름의 다른 프로그램 작업이 이미 있어 켤 수 없습니다 (${conflict.join(", ")}) — 이 앱이 만든 것이 아니라 덮어쓰거나 끄지 않습니다`;
  }
  return { on: sOn || tOn, serve: sOn, tick: tOn, supported, how, legacy, conflict };
}

async function enableMac(): Promise<string> {
  const jobs = macJobs();
  // 1) 충돌 — 아무것도 쓰기 전에 둘 다 본다. 남의 작업이 하나라도 있으면 하나도 안 쓴다.
  const clash: string[] = [];
  for (const j of jobs) {
    const cur = await readText(j.path);
    if (cur !== null && !isOurs(cur)) clash.push(j.path);
  }
  if (clash.length) {
    throw new AutoStartConflict(
      `자동 실행을 켜지 않았습니다 — 같은 이름의 다른 프로그램 작업이 이미 있습니다.\n${clash.map((c) => `· ${c}`).join("\n")}\n` +
        `이 앱이 만든 파일이 아니라(예: 다른 업로더) 덮어쓰지도, 내리지도 않았습니다. 그 작업을 정리한 뒤 다시 켜 주세요.`,
      clash,
    );
  }
  // 2) 옛 판(v1) 파일 — 지우지 않고 옆으로
  const 치움 = await retireLegacyMac();
  const 자기: string[] = [];       // 이 프로세스를 띄운 작업이라 내리지 못한 것 — 다음 로그인부터 바뀐다
  if (치움?.self) 자기.push(APP_ID);
  // 3) 쓰기 + 올리기. 기록 폴더는 미리 — 없으면 launchd 가 출력 파일을 못 열어 작업이 안 뜬다.
  await Deno.mkdir(launchAgentsDir(), { recursive: true });
  await Deno.mkdir(recordPath(), { recursive: true });
  const uid = uidOf();
  const 문제: string[] = [];
  for (const j of jobs) {
    const cur = await readText(j.path);
    const me = selfLabel() === j.label;          // 이 프로세스가 바로 그 작업이 띄운 것이다
    if (cur === j.text) {
      // 이미 같은 내용이다 — 건드리지 않는다(돌고 있는 서버가 스스로를 내리는 일이 없게). 올라가 있지 않을 때만 올린다.
      if (me || await launchLoaded(j.label)) continue;
    } else {
      if (cur !== null && !me) await run("launchctl", ["bootout", `gui/${uid}/${j.label}`]);     // 우리 것이 바뀌었다 — 내리고 다시 올린다
      await writeTextAtomic(j.path, j.text);
      if (me) { 자기.push(j.label); continue; }  // 돌고 있는 나를 내리고 다시 올릴 수 없다 — 파일만 바꿔 두면 다음 로그인부터 적용된다
    }
    const r = await run("launchctl", ["bootstrap", `gui/${uid}`, j.path]);
    if (r.code !== 0) {
      // 파일은 이미 제자리에 있다 — 다음 로그인 때 launchd 가 저절로 올린다. 다만 지금은 안 떴다는 것을 숨기지 않는다.
      const why = cut((r.stderr || r.stdout).trim(), 120) || `코드 ${r.code}`;
      문제.push(`${j.label}: ${why}`);
      await log(`⚠️  launchctl bootstrap 실패 — ${j.label}: ${why}`);
    }
  }
  let msg = `맥 로그인 때 자동 실행되도록 등록했습니다. (${TICK_MINUTES}분마다 심사확인도 합니다)`;
  if (치움) msg += `\n옛 판의 자동 시작 파일은 지우지 않고 옆으로 치워 두었습니다: ${치움.moved}`;
  if (자기.length) msg += `\n지금 돌고 있는 이 앱을 띄운 작업(${자기.join(", ")})은 내리지 않았습니다 — 다음 로그인부터 새 설정으로 바뀝니다.`;
  if (문제.length) {
    msg += `\n⚠️ 지금 바로 켜지는 못했습니다 — 다음 로그인부터 자동으로 돕니다.\n${문제.map((x) => `· ${x}`).join("\n")}`;
  }
  return msg;
}

async function disableMac(): Promise<string> {
  const [serve, review] = macJobs();
  const uid = uidOf();
  const 끈것: string[] = [], 남의것: string[] = [], 자기: string[] = [];
  // 심사확인(따로 도는 프로세스)을 먼저, 서버를 맨 마지막에 — 서버가 launchd 가 띄운 판이면 bootout 이 자기 자신을 끝낸다.
  // 파일을 먼저 지우고 내린다: 내리는 순간 이 프로세스가 끝나더라도 등록은 이미 지워져 있다.
  const off = async (j: MacJob) => {
    const cur = await readText(j.path);
    if (cur === null) return;
    if (!isOurs(cur)) { 남의것.push(j.label); return; }     // 남의 작업은 내리지도 지우지도 않는다
    try { await Deno.remove(j.path); } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw new Error(`자동 시작 파일을 지우지 못했습니다.\n${j.path}\n\n이유: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (selfLabel() === j.label) 자기.push(j.label);        // 이 프로세스를 띄운 작업 — 내리면 응답도 못 하고 끝난다
    else await run("launchctl", ["bootout", `gui/${uid}/${j.label}`]);
    끈것.push(j.label);
  };
  await off(review);
  const 치움 = await retireLegacyMac();
  if (치움?.self) 자기.push(APP_ID);
  await off(serve);
  let msg = "자동 시작을 껐습니다.";
  if (치움) msg += `\n옛 판의 자동 시작 파일은 옆으로 치워 두었습니다: ${치움.moved}`;
  if (자기.length) msg += `\n지금 돌고 있는 이 앱을 띄운 작업(${자기.join(", ")})은 내리지 않았습니다 — 이 앱을 끝낸 뒤 다음 로그인부터 자동으로 켜지지 않습니다.`;
  if (남의것.length) msg += `\n같은 이름의 다른 프로그램 작업은 건드리지 않았습니다: ${남의것.join(", ")}`;
  return msg;
}

/* ── 윈도우: 시작 프로그램 .vbs + 작업 스케줄러 ──────────────────── */

/** 시작 프로그램 폴더. GARASADAE_HOME 이 있으면 APPDATA 를 보지 않는다 — 시험이 진짜 폴더를 건드리지 않게 */
function winStartupDir(): string {
  const roaming = !env("GARASADAE_HOME") && env("APPDATA") ? env("APPDATA") : join(homeDir(), "AppData", "Roaming");
  return join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
/** 옛 판과 같은 이름이다 — 같은 자리를 갱신하므로 두 개가 같이 뜨는 일이 없다 */
const winStartupFile = () => join(winStartupDir(), `${APP_NAME}.vbs`);
/** 작업 스케줄러가 부르는 숨김 실행기 (시작 프로그램 폴더에 두면 로그인 때도 한 번 더 돈다 — 데이터 폴더에 둔다) */
const winReviewVbs = () => dataPath("심사확인실행.vbs");

/** 윈도우가 알아보는 글자 형식(UTF-16, 앞에 표시 붙임)으로 바꾼다. */
function utf16le(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xFF;
  out[1] = 0xFE;                       // 이 표시가 있어야 윈도우가 UTF-16 인 줄 안다
  for (let i = 0, o = 2; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[o++] = c & 0xFF;
    out[o++] = c >> 8;
  }
  return out;
}
function decodeUtf16le(b: Uint8Array): string {
  const start = b[0] === 0xFF && b[1] === 0xFE ? 2 : 0;
  return new TextDecoder("utf-16le").decode(b.subarray(start));
}
async function readVbs(path: string): Promise<string | null> {
  try {
    const b = await Deno.readFile(path);
    // UTF-16 이면 BOM 이 있다. 아니면(손으로 고친 파일) 그냥 글로 읽는다.
    return b[0] === 0xFF && b[1] === 0xFE ? decodeUtf16le(b) : dec.decode(b);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}
async function writeVbs(path: string, text: string) {
  await Deno.mkdir(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))), { recursive: true });
  const tmp = `${path}.${Date.now().toString(36)}.tmp`;
  try {
    await Deno.writeFile(tmp, utf16le(text));
    await Deno.rename(tmp, path);
  } catch (e) {
    try { await Deno.remove(tmp); } catch { /* 없으면 그만이다 */ }
    throw e;
  }
}

/** 명령줄 한 줄 — 공백이 든 조각만 큰따옴표로 감싼다 */
const winCmd = (argv: string[]) => argv.map((a) => /\s/.test(a) ? `"${a}"` : a).join(" ");
/** VBScript 글자 안의 큰따옴표는 두 번 쓴다 */
const vbsStr = (s: string) => `"${s.replace(/"/g, '""')}"`;

function vbsServe(): string {
  return `' ${APP_NAME} 자동 시작 (${MARK})\r\nCreateObject("WScript.Shell").Run ${vbsStr(winCmd([...exeArgv(), "--background"]))}, 0, False\r\n`;
}
/** 끝날 때까지 기다린다(True) — 작업 스케줄러가 앞 판이 도는 중에 같은 것을 또 띄우지 않게 */
function vbsReview(): string {
  return `' ${APP_NAME} 심사확인 (${MARK}) — 작업 스케줄러가 ${TICK_MINUTES}분마다 부릅니다. 창이 뜨지 않게 이 파일을 거칩니다.\r\n` +
    `CreateObject("WScript.Shell").Run ${vbsStr(winCmd([...exeArgv(), "심사확인"]))}, 0, True\r\n`;
}
/** 옛 판(v1)이 만든 .vbs 인가 — 우리 표식은 없고, 옛 머리말 `' <이름> 자동 시작` 이 있다 */
const looksLegacyVbs = (t: string | null) => t !== null && !t.includes(MARK) && t.includes(`' ${APP_NAME} 자동 시작`) && t.includes("--background");

async function winTaskExists(): Promise<boolean> {
  return (await run("schtasks", ["/query", "/tn", REVIEW_LABEL])).code === 0;
}

async function winStatus(): Promise<AutoStartStatus> {
  const cur = await readVbs(winStartupFile());
  const legacy = looksLegacyVbs(cur);
  const foreign = cur !== null && !isOurs(cur) && !legacy;
  const serve = isOurs(cur) || legacy;
  const tick = await winTaskExists();
  const conflict = foreign ? [winStartupFile()] : [];
  let supported = true;
  let how = `윈도우 시작 프로그램(.vbs, 창이 뜨지 않게)과 작업 스케줄러(${TICK_MINUTES}분마다 심사확인: ${REVIEW_LABEL})`;
  if (!isCompiled()) { supported = false; how = "개발 실행(deno run) 중에는 자동 시작을 등록하지 않습니다"; }
  else if (foreign) { supported = false; how = `시작 프로그램에 같은 이름의 다른 파일이 있어 켤 수 없습니다 (${winStartupFile()})`; }
  return { on: serve || tick, serve, tick, supported, how, legacy, conflict };
}

async function enableWin(): Promise<string> {
  const f = winStartupFile();
  const cur = await readVbs(f);
  if (cur !== null && !isOurs(cur) && !looksLegacyVbs(cur)) {
    throw new AutoStartConflict(
      `자동 실행을 켜지 않았습니다 — 시작 프로그램에 같은 이름의 다른 파일이 이미 있습니다.\n· ${f}\n이 앱이 만든 파일이 아니라 덮어쓰지 않았습니다.`,
      [f],
    );
  }
  let 치움: string | null = null;
  // 옛 판 파일은 같은 자리를 갱신한다. 시작 프로그램 폴더에 낯선 확장자의 사본을 두면 로그인 때 「연결 프로그램」 창이 뜰 수 있어, 사본은 데이터 폴더에 둔다.
  if (looksLegacyVbs(cur)) {
    await Deno.mkdir(dataPath("자동시작_옛판"), { recursive: true });
    치움 = await moveAside(f, dataPath("자동시작_옛판"));
  }
  // 윈도우의 스크립트 실행기는 .vbs 를 UTF-8 로 읽지 않는다. UTF-8 로 쓰면 폴더 이름에 한글이 있을 때 경로가 깨져 조용히 실패한다. (2026-08-20 실제 사고)
  await writeVbs(f, vbsServe());
  await writeVbs(winReviewVbs(), vbsReview());
  const r = await run("schtasks", ["/create", "/tn", REVIEW_LABEL, "/tr", `wscript.exe //B //Nologo "${winReviewVbs()}"`,
    "/sc", "minute", "/mo", String(TICK_MINUTES), "/f"]);
  let msg = "윈도우 시작 시 자동 실행되도록 등록했습니다.";
  if (r.code === 0) msg += ` (${TICK_MINUTES}분마다 심사확인도 합니다)`;
  else {
    const why = cut((r.stderr || r.stdout).trim(), 120) || `코드 ${r.code}`;
    void log(`⚠️  작업 스케줄러 등록 실패 — ${why}`);
    msg += `\n⚠️ ${TICK_MINUTES}분마다 심사확인 작업은 등록하지 못했습니다: ${why}`;
  }
  if (치움) msg += `\n옛 판의 시작 파일은 지우지 않고 치워 두었습니다: ${치움}`;
  return msg;
}

async function disableWin(): Promise<string> {
  const f = winStartupFile();
  const cur = await readVbs(f);
  let 남의것 = false;
  if (cur !== null) {
    if (!isOurs(cur) && !looksLegacyVbs(cur)) 남의것 = true;
    else {
      // 지우지 못했는데 껐다고 답하면 안 된다 — 꺼지지 않았는데 껐다고 답하고 화면은 다시 켜짐으로 돌아간 일이 실제로 있었다. (2026-08-20)
      try { await Deno.remove(f); } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          const m = e instanceof Error ? e.message : String(e);
          await log(`⚠️  자동 시작을 끄지 못했습니다: ${f} — ${m}`);
          throw new Error(
            `자동 시작 파일을 지우지 못했습니다.\n${f}\n\n이유: ${m}\n\n` +
              `보안 프로그램이 시작 폴더를 지키고 있을 수 있습니다. 탐색기 주소창에 shell:startup 을 넣고 그 파일을 직접 지워 주세요.`,
          );
        }
      }
      if (await exists(f)) throw new Error(`자동 시작 파일이 아직 남아 있습니다.\n${f}\n직접 지워 주세요 (탐색기 주소창에 shell:startup).`);
    }
  }
  await run("schtasks", ["/delete", "/tn", REVIEW_LABEL, "/f"]);      // 없으면 실패하지만 그게 바라던 상태다
  try { await Deno.remove(winReviewVbs()); } catch { /* 없으면 그만이다 */ }
  return 남의것 ? `자동 시작을 껐습니다. (시작 프로그램의 같은 이름 파일은 이 앱이 만든 것이 아니라 건드리지 않았습니다)` : "자동 시작을 껐습니다.";
}

/* ── 리눅스: .desktop (로그인 때 서버) — 10분 작업은 cron 안내 ─────── */

/** ~/.config/autostart. 시험(GARASADAE_HOME)이면 XDG_CONFIG_HOME 을 보지 않는다 — 진짜 폴더를 건드리지 않게 */
function linuxDesktopDir(): string {
  const xdg = env("GARASADAE_HOME") ? "" : env("XDG_CONFIG_HOME");
  return join(xdg || join(homeDir(), ".config"), "autostart");
}
const linuxDesktopFile = () => join(linuxDesktopDir(), `${SERVE_LABEL}.desktop`);
/** 옛 판(v1)의 .desktop — 접미가 없다 */
const legacyLinuxDesktop = () => join(linuxDesktopDir(), `${APP_ID}.desktop`);

/** .desktop 의 Exec 인자 — 공백·특수문자가 든 조각은 큰따옴표로 감싸고 \ " ` $ 를 이스케이프하며 % 는 두 번 쓴다 */
function desktopArg(a: string): string {
  const t = a.replace(/%/g, "%%");
  return /[\s"'`$\\<>~|&;*?#()]/.test(t) ? `"${t.replace(/([\\"`$])/g, "\\$1")}"` : t;
}
function desktopText(): string {
  return `[Desktop Entry]\n# ${MARK}\nType=Application\nName=${APP_NAME}\nComment=${APP_NAME} 자동 시작\n` +
    `Exec=${[...exeArgv(), "--background"].map(desktopArg).join(" ")}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
}
const looksLegacyDesktop = (t: string | null) => t !== null && !t.includes(MARK) && t.includes("--background") && t.includes(`Name=${APP_NAME}`);
const cronLine = () => `*/${TICK_MINUTES} * * * * ${[...exeArgv(), "심사확인"].map(desktopArg).join(" ")}`;

async function linuxStatus(): Promise<AutoStartStatus> {
  const cur = await readText(linuxDesktopFile());
  const legacy = looksLegacyDesktop(await readText(legacyLinuxDesktop()));
  const foreign = cur !== null && !isOurs(cur);
  const serve = isOurs(cur) || legacy;
  const cron = await run("crontab", ["-l"]);
  const tick = cron.code === 0 && cron.stdout.split("\n").some((l) => !l.trim().startsWith("#") && l.includes("심사확인"));
  return {
    on: serve || tick, serve, tick, supported: false, legacy, conflict: foreign ? [linuxDesktopFile()] : [],
    how: `리눅스: 로그인 때 실행(.desktop)만 이 앱이 등록합니다. ${TICK_MINUTES}분마다 심사확인은 cron 에 직접 넣어 주세요 — ${cronLine()}`,
  };
}

async function enableLinux(): Promise<string> {
  const f = linuxDesktopFile();
  const cur = await readText(f);
  if (cur !== null && !isOurs(cur)) {
    throw new AutoStartConflict(`자동 실행을 켜지 않았습니다 — 같은 이름의 다른 파일이 이미 있습니다.\n· ${f}\n이 앱이 만든 파일이 아니라 덮어쓰지 않았습니다.`, [f]);
  }
  let 치움: string | null = null;
  if (looksLegacyDesktop(await readText(legacyLinuxDesktop()))) 치움 = await moveAside(legacyLinuxDesktop());
  await Deno.mkdir(linuxDesktopDir(), { recursive: true });
  await writeTextAtomic(f, desktopText());
  let msg = `로그인 시 자동 실행되도록 등록했습니다.\n${TICK_MINUTES}분마다 심사확인은 cron 에 직접 넣어 주세요 (crontab -e):\n${cronLine()}`;
  if (치움) msg += `\n옛 판의 자동 시작 파일은 지우지 않고 옆으로 치워 두었습니다: ${치움}`;
  return msg;
}

async function disableLinux(): Promise<string> {
  const f = linuxDesktopFile();
  const cur = await readText(f);
  let msg = "자동 시작을 껐습니다.";
  if (cur !== null) {
    if (isOurs(cur)) await Deno.remove(f);
    else msg += `\n같은 이름의 다른 파일은 이 앱이 만든 것이 아니라 건드리지 않았습니다: ${f}`;
  }
  if (looksLegacyDesktop(await readText(legacyLinuxDesktop()))) msg += `\n옛 판의 자동 시작 파일은 옆으로 치워 두었습니다: ${await moveAside(legacyLinuxDesktop())}`;
  return msg;
}

/* ── 공개 입구 ───────────────────────────────────────────────── */

/** 자동 실행이 지금 어떻게 되어 있나. 화면이 열릴 때 부른다(명령을 몇 번 부를 수 있다). */
export async function autoStartStatus(): Promise<AutoStartStatus> {
  const os = currentOs();
  return os === "mac" ? await macStatus() : os === "win" ? await winStatus() : await linuxStatus();
}

/** 옛 이름 호환 — 「켜져 있나」만 */
export async function autoStartEnabled(): Promise<boolean> {
  return (await autoStartStatus()).on;
}

/**
 * 자동 실행 두 작업을 켜거나 끈다. 사람이 읽는 결과 글을 돌려준다.
 *  · 켜기: 개발 실행(deno run)이면 등록하지 않고 안내만. 남의 작업이 같은 이름으로 있으면 AutoStartConflict 로 멈춘다(아무것도 안 씀).
 *  · 끄기: 이 앱이 만든 것만 끈다. 개발 실행이어도 이미 있는 등록은 치운다.
 *  · 같은 내용이면 건드리지 않는다 — 돌고 있는 서버가 스스로를 내리는 일이 없게.
 * ★맥에서 launchd 가 띄운 서버가 「끄기」를 처리하면 bootout 이 그 서버를 끝낸다. 부르는 쪽은 응답을 먼저 보낸 뒤 부르는 것이 좋다.
 */
export function setAutoStart(on: boolean): Promise<string> {
  return 줄서서("autostart", async () => {
    const os = currentOs();
    if (on) {
      if (!isCompiled()) return "개발 모드에서는 자동 시작을 등록하지 않습니다.";
      return os === "mac" ? await enableMac() : os === "win" ? await enableWin() : await enableLinux();
    }
    return os === "mac" ? await disableMac() : os === "win" ? await disableWin() : await disableLinux();
  });
}

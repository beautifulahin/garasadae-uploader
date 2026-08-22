// OS 별 동작: 알림 · 폴더/브라우저 열기 · 자동 시작 등록
import { APP_ID, APP_NAME, IS_MAC, IS_WIN, dataDir, exists, fromBase64, homeDir, join, log } from "./paths.ts";
import { 텔레그램 } from "./telegram.ts";

function env(k: string) { try { return Deno.env.get(k) ?? ""; } catch { return ""; } }

async function spawn(cmd: string[], detach = true) {
  try {
    const c = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "null", stderr: "null", stdin: "null",
    });
    const child = c.spawn();
    if (detach) child.unref?.();
    else await child.status;
  } catch (e) {
    await log(`(명령 실행 실패: ${cmd[0]} — ${e instanceof Error ? e.message : e})`);
  }
}

/* ── 올리는 동안 잠들지 않게 붙든다 ────────────────────────────
   맥이 잠들면 업로드가 멈춘다. 큰 편을 걸어 두고 자리를 뜨면 아침에 와서야
   "왜 안 올라갔지?" 를 알게 된다.

   ★`caffeinate -i` 는 **화면만 꺼지고 시스템은 안 자게** 한다. 뚜껑을 닫으면
     그래도 잔다 — 그건 맥이 양보하지 않는 자리다.
   ★올리는 **동안만** 붙든다. 늘 붙들면 안 쓸 때도 컴퓨터가 안 잔다.
   ★윈도우·리눅스에서는 아무것도 안 한다(맥만 있는 명령이다). */
let 붙든이: Deno.ChildProcess | null = null;

export function 잠깨워두기(): void {
  if (!IS_MAC || 붙든이) return;
  try {
    붙든이 = new Deno.Command("caffeinate", {
      args: ["-i", "-w", String(Deno.pid)],   // 이 프로그램이 죽으면 저도 따라 죽는다
      stdout: "null", stderr: "null", stdin: "null",
    }).spawn();
  } catch { 붙든이 = null; }                   // 없는 명령이면 그냥 넘어간다
}

export function 잠깨우기끝(): void {
  if (!붙든이) return;
  try { 붙든이.kill(); } catch { /* 이미 죽었다 */ }
  try { 붙든이.unref?.(); } catch { /* 무시 */ }
  붙든이 = null;
}

/** 텔레그램으로도 보낼까 — 화면(설정)에서 끌 수 있다. 기본은 켬. */
let 텔레그램켬 = true;
export function 텔레그램설정(on: boolean) { 텔레그램켬 = on; }

export async function notify(title: string, text: string) {
  const t = text.replace(/["'`]/g, "").slice(0, 180);
  const h = title.replace(/["'`]/g, "");
  /* ★막힌 소식은 텔레그램으로도 보낸다 (개인판, 사용자 지시 2026-08-22).
     맥 앞에 없으면 알림을 못 보기 때문이다. **잘 된 일(✅)은 뺀다** — 하루 몇 편씩
     올라가는데 그때마다 울리면 정작 급한 것이 묻힌다.
     열쇠가 없으면 telegram.ts 가 조용히 아무 일도 안 한다(공개판). */
  if (텔레그램켬 && !h.includes("✅")) {
    텔레그램(`${h}\n${t}`).catch(() => {});
  }
  if (IS_MAC) {
    await spawn(["osascript", "-e", `display notification "${t}" with title "${h}"`]);
  } else if (IS_WIN) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = '${h}'
$n.BalloonTipText  = '${t}'
$n.Visible = $true
$n.ShowBalloonTip(6000)
Start-Sleep -Seconds 7
$n.Dispose()`.trim();
    await spawn(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps]);
  } else {
    await spawn(["notify-send", h, t]);
  }
}

export async function openPath(p: string) {
  if (IS_MAC) await spawn(["open", p]);
  else if (IS_WIN) await spawn(["explorer", p.replace(/\//g, "\\")]);
  else await spawn(["xdg-open", p]);
}

/** 이 컴퓨터에서 쓸 수 있는 브라우저 목록 */
export async function listBrowsers(): Promise<{ id: string; name: string }[]> {
  const found: { id: string; name: string }[] = [];
  if (IS_MAC) {
    const macApps = [
      ["Google Chrome", "크롬"], ["Safari", "사파리"], ["Microsoft Edge", "엣지"],
      ["Firefox", "파이어폭스"], ["Whale", "웨일"], ["Arc", "Arc"], ["Brave Browser", "브레이브"],
    ];
    for (const [app, label] of macApps) {
      if (await exists(`/Applications/${app}.app`)) found.push({ id: app, name: label });
    }
  } else if (IS_WIN) {
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
  }
  return found;
}

/* ── 이미 열려 있는 우리 탭을 다시 쓴다 ──────────────────────────────
   사용자 지시(2026-08-21): "새 창을 기존 창과 중복으로 띄우되 리프레쉬로 대체를
   하든지, 새 창을 안 띄우고 기존 창을 이용하든지."

   ★왜 화면 쪽(ui.html)만으로는 안 되나 — 브라우저는 **스크립트가 열지 않은 탭의
     window.close() 를 막는다.** 그래서 옛 창은 덮개만 씌운 채 그대로 남았다.
     닫지 못한다면 **애초에 새 탭을 안 만들면 된다.** 여기서는 브라우저에게
     "그 주소를 이미 띄운 탭을 찾아, 그 자리에서 다시 불러라" 고 시킨다.

   되면 true. 자동화 권한이 없거나 그런 탭이 없으면 false → 부르는 쪽이 새로 연다. */
const 크롬계열 = ["Google Chrome", "Brave Browser", "Microsoft Edge", "Whale",
                "Vivaldi", "Chromium", "Opera"];

function esc(s: string) { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

async function 도는브라우저(): Promise<string[]> {
  const out = await capture(["/bin/ps", "-Ao", "comm="]);
  const 것 = new Set<string>();
  for (const 앱 of [...크롬계열, "Safari"]) {
    if (out.includes(`/${앱}.app/Contents/MacOS/`)) 것.add(앱);
  }
  return [...것];
}

export async function 쓰던탭에다시(base: string, url: string, browser = ""): Promise<boolean> {
  if (!IS_MAC) return false;
  const 볼것 = [...new Set([browser, ...(await 도는브라우저())].filter(Boolean))];
  for (const 앱 of 볼것) {
    const 사파리 = 앱 === "Safari";
    if (!사파리 && !크롬계열.includes(앱)) continue;      // 파이어폭스·Arc 는 못 시킨다
    const 고르기 = 사파리
      ? `set current tab of w to tab ti of w`
      : `set active tab index of w to ti`;
    const script = `
tell application "${esc(앱)}"
  if it is not running then return "0"
  repeat with wi from 1 to (count windows)
    set w to window wi
    repeat with ti from 1 to (count tabs of w)
      if (URL of tab ti of w) starts with "${esc(base)}" then
        set URL of tab ti of w to "${esc(url)}"
        ${고르기}
        set index of w to 1
        activate
        return "1"
      end if
    end repeat
  end repeat
end tell
return "0"`;
    const r = (await capture(["osascript", "-e", script])).trim();
    if (r === "1") {
      await log(`· 이미 열려 있던 ${앱} 탭을 다시 썼다 — 새 창을 안 띄운다`);
      return true;
    }
  }
  return false;
}

export async function openUrl(u: string, browser = "") {
  if (browser) {
    if (IS_MAC) { await spawn(["open", "-a", browser, u]); return; }
    if (IS_WIN) { await spawn(["cmd", "/c", "start", "", browser, u]); return; }
  }
  if (IS_MAC) await spawn(["open", u]);
  else if (IS_WIN) await spawn(["cmd", "/c", "start", "", u]);
  else await spawn(["xdg-open", u]);
}

/** OS 기본 폴더 선택창을 띄운다. 취소하면 null. */
export async function pickFolder(start: string): Promise<string | null> {
  try {
    if (IS_MAC) {
      const script = `tell application "System Events" to activate
set f to choose folder with prompt "영상을 저장할 폴더를 선택하세요"
return POSIX path of f`;
      const out = await capture(["osascript", "-e", script]);
      return out.trim() ? out.trim().replace(/\/$/, "") : null;
    }
    if (IS_WIN) {
      // 한글 윈도우의 콘솔은 한글을 UTF-8 로 내보내지 않는다.
      // 그래서 경로를 Base64(영문·숫자뿐)로 받아 이쪽에서 되돌린다.
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = "영상을 저장할 폴더를 선택하세요"
$d.ShowNewFolderButton = $true
$d.SelectedPath = "${start.replace(/\\/g, "\\\\")}"
$t = New-Object System.Windows.Forms.Form
$t.TopMost = $true
if ($d.ShowDialog($t) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($d.SelectedPath)))
}
$t.Dispose()`.trim();
      const out = await capture(["powershell", "-STA", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps]);
      return fromBase64(out.trim()) || null;
    }
    const out = await capture(["zenity", "--file-selection", "--directory"]);
    return out.trim() || null;
  } catch {
    return null;      // 취소했거나 선택창을 띄울 수 없는 환경
  }
}

/** 자동 시작 등록 파일을 지운다. 실패하면 왜 안 됐는지 그대로 알려 준다.
 *  전에는 오류를 삼키고 "껐습니다" 라고만 해서, 꺼지지 않았는데 껐다고
 *  답하고 화면은 다시 켜짐으로 돌아갔다. (2026-08-20 실제 사고) */
async function turnOff(f: string): Promise<string> {
  try {
    await Deno.remove(f);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      const m = e instanceof Error ? e.message : String(e);
      await log(`⚠️  자동 시작을 끄지 못했습니다: ${f} — ${m}`);
      throw new Error(
        `자동 시작 파일을 지우지 못했습니다.\n${f}\n\n` +
          `이유: ${m}\n\n` +
          `보안 프로그램이 시작 폴더를 지키고 있을 수 있습니다. ` +
          `탐색기 주소창에 shell:startup 을 넣고 그 파일을 직접 지워 주세요.`,
      );
    }
  }
  // 정말 사라졌는지 확인하고 답한다
  if (await exists(f)) {
    throw new Error(`자동 시작 파일이 아직 남아 있습니다.\n${f}\n직접 지워 주세요 (탐색기 주소창에 shell:startup).`);
  }
  return "자동 시작을 껐습니다.";
}

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

async function capture(cmd: string[]): Promise<string> {
  const c = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" });
  const { stdout, code } = await c.output();
  if (code !== 0) return "";
  return new TextDecoder().decode(stdout);
}

/** 파일을 휴지통으로 보낸다. 실패하면 false. */
export async function moveToTrash(path: string): Promise<boolean> {
  try {
    if (IS_WIN) {
      const esc = path.replace(/'/g, "''");
      const ps = `Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${esc}','OnlyErrorDialogs','SendToRecycleBin')`;
      const c = new Deno.Command("powershell", {
        args: ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps],
        stdout: "null", stderr: "null",
      });
      return (await c.output()).code === 0;
    }
    // 맥·리눅스는 휴지통 폴더로 옮기는 편이 권한 문제가 없다
    const trash = IS_MAC
      ? join(homeDir(), ".Trash")
      : join(homeDir(), ".local", "share", "Trash", "files");
    await Deno.mkdir(trash, { recursive: true });
    const name = path.split("/").pop() ?? "file";
    const dot = name.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let dest = join(trash, name);
    let i = 1;
    while (await exists(dest)) dest = join(trash, `${base} ${i++}${ext}`);
    await Deno.rename(path, dest);
    return true;
  } catch (e) {
    await log(`   ⚠️  휴지통으로 보내지 못했습니다: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/* ------------------------------------------------- 자동 시작 */
const winStartupFile = () =>
  join(homeDir(), "AppData", "Roaming", "Microsoft", "Windows",
       "Start Menu", "Programs", "Startup", `${APP_NAME}.vbs`);
const macPlistFile = () => join(homeDir(), "Library", "LaunchAgents", `${APP_ID}.plist`);
const linuxDesktopFile = () => join(homeDir(), ".config", "autostart", `${APP_ID}.desktop`);

/** 개발 중(deno run)에는 자동 시작을 등록하지 않는다. */
export function isCompiled(): boolean {
  const p = Deno.execPath().toLowerCase();
  return !(p.endsWith("/deno") || p.endsWith("deno.exe"));
}

export async function autoStartEnabled(): Promise<boolean> {
  return await exists(IS_WIN ? winStartupFile() : IS_MAC ? macPlistFile() : linuxDesktopFile());
}

export async function setAutoStart(on: boolean): Promise<string> {
  if (!isCompiled()) return "개발 모드에서는 자동 시작을 등록하지 않습니다.";
  const exe = Deno.execPath();

  if (IS_WIN) {
    const f = winStartupFile();
    if (!on) return await turnOff(f);
    await Deno.mkdir(f.slice(0, f.lastIndexOf("\\")), { recursive: true });
    // 윈도우의 스크립트 실행기는 .vbs 를 UTF-8 로 읽지 않는다.
    // UTF-8 로 쓰면 폴더 이름에 한글이 있을 때 경로가 깨져 조용히 실패한다.
    // 그래서 윈도우가 알아보는 UTF-16 으로 쓴다. (2026-08-20 실제 사고)
    await Deno.writeFile(
      f,
      utf16le(`' ${APP_NAME} 자동 시작\r\nCreateObject("WScript.Shell").Run """${exe}"" --background", 0, False\r\n`),
    );
    return "윈도우 시작 시 자동 실행되도록 등록했습니다.";
  }

  if (IS_MAC) {
    const f = macPlistFile();
    if (!on) {
      try { await new Deno.Command("launchctl", { args: ["bootout", `gui/${Deno.uid()}/${APP_ID}`] }).output(); } catch { /* 무시 */ }
      try { await Deno.remove(f); } catch { /* 무시 */ }
      return "자동 시작을 껐습니다.";
    }
    await Deno.mkdir(join(homeDir(), "Library", "LaunchAgents"), { recursive: true });
    await Deno.writeTextFile(f, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array><string>${exe}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>${join(dataDir(), "daemon.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(dataDir(), "daemon.err.log")}</string>
</dict></plist>
`);
    try {
      await new Deno.Command("launchctl", { args: ["bootout", `gui/${Deno.uid()}/${APP_ID}`], stderr: "null" }).output();
      await new Deno.Command("launchctl", { args: ["bootstrap", `gui/${Deno.uid()}`, f], stderr: "null" }).output();
    } catch { /* 무시 */ }
    return "맥 로그인 시 자동 실행되도록 등록했습니다.";
  }

  const f = linuxDesktopFile();
  if (!on) { try { await Deno.remove(f); } catch { /* 무시 */ } return "자동 시작을 껐습니다."; }
  await Deno.mkdir(join(homeDir(), ".config", "autostart"), { recursive: true });
  await Deno.writeTextFile(f,
    `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec="${exe}" --background\nX-GNOME-Autostart-enabled=true\n`);
  return "로그인 시 자동 실행되도록 등록했습니다.";
}

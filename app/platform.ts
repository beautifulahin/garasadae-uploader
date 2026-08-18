// OS 별 동작: 알림 · 폴더/브라우저 열기 · 자동 시작 등록
import { APP_ID, APP_NAME, IS_MAC, IS_WIN, dataDir, exists, homeDir, join, log } from "./paths.ts";

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

export async function notify(title: string, text: string) {
  const t = text.replace(/["'`]/g, "").slice(0, 180);
  const h = title.replace(/["'`]/g, "");
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
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = "영상을 저장할 폴더를 선택하세요"
$d.ShowNewFolderButton = $true
$d.SelectedPath = "${start.replace(/\\/g, "\\\\")}"
$t = New-Object System.Windows.Forms.Form
$t.TopMost = $true
if ($d.ShowDialog($t) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
$t.Dispose()`.trim();
      const out = await capture(["powershell", "-STA", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps]);
      return out.trim() || null;
    }
    const out = await capture(["zenity", "--file-selection", "--directory"]);
    return out.trim() || null;
  } catch {
    return null;      // 취소했거나 선택창을 띄울 수 없는 환경
  }
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
    if (!on) { try { await Deno.remove(f); } catch { /* 무시 */ } return "자동 시작을 껐습니다."; }
    await Deno.mkdir(f.slice(0, f.lastIndexOf("\\")), { recursive: true });
    await Deno.writeTextFile(
      f,
      `' ${APP_NAME} 자동 시작\r\nCreateObject("WScript.Shell").Run """${exe}"" --background", 0, False\r\n`,
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

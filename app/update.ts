// 새 버전 확인 및 설치
import { APP_NAME, APP_VERSION, buildLabel, IS_MAC, IS_WIN, REPO, join, log } from "./paths.ts";

export interface UpdateInfo {
  available: boolean;
  version: string;
  current: string;
  url: string;          // 내려받을 파일 주소
  page: string;         // 사람이 보는 릴리스 페이지
  canInstall: boolean;  // 앱이 스스로 교체할 수 있는 상태인지
  reason: string;       // 스스로 못 할 때의 이유
  notes: string;        // 이번 판에서 무엇이 달라졌는지 (몇 줄)
}

/** 이번 판의 패치 내용. 릴리스에 함께 올린 `notes.md` 를 읽는다.
 *
 * ★깃허브 API 를 쓰지 않는다 — IP 당 시간 60회 제한에 걸린다. 릴리스에 붙인 파일은
 *   `releases/latest/download/<이름>` 으로 제한 없이 받을 수 있다.
 * ★못 받아도 그만이다. 업데이트 자체는 패치 내용과 상관없이 된다.
 */
async function 패치내용(): Promise<string> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch(`https://github.com/${REPO}/releases/latest/download/notes.md`,
                          { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) {
      await r.body?.cancel();
      return "";
    }
    const 글 = (await r.text()).trim();
    // 제목 줄(#)과 빈 줄을 걷어 내고 앞의 몇 줄만 보여 준다
    const 줄 = 글.split("\n")
      .map((x) => x.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "· ").trim())
      .filter((x) => x.length > 0);
    return 줄.slice(0, 6).join("\n").slice(0, 600);
  } catch {
    return "";
  }
}

let cached: UpdateInfo | null = null;
let checkedAt = 0;

/** 이 컴퓨터에 맞는 배포 파일 이름 */
function assetName(): string {
  if (IS_WIN) return "garasadae-uploader-windows.zip";
  if (IS_MAC) {
    return Deno.build.arch === "aarch64"
      ? "garasadae-uploader-mac-apple-silicon.zip"
      : "garasadae-uploader-mac-intel.zip";
  }
  return "";
}

function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 실행 중인 프로그램을 스스로 교체할 수 있는 상태인지 */
function installable(): { ok: boolean; reason: string } {
  const exe = Deno.execPath();
  if (exe.toLowerCase().endsWith("/deno") || exe.toLowerCase().endsWith("deno.exe")) {
    return { ok: false, reason: "개발 모드에서는 업데이트하지 않습니다." };
  }
  if (exe.includes("/AppTranslocation/")) {
    return {
      ok: false,
      reason: "프로그램이 임시 위치에서 실행 중이라 교체할 수 없습니다. " +
        "가라사대 업로더를 응용 프로그램 폴더로 옮긴 뒤 다시 실행해 주세요.",
    };
  }
  return { ok: true, reason: "" };
}

export async function checkUpdate(force = false): Promise<UpdateInfo> {
  const page = `https://github.com/${REPO}/releases/latest`;

  // 시험용 — 실제 배포 없이 팝업 동작을 확인할 때만 쓴다
  const fake = (() => { try { return Deno.env.get("GARASADAE_FAKE_UPDATE") ?? ""; } catch { return ""; } })();
  if (fake) {
    return {
      available: true, version: fake, current: APP_VERSION, notes: "",
      url: "", page, canInstall: false, reason: "시험 모드입니다.",
    };
  }

  const none: UpdateInfo = {
    available: false, version: APP_VERSION, current: APP_VERSION, notes: "",
    url: "", page, canInstall: false, reason: "",
  };
  // 5분마다 확인한다. 새 버전을 올리면 실행 중인 프로그램이 곧바로 알아챈다.
  if (!force && cached && Date.now() - checkedAt < 5 * 60_000) return cached;

  try {
    // 깃허브 API 는 IP 당 시간 60회 제한이 있어 쓰지 않는다.
    // 최신 릴리스 주소가 태그 주소로 넘겨주는 것을 이용해 버전을 알아낸다.
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(`https://github.com/${REPO}/releases/latest`, {
      redirect: "manual",
      signal: c.signal,
    });
    const loc = r.headers.get("location") ?? "";
    await r.body?.cancel();
    clearTimeout(t);
    const latest = (loc.match(/\/releases\/tag\/v?([0-9]+\.[0-9]+\.[0-9]+)/) ?? [])[1] ?? "";
    if (!latest) return none;

    const want = assetName();
    const inst = installable();
    const 새것 = cmpVersion(latest, APP_VERSION) > 0;
    // ★**이름표가 달린 판은 스스로 갈아끼우지 않는다.** 공개판을 바탕으로 자기 것을
    //   얹어 쓰는 판(이름표가 그 표시다)을 공개판으로 덮으면 얹은 것이 조용히
    //   사라진다. 새 판이 나왔다고 알리기만 하고, 갈아끼우기는 그 판을 지은 사람이 한다.
    const 나만의판 = !!buildLabel();
    const info: UpdateInfo = {
      // 패치 내용은 **새 판이 있을 때만** 받아 온다 — 5분마다 헛되이 두드릴 일이 없다
      notes: 새것 ? await 패치내용() : "",
      available: 새것 && !나만의판,
      version: latest,
      current: APP_VERSION,
      // 최신 파일 주소는 항상 이 형태다
      url: want ? `https://github.com/${REPO}/releases/latest/download/${want}` : "",
      page,
      canInstall: inst.ok && !!want,
      reason: inst.ok ? (want ? "" : "이 컴퓨터에 맞는 파일을 찾지 못했습니다.") : inst.reason,
    };
    cached = info;
    checkedAt = Date.now();
    if (info.available) await log(`🆕 새 버전이 있습니다: ${APP_VERSION} → ${latest}`);
    else if (새것 && 나만의판) {
      await log(`🆕 새 공개판 ${latest} 이 나왔습니다 — 「${buildLabel()}」 은 스스로 갈지 `
        + `않습니다. 이 판을 지은 방법으로 다시 지어야 얹은 것을 잃지 않습니다.`);
    }
    return info;
  } catch {
    cached = none;
    checkedAt = Date.now() - 4 * 60_000;   // 1분 뒤 다시 시도
    return none;
  }
}

/* ------------------------------------------------- 설치 */
export type Progress = (pct: number, text: string) => void;

export async function installUpdate(info: UpdateInfo, onProgress: Progress): Promise<void> {
  if (!info.url) throw new Error("내려받을 파일 주소가 없습니다.");
  const inst = installable();
  if (!inst.ok) throw new Error(inst.reason);

  const tmp = await Deno.makeTempDir({ prefix: "garasadae_up_" });
  const zip = join(tmp, "new.zip");

  // 1) 내려받기
  onProgress(0, "새 버전을 내려받는 중…");
  const r = await fetch(info.url);
  if (!r.ok) throw new Error(`내려받기 실패 (${r.status})`);
  const total = Number(r.headers.get("content-length") ?? 0);
  const f = await Deno.open(zip, { write: true, create: true, truncate: true });
  let got = 0;
  const reader = r.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await f.write(value);
    got += value.length;
    if (total) onProgress(Math.round((got / total) * 80), `내려받는 중… ${(got / 1048576).toFixed(0)}MB`);
  }
  f.close();

  // 2) 압축 풀기
  onProgress(85, "압축을 푸는 중…");
  const out = join(tmp, "out");
  await Deno.mkdir(out, { recursive: true });
  await extract(zip, out);

  // 3) 교체
  onProgress(92, "프로그램을 교체하는 중…");
  if (IS_MAC) await swapMac(out);
  else if (IS_WIN) await swapWin(out);
  else throw new Error("이 운영체제는 자동 설치를 지원하지 않습니다.");

  onProgress(100, "완료 — 다시 시작합니다");
}

async function extract(zip: string, dest: string) {
  const cmd = IS_WIN
    ? ["powershell", "-NoProfile", "-Command",
       `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]
    : ["ditto", "-x", "-k", zip, dest];
  const { code, stderr } = await new Deno.Command(cmd[0], {
    args: cmd.slice(1), stdout: "null", stderr: "piped",
  }).output();
  if (code !== 0) throw new Error("압축을 풀지 못했습니다: " + new TextDecoder().decode(stderr).slice(0, 200));
}

async function findFile(root: string, name: string): Promise<string | null> {
  for await (const e of Deno.readDir(root)) {
    const p = join(root, e.name);
    if (e.name === name) return p;
    if (e.isDirectory && !e.name.endsWith(".app")) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    }
    if (e.isDirectory && e.name.endsWith(".app") && name.endsWith(".app")) {
      if (e.name === name) return p;
    }
  }
  return null;
}

async function findApp(root: string): Promise<string | null> {
  for await (const e of Deno.readDir(root)) {
    const p = join(root, e.name);
    if (e.isDirectory && e.name.endsWith(".app")) return p;
    if (e.isDirectory) {
      const hit = await findApp(p);
      if (hit) return hit;
    }
  }
  return null;
}

/** 맥: 실행 중인 .app 번들을 통째로 바꾸고 다시 실행한다. */
async function swapMac(extracted: string) {
  const exe = Deno.execPath();                       // .../X.app/Contents/MacOS/GarasadaeUploader
  const parts = exe.split("/");
  const idx = parts.findIndex((p) => p.endsWith(".app"));
  if (idx < 0) throw new Error("설치 위치를 찾지 못했습니다.");
  const current = parts.slice(0, idx + 1).join("/");

  const fresh = await findApp(extracted);
  if (!fresh) throw new Error("새 버전에서 프로그램을 찾지 못했습니다.");

  // 서명이 온전한지 확인한 뒤에만 바꾼다
  const v = await new Deno.Command("codesign", { args: ["--verify", "--strict", fresh], stderr: "null" }).output();
  if (v.code !== 0) throw new Error("새 파일의 서명 확인에 실패해 설치를 중단했습니다.");

  const backup = current + ".old";
  try { await Deno.remove(backup, { recursive: true }); } catch { /* 없으면 무시 */ }
  await Deno.rename(current, backup);
  try {
    await Deno.rename(fresh, current);
  } catch (e) {
    await Deno.rename(backup, current);               // 실패하면 되돌린다
    throw new Error(`교체하지 못했습니다: ${e instanceof Error ? e.message : e}`);
  }
  try { await Deno.remove(backup, { recursive: true }); } catch { /* 무시 */ }

  await log("⬆️  새 버전으로 교체 완료 — 다시 시작합니다");
  // 지금 프로그램이 완전히 꺼진 뒤에 켜야 한다.
  // 겹쳐서 켜면 새 프로그램이 "이미 실행 중"으로 보고 스스로 종료해 버린다.
  const esc = current.replace(/(["\\$`])/g, "\\$1");
  new Deno.Command("/bin/sh", {
    // --background 로 켜서 새 탭이 또 열리지 않게 한다.
    // 이미 열려 있는 화면이 스스로 새로고침되어 새 버전을 보여준다.
    args: ["-c", `sleep 4; open -n "${esc}" --args --background`],
    stdout: "null", stderr: "null", stdin: "null",
  }).spawn().unref?.();
  setTimeout(() => Deno.exit(0), 300);
}

/** 윈도우: 실행 중인 exe 는 못 바꾸므로 도우미 스크립트에 맡긴다. */
async function swapWin(extracted: string) {
  const exe = Deno.execPath();
  const name = exe.split(/[\\/]/).pop()!;
  const fresh = await findFile(extracted, name) ?? await findFile(extracted, "가라사대업로더.exe");
  if (!fresh) throw new Error("새 버전에서 프로그램을 찾지 못했습니다.");

  const bat = join(Deno.env.get("TEMP") ?? ".", "가라사대_업데이트.bat");
  const script = `@echo off\r
chcp 65001 >nul\r
echo ${APP_NAME} 를 업데이트하는 중입니다. 이 창은 저절로 닫힙니다.\r
timeout /t 2 /nobreak >nul\r
:wait\r
tasklist /FI "IMAGENAME eq ${name}" 2>nul | find /I "${name}" >nul\r
if not errorlevel 1 (\r
  timeout /t 1 /nobreak >nul\r
  goto wait\r
)\r
move /Y "${fresh}" "${exe}" >nul\r
start "" "${exe}" --background\r
del "%~f0"\r
`;
  await Deno.writeTextFile(bat, script);
  await log("⬆️  새 버전 교체를 도우미에 맡기고 종료합니다");
  new Deno.Command("cmd", { args: ["/c", "start", "", bat], stdout: "null", stderr: "null" }).spawn().unref?.();
  setTimeout(() => Deno.exit(0), 1200);
}

// 영상을 휴지통으로 보낸다 — 지우되 되살릴 수 있게.  (파이썬: trash.py · folders.mark_done 의 ~/.Trash 이동)
//
// 왜 지우기가 아니라 휴지통인가
//   화면에서 누르는 「삭제」는 손이 미끄러지기 쉽다. 진짜로 지워 버리면 고객이 만들어 준 영상이 그대로
//   사라지고 되돌릴 방법이 없다. 휴지통으로 보내면 파인더에서 「제자리에 다시 넣기」로 원래 폴더에
//   그대로 돌아온다. 사용자가 휴지통을 비우기 전까지는 언제든 되살릴 수 있다.
//
// 어떻게 보내나
//   맥은 파인더에게 시킨다(`osascript`). 파인더가 옮겨야 「되돌리기」 정보가 함께 적혀서 제자리로 돌아올 수
//   있다. 파일을 직접 `~/.Trash` 로 옮기면 휴지통에 들어가긴 해도 **어디서 왔는지가 없어 제자리 복원이 안 된다.**
//   윈도우는 PowerShell 의 Recycle Bin, 리눅스는 XDG 휴지통 규칙(files/ + info/*.trashinfo)을 쓴다.
//
// 같이 딸린 것도 함께
//   영상만 보내고 문안(.txt)·표지(.jpg)를 남기면 폴더에 짝 잃은 파일이 쌓인다. 같은 이름의 곁 파일을 함께 보낸다.
import { IS_MAC, IS_WIN, baseName, dirName, env, exists, homeDir, join, log, withSuffix } from "./paths.ts";
import { isoWall, wallNow } from "./clock.ts";

/** 영상과 함께 가는 곁 파일의 확장자 (파이썬 SIDE) */
export const TRASH_SIDE_EXT = [".txt", ".json", ".jpg", ".jpeg", ".png", ".webp", ".srt", ".vtt"] as const;

/** 휴지통으로 못 보냈다 — 까닭을 사람 말로 담는다. (파이썬 못보냄) */
export class TrashError extends Error {
  constructor(m: string) { super(m); this.name = "TrashError"; }
}

export type TrashOS = "mac" | "win" | "linux";
export type Runner = (cmd: string, args: string[], env?: Record<string, string>) => Promise<{ code: number; stderr: string }>;

export interface TrashOpts {
  /** 시험용: 다른 운영체제 길로 보낸다 (기본은 지금 컴퓨터) */
  os?: TrashOS;
  /** 시험용: 파인더·PowerShell 을 진짜로 부르지 않고 가짜 실행기를 끼운다 */
  run?: Runner;
}

export interface TrashResult {
  영상: string;
  함께: string[];
  개수: number;
}

const currentOs = (): TrashOS => (IS_MAC ? "mac" : IS_WIN ? "win" : "linux");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dec = new TextDecoder();

/* ============================================================ 경로 다루기 */

/** 파일이 없어도 쓸 수 있는 절대 경로 — `.` `..` 만 걷어 낸다 */
function lexicalResolve(p: string): string {
  const sep = IS_WIN ? "\\" : "/";
  const abs = IS_WIN ? /^([A-Za-z]:)?[\\/]/.test(p) : p.startsWith("/");
  const full = abs ? p : join(Deno.cwd(), p);
  const drive = IS_WIN ? (/^[A-Za-z]:/.exec(full)?.[0] ?? "") : "";
  const out: string[] = [];
  for (const part of full.slice(drive.length).split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return drive + sep + out.join(sep);
}

/**
 * 심볼릭 링크까지 풀어 진짜 자리를 구한다. (파이썬 Path.resolve)
 * 파일이 없어도 **있는 가장 긴 위쪽 폴더까지는** 실제 경로로 풀고 나머지는 글자 그대로 붙인다 —
 * 안 그러면 없는 파일은 링크가 풀린 허용 폴더(예: 맥의 /var → /private/var)와 글자가 달라 「폴더 밖」으로 잘못 읽힌다.
 */
async function resolveLoose(p: string): Promise<string> {
  try { return await Deno.realPath(p); } catch { /* 끝 조각이 없다 — 아래에서 있는 데까지만 푼다 */ }
  const full = lexicalResolve(p);
  let head = full;
  const tail: string[] = [];
  for (;;) {
    const up = dirName(head);
    if (up === head) return full;
    tail.unshift(baseName(head));
    head = up;
    try { return join(await Deno.realPath(head), ...tail); } catch { /* 더 위로 */ }
  }
}

const nfc = (s: string) => s.normalize("NFC");

function isInside(child: string, root: string): boolean {
  const sep = IS_WIN ? "\\" : "/";
  const c = nfc(child), r = nfc(root).replace(/[\\/]+$/, "");
  return c === r || c.startsWith(r + sep);
}

/** 이름을 (줄기, 확장자) 로 — 확장자의 대소문자를 그대로 둔다 */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** 같은 이름의 문안·표지. 있는 것만. (파이썬 곁파일) */
export async function sideFiles(video: string): Promise<string[]> {
  const out: string[] = [];
  for (const ext of TRASH_SIDE_EXT) {
    const 곁 = withSuffix(video, ext);
    if (곁 !== video && await exists(곁)) out.push(곁);
  }
  return out;
}

/** 이름 하나 옮기기 — 같은 디스크면 이름만 바꾸고, 다른 디스크(외장 → 내장 휴지통)면 복사한 뒤 지운다 */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await Deno.rename(src, dest);
  } catch {
    await Deno.copyFile(src, dest);
    await Deno.remove(src);
  }
}

/* ============================================================ 운영체제별로 보내기 */

async function defaultRun(cmd: string, args: string[], extraEnv?: Record<string, string>) {
  try {
    const r = await new Deno.Command(cmd, {
      args, env: extraEnv, stdout: "null", stderr: "piped", signal: AbortSignal.timeout(60_000),
    }).output();
    return { code: r.code, stderr: dec.decode(r.stderr) };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw new TrashError(`${cmd} 명령을 찾을 수 없습니다`);
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new TrashError(`${cmd} 가 60초 안에 끝나지 않았습니다`);
    }
    throw new TrashError(errMsg(e).slice(0, 200));
  }
}

/** 파인더에게 시킨다. 그래야 「제자리에 다시 넣기」가 된다. 경로는 인자로 넘겨 따옴표가 든 이름에도 안 깨진다. */
async function macTrash(paths: string[], run: Runner): Promise<void> {
  const script = [
    "on run argv",
    "set theFiles to {}",
    "repeat with i from 1 to count of argv",
    "set end of theFiles to (POSIX file (item i of argv))",
    "end repeat",
    'tell application "Finder" to delete theFiles',
    "end run",
  ];
  const r = await run("osascript", [...script.flatMap((l) => ["-e", l]), ...paths]);
  if (r.code !== 0) throw new TrashError((r.stderr || "파인더가 응답하지 않았습니다").trim().slice(0, 200));
}

/** 경로 목록은 환경변수로 넘긴다 — 한글 이름·작은따옴표가 PowerShell 글 안에서 깨지지 않게 */
async function winTrash(paths: string[], run: Runner): Promise<void> {
  const ps = "Add-Type -AssemblyName Microsoft.VisualBasic;" +
    'foreach($f in ($env:GU_FILES -split "`n")){ if($f){ ' +
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f,'OnlyErrorDialogs','SendToRecycleBin') } }";
  const r = await run("powershell", ["-NoProfile", "-Command", ps], { GU_FILES: paths.join("\n") });
  if (r.code !== 0) throw new TrashError((r.stderr || "휴지통으로 보내지 못했습니다").trim().slice(0, 200));
}

const xdgTrashRoot = () => join(env("XDG_DATA_HOME") || join(homeDir(), ".local", "share"), "Trash");

/** XDG 휴지통 규칙 — 어디서 왔는지를 .trashinfo 에 적어야 복원된다. 들어간 자리 목록을 돌려준다. */
async function linuxTrash(paths: string[]): Promise<string[]> {
  const root = xdgTrashRoot();
  await Deno.mkdir(join(root, "files"), { recursive: true });
  await Deno.mkdir(join(root, "info"), { recursive: true });
  const dests: string[] = [];
  for (const p of paths) {
    const [줄기, 꼬리] = splitName(baseName(p));
    let 이름 = baseName(p);
    let n = 1;
    while (await exists(join(root, "files", 이름)) || await exists(join(root, "info", `${이름}.trashinfo`))) {
      이름 = `${줄기}.${n}${꼬리}`;
      n++;
    }
    const info = join(root, "info", `${이름}.trashinfo`);
    const 경로글 = p.split("/").map(encodeURIComponent).join("/");
    await Deno.writeTextFile(info, `[Trash Info]\nPath=${경로글}\nDeletionDate=${isoWall(wallNow())}\n`);
    const dest = join(root, "files", 이름);
    try {
      await moveFile(p, dest);
    } catch (e) {
      try { await Deno.remove(info); } catch { /* 정보 파일만 남은 찌꺼기는 없는 편이 낫다 */ }
      throw new TrashError(`${baseName(p)} 를 휴지통으로 옮기지 못했습니다: ${errMsg(e).slice(0, 120)}`);
    }
    dests.push(dest);
  }
  return dests;
}

/* ============================================================ 공개 함수 */

/**
 * 영상 하나와 딸린 파일을 휴지통으로. 못 보내면 TrashError. (파이썬 trash.보내기)
 *
 * allowedRoots 를 주면 그 안의 파일만 지운다. 화면에서 넘어온 경로를 그대로 믿고 지우면 엉뚱한 것이 사라질 수 있다.
 */
export async function sendToTrash(
  video: string, allowedRoots?: string[] | null, opts: TrashOpts = {},
): Promise<TrashResult> {
  const os = opts.os ?? currentOs();
  const run = opts.run ?? defaultRun;
  let v: string;
  try {
    v = await resolveLoose(video);
  } catch {
    throw new TrashError("경로가 이상합니다");
  }

  if (allowedRoots !== undefined && allowedRoots !== null) {
    const 뿌리 = await Promise.all(allowedRoots.map((x) => resolveLoose(x)));
    if (!뿌리.some((r) => isInside(v, r))) throw new TrashError("등록된 채널 폴더 안의 파일만 지울 수 있습니다");
  }

  if (!(await exists(v))) throw new TrashError("파일이 이미 없습니다");

  const 보낼것 = [v, ...(await sideFiles(v))];
  if (os === "mac") await macTrash(보낼것, run);
  else if (os === "win") await winTrash(보낼것, run);
  else await linuxTrash(보낼것);

  const 남음: string[] = [];
  for (const p of 보낼것) if (await exists(p)) 남음.push(p);
  if (남음.length) throw new TrashError(`${남음.length}개가 그대로 남았습니다`);

  return { 영상: baseName(v), 함께: 보낼것.slice(1).map(baseName), 개수: 보낼것.length };
}

/**
 * 파일 하나를 휴지통 폴더로 **단순 이동**한다 — 「제자리에 다시 넣기」 정보가 없다.
 * (파이썬 folders.mark_done 이 올린 뒤 사본 폴더의 영상·제목 파일을 `~/.Trash` 로 치우던 방식)
 * 같은 이름이 이미 휴지통에 있으면 「이름 1」「이름 2」… 로 번호를 붙인다. 성공하면 들어간 자리, 실패하면 null.
 * 맥: ~/.Trash · 리눅스: XDG 휴지통(정보 파일 포함) · 윈도우: 휴지통(PowerShell).
 */
export async function moveToTrashPlain(path: string, opts: TrashOpts = {}): Promise<string | null> {
  const os = opts.os ?? currentOs();
  try {
    const p = await resolveLoose(path);
    if (!(await exists(p))) throw new TrashError("파일이 이미 없습니다");
    if (os === "win") {
      await winTrash([p], opts.run ?? defaultRun);
      return "휴지통";
    }
    if (os === "linux") return (await linuxTrash([p]))[0];
    const 통 = join(homeDir(), ".Trash");
    await Deno.mkdir(통, { recursive: true });
    const [줄기, 꼬리] = splitName(baseName(p));
    let dest = join(통, baseName(p));
    let i = 1;
    while (await exists(dest)) dest = join(통, `${줄기} ${i++}${꼬리}`);
    await moveFile(p, dest);
    return dest;
  } catch (e) {
    await log(`   ⚠️  휴지통으로 보내지 못했습니다: ${errMsg(e).slice(0, 120)}`);
    return null;
  }
}


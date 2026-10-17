// 크로스플랫폼 경로 · 파일 읽고 쓰기 · 기록(로그) · 파일 잠금
//
// 2.0.0 — 저장 파일은 현재 업로더(파이썬)와 **같은 이름·같은 꼴**이다.
//   (channels.json · tokens.json · ledger.csv · pending.json · 발사대기.json …)
//   자리는 옛 앱과 같은 OS 표준 폴더라, 쓰던 사람의 설정·토큰이 그대로 이어진다(migrate.ts).
export const IS_WIN = Deno.build.os === "windows";
export const IS_MAC = Deno.build.os === "darwin";
export const APP_NAME = "가라사대업로더";
export const APP_ID = "com.garasadae.uploader";
export const APP_VERSION = "2.0.0";
export const REPO = "beautifulahin/garasadae-uploader";

export function env(k: string): string {
  try { return Deno.env.get(k) ?? ""; } catch { return ""; }
}

/** 집 폴더. GARASADAE_HOME 을 주면 그쪽을 쓴다 — 시험이 진짜 집(LaunchAgents 등)을 건드리지 않게. */
export function homeDir(): string {
  return env("GARASADAE_HOME") || env(IS_WIN ? "USERPROFILE" : "HOME") || ".";
}

export function join(...parts: string[]): string {
  const sep = IS_WIN ? "\\" : "/";
  return parts.filter(Boolean).join(sep).replace(/[\\/]+/g, () => sep);
}

/** 파일 이름만 (경로 구분자는 / 와 \ 둘 다 본다) */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}
export function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? "." : (i === 0 ? p.slice(0, 1) : p.slice(0, i));
}
/** 확장자를 뗀 이름 (stem) */
export function stemOf(name: string): string {
  const b = baseName(name);
  const i = b.lastIndexOf(".");
  return i <= 0 ? b : b.slice(0, i);
}
export function extOf(name: string): string {
  const b = baseName(name);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i).toLowerCase();
}
/** 확장자만 바꾼 경로 (파이썬 Path.with_suffix) — 앞의 폴더 경로는 적힌 그대로 둔다 */
export function withSuffix(p: string, suffix: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const dir = i < 0 ? "" : p.slice(0, i + 1);
  const name = p.slice(i + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  return dir + stem + suffix;
}

/** 설정·토큰·기록을 두는 곳.  GARASADAE_DATA_DIR 로 바꿀 수 있다(시험·모래상자용). */
export function dataDir(): string {
  const override = env("GARASADAE_DATA_DIR");
  if (override) return override;
  if (IS_WIN) return join(env("APPDATA") || join(homeDir(), "AppData", "Roaming"), APP_NAME);
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", APP_NAME);
  return join(env("XDG_CONFIG_HOME") || join(homeDir(), ".config"), APP_NAME);
}
export const dataPath = (...p: string[]) => join(dataDir(), ...p);
/** 기록/ 폴더 안 */
export const recordPath = (...p: string[]) => join(dataDir(), "기록", ...p);

export async function exists(p: string): Promise<boolean> {
  try { await Deno.stat(p); return true; } catch { return false; }
}
export function existsSync(p: string): boolean {
  try { Deno.statSync(p); return true; } catch { return false; }
}
export async function isFile(p: string): Promise<boolean> {
  try { return (await Deno.stat(p)).isFile; } catch { return false; }
}
export async function isDir(p: string): Promise<boolean> {
  try { return (await Deno.stat(p)).isDirectory; } catch { return false; }
}

/** 바탕화면. 윈도우는 OneDrive 리디렉션까지 확인한다. */
export async function desktopDir(): Promise<string> {
  const home = homeDir();
  if (!IS_WIN) return join(home, "Desktop");
  try {
    // 한글 윈도우의 콘솔은 한글을 UTF-8 로 내보내지 않는다. 경로를 Base64 로 받아 이쪽에서 되돌린다.
    const ps = `$v = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders').Desktop
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($v))`;
    const out = await runBase64(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps]);
    if (out) {
      const p = out.replace(/%([^%]+)%/g, (_, k) => env(k));
      if (await exists(p)) return p;
    }
  } catch { /* 무시 */ }
  for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const od = env(k);
    if (od && await exists(join(od, "Desktop"))) return join(od, "Desktop");
  }
  return join(home, "Desktop");
}

export function fromBase64(s: string): string {
  if (!s) return "";
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export async function runBase64(cmd: string[]): Promise<string> {
  const c = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" });
  const { stdout, code } = await c.output();
  if (code !== 0) return "";
  return fromBase64(new TextDecoder().decode(stdout).trim());
}

/** 이 판에 붙은 이름표(Resources/label.txt). 공개판은 없다. */
export function buildLabel(): string {
  try {
    const exe = Deno.execPath();
    const i = exe.lastIndexOf("/Contents/MacOS/");
    const 자리 = i > 0
      ? exe.slice(0, i) + "/Contents/Resources/label.txt"
      : join(exe.slice(0, Math.max(exe.lastIndexOf("/"), 0)), "label.txt");
    return Deno.readTextFileSync(자리).trim().slice(0, 20);
  } catch {
    return "";
  }
}

/* ============================================================ JSON 읽고 쓰기 */

/**
 * 파일마다 **한 줄로 세운다.** 같은 파일에 두 곳이 동시에 쓰면 서로를 잡아먹는다
 * (옛 앱 2026-08-22 실측: 동시에 40번 걸어 40번 다 터졌다).
 */
const 쓰기줄 = new Map<string, Promise<unknown>>();

export function 줄서서<T>(열쇠: string, 일: () => Promise<T>): Promise<T> {
  const 앞사람 = 쓰기줄.get(열쇠) ?? Promise.resolve();
  const 내차례 = 앞사람.then(일, 일); // 앞사람이 넘어져도 내 차례는 온다
  쓰기줄.set(열쇠, 내차례.catch(() => {}));
  return 내차례;
}

export interface WriteOpts {
  /** 비밀이 든 파일 — 맥·리눅스에서 권한 600 */
  secret?: boolean;
  /** 들여쓰기 (기본 2, 0이면 한 줄) */
  indent?: number;
}

export function writeJson(path: string, data: unknown, opts: WriteOpts = {}): Promise<void> {
  return 줄서서(path, () => writeJsonNow(path, data, opts));
}

export async function writeTextAtomic(path: string, text: string, secret = false): Promise<void> {
  return 줄서서(path, () => writeTextNow(path, text, secret));
}

async function writeTextNow(path: string, text: string, secret = false) {
  await Deno.mkdir(dirName(path), { recursive: true }).catch(() => {});
  // 임시 이름은 부를 때마다 다르게 — 앞선 판이 남긴 찌꺼기와 부딪히지 않게
  const tmp = `${path}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, path);
  } catch (e) {
    try { await Deno.remove(tmp); } catch { /* 없으면 그만이다 */ }
    throw e;
  }
  if (secret && !IS_WIN) { try { await Deno.chmod(path, 0o600); } catch { /* 무시 */ } }
}

async function writeJsonNow(path: string, data: unknown, opts: WriteOpts) {
  const indent = opts.indent ?? 2;
  await writeTextNow(path, JSON.stringify(data, null, indent || undefined), !!opts.secret);
}

/** 깨진 파일은 옆에 남겨 두고 알린다 — 조용히 빈 값으로 갈아엎으면 기록이 통째로 날아간다. */
async function setAsideCorrupt(path: string, why: string) {
  try {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    await Deno.copyFile(path, `${path}.깨짐_${stamp}`);
    await log(`⚠️  ${baseName(path)} 을 읽지 못해(${why}) 사본을 옆에 남겼습니다`);
  } catch { /* 무시 */ }
}

/** JSON 을 읽는다. 없으면 fallback, 깨졌으면 사본을 남기고 fallback. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return structuredClone(fallback);
  }
  if (!text.trim()) return structuredClone(fallback);
  try {
    return JSON.parse(text.replace(/^﻿/, "")) as T;
  } catch (e) {
    await setAsideCorrupt(path, e instanceof Error ? e.message : String(e));
    return structuredClone(fallback);
  }
}

export function readJsonSync<T>(path: string, fallback: T): T {
  try {
    const text = Deno.readTextFileSync(path);
    if (!text.trim()) return structuredClone(fallback);
    return JSON.parse(text.replace(/^﻿/, "")) as T;
  } catch {
    return structuredClone(fallback);
  }
}

/** 바뀌지 않았으면 다시 읽지 않는 읽기 (파이썬 local_json.read_json) */
const 읽기캐시 = new Map<string, { sig: string; value: unknown }>();
export async function readJsonCached<T>(path: string, fallback: T): Promise<T> {
  try {
    const st = await Deno.stat(path);
    const sig = `${st.size}:${st.mtime?.getTime() ?? 0}`;
    const hit = 읽기캐시.get(path);
    if (hit && hit.sig === sig) return structuredClone(hit.value) as T;
    const value = await readJson<T>(path, fallback);
    읽기캐시.set(path, { sig, value });
    return structuredClone(value);
  } catch {
    return structuredClone(fallback);
  }
}

export async function ensureDataDir() {
  await Deno.mkdir(dataDir(), { recursive: true });
  await Deno.mkdir(recordPath(), { recursive: true });
}

/* ============================================================ 파일 잠금 */

/**
 * 파일 잠금 안에서 일을 한다 (파이썬 fcntl.flock).
 * wait=false 이면 이미 잠겨 있을 때 기다리지 않고 null 을 돌려준다.
 * 다른 프로세스(화면 서버·예약 작업·명령줄)와 함께 쓰는 문이라 프로세스 사이에서도 막는다.
 */
export async function withFileLock<T>(
  lockPath: string,
  일: () => Promise<T>,
  opts: { wait?: boolean } = {},
): Promise<T | null> {
  await Deno.mkdir(dirName(lockPath), { recursive: true }).catch(() => {});
  const f = await Deno.open(lockPath, { read: true, write: true, create: true });
  try {
    if (opts.wait === false) {
      const got = await f.tryLock(true);
      if (!got) return null;
    } else {
      await f.lock(true);
    }
    try {
      return await 일();
    } finally {
      try { await f.unlock(); } catch { /* 무시 */ }
    }
  } finally {
    try { f.close(); } catch { /* 무시 */ }
  }
}

/* ============================================================ 기록(로그) */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 「~」로 시작하는 경로를 집 폴더로 (파이썬 expanduser). 사람이 손으로 적은 폴더 칸에 쓴다. */
export function expandHome(p: string): string {
  const t = String(p ?? "").trim();
  if (t === "~") return homeDir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(homeDir(), t.slice(2));
  return t;
}

/** 글자 수로 자르기 — 파이썬 `s[:n]` 처럼 한 글자(이모지 포함)를 반으로 가르지 않는다 */
export function cut(s: unknown, n: number): string {
  const t = String(s ?? "");
  if (t.length <= n) return t;
  return Array.from(t).slice(0, n).join("");
}

/** 시각 글자 — 기록 한 줄 앞에 붙는다 (이 컴퓨터 시각) */
export function stampNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 파일마다 남길 줄 수 (파이썬 기록장.한도) */
export const LOG_LIMITS: Record<string, number> = {
  "서버.log": 3000,
  "올리기.log": 5000, // 업로드 기록은 오래 남긴다 — 사후에 되짚을 일이 많다
  "올리기감시.log": 3000,
  "심사확인.log": 2000,
};
export const LOG_DEFAULT_LIMIT = 2000;

/** 기록/<파일> 에 한 줄 남긴다. 못 남겨도 하던 일을 멈추지 않는다. (파이썬 기록장.적기) */
export async function recordLine(file: string, line: string): Promise<void> {
  try {
    await Deno.mkdir(recordPath(), { recursive: true });
    await Deno.writeFile(recordPath(file), enc.encode(`${stampNow()}  ${line}\n`), { append: true, create: true });
  } catch { /* 기록을 못 남긴다고 하던 일을 멈추면 안 된다 */ }
}

let 조용히 = false;
/** 시험이 콘솔을 어지럽히지 않게 */
export function setQuiet(on: boolean) { 조용히 = on; }

/** 화면·콘솔·기록/서버.log 에 한 줄. */
export async function log(msg: string): Promise<void> {
  if (!조용히) console.log(msg);
  await recordLine("서버.log", msg.replace(/\n/g, " ⏎ "));
}

/** 파일의 뒤쪽 n줄 — 통째로 읽지 않는다(화면이 자주 부르는 자리). */
export async function tailFile(path: string, n = 60, maxBytes = 128 * 1024): Promise<string[]> {
  try {
    const f = await Deno.open(path, { read: true });
    try {
      const size = (await f.stat()).size;
      const take = Math.min(size, maxBytes);
      await f.seek(size - take, Deno.SeekMode.Start);
      const buf = new Uint8Array(take);
      let got = 0;
      while (got < buf.length) {
        const k = await f.read(buf.subarray(got));
        if (k === null) break;
        got += k;
      }
      const lines = dec.decode(buf.subarray(0, got)).trimEnd().split("\n");
      if (size > take && lines.length) lines.shift(); // 반 토막 난 첫 줄은 버린다
      return lines.slice(-n);
    } finally {
      try { f.close(); } catch { /* 무시 */ }
    }
  } catch { return []; }
}

/** 올리기.log 와 서버.log 를 시각 순으로 섞은 뒤쪽 n줄 — 화면의 「최근 기록」 */
export async function recentLog(n = 80): Promise<string[]> {
  const a = await tailFile(recordPath("올리기.log"), n);
  const b = await tailFile(recordPath("서버.log"), n);
  return [...a, ...b].filter((x) => x.trim())
    .sort((x, y) => x.slice(0, 19).localeCompare(y.slice(0, 19))).slice(-n);
}

/** 너무 길어진 기록을 뒤에서부터 남기고 앞을 버린다. (파이썬 기록장.자르기) */
export async function trimLogs(): Promise<{ name: string; before: number; after: number }[]> {
  const out: { name: string; before: number; after: number }[] = [];
  try {
    for await (const e of Deno.readDir(recordPath())) {
      if (!e.isFile || !e.name.endsWith(".log")) continue;
      const limit = LOG_LIMITS[e.name] ?? LOG_DEFAULT_LIMIT;
      const p = recordPath(e.name);
      let lines: string[];
      try { lines = (await Deno.readTextFile(p)).split("\n"); } catch { continue; }
      if (lines.at(-1) === "") lines.pop();
      if (lines.length <= limit) continue;
      try {
        await writeTextAtomic(p, lines.slice(-limit).join("\n") + "\n");
        out.push({ name: e.name, before: lines.length, after: limit });
      } catch { /* 무시 */ }
    }
  } catch { /* 폴더가 없으면 자를 것도 없다 */ }
  return out;
}

/* ============================================================ 시각 글자(기록용) */

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 크로스플랫폼 경로 · 설정 · 상태
export const IS_WIN = Deno.build.os === "windows";
export const IS_MAC = Deno.build.os === "darwin";
export const APP_NAME = "가라사대업로더";
export const APP_ID = "com.garasadae.uploader";

function env(k: string) {
  try { return Deno.env.get(k) ?? ""; } catch { return ""; }
}

export function homeDir(): string {
  return env(IS_WIN ? "USERPROFILE" : "HOME") || ".";
}

/** 설정·토큰 저장 위치 (실행파일 옆이 아니라 OS 표준 위치) */
export function dataDir(): string {
  if (IS_WIN) return join(env("APPDATA") || join(homeDir(), "AppData", "Roaming"), APP_NAME);
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", APP_NAME);
  return join(env("XDG_CONFIG_HOME") || join(homeDir(), ".config"), APP_NAME);
}

export function join(...parts: string[]): string {
  const sep = IS_WIN ? "\\" : "/";
  return parts.filter(Boolean).join(sep).replace(/[\\/]+/g, (m) => (m.length ? sep : m));
}

/** 바탕화면. 윈도우는 OneDrive 리디렉션까지 확인한다. */
export async function desktopDir(): Promise<string> {
  const home = homeDir();
  if (!IS_WIN) return join(home, "Desktop");

  // 1) 레지스트리가 가장 정확하다
  try {
    const out = await run(["reg", "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
      "/v", "Desktop"]);
    const m = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (m) {
      let p = m[1].trim().replace(/%([^%]+)%/g, (_, k) => env(k));
      if (await exists(p)) return p;
    }
  } catch { /* 무시 */ }

  // 2) OneDrive 로 옮겨진 경우
  for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const od = env(k);
    if (od && await exists(join(od, "Desktop"))) return join(od, "Desktop");
  }
  return join(home, "Desktop");
}

export async function exists(p: string): Promise<boolean> {
  try { await Deno.stat(p); return true; } catch { return false; }
}

export async function run(cmd: string[]): Promise<string> {
  const c = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" });
  const { stdout } = await c.output();
  return new TextDecoder(IS_WIN ? "utf-8" : "utf-8").decode(stdout);
}

/* ----------------------------------------------------------- 설정 */
export interface Config {
  clientId: string;
  clientSecret: string;
  watchDir: string;
  pollSeconds: number;
  stableChecks: number;
  privacy: "private" | "unlisted" | "public";
  categoryId: string;
  language: string;
  tags: string[];
  description: string;
  titlePrefix: string;
  titleSuffix: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
  reviewMode: boolean;      // true = 사용자가 확인 버튼을 눌러야 업로드
  afterUpload: "move" | "keep";
  maxRetries: number;
  dailyLimit: number;
  notifications: boolean;
  autoStart: boolean;
  port: number;
}

export const DEFAULTS: Config = {
  clientId: "", clientSecret: "", watchDir: "",
  pollSeconds: 5, stableChecks: 3,
  privacy: "private", categoryId: "22", language: "ko",
  tags: [], description: "", titlePrefix: "", titleSuffix: "",
  madeForKids: false, notifySubscribers: true,
  reviewMode: false, afterUpload: "move",
  maxRetries: 3, dailyLimit: 6, notifications: true,
  autoStart: false, port: 8777,
};

export interface UploadRec {
  id: string; title: string; file: string; size: number;
  privacy: string; at: string;
}
export interface State {
  uploads: UploadRec[];
  failed: Record<string, number>;
  quotaDate: string;
  quotaUsed: number;
}
export const EMPTY_STATE: State = { uploads: [], failed: {}, quotaDate: "", quotaUsed: 0 };

const CONF_F = () => join(dataDir(), "config.json");
const STATE_F = () => join(dataDir(), "state.json");
const TOKEN_F = () => join(dataDir(), "tokens.json");
export const LOG_F = () => join(dataDir(), "uploader.log");

export async function ensureDataDir() {
  await Deno.mkdir(dataDir(), { recursive: true });
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return { ...fallback, ...JSON.parse(await Deno.readTextFile(path)) }; }
  catch { return structuredClone(fallback); }
}
async function writeJson(path: string, data: unknown, secret = false) {
  await ensureDataDir();
  const tmp = path + ".tmp";
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2));
  await Deno.rename(tmp, path);
  if (secret && !IS_WIN) { try { await Deno.chmod(path, 0o600); } catch { /* 무시 */ } }
}

export async function loadConfig(): Promise<Config> {
  const c = await readJson<Config>(CONF_F(), DEFAULTS);
  if (!c.watchDir) c.watchDir = join(await desktopDir(), "업로드대기");
  return c;
}
export const saveConfig = (c: Config) => writeJson(CONF_F(), c);

export const loadState = () => readJson<State>(STATE_F(), EMPTY_STATE);
export const saveState = (s: State) => writeJson(STATE_F(), s);

export interface Tokens {
  access_token?: string; refresh_token: string; expires_at?: number;
  channel?: { title: string; thumb: string; subs: string };
  channelError?: string;
  channelErrorUrl?: string;
}
export const loadTokens = async (): Promise<Tokens | null> => {
  try { return JSON.parse(await Deno.readTextFile(TOKEN_F())); } catch { return null; }
};
export const saveTokens = (t: Tokens) => writeJson(TOKEN_F(), t, true);
export const clearTokens = async () => { try { await Deno.remove(TOKEN_F()); } catch { /* 무시 */ } };

/* ----------------------------------------------------------- 로그 */
const enc = new TextEncoder();
export async function log(msg: string) {
  const line = `[${new Date().toLocaleString("ko-KR")}] ${msg}\n`;
  console.log(line.trimEnd());
  try {
    await ensureDataDir();
    await Deno.writeFile(LOG_F(), enc.encode(line), { append: true, create: true });
  } catch { /* 무시 */ }
}
export async function tailLog(n = 60): Promise<string[]> {
  try {
    const txt = await Deno.readTextFile(LOG_F());
    return txt.trimEnd().split("\n").slice(-n);
  } catch { return []; }
}

// 크로스플랫폼 경로 · 설정 · 상태 · 로그
export const IS_WIN = Deno.build.os === "windows";
export const IS_MAC = Deno.build.os === "darwin";
export const APP_NAME = "가라사대업로더";
export const APP_ID = "com.garasadae.uploader";
export const APP_VERSION = "1.7.17";
export const REPO = "beautifulahin/garasadae-uploader";

function env(k: string) {
  try { return Deno.env.get(k) ?? ""; } catch { return ""; }
}

export function homeDir(): string {
  return env(IS_WIN ? "USERPROFILE" : "HOME") || ".";
}

/** 설정·토큰 저장 위치 (실행파일 옆이 아니라 OS 표준 위치)
 *  GARASADAE_DATA_DIR 을 지정하면 그쪽을 쓴다 — 실제 사용 중인 설정을 건드리지 않고
 *  시험해 볼 때 사용한다. */
export function dataDir(): string {
  const override = env("GARASADAE_DATA_DIR");
  if (override) return override;
  if (IS_WIN) return join(env("APPDATA") || join(homeDir(), "AppData", "Roaming"), APP_NAME);
  if (IS_MAC) return join(homeDir(), "Library", "Application Support", APP_NAME);
  return join(env("XDG_CONFIG_HOME") || join(homeDir(), ".config"), APP_NAME);
}

export function join(...parts: string[]): string {
  const sep = IS_WIN ? "\\" : "/";
  return parts.filter(Boolean).join(sep).replace(/[\\/]+/g, () => sep);
}

/** 바탕화면. 윈도우는 OneDrive 리디렉션까지 확인한다. */
export async function desktopDir(): Promise<string> {
  const home = homeDir();
  if (!IS_WIN) return join(home, "Desktop");

  try {
    // 한글 윈도우의 콘솔은 한글을 UTF-8 로 내보내지 않는다.
    // 그래서 경로를 Base64(영문·숫자뿐)로 받아 이쪽에서 되돌린다.
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

export async function exists(p: string): Promise<boolean> {
  try { await Deno.stat(p); return true; } catch { return false; }
}

/** Base64 로 받은 글자를 UTF-8 로 되돌린다. 빈 값이거나 형식이 틀리면 빈 문자열. */
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

/** 명령을 실행해 Base64 로 나온 결과를 글자로 되돌려 받는다. 실패하면 빈 문자열. */
export async function runBase64(cmd: string[]): Promise<string> {
  const c = new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "null" });
  const { stdout, code } = await c.output();
  if (code !== 0) return "";
  return fromBase64(new TextDecoder().decode(stdout).trim());
}

/* ============================================================ 설정 */

/** 채널마다 다르게 둘 수 있는 업로드 기본값 */
export interface ChannelDefaults {
  privacy: "private" | "unlisted" | "public";
  categoryId: string;
  language: string;
  tags: string[];
  description: string;
  titlePrefix: string;
  titleSuffix: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
  reviewMode: boolean;
  afterUpload: "move" | "trash" | "delete" | "keep";
  dailyLimit: number;
  studioAfter: "ask" | "always" | "never";

  /** 같은 편을 두 번 올리는 것을 막는다 (파일이 같거나 제목이 같을 때).
   *  ★여태 막힌 것은 '그대로 두기' 로 둔 파일뿐이었다. `_완료로 옮기기`(기본값)로
   *    쓰면 같은 mp4 를 다시 떨굴 때 **그대로 또 올라갔다.** */
  dupGuard: boolean;

  /** 공개 시각을 나눠 주는 자리들. `["07:00","12:00","19:00"]` 꼴.
   *  비어 있으면 여태처럼 예약 없이 바로 올린다.
   *  ★올리는 것은 여전히 즉시다 — **뜨는 시각만** 나눈다. */
  publishSlots: string[];

  /** 올린 직후 첫 댓글을 단다. 쪽지의 `firstComment` 에 적힌 글.
   *  ★유튜브 API 에는 **댓글을 고정하는 길이 없다** — 다는 것까지만 한다. */
  firstComment: boolean;

  /** 이 시간이 지나면 제목을 쪽지의 `titleB` 로 갈아끼운다. 0 이면 안 한다. */
  retitleHours: number;
}

export const CHANNEL_DEFAULTS: ChannelDefaults = {
  privacy: "private",
  categoryId: "22",
  language: "ko",
  tags: [],
  description: "",
  titlePrefix: "",
  titleSuffix: "",
  madeForKids: false,
  notifySubscribers: true,
  reviewMode: false,
  afterUpload: "move",
  dailyLimit: 6,
  studioAfter: "ask",
  dupGuard: true,
  publishSlots: [],
  firstComment: false,
  retitleHours: 0,
};

export interface Channel extends ChannelDefaults {
  id: string;
  name: string;            // 사용자가 붙인 이름 (폴더 이름으로도 쓰인다)
  folder: string;          // 감시 폴더 절대경로
  clientId: string;        // 이 채널이 쓰는 구글 클라이언트
  clientSecret: string;
  /** 다른 채널의 구글 프로젝트를 같이 쓸 때 그 채널 id. 비어 있으면 자기 것을 쓴다.
   *  같은 프로젝트를 쓰면 하루 업로드 한도도 함께 나눠 쓴다. */
  sharesWith: string;
  enabled: boolean;
  createdAt: string;
}

export interface Config {
  schema: 2;
  port: number;
  pollSeconds: number;
  stableChecks: number;
  notifications: boolean;
  autoStart: boolean;
  autoStartAsked: boolean;
  updateDeclines: Record<string, number>;
  baseDir: string;          // 채널 폴더들이 들어가는 상위 폴더
  browser: string;          // 화면을 띄울 브라우저. 비어 있으면 시스템 기본값
  channels: Channel[];
  /** 이 컴퓨터에만 있는 **끼움 화면**. 탭으로 붙어 그 주소를 그대로 띄운다.
   *
   * ★배포본에는 목록이 비어 있다 — 붙일 화면은 각자의 설정 파일에만 있다. 자기
   *   컴퓨터에서 돌리는 다른 도구를 업로더 안에서 함께 보려고 만들었다.
   * ★127.0.0.1 이나 localhost 만 받는다. 남의 사이트를 탭으로 끼우면 그 화면이
   *   업로더 안에 있는 것처럼 보여 위험하다.
   */
  panels: { name: string; url: string }[];
}

export const DEFAULTS: Config = {
  schema: 2,
  port: 8777,
  pollSeconds: 5,
  stableChecks: 3,
  notifications: true,
  autoStart: false,
  autoStartAsked: false,
  updateDeclines: {},
  baseDir: "",
  browser: "",
  channels: [],
  panels: [],
};

export function newChannelId(): string {
  return "ch_" + crypto.randomUUID().slice(0, 8);
}

/** 이름에서 폴더로 쓸 수 없는 글자를 없앤다 */
export function safeFolderName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 60) || "채널";
}

/** 하루 한도를 함께 쓰는 단위(구글 프로젝트)를 가려낸다.
 *  sharesWith 로 연결된 채널들은 같은 열쇠를 돌려준다. */
export function projectKey(cfg: Config, ch: Channel): string {
  const seen = new Set<string>();
  let cur: Channel | undefined = ch;
  while (cur && cur.sharesWith && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next: Channel | undefined = cfg.channels.find((c) => c.id === cur!.sharesWith);
    if (!next) break;
    cur = next;
  }
  return (cur?.clientId || cur?.id || ch.id).trim();
}

/** 그 채널이 실제로 쓸 구글 클라이언트 정보 */
export function credsOf(cfg: Config, ch: Channel): { clientId: string; clientSecret: string } {
  const seen = new Set<string>();
  let cur: Channel | undefined = ch;
  while (cur && cur.sharesWith && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next: Channel | undefined = cfg.channels.find((c) => c.id === cur!.sharesWith);
    if (!next) break;
    cur = next;
  }
  return { clientId: cur?.clientId ?? "", clientSecret: cur?.clientSecret ?? "" };
}

/** 이 컴퓨터 시간 기준 날짜 (YYYY-MM-DD).
 *  세계표준시를 쓰면 한국에서 새벽 0~9시에 '오늘' 이 하루 밀린다. */
/** 이 판에 붙은 이름표. 앱 안에 `Resources/label.txt` 가 있으면 그 글자를 화면에 단다.
 *
 * ★공개판을 그대로 쓰면서 **자기만의 판**을 따로 짓는 사람이 있다(쪽지처럼 자기에게만
 *   필요한 것을 얹는 경우). 그때 버전 숫자는 바탕이 된 공개판과 같아서 화면만 보고는
 *   구분이 안 된다 — 실제로 "이거 공개판 아니야?" 하고 헷갈렸다. 이름표로 가른다.
 * ★파일이 없으면 아무것도 안 단다. 공개판은 그대로다. */
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

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 유튜브 할당량이 세는 **그날**. 태평양 날짜다.
 *
 * ★유튜브 API 할당량은 **태평양 자정**에 리셋된다. 한국시간으로는 오후 4시(서머타임 중)
 *   또는 오후 5시다. 그런데 여태 `localDate()`(그 컴퓨터의 날짜)로 셌다. 시차가 있는
 *   곳에서는 우리 카운터만 먼저 0 이 되고 구글 것은 그대로라, **"오늘 0편 썼다"고 믿고
 *   계속 시도하다 quotaExceeded 를 받았다.** 세는 자리를 구글과 같은 날짜로 맞춘다.
 *
 * ★사람에게 보여 주는 "오늘 몇 편"(todayCount)은 그대로 그 컴퓨터의 날짜를 쓴다 —
 *   그건 사용자의 하루지 구글의 하루가 아니다.
 */
export function quotaDate(d = new Date()): string {
  // en-CA 로 뽑으면 2026-08-20 꼴로 나온다
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** 할당량이 다시 차오르는 때 — 태평양 자정을 이 컴퓨터 시각으로 옮긴 것 */
export function quotaResetAt(d = new Date()): string {
  const 태평양오늘 = quotaDate(d);
  // 태평양 자정 = 그 날짜의 00:00 (PDT −07:00 / PST −08:00). 두 시각 중 아직 안 온 쪽.
  for (const 시차 of ["-07:00", "-08:00"]) {
    const t = new Date(`${태평양오늘}T00:00:00${시차}`);
    const 내일 = new Date(t.getTime() + 24 * 3600_000);
    if (내일 > d) return 내일.toISOString();
  }
  return new Date(d.getTime() + 24 * 3600_000).toISOString();
}

/** 기록에 남기는 시각. localDate() 와 앞 10자리가 일치해야 한다. */
export function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDate(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface UploadRec {
  id: string;
  title: string;
  file: string;
  size: number;
  privacy: string;
  at: string;
  channelId: string;
  channelName: string;
  verified?: boolean;
  /** 파일 지문 — 같은 파일이 또 들어왔는지 가리는 데 쓴다(fileFingerprint) */
  hash?: string;
  /** 예약 공개 시각(RFC3339). 슬롯이 겹치지 않게 하는 데도 쓴다. */
  publishAt?: string;
}

/** 올린 뒤 성적. 유튜브에 다시 물어 채운다. */
export interface StatRec {
  views: number;
  likes: number;
  comments: number;
  /** 잰 때 (epoch ms) */
  at: number;
  /** 유튜브가 아는 지금 제목 — 우리가 적어 둔 것과 다를 수 있다(손으로 고쳤을 때) */
  title?: string;
  privacy?: string;
  /** 사라진 영상 — 지웠거나 유튜브가 내렸다 */
  gone?: boolean;
}

/** 나중에 할 일 — 첫 댓글, 제목 갈아끼우기처럼 **뒤에** 해야 하는 것 */
export interface Job {
  kind: "comment" | "retitle";
  videoId: string;
  channelId: string;
  /** 할 때 (epoch ms) */
  at: number;
  text: string;
  tries: number;
}

export interface State {
  uploads: UploadRec[];
  /** 영상별 성적. 열쇠는 videoId */
  stats: Record<string, StatRec>;
  /** 성적을 마지막으로 잰 때 (epoch ms) */
  statsAt: number;
  /** 밀린 뒷일 */
  jobs: Job[];
  /** '그대로 두기' 로 이미 올린 파일. 열쇠는 "채널id|파일이름" */
  kept: Record<string, number>;
  failed: Record<string, number>;
  /** 구글 프로젝트별 하루 사용량. 열쇠는 projectKey() */
  quota: Record<string, { date: string; used: number }>;
}

export const EMPTY_STATE: State = {
  uploads: [], stats: {}, statsAt: 0, jobs: [], kept: {}, failed: {}, quota: {},
};

const CONF_F = () => join(dataDir(), "config.json");
const STATE_F = () => join(dataDir(), "state.json");
const TOKEN_DIR = () => join(dataDir(), "tokens");
const TOKEN_F = (channelId: string) => join(TOKEN_DIR(), `${channelId}.json`);
export const LOG_F = () => join(dataDir(), "uploader.log");

export async function ensureDataDir() {
  await Deno.mkdir(dataDir(), { recursive: true });
  await Deno.mkdir(TOKEN_DIR(), { recursive: true });
}

/** 파일마다 **한 줄로 세운다.** 같은 파일에 두 곳이 동시에 쓰면 서로를 잡아먹는다.
 *
 * ★실제로 일어나던 일 (2026-08-22 실측: 동시에 40번 걸어 40번 다 터졌다)
 *   `state.json` 을 쓰는 곳은 감시 고리(`loop`)만이 아니다. 화면에서 [진행] 을
 *   누르면 `server.ts` 가 `engine.uploadOne()` 을 **기다리지 않고** 띄우므로,
 *   그 업로드가 성적 재기·뒷일하기와 겹칠 수 있다. 그런데 임시 파일 이름이
 *   `state.json.tmp` 하나뿐이라, 뒤엣것이 앞엣것의 임시 파일을 지워 버리고
 *   앞엣것의 `rename` 이 **NotFound 로 터졌다.**
 *   그 예외는 업로드가 **다 끝난 뒤에** 던져져 `uploadOne` 의 catch 로 떨어졌다 —
 *   그래서 **멀쩡히 올라간 편이 「실패」로 적히고 다시 시도**되었다.
 *   (뒤처리도 안 돌아 파일이 대기함에 그대로 남았다.)
 */
const 쓰기줄 = new Map<string, Promise<unknown>>();

function 줄서서<T>(열쇠: string, 일: () => Promise<T>): Promise<T> {
  const 앞사람 = 쓰기줄.get(열쇠) ?? Promise.resolve();
  const 내차례 = 앞사람.then(일, 일);          // 앞사람이 넘어져도 내 차례는 온다
  쓰기줄.set(열쇠, 내차례.catch(() => {}));
  return 내차례;
}

function writeJson(path: string, data: unknown, secret = false): Promise<void> {
  return 줄서서(path, () => writeJsonNow(path, data, secret));
}

async function writeJsonNow(path: string, data: unknown, secret = false) {
  await Deno.mkdir(path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))), { recursive: true })
    .catch(() => {});
  // ★임시 이름은 **부를 때마다 다르게.** 줄을 세워도 앞선 판이 남긴 찌꺼기와
  //   부딪히지 않게 한다(프로그램이 쓰다 죽었을 수도 있다).
  const tmp = `${path}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2));
    await Deno.rename(tmp, path);
  } catch (e) {
    try { await Deno.remove(tmp); } catch { /* 없으면 그만이다 */ }
    throw e;
  }
  if (secret && !IS_WIN) { try { await Deno.chmod(path, 0o600); } catch { /* 무시 */ } }
}

/* ---------------------------------------------- 설정 읽기·쓰기 */

let confCache: Config | null = null;

export async function loadConfig(force = false): Promise<Config> {
  if (confCache && !force) return confCache;
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await Deno.readTextFile(CONF_F())); } catch { /* 처음 실행 */ }

  const cfg = await normalize(raw);
  confCache = cfg;
  return cfg;
}

export async function saveConfig(c: Config): Promise<void> {
  confCache = c;
  await writeJson(CONF_F(), c);
}

/** 옛 설정(채널 하나짜리)을 새 구조로 옮기고, 빠진 값을 채운다. */
async function normalize(raw: Record<string, unknown>): Promise<Config> {
  const cfg: Config = {
    ...structuredClone(DEFAULTS),
    ...(raw as Partial<Config>),
    schema: 2,
  };
  cfg.updateDeclines = (raw.updateDeclines as Record<string, number>) ?? {};
  cfg.channels = Array.isArray(raw.channels) ? (raw.channels as Channel[]) : [];
  // ★끼움 화면은 **내 컴퓨터의 것만** 받는다. 남의 사이트를 탭으로 끼우면 그 화면이
  //   업로더 안에 있는 것처럼 보여, 무엇을 누르는지 헷갈리게 만들 수 있다.
  cfg.panels = (Array.isArray(raw.panels) ? raw.panels : [])
    .map((x) => ({ name: String((x as {name?: string}).name ?? "").slice(0, 20),
                   url: String((x as {url?: string}).url ?? "") }))
    .filter((x) => x.name && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(x.url))
    .slice(0, 5);

  if (!cfg.baseDir) cfg.baseDir = join(await desktopDir(), "업로드대기");

  // ── 옛 구조에서 넘어오기 ─────────────────────────────
  const wasOld = raw.watchDir !== undefined && cfg.channels.length === 0;
  if (wasOld) {
    const id = newChannelId();
    const folder = String(raw.watchDir);
    cfg.channels = [{
      ...structuredClone(CHANNEL_DEFAULTS),
      id,
      name: "내 채널",
      folder,
      clientId: String(raw.clientId ?? ""),
      clientSecret: String(raw.clientSecret ?? ""),
      sharesWith: "",
      enabled: true,
      createdAt: new Date().toISOString(),
      privacy: (raw.privacy as ChannelDefaults["privacy"]) ?? "private",
      categoryId: String(raw.categoryId ?? "22"),
      language: String(raw.language ?? "ko"),
      tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
      description: String(raw.description ?? ""),
      titlePrefix: String(raw.titlePrefix ?? ""),
      titleSuffix: String(raw.titleSuffix ?? ""),
      madeForKids: !!raw.madeForKids,
      notifySubscribers: raw.notifySubscribers !== false,
      reviewMode: !!raw.reviewMode,
      afterUpload: (raw.afterUpload as ChannelDefaults["afterUpload"]) ?? "move",
      dailyLimit: Number(raw.dailyLimit ?? 6),
      studioAfter: (raw.studioAfter as ChannelDefaults["studioAfter"]) ?? "ask",
    }];
    // 폴더가 옛 기본 위치면 그것을 상위 폴더로 삼는다
    cfg.baseDir = folder;

    // 옛 토큰 파일을 채널 토큰으로 옮긴다
    try {
      const oldTok = join(dataDir(), "tokens.json");
      if (await exists(oldTok)) {
        await Deno.mkdir(TOKEN_DIR(), { recursive: true });
        await Deno.copyFile(oldTok, TOKEN_F(id));
        await Deno.rename(oldTok, oldTok + ".migrated");
      }
    } catch { /* 무시 */ }

    // 옛 기록에 채널을 붙인다
    try {
      const st: State = JSON.parse(await Deno.readTextFile(STATE_F()));
      let touched = false;
      for (const u of st.uploads ?? []) {
        if (!u.channelId) { u.channelId = id; u.channelName = "내 채널"; touched = true; }
      }
      const anyState = st as unknown as Record<string, unknown>;
      if (anyState.quotaUsed !== undefined) {
        st.quota = st.quota ?? {};
        st.quota[String(raw.clientId ?? id)] = {
          date: String(anyState.quotaDate ?? ""),
          used: Number(anyState.quotaUsed ?? 0),
        };
        delete anyState.quotaUsed;
        delete anyState.quotaDate;
        touched = true;
      }
      if (touched) await writeJson(STATE_F(), st);
    } catch { /* 기록이 없으면 넘어간다 */ }
  }

  // 옛 평면 항목 정리
  for (const k of ["watchDir", "clientId", "clientSecret", "privacy", "categoryId", "language",
    "tags", "description", "titlePrefix", "titleSuffix", "madeForKids", "notifySubscribers",
    "reviewMode", "afterUpload", "dailyLimit", "studioAfter"]) {
    delete (cfg as unknown as Record<string, unknown>)[k];
  }

  // 채널마다 빠진 값 채우기
  cfg.channels = cfg.channels.map((c) => ({
    ...structuredClone(CHANNEL_DEFAULTS),
    ...c,
    id: c.id || newChannelId(),
    name: c.name || "채널",
    folder: c.folder || join(cfg.baseDir, safeFolderName(c.name || "채널")),
    sharesWith: c.sharesWith ?? "",
    enabled: c.enabled !== false,
    createdAt: c.createdAt || new Date().toISOString(),
    tags: Array.isArray(c.tags) ? c.tags : [],
    dupGuard: c.dupGuard !== false,
    publishSlots: 슬롯정리(c.publishSlots),
    firstComment: !!c.firstComment,
    retitleHours: clampNum(c.retitleHours, 0, 720, 0),
  }));

  cfg.port = clampNum(cfg.port, 1024, 65535, 8777);
  cfg.pollSeconds = clampNum(cfg.pollSeconds, 2, 3600, 5);
  cfg.stableChecks = clampNum(cfg.stableChecks, 1, 60, 3);
  return cfg;
}

/** 공개 슬롯을 `HH:MM` 꼴로 추린다. 틀린 것은 조용히 버리고, 이른 시각부터 세운다. */
export function 슬롯정리(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(x).trim());
    if (!m) continue;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    const s = `${String(h).padStart(2, "0")}:${m[2]}`;
    if (!out.includes(s)) out.push(s);
  }
  return out.sort().slice(0, 12);
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

export const findChannel = (cfg: Config, id: string) => cfg.channels.find((c) => c.id === id);

/* ---------------------------------------------- 상태 */

export async function loadState(): Promise<State> {
  try {
    const s = JSON.parse(await Deno.readTextFile(STATE_F()));
    return {
      uploads: Array.isArray(s.uploads) ? s.uploads : [],
      stats: s.stats ?? {},
      statsAt: Number(s.statsAt) || 0,
      jobs: Array.isArray(s.jobs) ? s.jobs : [],
      kept: s.kept ?? {},
      failed: s.failed ?? {},
      quota: s.quota ?? {},
    };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}
export const saveState = (s: State) => writeJson(STATE_F(), s);

/* ---------------------------------------------- 토큰 (채널별) */

export interface Tokens {
  access_token?: string;
  refresh_token: string;
  expires_at?: number;
  /** 로그인할 때 실제로 받은 권한 범위. 고급 기능(첫 댓글·제목 교체)에는
   *  `youtube.force-ssl` 이 있어야 하는데, 옛 토큰에는 없다. */
  scope?: string;
  channel?: {
    id?: string; title: string; thumb: string; subs: string;
    views?: string; videos?: string; handle?: string;
  };
  channelError?: string;
  channelErrorUrl?: string;
}

export async function loadTokens(channelId: string): Promise<Tokens | null> {
  try { return JSON.parse(await Deno.readTextFile(TOKEN_F(channelId))); } catch { return null; }
}
export const saveTokens = (channelId: string, t: Tokens) => writeJson(TOKEN_F(channelId), t, true);
export const clearTokens = async (channelId: string) => {
  try { await Deno.remove(TOKEN_F(channelId)); } catch { /* 무시 */ }
};

/* ---------------------------------------------- 로그 */
const enc = new TextEncoder();
const dec = new TextDecoder();

/** 로그를 얼마나 두고 볼까. 넘으면 앞쪽을 덜어 낸다.
 *  ★화면은 **6초마다** 로그를 다시 읽는다(ui.html: `setInterval(loadLog, 6000)`).
 *    끝없이 자라게 두면 몇 달 뒤에는 수십 MB 짜리를 하루에 만 번 넘게 읽게 된다. */
const 로그최대 = 4 * 1024 * 1024;
const 로그남길것 = 1024 * 1024;
const 꼬리읽을것 = 128 * 1024;

export async function log(msg: string) {
  const line = `[${new Date().toLocaleString("ko-KR")}] ${msg}\n`;
  console.log(line.trimEnd());
  try {
    await ensureDataDir();
    await Deno.writeFile(LOG_F(), enc.encode(line), { append: true, create: true });
    await 로그덜어내기();
  } catch { /* 무시 */ }
}

/** 너무 커졌으면 뒤쪽만 남기고 다시 쓴다. 쓰기 줄에 세워 덧쓰기와 엇갈리지 않게 한다. */
async function 로그덜어내기() {
  const 자리 = LOG_F();
  let 크기 = 0;
  try { 크기 = (await Deno.stat(자리)).size; } catch { return; }
  if (크기 <= 로그최대) return;
  await 줄서서(자리, async () => {
    const f = await Deno.open(자리, { read: true });
    try {
      const 새크기 = (await f.stat()).size;
      if (새크기 <= 로그최대) return;
      await f.seek(새크기 - 로그남길것, Deno.SeekMode.Start);
      const buf = new Uint8Array(로그남길것);
      let 읽음 = 0;
      while (읽음 < buf.length) {
        const n = await f.read(buf.subarray(읽음));
        if (n === null) break;
        읽음 += n;
      }
      const 글 = dec.decode(buf.subarray(0, 읽음));
      const 줄머리 = 글.indexOf("\n") + 1;                  // 잘린 첫 줄은 버린다
      await Deno.writeTextFile(자리, "…(앞부분은 덜어 냈습니다)\n" + 글.slice(줄머리));
    } finally {
      try { f.close(); } catch { /* 무시 */ }
    }
  }).catch(() => {});
}

export async function tailLog(n = 60): Promise<string[]> {
  // ★통째로 읽지 않는다 — 화면이 6초마다 부르는 자리다.
  try {
    const f = await Deno.open(LOG_F(), { read: true });
    try {
      const 크기 = (await f.stat()).size;
      const 잴것 = Math.min(크기, 꼬리읽을것);
      await f.seek(크기 - 잴것, Deno.SeekMode.Start);
      const buf = new Uint8Array(잴것);
      let 읽음 = 0;
      while (읽음 < buf.length) {
        const k = await f.read(buf.subarray(읽음));
        if (k === null) break;
        읽음 += k;
      }
      const 줄 = dec.decode(buf.subarray(0, 읽음)).trimEnd().split("\n");
      if (크기 > 잴것 && 줄.length) 줄.shift();              // 반 토막 난 첫 줄은 버린다
      return 줄.slice(-n);
    } finally {
      try { f.close(); } catch { /* 무시 */ }
    }
  } catch { return []; }
}

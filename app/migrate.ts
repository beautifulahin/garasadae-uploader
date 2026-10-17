// 옛 판(v1.x)을 쓰던 사람의 자료를 새 모양으로 옮긴다 — 채널 설정 · 로그인 정보 · 올린 기록 · 앱 설정.
//
// 지키는 약속 (사장님 지시 2026-10: 「등록해놓은 채널들 없어지지않도록 유지시키고」)
//   · **옛 파일은 하나도 지우거나 덮지 않는다.** config.json · state.json · tokens/ · uploader.log 는 그대로 둔다. 새 구조로는 「복사해서 옮기기」만 한다.
//     딱 하나, 옛 「단일 tokens.json」(최상위에 refresh_token 이 있는 아주 옛 꼴)만은 새 앱의 tokens.json 과 이름이 같아
//     새 꼴로 바꿔야 한다 — 그 파일은 바꾸기 **전에** `tokens.json.옛판_<시각>` 으로 사본을 먼저 만들고, 아래 복사본에도 들어 있다.
//   · **옮기기 전에 옛 자료를 날짜 붙은 폴더에 통째로 복사해 둔다**(`백업/이행전_<날짜_시각>/`). 복사본이 온전한지(크기·SHA-256) 다시 읽어 확인하고,
//     못 만들면 아무것도 옮기지 않는다. 같은 자료로 여러 번 돌아도 복사본은 새로 늘지 않는다.
//   · **몇 번을 돌려도 결과가 같다.** 조각마다 「이미 있으면 건드리지 않는다」로 짰고, 모든 쓰기는 임시 파일 → 이름 바꾸기(원자적)다.
//     중간에 꺼져도 `이행기록.json` 이 없으니 다음에 켤 때 이어서 끝낸다.
//   · **옮긴 뒤 하나씩 다시 확인한다**(verifyMigration): 옛 채널 수 = 새 채널 수 · 채널마다 유튜브 채널 ID · 폴더 · 로그인 정보(갱신 토큰 · 그 토큰을 받은 구글 열쇠 · 권한) ·
//     옛 올린 기록(예약 포함). 하나라도 빠지면 **이행기록을 남기지 않고 새 판을 멈춘다**(hold.ts) — 옛 자료는 그대로 살아 있고, 문제 목록에 빨간 줄과 복사본 위치가 뜬다.
//   · **열쇠·토큰 값은 어디에도 출력하거나 남기지 않는다** — 로그·보고·이행기록에는 채널 이름과 개수만 적는다.
//   · 새 앱에 같은 기능이 없는 설정(첫 댓글·제목 교체 등)은 버리되, 무엇을 왜 버렸는지 이행기록에 적는다.
//   · 새 앱에 같은 이름의 다른 채널이 이미 있어도 옛 채널을 버리지 않는다 — 이름에 (2) 를 붙여 따로 옮긴다.
//   · 같은 유튜브 채널을 이름 둘로 등록했던 옛 채널은 로그인 정보도 둘 다 그대로 둔다(하나로 합치지 않는다 — 살아 있는 쪽을 지울 수 있다).
//
// 옛 앱은 채널마다 구글 클라이언트(clientId/Secret)를 갖고 있었다. 옛 토큰은 그 클라이언트로만 갱신되므로,
// 새 앱에서는 채널 전용 열쇠 파일(client_secret_<이름>.json)을 만들어 토큰 항목의 `secret` 이 가리키게 한다 — 옛 토큰이 그대로 산다.
// (이 앱에 묶여 온 기본 열쇠로 바꿔 끼우지 않는다 — 다른 열쇠로는 옛 토큰이 죽는다. clientFor 가 `secret` 을 맨 먼저 본다.)
//
// 옛 자료의 자리는 새 앱과 같은 데이터 폴더다(앱 이름이 같다). 다른 자리를 보려면 GARASADAE_OLD_DATA_DIR 로 바꾼다(시험).
import {
  APP_VERSION, baseName, cut, dataDir, dataPath, desktopDir, dirName, env, exists, IS_WIN, isDir, isFile, join, log,
  readJsonSync, withFileLock, writeJson,
} from "./paths.ts";
import { isoWall, minuteWall, parseWall, wallNow } from "./clock.ts";
import { type ChannelConf, editChannels, loadChannelsRaw, sameFolder } from "./channels.ts";
import { loadStore, putEntry, readClientFile, SCOPES_LEGACY, type TokenEntry, updateStore } from "./ytcore.ts";
import { saveChannelClientFile } from "./oauth.ts";
import { LEDGER_HEAD, readLedgerRaw, updateLedger } from "./ledger.ts";
import { type AppSettings, saveAppSettings } from "./settings.ts";
import { loadPolicies, writePolicy } from "./daily.ts";
import { VIDEO_EXT } from "./folders.ts";
import { migrationHold, resolveHold, setHold } from "./hold.ts";

type Obj = Record<string, unknown>;

/* ============================================================ 꼴 */

export interface FolderInfo {
  channel: string;
  folder: string;
  exists: boolean;
  /** 폴더 맨 위에 기다리는 영상 — 새 앱이 이어서 올린다 */
  waiting: number;
  /** 옛 앱이 올린 뒤 치워 둔 `_완료` · 실패한 `_실패` · 보류한 `_보류` 안의 영상 (새 앱은 건드리지 않는다) */
  done: number;
  failed: number;
  held: number;
}

export interface OldState {
  /** 옛 자료가 있는 폴더 */
  dir: string;
  /** 이미 이행을 마쳤다 (이행기록.json 이 있다) */
  done: boolean;
  /** 이행할 것이 있다 — 아직 안 했고, 옛 config.json 이나 옛 단일 tokens.json 이 있다 */
  needed: boolean;
  configFound: boolean;
  stateFound: boolean;
  /** 옛 채널 설정 수 (읽을 수 없으면 0) */
  channels: number;
  /** 로그인 정보 파일(tokens/*.json) 수 */
  tokenFiles: number;
  /** 최상위에 refresh_token 이 있는 옛 단일 tokens.json 이 있다 */
  singleToken: boolean;
  /** 옛 올린 기록 수 */
  uploads: number;
}

export interface MigrationReport {
  /** 끝까지 갔다. false 이면 errors 를 보라 — 이행기록을 쓰지 않았으니 다음 실행에서 이어서 한다 */
  ok: boolean;
  dryRun: boolean;
  /** 이번 호출이 실제로 일을 했다 (이미 끝냈거나 옮길 옛 자료가 없으면 false) */
  ran: boolean;
  /** 이미 이행을 마친 뒤라 아무것도 안 했다 */
  already: boolean;
  at: string;
  oldDir: string;
  /** 옮긴 채널 */
  channels: number;
  channelNames: string[];
  /** 로그인 정보를 옮긴 채널 수 */
  tokens: number;
  /** 로그인 정보를 못 옮겨 다시 연결해야 하는 채널 */
  needLogin: string[];
  /** 원장에 더한 줄 수 · 이미 원장에 있어 건너뛴 줄 수 */
  ledgerRows: number;
  ledgerSkipped: number;
  /** 하루 한도 정책을 만든 채널 수 */
  policies: number;
  /** 옮긴 앱 설정 칸 (값은 적지 않는다) */
  settings: string[];
  /** 건너뛴 것과 까닭 */
  skipped: string[];
  /** 새 앱에 같은 기능이 없어 옮기지 않은 것과 까닭 */
  dropped: string[];
  warnings: string[];
  /** 참고 (꺼 둔 채널이었음 · 삭제 → 휴지통 으로 바꿈 따위) */
  notes: string[];
  errors: string[];
  folders: FolderInfo[];
  /** 옮기기 직전에 옛 자료를 복사해 둔 폴더 (복사본을 만들지 않았으면 "") */
  backupDir: string;
  /** 복사본에 든 파일 수 */
  backupFiles: number;
  /** 같은 자료의 복사본이 이미 있어 새로 만들지 않았다 */
  backupReused: boolean;
  /** 옮긴 뒤 확인한 결과 (옮기기 전에 멈췄거나 시험 이행이면 null) */
  verify: VerifyReport | null;
  /** 확인에서 빠진 것이 나오거나 끝까지 못 가서 새 판이 올리기·공개를 멈춰 두었다 */
  held: boolean;
}

/** 옮긴 뒤 옛 판 자료와 하나씩 견준 결과 — 값은 없고 이름·개수·사람 말뿐이다 */
export interface VerifyReport {
  ok: boolean;
  /** 옛 판의 채널 수 */
  oldChannels: number;
  /** 그 채널들의 칸이 새 앱에 온전히 있는 수 */
  newChannels: number;
  /** 새 앱의 채널 칸 전체 수 (옛 채널 + 새 앱에 원래 있던 것) */
  totalChannels: number;
  /** 옛 판에서 쓸 수 있던 로그인 정보 수 → 새 앱에서 온전히 살아 있는 수 */
  tokensOld: number;
  tokensNew: number;
  /** 옛 올린 기록(영상 ID 가 있는 것, 겹침 제외) → 새 원장에 있는 수 */
  ledgerOld: number;
  ledgerNew: number;
  /** 빠졌거나 달라진 것 (사람 말) */
  missing: string[];
}

function emptyReport(dryRun: boolean): MigrationReport {
  return {
    ok: true, dryRun, ran: false, already: false, at: isoWall(wallNow()), oldDir: "",
    channels: 0, channelNames: [], tokens: 0, needLogin: [], ledgerRows: 0, ledgerSkipped: 0, policies: 0,
    settings: [], skipped: [], dropped: [], warnings: [], notes: [], errors: [], folders: [],
    backupDir: "", backupFiles: 0, backupReused: false, verify: null, held: false,
  };
}

/* ============================================================ 작은 도구 */

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const errText = (e: unknown) => cut(e instanceof Error ? e.message : String(e), 160);

/** 옛 자료가 있는 폴더 — 새 앱과 같은 데이터 폴더. 시험이 다른 자리를 볼 수 있다. */
export const oldDir = () => env("GARASADAE_OLD_DATA_DIR") || dataDir();
const recordFile = () => dataPath("이행기록.json");
const storeFile = () => dataPath("tokens.json");

/**
 * 옛 JSON 을 읽는다. 없으면 missing, 깨졌으면 ok=false.
 * paths.readJson 을 안 쓰는 까닭: 깨진 파일을 만나면 그것은 옆에 사본을 **쓴다** — 옛 폴더에는 아무것도 쓰지 않는다(시험 이행 포함).
 * 오류 글에 파일 내용 조각이 섞이지 않도록 메시지는 버린다(토큰 파일을 읽다 깨졌을 때 값 일부가 새지 않게).
 */
async function readOldJson(path: string): Promise<{ ok: boolean; missing: boolean; value: unknown }> {
  let text: string;
  try { text = await Deno.readTextFile(path); } catch (e) {
    return { ok: false, missing: e instanceof Deno.errors.NotFound, value: null };
  }
  try { return { ok: true, missing: false, value: JSON.parse(text.replace(/^\uFEFF/, "")) }; } catch {
    return { ok: false, missing: false, value: null };
  }
}

/** 최상위에 refresh_token 글자가 있으면 옛 단일 토큰 꼴이다 (새 꼴의 최상위는 채널 이름 → 항목 객체) */
async function readSingleToken(path: string): Promise<Obj | null> {
  const r = await readOldJson(path);
  return r.ok && isObj(r.value) && typeof r.value.refresh_token === "string" ? r.value : null;
}

/** 슬롯 `HH:MM` 들을 정리 — 틀린 것은 버리고, 이른 시각부터, 중복 없이, 열둘까지 (옛 앱의 슬롯정리) */
function cleanSlots(v: unknown): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(x).trim());
    if (!m) continue;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) continue;
    const s = `${String(h).padStart(2, "0")}:${m[2]}`;
    if (!out.includes(s)) out.push(s);
  }
  return out.sort().slice(0, 12);
}

/** 이행기록용 시각 글 — 20261017_093005 */
function stampText(): string {
  return isoWall(wallNow()).replace(/[-:]/g, "").replace("T", "_");
}

/** 원본을 그대로 옆에 복사해 둔다. 같은 내용의 사본이 이미 있으면 그것을 쓴다 (끊겼다 다시 돌 때 사본이 늘지 않게). */
async function backupFile(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const dir = dirName(path), base = baseName(path);
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.startsWith(`${base}.옛판_`)) continue;
      const other = await Deno.readFile(join(dir, e.name));
      if (other.length === bytes.length && other.every((b, i) => b === bytes[i])) return join(dir, e.name);
    }
  } catch { /* 폴더를 못 읽으면 새로 만든다 */ }
  let dest = `${path}.옛판_${stampText()}`;
  for (let n = 2; await exists(dest); n++) dest = `${path}.옛판_${stampText()}_${n}`;
  await Deno.copyFile(path, dest);
  if (!IS_WIN) { try { await Deno.chmod(dest, 0o600); } catch { /* 무시 */ } }   // 토큰이 든 사본이다
  return dest;
}

/* ============================================================ 옛 설정 해석 */

interface OldChan {
  /** 옛 채널 id (ch_xxxxxxxx) — 토큰 파일 이름 */
  oldId: string;
  name: string;
  raw: Obj;
  /** 채널 목록이 없던 아주 옛 설정(평평한 꼴)에서 만든 가상 채널 */
  flat: boolean;
}

function oldChannels(cfg: Obj): OldChan[] {
  const list = Array.isArray(cfg.channels) ? cfg.channels.filter(isObj) : [];
  if (list.length) return list.map((c) => ({ oldId: str(c.id), name: str(c.name) || "채널", raw: c, flat: false }));
  // 아주 옛 설정: watchDir · clientId · clientSecret … 이 맨 위에 평평하게 있다 (옛 앱의 normalize 가 「내 채널」로 바꾸던 꼴)
  if (str(cfg.watchDir)) return [{ oldId: "", name: "내 채널", raw: { ...cfg, folder: cfg.watchDir }, flat: true }];
  return [];
}

/** 이 채널이 실제로 쓰는 구글 클라이언트 — sharesWith 를 따라간다 (옛 앱의 credsOf) */
function credsFor(c: OldChan, all: OldChan[]): { clientId: string; clientSecret: string } {
  const seen = new Set<string>();
  let cur: OldChan | undefined = c;
  while (cur && str(cur.raw.sharesWith) && !seen.has(cur.oldId)) {
    seen.add(cur.oldId);
    const want = str(cur.raw.sharesWith);
    const next: OldChan | undefined = all.find((x) => x.oldId === want);
    if (!next) break;
    cur = next;
  }
  return { clientId: str(cur?.raw.clientId), clientSecret: str(cur?.raw.clientSecret) };
}

/** 옛 판에서 만든 채널 설정을 새 칸으로. (필드 변환 표) */
function mapChannel(raw: Obj, cid: string, folder: string): ChannelConf {
  const slots = cleanSlots(raw.publishSlots);
  const privacy = str(raw.privacy);
  const after = str(raw.afterUpload);
  const conf: ChannelConf = {
    channel_id: cid,
    folder,
    prefix: "",
    // 슬롯이 있으면 그 시각에 예약 공개, 없으면 옛 앱처럼 올리고 바로(심사 뒤) 공개한다
    publish: slots.length ? "schedule" : "now",
    // 옛 privacy 는 올린 직후의 공개 범위였다 → 심사가 끝난 뒤 정할 공개 범위. 옛 기본은 private(자동 공개 안 함).
    after_review: ["public", "unlisted", "private"].includes(privacy) ? privacy : "private",
    // 삭제는 휴지통으로 바꾼다 — 새 앱은 영상을 지우지 않는다(되살릴 수 있게)
    after_upload: after === "trash" || after === "delete" ? "trash" : after === "keep" ? "keep" : "move",
  };
  if (slots.length) conf.times = slots;
  // 머리말·설명은 다듬지 않고 쓴 그대로 옮긴다 — 「[A] 」 끝의 공백은 제목과 붙지 않게 하는 의미 있는 글자다
  if (typeof raw.titlePrefix === "string" && raw.titlePrefix.trim()) conf.title_prefix = raw.titlePrefix;
  if (typeof raw.description === "string" && raw.description.trim()) conf.desc = raw.description;
  const tags = strs(raw.tags);
  if (tags.length) conf.tags = tags;
  if (str(raw.language)) conf.audio_language = str(raw.language);
  if (raw.madeForKids === true) conf.made_for_kids = true;
  // 옛 dailyLimit 은 「하루 업로드 편수」였다 → 일 한도 정책 파일이 상한을 지키고, 여기 값은 하루에 몇 편씩 고르는지(고정)를 같은 숫자로 맞춘다
  const limit = Math.trunc(num(raw.dailyLimit, 0));
  if (limit > 0) { conf.daily_rule = "fixed"; conf.daily = limit; }
  return conf;
}

/** 새 앱에 같은 기능이 없어 버리는 설정 — **쓰던 것만** 적는다(기본값은 소음이라 적지 않는다) */
function droppedFor(name: string, raw: Obj): string[] {
  const out: string[] = [];
  const d = (m: string) => out.push(`[${name}] ${m}`);
  if (raw.reviewMode === true) d("검토 모드 — 새 앱에 같은 항목이 없어 옮기지 않았습니다");
  const studio = str(raw.studioAfter);
  if (studio && studio !== "ask") d(`올린 뒤 스튜디오 열기(${studio}) — 새 앱에 같은 항목이 없어 옮기지 않았습니다`);
  if (raw.firstComment === true || str(raw.firstCommentText)) d("첫 댓글 자동 달기 — 댓글 쓰기는 force-ssl 권한이 필요한데 새 앱의 로그인 방식으로는 받을 수 없어 옮기지 못합니다");
  if (num(raw.retitleHours) > 0 || str(raw.retitleTemplate)) d("제목 자동 교체 — force-ssl 권한이 필요한데 새 앱의 로그인 방식으로는 받을 수 없어 옮기지 못합니다");
  if (raw.notifySubscribers === false) d("구독자 알림 끄기 — 새 앱에 같은 항목이 없어 옮기지 않았습니다");
  if (raw.dupGuard === false) d("중복 올리기 막기 끄기 — 새 앱은 원장으로 늘 중복을 막습니다(끌 수 없음)");
  if (str(raw.sharesWith)) d("구글 프로젝트 공유(sharesWith) — 공유 대상의 열쇠를 그대로 가져와 같은 프로젝트로 셉니다. 공유 설정 자체는 새 앱에 없습니다");
  if (str(raw.titleSuffix)) d("제목 꼬리말 — 새 앱에 같은 항목이 없어 옮기지 않았습니다");
  const cat = str(raw.categoryId);
  if (cat && cat !== "22") d(`카테고리(${cat}) — 새 앱은 채널별이 아니라 운영 원칙(policy.json)의 기본값 하나를 씁니다`);
  return out;
}

/** 옛 앱이 새 채널 기본 폴더로 쓰던 바탕화면 「업로드대기」인가 */
async function isOldDefaultBaseDir(p: string): Promise<boolean> {
  const t = p.replace(/[\\/]+$/, "");
  if (baseName(t) !== "업로드대기") return false;
  const parent = dirName(t);
  if (sameFolder(parent, await desktopDir())) return true;
  return /^(Desktop|바탕 ?화면)$/i.test(baseName(parent));
}

const VIDEO_EXTS = [...VIDEO_EXT];
async function countVideos(dir: string): Promise<number> {
  let n = 0;
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || e.name.startsWith(".")) continue;
      const i = e.name.lastIndexOf(".");
      if (i > 0 && VIDEO_EXTS.includes(e.name.slice(i).toLowerCase())) n++;
    }
  } catch { /* 폴더가 없으면 0 */ }
  return n;
}

async function surveyFolder(channel: string, folder: string): Promise<FolderInfo> {
  const ok = !!folder && await isDir(folder);
  if (!ok) return { channel, folder, exists: false, waiting: 0, done: 0, failed: 0, held: 0 };
  return {
    channel, folder, exists: true, waiting: await countVideos(folder),
    done: await countVideos(join(folder, "_완료")), failed: await countVideos(join(folder, "_실패")), held: await countVideos(join(folder, "_보류")),
  };
}

/* ============================================================ 열쇠 파일 */

interface KeyLike { id: string; secret: string }
const keyName = (nm: string) => `client_secret_${nm.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "채널"}.json`;

async function readKeyLoose(path: string): Promise<KeyLike | null> {
  try {
    // 비밀 파일 — 파일 위치만 확인하고 값은 비교에만 쓴다
    const r = await readClientFile(path);
    return { id: r.client_id, secret: r.client_secret };
  } catch { return null; }
}

/* ============================================================ 이행 직전 복사 (백업) */

const 백업뿌리 = () => dataPath("백업");
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
const 최대복사 = 20 * 1024 * 1024;

interface BackupItem { rel: string; abs: string; part: "옛자료" | "현재자료" }
interface ManifestEntry { p: string; size: number; sha: string }
interface Manifest { schema: 1; 일시: string; 앱버전: string; 옛자료: ManifestEntry[]; 현재자료: ManifestEntry[] }

/**
 * 복사할 파일들.
 *   옛자료   — 옛 구조: config.json · state.json · tokens/ 안의 모든 파일 · (옛 단일 꼴이면) tokens.json
 *   현재자료 — 새 앱의 데이터 폴더에 이미 있는 JSON·CSV (채널 · 로그인 · 원장 · 설정 · 정책 · 열쇠 파일 …) — 옮기다가 바뀔 수 있는 것들
 * 로그·큰 파일·잠금 파일은 넣지 않는다.
 */
async function backupItems(): Promise<BackupItem[]> {
  const out: BackupItem[] = [];
  const old = oldDir(), cur = dataDir();
  const seen = new Set<string>();
  const add = (part: BackupItem["part"], rel: string, abs: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ rel: `${part}/${rel}`, abs, part });
  };
  for (const f of ["config.json", "state.json"]) if (await isFile(join(old, f))) add("옛자료", f, join(old, f));
  if ((await readSingleToken(join(old, "tokens.json"))) !== null) add("옛자료", "tokens.json", join(old, "tokens.json"));
  try {
    for await (const e of Deno.readDir(join(old, "tokens"))) if (e.isFile) add("옛자료", `tokens/${e.name}`, join(old, "tokens", e.name));
  } catch { /* 폴더가 없으면 건너뛴다 */ }
  try {
    for await (const e of Deno.readDir(cur)) {
      if (!e.isFile || !/\.(json|csv)$/i.test(e.name)) continue;
      if (e.name === "이행기록.json" || e.name === "이행보류.json") continue;
      add("현재자료", e.name, join(cur, e.name));
    }
  } catch { /* 폴더가 없으면 건너뛴다 */ }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

async function readManifest(dir: string): Promise<Manifest | null> {
  const r = await readOldJson(join(dir, "목록.json"));
  return r.ok && isObj(r.value) && Array.isArray(r.value.옛자료) ? (r.value as unknown as Manifest) : null;
}

const 같은목록 = (a: ManifestEntry[], b: ManifestEntry[]) =>
  a.length === b.length && a.every((x, i) => x.p === b[i].p && x.size === b[i].size && x.sha === b[i].sha);

/**
 * 옛 자료를 날짜 붙은 폴더에 **복사**해 둔다. 원본은 읽기만 한다.
 *  · 복사본마다 다시 읽어 SHA-256 을 견준다(복사가 반쯤 되다 만 것을 걸러낸다). 하나라도 어긋나면 던진다 — 그러면 아무것도 옮기지 않는다.
 *  · 옛 자료(옛 구조 파일들)가 이미 떠 둔 복사본과 똑같으면 새로 만들지 않고 그 폴더를 돌려준다(끊겼다 다시 돌 때 복사본이 쌓이지 않게).
 *  · `.작성중` 폴더에서 다 만든 뒤 한 번에 이름을 바꾼다 — 반쯤 만든 복사본이 「복사본」으로 보이지 않는다.
 *  · 토큰이 든 복사본이라 폴더 700 · 파일 600 (윈도우는 해당 없음).
 */
export async function backupAll(): Promise<{ dir: string; files: number; reused: boolean }> {
  const items = await backupItems();
  const entries: { item: BackupItem; bytes: Uint8Array; sha: string }[] = [];
  for (const item of items) {
    const st = await Deno.stat(item.abs);
    if (st.size > 최대복사) continue;                // 상식 밖으로 큰 파일은 설정이 아니다
    const bytes = await Deno.readFile(item.abs);
    entries.push({ item, bytes, sha: await sha256(bytes) });
  }
  const mk = (part: BackupItem["part"]): ManifestEntry[] =>
    entries.filter((e) => e.item.part === part).map((e) => ({ p: e.item.rel, size: e.bytes.length, sha: e.sha }));
  const 옛 = mk("옛자료"), 현 = mk("현재자료");

  // 같은 옛 자료의 복사본이 이미 있나 (최근 것부터)
  const root = 백업뿌리();
  const names: string[] = [];
  try { for await (const e of Deno.readDir(root)) if (e.isDirectory && /^이행전_\d{8}_\d{6}(_\d+)?$/.test(e.name)) names.push(e.name); } catch { /* 아직 없다 */ }
  for (const nm of names.sort().reverse()) {
    const m = await readManifest(join(root, nm));
    if (m && 같은목록(m.옛자료, 옛)) return { dir: join(root, nm), files: m.옛자료.length + m.현재자료.length, reused: true };
  }

  const stamp = stampText();
  let final = join(root, `이행전_${stamp}`);
  for (let n = 2; await exists(final); n++) final = join(root, `이행전_${stamp}_${n}`);
  const tmp = `${final}.작성중`;
  await Deno.mkdir(tmp, { recursive: true });
  if (!IS_WIN) { try { await Deno.chmod(root, 0o700); await Deno.chmod(tmp, 0o700); } catch { /* 무시 */ } }
  for (const e of entries) {
    const dest = join(tmp, ...e.item.rel.split("/"));
    await Deno.mkdir(dirName(dest), { recursive: true });
    if (!IS_WIN) { try { await Deno.chmod(dirName(dest), 0o700); } catch { /* 무시 */ } }
    await Deno.writeFile(dest, e.bytes);
    if (!IS_WIN) { try { await Deno.chmod(dest, 0o600); } catch { /* 무시 */ } }
    const back = await sha256(await Deno.readFile(dest));
    if (back !== e.sha) throw new Error(`복사본 ${e.item.rel} 이 원본과 다릅니다`);
  }
  await Deno.writeTextFile(join(tmp, "읽어보세요.txt"),
    "이 폴더는 가라사대 업로더가 옛 판의 자료를 새 판으로 옮기기 직전에 떠 둔 복사본입니다.\n" +
    "옛자료/ 안의 파일은 옮기기 전 옛 판의 설정·로그인 정보·기록 그대로입니다 (원본도 지우지 않고 그대로 두었습니다).\n" +
    "현재자료/ 안의 파일은 그때 새 판 데이터 폴더에 이미 있던 파일입니다.\n" +
    "옛 판으로 되돌릴 때는 옛자료/ 안의 파일을 데이터 폴더에 같은 이름으로 복사하세요. 로그인 정보가 들어 있으니 다른 사람에게 보내지 마세요.\n");
  const manifest: Manifest = { schema: 1, 일시: isoWall(wallNow()), 앱버전: APP_VERSION, 옛자료: 옛, 현재자료: 현 };
  await writeJson(join(tmp, "목록.json"), manifest);
  await Deno.rename(tmp, final);
  return { dir: final, files: entries.length, reused: false };
}

/* ============================================================ 시험용 끊기 */

let 끊기: ((자리: string) => void | Promise<void>) | null = null;
/**
 * 시험: 이행 도중 정해진 자리에서 일부러 끊거나(던진다) 파일을 몰래 바꾼다 — 프로그램이 죽은 것·조용히 빠진 것을 흉내낸다.
 * 자리 이름: 복사끝 · 채널시작:<이름> · 로그인끝:<이름> · 채널칸끝:<이름> · 원장시작 · 원장끝 · 설정끝 · 옮기기끝 · 기록직전
 * null 이면 끈다. 운영 코드는 이 함수를 부르지 않는다.
 */
export function setMigrateFault(f: ((자리: string) => void | Promise<void>) | null) { 끊기 = f; }
const 여기서 = async (자리: string) => { if (끊기) await 끊기(자리); };

/* ============================================================ 이행 본체 */

interface Ctx {
  rep: MigrationReport;
  write: boolean;
  say: (line: string) => void;
  dir: string;
  cfg: Obj;
  chans: OldChan[];
  /** 옛 단일 tokens.json (없으면 null) */
  singleTok: Obj | null;
  /** 새 앱의 tokens.json 이 옛 단일 꼴이다 — 첫 쓰기 전에 사본을 만들고 새 꼴로 바꿔야 한다 */
  newIsSingle: boolean;
  storeConverted: boolean;
  /** 이번 실행에서 정한(또는 만든) 열쇠 파일 — 시험 이행에서도 이름이 겹치지 않게 */
  keyPlan: Map<string, KeyLike>;
  /** 옮긴 채널마다 「옛 판에서 이랬다」를 적어 둔 것 — 옮긴 뒤 확인(verifyMigration)이 이것과 새 앱을 견준다 */
  plan: PlanItem[];
  /** 옛 올린 기록의 영상 ID들 (겹침 제외) */
  oldUploadIds: string[];
}

/** 옛 채널 하나가 새 앱에서 이렇게 되어 있어야 한다는 기대 (열쇠·토큰 값이 들어 있으니 밖으로 내보내지 않는다) */
interface PlanItem {
  /** 새 앱에서의 채널 이름 */
  name: string;
  oldName: string;
  /** 채널 칸을 만든다 (단일 토큰만 있고 채널 설정이 없으면 false) */
  slot: boolean;
  /** 옛 로그인 정보가 알려 주는 유튜브 채널 ID (없으면 "") */
  cid: string;
  /** 옛 폴더 (없으면 "") */
  folder: string;
  /** 옛 판에서 쓸 수 있던 로그인 정보 (갱신 토큰 + 그 토큰을 받은 구글 열쇠 + 권한). 없던 채널이면 null */
  tok: { rt: string; clientId: string; clientSecret: string; scopes: string[] } | null;
}

/** 채널 전용 열쇠 파일을 정한다. 같은 이름이 이미 있고 같은 열쇠면 그것을 쓰고, 다른 열쇠면 번호를 붙인다. */
async function placeKeyFile(ctx: Ctx, name: string, creds: { clientId: string; clientSecret: string }): Promise<string> {
  let nm = name;
  const short = name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 30) || "채널";
  for (let n = 2; n < 200; n++) {
    const file = keyName(nm);
    const have = ctx.keyPlan.get(file) ?? await readKeyLoose(dataPath(file));
    if (!have) {
      if (ctx.write) {
        const got = await saveChannelClientFile(nm, creds);
        ctx.keyPlan.set(got, { id: creds.clientId, secret: creds.clientSecret });
        return got;
      }
      ctx.keyPlan.set(file, { id: creds.clientId, secret: creds.clientSecret });
      return file;
    }
    if (have.id === creds.clientId && have.secret === creds.clientSecret) {
      ctx.keyPlan.set(file, have);
      return file;
    }
    nm = `${short}_${n}`;
  }
  throw new Error("열쇠 파일 이름을 정하지 못했습니다");
}

/** 새 tokens.json 에 항목을 넣는다. 옛 단일 꼴이었다면 사본을 만든 뒤 한 번에 새 꼴로 갈아끼운다. */
async function putToken(ctx: Ctx, key: string, entry: TokenEntry): Promise<string[]> {
  if (ctx.newIsSingle && !ctx.storeConverted) {
    const copy = await backupFile(storeFile());
    ctx.rep.notes.push(`옛 단일 로그인 정보(tokens.json)를 ${baseName(copy)} 로 백업하고 새 꼴로 바꿨습니다`);
    // 한 번의 쓰기로 통째로 — 읽고 쓰는 사이에 끊겨도 옛 꼴 아니면 새 꼴이다
    await updateStore((s) => {
      const loose = s as unknown as Obj;
      for (const k of Object.keys(loose)) delete loose[k];
      s[key] = entry;
    });
    ctx.storeConverted = true;
    return [];
  }
  // 같은 유튜브 채널을 이름 둘로 등록했던 옛 채널도 둘 다 남긴다 — 합치면 살아 있는 로그인을 지울 수 있다
  return await putEntry(key, entry, { merge: false });
}

/** 새 tokens.json 이 옛 단일 꼴인데 옮길 항목이 없다 — 사본만 만들고 빈 새 꼴로 바꾼다 */
async function resetSingleStore(ctx: Ctx): Promise<void> {
  if (!ctx.newIsSingle || ctx.storeConverted) return;
  if (ctx.write) {
    const copy = await backupFile(storeFile());
    ctx.rep.notes.push(`옛 단일 로그인 정보(tokens.json)를 ${baseName(copy)} 로 백업하고 비웠습니다 — 짝이 되는 채널 설정이 없어 옮기지 못했습니다`);
    await updateStore((s) => { for (const k of Object.keys(s)) delete (s as unknown as Obj)[k]; });
  }
  ctx.storeConverted = true;
}

interface TokenResult {
  /** 이 채널이 가진 유튜브 채널 id (토큰 파일에서) — 없으면 "" */
  cid: string;
  /** 새 tokens.json 에 자리 잡았다(이번에 넣었거나 이미 같은 것이 있다) */
  moved: boolean;
  /** 옛 판에서 쓸 수 있던 로그인 정보였나 (그랬다면 새 앱에도 온전히 있어야 한다) */
  tok: PlanItem["tok"];
}

/** 로그인 정보 하나를 새 tokens.json 으로. (필드 변환: scope → scopes · channel.id → channel_id · 채널 전용 열쇠 파일) */
async function moveToken(
  ctx: Ctx, name: string, tok: Obj | null, creds: { clientId: string; clientSecret: string }, addedAt: string, unreadable = false,
): Promise<TokenResult> {
  const rep = ctx.rep;
  const ch = isObj(tok?.channel) ? tok!.channel as Obj : {};
  const cid = str(ch.id);
  const none = (why: string): TokenResult => {
    rep.skipped.push(`[${name}] 로그인 정보 — ${why}`);
    rep.needLogin.push(name);
    return { cid, moved: false, tok: null };
  };
  if (!tok) return none(unreadable ? "로그인 정보 파일을 읽을 수 없습니다(깨졌거나 JSON 이 아닙니다 — 옛 파일은 그대로 두었습니다). 채널 탭에서 다시 연결해 주세요" : "로그인 정보 파일이 없습니다. 채널 탭에서 다시 연결해 주세요");
  const rt = str(tok.refresh_token);
  if (!rt) return none("로그인 정보에 갱신 토큰이 없습니다. 채널 탭에서 다시 연결해 주세요");
  if (!creds.clientId) return none("옛 설정에 구글 열쇠(clientId)가 없어 토큰을 갱신할 수 없습니다. 채널 탭에서 다시 연결해 주세요");

  const scopes = str(tok.scope).split(/\s+/).filter(Boolean);
  const want: NonNullable<PlanItem["tok"]> = { rt, clientId: creds.clientId, clientSecret: creds.clientSecret, scopes: scopes.length ? scopes : [...SCOPES_LEGACY] };

  // 이미 같은 별칭이 있나 — 같은 토큰이면 이전 실행이 해 둔 것이고, 다른 로그인이면 건드리지 않는다(이름을 정할 때 이미 비켜 갔으니 보통은 오지 않는다)
  const cur = (loadStore() as unknown as Record<string, unknown>)[name];
  if (isObj(cur) && typeof cur.refresh_token === "string" && !(ctx.newIsSingle && !ctx.storeConverted)) {
    if (cur.refresh_token === rt) return { cid, moved: true, tok: want };
    rep.skipped.push(`[${name}] 로그인 정보 — 새 앱에 같은 이름으로 이미 다른 로그인이 있어 건드리지 않았습니다`);
    return { cid, moved: false, tok: want };
  }

  const file = await placeKeyFile(ctx, name, creds);
  const entry: TokenEntry = {
    channel_id: cid,
    title: str(ch.title) || name,
    refresh_token: rt,
    added: addedAt,
    scopes: want.scopes,
    how: "browser",
    secret: file,
  };
  if (ctx.write) await putToken(ctx, name, entry);
  return { cid, moved: true, tok: want };
}

/** channels.json 에 칸을 더한다. 같은 이름이 있으면 건드리지 않는다. 폴더가 다른 채널과 겹치면 폴더만 비운다. (순수 — 시험 이행도 같은 함수로 센다) */
function addChannelTo(d: Record<string, any>, name: string, conf: ChannelConf): { result: "added" | "exists"; overlap: string } {
  if (Object.hasOwn(d, name)) return { result: "exists", overlap: "" };
  let overlap = "";
  if (conf.folder) {
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith("_") || !v || typeof v !== "object") continue;
      const f = (v as ChannelConf).folder;
      if (typeof f === "string" && f && sameFolder(f, conf.folder)) { overlap = k; break; }
    }
    if (overlap) { conf.old_folder = conf.folder; conf.folder = ""; }
  }
  d[name] = conf;
  return { result: "added", overlap };
}

/** 새 채널 이름 — 비었거나 「_」로 시작하면(새 앱은 그런 칸을 설명 메모로 읽는다) 다듬고, 겹치거나 `fits` 가 거절하면 (2) 를 붙인다 */
function pickName(raw: string, used: Set<string>, fits: (n: string) => boolean): string {
  let base = raw.trim().replace(/^_+/, "").trim();
  if (!base || ["__proto__", "constructor", "prototype"].includes(base)) base = "채널";
  let n = base;
  for (let i = 2; used.has(n) || !fits(n); i++) n = `${base} (${i})`;
  used.add(n);
  return n;
}

const chanOf = (tok: Obj | null): Obj => (isObj(tok?.channel) ? tok!.channel as Obj : {});

async function work(ctx: Ctx): Promise<void> {
  const { rep, say } = ctx;
  const sim = ctx.write ? null : structuredClone(loadChannelsRaw()) as Record<string, any>;
  const used = new Set<string>();
  const nameById = new Map<string, string>();
  const policyHas = (cid: string) => loadPolicies().some((p) => p.cfg.channel_id === cid);
  const channelsNow = () => (ctx.write ? loadChannelsRaw() : sim!) as Record<string, any>;

  /**
   * 이 이름을 써도 되나 — 새 앱에 같은 이름의 칸이 이미 있는데 **다른 유튜브 채널**이면 안 된다(그 칸을 건드리지도, 옛 채널을 버리지도 않고 이름만 비켜 간다).
   * 같은 채널이거나(이전 실행이 만든 칸) 둘 다 채널을 모르면 같은 칸으로 본다. 이름으로 다른 로그인이 이미 있어도 비켜 간다.
   * 같은 자료로 몇 번을 돌려도 같은 이름이 나온다(이전 실행이 만든 칸을 알아본다).
   */
  const fits = (n: string, cid: string, rt: string): boolean => {
    const have = channelsNow()[n];
    if (isObj(have) && str(have.channel_id) !== cid) return false;
    const t = (loadStore() as unknown as Record<string, unknown>)[n];
    if (rt && isObj(t) && typeof t.refresh_token === "string" && t.refresh_token !== rt) return false;
    return true;
  };

  /* ── 옛 단일 토큰 (있으면 「내 채널」로) ─────────────────────────────
     짝이 되는 클라이언트는 평평한 옛 설정의 clientId/clientSecret 이다. 이것을 먼저 처리한다 —
     새 tokens.json 과 이름이 같은 파일이라, 다른 항목을 넣기 전에 새 꼴로 바꿔 두어야 섞이지 않는다. */
  let single: TokenResult | null = null;
  let singleName = "내 채널";
  if (ctx.singleTok) {
    const flatChan = ctx.chans.find((x) => x.flat);
    const creds = { clientId: str(ctx.cfg.clientId), clientSecret: str(ctx.cfg.clientSecret) };
    const sc = str(chanOf(ctx.singleTok).id), srt = str(ctx.singleTok.refresh_token);
    singleName = pickName("내 채널", used, (n) => fits(n, sc, srt));
    const at = parseWall(str(ctx.singleTok.added) || "") ?? wallNow();
    single = await moveToken(ctx, singleName, ctx.singleTok, creds, isoWall(at));
    if (!single.moved) await resetSingleStore(ctx);
    else if (!flatChan) rep.notes.push("옛 단일 로그인 정보를 「내 채널」 이름으로 옮겼습니다 (짝이 되는 채널 설정은 없어 채널 칸은 만들지 않았습니다)");
    if (single.moved) rep.tokens++;
    if (!flatChan) ctx.plan.push({ name: singleName, oldName: "내 채널", slot: false, cid: single.cid, folder: "", tok: single.tok });
  } else if (ctx.newIsSingle) {
    await resetSingleStore(ctx);
  }

  /* ── 채널 하나씩 ─────────────────────────────────────────────── */
  for (const c of ctx.chans) {
    const raw = c.raw;

    // 옛 로그인 정보부터 읽는다 — 새 앱에서의 이름을 정하려면 어느 유튜브 채널인지 알아야 한다
    let tok: Obj | null = null, unreadable = false;
    if (!c.flat && /^[\w.-]+$/.test(c.oldId)) {
      const r = await readOldJson(join(ctx.dir, "tokens", `${c.oldId}.json`));
      if (r.ok && isObj(r.value)) tok = r.value;
      else if (!r.ok && !r.missing) unreadable = true;
    }
    const src = c.flat ? ctx.singleTok : tok;
    const oldCid = str(chanOf(src).id), oldRt = str(src?.refresh_token);
    const name = c.flat && ctx.singleTok ? singleName : pickName(c.name, used, (n) => fits(n, oldCid, oldRt));
    nameById.set(c.oldId || "(평평한 설정)", name);
    say(`채널 「${name}」 옮기는 중…`);
    const 바탕 = c.name.trim().replace(/^_+/, "").trim() || "채널";
    if (name !== 바탕) rep.notes.push(`[${name}] 옛 이름 「${c.name}」 과 겹치는 이름이 이미 있어(옛 채널끼리이거나 새 앱의 다른 채널) 이름에 번호를 붙였습니다`);
    await 여기서(`채널시작:${name}`);

    // (1) 로그인 정보
    let tr: TokenResult;
    if (c.flat) {
      tr = single ?? { cid: "", moved: false, tok: null };
      if (!ctx.singleTok) { rep.skipped.push(`[${name}] 로그인 정보 — 옛 단일 tokens.json 이 없습니다. 채널 탭에서 다시 연결해 주세요`); rep.needLogin.push(name); }
    } else {
      const at = parseWall(str(raw.createdAt)) ?? wallNow();
      tr = await moveToken(ctx, name, tok, credsFor(c, ctx.chans), isoWall(at), unreadable);
      if (tr.moved) rep.tokens++;
    }
    await 여기서(`로그인끝:${name}`);

    if (tr.moved && !tr.cid) rep.notes.push(`[${name}] 옛 로그인 정보에 유튜브 채널 ID 가 없어 비워 두었습니다 — 처음 쓸 때 채워집니다`);

    // (2) 채널 칸
    let folder = str(raw.folder);
    let folderMissing = false;
    if (folder && !(await isDir(folder))) { folderMissing = true; }
    const conf = mapChannel(raw, tr.cid, folderMissing ? "" : folder);
    if (folderMissing) {
      // 없는 폴더를 그대로 두면 새 앱이 「폴더를 찾을 수 없다」는 치명적 문제로 모든 채널의 실행을 막는다 — 비워 두고 옛 자리만 적어 둔다
      conf.old_folder = folder;
      rep.warnings.push(`[${name}] 옛 폴더가 지금 없습니다 — 만들지 않았고 채널의 폴더는 비워 두었습니다. 채널 탭에서 폴더를 지정해 주세요. (옛 자리: ${folder})`);
    }
    if (!folder) rep.warnings.push(`[${name}] 옛 설정에 폴더가 없습니다 — 채널 탭에서 폴더를 지정해 주세요`);
    let added: { result: "added" | "exists"; overlap: string };
    if (ctx.write) added = await editChannels((d) => addChannelTo(d, name, conf));
    else added = addChannelTo(sim!, name, conf);
    if (added.result === "exists") {
      rep.skipped.push(`[${name}] 채널 칸 — 이미 있어(이전에 옮겼거나 같은 채널) 건드리지 않았습니다`);
    } else {
      rep.channels++;
      rep.channelNames.push(name);
      if (added.overlap) rep.warnings.push(`[${name}] 폴더가 [${added.overlap}] 와 겹쳐 폴더를 비워 두었습니다(옛 자리는 채널 설정의 old_folder 에 적어 두었습니다). 채널 탭에서 다시 지정해 주세요`);
      rep.folders.push(await surveyFolder(name, conf.folder));
    }
    await 여기서(`채널칸끝:${name}`);
    ctx.plan.push({ name, oldName: c.name, slot: true, cid: tr.cid, folder, tok: tr.tok });

    // (3) 일 한도 정책 — 옛 dailyLimit 은 「하루 업로드 편수」였다
    const limit = Math.trunc(num(raw.dailyLimit, 0));
    if (limit > 0) {
      if (!tr.cid) {
        rep.warnings.push(`[${name}] 하루 ${limit}편 한도 — 유튜브 채널 ID 를 아직 몰라 정책 파일을 만들지 못했습니다. 연결한 뒤 채널 탭의 「일 한도 설정」에서 ${limit}편으로 지정해 주세요`);
      } else if (policyHas(tr.cid)) {
        rep.skipped.push(`[${name}] 일 한도 정책 — 이 채널의 정책 파일이 이미 있어 건드리지 않았습니다`);
      } else {
        if (ctx.write) await writePolicy({ channel_id: tr.cid, label: name, aliases: [name], daily_limit: limit, cap_uploads: true });
        rep.policies++;
        rep.notes.push(`[${name}] 하루 업로드 ${limit}편 한도를 일 한도 정책으로 만들었습니다 (기본 규칙: 07시 시작 · 공개 간격 2시간)`);
      }
    }

    // (4) 버리는 것과 참고
    rep.dropped.push(...droppedFor(name, raw));
    if (raw.enabled === false) rep.notes.push(`[${name}] 옛 앱에서 감시를 꺼 둔 채널이었습니다 — 새 앱에는 켜고 끄는 칸이 없어 그대로 옮겼습니다`);
    const after = str(raw.afterUpload);
    if (after === "delete") rep.notes.push(`[${name}] 「올린 뒤 삭제」였던 설정은 「휴지통으로」로 바꿨습니다 (새 앱은 영상을 지우지 않습니다)`);
  }

  // 같은 유튜브 채널을 이름 둘 이상으로 등록했던 경우 — 둘 다 그대로 두었다고 알린다
  const byCid = new Map<string, string[]>();
  for (const p of ctx.plan) if (p.cid) byCid.set(p.cid, [...(byCid.get(p.cid) ?? []), p.name]);
  for (const names of byCid.values()) {
    if (names.length > 1) rep.warnings.push(`[${names.join("] · [")}] 는 같은 유튜브 채널입니다 — 이름마다 로그인 정보를 그대로 두었습니다(합치지 않음)`);
  }

  /* ── 올린 기록 → 원장 ─────────────────────────────────────────── */
  await 여기서("원장시작");
  await moveLedger(ctx, nameById);
  await 여기서("원장끝");

  /* ── 앱 설정 ─────────────────────────────────────────────────── */
  await moveSettings(ctx);
  await 여기서("설정끝");

  /* ── 옛 앱이 만든 폴더들(모든채널 …)은 건드리지 않는다 — 영상 수만 센다 ─── */
  const oldBase = str(ctx.cfg.baseDir);
  if (oldBase) {
    const bc = join(oldBase, "모든채널");
    if (await isDir(bc)) {
      const f = await surveyFolder("모든채널", bc);
      rep.folders.push(f);
      if (f.waiting) rep.warnings.push(`옛 「모든채널」 폴더에 기다리는 영상 ${f.waiting}편이 있습니다 — 새 앱은 이 폴더를 쓰지 않습니다. 보낼 채널의 폴더로 옮겨 주세요 (${bc})`);
    }
  }
  await 여기서("옮기기끝");
}

/** state.json 의 uploads 한 건 = 원장 한 줄. 영상 id 가 이미 원장에 있으면 건너뛴다. 한 번의 쓰기로 통째로 더한다. */
async function moveLedger(ctx: Ctx, nameById: Map<string, string>): Promise<void> {
  const { rep } = ctx;
  const stRes = await readOldJson(join(ctx.dir, "state.json"));
  if (!stRes.ok || !isObj(stRes.value)) {
    if (!stRes.missing) rep.warnings.push("state.json 을 읽지 못해 올린 기록은 옮기지 못했습니다 (파일은 그대로 두었습니다)");
    return;
  }
  const st = stRes.value;
  const ups = Array.isArray(st.uploads) ? st.uploads.filter(isObj) : [];
  ctx.oldUploadIds = [...new Set(ups.map((u) => str(u.id)).filter(Boolean))];

  // 새 앱에 같은 칸이 없어 옮기지 않는 기록들 — 있었던 만큼만 적는다
  const statsN = isObj(st.stats) ? Object.keys(st.stats).length : 0;
  const jobsN = Array.isArray(st.jobs) ? st.jobs.length : 0;
  if (jobsN) rep.dropped.push(`밀린 뒷일 ${jobsN}건(첫 댓글·제목 교체) — force-ssl 권한이 필요해 새 앱에서 지원하지 않아 옮기지 않았습니다`);
  if (statsN) rep.dropped.push(`영상별 성적 기록 ${statsN}건 — 새 앱이 유튜브에서 다시 읽으므로 옮기지 않았습니다`);
  if (ups.some((u) => str(u.hash))) rep.dropped.push("파일 지문(hash) — 새 원장에 칸이 없어 옮기지 않았습니다 (파일 이름·영상 ID 로 중복을 막습니다)");
  const keptN = isObj(st.kept) ? Object.keys(st.kept).length : 0;
  if (keptN) rep.dropped.push(`「그대로 두기」로 이미 올린 파일 표시 ${keptN}건 — 새 앱은 올린 기록의 파일 이름으로 같은 영상을 다시 올리지 않으므로 따로 옮기지 않았습니다`);
  const quotaN = isObj(st.quota) ? Object.keys(st.quota).length : 0;
  if (quotaN) rep.dropped.push("하루 사용량 기록(quota) — 옛 앱은 영상 1건을 1,600점으로 세어 실제와 달라서 옮기지 않았습니다. 오늘 올린 편수는 옮긴 올린 기록으로 셉니다");

  if (!ups.length) return;
  const raw = readLedgerRaw();
  const head = raw ? raw[0] : [...LEDGER_HEAD];
  const idCol = head.indexOf("영상ID");
  if (idCol < 0) {
    rep.warnings.push("원장(ledger.csv)의 머리글에 「영상ID」 칸이 없어 올린 기록을 옮기지 못했습니다 (원장은 건드리지 않았습니다)");
    return;
  }
  const have = new Set<string>();
  for (const r of raw?.slice(1) ?? []) if (r[idCol]) have.add(r[idCol]);

  let badPublishAt = 0;
  const rows: { at: string; cells: string[] }[] = [];
  for (const u of ups) {
    const id = str(u.id);
    if (!id) { rep.skipped.push("올린 기록 한 건 — 영상 ID 가 없어 옮기지 않았습니다"); continue; }
    if (have.has(id)) { rep.ledgerSkipped++; continue; }
    have.add(id);
    const atRaw = str(u.at);
    const atW = atRaw ? parseWall(atRaw) : null;
    const at = atW ? isoWall(atW) : atRaw;
    const pubRaw = str(u.publishAt);
    const pubW = pubRaw ? parseWall(pubRaw) : null;
    // 원장을 읽는 쪽(일 한도 편성기)은 예약시각을 못 읽으면 멈춘다 — 읽을 수 있는 값만 쓴다. 시간대(Z)는 이 컴퓨터 시각으로 옮긴다.
    if (pubRaw && !pubW) badPublishAt++;
    const row: Record<string, string> = {
      "업로드시각": at,
      "채널": nameById.get(str(u.channelId)) ?? str(u.channelName),
      "영상ID": id,
      "제목": String(u.title ?? ""),
      "파일": String(u.file ?? ""),
      "공개설정": str(u.privacy),
      "예약시각": pubW ? minuteWall(pubW) : "",
    };
    rows.push({ at, cells: head.map((h) => row[h] ?? "") });
  }
  if (badPublishAt) rep.warnings.push(`예약 시각을 읽지 못한 올린 기록 ${badPublishAt}건은 예약시각을 비워 두었습니다`);
  // 오래된 것부터 (옛 목록은 최신이 맨 앞이다). 같은 시각은 원래 순서를 지킨다.
  rows.reverse();
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  rep.ledgerRows = rows.length;
  if (ctx.write && rows.length) {
    // 잠근 뒤 다시 읽는다 — 그 사이에 다른 곳이 한 줄 더했을 수 있다 (원장 잠금은 appendLedger·patchLedger·맞춤이 쓰는 것과 같다)
    await updateLedger((again) => ({ rows: [...(again ?? [head]), ...rows.map((r) => r.cells)], out: undefined }));
  }
}

/** 앱 설정 칸을 옮긴다. 새 앱에 이미 값이 있는 칸은 건드리지 않는다. 값은 보고에 적지 않는다. */
async function moveSettings(ctx: Ctx): Promise<void> {
  const { rep, cfg } = ctx;
  const have = readJsonSync<Record<string, unknown>>(dataPath("앱설정.json"), {});
  const patch: Partial<AppSettings> = {};
  const put = (key: keyof AppSettings & string, v: unknown) => {
    if (v === undefined || key in have) return;
    (patch as Record<string, unknown>)[key] = v;
    rep.settings.push(key);
  };
  const port = num(cfg.port, 0);
  if (port >= 1024 && port <= 65535) put("port", Math.trunc(port));
  if (typeof cfg.browser === "string" && cfg.browser) put("browser", cfg.browser);
  if (typeof cfg.notifications === "boolean") put("osNotify", cfg.notifications);
  for (const k of ["telegramAlerts", "autoStart", "autoStartAsked", "aiTitles"] as const) {
    if (typeof cfg[k] === "boolean") put(k, cfg[k]);
  }
  if (isObj(cfg.updateDeclines) && Object.keys(cfg.updateDeclines).length) put("updateDeclines", cfg.updateDeclines);
  if (typeof cfg.aiKey === "string" && cfg.aiKey) put("aiKey", cfg.aiKey);     // 값은 어디에도 적지 않는다
  if (typeof cfg.aiModel === "string" && cfg.aiModel) put("aiModel", cfg.aiModel);
  // 새 채널의 기본 폴더(baseDir): 옛 기본(바탕화면 업로드대기)은 쓰지 않는다 — 채널 폴더만 옮겼다. 쓴 사람이 직접 고른 자리만 가져온다.
  const oldBase = str(cfg.baseDir);
  if (oldBase) {
    if (await isOldDefaultBaseDir(oldBase)) rep.notes.push(`옛 새 채널 기본 폴더(${oldBase})는 새 앱의 기본 자리로 바꾸지 않고 그대로 두었습니다 — 채널 폴더만 옮겼습니다`);
    else put("baseDir", oldBase);
  }
  if (cfg.autoStart === true) rep.notes.push("옛 판에서 자동 시작을 켜 두었습니다 — 새 방식(작업 둘)으로 다시 등록해야 합니다 (설정의 자동 시작을 한 번 켜 주세요)");
  if (num(cfg.pollSeconds, 5) !== 5 || num(cfg.stableChecks, 3) !== 3) {
    rep.dropped.push("폴더 감시 주기(pollSeconds · stableChecks) — 새 앱은 폴더를 계속 지켜보지 않아 옮기지 않았습니다");
  }
  if (ctx.write && Object.keys(patch).length) await saveAppSettings(patch);
}

/* ============================================================ 옮긴 뒤 확인 */

const sameList = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

/**
 * 옮긴 결과를 **옛 판 자료와 하나씩** 견준다. 새 앱 파일은 읽기만 하고, 열쇠·토큰은 견주기만 할 뿐 어디에도 쓰지 않는다.
 *  ① 옛 채널마다 새 앱에 칸이 있나(옛 채널 수 = 새 채널 수) · 유튜브 채널 ID 가 같나 · 폴더가 그대로 이어졌나
 *  ② 옛 판에서 쓸 수 있던 로그인 정보는 새 tokens.json 에 갱신 토큰·권한이 그대로 있고, 그 토큰을 받은 **구글 열쇠(전용 열쇠 파일)가 같은 열쇠**인가
 *     (다른 열쇠로 갱신하면 옛 토큰이 죽는다 — 그래서 열쇠까지 견준다)
 *  ③ 옛 올린 기록(예약 포함)이 새 원장에 영상 ID 로 모두 있나
 * 옛 판에서도 로그인이 없었거나 갱신할 수 없던 채널(열쇠 없음 · 토큰 없음 · 파일 깨짐)은 「빠진 것」이 아니다 — 원래 없던 것이라
 * 보고의 「다시 연결해야 하는 채널」에 이미 올라 있다.
 */
async function verifyMigration(ctx: Ctx): Promise<VerifyReport> {
  const miss: string[] = [];
  const chans = loadChannelsRaw();
  const store = loadStore() as unknown as Record<string, unknown>;
  const slotsNow = Object.entries(chans).filter(([k, v]) => !k.startsWith("_") && isObj(v)).length;
  const slotPlans = ctx.plan.filter((p) => p.slot);
  let newChannels = 0, tokensOld = 0, tokensNew = 0;
  for (const p of ctx.plan) {
    if (p.slot) {
      const cf = chans[p.name];
      if (!isObj(cf)) {
        miss.push(`[${p.name}] 채널 칸이 새 앱에 없습니다`);
      } else {
        let good = true;
        if (p.cid && str(cf.channel_id) !== p.cid) { miss.push(`[${p.name}] 유튜브 채널 ID 가 옛 판과 다릅니다`); good = false; }
        if (p.folder) {
          const now = str(cf.folder), kept = str(cf.old_folder);
          if (!(now && sameFolder(now, p.folder)) && !(kept && sameFolder(kept, p.folder))) { miss.push(`[${p.name}] 폴더 설정이 옛 판과 이어지지 않습니다`); good = false; }
        }
        if (good) newChannels++;
      }
    }
    if (p.tok) {
      tokensOld++;
      const e = store[p.name];
      let good = isObj(e) && e.refresh_token === p.tok.rt && str(e.channel_id) === p.cid && sameList(e.scopes, p.tok.scopes);
      if (good && isObj(e)) {
        const file = str(e.secret);
        const k = file ? await readKeyLoose(dataPath(file)) : null;
        good = !!k && k.id === p.tok.clientId && k.secret === p.tok.clientSecret;
      }
      if (good) tokensNew++;
      else miss.push(`[${p.name}] 로그인 정보가 새 앱에 온전히 옮겨지지 않았습니다 (갱신 토큰 · 권한 · 받은 구글 열쇠 중 하나가 다릅니다)`);
    }
  }
  if (slotsNow < slotPlans.length) miss.push(`새 앱의 채널 칸(${slotsNow}개)이 옛 채널 수(${slotPlans.length}개)보다 적습니다`);

  // 올린 기록 — 영상 ID 로
  let ledgerNew = 0;
  if (ctx.oldUploadIds.length) {
    const raw = readLedgerRaw();
    const idCol = raw ? raw[0].indexOf("영상ID") : -1;
    const have = new Set<string>();
    if (raw && idCol >= 0) for (const r of raw.slice(1)) if (r[idCol]) have.add(r[idCol]);
    ledgerNew = ctx.oldUploadIds.filter((id) => have.has(id)).length;
    if (ledgerNew < ctx.oldUploadIds.length) miss.push(`옛 올린 기록 ${ctx.oldUploadIds.length - ledgerNew}건이 새 원장에 없습니다`);
  }
  return {
    ok: miss.length === 0,
    oldChannels: slotPlans.length, newChannels, totalChannels: slotsNow,
    tokensOld, tokensNew, ledgerOld: ctx.oldUploadIds.length, ledgerNew, missing: miss,
  };
}

/* ============================================================ 공개 함수 */

/** 이행할 옛 자료가 있나. 파일을 읽기만 한다. */
export async function detectOld(): Promise<OldState> {
  const dir = oldDir();
  const configFound = await isFile(join(dir, "config.json"));
  const stateFound = await isFile(join(dir, "state.json"));
  const done = await isFile(recordFile());
  const singleToken = (await readSingleToken(join(dir, "tokens.json"))) !== null;
  const needed = !done && (configFound || singleToken);
  let tokenFiles = 0;
  try {
    for await (const e of Deno.readDir(join(dir, "tokens"))) if (e.isFile && e.name.endsWith(".json")) tokenFiles++;
  } catch { /* 폴더가 없으면 0 */ }
  let channels = 0, uploads = 0;
  if (needed && configFound) {
    const c = await readOldJson(join(dir, "config.json"));
    if (c.ok && isObj(c.value)) channels = oldChannels(c.value).length;
  }
  if (needed && stateFound) {
    const s = await readOldJson(join(dir, "state.json"));
    if (s.ok && isObj(s.value) && Array.isArray(s.value.uploads)) uploads = s.value.uploads.length;
  }
  return { dir, done, needed, configFound, stateFound, channels, tokenFiles, singleToken, uploads };
}

async function alreadyReport(rep: MigrationReport): Promise<MigrationReport> {
  const prev = readJsonSync<Record<string, unknown>>(recordFile(), {});
  const old = isObj(prev.report) ? prev.report : {};
  // 이행기록이 있으면 끝난 일이다 — 멈춤 표시가 남아 있으면(기록과 멈춤 풀기 사이에 꺼졌을 때) 풀어 준다. 시험 이행은 아무것도 쓰지 않는다.
  if (!rep.dryRun) { try { await resolveHold("verified"); } catch { /* 풀지 못해도 보고는 한다 */ } }
  return { ...rep, ...(old as Partial<MigrationReport>), dryRun: rep.dryRun, ran: false, already: true, ok: true, held: false };
}

/**
 * 옛 판의 자료를 새 모양으로 옮긴다. 한 번만 돈다(멱등) — 끝까지 가고 **확인이 통과해야** `이행기록.json` 을 남긴다.
 *  · dryRun: 아무것도 쓰지 않고 「이대로 옮기면 이렇게 된다」만 센다.
 *  · 던지지 않는다 — 문제는 report.ok=false 와 report.errors 로 돌려주고 이행기록을 쓰지 않는다(다음 실행에서 이어서 한다).
 *  · 끝까지 못 갔거나 확인에서 빠진 것이 나오면 이행 보류(hold.ts)를 걸어 새 판이 올리기·공개를 멈춘다. 옛 자료는 그대로 살아 있다.
 *  · say: 진행 한 줄씩 (기본: 기록/서버.log). 열쇠·토큰 값은 한 줄도 안 나온다.
 */
export async function migrate(opts: { dryRun?: boolean; say?: (line: string) => void } = {}): Promise<MigrationReport> {
  const dry = !!opts.dryRun;
  // 시험 이행은 아무것도 쓰지 않는다고 했으니 기록 파일에도 안 적는다(콘솔에만)
  const say = opts.say ?? (dry ? (l: string) => console.log(l) : (l: string) => { void log(l); });
  const rep = emptyReport(dry);
  try {
    const st = await detectOld();
    rep.oldDir = st.dir;
    if (st.done) return await alreadyReport(rep);
    if (!st.needed) {
      // 옮길 옛 자료가 더는 없다(사람이 치웠다) — 확인할 것이 없으니 남은 멈춤 표시는 풀어 준다
      if (!dry && migrationHold()) { await resolveHold("accepted"); rep.notes.push("옛 자료가 더는 없어 이행 보류를 풀었습니다"); }
      return rep;
    }

    if (dry) {
      rep.ran = true;
      const ctx = await prepare(rep, true, say);
      if (ctx) await work(ctx);
      return rep;
    }
    // 화면 서버와 명령줄이 동시에 부를 수 있다 — 한 줄로 세우고, 잠근 뒤 기록을 다시 본다
    const got = await withFileLock(dataPath("이행.lock"), async () => {
      if (await isFile(recordFile())) return "already" as const;
      await realRun(rep, say);
      return "done" as const;
    });
    if (got === "already") return await alreadyReport(rep);
  } catch (e) {
    rep.ok = false;
    rep.errors.push(`이행 중 오류 — ${errText(e)}`);
    await log(`⚠️  옛 판 자료 이행 중 오류 — ${errText(e)}`);
  }
  return rep;
}

/** 진짜 이행: 읽기 → 복사본 → 옮기기 → 확인 → (통과) 멈춤 풀기 + 기록 / (실패) 멈춤 걸기 */
async function realRun(rep: MigrationReport, say: (line: string) => void): Promise<void> {
  rep.ran = true;
  try {
    let ctx = await prepare(rep, false, say);          // 아무것도 쓰지 않는다 — 옛 설정이 깨졌으면 여기서 멈춘다
    if (ctx) {
      say("옛 자료를 복사해 두는 중…");
      try {
        const b = await backupAll();
        rep.backupDir = b.dir; rep.backupFiles = b.files; rep.backupReused = b.reused;
        say(`옛 자료 복사본: ${b.dir}${b.reused ? " (같은 자료의 복사본이 이미 있어 그것을 씁니다)" : ""}`);
      } catch (e) {
        rep.ok = false;
        rep.errors.push(`옮기기 전에 옛 자료를 복사해 두지 못해 아무것도 옮기지 않았습니다 — ${errText(e)}`);
        ctx = null;
      }
    }
    if (ctx) {
      await 여기서("복사끝");
      say("옛 판 자료를 새 판으로 옮기는 중…");
      await work(ctx);
      if (!ctx.chans.length && !ctx.singleTok) rep.warnings.push("옛 설정에 채널이 하나도 없어 옮길 채널이 없었습니다");
      rep.verify = await verifyMigration(ctx);        // 옮긴 뒤 옛 판 자료와 하나씩 견준다
      if (!rep.verify.ok) {
        rep.ok = false;
        rep.errors.push(`옮긴 뒤 확인에서 빠진 것이 ${rep.verify.missing.length}건 나왔습니다 — 새 판은 올리기·공개를 멈춰 두었습니다. 옛 자료는 그대로입니다`);
      }
      await 여기서("기록직전");
    }
  } catch (e) {
    rep.ok = false;
    rep.errors.push(`이행 중 오류 — ${errText(e)}`);
    await log(`⚠️  옛 판 자료 이행 중 오류 — ${errText(e)}`);
  }

  if (rep.ok) {
    // 멈춤을 먼저 풀고 기록을 남긴다 — 그 사이에 꺼지면 다음에 켤 때 처음부터 다시 돌아 기록을 남긴다(반대 순서면 멈춤이 영영 안 풀린다)
    await resolveHold("verified");
    await writeJson(recordFile(), {
      schema: 1, 일시: rep.at, 앱버전: APP_VERSION, 옛자료: rep.oldDir, 복사본: rep.backupDir,
      설명: "옛 판(v1.x)의 자료를 새 판으로 옮기고, 옛 채널 · 로그인 정보 · 올린 기록이 새 판에 빠짐없이 있는지 확인한 기록입니다. 옛 파일은 지우지 않고 그대로 두었습니다. 열쇠·토큰 값은 적지 않습니다.",
      report: rep,
    });
  } else {
    rep.held = true;
    try {
      await setHold({
        backupDir: rep.backupDir, oldDir: rep.oldDir, reasons: rep.errors.slice(0, 6), missing: (rep.verify?.missing ?? []).slice(0, 40),
        oldChannels: rep.verify?.oldChannels ?? 0, newChannels: rep.verify?.newChannels ?? 0,
      });
    } catch (e) {
      await log(`⚠️  이행 보류 표시를 남기지 못했습니다 — ${errText(e)}`);
    }
  }
}

/** 옛 자료를 읽어 이행에 쓸 묶음을 만든다. 아무것도 쓰지 않는다. config.json 을 못 읽으면 null (까닭은 보고에) */
async function prepare(rep: MigrationReport, dry: boolean, say: (line: string) => void): Promise<Ctx | null> {
  const dir = oldDir();
  const cfgRes = await readOldJson(join(dir, "config.json"));
  if (!cfgRes.ok && !cfgRes.missing) {
    rep.ok = false;
    rep.errors.push("config.json 을 JSON 으로 읽을 수 없어 이행을 멈췄습니다 (파일은 그대로 두었습니다). 고친 뒤 다시 켜면 이어서 합니다");
    return null;
  }
  const cfg: Obj = isObj(cfgRes.value) ? cfgRes.value : {};
  const chans = oldChannels(cfg);

  // 옛 단일 토큰은 옛 폴더의 tokens.json. 새 앱의 tokens.json 도 같은 꼴이면 (같은 폴더일 때 같은 파일) 새 꼴로 바꿔야 한다.
  const singleTok = await readSingleToken(join(dir, "tokens.json"));
  const sameStore = join(dir, "tokens.json") === storeFile();
  const newIsSingle = sameStore ? singleTok !== null : (await readSingleToken(storeFile())) !== null;

  const ctx: Ctx = {
    rep, write: !dry, say, dir, cfg, chans, singleTok, newIsSingle, storeConverted: false, keyPlan: new Map(), plan: [], oldUploadIds: [],
  };
  if (dry) say("옛 판 자료 이행 시험(아무것도 쓰지 않음)…");
  return ctx;
}

/**
 * 켤 때마다(화면 서버 · 심사확인 · 명령줄) 먼저 부른다 — 옮길 옛 자료가 있으면 옮기고 확인까지 마친다.
 * 이미 끝났거나 옮길 것이 없으면(멈춤 표시도 없으면) 아무것도 하지 않고 null.
 * 끝까지 못 가거나 확인에서 빠진 것이 나오면 보고(ok=false)를 돌려주고, 새 판은 올리기·공개를 멈춘 채로 켜진다(hold.ts).
 */
export async function ensureMigrated(say?: (line: string) => void): Promise<MigrationReport | null> {
  const st = await detectOld();
  if (!st.needed && !migrationHold()) return null;
  const r = await migrate({ say });
  if (r.already || !r.ran && !r.notes.length && !r.errors.length) return null;
  return r;
}

/**
 * 사람이 「빠진 것이 있는 채로 새 판을 쓰겠다」고 받아들인다 — 멈춤을 풀고 이행기록을 남긴다(다시 옮기려 하지 않는다).
 * 화면의 확인 창을 거쳐서만 부른다(routes 의 migrate/accept 가 confirm 을 요구한다). 옛 파일과 복사본은 그대로 남는다.
 */
export async function acceptMigration(): Promise<{ ok: boolean; message: string }> {
  const h = migrationHold();
  if (!h) return { ok: false, message: "멈춰 있는 이행이 없습니다" };
  await resolveHold("accepted");
  await writeJson(recordFile(), {
    schema: 1, 일시: isoWall(wallNow()), 앱버전: APP_VERSION, 옛자료: h.oldDir, 복사본: h.backupDir, 사람이받아들임: true, 빠진것: h.missing, 까닭: h.reasons,
    설명: "옛 판 자료를 옮긴 뒤 확인에서 빠진 것이 있었지만, 사람이 그대로 새 판을 쓰겠다고 받아들인 기록입니다. 옛 파일과 복사본은 지우지 않고 그대로 두었습니다.",
    report: { ...emptyReport(false), ok: true, ran: true, oldDir: h.oldDir, backupDir: h.backupDir, errors: h.reasons, warnings: h.missing },
  });
  return { ok: true, message: `새 판을 그대로 쓰기로 했습니다. 옛 자료와 복사본(${h.backupDir || "없음"})은 지우지 않았습니다.` };
}

/** 사람이 읽는 보고 (화면·로그에 그대로). 열쇠·토큰 값은 들어 있지 않다. */
export function formatReport(r: MigrationReport): string[] {
  if (r.already) return ["옛 판의 자료는 이미 옮겨 두었습니다. (데이터 폴더의 이행기록.json 참고)"];
  if (!r.ran) return r.errors.length ? r.errors.map((e) => `⚠️ ${e}`) : ["옮길 옛 판 자료가 없습니다."];
  const L: string[] = [];
  L.push(
    r.dryRun ? "🔍 이행 시험 — 아무것도 쓰지 않았습니다. 이대로 옮기면 아래와 같이 됩니다."
      : r.ok ? "✅ 옛 판의 자료를 새 판으로 옮겼습니다."
      : "⚠️ 옛 판의 자료를 옮기다 멈췄습니다 — 다음에 켤 때 이어서 합니다.",
  );
  if (r.backupDir) L.push(`· 옛 자료 복사본: ${r.backupDir}${r.backupReused ? " (이미 떠 둔 같은 복사본)" : ""} — 파일 ${r.backupFiles}개`);
  L.push(`· 채널 ${r.channels}개${r.channelNames.length ? ` (${r.channelNames.join(", ")})` : ""}`);
  L.push(`· 로그인 정보 ${r.tokens}개`);
  if (r.needLogin.length) L.push(`  └ 다시 연결해야 하는 채널: ${r.needLogin.join(", ")}`);
  L.push(`· 올린 기록 ${r.ledgerRows}건${r.ledgerSkipped ? ` (이미 있던 ${r.ledgerSkipped}건은 건너뜀)` : ""}`);
  if (r.policies) L.push(`· 하루 한도 정책 ${r.policies}개`);
  if (r.settings.length) L.push(`· 앱 설정: ${r.settings.join(", ")}`);
  for (const f of r.folders) {
    L.push(f.exists
      ? `· 폴더 [${f.channel}] 기다리는 영상 ${f.waiting}편 — 옛 _완료 ${f.done} · _실패 ${f.failed} · _보류 ${f.held} (건드리지 않음)`
      : `· 폴더 [${f.channel}] ${f.folder ? "없음" : "지정 안 됨"}`);
  }
  const section = (title: string, items: string[]) => { if (items.length) { L.push(title); for (const x of items) L.push(`  - ${x}`); } };
  section("건너뛴 것", r.skipped);
  section("옮기지 않은 것 (새 앱에 같은 기능이 없음)", r.dropped);
  section("확인할 것", r.warnings);
  section("참고", r.notes);
  const v = r.verify;
  if (v) {
    L.push(`· 옮긴 뒤 확인: 채널 ${v.oldChannels} → ${v.newChannels} · 로그인 정보 ${v.tokensOld} → ${v.tokensNew} · 올린 기록 ${v.ledgerOld} → ${v.ledgerNew} — ${v.ok ? "빠진 것 없음" : `빠진 것 ${v.missing.length}건`}`);
    for (const m of v.missing) L.push(`  ✗ ${m}`);
  }
  section("오류", r.errors);
  if (r.held) L.push(`⛔ 새 판은 올리기·공개를 멈춰 두었습니다. 옛 자료와 복사본(${r.backupDir || "없음"})은 그대로입니다. 문제 목록의 「다시 옮기기」를 눌러 주세요.`);
  L.push("옛 파일(config.json · state.json · tokens/ · uploader.log)은 지우지 않고 그대로 두었습니다.");
  return L;
}

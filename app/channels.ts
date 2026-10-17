// 채널 ↔ 폴더 짝 · 폴더 표식 · 운영 방식. (파이썬 setup.py · binding.py · mode.py)
//
// channels.json 한 파일이 「어느 채널의 영상이 어느 폴더에 있나」를 정한다.
// 채널은 채널ID(channel_id)로 묶이므로 표시 이름을 바꿔도 연결이 풀리지 않는다.
import { baseName, dataPath, exists, expandHome, isDir, join, readJson, readJsonSync, writeJson, withFileLock } from "./paths.ts";
import { isoWall, wallNow } from "./clock.ts";
import { loadStore, updateStore } from "./ytcore.ts";

/** 채널 한 칸. 모르는 칸은 그대로 보존한다(사람이 손으로 적은 칸을 지우지 않게). */
export interface ChannelConf {
  channel_id: string;
  folder: string;
  /** 파일 이름 머리말 — 다른 고객 영상이 섞이는 것을 잡는다 */
  prefix?: string;
  /** 하루 공개 시각 후보 (HH:MM) */
  times?: string[];
  /** schedule = 예약 · now = 심사 뒤 즉시 */
  publish?: string;
  daily_rule?: string;
  daily?: number;
  daily_fallback?: number;
  rule?: { min_views: number; daily: number }[];
  /** order · oldest · suggest · manual */
  pick?: string;
  window?: [number, number];
  date?: string;
  title_prefix?: string;
  desc?: string;
  tags?: string[];
  approved_by?: string;
  allow_not_short?: boolean;
  롱폼?: boolean;
  audio_language?: string;
  회수제외?: boolean;
  /** 심사 통과 뒤 공개 범위: public(기본) · unlisted · private(자동 공개 안 함) */
  after_review?: string;
  /** 올린 뒤 원본: trash(휴지통) · move(업로드완료 폴더) · keep(그대로) — 없으면 자리에 따라 자동 */
  after_upload?: string;
  /** 썸네일 실패를 표식으로 남겨 10분마다 다시 시도 */
  thumb_watch?: boolean;
  /** 문안 규격(메타검사) */
  meta_rule?: MetaRule;
  /** 스튜디오를 여는 크롬 프로필 이름 등 (선택) */
  studio_profile?: string;
  /** 이 채널만 아동용 표시를 다르게 (없으면 policy.json 의 값) — 옛 앱 채널 옵션을 잃지 않으려는 칸 */
  made_for_kids?: boolean;
  /** 롱폼 하루 공개 칸 "09:15" 들 — 받기가 롱폼의 다음 칸을 셈할 때 쓴다 */
  long_slots?: string[];
  /** 한 번 켜면 7일 넘고 조회 N회 미만 영상을 비공개로 돌리는 회수를 이 채널에 건다 (기본 꺼짐) */
  회수?: boolean;
  /** 쿠팡 파트너스 자동 링크 — on 을 false 로 두면 이 채널만 끈다(기본: 전체 설정을 따른다), sub_id 는 수수료 집계용 채널 구분 코드(영문·숫자) */
  coupang?: { on?: boolean; sub_id?: string; mode?: "auto" | "rule" | "off" };
  /** AI 문안(제목·설명·해시태그 자동 짓기) — false 면 이 채널만 끈다(기본: 전체 설정을 따른다) */
  ai?: boolean;
  /** 자동으로 지은 설명 앞·뒤에 늘 붙일 글 (비우면 안 붙임) */
  desc_head?: string;
  desc_tail?: string;
  /** 자동으로 지은 해시태그 앞에 늘 넣을 해시태그 (# 없이) */
  fixed_tags?: string[];
  /** 말투 메모 — 비우면 이 채널의 지난 영상 제목·설명을 보고 AI 가 알아서 맞춘다 */
  tone?: string;
  [k: string]: unknown;
}
export type Channels = Record<string, ChannelConf>;

export interface MetaRule {
  /** 한글이 한 글자라도 있으면 막는다 (일본어·영어 채널) */
  forbid_hangul?: boolean;
  /** 해시태그 정확한 개수 */
  hashtags?: number;
  /** #shorts 금지 */
  forbid_shorts_tag?: boolean;
  /** 구독·좋아요·알림 유도 줄 금지 */
  forbid_cta?: boolean;
  desc_min?: number;
  desc_max?: number;
}

export const channelsPath = () => dataPath("channels.json");

/**
 * 채널 키(별칭 또는 채널ID)로 그 채널의 설정 칸을 찾는다. 못 찾으면 null.
 * 발사대기는 채널ID 를 쓰기도 하므로 둘 다 받는다. (파이썬 upload.채널설정)
 */
export function confFor(channel: string, chans: Channels = loadChannels()): ChannelConf | null {
  if (chans[channel]) return chans[channel];
  for (const v of Object.values(chans)) if (v.channel_id && v.channel_id === channel) return v;
  return null;
}

/** 이름이 _ 로 시작하는 칸(설명 메모)을 뺀 채널들 */
export function loadChannels(): Channels {
  const d = readJsonSync<Record<string, unknown>>(channelsPath(), {});
  const out: Channels = {};
  for (const [k, v] of Object.entries(d)) {
    if (!k.startsWith("_") && v && typeof v === "object") out[k] = v as ChannelConf;
  }
  return out;
}

export function loadChannelsRaw(): Record<string, unknown> {
  return readJsonSync<Record<string, unknown>>(channelsPath(), {});
}

/** 채널 파일을 잠그고 고친다 (화면 서버와 명령줄이 겹쳐 쓰지 않게). 반환: 고치기 함수의 값 */
export async function editChannels<T>(고치기: (d: Record<string, any>) => T | Promise<T>): Promise<T> {
  const r = await withFileLock(dataPath("channels.lock"), async () => {
    const d = await readJson<Record<string, any>>(channelsPath(), {});
    const out = await 고치기(d);
    await writeJson(channelsPath(), d);
    return out;
  });
  return r as T;
}

export async function saveChannels(d: Record<string, unknown>): Promise<void> {
  await writeJson(channelsPath(), d);
}

/**
 * 인증 직후 자리를 만들어 둔다. 폴더 경로만 채우면 바로 쓸 수 있다. (파이썬 auth.authorize 끝부분)
 *  · 같은 채널의 자리가 이미 있으면 아무것도 안 한다(false).
 *  · 이름만 만들어 둔 빈 자리(채널 탭의 「채널 추가」)에 그 이름으로 연결하면 그 자리에 채널 id 만 채운다 — 폴더·설정은 그대로.
 *    (통째로 새 자리로 덮으면 사용자가 이미 정한 폴더가 사라진다.)
 *  · 없으면 새로 만든다(true).
 */
export async function ensureChannelSlot(key: string, channelId: string): Promise<boolean> {
  return await editChannels((d) => {
    const have = Object.values(d).some((v) => v && typeof v === "object" && (v as ChannelConf).channel_id === channelId);
    if (have) return false;
    const cur = d[key];
    if (cur && typeof cur === "object") {
      if (!(cur as ChannelConf).channel_id) (cur as ChannelConf).channel_id = channelId;
      return false;
    }
    d[key] = {
      channel_id: channelId, folder: "", prefix: "", times: ["09:00"], publish: "schedule",
      daily_rule: "auto", daily_fallback: 1,
    };
    return true;
  });
}

/** 이름만 있는 빈 칸 하나 (화면의 「채널 추가」 — 인증은 나중에) */
export async function addChannelByName(name: string): Promise<void> {
  const nm = name.trim();
  if (!nm) throw new Error("이름이 비었습니다");
  await editChannels((d) => {
    if (nm in d) throw new Error("같은 이름이 이미 있습니다");
    d[nm] = { channel_id: "", folder: "", prefix: "", publish: "schedule", daily_rule: "views" };
  });
}

/** 표시 이름만 바꾼다. 채널 연결은 channel_id 로 되어 있어 풀리지 않는다. (setup.rename) */
export async function renameChannel(old: string, nu: string): Promise<void> {
  const to = nu.trim();
  if (!to) throw new Error("이름이 비었습니다");
  const cf = await editChannels((d) => {
    if (!(old in d)) throw new Error(`그런 채널이 없습니다: ${old}`);
    if (to in d) throw new Error(`이미 있는 이름입니다: ${to}`);
    // 차례를 지키며 키 이름만 바꾼다
    const nd: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) nd[k === old ? to : k] = v;
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, nd);
    return d[to] as ChannelConf;
  });
  await updateStore((s) => { if (old in s) { s[to] = s[old]; delete s[old]; } });
  if (cf?.folder) {
    const mk = await readMark(cf.folder);
    if (mk) await writeMark(cf.folder, String(mk.channel_id ?? ""), String(mk.channel_title ?? to), to);
  }
}

/**
 * 채널을 목록에서 뺀다. 영상 파일과 폴더는 절대 지우지 않는다 — 우리 쪽 기록(설정·토큰·채널정보)만 지운다.
 * 폴더의 채널 표식은 남겨 둔다(나중에 다시 붙일 때 짝을 확인할 수 있다).
 */
export async function removeChannel(alias: string): Promise<{ alias: string; folder: string; channelId: string }> {
  let cid = "", folder = "";
  const name = await editChannels((d) => {
    let key = alias;
    if (!(key in d)) {
      const cand = Object.keys(d).filter((k) => !k.startsWith("_") && k.includes(alias));
      if (cand.length === 1) key = cand[0];
      else if (cand.length) throw new Error(`여럿이 걸립니다: ${cand.join(", ")}`);
      else throw new Error(`그런 채널이 없습니다: ${alias}`);
    }
    cid = String((d[key] as ChannelConf).channel_id ?? "");
    folder = String((d[key] as ChannelConf).folder ?? "");
    delete d[key];
    return key;
  });
  await updateStore((s) => {
    for (const [k, v] of Object.entries(s)) if ((cid && v.channel_id === cid) || k === name) delete s[k];
  });
  try {
    const { removeProfile } = await import("./profile.ts");
    if (cid) await removeProfile(cid);
  } catch { /* 채널 정보가 없으면 그만이다 */ }
  return { alias: name, folder, channelId: cid };
}

/** 화면에서 끌어놓은 차례대로 channels.json 을 다시 쓴다. 순서를 따로 저장하지 않고 파일 자체의 차례를 바꾼다. */
export async function orderChannels(want: string[]): Promise<string[]> {
  return await editChannels((d) => {
    const 밑줄: Record<string, unknown> = {};
    const 채널: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d)) (k.startsWith("_") ? 밑줄 : 채널)[k] = v;
    const 모름 = want.filter((x) => !(x in 채널));
    if (모름.length) throw new Error(`모르는 채널입니다 — ${모름.slice(0, 3).join(", ")}`);
    const 새: Record<string, unknown> = { ...밑줄 };
    for (const k of want) 새[k] = 채널[k];
    for (const [k, v] of Object.entries(채널)) if (!(k in 새)) 새[k] = v; // 빠진 것이 있어도 잃지 않는다
    if (Object.keys(새).length !== Object.keys(d).length) throw new Error("채널 수가 맞지 않아 저장하지 않았습니다");
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, 새);
    return Object.keys(새).filter((k) => !k.startsWith("_"));
  });
}

/** 같은 channel_id 를 가진 칸 이름 전부 (한 채널을 두 이름으로 등록한 경우: 쇼츠용·롱폼용) */
export function sameChannelNames(name: string, chans: Channels = loadChannels()): Set<string> {
  const cid = chans[name]?.channel_id;
  const s = new Set<string>([name]);
  if (cid) for (const [n, v] of Object.entries(chans)) if (v.channel_id === cid) s.add(n);
  return s;
}

/** 이 칸이 롱폼 칸인가 (channels.json 의 allow_not_short / 롱폼 표시) */
export const isLongChannel = (cf: ChannelConf) => !!(cf.allow_not_short || cf.롱폼);

/* ============================================================ 폴더 표식 */
// 폴더 안에 .채널정보.json 을 남긴다. 그 안의 channel_id 가 설정과 다르면 멈춘다.
// 파일과 설정 양쪽이 같이 틀려야만 사고가 나므로, 실수 하나로는 뚫리지 않는다.
export const MARK = ".채널정보.json";

export async function readMark(folder: string): Promise<Record<string, unknown> | null> {
  const f = join(folder, MARK);
  if (!(await exists(f))) return null;
  try { return JSON.parse(await Deno.readTextFile(f)); } catch { return null; }
}

export async function writeMark(folder: string, channelId: string, title: string, alias: string): Promise<string> {
  await Deno.mkdir(folder, { recursive: true });
  const f = join(folder, MARK);
  await writeJson(f, {
    channel_id: channelId,
    channel_title: title,
    alias,
    bound_at: isoWall(wallNow()),
    _경고: "이 폴더는 위 채널 전용입니다. 다른 채널에 연결하거나 이 파일을 지우지 마세요.",
  });
  return f;
}

/** (치명적 문제, 경고) — 치명적 문제가 하나라도 있으면 실행하지 않는다. (binding.verify_all) */
export async function verifyAll(chans: Channels): Promise<{ fatal: string[]; warn: string[] }> {
  const fatal: string[] = [], warn: string[] = [];
  const seen = new Map<string, string>();
  for (const [alias, cf] of Object.entries(chans)) {
    const folder = expandHome(cf.folder ?? ""); // 사람이 손으로 적은 「~/영상」 도 읽는다
    const cid = cf.channel_id ?? "";
    if (!folder) { warn.push(`[${alias}] 폴더가 정해지지 않았습니다 — 채널 탭에서 지정하세요`); continue; }
    if (!(await isDir(folder))) { fatal.push(`[${alias}] 폴더를 찾을 수 없습니다: ${folder}`); continue; }
    let key = folder;
    try { key = await Deno.realPath(folder); } catch { /* 그대로 */ }
    if (seen.has(key)) { fatal.push(`[${alias}] 폴더가 [${seen.get(key)}] 와 겹칩니다: ${folder}`); continue; }
    seen.set(key, alias);
    const mk = await readMark(folder);
    if (mk === null) { warn.push(`[${alias}] 폴더에 채널 표식이 없습니다 — 채널 탭에서 「표식 새기기」를 누르세요`); continue; }
    if (cid && mk["channel_id"] !== cid) {
      fatal.push(
        `[${alias}] 폴더가 다른 채널 것입니다\n` +
          `        폴더 표식: ${mk["channel_title"] ?? "?"} (${mk["channel_id"]})\n` +
          `        설정      : ${cid}\n` +
          `        → 경로가 밀렸거나 설정이 뒤바뀌었습니다. 확인 전에는 올리지 마세요.`,
      );
    }
  }
  return { fatal, warn };
}

/** 폴더가 그 채널 표식과 맞나 (화면의 「결합 완료」 칩) */
export async function boundOk(cf: ChannelConf): Promise<boolean> {
  if (!cf.folder) return false;
  const mk = await readMark(expandHome(cf.folder));
  return !!mk && mk["channel_id"] === (cf.channel_id ?? "");
}

/** 폴더를 정한다 — 다른 채널이 이미 쓰는 폴더면 막고, 표식을 새긴다. (serve.py folder) */
export async function setFolder(alias: string, folderIn: string, title = ""): Promise<{ folder: string; n: number }> {
  const folder = expandHome(folderIn);
  if (!(await isDir(folder))) throw new Error("폴더가 아닙니다");
  const cf = await editChannels((d) => {
    const cur = d[alias] as ChannelConf | undefined;
    if (!cur) throw new Error(`모르는 채널입니다 — ${alias}`);
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith("_") || k === alias) continue;
      if ((v as ChannelConf).folder && sameFolder((v as ChannelConf).folder, folder)) throw new Error(`이미 ${k} 가 쓰는 폴더입니다`);
    }
    cur.folder = folder;
    return cur;
  });
  try { await writeMark(folder, cf.channel_id ?? "", title || alias, alias); } catch { /* 표식은 덤이다 */ }
  let n = 0;
  for await (const e of Deno.readDir(folder)) if (e.isFile && e.name.toLowerCase().endsWith(".mp4")) n++;
  return { folder, n };
}

export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** 토큰이 있는 채널 이름 → 채널ID 짝 */
export function connectedIds(): Set<string> {
  const s = new Set<string>();
  for (const v of Object.values(loadStore())) if (v.channel_id) s.add(v.channel_id);
  return s;
}

/* ============================================================ 운영 방식 (대행 / 소유주) */

export const MODE_AGENCY = "agency";
export const MODE_OWNER = "owner";
export const MODE_NAMES: Record<string, string> = { [MODE_AGENCY]: "대행 관리자", [MODE_OWNER]: "채널 소유주" };
export const MODE_DESC: Record<string, string> = {
  [MODE_AGENCY]: "고객사마다 채널 주인이 다릅니다",
  [MODE_OWNER]: "채널이 모두 내 계정 안에 있습니다",
};
const modePath = () => dataPath("운영방식.json");

/** 정해진 운영 방식. 아직 안 골랐으면 null. */
export function getMode(): string | null {
  const v = readJsonSync<{ mode?: string }>(modePath(), {}).mode;
  return v === MODE_AGENCY || v === MODE_OWNER ? v : null;
}
export async function setMode(m: string): Promise<void> {
  if (m !== MODE_AGENCY && m !== MODE_OWNER) throw new Error(`모르는 운영 방식: ${m}`);
  await writeJson(modePath(), { mode: m });
}
export async function clearMode(): Promise<void> { try { await Deno.remove(modePath()); } catch { /* 없으면 그만 */ } }
/** 안 골랐으면 대행 쪽 화면을 기본으로 본다 */
export const isAgency = () => getMode() !== MODE_OWNER;

export function modeWords(): Record<string, string> {
  return isAgency()
    ? { unit: "고객사", units: "고객사", add: "고객사 추가", roster: "고객사", who: "고객사별" }
    : { unit: "채널", units: "채널", add: "채널 추가", roster: "내 채널", who: "채널별" };
}
export function modeFeatures(): Record<string, boolean> {
  const a = isAgency();
  return {
    verify_binding: a, // 폴더가 그 고객사 것이 맞는지 매번 확인
    auth_per_channel: a, // 채널마다 따로 로그인
    client_report: a,
    isolation_note: a,
    account_risk_note: !a,
  };
}

export { baseName };

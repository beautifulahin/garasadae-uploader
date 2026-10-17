// 일 한도 편성기 — 채널마다 「하루 N편」을 날짜별로 지키고, 넘치는 분은 다음 날로 N편씩 밀어 편성한다.
// (파이썬: 일 한도 편성 모듈 둘을 정책 파일 하나로 일반화한 것)
//
// 왜 필요한가
//   한 채널에 하루에 몰아 올리거나 몰아 공개하면 스팸처럼 보인다. 그래서 채널마다 「하루 몇 편」을 정해 두고,
//   실제 업로드와 공개 예약을 **정책 시간대의 날짜**로 센다. 한도를 넘는 분은 거절하지 않고 다음 날 N편씩 밀어 담는다.
//   (대기열에 쌓인 영상이 30편이어도 하루에 N편씩 차례로 나간다.)
//
// 정책은 코드가 아니라 데이터 폴더의 파일이다 — `<아무이름>_daily_policy.json` 하나가 채널 하나.
//   원본은 채널 ID 상수와 정책 파일이 코드에 박혀 있었다. 여기서는 그 상수를 없애고 **폴더의 모든 정책 파일을 같은 규칙으로** 읽는다.
//   새 채널은 파일 하나(화면의 「일 한도 설정」이 writePolicy 로 쓴다)만 놓으면 된다.
//
//   ① 일 한도형 — schema "channel-daily-cap-v1" | "channel-daily-cap-v2" (옛 첫 꼴 "oshi-daily-cap-v1" 은 v1 과 같다)
//        channel_id · aliases[] · label        채널을 부르는 이름들(대기열의 channel 이나 _alias 가 이 중 하나면 이 정책의 대상)
//        timezone · daily_limit                날짜를 가르는 시간대 · 하루 편수
//        day_start_hour                        하루 시작(이 시각 전에는 올리지도 공개하지도 않는다)
//        publish_gap_minutes · review_lead_minutes   공개와 공개 사이 최소 간격 · 올린 뒤 검토가 끝나는 데 드는 시간
//        order_by "publish_at"                 편성 순서를 공개 예정 순으로(없으면 대기열에 담은 순)
//        --- v2 에서 생긴 선택 칸 (옛 코드가 v2 파일을 v1 처럼 잘못 읽지 않게 버전을 올려 건너뛰게 했다) ---
//        kind "쇼츠" | "롱폼"                   그 종류만 셈·편성한다(없으면 구분 없음 — 쇼츠 한도가 롱폼을 먹지 않게)
//        cap_uploads false                     공개 예약 수만 제한하고 업로드(쏠 시각)는 건드리지 않는다
//        overflow_day_start_hour               한도가 차서 다음 날로 밀릴 때의 공개 시작 시각(없으면 day_start_hour)
//   ② 승인형 — schema "approved-daily-v1": 사람이 승인한 완성본을 「올린 뒤 N분」 뒤로 예약하고 날짜별 N편을 지킨다.
//        channel_id · aliases[] · timezone · daily_limit · approval_required · publish_delay_minutes · overflow_day_start_hour
//
// 편성기(reflow)는 예약을 **늦추기만** 한다(앞당기지 않는다). 이미 잡힌 대기분을 한꺼번에 앞으로 당기라는 지시일 때만 repack 을 쓴다.
// 시각은 모두 app/clock.ts 의 벽시계(Wall)다 — 정책 시간대로 옮긴 「숫자 그대로」를 더하고 뺀다(서머타임에 하루가 23/25시간이 되지 않게).
import { dataDir, dataPath, existsSync, log, readJsonSync, stemOf, withFileLock, writeJson } from "./paths.ts";
import {
  addMinutes, dateOnly, isoWall, minuteWall, nextDayAt, parseWall, shortWall, systemZone, type Wall, wall, wallHour,
  wallNow, withTime,
} from "./clock.ts";
import { type LedgerRow, readLedgerStrict } from "./ledger.ts";
import { ledgerRowIsLong, normalizeJob } from "./shorts.ts";

/* ============================================================ 꼴 */

export interface Policy {
  schema: string;
  label?: string;
  channel_id: string;
  aliases?: string[];
  kind?: "쇼츠" | "롱폼";
  cap_uploads?: boolean;
  timezone: string;
  daily_limit: number;
  day_start_hour: number;
  overflow_day_start_hour?: number;
  publish_gap_minutes: number;
  review_lead_minutes: number;
  order_by?: string;
  publish_delay_minutes?: number;
  approval_required?: boolean;
  user_instruction?: string;
  authorized_at?: string;
  rule_id?: string;
  basis?: string;
  [k: string]: unknown;
}

/** 발사대기 한 줄 — channel, file, _alias, 쏠때("YYYY-MM-DDTHH:MM:SS"), publish_at("YYYY-MM-DD HH:MM"), 담은때, 롱폼, allow_not_short, time_by … */
export type Job = Record<string, any>;

export interface Loaded {
  /** 읽어서 다듬은 정책(모르는 칸은 그대로 보존) */
  cfg: Policy;
  /** 이 정책이 맡는 채널 이름들 = {channel_id, ...aliases} */
  names: Set<string>;
  /** 잠금 파일 **이름**(데이터 폴더 안) — `.<정책파일에서 _policy.json 뺀 것>_upload.lock` */
  lock: string;
  /** 정책 파일의 전체 경로 */
  path: string;
}

export const SCHEMA_V1 = "channel-daily-cap-v1";
export const SCHEMA_V2 = "channel-daily-cap-v2";
/** 승인형 정책의 schema (파이썬 승인형 편성기의 일반화) */
export const SCHEMA_APPROVED = "approved-daily-v1";
/** v1 과 같게 읽는 schema 들 — 맨 끝은 원본이 처음 쓰던 꼴이다 */
const V1_FAMILY = [SCHEMA_V1, "oshi-daily-cap-v1"];
const CAP_SCHEMAS = [...V1_FAMILY, SCHEMA_V2];

const POLICY_SUFFIX = "_daily_policy.json";

export const isApprovedPolicy = (cfg: { schema?: unknown }): boolean => cfg.schema === SCHEMA_APPROVED;

/** 한도에 걸려 더 올리거나 예약할 수 없다 — 대기열에 그대로 두고 다음 날로 미룬다(실패가 아니다). (파이썬 DailyLimitReached) */
export class DailyLimitReached extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyLimitReached";
  }
}

/* ============================================================ 시계 (시험이 바꿔 끼운다) */

let 지금 = (): Date => new Date();
/** 시험용: 현재 시각을 바꿔 끼운다(파이썬 시험이 dt.datetime 을 얼리던 자리). null 이면 진짜 시계로 되돌린다. */
export function setDailyClock(f: (() => Date) | null) { 지금 = f ?? (() => new Date()); }
const 벽시계 = (zone: string): Wall => wallNow(zone, 지금());

/* ============================================================ 작은 도구 */

const later = (...ws: Wall[]): Wall => ws.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
const 비교 = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
const 올리기 = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const 몇개 = (m: Map<string, number>, w: Wall) => m.get(dateOnly(w)) ?? 0;

/** 정책 시간대의 벽시계로 읽는다. 못 읽으면 던진다 — 파이썬 fromisoformat 이 ValueError 를 내던 자리(모르는 채 세면 한도를 넘는다). */
function 시각(v: unknown, cfg: Policy, 무엇: string): Wall {
  if (v instanceof Date) return v; // 이미 벽시계다
  const w = parseWall(String(v ?? ""), cfg.timezone);
  if (!w) throw new Error(`${무엇}을(를) 읽지 못했습니다: ${JSON.stringify(v)}`);
  return w;
}

const namesOf = (cfg: Policy): Set<string> => new Set([cfg.channel_id, ...(cfg.aliases ?? [])]);

/** 원장: 못 읽으면 던진다(readLedgerStrict) — 모르는 채로 세면 한도를 넘겨 올리게 된다. 없으면 [] */
const 원장읽기 = (): LedgerRow[] => readLedgerStrict();
/**
 * 검토대기(pending.json) — 없으면 []. (읽기·쓰기는 검토 쪽이 맡는다)
 * 깨졌거나 목록이 아니어도 편성을 멈추지는 않되, **조용히 삼키지 않고** 한 줄 남긴다 —
 * 검토대기가 빠진 채 세면 공개 칸을 덜 센 것일 수 있어서, 사람이 알아야 한다.
 */
function 대기읽기(): any[] {
  const path = dataPath("pending.json");
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) 한번알림(path, `  pending.json 을 읽지 못했습니다 — 검토대기 없이 셉니다: ${(e as Error).message}`);
    return [];
  }
  if (!text.trim()) return [];
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (Array.isArray(v)) return v;
    한번알림(path, "  pending.json 이 목록이 아닙니다 — 검토대기 없이 셉니다");
  } catch (e) {
    한번알림(path, `  pending.json 이 깨져 있습니다 — 검토대기 없이 셉니다: ${(e as Error).message}`);
  }
  return [];
}

/* ============================================================ 정책 읽기 */

const 이미알림 = new Set<string>();
/** 정책은 부를 때마다 다시 읽는다. 같은 문제를 읽을 때마다 기록에 쌓지 않게 한 번만 알린다. */
function 한번알림(path: string, 말: string) {
  const 열쇠 = `${path}|${말}`;
  if (이미알림.has(열쇠)) return;
  이미알림.add(열쇠);
  void log(말);
}

function 숫자(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  const n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function 정수칸(v: unknown, 이름: string, 작게: number, 크게: number): number {
  const n = 숫자(v);
  if (n === null || !Number.isInteger(n) || n < 작게 || n > 크게) {
    throw new Error(`${이름} 값이 올바르지 않습니다(${작게}~${크게} 사이의 정수): ${JSON.stringify(v)}`);
  }
  return n;
}
function 분칸(v: unknown, 이름: string): number {
  const n = 숫자(v);
  if (n === null || n < 0) throw new Error(`${이름} 값이 올바르지 않습니다(0 이상의 숫자): ${JSON.stringify(v)}`);
  return n;
}

/** JSON → 정책. 모자라거나 이상한 칸은 던진다 — 그 채널의 편성만 건너뛰고 다른 채널은 계속 간다. */
function 정리(raw: unknown): Policy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("정책 파일이 JSON 객체가 아닙니다");
  const r = raw as Record<string, unknown>;
  const schema = String(r.schema ?? "");
  const 승인형 = schema === SCHEMA_APPROVED;
  if (!승인형 && !CAP_SCHEMAS.includes(schema)) throw new Error(`알 수 없는 schema 입니다: ${JSON.stringify(r.schema)}`);

  const channelId = typeof r.channel_id === "string" ? r.channel_id.trim() : "";
  if (!channelId) throw new Error("channel_id 가 비었습니다");
  let aliases: string[] | undefined;
  if (r.aliases !== undefined && r.aliases !== null) {
    if (!Array.isArray(r.aliases) || r.aliases.some((a) => typeof a !== "string")) {
      throw new Error("aliases 는 글자 목록이어야 합니다");
    }
    // 빈 별칭은 거른다 — 빈 이름이 이름 집합에 들어가면 채널 칸이 빈 일감이 전부 이 정책 대상이 된다
    aliases = (r.aliases as string[]).filter((a) => a.trim() !== "");
  }
  const tz = r.timezone;
  if (typeof tz !== "string" || !tz.trim()) throw new Error("timezone 이 비었습니다");
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); } catch { throw new Error(`알 수 없는 시간대입니다: ${tz}`); }
  const limit = 숫자(r.daily_limit);
  if (limit === null || Math.trunc(limit) < 1) {
    throw new Error(`daily_limit 값이 올바르지 않습니다(1 이상): ${JSON.stringify(r.daily_limit)}`);
  }

  const cfg = { ...r, schema, channel_id: channelId, timezone: tz, daily_limit: Math.trunc(limit) } as Policy;
  if (aliases) cfg.aliases = aliases;

  if (승인형) {
    cfg.publish_delay_minutes = 분칸(r.publish_delay_minutes, "publish_delay_minutes");
    cfg.overflow_day_start_hour = 정수칸(r.overflow_day_start_hour, "overflow_day_start_hour", 0, 23);
    // 일 한도형 칸은 이 정책이 읽지 않는다. Policy 꼴을 채우려고 뜻이 같은 값만 얹는다(파일에는 쓰이지 않는다).
    cfg.day_start_hour = cfg.overflow_day_start_hour;
    cfg.publish_gap_minutes = 0;
    cfg.review_lead_minutes = cfg.publish_delay_minutes;
    return cfg;
  }

  cfg.day_start_hour = 정수칸(r.day_start_hour, "day_start_hour", 0, 23);
  cfg.publish_gap_minutes = 분칸(r.publish_gap_minutes, "publish_gap_minutes");
  cfg.review_lead_minutes = 분칸(r.review_lead_minutes, "review_lead_minutes");
  if (r.overflow_day_start_hour !== undefined && r.overflow_day_start_hour !== null) {
    cfg.overflow_day_start_hour = 정수칸(r.overflow_day_start_hour, "overflow_day_start_hour", 0, 23);
  }
  if (r.kind !== undefined && r.kind !== null && r.kind !== "쇼츠" && r.kind !== "롱폼") {
    throw new Error(`kind 는 "쇼츠" 또는 "롱폼" 이어야 합니다: ${JSON.stringify(r.kind)}`);
  }
  if (r.cap_uploads !== undefined && r.cap_uploads !== null && typeof r.cap_uploads !== "boolean") {
    throw new Error(`cap_uploads 는 true/false 여야 합니다: ${JSON.stringify(r.cap_uploads)}`);
  }
  return cfg;
}

/**
 * 데이터 폴더의 모든 `*_daily_policy.json` 을 읽는다(파일 이름 순). (파이썬 편성기의 extra_policies)
 * 깨진 정책 파일은 그 채널만 건너뛰고 한 줄 남긴다 — 한 채널 설정이 깨졌다고 다른 채널 대기열 쓰기까지 멈추면 안 된다.
 */
export function loadPolicies(): Loaded[] {
  let files: string[];
  try {
    files = [...Deno.readDirSync(dataDir())]
      .filter((e) => (e.isFile || e.isSymlink) && e.name.endsWith(POLICY_SUFFIX))
      .map((e) => e.name).sort();
  } catch (e) {
    // 데이터 폴더가 아직 없으면 정책도 없다. 그 밖의 사정(권한 등)은 알린다.
    if (!(e instanceof Deno.errors.NotFound)) 한번알림(dataDir(), `일 한도 정책 폴더를 읽지 못했습니다: ${(e as Error).message}`);
    return [];
  }
  const out: Loaded[] = [];
  for (const name of files) {
    const path = dataPath(name);
    let cfg: Policy;
    try {
      const text = Deno.readTextFileSync(path).replace(/^\uFEFF/, "");
      const raw = JSON.parse(text);
      const schema = raw && typeof raw === "object" ? String((raw as Record<string, unknown>).schema ?? "") : "";
      // 이 코드가 아는 꼴이 아니면(더 새 버전의 파일 등) 읽지 않는다 — 다만 오타로 한도가 조용히 풀리지 않게 한 번 알린다.
      if (schema !== SCHEMA_APPROVED && !CAP_SCHEMAS.includes(schema)) {
        한번알림(path, `  ${name}: 알 수 없는 schema(${JSON.stringify(schema)}) — 이 채널의 일 한도 편성을 건너뜁니다`);
        continue;
      }
      cfg = 정리(raw);
    } catch (e) {
      한번알림(path, `  ${name} 읽기 오류 — 이 채널의 일 한도 편성을 건너뜁니다: ${(e as Error).message}`);
      continue;
    }
    out.push({
      cfg,
      names: namesOf(cfg),
      lock: `.${name.slice(0, -"_policy.json".length)}_upload.lock`,
      path,
    });
  }
  return out;
}

/** 이 채널(이름·별칭·channel_id 어느 것이든)에 걸린 정책. 없으면 null. (파이썬 profile_of) */
export function policyForChannel(channel: string): Loaded | null {
  if (!channel) return null;
  return loadPolicies().find((p) => p.names.has(channel)) ?? null;
}

/* ============================================================ 종류 가르기 */

/** 롱폼 전용(R-352)인가 / 쇼츠 전용인가 */
const 쇼츠만 = (cfg: Policy) => cfg.kind === "쇼츠";
const 롱폼만 = (cfg: Policy) => cfg.kind === "롱폼";
/** 업로드 수도 제한하는가 — cap_uploads 가 false 이면 공개 예약만 제한한다(없으면 둘 다) */
const 업로드도제한 = (cfg: Policy) => cfg.cap_uploads !== false;

/** 대기열·일감 한 줄이 롱폼인가 — 담을 때 실제 파일로 적어 둔 표시를 읽는다(없으면 쇼츠). (파이썬 _long_job) */
const 롱폼일감 = (job: Job) => !!(job["롱폼"] || job["allow_not_short"]);

/** 편성 순서 열쇠 — 공개 예정 시각(없으면 쏠 시각). 'T' 와 공백 차이를 맞춰 글자로 비교한다. (파이썬 _plan_key) */
const 계획열쇠 = (job: Job): string => String(job["publish_at"] || job["쏠때"] || "").replace(/T/g, " ").slice(0, 16);
const 담은때 = (job: Job): string => String(job["담은때"] || "");

/**
 * 이 정책이 편성할 대기열 줄인가 — 그 채널이고, 쇼츠 전용 정책이면 롱폼이 아닌 줄, 롱폼 전용이면 롱폼인 줄. (파이썬 _mine)
 * 쇼츠 한도가 같은 채널의 롱폼을 먹지 않게(그 반대도) 한다.
 */
function mine(job: Job, cfg: Policy, names: Set<string>): boolean {
  return (names.has(job["channel"]) || names.has(job["_alias"]))
    && !(쇼츠만(cfg) && 롱폼일감(job))
    && !(롱폼만(cfg) && !롱폼일감(job));
}

/* ============================================================ 세기 */

/**
 * 원장 + 검토대기를 날짜별 편수로 센다. (파이썬 편성기의 counts 둘)
 *   uploads    날짜(YYYY-MM-DD) → 그 날 실제 올린 편수      published  날짜 → 그 날 공개(예약) 편수
 *   booked     공개(예약) 시각 전부 — 새 공개 시각이 서로 너무 가깝지 않게 비교할 때 쓴다
 * 같은 영상 ID 의 원장·검토대기 기록은 한 번만 센다. exclude 는 그 영상의 공개를 세지 않는다(승인형 — 자기 예약을 옮길 때).
 */
export function counts(
  ledger: Record<string, string>[],
  pending: any[],
  cfg: Policy,
  exclude = "",
): { uploads: Map<string, number>; published: Map<string, number>; booked: Wall[] } {
  if (isApprovedPolicy(cfg)) return 승인세기(ledger, pending, cfg, exclude);
  const names = namesOf(cfg), only쇼츠 = 쇼츠만(cfg), only롱폼 = 롱폼만(cfg);
  const uploads = new Map<string, number>();
  const publications = new Map<string, Wall>();
  const seen = new Set<string>(), longIds = new Set<string>();
  for (const row of ledger) {
    if (!names.has(row["채널"])) continue;
    const key = row["영상ID"] || row["파일"];
    if (only쇼츠 || only롱폼) {
      // 원장 줄의 롱폼 판정은 공개 간격 검사와 같은 잣대 한 곳(ledgerRowIsLong)이다
      const isLong = ledgerRowIsLong(row);
      if (isLong) longIds.add(key);
      if (isLong === only쇼츠) continue; // 쇼츠 전용이면 롱폼 줄을, 롱폼 전용이면 쇼츠 줄을 셈에서 뺀다
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    올리기(uploads, dateOnly(시각(row["업로드시각"], cfg, "원장 업로드시각")));
    const at = row["공개시각"] || row["예약시각"];
    if (at) publications.set(key, 시각(at, cfg, "원장 공개·예약시각"));
  }
  // 같은 video ID 의 원장/검토대기 기록은 한 번만 센다(같은 열쇠로 덮는다).
  for (const row of pending) {
    // 검토대기 줄에는 종류 표시가 없다 — 원장에서 롱폼으로 확인된 영상 ID 로 가른다
    // (롱폼 전용은 그 ID 만, 쇼츠 전용·구분 없음은 그 ID 만 뺀다)
    if (names.has(row?.channel) && row.video_id && row.publish_at
      && (only롱폼 ? longIds.has(row.video_id) : !longIds.has(row.video_id))) {
      publications.set(row.video_id, 시각(row.publish_at, cfg, "검토대기 공개 예정 시각"));
    }
  }
  const published = new Map<string, number>();
  for (const t of publications.values()) 올리기(published, dateOnly(t));
  return { uploads, published, booked: [...publications.values()] };
}

/** 승인형의 세기 — 종류 구분이 없고, 업로드시각이 비어 있어도 던지지 않는다. (파이썬 승인형 편성기의 counts) */
function 승인세기(ledger: Record<string, string>[], pending: any[], cfg: Policy, exclude: string) {
  const names = namesOf(cfg);
  const uploads = new Map<string, number>();
  const pubs = new Map<unknown, Wall>();
  const seen = new Set<string>();
  for (const r of ledger) {
    if (!names.has(r["채널"])) continue;
    const key = r["영상ID"] || r["파일"];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (r["업로드시각"]) 올리기(uploads, dateOnly(시각(r["업로드시각"], cfg, "원장 업로드시각")));
    const at = r["공개시각"] || r["예약시각"];
    if (key !== exclude && at) pubs.set(key, 시각(at, cfg, "원장 공개·예약시각"));
  }
  for (const r of pending) {
    if (names.has(r?.channel) && r.video_id !== exclude && r.publish_at) {
      pubs.set(r.video_id, 시각(r.publish_at, cfg, "검토대기 공개 예정 시각"));
    }
  }
  const published = new Map<string, number>();
  for (const t of pubs.values()) 올리기(published, dateOnly(t));
  return { uploads, published, booked: [...pubs.values()] };
}

/* ============================================================ 편성 */

/**
 * 한 채널(정책 하나)의 대기분을 편성한다. 기존 예약을 앞당기지 않고 초과/밀린 분만 뒤로 보낸다. (파이썬 _reflow_one)
 *
 * 줄마다 ① 올릴 시각: 지금·원래 쏠때·앞 줄 중 가장 늦은 때 → 하루 시작 전이면 시작으로 → 그 날 칸이 차면 다음 날 시작으로
 *                  ② 공개 시각: 원래 공개 예정과 (올린 때 + 검토 시간) 중 늦은 때 → 앞 줄 공개 + 간격 이후 →
 *                     그 날 공개 칸이 차면 다음 날(밀릴 때의 시작 시각)로 → 이미 잡힌 공개와 간격 안쪽이면 그 뒤로
 */
function 한채널편성(
  queue: Job[], cfg: Policy, names: Set<string>, now: Wall | undefined, ledger: LedgerRow[], pending: any[],
): Job[] {
  const 지금W = now ?? 벽시계(cfg.timezone);
  const { uploads, published, booked } = counts(ledger, pending, cfg);
  const limit = cfg.daily_limit;
  const gapMin = cfg.publish_gap_minutes, gapMs = gapMin * 60_000;
  const leadMin = cfg.review_lead_minutes;
  const start = cfg.day_start_hour;
  // 한도가 차서 다음 날로 미룰 때의 공개 시작 시각 — 칸이 없으면 day_start_hour
  const overflow = cfg.overflow_day_start_hour ?? start;
  const 업로드제한 = 업로드도제한(cfg); // false 면 업로드는 제한하지 않고(쏠 시각 그대로) 공개 예약 날짜만 편성한다
  let tailUpload: Wall | null = null, tailPublish: Wall | null = null;

  // 담은 순서가 기준이다. 이미 미래에 배치된 항목을 새 항목이 앞지르지 않는다.
  // (order_by=publish_at 인 채널은 공개 예정 순서가 기준 — 새 편은 마지막 공개 예정 뒤에 붙으므로 같은 뜻이다)
  const 순서 = queue.map((row, index) => ({ row, index }));
  if (cfg.order_by === "publish_at") {
    순서.sort((a, b) =>
      비교(계획열쇠(a.row), 계획열쇠(b.row)) || 비교(담은때(a.row), 담은때(b.row)) || a.index - b.index);
  } else {
    순서.sort((a, b) => 비교(담은때(a.row), 담은때(b.row)) || a.index - b.index);
  }

  const 짜임: Job[] = new Array(queue.length);
  for (const { row, index } of 순서) {
    const job = { ...row };
    if (!mine(job, cfg, names)) { 짜임[index] = job; continue; }

    let uploadAt: Wall;
    if (업로드제한) {
      uploadAt = later(지금W, 시각(job["쏠때"] || 지금W, cfg, "쏠때"), tailUpload ?? 지금W);
      if (wallHour(uploadAt) < start) uploadAt = withTime(uploadAt, start);
      while (몇개(uploads, uploadAt) >= limit) uploadAt = nextDayAt(uploadAt, start);
      올리기(uploads, dateOnly(uploadAt));
      tailUpload = uploadAt;
    } else {
      // 업로드는 그대로(쏠때를 건드리지 않는다) — 올린 뒤 검토 시간 이후에 공개된다는 계산에만 쓴다
      uploadAt = later(지금W, 시각(job["쏠때"] || 지금W, cfg, "쏠때"));
      if (wallHour(uploadAt) < start) uploadAt = withTime(uploadAt, start);
    }
    const 검토끝 = addMinutes(uploadAt, leadMin);
    let publishAt = later(시각(job["publish_at"] || 검토끝, cfg, "publish_at"), 검토끝);
    if (tailPublish) publishAt = later(publishAt, addMinutes(tailPublish, gapMin));
    // 공개가 자리 잡을 때까지 — 시작 시각 앞이면 시작으로, 그 날이 차면 다음 날로, 이미 잡힌 공개와 가까우면 그 뒤로.
    // 뜻이 어긋난 정책(간격이 하루보다 길다 등)이 앱을 멈춰 세우지 않게 상한을 둔다.
    for (let 번 = 0;; 번++) {
      if (번 > 100_000) throw new Error("공개 시각을 정하지 못했습니다 — 일 한도 정책의 값(편수·간격)을 확인하세요");
      if (wallHour(publishAt) < start) publishAt = withTime(publishAt, start);
      if (몇개(published, publishAt) >= limit) {
        publishAt = later(nextDayAt(publishAt, overflow), 검토끝);
        continue;
      }
      const 가까운 = booked.filter((t) => Math.abs(t.getTime() - publishAt.getTime()) < gapMs);
      if (가까운.length) { publishAt = addMinutes(later(...가까운), gapMin); continue; }
      break;
    }
    올리기(published, dateOnly(publishAt));
    booked.push(publishAt);
    tailPublish = publishAt;
    if (업로드제한) job["쏠때"] = isoWall(uploadAt);
    job["publish_at"] = minuteWall(publishAt);
    짜임[index] = job;
  }
  return 짜임;
}

/**
 * 승인형 정책의 편성. (파이썬 승인형 편성기의 reflow)
 * 줄 순서대로 ① 올릴 시각: 지금·원래 쏠때·앞 줄 중 가장 늦은 때, 그 날 업로드 칸이 차면 다음 날 ② 공개 시각: 정한 시각(없으면 올린 뒤
 * publish_delay_minutes), 다른 날로 밀렸으면 그만큼 뒤로 ③ 그 날 공개 칸이 차면 다음 날로 — 올리는 시각도 그 뒤로 따라간다.
 * 승인한 시각이므로 time_by 를 user 로 적는다.
 */
function 승인편성(queue: Job[], p: Loaded, now: Wall | undefined, ledger: LedgerRow[], pending: any[]): Job[] {
  const cfg = p.cfg;
  const limit = cfg.daily_limit;
  const delay = cfg.publish_delay_minutes ?? 0;
  const overflow = cfg.overflow_day_start_hour ?? 0;
  const 지금W = now ?? 벽시계(cfg.timezone);
  const { uploads: up, published: pub } = 승인세기(ledger, pending, cfg, "");
  const 다음날 = (t: Wall) => nextDayAt(t, overflow);
  let tail = 지금W;
  const out: Job[] = [];
  for (const r of queue) {
    const j = { ...r };
    if (!(p.names.has(j["channel"]) || p.names.has(j["_alias"]))) { out.push(j); continue; }
    const plannedSend = 시각(j["쏠때"] || 지금W, cfg, "쏠때");
    let send = later(지금W, plannedSend, tail);
    while (몇개(up, send) >= limit) send = 다음날(send);
    let publish = 시각(j["publish_at"] || addMinutes(send, delay), cfg, "publish_at");
    if (dateOnly(send) > dateOnly(plannedSend)) publish = later(publish, addMinutes(send, delay));
    for (let 번 = 0; 몇개(pub, publish) >= limit; 번++) {
      if (번 > 100_000) throw new Error("공개 시각을 정하지 못했습니다 — 일 한도 정책의 값을 확인하세요");
      publish = 다음날(publish);
      send = later(send, publish);
      publish = later(publish, addMinutes(send, delay));
      while (몇개(up, send) >= limit) {
        send = 다음날(send);
        publish = later(publish, addMinutes(send, delay));
      }
    }
    올리기(up, dateOnly(send));
    올리기(pub, dateOnly(publish));
    tail = send;
    j["쏠때"] = isoWall(send);
    j["publish_at"] = minuteWall(publish);
    j["time_by"] = "user";
    out.push(j);
  }
  return out;
}

/**
 * 정책이 있는 채널마다 같은 규칙으로 대기열을 편성한다. (파이썬 편성기의 reflow 둘)
 * 입력은 건드리지 않고 새 배열을 돌려준다. 정책이 없는 채널의 줄은 그대로(복사만) 돌려준다.
 *  · now      **정책 시간대의 벽시계**(Wall)다 — 안 주면 각 정책의 시간대로 본 지금. 순간(Date.now)을 그대로 넘기면 시간대만큼 어긋난다.
 *  · ledger·pending   안 주면 데이터 폴더의 ledger.csv · pending.json 을 읽는다(원장을 못 읽으면 던진다 — 모르는 채 세면 한도를 넘는다).
 *  · 시각 글자를 못 읽으면 던진다(원본이 ValueError 를 내던 자리). 한도를 모르는 채 편성하지 않으려는 것이다.
 */
export function reflow(
  queue: Job[],
  o: { now?: Wall; ledger?: Record<string, string>[]; pending?: any[] } = {},
): Job[] {
  let result = queue.map((row) => ({ ...row }));
  let ledger = o.ledger, pending = o.pending;
  for (const p of loadPolicies()) {
    if (!result.some((row) => p.names.has(row["channel"]) || p.names.has(row["_alias"]))) continue;
    ledger ??= 원장읽기();
    pending ??= 대기읽기();
    if (isApprovedPolicy(p.cfg)) {
      result = 승인편성(result, p, o.now, ledger, pending);
    } else if (result.some((row) => mine(row, p.cfg, p.names))) {
      result = 한채널편성(result, p.cfg, p.names, o.now, ledger, pending);
    }
  }
  return result;
}

/* ============================================================ 앞당기기 */

/**
 * 그 채널 대기분을 지금부터 다시 앞당겨 채운다 — 순서는 지금 공개 예정·쏠 시각 오름차순(first 에 적은 파일은 적은 순서대로 맨 앞).
 * today 가 있으면 그만큼만 오늘 올리고 나머지는 다음 날 하루 시작부터. 다른 채널·다른 종류 줄은 그대로다. (파이썬 repack)
 * 편성기는 늦추기만 하므로 공개 시각 자리에는 순서만 지키는 이른 자리표를 두고, 실제 시각은 규칙대로 새로 정해진다.
 */
export function repack(
  queue: Job[],
  channel: string,
  o: { today?: number; now?: Wall; ledger?: Record<string, string>[]; pending?: any[]; first?: string[] } = {},
): Job[] {
  const p = 앞당길정책(channel);
  const { cfg, names } = p;
  const now = o.now ?? 벽시계(cfg.timezone);
  const tomorrow = nextDayAt(now, cfg.day_start_hour);
  const rank = new Map<string, number>();
  (o.first ?? []).forEach((file, k) => rank.set(file, k)); // 같은 파일을 두 번 적으면 뒤의 것이 이긴다
  // 정렬 열쇠는 글자 그대로만 쓴다 — 아래에서 쏠때·publish_at 을 덮어쓰기 전의 값은 읽지(해석하지) 않는다.
  const 대상 = queue.map((_, i) => i).filter((i) => mine(queue[i], cfg, names)).sort((a, b) =>
    ((rank.get(queue[a]["file"]) ?? rank.size) - (rank.get(queue[b]["file"]) ?? rank.size))
    || 비교(계획열쇠(queue[a]), 계획열쇠(queue[b]))
    || 비교(String(queue[a]["쏠때"] || ""), String(queue[b]["쏠때"] || ""))
    || a - b);
  const out = queue.map((row) => ({ ...row }));
  대상.forEach((i, k) => {
    out[i]["쏠때"] = isoWall(o.today == null || k < o.today ? now : tomorrow);
    out[i]["publish_at"] = minuteWall(addMinutes(wall(2000, 1, 1), k));
  });
  return 한채널편성(out, cfg, names, now, o.ledger ?? 원장읽기(), o.pending ?? 대기읽기());
}

function 앞당길정책(channel: string): Loaded {
  const p = policyForChannel(channel);
  if (!p) throw new Error(`${channel}: 일 한도 정책이 없는 채널`);
  if (isApprovedPolicy(p.cfg)) throw new Error(`${channel}: 승인형 정책은 앞당기기를 하지 않습니다`);
  return p;
}

export interface RepackReport {
  /** 한 줄씩의 표 — 「  1  업로드 10-12 22:15  공개 10-12 22:25  파일이름」 */
  lines: string[];
  /** 날짜별 업로드 편수 / 공개 편수 (날짜순) */
  uploads: Record<string, number>;
  published: Record<string, number>;
}

/** 키 순서와 상관없이 같은 줄인가 (파이썬 dict 비교) */
function 같은줄(a: unknown, b: unknown): boolean {
  const 정렬 = (v: unknown): unknown => Array.isArray(v) ? v.map(정렬)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => 비교(x, y)).map(([k, x]) => [k, 정렬(x)]))
      : v;
  return JSON.stringify(정렬(a)) === JSON.stringify(정렬(b));
}

/**
 * repack 결과를 사람이 볼 표로 만든다. (파이썬 _repack_cli 의 계산 부분 — 파일 읽기·백업·쓰기는 부르는 쪽이 한다)
 * 편성 대상이 아닌 줄이 바뀌었으면 던진다(파이썬 assert) — 다른 채널의 예약을 건드리면 안 된다.
 */
export function repackReport(before: Job[], after: Job[], channel: string): RepackReport {
  const { cfg, names } = 앞당길정책(channel);
  const 대상 = before.map((_, i) => i).filter((i) => mine(before[i], cfg, names));
  const 대상집합 = new Set(대상);
  for (let i = 0; i < before.length; i++) {
    if (!대상집합.has(i) && !같은줄(after[i], before[i])) throw new Error("편성 대상이 아닌 줄이 바뀌었다");
  }
  const up = new Map<string, number>(), pub = new Map<string, number>();
  const lines: string[] = [];
  [...대상].sort((a, b) => 비교(String(after[a]["publish_at"]), String(after[b]["publish_at"]))).forEach((i, k) => {
    const row = after[i];
    올리기(up, String(row["쏠때"]).slice(0, 10));
    올리기(pub, String(row["publish_at"]).slice(0, 10));
    lines.push(`${String(k + 1).padStart(3)}  업로드 ${String(row["쏠때"]).slice(5, 16).replace("T", " ")}  `
      + `공개 ${String(row["publish_at"]).slice(5)}  ${stemOf(String(row["file"] ?? ""))}`);
  });
  const 날짜순 = (m: Map<string, number>) => Object.fromEntries([...m].sort(([x], [y]) => 비교(x, y)));
  return { lines, uploads: 날짜순(up), published: 날짜순(pub) };
}

/* ============================================================ 실제 업로드 문 */

/**
 * 실제 올리려는 일감이 롱폼인가 — 표시가 없으면 실제 파일로 잰다. 못 재면 쇼츠로 센다(올리기 단계가 따로 거절한다). (파이썬 _upload_is_long)
 */
async function 올릴게롱폼(job: Job | undefined): Promise<boolean> {
  if (!job || Object.keys(job).length === 0) return false; // 파이썬 `not job` — 빈 사전도 비었다
  if ("롱폼" in job || "allow_not_short" in job) return 롱폼일감(job);
  try {
    return !!(await normalizeJob(job)).롱폼;
  } catch (e) {
    void log(`  일 한도: 영상 종류를 재지 못해 쇼츠로 셉니다 — ${(e as Error).message}`);
    return false;
  }
}

/**
 * 이 채널의 실제 업로드에 일 한도가 걸려 있으면 그 정책, 아니면 null. (파이썬 _slot)
 * 원본은 종류가 안 맞는 정책을 만나면 거기서 「한도 없음」으로 끝냈다. 같은 채널에 쇼츠용·롱폼용 정책이 따로 있으면
 * 앞 정책 때문에 뒤 정책이 걸리지 않는 셈이라, 여기서는 **다음 정책을 계속 본다**(정책이 하나뿐이면 원본과 같다).
 */
async function 걸린정책(channel: string, job: Job | undefined): Promise<Loaded | null> {
  for (const p of loadPolicies()) {
    if (!p.names.has(channel)) continue;
    if (!isApprovedPolicy(p.cfg)) {
      if (쇼츠만(p.cfg) && await 올릴게롱폼(job)) continue; // 쇼츠 한도는 롱폼을 세지 않는다
      if (롱폼만(p.cfg) && !(await 올릴게롱폼(job))) continue; // 롱폼 전용 정책은 쇼츠를 세지 않는다
    }
    return p;
  }
  return null;
}

const 이름표 = (cfg: Policy) => cfg.label || "이 채널";

/**
 * 업로드는 막지 않고, 이 일감이 공개될 날짜의 공개 예약이 이미 한도면 막는 마지막 보루. (파이썬 _require_publication_slot)
 * 편성기(reflow)가 날짜를 옮기지 못한 직접 전송(사람이 화면에서 바로 올리기 등)을 위한 것이다.
 * 공개 시각이 없거나 이미 지났으면 올린 뒤 검토가 끝나는 대로 열리므로 지금 + 검토 시간(lead)의 날짜로 센다.
 */
function 공개칸확인(cfg: Policy, job: Job | undefined) {
  const soonest = addMinutes(벽시계(cfg.timezone), cfg.review_lead_minutes);
  const planned = job?.["publish_at"];
  const when = planned ? later(시각(planned, cfg, "publish_at"), soonest) : soonest;
  const { published } = counts(원장읽기(), 대기읽기(), cfg);
  if (몇개(published, when) >= cfg.daily_limit) {
    throw new DailyLimitReached(
      `${이름표(cfg)} 하루 ${cfg.daily_limit}편 공개 예약 한도 — ${shortWall(when).slice(0, 5)} 공개 예약이 가득 찼습니다. 다음 날로 편성해야 합니다`);
  }
}

function 업로드칸확인(cfg: Policy) {
  const today = dateOnly(벽시계(cfg.timezone));
  const { uploads } = counts(원장읽기(), [], cfg);
  if ((uploads.get(today) ?? 0) >= cfg.daily_limit) {
    throw new DailyLimitReached(`${이름표(cfg)} 하루 ${cfg.daily_limit}편 업로드 완료 — 다음 날 대기열로 미룹니다`);
  }
}

/**
 * 파일 잠금 안에서 한도를 확인한 뒤 fn(실제 업로드)을 한다. (파이썬 upload_slot — 컨텍스트 매니저)
 * 즉시·정기·직접 전송이 동시에 마지막 칸을 차지하지 못하게, 확인과 업로드를 같은 잠금 안에서 한다 —
 * fn 이 원장에 한 줄을 적고 끝나야 다음 사람이 그것을 보고 센다. 한도가 찼으면 fn 은 불리지 않고 DailyLimitReached 를 던진다.
 * dry 이거나 한도가 걸리지 않은 채널(종류가 다른 일감 포함)이면 그냥 fn 을 한다.
 */
export async function uploadSlot<T>(
  channel: string,
  job: Job | undefined,
  fn: () => Promise<T>,
  o: { dry?: boolean } = {},
): Promise<T> {
  if (o.dry) return await fn();
  const found = await 걸린정책(channel, job);
  if (!found) return await fn();
  const r = await withFileLock(dataPath(found.lock), async () => {
    if (isApprovedPolicy(found.cfg) || 업로드도제한(found.cfg)) 업로드칸확인(found.cfg);
    else 공개칸확인(found.cfg, job); // cap_uploads false: 공개 예약 날짜만 본다
    return { 값: await fn() };
  });
  return r!.값;
}

/**
 * 승인형 정책이 있는 채널의 공개 예약 한도 문턱. (파이썬 승인형 편성기의 require_publication)
 * when 이 없으면 지금. videoId 는 자기 자신의 예약을 세지 않게 뺀다(예약을 옮길 때). 승인형이 아닌 채널은 아무것도 하지 않는다.
 * 원본은 ValueError 를 던졌지만 여기서는 DailyLimitReached(Error 의 한 갈래)를 던진다.
 */
export function requirePublication(channel: string, when?: Wall | null, videoId = ""): void {
  const found = policyForChannel(channel);
  if (!found || !isApprovedPolicy(found.cfg)) return;
  const cfg = found.cfg;
  const { published } = 승인세기(원장읽기(), 대기읽기(), cfg, videoId);
  const day = when ?? 벽시계(cfg.timezone);
  if (몇개(published, day) >= cfg.daily_limit) {
    throw new DailyLimitReached(`${이름표(cfg)} 하루 ${cfg.daily_limit}편 공개 예약 한도 — 다음 날로 편성해야 합니다`);
  }
}

/* ============================================================ 화면 설정 */

const 정책잠금 = () => dataPath("daily_policy.lock");

/** 사람이 알아보는 파일 이름으로 — 경로 구분자·점·공백 같은 것은 밑줄로 */
function 안전한이름(s: string): string {
  return s.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

/** 쓸 때 보기 좋은 칸 순서 (나머지 모르는 칸은 그 뒤에 그대로) */
const 칸순서 = [
  "schema", "label", "channel_id", "aliases", "kind", "cap_uploads", "timezone", "daily_limit", "day_start_hour",
  "overflow_day_start_hour", "publish_gap_minutes", "review_lead_minutes", "order_by", "approval_required",
  "publish_delay_minutes", "user_instruction", "authorized_at", "rule_id", "basis",
];
const 일한도형전용칸 = ["kind", "cap_uploads", "day_start_hour", "publish_gap_minutes", "review_lead_minutes", "order_by"];
const 승인형전용칸 = ["approval_required", "publish_delay_minutes"];

/**
 * 정책 파일을 쓴다(화면의 「일 한도 설정」). 쓴 파일의 경로를 돌려준다.
 *  · 같은 channel_id 의 정책이 이미 있으면 그 파일을 고친다(두 파일이 같은 채널을 편성하는 일이 없게). 없으면 label(없으면 channel_id)로 새 파일.
 *  · p 에 적은 칸만 덮는다 — 값이 undefined/null 이면 그 칸을 지운다(예: kind 를 지워 「구분 없음」으로). p 에 없는 칸은 옛 파일 값을 보존한다.
 *  · 일 한도형은 kind 롱폼·cap_uploads·overflow_day_start_hour 중 하나라도 있으면 v2, 아니면 v1 로 적는다. schema 를 approved-daily-v1 로 주면 승인형.
 *  · 읽을 때와 같은 검사를 거친다 — 이상한 값이면 던지고 아무것도 쓰지 않는다.
 */
export async function writePolicy(p: Partial<Policy> & { channel_id: string; daily_limit: number }): Promise<string> {
  const id = String(p.channel_id ?? "").trim();
  if (!id) throw new Error("채널 ID 가 비었습니다");
  const r = await withFileLock(정책잠금(), async () => {
    const 옛 = loadPolicies().find((x) => x.cfg.channel_id === id);
    const 옛값 = 옛 ? readJsonSync<Record<string, unknown>>(옛.path, {}) : {};
    const 합침: Record<string, unknown> = { ...옛값 };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null) delete 합침[k]; else 합침[k] = v;
    }
    합침.channel_id = id;
    const 승인형 = 합침.schema === SCHEMA_APPROVED;
    if (승인형) {
      for (const k of 일한도형전용칸) delete 합침[k];
      합침.approval_required ??= true;
      합침.publish_delay_minutes ??= 10;
      합침.overflow_day_start_hour ??= 7;
    } else {
      for (const k of 승인형전용칸) delete 합침[k];
      합침.day_start_hour ??= 7;
      합침.publish_gap_minutes ??= 120;
      합침.review_lead_minutes ??= 50;
      const v2 = 합침.kind === "롱폼" || 합침.cap_uploads !== undefined || 합침.overflow_day_start_hour !== undefined;
      합침.schema = v2 ? SCHEMA_V2 : (V1_FAMILY.includes(String(옛값.schema)) ? String(옛값.schema) : SCHEMA_V1);
    }
    합침.timezone ??= systemZone();
    if (Array.isArray(합침.aliases) && !합침.aliases.length) delete 합침.aliases;
    const 검증 = 정리(합침); // 이상한 값은 여기서 던진다 — 쓰기 전에
    // 검사가 다듬은 숫자("6" → 6)와 별칭(빈 칸 거름)을 파일에도 그대로 적는다 — 다음에 읽는 쪽이 같은 값을 보게
    for (const k of ["daily_limit", "day_start_hour", "overflow_day_start_hour", "publish_gap_minutes", "review_lead_minutes", "publish_delay_minutes"]) {
      if (k in 합침) 합침[k] = 검증[k];
    }
    if (검증.aliases?.length) 합침.aliases = 검증.aliases; else delete 합침.aliases;

    const 순서대로: Record<string, unknown> = {};
    for (const k of 칸순서) if (k in 합침) 순서대로[k] = 합침[k];
    for (const k of Object.keys(합침)) if (!(k in 순서대로)) 순서대로[k] = 합침[k];

    let path = 옛?.path;
    if (!path) {
      const 이름 = 안전한이름(String(합침.label ?? "")) || 안전한이름(id) || "channel";
      path = dataPath(`${이름}${POLICY_SUFFIX}`);
      // 다른 채널의(또는 읽히지 않는 깨진) 정책 파일을 덮어쓰지 않는다
      for (let n = 2; existsSync(path); n++) path = dataPath(`${이름}_${n}${POLICY_SUFFIX}`);
    }
    await writeJson(path, 순서대로);
    await log(`  일 한도 정책을 ${옛 ? "고쳤습니다" : "만들었습니다"} — ${describePolicy(검증)}`);
    return path;
  });
  return r!;
}

/** channel_id 가 같은 정책 파일을 지운다. 지운 게 있으면 true. (알아보는 이름의 별칭은 지우지 않는다) */
export async function removePolicy(channelId: string): Promise<boolean> {
  const r = await withFileLock(정책잠금(), async () => {
    let 지움 = false;
    for (const p of loadPolicies()) {
      if (p.cfg.channel_id !== channelId) continue;
      try {
        await Deno.remove(p.path);
        지움 = true;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
    if (지움) await log(`  일 한도 정책을 지웠습니다 — ${channelId}`);
    return 지움;
  });
  return !!r;
}

/** 사람 말 한 줄 — 「하루 2편 · 롱폼만 · 공개 예약만 제한 · 07시 시작(밀리면 09시) · …」 */
export function describePolicy(cfg: Policy): string {
  const 시 = (h: number) => `${String(h).padStart(2, "0")}시`;
  const 분글 = (m: number) => m >= 60
    ? (m % 60 === 0 ? `${m / 60}시간` : `${Math.floor(m / 60)}시간 ${m % 60}분`)
    : `${m}분`;
  if (isApprovedPolicy(cfg)) {
    return [
      `하루 ${cfg.daily_limit}편`, "승인한 영상만", `올린 ${분글(cfg.publish_delay_minutes ?? 0)} 뒤 공개 예약`,
      `가득 차면 다음 날 ${시(cfg.overflow_day_start_hour ?? 0)}부터`, cfg.timezone,
    ].join(" · ");
  }
  const overflow = cfg.overflow_day_start_hour;
  return [
    `하루 ${cfg.daily_limit}편`,
    cfg.kind ? `${cfg.kind}만` : "쇼츠·롱폼 구분 없음",
    업로드도제한(cfg) ? "업로드·공개 예약 모두 제한" : "공개 예약만 제한",
    `${시(cfg.day_start_hour)} 시작` + (overflow !== undefined && overflow !== cfg.day_start_hour ? `(밀리면 ${시(overflow)})` : ""),
    `공개 간격 ${분글(cfg.publish_gap_minutes)}`,
    `올린 뒤 ${분글(cfg.review_lead_minutes)} 이후 공개`,
    cfg.timezone,
  ].join(" · ");
}

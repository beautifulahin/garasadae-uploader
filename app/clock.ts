// 시각 다루기 — 파이썬의 「시간대 없는 날짜시각(naive datetime)」과 같은 방식으로 셈한다.
//
// 왜 이렇게 하나
//   현재 업로더(파이썬)는 발사대기 시각·예약 시각을 `2026-10-19T09:00:00` 같은 **시간대 없는
//   벽시계 글자**로 적고, 더하기·빼기도 그 글자 위에서 한다. 일 한도 편성기는 정책의
//   시간대(Asia/Seoul)로 옮긴 벽시계 값을 쓴다.
//   자바스크립트의 Date 는 늘 순간(절대 시각)이라, 벽시계 셈을 그대로 하면 서머타임·시간대에
//   따라 하루가 23/25시간이 되어 어긋난다.
//
// 그래서 「벽시계 Date」를 쓴다
//   Date.UTC(년,월,일,시,분,초) 로 만든 Date 에 **벽시계 숫자를 UTC 칸에 그대로 담는다.**
//   읽을 때는 getUTC* 로 꺼낸다. 이러면 더하기·빼기·비교가 파이썬 naive 와 똑같이 돌고
//   서머타임에 흔들리지 않는다.  (이 파일 밖에서는 Date 의 getHours() 등을 쓰지 말 것)
//
// 순간 ↔ 벽시계 변환은 Intl 로 한다(시간대 이름만 있으면 된다).

/** 벽시계 값 — UTC 칸에 벽시계 숫자를 담은 Date. */
export type Wall = Date;

const 분 = 60_000;
const 시간 = 3_600_000;
const 날 = 86_400_000;

/** 이 컴퓨터의 시간대 이름 (예: Asia/Seoul). 시험은 TZ 환경변수로 고정한다. */
export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function wall(y: number, m: number, d: number, h = 0, mi = 0, s = 0): Wall {
  return new Date(Date.UTC(y, m - 1, d, h, mi, s, 0));
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(zone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    dtfCache.set(zone, f);
  }
  return f;
}

/** 절대 순간 → 그 시간대의 벽시계 */
export function instantToWall(t: Date, zone: string = systemZone()): Wall {
  const p: Record<string, number> = {};
  for (const x of dtf(zone).formatToParts(t)) {
    if (x.type !== "literal") p[x.type] = Number(x.value);
  }
  return wall(p.year, p.month, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
}

/** 벽시계 → 절대 순간 (그 시간대 기준). 서머타임 겹침/빈 시각은 앞쪽 값으로 정한다. */
export function wallToInstant(w: Wall, zone: string = systemZone()): Date {
  // 추측 → 그 순간의 벽시계와 견줘 차이만큼 고친다 (두 번이면 수렴한다)
  let guess = new Date(w.getTime());
  for (let i = 0; i < 3; i++) {
    const seen = instantToWall(guess, zone);
    const diff = w.getTime() - seen.getTime();
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

/** 지금의 벽시계 (시간대를 안 주면 이 컴퓨터) */
export function wallNow(zone: string = systemZone(), now: Date = new Date()): Wall {
  return instantToWall(now, zone);
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const WITH_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * 글자 → 벽시계.  파이썬 `datetime.fromisoformat(...)` + 정책의 local_time 과 같은 뜻.
 *  · 시간대가 없는 글자(2026-10-19T09:00:00 / 2026-10-19 09:00)는 **적힌 숫자 그대로**가 벽시계다.
 *  · Z·+09:00 이 붙은 글자는 `zone` 의 벽시계로 옮긴다.
 *  · 읽을 수 없으면 null.
 */
export function parseWall(text: string, zone: string = systemZone()): Wall | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (WITH_ZONE.test(s) && /\d{2}:\d{2}/.test(s)) {
    const t = new Date(s.replace(" ", "T"));
    if (Number.isNaN(t.getTime())) return null;
    return instantToWall(t, zone);
  }
  const m = NAIVE.exec(s);
  if (!m) return null;
  const w = wall(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  // 2월 31일 같은 값은 오류로 본다
  if (w.getUTCMonth() + 1 !== +m[2] || w.getUTCDate() !== +m[3]) return null;
  return w;
}

/**
 * 시간대가 있든 없든 하나의 순간(Date)으로 읽는다. 파이썬 `fromisoformat(x.replace("Z", "+00:00"))` 뒤에
 * 시간대 없는 값은 `.astimezone()`(이 컴퓨터 시각으로 봄)으로 맞추던 것과 같다.
 * 예약 시각(UTC 로 저장)과 사람이 적은 시각(이 컴퓨터 시각)을 같은 줄에 놓고 비교할 때 쓴다.
 */
export function parseInstant(text: string, zone: string = systemZone()): Date | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (WITH_ZONE.test(s) && /\d{2}:\d{2}/.test(s)) {
    const t = new Date(s.replace(" ", "T"));
    return Number.isNaN(t.getTime()) ? null : t;
  }
  const w = parseWall(s);
  return w ? wallToInstant(w, zone) : null;
}

/**
 * 시간대 표시(Z·+09:00)를 **무시하고** 적힌 숫자를 그대로 벽시계로 읽는다.
 * 파이썬 `datetime.fromisoformat(v.replace("Z", ""))` 와 같은 뜻 — 원장의 공개시각·예약시각을 읽을 때 쓴다
 * (원장은 이 컴퓨터 시각으로 적히므로 Z 가 붙어 있어도 옮기지 않는 것이 파이썬과 같은 값이다).
 */
export function parseNaive(text: string): Wall | null {
  const s = String(text ?? "").trim().replace(WITH_ZONE, "");
  return s ? parseWall(s) : null;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** 2026-10-19T09:00:00  (파이썬 isoformat(timespec="seconds")) */
export function isoWall(w: Wall): string {
  return `${w.getUTCFullYear()}-${p2(w.getUTCMonth() + 1)}-${p2(w.getUTCDate())}` +
    `T${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())}:${p2(w.getUTCSeconds())}`;
}

/** 10/19 09:00  (파이썬 strftime("%m/%d %H:%M") — 사람에게 보이는 글) */
export function shortWall(w: Wall): string {
  return `${p2(w.getUTCMonth() + 1)}/${p2(w.getUTCDate())} ${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())}`;
}

/** 2026-10-19 09:00  (publish_at 칸의 글자 꼴) */
export function minuteWall(w: Wall): string {
  return `${w.getUTCFullYear()}-${p2(w.getUTCMonth() + 1)}-${p2(w.getUTCDate())} ` +
    `${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())}`;
}

export function dateOnly(w: Wall): string {
  return `${w.getUTCFullYear()}-${p2(w.getUTCMonth() + 1)}-${p2(w.getUTCDate())}`;
}

/** 날짜 칸(YYYY-MM-DD)만 같은 날로 비교하기 좋게 */
export const sameDay = (a: Wall, b: Wall) => dateOnly(a) === dateOnly(b);

export const addMinutes = (w: Wall, n: number): Wall => new Date(w.getTime() + n * 분);
export const addHours = (w: Wall, n: number): Wall => new Date(w.getTime() + n * 시간);
export const addDays = (w: Wall, n: number): Wall => new Date(w.getTime() + n * 날);
export const diffMinutes = (a: Wall, b: Wall): number => (a.getTime() - b.getTime()) / 분;

/** 하루의 몇 시 몇 분으로 바꾼다 (같은 날짜) */
export function withTime(w: Wall, h: number, mi = 0, s = 0): Wall {
  return wall(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate(), h, mi, s);
}

/** 그날의 다음 날 hour 시 (파이썬 next_day) */
export function nextDayAt(w: Wall, hour: number): Wall {
  return wall(w.getUTCFullYear(), w.getUTCMonth() + 1, w.getUTCDate() + 1, hour, 0, 0);
}

export const wallHour = (w: Wall) => w.getUTCHours();
export const wallMinute = (w: Wall) => w.getUTCMinutes();

/* ─────────── 태평양 날짜 — 유튜브 할당량이 풀리는 기준 ─────────── */

/** 유튜브 API 할당량이 세는 그날(태평양 날짜). 서머타임은 Intl 이 안다. */
export function quotaDay(now: Date = new Date()): string {
  return dateOnly(instantToWall(now, "America/Los_Angeles"));
}

/**
 * 하루 업로드 한도가 풀리는 다음 시각 = 태평양 자정 + 10분 (파이썬 다음한도초기화).
 * 이 컴퓨터의 벽시계로 돌려준다.
 */
export function nextQuotaReset(now: Date = new Date(), zone: string = systemZone()): Wall {
  const la = instantToWall(now, "America/Los_Angeles");
  const next = wall(la.getUTCFullYear(), la.getUTCMonth() + 1, la.getUTCDate() + 1, 0, 10, 0);
  return instantToWall(wallToInstant(next, "America/Los_Angeles"), zone);
}

/** 다음 초기화까지 남은 시간 글 — 「3시간 12분 뒤」 */
export function untilQuotaReset(now: Date = new Date()): string {
  const la = instantToWall(now, "America/Los_Angeles");
  const next = wall(la.getUTCFullYear(), la.getUTCMonth() + 1, la.getUTCDate() + 1, 0, 0, 0);
  const min = Math.floor((next.getTime() - la.getTime()) / 분);
  return `${Math.floor(min / 60)}시간 ${min % 60}분 뒤`;
}

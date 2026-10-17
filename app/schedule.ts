// 업로드 시각을 정한다 — 4시간 이상 띄우고, 정각을 피한다. (파이썬: schedule.py)
//
// 왜 이렇게 하나
//   · 같은 채널에 몰아 올리면 노출이 서로 잡아먹는다. **최소 4시간**은 띄운다.
//   · 09:00, 12:00 처럼 정각에 딱딱 맞추면 기계가 돌리는 티가 난다. 사람이 올리는 것처럼 분 단위로 흩어 놓는다.
//
// ★ 무작위인데 미리보기와 실제가 같아야 한다 ★
//   그냥 난수를 쓰면 미리보기에서 본 시각과 실제 올라가는 시각이 달라진다. 그러면 미리보기가 아무 쓸모가 없다.
//   그래서 **날짜와 채널로 씨앗을 만들어** 같은 날 같은 채널이면 몇 번을 돌려도 같은 시각이 나오게 했다.
//   날이 바뀌면 자연히 다른 시각이 된다.
//
// 파이썬과 다른 점 (일부러)
//   · 난수기: 파이썬은 sha256 씨앗 + Mersenne Twister 였다. 여기서는 글자 해시 + mulberry32 라 같은 (날짜, 채널)에서 나오는
//     숫자가 파이썬과 다르다 — 성질(간격·창 안·결정성)은 같다.
//   · 간격: 파이썬은 마지막 칸을 창 끝으로 자른 뒤 간격을 다시 안 재서, 아주 드물게 4시간에서 1분이 모자랐다
//     (예: 창이 정확히 4시간의 배수일 때). 여기서는 칸마다 「간격을 지키면서 창 안에 들어갈 수 있는 자리」로 먼저 가둔 뒤 정한다.
//   · 정각: 파이썬은 흩뜨리기만 해서 1/60 확률로 정각이 나왔다. 여기서는 plan() 이 만든 시각이 정각이면 1~9분 비킨다.
//   · 시계: 파이썬은 now() 를 몰래 불렀다. 여기서는 「지금」을 인자로 받는다(함정 1.4 — 시각 코드는 지금을 받아야 한다).
import { addDays, addMinutes, dateOnly, minuteWall, parseWall, sameDay, type Wall, wallNow, withTime } from "./clock.ts";

/** 올리는 시각의 창 [시작 시, 끝 시) */
export type Window = [number, number];

export const DEFAULT_WINDOW: Window = [9, 22]; // 09시~22시 사이에 올린다
export const MIN_GAP_MIN = 240; // 최소 간격 4시간
export const JITTER_MIN = 55; // 슬롯마다 흩뜨릴 폭(분)
export const SPARE_MIN = 12; // 이미 지난 시각을 앞으로 밀 때, 지금에서 이만큼 뒤로

/* ============================================================ 씨앗 난수기 */

/** 글자 → 32비트 씨앗 (xmur3 변형) */
export function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 0 이상 1 미만의 난수를 내는 함수 (mulberry32) */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 같은 날·같은 채널이면 언제나 같은 난수열. (파이썬: schedule._rng) */
export function rngFor(dateStr: string, channel: string): () => number {
  return mulberry32(hashSeed(`${dateStr}|${channel}`));
}

/** 이상한 창이 들어와도 멈추지 않게 — 끝이 시작보다 늦지 않으면 기본 창으로 (채널 설정의 window 를 읽는 쪽도 이것을 쓴다) */
export function normalizeWindow(w: Window | number[] | undefined | null): Window {
  if (w && w.length === 2 && Number.isFinite(w[0]) && Number.isFinite(w[1]) && w[0] >= 0 && w[1] > w[0] && w[1] <= 24) {
    return [Math.trunc(w[0]), Math.trunc(w[1])];
  }
  return DEFAULT_WINDOW;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;

/* ============================================================ 계획 */

/**
 * (시각 목록 'HH:MM', 안내문). n개를 window 안에 4시간 이상 띄워 배치한다. (파이썬: schedule.plan)
 *
 * 남는 여유(창 길이 − 간격 합)를 칸 사이에 무작위로 나눠 주고(앞뒤로 쏠리지 않게), 칸마다 ±jitter/2 분 흩뜨린다.
 * 창에 다 못 들어가면 간격을 줄이지 않고 편수를 줄인다.
 */
export function plan(
  dateStr: string, channel: string, n: number,
  window: Window | number[] = DEFAULT_WINDOW, minGapMin = MIN_GAP_MIN, jitterMin = JITTER_MIN,
): [string[], string] {
  if (!(n > 0)) return [[], "올릴 것이 없습니다"];
  const [startH, endH] = normalizeWindow(window);
  const base = startH * 60;
  const limit = endH * 60 - 1; // 창 안에서 쓸 수 있는 마지막 분 (22시 창이면 21:59)
  const room = limit - base; // 첫 칸과 마지막 칸 사이에 쓸 수 있는 분
  let count = Math.trunc(n);
  let note = "";
  if ((count - 1) * minGapMin > room) {
    // 창이 좁아 다 못 넣는다 — 간격을 줄이지 않고 편수를 줄이는 쪽이 안전하다.
    const fit = Math.max(1, Math.floor(room / minGapMin) + 1);
    note = `${startH}~${endH}시 안에 ${Math.floor(minGapMin / 60)}시간 간격으로는 ${fit}개까지만 들어갑니다`;
    count = fit;
  }

  const rnd = rngFor(dateStr, channel);
  const slack = Math.max(0, room - (count - 1) * minGapMin);
  // 남는 여유를 칸 사이에 무작위로 나눠 준다. n+1 개를 뽑아 정렬하고 앞의 n 개를 쓴다(파이썬과 같은 모양).
  const cuts = Array.from({ length: count + 1 }, () => rnd() * slack).sort((a, b) => a - b);
  const jit = Array.from({ length: count }, () => (rnd() - 0.5) * jitterMin); // 정각을 흩뜨린다
  const nudge = Array.from({ length: count }, () => 1 + Math.floor(rnd() * 9)); // 정각이면 비킬 분(1~9)

  // i 번째 칸이 가도 되는 분의 범위 — 앞 칸들이 간격을 지키고, 뒤 칸들이 간격을 지킬 자리를 남긴다.
  const lo = (i: number) => base + i * minGapMin;
  const hi = (i: number) => Math.max(limit - (count - 1 - i) * minGapMin, lo(i));

  const mins: number[] = [];
  let prev: number | null = null;
  for (let i = 0; i < count; i++) {
    let pos = base + cuts[i] + i * minGapMin + jit[i];
    pos = Math.min(Math.max(pos, lo(i)), hi(i));
    if (prev !== null && pos - prev < minGapMin) pos = prev + minGapMin; // 간격은 절대 안 줄인다
    let m = Math.floor(pos);
    if (m % 60 === 0) {
      // 정각(분이 0)이면 기계가 돌리는 티가 난다 — 간격과 창을 지키는 쪽으로 조금 비킨다.
      const 뒤 = m + nudge[i];
      const 앞 = m - nudge[i];
      if (뒤 <= hi(i)) m = 뒤;
      else if (앞 >= Math.max(lo(i), prev !== null ? prev + minGapMin : base)) m = 앞;
    }
    mins.push(m);
    prev = m;
  }

  const times = mins.map(hhmm);
  const gaps = mins.slice(1).map((v, i) => v - mins[i]);
  return [
    times,
    note || (`${count}개 · 간격 ` +
      (gaps.length ? gaps.map((g) => `${Math.floor(g / 60)}시간${p2(g % 60)}분`).join("·") : "—")),
  ];
}

/** 오늘(또는 며칠 뒤) 날짜 글 'YYYY-MM-DD'. now 를 주면 그 벽시계 기준. (파이썬: schedule.today_str) */
export function todayStr(offsetDays = 0, now: Wall = wallNow()): string {
  return dateOnly(addDays(now, offsetDays));
}

function readHM(text: unknown): [number, number] {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(text ?? ""));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`시각을 읽지 못했습니다: ${JSON.stringify(text)} (예: 09:15)`);
  return [+m[1], +m[2]];
}

const minuteOfDay = (w: Wall) => w.getUTCHours() * 60 + w.getUTCMinutes();

/**
 * 이미 지난 시각을 앞으로 민다. `["YYYY-MM-DD HH:MM", ...]` 를 돌려준다. (파이썬: schedule.미래로)
 *
 * 왜 필요한가
 *   plan() 은 하루의 창(09~22시) 안에 고르게 흩는다. 지금이 몇 시인지는 보지 않는다. 그래서 저녁 8시에 올리면
 *   「오늘 15:32」 같은 **이미 지난 시각**이 나온다. 그 값을 publishAt 으로 보내면 유튜브가 거부하고 영상은 비공개인 채로 남는다.
 *
 * 어떻게 미나
 *   · 아직 안 지난 시각은 그대로 둔다
 *   · 지났으면 지금부터 조금 뒤(spareMin)로 옮긴다 — 창이 아직 열려 있을 때
 *   · 창이 닫혔으면 다음 날 같은 자리로 넘긴다
 *   · 어느 경우에도 간격(minGapMin)은 지킨다
 *   · 창 밖으로 나가면 창 안으로 되돌린다 — 자정을 넘기면 시(hour)가 작아지므로 양쪽을 다 본다(함정 5.3: 00:44·04:44 가 나온 적이 있다)
 *   · floor(우리가 더한 것): 이 시각보다 이르면 이 시각 이후로 민다 (같은 꼴의 마지막 예약 뒤에 이어 붙일 때)
 *
 * 사람이 정한 시각(채널 설정의 times)은 안 지난 한 그대로 둔다 — 정각을 흩뜨리는 것은 plan() 이 만든 시각의 몫이다.
 */
export function future(
  dateStr: string, times: string[], window: Window | number[] = DEFAULT_WINDOW,
  minGapMin = MIN_GAP_MIN, spareMin = SPARE_MIN, now: Wall = wallNow(), floor: Wall | null = null,
): string[] {
  if (!times.length) return [];
  const [startH, endH] = normalizeWindow(window);
  const 기본바닥 = addMinutes(now, spareMin);
  const 바닥 = floor && floor.getTime() > 기본바닥.getTime() ? floor : 기본바닥;

  // 날짜를 못 읽으면 오늘로 (파이썬: date.fromisoformat 실패 → date.today())
  const 날 = (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? parseWall(dateStr) : null) ?? withTime(now, 0);

  const out: string[] = [];
  let 앞것: Wall | null = null;
  times.forEach((text) => {
    const [h, m] = readHM(text);
    const 원래 = withTime(날, h, m);
    let t = 원래;

    if (t.getTime() < 바닥.getTime()) {
      // 오늘 창이 아직 열려 있으면 지금 바로 뒤로, 아니면 내일 같은 자리로
      if (minuteOfDay(바닥) < endH * 60 && sameDay(바닥, 날)) {
        t = withTime(바닥, 바닥.getUTCHours(), 바닥.getUTCMinutes());
        if (t.getUTCHours() < startH) t = withTime(t, startH, m % 60);
      } else {
        t = withTime(addDays(날, 1), h, m);
      }
    }
    // 바닥(예약 뒤)보다 이르면 바닥으로 — 위의 「내일 같은 자리」가 바닥에 못 미칠 수 있다
    if (floor && t.getTime() < floor.getTime()) {
      t = withTime(floor, floor.getUTCHours(), floor.getUTCMinutes() + (floor.getUTCSeconds() > 0 ? 1 : 0));
    }
    if (앞것 && t.getTime() - 앞것.getTime() < minGapMin * 60_000) t = addMinutes(앞것, minGapMin);

    // 창 밖으로 나갔으면 창 안으로 되돌린다.
    for (let 번 = 0; 번 < 400 && (t.getUTCHours() >= endH || t.getUTCHours() < startH); 번++) {
      t = t.getUTCHours() >= endH
        ? withTime(addDays(t, 1), startH, t.getUTCMinutes())
        : withTime(t, startH, t.getUTCMinutes());
    }
    앞것 = t;
    out.push(minuteWall(t));
  });
  return out;
}

/* ============================================================ 눈으로 보는 것 */

/** 파이썬 round() — 한가운데(.5)는 짝수 쪽으로 */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** 터미널용 막대. 0이어도 눈에 보이게 한 칸은 남긴다. (파이썬: schedule.bar) */
export function bar(value: number, total: number, width = 18, ch = "█", empty = "·"): string {
  if (total <= 0) return empty.repeat(width);
  const filled = value > 0 ? Math.max(1, roundHalfEven((value / total) * width)) : 0;
  // value 가 total 보다 크면 파이썬은 막대가 폭을 넘었다 — repeat 에 음수를 주면 던지므로 0 으로 막는다
  return ch.repeat(filled) + empty.repeat(Math.max(0, width - filled));
}

/** 하루를 한 줄로 그려 언제 올라가는지 눈으로 보여준다. (파이썬: schedule.timeline) */
export function timeline(times: string[], window: Window | number[] = DEFAULT_WINDOW, width = 46): string {
  const [startH, endH] = normalizeWindow(window);
  const span = (endH - startH) * 60;
  const row = Array.from({ length: width }, () => "─");
  for (const t of times) {
    const [h, m] = readHM(t);
    const at = h * 60 + m - startH * 60;
    const i = Math.max(0, Math.min(width - 1, roundHalfEven((at / span) * (width - 1))));
    row[i] = "▼";
  }
  return row.join("");
}

// 공개 시각을 나눠 준다 — 「몇 시에 뜨게 할까」.
//
// 왜 있나
//   쪽지(sidecar)에 `publishAt` 을 적으면 예약 공개가 되지만, **손으로 적어야** 썼다.
//   그래서 다섯 편이 한 시간 안에 쏟아져 서로 조회수를 갉아먹는 일이 생겼다.
//
// 무엇을 바꾸나
//   채널에 `publishSlots: ["07:00","12:00","19:00"]` 만 적어 두면, 올릴 때 **아직
//   안 찬 가장 이른 자리**를 알아서 물린다.
//
// ★올리는 것은 여전히 즉시다. 사용자 지시("언제든 승인 치면 지체없이 바로 업로드")와
//   부딪히지 않는다 — 올라가는 때가 아니라 **뜨는 때**만 나눈다.
// ★슬롯이 비어 있으면(기본값) 아무 일도 안 한다. 여태 그대로 돈다.

/** 슬롯 하나가 찼다고 보는 간격. 이 안에 이미 예약이 있으면 그 자리는 건너뛴다. */
const 겹침 = 30 * 60_000;
/** 지금부터 이만큼은 지나야 예약을 건다. 너무 붙으면 올리는 사이에 시각이 지나 버린다. */
const 최소여유 = 15 * 60_000;
/** 며칠 앞까지 자리를 찾아볼까 */
const 며칠 = 21;

/** `HH:MM` 을 그날의 시각으로 만든다 (이 컴퓨터의 시간대). */
function 그날그시각(기준: Date, 며칠뒤: number, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(기준.getFullYear(), 기준.getMonth(), 기준.getDate() + 며칠뒤, h, m, 0, 0);
  return d;
}

/**
 * 다음으로 쓸 공개 시각을 고른다. 쓸 자리가 없으면 빈 글자.
 *
 * @param slots  채널에 적어 둔 `HH:MM` 들
 * @param taken  이미 예약해 둔 시각들(RFC3339). 겹치지 않게 피한다.
 * @returns RFC3339 (UTC 꼴). 유튜브에 그대로 넘긴다.
 */
export function nextSlot(slots: string[], taken: string[], now = new Date()): string {
  if (!slots.length) return "";
  const 찬자리 = taken
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n) && n > now.getTime() - 86400_000);

  for (let 날 = 0; 날 <= 며칠; 날++) {
    for (const s of slots) {
      const t = 그날그시각(now, 날, s);
      const ms = t.getTime();
      if (ms < now.getTime() + 최소여유) continue;
      if (찬자리.some((x) => Math.abs(x - ms) < 겹침)) continue;
      return t.toISOString();
    }
  }
  return "";
}

/** 사람이 읽는 꼴 — "8월 22일(토) 07:00" */
export function 슬롯말(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const 요일 = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${요일}) ${p(d.getHours())}:${p(d.getMinutes())}`;
}

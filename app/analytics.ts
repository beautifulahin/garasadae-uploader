// 유튜브 스튜디오와 **같은 창구에서 같은 값**을 받아 온다 — YouTube Analytics API. (파이썬 분석.py)
//
// 왜 이 파일이 있나
//   기간 지표(48시간·7일·28일)는 우리가 두 시점의 스냅샷을 빼서 어림했다. 스튜디오 숫자와 맞을 수가 없었다 — 재는 방법
//   자체가 달랐다. 스튜디오가 쓰는 창구(YouTube Analytics API, reports.query)는 따로 있고, **이미 갖고 있는 youtube 권한으로
//   열린다.** 허용 범위 목록에 youtube 가 들어 있어서 재인증이 필요 없다.
//
// 무엇이 되나
//   · 하루 단위 조회수·시청시간·구독자 증감 — **지나간 날짜도 소급해서**
//   · 스튜디오 개요 카드와 같은 값: 조회수 / 시청 시간(시간) / 구독자
// 무엇이 안 되나 (스튜디오 전용이라 어떤 권한으로도 못 받는 것)
//   · 실시간 카드(지난 48시간·60분, 시간별) — API 에 아예 없다
//   · 노출수·노출 클릭률 — API 에 없다
//   · 마지막 1~2일은 유튜브가 아직 집계 중이라 값이 나중에 오른다(스튜디오 그래프 끝이 점선인 것과 같은 이유다)
//
// 날짜의 기준: 이 API 의 「하루」는 **태평양 시간**이다. 스튜디오 그래프도 같은 기준이라 날짜를 만지지 않고 그대로 보여 줘야
// 스튜디오와 값이 맞는다.
//
// 돈: Data API 와 다른 API 라 **통이 다르다.** 아무리 조회해도 10,000유닛에서 안 나간다(quota.ts 가 analytics.query 라는
// 이름의 딴 지갑으로 센다).
//
// 호출 규칙: **사람이 갱신을 눌렀을 때만 부른다.** 화면 그리기·주기 작업에서 부르면 안 된다.
import { dataPath, log, readJson, withFileLock, writeJson } from "./paths.ts";
import { addDays, dateOnly, isoWall, wallNow } from "./clock.ts";
import { ytFor } from "./ytcore.ts";
import { analyticsQuery } from "./youtube.ts";
import { cut, fixed, msgOf, pyRound } from "./stats.ts";

type Obj = Record<string, any>;

/** 한 번에 받아 두는 길이. 7·28·90·365일은 여기서 잘라 쓴다 */
export const PERIOD_DAYS = 365;

/** reports.query 한 번에 담는 지표. 순서가 rows 의 열 순서가 된다. */
export const METRICS = ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost",
  "likes", "comments", "shares"] as const;

export const analyticsPath = () => dataPath("분석기록.json");

/** 분석기록.json 한 채널 칸 */
export interface AnalyticsEntry {
  받은때: string;
  열: string[];
  /** [날짜, 조회수, 시청분, 구독얻음, 구독잃음, 좋아요, 댓글, 공유] */
  rows: any[][];
  /** 지난 28일 나라별 조회 — { 합, 상위: [[코드, 조회수], …] } */
  나라28?: { 합: number; 상위: [string, number][] };
  /** 쇼츠/롱폼 구분 일별 — [날짜, 종류, 조회수, 시청분, 참여조회] */
  종류?: any[][];
}
export type AnalyticsStore = Record<string, AnalyticsEntry>;

export async function loadAnalytics(): Promise<AnalyticsStore> {
  return await readJson<AnalyticsStore>(analyticsPath(), {});
}

/**
 * 이 채널의 일별 지표를 유튜브에서 받아 저장한다. 받은 날 수를 돌려준다. (파이썬: 분석.받기)
 * 호출은 채널당 **세 번**이다(일별 · 나라별 · 쇼츠/롱폼). 365일치를 통으로 받아 두고 7·28·90일은 저장본에서 잘라 계산한다.
 * 채널 등록이 안 됐으면 LookupError 가 그대로 올라간다.
 */
export async function fetchChannel(key: string, days = PERIOD_DAYS): Promise<number> {
  // 하루쯤 넘겨 불러도 유튜브가 있는 데까지만 준다
  const 끝 = wallNow();
  const 시작 = addDays(끝, -(days - 1));
  const yt = await ytFor(key);
  const r = await analyticsQuery(yt, {
    ids: "channel==MINE", startDate: dateOnly(시작), endDate: dateOnly(끝),
    metrics: METRICS.join(","), dimensions: "day", sort: "day",
  });
  const 줄들: any[][] = r.rows ?? [];
  const 칸: AnalyticsEntry = {
    받은때: isoWall(wallNow()),
    열: ["day", ...METRICS],
    rows: 줄들,
  };

  // 국가별 조회 분포(지난 28일) — 이 채널이 어느 나라에 먹히는지. 원하는 것은 「노출」 비율이지만 노출수는 API 에 없다(스튜디오
  // 전용). 조회수 비율이 사실상 같은 얘기라 그것으로 잰다. 부가 정보라 실패해도 일별 지표는 그대로 살린다.
  try {
    const r2 = await analyticsQuery(yt, {
      ids: "channel==MINE", startDate: dateOnly(addDays(끝, -27)), endDate: dateOnly(끝),
      metrics: "views", dimensions: "country", sort: "-views", maxResults: 200,
    });
    const 나라들: [string, number][] = (r2.rows ?? []).map((x: any[]) => [String(x[0]), Math.trunc(Number(x[1]) || 0)]);
    칸.나라28 = { 합: 나라들.reduce((a, [, v]) => a + v, 0), 상위: 나라들.slice(0, 5) };
  } catch (e) {
    await log(`  국가 분포는 못 받았습니다(${key}) — ${cut(msgOf(e), 60)}`);
  }
  // 쇼츠/롱폼 구분 일별(365일) — 수확 막대(쇼츠 조회·롱폼 시청시간)용. 부가라 실패해도 그대로.
  try {
    const r3 = await analyticsQuery(yt, {
      ids: "channel==MINE", startDate: dateOnly(시작), endDate: dateOnly(끝),
      metrics: "views,estimatedMinutesWatched,engagedViews", dimensions: "day,creatorContentType", sort: "day",
    });
    칸.종류 = r3.rows ?? [];
  } catch (e) {
    await log(`  쇼츠/롱폼 구분 실패(${key}) — ${cut(msgOf(e), 60)}`);
  }

  // 다른 채널을 받는 쪽(또는 다른 프로그램)이 같은 파일을 고치고 있어도 서로 안 지우게, 쓰는 순간에 다시 읽어 합친다.
  await withFileLock(dataPath("분석기록.lock"), async () => {
    const d = await loadAnalytics();
    d[key] = 칸;
    await writeJson(analyticsPath(), d, { indent: 0 });
  });
  return 줄들.length;
}

/** 여러 채널을 받는다. 한 채널이 터져도 나머지는 계속 간다. 값이 null 이면 그 채널은 실패. (파이썬: 분석.모두받기) */
export async function fetchAll(keys: string[], quiet = false): Promise<Record<string, number | null>> {
  const 난것: Record<string, number | null> = {};
  for (const k of keys) {
    try {
      const n = await fetchChannel(k);
      난것[k] = n;
      if (!quiet) await log(`  ${k.padEnd(14)} ${n}일치`);
    } catch (e) {
      난것[k] = null;
      if (!quiet) await log(`  ${k.padEnd(14)} 실패 — ${e instanceof Error ? e.name : "오류"}: ${cut(msgOf(e), 80)}`);
    }
  }
  return 난것;
}

/* ──────────────── 사람이 누를 때 한 번 (파이썬 serve._분석갱신) ──────────────── */

const 분석_간격 = 1800; // 초 (30분)
const 분석_마지막: { t: number; 결과: { 최근: boolean; 받음: string[]; 실패: string[] } | null } = { t: 0, 결과: null };

/**
 * 「리스트 갱신하기」 가 부르는 한 번. 30분 안에 다시 오면 유튜브를 부르지 않고 「최근에 받음」 만 돌려준다(분석 쿼터 보호).
 * (파이썬 serve._분석갱신 — 서버가 아닌 이쪽에 두어 다른 곳에서 같은 간격을 지키게 했다.)
 */
export async function refreshThrottled(
  keys: string[], now: number = Date.now() / 1000,
): Promise<{ 최근: boolean; 받음: string[]; 실패: string[] }> {
  if (분석_마지막.결과 !== null && now - 분석_마지막.t < 분석_간격) return { ...분석_마지막.결과, 최근: true };
  const got = keys.length ? await fetchAll(keys, true) : {};
  const res = {
    최근: false,
    받음: Object.entries(got).filter(([, v]) => v !== null).map(([k]) => k),
    실패: Object.entries(got).filter(([, v]) => v === null).map(([k]) => k),
  };
  분석_마지막.t = now;
  분석_마지막.결과 = res;
  return res;
}
/** 시험: 30분 표식을 지운다 */
export function resetThrottle() { 분석_마지막.t = 0; 분석_마지막.결과 = null; }

/* ============================================================ 저장본 읽기 (유튜브를 부르지 않는다) */

/** 저장본에 적힌 「받은때」 (없으면 빈 글) (파이썬: 분석.받은때) */
export async function receivedAt(key: string, store?: AnalyticsStore): Promise<string> {
  return String(((store ?? await loadAnalytics())[key]?.받은때) ?? "");
}

/** 자주 나오는 나라만 우리말로. 없는 코드는 코드 그대로 보여 준다 — 틀린 이름을 지어내는 것보다 낫다. */
export const 나라이름: Record<string, string> = {
  KR: "한국", US: "미국", JP: "일본", CA: "캐나다", AU: "호주",
  GB: "영국", DE: "독일", FR: "프랑스", IN: "인도", ID: "인도네시아",
  VN: "베트남", TH: "태국", TW: "대만", HK: "홍콩", PH: "필리핀",
  MY: "말레이시아", SG: "싱가포르", BR: "브라질", MX: "멕시코",
  RU: "러시아", CN: "중국", NZ: "뉴질랜드", NL: "네덜란드",
  ES: "스페인", IT: "이탈리아", TR: "튀르키예", SA: "사우디",
  AE: "아랍에미리트", EG: "이집트", PK: "파키스탄", BD: "방글라데시",
  UZ: "우즈베키스탄", KZ: "카자흐스탄", MN: "몽골",
};

/**
 * 「한국 92% · 미국 5%」 — 지난 28일 조회수 기준 상위 나라들. (파이썬: 분석.나라요약)
 * 자료가 없거나(아직 안 받음) 조회가 너무 적으면 빈 글 — 표본 몇 회로 나라 비율을 말하는 것은 거짓말에 가깝다.
 */
export async function countrySummary(key: string, n = 2, store?: AnalyticsStore): Promise<string> {
  const 나 = ((store ?? await loadAnalytics())[key]?.나라28) ?? ({} as Partial<NonNullable<AnalyticsEntry["나라28"]>>);
  const 합 = 나.합 || 0;
  const 상위 = 나.상위 || [];
  if (합 < 50 || !상위.length) return "";
  const 조각: string[] = [];
  for (const [코드, v] of 상위.slice(0, n)) {
    const 비 = (v / 합) * 100;
    조각.push(`${나라이름[코드] ?? 코드} ${비 >= 1 ? pyRound(비) : fixed(pyRound(비, 1), 1)}%`);
  }
  return 조각.join(" · ");
}

/** 기간 요약 한 건 (스튜디오 개요 카드와 같은 값) */
export interface PeriodSummary {
  일수: number; 조회수: number; 시청분: number; 시청시간: number; 구독자: number; 구독늘: number; 구독줄: number;
  좋아요: number; 댓글: number; 공유: number;
  하루: { 날: string; 값: number }[];
  쇼츠조회: number | null; 쇼츠참여조회: number | null; 롱폼시청시간: number | null;
  받은때: string;
}

const 정수 = (x: unknown): number => {
  const v = Number(x);
  return Number.isFinite(v) ? Math.trunc(v) : 0;
};

/**
 * 저장본에서 스튜디오 개요와 같은 요약을 만든다. 유튜브를 부르지 않는다. (파이썬: 분석.기간요약)
 * 스튜디오의 「지난 N일」은 오늘(태평양)을 포함한 마지막 N일이다. 같은 방식으로 자른다.
 */
export async function periodSummary(key: string, days: number, store?: AnalyticsStore): Promise<PeriodSummary | null> {
  const d = (store ?? await loadAnalytics())[key];
  const rows = d?.rows;
  if (!d || !rows?.length) return null;
  const 자를날 = dateOnly(addDays(wallNow(), -(days - 1)));
  const 창 = rows.filter((r) => String(r[0]) >= 자를날);
  const 합 = (i: number) => 창.reduce((a, r) => a + 정수(r[i]), 0);
  const 종 = (d.종류 ?? []).filter((r) => String(r[0]) >= 자를날);
  const 쇼츠 = (r: any[]) => String(r[1]).toLowerCase() === "shorts";
  return {
    일수: 창.length,
    조회수: 합(1),
    시청분: 합(2),
    시청시간: pyRound(합(2) / 60, 1),
    구독자: 합(3) - 합(4),
    구독늘: 합(3), 구독줄: 합(4),
    좋아요: 합(5), 댓글: 합(6), 공유: 합(7),
    하루: 창.map((r) => ({ 날: String(r[0]).slice(5).replace(/-/g, "/"), 값: 정수(r[1]) })),
    쇼츠조회: 종.length ? 종.filter(쇼츠).reduce((a, r) => a + 정수(r[2]), 0) : null,
    쇼츠참여조회: 종.length && 종.every((r) => r.length > 4)
      ? 종.filter((r) => 쇼츠(r) && r[4] !== null && r[4] !== undefined).reduce((a, r) => a + 정수(r[4]), 0)
      : null,
    롱폼시청시간: 종.length ? pyRound(종.filter((r) => !쇼츠(r)).reduce((a, r) => a + 정수(r[3]), 0) / 60, 1) : null,
    받은때: String(d.받은때 ?? ""),
  };
}

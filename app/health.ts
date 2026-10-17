// 채널 건전성 검사 — 이미 받아 둔 자료만으로, 유튜브 호출 0건. (파이썬 건강.py)
//
// 무엇을 보나 (전부 로컬)
//   성장     지난 28일 조회수 vs 그 전 28일          (분석기록)
//   구독     28일 순증과 이탈률(잃은÷얻은)            (분석기록)
//   리듬     이 업로더의 최근 14일 공개 최대 공백     (원장)
//   타율     이 업로더가 관리한 공개 영상 최근 10편의 하루 조회 (성적·원장)
//   시청     조회당 평균 시청 초                      (분석기록)
//   저작권   지역 차단·실종 흔적                      (성적 — 갱신 때 스캔)
//
// 판정은 좋음 · 주의 · 위험 · 몰라. 오래됐거나 모자란 자료로 좋음이나 위험을 단정하지 않는다.
// 채널 경고(스트라이크) 수는 API 가 안 준다. 그건 월 1회 스튜디오에서 눈으로 확인하는 것이 운영 수칙이다.
import { dataPath, readJson } from "./paths.ts";
import type { AnalyticsStore } from "./analytics.ts";
import { dateOnly, instantToWall, parseWall, systemZone, wallNow } from "./clock.ts";
import type { Wall } from "./clock.ts";
import { readLedger } from "./ledger.ts";
import type { LedgerRow } from "./ledger.ts";
import { commaFixed, commaInt, dayNum, fixed, parseDay, pyInt } from "./stats.ts";

type Obj = Record<string, any>;

export const 좋음 = "좋음", 주의 = "주의", 위험 = "위험", 몰라 = "몰라";
export const 캐시유효일 = 7;

export interface HealthLine { 항목: string; 등급: string; 말: string }
export interface HealthResult { 등급: string; 줄들: HealthLine[] }

const 하루ms = 86_400_000;

/** 이 글자를 이 컴퓨터의 벽시계로. 시간대가 붙어 있으면 이 컴퓨터 시각으로 옮긴다. 못 읽으면 null. */
function 시각(값: unknown): Wall | null {
  if (값 === null || 값 === undefined) return null;
  return parseWall(String(값), systemZone());
}

function 신선(때: Wall | null, 지금: Wall): boolean {
  if (!때) return false;
  const 차 = 지금.getTime() - 때.getTime();
  return 차 >= 0 && 차 <= 캐시유효일 * 하루ms;
}

/** 확인된 공개 영상과, 시각이 지났지만 공개 결과 미확인인 예약. */
function 원장게시(채널: string, 지금: Wall, 원장: LedgerRow[]): [Map<string, Wall>, Map<string, Wall>] {
  const 공개 = new Map<string, Wall>();
  const 미확인예약 = new Map<string, Wall>();
  const 오늘 = dayNum(지금);
  // 원장 파일이 없으면 readLedger() 가 빈 목록을 준다 — 공개 기록이 없는 것이다
  for (const r of 원장) {
    if ((r["채널"] ?? "").trim() !== 채널) continue;
    const 상태 = (r["공개설정"] ?? "").trim();
    const 영상 = (r["영상ID"] ?? "").trim();
    if (상태 === "public") {
      const 때 = 시각(r["공개시각"]);
      if (영상 && 때 && 때.getTime() <= 지금.getTime()) 공개.set(영상, 때);
    } else if (상태 === "예약") {
      const 때 = 시각(r["예약시각"]);
      if (영상 && 때 && 오늘 - 13 <= dayNum(때) && dayNum(때) <= 오늘 && 때.getTime() <= 지금.getTime()) 미확인예약.set(영상, 때);
    }
  }
  return [공개, 미확인예약];
}

function 리듬(공개: Map<string, Wall>, 미확인예약: Map<string, Wall>, 지금: Wall): [string, string] {
  const 오늘 = dayNum(지금);
  const 시작 = 오늘 - 13;
  const 날들 = new Set([...공개.values()].map(dayNum).filter((d) => 시작 <= d && d <= 오늘));
  const 예약날들 = new Set([...미확인예약.values()].map(dayNum).filter((d) => 시작 <= d && d <= 오늘));
  if (!공개.size) {
    return [몰라, 미확인예약.size ? `공개 결과 미확인 예약 ${미확인예약.size}편` : "확인된 공개 기록이 없습니다"];
  }
  const 첫날 = Math.min(...[...공개.values()].map(dayNum));
  const 관측시작 = Math.max(시작, 첫날);
  const 관측일 = 오늘 - 관측시작 + 1;
  if (관측일 < 7 || 공개.size < 3) {
    return [몰라, `공개 기록 ${관측일}일 · ${날들.size}일 게시 — 리듬 판단에는 이릅니다`];
  }

  const 최대공백 = (가정날들: Set<number>): number => {
    // 아직 끝나지 않은 오늘은 게시물이 없다는 이유만으로 공백에 넣지 않는다.
    const 끝날 = 가정날들.has(오늘) ? 오늘 : 오늘 - 1;
    let 공백 = 0, 연속 = 0;
    for (let i = 0; i < 끝날 - 관측시작 + 1; i++) {
      if (가정날들.has(관측시작 + i)) 연속 = 0;
      else { 연속++; 공백 = Math.max(공백, 연속); }
    }
    return 공백;
  };

  const 확인공백 = 최대공백(날들);
  if (!미확인예약.size) {
    const 등급 = 확인공백 >= 5 ? 주의 : 좋음;
    let 말 = `이 업로더 기록상 최근 14일 중 ${날들.size}일 게시 · 최대 공백 ${확인공백}일`;
    if (등급 === 주의) 말 += " — 다른 경로의 게시가 있다면 채널 실제 간격과 다를 수 있습니다";
    return [등급, 말];
  }
  // 미확인 예약이 모두 실패한 경우와 모두 게시된 경우를 모두 계산한다. 어느 쪽이든 같은 등급일 때만 판정한다.
  const 가능한공백 = 최대공백(new Set([...날들, ...예약날들]));
  if (확인공백 < 5) {
    return [좋음, `이 업로더에서 확인된 공개 ${날들.size}일 · 최대 공백 ${확인공백}일 이하 (예약 결과 미확인 ${미확인예약.size}편)`];
  }
  if (가능한공백 >= 5) {
    return [주의, `이 업로더 기록은 예약이 모두 공개됐어도 공백 ${가능한공백}일 (예약 결과 미확인 ${미확인예약.size}편)` +
      " — 다른 경로의 게시가 있다면 채널 실제 간격과 다를 수 있습니다"];
  }
  return [몰라, `예약 결과 미확인 ${미확인예약.size}편 때문에 리듬 판정 보류 — 상태 맞춤으로 확인하세요`];
}

/** 공개 후 48시간 지난 최근 10편을 게시 경과 일수당 조회수로 비교한다. */
function 타율(p: Obj, 공개: Map<string, Wall>, 잰때: Wall): [string, string] {
  const 후보: [Wall, number][] = [];
  const 자료: unknown = "전체조회" in p ? p["전체조회"] : "공개최근30" in p ? p["공개최근30"] : p["rows"];
  for (const r of (Array.isArray(자료) ? 자료 : []) as unknown[]) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) continue;
    const o = r as Obj;
    const 게시 = 공개.get(String(o.id || ""));
    const 경과일 = 게시 ? (잰때.getTime() - 게시.getTime()) / 하루ms : 0;
    if (경과일 < 2) continue;
    const 조회 = pyInt(o.views);
    if (조회 === null) continue;
    if (조회 >= 0) 후보.push([게시!, 조회 / 경과일]);
  }
  후보.sort((a, b) => b[0].getTime() - a[0].getTime());
  const 속도 = 후보.slice(0, 10).map((x) => x[1]).sort((a, b) => a - b);
  if (속도.length < 5) return [몰라, `이 업로더의 공개·48시간 경과 영상 ${속도.length}편 — 비교할 표본이 부족합니다`];
  const 중앙 = (속도[Math.floor((속도.length - 1) / 2)] + 속도[Math.floor(속도.length / 2)]) / 2;
  if (중앙 < 20) {
    return [몰라, `이 업로더 최근 ${속도.length}편 하루 조회 중앙 ${commaFixed(중앙, 0)}회 — 조회 규모가 작아 상대 타율은 보류합니다`];
  }
  const 터짐 = 속도.filter((v) => v >= 중앙 * 2).length;
  const 바닥 = 속도.filter((v) => v <= 중앙 * 0.2).length;
  const 등급 = 바닥 >= 4 && 터짐 === 0 ? 주의 : 좋음;
  return [등급, `이 업로더 최근 ${속도.length}편 하루 조회 중앙 ${commaFixed(중앙, 0)}회 · 2배↑ ${터짐}편 · 바닥 ${바닥}편`];
}

/** 분석기록의 한 열을 [시작, 끝) 날짜 글자 범위에서 더한다 */
function 합(rows: any[][], i: number, 시작: string, 끝: string): number {
  return rows.filter((r) => 시작 <= String(r[0]) && String(r[0]) < 끝).reduce((a, r) => a + (pyInt(r[i] || 0) ?? 0), 0);
}

/** evaluate 에 미리 읽어 둔 자료를 넘겨 파일을 되풀이해 읽지 않게 한다(채널 열 개를 한 화면에 그릴 때). 시각은 시험이 고정할 때만 준다. */
export interface HealthSrc {
  now?: Wall;
  analytics?: AnalyticsStore;
  perf?: Record<string, Obj>;
  ledger?: LedgerRow[];
}

/**
 * 채널 하나의 건전성. {"등급": 좋음|주의|위험|몰라, "줄들": [{"항목","등급","말"}]} (파이썬: 건강.평가)
 * 유튜브를 부르지 않는다 — 분석기록·성적·원장 파일만 읽는다.
 */
export async function evaluate(key: string, o: HealthSrc = {}): Promise<HealthResult> {
  const 줄들: HealthLine[] = [];
  const 넣기 = (항목: string, 등급: string, 말: string) => { 줄들.push({ 항목, 등급, 말 }); };

  const 지금 = o.now ?? wallNow();
  const 오늘 = dayNum(지금);

  // ── 성장·구독·시청 (분석기록) ─────────────────────────────
  const d = (((o.analytics ?? await readJson<Obj>(dataPath("분석기록.json"), {})) as Obj)[key] ?? {}) as Obj;
  const rows: any[][] = d.rows ?? [];
  let 마지막분석날: number | null = null;
  {
    // 한 줄이라도 날짜를 못 읽으면 통째로 못 읽은 것으로 본다(원본: max() 가 도중에 터지면 None)
    const 날번호들: number[] = [];
    let 읽음 = true;
    for (const r of rows) {
      const w = r ? parseDay(String(r[0]).slice(0, 10)) : null;
      if (!w) { 읽음 = false; break; }
      날번호들.push(dayNum(w));
    }
    if (읽음 && 날번호들.length) 마지막분석날 = Math.max(...날번호들);
  }
  const 분석날유효 = 마지막분석날 !== null && 오늘 - 마지막분석날 >= 0 && 오늘 - 마지막분석날 <= 3;
  if (!rows.length || !신선(시각(d.받은때), 지금) || !분석날유효) {
    const 이유 = !rows.length ? "지표 갱신을 누르면 채워집니다" : "분석 자료의 갱신 시각이 없거나 최근 날짜가 3일 넘게 비었습니다";
    for (const 항목 of ["성장", "구독", "시청"]) 넣기(항목, 몰라, 이유);
  } else {
    // Analytics 날짜는 태평양 기준이고 마지막 1~2일은 집계 중이다. 최근 기록일과 한국 시각 3일 전 중 이른 날짜까지 확정분으로 본다.
    const 기준날 = Math.min(마지막분석날!, 오늘 - 3);
    const 날글자 = (n: number) => dateOnly(new Date(n * 하루ms));
    const d28 = 날글자(기준날 - 27);
    const d56 = 날글자(기준날 - 55);
    const 내일 = 날글자(기준날 + 1);
    const 기간말 = `${날글자(기준날)}까지 28일`;
    const 요즘 = 합(rows, 1, d28, 내일);
    const 그전 = 합(rows, 1, d56, d28);
    if (그전 >= 100) {
      const 비 = 요즘 / 그전;
      const 등 = 비 <= 0.5 ? 위험 : 비 <= 0.8 ? 주의 : 좋음;
      넣기("성장", 등, `${기간말} ${commaInt(요즘)}회 (그 전 28일 대비 ${fixed(비, 1)}배)`);
    } else if (요즘 > 0) {
      넣기("성장", 몰라, `${기간말} ${commaInt(요즘)}회 — 이전 28일 표본이 적어 추세는 판단하지 않습니다`);
    } else {
      넣기("성장", 몰라, "최근 조회 기록이 없습니다");
    }

    const 얻 = 합(rows, 3, d28, 내일);
    const 잃 = 합(rows, 4, d28, 내일);
    if (얻 >= 5) {
      const 이탈 = 잃 / 얻;
      넣기("구독", 이탈 >= 0.5 ? 주의 : 좋음, `${기간말} +${얻} −${잃}` + (이탈 >= 0.5 ? ` — 이탈률 ${fixed(이탈 * 100, 0)}%` : ""));
    } else {
      넣기("구독", 몰라, `${기간말} +${얻} −${잃} — 표본이 적습니다`);
    }

    const 분 = 합(rows, 2, d28, 내일);
    if (요즘 >= 100) {
      const 초 = (분 * 60) / 요즘;
      넣기("시청", 몰라, `조회당 평균 ${fixed(초, 0)}초 — 영상 길이별 비교 전에는 판정하지 않습니다`);
    } else {
      넣기("시청", 몰라, "최근 조회 표본이 적어 시청 시간을 판단하지 않습니다");
    }
  }

  // ── 리듬 (확인된 공개 시각) ─────────────────────────────────
  const [공개, 미확인예약] = 원장게시(key, 지금, o.ledger ?? readLedger());
  const [리듬등급, 리듬말] = 리듬(공개, 미확인예약, 지금);
  넣기("리듬", 리듬등급, 리듬말);

  // ── 타율·저작권 (성적 캐시) ────────────────────────────────
  const p = ((o.perf ?? await readJson<Obj>(dataPath("성적.json"), {}))[key] ?? {}) as Obj;
  let 잰때: Wall | null = null;
  {
    const at = Number(p._at);
    if (p._at !== null && p._at !== undefined && Number.isFinite(at)) 잰때 = instantToWall(new Date(at * 1000));
  }
  if (!신선(잰때, 지금)) {
    const 이유 = !Object.keys(p).length ? "지표 갱신을 누르면 채워집니다" : "영상 성적의 갱신 시각이 없거나 7일이 넘었습니다";
    넣기("타율", 몰라, 이유);
    넣기("저작권", 몰라, 이유);
  } else {
    const [타율등급, 타율말] = 타율(p, 공개, 잰때!);
    넣기("타율", 타율등급, 타율말);

    // ── 저작권 흔적 (성적에 갱신 때 저장됨) ────────────────────
    const 실종: unknown[] = Array.isArray(p.실종) ? p.실종 : [];
    const 차단: Obj = p.차단 && typeof p.차단 === "object" ? p.차단 : {};
    if (실종.length) {
      넣기("저작권", 위험, `올라갔던 영상 ${실종.length}편이 유튜브 응답에서 사라짐 — ${String(실종[0]).slice(0, 30)}… 스튜디오에서 확인하세요`);
    } else if (Object.keys(차단).length) {
      넣기("저작권", 주의, `지역 차단 영상 ${Object.keys(차단).length}편 — 스튜디오에서 원인을 확인하세요`);
    } else if ("차단" in p && ((p.rows ?? []) as unknown[]).some((r) => r !== null && typeof r === "object" && (r as Obj).id)) {
      넣기("저작권", 좋음, "검사한 영상에서 지역 차단·실종 흔적 없음");
    } else {
      넣기("저작권", 몰라, "검사한 영상이 없거나 차단 검사가 완료되지 않았습니다");
    }
  }

  const 등급들 = 줄들.map((x) => x.등급);
  // 차단 흔적 없음과 상대 타율만으로 채널 전체를 건강하다고 단정하지 않는다.
  const 확실한좋음 = 줄들.some((x) => x.항목 === "성장" && x.등급 === 좋음) &&
    줄들.some((x) => ["구독", "리듬", "타율"].includes(x.항목) && x.등급 === 좋음);
  const 전체 = 등급들.includes(위험) ? 위험 : 등급들.includes(주의) ? 주의 : 확실한좋음 ? 좋음 : 몰라;
  return { 등급: 전체, 줄들 };
}

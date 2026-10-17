// 성과가 눈에 띄게 뛴 채널을 골라낸다 — 최근 3일 조회수·구독자 기준. (파이썬 spike.py)
//
// 무엇을 재나
//   채널 **전체** 조회수와 구독자가 최근 3일 동안 얼마나 늘었는지를, 그 채널의 평소 3일치 증가와 견준다.
//   2배가 넘으면 급등으로 본다.
//
// 왜 영상별 「하루 평균 조회수」 로 재지 않나
//   처음에는 그렇게 했다가 버렸다. 전 채널이 급등으로 나왔다(420배, 137배, 32배…). 전부 급등이면 급등이 아니다.
//   넉 달 된 영상의 「하루 평균」 은 조회수를 130일로 나눈 값이라 아주 작고, 어제 올린 영상은 나누는 날이 하루뿐이라 크다.
//   새 영상은 언제나 이긴다. 채널이 잘되고 있어서가 아니라 **새것이기 때문에** 이긴다. 그건 성과가 아니라 산수다.
//   그래서 영상이 아니라 채널 전체를 본다. 같은 잣대로 어제와 오늘을 견준다.
//
// 무엇과 견주나
//   **직전 3일**이다. 오늘부터 3일 전까지 늘어난 양을, 그 앞 3일(6일 전 ~ 3일 전)에 늘어난 양과 나란히 놓는다.
//   기록 전체의 평균과 견주지 않는다 — 평균은 오래된 잠잠하던 시절까지 끌고 들어와 지금 막 식은 채널도 급등으로 보이게 만든다.
//
// 무엇이 필요한가
//   `구독기록.json` 에 날마다 한 점씩. **7일치**(6일 전 점까지)가 있어야 판정한다.
//   구독자 수는 유튜브가 10명 단위로 반올림해서 준다. 그래서 구독자 급등은 증가폭이 그 반올림을 넘을 때만 말한다.
//   조회수는 반올림이 없어 그대로 쓴다.
import { log } from "./paths.ts";
import { loadSubs } from "./subs.ts";
import { cut, dayNum, fixed, msgOf, parseDay, pyRound, signedComma } from "./stats.ts";

export const 배수기준 = 2.0; // 직전 3일의 몇 배부터 「급등」 인가
export const 창 = 3; // 최근 며칠을 보나
export const 필요폭 = 창 * 2; // 두 구간을 보려면 이만큼(6일)은 지나 있어야 한다
export const 조회_바닥 = 300; // 이보다 적게 는 것은 잡음으로 본다
export const 구독_바닥 = 10; // 유튜브 반올림 폭

/** 한 종목(조회수 또는 구독자)의 판정 */
export interface SpikePart { 최근: number; 평소: number; 배수: number | null; 급등: boolean }

export interface SpikeResult {
  /** true 면 강조한다 */
  급등: boolean;
  조회: SpikePart | null;
  구독: SpikePart | null;
  /** 화면에 띄울 한 줄 */
  말: string;
  /** 쌓인 날 수 */
  점수: number;
  /** 판정까지 며칠 더 필요한가(0이면 판정 중) */
  남은날: number;
}

/** [(하루 번호, 조회수, 구독자), ...] 오래된 것부터. */
type Point = [number, number | null, number | null];

function points(d: Record<string, Record<string, any>>): Point[] {
  const 난것: Point[] = [];
  for (const 날 of Object.keys(d).sort()) {
    const x = parseDay(날);
    if (!x) continue;
    const v = d[날] ?? {};
    난것.push([dayNum(x), v.views ?? null, v.subs ?? null]);
  }
  return 난것;
}

/** 그 날짜 이전(같은 날 포함)의 마지막 점. 없으면 null. */
function 자리(기록: Point[], 몇일전: number): Point | null {
  const 기준 = 기록[기록.length - 1][0] - 몇일전;
  const 앞 = 기록.filter((r) => r[0] <= 기준);
  return 앞.length ? 앞[앞.length - 1] : null;
}

/** 조회수(자리 1)나 구독자(자리 2) 하나를 본다 — 최근 3일 vs 직전 3일. */
function 한종목(기록: Point[], idx: 1 | 2, 바닥: number): SpikePart | null {
  const 값 = 기록.filter((r) => r[idx] !== null);
  if (값.length < 2) return null;

  const 끝날 = 값[값.length - 1][0], 끝값 = 값[값.length - 1][idx] as number;
  const 가운데 = 자리(값, 창); // 3일 전
  const 처음 = 자리(값, 창 * 2); // 6일 전
  if (!가운데 || !처음) return null;
  if (가운데[0] === 끝날 || 처음[0] === 가운데[0]) return null; // 두 구간이 겹치면 견줄 수 없다

  let 최근 = 끝값 - (가운데[idx] as number);
  let 직전 = (가운데[idx] as number) - (처음[idx] as number);

  // 구간이 정확히 3일이 아닐 수 있다(기록이 빠진 날). 하루치로 고쳐 3일로 맞춘다.
  // 안 맞추면 4일짜리 구간이 3일짜리를 이겨서 가짜 급등이 난다.
  const 최근일 = Math.max(끝날 - 가운데[0], 1);
  const 직전일 = Math.max(가운데[0] - 처음[0], 1);
  최근 = pyRound((최근 / 최근일) * 창);
  직전 = pyRound((직전 / 직전일) * 창);

  if (최근 < 바닥) return { 최근, 평소: 직전, 배수: null, 급등: false };
  if (직전 <= 0) {
    // 직전 3일에는 안 늘다가 늘기 시작했다 — 배수는 못 내지만 이건 급등이다
    return { 최근, 평소: 직전, 배수: null, 급등: true };
  }
  const 배 = 최근 / 직전;
  return { 최근, 평소: 직전, 배수: pyRound(배, 1), 급등: 배 >= 배수기준 };
}

/** 이 채널이 최근 3일 동안 평소보다 크게 뛰었나. (파이썬: spike.judge) */
export async function judge(name: string): Promise<SpikeResult> {
  const 기록 = points((await loadSubs())[name] ?? {});
  const 폭 = 기록.length >= 2 ? 기록[기록.length - 1][0] - 기록[0][0] : 0;
  const out: SpikeResult = {
    급등: false, 조회: null, 구독: null, 말: "", 점수: 기록.length, 남은날: Math.max(필요폭 - 폭, 0),
  };
  if (폭 < 필요폭) {
    const 남 = out.남은날;
    out.말 = 기록.length ? `${기록.length}일째 기록 중 — ${남}일 뒤부터 판정합니다` : "기록이 없습니다";
    return out;
  }

  out.조회 = 한종목(기록, 1, 조회_바닥);
  out.구독 = 한종목(기록, 2, 구독_바닥);

  const 말들: string[] = [];
  for (const [이름, r] of [["조회수", out.조회], ["구독자", out.구독]] as const) {
    if (r && r.급등) {
      out.급등 = true;
      // 파이썬은 배수가 실수라 「11.0배」 로 찍는다 — 사람이 읽는 문구가 같도록 소수 한 자리로 맞춘다
      말들.push(r.배수 ? `${이름} ${fixed(r.배수, 1)}배` : `${이름} 늘기 시작`);
    }
  }
  if (말들.length) {
    out.말 = `최근 ${창}일 ${말들.join(" · ")} (직전 ${창}일 대비)`;
  } else {
    const 조 = out.조회;
    out.말 = 조 ? `최근 ${창}일 조회 ${signedComma(조.최근)} · 직전 ${창}일 ${signedComma(조.평소)}` : "판정할 만큼 안 쌓였습니다";
  }
  return out;
}

/**
 * 여러 채널을 한꺼번에. 하나가 터져도 나머지는 계속 간다. (파이썬: spike.all_judge)
 * 원본은 터진 자리의 「남은날」 에 정의되지 않은 이름(최소점)을 써서 그 자리에서 또 터졌다 — 여기서는 필요폭으로 채운다.
 */
export async function allJudge(names: string[]): Promise<Record<string, SpikeResult>> {
  const 난것: Record<string, SpikeResult> = {};
  for (const n of names) {
    try {
      난것[n] = await judge(n);
    } catch (e) {
      await log(`  ${n} 급등 판정을 못 했습니다 — ${cut(msgOf(e), 70)}`);
      난것[n] = { 급등: false, 조회: null, 구독: null, 말: "", 점수: 0, 남은날: 필요폭 };
    }
  }
  return 난것;
}

// 구독자·조회수를 날마다 한 점씩 적어 둔다. (파이썬 subs.py)
//
// 구독기록.json
//   { "채널이름": { "2026-08-27": {"subs": 1720, "views": 1083041, "videos": 27} } }
// 하루에 한 점만 남긴다. 같은 날 여러 번 갱신하면 마지막 값으로 덮는다.
// 구독자를 숨긴 채널(subs 가 null)은 건너뛴다.
//
// 정확도
//   Data API 는 유효숫자 3자리로 내림한다. 1,724명은 1720 으로 온다. 1,000명 미만은 1명 단위로 읽힌다.
//   (스튜디오 화면에서 정확값을 읽는 장치는 이 앱에 없다 — 그래서 예전 점과 비교한 증감에는 그 점의 내림 오차가 남을 수 있다.)
import { dataPath, log, readJson, recordPath, withFileLock, writeJson, writeTextAtomic } from "./paths.ts";
import { addDays, dateOnly, wallNow } from "./clock.ts";
import { loadChannels } from "./channels.ts";
import { loadStore } from "./ytcore.ts";
import { cut, dayNum, msgOf, multiChannelMetrics, parseDay, signedComma } from "./stats.ts";

type Obj = Record<string, any>;
export const subsPath = () => dataPath("구독기록.json");

/** 반올림 폭이 이보다 작다고 믿지 않는다 */
export const STEP = 10;

export async function loadSubs(): Promise<Record<string, Record<string, Obj>>> {
  return await readJson<Record<string, Record<string, Obj>>>(subsPath(), {});
}

/** 오늘 값을 남긴다. 구독자를 숨긴 채널은 건너뛴다. */
export async function record(
  name: string, subs: number | null | undefined, views?: number | null, videos?: number | null,
  o: { exact?: boolean | null; source?: string | null } = {},
): Promise<void> {
  if (subs === null || subs === undefined) return;
  await withFileLock(dataPath("구독기록.lock"), async () => {
    const d = await loadSubs();
    const 오늘 = dateOnly(wallNow());
    const 점: Obj = {
      subs: Math.trunc(Number(subs)),
      views: views === null || views === undefined ? null : Math.trunc(Number(views)),
      videos: videos === null || videos === undefined ? null : Math.trunc(Number(videos)),
    };
    if (o.exact !== null && o.exact !== undefined) 점.exact = !!o.exact;
    if (o.source !== null && o.source !== undefined) 점.source = o.source;
    (d[name] ??= {})[오늘] = 점;
    await writeJson(subsPath(), d, { indent: 1 });
  });
}

/* ============================================================ 읽기 */

/**
 * [(날짜, 구독자), ...] 오래된 것부터. 없는 날은 비운다(채우지 않는다). (파이썬: subs.흐름)
 */
export async function flow(name: string, days = 30): Promise<[string, number][]> {
  const d = (await loadSubs())[name] ?? {};
  return flowOf(d, days);
}

function flowOf(d: Record<string, Obj>, days: number): [string, number][] {
  const 끝 = dateOnly(wallNow());
  const 시작 = dateOnly(addDays(wallNow(), -(days - 1)));
  const 난것: [string, number][] = [];
  for (const 날 of Object.keys(d).sort()) {
    if (!parseDay(날)) continue;
    const v = d[날];
    if (시작 <= 날 && 날 <= 끝 && v && v.subs !== null && v.subs !== undefined) 난것.push([날, Math.trunc(Number(v.subs))]);
  }
  return 난것;
}

/** 구독자 증감 요약 한 건 */
export interface SubSummary {
  점수: number; 최근: number | null; 하루: number | null; 이레: number | null; 한달: number | null;
  믿음: boolean; 말: string;
}

/**
 * 화면에 쓸 값. (파이썬: subs.요약)
 *
 *   점수  기록된 날 수 · 최근  마지막으로 적은 구독자 수 · 하루  바로 앞 점 대비 증감
 *   이레  7일 전 대비 · 한달  30일 전 대비 · 믿음  하루치를 믿어도 되는지(반올림 폭 10명 이상 움직였을 때만 true — 값은 그대로 준다)
 *   말  사람에게 보여 줄 한 줄
 */
export async function summary(name: string): Promise<SubSummary> {
  return summaryOf(flowOf((await loadSubs())[name] ?? {}, 40));
}

export function summaryOf(흐: [string, number][]): SubSummary {
  const out: SubSummary = {
    점수: 흐.length, 최근: 흐.length ? 흐[흐.length - 1][1] : null,
    하루: null, 이레: null, 한달: null, 믿음: false, 말: "",
  };
  if (!흐.length) { out.말 = "기록을 오늘부터 쌓습니다"; return out; }
  if (흐.length < 2) { out.말 = "첫 기록입니다 — 내일부터 증감이 보입니다"; return out; }

  const [끝날, 끝값] = 흐[흐.length - 1];
  const 오늘 = dayNum(parseDay(끝날)!);
  const 며칠전 = (n: number): [string, number] | null => {
    const 기준 = 오늘 - n;
    const 뒤 = 흐.filter(([d]) => dayNum(parseDay(d)!) <= 기준);
    return 뒤.length ? 뒤[뒤.length - 1] : null;
  };

  const 앞 = 흐[흐.length - 2];
  out.하루 = 끝값 - 앞[1];
  for (const [키, n] of [["이레", 7], ["한달", 30]] as const) {
    const g = 며칠전(n);
    if (g) out[키] = 끝값 - g[1];
  }

  // 반올림 폭보다 작은 변화는 「0」 이 아니라 「모른다」 다. 여기서 0 이라고 단정하면 늘어나고 있는 채널이 멈춘 것처럼 보인다.
  out.믿음 = Math.abs(out.하루 ?? 0) >= STEP;
  // 1명이 바뀌어도 그대로 말한다. 다만 유튜브가 10명 단위로 반올림해서 주므로, 그보다 작은 실제 변화는 며칠 뒤에
  // 한꺼번에 나타난다. 그 사실은 설명(툴팁)에만 적고 숫자 자리는 있는 그대로 둔다.
  if (out.하루 !== null) out.말 = `어제보다 ${signedComma(out.하루)}명`;
  else if (out.이레 !== null) out.말 = `일주일 ${signedComma(out.이레)}명`;
  else out.말 = "기록을 쌓는 중입니다";
  return out;
}

/* ============================================================ 찍기 */

/**
 * 오늘 점이 없는 채널만 골라 찍는다. 채널당 1유닛. (파이썬: subs.오늘찍기)
 *
 * 갱신 단추를 안 누르는 날이 생기면 기록에 구멍이 난다. 구멍이 나면 「최근 3일」 을 셀 수 없다. 그래서 하루 한 번은
 * 저절로 찍히게 해 둔다. 반환: 찍은 채널 수.
 */
export async function snapToday(quiet = false): Promise<number> {
  const { fetchProfile, remember } = await import("./profile.ts");
  const 있는것 = await loadSubs();
  const 오늘 = dateOnly(wallNow());
  let 찍음 = 0;
  const 본채널 = new Set<string>(); // 한 채널을 두 이름으로 등록했을 수 있다(쇼츠/롱폼)
  const 설정 = loadChannels();
  const 토큰 = loadStore();
  for (const name of Object.keys(설정)) {
    const cid = String(설정[name]?.channel_id ?? "");
    if (cid && 본채널.has(cid)) continue; // 같은 채널을 두 번 물으면 유닛만 두 배로 나간다
    if (오늘 in (있는것[name] ?? {})) { 본채널.add(cid); continue; }
    let pr: Obj;
    try {
      // 별칭이 토큰 목록에 없을 수 있다(롱폼처럼 덧붙인 이름). 그럴 때는 채널ID 로 찾는다 — ytFor 가 둘 다 받는다.
      pr = await fetchProfile(name in 토큰 ? name : (cid || name));
    } catch (e) {
      // 실패해도 「오늘 해봤다」 는 남긴다. 안 남기면 5분마다 도는 작업이 **같은 채널을 하루 종일 다시 부른다.**
      // 한도가 바닥난 날에는 10채널 × 288회 = 2,880번이 헛돈다. 실패 기록을 남겨 그날은 한 번만 시도하게 한다.
      await withFileLock(dataPath("구독기록.lock"), async () => {
        const d = await loadSubs();
        (d[name] ??= {})[오늘] = { subs: null, views: null, videos: null, 못함: cut(msgOf(e), 120) };
        await writeJson(subsPath(), d, { indent: 1 });
      });
      if (!quiet) await log(`  ${name} — ${cut(msgOf(e), 70)}`);
      continue;
    }
    pr = await remember(pr);
    for (const [alias, cf] of Object.entries(설정)) {
      if (cf.channel_id === pr.channel_id) {
        await record(alias, pr.subscribers, pr.views, pr.videos, { exact: pr.subscribers_exact, source: pr.subscribers_source });
      }
    }
    if (cid) 본채널.add(cid);
    찍음++;
  }
  if (!quiet) await log(찍음 ? `  구독·조회 기록 ${찍음}개 채널 찍음` : "  오늘 몫은 이미 다 찍혀 있습니다");
  return 찍음;
}

const 영상찍기_사이 = 2 * 3600; // 초. 이만큼 지났으면 다시 찍는다

/**
 * 영상별 조회수를 하루 한 점씩(그리고 시각별로) 남긴다. **하루 조회수 그래프의 밑재료다.** (파이썬: subs.영상찍기)
 *
 * 왜 자동으로 돌려야 하나
 *   이 기록은 그동안 사람이 「갱신」 을 누를 때만 쌓였다. 하루라도 안 누르면 그날 점이 없고, 점이 없으면 **그 날짜의
 *   하루 조회수를 영영 못 낸다.** 지나간 날은 유튜브에 물어봐도 알 수 없다(누적값만 준다). 사람 손에 맡기면 안 된다.
 * 하루 한 번이 아니라 **몇 시간에 한 번** 찍는다(2시간 간격 표식: 기록/영상찍은때.txt) — 하루 한 점만 있으면
 * 「어제 대비」 가 나오기까지 하루를 꼬박 기다려야 하고 그동안 그래프가 비어 있다.
 * 비용: 채널당 1유닛(목록) + 전체 1유닛(일괄 통계). 10채널이면 11 안팎.
 */
export async function snapVideos(quiet = false): Promise<number> {
  const 표 = recordPath("영상찍은때.txt");
  const 이제 = Date.now() / 1000;
  try {
    const 지난때 = parseFloat((await Deno.readTextFile(표)).trim());
    if (Number.isFinite(지난때) && 이제 - 지난때 < 영상찍기_사이) {
      if (!quiet) await log(`  ${Math.trunc((영상찍기_사이 - (이제 - 지난때)) / 60)}분 뒤에 다시 찍습니다`);
      return 0;
    }
  } catch (e) {
    // 표식 파일이 없는 것은 정상(처음 찍는다). 다른 까닭(권한 등)이면 한 줄 남기고 그냥 찍는다.
    if (!(e instanceof Deno.errors.NotFound)) await log(`  영상 찍은 때 표식을 읽지 못했습니다 — ${cut(msgOf(e), 60)}`);
  }

  const 이름들 = Object.keys(loadChannels());
  if (!이름들.length) return 0;
  // lift.ts 는 이 파일의 loadSubs 를 가져다 쓰므로 순환을 피하려고 여기서만 늦게 불러온다
  const LF = await import("./lift.ts");
  let 모두: Awaited<ReturnType<typeof multiChannelMetrics>>;
  try {
    모두 = await multiChannelMetrics(이름들);
  } catch (e) {
    await log(`  영상 기록을 읽지 못했습니다 — ${cut(msgOf(e), 80)}`);
    return 0;
  }

  let 찍음 = 0;
  for (const [name, rows] of Object.entries(모두)) {
    if (!rows.length) continue;
    try {
      await LF.record(name, rows); // 하루 한 점 (일별 그래프용)
      await LF.recordFrequent(name, rows); // 시각별 점 (48시간 그래프용)
      찍음++;
    } catch (e) {
      await log(`  ${name} 영상 기록 실패 — ${cut(msgOf(e), 70)}`);
    }
  }
  try {
    await writeTextAtomic(표, String(이제));
  } catch (e) {
    await log(`  찍은 때를 적지 못했습니다 — ${msgOf(e)}`);
  }
  if (!quiet) await log(`  영상별 조회수 ${찍음}개 채널 찍음`);
  return 찍음;
}

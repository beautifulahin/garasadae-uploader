// 하루 한도 시험 — 일 한도 편성기(app/daily.ts).
//
// 원본(파이썬) 시험 네 개의 **계산 부분**을 같은 기대값으로 옮겼다:
//   파이썬 일 한도 시험 넷(고정 6편 · 쇼츠만 · 롱폼만 · 즉시)
// (대기열 파일을 직접 쓰는 발사 모듈·받기 모듈은 이 시험의 몫이 아니다 — 거기서 부르는 계산만 본다.)
// 그 위에 새 앱에서 일반화한 것들: 정책 파일 읽기·쓰기, 깨진 정책 파일, 승인형 정책, 앞당기기 표, 동시 업로드 잠금.
//
// 채널 이름·ID 는 모두 가짜다. 정책 파일은 모래상자(임시 데이터 폴더)에 writePolicy 로 만든다.
// 「지금」은 setDailyClock 으로 얼린다(파이썬 시험이 dt.datetime 을 얼리던 자리).
import { 같나, 결과, 구역, 던지나, 모래상자, 영상쓰기, 참인가 } from "./도구.ts";
import {
  counts, DailyLimitReached, describePolicy, type Job, loadPolicies, policyForChannel, reflow, removePolicy, repack,
  repackReport, requirePublication, SCHEMA_APPROVED, SCHEMA_V1, SCHEMA_V2, setDailyClock, uploadSlot, writePolicy,
} from "../app/daily.ts";
import { isoWall, minuteWall, parseWall, shortWall, systemZone, type Wall, wall, wallToInstant } from "../app/clock.ts";
import { appendLedger, LEDGER_HEAD, type LedgerRow, readLedger, writeLedgerRaw } from "../app/ledger.ts";
import { baseName, dataDir, dataPath, existsSync, readJsonSync, recordPath } from "../app/paths.ts";
import { forceToolMissing } from "../app/tools.ts";

/* ─────────── 가짜 채널 ───────────
   UC 로 시작하는 24자 글자는 소스에 직접 쓰지 않고 만든다(공통 규칙 3). */
const 아이디 = (c: string) => "UC" + c.repeat(22);
const A = 아이디("a"), B = 아이디("b"), C = 아이디("c"), D = 아이디("d"), Z = 아이디("z"), Q = 아이디("q");

type 정책입력 = Parameters<typeof writePolicy>[0];
/** 일 6편 · 종류 구분 없음 (원본의 첫 정책 꼴) */
const 정책A: 정책입력 = {
  label: "채널A", channel_id: A, aliases: ["채널A"], timezone: "Asia/Seoul",
  daily_limit: 6, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50,
};
/** 일 6편 · 쇼츠만 · 공개 예정 순서가 기준 */
const 정책B: 정책입력 = {
  label: "채널B", channel_id: B, aliases: ["채널B"], kind: "쇼츠", order_by: "publish_at", timezone: "Asia/Seoul",
  daily_limit: 6, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50,
};
/** 일 2편 · 롱폼만 · 공개 예약만 제한(업로드는 그대로) · 밀리면 09시 */
const 정책C: 정책입력 = {
  label: "채널C 롱폼", channel_id: C, aliases: ["채널C"], kind: "롱폼", cap_uploads: false, timezone: "Asia/Seoul",
  daily_limit: 2, day_start_hour: 7, overflow_day_start_hour: 9, publish_gap_minutes: 120, review_lead_minutes: 50,
};
/** 승인형 — 일 6편 · 올린 뒤 10분 · 밀리면 07시 */
const 정책D: 정책입력 = {
  schema: SCHEMA_APPROVED, label: "채널D", channel_id: D, aliases: ["채널D"], timezone: "Asia/Seoul",
  daily_limit: 6, publish_delay_minutes: 10, overflow_day_start_hour: 7,
};

/* ─────────── 작은 도구 ─────────── */
const 키순 = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 키 순서와 상관없이 같은가 (파이썬 dict 비교) */
function 정규(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(정규);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => 키순(a, b)).map(([k, x]) => [k, 정규(x)]));
  }
  return v;
}
const 같은가 = (무엇: string, 실제: unknown, 바람: unknown) => 같나(무엇, 정규(실제), 정규(바람));
/** 파이썬 collections.Counter(j[칸][:10] for j in rows) — 날짜순 */
function 날짜별(rows: Job[], 칸: string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) { const k = String(r[칸]).slice(0, 10); m[k] = (m[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => 키순(a, b)));
}
const 맵 = (m: Map<string, number>) => Object.fromEntries([...m].sort(([a], [b]) => 키순(a, b)));
const 시 = (w: Wall) => minuteWall(w).slice(11); // HH:MM
const W = (s: string): Wall => parseWall(s)!;
const 초뒤 = (w: Wall, s: number): Wall => new Date(w.getTime() + s * 1000);
const 두자리 = (n: number) => String(n).padStart(2, "0");
/** 정책 시간대의 이 벽시계를 지금으로 얼린다 */
const 얼리기 = (w: Wall, zone = "Asia/Seoul") => setDailyClock(() => wallToInstant(w, zone));

/** 원장 줄 하나 — 쇼츠는 세로 41초, 롱폼은 가로 130초 */
function 원장줄(채널: string, 영상ID: string, 업로드: string, 예약 = "", 종류: "쇼츠" | "롱폼" = "쇼츠", 공개 = ""): LedgerRow {
  const 길 = 종류 === "롱폼";
  return {
    채널, 영상ID, 업로드시각: 업로드, 예약시각: 예약, 공개시각: 공개, 파일: `/led/${영상ID}.mp4`,
    해상도: 길 ? "1920x1080" : "1080x1920", 길이초: 길 ? "130.0" : "41.0",
  };
}
async function 원장쓰기(rows: LedgerRow[]) {
  await writeLedgerRaw([[...LEDGER_HEAD], ...rows.map((r) => LEDGER_HEAD.map((h) => r[h] ?? ""))]);
}
const 대기쓰기 = (rows: unknown[]) => Deno.writeTextFile(dataPath("pending.json"), JSON.stringify(rows));

/** 던지지 말아야 하는 일 — 던지면 시험 전체가 멈추지 않고 이 한 줄만 틀린 것으로 센다 */
async function 안던지나(무엇: string, 함수: () => unknown | Promise<unknown>) {
  try {
    await 함수();
    같나(무엇, true, true);
  } catch (e) {
    같나(`${무엇} — 던지지 말아야 하는데 던졌다: ${e instanceof Error ? e.message : e}`, false, true);
  }
}

async function 한도에걸리나(무엇: string, 함수: () => Promise<unknown>, 글귀?: RegExp) {
  try {
    await 함수();
    같나(`${무엇} — 던져야 한다`, "안 던졌다", "DailyLimitReached");
  } catch (e) {
    const 맞나 = e instanceof DailyLimitReached && (글귀 ? 글귀.test(e.message) : true);
    같나(무엇, 맞나, true);
    if (!맞나) console.log(`     (받은 오류: ${e instanceof Error ? e.message : e})`);
  }
}

/** 기록/서버.log 에 이 글들이 다 나올 때까지 기다린다(정책 읽기 오류는 기록을 기다리지 않고 남긴다) */
async function 기록을기다리기(...글들: string[]): Promise<string> {
  let 본문 = "";
  for (let i = 0; i < 60; i++) {
    try { 본문 = await Deno.readTextFile(recordPath("서버.log")); } catch { 본문 = ""; }
    if (글들.every((g) => 본문.includes(g))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return 본문;
}
const 몇번나오나 = (본문: string, 글: string) => 본문.split(글).length - 1;

/* ─────────── 원본 시험의 재료 ─────────── */

// (파이썬 시험: 고정 6편) — 하루 시작 07시, 간격 2시간, 올린 뒤 50분
const NOW9 = wall(2026, 10, 9, 7, 0);
function 일감A(n: number): Job[] {
  return Array.from({ length: n }, (_, i) => ({
    channel: A, file: `/fixture/${i}.mp4`, _승인: "approved", 쏠때: isoWall(NOW9), publish_at: "2026-10-09 07:50",
    담은때: isoWall(초뒤(NOW9, i)),
  }));
}
/** 이미 올린 n편 (원장) — 오늘 07시 */
const 완료A = (n: number): LedgerRow[] =>
  Array.from({ length: n }, (_, i) => ({ 채널: "채널A", 영상ID: `v${i}`, 업로드시각: "2026-10-09T07:00:00", 예약시각: "" }));

// (파이썬 시험: 쇼츠만) — 쇼츠만
const NOW12 = wall(2026, 10, 12, 22, 15);
function 쇼츠일감(i: number, extra: Job = {}): Job {
  // 날짜 숫자가 i 가 커지면 달력에 없는 날(10-32)이 된다 — 원본 시험 그대로다.
  // repack 은 덮어쓰기 전의 쏠때·publish_at 을 해석하지 않으므로 이래도 된다(해석하면 여기서 터진다).
  return {
    channel: B, file: `/fixture/s${두자리(i)}.mp4`, _승인: "ok", time_by: "user", allow_not_short: false,
    쏠때: `2026-10-${두자리(13 + i)}T09:15:00`, publish_at: `2026-10-${14 + i} 09:15`, 담은때: `2026-10-0${1 + (i % 5)}T00:00:00`, ...extra,
  };
}

// (파이썬 시험: 롱폼만) — 롱폼만, 공개 예약만 제한
const NOW15 = wall(2026, 10, 15, 16, 30);
function 롱폼일감(i: number, extra: Job = {}): Job {
  return {
    channel: C, file: `/fixture/L${i}.mp4`, _승인: "ok", time_by: "user", allow_not_short: true, 롱폼: true,
    쏠때: "2026-10-15T16:30:00", publish_at: "2026-10-15 17:30", 담은때: `2026-10-15T16:${두자리(i)}:00`, ...extra,
  };
}
function 쇼츠일감C(i: number, extra: Job = {}): Job {
  return {
    channel: C, file: `/fixture/S${두자리(i)}.mp4`, _승인: "ok", time_by: "user", allow_not_short: false,
    쏠때: "2026-10-15T16:30:00", publish_at: "2026-10-15 17:30", 담은때: `2026-10-15T16:${두자리(i)}:00`, ...extra,
  };
}
const 원장C = (종류: "쇼츠" | "롱폼", 영상ID: string, 예약: string, 채널 = "채널C", 업로드 = "2026-10-15T08:00:00") =>
  원장줄(채널, 영상ID, 업로드, 예약, 종류);

export async function 실행() {
  try {
    await 정책파일();
    await 읽기꼴();
    await 하루여섯편();
    await 쇼츠만();
    await 롱폼만();
    await 승인형();
    await 실제업로드문();
    await 깨진것들();
  } finally {
    setDailyClock(null);
  }
}

/* ============================================================ 정책 파일 */

async function 정책파일() {
  setDailyClock(null);
  구역("정책 파일 쓰기·고치기·지우기 (화면의 일 한도 설정)");
  await 모래상자(async () => {
    같나("정책이 없으면 빈 목록", loadPolicies(), []);
    같나("정책이 없으면 채널도 없다", policyForChannel("채널A"), null);

    const pathA = await writePolicy(정책A);
    같나("label 로 만든 파일 이름", baseName(pathA), "채널A_daily_policy.json");
    const rawA = readJsonSync<Record<string, unknown>>(pathA, {});
    같나("종류·업로드 제한을 안 쓰면 v1", rawA.schema, SCHEMA_V1);
    같나("쓰기 좋은 칸 순서", Object.keys(rawA),
      ["schema", "label", "channel_id", "aliases", "timezone", "daily_limit", "day_start_hour", "publish_gap_minutes", "review_lead_minutes"]);
    const a = policyForChannel("채널A")!;
    같나("별칭으로 찾는다", a.cfg.channel_id, A);
    같나("channel_id 로도 찾는다", policyForChannel(A)?.cfg.label, "채널A");
    같나("모르는 이름은 없다", policyForChannel("채널Q"), null);
    같나("이름 집합 = {channel_id, ...aliases}", [...a.names].sort(), [A, "채널A"].sort());
    같나("잠금 파일 이름 = .<파일에서 _policy.json 뺀 것>_upload.lock", a.lock, ".채널A_daily_upload.lock");
    같나("정책 파일 경로", a.path, dataPath("채널A_daily_policy.json"));

    // v1 / v2 가르기 — 임시 정책으로
    const 임시 = (extra: Partial<정책입력> = {}): 정책입력 => ({ ...정책A, channel_id: Q, label: "임시", aliases: [], ...extra });
    const 종류 = async (p: 정책입력) => {
      const 쓴 = readJsonSync<Record<string, unknown>>(await writePolicy(p), {}).schema;
      await removePolicy(Q);
      return 쓴;
    };
    같나("kind 쇼츠만 — 옛 코드도 읽던 꼴이라 v1", await 종류(임시({ kind: "쇼츠" })), SCHEMA_V1);
    같나("kind 롱폼 — v2", await 종류(임시({ kind: "롱폼" })), SCHEMA_V2);
    같나("cap_uploads 를 쓰면 v2", await 종류(임시({ cap_uploads: false })), SCHEMA_V2);
    같나("overflow_day_start_hour 를 쓰면 v2", await 종류(임시({ overflow_day_start_hour: 9 })), SCHEMA_V2);

    // 고치기: 같은 channel_id 는 같은 파일, 적은 칸만 덮고 안 적은 칸은 보존
    await writePolicy({ ...정책A, kind: "쇼츠", memo: "손으로 적은 메모" });
    const 고침 = await writePolicy({ channel_id: A, daily_limit: 3 });
    같나("같은 channel_id 는 같은 파일을 고친다", 고침, pathA);
    같나("파일은 하나뿐", loadPolicies().length, 1);
    const 고친 = policyForChannel(A)!.cfg;
    같나("편수만 바꿔도 종류와 하루 시작은 남는다", [고친.daily_limit, 고친.kind, 고친.day_start_hour], [3, "쇼츠", 7]);
    같나("모르는 칸(메모)도 보존한다", 고친.memo, "손으로 적은 메모");
    await writePolicy({ channel_id: A, daily_limit: 3, kind: undefined });
    같나("kind 를 undefined 로 주면 지워진다(구분 없음)", policyForChannel(A)!.cfg.kind, undefined);
    같나("그래서 도로 v1", readJsonSync<Record<string, unknown>>(pathA, {}).schema, SCHEMA_V1);
    await writePolicy({ channel_id: A, daily_limit: "6" as unknown as number, aliases: ["채널A", "  ", "채널A2"] });
    const 다듬은 = readJsonSync<Record<string, unknown>>(pathA, {});
    같나("글자로 온 숫자는 숫자로 적는다", 다듬은.daily_limit, 6);
    같나("빈 별칭은 거르고 나머지는 남긴다", 다듬은.aliases, ["채널A", "채널A2"]);

    // 새 파일 이름이 겹치거나 위험할 때
    const 둘째 = await writePolicy({ ...정책A, channel_id: B, aliases: ["채널B"] });
    같나("다른 채널이 같은 label 이면 덮지 않고 번호를 붙인다", baseName(둘째), "채널A_2_daily_policy.json");
    const 위험 = await writePolicy({ ...정책A, channel_id: 아이디("e"), label: "../등/위험:이름 *?", aliases: [] });
    같나("label 의 경로 문자는 밑줄로 — 데이터 폴더 밖으로 못 나간다", [위험.startsWith(dataDir() + "/"), baseName(위험)], [true, "등_위험_이름_daily_policy.json"]);
    같나("label 이 없으면 channel_id 로 이름을 짓는다",
      baseName(await writePolicy({ channel_id: 아이디("f"), daily_limit: 2, label: undefined })), `${아이디("f")}_daily_policy.json`);
    for (const id of [B, 아이디("e"), 아이디("f")]) await removePolicy(id);
    같나("지운 뒤엔 처음 하나만", loadPolicies().map((p) => p.cfg.channel_id), [A]);

    // 이상한 값은 쓰기 전에 막는다
    const 앞 = loadPolicies().length;
    for (const [이름, 입력] of [
      ["편수 0", { ...임시(), daily_limit: 0 }],
      ["편수 음수", { ...임시(), daily_limit: -2 }],
      ["하루 시작 24시", { ...임시(), day_start_hour: 24 }],
      ["없는 시간대", { ...임시(), timezone: "Mars/Base" }],
      ["모르는 종류", { ...임시(), kind: "아무거나" as unknown as "쇼츠" }],
      ["간격 음수", { ...임시(), publish_gap_minutes: -1 }],
      ["채널 ID 가 빔", { ...임시(), channel_id: "  " }],
    ] as [string, 정책입력][]) {
      await 던지나(`쓰기 거절: ${이름}`, () => writePolicy(입력));
    }
    같나("거절된 것은 파일을 남기지 않는다", loadPolicies().length, 앞);

    // 승인형
    const pathD = await writePolicy(정책D);
    const rawD = readJsonSync<Record<string, unknown>>(pathD, {});
    같나("승인형 schema", rawD.schema, SCHEMA_APPROVED);
    같나("승인형에는 일 한도형 칸이 안 적힌다",
      ["day_start_hour", "publish_gap_minutes", "review_lead_minutes", "kind", "cap_uploads"].filter((k) => k in rawD), []);
    같나("승인형 칸", [rawD.daily_limit, rawD.publish_delay_minutes, rawD.overflow_day_start_hour, rawD.approval_required], [6, 10, 7, true]);
    const 새승인 = await writePolicy({ schema: SCHEMA_APPROVED, channel_id: 아이디("h"), label: "채널H", daily_limit: 2 });
    const 새승인값 = readJsonSync<Record<string, unknown>>(새승인, {});
    같나("승인형 기본값(올린 뒤 10분 · 밀리면 07시 · 승인 필요)", [새승인값.publish_delay_minutes, 새승인값.overflow_day_start_hour, 새승인값.approval_required], [10, 7, true]);
    같나("시간대를 안 주면 이 컴퓨터의 시간대", 새승인값.timezone, systemZone());
    const 승인읽기 = loadPolicies().find((x) => x.cfg.channel_id === 아이디("h"))!.cfg;
    같나("승인형은 Policy 꼴을 채우는 값이 따로 얹힌다(파일에는 안 적힌다)", [승인읽기.day_start_hour, 승인읽기.review_lead_minutes, 승인읽기.publish_gap_minutes], [7, 10, 0]);
    // 승인형 정책을 일 한도형으로 바꿔 쓰기
    await writePolicy({ schema: SCHEMA_V1, channel_id: 아이디("h"), daily_limit: 2 });
    const 바뀜 = readJsonSync<Record<string, unknown>>(새승인, {});
    같나("승인형 → 일 한도형: 승인형 칸이 빠지고 기본값이 채워진다",
      [바뀜.schema, "publish_delay_minutes" in 바뀜, "approval_required" in 바뀜, 바뀜.day_start_hour, 바뀜.publish_gap_minutes, 바뀜.review_lead_minutes],
      [SCHEMA_V2, false, false, 7, 120, 50]); // 밀림 시작 칸(overflow_day_start_hour)이 남아 있으니 그 칸을 읽는 v2 다

    // 지우기
    같나("지우면 true", await removePolicy(아이디("h")), true);
    같나("다시 지우면 false", await removePolicy(아이디("h")), false);
    같나("지운 채널은 더 안 보인다", policyForChannel(아이디("h")), null);
    같나("별칭으로는 안 지운다", await removePolicy("채널A"), false);
  });

  구역("사람 말 한 줄 (describePolicy)");
  await 모래상자(async () => {
    await writePolicy(정책A); await writePolicy(정책C); await writePolicy(정책D);
    같나("일 한도형(구분 없음)", describePolicy(policyForChannel(A)!.cfg),
      "하루 6편 · 쇼츠·롱폼 구분 없음 · 업로드·공개 예약 모두 제한 · 07시 시작 · 공개 간격 2시간 · 올린 뒤 50분 이후 공개 · Asia/Seoul");
    같나("롱폼만 · 공개 예약만 제한 · 밀리면 09시", describePolicy(policyForChannel(C)!.cfg),
      "하루 2편 · 롱폼만 · 공개 예약만 제한 · 07시 시작(밀리면 09시) · 공개 간격 2시간 · 올린 뒤 50분 이후 공개 · Asia/Seoul");
    같나("승인형", describePolicy(policyForChannel(D)!.cfg),
      "하루 6편 · 승인한 영상만 · 올린 10분 뒤 공개 예약 · 가득 차면 다음 날 07시부터 · Asia/Seoul");
  });
}

/* ============================================================ 옛 꼴과 모르는 꼴 */

async function 읽기꼴() {
  setDailyClock(null);
  구역("정책 파일 읽기 — 옛 첫 꼴·v1·v2·글자 숫자·BOM");
  await 모래상자(async () => {
    const 놓기 = (이름: string, v: unknown) => Deno.writeTextFile(dataPath(이름), typeof v === "string" ? v : JSON.stringify(v));
    const 기본 = { timezone: "Asia/Seoul", daily_limit: 6, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50 };
    await 놓기("옛꼴_daily_policy.json", { schema: "oshi-daily-cap-v1", channel_id: A, ...기본 });
    await 놓기("v1_daily_policy.json", { schema: SCHEMA_V1, channel_id: B, ...기본 });
    await 놓기("v2_daily_policy.json", { schema: SCHEMA_V2, channel_id: C, kind: "롱폼", cap_uploads: false, overflow_day_start_hour: 9, ...기본, daily_limit: 2 });
    await 놓기("글자숫자_daily_policy.json", { schema: SCHEMA_V1, channel_id: D, ...기본, daily_limit: "4", day_start_hour: "8" });
    await 놓기("BOM_daily_policy.json", "﻿" + JSON.stringify({ schema: SCHEMA_V1, channel_id: Z, ...기본 }));
    await 놓기("정책아님.json", { schema: SCHEMA_V1, channel_id: Q, ...기본 }); // 이름 끝이 _daily_policy.json 이 아니다
    const 읽음 = loadPolicies();
    같나("옛 첫 꼴(oshi-daily-cap-v1)·v1·v2 가 모두 읽히고 파일 이름 순이다", 읽음.map((p) => p.cfg.channel_id), [Z, B, C, D, A]);
    같나("이름이 _daily_policy.json 으로 안 끝나는 파일은 안 읽는다", policyForChannel(Q), null);
    같나("글자로 적힌 숫자도 숫자로 읽는다", [policyForChannel(D)!.cfg.daily_limit, policyForChannel(D)!.cfg.day_start_hour], [4, 8]);
    const c = policyForChannel(C)!.cfg;
    같나("v2 칸", [c.kind, c.cap_uploads, c.overflow_day_start_hour, c.daily_limit], ["롱폼", false, 9, 2]);
    같나("옛 첫 꼴 파일의 잠금 이름", policyForChannel(A)!.lock, ".옛꼴_daily_upload.lock");
    같나("BOM 이 붙은 파일도 읽는다", policyForChannel(Z)?.cfg.channel_id, Z);
  });
}

/* ============================================================ 고정 6편 (파이썬 시험) */

async function 하루여섯편() {
  setDailyClock(null);
  구역("하루 6편 (원본: 파이썬 시험 고정 6편 · 즉시)");
  await 모래상자(async () => {
    await writePolicy(정책A);
    const cfg = policyForChannel(A)!.cfg;
    const 기대 = { "2026-10-09": 6, "2026-10-10": 6, "2026-10-11": 6, "2026-10-12": 1 };

    {
      const 큐 = 일감A(19);
      const planned = reflow(큐, { now: NOW9, ledger: [], pending: [] });
      같나("19편은 하루 6편씩 — 업로드", 날짜별(planned, "쏠때"), 기대);
      같나("19편은 하루 6편씩 — 공개", 날짜별(planned, "publish_at"), 기대);
      같나("순서는 그대로", planned.map((j) => j.file), 큐.map((j) => j.file));
      같나("입력은 건드리지 않는다", 큐, 일감A(19));
    }
    {
      const planned = reflow(일감A(14), { now: NOW9, ledger: 완료A(5), pending: [] });
      같나("실제로 5편 올렸으면 오늘 자리는 한 칸", 날짜별(planned, "쏠때"), { "2026-10-09": 1, "2026-10-10": 6, "2026-10-11": 6, "2026-10-12": 1 });
    }
    {
      const rows = 완료A(6).map((r, i) => ({
        ...r, 업로드시각: "2026-10-08T22:00:00Z", // 한국 시각으로 10-09 07시
        예약시각: `2026-10-09 ${두자리(7 + i * 2)}:50`,
      }));
      const pending = [{ channel: "채널A", video_id: "v0", publish_at: "2026-10-08T22:50:00Z" }]; // v0 의 예약과 같은 순간
      const { uploads, published } = counts(rows, pending, cfg);
      같나("한국 시각으로 옮겨 센다 — 업로드 6", uploads.get("2026-10-09"), 6);
      같나("원장과 검토대기의 같은 영상은 한 번만 센다 — 공개 6", published.get("2026-10-09"), 6);
      const planned = reflow(일감A(1), { now: NOW9, ledger: rows, pending });
      같나("그래서 다음 편은 내일로 — 업로드", planned[0].쏠때.slice(0, 10), "2026-10-10");
      같나("그래서 다음 편은 내일로 — 공개", planned[0].publish_at.slice(0, 10), "2026-10-10");
    }
    {
      const 앞 = reflow(일감A(13), { now: NOW9, ledger: 완료A(6), pending: [] });
      const 새 = { ...일감A(1)[0], file: "/fixture/new.mp4", 담은때: "2026-10-09T08:00:00" };
      const 뒤 = reflow([...앞, 새], { now: wall(2026, 10, 12, 7), ledger: 완료A(6), pending: [] });
      같나("밀린 것과 새로 온 것이 한 날 6편을 넘지 않는다", 날짜별(뒤, "쏠때"), { "2026-10-12": 6, "2026-10-13": 6, "2026-10-14": 2 });
      같나("새 편은 맨 뒤 — 앞지르지 않는다", 뒤[뒤.length - 1].file, "/fixture/new.mp4");
      같나("새 편은 10-14", 뒤[뒤.length - 1].쏠때.slice(0, 10), "2026-10-14");
    }
    {
      const 다른 = { channel: Q, file: "/fixture/other.mp4", 쏠때: "2026-10-09T01:00:00" };
      const 먼 = { ...일감A(1)[0], 쏠때: "2026-10-20T09:00:00", publish_at: "2026-10-20 12:00" };
      const result = reflow([다른, 먼], { now: NOW9, ledger: [], pending: [] });
      같은가("다른 채널은 한 글자도 안 바뀐다", result[0], 다른);
      같은가("이미 먼 미래로 잡힌 예약은 앞당기지 않는다", result[1], 먼);
    }
    {
      // 먼저 담은 것을 앞지르지 않는다 — 나중에 담은 것이 더 이른 시각을 달라고 해도 앞 줄 뒤에 붙는다
      const 먼저 = (extra: Job) => ({ ...일감A(1)[0], file: "/fixture/first.mp4", 담은때: "2026-10-09T06:00:00", ...extra });
      const 나중 = (extra: Job) => ({ ...일감A(1)[0], file: "/fixture/second.mp4", 담은때: "2026-10-09T06:30:00", ...extra });
      const 업로드 = reflow([먼저({ 쏠때: "2026-10-09T15:00:00", publish_at: "2026-10-09 17:00" }), 나중({ 쏠때: "2026-10-09T07:00:00", publish_at: "2026-10-09 09:00" })],
        { now: NOW9, ledger: [], pending: [] });
      같나("업로드: 뒤에 담은 것이 더 이른 쏠 시각을 달라고 해도 앞 줄 시각 이후", 업로드.map((j) => j.쏠때), ["2026-10-09T15:00:00", "2026-10-09T15:00:00"]);
      const 공개 = reflow([먼저({ 쏠때: "2026-10-09T07:00:00", publish_at: "2026-10-09 17:00" }), 나중({ 쏠때: "2026-10-09T07:00:00", publish_at: "2026-10-09 09:00" })],
        { now: NOW9, ledger: [], pending: [] });
      같나("공개: 뒤에 담은 것이 더 이른 공개를 달라고 해도 앞 줄 공개 + 2시간 뒤", 공개.map((j) => j.publish_at), ["2026-10-09 17:00", "2026-10-09 19:00"]);
    }
    {
      const 새벽 = wall(2026, 10, 9, 3, 0);
      const p = reflow([{ ...일감A(1)[0], 쏠때: "2026-10-09T03:00:00", publish_at: "2026-10-09 03:30" }], { now: 새벽, ledger: [], pending: [] });
      같나("새벽 3시에 담아도 올리기·공개는 하루 시작(07시) 이후", [p[0].쏠때, p[0].publish_at], ["2026-10-09T07:00:00", "2026-10-09 07:50"]);
    }
    {
      // 같은 영상이 원장에 두 줄이어도 한 번만 센다 / 영상ID 가 비면 파일 이름으로 / 둘 다 비면 세지 않는다
      const 줄 = 원장줄("채널A", "dup", "2026-10-09T07:00:00", "2026-10-09 09:00");
      const 둘 = counts([줄, { ...줄 }], [], cfg);
      같나("같은 영상 두 줄은 한 번 — 업로드·공개·예약 시각", [맵(둘.uploads), 맵(둘.published), 둘.booked.length], [{ "2026-10-09": 1 }, { "2026-10-09": 1 }, 1]);
      const 파일뿐 = { ...줄, 영상ID: "", 파일: "/led/x.mp4" };
      같나("영상ID 가 비면 파일 이름으로 같은 영상을 가른다", 맵(counts([파일뿐, { ...파일뿐 }], [], cfg).uploads), { "2026-10-09": 1 });
      같나("영상ID·파일이 둘 다 비면 셀 수 없어 세지 않는다", 맵(counts([{ ...줄, 영상ID: "", 파일: "" }], [], cfg).uploads), {});
    }
    {
      // (파이썬: test_targeted_immediate_dispatch_keeps_full_day_jobs_in_queue 의 계산 부분)
      // 오늘 6편이 이미 올라갔으면 13편 전부 내일부터 — 지금 쏠 차례가 된 것이 하나도 없어 발사기는 아무것도 안 올린다.
      const planned = reflow(일감A(13), { now: NOW9, ledger: 완료A(6), pending: [] });
      같나("13편이 다 큐에 남는다", planned.length, 13);
      같나("날짜별 업로드", 날짜별(planned, "쏠때"), { "2026-10-10": 6, "2026-10-11": 6, "2026-10-12": 1 });
      참인가("쏠 차례가 된 것이 하나도 없다", planned.every((j) => j.쏠때 > isoWall(NOW9)));
    }
    {
      // 일곱째 업로드는 인증 전에 막힌다 (파이썬: test_actual_insert_guard_blocks_seventh_upload_without_authentication)
      await 원장쓰기(완료A(6));
      얼리기(NOW9);
      let 닿았나 = false;
      await 한도에걸리나("일곱째 업로드는 videos.insert 에 닿기 전에 막힌다", () => uploadSlot(A, undefined, async () => { 닿았나 = true; }), /하루 6편 업로드 완료/);
      같나("업로드 함수는 불리지 않았다", 닿았나, false);
      await 원장쓰기(완료A(5));
      같나("다섯 편째까지는 통과한다", await uploadSlot(A, undefined, async () => "올림"), "올림");
    }
  });
}

/* ============================================================ 쇼츠만 (파이썬 시험) */

async function 쇼츠만() {
  setDailyClock(null);
  구역("쇼츠만 셈 — 롱폼은 한도 밖 (원본: 파이썬 시험 쇼츠만)");
  await 모래상자(async () => {
    await writePolicy(정책A);
    await writePolicy(정책B);
    const 큐: Job[] = [
      ...Array.from({ length: 20 }, (_, i) => 쇼츠일감(i)),
      { channel: B, file: "/fixture/long.mp4", allow_not_short: true, 롱폼: true, 쏠때: "2026-10-13T09:15:00", publish_at: "2026-10-14 09:15", 담은때: "2026-10-01T00:00:00" },
      { channel: Z, file: "/fixture/other.mp4", 쏠때: "2026-10-14T07:00:00" },
    ];
    const 원장 = [원장줄("채널B", "a", "2026-10-11T09:20:00", "2026-10-12 09:15"), 원장줄("채널B", "b", "2026-10-11T15:20:00", "2026-10-12 15:15")];
    const 앞 = JSON.parse(JSON.stringify(큐));
    const planned = repack(큐, "채널B", { today: 2, now: NOW12, ledger: 원장, pending: [] });
    {
      const 쇼츠 = planned.slice(0, 20);
      같나("앞당기기: 순서 그대로", 쇼츠.map((r) => r.file), 큐.slice(0, 20).map((r) => r.file));
      같나("앞당기기: 오늘 밤 둘, 그 뒤 하루 6편씩 — 업로드", 날짜별(쇼츠, "쏠때"), { "2026-10-12": 2, "2026-10-13": 6, "2026-10-14": 6, "2026-10-15": 6 });
      같나("앞당기기: 공개", 날짜별(쇼츠, "publish_at"), { "2026-10-12": 1, "2026-10-13": 6, "2026-10-14": 6, "2026-10-15": 6, "2026-10-16": 1 });
      const 시각들 = 쇼츠.map((r) => parseWall(r.publish_at)!).sort((x, y) => x.getTime() - y.getTime());
      let 최소 = Infinity;
      for (let i = 1; i < 시각들.length; i++) 최소 = Math.min(최소, 시각들[i].getTime() - 시각들[i - 1].getTime());
      참인가("공개 사이는 2시간 이상", 최소 >= 2 * 3600_000);
      같나("둘째 날 공개 시각표", 시각들.slice(1, 7).map(시), ["07:00", "09:00", "11:00", "13:00", "15:00", "17:00"]);
      같은가("롱폼과 다른 채널 줄은 한 글자도 안 바뀐다", planned.slice(20), 큐.slice(20));
      같은가("입력 큐는 건드리지 않는다", 큐, 앞);
    }
    {
      // 원본 _repack_cli 가 찍는 표 (파이썬 원본 알고리즘으로 같은 입력에서 뽑은 값)
      const 보고 = repackReport(큐, planned, "채널B");
      같나("앞당기기 표", 보고.lines, [
        "  1  업로드 10-12 22:15  공개 10-12 23:05  s00", "  2  업로드 10-12 22:15  공개 10-13 07:00  s01",
        "  3  업로드 10-13 07:00  공개 10-13 09:00  s02", "  4  업로드 10-13 07:00  공개 10-13 11:00  s03",
        "  5  업로드 10-13 07:00  공개 10-13 13:00  s04", "  6  업로드 10-13 07:00  공개 10-13 15:00  s05",
        "  7  업로드 10-13 07:00  공개 10-13 17:00  s06", "  8  업로드 10-13 07:00  공개 10-14 07:00  s07",
        "  9  업로드 10-14 07:00  공개 10-14 09:00  s08", " 10  업로드 10-14 07:00  공개 10-14 11:00  s09",
        " 11  업로드 10-14 07:00  공개 10-14 13:00  s10", " 12  업로드 10-14 07:00  공개 10-14 15:00  s11",
        " 13  업로드 10-14 07:00  공개 10-14 17:00  s12", " 14  업로드 10-14 07:00  공개 10-15 07:00  s13",
        " 15  업로드 10-15 07:00  공개 10-15 09:00  s14", " 16  업로드 10-15 07:00  공개 10-15 11:00  s15",
        " 17  업로드 10-15 07:00  공개 10-15 13:00  s16", " 18  업로드 10-15 07:00  공개 10-15 15:00  s17",
        " 19  업로드 10-15 07:00  공개 10-15 17:00  s18", " 20  업로드 10-15 07:00  공개 10-16 07:00  s19",
      ]);
      같나("표 아래 날짜별 업로드", 보고.uploads, { "2026-10-12": 2, "2026-10-13": 6, "2026-10-14": 6, "2026-10-15": 6 });
      같나("표 아래 날짜별 공개", 보고.published, { "2026-10-12": 1, "2026-10-13": 6, "2026-10-14": 6, "2026-10-15": 6, "2026-10-16": 1 });
      // 대상이 아닌 줄이 바뀌었으면 표를 만들다 멈춘다 (파이썬 assert)
      const 망가뜨림 = planned.map((r, i) => (i === 21 ? { ...r, 쏠때: "2030-01-01T00:00:00" } : r));
      await 던지나("다른 채널 줄이 바뀐 결과는 표로 못 만든다", () => repackReport(큐, 망가뜨림, "채널B"), /편성 대상이 아닌 줄이 바뀌었다/);
    }
    {
      const 큐5 = Array.from({ length: 5 }, (_, i) => 쇼츠일감(i));
      const planned2 = repack(큐5, "채널B", { today: 0, now: NOW12, ledger: [], pending: [], first: ["/fixture/s03.mp4", "/fixture/s01.mp4"] });
      같나("먼저 보낼 파일은 적은 순서대로 맨 앞, 나머지는 원래 순서",
        [...planned2].sort((x, y) => 키순(x.publish_at, y.publish_at)).map((r) => r.file), [3, 1, 0, 2, 4].map((i) => `/fixture/s${두자리(i)}.mp4`));
      같나("today=0 이면 전부 내일부터", 날짜별(planned2, "쏠때"), { "2026-10-13": 5 });
      await 던지나("없는 채널은 앞당길 수 없다", () => repack(큐5, "채널Q", { now: NOW12 }), /일 한도 정책이 없는 채널/);
    }
    {
      const 롱원장 = Array.from({ length: 6 }, (_, i) => 원장줄("채널B", `L${i}`, "2026-10-12T10:00:00", `2026-10-13 ${두자리(7 + i)}:00`, "롱폼"));
      const p = reflow([쇼츠일감(0, { 쏠때: "2026-10-12T09:15:00", publish_at: "2026-10-13 09:15" })], { now: NOW12, ledger: 롱원장, pending: [] });
      같나("롱폼 업로드·예약 6편이어도 쇼츠 칸은 안 먹힌다", p[0].쏠때.slice(0, 10), "2026-10-12");
    }
    {
      const 쇼츠원장 = Array.from({ length: 6 }, (_, i) => 원장줄("채널B", `S${i}`, "2026-10-12T08:00:00", `2026-10-12 ${두자리(9 + i)}:00`));
      const 먼 = 쇼츠일감(0, { 쏠때: "2026-10-20T09:15:00", publish_at: "2026-10-21 09:15" });
      const p = reflow([쇼츠일감(1, { 쏠때: "2026-10-12T08:00:00", publish_at: "2026-10-12 09:00" }), 먼], { now: NOW12, ledger: 쇼츠원장, pending: [] });
      같나("오늘 쇼츠 6편을 올렸으면 다음 편은 내일 07시", p[0].쏠때, "2026-10-13T07:00:00");
      같나("이미 먼 예약은 앞당기지 않는다", p[1].쏠때, "2026-10-20T09:15:00");
    }
    {
      // 일곱째 쇼츠는 막히고 롱폼·다른 채널은 통과 (파이썬: test_upload_slot_blocks_seventh_short_but_not_a_long)
      await 원장쓰기(Array.from({ length: 6 }, (_, i) => 원장줄("채널B", `S${i}`, "2026-10-12T08:00:00", `2026-10-12 ${두자리(9 + i)}:00`)));
      얼리기(NOW12);
      await 한도에걸리나("일곱째 쇼츠는 막힌다", () => uploadSlot(B, { allow_not_short: false }, async () => {}), /하루 6편 업로드 완료/);
      같나("롱폼은 이 한도 밖", await uploadSlot(B, { allow_not_short: true, 롱폼: true }, async () => "통과"), "통과");
      같나("다른 채널도 밖", await uploadSlot("other_ch", {}, async () => "통과"), "통과");
    }
  });
}

/* ============================================================ 롱폼만 (파이썬 시험) */

async function 롱폼만() {
  setDailyClock(null);
  구역("롱폼만 셈 · 공개 예약만 제한 · 하루 2편 (원본: 파이썬 시험 롱폼만)");
  await 모래상자(async () => {
    await writePolicy(정책A);
    await writePolicy(정책B);
    await writePolicy(정책C);
    const cfgC = policyForChannel(C)!.cfg;

    {
      const 찾음 = Object.fromEntries(loadPolicies().map((p) => [p.cfg.channel_id, p.cfg]));
      같나("롱폼 정책이 한 곳에 적힌 대로 읽힌다", [cfgC.daily_limit, cfgC.kind, cfgC.cap_uploads, cfgC.timezone], [2, "롱폼", false, "Asia/Seoul"]);
      같나("하루 시작 07시, 밀리면 09시", [cfgC.day_start_hour, cfgC.overflow_day_start_hour], [7, 9]);
      같나("옛 v1 정책 파일도 그대로 읽힌다", [찾음[A].daily_limit, 찾음[B].daily_limit, 찾음[B].kind], [6, 6, "쇼츠"]);
      같나("별칭으로 불러도 같은 정책", policyForChannel("채널C")?.cfg.channel_id, C);
    }
    {
      const planned = reflow(Array.from({ length: 5 }, (_, i) => 롱폼일감(i)), { now: NOW15, ledger: [], pending: [] });
      같나("하루 2편, 넘치면 다음 날 09시부터 2편씩", planned.map((j) => j.publish_at),
        ["2026-10-15 17:30", "2026-10-15 19:30", "2026-10-16 09:00", "2026-10-16 11:00", "2026-10-17 09:00"]);
      같나("업로드(쏠 시각)는 한도 밖 — 그대로", [...new Set(planned.map((j) => j.쏠때))], ["2026-10-15T16:30:00"]);
      같나("순서는 그대로", planned.map((j) => j.file), [0, 1, 2, 3, 4].map((i) => `/fixture/L${i}.mp4`));
    }
    {
      const 원장 = [원장C("롱폼", "a", "2026-10-15 07:00"), 원장C("롱폼", "b", "2026-10-15 09:00")];
      const planned = reflow([롱폼일감(0, { publish_at: "2026-10-15 17:20" })], { now: NOW15, ledger: 원장, pending: [] });
      같나("오늘 칸이 차면 다음 롱폼은 내일 09시", planned[0].publish_at, "2026-10-16 09:00");
      같나("업로드는 오늘 그대로", planned[0].쏠때, "2026-10-15T16:30:00");
    }
    {
      const 열시 = wall(2026, 10, 15, 10, 0);
      const 원장 = [원장C("롱폼", "a", "2026-10-15 09:00")];
      const planned = reflow([
        롱폼일감(0, { publish_at: "2026-10-15 11:00", 쏠때: "2026-10-15T10:00:00" }),
        롱폼일감(1, { publish_at: "2026-10-15 13:00", 쏠때: "2026-10-15T10:00:00" }),
      ], { now: 열시, ledger: 원장, pending: [] });
      같나("오늘 한 칸이 남으면 하나는 오늘, 하나는 내일", planned.map((j) => j.publish_at), ["2026-10-15 11:00", "2026-10-16 09:00"]);
      const 이른 = reflow([롱폼일감(0, { publish_at: "2026-10-15 10:10", 쏠때: "2026-10-15T10:00:00" })], { now: 열시, ledger: [], pending: [] });
      같나("올린 뒤 50분 이후에 공개", 이른[0].publish_at, "2026-10-15 10:50");
      const 가까운 = reflow([롱폼일감(0, { publish_at: "2026-10-15 10:30", 쏠때: "2026-10-15T10:00:00" })], { now: 열시, ledger: 원장, pending: [] });
      같나("롱폼끼리 2시간 간격 — 09:00 예약이 있으면 10:50 은 11:00 으로", 가까운[0].publish_at, "2026-10-15 11:00");
    }
    {
      const 가득 = [원장C("롱폼", "a", "2026-10-15 07:00"), 원장C("롱폼", "b", "2026-10-15 09:00"), 원장C("쇼츠", "s", "2026-10-15 17:00")];
      const 쇼츠 = 쇼츠일감C(0);
      같은가("쇼츠는 한도 밖 — 한 글자도 안 바뀐다", reflow([쇼츠], { now: NOW15, ledger: 가득, pending: [] }), [쇼츠]);
      const 쇼츠만4 = Array.from({ length: 4 }, (_, i) => 원장C("쇼츠", `s${i}`, `2026-10-15 ${10 + i}:00`));
      const planned = reflow([롱폼일감(0)], { now: NOW15, ledger: 쇼츠만4, pending: [] });
      같나("쇼츠가 4편이어도 롱폼 칸은 비어 있다", planned[0].publish_at, "2026-10-15 17:30");
    }
    {
      const 원장 = [원장C("롱폼", "L1", "2026-10-16 09:00"), 원장C("롱폼", "L2", "2026-10-16 11:00"), 원장C("쇼츠", "S1", "2026-10-16 09:00")];
      const pending = [
        { channel: "채널C", video_id: "L1", publish_at: "2026-10-16T00:00:00Z" }, // 원장과 같은 영상 = 한 번만
        { channel: "채널C", video_id: "S1", publish_at: "2026-10-16T00:00:00Z" }, // 쇼츠
        { channel: "other_ch", video_id: "X", publish_at: "2026-10-16T00:00:00Z" }, // 다른 채널
      ];
      const { published, booked } = counts(원장, pending, cfgC);
      같나("검토대기는 원장이 롱폼으로 확인한 영상만, 같은 영상은 한 번만 센다", published.get("2026-10-16"), 2);
      같나("공개(예약) 시각도 둘", booked.length, 2);
    }
    {
      const 새벽 = wall(2026, 10, 15, 3, 0);
      const p = reflow([롱폼일감(0, { 쏠때: "2026-10-15T03:00:00", publish_at: "2026-10-15 03:30" })], { now: 새벽, ledger: [], pending: [] });
      같나("업로드를 제한하지 않아도 공개는 하루 시작 이후(07:00 + 50분)", p[0].publish_at, "2026-10-15 07:50");
      같나("업로드 시각은 건드리지 않는다(새벽 그대로)", p[0].쏠때, "2026-10-15T03:00:00");
    }
    {
      const 다른 = { channel: Q, file: "/fixture/o.mp4", 쏠때: "2026-10-15T01:00:00", publish_at: "2026-10-15 03:00" };
      const 큐 = [다른, 쇼츠일감C(0), 롱폼일감(1)];
      const planned = reflow(큐, { now: NOW15, ledger: [], pending: [] });
      같은가("다른 채널은 그대로", planned[0], 다른);
      같은가("같은 채널의 쇼츠 줄도 그대로", planned[1], 큐[1]);
      같나("롱폼 줄만 편성한다", planned[2].publish_at, "2026-10-15 17:30");
    }
    {
      const 큐: Job[] = Array.from({ length: 8 }, (_, i) => ({
        channel: A, file: `/fixture/o${i}.mp4`, _승인: "ok", 쏠때: "2026-10-15T07:00:00", publish_at: "2026-10-15 07:50", 담은때: `2026-10-15T06:0${i}:00`,
      }));
      for (let i = 0; i < 8; i++) 큐.push(쇼츠일감C(i, { channel: B, publish_at: "2026-10-15 17:30" }));
      큐.push(롱폼일감(0, { channel: B }));
      const 원장 = [원장C("롱폼", "a", "2026-10-15 07:00"), 원장C("롱폼", "b", "2026-10-15 09:00")];
      const 있을때 = reflow(큐, { now: NOW15, ledger: 원장, pending: [] });
      await removePolicy(C);
      같은가("기존 채널은 롱폼 정책이 있든 없든 똑같이 편성된다", 있을때, reflow(큐, { now: NOW15, ledger: 원장, pending: [] }));
      await writePolicy(정책C);
    }
    {
      // 막힌 롱폼은 큐에 남고, 사유는 이 채널의 한도 문구로 말한다 (파이썬: test_dispatcher_keeps_a_blocked_long_form_in_the_queue_...)
      await 원장쓰기([원장C("롱폼", "a", "2026-10-16 09:00"), 원장C("롱폼", "b", "2026-10-16 11:00"), 원장C("쇼츠", "s1", "2026-10-17 09:00")]);
      얼리기(NOW15);
      const 본문 = (j: Job) => uploadSlot(C, j, async () => "올림");
      let 닿았나 = false;
      try {
        await uploadSlot(C, 롱폼일감(0, { publish_at: "2026-10-16 13:00" }), async () => { 닿았나 = true; });
        같나("공개 날짜가 가득 찬 롱폼은 막혀야 한다", "안 막혔다", "막힘");
      } catch (e) {
        참인가("한도 오류다", e instanceof DailyLimitReached);
        const m = (e as Error).message;
        참인가("이 채널의 한도 문구(하루 2편 공개 예약 한도 · 10/16)", /하루 2편 공개 예약 한도.*10\/16/.test(m));
        참인가("틀린 문구(하루 6편)가 아니다", !m.includes("하루 6편"));
      }
      같나("막힌 일감은 업로드 함수에 닿지 않았다", 닿았나, false);
      같나("다음 날 자리는 비어 있다", await 본문(롱폼일감(0, { publish_at: "2026-10-17 09:00" })), "올림");
      같나("이름(별칭)으로 불러도 같은 정책 — 오늘은 롱폼이 하나도 없다", await uploadSlot("채널C", 롱폼일감(0, { publish_at: "2026-10-15 17:30" }), async () => "올림"), "올림");
      같나("공개 시각이 없으면 올린 뒤 50분 = 오늘 17:20 → 오늘 칸이 비어 있다", await 본문(롱폼일감(0, { publish_at: "" })), "올림");
      같나("쇼츠는 한도 밖", await 본문(쇼츠일감C(0, { publish_at: "2026-10-16 13:00" })), "올림");
      같나("다른 채널도 밖", await uploadSlot("other_ch", {}, async () => "올림"), "올림");

      await 원장쓰기([원장C("롱폼", "a", "2026-10-15 07:00"), 원장C("롱폼", "b", "2026-10-15 09:00")]);
      await 한도에걸리나("오늘 공개 칸이 가득 찼는데 공개 시각 없이 바로 올리면 막힌다", () => 본문(롱폼일감(0, { publish_at: "" })));
      await 한도에걸리나("이미 지난 예약 시각은 올린 뒤 바로 열리는 것으로 센다", () => 본문(롱폼일감(0, { publish_at: "2026-10-15 07:00" })));
    }
    {
      // (파이썬: ReceiveImmediateFlowTest 의 계산 부분) 롱폼을 즉시 넘길 때마다 편성기를 지나 공개 시각이 정해지고,
      // 쏠 때 원장에 한 줄이 더해진다. 쇼츠는 이 정책 밖이라 예전처럼 그대로 간다.
      const 원장 = [원장C("롱폼", "a", "2026-10-15 07:00"), 원장C("롱폼", "b", "2026-10-15 09:00")];
      const 받은: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const 일감 = 롱폼일감(i, { file: `/fixture/에피${i}_롱폼.mp4`, publish_at: "2026-10-15 17:20", 쏠때: "2026-10-15T16:30:00" });
        const [r] = reflow([일감], { now: NOW15, ledger: 원장, pending: [] });
        받은.push(shortWall(parseWall(r.publish_at)!));
        원장.push(원장C("롱폼", `n${i}`, r.publish_at, "채널C", r.쏠때));
      }
      같나("셋째~일곱째 롱폼이 하루 2편씩 밀린다", 받은, ["10/16 09:00", "10/16 11:00", "10/17 09:00", "10/17 11:00", "10/18 09:00"]);
      for (const [i, hm] of ["17:20", "19:20", "21:20"].entries()) {
        const 쇼츠 = 쇼츠일감C(i + 1, { publish_at: `2026-10-15 ${hm}`, 쏠때: "2026-10-15T16:30:00" });
        같은가(`쇼츠 ${hm} 는 롱폼이 다 찬 날에도 그대로`, reflow([쇼츠], { now: NOW15, ledger: 원장, pending: [] }), [쇼츠]);
      }
    }
  });
}

/* ============================================================ 승인형 */

async function 승인형() {
  setDailyClock(null);
  구역("승인형 정책 — 올린 뒤 N분 예약, 날짜별 N편, 넘치면 다음 날 (원본: 파이썬 승인형 편성기의 일반화)");
  await 모래상자(async () => {
    const 승일감 = (i: number, extra: Job = {}): Job => ({ channel: D, file: `/fixture/R${i}.mp4`, 쏠때: "2026-10-15T16:30:00", ...extra });
    const 칸 = (r: Job) => [r.쏠때, r.publish_at, r.time_by];
    const 승원장 = (id: string, 업로드: string, 예약: string): LedgerRow => ({ 채널: "채널D", 영상ID: id, 업로드시각: 업로드, 예약시각: 예약, 공개시각: "" });

    await writePolicy({ ...정책D, daily_limit: 2 });
    {
      const out = reflow(Array.from({ length: 5 }, (_, i) => 승일감(i)), { now: NOW15, ledger: [], pending: [] });
      같나("하루 2편: 오늘 둘 · 내일 07시 둘 · 모레 07시 하나", out.map(칸), [
        ["2026-10-15T16:30:00", "2026-10-15 16:40", "user"], ["2026-10-15T16:30:00", "2026-10-15 16:40", "user"],
        ["2026-10-16T07:00:00", "2026-10-16 07:10", "user"], ["2026-10-16T07:00:00", "2026-10-16 07:10", "user"],
        ["2026-10-17T07:00:00", "2026-10-17 07:10", "user"],
      ]);
    }
    await writePolicy({ channel_id: D, daily_limit: 6 });
    {
      const 큐 = [...Array.from({ length: 5 }, (_, i) => 승일감(i)), { channel: Q, file: "/fixture/o.mp4", 쏠때: "2026-10-15T01:00:00" }];
      const 원장 = Array.from({ length: 4 }, (_, i) => 승원장(`v${i}`, "2026-10-15T08:00:00", `2026-10-15 ${두자리(9 + i)}:00`));
      const out = reflow(큐, { now: NOW15, ledger: 원장, pending: [] });
      같나("오늘 4편이 이미 있으면 2편만 오늘, 나머지는 내일 07:10", out.slice(0, 5).map(칸), [
        ["2026-10-15T16:30:00", "2026-10-15 16:40", "user"], ["2026-10-15T16:30:00", "2026-10-15 16:40", "user"],
        ["2026-10-16T07:00:00", "2026-10-16 07:10", "user"], ["2026-10-16T07:00:00", "2026-10-16 07:10", "user"],
        ["2026-10-16T07:00:00", "2026-10-16 07:10", "user"],
      ]);
      같은가("다른 채널 줄은 한 글자도 안 바뀐다", out[5], 큐[5]);
    }
    {
      const 원장 = Array.from({ length: 6 }, (_, i) => 승원장(`w${i}`, "2026-10-14T08:00:00", `2026-10-15 ${두자리(9 + i)}:30`));
      const out = reflow([승일감(0, { publish_at: "2026-10-15 20:00", time_by: "user" }), 승일감(1, { publish_at: "2026-10-16 09:00" })], { now: NOW15, ledger: 원장, pending: [] });
      같나("사람이 정한 시각이 이미 가득 찬 날이면 다음 날 07시로 — 올리는 시각도 따라간다", 칸(out[0]), ["2026-10-16T07:00:00", "2026-10-16 07:10", "user"]);
      같나("다음 날에 정한 시각은 그대로 존중한다", 칸(out[1]), ["2026-10-16T07:00:00", "2026-10-16 09:00", "user"]);
    }
    {
      // 올리는 날이 밀리면(오늘 업로드 칸이 가득) 공개도 올린 뒤 N분 이후로 — 올리기 전에 공개되는 일이 없게
      const 원장 = Array.from({ length: 6 }, (_, i) => 승원장(`u${i}`, "2026-10-15T08:00:00", ""));
      const out = reflow([승일감(0, { publish_at: "2026-10-15 17:00" })], { now: NOW15, ledger: 원장, pending: [] });
      같나("업로드 칸이 가득 찬 날의 일감은 내일 07시에 올리고, 공개는 올린 뒤 10분", 칸(out[0]), ["2026-10-16T07:00:00", "2026-10-16 07:10", "user"]);
    }
    {
      // 일 한도형과 달리 간격·하루 시작 칸이 없다 — 한 날에 둘이 같은 시각이어도 그대로다(원본 그대로)
      const 정책 = policyForChannel(D)!.cfg;
      const 원장 = [승원장("x1", "2026-10-14T08:00:00", "2026-10-16 09:00"), 승원장("x2", "2026-10-14T09:00:00", "2026-10-16 11:00")];
      const 전부 = counts(원장, [], 정책);
      같나("승인형 세기: 업로드는 올린 날로, 공개는 예약한 날로", [맵(전부.uploads), 맵(전부.published)], [{ "2026-10-14": 2 }, { "2026-10-16": 2 }]);
      const 뺌 = counts(원장, [], 정책, "x1");
      같나("자기 자신의 예약은 빼고 센다(옮길 때)", [맵(뺌.uploads), 맵(뺌.published)], [{ "2026-10-14": 2 }, { "2026-10-16": 1 }]);
      const 검토 = counts(원장, [{ channel: "채널D", video_id: "p1", publish_at: "2026-10-16T05:00:00Z" }, { channel: Q, video_id: "p2", publish_at: "2026-10-16T05:00:00Z" }], 정책);
      같나("검토대기의 공개 예정도 센다(다른 채널은 아니다)", 맵(검토.published), { "2026-10-16": 3 });
    }
    {
      // requirePublication — 공개 예약이 가득 찬 날은 거절
      await writePolicy({ channel_id: D, daily_limit: 2 });
      await 원장쓰기([승원장("x1", "2026-10-14T08:00:00", "2026-10-16 09:00"), 승원장("x2", "2026-10-14T09:00:00", "2026-10-16 11:00")]);
      얼리기(wall(2026, 10, 16, 10, 0));
      await 던지나("가득 찬 날(10-16)에 또 예약하면 거절", () => requirePublication(D, W("2026-10-16 13:00")), /하루 2편 공개 예약 한도/);
      await 안던지나("자기 영상이면 자리가 있다(예약을 옮기는 중)", () => requirePublication(D, W("2026-10-16 13:00"), "x1"));
      await 안던지나("다른 날은 통과", () => requirePublication(D, W("2026-10-17 09:00")));
      await 던지나("공개 시각을 안 주면 지금 날짜로 센다(오늘이 가득)", () => requirePublication(D), /공개 예약 한도/);
      await 던지나("공개 시각이 null 이어도 지금 날짜로 센다", () => requirePublication(D, null), /공개 예약 한도/);
      await 안던지나("정책이 없는 채널은 아무것도 안 한다", () => requirePublication("모르는채널", W("2026-10-16 13:00")));
      await writePolicy(정책A);
      await 원장쓰기(Array.from({ length: 6 }, (_, i) => 원장줄("채널A", `f${i}`, "2026-10-14T08:00:00", `2026-10-16 ${두자리(7 + i * 2)}:50`)));
      await 안던지나("승인형이 아닌 정책의 채널은 공개 예약이 가득 차 있어도 이 문턱이 막지 않는다(그쪽은 편성기·업로드 문 몫)",
        () => requirePublication("채널A", W("2026-10-16 13:00")));
    }
    {
      // 업로드 문 — 오늘 올린 편수가 한도면 거절
      얼리기(NOW15);
      await 원장쓰기([승원장("u1", "2026-10-15T08:00:00", ""), 승원장("u2", "2026-10-15T09:00:00", "")]);
      await 한도에걸리나("오늘 2편을 이미 올렸으면 업로드 문이 막는다", () => uploadSlot(D, undefined, async () => {}), /하루 2편 업로드 완료/);
      await 원장쓰기([승원장("u1", "2026-10-15T08:00:00", "")]);
      같나("한 편뿐이면 통과", await uploadSlot(D, undefined, async () => "올림"), "올림");
    }
    {
      await 던지나("승인형 정책은 앞당기기를 안 한다", () => repack([승일감(0)], D, { now: NOW15 }), /앞당기기를 하지 않습니다/);
    }
  });
}

/* ============================================================ 실제 업로드 문 */

async function 실제업로드문() {
  setDailyClock(null);
  구역("실제 업로드 문 (uploadSlot) — 잠금·시간대·종류 판정");
  await 모래상자(async (dir) => {
    await writePolicy(정책A);
    얼리기(NOW9);

    // dry 는 한도를 안 본다
    await 원장쓰기(완료A(6));
    같나("dry 이면 가득 차 있어도 통과", await uploadSlot(A, undefined, async () => "시험", { dry: true }), "시험");
    같나("한도가 걸리지 않은 채널은 잠금도 안 잡는다", existsSync(dataPath(".채널A_daily_upload.lock")), false);

    // 같은 잠금 안에서 확인과 업로드 — 마지막 칸을 둘이 차지하지 못한다
    await writePolicy({ channel_id: A, daily_limit: 2 });
    await 원장쓰기([]);
    let 동시 = 0, 겹침 = 0, 들어감 = 0;
    const 올려보기 = (n: number) => uploadSlot(A, { file: `/f/${n}.mp4` }, async () => {
      동시++; if (동시 > 1) 겹침++;
      들어감++;
      await new Promise((r) => setTimeout(r, 30));
      await appendLedger(원장줄("채널A", `c${n}`, "2026-10-09T07:00:00")); // 올리면 원장에 한 줄
      동시--;
      return n;
    });
    const 끝 = await Promise.allSettled([1, 2, 3, 4].map(올려보기));
    같나("네 곳이 동시에 와도 두 칸만 열린다", 끝.filter((x) => x.status === "fulfilled").length, 2);
    같나("나머지 둘은 한도 오류", 끝.filter((x) => x.status === "rejected" && x.reason instanceof DailyLimitReached).length, 2);
    같나("한 번에 하나씩만 들어간다(겹침 없음)", 겹침, 0);
    같나("업로드 함수는 두 번만 불렸다", 들어감, 2);
    같나("원장에도 두 줄", readLedger().length, 2);
    같나("잠금 파일이 데이터 폴더에 생긴다", existsSync(dataPath(".채널A_daily_upload.lock")), true);

    // 업로드 함수가 던지면 그대로 위로 올라온다 — 잠금은 풀린다
    await writePolicy({ channel_id: A, daily_limit: 6 });
    await 원장쓰기([]);
    await 던지나("업로드가 실패하면 그 오류가 그대로 나온다", () => uploadSlot(A, undefined, async () => { throw new Error("업로드 실패 시늉"); }), /업로드 실패 시늉/);
    같나("그 뒤에도 잠금이 풀려 있어 다시 들어간다", await uploadSlot(A, undefined, async () => "다시"), "다시");

    // 한도 문구의 이름: label 이 없으면 「이 채널」
    await writePolicy({ channel_id: A, daily_limit: 1, label: undefined });
    await 원장쓰기(완료A(1));
    await 한도에걸리나("label 이 없는 정책은 「이 채널」로 말한다", () => uploadSlot(A, undefined, async () => {}), /^이 채널 하루 1편 업로드 완료/);
  });

  구역("정책 시간대로 하루를 가른다 (이 컴퓨터 시간대와 상관없이)");
  await 모래상자(async () => {
    const 뉴욕 = 아이디("n");
    await writePolicy({ ...정책A, channel_id: 뉴욕, label: "채널N", aliases: ["채널N"], timezone: "America/New_York", daily_limit: 1 });
    // 순간 2026-10-10T02:00Z 는 뉴욕(EDT)으로 10-09 22:00 — 한국으로는 이미 10-10 11:00
    setDailyClock(() => new Date("2026-10-10T02:00:00Z"));
    await 원장쓰기([원장줄("채널N", "n1", "2026-10-10T01:00:00Z")]); // 뉴욕 10-09 21:00 = 오늘
    await 한도에걸리나("Z 가 붙은 업로드 시각은 정책 시간대의 날짜로 옮겨 센다", () => uploadSlot(뉴욕, undefined, async () => {}), /업로드 완료/);
    await 원장쓰기([원장줄("채널N", "n2", "2026-10-10T05:00:00Z")]); // 뉴욕 10-10 01:00 = 내일
    같나("정책 시간대로 내일인 기록은 오늘 칸을 안 쓴다", await uploadSlot(뉴욕, undefined, async () => "통과"), "통과");
    await 원장쓰기([원장줄("채널N", "n3", "2026-10-09T23:00:00")]); // 시간대 표시가 없으면 적힌 숫자가 그 시간대의 벽시계
    await 한도에걸리나("시간대 표시가 없으면 적힌 숫자가 그 정책 시간대의 시각", () => uploadSlot(뉴욕, undefined, async () => {}), /업로드 완료/);
  });

  구역("종류 표시가 없는 일감은 실제 파일로 잰다 (롱폼이 쇼츠 한도를 먹지 않게)");
  await 모래상자(async (dir) => {
    forceToolMissing("ffprobe"); // 손으로 짠 최소 MP4 를 내장 판독기가 읽는다
    await 영상쓰기(`${dir}/세로.mp4`, { w: 1080, h: 1920, sec: 40 });
    await 영상쓰기(`${dir}/가로.mp4`, { w: 1920, h: 1080, sec: 202 });
    await writePolicy(정책B);
    await writePolicy(정책C);
    얼리기(NOW12);
    await 원장쓰기(Array.from({ length: 6 }, (_, i) => 원장줄("채널B", `S${i}`, "2026-10-12T08:00:00", `2026-10-12 ${두자리(9 + i)}:00`)));
    await 한도에걸리나("쇼츠 정책 — 표시 없는 세로 파일은 쇼츠로 재서 막는다", () => uploadSlot(B, { channel: B, file: `${dir}/세로.mp4` }, async () => {}), /업로드 완료/);
    같나("쇼츠 정책 — 표시 없는 가로 파일은 롱폼으로 재서 한도 밖", await uploadSlot(B, { channel: B, file: `${dir}/가로.mp4` }, async () => "통과"), "통과");
    같나("파일을 못 재면 쇼츠로 센다 — 한도가 찬 쇼츠 정책은 막는다(올리기 단계가 따로 거절한다)", await (async () => {
      try { await uploadSlot(B, { channel: B, file: `${dir}/없는파일.mp4` }, async () => "통과"); return "통과"; } catch (e) { return e instanceof DailyLimitReached ? "막힘" : "다른 오류"; }
    })(), "막힘");
    같나("빈 일감({})도 쇼츠로 센다", await (async () => {
      try { await uploadSlot(B, {}, async () => "통과"); return "통과"; } catch (e) { return e instanceof DailyLimitReached ? "막힘" : "다른 오류"; }
    })(), "막힘");

    얼리기(NOW15);
    await 원장쓰기([원장C("롱폼", "a", "2026-10-16 09:00"), 원장C("롱폼", "b", "2026-10-16 11:00")]);
    await 한도에걸리나("롱폼 정책 — 표시 없는 가로 파일은 롱폼으로 재서 공개 칸을 본다",
      () => uploadSlot(C, { channel: C, file: `${dir}/가로.mp4`, publish_at: "2026-10-16 13:00" }, async () => {}), /공개 예약 한도/);
    같나("롱폼 정책 — 표시 없는 세로 파일은 쇼츠라 한도 밖", await uploadSlot(C, { channel: C, file: `${dir}/세로.mp4`, publish_at: "2026-10-16 13:00" }, async () => "통과"), "통과");
  });

  구역("같은 채널에 쇼츠용·롱폼용 정책이 따로 있어도 올바른 쪽이 걸린다");
  await 모래상자(async () => {
    const 한채널 = 아이디("m");
    await writePolicy({ ...정책B, channel_id: 한채널, label: "채널M 쇼츠", aliases: [], daily_limit: 1 });
    // 롱폼용은 다른 파일로 직접 놓는다(writePolicy 는 channel_id 하나에 파일 하나만 두므로)
    await Deno.writeTextFile(dataPath("채널M롱폼_daily_policy.json"), JSON.stringify({
      schema: SCHEMA_V2, label: "채널M 롱폼", channel_id: 한채널, kind: "롱폼", timezone: "Asia/Seoul",
      daily_limit: 1, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50,
    }));
    얼리기(NOW12);
    await 원장쓰기([
      원장줄(한채널, "s1", "2026-10-12T08:00:00", "2026-10-12 09:00"),
      원장줄(한채널, "l1", "2026-10-12T08:30:00", "2026-10-12 10:00", "롱폼"),
    ]);
    await 한도에걸리나("쇼츠 일감은 쇼츠용 정책에 걸린다", () => uploadSlot(한채널, { allow_not_short: false }, async () => {}), /채널M 쇼츠 하루 1편/);
    await 한도에걸리나("롱폼 일감은 롱폼용 정책에 걸린다(앞 정책이 종류가 달라도 건너뛴다)", () => uploadSlot(한채널, { 롱폼: true }, async () => {}), /채널M 롱폼 하루 1편/);
  });
}

/* ============================================================ 깨진 것들 */

async function 깨진것들() {
  setDailyClock(null);
  구역("깨진 정책 파일은 그 채널만 건너뛰고 다른 채널은 계속 편성한다");
  await 모래상자(async () => {
    await writePolicy(정책A);
    const 기본 = { timezone: "Asia/Seoul", daily_limit: 6, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50 };
    const 놓기 = (이름: string, v: unknown) => Deno.writeTextFile(dataPath(이름), typeof v === "string" ? v : JSON.stringify(v));
    const q = (c: string) => 아이디(c);
    await 놓기("bad1_daily_policy.json", "{ 이건 JSON 이 아니다");
    await 놓기("bad2_daily_policy.json", { schema: "channel-daily-cap-v9", channel_id: q("1"), ...기본 });
    await 놓기("bad3_daily_policy.json", { schema: SCHEMA_V1, channel_id: q("2"), ...기본, daily_limit: 0 });
    await 놓기("bad4_daily_policy.json", { schema: SCHEMA_V1, channel_id: q("3"), ...기본, timezone: "Mars/Base" });
    await 놓기("bad5_daily_policy.json", { schema: SCHEMA_V1, channel_id: q("4"), timezone: "Asia/Seoul", daily_limit: 6 }); // 하루 시작·간격 없음
    await 놓기("bad6_daily_policy.json", "[]");
    await 놓기("bad7_daily_policy.json", { schema: SCHEMA_V1, channel_id: q("5"), ...기본, aliases: "채널X" });
    await 놓기("bad8_daily_policy.json", { schema: SCHEMA_V2, channel_id: q("6"), ...기본, kind: "아무거나" });
    await 놓기("bad9_daily_policy.json", { schema: SCHEMA_V1, ...기본 }); // channel_id 없음

    같나("읽히는 것은 멀쩡한 하나뿐", loadPolicies().map((p) => p.cfg.channel_id), [A]);
    const 본문 = await 기록을기다리기(
      "bad1_daily_policy.json 읽기 오류", "bad2_daily_policy.json: 알 수 없는 schema", "bad3_daily_policy.json 읽기 오류",
      "bad4_daily_policy.json 읽기 오류", "bad5_daily_policy.json 읽기 오류", "bad6_daily_policy.json: 알 수 없는 schema",
      "bad7_daily_policy.json 읽기 오류", "bad8_daily_policy.json 읽기 오류", "bad9_daily_policy.json 읽기 오류");
    for (const n of [1, 3, 4, 5, 7, 8, 9]) 참인가(`bad${n} — 읽기 오류 한 줄이 남는다`, 본문.includes(`bad${n}_daily_policy.json 읽기 오류`));
    for (const n of [2, 6]) 참인가(`bad${n} — 모르는 schema 한 줄이 남는다`, 본문.includes(`bad${n}_daily_policy.json: 알 수 없는 schema`));
    loadPolicies(); loadPolicies();
    await new Promise((r) => setTimeout(r, 300)); // 두 번 더 읽으며 남긴 기록(있다면)이 파일에 닿을 때까지
    const 다시 = await 기록을기다리기("bad1_daily_policy.json 읽기 오류");
    같나("같은 문제를 읽을 때마다 기록에 쌓지 않는다(한 번만)", 몇번나오나(다시, "bad1_daily_policy.json 읽기 오류"), 1);

    const 큐: Job[] = [
      ...일감A(7),
      { channel: q("1"), file: "/fixture/q1.mp4", 쏠때: "2026-10-09T01:00:00", publish_at: "2026-10-09 02:00" },
      { channel: q("2"), file: "/fixture/q2.mp4", 쏠때: "2026-10-09T01:00:00" },
      { channel: q("4"), file: "/fixture/q4.mp4", 쏠때: "2026-10-09T01:00:00" },
    ];
    const planned = reflow(큐, { now: NOW9, ledger: [], pending: [] });
    같나("멀쩡한 채널은 계속 편성된다(하루 6편, 일곱째는 내일)", 날짜별(planned.slice(0, 7), "쏠때"), { "2026-10-09": 6, "2026-10-10": 1 });
    같은가("정책이 깨진 채널의 줄은 손대지 않는다", planned.slice(7), 큐.slice(7));
  });

  구역("모르면 막는다 — 읽을 수 없는 시각·깨진 검토대기");
  await 모래상자(async () => {
    await writePolicy(정책A);
    await 던지나("원장의 업로드 시각을 못 읽으면 편성을 멈춘다(모르는 채 세면 한도를 넘는다)",
      () => reflow(일감A(1), { now: NOW9, ledger: [원장줄("채널A", "v1", "엉터리")], pending: [] }), /원장 업로드시각/);
    await 던지나("검토대기의 공개 예정 시각을 못 읽어도 멈춘다",
      () => reflow(일감A(1), { now: NOW9, ledger: [], pending: [{ channel: "채널A", video_id: "p1", publish_at: "엉터리" }] }), /검토대기 공개 예정 시각/);
    await 던지나("일감의 쏠때를 못 읽어도 멈춘다", () => reflow([{ ...일감A(1)[0], 쏠때: "엉터리" }], { now: NOW9, ledger: [], pending: [] }), /쏠때/);

    // 검토대기 파일이 깨졌으면 편성은 이어가되 한 줄 남긴다
    await Deno.writeTextFile(dataPath("pending.json"), "{ nope");
    const planned = reflow(일감A(7), { now: NOW9 }); // ledger·pending 을 안 주면 파일에서 읽는다
    같나("깨진 pending.json 이어도 원장만으로 편성한다", 날짜별(planned, "쏠때"), { "2026-10-09": 6, "2026-10-10": 1 });
    const 본문 = await 기록을기다리기("pending.json 이 깨져 있습니다");
    참인가("깨진 pending.json 은 조용히 삼키지 않고 한 줄 남긴다", 본문.includes("pending.json 이 깨져 있습니다"));
    await Deno.writeTextFile(dataPath("pending.json"), JSON.stringify({ 목록아님: true }));
    reflow(일감A(1), { now: NOW9 });
    참인가("목록이 아닌 pending.json 도 한 줄 남긴다", (await 기록을기다리기("pending.json 이 목록이 아닙니다")).includes("pending.json 이 목록이 아닙니다"));

    // 파일에서 읽는 길 — 원장·검토대기 파일을 그대로 쓴다
    await 원장쓰기(완료A(6));
    await 대기쓰기([]);
    같나("원장 파일에서 읽어 오늘이 찬 것을 안다", reflow(일감A(1), { now: NOW9 })[0].쏠때.slice(0, 10), "2026-10-10");
    await 원장쓰기([]);
    await 대기쓰기([{ channel: "채널A", video_id: "p1", publish_at: "2026-10-09T00:00:00Z" }]);
    같나("검토대기 파일에서 읽은 공개 예정도 센다(09시 → 07:50 은 2시간 안쪽이라 09:00 이후로)", reflow(일감A(1), { now: NOW9 })[0].publish_at, "2026-10-09 11:00");
  });

  구역("입력을 바꾸지 않는다");
  await 모래상자(async () => {
    await writePolicy(정책B);
    const 큐 = [...Array.from({ length: 8 }, (_, i) => 쇼츠일감(i)), { channel: Z, file: "/fixture/other.mp4", 쏠때: "2026-10-14T07:00:00" }];
    const 사본 = JSON.parse(JSON.stringify(큐));
    const 원장 = [원장줄("채널B", "a", "2026-10-11T09:20:00", "2026-10-12 09:15")];
    const 원장사본 = JSON.parse(JSON.stringify(원장));
    reflow(큐, { now: NOW12, ledger: 원장, pending: [] });
    repack(큐, "채널B", { today: 1, now: NOW12, ledger: 원장, pending: [], first: ["/fixture/s02.mp4"] });
    같나("reflow·repack 이 큐를 안 바꾼다", 큐, 사본);
    같나("원장 줄도 안 바꾼다", 원장, 원장사본);
    같나("정책이 없는 채널만 있는 큐는 그대로(복사만)", reflow([{ channel: Q, file: "/x.mp4" }], { now: NOW12, ledger: [], pending: [] }), [{ channel: Q, file: "/x.mp4" }]);
    같나("빈 큐", reflow([], { now: NOW12, ledger: [], pending: [] }), []);
  });
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

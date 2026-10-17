// 계획 시험 — 이 영상이 이 채널 것인가(verify) · 업로드 시각(schedule) · 폴더를 훑어 올리기(plan).
//
// 원본(파이썬)에는 이 모듈들의 시험이 없다(tests/ 에 run·schedule 시험 없음). 원본 docstring 이 약속하는 성질과, 원본 함정 기록에서 뽑은
// 사고(1.1 「1개를 골랐는데 7개가 올라갔다」 · 1.4 「예약이 과거였다」 · 5.3 「새벽 0시·4시로 밀렸다」 · 6.2 「--go 만 쳐도 올라갔다」)를
// 시험으로 못 박았다. 거기에 새 앱에서 일반화한 것들(쇼츠/롱폼 따로 · 일 한도 정책 · 같은 날 두 번 안 담김)을 더했다.
//
// 구글에는 한 번도 닿지 않는다: 가짜 서버(가짜구글.ts)와 임시 폴더(모래상자)만 쓴다. 채널 이름·ID 는 모두 가짜다.
//   실행:  TZ=Asia/Seoul deno run -A --no-lock 시험/계획.ts
import { 같나, 결과, 구역, 모래상자, 영상쓰기, type Fx } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { setEmbeddedForTest } from "../app/embedded.ts";
import { saveStore, SCOPES, type Store, updateStore } from "../app/ytcore.ts";
import { baseName, dataPath, join, readJsonSync, recordPath, writeJson } from "../app/paths.ts";
import { channelsPath, loadChannels, writeMark } from "../app/channels.ts";
import { forceToolMissing } from "../app/tools.ts";
import { addDays, dateOnly, isoWall, minuteWall, parseWall, systemZone, wall, wallNow, wallToInstant, withTime } from "../app/clock.ts";
import { LEDGER_HEAD, readLedger, writeLedgerRaw } from "../app/ledger.ts";
import { isLocked, resetSafetyCache, setLocked } from "../app/safety.ts";
import { fire, readQueue } from "../app/queue.ts";
import { loadPending } from "../app/review.ts";
import { SCHEMA_APPROVED, setDailyClock, writePolicy } from "../app/daily.ts";
import { dailyCached, dailyRemember, insightRemember, perfUpdate } from "../app/perf.ts";
import { checkChannelConf, checkFile } from "../app/verify.ts";
import { bar, DEFAULT_WINDOW, future, hashSeed, normalizeWindow, plan as planTimes, timeline, todayStr } from "../app/schedule.ts";
import {
  cmdCheck, cmdLearn, cmdPreview, cmdStatus, dailyForChannel, guard, lampLine, loadChannelsPlan, perfBrief, run,
} from "../app/plan.ts";

/* ─────────── 재료 ─────────── */

const 아이디 = (c: string) => "UC" + c.repeat(22); // 소스에 UC+22자를 직접 쓰지 않는다(공통 규칙 3)
const A = 아이디("a"), B = 아이디("b"), P = 아이디("p"), Q = 아이디("q");

/** 세로 쇼츠 · 길이·크기가 편마다 다르게(같은 영상 묶음 경고에 안 걸리게) */
const 세로 = (i = 0): Fx => ({ w: 1080, h: 1920, sec: 20 + i, extraBytes: 64 + i * 7 });
const 가로 = (i = 0): Fx => ({ w: 1920, h: 1080, sec: 240 + i, extraBytes: 64 + i * 7 });

/** 오늘 10시 (이 컴퓨터 시간대). 날짜는 진짜 오늘이라, 시험이 진짜 시각으로 적는 원장·기록과 날짜가 맞는다. */
const 지금벽 = withTime(wallNow(), 10, 0);
const 지금순간 = wallToInstant(지금벽, systemZone());
const 오늘 = dateOnly(지금벽);

const 두자리 = (n: number) => String(n).padStart(2, "0");
const 분으로 = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

interface 칸 { 이름: string; id: string; 설정?: Record<string, unknown> }

/** 가짜 구글 + 채널 설정 + 토큰 + 폴더 */
async function 세상(dir: string, 칸들: 칸[]): Promise<가짜구글> {
  const g = new 가짜구글().install();
  setEmbeddedForTest("browser", { client_id: "시험열쇠", client_secret: "비밀아님" });
  forceToolMissing("ffprobe"); // 내장 판독기로 — 외부 도구 없이
  const store: Store = {};
  const conf: Record<string, unknown> = {};
  for (const [i, c] of 칸들.entries()) {
    // 가짜 접근 토큰이 헤더에 실리므로 새로고침 토큰은 영문이어야 한다
    g.addChannel({ id: c.id, title: c.이름 }, `RT${i}`);
    store[c.이름] = {
      channel_id: c.id, title: c.이름, refresh_token: `RT${i}`, added: "2026-10-01", scopes: [...SCOPES],
    };
    const folder = `${dir}/영상/${c.이름}`;
    await Deno.mkdir(folder, { recursive: true });
    conf[c.이름] = { channel_id: c.id, folder, publish: "schedule", daily_rule: "fixed", daily: 2, pick: "oldest", ...c.설정 };
  }
  await saveStore(store);
  await writeJson(channelsPath(), conf);
  return g;
}

/** 영상 여러 편 — 앞 이름일수록 폴더에 오래 있었던 것으로 (수정 시각을 며칠씩 벌린다) */
async function 영상들(폴더: string, 이름들: string[], fx: (i: number) => Fx = 세로): Promise<string[]> {
  const out: string[] = [];
  for (const [i, 이름] of 이름들.entries()) {
    const p = join(폴더, 이름);
    await 영상쓰기(p, fx(i));
    const t = new Date(Date.now() - (이름들.length - i + 3) * 86_400_000);
    await Deno.utime(p, t, t);
    out.push(p);
  }
  return out;
}

const 폴더 = (dir: string, 이름: string) => `${dir}/영상/${이름}`;
async function 파일있나(p: string): Promise<boolean> { try { await Deno.stat(p); return true; } catch { return false; } }
const 모음 = () => { const 줄: string[] = []; return { 줄, say: (s: string) => { 줄.push(s); } }; };
const 글에있나 = (줄: string[], 조각: string) => 줄.some((x) => x.includes(조각));

export async function 실행() {
  try {
    await 확인();
    await 시각();
    await 불러오기와점검();
    await 문지기();
    await 미리보기와담기();
    await 직접고르기();
    await 올리다실패();
    await 한밤();
    await 쇼츠롱폼분리();
    await 일한도정책();
    await 걸러내기();
    await 미리보기자료();
    await 성적과배움();
  } finally {
    setDailyClock(null);
  }
}

/* ============================================================ verify */

async function 확인() {
  구역("확인 — 이 영상이 이 채널 것인가 (verify)");
  await 모래상자(async (dir) => {
    const 폴 = `${dir}/영상/채널A`;
    await Deno.mkdir(`${폴}/업로드완료`, { recursive: true });
    const 영상 = join(폴, "AB_001.mp4");
    await 영상쓰기(영상, 세로());

    같나("머리말이 맞고 이력이 없으면 통과", await checkFile(영상, { prefix: "AB_" }), [true, []]);
    같나("머리말이 비어 있으면 이름 검사는 건너뛴다", (await checkFile(영상, { prefix: "" }))[0], true);
    같나("머리말이 없는 설정도 통과", (await checkFile(영상, {}))[0], true);
    const 틀림 = await checkFile(영상, { prefix: "ZZ_" });
    같나("머리말이 다르면 막는다", [틀림[0], 틀림[1].length, 틀림[1][0].includes("'ZZ_' 로 시작하지 않습니다")], [false, 1, true]);
    같나("공백만 있는 머리말은 비어 있는 것", (await checkFile(영상, { prefix: "  " }))[0], true);

    // 맥은 파일 이름을 풀어쓴 꼴(NFD)로 줄 수 있다 — 같은 글자인데 막으면 멀쩡한 영상이 「검토필요」로 옮겨진다
    const 한글 = join(폴, "가나다_001.mp4".normalize("NFD"));
    await 영상쓰기(한글, 세로(1));
    같나("풀어쓴 한글 이름도 같은 머리말로 본다", (await checkFile(한글, { prefix: "가나다_".normalize("NFC") }))[0], true);

    // 2) 완료 폴더에 같은 이름
    await 영상쓰기(join(폴, "업로드완료", "AB_001.mp4"), 세로());
    const 완료 = await checkFile(영상, { prefix: "AB_" });
    같나("완료 폴더에 같은 이름이 있으면 막는다", [완료[0], 완료[1][0].includes("'업로드완료' 에 같은 이름이 있습니다")], [false, true]);

    // 3) 원장에 같은 이름 — 폴더를 옮기거나 지워도 원장은 남는다
    await Deno.remove(join(폴, "업로드완료", "AB_001.mp4"));
    await writeLedgerRaw([[...LEDGER_HEAD], LEDGER_HEAD.map((h) => ({ 업로드시각: "2026-10-01T09:00:00", 채널: "채널A", 영상ID: "vid1", 파일: "/예전/자리/AB_001.mp4" } as Record<string, string>)[h] ?? "")]);
    const 이력 = await checkFile(영상, { prefix: "AB_" });
    같나("원장에 같은 이름이 있으면 막는다(다른 폴더에서 올렸어도)", [이력[0], 이력[1][0]], [false, "이미 올린 영상입니다 — 2026-10-01 [채널A] https://youtu.be/vid1"]);
    같나("미리 읽은 원장을 넘겨도 같은 답", (await checkFile(영상, { prefix: "AB_" }, new Map([["AB_001.mp4", ["2026-10-01", "채널A", "vid1"]]])))[1], 이력[1]);
    같나("문제가 여럿이면 다 모은다", (await checkFile(영상, { prefix: "ZZ_" }))[1].length, 2);

    // 채널 설정 자체
    await updateStore((s) => { s.채널A = { channel_id: A, title: "채널A", refresh_token: "x", added: "" }; });
    const 토큰 = { 채널A: { channel_id: A } };
    같나("온전한 설정은 문제가 없다", checkChannelConf("채널A", { folder: 폴, channel_id: A }, 토큰), []);
    같나("폴더가 없다", checkChannelConf("채널A", { channel_id: A }, 토큰), ["폴더가 지정되지 않았습니다"]);
    같나("폴더를 찾을 수 없다", checkChannelConf("채널A", { folder: `${dir}/없음`, channel_id: A }, 토큰)[0], `폴더를 찾을 수 없습니다: ${dir}/없음`);
    같나("channel_id 가 없다", checkChannelConf("채널A", { folder: 폴 }, 토큰)[0].startsWith("channel_id 가 없습니다"), true);
    같나("인증 안 된 채널", checkChannelConf("채널A", { folder: 폴, channel_id: B }, 토큰)[0].startsWith(`인증되지 않은 채널입니다 (${B})`), true);
    같나("문제는 모두 모은다", checkChannelConf("채널A", {}, {}).length, 2);
  });
}

/* ============================================================ schedule */

function 시각() {
  구역("시각 — 4시간 간격 · 정각 피하기 · 창 안 · 같은 날 같은 시각 (schedule)");
  const 창들: [number, number][] = [[9, 22], [9, 21], [8, 12], [0, 24], [10, 23]];
  let 조합 = 0, 비결정 = 0, 창밖 = 0, 정각 = 0, 간격 = 0;
  for (const 창 of 창들) {
    for (let d = 1; d <= 28; d++) for (const 채널 of ["채널A", "채널B", A]) for (let n = 1; n <= 6; n++) {
      const 날 = `2027-02-${두자리(d)}`;
      const ts = planTimes(날, 채널, n, 창)[0];
      조합++;
      if (JSON.stringify(ts) !== JSON.stringify(planTimes(날, 채널, n, 창)[0])) 비결정++;
      ts.forEach((t, i) => {
        const m = 분으로(t);
        if (m < 창[0] * 60 || m > 창[1] * 60 - 1) 창밖++;
        if (m % 60 === 0) 정각++;
        if (i > 0 && m - 분으로(ts[i - 1]) < 240) 간격++;
      });
    }
  }
  같나(`${조합}가지 조합에서 같은 (날짜·채널)은 늘 같은 시각`, 비결정, 0);
  같나("모든 시각이 창 안(마지막 1분 전까지)", 창밖, 0);
  같나("정각(분 0)이 하나도 안 나온다", 정각, 0);
  같나("칸 사이 간격이 늘 4시간 이상", 간격, 0);

  const [세개, 노트] = planTimes("2027-02-10", "채널A", 3);
  같나("3개를 창 안에 배치", 세개.length, 3);
  같나("안내문에 개수와 간격", 노트.startsWith("3개 · 간격 "), true);
  같나("날이 바뀌면 다른 시각", JSON.stringify(세개) !== JSON.stringify(planTimes("2027-02-11", "채널A", 3)[0]), true);
  같나("채널이 다르면 다른 시각", JSON.stringify(세개) !== JSON.stringify(planTimes("2027-02-10", "채널B", 3)[0]), true);
  같나("0개는 비어 있다", planTimes("2027-02-10", "채널A", 0), [[], "올릴 것이 없습니다"]);
  const [넘침, 넘침노트] = planTimes("2027-02-10", "채널A", 9);
  같나("창이 좁으면 간격을 줄이지 않고 편수를 줄인다", [넘침.length, 넘침노트], [4, "9~22시 안에 4시간 간격으로는 4개까지만 들어갑니다"]);
  같나("창이 딱 4시간의 배수여도 간격이 모자라지 않는다", planTimes("2027-02-10", "채널A", 4, [9, 21])[0].length, 3);
  같나("망가진 창은 기본 창으로", [normalizeWindow([22, 9]), normalizeWindow(undefined), normalizeWindow([9, 22])], [DEFAULT_WINDOW, DEFAULT_WINDOW, [9, 22]]);
  같나("씨앗은 글자마다 다르다", hashSeed("a|b") !== hashSeed("a|c"), true);
  같나("오늘 날짜 글", todayStr(0, wall(2027, 2, 10, 23, 59)), "2027-02-10");
  같나("며칠 뒤", todayStr(3, wall(2027, 2, 27, 8)), "2027-03-02");

  // 과거 방지 (함정 1.4 · 5.3)
  const 저녁 = wall(2027, 2, 10, 20, 0, 30); // 저녁 8시: 오늘 15:32 같은 시각이 이미 지났다
  같나("지난 시각을 그대로 두지 않는다", future("2027-02-10", ["10:12", "15:32"], DEFAULT_WINDOW, 240, 12, 저녁)[0] >= "2027-02-10 20:12", true);
  const 밀림 = future("2027-02-10", ["10:12", "15:32", "19:50"], DEFAULT_WINDOW, 240, 12, 저녁);
  같나("저녁 8시: 첫 칸은 지금 바로 뒤, 나머지는 4시간 간격으로 다음 날 아침부터", 밀림, ["2027-02-10 20:12", "2027-02-11 09:12", "2027-02-11 13:12"]);
  같나("새벽 0시·4시로 밀리지 않는다(함정 5.3)", 밀림.every((t) => { const h = +t.slice(11, 13); return h >= 9 && h < 22; }), true);
  const 이른아침 = wall(2027, 2, 10, 3, 0, 30);
  같나("창이 열리기 전이면 시각을 건드리지 않는다", future("2027-02-10", ["10:12", "15:32", "19:50"], DEFAULT_WINDOW, 240, 12, 이른아침), ["2027-02-10 10:12", "2027-02-10 15:32", "2027-02-10 19:50"]);
  같나("창 안에서 지난 시각은 지금 + 여유분(12분)", future("2027-02-10", ["10:12"], DEFAULT_WINDOW, 240, 12, wall(2027, 2, 10, 12, 0, 10)), ["2027-02-10 12:12"]);
  같나("간격이 모자라면 앞 칸에서 4시간 뒤로", future("2027-02-10", ["10:00", "11:00"], DEFAULT_WINDOW, 240, 12, wall(2027, 2, 10, 6, 0))[1], "2027-02-10 14:00");
  같나("날짜 글을 못 읽으면 오늘로", future("엉터리", ["23:00"], DEFAULT_WINDOW, 240, 12, wall(2027, 2, 10, 6, 0)), [future("2027-02-10", ["23:00"], DEFAULT_WINDOW, 240, 12, wall(2027, 2, 10, 6, 0))[0]]);
  같나("빈 목록은 빈 목록", future("2027-02-10", [], DEFAULT_WINDOW, 240, 12, 저녁), []);
  같나("바닥(마지막 예약 뒤)보다 이르면 바닥으로", future("2027-02-10", ["10:12", "15:32"], DEFAULT_WINDOW, 240, 12, wall(2027, 2, 10, 9, 0), wall(2027, 2, 10, 16, 5)), ["2027-02-10 16:05", "2027-02-10 20:05"]);
  같나("바닥이 먼 날이면 그날부터 이어 붙인다", future("2027-02-10", ["10:12"], DEFAULT_WINDOW, 240, 12, wall(2027, 2, 10, 9, 0), wall(2027, 2, 12, 10, 30)), ["2027-02-12 10:30"]);
  같나("사람이 정한 정각 시각은 건드리지 않는다", future("2027-02-10", ["14:00"], DEFAULT_WINDOW, 240, 12, wall(2027, 2, 10, 6, 0)), ["2027-02-10 14:00"]);

  // 눈으로 보는 것
  같나("막대: 0이어도 한 칸은 남긴다", bar(1, 1000, 18), "█" + "·".repeat(17));
  같나("막대: 값이 0이면 빈 막대", bar(0, 10, 4), "····");
  같나("막대: 합이 0이면 빈 막대", bar(3, 0, 4), "····");
  같나("막대: 반", bar(5, 10, 4, "▓"), "▓▓··");
  같나("막대: 값이 합보다 커도 던지지 않는다", bar(12, 10, 5).length >= 5, true);
  같나("하루 한 줄: 시작·끝 칸에 표시", timeline(["09:00", "21:59"], [9, 22], 10), "▼────────▼");
  같나("하루 한 줄: 폭", timeline(["10:00"], [9, 22]).length, 46);
}

/* ============================================================ 불러오기 · 점검 · 현황 */

async function 불러오기와점검() {
  구역("채널 불러오기 · 오늘 몇 개 · 점검 · 현황");
  await 모래상자(async (dir) => {
    const { 줄, say } = 모음();
    같나("채널 설정 파일이 없으면 빈 사전(첫 화면이 죽지 않는다)", loadChannelsPlan(say), {});
    같나("그때 말은 한 줄", 줄.length, 1);

    const g = await 세상(dir, [
      { 이름: "채널A", id: A, 설정: { daily_rule: "fixed", daily: 3 } },
      { 이름: "채널B", id: B, 설정: { daily_rule: "views", daily_fallback: 2 } },
    ]);
    await writeJson(channelsPath(), { _메모: "이름이 _ 로 시작하는 칸은 빼야 한다", ...readJsonSync<Record<string, unknown>>(channelsPath(), {}) });
    const chans = loadChannelsPlan(모음().say);
    같나("메모 칸은 채널이 아니다", Object.keys(chans), ["채널A", "채널B"]);

    // ── 오늘 몇 개
    같나("고정 편수", await dailyForChannel("채널A", chans.채널A), [3, "고정 3개"]);
    같나("아직 안 읽었으면 기본값과 안내(유튜브에 묻지 않는다)", await dailyForChannel("채널B", chans.채널B), [2, "아직 안 읽음 — [갱신]을 누르면 조회수로 정합니다"]);
    같나("묻지 않았으니 호출은 0건", g.calls.length, 0);
    await dailyRemember("채널B", [4, "최근 3개 [1] 최고 1회 → 하루 4개"]);
    같나("적어 둔 값을 쓴다", await dailyForChannel("채널B", chans.채널B), [4, "최근 3개 [1] 최고 1회 → 하루 4개"]);
    같나("그래도 호출은 0건", g.calls.length, 0);

    // 새로 읽기(live) — 성숙한 영상의 최고 조회수로 정한다
    g.addVideo({ id: "hv1", channelId: B, snippet: { title: "옛 영상", publishedAt: new Date(Date.now() - 5 * 86_400_000).toISOString() }, statistics: { viewCount: "12000" } });
    const 새로 = await dailyForChannel("채널B", chans.채널B, true);
    같나("조회수 1만 이상이면 하루 2개", 새로[0], 2);
    같나("근거 글에 최고 조회수", 새로[1].includes("최고 12,000회"), true);
    같나("읽은 값을 적어 둔다", (await dailyCached("채널B"))?.[0], 2);

    // ── 점검
    const 점검줄 = 모음();
    const 점검 = await cmdCheck(chans, 점검줄.say);
    같나("점검: 둘 다 폴더가 있고 인증됐다", [점검.total, 점검.bad], [2, 0]);
    await updateStore((s) => { delete s.채널B; });
    const 나쁨줄 = 모음();
    const 나쁨 = await cmdCheck(chans, 나쁨줄.say);
    같나("인증이 빠진 채널을 짚는다", [나쁨.bad, 나쁨.rows[1].ok, 글에있나(나쁨줄.줄, "인증되지 않은 채널입니다")], [1, false, true]);
    await saveStore({
      채널A: { channel_id: A, title: "채널A", refresh_token: "RT0", added: "", scopes: [...SCOPES] },
      채널B: { channel_id: B, title: "채널B", refresh_token: "RT1", added: "", scopes: [...SCOPES] },
    });

    // ── 현황 (저장해 둔 값만 — 유튜브를 안 부른다)
    await 영상들(폴더(dir, "채널A"), ["a1.mp4", "a2.mp4", "a3.mp4"]);
    await 영상쓰기(join(폴더(dir, "채널A"), "업로드완료", "old.mp4"), 세로(9));
    await perfUpdate((c) => {
      c.채널A = { rows: [
        { id: "x1", title: "t1", views: 1000, likes: 50, comments: 3, vpd: 100, age: 10, at: "10/01" },
        { id: "x2", title: "t2", views: 20000, likes: 400, comments: 9, vpd: 100, age: 10, at: "10/02" },
        { id: "x3", title: "t3", views: 3000, likes: null, comments: null, vpd: 100, age: 10, at: "10/03" },
      ] };
    });
    g.clearCalls();
    같나("성적 한 줄: 저장본에서(중앙 3,000 · 최고 2.0만 · 좋아요 중앙값 · 댓글 중앙)", await perfBrief(A),
      "직전 3개 중앙 3,000 · 최고 2.0만 · 좋아요 3.5% · 댓글 중앙 6");
    같나("성적이 없는 채널은 빈 글", await perfBrief(B), "");
    const 현황줄 = 모음();
    const 현황 = await cmdStatus(chans, 현황줄.say);
    같나("현황: 채널A 대기 3 · 완료 1", [현황.rows[0].count, 현황.rows[0].daily, 현황.total], [{ 대기: 3, 완료: 1, 검토필요: 0 }, 3, { 대기: 3, 완료: 1, 검토필요: 0 }]);
    같나("현황: 재고는 대기/오늘편수 = 1일치 → 곧 떨어진다는 표시", 현황줄.줄.some((x) => x.includes("1.0일⚠")), true);
    같나("현황에 성적 한 줄이 따라붙는다", 글에있나(현황줄.줄, "직전 3개 중앙 3,000"), true);
    같나("현황을 봐도 유튜브 호출은 0건", g.calls.length, 0);
    같나("합계 줄", 글에있나(현황줄.줄, "합계"), true);
    await Deno.remove(폴더(dir, "채널B"), { recursive: true });
    const 없는 = await cmdStatus(chans, 모음().say);
    같나("폴더가 사라진 채널은 「폴더 없음」", [없는.rows[1].count, 없는.rows[1].why], [null, "폴더 없음"]);

    // ── 실행 전 점검
    await Deno.mkdir(폴더(dir, "채널B"), { recursive: true });
    const 경고줄 = 모음();
    const 문 = await guard(chans, true, 경고줄.say);
    같나("표식이 없으면 경고만 하고 통과", [문.ok, 문.fatal.length, 문.warn.length], [true, 0, 2]);
    await writeMark(폴더(dir, "채널B"), 아이디("z"), "다른채널", "다른채널");
    const 막힘줄 = 모음();
    const 막힘 = await guard(chans, true, 막힘줄.say);
    같나("폴더가 다른 채널 것이면 막는다", [막힘.ok, 막힘.fatal.length, 글에있나(막힘줄.줄, "폴더 확인이 필요해 실행하지 않습니다")], [false, 1, true]);

    // ── 신호등
    같나("신호등: 정상", lampLine({ red: 0, yellow: 0 }, 모음().say), "  ● 정상");
    같나("신호등: 경고만", lampLine({ red: 0, yellow: 2 }, 모음().say), "  ● 작업불이행·경고 2건");
    같나("신호등: 오류", lampLine({ red: 1, yellow: 2 }, 모음().say), "  ● 오류 1건 · 작업불이행·경고 2건");
  });
}

/* ============================================================ 문지기 (함정 6.2) */

async function 문지기() {
  구역("문지기 — 고르지 않고 --go 만 주면 거부 (함정 6.2) · 잠금");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A }]);
    await 영상들(폴더(dir, "채널A"), ["a1.mp4", "a2.mp4"]);
    g.clearCalls();

    const { 줄, say } = 모음();
    const r1 = await run(true, undefined, undefined, { say, clock: 지금순간 });
    같나("--pick 도 --auto-ok 도 없이 go 만 주면 거부한다", [r1.refused.includes("올릴 영상을 고르지 않았습니다"), r1.up, r1.queued], [true, 0, 0]);
    같나("거부 문구가 두 길을 알려 준다(--pick · --auto-ok)", [글에있나(줄, "--pick 파일명"), 글에있나(줄, "--go --auto-ok")], [true, true]);
    같나("아무것도 안 담고 아무것도 안 물었다", [readQueue().length, g.calls.length, readLedger().length], [0, 0, 0]);
    같나("거부는 파일도 안 건드린다", [await 파일있나(join(폴더(dir, "채널A"), "a1.mp4")), await 파일있나(join(폴더(dir, "채널A"), "검토필요"))], [true, false]);

    const 빈 = await run(true, [], [], { say: 모음().say, clock: 지금순간 });
    같나("빈 목록은 고르지 않은 것과 같다", 빈.refused.includes("올릴 영상을 고르지 않았습니다"), true);

    await setLocked(true);
    같나("잠가 두었다", isLocked(), true);
    const 잠김 = await run(true, ["a1.mp4"], undefined, { say: 모음().say, clock: 지금순간 });
    같나("잠겨 있으면 고르고 나서도 거부", [잠김.refused.includes("올리기가 잠겨 있습니다"), readQueue().length, g.calls.length], [true, 0, 0]);
    const 잠긴미리 = await run(false, undefined, undefined, { say: 모음().say, clock: 지금순간 });
    같나("잠겨 있어도 미리보기는 볼 수 있다", [잠긴미리.refused, 잠긴미리.go], ["", false]);
    await setLocked(false);

    // 미리보기(go 없음)는 고르지 않아도 된다
    const 미리 = await run(false, undefined, undefined, { say: 모음().say, clock: 지금순간 });
    같나("go 없이 보기만 하는 건 막지 않는다", 미리.refused, "");
  });
}

/* ============================================================ 미리보기 · 담기 · 같은 날 두 번 */

async function 미리보기와담기() {
  구역("자동 계획 — 미리보기 = 실제 · 발사대기에 담기 · 같은 날 두 번 안 담김");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { daily: 2 } }]);
    const 파일 = await 영상들(폴더(dir, "채널A"), ["a1.mp4", "a2.mp4", "a3.mp4"]);
    g.clearCalls();

    // ── 미리보기: 아무것도 바꾸지 않는다
    const 미 = 모음();
    const 미리 = await run(false, undefined, undefined, { say: 미.say, clock: 지금순간 });
    같나("미리보기: 오늘 몫 2개를 고른다(오래된 것부터)", 미리.items.map((x) => x.name), ["a1.mp4", "a2.mp4"]);
    같나("미리보기: 아무것도 안 담고 안 올렸다", [readQueue().length, readLedger().length, g.calls.length], [0, 0, 0]);
    같나("미리보기: 파일은 그대로", await Promise.all(파일.map(파일있나)), [true, true, true]);
    같나("미리보기: 말이 「미리보기 — 아무것도 바꾸지 않았습니다」로 끝난다", 글에있나(미.줄, "미리보기 — 아무것도 바꾸지 않았습니다"), true);
    같나("미리보기: 나머지 1개는 폴더에 둔다는 말", 글에있나(미.줄, "나머지 1개는 폴더에 그대로 둡니다"), true);
    같나("미리보기: 예상 시각과 하루 줄", [글에있나(미.줄, "예상 시각"), 미.줄.some((x) => x.includes("9시") && x.includes("▼"))], [true, true]);
    같나("미리보기: 같은 날 같은 계획(여러 번 돌려도 같은 시각)",
      JSON.stringify((await run(false, undefined, undefined, { say: 모음().say, clock: 지금순간 })).lines.filter((x) => x.includes("예상 시각"))),
      JSON.stringify(미.줄.filter((x) => x.includes("예상 시각"))));

    // ── 실제로 담기
    const 실 = 모음();
    const r = await run(true, undefined, undefined, { autoOk: true, say: 실.say, clock: 지금순간, who: "시험 승인" });
    같나("--auto-ok 로 맡기면 2개를 발사대기에 담는다", [r.refused, r.queued, r.up, r.failed], ["", 2, 0, 0]);
    const 큐 = readQueue().sort((a, b) => String(a["쏠때"]).localeCompare(String(b["쏠때"])));
    같나("큐: 오래된 두 편", 큐.map((j) => baseName(String(j.file))), ["a1.mp4", "a2.mp4"]);
    같나("큐: 올리는 시각 사이가 4시간 이상", (parseWall(String(큐[1]["쏠때"]))!.getTime() - parseWall(String(큐[0]["쏠때"]))!.getTime()) >= 240 * 60_000, true);
    같나("큐: 모두 지금 + 12분 뒤이고 창(9~22시) 안", 큐.every((j) => {
      const w = parseWall(String(j["쏠때"]))!;
      return w.getTime() >= 지금벽.getTime() + 12 * 60_000 && w.getUTCHours() >= 9 && w.getUTCHours() < 22 && w.getUTCMinutes() !== 0;
    }), true);
    같나("큐: 공개 시각은 비워 둔다(그 시각에 올림 → 30분 검토 → 통과 즉시 공개)", 큐.map((j) => j["publish_at"]), ["", ""]);
    같나("큐: 사람 승인 표시가 달려 있다(출구검사가 본다)", 큐.every((j) => String(j["_승인"]).startsWith("시험 승인") && String(j["_승인"]).includes("--auto-ok")), true);
    같나("큐: 실제 파일로 잰 종류가 박혀 있다", 큐.map((j) => [j["영상종류"], j["allow_not_short"]]), [["쇼츠", false], ["쇼츠", false]]);
    같나("큐: 채널은 채널ID 로", 큐[0]["channel"], A);
    같나("담기만 했으니 유튜브에는 아무것도 안 갔다", [g.calls.length, readLedger().length, loadPending().length], [0, 0, 0]);
    같나("파일은 아직 폴더에 있다(쏠 때까지 붙들어 둔다)", [await 파일있나(파일[0]), await 파일있나(파일[1])], [true, true]);
    같나("끝 말: 발사대기 2건 + 아직 올라간 게 아니라는 안내", [글에있나(실.줄, "발사대기 2건"), 글에있나(실.줄, "아직 올라간 것이 아닙니다")], [true, true]);

    // ── 미리보기와 실제가 같은 계산에서 나왔나
    같나("미리보기가 보여 준 시각 = 실제로 큐에 담긴 시각",
      큐.map((j) => String(j["쏠때"]).slice(0, 16).replace("T", " ")).sort(),
      미리.items.map((x) => x.when).sort());

    // ── 같은 날 두 번 안 담김
    const 둘 = 모음();
    const r2 = await run(true, undefined, undefined, { autoOk: true, say: 둘.say, clock: 지금순간 });
    같나("같은 날 다시 돌려도 더 담지 않는다(오늘 몫을 이미 채웠다)", [r2.queued, r2.up, readQueue().length], [0, 0, 2]);
    같나("그 까닭을 말한다", 글에있나(둘.줄, "오늘 이미 2편 올렸거나 담음"), true);
    같나("남은 한 편(a3)은 큐에 안 들어갔다", readQueue().some((j) => String(j.file).endsWith("a3.mp4")), false);
    같나("두 번째 돌려도 유튜브 호출은 0건", g.calls.length, 0);

    // ── 쏠 때가 되면 담아 둔 일감이 실제로 올라간다 (출구검사를 통과한다) — 내일 아침에 컴퓨터가 켜져 있다고 치고 쏜다
    const 내일순간 = new Date(지금순간.getTime() + 24 * 3_600_000);
    const 쏨 = await fire({ now: wallNow(systemZone(), 내일순간), say: 모음().say });
    같나("쏠 때가 되면 담아 둔 두 편이 실제로 올라간다", [쏨, g.callsTo(/^videos\.insert$/).length, readQueue().length, readLedger().length], [2, 2, 0, 2]);
    같나("올라간 편은 완료 폴더로", [await 파일있나(파일[0]), await 파일있나(join(폴더(dir, "채널A"), "업로드완료", "a1.mp4"))], [false, true]);

    // 하루가 지나면 다시 몫이 생긴다 — 어제 쏜 두 편은 오늘 몫을 쓰지 않는다
    setDailyClock(() => 내일순간);
    const r3 = await run(true, undefined, undefined, { autoOk: true, say: 모음().say, clock: 내일순간 });
    같나("다음 날에는 새 몫을 담는다(남은 a3 한 편)", [r3.queued, readQueue().map((j) => baseName(String(j.file)))], [1, ["a3.mp4"]]);
    setDailyClock(() => 지금순간);
  });

  await 모래상자(async (dir) => {
    구역("즉시 발행(publish: now) 채널 — 그 자리에서 올리고 완료 폴더로");
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { publish: "now", daily: 2 } }]);
    const 파일 = await 영상들(폴더(dir, "채널A"), ["n1.mp4", "n2.mp4", "n3.mp4"]);
    const { 줄, say } = 모음();
    const r = await run(true, undefined, undefined, { autoOk: true, say, clock: 지금순간 });
    같나("즉시 발행: 2편이 올라갔다", [r.up, r.queued, r.failed], [2, 0, 0]);
    같나("유튜브에 이어올리기로 2편", g.callsTo(/^videos\.insert$/).length, 2);
    같나("원장 2줄 + 심사 대기 2건", [readLedger().length, loadPending().length], [2, 2]);
    같나("원장 채널은 사람이 읽는 이름", readLedger().map((x) => x["채널"]), ["채널A", "채널A"]);
    같나("올린 파일은 업로드완료 폴더로", [await 파일있나(파일[0]), await 파일있나(join(폴더(dir, "채널A"), "업로드완료", "n1.mp4")), await 파일있나(파일[2])], [false, true, true]);
    같나("올리기.log 에 「발사」(예약 작업과 같은 길)", (await Deno.readTextFile(recordPath("올리기.log"))).includes("n1.mp4  예정"), true);
    같나("끝 말: 올림 2건 · 공개는 30분 뒤 심사 후", [글에있나(줄, "올림 2건"), 글에있나(줄, "공개는 올린 지 30분 뒤")], [true, true]);
    resetSafetyCache();
    const 또 = await run(true, undefined, undefined, { autoOk: true, say: 모음().say, clock: 지금순간 });
    같나("같은 날 다시 돌려도 더 안 올린다(원장에 오늘 2편)", [또.up, g.callsTo(/^videos\.insert$/).length], [0, 2]);
  });
}

/* ============================================================ 직접 고르기 (함정 1.1) */

async function 직접고르기() {
  구역("직접 고르기 — 고른 파일이 있는 채널만 돈다 (함정 1.1) · --at · 못 읽는 시각");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [
      { 이름: "채널A", id: A, 설정: { daily: 5 } },
      { 이름: "채널B", id: B, 설정: { daily: 5 } },
    ]);
    const 에이 = await 영상들(폴더(dir, "채널A"), ["a1.mp4", "a2.mp4", "a3.mp4"]);
    const 비 = await 영상들(폴더(dir, "채널B"), ["b1.mp4", "b2.mp4", "b3.mp4"], (i) => 세로(10 + i));
    g.clearCalls();

    // 1개를 골랐는데 7개가 올라가던 사고
    const { 줄, say } = 모음();
    const r = await run(true, ["a2.mp4"], undefined, { say, clock: 지금순간 });
    같나("1개를 고르면 정확히 1개만 올라간다", [r.up, r.queued, r.failed, g.callsTo(/^videos\.insert$/).length], [1, 0, 0, 1]);
    같나("고른 파일이 없는 채널(B)은 건너뛴다", [글에있나(줄, "직접 고르기 — 채널 1개 · 영상 1개"), 글에있나(줄, "건너뜀: 채널B")], [true, true]);
    같나("채널B 의 영상은 하나도 안 건드렸다", await Promise.all(비.map(파일있나)), [true, true, true]);
    같나("채널A 의 다른 영상도 안 건드렸다", [await 파일있나(에이[0]), await 파일있나(에이[2])], [true, true]);
    같나("원장·큐: 한 줄 / 비어 있다", [readLedger().map((x) => baseName(x["파일"])), readQueue().length], [["a2.mp4"], 0]);
    같나("계획 시각을 붙이지 않는다(사람이 짚었다 = 지금 올려라)", 글에있나(줄, "예상 시각"), false);
    같나("고르기만 한 것은 「예약 발행」이라 말하지 않는다(즉시 발행)", 글에있나(줄, "즉시 발행"), true);
    같나("올라간 이름이 목록에 나온다", r.items.map((x) => [x.name, x.action]), [["a2.mp4", "uploaded"]]);
    같나("올린 파일은 업로드완료로 옮겨졌다", await 파일있나(join(폴더(dir, "채널A"), "업로드완료", "a2.mp4")), true);

    // 경로로 줘도 이름으로 줘도 같다
    g.clearCalls();
    const 경로 = await run(true, [비[1]], undefined, { say: 모음().say, clock: 지금순간 });
    같나("경로로 줘도 이름으로 본다", [경로.up, 경로.channels], [1, ["채널B"]]);

    // 못 찾는 파일
    const 못 = 모음();
    const r0 = await run(true, ["없는영상.mp4"], undefined, { say: 못.say, clock: 지금순간 });
    같나("어느 채널 폴더에도 없는 파일: 아무것도 안 하고 알린다", [r0.up, r0.queued, r0.notFound, 글에있나(못.줄, "찾지 못했습니다")], [0, 0, ["없는영상.mp4"], true]);

    // --at : 사람이 정한 시각은 약속이다
    g.clearCalls();
    const 내일아침 = minuteWall(withTime(addDays(지금벽, 1), 9, 20));
    const at = await run(true, ["a1.mp4"], [`a1.mp4=${내일아침}`], { say: 모음().say, clock: 지금순간 });
    같나("--at 으로 미래 시각을 주면 발사대기에 담는다", [at.queued, at.up, g.callsTo(/^videos\.insert$/).length], [1, 0, 0]);
    const 담김 = readQueue().find((j) => String(j.file).endsWith("a1.mp4"))!;
    같나("그 시각 그대로(약속)", String(담김["쏠때"]).slice(0, 16), 내일아침.replace(" ", "T"));
    같나("공개 예약은 비운다(올린 뒤 30분 심사 후 공개)", 담김["publish_at"], "");
    같나("시각 정한 이: user", 담김["time_by"], "user");
    같나("승인 표시: 사람이 고름(--pick)", String(담김["_승인"]).includes("사람이 고름(--pick)"), true);
    같나("담아 두면 그 파일은 다음 훑기에서 빠진다(두 번 안 담김)", (await run(true, ["a1.mp4"], [`a1.mp4=${내일아침}`], { say: 모음().say, clock: 지금순간 })).channels, []);

    // 못 읽는 시각은 올리지 않는다 — 조용히 「즉시 공개」로 바꾸지 않는다
    g.clearCalls();
    const 엉터리 = 모음();
    const bad = await run(true, ["a3.mp4"], ["a3.mp4=내일 아침쯤"], { say: 엉터리.say, clock: 지금순간 });
    같나("못 읽는 시각: 올리지 않고 실패로 센다", [bad.up, bad.queued, bad.failed, g.callsTo(/^videos\.insert$/).length], [0, 0, 1, 0]);
    같나("그 까닭을 말한다", 글에있나(엉터리.줄, "시각을 읽지 못했습니다"), true);
    같나("파일은 폴더에 그대로", await 파일있나(에이[2]), true);

    // 지난 시각은 올리되 「이미 지났다」고 말한다(검토 뒤 바로 공개)
    const 과거 = minuteWall(addDays(지금벽, -1));
    g.clearCalls();
    const 지난 = 모음();
    const old = await run(true, ["a3.mp4"], [`a3.mp4=${과거}`], { say: 지난.say, clock: 지금순간 });
    같나("지난 시각: 지금 올린다", [old.up, g.callsTo(/^videos\.insert$/).length], [1, 1]);
    같나("지난 예약은 심사가 끝나는 대로 공개한다고 말한다", 글에있나(지난.줄, "이미 지났습니다"), true);
    같나("유튜브에 예약(publishAt)으로 안 보낸다", loadPending().every((p) => !p.publish_at), true);
  });
}

/* ============================================================ 올리다 실패 */

async function 올리다실패() {
  구역("올리다 실패하면 — 실패로 세고 큐에 남아 다시 쏜다 · 하루 업로드 한도(429)는 다음 날로");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { daily: 2 } }]);
    const 파일 = await 영상들(폴더(dir, "채널A"), ["f1.mp4", "f2.mp4"]);
    g.failNext(/upload\/youtube\/v3\/videos/, 400, { error: { code: 400, message: "잘못된 요청", errors: [{ reason: "badRequest" }] } });
    const 첫 = 모음();
    const r = await run(true, ["f1.mp4"], undefined, { say: 첫.say, clock: 지금순간 });
    같나("올리다 실패하면 실패로 센다", [r.up, r.queued, r.failed], [0, 0, 1]);
    같나("파일은 폴더에 그대로 · 원장은 비어 있다 · 큐에 남는다", [await 파일있나(파일[0]), readLedger().length, readQueue().length], [true, 0, 1]);
    같나("까닭이 나온다", 글에있나(첫.줄, "쏘지 못했습니다"), true);
    같나("결과 목록에도 까닭이 담긴다", [r.items[0].action, r.items[0].note.length > 0], ["failed", true]);
    // 다음 차례에 예약 작업이 다시 쏘면 올라간다
    const 쏨 = await fire({ now: 지금벽, say: 모음().say });
    같나("다음 차례에 다시 쏘면 올라간다", [쏨, readLedger().length, readQueue().length], [1, 1, 0]);
    // 하루 업로드 한도(429) — 남은 것은 다음 초기화로 미룬다
    g.failNext(/upload\/youtube\/v3\/videos/, 429, { error: { code: 429, message: "uploadLimitExceeded", errors: [{ reason: "uploadLimitExceeded" }] } });
    const 둘 = 모음();
    const r2 = await run(true, ["f2.mp4"], undefined, { say: 둘.say, clock: 지금순간 });
    같나("하루 업로드 한도(429)는 실패가 아니라 기다림으로 센다", [r2.up, r2.queued, r2.failed], [0, 1, 0]);
    같나("큐의 올리기 시각이 한도 초기화 뒤로 밀렸다", String(readQueue()[0]["쏠때"]) > isoWall(지금벽), true);
    같나("그 말이 나온다", 글에있나(둘.줄, "하루 업로드 한도에 걸렸습니다"), true);
  });
}

/* ============================================================ 한밤 금지 · 신호등 */

async function 한밤() {
  구역("한밤 발사 금지 — 그 자리 올리기도 같은 문을 지난다 · 신호등");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { daily: 2 } }]);
    const 파일 = await 영상들(폴더(dir, "채널A"), ["g1.mp4", "g2.mp4"]);
    const 새벽순간 = wallToInstant(withTime(지금벽, 3, 0), systemZone());
    setDailyClock(() => 새벽순간);
    const { 줄, say } = 모음();
    const r = await run(true, ["g1.mp4"], undefined, { say, clock: 새벽순간 });
    같나("새벽 3시에 누르면(금지 스위치 켬) 올리지 않고 큐에서 아침을 기다린다", [r.up, r.queued, r.failed, g.callsTo(/^videos\.insert$/).length], [0, 1, 0, 0]);
    같나("그 까닭과 안내가 나온다", [글에있나(줄, "발사 금지 시간대"), 글에있나(줄, "지금은 못 쏩니다")], [true, true]);
    같나("파일은 폴더에 있다", await 파일있나(파일[0]), true);
    await Deno.writeTextFile(dataPath("심야발사.json"), JSON.stringify({ 금지: false }));
    const r2 = await run(true, ["g2.mp4"], undefined, { say: 모음().say, clock: 새벽순간 });
    같나("🌙 스위치를 끄면 한밤에도 올라간다", [r2.up, g.callsTo(/^videos\.insert$/).length], [1, 1]);

    // 신호등은 숫자를 받아 맨 위에 말한다
    const 램프 = 모음();
    await run(false, undefined, undefined, { say: 램프.say, clock: 지금순간, lamp: async () => ({ red: 1, yellow: 2 }) });
    같나("run 맨 위에 신호등 한 줄", 글에있나(램프.줄, "● 오류 1건 · 작업불이행·경고 2건"), true);
    const 깨진램프 = 모음();
    await run(false, undefined, undefined, { say: 깨진램프.say, clock: 지금순간, lamp: async () => { throw new Error("신호등 고장"); } });
    같나("신호등이 고장 나도 훑기는 계속된다", 글에있나(깨진램프.줄, "신호등을 읽지 못했습니다"), true);
    setDailyClock(() => 지금순간);
  });
}

/* ============================================================ 쇼츠 · 롱폼 따로 */

async function 쇼츠롱폼분리() {
  구역("쇼츠와 롱폼은 따로 — 종류는 실제 파일로 · 시각도 따로 셈한다");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { daily: 4 } }]);
    const 폴 = 폴더(dir, "채널A");
    await 영상들(폴, ["s1.mp4", "s2.mp4"], 세로);
    await 영상들(폴, ["l1.mp4", "l2.mp4"], 가로);
    g.clearCalls();
    const { 줄, say } = 모음();
    const r = await run(true, undefined, undefined, { autoOk: true, say, clock: 지금순간 });
    같나("넷 다 담는다", [r.queued, r.up, r.failed], [4, 0, 0]);
    const 큐 = readQueue();
    const 종류별 = (롱: boolean) => 큐.filter((j) => !!j["allow_not_short"] === 롱).sort((a, b) => String(a["쏠때"]).localeCompare(String(b["쏠때"])));
    같나("쇼츠 둘 · 롱폼 둘이 실제 파일 모양대로 표시된다", [종류별(false).length, 종류별(true).length], [2, 2]);
    같나("롱폼 표시(롱폼·allow_not_short)", 종류별(true).every((j) => j["롱폼"] === true && j["영상종류"] === "롱폼"), true);
    같나("쇼츠에는 롱폼 표시가 없다", 종류별(false).every((j) => j["롱폼"] === false && j["영상종류"] === "쇼츠"), true);
    for (const 롱 of [false, true]) {
      const 시 = 종류별(롱).map((j) => parseWall(String(j["쏠때"]))!.getTime());
      같나(`${롱 ? "롱폼" : "쇼츠"}끼리는 4시간 이상 띄운다`, 시[1] - 시[0] >= 240 * 60_000, true);
    }
    같나("꼴마다 예상 시각을 따로 말한다", [글에있나(줄, "[쇼츠]"), 글에있나(줄, "[롱폼]")], [true, true]);
    같나("롱폼 썸네일 업로드는 올릴 때 영상 옆 그림으로(여기선 담기만)", g.calls.length, 0);

  });

  구역("같은 꼴의 마지막 공개 예약 뒤로 이어 붙인다 (쇼츠·롱폼 따로)");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { daily: 2 } }]);
    const 폴 = 폴더(dir, "채널A");
    await 영상들(폴, ["s1.mp4"], 세로);
    await 영상들(폴, ["l1.mp4"], 가로);
    const 앞 = await run(false, undefined, undefined, { say: 모음().say, clock: 지금순간 });
    const 앞쇼 = 앞.items.find((x) => x.name === "s1.mp4")!.when;
    const 앞롱 = 앞.items.find((x) => x.name === "l1.mp4")!.when;
    // 쇼츠 예약만 오늘 20:00 에 이미 있다 → 쇼츠는 그 뒤(+2시간−검토 30분 = 21:30)부터, 롱폼은 그대로
    await writeLedgerRaw([[...LEDGER_HEAD], LEDGER_HEAD.map((h) => ({
      업로드시각: isoWall(지금벽), 채널: "채널A", 영상ID: "vS", 제목: "예약 쇼츠", 파일: "/먼저/올린.mp4", 길이초: "30.0", 해상도: "1080x1920",
      예약시각: minuteWall(withTime(지금벽, 20, 0)), 공개설정: "예약",
    } as Record<string, string>)[h] ?? "")]);
    resetSafetyCache();
    g.clearCalls();
    const 뒤 = await run(false, undefined, undefined, { say: 모음().say, clock: 지금순간 });
    const 쇼 = 뒤.items.find((x) => x.name === "s1.mp4")!.when ?? "";
    const 롱 = 뒤.items.find((x) => x.name === "l1.mp4")!.when;
    같나("쇼츠: 마지막 쇼츠 예약(20:00) + 2시간 − 검토 30분 = 21:30 이후", 쇼 >= minuteWall(withTime(지금벽, 21, 30)), true);
    같나("롱폼: 쇼츠 예약에 안 밀린다(예약이 있기 전과 같은 시각)", 롱, 앞롱);
    같나("(참고) 쇼츠는 예약이 있기 전보다 늦어졌다", 쇼 >= (앞쇼 ?? ""), true);
  });
}

/* ============================================================ 일 한도 정책 */

async function 일한도정책() {
  구역("쇼츠 하루 한도 정책 — 일 한도 편성이 적용된 시각 (미리보기 = 실제)");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널P", id: P, 설정: { daily: 3 } }]);
    await 영상들(폴더(dir, "채널P"), ["p1.mp4", "p2.mp4", "p3.mp4"]);
    await writePolicy({
      label: "채널P", channel_id: P, aliases: ["채널P"], kind: "쇼츠", timezone: systemZone(),
      daily_limit: 1, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50,
    });
    g.clearCalls();

    // 미리보기가 먼저 한도 편성을 보여 준다
    const 미 = await cmdPreview(loadChannels(), { clock: 지금순간 });
    const 예상 = 미.channels[0].items.map((x) => x.fireAt);
    같나("미리보기: 3편이 날마다 1편씩(날짜가 다 다르다)", new Set(예상.map((x) => x.slice(0, 10))).size, 3);
    같나("미리보기: 한도로 미뤄진 편에 이유가 붙는다", 미.channels[0].items.slice(1).every((x) => x.deferred.includes("하루 한도")), true);
    같나("미리보기: 공개 시각도 함께 보인다", 미.channels[0].items.every((x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.publishAt)), true);

    const r = await run(true, undefined, undefined, { autoOk: true, say: 모음().say, clock: 지금순간 });
    같나("실제로 3편이 모두 발사대기에 담겼다", [r.queued, r.up, r.failed], [3, 0, 0]);
    const 큐 = readQueue().sort((a, b) => String(a["쏠때"]).localeCompare(String(b["쏠때"])));
    const 날짜 = 큐.map((j) => String(j["쏠때"]).slice(0, 10));
    같나("하루에 1편씩, 매일 하루씩 밀린다", [new Set(날짜).size, 날짜[0] === 오늘, 날짜[1] === dateOnly(addDays(지금벽, 1)), 날짜[2] === dateOnly(addDays(지금벽, 2))], [3, true, true, true]);
    같나("공개 예약 날짜도 하루에 1편", new Set(큐.map((j) => String(j["publish_at"]).slice(0, 10))).size, 3);
    같나("미리보기가 보여 준 올리기 시각 = 실제 큐의 시각", 큐.map((j) => String(j["쏠때"])).sort(), [...예상].sort());
    같나("담기만 했다(유튜브 0건)", g.calls.length, 0);
    같나("밀려서 편성된 말이 나온다", (await run(false, undefined, undefined, { say: 모음().say, clock: 지금순간 })).channels, []);
  });

  await 모래상자(async (dir) => {
    구역("한도에 걸린 즉시 올리기는 실패가 아니라 다음 날 대기열로");
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널P", id: P, 설정: { daily: 3 } }]);
    const 파일 = await 영상들(폴더(dir, "채널P"), ["p1.mp4", "p2.mp4"]);
    await writePolicy({
      label: "채널P", channel_id: P, aliases: ["채널P"], kind: "쇼츠", timezone: systemZone(),
      daily_limit: 1, day_start_hour: 7, publish_gap_minutes: 120, review_lead_minutes: 50,
    });
    // 오늘 이미 1편을 올렸다고 적어 둔다(한도 1편이 찼다)
    await writeLedgerRaw([[...LEDGER_HEAD], LEDGER_HEAD.map((h) => ({
      업로드시각: isoWall(지금벽), 채널: "채널P", 영상ID: "vP0", 제목: "오늘 올린 것", 파일: "/먼저/올린.mp4", 길이초: "30.0", 해상도: "1080x1920",
      공개설정: "비공개(검토대기)", 예약시각: minuteWall(withTime(지금벽, 11, 0)),
    } as Record<string, string>)[h] ?? "")]);
    resetSafetyCache();
    g.clearCalls();
    const { 줄, say } = 모음();
    const r = await run(true, ["p1.mp4"], undefined, { say, clock: 지금순간 });
    같나("한도가 찬 날 즉시 올리기: 실패가 아니라 발사대기로", [r.up, r.queued, r.failed, g.callsTo(/^videos\.insert$/).length], [0, 1, 0, 0]);
    같나("파일은 폴더에 그대로 있다", await 파일있나(파일[0]), true);
    const 담김 = readQueue()[0];
    같나("다음 날로 편성됐다", String(담김["쏠때"]).slice(0, 10) > 오늘, true);
    같나("그 까닭이 말로 나온다", 글에있나(줄, "발사대기"), true);
  });

  await 모래상자(async (dir) => {
    구역("승인형 정책 — 담고 바로 쏜다 · 올린 뒤 정한 분 뒤 공개 예약");
    setDailyClock(() => 지금순간);
    const 지금 = new Date(); // 승인형은 진짜 업로드까지 간다 — 공개 예약이 진짜 앞날이어야 해서 진짜 지금을 쓴다
    const g = await 세상(dir, [{ 이름: "채널Q", id: Q, 설정: { daily: 3 } }]);
    await Deno.writeTextFile(dataPath("심야발사.json"), JSON.stringify({ 금지: false })); // 한밤에 돌려도 되게
    await writePolicy({
      schema: SCHEMA_APPROVED, label: "채널Q", channel_id: Q, aliases: ["채널Q"], timezone: systemZone(),
      daily_limit: 2, publish_delay_minutes: 10, overflow_day_start_hour: 7,
    });
    const 파일 = await 영상들(폴더(dir, "채널Q"), ["q1.mp4", "q2.mp4", "q3.mp4"]);
    g.clearCalls();
    setDailyClock(() => 지금);
    const 미 = await cmdPreview(loadChannels(), { clock: 지금 });
    같나("승인형 미리보기: 2편은 바로 · 1편은 하루 한도로 다음 날", [미.channels[0].items.map((x) => x.immediate), 미.channels[0].items[2].deferred.includes("하루 한도")], [[true, true, false], true]);
    같나("승인형 미리보기: 공개 예약 시각(올린 뒤 10분)이 보인다", 미.channels[0].items[0].publishAt.length, 16);
    g.clearCalls();
    const { 줄, say } = 모음();
    const r = await run(true, ["q1.mp4", "q2.mp4", "q3.mp4"], undefined, { say, clock: 지금 });
    같나("승인형: 하루 2편 — 2편은 바로 올라가고 1편은 다음 날 대기열", [r.up, r.queued, r.failed], [2, 1, 0]);
    같나("올라간 건 유튜브에 2건", g.callsTo(/^videos\.insert$/).length, 2);
    같나("원장 예약시각은 올린 뒤 10분", readLedger().every((x) => (x["예약시각"] ?? "").length === 16), true);
    같나("올라간 파일은 완료 폴더로, 못 올린 1편은 큐에", [await 파일있나(파일[0]), await 파일있나(파일[2]), readQueue().length], [false, true, 1]);
    같나("다음 날로 편성됐다고 말한다", 글에있나(줄, "발사대기"), true);
    const 다음 = readQueue()[0];
    같나("큐에 남은 편의 올리기 시각은 다음 날 이후", String(다음["쏠때"]).slice(0, 10) > dateOnly(wallNow(systemZone(), 지금)), true);
    setDailyClock(() => 지금순간);
  });
}

/* ============================================================ 걸러내기 */

async function 걸러내기() {
  구역("걸러내기 — 검토필요로 옮기는 것 · 읽을 수 없는 파일 · 같은 영상 묶음 · 이미 올린 것");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { prefix: "AB_", daily: 5, publish: "now" } }]);
    const 폴 = 폴더(dir, "채널A");
    await 영상쓰기(join(폴, "AB_좋음.mp4"), 세로(1));
    await 영상쓰기(join(폴, "남의것.mp4"), 세로(2)); // 머리말이 다르다
    await Deno.writeFile(join(폴, "AB_깨짐.mp4"), new Uint8Array([1, 2, 3, 4, 5])); // 영상이 아니다
    await 영상쓰기(join(폴, "AB_쌍둥이1.mp4"), 세로(5));
    await 영상쓰기(join(폴, "AB_쌍둥이2.mp4"), 세로(5)); // 길이·크기가 같다 = 이름만 바꾼 같은 영상
    g.clearCalls();

    const 미 = 모음();
    const 미리 = await run(false, undefined, undefined, { autoOk: true, say: 미.say, clock: 지금순간 });
    같나("미리보기: 머리말이 다른 것은 검토필요라고 말하지만 옮기지 않는다", [글에있나(미.줄, "남의것.mp4  검토필요 — 파일 이름이 'AB_' 로 시작하지 않습니다"), await 파일있나(join(폴, "남의것.mp4"))], [true, true]);
    같나("미리보기: 읽을 수 없는 파일", 글에있나(미.줄, "AB_깨짐.mp4  읽을 수 없음"), true);
    같나("같은 영상 묶음 경고", 글에있나(미.줄, "같은 영상 2개로 보입니다"), true);
    같나("검토필요 건수에 둘이 센다", 미리.held, 2);

    const 실 = 모음();
    const r = await run(true, undefined, undefined, { autoOk: true, say: 실.say, clock: 지금순간 });
    같나("실제: 머리말이 다른 것은 검토필요 폴더로 옮겨지고 사유가 남는다", [
      await 파일있나(join(폴, "남의것.mp4")), await 파일있나(join(폴, "검토필요", "남의것.mp4")), await 파일있나(join(폴, "검토필요", "남의것.사유.txt")),
    ], [false, true, true]);
    같나("실제: 읽을 수 없는 파일도 검토필요로", await 파일있나(join(폴, "검토필요", "AB_깨짐.mp4")), true);
    같나("실제: 좋은 영상(쌍둥이 포함)은 올라간다", r.up, 3);
    같나("끝 말: 검토필요 2건", 글에있나(실.줄, "검토필요 2건"), true);

    // 이미 올린 이름은 막는다 (원장)
    await 영상쓰기(join(폴, "AB_좋음.mp4"), 세로(1));
    resetSafetyCache();
    const 다시 = 모음();
    const 또 = await run(true, undefined, undefined, { autoOk: true, say: 다시.say, clock: 지금순간 });
    같나("원장에 있는 이름: 다시 올리지 않고 검토필요로", [또.up, 글에있나(다시.줄, "이미 올린 영상입니다")], [0, true]);
  });
}

/* ============================================================ 미리보기 자료 (JSON) */

async function 미리보기자료() {
  구역("미리보기 자료 — HTML 이 아니라 JSON · 유튜브를 안 부른다");
  await 모래상자(async (dir) => {
    setDailyClock(() => 지금순간);
    const g = await 세상(dir, [
      { 이름: "채널A", id: A, 설정: { daily: 2, pick: "suggest" } },
      { 이름: "채널B", id: B, 설정: { daily: 1, publish: "now" } },
    ]);
    await 영상들(폴더(dir, "채널A"), ["a1.mp4", "a2.mp4", "a3.mp4"]);
    await Deno.writeTextFile(join(폴더(dir, "채널A"), "a1.txt"), "[제목]\n첫째 영상의 제목\n\n[설명]\n설명\n\n[해시태그]\n#가짜\n");
    await 영상들(폴더(dir, "채널B"), ["b1.mp4", "b2.mp4"], (i) => 세로(30 + i));
    await insightRemember("채널A", { learned: true, n: 12, best_dur: [15, 30], dur_tbl: { "(15, 30)": [100, 5] }, best_hour: null, trend: 0, cadence: 1, median_views: 100 });
    g.clearCalls();

    const 자료 = await cmdPreview(loadChannels(), { clock: 지금순간 });
    같나("채널 둘 · 영상 5편(오늘 몫 3 + 여분 2)", [자료.channels.length, 자료.total], [2, 5]);
    같나("직렬화된다(JSON)", JSON.parse(JSON.stringify(자료)).channels[0].name, "채널A");
    같나("유튜브를 한 번도 안 불렀다", g.calls.length, 0);
    같나("아무것도 안 바꿨다", [readQueue().length, readLedger().length, await 파일있나(join(폴더(dir, "채널A"), "a1.mp4"))], [0, 0, true]);
    const a = 자료.channels[0];
    같나("채널A: 오늘 몫 2 + 여분 1", [a.items.filter((x) => !x.spare).length, a.items.filter((x) => x.spare).length], [2, 1]);
    const 첫 = a.items[0];
    같나("항목에 파일·제목·종류·올리기 시각·공개 시각·사유가 있다", [
      typeof 첫.file, 첫.title, 첫.kind, /^\d{4}-\d{2}-\d{2}T/.test(첫.fireAt), typeof 첫.publishAt, 첫.reason.length > 0,
    ], ["string", "첫째 영상의 제목", "쇼츠", true, "string", true]);
    같나("공개 시각이 비어 있으면 「검토 뒤 바로 공개」라고 말한다", 첫.publishWord.includes("심사 확인 후 바로 공개"), true);
    같나("추천 방식: 사유에 순위와 점수", 첫.reason.includes("추천") && 첫.reason.includes("점"), true);
    같나("추천 방식: 저장해 둔 배운 것을 썼다", a.items.every((x) => x.rank !== null), true);
    같나("여분은 예약이 없다", a.items.find((x) => x.spare)!.fireAt, "");
    const b = 자료.channels[1];
    같나("즉시 발행 채널: 바로 올림", [b.items[0].immediate, b.items[0].fireAt, b.items[1].spare], [true, "", true]);
    같나("직접 훑는 길(run)과 같은 파일을 고른다", (await run(false, undefined, undefined, { say: 모음().say, clock: 지금순간 })).items.map((x) => x.name).sort(),
      [...a.items.filter((x) => !x.spare), ...b.items.filter((x) => !x.spare)].map((x) => x.name).sort());
  });
}

/* ============================================================ 성적 · 배운 것 */

async function 성적과배움() {
  구역("성적과 배운 것 (사람이 시킨 길 — 유튜브에 직접 묻는다)");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A }]);
    for (let i = 0; i < 3; i++) {
      g.addVideo({
        id: `lv${i}`, channelId: A,
        snippet: { title: `영상 ${i + 1}`, publishedAt: new Date(Date.now() - (10 + i) * 86_400_000).toISOString() },
        statistics: { viewCount: String(1000 * (i + 1)), likeCount: String(10 * (i + 1)), commentCount: "2" },
      });
    }
    const { 줄, say } = 모음();
    const rows = await cmdLearn(loadChannels(), say);
    같나("채널 하나의 성적표와 배운 것", [rows.length, rows[0].error, 글에있나(줄, "올린날")], [1, "", true]);
    같나("표본이 모자라면 배우지 않았다고 말한다", [rows[0].insight?.learned, 글에있나(줄, "학습 안 함")], [false, true]);
    같나("조회수 중앙값이 표 끝에 나온다", 글에있나(줄, "조회수 중앙값 2,000"), true);
    같나("직접 새로 읽는 한 줄 성적(live)", (await perfBrief(A, { live: true })).startsWith("직전 3개 중앙 2,000"), true);
    await updateStore((st) => { delete st.채널A; });
    const 안 = await cmdLearn(loadChannels(), 모음().say);
    같나("인증 없는 채널은 안내문으로 바뀐다(던지지 않는다)", [안[0].error, 안[0].insight?.why], ["아직 인증 전입니다", "아직 인증 전입니다"]);
  });
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

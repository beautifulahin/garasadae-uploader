// 동기화·회수·자가점검 시험 — 유튜브를 진실로 기록을 맞춘다(sync) · 저성과 회수(recall) · 놀 때 호출 0건(selfcheck).
//
// 원본(파이썬)에는 이 셋의 시험이 없다. 원본 docstring 이 약속하는 것과 함정 기록(3.1·5.4·「모르는 것과 없는 것은 다르다」)을
// 시험으로 못 박았다: 못 물으면 손대지 않는다 · 물어보는 동안 새로 적힌 줄은 안 건드린다 · 회수는 기본이 꺼짐이고 켠 채널만 돈다.
//
// 구글에는 한 번도 닿지 않는다: 가짜 서버(가짜구글.ts)와 임시 폴더(모래상자)만 쓴다. 채널 이름·ID 는 모두 가짜다.
//   실행:  TZ=Asia/Seoul deno run -A --no-lock 시험/동기화.ts
import { 같나, 결과, 구역, 모래상자 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { setEmbeddedForTest } from "../app/embedded.ts";
import { saveStore, SCOPES, type Store } from "../app/ytcore.ts";
import { dataPath, readJsonSync, recordPath, writeJson } from "../app/paths.ts";
import { channelsPath } from "../app/channels.ts";
import { addDays, instantToWall, isoWall, minuteWall, systemZone, wallNow } from "../app/clock.ts";
import { LEDGER_HEAD, readLedger, writeLedgerRaw } from "../app/ledger.ts";
import { loadPending, type PendingItem, savePending } from "../app/review.ts";
import { isLocked, manualPrivateHas, setLocked } from "../app/safety.ts";
import * as quota from "../app/quota.ts";
import { saveTelegramConfig } from "../app/notify.ts";
import { ytFor } from "../app/ytcore.ts";
import { CouldNotAsk, localTime, markSynced, run as syncRun, states, syncDue } from "../app/sync.ts";
import { candidates, LOWERED, MAX_PER_ROUND, recallable, recallOn, run as recallRun } from "../app/recall.ts";
import { defaultChecks, type IdleCheck, main as selfMain, runChecks, uploadCounts } from "../app/selfcheck.ts";

const 아이디 = (c: string) => "UC" + c.repeat(22);
const A = 아이디("a"), B = 아이디("b"), C = 아이디("c");

interface 칸 { 이름: string; id: string; 토큰?: boolean; 설정?: Record<string, unknown> }

/** 가짜 구글 + 채널 설정 + 토큰(토큰: false 면 인증 없는 채널) */
async function 세상(dir: string, 칸들: 칸[], 구글: 가짜구글 = new 가짜구글()): Promise<가짜구글> {
  const g = 구글.install();
  setEmbeddedForTest("browser", { client_id: "시험열쇠", client_secret: "비밀아님" });
  const store: Store = {};
  const conf: Record<string, unknown> = {};
  for (const [i, c] of 칸들.entries()) {
    if (c.토큰 !== false) {
      g.addChannel({ id: c.id, title: c.이름 }, `RT${i}`); // 가짜 접근 토큰이 헤더에 실리므로 영문
      store[c.이름] = { channel_id: c.id, title: c.이름, refresh_token: `RT${i}`, added: "2026-10-01", scopes: [...SCOPES] };
    }
    const folder = `${dir}/영상/${c.이름}`;
    await Deno.mkdir(folder, { recursive: true });
    conf[c.이름] = { channel_id: c.id, folder, publish: "schedule", daily_rule: "fixed", daily: 2, ...c.설정 };
  }
  await saveStore(store);
  await writeJson(channelsPath(), conf);
  return g;
}

function 원장줄(o: Record<string, string>): string[] {
  return LEDGER_HEAD.map((h) => o[h] ?? "");
}
const 원장쓰기 = (rows: Record<string, string>[]) => writeLedgerRaw([[...LEDGER_HEAD], ...rows.map(원장줄)]);
const 대기: (o: Partial<PendingItem> & { channel: string; video_id: string }) => PendingItem = (o) => ({
  title: `대기 ${o.video_id}`, publish_at: null, uploaded: isoWall(wallNow()), 확인수: 0, 사람확인: false, 시각정한이: "auto", ...o,
});
const 모음 = () => { const 줄: string[] = []; return { 줄, say: (s: string) => { 줄.push(s); } }; };
const 글에있나 = (줄: string[], 조각: string) => 줄.some((x) => x.includes(조각));
const 행 = (id: string) => readLedger().filter((r) => r["영상ID"] === id);
const 며칠전 = (n: number) => isoWall(addDays(wallNow(), -n));

/** 끼어드는 가짜 구글 — 유튜브에 묻는 동안 다른 길(업로드)이 원장·대기 목록에 새 줄을 적는 일을 흉내 낸다 */
class 끼어드는구글 extends 가짜구글 {
  끼어들기: (() => Promise<void>) | null = null;
  constructor() {
    super();
    const 원래 = this.handle;
    this.handle = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (this.끼어들기 && url.includes("/youtube/v3/videos?")) {
        const f = this.끼어들기;
        this.끼어들기 = null;
        await f();
      }
      return await 원래(input, init);
    };
  }
}

export async function 실행() {
  await 맞추기();
  await 못물음();
  await 새줄과동시();
  await 돌린지();
  await 회수끔();
  await 회수켬();
  await 회수한바퀴();
  await 회수막힘();
  await 점검();
}

/* ============================================================ sync */

async function 맞추기() {
  구역("동기화 — 유튜브를 진실로 기록을 맞춘다 (sync)");
  같나("UTC 글을 이 컴퓨터 시각으로", localTime("2026-08-28T05:50:00Z"), minuteWall(instantToWall(new Date("2026-08-28T05:50:00Z"), systemZone())));
  if (systemZone() === "Asia/Seoul") 같나("(한국 시각이면) 14:50", localTime("2026-08-28T05:50:00Z"), "2026-08-28 14:50");
  같나("못 읽는 글은 앞 16자를 그대로", localTime("엉터리 시각 글자입니다 뭐가 뭔지"), "엉터리 시각 글자입니다 뭐가 뭔지".slice(0, 16));
  같나("빈 글은 빈 글", localTime(""), "");

  await 모래상자(async (dir) => {
    const g = await 세상(dir, [
      { 이름: "채널A", id: A }, { 이름: "채널B", id: B }, { 이름: "채널C", id: C, 토큰: false },
    ]);
    const 공개일 = "2026-09-20T03:30:00Z";
    g.addVideo({ id: "v1", channelId: A, status: { privacyStatus: "public" }, snippet: { title: "t1", publishedAt: 공개일 } });
    g.addVideo({ id: "v2", channelId: A, status: { privacyStatus: "private", publishAt: "2027-01-05T00:00:00Z" } });
    // v3: 유튜브에 없다(사람이 스튜디오에서 지웠다)
    g.addVideo({ id: "v4", channelId: B, status: { privacyStatus: "public" } });
    g.addVideo({ id: "v5", channelId: A, status: { privacyStatus: "public" } });
    g.addVideo({ id: "v6", channelId: A, status: { privacyStatus: "private" } });
    g.addVideo({ id: "v7", channelId: A, status: { privacyStatus: "public" } });
    g.addVideo({ id: "v8", channelId: A, status: { privacyStatus: "public" }, snippet: { title: "t8", publishedAt: "2026-09-21T00:00:00Z" } });
    g.addVideo({ id: "v9", channelId: A, status: { privacyStatus: "private" } });

    await 원장쓰기([
      { 영상ID: "v1", 채널: "채널A", 제목: "첫째", 공개설정: "비공개(검토대기)", 공개시각: "", 업로드시각: 며칠전(9) },
      { 영상ID: "v2", 채널: "채널A", 제목: "예약된 것", 공개설정: "public", 예약시각: "2026-12-31 09:00", 업로드시각: 며칠전(8) },
      { 영상ID: "v3", 채널: "채널A", 제목: "사라진 것", 공개설정: "public", 파일: "/예전/사라진.mp4", 업로드시각: 며칠전(7) },
      { 영상ID: "v4", 채널: "채널B", 제목: "두 번 적힘", 공개설정: "public", 공개시각: "2026-09-01 10:00", 업로드시각: 며칠전(6) },
      { 영상ID: "v4", 채널: "채널B", 제목: "두 번 적힘", 공개설정: "public", 공개시각: "2026-09-01 10:00", 업로드시각: 며칠전(6) },
      { 영상ID: "v7", 채널: A, 제목: "채널ID 로 적힌 옛 기록", 공개설정: "public", 공개시각: "2026-09-02 10:00", 업로드시각: 며칠전(5) },
      { 영상ID: "v8", 채널: "채널A", 제목: "이미 공개시각이 있다", 공개설정: "public", 공개시각: "2026-10-01 10:00", 업로드시각: 며칠전(4) },
      { 영상ID: "vC1", 채널: "채널C", 제목: "인증 없는 채널", 공개설정: "public", 업로드시각: 며칠전(3) },
    ]);
    await savePending([
      대기({ channel: "채널A", video_id: "v3", title: "사라진 대기" }),
      대기({ channel: "채널A", video_id: "v5", title: "이미 공개된 대기" }),
      대기({ channel: "채널A", video_id: "v6", title: "아직 비공개인 대기" }),
      대기({ channel: A, video_id: "v9", title: "채널ID 로 적힌 대기" }),
      대기({ channel: "채널C", video_id: "vC", title: "인증 없는 채널의 대기" }),
    ]);
    g.clearCalls();

    const { 줄, say } = 모음();
    const r = await syncRun(false, { say });
    같나("바뀐 수: 원장 2 · 유령 3 · 중복 1 · 이름 2", [r.ledger, r.ghost, r.dup, r.name, r.total], [2, 3, 1, 2, 8]);
    같나("채널A·B 는 물어봤고 채널C 는 못 물어봤다", [r.asked.sort(), r.notAsked.map((x) => x.alias)], [["채널A", "채널B"], ["채널C"]]);
    같나("못 물어본 까닭이 말로 나온다", [글에있나(줄, "물어보지 못했습니다"), 글에있나(줄, "손대지 않습니다")], [true, true]);
    같나("채널 하나당 videos.list 한 번 (A·B = 2건)", g.callsTo(/^videos\.list$/).length, 2);
    같나("공개·비공개를 바꾸는 호출은 없다(읽기만)", g.callsTo(/^videos\.update$/).length, 0);

    같나("v1: 공개설정이 실제(public)로, 공개시각이 채워진다", [행("v1")[0]["공개설정"], 행("v1")[0]["공개시각"]], ["public", localTime(공개일)]);
    같나("v2: 예약으로 고치고 예약시각을 실제로", [행("v2")[0]["공개설정"], 행("v2")[0]["예약시각"]], ["예약", localTime("2027-01-05T00:00:00Z")]);
    같나("v3: 유튜브에 없으면 원장에서 뺀다", 행("v3").length, 0);
    같나("v4: 두 번 적힌 줄은 하나로", 행("v4").length, 1);
    같나("v7: 채널ID 로 적힌 옛 기록은 별칭으로", 행("v7")[0]["채널"], "채널A");
    같나("v8: 이미 적힌 공개시각은 손대지 않는다", 행("v8")[0]["공개시각"], "2026-10-01 10:00");
    같나("채널C: 물어보지 못했으니 그대로 둔다", [행("vC1").length, 행("vC1")[0]["공개설정"]], [1, "public"]);
    같나("뺀 원장 줄은 원장정리.log 에 옮겨 적는다(지우는 게 아니라 치우는 것)",
      (await Deno.readTextFile(recordPath("원장정리.log"))).includes("영상ID=v3"), true);

    const 남은 = loadPending();
    같나("심사 대기: 사라진 것·이미 공개된 것은 빠진다", 남은.map((p) => p.video_id).sort(), ["v6", "v9", "vC"]);
    같나("심사 대기: 채널ID 로 적힌 것도 별칭으로", 남은.find((p) => p.video_id === "v9")!.channel, "채널A");
    같나("끝 말: 맞춤 8건", 글에있나(줄, "맞춤 8건"), true);

    // 다시 돌리면 이미 맞아 있다
    const 또 = await syncRun(true);
    같나("두 번째는 바꿀 것이 없다(채널C 는 여전히 못 물음)", [또.total, 또.notAsked.length], [0, 1]);
    같나("quiet 이면 말이 안 나온다(기록은 남긴다)", [또.lines.length > 0, 글에있나(또.lines, "손대지 않습니다")], [true, true]);
  });

  await 모래상자(async (dir) => {
    구역("sync.states — 물어보지 못하면 빈 사전이 아니라 CouldNotAsk");
    const g = await 세상(dir, [{ 이름: "채널A", id: A }, { 이름: "채널C", id: C, 토큰: false }]);
    g.addVideo({ id: "x1", channelId: A, status: { privacyStatus: "public" } });
    같나("물어본 것만 돌려준다(없는 id 는 빠진다)", Object.keys(await states("채널A", ["x1", "x2"])), ["x1"]);
    같나("물을 id 가 없으면 빈 사전", await states("채널A", []), {});
    let 던짐 = "";
    try { await states("채널C", ["x1"]); } catch (e) { 던짐 = e instanceof CouldNotAsk ? e.message : `다른 오류 ${e}`; }
    같나("인증이 없으면 CouldNotAsk", 던짐, "채널C — 인증이 없습니다");
    g.failNext(/youtube\/v3\/videos/, 500, {});
    let 던짐2 = "";
    try { await states("채널A", ["x1"]); } catch (e) { 던짐2 = e instanceof CouldNotAsk ? "CouldNotAsk" : `다른 오류 ${e}`; }
    같나("유튜브가 500 을 주면 CouldNotAsk(없다는 뜻이 아니다)", 던짐2, "CouldNotAsk");
  });
}

/* ============================================================ 못 물음 (함정 3.1) */

async function 못물음() {
  구역("모르는 것과 없는 것은 다르다 — 못 물으면 손대지 않는다");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A }]);
    g.addVideo({ id: "k1", channelId: A, status: { privacyStatus: "public" } });
    await 원장쓰기([
      { 영상ID: "k1", 채널: "채널A", 제목: "있다", 공개설정: "비공개(검토대기)", 업로드시각: 며칠전(2) },
      { 영상ID: "k2", 채널: "채널A", 제목: "유튜브에 없는 것(하지만 못 물으면 모른다)", 공개설정: "public", 업로드시각: 며칠전(2) },
    ]);
    await savePending([대기({ channel: "채널A", video_id: "k2" })]);
    const 앞 = await Deno.readTextFile(dataPath("ledger.csv"));

    // 할당량이 떨어졌거나 유튜브가 죽었다
    g.failNext(/youtube\/v3\/videos/, 403, { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }], status: "RESOURCE_EXHAUSTED" } });
    const { 줄, say } = 모음();
    const r = await syncRun(false, { say });
    같나("못 물었다: 아무것도 안 바뀐다", [r.total, r.notAsked.map((x) => x.alias)], [0, ["채널A"]]);
    같나("원장 파일이 한 글자도 안 바뀌었다(7건이 다 날아간 사고가 났던 자리)", await Deno.readTextFile(dataPath("ledger.csv")), 앞);
    같나("심사 대기도 그대로", loadPending().map((p) => p.video_id), ["k2"]);
    같나("「손대지 않습니다」라고 말한다", 글에있나(줄, "손대지 않습니다"), true);
    같나("이 경우 「일치합니다」라고 거짓말하지 않는다", 글에있나(줄, "일치합니다"), false);

    // 같은 상태에서 이번엔 물을 수 있다 — 그때 비로소 판정한다
    const 다시 = await syncRun(true);
    같나("물을 수 있게 되면 판정한다(k2 는 유령, k1 은 공개로)", [다시.ghost, 행("k2").length, 행("k1")[0]["공개설정"]], [2, 0, "public"]);
  });

  await 모래상자(async (dir) => {
    await 세상(dir, [{ 이름: "채널A", id: A }]);
    같나("원장이 없으면 할 일이 없다(만들지도 않는다)", [(await syncRun(true)).total, await Deno.stat(dataPath("ledger.csv")).then(() => true, () => false)], [0, false]);
  });
}

/* ============================================================ 새로 적힌 줄 (경쟁) */

async function 새줄과동시() {
  구역("물어보는 동안 새로 적힌 줄은 안 건드린다 · 한 번에 하나만 돈다");
  await 모래상자(async (dir) => {
    const 구글 = new 끼어드는구글();
    const g = await 세상(dir, [{ 이름: "채널A", id: A }], 구글);
    g.addVideo({ id: "n1", channelId: A, status: { privacyStatus: "public" } });
    await 원장쓰기([{ 영상ID: "n1", 채널: "채널A", 제목: "원래 있던 줄", 공개설정: "비공개(검토대기)", 업로드시각: 며칠전(1) }]);
    await savePending([대기({ channel: "채널A", video_id: "n1" })]);
    구글.끼어들기 = async () => {
      // 유튜브가 대답하는 사이 업로드가 끝나 새 줄을 적었다 (아직 유튜브에는 안 보이는 영상)
      await 원장쓰기([
        ...readLedger(),
        { 영상ID: "n2", 채널: "채널A", 제목: "방금 올라간 줄", 공개설정: "비공개(검토대기)", 업로드시각: isoWall(wallNow()) },
      ]);
      await savePending([...loadPending(), 대기({ channel: "채널A", video_id: "n2", title: "방금 올라간 대기" })]);
    };
    const r = await syncRun(true);
    같나("원래 있던 줄은 맞춘다", [행("n1")[0]["공개설정"], r.ledger], ["public", 1]);
    같나("그 사이 적힌 줄은 안 지워지고 안 건드려진다", [행("n2").length, 행("n2")[0]["공개설정"]], [1, "비공개(검토대기)"]);
    같나("그 사이 적힌 대기도 남는다(원본은 읽어 둔 목록을 통째로 덮어 썼다)", loadPending().map((p) => p.video_id), ["n2"]);
    같나("유령으로 센 것은 「이미 공개된 대기」 1건뿐 — 새 줄은 유령이 아니다", r.ghost, 1);
  });

  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A }]);
    g.addVideo({ id: "d1", channelId: A, status: { privacyStatus: "public" } });
    await 원장쓰기([{ 영상ID: "d1", 채널: "채널A", 제목: "t", 공개설정: "비공개(검토대기)", 업로드시각: 며칠전(1) }]);
    let 물어본횟수 = 0;
    const 느린묻기 = async (alias: string, ids: string[]) => {
      물어본횟수++;
      await new Promise((r) => setTimeout(r, 250));
      return await states(alias, ids);
    };
    const 첫째 = syncRun(true, { asker: 느린묻기 });
    await new Promise((r) => setTimeout(r, 60));
    const 둘째 = await syncRun(true, { asker: 느린묻기 });
    같나("돌고 있는 동안 또 누르면 건너뛴다", [둘째.skipped, 글에있나(둘째.lines, "이미 맞추는 중")], [true, true]);
    const 첫 = await 첫째;
    같나("먼저 누른 것은 끝까지 돈다 · 유튜브에는 한 번만 물었다", [첫.skipped, 첫.ledger, 물어본횟수], [false, 1, 1]);
  });
}

/* ============================================================ 돌린 지 */

async function 돌린지() {
  구역("돌린 지 얼마나 됐나 — 표식 파일");
  await 모래상자(async () => {
    const 지금 = new Date("2027-03-10T01:00:00Z");
    같나("한 번도 안 돌렸으면 돌릴 때다", syncDue(1, 지금), true);
    await markSynced(지금);
    같나("방금 돌았으면 아니다", syncDue(1, 지금), false);
    같나("30분 뒤에도 한 시간 간격이면 아직", syncDue(1, new Date(지금.getTime() + 30 * 60_000)), false);
    같나("한 시간이 지나면 돌릴 때", syncDue(1, new Date(지금.getTime() + 61 * 60_000)), true);
    같나("간격을 짧게 주면 짧게", syncDue(0.25, new Date(지금.getTime() + 20 * 60_000)), true);
    await Deno.writeTextFile(recordPath("맞추기시각.txt"), "엉터리");
    같나("표식 글이 망가졌으면 돌릴 때(못 읽으면 쉬지 않는다)", syncDue(1, 지금), true);
  });
  await 모래상자(async (dir) => {
    await 세상(dir, [{ 이름: "채널A", id: A }]);
    같나("run 을 부르면 돌았다고 적는다", [syncDue(1), (await syncRun(true), syncDue(1))], [true, false]);
  });
}

/* ============================================================ recall (끔) */

async function 회수끔() {
  구역("저성과 회수 — 기본은 꺼져 있다");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A }]);
    g.addVideo({ id: "r1", channelId: A, status: { privacyStatus: "public" }, statistics: { viewCount: "5" } });
    await 원장쓰기([{ 영상ID: "r1", 채널: "채널A", 제목: "조회수 5 짜리", 공개설정: "public", 업로드시각: 며칠전(30) }]);
    g.clearCalls();
    같나("회수 칸이 없으면 꺼져 있다", [recallOn(), candidates().length], [false, 0]);
    const 줄 = 모음();
    const r = await recallRun({ say: 줄.say });
    같나("꺼져 있으면 아무것도 안 하고 유튜브도 안 부른다", [r.skipped, r.lowered, g.calls.length], ["off", 0, 0]);
    같나("조용한 길(예약 작업)에서는 말도 없다", 줄.줄.length, 0);
    const 보기 = await recallRun({ dryRun: true, say: 줄.say });
    같나("사람이 보기·지금을 누르면 꺼져 있다고 말한다", [보기.skipped, 글에있나(줄.줄, "꺼져 있습니다")], ["off", true]);
    같나("원장은 그대로", 행("r1")[0]["공개설정"], "public");
    같나("스로틀 표식도 안 만든다", await Deno.stat(recordPath("회수마지막.txt")).then(() => true, () => false), false);

    // 「회수제외」 만으로는 켜지지 않는다 · false 는 켠 게 아니다
    await writeJson(channelsPath(), {
      채널A: { channel_id: A, folder: `${dir}/영상/채널A`, 회수: false },
      채널B: { channel_id: B, folder: `${dir}/영상/채널B`, 회수제외: true },
    });
    같나("회수: false 는 꺼짐 · 회수제외만 있는 것도 꺼짐", recallOn(), false);
  });
}

/* ============================================================ recall (켬) */

async function 회수켬() {
  구역("저성과 회수 — 켠 채널만 · 7일 넘고 조회 1000 미만 · 읽고 합쳐 비공개로 · 수동비공개 명단");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [
      { 이름: "채널A", id: A, 설정: { 회수: true } },
      { 이름: "채널A롱폼", id: A, 토큰: false, 설정: { 회수제외: true } }, // 같은 유튜브 채널의 둘째 이름(롱폼용)
      { 이름: "채널B", id: B }, // 회수 안 켬
    ]);
    // 채널A: 오래되고 조회수 낮은 것 / 높은 것 / 어린 것 / 응답 없는 것
    g.addVideo({ id: "low", channelId: A, status: { privacyStatus: "public", embeddable: true, publicStatsViewable: true, selfDeclaredMadeForKids: false }, snippet: { title: "낮은 영상" }, statistics: { viewCount: "999" } });
    g.addVideo({ id: "edge", channelId: A, status: { privacyStatus: "public" }, statistics: { viewCount: "1000" } });
    g.addVideo({ id: "high", channelId: A, status: { privacyStatus: "public" }, statistics: { viewCount: "50000" } });
    g.addVideo({ id: "young", channelId: A, status: { privacyStatus: "public" }, statistics: { viewCount: "3" } });
    g.addVideo({ id: "hidden", channelId: A, status: { privacyStatus: "private" }, statistics: { viewCount: "2" } });
    g.addVideo({ id: "longlow", channelId: A, status: { privacyStatus: "public" }, statistics: { viewCount: "7" } });
    g.addVideo({ id: "bnot", channelId: B, status: { privacyStatus: "public" }, statistics: { viewCount: "1" } });
    await 원장쓰기([
      { 영상ID: "low", 채널: "채널A", 제목: "낮은 영상", 공개설정: "public", 업로드시각: 며칠전(10) },
      { 영상ID: "edge", 채널: "채널A", 제목: "딱 1000회", 공개설정: "public", 업로드시각: 며칠전(10) },
      { 영상ID: "high", 채널: "채널A", 제목: "잘 된 영상", 공개설정: "public", 업로드시각: 며칠전(40) },
      { 영상ID: "young", 채널: "채널A", 제목: "6일 된 영상", 공개설정: "public", 업로드시각: 며칠전(6) },
      { 영상ID: "hidden", 채널: "채널A", 제목: "원장엔 공개인데 이미 비공개", 공개설정: "public", 업로드시각: 며칠전(20) },
      { 영상ID: "sched", 채널: "채널A", 제목: "예약 중", 공개설정: "예약", 업로드시각: 며칠전(20) },
      { 영상ID: "done", 채널: "채널A", 제목: "이미 내린 것", 공개설정: LOWERED, 업로드시각: 며칠전(20) },
      { 영상ID: "longlow", 채널: "채널A롱폼", 제목: "롱폼칸 영상(회수제외)", 공개설정: "public", 업로드시각: 며칠전(20) },
      { 영상ID: "bnot", 채널: "채널B", 제목: "회수를 안 켠 채널", 공개설정: "public", 업로드시각: 며칠전(20) },
    ]);
    await saveTelegramConfig("123456:ABCdef", [777]);

    같나("켠 채널이 있으니 켜졌다", recallOn(), true);
    같나("채널A 는 대상 · 회수제외 칸은 아니다 · 안 켠 채널도 아니다", [recallable("채널A"), recallable("채널A롱폼"), recallable("채널B"), recallable("없는이름")], [true, false, false, false]);
    같나("후보: 공개 + 7일 넘음 + 켠 채널 + 제외 아님", candidates().map((c) => c.id).sort(), ["edge", "hidden", "high", "low"]);

    // 보기만
    g.clearCalls();
    const 보 = 모음();
    const 미리 = await recallRun({ dryRun: true, say: 보.say });
    같나("보기만: 아무것도 안 바꾼다", [미리.lowered, g.callsTo(/^videos\.update$/).length, 행("low")[0]["공개설정"], g.videos.get("low")!.status.privacyStatus], [0, 0, "public", "public"]);
    같나("보기만: 내릴 것 표시와 통과 표시", [글에있나(보.줄, "내릴 것  [채널A] 낮은 영상"), 글에있나(보.줄, "통과  [채널A] 잘 된 영상"), 글에있나(보.줄, "응답 없음")], [true, true, true]);
    같나("보기만: 조회수는 일괄 통계 한 번(딴 지갑)", g.callsTo(/batchGetStats/).length, 1);
    같나("보기만: 스로틀 표식을 안 남긴다", await Deno.stat(recordPath("회수마지막.txt")).then(() => true, () => false), false);

    // 실제로
    g.clearCalls();
    const 실 = 모음();
    const r = await recallRun({ say: 실.say });
    같나("실제: 1000 미만 한 편만 내린다(딱 1000 은 통과)", [r.lowered, r.rows.filter((x) => x.verdict === "lowered").map((x) => x.id)], [1, ["low"]]);
    같나("유튜브에서 비공개가 됐다", g.videos.get("low")!.status.privacyStatus, "private");
    같나("읽고 합쳐 썼다: 퍼가기·통계 공개·아동용 표시가 안 지워졌다", [
      g.videos.get("low")!.status.embeddable, g.videos.get("low")!.status.publicStatsViewable, g.videos.get("low")!.status.selfDeclaredMadeForKids,
    ], [true, true, false]);
    같나("나머지는 안 건드렸다", ["edge", "high", "hidden", "longlow", "bnot", "young"].map((id) => g.videos.get(id)!.status.privacyStatus), ["public", "public", "private", "public", "public", "public"]);
    같나("수정 호출은 한 번", g.callsTo(/^videos\.update$/).length, 1);
    같나("원장에 저성과비공개로 적힌다", 행("low")[0]["공개설정"], LOWERED);
    같나("사람이 내린 영상 명단에 오른다(자동 루틴이 다시 공개하지 못한다)", manualPrivateHas("low"), true);
    같나("올리기.log 에 남는다", (await Deno.readTextFile(recordPath("올리기.log"))).includes("저성과비공개  [채널A] 낮은 영상  999회"), true);
    같나("텔레그램으로 알린다", [g.telegram.length, g.telegram[0]?.text.includes("저성과 회수"), g.telegram[0]?.text.includes("낮은 영상")], [1, true, true]);
    같나("응답 없는 것(hidden)은 건너뛴다고 말한다", 글에있나(실.줄, "응답 없음(이미 비공개?)"), true);
    같나("회수는 후보에서 빠진다(다시는 검사 안 한다)", candidates().map((c) => c.id).includes("low"), false);

    // 스로틀: 한 시간에 한 번
    const 곧 = await recallRun({ say: 모음().say });
    같나("바로 또 부르면 아직 차례가 아니다", [곧.skipped, 곧.lowered], ["throttle", 0]);
    같나("강제(--지금)는 스로틀을 무시한다", (await recallRun({ force: true, say: 모음().say })).skipped, "");
    const 오십육분 = new Date(Date.now() + 56 * 60_000);
    같나("55분이 지나면 다시 돈다", (await recallRun({ clock: 오십육분, say: 모음().say })).skipped, "");
  });
}

/* ============================================================ recall (한 바퀴 · 막힘) */

async function 회수한바퀴() {
  구역("저성과 회수 — 한 바퀴에 최대 30편");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { 회수: true } }]);
    const 줄: Record<string, string>[] = [];
    for (let i = 0; i < 35; i++) {
      const id = `m${String(i).padStart(2, "0")}`;
      g.addVideo({ id, channelId: A, status: { privacyStatus: "public" }, statistics: { viewCount: "4" } });
      줄.push({ 영상ID: id, 채널: "채널A", 제목: `영상 ${i}`, 공개설정: "public", 업로드시각: 며칠전(12) });
    }
    await 원장쓰기(줄);
    const r = await recallRun({ say: 모음().say });
    같나("한 바퀴에 30편만 내린다", [MAX_PER_ROUND, r.lowered, r.rows.filter((x) => x.verdict === "later").length], [30, 30, 5]);
    같나("나머지 5편은 아직 공개", [...g.videos.values()].filter((v) => v.status.privacyStatus === "public").length, 5);
    const 다음 = await recallRun({ force: true, say: 모음().say });
    같나("다음 바퀴에 나머지를 내린다", [다음.lowered, [...g.videos.values()].filter((v) => v.status.privacyStatus === "public").length], [5, 0]);
  });
}

async function 회수막힘() {
  구역("저성과 회수 — 잠금 · 조회수를 못 읽음");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A, 설정: { 회수: true } }]);
    g.addVideo({ id: "z1", channelId: A, status: { privacyStatus: "public" }, statistics: { viewCount: "1" } });
    await 원장쓰기([{ 영상ID: "z1", 채널: "채널A", 제목: "낮음", 공개설정: "public", 업로드시각: 며칠전(9) }]);

    await setLocked(true);
    같나("잠겨 있으면 회수도 멈춘다", [isLocked(), (await recallRun({ say: 모음().say })).lowered, g.videos.get("z1")!.status.privacyStatus], [true, 0, "public"]);
    await setLocked(false);

    const 실패 = await recallRun({
      force: true, say: 모음().say, stats: async () => { throw new Error("통계를 못 받았습니다"); },
    });
    같나("조회수를 못 읽으면 내리지 않는다", [실패.skipped, 실패.lowered, g.videos.get("z1")!.status.privacyStatus], ["error", 0, "public"]);
    같나("(사람이 force 로 보면 읽지 못했다는 말이 나온다)", 글에있나(실패.lines, "조회수를 읽지 못했습니다"), true);
    await Deno.remove(recordPath("회수마지막.txt")).catch(() => {}); // 위 바퀴들이 남긴 표식을 치우고 다시 확인한다
    await recallRun({ say: 모음().say, stats: async () => { throw new Error("또 못 받음"); } });
    같나("조회수를 못 읽은 바퀴도 표식을 남긴다(함정 5.8 — 10분마다 같은 호출을 되풀이하지 않는다)", await Deno.stat(recordPath("회수마지막.txt")).then(() => true, () => false), true);
    같나("그래서 바로 다음 차례(스로틀 안)에는 쉰다", (await recallRun({ say: 모음().say, stats: async () => { throw new Error("안 불려야 한다"); } })).skipped, "throttle");

    const 아무도 = await recallRun({ force: true, say: 모음().say, stats: async () => ({}) });
    같나("응답이 비어 오면 전부 「응답 없음」으로 건너뛴다(내리지 않는다)", [아무도.lowered, 아무도.rows[0].verdict], [0, "noreply"]);
  });
}

/* ============================================================ selfcheck */

async function 점검() {
  구역("자가점검 — 놀 때 유튜브 호출 0건 · 올리기 셈 대조");
  await 모래상자(async (dir) => {
    const g = await 세상(dir, [{ 이름: "채널A", id: A }]);
    await Deno.writeFile(`${dir}/영상/채널A/한편.mp4`, new Uint8Array(0)); // 곁가지: 읽을 수 없는 파일이 있어도 화면 그리기는 안 새고 안 죽는다
    await savePending([대기({ channel: "채널A", video_id: "p1" })]);
    const 앞가드 = Deno.env.get("GARASADAE_OFFLINE");
    const 앞폴더 = Deno.env.get("GARASADAE_DATA_DIR");

    const { 줄, say } = 모음();
    const rep = await runChecks(defaultChecks(), { say });
    같나("기본 점검 여섯 자리가 모두 0건(돌리다 멈춘 자리도 없다)", [rep.rows.length, rep.rows.every((x) => x.calls === 0 && !x.note), rep.bad], [6, true, 0]);
    같나("가짜 서버에도 한 번도 안 닿았다", g.calls.length, 0);
    같나("끝 말: 규칙을 지키고 있다", 글에있나(줄, "규칙을 지키고 있습니다"), true);
    같나("점검이 끝나면 오프라인 가드·데이터 폴더가 원래대로", [Deno.env.get("GARASADAE_OFFLINE"), Deno.env.get("GARASADAE_DATA_DIR")], [앞가드, 앞폴더]);
    같나("진짜 대기 목록은 안 건드렸다(임시 폴더에서 돌렸다)", loadPending().map((p) => p.video_id), ["p1"]);
    같나("진짜 데이터 폴더에 점검 흔적(임시 대기 항목)이 없다", JSON.stringify(readJsonSync(dataPath("pending.json"), [])).includes("idle_new"), false);

    // 새는 자리를 심어 본다
    const 새는: IdleCheck = {
      name: "새는 자리", why: "화면을 그릴 때 유튜브를 부르면 안 된다",
      fn: async () => { const yt = await ytFor("채널A"); await yt.get("/youtube/v3/videos", { part: "id", id: "x" }); },
    };
    const 얌전: IdleCheck = { name: "얌전한 자리", why: "", fn: () => { quota.today(); } };
    const 줄2 = 모음();
    const 샘 = await runChecks([얌전, 새는], { say: 줄2.say });
    같나("샌 자리를 잡는다(호출 1건 이상)", [샘.rows[0].leaked, 샘.rows[1].leaked, 샘.rows[1].calls >= 1], [false, true, true]);
    같나("보고에 까닭과 부른 자리가 나온다", [글에있나(줄2.줄, "[샌다] 새는 자리"), 글에있나(줄2.줄, "화면을 그릴 때 유튜브를 부르면 안 된다"), 글에있나(줄2.줄, "→ ")], [true, true, true]);
    같나("샌 자리가 있으면 문제 수가 센다", 샘.bad >= 1, true);
    같나("종료 코드는 문제가 있으면 1", await selfMain({ say: () => {}, checks: [새는] }), 1);
    같나("종료 코드는 깨끗하면 0", await selfMain({ say: () => {}, checks: [얌전] }), 0);

    // 오프라인 가드를 껐다 켜도 존중한다
    Deno.env.delete("GARASADAE_OFFLINE");
    await runChecks([얌전], { say: () => {} });
    같나("가드가 없던 환경에서는 끝나고 다시 없다", Deno.env.get("GARASADAE_OFFLINE"), undefined);
    Deno.env.set("GARASADAE_OFFLINE", "1");
  });

  await 모래상자(async () => {
    구역("올리기 셈 대조 — 원장에 오늘 올린 게 있는데 계량기가 안 셌으면 샌다");
    같나("아무것도 없으면 0 = 0", uploadCounts(), { ledger: 0, meter: 0 });
    await 원장쓰기([{ 영상ID: "u1", 채널: "채널A", 제목: "오늘 올림", 업로드시각: isoWall(wallNow()), 공개설정: "비공개(검토대기)" }]);
    같나("원장 1건 · 계량기 0건", uploadCounts(), { ledger: 1, meter: 0 });
    const 샘 = await runChecks([], { say: () => {} });
    같나("올렸는데 안 셌다 = 샌다", [샘.leakInsert, 샘.bad], [true, 1]);
    await quota.spend("videos.insert");
    같나("세어 두면 맞는다", uploadCounts(), { ledger: 1, meter: 1 });
    const 맞음 = await runChecks([], { say: () => {} });
    같나("맞으면 통과", [맞음.leakInsert, 맞음.bad], [false, 0]);
    await quota.spend("videos.insert");
    const 더 = await runChecks([], { say: () => {} });
    같나("계량기가 원장보다 많은 것은 누수가 아니다(삭제 영상 정리일 수 있다)", [더.leakInsert, 더.bad, 글에있나(더.lines, "[참고]")], [false, 0, true]);
  });
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

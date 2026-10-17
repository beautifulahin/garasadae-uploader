// 심사·공개 시험 — 올린 영상을 30분 뒤 한 번 확인하고, 이상 없는 것만 공개로 바꾼다. 가짜 구글 서버만 쓴다.
import { 같나, 구역, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 채널준비 } from "./바탕.ts";
import * as R from "../app/review.ts";
import { manualPrivateAdd, setLocked } from "../app/safety.ts";
import { appendLedger, patchLedger, readLedger } from "../app/ledger.ts";
import { isoWall, wallNow } from "../app/clock.ts";
import { dataPath } from "../app/paths.ts";

type Obj = Record<string, any>;
const 분 = 60_000;

export async function 실행() {
  구역("판정 표 (judge)");
  같나("거부됨 — 사유를 한국말로", R.judge({ uploadStatus: "rejected", rejectionReason: "copyright" }, {}), ["bad", "거부됨 — 저작권 위반"]);
  같나("실패 — 사유를 한국말로", R.judge({ uploadStatus: "failed", failureReason: "codec" }, {}), ["bad", "실패 — 코덱 문제"]);
  같나("모르는 사유는 그대로", R.judge({ uploadStatus: "rejected", rejectionReason: "zzz" }, {})[1], "거부됨 — zzz");
  같나("삭제됨", R.judge({ uploadStatus: "deleted" }, {}), ["bad", "삭제된 영상"]);
  같나("처리 실패", R.judge({ uploadStatus: "processed" }, { processingStatus: "failed" }), ["bad", "유튜브 처리 실패"]);
  같나("처리 중이면 기다린다", R.judge({ uploadStatus: "uploaded" }, { processingStatus: "processing" })[0], "wait");
  같나("처리됨 + 이상 없음", R.judge({ uploadStatus: "processed", embeddable: true, publicStatsViewable: true, license: "youtube" }, { processingStatus: "succeeded" }), ["ok", "이상 없음"]);
  같나("퍼가기가 꺼져 있으면 확인 필요(claim)", R.judge({ uploadStatus: "processed", embeddable: false }, {})[0], "claim");
  같나("통계 공개가 꺼져 있어도 확인 필요", R.judge({ uploadStatus: "processed", publicStatsViewable: false }, {})[0], "claim");
  같나("라이선스가 다르면 확인 필요", R.judge({ uploadStatus: "processed", license: "weird" }, {}), ["claim", "라이선스 표시가 다릅니다 — weird"]);
  같나("크리에이티브 커먼즈는 괜찮다", R.judge({ uploadStatus: "processed", license: "creativeCommon" }, {})[0], "ok");
  같나("모르는 상태는 기다린다", R.judge({ uploadStatus: "?" }, {})[0], "wait");

  구역("언제 볼 차례인가 — 올린 지 30분 뒤 한 번");
  await 모래상자(async () => {
    const now = new Date();
    const w = wallNow();
    const 올림 = (분전: number) => isoWall(new Date(w.getTime() - 분전 * 분));
    const it = (o: Obj = {}): R.PendingItem => ({ channel: "채널A", video_id: "V", title: "t", publish_at: null, uploaded: 올림(0), 확인수: 0, 사람확인: false, 시각정한이: "auto", ...o });
    const a = R.whenToLook(it(), now);
    같나("방금 올렸으면 아직 — 30분 안쪽 남음", [a.look, a.remaining >= 29 && a.remaining <= 30, a.turn], [false, true, 1]);
    같나("31분 지났으면 볼 차례", R.whenToLook(it({ uploaded: 올림(31) }), now).look, true);
    const done = R.whenToLook(it({ uploaded: 올림(40), 확인수: 1 }), now);
    같나("한 번 봤으면 끝 — 사람 몫", [done.look, done.done], [false, true]);
    같나("사람확인으로 넘겼으면 끝", R.whenToLook(it({ 사람확인: true, 확인수: 1 }), now).done, true);
    같나("올린 때를 읽지 못하면 일단 본다", R.whenToLook(it({ uploaded: "???" }), now).look, true);
    같나("예약 시각이 지났나(UTC Z)", [R.isPast("2020-01-01T00:00:00Z", now), R.isPast("2999-01-01T00:00:00Z", now)], [true, false]);
    같나("읽을 수 없는 값은 지나지 않은 것으로", R.isPast("내일", now), false);
  });

  구역("공개 한 바퀴 — 이상 없는 것만 공개로 (가짜 구글)");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    const c = await 채널준비(dir, fake, { name: "채널A" });
    const w = wallNow();
    const 올림 = (분전: number) => isoWall(new Date(w.getTime() - 분전 * 분));
    const wallStr = (d: Date) => { const p = (x: number) => String(x).padStart(2, "0"); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
    let 번호 = 0;
    /** 올린 영상 하나를 만든다 (유튜브엔 비공개·처리 끝, 장부와 심사 대기에도 오른다) */
    const 만들기 = async (o: { 분전?: number; pend?: Obj; video?: Obj; ledger?: Obj } = {}) => {
      const id = `VID${++번호}`;
      fake.addVideo({ id, channelId: c.id, snippet: { title: `영상 ${id}` }, status: { privacyStatus: "private", uploadStatus: "processed", ...(o.video ?? {}) } });
      await appendLedger({ 업로드시각: 올림(o.분전 ?? 40), 채널: "채널A", 영상ID: id, 제목: `영상 ${id}`, 파일: `/f/${id}.mp4`, 길이초: "40.0", 해상도: "1080x1920", 공개설정: "비공개(검토대기)", ...(o.ledger ?? {}) });
      await R.updatePending((items) => { items.push({ channel: "채널A", video_id: id, title: `영상 ${id}`, publish_at: null, uploaded: 올림(o.분전 ?? 40), 확인수: 0, 사람확인: false, 시각정한이: "auto", ...(o.pend ?? {}) }); return items; });
      return id;
    };
    const 줄: string[] = [];
    const say = (s: string) => { 줄.push(s); };
    // 앞에서 공개한 영상들이 공개 간격(2시간)에 걸리지 않게, 장부의 공개·예약 시각을 3일 전으로 돌려 둔다
    const 간격비우기 = async () => {
      for (const r of readLedger()) {
        if (r["공개시각"]) await patchLedger(r["영상ID"], { 공개시각: wallStr(new Date(w.getTime() - 3 * 86_400_000)) });
      }
    };
    const 갱신수 = () => fake.callsTo(/^videos\.update$/).length;
    const 남음 = () => R.loadPending().map((x) => x.video_id);
    const 장부 = (id: string) => readLedger().find((r) => r["영상ID"] === id)!;

    // 1) 아직 볼 때가 아님
    const e0 = await 만들기({ 분전: 5 });
    fake.clearCalls();
    const r0 = await R.run(true, "예약작업", { say });
    같나("30분이 안 됐으면 유튜브를 부르지 않는다(유닛도 안 씀)", [fake.calls.length, 남음().includes(e0)], [0, true]);
    같나("남은 분을 알려 준다", 줄.some((s) => /번째 확인까지 \d+분 남음/.test(s)), true);
    같나("결과 모양", [r0.opened, r0.blocked, r0.kept], [0, 0, 1]);
    await R.updatePending(() => []);

    // 2) 이상 없음 → 공개 (확인만이면 안 바꾼다)
    const ok1 = await 만들기();
    fake.clearCalls();
    await R.run(false, "", { say });
    같나("확인만 하면(doPublish=false) videos.update 를 안 부른다", 갱신수(), 0);
    같나("확인만 해도 확인수는 올라간다", R.loadPending().find((x) => x.video_id === ok1)!.확인수, 1);
    await R.updatePending(() => []);

    const ok2 = await 만들기();
    fake.clearCalls();
    const r2 = await R.run(true, "예약작업", { say });
    같나("이상 없으면 공개로 바뀐다", fake.videos.get(ok2)!.status.privacyStatus, "public");
    같나("공개 전환이 퍼가기·통계 공개를 지우지 않는다(읽고 합쳐 쓰기)", [fake.videos.get(ok2)!.status.embeddable, fake.videos.get(ok2)!.status.publicStatsViewable], [true, true]);
    같나("보낸 status 에 publishAt 이 없다", "publishAt" in (fake.callsTo(/^videos\.update$/)[0].body.status), false);
    같나("장부에 공개시각·공개설정이 적힌다", [장부(ok2)["공개설정"], 장부(ok2)["공개시각"] !== ""], ["public", true]);
    같나("심사 대기에서 빠진다", 남음().includes(ok2), false);
    같나("결과", [r2.opened, r2.blocked], [1, 0]);

    // 3) 누가 시켰는지 밝히지 않으면 공개 안 함
    const ok3 = await 만들기();
    fake.clearCalls();
    await R.run(true, "", { say });
    같나("누가 시켰는지 밝히지 않으면 공개하지 않는다", [갱신수(), fake.videos.get(ok3)!.status.privacyStatus], [0, "private"]);
    같나("그 영상은 목록에 남는다", 남음().includes(ok3), true);
    await R.updatePending(() => []);

    // 4) 예약
    await 간격비우기();
    const 먼 = new Date(Date.now() + 600 * 분).toISOString().replace(/\.\d{3}Z$/, "Z");
    const rs = await 만들기({ pend: { publish_at: 먼, 시각정한이: "user" } });
    await R.run(true, "예약작업", { say });
    같나("사람이 고른 예약은 비공개 + 예약 시각으로 둔다", [fake.videos.get(rs)!.status.privacyStatus, fake.videos.get(rs)!.status.publishAt], ["private", 먼]);
    같나("예약은 아직 공개된 것이 아니다 — 장부에 「예약」", [장부(rs)["공개설정"], 장부(rs)["공개시각"]], ["예약", ""]);
    같나("예약 건은 목록에서 빠진다", 남음().includes(rs), false);

    const ra = await 만들기({ pend: { publish_at: 먼, 시각정한이: "auto" } });
    await R.run(true, "예약작업", { say });
    같나("앱이 계획한 시각은 기다리지 않고 바로 공개한다", fake.videos.get(ra)!.status.privacyStatus, "public");
    await 간격비우기();

    const rp = await 만들기({ pend: { publish_at: "2020-01-01T00:00:00Z", 시각정한이: "user" } });
    await R.run(true, "예약작업", { say });
    같나("이미 지난 예약은 지금 연다(지난 시각을 보내면 유튜브가 거부한다)", fake.videos.get(rp)!.status.privacyStatus, "public");
    await 간격비우기();

    // 5) 공개 간격 — 막히면 확인수를 되돌려 다음에 다시
    const 방금 = isoWall(w);
    await appendLedger({ 업로드시각: 방금, 채널: "채널A", 영상ID: "GAP0", 제목: "앞 영상", 파일: "/f/g.mp4", 길이초: "40.0", 해상도: "1080x1920", 공개시각: wallStr(new Date(w.getTime() - 20 * 분)) });
    const gp = await 만들기();
    fake.clearCalls();
    await R.run(true, "예약작업", { say });
    const g = R.loadPending().find((x) => x.video_id === gp)!;
    같나("간격 2시간 미달이면 공개하지 않는다", [갱신수(), fake.videos.get(gp)!.status.privacyStatus], [0, "private"]);
    같나("간격 대기는 검토를 쓴 것이 아니다 — 확인수를 되돌린다", [g.확인수, String(g.간격대기).includes("공개 간격")], [0, true]);
    await R.updatePending(() => []);
    // 간격 장부를 비운다 (다음 시험에 영향 없게)
    const rows = readLedger().filter((r) => r["영상ID"] !== "GAP0");
    void rows;

    // 6) 사람이 내린 영상 · 제한 · 처리 중 · 없음 · 이미 공개
    const mp = await 만들기({ ledger: { 업로드시각: 올림(40) } });
    await manualPrivateAdd(mp, "채널A", "내린 영상");
    fake.clearCalls();
    await R.run(true, "예약작업", { say });
    같나("사람이 내린 영상은 자동 공개하지 않고 목록에서 뺀다", [갱신수(), 남음().includes(mp)], [0, false]);

    const cl = await 만들기({ video: { embeddable: false } });
    fake.clearCalls();
    const rc = await R.run(true, "예약작업", { say });
    같나("제한이 걸린 영상(claim)은 공개하지 않고 사람에게 알린다", [갱신수(), rc.blocked, 남음().includes(cl)], [0, 1, true]);
    await R.updatePending(() => []);

    const pr = await 만들기({ video: { uploadStatus: "uploaded" } });
    fake.videos.get(pr)!.processingDetails = { processingStatus: "processing" };
    fake.clearCalls();
    await R.run(true, "예약작업", { say });
    같나("처리 중이면 기다린다(목록에 남음·공개 안 함)", [갱신수(), 남음().includes(pr), fake.videos.get(pr)!.status.privacyStatus], [0, true, "private"]);
    await R.updatePending(() => []);

    await R.updatePending((items) => { items.push({ channel: "채널A", video_id: "NOPE", title: "사라진", publish_at: null, uploaded: 올림(40), 확인수: 0, 사람확인: false, 시각정한이: "auto" }); return items; });
    const rn = await R.run(true, "예약작업", { say });
    같나("유튜브에 없는 영상은 알리고 목록에서 뺀다", [rn.blocked, 남음().includes("NOPE")], [1, false]);

    const pub = await 만들기({ video: { privacyStatus: "public" } });
    fake.clearCalls();
    const rpub = await R.run(true, "예약작업", { say });
    같나("스튜디오에서 이미 공개한 영상은 할 일이 없다 — 목록에서 뺀다", [갱신수(), rpub.opened, 남음().includes(pub)], [0, 1, false]);

    // 7) 한 번 봤는데도 안 풀리면 사람 몫 · 늦은 심사 구제
    const hu = await 만들기({ video: { uploadStatus: "uploaded" }, pend: { 확인수: 1 } });
    fake.videos.get(hu)!.processingDetails = { processingStatus: "processing" };
    const rh = await R.run(true, "예약작업", { say });
    같나("확인을 다 썼는데 안 풀렸으면 사람확인으로 넘긴다", [R.loadPending().find((x) => x.video_id === hu)!.사람확인, rh.blocked], [true, 1]);
    같나("사람확인필요가 올리기.log 에 남는다(브리핑이 읽는다)", (await Deno.readTextFile(dataPath("기록", "올리기.log"))).includes("사람확인필요"), true);
    fake.clearCalls();
    await R.run(true, "예약작업", { say });
    같나("사람확인으로 넘긴 것은 한 시간이 안 지났으면 조회하지 않는다", fake.calls.length, 0);
    await R.updatePending((items) => items.map((x) => x.video_id === hu ? { ...x, uploaded: 올림(180), 마지막확인: 올림(90) } : x));
    fake.finishProcessing(hu);
    await 간격비우기();
    fake.clearCalls();
    await R.run(true, "예약작업", { say });
    같나("느린 심사 구제 — 올린 지 12시간 안이고 마지막 확인이 1시간 전이면 한 번 더 본다", [fake.callsTo(/^videos\.list$/).length > 0, fake.videos.get(hu)!.status.privacyStatus], [true, "public"]);

    // 8) 검토하는 동안 새로 올라간 영상이 목록에서 사라지지 않는다
    const nv = await 만들기({ 분전: 1 });
    let 끼움: Promise<void> | null = null;
    const 끼우기 = (s: string) => { if (!끼움 && s.includes("검토 대기")) 끼움 = R.addPending("채널A", "NEWV", "새로 올라간 영상", null, "auto"); };
    await R.run(true, "예약작업", { say: 끼우기 });
    await 끼움;
    같나("검토 도중에 올라간 영상이 목록을 덮어쓰며 사라지지 않는다", 남음().includes("NEWV") && 남음().includes(nv), true);

    // 9) 잠그면 공개도 멈춘다
    const lk = await 만들기();
    await setLocked(true);
    fake.clearCalls();
    await R.run(true, "예약작업", { say });
    await setLocked(false);
    같나("잠겨 있으면 공개도 멈춘다", [갱신수(), fake.videos.get(lk)!.status.privacyStatus], [0, "private"]);

    같나("화면용 한 줄 요약(describePending)이 유튜브를 안 부른다", (fake.clearCalls(), R.describePending().length > 0 && fake.calls.length === 0), true);
  });
  void 참인가;
}

if (import.meta.main) {
  const { 결과 } = await import("./도구.ts");
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

// 올리기 시험 — 업로드 · 발사대기 · 심사·공개. 가짜 구글 서버만 쓴다(실제 업로드·공개·인증 요청 0건).
import { 같나, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 분뒤, 영상두기, 채널준비 } from "./바탕.ts";
import { type Job, uploadOne, loadPolicy, toRfc3339, ensurePolicy } from "../app/upload.ts";
import * as Q from "../app/queue.ts";
import * as R from "../app/review.ts";
import { ExitBlocked, resetSafetyCache, setLocked } from "../app/safety.ts";
import { appendLedger, readLedger } from "../app/ledger.ts";
import { editChannels } from "../app/channels.ts";
import { dataPath, readJsonSync, writeJson } from "../app/paths.ts";
import { GoogleError } from "../app/google.ts";
import { isoWall, minuteWall, wall, wallNow } from "../app/clock.ts";
import { writePolicy } from "../app/daily.ts";

type Obj = Record<string, any>;
const 보고: string[] = [];
const say = (s: string) => { 보고.push(s); };

const 몸 = (fake: 가짜구글): Obj => fake.callsTo(/^videos\.insert$/)[0]?.body ?? {};
const 로그 = async (이름: string) => { try { return await Deno.readTextFile(dataPath("기록", 이름)); } catch { return ""; } };
const 일감 = (c: { name: string }, file: string, o: Obj = {}): Job => ({ channel: c.name, file, _승인: "사람 승인 (시험)", time_by: "user", ...o });

export async function 실행() {
  구역("업로드 — 한 편을 비공개로 올리고 장부에 남긴다");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글(); fake.instantProcessing = true;
    const c = await 채널준비(dir, fake, { name: "채널A", conf: { audio_language: "ko" } });
    const v = await 영상두기(c.folder, "영상1.mp4", { txt: "[제목]\n첫 영상 제목\n\n[설명]\n설명 한 줄\n\n[해시태그]\n#태그가 #태그나\n" });
    const j = 일감(c, v);
    const vid = await uploadOne(j, { say, waitScale: 0 });
    참인가("영상 id 를 돌려준다", typeof vid === "string" && vid!.startsWith("FAKE"));
    const b = 몸(fake);
    같나("업로드는 언제나 비공개", b.status?.privacyStatus, "private");
    같나("퍼가기·통계 공개를 못박는다", [b.status?.embeddable, b.status?.publicStatsViewable], [true, true]);
    같나("아동용 아님·AI 합성 아님(기본 원칙)", [b.status?.selfDeclaredMadeForKids, b.status?.containsSyntheticMedia], [false, false]);
    같나("제목은 곁글에서", b.snippet?.title, "첫 영상 제목");
    같나("카테고리 기본 22", b.snippet?.categoryId, "22");
    같나("채널 칸의 언어를 못박는다", [b.snippet?.defaultLanguage, b.snippet?.defaultAudioLanguage], ["ko", "ko"]);
    같나("태그는 곁글의 해시태그", b.snippet?.tags, ["태그가", "태그나"]);
    같나("영상 종류가 일감에 적힌다", [j.영상종류, j.롱폼], ["쇼츠", false]);
    const row = readLedger().find((r) => r["영상ID"] === vid)!;
    같나("장부: 채널·제목", [row["채널"], row["제목"]], ["채널A", "첫 영상 제목"]);
    같나("장부: 해상도·길이", [row["해상도"], row["길이초"]], ["1080x1920", "40.0"]);
    같나("장부: 비공개(검토대기)", row["공개설정"], "비공개(검토대기)");
    같나("장부: 아동용 False", row["아동용"], "False");
    const pend = R.loadPending().find((x) => x.video_id === vid)!;
    같나("심사 대기에 올랐다(확인수 0 · 사람이 정한 시각)", [pend.확인수, pend.시각정한이, pend.publish_at], [0, "user", null]);
    같나("올리기 기록이 남는다", (await 로그("올리기.log")).includes(`업로드  [채널A] 영상1.mp4  ${vid}`), true);

    구역("업로드 — 출구에서 막히면 유튜브를 한 번도 안 부른다");
    fake.clearCalls();
    const v2 = await 영상두기(c.folder, "영상2.mp4");
    resetSafetyCache();
    await 던지나("사람 승인 표시가 없으면 막는다", () => uploadOne(일감(c, v2, { _승인: "" }), { say, waitScale: 0 }), /사람 승인 표시가 없습니다/);
    같나("그때 videos.insert 호출은 0건", fake.callsTo(/^videos\.insert/).length, 0);
    await 던지나("같은 파일을 두 번 올리면 막는다(장부 기준)", () => uploadOne(일감(c, v), { say, waitScale: 0 }), /이미 올린 파일입니다/);
    같나("그때도 호출 0건", fake.callsTo(/^videos\.insert/).length, 0);
    await setLocked(true);
    await 던지나("잠겨 있으면 막는다", () => uploadOne(일감(c, v2), { say, waitScale: 0 }), /잠겨 있습니다/);
    await setLocked(false);
    const 깨진 = `${c.folder}/깨짐.mp4`;
    await Deno.writeFile(깨진, new Uint8Array([0, 0, 0, 8, 102, 114, 101, 101]));
    await 던지나("읽지 못하는 파일은 올리지 않는다(롱폼으로 치지도 않는다)", () => uploadOne(일감(c, 깨진), { say, waitScale: 0 }));
    같나("깨진 파일도 호출 0건", fake.callsTo(/^videos\.insert/).length, 0);
    await 던지나("없는 파일", () => uploadOne(일감(c, `${c.folder}/없음.mp4`), { say, waitScale: 0 }), /파일이 없습니다/);
    같나("시험 모드(dry)는 올리지 않는다", await uploadOne(일감(c, v2), { dry: true, say, waitScale: 0 }), null);
    같나("dry 도 호출 0건", fake.callsTo(/^videos\.insert/).length, 0);
  });

  구역("업로드 — 롱폼 썸네일 · 예약 시각 · 운영 원칙 · 끊긴 전송 이어올리기");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글(); fake.instantProcessing = true;
    const c = await 채널준비(dir, fake, { name: "채널A", conf: { thumb_watch: true } });
    const png = (w: number, h: number, extra = 0) => {
      // PNG 머리(서명 + IHDR)만 있는 가짜 그림 — 크기만 읽힌다
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, ...u32(w), ...u32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0];
      return new Uint8Array([...sig, ...ihdr, ...new Uint8Array(extra)]);
    };
    const lv = await 영상두기(c.folder, "롱1.mp4", { long: true });
    await Deno.writeFile(`${c.folder}/롱1.png`, png(1280, 720));
    const j = 일감(c, lv);
    const vid = await uploadOne(j, { say, waitScale: 0 });
    같나("롱폼으로 판정된다", [j.영상종류, j.롱폼, j.allow_not_short], ["롱폼", true, true]);
    같나("영상 옆 그림이 맞춤 썸네일로 올라간다", fake.thumbs.map((t) => [t.videoId, t.mime]), [[vid, "image/png"]]);
    같나("롱폼은 장부에도 롱폼 꼴로(가로·400초)", readLedger().find((r) => r["영상ID"] === vid)!["해상도"], "1920x1080");

    const lv2 = await 영상두기(c.folder, "롱2.mp4", { long: true });
    await Deno.writeFile(`${c.folder}/롱2.png`, png(1280, 720, 2 * 1024 * 1024 + 10));
    fake.thumbs.length = 0;
    const vid2 = await uploadOne(일감(c, lv2), { say, waitScale: 0 });
    같나("2MB 를 넘는 그림은 올리지 않고 알린다", [fake.thumbs.length, 보고.some((s) => s.includes("2MB를 넘어 건너뜁니다"))], [0, true]);
    참인가("그래도 영상은 올라갔다", !!vid2);

    const lv3 = await 영상두기(c.folder, "롱3.mp4", { long: true });
    await Deno.writeFile(`${c.folder}/롱3.png`, png(1280, 720));
    fake.failNext(/thumbnails\/set/, 403, { error: { code: 403, message: "thumbnail permission", errors: [{ reason: "forbidden" }] } });
    const vid3 = await uploadOne(일감(c, lv3), { say, waitScale: 0 });
    참인가("썸네일이 실패해도 영상은 이미 올라가 있다", !!vid3);
    const 표식 = readJsonSync<Obj[]>(dataPath("썸네일대기.json"), []);
    같나("thumb_watch 채널은 실패 표식(썸네일대기.json)을 남긴다", [표식.length, 표식[0]?.video_id], [1, vid3]);

    // 감시 안 하는 채널은 표식이 없다
    await editChannels((d) => { d["채널A"].thumb_watch = false; });
    const lv4 = await 영상두기(c.folder, "롱4.mp4", { long: true });
    await Deno.writeFile(`${c.folder}/롱4.png`, png(1280, 720));
    fake.failNext(/thumbnails\/set/, 403, { error: { code: 403, message: "x", errors: [{ reason: "forbidden" }] } });
    await uploadOne(일감(c, lv4), { say, waitScale: 0 });
    같나("thumb_watch 가 없으면 표식을 안 남긴다", readJsonSync<Obj[]>(dataPath("썸네일대기.json"), []).length, 1);

    // 예약 시각
    const sv = await 영상두기(c.folder, "쇼츠예약.mp4");
    const 예약 = 분뒤(600);
    const j2 = 일감(c, sv, { publish_at: 예약 });
    const vid5 = await uploadOne(j2, { say, waitScale: 0 });
    const p5 = R.loadPending().find((x) => x.video_id === vid5)!;
    같나("예약은 UTC 로 바뀌어 심사 대기에 남는다", p5.publish_at, toRfc3339(예약));
    참인가("UTC 표기는 Z 로 끝난다", String(p5.publish_at).endsWith("Z"));
    같나("장부에는 사람이 적은 시각 그대로", readLedger().find((r) => r["영상ID"] === vid5)!["예약시각"], 예약);
    const sv2 = await 영상두기(c.folder, "쇼츠지난예약.mp4");
    const vid6 = await uploadOne(일감(c, sv2, { publish_at: "2020-01-01 09:00" }), { say, waitScale: 0 });
    같나("이미 지난 예약은 걸러 「심사 끝나면 바로」 로 돌린다", R.loadPending().find((x) => x.video_id === vid6)!.publish_at, null);
    await 던지나("형식이 틀린 예약 글은 읽지 못한다", async () => toRfc3339("내일 아침"), /발행 시각 형식을 못 읽었습니다/);
    같나("초가 있는 꼴도 읽는다", toRfc3339("2026-09-01 09:00:30").endsWith(":30Z"), true);
    같나("한국 09:00 은 UTC 00:00", toRfc3339("2026-09-01 09:00").slice(0, 16), "2026-09-01T00:00".replace("T00", "T00"));

    // 운영 원칙
    같나("policy.json 이 없으면 안전한 기본값", [loadPolicy().made_for_kids, loadPolicy().contains_synthetic_media, loadPolicy().default_category], [false, false, 22]);
    await ensurePolicy();
    같나("처음 켤 때 policy.json 을 눈에 보이게 적어 둔다", readJsonSync<Obj>(dataPath("policy.json"), {}).made_for_kids, false);
    await writeJson(dataPath("policy.json"), { made_for_kids: true, contains_synthetic_media: true, default_category: 24 });
    const sv3 = await 영상두기(c.folder, "쇼츠정책.mp4");
    fake.clearCalls();
    await uploadOne(일감(c, sv3), { say, waitScale: 0 });
    같나("운영 원칙의 아동용·AI 합성·카테고리를 따른다", [몸(fake).status?.selfDeclaredMadeForKids, 몸(fake).status?.containsSyntheticMedia, 몸(fake).snippet?.categoryId], [true, true, "24"]);
    await editChannels((d) => { d["채널A"].made_for_kids = false; });
    const sv4 = await 영상두기(c.folder, "쇼츠채널별.mp4");
    fake.clearCalls();
    await uploadOne(일감(c, sv4, { synthetic: false, category: 10 }), { say, waitScale: 0 });
    같나("채널 칸의 made_for_kids 와 일감의 synthetic·category 가 이긴다", [몸(fake).status?.selfDeclaredMadeForKids, 몸(fake).status?.containsSyntheticMedia, 몸(fake).snippet?.categoryId], [false, false, "10"]);
    await Deno.remove(dataPath("policy.json"));

    // 끊긴 전송
    const sv5 = await 영상두기(c.folder, "끊김.mp4", { mb: 9 }); // 8MB 조각 둘
    fake.dropNextChunk = true;
    fake.clearCalls();
    const vid7 = await uploadOne(일감(c, sv5), { say, waitScale: 0 });
    참인가("조각이 한 번 끊겨도 이어서 올라간다", !!vid7);
    같나("videos.insert 는 한 번 올라간 것으로 한 번만 센다", fake.videos.size >= 1 && fake.callsTo(/^videos\.insert$/).length, 1);
  });

  구역("발사대기 — 정한 시각까지 컴퓨터에 붙들어 두었다가 쏜다");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글(); fake.instantProcessing = true;
    const c = await 채널준비(dir, fake, { name: "채널A" });
    const a = await 영상두기(c.folder, "a.mp4"), b = await 영상두기(c.folder, "b.mp4"), d = await 영상두기(c.folder, "c.mp4");
    같나("승인 표시가 없으면 담지 않는다", await Q.add({ channel: "채널A", file: a }, "2026-10-20T09:00:00", say), false);
    같나("승인 표시가 있으면 담는다", await Q.add(일감(c, b, { publish_at: "2026-10-21 09:00" }), "2026-10-20T10:00:00", say), true);
    await Q.add(일감(c, a, { publish_at: "2026-10-21 08:00" }), "2026-10-20T09:00:00", say);
    같나("쏠 시각이 이른 것부터", Q.list().map((x) => baseOf(x.file)), ["a.mp4", "b.mp4"]);
    await Q.add(일감(c, a), "2026-10-20T11:30:00", say);
    같나("같은 파일을 또 담으면 시각만 고친다", [Q.list().length, Q.list().find((x) => baseOf(x.file) === "a.mp4")!.쏠때], [2, "2026-10-20T11:30:00"]);
    같나("담긴 일감에 영상 종류가 적힌다", Q.list()[0].영상종류, "쇼츠");
    같나("남은 분(음수 = 늦음)", Q.minutesLeft({ 쏠때: "2026-10-20T10:00:00" }, wall(2026, 10, 20, 9, 30)), 30);
    같나("쏠 때가 된 것만", Q.due(wall(2026, 10, 20, 10, 30)).map((x) => baseOf(x.file)), ["b.mp4"]);
    같나("빼기", [await Q.remove(a), await Q.remove(a)], [true, false]);
    같나("여러 개를 한 번에 빼기(NFC 비교)", await Q.removeMany([b.normalize("NFD")]), 1);
    같나("다 빠졌다", Q.list().length, 0);
    같나("묶음 취소는 비어 있으면 0", await Q.removeMany([]), 0);

    구역("발사대기 — 심야 금지·잠금·동시 전송");
    같나("심야 금지는 기본이 켜짐", Q.nightBan(), true);
    같나("스위치를 뒤집으면 허용", await Q.toggleNight(), false);
    같나("다시 뒤집으면 금지", await Q.toggleNight(), true);
    await Q.add(일감(c, a), "2020-01-01T00:00:00", say);
    let 불림 = 0;
    const 올리기 = async () => { 불림++; return "V" + 불림; };
    같나("자정~7시에는 쏘지 않는다", await Q.fire({ say, now: wall(2026, 10, 20, 3, 0), uploader: 올리기 }), 0);
    같나("그때 큐는 그대로", Q.list().length, 1);
    await Q.toggleNight(); // 허용
    같나("심야 허용이면 새벽에도 쏜다", await Q.fire({ say, now: wall(2026, 10, 20, 3, 0), uploader: 올리기 }), 1);
    같나("쏜 것은 큐에서 빠진다", Q.list().length, 0);
    같나("쏜 파일은 채널 폴더의 업로드완료 로 옮겨진다", [await 있나(a), await 있나(`${c.folder}/업로드완료/a.mp4`)], [false, true]);
    await Q.toggleNight(); // 다시 금지
    await Q.add(일감(c, b), "2020-01-01T00:00:00", say);
    await setLocked(true);
    같나("잠겨 있으면 아무것도 안 쏜다", await Q.fire({ say, now: wall(2026, 10, 20, 12, 0), uploader: 올리기 }), 0);
    await setLocked(false);
    // 동시에 둘이 쏘려 하면 하나만
    let 풀기!: () => void;
    const 기다림 = new Promise<void>((r) => { 풀기 = r; });
    const 느린 = async () => { await 기다림; return "VSLOW"; };
    const 첫째 = Q.fire({ say, now: wall(2026, 10, 20, 12, 0), uploader: 느린 });
    await new Promise((r) => setTimeout(r, 50));
    같나("다른 전송이 진행 중이면 기다리지 않고 0 (같은 영상을 동시에 안 올린다)", await Q.fire({ say, now: wall(2026, 10, 20, 12, 0), uploader: 느린 }), 0);
    풀기();
    같나("첫째는 끝까지 쏜다", await 첫째, 1);

    구역("발사대기 — 한도 · 실패 · 사라진 파일");
    for (const n of ["x1.mp4", "x2.mp4", "x3.mp4"]) await Q.add(일감(c, await 영상두기(c.folder, n), { publish_at: "2026-10-20 09:00" }), "2020-01-01T00:00:00", say);
    let 호출 = 0;
    const 한도 = async () => { 호출++; throw new GoogleError("429 quotaExceeded", 429, "quotaExceeded"); };
    같나("한도에 걸리면 하나만 두드리고 멈춘다", [await Q.fire({ say, now: wall(2026, 10, 20, 12, 0), uploader: 한도 }), 호출], [0, 1]);
    const 다음 = Q.nextReset();
    같나("남은 것 전부가 다음 초기화 뒤로 밀린다", Q.list().every((x) => String(x.쏠때) >= 다음), true);
    같나("공개 예약도 하루씩 밀려 올리기+1시간 뒤가 된다", Q.list().every((x) => String(x.publish_at) >= minuteWall(new Date(new Date(다음 + "Z").getTime() + 3600_000))), true);
    같나("한도미룸이 올리기.log 에 남는다", (await 로그("올리기.log")).includes("한도미룸"), true);
    for (const x of Q.list()) await Q.remove(x.file);

    for (const n of ["y1.mp4", "y2.mp4"]) await Q.add(일감(c, await 영상두기(c.folder, n)), "2020-01-01T00:00:00", say);
    let 부름 = 0;
    const 실패 = async (j: Job) => { 부름++; if (baseOf(j.file) === "y1.mp4") throw new Error("그냥 실패\n둘째 줄"); return "Y2"; };
    같나("한 건이 실패해도 나머지는 계속 쏜다", [await Q.fire({ say, now: wall(2026, 10, 20, 12, 0), uploader: 실패 }), 부름], [1, 2]);
    같나("실패한 것은 큐에 남아 다음 차례에 다시", Q.list().map((x) => baseOf(x.file)), ["y1.mp4"]);
    같나("발사실패가 올리기.log 에 남는다", (await 로그("올리기.log")).includes("발사실패 [채널A] y1.mp4  그냥 실패"), true);
    await Q.remove(Q.list()[0].file);

    const z = await 영상두기(c.folder, "z.mp4");
    await Q.add(일감(c, z), "2020-01-01T00:00:00", say);
    await Deno.remove(z);
    같나("파일이 사라졌으면 큐에서 뺀다", [await Q.fire({ say, now: wall(2026, 10, 20, 12, 0), uploader: 올리기 }), Q.list().length], [0, 0]);
    같나("발사무산이 올리기.log 에 남는다(브리핑이 읽는다)", (await 로그("올리기.log")).includes("발사무산 [채널A] z.mp4"), true);

    // 외장이 안 붙어 있으면 큐를 지킨다
    const 외장 = `${dir}/없는외장`;
    await writeJson(dataPath("경로설정.json"), { 외장뿌리: 외장 });
    await Deno.mkdir(`${외장}/영상`, { recursive: true });
    await 영상두기(`${외장}/영상`, "w.mp4");
    await Q.add(일감(c, `${외장}/영상/w.mp4`), "2020-01-01T00:00:00", say);
    await Deno.remove(외장, { recursive: true }); // 외장을 뽑았다
    같나("외장이 통째로 안 붙었으면 큐를 지킨다(못 보는 것이지 없는 게 아니다)", [await Q.fire({ say, now: wall(2026, 10, 20, 12, 0), uploader: 올리기 }), Q.list().length], [0, 1]);
    같나("그 영상을 모르는 큐 줄은 사람이 뺄 수 있다", await Q.remove(`${외장}/영상/w.mp4`), true);

    구역("발사대기 — 진짜 올리기 한 바퀴 (가짜 구글)");
    const e = await 영상두기(c.folder, "끝까지.mp4", { txt: "[제목]\n끝까지 가는 영상\n" });
    await Q.add(일감(c, e, { publish_at: "2099-01-01 09:00" }), "2020-01-01T00:00:00", say);
    같나("쏘면 올라가고 큐가 빈다", [await Q.fire({ say, now: wall(2026, 10, 20, 12, 0) }), Q.list().length], [1, 0]);
    참인가("장부·심사 대기에 올랐다", readLedger().some((r) => r["제목"] === "끝까지 가는 영상") && R.loadPending().some((x) => x.title === "끝까지 가는 영상"));
    같나("올리기.log 에 발사가 남는다", (await 로그("올리기.log")).includes("발사   [채널A] 끝까지.mp4"), true);
    같나("끝난 파일은 업로드완료 로", await 있나(`${c.folder}/업로드완료/끝까지.mp4`), true);
    같나("곁글도 같이 옮겨진다", await 있나(`${c.folder}/업로드완료/끝까지.txt`), true);
  });

  구역("발사대기 — 채널의 하루 편수 한도가 담을 때 적용된다 (일 한도 편성기)");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글(); fake.instantProcessing = true;
    const c = await 채널준비(dir, fake, { name: "채널A" });
    await writePolicy({ channel_id: c.id, label: "시험", daily_limit: 2, cap_uploads: true, day_start_hour: 7, overflow_day_start_hour: 9, publish_gap_minutes: 120 } as never);
    const 날 = (t: Obj) => String(t.쏠때).slice(0, 10);
    const base = wallNow();
    const ymd = (d: Date, add = 0) => { const t = new Date(d.getTime() + add * 86_400_000); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`; };
    for (const n of ["p1", "p2", "p3"]) {
      await Q.add(일감(c, await 영상두기(c.folder, n + ".mp4"), { channel: c.id, publish_at: `${ymd(base, 1)} 0${["8", "9", "9"][["p1", "p2", "p3"].indexOf(n)]}:00` }), `${ymd(base)}T10:00:00`, say);
    }
    const days = new Set(Q.list().map(날));
    참인가("하루 2편을 넘는 것은 다음 날로 밀린다(한 날에 모두 몰리지 않는다)", days.size >= 2);
  });
}

const baseOf = (p: unknown) => String(p).split("/").pop();
const 있나 = (p: string) => Deno.stat(p).then(() => true, () => false);
void isoWall; void appendLedger; void ExitBlocked;

if (import.meta.main) {
  const { 결과 } = await import("./도구.ts");
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

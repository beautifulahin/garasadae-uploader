// 받기 시험 — 승인한 영상을 채널 폴더로 복사하고 발사대기에 담는다. 쇼츠/롱폼을 실제 파일로 가르고 공개 시각을 꼴별로 따로 센다.
import { 같나, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 영상두기, 채널준비 } from "./바탕.ts";
import * as Q from "../app/queue.ts";
import * as R from "../app/review.ts";
import { findChannel, lastReservation, nextSlot, receive, sameChannelKeys, shrinkImage, sideText } from "../app/receive.ts";
import { appendLedger } from "../app/ledger.ts";
import { editChannels } from "../app/channels.ts";
import { systemZone, wall, wallToInstant } from "../app/clock.ts";
import { forceToolMissing } from "../app/tools.ts";
import { writeJson, dataPath } from "../app/paths.ts";

type Obj = Record<string, any>;
const 시계 = (y: number, m: number, d: number, h: number, mi = 0) => wallToInstant(wall(y, m, d, h, mi), systemZone());
const 없음 = async () => "";
const 있나 = (p: string) => Deno.stat(p).then(() => true, () => false);
const 큐 = (name: string) => Q.list().find((x) => String(x.file).endsWith("/" + name))!;

export async function 실행() {
  구역("채널 찾기·같은 유튜브 채널의 두 칸");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    const c = await 채널준비(dir, fake, { name: "채널A" });
    await editChannels((d) => { d["채널A 롱폼"] = { ...d["채널A"], folder: `${dir}/영상/채널A 롱폼` }; });
    같나("이름으로 찾는다", findChannel("채널A")[0], "채널A");
    같나("채널 id 로도 찾는다", findChannel(c.id)[0], "채널A");
    await 던지나("모르는 채널은 쓸 수 있는 이름을 알려 준다", async () => findChannel("없는채널"), /쓸 수 있는 것: 채널A, 채널A 롱폼/);
    같나("같은 channel_id 를 가진 칸 이름이 모두 나온다(쇼츠용·롱폼용)", [...sameChannelKeys("채널A")].sort(), ["채널A", "채널A 롱폼"]);
  });

  구역("받기 — 쇼츠: 복사 · 곁글 · 마지막 예약 + 2시간");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    const c = await 채널준비(dir, fake, { name: "채널A" });
    const 원본 = `${dir}/승인본`;
    const s1 = await 영상두기(원본, "쇼츠1.mp4", { txt: "[제목]\n첫 쇼츠\n\n[설명]\n이 영상은 시험용이다\n\n[해시태그]\n#가 #나\n" });
    const s2 = await 영상두기(원본, "쇼츠2.mp4");
    const clock = 시계(2026, 10, 20, 12, 0);
    const r1 = await receive("채널A", s1, { clock, youtubeHas: 없음, say: () => {}, who: "시험 승인" });
    같나("쇼츠로 판정", r1.long, false);
    같나("원본은 그대로 두고 복사한다", [await 있나(s1), await 있나(r1.dst)], [true, true]);
    같나("채널 폴더에 곁글이 쓰인다", (await Deno.readTextFile(r1.dst.replace(/\.mp4$/, ".txt"))).startsWith("[제목]\n첫 쇼츠\n\n[설명]\n이 영상은 시험용이다"), true);
    같나("마지막 예약이 없으면 지금 + 50분", r1.publishAt, "2026-10-20 12:50");
    같나("올리기는 공개 24시간 전(늦어도 지금)", r1.fireAt, "2026-10-20T12:00:00");
    const j = 큐("쇼츠1.mp4");
    같나("발사대기 일감: 채널 id · 쇼츠 · 승인 표시", [j.channel, j.allow_not_short, j.time_by, String(j._승인).startsWith("시험 승인 (")], [c.id, false, "user", true]);
    같나("태그는 해시태그에서(# 뗌)", j.tags, ["가", "나"]);
    const r2 = await receive("채널A", s2, { clock, youtubeHas: 없음, say: () => {} });
    같나("두 번째 쇼츠는 마지막 예약 + 2시간", r2.publishAt, "2026-10-20 14:50");
    await 던지나("같은 편이 아직 발사대기에 있으면 두 번 담지 않는다", () => receive("채널A", s1, { clock, youtubeHas: 없음, say: () => {} }), /이미 발사대기에 있다/);

    구역("받기 — 0~7시 칸은 07:00 으로 민다 · 사람이 정한 공개 시각");
    const s3 = await 영상두기(원본, "새벽.mp4");
    const r3 = await receive("채널A", s3, { clock: 시계(2026, 10, 25, 2, 0), youtubeHas: 없음, say: () => {} });
    같나("새벽에 받으면 공개는 아침 7시", r3.publishAt, "2026-10-25 07:00");
    const s4 = await 영상두기(원본, "정한시각.mp4");
    const r4 = await receive("채널A", s4, { clock: 시계(2026, 10, 27, 12, 0), publishAt: "2026-10-30 09:00", youtubeHas: 없음, say: () => {} });
    같나("사람이 정한 공개 시각(45분 넘게 앞)은 그대로", [r4.publishAt, r4.fireAt], ["2026-10-30 09:00", "2026-10-29T09:00:00"]);
    const s5 = await 영상두기(원본, "곧.mp4");
    const r5 = await receive("채널A", s5, { clock: 시계(2026, 11, 2, 12, 0), publishAt: "2026-11-02 12:30", youtubeHas: 없음, say: () => {} });
    같나("45분 안쪽의 시각은 무시하고 셈한다", r5.publishAt !== "2026-11-02 12:30", true);

    구역("받기 — 쪽지(json) 가 곁글보다 앞선다");
    const s6 = await 영상두기(원본, "쪽지.mp4", { txt: "[제목]\n곁글 제목\n" });
    await writeJson(`${원본}/쪽지.json`, { title: "쪽지 제목", description: "쪽지 설명", publishAt: "2026-12-05 09:00", tags: ["비공개1", "비공개2"] });
    const r6 = await receive("채널A", s6, { clock: 시계(2026, 12, 1, 12, 0), youtubeHas: 없음, say: () => {} });
    같나("쪽지의 제목·설명이 곁글로 간다", (await Deno.readTextFile(r6.dst.replace(/\.mp4$/, ".txt"))).includes("[제목]\n쪽지 제목\n\n[설명]\n쪽지 설명"), true);
    같나("쪽지의 publishAt 을 쓴다", r6.publishAt, "2026-12-05 09:00");
    const s7 = await 영상두기(원본, "쪽지지정.mp4");
    await writeJson(`${dir}/다른쪽지.json`, { title: "지정한 쪽지" });
    const r7 = await receive("채널A", s7, { clock: 시계(2026, 12, 1, 12, 0), note: `${dir}/다른쪽지.json`, youtubeHas: 없음, say: () => {} });
    같나("쪽지를 따로 지정할 수 있다", (await Deno.readTextFile(r7.dst.replace(/\.mp4$/, ".txt"))).includes("[제목]\n지정한 쪽지"), true);
    await 던지나("지정한 쪽지를 못 읽으면 넘기지 않는다", () => receive("채널A", s7, { clock, note: `${dir}/없는쪽지.json`, youtubeHas: 없음, say: () => {} }), /쪽지를 읽지 못했습니다|이미 발사대기/);

    구역("받기 — 중복은 넘기지 않는다");
    const s8 = await 영상두기(원본, "이미올림.mp4");
    await appendLedger({ 업로드시각: "2026-10-01T10:00:00", 채널: "채널A", 영상ID: "OLD1", 제목: "옛 제목 하나", 파일: "/어딘가/이미올림.mp4" });
    await 던지나("장부에 같은 파일 이름이 있으면", () => receive("채널A", s8, { clock, youtubeHas: 없음, say: () => {} }), /같은 파일이 이미 올라갔다 — https:\/\/youtu\.be\/OLD1/);
    const s9 = await 영상두기(원본, "다른이름.mp4", { txt: "[제목]\n옛 제목 하나\n" });
    await 던지나("장부에 같은 제목이 있으면", () => receive("채널A", s9, { clock, youtubeHas: 없음, say: () => {} }), /같은 제목이 이미 올라갔다/);
    const s10 = await 영상두기(원본, "유튜브에있음.mp4", { txt: "[제목]\n유튜브에만 있는 제목\n" });
    await 던지나("유튜브에 같은 제목이 이미 있으면(다른 프로그램으로 올린 것까지)", () => receive("채널A", s10, { clock, youtubeHas: async () => "유튜브에 이미 있다 — 「유튜브에만 있는 제목」 https://youtu.be/ZZ", say: () => {} }), /유튜브에 이미 있다/);

    구역("받기 — 바로 올리기(--즉시)");
    const s11 = await 영상두기(원본, "즉시.mp4");
    const 쏜 = [] as string[];
    const r11 = await receive("채널A", s11, { clock: 시계(2027, 1, 10, 12, 0), now: true, youtubeHas: 없음, say: () => {}, fireNow: async (f) => { 쏜.push(f); return 1; } });
    같나("올리기 시각이 지금이 되고 그 영상만 바로 쏜다(공개 예약은 유지)", [r11.fireAt, 쏜, r11.publishAt !== r11.fireAt], ["2027-01-10T12:00:00", [r11.dst], true]);
  });

  구역("받기 — 롱폼: 칸 · 맞춤 썸네일 · 쇼츠 셈에 안 섞인다");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    await 채널준비(dir, fake, { name: "채널A", conf: { long_slots: ["09:15", "15:15"] } });
    const 원본 = `${dir}/승인본`;
    const clock = 시계(2026, 10, 20, 12, 0);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 5, 0, 0, 0, 2, 208, 8, 2, 0, 0, 0]);
    const l1 = await 영상두기(원본, "롱1.mp4", { long: true });
    await Deno.writeFile(`${원본}/롱1_썸네일.png`, png);
    const a = await receive("채널A", l1, { clock, youtubeHas: 없음, say: () => {} });
    같나("가로 400초는 롱폼 — 쇼츠 조건을 재지 않는다", [a.long, 큐("롱1.mp4").allow_not_short, 큐("롱1.mp4").롱폼], [true, true, true]);
    같나("지금+3시간 뒤의 첫 칸(15:00 이후 → 15:15)", a.publishAt, "2026-10-20 15:15");
    같나("영상 옆 「썸네일」 그림을 같은 이름 그림으로 복사한다", [a.thumb?.endsWith("/롱1.png"), await 있나(a.thumb ?? "")], [true, true]);
    const l2 = await 영상두기(원본, "롱2.mp4", { long: true });
    const b = await receive("채널A", l2, { clock, youtubeHas: 없음, say: () => {} });
    같나("롱폼 마지막 예약 다음 칸(다음 날 09:15)", b.publishAt, "2026-10-21 09:15");
    같나("롱폼은 하루 칸을 채운다 — 세 번째는 15:15", (await receive("채널A", await 영상두기(원본, "롱3.mp4", { long: true }), { clock, youtubeHas: 없음, say: () => {} })).publishAt, "2026-10-21 15:15");
    // 쇼츠는 롱폼 예약에 밀리지 않는다
    const s1 = await receive("채널A", await 영상두기(원본, "쇼1.mp4"), { clock, youtubeHas: 없음, say: () => {} });
    같나("쇼츠는 롱폼 예약 뒤로 밀리지 않는다(꼴별로 센다)", s1.publishAt, "2026-10-20 12:50");
    같나("lastReservation 도 꼴별", [(await lastReservation("채널A", true))?.toISOString().slice(0, 16), (await lastReservation("채널A", false))?.toISOString().slice(0, 16)], ["2026-10-21T15:15", "2026-10-20T12:50"]);
    // 이미 담긴 롱폼은 칸은 그대로, 파일만 새것으로
    await Deno.writeFile(l1, new Uint8Array(await Deno.readFile(l1)).slice(0, 2000)); // 크기가 다른 새 판 — 크기만 달라지면 된다
    const again = await 영상두기(원본, "롱1.mp4", { long: true, mb: 1 });
    const c2 = await receive("채널A", again, { clock, youtubeHas: 없음, say: () => {} });
    같나("이미 발사대기에 있는 롱폼은 칸을 그대로 두고 파일만 새것으로", [c2.replaced, c2.publishAt, (await Deno.stat(c2.dst)).size > 1_000_000], [true, "2026-10-20 15:15", true]);
    같나("그래도 큐에는 한 줄", Q.list().filter((x) => String(x.file).endsWith("/롱1.mp4")).length, 1);
    // 칸 계산 단독
    같나("칸 계산은 롱폼 마지막 예약(10-21 15:15) 뒤로 간다", (await nextSlot("채널A", ["09:15"], wall(2026, 10, 20, 8, 0))).toISOString().slice(0, 16), "2026-10-22T09:15");
    await 던지나("칸 글이 이상하면", () => nextSlot("채널A", ["아침"], wall(2026, 10, 20, 8, 0)), /칸 시각을 읽지 못했습니다/);
    await 던지나("칸이 비었으면", () => nextSlot("채널A", [], wall(2026, 10, 20, 8, 0)), /롱폼 칸이 비었습니다/);
  });

  구역("받기 — 장부·심사 대기에 있는 예약도 센다 (이미 쏜 것은 큐에서 빠지므로)");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    const c = await 채널준비(dir, fake, { name: "채널A" });
    const 원본 = `${dir}/승인본`;
    const clock = 시계(2026, 10, 20, 12, 0);
    // 장부: 이미 올라간 쇼츠의 예약시각, 롱폼의 예약시각(쇼츠에 영향 없음)
    await appendLedger({ 업로드시각: "2026-10-19T10:00:00", 채널: "채널A", 영상ID: "S0", 제목: "앞 쇼츠", 파일: "/s0.mp4", 길이초: "40.0", 해상도: "1080x1920", 예약시각: "2026-10-25 09:00" });
    await appendLedger({ 업로드시각: "2026-10-19T10:00:00", 채널: "채널A", 영상ID: "L0", 제목: "앞 롱폼", 파일: "/l0.mp4", 길이초: "900.0", 해상도: "1920x1080", 예약시각: "2026-11-30 09:00" });
    const r1 = await receive("채널A", await 영상두기(원본, "다음쇼츠.mp4"), { clock, youtubeHas: 없음, say: () => {} });
    같나("장부의 마지막 쇼츠 예약 + 2시간 (롱폼 예약은 안 센다)", r1.publishAt, "2026-10-25 11:00");
    // 심사 대기의 예약은 UTC 로 저장돼 있다 — 이 컴퓨터 시각으로 바꿔 센다
    await R.updatePending((items) => { items.push({ channel: "채널A", video_id: "P1", title: "심사 중", publish_at: "2026-10-26T01:00:00Z", uploaded: "2026-10-20T11:00:00", 확인수: 0, 사람확인: false, 시각정한이: "user" }); return items; });
    const r2 = await receive("채널A", await 영상두기(원본, "그다음쇼츠.mp4"), { clock, youtubeHas: 없음, say: () => {} });
    같나("심사 대기의 UTC 예약(한국 10:00)도 센다", r2.publishAt, "2026-10-26 12:00");
    void c;
  });

  구역("받기 — 문안 규격(채널 설정)과 오류");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    await 채널준비(dir, fake, { name: "해외", conf: { meta_rule: { forbid_hangul: true } } });
    await 채널준비(dir, fake, { name: "폴더없음", c: "z", conf: { folder: "" } });
    const 원본 = `${dir}/승인본`;
    const clock = 시계(2026, 10, 20, 12, 0);
    const k = await 영상두기(원본, "한글.mp4", { txt: "[제목]\n한글 제목\n\n[설명]\n한글 설명\n" });
    await 던지나("문안 규격에 걸리면 복사·담기 전에 넘기지 않는다", () => receive("해외", k, { clock, youtubeHas: 없음, say: () => {} }), /문안 규격 미달/);
    같나("그때 채널 폴더에도 큐에도 아무것도 안 생긴다", [Q.list().length, await 있나(`${dir}/영상/해외/한글.mp4`)], [0, false]);
    await 던지나("폴더가 정해지지 않은 채널", () => receive("폴더없음", k, { clock, youtubeHas: 없음, say: () => {} }), /폴더가 아직 없습니다/);
    await 던지나("영상이 없으면", () => receive("해외", `${원본}/없음.mp4`, { clock, youtubeHas: 없음, say: () => {} }), /영상이 없다/);
    같나("곁글 꼴", sideText("제목", "설명", ["#a", "#b"]), "[제목]\n제목\n\n[설명]\n설명\n\n[해시태그]\n#a #b\n");
    // 그림 줄이기 — 줄일 도구가 하나도 없으면 분명히 말한다 (맥의 sips 는 항상 있으므로 그림이 아닌 글로 실패를 만든다)
    forceToolMissing("ffmpeg");
    같나("그림이 아닌 파일은 줄이지 못한다", await shrinkImage(`${dir}/그림아님.png`, `${dir}/out.jpg`), false);
  });
  void 참인가; void dataPath;
}

if (import.meta.main) {
  const { 결과 } = await import("./도구.ts");
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

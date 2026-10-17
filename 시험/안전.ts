// 안전장치 시험 — 올리기 입구(표)·출구검사·공개검사·수동 비공개·공개 간격. 구글에는 한 번도 닿지 않는다.
import { 같나, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 분뒤, 영상두기, 채널준비 } from "./바탕.ts";
import {
  allowUpload, exitGate, ExitBlocked, fingerprint, giveTicket, isLocked, manualPrivateAdd, manualPrivateHas, manualPrivateList,
  manualPrivateRemove, publishGate, PublishBlocked, Refusal, resetSafetyCache, setLocked, setSafetyClock, whyNotHuman,
} from "../app/safety.ts";
import { appendLedger } from "../app/ledger.ts";
import { editChannels } from "../app/channels.ts";
import { dataPath } from "../app/paths.ts";

const H = (o: Record<string, string>) => new Headers(o);

export async function 실행() {
  구역("올리기 입구 — 표 한 장은 한 번만");
  await 모래상자(async () => {
    let 초 = 1000;
    setSafetyClock(() => 초);
    const f = ["/a/1.mp4", "/a/2.mp4"];
    같나("지문은 순서와 무관", fingerprint(["/b", "/a"]), fingerprint(["/a", "/b"]));
    같나("지문은 24자", fingerprint(f).length, 24);
    await 던지나("표 없이는 거절", () => allowUpload("", f), /표가 없습니다/);
    const t1 = giveTicket(f);
    await allowUpload(t1, f, H({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }));
    참인가("처음 한 번은 통과", true);
    await 던지나("같은 표를 또 쓰면 거절(새로고침·뒤로가기)", () => allowUpload(t1, f), /이미 쓴 요청/);
    // 90초 안에 같은 묶음
    초 += 30;
    const t2 = giveTicket(f);
    await 던지나("같은 묶음을 90초 안에 또 올리면 손이 미끄러진 것으로 본다", () => allowUpload(t2, f), /두 번 눌린/);
    초 += 100;
    const t3 = giveTicket(f);
    await allowUpload(t3, f);
    참인가("90초가 지나면 다시 통과", true);
    // 표 만료 / 묶음 바뀜
    const t4 = giveTicket(["/x.mp4"]);
    초 += 121;
    await 던지나("표는 2분이 지나면 만료", () => allowUpload(t4, ["/x.mp4"]), /이미 쓴 요청|시간이 지났/);
    const t5 = giveTicket(["/y.mp4"]);
    await 던지나("고른 영상이 바뀌면 거절", () => allowUpload(t5, ["/z.mp4"]), /고른 영상이 바뀌었/);
    // 20개 넘음
    const many = Array.from({ length: 21 }, (_, i) => `/m/${i}.mp4`);
    await 던지나("한 번에 20개 넘으면 거절", () => allowUpload(giveTicket(many), many), /너무 많습니다/);
    초 += 200;
    await allowUpload(giveTicket(many), many, null, { many: true });
    참인가("한 번 더 확인받으면(many) 통과", true);
    // 사람이 누른 요청인가
    같나("미리 읽기는 거절", whyNotHuman(H({ "sec-purpose": "prefetch" })), "브라우저가 미리 읽는 요청입니다");
    같나("다른 사이트에서 부르면 거절", whyNotHuman(H({ "sec-fetch-site": "cross-site" })).startsWith("다른 곳에서"), true);
    같나("주소창·북마크로 들어오면 거절", whyNotHuman(H({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" })).startsWith("주소창"), true);
    같나("자원으로 부르면 거절", whyNotHuman(H({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" })).startsWith("페이지가 자원으로"), true);
    같나("헤더가 없으면(옛 브라우저) 표에 맡긴다", whyNotHuman(H({})), "");
    // 잠금
    같나("처음엔 잠겨 있지 않다", isLocked(), false);
    await setLocked(true);
    같나("잠그면 잠김", isLocked(), true);
    초 += 500;
    await 던지나("잠겨 있으면 표가 있어도 거절", () => allowUpload(giveTicket(["/q.mp4"]), ["/q.mp4"]), /잠겨 있습니다/);
    await setLocked(false);
    같나("풀면 풀림", isLocked(), false);
    같나("올리기감시.log 에 남는다", (await Deno.readTextFile(dataPath("기록", "올리기감시.log"))).includes("잠금 켜짐"), true);
    setSafetyClock(null);
  });

  구역("출구검사 — 업로드 직전 마지막 문턱");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    const c = await 채널준비(dir, fake, { name: "채널A" });
    const v = await 영상두기(c.folder, "영상1.mp4");
    const job = (extra: Record<string, unknown> = {}) => ({ channel: "채널A", file: v, _승인: "사람 승인", ...extra });
    resetSafetyCache();
    await exitGate(job(), v);
    참인가("모든 조건이 맞으면 통과", true);
    await 던지나("사람 승인 표시가 없으면 막는다", () => exitGate(job({ _승인: "" }), v), /사람 승인 표시가 없습니다/);
    await setLocked(true);
    await 던지나("잠겨 있으면 막는다", () => exitGate(job(), v), /잠겨 있습니다/);
    await setLocked(false);
    await 던지나("파일이 없으면 막는다", () => exitGate(job({ file: `${c.folder}/없음.mp4` }), `${c.folder}/없음.mp4`), /사라졌습니다/);
    // 다른 채널 폴더의 파일
    const other = `${dir}/딴곳/영상1.mp4`;
    await 영상두기(`${dir}/딴곳`, "영상1.mp4");
    await 던지나("그 채널 폴더의 파일이 아니면 막는다(고객 뒤바뀜)", () => exitGate(job({ file: other }), other), /폴더의 것이 아닙니다/);
    await 던지나("일감의 채널이 별칭이 아니라 채널 ID 여도 폴더 짝을 건너뛰지 않는다", () => exitGate(job({ channel: c.id, file: other }), other), /폴더의 것이 아닙니다/);
    // 원장에 이미 있는 파일 이름
    await appendLedger({ 업로드시각: "2026-10-01T10:00:00", 채널: "채널A", 영상ID: "OLD1", 제목: "옛", 파일: "/아주/다른/자리/영상1.mp4" });
    resetSafetyCache();
    await 던지나("원장에 같은 파일 이름이 있으면 막는다(어느 폴더에서 왔든)", () => exitGate(job(), v), /이미 올린 파일입니다/);
    // 문안 규격(meta_rule) — 채널 설정이 있을 때만
    const v2 = await 영상두기(c.folder, "영상2.mp4", { txt: "[제목]\n한글 제목\n\n[설명]\n한글 설명\n\n[해시태그]\n#a #b\n" });
    await editChannels((d) => { d["채널A"].meta_rule = { forbid_hangul: true }; });
    resetSafetyCache();
    await 던지나("문안 규격이 있고 한글이 섞이면 막는다", () => exitGate(job({ file: v2 }), v2), /문안 규격 미달/);
    const v3 = await 영상두기(c.folder, "영상3.mp4");
    await 던지나("문안 규격이 있는데 곁글이 없으면 막는다", () => exitGate(job({ file: v3 }), v3), /곁파일\(\.txt\) 없음/);
    await editChannels((d) => { delete d["채널A"].meta_rule; });
    await exitGate(job({ file: v3 }), v3);
    참인가("규격이 없으면 곁글이 없어도 통과", true);
    // 원장을 못 읽으면 막는다 (모르면 막는다)
    await Deno.writeTextFile(dataPath("ledger.csv"), "업로드시각,채널\n\"깨짐"); // 닫히지 않은 따옴표
    resetSafetyCache();
    // 닫히지 않은 따옴표는 읽히긴 한다 — 원장 자리를 폴더로 바꿔 읽기 오류를 만든다
    await Deno.remove(dataPath("ledger.csv"));
    await Deno.mkdir(dataPath("ledger.csv"));
    resetSafetyCache();
    await 던지나("원장을 못 읽으면 중복을 알 수 없어 막는다", () => exitGate(job({ file: v3 }), v3), /원장을 읽지 못해/);
    await Deno.remove(dataPath("ledger.csv"));
    resetSafetyCache();
  });

  구역("공개검사 — 누가 시켰나·잠금·검토·사람이 내린 영상·공개 간격");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    await 채널준비(dir, fake, { name: "채널A" });
    const it = { channel: "채널A", title: "영상", video_id: "V1", 확인수: 1 };
    await 던지나("누가 시켰는지 밝히지 않으면 막는다", () => publishGate("", it), /누가 공개를 시켰는지/);
    await 던지나("엉뚱한 이름도 막는다", () => publishGate("점검", it), /누가 공개를 시켰는지/);
    await publishGate("예약작업", it);
    await publishGate("사람", it);
    참인가("예약작업·사람은 통과", true);
    await 던지나("검토를 안 했으면(확인수 0) 막는다", () => publishGate("예약작업", { ...it, 확인수: 0 }), /아직 검토하지 않았습니다/);
    await setLocked(true);
    await 던지나("잠겨 있으면 공개도 멈춘다", () => publishGate("예약작업", it), /잠겨 있어 공개도 멈춥니다/);
    await setLocked(false);
    // 사람이 내린 영상
    await manualPrivateAdd("V1", "채널A", "영상");
    같나("명단에 올랐다", manualPrivateHas("V1"), true);
    같나("같은 것을 또 올려도 한 줄", (await manualPrivateAdd("V1"), manualPrivateList().length), 1);
    await 던지나("사람이 내린 영상은 무엇이 시켜도 다시 공개하지 않는다", () => publishGate("사람", it), /사람이 비공개로 내린 영상/);
    같나("사람이 풀면 풀린다", await manualPrivateRemove("V1"), true);
    같나("없는 것을 풀면 false", await manualPrivateRemove("V1"), false);
    await publishGate("사람", it);
    // 공개 간격 2시간 — 쇼츠는 쇼츠끼리, 롱폼은 롱폼끼리
    const now = new Date();
    const p = (x: number) => String(x).padStart(2, "0");
    const wallStr = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    await appendLedger({
      업로드시각: wallStr(now), 채널: "채널A", 영상ID: "S1", 제목: "쇼츠", 파일: "/s1.mp4", 길이초: "40.0", 해상도: "1080x1920",
      공개시각: wallStr(new Date(now.getTime() - 30 * 60_000)),
    });
    await 던지나("같은 꼴(쇼츠)이 30분 전에 공개됐으면 간격 2시간 미달", () => publishGate("사람", { ...it, video_id: "S2" }), /공개 간격 2시간 미달/);
    // 롱폼 영상은 쇼츠 공개와 겹쳐도 된다
    await appendLedger({
      업로드시각: wallStr(now), 채널: "채널A", 영상ID: "L1", 제목: "롱폼", 파일: "/l1.mp4", 길이초: "600.0", 해상도: "1920x1080",
    });
    await publishGate("사람", { ...it, video_id: "L1" });
    참인가("롱폼은 쇼츠 간격에 안 막힌다(꼴별로 잰다)", true);
    // 예약 시각(열릴때) 기준으로 잰다
    const 먼미래 = new Date(now.getTime() + 5 * 3600_000);
    await publishGate("사람", { ...it, video_id: "S3" }, new Date(Date.UTC(먼미래.getFullYear(), 먼미래.getMonth(), 먼미래.getDate(), 먼미래.getHours(), 먼미래.getMinutes())));
    참인가("예약 시각이 간격 밖이면 통과", true);
  });

  void 분뒤;
}

if (import.meta.main) {
  const { 결과 } = await import("./도구.ts");
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

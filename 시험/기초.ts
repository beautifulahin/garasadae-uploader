// 기초 시험 — 시각·원장·계량·종류 판정·영상 판독·문안 읽기.
import { 같나, 구역, 던지나, 모래상자, 영상쓰기, 참인가 } from "./도구.ts";
import {
  addDays, addMinutes, dateOnly, instantToWall, isoWall, minuteWall, nextDayAt, nextQuotaReset, parseWall, quotaDay,
  wall, wallToInstant,
} from "../app/clock.ts";
import { parseCsv, toCsv, appendLedger, readLedger, patchLedger, LEDGER_HEAD } from "../app/ledger.ts";
import * as quota from "../app/quota.ts";
import { classify, infoFromRaw, ledgerRowIsLong, normalizeJob, probe, probeNow, check } from "../app/shorts.ts";
import { parseText, saveFor, loadFor, readSections, splitLines } from "../app/sidecar.ts";
import { probeNative } from "../app/mediaprobe.ts";
import { dataPath } from "../app/paths.ts";
import { 본문만들기, 상태합치기 } from "../app/ytcore.ts";
import { forceToolMissing } from "../app/tools.ts";

export async function 실행() {
  구역("시각 (벽시계)");
  {
    const w = parseWall("2026-10-09T07:00:00")!;
    같나("시간대 없는 글은 적힌 숫자 그대로", isoWall(w), "2026-10-09T07:00:00");
    같나("분 단위 글", minuteWall(parseWall("2026-10-09 07:05")!), "2026-10-09 07:05");
    같나("Z 가 붙으면 정책 시간대의 벽시계로", isoWall(parseWall("2026-10-08T22:00:00Z", "Asia/Seoul")!), "2026-10-09T07:00:00");
    같나("+09:00 도 옮긴다", isoWall(parseWall("2026-10-09T07:00:00+09:00", "Asia/Seoul")!), "2026-10-09T07:00:00");
    같나("없는 날짜(2월 31일)는 못 읽은 것", parseWall("2026-02-31T00:00:00"), null);
    같나("하루 더하기는 서머타임에 안 흔들린다", isoWall(addDays(wall(2026, 3, 8, 12), 1)), "2026-03-09T12:00:00");
    같나("다음 날 7시", isoWall(nextDayAt(wall(2026, 10, 9, 23, 30), 7)), "2026-10-10T07:00:00");
    같나("분 더하기가 자정을 넘는다", isoWall(addMinutes(wall(2026, 10, 9, 23, 50), 20)), "2026-10-10T00:10:00");
    const inst = wallToInstant(wall(2026, 10, 9, 7, 0), "Asia/Seoul");
    같나("벽시계 → 순간 → 벽시계 왕복", isoWall(instantToWall(inst, "Asia/Seoul")), "2026-10-09T07:00:00");
    같나("한국 07:00 은 UTC 전날 22:00", inst.toISOString(), "2026-10-08T22:00:00.000Z");
    같나("태평양 날짜(서머타임 중)", quotaDay(new Date("2026-10-17T06:59:00Z")), "2026-10-16");
    같나("태평양 날짜 (자정을 넘으면 다음 날)", quotaDay(new Date("2026-10-17T07:01:00Z")), "2026-10-17");
    같나("다음 한도 초기화 = 태평양 자정+10분 (한국 16:10)",
      isoWall(nextQuotaReset(new Date("2026-10-17T03:00:00Z"), "Asia/Seoul")), "2026-10-17T16:10:00");
    같나("겨울(PST)에는 17:10", isoWall(nextQuotaReset(new Date("2026-12-17T03:00:00Z"), "Asia/Seoul")), "2026-12-17T17:10:00");
    같나("dateOnly", dateOnly(wall(2026, 1, 2, 3)), "2026-01-02");
  }

  구역("원장 CSV (파이썬 csv 와 같은 꼴)");
  {
    const rows = parseCsv('a,b,c\r\n1,"x,y",3\r\n"q""r","줄\n바꿈",\r\n');
    같나("쉼표·따옴표·줄바꿈 칸을 읽는다", rows, [["a", "b", "c"], ["1", "x,y", "3"], ['q"r', "줄\n바꿈", ""]]);
    같나("쓰면 같은 꼴(\\r\\n)", toCsv(rows), 'a,b,c\r\n1,"x,y",3\r\n"q""r","줄\n바꿈",\r\n');
    같나("BOM 이 있어도 읽는다", parseCsv("﻿x,y\n1,2\n"), [["x", "y"], ["1", "2"]]);
    같나("빈 줄은 거른다", parseCsv("x,y\n\n1,2\n"), [["x", "y"], ["1", "2"]]);
    같나("머리 14칸", LEDGER_HEAD.length, 14);
    await 모래상자(async () => {
      같나("파일이 없으면 빈 목록", readLedger(), []);
      await appendLedger({ 업로드시각: "2026-10-09T07:00:00", 채널: "채널A", 영상ID: "v1", 제목: "첫, 편", 파일: "/a/b.mp4", 길이초: "30.0", 해상도: "1080x1920", 아동용: "False", AI합성: "False", 공개설정: "비공개(검토대기)" });
      await appendLedger({ 업로드시각: "2026-10-09T08:00:00", 채널: "채널A", 영상ID: "v2", 제목: "둘", 파일: "/a/c.mp4" });
      같나("두 줄", readLedger().map((r) => r["영상ID"]), ["v1", "v2"]);
      같나("쉼표가 든 제목이 안 깨진다", readLedger()[0]["제목"], "첫, 편");
      같나("공개시각은 비어 있을 때만 채운다", await patchLedger("v1", { 공개시각: "2026-10-09 08:00", 공개설정: "public" }, ["공개시각"]), true);
      같나("이미 있으면 덮지 않는다", await patchLedger("v1", { 공개시각: "다른 값" }, ["공개시각"]), false);
      같나("공개설정 바뀜", readLedger()[0]["공개설정"], "public");
      같나("공개시각 그대로", readLedger()[0]["공개시각"], "2026-10-09 08:00");
    });
    // 화면 서버와 따로 도는 심사확인이 동시에 원장을 고쳐도 한 줄도 안 잃는다 (읽고 쓰는 사이를 잠금으로 묶었다)
    await 모래상자(async () => {
      await Promise.all(Array.from({ length: 60 }, (_, i) => appendLedger({ 업로드시각: `2026-10-09T07:${String(i).padStart(2, "0")}:00`, 채널: "채널A", 영상ID: `c${i}`, 제목: `동시 ${i}`, 파일: `/a/${i}.mp4` })));
      같나("동시에 60줄을 더해도 60줄이 모두 남는다", readLedger().length, 60);
      같나("겹침 없이 영상 ID 가 모두 다르다", new Set(readLedger().map((r) => r["영상ID"])).size, 60);
      await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => patchLedger(`c${i}`, { 공개설정: "public" })),
        ...Array.from({ length: 20 }, (_, i) => appendLedger({ 업로드시각: "2026-10-10T07:00:00", 채널: "채널B", 영상ID: `d${i}`, 제목: `뒤 ${i}`, 파일: `/b/${i}.mp4` })),
      ]);
      같나("고치기와 더하기가 섞여도 줄도 고침도 안 잃는다", [readLedger().length, readLedger().filter((r) => r["공개설정"] === "public").length], [80, 20]);
    });
  }

  구역("계량 (할당량)");
  {
    같나("주소 → 이름: 목록", quota.nameOf("https://www.googleapis.com/youtube/v3/videos?id=a", "GET"), "videos.list");
    같나("PUT 은 videos.update", quota.nameOf("https://www.googleapis.com/youtube/v3/videos?part=status", "PUT"), "videos.update");
    같나("이어올리기는 videos.insert", quota.nameOf("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable", "POST"), "videos.insert");
    같나("batchGetStats 는 별도 통", quota.nameOf("https://youtube.googleapis.com/youtube/v3/videos:batchGetStats?id=a", "GET"), "videos.batchGetStats");
    같나("분석은 별도 통", quota.nameOf("https://youtubeanalytics.googleapis.com/v2/reports?ids=x", "GET"), "analytics.query");
    같나("썸네일", quota.nameOf("https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=a", "POST"), "thumbnails.set");
    await 모래상자(async () => {
      quota.set추적(false);
      await quota.watch("videos.list", "P1");
      await quota.watch("videos.list", "P1");
      await quota.watch("videos.update", "P2");
      await quota.spend("videos.insert", "P2");
      같나("유닛은 값표대로(읽기 2 + 수정 50)", quota.today().유닛, 52);
      같나("업로드 1건", quota.today().업로드, 1);
      같나("프로젝트별로 따로 센다", quota.todayByProject()["P1"].유닛, 2);
      같나("다른 프로젝트", quota.todayByProject()["P2"].유닛, 50);
      같나("남은 올리기 = (10000-52-2)/2", quota.남은올리기(), 4973);
      같나("프로젝트 몫만 보면", quota.남은올리기("P1"), 4999);
      quota.set추적(true);
      await 던지나("읽기 상한을 넘으면 막는다", async () => {
        for (let i = 0; i < 6100; i++) await quota.spend("videos.list", "BIG");
        await quota.watch("videos.list", "BIG");
      }, /읽기 몫/);
      await quota.watch("videos.update", "BIG"); // 쓰기는 막지 않는다
      참인가("쓰기는 상한에 안 막힌다", true);
    });
  }

  구역("쇼츠/롱폼 판정 (현재 업로더 시험과 같은 기대값)");
  {
    const M = (o: Record<string, unknown> = {}) => ({ w: 1080, h: 1920, sec: 30, mb: 1, codec: "h264", ...o });
    같나("180초 정각은 쇼츠", classify(M({ sec: 180 })), "쇼츠");
    같나("180.001초는 롱폼", classify(M({ sec: 180.001 })), "롱폼");
    같나("정사각형 180초는 쇼츠", classify(M({ w: 1080, h: 1080, sec: 180 })), "쇼츠");
    같나("1080x1440 세로", classify(M({ w: 1080, h: 1440 })), "쇼츠");
    같나("가로 15초는 롱폼", classify(M({ w: 1920, h: 1080, sec: 15 })), "롱폼");
    같나("4648초는 롱폼", classify(M({ sec: 4648.2 })), "롱폼");
    for (const [이름, info] of [["빈 값", {}], ["길이 0", M({ sec: 0 })], ["높이 0", M({ h: 0 })], ["NaN", M({ sec: NaN })],
      ["무한", M({ sec: Infinity })], ["음수 폭", M({ w: -1 })], ["길이 없음", M({ sec: null })]] as const) {
      await 던지나(`잘못된 값은 롱폼으로 안 친다 — ${이름}`, () => classify(info as Record<string, unknown>));
    }
    const 판 = (sar: [number, number]) => infoFromRaw({ w: 1920, h: 1080, sar, rotation: -90, sec: 30, bytes: 1024, codec: "h264" });
    같나("회전 -90 이고 화소비 1:1 이면 세로(쇼츠)", classify(판([1, 1])), "쇼츠");
    같나("회전 -90 이고 화소비 1:2 이면 표시가 가로(롱폼)", classify(판([1, 2])), "롱폼");
    같나("회전 뒤 크기", [판([1, 1]).w, 판([1, 1]).h], [1080, 1920]);
    같나("90도 회전도 같다", infoFromRaw({ w: 1920, h: 1080, sar: [1, 1], rotation: 90, sec: 30, bytes: 1, codec: "x" }).h, 1920);
    같나("180도는 안 바뀐다", infoFromRaw({ w: 1080, h: 1920, sar: [1, 1], rotation: 180, sec: 30, bytes: 1, codec: "x" }).w, 1080);
    같나("원장 줄: 새 정사각형은 쇼츠", ledgerRowIsLong({ 길이초: "60", 해상도: "1080x1080", 업로드시각: "2026-10-08T00:00:00" }), false);
    같나("원장 줄: 2024-10-14 이전 정사각형은 롱폼(과거 분류 보존)", ledgerRowIsLong({ 길이초: "60", 해상도: "1080x1080", 업로드시각: "2024-10-14T00:00:00" }), true);
    같나("원장 줄: 길이·해상도 없으면 쇼츠로(예전 그대로)", ledgerRowIsLong({ 길이초: "", 해상도: "", 업로드시각: "2026-10-08T00:00:00" }), false);
    같나("원장 줄: 4864초 가로", ledgerRowIsLong({ 길이초: "4864.0", 해상도: "1920x1064", 업로드시각: "2026-10-08T00:00:00" }), true);
  }

  구역("영상 판독 (내장 판독기 — ffprobe 없이)");
  await 모래상자(async (dir) => {
    forceToolMissing("ffprobe");
    const p = (n: string) => `${dir}/${n}`;
    await 영상쓰기(p("세로.mp4"), { w: 1080, h: 1920, sec: 40 });
    await 영상쓰기(p("가로긴것.mp4"), { w: 1920, h: 1080, sec: 202 });
    await 영상쓰기(p("회전.mp4"), { w: 1920, h: 1080, sec: 30, rotate: 90 });
    await 영상쓰기(p("화소비.mp4"), { w: 1920, h: 1080, sec: 30, sarH: 2, sarV: 1 });
    await 영상쓰기(p("화소비세로.mp4"), { w: 1920, h: 1080, sec: 30, sarH: 1, sarV: 2 });
    await 영상쓰기(p("정사각.mp4"), { w: 1080, h: 1080, sec: 179.9 });
    const r = await probeNative(p("세로.mp4"));
    같나("세로 크기", [r.w, r.h], [1080, 1920]);
    같나("길이", r.sec, 40);
    같나("코덱", r.codec, "avc1");
    같나("세로 → 쇼츠", (await check(p("세로.mp4"))).kind, "쇼츠");
    같나("가로 202초 → 롱폼", (await check(p("가로긴것.mp4"))).kind, "롱폼");
    같나("회전 90 → 세로로 보여 쇼츠", (await check(p("회전.mp4"))).kind, "쇼츠");
    같나("화소비 2:1 + 가로 → 롱폼", (await check(p("화소비.mp4"))).kind, "롱폼");
    같나("화소비 1:2 이면 표시 크기가 960x1080 이라 쇼츠(파이썬과 같은 식)", (await check(p("화소비세로.mp4"))).kind, "쇼츠");
    같나("정사각 179.9초 → 쇼츠", (await check(p("정사각.mp4"))).kind, "쇼츠");
    같나("check 는 쇼츠가 아니면 사유를 준다", (await check(p("가로긴것.mp4"))).notes.length >= 2, true);
    await Deno.writeFile(p("깨짐.mp4"), new Uint8Array([0, 0, 0, 8, 102, 114, 101, 101]));
    await 던지나("깨진 파일은 오류(롱폼 아님)", () => probe(p("깨짐.mp4")), /moov|트랙|읽지/);
    await Deno.writeFile(p("모름.avi"), new TextEncoder().encode("RIFF....AVI LIST...."));
    await 던지나("모르는 형식은 ffprobe 가 없다고 말한다", () => probe(p("모름.avi")), /ffprobe/);
    const j = await normalizeJob({ file: p("가로긴것.mp4"), _승인: "사람", publish_at: "2026-10-20 09:00", allow_not_short: false, 롱폼: false });
    같나("일감 표시가 실제 파일을 따른다", [j.영상종류, j.롱폼, j.allow_not_short], ["롱폼", true, true]);
    같나("승인·시각은 그대로", [j._승인, j.publish_at], ["사람", "2026-10-20 09:00"]);
    const k = await normalizeJob({ file: p("세로.mp4"), allow_not_short: true, 롱폼: true });
    같나("옛 롱폼 표시도 실제 파일로 바로잡는다", [k.영상종류, k.롱폼], ["쇼츠", false]);
    // 캐시: 같은 파일을 다시 재도 같은 값
    const a1 = await probe(p("세로.mp4")); const a2 = await probe(p("세로.mp4"));
    같나("캐시", a1, a2);
    await (await import("../app/shorts.ts")).saveCache();
    같나("영상정보.json 이 남는다", (await Deno.stat(dataPath("영상정보.json"))).isFile, true);
  });

  구역("문안 읽기·쓰기 (왕복해도 같다)");
  {
    const a = parseText("[제목]\n우산 세 개\n\n[설명]\n여러 줄 설명\n두 번째 줄\n\n[해시태그]\n#우산 #비오는날 #shorts\n");
    같나("제목", a.title, "우산 세 개");
    같나("태그", a.tags, ["우산", "비오는날", "shorts"]);
    같나("설명 끝에 해시태그가 붙는다", a.desc.endsWith("#우산 #비오는날 #shorts"), true);
    const b = parseText("제목: 한 줄 형식\n설명: 짧은 설명\n태그: #가 #나\n");
    같나("제목: 값 형식", [b.title, b.desc.startsWith("짧은 설명"), b.tags], ["한 줄 형식", true, ["가", "나"]]);
    const c = parseText("═══ 제목\n장식 구분선 뒤 제목\n═══ 설명\n본문\n");
    같나("장식 구분선 형식", c.title, "장식 구분선 뒤 제목");
    const d = parseText("항목 이름이 하나도 없는 글\n둘째 줄이 설명\n#태그1 #태그2\n");
    같나("민글: 첫 줄이 제목", d.title, "항목 이름이 하나도 없는 글");
    같나("민글: 본문 해시태그는 태그로도", d.tags, ["태그1", "태그2"]);
    같나("제목 꼬리 (16자) 제거", parseText("[제목]\n벌어진 일  (16자)\n").title, "벌어진 일");
    같나("설명에 이미 있는 태그는 또 안 붙인다", parseText("[설명]\n본문 #가\n[해시태그]\n#가 #나\n").desc.match(/#가/g)?.length, 1);
    같나("조립 과정 줄(1행 …)은 제목이 아니다", parseText("[제목]\n1행 어쩌구\n진짜 제목\n").title, "진짜 제목");
    같나("일본어 해시태그: 「・」에서 끊기고 「#『…』」는 통째로 빠진다(파이썬 해시태그자와 같다)", parseText("[해시태그]\n#中島美嘉・雪の華 #『NANA』\n").tags, ["中島美嘉"]);
    같나("줄 가르기: 끝 빈 줄 하나는 없는 것", splitLines("a\nb\n"), ["a", "b"]);
    같나("곁읽기: 칸 머리", readSections("[제목]\n진짜 이름\n\n[설명]\n내용 하나\n내용 둘\n\n[해시태그]\n#a #b\n"), { title: "진짜 이름", desc: "내용 하나\n내용 둘", tags: ["#a", "#b"] });
    await 모래상자(async (dir) => {
      const v = `${dir}/테스트_영상.mp4`;
      await Deno.writeFile(v, new Uint8Array([1]));
      같나("txt 가 없으면 파일 이름이 제목", (await loadFor(v)).title, "테스트_영상");
      await Deno.writeTextFile(`${dir}/테스트_영상.txt`, "[제목]\n손으로 쓴 제목\n[설명]\n  들여쓴 설명\n  둘째\n[해시태그]\n#태그\n");
      const m0 = await loadFor(v);
      let m = m0;
      for (let i = 0; i < 5; i++) {
        await saveFor(v, m.title, m.desc, m.tags);
        m = await loadFor(v);
      }
      같나("다섯 번 저장해도 제목이 같다", m.title, m0.title);
      같나("다섯 번 저장해도 설명 길이가 같다(들여쓰기 불어남 없음)", m.desc.length, m0.desc.length);
      같나("처음 것은 한 번만 남는다", await Deno.readTextFile(`${dir}/테스트_영상.txt.처음것`), "[제목]\n손으로 쓴 제목\n[설명]\n  들여쓴 설명\n  둘째\n[해시태그]\n#태그\n");
    });
  }

  구역("videos.update 읽고 합쳐 쓰기");
  {
    const 지금 = { privacyStatus: "private", embeddable: true, publicStatsViewable: true, selfDeclaredMadeForKids: false, license: "youtube", publishAt: "2999-01-01T00:00:00Z" };
    같나("공개로 바꿔도 퍼가기·통계 공개가 지워지지 않는다", 상태합치기(지금, { privacyStatus: "public" }),
      { privacyStatus: "public", embeddable: true, publicStatsViewable: true, selfDeclaredMadeForKids: false, license: "youtube" });
    같나("예약을 걸면 비공개+예약 시각", 상태합치기({ ...지금, publishAt: undefined }, { privacyStatus: "private", publishAt: "2999-02-02T00:00:00Z" }).publishAt, "2999-02-02T00:00:00Z");
    같나("다른 칸만 고치면 예약은 그대로", 상태합치기(지금, { embeddable: false }).publishAt, "2999-01-01T00:00:00Z");
    같나("공개로 바꾸면 예약 시각은 싣지 않는다", "publishAt" in 상태합치기(지금, { privacyStatus: "public" }), false);
    await 던지나("부른 쪽이 준 예약이 이미 지났으면 실패로 알린다",
      () => 상태합치기(지금, { privacyStatus: "private", publishAt: "2020-01-01T00:00:00Z" }), /이미 지났/);
    const 몸 = 본문만들기("v1", { status: 지금, snippet: { title: "옛", description: "d", tags: ["a"], categoryId: "22" } }, { privacyStatus: "public" }, { title: "새" });
    같나("부품 이름", 몸.part, "snippet,status");
    같나("머리 합치기: 바꾼 제목 + 나머지 보존", 몸.body.snippet, { title: "새", description: "d", tags: ["a"], categoryId: "22" });
  }
}

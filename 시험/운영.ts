// 운영 보조 시험 — 알림 · 브리핑 · 휴지통 · 보관/백업 · 문안 점검 · 썸네일 · 환경 점검.
//
//   TZ=Asia/Seoul deno run -A --no-lock 시험/운영.ts
//
// 구글·텔레그램에는 한 번도 닿지 않는다: 가짜 서버(가짜구글.ts)와 임시 폴더(도구.ts 모래상자)만 쓴다.
// 휴지통은 임시 폴더로 돌린 리눅스 길과 가짜 실행기로만 시험한다 — 진짜 파인더·PowerShell 은 부르지 않는다.
// 컴퓨터 화면 알림은 오프라인 시험 모드에서 건너뛰므로 진짜 알림이 뜨지 않는다.
import { 같나, 결과, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { APP_ID, dataPath, join, readJson, recordLine, recordPath, withFileLock, writeJson } from "../app/paths.ts";
import { addDays, addMinutes, dateOnly, isoWall, parseWall, wallNow } from "../app/clock.ts";
import { setFetch } from "../app/google.ts";
import { appendLedger } from "../app/ledger.ts";
import { findTool, forceToolMissing, resetToolCache } from "../app/tools.ts";
import { ytFor } from "../app/ytcore.ts";
import {
  alert, canSend, daySummary, desktopNotify, failNotice, launchNotice, publishNotice, saveTelegramConfig, send,
  setTelegramAlerts, telegramConfig, telegramSummary, testSend,
} from "../app/notify.ts";
import { collect, explainUploadFailure } from "../app/briefing.ts";
import { moveToTrashPlain, sendToTrash, sideFiles, TrashError } from "../app/trash.ts";
import { KEEP_FILES, keepToday, listKept, MIRROR_MARK_NAME, mirror } from "../app/archive.ts";
import {
  bodyLength, checkText, cleanForRule, countHangul, fitTags, formatLook, formatLookSummary, HASH_LINE, lookFolder,
} from "../app/metacheck.ts";
import {
  custom, failureReason, findThumb, imageInfo, imageInfoOfBytes, inspectLongforms, loadPending, MAX_ATTEMPTS, pendingPath,
  recordFailure, replaceThumbnail, RETRY_WAIT_MIN, retryPending, setThumbnailFor, THUMB_EXT, THUMB_MAX, ThumbError,
} from "../app/thumbs.ts";
import { formatReport, report } from "../app/envcheck.ts";

const TOKEN = "123456789:AAtest-token_xyz";
const CID = "UC" + "x".repeat(22); // 실제 채널 ID 모양이지만 가짜
const p2 = (n: number) => String(n).padStart(2, "0");
const 줄시각 = (w: Date) => `${dateOnly(w)} ${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())}:${p2(w.getUTCSeconds())}`;
const 잠깐 = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function 환경바꾸고<T>(값: Record<string, string | undefined>, 일: () => Promise<T>): Promise<T> {
  const 앞: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(값)) {
    앞[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
  try {
    return await 일();
  } finally {
    for (const [k, v] of Object.entries(앞)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

async function 읽기(path: string): Promise<string> {
  try { return await Deno.readTextFile(path); } catch { return ""; }
}

async function 파일들(root: string): Promise<string[]> {
  const out: string[] = [];
  async function 걷기(dir: string, rel: string) {
    const es: Deno.DirEntry[] = [];
    try { for await (const e of Deno.readDir(dir)) es.push(e); } catch { return; }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await 걷기(join(dir, e.name), r); else out.push(r.normalize("NFC"));
    }
  }
  await 걷기(root, "");
  return out.sort();
}

/* ============================================================ 그림 바이트를 손으로 짠다 */

function pngHeader(w: number, h: number, cgbi = false): Uint8Array {
  const b: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const 이름 = (s: string) => [...s].map((c) => c.charCodeAt(0));
  if (cgbi) b.push(...u32(4), ...이름("CgBI"), 0, 0, 0, 0, 0, 0, 0, 0);
  b.push(...u32(13), ...이름("IHDR"), ...u32(w), ...u32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0);
  return new Uint8Array(b);
}

function jpegHeader(w: number, h: number, extra = 0): Uint8Array {
  const b: number[] = [0xff, 0xd8];
  b.push(0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0); // APP0(JFIF)
  if (extra) { b.push(0xff, 0xe1, (extra + 2) >> 8, (extra + 2) & 255); for (let i = 0; i < extra; i++) b.push(0); } // 큰 APP1(EXIF)
  b.push(0xff, 0xff); // 표식 앞의 채움 바이트
  b.push(0xff, 0xdb, 0, 67, 0, ...new Array(64).fill(8)); // DQT
  b.push(0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1); // SOF0
  b.push(0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0xff, 0xd9); // SOS … EOI
  return new Uint8Array(b);
}

const 덧붙임 = (a: Uint8Array, 총: number) => { const o = new Uint8Array(Math.max(총, a.length)); o.set(a); return o; };

/** ffmpeg 가 풀 수 있는 진짜 PNG (한 가지 색) */
function crc32(buf: Uint8Array): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function makePng(w: number, h: number, rgb: [number, number, number], 뒤에붙일 = 0): Promise<Uint8Array> {
  const row = new Uint8Array(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = new Uint8Array(row.length * h);
  for (let y = 0; y < h; y++) raw.set(row, y * row.length);
  const cs = new CompressionStream("deflate"); // 웹 표준의 deflate 는 zlib 꼴이다 — PNG 가 바라는 그 꼴
  const wr = cs.writable.getWriter();
  wr.write(raw); wr.close();
  const idat = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    const td = new Uint8Array(t.length + data.length); td.set(t); td.set(data, t.length);
    const o = new Uint8Array(12 + data.length);
    o.set(u32(data.length), 0); o.set(td, 4); o.set(u32(crc32(td)), 8 + data.length);
    return o;
  };
  const ihdr = new Uint8Array(13); ihdr.set(u32(w), 0); ihdr.set(u32(h), 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)),
    new Uint8Array(뒤에붙일)];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 로그인·채널 설정을 모래상자에 차려 놓는다 — ytFor 가 가짜 서버로 인증받을 수 있게 */
async function 채널차리기(fake: 가짜구글, dir: string, alias = "채널A", 추가: Record<string, unknown> = {}) {
  await Deno.mkdir(`${dir}/폴더A`, { recursive: true });
  await Deno.writeTextFile(dataPath("client_secret.json"), JSON.stringify({ installed: { client_id: "test-client-id", client_secret: "s", token_uri: "https://oauth2.googleapis.com/token" } }));
  await Deno.writeTextFile(dataPath("tokens.json"), JSON.stringify({
    [alias]: { channel_id: CID, title: alias, refresh_token: "RT-A", added: "2026-01-01", scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube"], how: "browser" },
  }));
  await Deno.writeTextFile(dataPath("channels.json"), JSON.stringify({ [alias]: { channel_id: CID, folder: `${dir}/폴더A`, thumb_watch: true, ...추가 } }));
  fake.addChannel({ id: CID, title: alias }, "RT-A");
}

async function 텔레그램설정쓰기(받는이: unknown[] = [111, 222]) {
  await Deno.writeTextFile(dataPath("텔레그램.json"), JSON.stringify({ 봇토큰: TOKEN, 받는이 }));
}

/* ============================================================ 알림 */

async function 알림시험() {
  구역("알림 — 텔레그램 설정과 보내기");
  await 환경바꾸고({ TELEGRAM_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, async () => {
    await 모래상자(async () => {
      const fake = new 가짜구글().install();
      같나("설정이 없으면 보낼 수 없다", canSend(), false);
      같나("설정이 없으면 조용히 false", await send("안녕"), false);
      같나("아무것도 안 나갔다", fake.telegram.length, 0);
      같나("요약: 설정 없음", telegramSummary(), { configured: false, recipients: 0, source: "none", bot: "" });

      await 텔레그램설정쓰기();
      같나("설정이 있으면 보낼 수 있다", canSend(), true);
      같나("두 곳에 보낸다", await send("안녕\n줄바꿈"), true);
      같나("받는이마다 한 통씩", fake.telegram.map((t) => [t.chat, t.text]), [["111", "안녕\n줄바꿈"], ["222", "안녕\n줄바꿈"]]);
      같나("토큰은 주소에 실려 간다", fake.telegram[0].token, TOKEN);
      같나("요약은 봇 번호까지만 보여 준다", telegramSummary(), { configured: true, recipients: 2, source: "file", bot: "123456789" });
      fake.telegram.length = 0;
      같나("3900자에서 자른다", (await send("가".repeat(5000)), fake.telegram[0].text.length), 3900);

      // 실패해도 본 일을 막지 않는다
      fake.telegram.length = 0;
      fake.failNext(/api\.telegram\.org/, 500, { description: "Bad Gateway" }, 2);
      let 던졌나 = false;
      let 보냄 = true;
      try { 보냄 = await send("실패 시험"); } catch { 던졌나 = true; }
      같나("서버가 500 을 줘도 예외를 안 낸다", [던졌나, 보냄], [false, false]);
      let 로그 = await 읽기(recordPath("서버.log"));
      참인가("실패한 사실은 서버.log 에 남는다", 로그.includes("텔레그램 실패 — HTTP 500 Bad Gateway"));

      // 한 곳만 실패하면 보낸 것으로 친다
      fake.failNext(/api\.telegram\.org/, 500, {}, 1);
      같나("한 명이라도 받았으면 true", await send("절반"), true);
      같나("받은 쪽은 하나", fake.telegram.length, 1);

      // 연결이 아예 끊겨도 — 오류 글에 주소(토큰이 박힘)가 들어 있어도 토큰이 기록에 새지 않는다
      setFetch(() => Promise.reject(new TypeError(`error sending request for url (https://api.telegram.org/bot${TOKEN}/sendMessage): connection refused`)));
      같나("연결이 끊겨도 예외를 안 낸다", await send("끊김"), false);
      로그 = await 읽기(recordPath("서버.log"));
      참인가("끊김이 기록에 남는다", 로그.includes("connection refused"));
      같나("★토큰이 기록에 새지 않는다", 로그.includes(TOKEN), false);
      참인가("토큰 자리는 가려진다", 로그.includes("bot***"));
      fake.install();

      await Deno.writeTextFile(dataPath("텔레그램.json"), "\uFEFF" + JSON.stringify({ 봇토큰: TOKEN, 받는이: [111] }));
      같나("메모장이 붙인 BOM 이 있어도 읽는다", canSend(), true);

      // 설정 파일이 깨졌을 때
      await Deno.writeTextFile(dataPath("텔레그램.json"), "{ 이건 JSON 이 아님");
      fake.telegram.length = 0;
      같나("깨진 설정이면 보내지 않는다", [canSend(), await send("x")], [false, false]);
      참인가("설정이 깨졌다고 말한다", (telegramConfig().problem ?? "").includes("JSON"));
      같나("깨진 설정으로는 아무것도 안 나갔다", fake.telegram.length, 0);
    });

    // 환경변수와 파일의 우선순위
    await 모래상자(async () => {
      const fake = new 가짜구글().install();
      await 환경바꾸고({ TELEGRAM_TOKEN: "999:envtoken", TELEGRAM_CHAT_ID: "5, 6" }, async () => {
        같나("파일이 없으면 환경변수를 쓴다", telegramConfig(), { token: "999:envtoken", chatIds: [5, 6], source: "env", problem: undefined });
        await Deno.writeTextFile(dataPath("텔레그램.json"), JSON.stringify({ 봇토큰: TOKEN, 받는이: [111] }));
        같나("파일이 있으면 파일이 먼저", [telegramConfig().token, telegramConfig().chatIds, telegramConfig().source], [TOKEN, [111], "file"]);
        await Deno.writeTextFile(dataPath("텔레그램.json"), JSON.stringify({ 봇토큰: TOKEN }));
        같나("비어 있는 칸만 환경변수로 채운다", [telegramConfig().token, telegramConfig().chatIds, telegramConfig().source], [TOKEN, [5, 6], "mixed"]);
        await Deno.writeTextFile(dataPath("텔레그램.json"), JSON.stringify({ 봇토큰: TOKEN, 받는이: ["abc", 7, -100123] }));
        같나("받는이의 글자는 걸러내고 그룹(음수)은 받는다", telegramConfig().chatIds, [7, -100123]);
        참인가("걸러낸 것은 알려 준다", (telegramConfig().problem ?? "").includes("abc"));
      });
      void fake;
    });
  });

  구역("알림 — 설정 저장과 시험 보내기");
  await 환경바꾸고({ TELEGRAM_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, async () => {
    await 모래상자(async () => {
      const fake = new 가짜구글().install();
      const t0 = await testSend();
      같나("설정이 없으면 시험 보내기는 이유를 말한다", [t0.ok, t0.configured, t0.message.includes("설정이 없습니다")], [false, false, true]);

      await saveTelegramConfig(TOKEN, [111, "222"]);
      같나("저장한 설정이 읽힌다", [telegramConfig().token, telegramConfig().chatIds], [TOKEN, [111, 222]]);
      if (Deno.build.os !== "windows") {
        같나("비밀 파일은 권한 600", (await Deno.stat(dataPath("텔레그램.json"))).mode! & 0o777, 0o600);
      }
      await Deno.writeTextFile(dataPath("텔레그램.json"), JSON.stringify({ _설명: "메모", 봇토큰: "1:old", 받는이: [1] }));
      await saveTelegramConfig(TOKEN, [333]);
      같나("저장할 때 파일의 다른 칸(메모)은 지우지 않는다", (await readJson<Record<string, unknown>>(dataPath("텔레그램.json"), {}))["_설명"], "메모");
      await 던지나("토큰 꼴이 이상하면 던진다", () => saveTelegramConfig("엉터리", [1]), /토큰/);
      await 던지나("받는이가 숫자가 아니면 던진다", () => saveTelegramConfig(TOKEN, ["가나다"]), /숫자/);
      await 던지나("받는이가 없으면 던진다", () => saveTelegramConfig(TOKEN, []), /하나 이상/);

      const t1 = await testSend();
      같나("시험 보내기: 보냈다", [t1.ok, t1.recipients, fake.telegram.length], [true, 1, 1]);
      참인가("시험 글이다", fake.telegram[0].text.includes("알림 시험"));

      await saveTelegramConfig("", []);
      같나("둘 다 비우면 설정을 지운다(알림 끄기)", [canSend(), await Deno.stat(dataPath("텔레그램.json")).then(() => true, () => false)], [false, false]);
    });
  });

  구역("알림 — 발사·실패·공개 글과 화면 알림");
  await 환경바꾸고({ TELEGRAM_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, async () => {
    await 모래상자(async () => {
      const fake = new 가짜구글().install();
      await 텔레그램설정쓰기([111]);
      await launchNotice("채널A", "영상 제목 ".repeat(20), "vid123", "2026-10-19T09:00:00", 3, "10/19 09:30");
      let 글 = fake.telegram.at(-1)!.text;
      참인가("발사: 머리 · 채널", 글.startsWith("🚀 발사 완료\n채널  채널A"));
      참인가("발사: 제목은 60자까지", 글.split("\n")[2] === "영상  " + "영상 제목 ".repeat(20).slice(0, 60));
      참인가("발사: 예정은 T 를 공백으로 16자", 글.includes("예정  2026-10-19 09:00\n"));
      참인가("발사: 주소 · 남은 대기 · 공개 예정", 글.includes("https://youtu.be/vid123") && 글.includes("남은 발사대기 3건") && 글.includes("10/19 09:30 에 공개됩니다."));
      await launchNotice("채널A", "제목", "v", "2026-10-19 09:00", 0);
      참인가("발사: 공개 예정이 없으면 바로 공개", fake.telegram.at(-1)!.text.includes("통과하면 바로 공개됩니다."));
      await failNotice("채널A", "제목", "까닭 ".repeat(100));
      글 = fake.telegram.at(-1)!.text;
      참인가("실패: 머리 · 까닭은 180자", 글.startsWith("⚠️ 발사 실패") && 글.split("\n")[3] === "까닭  " + ("까닭 ".repeat(100)).slice(0, 180));
      await publishNotice("채널A", "제목", "vidZ");
      같나("공개: 네 줄", fake.telegram.at(-1)!.text, "✅ 공개 완료\n채널  채널A\n영상  제목\n주소  https://youtu.be/vidZ");

      fake.telegram.length = 0;
      let r = await alert("가라 ✅", "잘 된 일", { wait: true });
      같나("✅ 제목은 텔레그램에 안 간다", [r.telegram, fake.telegram.length], [null, 0]);
      r = await alert("⚠️ 제목", "막힌 일", { wait: true });
      같나("막힌 일은 텔레그램에 간다", [r.telegram, fake.telegram.length], [true, 1]);
      참인가("제목과 글이 함께 간다", fake.telegram[0].text.startsWith("⚠️ 제목\n막힌 일"));
      같나("시험 중에는 화면 알림을 띄우지 않는다", r.desktop, false);
      같나("화면 알림 함수도 시험 중에는 건너뛴다", await desktopNotify("제목", "글"), false);

      fake.telegram.length = 0;
      setTelegramAlerts(false);
      r = await alert("⚠️ 끔", "막힌 일", { wait: true });
      같나("스위치를 끄면 텔레그램에 안 간다", [r.telegram, fake.telegram.length], [null, 0]);
      r = await alert("⚠️ 따로 켬", "막힌 일", { wait: true, telegram: true });
      같나("부르는 쪽이 켜면 간다", [r.telegram, fake.telegram.length], [true, 1]);
      setTelegramAlerts(true);
      fake.telegram.length = 0;
      await alert("⚠️ 기다리지 않음", "글");
      await 잠깐(80);
      같나("기다리지 않아도 곧 나간다", fake.telegram.length, 1);
    });
  });

  구역("알림 — 하루 요약은 하루 한 번만");
  await 환경바꾸고({ TELEGRAM_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, async () => {
    await 모래상자(async () => {
      const fake = new 가짜구글().install();
      같나("설정이 없으면 보내지 않고 표식도 없다", [await daySummary(), await Deno.stat(recordPath("요약보낸날.txt")).then(() => true, () => false)], [false, false]);

      await 텔레그램설정쓰기([111]);
      const 지금 = wallNow();
      const 오늘 = dateOnly(지금);
      await appendLedger({ 업로드시각: isoWall(지금), 채널: "채널A", 영상ID: "v1", 제목: "공개된 영상", 공개설정: "public" });
      await appendLedger({ 업로드시각: isoWall(지금), 채널: "채널B", 영상ID: "v2", 제목: "예약 영상", 공개설정: "예약" });
      await appendLedger({ 업로드시각: isoWall(addDays(지금, -1)), 채널: "채널A", 영상ID: "v0", 제목: "어제 영상", 공개설정: "public" });
      const 대기 = Array.from({ length: 10 }, (_, i) => ({ file: `/x/파일${i}.mp4`, channel: CID, _alias: "채널A", 쏠때: `2026-10-2${i % 10}T09:00:00` }));
      await writeJson(dataPath("발사대기.json"), 대기);

      같나("처음에는 보낸다", await daySummary(), true);
      const 글 = fake.telegram[0].text;
      참인가("오늘 올린 것만 센다", 글.includes("올린 영상 2편 (공개 1)") && !글.includes("어제 영상"));
      참인가("제목과 상태", 글.includes("[채널A] 공개된 영상 — 공개") && 글.includes("[채널B] 예약 영상 — 예약"));
      참인가("발사 대기는 총수를 말하고 8건까지만 보여 준다", 글.includes("발사 대기 10건") && 글.includes("… 외 2건") && 글.includes("파일0") && !글.includes("파일9"));
      같나("보낸 날 표식", (await 읽기(recordPath("요약보낸날.txt"))).trim(), 오늘);
      같나("같은 날 또 부르면 그냥 지나간다", [await daySummary(), fake.telegram.length], [false, 1]);

      await Deno.writeTextFile(recordPath("요약보낸날.txt"), dateOnly(addDays(지금, -1)));
      같나("표식이 어제 날짜면 다시 보낸다", [await daySummary(), fake.telegram.length], [true, 2]);

      // 못 보냈으면 표식을 안 남겨 다음에 다시 시도한다
      await Deno.writeTextFile(recordPath("요약보낸날.txt"), "2000-01-01");
      fake.failNext(/api\.telegram\.org/, 500, {}, 1);
      같나("못 보내면 false", await daySummary(), false);
      같나("못 보냈으면 표식을 안 바꾼다", (await 읽기(recordPath("요약보낸날.txt"))).trim(), "2000-01-01");
      같나("다음에 다시 시도해 보낸다", await daySummary(), true);

      // 올린 것도 대기도 없는 날
      await Deno.remove(dataPath("ledger.csv"));
      await Deno.remove(dataPath("발사대기.json"));
      await Deno.remove(recordPath("요약보낸날.txt"));
      await daySummary();
      참인가("빈 날 글", fake.telegram.at(-1)!.text.includes("오늘 올린 영상 없음") && fake.telegram.at(-1)!.text.includes("발사 대기 없음"));
    });
  });
}

/* ============================================================ 브리핑 */

async function 브리핑시험() {
  구역("브리핑 — 기록 줄을 사람 말로");
  await 모래상자(async (dir) => {
    같나("기록이 없으면 비어 있다", await collect(), []);

    const 지금 = wallNow();
    const 전 = (분: number) => addMinutes(지금, -분);
    const 쓰기 = async (파일: string, 줄들: [Date, string][]) => {
      await Deno.mkdir(recordPath(), { recursive: true });
      await Deno.writeTextFile(recordPath(파일), 줄들.map(([w, s]) => `${줄시각(w)}  ${s}`).join("\n") + "\n");
    };
    await 쓰기("올리기.log", [
      [전(300), "발사무산 [채널A] 영상1.mp4  파일이 제자리에 없어 큐에서 뺌  (예정 2026-10-19T09:00:00)"],
      [전(250), "발사실패 [채널A] 영상2.mp4  403 quotaExceeded  (큐에 남아 다음 차례에 다시 쏩니다)"],
      [전(200), "실패   [채널B] 영상3.mp4  GoogleError: 403 forbidden"],
      [전(150), "사람확인필요  [채널B] 제목입니다 — 1번 확인해도 심사 안 끝남"],
      // 아래는 팝업이 되면 안 되는 줄들 — 제목에 「실패」 · 「썸네일」이 든 정상 줄과, 앱이 알아서 하는 일
      [전(100), "업로드  [채널A] 실패하는 이유.mp4  vidA"],
      [전(95), "올림   [채널A] 투자 실패 사례.mp4  예약 2026-10-19 09:00"],
      [전(90), "대기   [채널A] 발사실패 모음.mp4  발사예정 2026-10-19 09:00"],
      [전(85), "비공개  [채널A] 썸네일 만드는 법  vidB  (사람이 내림)"],
      [전(80), "썸네일실패 [채널A] a.mp4 vid1 403 forbidden"],
      [전(70), "곁파일이동실패  a.txt  Error: x"],
      [전(60), "썸네일재시도실패 [채널A] a.mp4 vid1 2번째 500"],
      [전(55), "썸네일재시도성공 [채널A] a.mp4 vid1 3번째"],
      [전(50), "썸네일포기 [채널A] b.mp4 vid2 6번 실패 500 backend"],
      [전(60 * 50), "실패   [채널C] 오래된.mp4  Error: 옛날 일"],
    ]);
    let 목록 = await collect();
    같나("띄우는 것은 다섯 건", 목록.map((x) => x.무슨일), [
      "썸네일이 끝내 안 붙었습니다",
      "심사가 끝나지 않아 확인이 필요합니다",
      "[채널B] 영상이 올라가지 않았습니다",
      "[채널A] 예약 발사가 실패했습니다",
      "[채널A] 예약 발사가 무산됐습니다",
    ]);
    같나("급", 목록.map((x) => x.급), ["살펴봄", "살펴봄", "큰일", "큰일", "큰일"]);
    참인가("할당량 까닭", 목록[3].왜.includes("할당량") && 목록[3].할일.includes("오후 4~5시"));
    참인가("권한 까닭", 목록[2].왜.includes("권한") && 목록[2].뜻.includes("유튜브에 없습니다"));
    참인가("무산: 예정과 파일을 말에 넣는다", 목록[4].왜.includes("2026-10-19T09:00:00") && 목록[4].왜.includes("영상1.mp4"));
    참인가("때는 월-일 시:분", /^\d{2}-\d{2} \d{2}:\d{2}$/.test(목록[0].때));
    참인가("원문이 붙는다", 목록[2].원문.includes("GoogleError: 403 forbidden"));
    같나("id 는 12자", 목록.every((x) => /^[0-9a-f]{12}$/.test(x.id)), true);
    같나("48시간이 지난 것은 안 띄운다", 목록.some((x) => x.무슨일.includes("채널C")), false);

    // 같은 일 중복 제거 · 다섯 건 한도
    await 쓰기("올리기.log", [
      [전(10), "실패   [채널A] 같은.mp4  Error: 같은 일"],
      [전(10), "실패   [채널A] 같은.mp4  Error: 같은 일"],
      ...Array.from({ length: 7 }, (_, i) => [전(20 + i), `실패   [채널${i}] 다른${i}.mp4  Error: 다른 일 ${i}`] as [Date, string]),
    ]);
    목록 = await collect();
    같나("한도는 다섯 건", 목록.length, 5);
    같나("똑같은 줄은 하나로", 목록.filter((x) => x.무슨일.includes("[채널A]")).length, 1);
    같나("최근 것부터", 목록[0].무슨일, "[채널A] 영상이 올라가지 않았습니다");

    // 서버 예외
    await Deno.remove(recordPath("올리기.log"));
    await 쓰기("서버.log", [[전(5), "시작했습니다"]]);
    같나("예외가 없으면 비어 있다", await collect(), []);
    await recordLine("서버.log", "[예외] TypeError: 뭔가 터졌다 ⏎ at 함수 (파일.ts:1:1) ⏎ at 또 (다른.ts:2:2)");
    목록 = await collect();
    같나("예외는 큰일 하나", 목록.map((x) => [x.급, x.무슨일, x.왜]), [["큰일", "앱 서버에 오류가 났습니다", "TypeError: 뭔가 터졌다"]]);
    참인가("원문에 흔적이 남는다", 목록[0].원문.includes("파일.ts:1:1"));
    const 옛id = 목록[0].id;
    await 쓰기("서버.log", [[전(30), "[예외] TypeError: 뭔가 터졌다 ⏎ at 함수 (파일.ts:1:1) ⏎ at 또 (다른.ts:2:2)"]]);
    같나("같은 오류가 다시 나도 id 가 같다(한 번 확인한 것은 다시 안 뜬다)", (await collect())[0].id, 옛id);
    await 쓰기("서버.log", [[전(60 * 50), "[예외] RangeError: 오래전 일"]]);
    같나("48시간이 지난 예외는 안 띄운다", await collect(), []);
    // 문구가 비면 다음 흔적 줄에서 까닭을 찾는다 — 시각 없이 이어 붙은 줄(여러 줄로 남은 예외)과 한 줄로 이어진 꼴(⏎) 둘 다
    await Deno.writeTextFile(recordPath("서버.log"), `${줄시각(전(5))}  [예외]\n   at 이름 없는 예외\n   at 또 하나\n`);
    같나("문구가 비면 이어진 줄에서 까닭을 찾는다", (await collect())[0].왜, "at 이름 없는 예외");
    await 쓰기("서버.log", [[전(5), "[예외] ⏎ at 한 줄로 이어진 예외 ⏎ at 또"]]);
    같나("한 줄로 이어진 꼴도 같다", (await collect())[0].왜, "at 한 줄로 이어진 예외");

    // 사람 확인 대기
    await Deno.remove(recordPath("서버.log"));
    await writeJson(dataPath("pending.json"), [
      { channel: "채널B", video_id: "vidX", title: "오래 걸리는 영상", 사람확인: true, 확인수: 1 },
      { channel: "채널B", video_id: "vidY", title: "아직 자동", 사람확인: false, 확인수: 0 },
    ]);
    목록 = await collect();
    같나("사람확인만 띄운다", 목록.map((x) => x.무슨일), ["[채널B] 심사가 끝나지 않았습니다"]);
    참인가("스튜디오 주소", 목록[0].할일.includes("https://studio.youtube.com/video/vidX/edit"));
    참인가("한 번 확인한 횟수", 목록[0].왜.includes("1번 확인했지만"));

    // 폴더를 못 읽으면 화면이 옛 값을 보여 준다
    await Deno.remove(dataPath("pending.json"));
    await Deno.mkdir(`${dir}/있는폴더`, { recursive: true });
    await writeJson(dataPath("channels.json"), {
      채널A: { channel_id: CID, folder: `${dir}/있는폴더` },
      채널B: { channel_id: "UC" + "y".repeat(22), folder: `${dir}/사라진폴더` },
      채널C: { channel_id: "UC" + "z".repeat(22), folder: "" },
    });
    목록 = await collect();
    같나("못 읽는 폴더 하나만 말한다", 목록.length, 1);
    참인가("어느 채널 · 어느 폴더인지 말한다", 목록[0].왜.includes("채널B →") && !목록[0].왜.includes("채널A →") && !목록[0].왜.includes("채널C →"));
    같나("큰일이다", 목록[0].급, "큰일");
    await Deno.mkdir(`${dir}/사라진폴더`);
    같나("폴더가 돌아오면 사라진다", await collect(), []);
  });

  구역("브리핑 — 오류 문구를 사람 말로");
  {
    같나("할당량", explainUploadFailure("HttpError 403 quotaExceeded").왜, "오늘 쓸 수 있는 유튜브 할당량을 다 썼습니다.");
    같나("할당량(우리 말)", explainUploadFailure("오늘 쓸 수 있는 유튜브 할당량을 다 썼습니다.").왜.includes("할당량"), true);
    같나("인증", explainUploadFailure("invalid_grant: Token has been expired").왜, "이 채널의 인증이 풀렸습니다.");
    같나("인증(우리 말)", explainUploadFailure("인증이 만료되었거나 취소되었습니다. 다시 연결해 주세요.").왜, "이 채널의 인증이 풀렸습니다.");
    같나("권한", explainUploadFailure("403 forbidden").왜.includes("권한"), true);
    같나("연결 끊김", explainUploadFailure("ConnectionResetError").왜, "전송 중 연결이 끊겼습니다.");
    같나("연결 끊김(우리 말)", explainUploadFailure("네트워크가 불안정합니다: x").왜, "전송 중 연결이 끊겼습니다.");
    같나("쇼츠 조건", explainUploadFailure("쇼츠 조건 미달").왜.includes("9:16"), true);
    같나("파일 없음", explainUploadFailure("파일이 없습니다: x").왜, "올리려던 파일을 찾지 못했습니다.");
    같나("모르는 오류는 원문 그대로(160자)", explainUploadFailure("이상한 일 ".repeat(40)).왜.length, 160);
    같나("빈 오류", explainUploadFailure("").왜, "까닭을 읽지 못했습니다.");
  }
}

/* ============================================================ 휴지통 */

async function 휴지통시험() {
  구역("휴지통 — 리눅스 길(임시 폴더)과 가짜 실행기");
  await 모래상자(async (dir) => {
    await 환경바꾸고({ XDG_DATA_HOME: `${dir}/xdg` }, async () => {
      const 채널 = `${dir}/채널폴더`;
      await Deno.mkdir(채널, { recursive: true });
      const 만들기 = async (이름: string, 곁 = [".txt", ".json", ".jpg"]) => {
        await Deno.writeTextFile(`${채널}/${이름}.mp4`, "영상");
        for (const x of 곁) await Deno.writeTextFile(`${채널}/${이름}${x}`, "곁" + x);
      };
      await 만들기("영상1", [".txt", ".json", ".jpg", ".png", ".srt"]);
      await Deno.writeTextFile(`${채널}/영상1.zip`, "곁 파일이 아니다");
      await Deno.writeTextFile(`${채널}/영상10.txt`, "이름이 비슷한 다른 영상의 문안");

      같나("곁 파일 찾기: 확장자 목록 안의 같은 이름만", (await sideFiles(`${채널}/영상1.mp4`)).map((x) => x.split("/").pop()).sort(), ["영상1.json", "영상1.jpg", "영상1.png", "영상1.srt", "영상1.txt"].sort());

      const r = await sendToTrash(`${채널}/영상1.mp4`, [채널], { os: "linux" });
      같나("영상과 곁 파일이 함께 간다", [r.영상, r.함께.length, r.개수], ["영상1.mp4", 5, 6]);
      같나("폴더에서는 사라졌다", (await 파일들(채널)), ["영상1.zip", "영상10.txt"]);
      같나("휴지통 파일 칸에 들어갔다", (await 파일들(`${dir}/xdg/Trash/files`)), ["영상1.json", "영상1.jpg", "영상1.mp4", "영상1.png", "영상1.srt", "영상1.txt"].sort());
      const info = await Deno.readTextFile(`${dir}/xdg/Trash/info/영상1.mp4.trashinfo`);
      참인가("되살릴 자리를 적는다(한글은 퍼센트 부호로)", info.startsWith("[Trash Info]\nPath=") && info.includes(encodeURIComponent("영상1.mp4")) && info.includes("DeletionDate=2"));

      await 만들기("영상1", [".txt"]);
      const r2 = await sendToTrash(`${채널}/영상1.mp4`, [채널], { os: "linux" });
      같나("같은 이름이 있으면 번호를 붙인다", (await 파일들(`${dir}/xdg/Trash/files`)).filter((x) => x.includes(".1.")).sort(), ["영상1.1.mp4", "영상1.1.txt"]);
      같나("번호 붙은 쪽도 정보 파일이 있다", (await 파일들(`${dir}/xdg/Trash/info`)).includes("영상1.1.mp4.trashinfo"), true);
      같나("두 번째 결과", r2.개수, 2);

      // 허용 폴더
      await Deno.mkdir(`${dir}/남의폴더`, { recursive: true });
      await Deno.writeTextFile(`${dir}/남의폴더/남의영상.mp4`, "남의 것");
      await 던지나("등록된 폴더 밖은 지우지 않는다", () => sendToTrash(`${dir}/남의폴더/남의영상.mp4`, [채널], { os: "linux" }), /등록된 채널 폴더 안/);
      await 던지나("../ 로 빠져나가도 막는다", () => sendToTrash(`${채널}/../남의폴더/남의영상.mp4`, [채널], { os: "linux" }), /등록된 채널 폴더 안/);
      let 링크됨 = true;
      try { await Deno.symlink(`${dir}/남의폴더/남의영상.mp4`, `${채널}/바로가기.mp4`); } catch { 링크됨 = false; } // 권한이 없는 윈도우 등
      if (링크됨) await 던지나("폴더 안의 바로가기가 밖을 가리켜도 막는다", () => sendToTrash(`${채널}/바로가기.mp4`, [채널], { os: "linux" }), /등록된 채널 폴더 안/);
      같나("남의 파일은 그대로", await Deno.readTextFile(`${dir}/남의폴더/남의영상.mp4`), "남의 것");
      await 던지나("이름이 접두사만 같은 폴더도 안쪽이 아니다", () => sendToTrash(`${dir}/채널폴더2/x.mp4`, [채널], { os: "linux" }), /이미 없습니다|등록된 채널 폴더 안/);
      await 던지나("없는 파일", () => sendToTrash(`${채널}/없는영상.mp4`, [채널], { os: "linux" }), /이미 없습니다/);
      let 오류종류 = "";
      try { await sendToTrash(`${채널}/없는영상.mp4`, [채널], { os: "linux" }); } catch (e) { 오류종류 = e instanceof TrashError ? "TrashError" : String(e); }
      같나("못 보낸 까닭은 TrashError 로 던진다", 오류종류, "TrashError");
      같나("허용 폴더를 안 주면 어디든 보낸다(호출한 쪽 책임)", (await sendToTrash(`${dir}/남의폴더/남의영상.mp4`, undefined, { os: "linux" })).개수, 1);
    });
  });

  await 모래상자(async (dir) => {
    const 폴더 = `${dir}/폴더`;
    await Deno.mkdir(폴더, { recursive: true });
    const 호출: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    // 가짜 실행기: 파인더·PowerShell 이 하듯 넘겨받은 경로의 파일을 치운다
    const 가짜 = (치우기: (p: string) => boolean, code = 0, stderr = "") => async (cmd: string, args: string[], env?: Record<string, string>) => {
      호출.push({ cmd, args, env });
      if (code === 0) {
        const 경로들 = env?.GU_FILES ? env.GU_FILES.split("\n") : args.filter((a) => a.startsWith("/"));
        for (const p of 경로들) if (치우기(p)) await Deno.remove(p);
      }
      return { code, stderr };
    };

    await Deno.writeTextFile(`${폴더}/한 "따옴표" 영상.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/한 "따옴표" 영상.txt`, "x");
    const r = await sendToTrash(`${폴더}/한 "따옴표" 영상.mp4`, null, { os: "mac", run: 가짜(() => true) });
    같나("맥: osascript 를 부른다", 호출[0].cmd, "osascript");
    참인가("맥: 파인더에게 시키는 글이다", 호출[0].args.some((a) => a === 'tell application "Finder" to delete theFiles'));
    참인가("맥: 경로는 글 안에 끼우지 않고 인자로 넘긴다(따옴표가 든 이름도 안 깨진다)", 호출[0].args.includes(`${await Deno.realPath(폴더)}/한 "따옴표" 영상.mp4`));
    같나("맥: 영상과 곁 파일 둘", r.개수, 2);

    await Deno.writeTextFile(`${폴더}/안지워짐.mp4`, "x");
    await 던지나("맥: 파인더가 거절하면 그 말을 던진다", () => sendToTrash(`${폴더}/안지워짐.mp4`, null, { os: "mac", run: 가짜(() => true, 1, "Finder got an error: 권한 없음") }), /권한 없음/);
    await 던지나("맥: 거절 말이 없으면 기본 말", () => sendToTrash(`${폴더}/안지워짐.mp4`, null, { os: "mac", run: 가짜(() => true, 1, "") }), /응답하지 않았습니다/);
    await 던지나("맥: 성공이라는데 파일이 남았으면 던진다", () => sendToTrash(`${폴더}/안지워짐.mp4`, null, { os: "mac", run: 가짜(() => false) }), /1개가 그대로 남았습니다/);
    같나("그래도 파일은 안 잃는다", await Deno.readTextFile(`${폴더}/안지워짐.mp4`), "x");

    호출.length = 0;
    await Deno.writeTextFile(`${폴더}/윈도우.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/윈도우.jpg`, "x");
    const w = await sendToTrash(`${폴더}/윈도우.mp4`, null, { os: "win", run: 가짜(() => true) });
    같나("윈도우: powershell", 호출[0].cmd, "powershell");
    같나("윈도우: 경로는 환경변수로(줄바꿈으로 이어)", 호출[0].env?.GU_FILES.split("\n").map((x) => x.split("/").pop()), ["윈도우.mp4", "윈도우.jpg"]);
    참인가("윈도우: 휴지통 보내기 옵션", 호출[0].args.join(" ").includes("SendToRecycleBin"));
    같나("윈도우 결과", w.개수, 2);
  });

  구역("휴지통 — 단순 이동(휴지통 폴더로 옮기기만)");
  await 모래상자(async (dir) => {
    const 집 = `${dir}/집`;
    await Deno.mkdir(`${dir}/원본`, { recursive: true });
    const 만들기 = async (내용: string) => { await Deno.writeTextFile(`${dir}/원본/영상.mp4`, 내용); };
    await 만들기("하나");
    const a = await moveToTrashPlain(`${dir}/원본/영상.mp4`, { os: "mac" });
    같나("맥: ~/.Trash 로 들어간다", a, `${집}/.Trash/영상.mp4`);
    await 만들기("둘");
    같나("같은 이름이면 번호", await moveToTrashPlain(`${dir}/원본/영상.mp4`, { os: "mac" }), `${집}/.Trash/영상 1.mp4`);
    await 만들기("셋");
    같나("번호는 이어서 늘어난다", await moveToTrashPlain(`${dir}/원본/영상.mp4`, { os: "mac" }), `${집}/.Trash/영상 2.mp4`);
    같나("앞의 것은 덮이지 않았다", [await Deno.readTextFile(`${집}/.Trash/영상.mp4`), await Deno.readTextFile(`${집}/.Trash/영상 1.mp4`)], ["하나", "둘"]);
    같나("원래 자리는 비었다", await Deno.stat(`${dir}/원본/영상.mp4`).then(() => true, () => false), false);
    같나("없는 파일은 null", await moveToTrashPlain(`${dir}/원본/없음.mp4`, { os: "mac" }), null);
    참인가("없는 파일은 기록에 남는다", (await 읽기(recordPath("서버.log"))).includes("휴지통으로 보내지 못했습니다"));
    같나("확장자가 없는 이름도 번호가 붙는다", (await (async () => {
      await Deno.writeTextFile(`${dir}/원본/메모`, "1"); await moveToTrashPlain(`${dir}/원본/메모`, { os: "mac" });
      await Deno.writeTextFile(`${dir}/원본/메모`, "2");
      return moveToTrashPlain(`${dir}/원본/메모`, { os: "mac" });
    })()), `${집}/.Trash/메모 1`);
    await 만들기("윈도우");
    const 불린 = { env: "" };
    같나("윈도우: 휴지통으로 보내고 「휴지통」이라고 답한다", await moveToTrashPlain(`${dir}/원본/영상.mp4`, { os: "win", run: async (_c, _a, e) => { 불린.env = e?.GU_FILES ?? ""; await Deno.remove(불린.env); return { code: 0, stderr: "" }; } }), "휴지통");
    참인가("윈도우: 경로는 환경변수로 넘겼다", 불린.env.endsWith("영상.mp4"));
    await 환경바꾸고({ XDG_DATA_HOME: `${dir}/xdg` }, async () => {
      await 만들기("리눅스");
      같나("리눅스: 휴지통 파일 칸", await moveToTrashPlain(`${dir}/원본/영상.mp4`, { os: "linux" }), `${dir}/xdg/Trash/files/영상.mp4`);
    });
  });
}

/* ============================================================ 보관 · 백업 */

async function 보관시험() {
  구역("보관 — 날짜 폴더에 얼려 둔다");
  await 모래상자(async () => {
    같나("지킬 것 다섯", KEEP_FILES, ["구독기록.json", "영상기록.json", "성적.json", "ledger.csv", "pending.json"]);
    같나("자료가 없으면 0개", await keepToday(true), 0);
    await Deno.writeTextFile(dataPath("ledger.csv"), "원장 1\r\n");
    await Deno.writeTextFile(dataPath("pending.json"), "[]");
    await Deno.writeTextFile(dataPath("영상기록.json"), '{"a":1}');
    await Deno.writeTextFile(dataPath("channels.json"), "{}"); // 지킬 목록이 아니다
    const 오늘 = dateOnly(wallNow());
    같나("있는 것 셋을 남긴다", await keepToday(true), 3);
    같나("오늘 폴더에 들어갔다", await 파일들(recordPath("보관", 오늘)), ["ledger.csv", "pending.json", "영상기록.json"].sort());
    const 원본시각 = (await Deno.stat(dataPath("ledger.csv"))).mtime!.getTime();
    참인가("수정 시각을 그대로 둔다", Math.abs((await Deno.stat(recordPath("보관", 오늘, "ledger.csv"))).mtime!.getTime() - 원본시각) < 2000);
    await Deno.writeTextFile(dataPath("ledger.csv"), "원장 2\r\n더\r\n");
    await keepToday(true);
    같나("같은 날 또 돌리면 덮어쓸 뿐 늘지 않는다", [(await 파일들(recordPath("보관", 오늘))).length, await Deno.readTextFile(recordPath("보관", 오늘, "ledger.csv"))], [3, "원장 2\r\n더\r\n"]);

    // 400일이 지난 날짜 폴더만 치운다
    const 지금 = wallNow();
    for (const n of [399, 400, 401, 1000]) {
      await Deno.mkdir(recordPath("보관", dateOnly(addDays(지금, -n))), { recursive: true });
      await Deno.writeTextFile(recordPath("보관", dateOnly(addDays(지금, -n)), "ledger.csv"), String(n));
    }
    await Deno.mkdir(recordPath("보관", "내가 따로 둔 메모"), { recursive: true });
    await Deno.mkdir(recordPath("보관", "2000-13-45x"), { recursive: true });
    await keepToday(true);
    const 남은 = (await Array.fromAsync(Deno.readDir(recordPath("보관")))).map((e) => e.name).sort();
    같나("399 · 400일 전은 남고 401 · 1000일 전은 치운다", [399, 400, 401, 1000].map((n) => 남은.includes(dateOnly(addDays(지금, -n)))), [true, true, false, false]);
    같나("날짜 모양이 아닌 폴더는 건드리지 않는다", [남은.includes("내가 따로 둔 메모"), 남은.includes("2000-13-45x")], [true, true]);

    const 목록 = await listKept();
    참인가("목록은 오래된 날부터", 목록.map((x) => x.date).join() === 목록.map((x) => x.date).sort().join());
    const 오늘칸 = 목록.find((x) => x.date === 오늘)!;
    같나("오늘 칸: 파일 3개 · 크기", [오늘칸.files, 오늘칸.bytes], [3, new TextEncoder().encode("원장 2\r\n더\r\n[]" + '{"a":1}').length]);
  });
}

async function 백업시험() {
  구역("백업 — 맥 → 외장 한 방향 미러");
  await 모래상자(async (dir) => {
    const dst = `${dir}/외장/백업/uploader`;
    await Deno.mkdir(`${dir}/외장`, { recursive: true });
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: dst }));
    await Deno.writeTextFile(dataPath("ledger.csv"), "a,b\r\n1,2\r\n");
    await Deno.writeTextFile(dataPath("channels.json"), "{}");
    await Deno.mkdir(recordPath("보관", "2026-10-01"), { recursive: true });
    await Deno.writeTextFile(recordPath("보관", "2026-10-01", "ledger.csv"), "옛 원장");
    // 미러에서 빠져야 하는 것들
    await Deno.writeTextFile(dataPath(".DS_Store"), "x");
    await Deno.writeTextFile(dataPath("영상정보.json"), "{}");
    await Deno.writeTextFile(dataPath("tokens.lock"), "");
    await Deno.writeTextFile(dataPath("임시.json.abc.tmp"), "x");
    await Deno.mkdir(dataPath("__pycache__"), { recursive: true });
    await Deno.writeTextFile(dataPath("__pycache__", "a.pyc"), "x");

    const r1 = await mirror(true);
    같나("처음: 코드 0", r1.code, 0);
    같나("복사한 것: 데이터 · 보관 사본 · 설정까지(캐시·잠금·임시는 뺀다) + 대상 폴더의 표식", await 파일들(dst), [MIRROR_MARK_NAME, "channels.json", "ledger.csv", "경로설정.json", "기록/보관/2026-10-01/ledger.csv"].sort());
    같나("셈", [r1.copied, r1.deleted, r1.total], [4, 0, 4]);
    같나("내용도 같다", await Deno.readTextFile(`${dst}/ledger.csv`), "a,b\r\n1,2\r\n");

    const r2 = await mirror(true);
    같나("두 번째: 바뀐 게 없으면 복사 0 · 지움 0", [r2.code, r2.copied, r2.deleted], [0, 0, 0]);

    await Deno.writeTextFile(dataPath("ledger.csv"), "a,b\r\n1,2\r\n3,4\r\n");
    await Deno.remove(dataPath("channels.json"));
    await Deno.remove(recordPath("보관", "2026-10-01"), { recursive: true });
    const r3 = await mirror(true);
    같나("바뀐 것은 다시 복사하고 사라진 것은 사본에서도 지운다", [r3.copied, r3.deleted], [1, 2]);
    같나("사본 내용", await Deno.readTextFile(`${dst}/ledger.csv`), "a,b\r\n1,2\r\n3,4\r\n");
    같나("빈 폴더도 치운다", await Deno.stat(`${dst}/기록`).then(() => true, () => false), false);

    // 사본 쪽 찌꺼기는 건드리지 않는다
    await Deno.writeTextFile(`${dst}/.DS_Store`, "파인더가 만든 것");
    await Deno.mkdir(`${dst}/__pycache__`);
    const r4 = await mirror(true);
    같나("제외 이름은 사본에서도 안 지운다", [r4.deleted, await Deno.readTextFile(`${dst}/.DS_Store`)], [0, "파인더가 만든 것"]);
    참인가("표식도 지우지 않는다", await Deno.stat(`${dst}/${MIRROR_MARK_NAME}`).then(() => true, () => false));
  });

  await 모래상자(async (dir) => {
    // 이름이 NFD 로 풀려 있는 사본 — 같은 파일로 알아본다
    const dst = `${dir}/외장/백업/uploader`;
    await Deno.mkdir(`${dir}/외장`, { recursive: true });
    await Deno.mkdir(dst, { recursive: true });
    await Deno.writeTextFile(`${dst}/${MIRROR_MARK_NAME}`, "{}"); // 이미 이 앱이 쓰던 사본 폴더
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: dst }));
    const 이름 = "한글 이름.json";
    await Deno.writeTextFile(dataPath(이름.normalize("NFC")), "내용");
    const st = await Deno.stat(dataPath(이름.normalize("NFC")));
    await Deno.writeTextFile(`${dst}/${이름.normalize("NFD")}`, "내용");
    await Deno.utime(`${dst}/${이름.normalize("NFD")}`, st.atime ?? st.mtime!, st.mtime!);
    await Deno.writeTextFile(`${dst}/경로설정.json`, await Deno.readTextFile(dataPath("경로설정.json")));
    const s2 = await Deno.stat(dataPath("경로설정.json"));
    await Deno.utime(`${dst}/경로설정.json`, s2.atime ?? s2.mtime!, s2.mtime!);
    const r = await mirror(true);
    같나("NFD 사본을 같은 파일로 본다: 복사도 지움도 없다", [r.code, r.copied, r.deleted], [0, 0, 0]);
    같나("사본에 같은 이름이 둘 생기지 않았다", (await Array.fromAsync(Deno.readDir(dst))).filter((e) => e.name.normalize("NFC") === 이름.normalize("NFC")).length, 1);
  });

  구역("백업 — 엉뚱한 폴더를 대상으로 적었을 때(안전 장치)");
  await 모래상자(async (dir) => {
    const dst = `${dir}/외장/백업/uploader`;
    await Deno.mkdir(dst, { recursive: true });
    await Deno.writeTextFile(`${dst}/내 중요한 파일.txt`, "지우면 안 됨");
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: dst }));
    await Deno.writeTextFile(dataPath("ledger.csv"), "x");
    const r = await mirror(true);
    같나("이미 다른 파일이 든 폴더는 건드리지 않는다(코드 1)", [r.code, r.copied, r.deleted], [1, 0, 0]);
    같나("남의 파일이 그대로", await Deno.readTextFile(`${dst}/내 중요한 파일.txt`), "지우면 안 됨");
    참인가("까닭과 푸는 법을 말한다", r.message.includes("이미 다른 파일이 있어 멈췄습니다") && r.message.includes("빈 폴더") && r.message.includes(MIRROR_MARK_NAME));
    같나("멋대로 표식을 만들지 않았다", await Deno.stat(`${dst}/${MIRROR_MARK_NAME}`).then(() => true, () => false), false);
    같나("아무것도 복사하지 않았다", await 파일들(dst), ["내 중요한 파일.txt"]);
    참인가("조용 모드에서도 기록에 남는다", (await 읽기(recordPath("서버.log"))).includes("백업 실패 — 백업 대상 폴더에 이미 다른 파일이 있어"));

    await Deno.remove(`${dst}/내 중요한 파일.txt`);
    await Deno.writeTextFile(`${dst}/.DS_Store`, "운영체제 찌꺼기");
    const r2 = await mirror(true);
    같나("운영체제 찌꺼기만 든 폴더는 빈 폴더로 본다", r2.code, 0);
    같나("그러면 표식을 남기고 돈다", [await Deno.stat(`${dst}/${MIRROR_MARK_NAME}`).then(() => true, () => false), await Deno.readTextFile(`${dst}/ledger.csv`)], [true, "x"]);
    const 표식 = JSON.parse(await Deno.readTextFile(`${dst}/${MIRROR_MARK_NAME}`));
    참인가("표식에 무엇인지 적혀 있다", typeof 표식.설명 === "string" && 표식.앱 === APP_ID && /^\d{4}-\d{2}-\d{2}T/.test(표식.만든때));
    await Deno.writeTextFile(`${dst}/직접 넣은 파일.txt`, "원본에 없다");
    const r3 = await mirror(true);
    같나("표식이 있는 폴더는 원본에 없는 파일을 지운다(미러의 뜻)", [r3.code, r3.deleted, await Deno.stat(`${dst}/직접 넣은 파일.txt`).then(() => true, () => false)], [0, 1, false]);
  });

  await 모래상자(async (dir) => {
    // 이 폴더가 맞다면 표식을 손으로 만들어 두면 된다
    const dst = `${dir}/외장/백업/uploader`;
    await Deno.mkdir(dst, { recursive: true });
    await Deno.writeTextFile(`${dst}/${MIRROR_MARK_NAME}`, "{}");
    await Deno.writeTextFile(`${dst}/옛 사본.txt`, "원본에 없는 옛 사본");
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: dst }));
    const r = await mirror(true);
    같나("표식을 손으로 만들어 두면 돈다", [r.code, r.deleted, await 파일들(dst)], [0, 1, [MIRROR_MARK_NAME, "경로설정.json"].sort()]);
  });

  구역("백업 — 외장이 없을 때 · 겹침 · 동시 실행");
  await 모래상자(async (dir) => {
    await Deno.writeTextFile(dataPath("ledger.csv"), "x");
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: `${dir}/없는외장/백업/uploader` }));
    const r = await mirror(true);
    같나("외장이 안 붙어 있으면 건너뜀(코드 2)", r.code, 2);
    같나("아무것도 만들지 않는다", await Deno.stat(`${dir}/없는외장`).then(() => true, () => false), false);
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: "/Volumes/__없는_외장__/백업/uploader" }));
    같나("볼륨 이름이 드러나는 경로도 건너뜀", [(await mirror(true)).code, await Deno.stat("/Volumes/__없는_외장__").then(() => true, () => false)], [2, false]);
    await Deno.writeTextFile(dataPath("경로설정.json"), "{}");
    같나("설정이 없으면 기본 자리(없는 이름)라 건너뜀", (await mirror(true)).code, 2);
    참인가("건너뜀은 기록에 남기지 않는다(외장을 뺀 날은 정상)", !(await 읽기(recordPath("서버.log"))).includes("백업 실패"));

    // 백업 대상이 원본 폴더 안에 있어도 자기 사본을 또 복사하지 않는다
    const 안 = dataPath("기록", "사본", "uploader");
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: 안 }));
    const a = await mirror(true);
    const 처음 = await 파일들(안);
    const b = await mirror(true);
    같나("대상이 원본 안이어도 돈다", [a.code, b.code], [0, 0]);
    같나("두 번째에 복사가 없다(자기 사본을 또 복사하지 않는다)", [b.copied, (await 파일들(안)).length], [0, 처음.length]);
    참인가("사본 폴더 자체는 복사 목록에 없다", !처음.some((x) => x.includes("사본/")));

    // 원본이 대상 안에 있으면 멈춘다
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: dir }));
    const c = await mirror(true);
    같나("원본을 품은 대상이면 멈춘다(코드 1)", c.code, 1);
    참인가("실패는 조용 모드에서도 기록에 남는다", (await 읽기(recordPath("서버.log"))).includes("백업 실패 — 백업 대상이 원본 폴더를 품고 있어 멈췄습니다"));

    // 동시에 두 번
    await Deno.mkdir(`${dir}/외장2`, { recursive: true });
    await Deno.writeTextFile(dataPath("경로설정.json"), JSON.stringify({ 백업대상: `${dir}/외장2/백업/uploader` }));
    const 동시 = await withFileLock(dataPath("백업.lock"), async () => await mirror(true));
    같나("다른 백업이 돌고 있으면 건너뜀(코드 2)", [동시?.code, 동시?.message], [2, "이미 다른 백업이 돌고 있습니다"]);
    같나("끝나면 다시 돈다", (await mirror(true)).code, 0);
  });
}

/* ============================================================ 문안 점검 */

const 일본어규격 = { forbid_hangul: true, hashtags: 5, forbid_shorts_tag: true, forbid_cta: true };
const 글꼴 = (제목: string, 설명: string, 태그: string) => `[제목]\n${제목}\n\n[설명]\n${설명}\n\n[해시태그]\n${태그}\n`;
const 좋은태그 = "#音楽 #動画 #推し #日本 #テスト";

async function 문안시험() {
  구역("문안 점검 — 규격 검사 (채널 설정의 meta_rule)");
  {
    같나("규격이 없으면 늘 통과", checkText(undefined, "아무 글"), []);
    같나("규칙 칸이 하나도 없는 {} 도 규격 없음", checkText({}, "아무 글"), []);
    같나("좋은 글은 통과", checkText(일본어규격, 글꼴("テスト動画", "これはテストの説明です。", 좋은태그)), []);
    같나("제목이 없다", checkText({ hashtags: 5 }, 글꼴("", "본문", 좋은태그)), ["제목 없음"]);

    같나("제목의 한글", checkText({ forbid_hangul: true }, 글꼴("テスト동画", "あ", "#a")).filter((x) => x.includes("한글")), ["제목에 한글 1자"]);
    같나("설명 · 해시태그의 한글", checkText({ forbid_hangul: true }, 글꼴("テスト", "한글 두 자", "#日本 #음악")).filter((x) => x.includes("한글")), ["설명에 한글 4자", "해시태그에 한글 2자"]);
    같나("비공개 태그의 한글(tags 인자)", checkText({ forbid_hangul: true }, 글꼴("テスト", "あ", "#a"), ["日本語", "한글"]), ["비공개 태그에 한글 2자"]);
    같나("한글 규칙을 안 켜면 한글도 통과", checkText({ hashtags: 1 }, 글꼴("한글 제목", "한글 설명", "#한글")), []);
    같나("풀어 쓴 자모(맥 파일 이름 꼴)도 한글이다", [countHangul("뮤직스타"), countHangul("뮤직스타".normalize("NFD"))], [4, 9]);
    같나("호환 자모 · 옛 자모 · 반각 한글", [countHangul("ㄱㅏ"), countHangul("ꥠ"), countHangul("ﾡ")], [2, 1, 1]);
    같나("일본어 · 영어 · 한자는 한글이 아니다", countHangul("日本語 かな カナ ABC 漢字 ｱｲｳ"), 0);

    같나("해시태그 개수: 모자람", checkText({ hashtags: 5 }, 글꼴("テ", "あ", "#a #b #c #d")), ["해시태그 4개(정확히 5개)"]);
    같나("해시태그 개수: 넘침", checkText({ hashtags: 5 }, 글꼴("テ", "あ", "#a #b #c #d #e #f")), ["해시태그 6개(정확히 5개)"]);
    같나("개수를 안 정하면 개수는 안 잰다", checkText({ forbid_hangul: true }, 글꼴("テ", "あ", "#a")), []);
    같나("겹친 태그", checkText({ hashtags: 5 }, 글꼴("テ", "あ", "#a #b #c #d #a")), ["해시태그가 겹친다"]);
    같나("본문에 섞인 태그", checkText({ hashtags: 5 }, 글꼴("テ", "본문 #섞임 입니다", 좋은태그)).map((x) => x.slice(0, 20)), ["설명 본문에 해시태그가 있다(#섞임)"]);
    같나("태그만 있는 줄은 본문이 아니다", checkText({ hashtags: 5 }, 글꼴("テ", "본문\n#가 #나", 좋은태그)), []);
    같나("올릴 때 끊기는 태그(・ 기호)", checkText({ hashtags: 5 }, 글꼴("テ", "あ", "#中島美嘉・雪の華 #b #c #d #e")), ["해시태그가 올릴 때 끊긴다(기호가 들었다): #中島美嘉・雪の華 → #中島美嘉"]);

    같나("#shorts: 태그", checkText({ forbid_shorts_tag: true }, 글꼴("テ", "あ", "#a #shorts")), ["#shorts 있음"]);
    같나("#Shorts 대소문자 무관 · 설명", checkText({ forbid_shorts_tag: true }, 글꼴("テ", "ここで #Shorts です", "#a")), ["#shorts 있음"]);
    같나("#shorts 제목", checkText({ forbid_shorts_tag: true }, 글꼴("テスト #shorts", "あ", "#a")), ["#shorts 있음"]);
    같나("더 긴 낱말(#shortsfilm)은 아니다", checkText({ forbid_shorts_tag: true }, 글꼴("テ", "あ", "#shortsfilm")), []);
    같나("규칙을 안 켜면 #shorts 도 통과", checkText({ hashtags: 1 }, 글꼴("テ", "あ", "#shorts")), []);

    같나("구독 유도: チャンネル登録", checkText({ forbid_cta: true }, 글꼴("テ", "チャンネル登録お願いします", "#a")), ["구독·좋아요·알림 유도 말 「チャンネル登録」"]);
    같나("구독 유도: 영어는 대소문자 무관", checkText({ forbid_cta: true }, 글꼴("テ", "Please SUBSCRIBE!", "#a")), ["구독·좋아요·알림 유도 말 「SUBSCRIBE」"]);
    같나("좋아요 · 알림 · 벨", [checkText({ forbid_cta: true }, 글꼴("テ", "좋아요 눌러", "#a")).length, checkText({ forbid_cta: true }, 글꼴("テ", "通知をオンに", "#a")).length, checkText({ forbid_cta: true }, 글꼴("テ", "ベルマークを押して", "#a")).length], [1, 1, 1]);
    같나("「レベル」 · 「いいね」 같은 정상 글은 걸리지 않는다", checkText({ forbid_cta: true }, 글꼴("『いいね！光源氏くん』", "レベルが高い", "#a")), []);

    // 본문 글자 수 — 업로드되는 꼴(본문 + 빈 줄 + 해시태그 줄)로 잰다
    const 본문 = "あ".repeat(30);
    같나("글자 수: 범위 안", checkText({ desc_min: 20, desc_max: 40 }, 글꼴("テ", 본문, "#a")), []);
    같나("글자 수: 모자람(업로드되는 꼴이라 본문 30자는 31자로 잡힌다)", checkText({ desc_min: 40, desc_max: 100 }, 글꼴("テ", 본문, "#a")), ["설명 본문 31자(40~100 밖)"]);
    같나("글자 수: 넘침", checkText({ desc_min: 10, desc_max: 20 }, 글꼴("テ", 본문, "#a")), ["설명 본문 31자(10~20 밖)"]);
    같나("글자 수: 한쪽만 정한 규칙", [checkText({ desc_min: 99 }, 글꼴("テ", 본문, "#a")), checkText({ desc_max: 5 }, 글꼴("テ", 본문, "#a"))], [["설명 본문 31자(99자 이상이어야 함)"], ["설명 본문 31자(5자 이하여야 함)"]]);
    같나("글자 수: 해시태그가 없으면 본문 그대로", checkText({ desc_max: 29 }, `[제목]\nテ\n\n[설명]\n${본문}\n`), ["설명 본문 30자(29자 이하여야 함)"]);
    같나("글자 수 규칙을 안 정하면 안 잰다", checkText({ hashtags: 1 }, 글꼴("テ", "あ".repeat(5000), "#a")), []);
    같나("원본에 박혀 있던 실측 숫자(527~706)는 기본값이 아니다", checkText({ forbid_hangul: true }, 글꼴("テ", "あ", "#a")), []);

    같나("여러 흠은 한꺼번에", checkText(일본어규격, 글꼴("한글", "구독 #shorts", "#a")).length >= 4, true);
    같나("BOM 이 앞에 있어도 읽는다", checkText({ hashtags: 5 }, "\uFEFF" + 글꼴("テ", "あ", 좋은태그)), []);

    같나("본문글자수: 해시태그만 있는 줄을 뺀다", [bodyLength("本文\n#a #b"), bodyLength("あ\n\n#t"), bodyLength("#a"), bodyLength("")], [2, 2, 0, 0]);
    같나("본문글자수: 이모지도 한 글자로", bodyLength("😀😀"), 2);
  }

  구역("문안 점검 — 해시태그 줄 · 태그 한도 · 정리");
  {
    for (const [글, 바람] of [["#a #b", true], ["  #a   #b  ", true], ["#한글태그", true], ["#a b", false], ["본문 #a", false], ["", false], ["#", false], ["# a", false], ["#a#b", true]] as const) {
      같나(`해시줄 판정 「${글}」`, HASH_LINE.test(글), 바람);
    }
    const 시작 = performance.now();
    HASH_LINE.test("#a ".repeat(5000) + "x");
    HASH_LINE.test("#" + "a".repeat(200_000) + " c");
    참인가("★나쁜 입력에도 순식간에 끝난다(되돌이 없음)", performance.now() - 시작 < 1000);

    같나("fitTags: # 를 떼고 겹침을 빼고 앞에서부터", fitTags(["#a", "b", "a", "c d"], 10), ["a", "b", "c d"]);
    같나("fitTags: 넘치면 거기서 멈춘다(공백 든 낱말은 따옴표 2자)", fitTags(["#a", "b", "c d", "e"], 8), ["a", "b"]);
    같나("fitTags: 빈 값은 건너뛴다", fitTags(["", "  ", "#", "x"]), ["x"]);
    const 많이 = Array.from({ length: 200 }, (_, i) => `tag${String(i).padStart(3, "0")}`);
    const 담김 = fitTags(많이);
    같나("fitTags: 기본 한도는 500자에서 10자 여유 — 6자 낱말은 70개", 담김.length, 70);
    같나("fitTags: 쉼표까지 센 길이가 한도 안", 담김.join(",").length <= 490, true);

    const 규격 = { hashtags: 5, forbid_cta: true, forbid_shorts_tag: true };
    const 정리 = cleanForRule(규격, "テスト", "本文です。\nチャンネル登録お願い\n#古い #タグ\n最後の行  ", ["#shorts", "#a", "#b", "#c", "#d", "#e", "#f"]);
    같나("정리: 구독 줄 · 태그만 있는 줄이 빠지고 앞뒤 공백을 걷는다", 정리.desc, "本文です。\n最後の行");
    같나("정리: #shorts 를 뺀 뒤 다섯 개로 자른다", 정리.tags, ["#a", "#b", "#c", "#d", "#e"]);
    같나("정리: 제목은 그대로", 정리.title, "テスト");
    같나("정리: # 가 없는 태그도 받은 꼴 그대로", cleanForRule(규격, "テ", "あ", ["Shorts", "x", "y"]).tags, ["x", "y"]);
    같나("정리하면 검사를 통과한다", checkText({ ...규격, forbid_hangul: true }, 글꼴(정리.title, 정리.desc, 정리.tags.join(" "))), []);
    같나("정리: 본문 안의 #shorts · 겹친 태그는 고치지 않고 검사가 잡는다(원본과 같다)", checkText(규격, 글꼴("テ", cleanForRule(규격, "テ", "ここで #shorts", ["#a"]).desc, "#a #a #b #c #d")).length >= 2, true);
    같나("정리: 규격이 없으면 그대로", cleanForRule(undefined, "제목", "설명\n#태그", ["#a"]), { title: "제목", desc: "설명\n#태그", tags: ["#a"] });
    같나("정리: 구독 규칙만 켜면 해시태그 줄은 남긴다", cleanForRule({ forbid_cta: true }, "テ", "本文\n구독\n#a", []).desc, "本文\n#a");
  }

  구역("문안 점검 — 폴더의 문안이 제대로 읽히나");
  await 모래상자(async (dir) => {
    const 폴더 = `${dir}/영상폴더`;
    await Deno.mkdir(폴더, { recursive: true });
    await Deno.writeTextFile(`${폴더}/좋음.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/좋음.txt`, "[제목]\n좋은 제목\n\n[설명]\n좋은 설명\n둘째 줄\n\n[해시태그]\n#하나 #둘\n");
    await Deno.writeTextFile(`${폴더}/문안없음.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/제목없음.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/제목없음.txt`, "[설명]\n설명만 있다\n\n[해시태그]\n#태그\n");
    await Deno.writeTextFile(`${폴더}/태그없음.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/태그없음.txt`, "[제목]\n제목이 여기 있다\n\n[설명]\n설명이 여기 있다\n");
    await Deno.writeTextFile(`${폴더}/긴제목.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/긴제목.txt`, `[제목]\n${"가".repeat(150)}\n\n[설명]\n설명\n\n[해시태그]\n#a\n`);
    await Deno.writeTextFile(`${폴더}/.숨김.mp4`, "x");
    await Deno.writeTextFile(`${폴더}/메모.txt`, "영상이 아니다");
    await Deno.writeTextFile(`${폴더}/한.mov`, "x");
    await Deno.writeTextFile(`${폴더}/한.txt`, "[제목]\nmov 도 본다\n[설명]\n설명입니다\n[해시태그]\n#a\n");

    const r = await lookFolder(폴더);
    같나("영상 수(숨김 · 영상 아닌 것 제외, mov 포함)", [r.exists, r.videos, r.items.map((x) => x.file)], [true, 6, ["긴제목.mp4", "문안없음.mp4", "제목없음.mp4", "좋음.mp4", "태그없음.mp4", "한.mov"]]);
    같나("손볼 곳이 있는 영상", [r.bad, r.items.filter((x) => !x.ok).map((x) => x.file)], [4, ["긴제목.mp4", "문안없음.mp4", "제목없음.mp4", "태그없음.mp4"]]);
    const 항 = (이름: string) => r.items.find((x) => x.file === 이름)!;
    같나("좋은 영상: 제목 · 설명 첫 줄 · 태그 · 출처", [항("좋음.mp4").title, 항("좋음.mp4").descFirst, 항("좋음.mp4").tags.slice(0, 2), 항("좋음.mp4").source], ["좋은 제목", "좋은 설명", ["하나", "둘"], "좋음.txt"]);
    같나("문안 파일이 없으면 파일 이름이 제목으로 나간다고 말한다", 항("문안없음.mp4").problems, ["문안 파일 없음 — 제목이 파일 이름으로 나갑니다"]);
    같나("제목 항목이 없으면", 항("제목없음.mp4").problems, ["제목을 못 읽었습니다 — [제목] 항목을 확인하세요"]);
    같나("태그가 없으면", 항("태그없음.mp4").problems, ["태그가 없습니다 — #낱말 형태인지 확인하세요"]);
    같나("제목이 100자에서 잘렸으면", 항("긴제목.mp4").problems, ["제목이 100자에서 잘렸습니다"]);
    같나("글자 수는 이모지도 한 글자", 항("좋음.mp4").titleLen, 5);

    const 줄 = formatLook(r);
    참인가("출력: 폴더 머리 · 영상 수", 줄.some((x) => x.includes(`${폴더}   영상 6개`)));
    참인가("출력: 좋은 것은 ✓, 손볼 것은 ✕", 줄.some((x) => x.includes("✓ 좋음.mp4")) && 줄.some((x) => x.includes("✕ 문안없음.mp4")));
    참인가("출력: 제목 · 설명 · 태그 · 출처 줄", 줄.some((x) => x.includes("제목  좋은 제목   [5자]")) && 줄.some((x) => x.includes("태그  하나, 둘   [2개]")) && 줄.some((x) => x.includes("출처  좋음.txt")));
    참인가("출력: 문제는 ⚠ 로", 줄.some((x) => x.includes("⚠ 문안 파일 없음")));
    같나("맺음말: 손볼 곳", formatLookSummary([r]).some((x) => x.includes("영상 6개 중 4개에 손볼 곳이 있습니다.")), true);

    const 없음 = await lookFolder(`${dir}/없는폴더`);
    같나("없는 폴더", [없음.exists, formatLook(없음)], [false, [`  폴더가 없습니다 — ${dir}/없는폴더`]]);
    await Deno.mkdir(`${dir}/빈폴더`);
    같나("영상이 없는 폴더", formatLook(await lookFolder(`${dir}/빈폴더`)), [`  영상이 없습니다 — ${dir}/빈폴더`]);
    같나("맺음말: 볼 영상이 없다", formatLookSummary([없음]).some((x) => x.includes("볼 영상이 없습니다.")), true);
    await Deno.mkdir(`${dir}/좋은폴더`);
    await Deno.writeTextFile(`${dir}/좋은폴더/a.mp4`, "x");
    await Deno.writeTextFile(`${dir}/좋은폴더/a.txt`, "[제목]\n제목입니다\n[설명]\n설명입니다\n[해시태그]\n#a\n");
    같나("맺음말: 모두 좋다", formatLookSummary([await lookFolder(`${dir}/좋은폴더`)]).some((x) => x.includes("영상 1개 모두 문안이 제대로 읽힙니다.")), true);
  });
}

/* ============================================================ 썸네일 */

/** 가짜 구글에 이미지 서버 · 채널 상태 · 썸네일 반영을 얹는다 (가짜구글.ts 는 고치지 않고 handle 만 감싼다) */
class 썸네일가짜 extends 가짜구글 {
  /** 경로 → 그림 바이트 (https://fake.img/<경로>) */
  imgs = new Map<string, Uint8Array>();
  /** channels.list part=status 에 돌려줄 longUploadsStatus (없으면 안 돌려줌) */
  인증상태: string | undefined;
  /** thumbnails.set 뒤 새 그림이 반영되는가 (false 면 옛 그림 그대로 = 반영이 늦는 경우) */
  반영 = true;
  /** thumbnails.set 뒤 영상 제목을 몰래 바꾼다 (다른 정보가 달라지는 경우) */
  몰래바꿀제목: string | undefined;
  private n = 0;
  constructor() {
    super();
    const base = this.handle;
    this.handle = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.host === "fake.img" && this.imgs.has(url.pathname)) {
        this.calls.push({ method: "GET", url: url.toString(), path: url.pathname, query: {}, body: null, auth: "", name: "img" });
        return new Response(new Uint8Array(this.imgs.get(url.pathname)!), { status: 200 });
      }
      const res = await base(input, init);
      if (url.pathname === "/youtube/v3/channels" && url.searchParams.get("part") === "status" && this.인증상태 !== undefined) {
        const j = await res.json();
        for (const it of j.items ?? []) it.status = { longUploadsStatus: this.인증상태 };
        return new Response(JSON.stringify(j), { status: res.status, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/upload/youtube/v3/thumbnails/set" && res.ok) {
        const v = this.videos.get(url.searchParams.get("videoId") ?? "");
        if (v && this.반영) {
          const 경로 = `/new${++this.n}.png`;
          this.imgs.set(경로, init!.body as Uint8Array);
          v.snippet.thumbnails = { maxres: { url: `https://fake.img${경로}` } };
        }
        if (v && this.몰래바꿀제목) v.snippet.title = this.몰래바꿀제목;
      }
      return res;
    };
  }
}

const 권한없음 = { error: { code: 403, message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails.", errors: [{ reason: "forbidden" }] } };

async function 썸네일시험() {
  구역("썸네일 — 그림 머리에서 크기 읽기 (손으로 짠 바이트)");
  {
    같나("PNG", await imageInfoOfBytes(pngHeader(1280, 720)), { format: "PNG", w: 1280, h: 720 });
    같나("PNG: 앞에 다른 조각(CgBI)이 끼어도", await imageInfoOfBytes(pngHeader(640, 360, true)), { format: "PNG", w: 640, h: 360 });
    같나("JPEG", await imageInfoOfBytes(jpegHeader(1920, 1080)), { format: "JPEG", w: 1920, h: 1080 });
    같나("JPEG: 큰 EXIF 와 채움 바이트를 건너뛴다", await imageInfoOfBytes(jpegHeader(1280, 720, 3000)), { format: "JPEG", w: 1280, h: 720 });
    같나("JPEG: 65535 이하의 큰 폭", (await imageInfoOfBytes(jpegHeader(4000, 3000)))?.w, 4000);
    같나("잘린 PNG", await imageInfoOfBytes(pngHeader(1280, 720).subarray(0, 20)), null);
    같나("잘린 JPEG(크기 표식 전에 끊김)", await imageInfoOfBytes(jpegHeader(1280, 720).subarray(0, 40)), null);
    같나("그림이 아닌 글", await imageInfoOfBytes(new TextEncoder().encode("이건 그림이 아니다 이건 그림이 아니다")), null);
    같나("빈 파일", await imageInfoOfBytes(new Uint8Array(0)), null);
    같나("크기가 0 인 PNG 는 모름", await imageInfoOfBytes(pngHeader(0, 0)), null);
    같나("표식이 어긋난 JPEG", await imageInfoOfBytes(new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78, 0x9a])), null);
  }

  await 모래상자(async (dir) => {
    구역("썸네일 — 영상 옆 그림 찾기 · 상세");
    같나("확장자 목록과 한도", [THUMB_EXT, THUMB_MAX], [[".jpg", ".jpeg", ".png"], 2 * 1024 * 1024]);
    const v = `${dir}/영상.mp4`;
    같나("그림이 없으면 null", [await findThumb(v), (await custom(v)).있음], [null, false]);
    같나("없을 때의 상세", await custom(v), { 있음: false, 이름: "", 크기: 0, 넘침: false, 가로: 0, 세로: 0, path: "" });

    await Deno.writeFile(`${dir}/영상.png`, pngHeader(1280, 720));
    같나("png 를 찾는다", await findThumb(v), { path: `${dir}/영상.png` });
    같나("상세: 이름 · 크기 · 가로세로", await custom(v), { 있음: true, 이름: "영상.png", 크기: pngHeader(1280, 720).length, 넘침: false, 가로: 1280, 세로: 720, path: `${dir}/영상.png` });
    await Deno.writeFile(`${dir}/영상.jpg`, jpegHeader(1920, 1080));
    같나("jpg 가 png 보다 먼저", await findThumb(v), { path: `${dir}/영상.jpg` });
    같나("상세도 jpg", (await custom(v)).이름, "영상.jpg");

    await Deno.writeFile(`${dir}/영상.jpg`, 덧붙임(jpegHeader(1920, 1080), THUMB_MAX + 1));
    같나("2MB 를 넘으면 건너뛴다고 알린다(다음 확장자는 찾지 않는다)", await findThumb(v), { skippedBig: `${dir}/영상.jpg` });
    같나("상세: 넘침 표시 · 크기는 읽는다", [(await custom(v)).넘침, (await custom(v)).가로], [true, 1920]);
    await Deno.writeFile(`${dir}/영상.jpg`, 덧붙임(jpegHeader(1920, 1080), THUMB_MAX));
    같나("딱 2MB 는 통과", await findThumb(v), { path: `${dir}/영상.jpg` });

    await Deno.mkdir(`${dir}/폴더.jpg`);
    같나("이름이 같은 폴더는 그림이 아니다", await findThumb(`${dir}/폴더.mp4`), null);
    같나("점이 여럿인 이름은 마지막 확장자만 바꾼다", (await (async () => { await Deno.writeFile(`${dir}/a.b.jpeg`, jpegHeader(640, 360)); return findThumb(`${dir}/a.b.mp4`); })()), { path: `${dir}/a.b.jpeg` });
    같나("imageInfo 는 파일의 머리만 읽는다", await imageInfo(`${dir}/a.b.jpeg`), { format: "JPEG", w: 640, h: 360 });
    같나("없는 파일은 null", await imageInfo(`${dir}/없음.jpg`), null);
  });

  구역("썸네일 — 올리기 (2MB · 확장자 · 그림 내용으로 정한 종류)");
  await 모래상자(async (dir) => {
    const fake = new 썸네일가짜().install();
    await 채널차리기(fake, dir);
    const yt = await ytFor("채널A");
    fake.addVideo({ id: "v1", channelId: CID });
    const 그림 = `${dir}/폴더A/그림.jpg`;
    await Deno.writeFile(그림, jpegHeader(1280, 720));

    const ok = await setThumbnailFor(yt, "v1", 그림);
    같나("올렸다", [ok.ok, ok.message], [true, "썸네일 올림 — 그림.jpg"]);
    같나("가짜 서버가 받은 것: 영상 · 종류", fake.thumbs.map((t) => [t.videoId, t.mime]), [["v1", "image/jpeg"]]);

    await Deno.writeFile(`${dir}/폴더A/가짜.jpg`, pngHeader(1280, 720));
    await setThumbnailFor(yt, "v1", `${dir}/폴더A/가짜.jpg`);
    같나("이름은 .jpg 여도 내용이 PNG 면 PNG 로 보낸다", fake.thumbs.at(-1)!.mime, "image/png");
    await Deno.writeFile(`${dir}/폴더A/모름.png`, new TextEncoder().encode("그림 아님"));
    await setThumbnailFor(yt, "v1", `${dir}/폴더A/모름.png`);
    같나("내용을 모르면 확장자를 따른다", fake.thumbs.at(-1)!.mime, "image/png");

    const 앞 = fake.thumbs.length;
    const 큼 = `${dir}/폴더A/큼.png`;
    await Deno.writeFile(큼, 덧붙임(pngHeader(1280, 720), THUMB_MAX + 1));
    const r1 = await setThumbnailFor(yt, "v1", 큼);
    같나("2MB 넘음: 보내지 않고 이유를 말한다", [r1.ok, r1.message.includes("2MB를 넘습니다"), fake.thumbs.length], [false, true, 앞]);
    const r2 = await setThumbnailFor(yt, "v1", `${dir}/폴더A/그림.gif`);
    같나("확장자가 안 맞으면 보내지 않는다", [r2.ok, r2.message.includes("jpg · jpeg · png"), fake.thumbs.length], [false, true, 앞]);
    const r3 = await setThumbnailFor(yt, "v1", `${dir}/폴더A/없음.png`);
    같나("파일이 없으면", [r3.ok, r3.message.includes("찾을 수 없습니다"), fake.thumbs.length], [false, true, 앞]);
    await Deno.writeFile(`${dir}/폴더A/빈.png`, new Uint8Array(0));
    같나("빈 파일", (await setThumbnailFor(yt, "v1", `${dir}/폴더A/빈.png`)).message.includes("비어 있습니다"), true);

    fake.failNext(/thumbnails\/set/, 403, 권한없음, 1);
    const r4 = await setThumbnailFor(yt, "v1", 그림);
    같나("유튜브가 거절하면 던지지 않고 까닭을 돌려준다", [r4.ok, r4.message], [false, "썸네일은 못 올렸습니다 — 403 The authenticated user doesn't have permissions to upload and set custom video thumbnails."]);
    참인가("원래 오류도 함께 준다(표식에 넘길 수 있게)", !!r4.error);
    같나("failureReason: 유튜브 오류", failureReason(r4.error), "403 The authenticated user doesn't have permissions to upload and set custom video thumbnails.");
    같나("failureReason: 일반 오류", failureReason(new TypeError("fetch failed\n줄바꿈")), "TypeError: fetch failed 줄바꿈");
    같나("failureReason: 150자에서 자른다", failureReason(new Error("가".repeat(300))).length, 150);
    같나("failureReason: 글", failureReason("그냥 글"), "그냥 글");
  });

  구역("썸네일 — 실패 표식 → 다시 붙이기 → 성공하면 표식 제거");
  await 환경바꾸고({ TELEGRAM_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, async () => {
    await 모래상자(async (dir) => {
      const fake = new 썸네일가짜().install();
      await 채널차리기(fake, dir);
      await 텔레그램설정쓰기([111]);
      fake.addVideo({ id: "v1", channelId: CID });
      const 영상 = `${dir}/폴더A/영상1.mp4`;
      const 그림 = `${dir}/폴더A/영상1.jpg`;
      await Deno.writeTextFile(영상, "영상");
      await Deno.writeFile(그림, jpegHeader(1280, 720));
      const yt = await ytFor("채널A");

      같나("표식이 없으면 유튜브를 한 번도 안 부른다", [await retryPending(), fake.calls.length], [{ 확인: 0, 붙임: 0, 실패: 0, 포기: 0, 대기: 0, 인증대기: 0 }, 0]);

      fake.failNext(/thumbnails\/set/, 403, 권한없음, 1);
      const 실패 = await setThumbnailFor(yt, "v1", 그림);
      await recordFailure("채널A", 영상, "v1", 그림, 실패.error);
      const 표식 = await loadPending();
      같나("표식 하나", 표식.map((x) => [x.video_id, x.채널, x.파일, x.시도, x.다음시도]), [["v1", "채널A", "영상1.mp4", 0, null]]);
      참인가("까닭 · 시각 · sha", 표식[0].까닭.startsWith("403 ") && /^\d{4}-\d{2}-\d{2}T/.test(표식[0].시각) && /^[0-9a-f]{64}$/.test(표식[0].썸네일_sha256));
      참인가("그림 사본을 데이터 폴더에 남긴다", !!표식[0].보관본 && (await Deno.readFile(표식[0].보관본!)).length === jpegHeader(1280, 720).length);
      참인가("올리기.log 에 한 줄", (await 읽기(recordPath("올리기.log"))).includes("썸네일실패 [채널A] 영상1.mp4 v1 403 The authenticated user"));
      let 글 = fake.telegram.at(-1)!.text;
      참인가("텔레그램: 머리 · 주소 · 인증 안내", 글.startsWith("⚠️ 썸네일 실패\n채널  채널A") && 글.includes("https://youtu.be/v1") && 글.includes("채널 전화번호 인증이 먼저 필요합니다"));

      // 같은 영상의 표식은 하나만 — 새 것으로 바뀐다
      await recordFailure("채널A", 영상, "v1", 그림, new Error("두 번째 실패"));
      같나("같은 영상은 하나로 합친다", (await loadPending()).map((x) => x.까닭), ["Error: 두 번째 실패"]);
      글 = fake.telegram.at(-1)!.text;
      참인가("403 이 아니면 인증 안내를 안 붙인다", !글.includes("전화번호 인증"));

      // 영상과 곁 파일이 옮겨진 뒤에도 사본으로 붙인다
      await Deno.remove(영상);
      await Deno.remove(그림);
      fake.clearCalls();
      fake.telegram.length = 0;
      const 요약 = await retryPending();
      같나("다시 붙였다", 요약, { 확인: 1, 붙임: 1, 실패: 0, 포기: 0, 대기: 0, 인증대기: 0 });
      같나("유튜브 호출: 채널 상태 확인 + 썸네일 한 번", [fake.callsTo(/thumbnails/).length, fake.thumbs.map((t) => [t.videoId, t.mime])], [1, [["v1", "image/jpeg"]]]);
      같나("표식이 지워졌다", await loadPending(), []);
      같나("그림 사본도 지워졌다", await Deno.stat(표식[0].보관본!).then(() => true, () => false), false);
      참인가("성공이 기록에 남는다", (await 읽기(recordPath("올리기.log"))).includes("썸네일재시도성공 [채널A] 영상1.mp4 v1 1번째"));
      같나("성공 알림", fake.telegram.map((t) => t.text.split("\n")[0]), ["✅ 썸네일 붙음"]);

      fake.clearCalls();
      같나("다시 비면 호출 0건", [(await retryPending()).확인, fake.calls.length], [0, 0]);
    });

    // 실패마다 간격이 늘고 3번째에 알리고 6번째에 포기한다
    await 모래상자(async (dir) => {
      const fake = new 썸네일가짜().install();
      await 채널차리기(fake, dir);
      await 텔레그램설정쓰기([111]);
      fake.addVideo({ id: "v1", channelId: CID });
      const 그림 = `${dir}/폴더A/영상1.png`;
      await Deno.writeFile(그림, pngHeader(1280, 720));
      await recordFailure("채널A", `${dir}/폴더A/영상1.mp4`, "v1", 그림, new Error("처음 실패"));
      fake.failNext(/thumbnails\/set/, 500, { error: { code: 500, message: "backend error", errors: [{ reason: "backendError" }] } }, 99);
      fake.telegram.length = 0;

      const 기다림 = async () => {
        const e = (await loadPending())[0];
        return Math.round((parseWall(e.다음시도!)!.getTime() - parseWall(e.마지막확인!)!.getTime()) / 60000);
      };
      const 시각당기기 = async () => {
        const raw = await readJson<Record<string, unknown>[]>(pendingPath(), []);
        raw[0].다음시도 = isoWall(addMinutes(wallNow(), -1));
        await writeJson(pendingPath(), raw);
      };

      같나("재시도 간격 표", [RETRY_WAIT_MIN, MAX_ATTEMPTS], [[10, 30, 60, 120, 240], 6]);
      const 기다린분: number[] = [];
      for (let n = 1; n < MAX_ATTEMPTS; n++) {
        const s = await retryPending();
        같나(`${n}번째 재시도는 실패로 미룬다`, [s.확인, s.실패, s.포기], [1, 1, 0]);
        기다린분.push(await 기다림());
        같나(`${n}번째 실패 뒤 시도 횟수`, (await loadPending())[0].시도, n);
        if (n === 1) {
          const 또 = await retryPending();
          같나("다음 시도 시각 전에는 건드리지 않는다", [또.확인, 또.대기, fake.callsTo(/thumbnails/).length], [0, 1, 1]);
        }
        await 시각당기기();
      }
      같나("간격이 늘어난다(10 → 30 → 60 → 120 → 240분)", 기다린분, [10, 30, 60, 120, 240]);
      같나("3번째 실패에서 한 번만 알린다", fake.telegram.map((t) => t.text.split("\n")[0]), ["⚠️ 썸네일 아직 안 붙음"]);

      fake.telegram.length = 0;
      const 마지막 = await retryPending();
      같나("6번째 실패에서 포기한다", [마지막.포기, 마지막.실패], [1, 0]);
      같나("표식에서 뺀다", await loadPending(), []);
      같나("썸네일은 여섯 번만 보냈다", fake.callsTo(/thumbnails/).length, 6);
      같나("포기 알림 한 번", fake.telegram.map((t) => t.text.split("\n")[0]), ["⚠️ 썸네일 포기"]);
      참인가("포기 알림에 그림 사본 자리가 있다", fake.telegram[0].text.includes("그림 사본:"));
      const 기록 = await 읽기(recordPath("올리기.log"));
      참인가("기록에 재시도 실패와 포기가 남는다", 기록.includes("썸네일재시도실패 [채널A] 영상1.mp4 v1 5번째") && 기록.includes("썸네일포기 [채널A] 영상1.mp4 v1 6번 실패"));
      같나("포기한 뒤에는 더 시도할 것이 없다", (await retryPending()).확인, 0);
      같나("그림 사본은 남긴다(사람이 직접 올릴 때 쓰도록)", (await 파일들(dataPath("썸네일대기"))).length, 1);
      // 브리핑이 포기를 「살펴봄」으로 띄운다
      const b = await collect();
      같나("브리핑: 포기만 사람에게 보인다(실패 · 재시도 줄은 안 보인다)", b.map((x) => x.무슨일), ["썸네일이 끝내 안 붙었습니다"]);
    });

    // 인증 전 채널은 보내지 않고 기다린다
    await 모래상자(async (dir) => {
      const fake = new 썸네일가짜().install();
      await 채널차리기(fake, dir);
      await 텔레그램설정쓰기([111]);
      fake.addVideo({ id: "v1", channelId: CID });
      const 그림 = `${dir}/폴더A/영상1.jpg`;
      await Deno.writeFile(그림, jpegHeader(1280, 720));
      await recordFailure("채널A", `${dir}/폴더A/영상1.mp4`, "v1", 그림, new Error("403 thumbnails"));
      fake.인증상태 = "eligible";
      fake.clearCalls();
      const s = await retryPending();
      같나("인증 전: 기다린다", [s.인증대기, s.붙임, s.실패], [1, 0, 0]);
      같나("썸네일은 보내지 않았다(보내 봤자 403)", fake.callsTo(/thumbnails/).length, 0);
      const e = (await loadPending())[0];
      같나("실패 횟수에 안 센다", e.시도, 0);
      참인가("까닭에 인증 안내", e.까닭.includes("전화번호 인증 필요") && e.까닭.includes("eligible"));
      참인가("한 시간 뒤에 다시 본다", Math.round((parseWall(e.다음시도!)!.getTime() - wallNow().getTime()) / 60000) >= 58);
      const 이어 = await retryPending();
      같나("시각 전이라 다시 묻지도 않는다", [이어.확인, 이어.대기], [0, 1]);

      fake.인증상태 = "allowed";
      const raw = await readJson<Record<string, unknown>[]>(pendingPath(), []);
      raw[0].다음시도 = isoWall(addMinutes(wallNow(), -1));
      await writeJson(pendingPath(), raw);
      같나("사람이 인증하면 저절로 붙는다", [(await retryPending()).붙임, fake.callsTo(/thumbnails/).length, await loadPending()], [1, 1, []]);
    });

    // 그림이 없거나 달라졌거나 채널이 없어졌을 때 — 유튜브를 부르지 않고 횟수만 센다
    await 모래상자(async (dir) => {
      const fake = new 썸네일가짜().install();
      await 채널차리기(fake, dir);
      await 텔레그램설정쓰기([111]);
      fake.addVideo({ id: "v1", channelId: CID });
      await recordFailure("채널A", `${dir}/폴더A/a.mp4`, "v1", `${dir}/폴더A/없는그림.jpg`, new Error("그림이 없었다"));
      같나("그림이 없어도 표식은 남는다(사본 없음)", (await loadPending())[0].보관본, undefined);
      fake.clearCalls();
      const s = await retryPending();
      같나("그림이 없으면 실패로 센다", [s.실패, fake.calls.length], [1, 0]);
      참인가("까닭이 말해 준다", (await loadPending())[0].까닭.startsWith("썸네일 그림을 못 찾음"));

      const 그림 = `${dir}/폴더A/b.jpg`;
      await Deno.writeFile(그림, jpegHeader(1280, 720));
      await recordFailure("채널A", `${dir}/폴더A/b.mp4`, "v2", 그림, new Error("x"));
      const 사본 = (await loadPending()).find((x) => x.video_id === "v2")!.보관본!;
      await Deno.writeFile(사본, jpegHeader(640, 360)); // 사본이 다른 그림으로 바뀌었다
      await Deno.remove(그림);
      const t = await retryPending();
      참인가("기록된 sha 와 다르면 붙이지 않는다", (await loadPending()).find((x) => x.video_id === "v2")!.까닭.includes("sha 와 다르다") && t.실패 >= 1);
      같나("다른 판의 그림은 보내지 않았다", fake.thumbs.length, 0);

      const 그림3 = `${dir}/폴더A/c.jpg`;
      await Deno.writeFile(그림3, jpegHeader(1280, 720));
      await recordFailure("없어진채널", `${dir}/폴더A/c.mp4`, "v3", 그림3, new Error("x"));
      const raw = await readJson<Record<string, unknown>[]>(pendingPath(), []);
      for (const r of raw) r.다음시도 = isoWall(addMinutes(wallNow(), -1));
      await writeJson(pendingPath(), raw);
      await retryPending();
      참인가("채널을 찾을 수 없으면 실패로 센다", (await loadPending()).find((x) => x.video_id === "v3")!.까닭.startsWith("채널 도구를 만들지 못함"));
    });

    // 겹쳐 돌지 않는다 · 도는 사이 쌓인 표식을 잃지 않는다
    await 모래상자(async (dir) => {
      const fake = new 썸네일가짜().install();
      await 채널차리기(fake, dir);
      fake.addVideo({ id: "v1", channelId: CID });
      const 그림 = `${dir}/폴더A/영상1.jpg`;
      await Deno.writeFile(그림, jpegHeader(1280, 720));
      await recordFailure("채널A", `${dir}/폴더A/영상1.mp4`, "v1", 그림, new Error("x"));
      const [a, b] = await Promise.all([retryPending(), retryPending()]);
      같나("동시에 두 번 불러도 한 번만 돈다", a.확인 + b.확인, 1);
      같나("썸네일은 한 번만 보냈다", fake.thumbs.length, 1);

      await Deno.writeTextFile(pendingPath(), JSON.stringify([{ 이건: "알아볼 수 없는 칸" }]));
      await recordFailure("채널A", `${dir}/폴더A/영상2.mp4`, "v9", 그림, new Error("y"));
      const 파일 = JSON.parse(await Deno.readTextFile(pendingPath()));
      같나("알아볼 수 없는 칸은 지우지 않고 그대로 둔다", [파일.length, 파일.some((x: Record<string, unknown>) => x["이건"] === "알아볼 수 없는 칸")], [2, true]);
    });
  });

  구역("썸네일 — 이미 올라간 영상의 점검 · 교체 (ffmpeg 로 같은 그림인지 잰다)");
  await 모래상자(async (dir) => {
    if (!(await findTool("ffmpeg"))) {
      console.log("  (ffmpeg 가 없어 이 구역은 건너뜁니다 — 설치하면 시험됩니다)");
      return;
    }
    const 빨강 = await makePng(1280, 720, [200, 30, 30]);
    const 파랑 = await makePng(1280, 720, [30, 30, 200]);
    const fake = new 썸네일가짜().install();
    await 채널차리기(fake, dir);
    fake.imgs.set("/old.png", 빨강);
    fake.addVideo({ id: "v1", channelId: CID, snippet: { title: "원래 제목", description: "설명", tags: ["a"], thumbnails: { maxres: { url: "https://fake.img/old.png" } } } });
    fake.addVideo({ id: "v2", channelId: CID, snippet: { title: "다른 채널 것처럼 보임", channelId: "UC" + "y".repeat(22), thumbnails: { maxres: { url: "https://fake.img/old.png" } } } });
    const 새그림 = `${dir}/새그림.png`;
    await Deno.writeFile(새그림, 파랑);
    const 같은그림 = `${dir}/같은그림.png`;
    await Deno.writeFile(같은그림, 빨강);
    const 결과폴더 = (n: string) => `${dir}/결과/${n}`;
    const 보낸수 = () => fake.callsTo(/thumbnails\/set/).length;

    // 점검: 원장의 롱폼만
    await appendLedger({ 업로드시각: "2026-10-01T09:00:00", 채널: "채널A", 영상ID: "v1", 제목: "롱폼", 길이초: "300.0", 해상도: "1920x1080" });
    await appendLedger({ 업로드시각: "2026-10-01T09:00:00", 채널: "채널A", 영상ID: "vS", 제목: "쇼츠", 길이초: "30.0", 해상도: "1080x1920" });
    await appendLedger({ 업로드시각: "2026-10-01T09:00:00", 채널: "채널Z", 영상ID: "vZ", 제목: "남의 채널", 길이초: "400.0", 해상도: "1920x1080" });
    await appendLedger({ 업로드시각: "2026-10-02T09:00:00", 채널: "채널A", 영상ID: "v1", 제목: "롱폼(다시)", 길이초: "300.0", 해상도: "1920x1080" });
    const 점검 = await inspectLongforms("채널A", 결과폴더("점검"));
    같나("점검: 롱폼만 · 중복 없이", 점검.videos, [{ id: "v1", title: "원래 제목", privacy: "public" }]);
    같나("점검: 보관한 파일", await 파일들(점검.directory), ["before.json", "ledger_rows.json", "original_thumbnails.json", "v1_before.jpg"]);
    같나("점검: 원장 줄 둘(같은 영상이 두 번 올라간 기록)", (await readJson<unknown[]>(`${점검.directory}/ledger_rows.json`, [])).length, 2);
    같나("점검은 읽기뿐이다(썸네일 요청 없음)", 보낸수(), 0);
    await 던지나("결과 폴더가 이미 있으면 덮지 않는다", () => inspectLongforms("채널A", 결과폴더("점검")), /이미 있습니다/);
    await 던지나("등록되지 않은 채널", () => inspectLongforms("없는채널"), /등록된 채널 이름을 지정하세요/);

    // 미리보기
    const 미리 = await replaceThumbnail("채널A", "v1", 새그림, { outDir: 결과폴더("미리") });
    같나("미리보기: 상태 · 메시지", [미리.status, 미리.message.startsWith("미리보기 — 원격 변경 없음")], ["preview", true]);
    같나("미리보기: 보관한 파일", await 파일들(미리.directory), ["before.json", "original_thumbnails.json", "request.json", "v1_before.jpg"]);
    const 요청 = await readJson<Record<string, unknown>>(`${미리.directory}/request.json`, {});
    같나("미리보기: 요청서", [요청.video_id, 요청.channel_id, 요청.size, 요청.submitted, 요청.automatic_retry, String(요청.sha256).length], ["v1", CID, [1280, 720], false, false, 64]);
    같나("미리보기는 아무것도 안 보낸다", 보낸수(), 0);

    // 안전 장치
    await 던지나("영상의 채널이 다르면 멈춘다", () => replaceThumbnail("채널A", "v2", 새그림, { outDir: 결과폴더("다른채널") }), /실제 채널이 요청한 채널과 다릅니다/);
    같나("멈추면 결과 폴더도 만들지 않는다", await Deno.stat(결과폴더("다른채널")).then(() => true, () => false), false);
    await 던지나("없는 영상", () => replaceThumbnail("채널A", "없는영상", 새그림, { outDir: 결과폴더("없음") }), /영상을 찾을 수 없습니다/);
    await 던지나("영상ID 가 없다", () => replaceThumbnail("채널A", "", 새그림), /영상ID와 썸네일 파일/);
    await 던지나("작은 그림(640 미만)", async () => replaceThumbnail("채널A", "v1", await (async () => { const p = `${dir}/작음.png`; await Deno.writeFile(p, await makePng(320, 180, [1, 2, 3])); return p; })(), { outDir: 결과폴더("작음") }), /640px 이상, 16:9 JPEG\/PNG/);
    await 던지나("16:9 가 아닌 그림", async () => replaceThumbnail("채널A", "v1", await (async () => { const p = `${dir}/사분삼.png`; await Deno.writeFile(p, await makePng(800, 600, [1, 2, 3])); return p; })(), { outDir: 결과폴더("사분삼") }), /16:9/);
    await 던지나("그림이 아닌 파일", async () => replaceThumbnail("채널A", "v1", await (async () => { const p = `${dir}/글.png`; await Deno.writeTextFile(p, "그림 아님"); return p; })(), { outDir: 결과폴더("글") }), /640px 이상, 16:9 JPEG\/PNG/);
    await 던지나("2MB 를 넘는 그림", async () => replaceThumbnail("채널A", "v1", await (async () => { const p = `${dir}/큼.png`; await Deno.writeFile(p, await makePng(1280, 720, [1, 2, 3], THUMB_MAX)); return p; })(), { outDir: 결과폴더("큼") }), /2MB를 넘습니다/);
    같나("안전 장치에 걸린 동안 아무것도 안 보냈다", 보낸수(), 0);

    // 이미 같은 그림이면 보내지 않는다
    const 같음 = await replaceThumbnail("채널A", "v1", 같은그림, { apply: true, outDir: 결과폴더("같음"), waitMs: 0 });
    같나("이미 같은 그림: 보내지 않는다", [같음.status, 보낸수(), (await readJson<Record<string, unknown>>(`${같음.directory}/result.json`, {})).status], ["already_matches", 0, "already_matches"]);

    // ffmpeg 가 없으면 비교할 수 없어 아무것도 보내지 않고 멈춘다
    forceToolMissing("ffmpeg");
    let 막힘: ThumbError | null = null;
    try { await replaceThumbnail("채널A", "v1", 새그림, { apply: true, outDir: 결과폴더("ffmpeg없음") }); } catch (e) { 막힘 = e as ThumbError; }
    참인가("ffmpeg 없이 교체하라고 하면 멈추고 이유를 말한다", 막힘 instanceof ThumbError && 막힘.message.includes("ffmpeg"));
    같나("멈췄으니 보내지 않았다", 보낸수(), 0);
    같나("멈춘 까닭을 결과 파일에 남긴다", (await readJson<Record<string, unknown>>(결과폴더("ffmpeg없음") + "/result.json", {})).submitted, false);
    같나("미리보기는 ffmpeg 없이도 된다", (await replaceThumbnail("채널A", "v1", 새그림, { outDir: 결과폴더("미리2") })).status, "preview");
    resetToolCache();

    // 지금 걸린 그림을 못 읽으면 같은지 비교할 수 없으니 보내지 않는다(원본은 이때 예외로 멈췄다)
    fake.imgs.set("/broken.png", new TextEncoder().encode("PNG 가 아닌 깨진 내용"));
    fake.addVideo({ id: "v3", channelId: CID, snippet: { title: "깨진 그림", thumbnails: { maxres: { url: "https://fake.img/broken.png" } } } });
    let 못읽음: ThumbError | null = null;
    try { await replaceThumbnail("채널A", "v3", 새그림, { apply: true, outDir: 결과폴더("못읽음"), waitMs: 0 }); } catch (e) { 못읽음 = e as ThumbError; }
    참인가("못 읽으면 멈추고 이유를 말한다", 못읽음 instanceof ThumbError && 못읽음.message.includes("비교할 수 없습니다") && 못읽음.message.includes("교체하지 않았습니다"));
    같나("못 읽어서 멈췄으니 보내지 않았다", 보낸수(), 0);
    같나("멈춘 까닭을 남긴다", (await readJson<Record<string, unknown>>(결과폴더("못읽음") + "/result.json", {})).status, "stopped_cannot_compare");

    // 거절당하면 거절 모습을 남기고 던진다
    fake.failNext(/thumbnails\/set/, 429, { error: { code: 429, message: "limit", errors: [{ reason: "uploadRateLimitExceeded" }] } }, 1);
    let 거절: ThumbError | null = null;
    try { await replaceThumbnail("채널A", "v1", 새그림, { apply: true, outDir: 결과폴더("거절"), waitMs: 0 }); } catch (e) { 거절 = e as ThumbError; }
    참인가("거절: 던진다", 거절 instanceof ThumbError && 거절.message.includes("거절됐습니다") && 거절.message.includes("429"));
    const 거절결과 = await readJson<Record<string, unknown>>(결과폴더("거절") + "/result.json", {});
    같나("거절: 하루 한도에 걸린 모습", [거절결과.status, 거절결과.http_status, 거절결과.youtube_reason, 거절결과.retry_after_limit_clears, 거절결과.automatic_retry], ["rejected_thumbnail_rate_limit", 429, "uploadRateLimitExceeded", true, false]);
    같나("거절돼도 요청서에는 보냈다고 적혀 있다", (await readJson<Record<string, unknown>>(결과폴더("거절") + "/request.json", {})).submitted, true);
    같나("자동으로 다시 보내지 않는다", 보낸수(), 1);

    // 교체 성공
    const 앞수 = 보낸수();
    const 교체 = await replaceThumbnail("채널A", "v1", 새그림, { apply: true, outDir: 결과폴더("교체"), waitMs: 0 });
    같나("교체: 확인까지 끝남", [교체.status, 교체.similarity?.matches, 보낸수() - 앞수], ["verified", true, 1]);
    같나("교체: 보낸 그림의 종류", fake.thumbs.at(-1)!.mime, "image/png");
    같나("교체: 남긴 파일", await 파일들(교체.directory), ["after.jpg", "after.json", "before.json", "original_thumbnails.json", "request.json", "response.json", "result.json", "v1_before.jpg"]);
    const 요청2 = await readJson<Record<string, unknown>>(`${교체.directory}/request.json`, {});
    참인가("교체: 요청서에 보냈다고 + 보낸 시각", 요청2.submitted === true && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(String(요청2.submitted_at)));
    같나("교체: 결과", await readJson(`${교체.directory}/result.json`, {}), { status: "verified", thumbnail_similarity: { mean_absolute_rgb_error: 0, matches: true }, other_metadata_unchanged: true, automatic_retry: false });
    같나("교체: 원본 썸네일은 옛 그림 그대로 보관", (await Deno.readFile(`${교체.directory}/v1_before.jpg`)).length, 빨강.length);
    같나("교체 뒤 제목은 그대로", fake.videos.get("v1")!.snippet.title, "원래 제목");

    // 한 번 더 같은 그림이면 이미 같다
    const 또 = await replaceThumbnail("채널A", "v1", 새그림, { apply: true, outDir: 결과폴더("또"), waitMs: 0 });
    같나("교체한 그림으로 다시 하면 이미 같다", [또.status, 보낸수() - 앞수], ["already_matches", 1]);

    // 반영이 늦으면 받아들여졌지만 확인 못 했다고 한다
    fake.반영 = false;
    const 늦음 = await replaceThumbnail("채널A", "v1", 같은그림, { apply: true, outDir: 결과폴더("늦음"), waitMs: 0 });
    같나("반영이 늦으면", [늦음.status, 늦음.similarity?.matches, (await readJson<Record<string, unknown>>(`${늦음.directory}/result.json`, {})).status], ["accepted_pending_thumbnail_propagation", false, "accepted_pending_thumbnail_propagation"]);
    참인가("늦어도 다시 보내지 않는다", 보낸수() - 앞수 === 2);
    fake.반영 = true;

    // 썸네일 말고 다른 정보가 바뀌면 멈춘다
    fake.몰래바꿀제목 = "몰래 바뀐 제목";
    let 바뀜: ThumbError | null = null;
    try { await replaceThumbnail("채널A", "v1", 같은그림, { apply: true, outDir: 결과폴더("바뀜"), waitMs: 0 }); } catch (e) { 바뀜 = e as ThumbError; } // 지금 걸린 건 파랑이라 빨강은 다른 그림이다
    참인가("다른 정보가 달라졌으면 멈춘다", 바뀜 instanceof ThumbError && 바뀜.message.includes("썸네일 외 원격 정보가 달라졌습니다"));
  });
}

/* ============================================================ 환경 점검 */

async function 환경시험() {
  구역("환경 점검");
  await 모래상자(async (dir) => {
    const r = await report();
    같나("이상 없음", [r.ok, r.problems], [true, []]);
    같나("운영체제 · 구조 · 앱 버전", [r.os, r.arch, r.osName.length > 0, r.appVersion], [Deno.build.os, Deno.build.arch, true, "2.0.0"]);
    같나("개발 모드로 돌고 있다", r.compiled, false);
    같나("데이터 폴더에 쓸 수 있다", [r.dataDir, r.dataDirWritable, r.dataDirExists], [`${dir}/데이터`, true, true]);
    같나("점검 중에 남긴 시험 파일이 없다", (await Array.fromAsync(Deno.readDir(`${dir}/데이터`))).filter((e) => e.name.includes("쓰기시험")).length, 0);
    같나("점검 파일 여섯 · 모두 필수가 아니다", [r.files.map((f) => f.name), r.files.some((f) => f.required)], [["channels.json", "tokens.json", "client_secret.json", "device_secret.json", "policy.json", "ledger.csv"], false]);
    같나("처음에는 모두 없다", r.files.every((f) => !f.present), true);
    참인가("policy.json 은 없어도 동작한다고 말한다", r.files.find((f) => f.name === "policy.json")!.note.includes("없어도 동작합니다"));
    참인가("열쇠 파일이 없다고 알려 준다", r.notes.some((n) => n.includes("열쇠 파일이 아직 없습니다")));

    await Deno.writeTextFile(dataPath("policy.json"), "{}");
    await Deno.writeTextFile(dataPath("client_secret.json"), "{}");
    const r2 = await report();
    같나("있는 파일은 있다고", r2.files.filter((f) => f.present).map((f) => f.name), ["client_secret.json", "policy.json"]);
    같나("열쇠 파일이 생기면 안내가 사라진다", r2.notes.some((n) => n.includes("열쇠 파일이 아직 없습니다")), false);

    forceToolMissing("ffprobe");
    forceToolMissing("ffmpeg");
    const r3 = await report();
    같나("ffprobe 가 없어도 실패가 아니다(내장 판독기)", [r3.ok, r3.prober, r3.ffprobe, r3.ffmpeg], [true, "내장 판독기", "", ""]);
    참인가("없는 도구를 알려 준다", r3.notes.some((n) => n.includes("ffprobe")) && r3.notes.some((n) => n.includes("ffmpeg")));
    resetToolCache();

    const 줄 = formatReport(r2);
    참인가("출력: 머리 · 운영체제 · 데이터 폴더", 줄[0].startsWith("환경 점검 — ") && 줄.some((x) => x.includes("운영체제")) && 줄.some((x) => x.includes(`${dir}/데이터`)));
    참인가("출력: 쓸 수 있음 · 결과", 줄.some((x) => x.includes("✓ 쓸 수 있음")) && 줄.at(-1)!.includes("이상 없음"));
    참인가("출력: 있는 파일은 ✓, 없는 파일은 · 와 안내", 줄.some((x) => x.includes("✓ policy.json — 있음")) && 줄.some((x) => x.includes("· tokens.json — 없음  (")));
  });

  await 모래상자(async (dir) => {
    // 데이터 폴더가 아직 없으면 만들지 않고, 위쪽 폴더에 쓸 수 있는지만 본다
    await Deno.remove(`${dir}/데이터`, { recursive: true });
    const r = await report();
    같나("폴더가 없어도 만들 수 있으면 이상 없음", [r.ok, r.dataDirExists, r.dataDirWritable], [true, false, true]);
    같나("점검이 폴더를 만들지 않았다", await Deno.stat(`${dir}/데이터`).then(() => true, () => false), false);
    참인가("안내가 있다", r.dataDirNote.includes("아직 없습니다"));
  });

  await 모래상자(async (dir) => {
    await Deno.remove(`${dir}/데이터`, { recursive: true });
    await Deno.writeTextFile(`${dir}/데이터`, "폴더 자리에 놓인 파일");
    const r = await report();
    같나("데이터 폴더 자리에 파일이 있으면 문제로 잡는다", [r.ok, r.dataDirWritable, r.problems[0]?.includes("파일이 있습니다")], [false, false, true]);
    await Deno.remove(`${dir}/데이터`);
    await Deno.mkdir(`${dir}/데이터/기록`, { recursive: true }); // 모래상자가 뒷정리할 수 있게 돌려놓는다
  });

  if (Deno.build.os !== "windows" && Deno.uid() !== 0) {
    await 모래상자(async (dir) => {
      await Deno.chmod(`${dir}/데이터`, 0o500);
      try {
        const r = await report();
        같나("쓸 수 없는 폴더는 문제로 잡는다", [r.ok, r.dataDirWritable, r.problems.length], [false, false, 1]);
        참인가("출력: 고칠 곳", formatReport(r).some((x) => x.includes("고칠 곳 1개")) && formatReport(r).some((x) => x.includes("✕ 쓸 수 없음")));
      } finally {
        await Deno.chmod(`${dir}/데이터`, 0o700);
      }
    });
  }
}

/* ============================================================ 실행 */

export async function 실행() {
  await 알림시험();
  await 브리핑시험();
  await 휴지통시험();
  await 보관시험();
  await 백업시험();
  await 문안시험();
  await 썸네일시험();
  await 환경시험();
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

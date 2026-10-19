// 인스타그램·스레드 시험 — 글 만들기 · 영상 규격 · 로그인 · 토큰 갱신 · 올리기 · 두 번 올리지 않기 · 훅 · 화면 길.
// 실제 메타·중계 서버·임시 보관에는 한 번도 닿지 않는다 — 모든 호출은 가짜 메타(가짜메타.ts)가 받는다.
import { 같나, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 가짜메타 } from "./가짜메타.ts";
import { 영상두기, type 채널준비결과, 채널준비 } from "./바탕.ts";
import { parseMetaJson, setEmbeddedMetaForTest } from "../app/embedded.ts";
import * as MT from "../app/meta.ts";
import * as MP from "../app/metapost.ts";
import * as R from "../app/review.ts";
import { uploadOne } from "../app/upload.ts";
import { tick } from "../app/tick.ts";
import { buildRoutes, newAppState } from "../app/routes.ts";
import { appendLedger } from "../app/ledger.ts";
import { confFor, loadChannels } from "../app/channels.ts";
import { dataPath, withFileLock, writeJson } from "../app/paths.ts";
import { isoWall, wallNow } from "../app/clock.ts";
import { readNote } from "../app/sidecar.ts";
import type { MediaInfo } from "../app/shorts.ts";

type Obj = Record<string, any>;
const 일 = 86_400_000, 분 = 60_000;
const 열쇠 = { worker_url: "https://relay.example.test", ig_app_id: "1111111111", th_app_id: "2222222222" };
/** 기다림을 건너뛰는 실행 설정 (시험은 1분·30초를 실제로 기다리지 않는다) */
const 빠르게 = { sleep: async () => {}, pollMs: 1, threadsWaitMs: 1 };
const 쇼츠정보: MediaInfo = { w: 1080, h: 1920, display_w: 1080, display_h: 1920, codec: "h264", sec: 40, mb: 20 };
const 보고: string[] = [];
const say = (s: string) => { 보고.push(s); };
const 일감 = (c: { name: string }, file: string, o: Obj = {}) => ({ channel: c.name, file, _승인: "사람 승인 (시험)", time_by: "user", ...o });
const 로그 = async (이름: string) => { try { return await Deno.readTextFile(dataPath("기록", 이름)); } catch { return ""; } };
const 있나 = async (p: string) => { try { await Deno.stat(p); return true; } catch { return false; } };
const 쉬기 = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha = async (t: string) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
/** 스레드가 글자를 세는 방식 (이모지 같은 4바이트 글자는 4) */
const thLen = (s: string) => { let n = 0; for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0xffff ? 4 : 1; return n; };

interface 세상 { fake: 가짜구글; meta: 가짜메타; c: 채널준비결과; ig: string; th: string }

/** 메타 계정 하나를 연결된 것처럼 토큰 저장소에 넣는다 (로그인 시험이 아닌 곳에서 쓰는 지름길) */
async function 연결(meta: 가짜메타, p: MT.Provider, uid: string, name: string, o: { left?: number; age?: number } = {}): Promise<string> {
  const token = `TOK-${p}-${uid}`;
  meta.validTokens.add(token);
  const now = Date.now();
  const key = MT.accountKey(p, uid);
  await MT.updateStore((s) => {
    s[key] = {
      provider: p, user_id: uid, username: name, access_token: token,
      expires_at: new Date(now + (o.left ?? 50) * 일).toISOString(), refreshed_at: new Date(now - (o.age ?? 3) * 일).toISOString(),
      added: new Date(now - 3 * 일).toISOString(),
    };
  });
  return key;
}

/** 채널 하나 + 인스타·스레드 계정이 걸린 세상 */
async function 세상만들기(dir: string, o: { ig?: boolean; th?: boolean } = {}): Promise<세상> {
  setEmbeddedMetaForTest(열쇠);
  const fake = new 가짜구글(); fake.instantProcessing = true;
  const c = await 채널준비(dir, fake, { name: "채널A" });
  const meta = new 가짜메타().install(fake);
  let ig = "", th = "";
  if (o.ig !== false) { ig = await 연결(meta, "instagram", "17841400000000001", "릴스계정"); await MT.bindChannel("채널A", "instagram", ig); }
  if (o.th !== false) { th = await 연결(meta, "threads", "26310000000000002", "스레드계정"); await MT.bindChannel("채널A", "threads", th); }
  return { fake, meta, c, ig, th };
}

const J = (id: string) => MP.loadJobs().jobs[id];
const 상태 = (id: string) => [J(id)?.targets.instagram?.state, J(id)?.targets.threads?.state];

/** 영상 한 편을 두고 장부에 담는다 */
async function 담기(w: 세상, name: string, o: Partial<MP.EnqueueArgs> & { long?: boolean; sec?: number } = {}) {
  const path = await 영상두기(w.c.folder, name, { long: o.long, sec: o.sec });
  const id = o.videoId ?? "VID_" + name.replace(/\.[^.]+$/, "");
  const { long: _l, sec: _s, ...rest } = o;
  const r = await MP.enqueue({
    videoId: id, channel: "채널A", file: path, title: "첫 영상 제목", desc: "설명 한 줄\n\n#태그가 #태그나", tags: [], info: 쇼츠정보, kind: "쇼츠", ...rest,
  });
  return { id, path, r };
}

/** 올릴 때가 된 것으로 만들고(공개 확인) 곧바로 한 바퀴 돈다 */
async function 완주(w: 세상, name: string, o: Partial<MP.EnqueueArgs> = {}, ctx: Partial<MP.RunCtx> = {}) {
  const d = await 담기(w, name, o);
  await MP.markPublic(d.id);
  const r = await MP.run({ ...빠르게, ...ctx });
  return { ...d, run: r };
}

/** 화면 길에서 부르는 뒤쪽 올리기가 끝날 때까지 기다린다 (시험 폴더가 지워진 뒤 진짜 폴더에 쓰지 않게) */
async function 뒤쪽끝(id: string, p: MT.Provider, 바람: string[]) {
  for (let i = 0; i < 200 && !바람.includes(J(id)?.targets[p]?.state ?? ""); i++) await 쉬기(25);
  for (let i = 0; i < 200; i++) {
    const got = await withFileLock(dataPath(".메타올리기.run.lock"), async () => true, { wait: false });
    if (got) return;
    await 쉬기(25);
  }
}

async function 글파일들(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...await 글파일들(p));
    else if (/\.(json|log|txt|last)$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function 실행() {
  // 규격 조사는 ffprobe 에 맡기지 않는다 — 시험 컴퓨터마다 달라지지 않게 고정한다
  MP.setExtraProbeForTest(async () => null);
  try {
    await 글시험();
    await 규격시험();
    await 연결정보시험();
    await 토큰시험();
    await 로그인시험();
    await 연결끊기시험();
    await 담기시험();
    await 올리기시험();
    await 스레드길시험();
    await 두번안올림시험();
    await 오류와기다림시험();
    await 청소시험();
    await 훅시험();
    await 화면길시험();
    await 새지않음시험();
  } finally {
    MP.setExtraProbeForTest(undefined);
  }
}

/* ═══════════════════════════ 1. 글 ═══════════════════════════ */

async function 글시험() {
  구역("글 — 인스타그램 설명 = 제목 + 설명 + 해시태그 (2200자 · 30개)");
  const a = MP.buildCaption("첫 제목", "설명 한 줄\n\n#태그1 #태그2", ["태그2", "shorts", "#새 태그"]);
  같나("제목 → 설명 → 해시태그 줄 · 겹침·#shorts 제외", a.text, "첫 제목\n\n설명 한 줄\n\n#태그1 #태그2 #새태그");
  같나("해시태그 수 · 줄이지 않음", [a.hashtags, a.trimmed], [3, false]);
  같나("제목만 있어도 된다", MP.buildCaption("제목만", "", []), { text: "제목만", hashtags: 0, trimmed: false });

  const 태그35 = Array.from({ length: 35 }, (_, i) => `태그${i + 1}`);
  const b = MP.buildCaption("제목", "가".repeat(3000), 태그35);
  참인가("2200자를 넘지 않는다", b.text.length <= 2200);
  같나("해시태그는 30개까지", b.hashtags, 30);
  참인가("제목은 지키고 설명을 줄이고 해시태그 줄은 살린다", b.trimmed && b.text.startsWith("제목\n\n가가") && b.text.includes("…") && b.text.includes("#태그30") && !b.text.includes("#태그31"));

  const c = MP.buildCaption("제목", Array.from({ length: 35 }, (_, i) => `#인라인${i + 1}`).join(" ") + " 본문 글", []);
  같나("설명 안에 낀 해시태그도 30개에 센다 — 넘는 것은 # 만 뗀다", [c.hashtags, c.text.includes("#인라인30"), c.text.includes("#인라인31"), c.text.includes("인라인31"), c.trimmed], [30, true, false, true, true]);

  const 긴제목 = MP.buildCaption("가".repeat(2300), "설명", ["태그"]);
  참인가("제목만으로 넘으면 제목을 자른다", 긴제목.text.length <= 2200 && 긴제목.text.endsWith("…"));

  구역("글 — 스레드 = 제목 + 짧은 설명 (500자) · 주제 태그 하나");
  const t1 = MP.buildThreadsText("제목 #제목태그", "첫 문단 글.\n\n둘째 문단은 안 간다.\n\n#주제 #다른", ["x.y"]);
  같나("제목 + 첫 문단 · 글 안의 해시태그는 뗀다", t1.text, "제목\n\n첫 문단 글.");
  같나("주제 태그는 규칙에 맞는 첫 태그 하나", t1.topic, "주제");
  같나("주제 태그에 「.」「&」가 없다", MP.buildThreadsText("t", "d", ["a.b&c"]).topic, "abc");
  같나("50자를 넘는 태그는 건너뛴다", MP.buildThreadsText("t", "d", ["가".repeat(60), "짧음"]).topic, "짧음");
  const t2 = MP.buildThreadsText("제목", "나".repeat(1200), []);
  참인가("설명이 길면 500자 안으로 줄인다", thLen(t2.text) <= 500 && t2.text.endsWith("…") && t2.text.startsWith("제목\n\n"));
  const t3 = MP.buildThreadsText("😀".repeat(200), "", []);
  참인가("이모지는 4로 센다 — 500을 넘지 않는다", thLen(t3.text) <= 500);
  같나("제목·설명이 모두 비면 기본 글", MP.buildThreadsText("", "", []).text, "영상");
}

/* ═══════════════════════════ 2. 규격 ═══════════════════════════ */

async function 규격시험() {
  구역("영상 규격 — 릴스 · 스레드 (문서 기준, 하나라도 어긋나면 올리지 않는다)");
  const ok = (o: Partial<MediaInfo> = {}): MediaInfo => ({ ...쇼츠정보, ...o });
  const 좋은추가 = { fps: 30, audio: "aac", bitrate: 5_000_000 };
  const 문제 = (r: MP.SpecResult, 글: string) => r.problems.some((x) => x.includes(글));
  같나("규격에 맞는 쇼츠", MP.reelsProblems(ok(), "a.mp4", 좋은추가).problems, []);
  참인가("ffprobe 가 없으면 확인하지 못한 항목을 알린다(막지는 않는다)", (() => { const r = MP.reelsProblems(ok(), "a.mp4", null); return r.problems.length === 0 && r.notes.length >= 1; })());
  참인가("3초 미만", 문제(MP.reelsProblems(ok({ sec: 2 }), "a.mp4", 좋은추가), "3초"));
  참인가("15분 초과", 문제(MP.reelsProblems(ok({ sec: 16 * 60 }), "a.mp4", 좋은추가), "15분"));
  참인가("300MB 초과", 문제(MP.reelsProblems(ok({ mb: 301 }), "a.mp4", 좋은추가), "300MB"));
  참인가("가로 1920px 초과", 문제(MP.reelsProblems(ok({ w: 2160, display_w: 2160 }), "a.mp4", 좋은추가), "1920px"));
  참인가("코덱이 H.264·HEVC 가 아니면", 문제(MP.reelsProblems(ok({ codec: "vp9" }), "a.mp4", 좋은추가), "H.264 또는 HEVC"));
  같나("HEVC 는 된다", MP.reelsProblems(ok({ codec: "hevc" }), "a.mp4", 좋은추가).problems, []);
  참인가("파일 형식이 mp4·mov 가 아니면", 문제(MP.reelsProblems(ok(), "a.avi", 좋은추가), "mp4·mov"));
  같나("mov 는 된다", MP.reelsProblems(ok(), "a.mov", 좋은추가).problems, []);
  참인가("프레임 수 15", 문제(MP.reelsProblems(ok(), "a.mp4", { ...좋은추가, fps: 15 }), "23~60"));
  참인가("프레임 수 120", 문제(MP.reelsProblems(ok(), "a.mp4", { ...좋은추가, fps: 120 }), "23~60"));
  참인가("음성이 AAC 가 아니면", 문제(MP.reelsProblems(ok(), "a.mp4", { ...좋은추가, audio: "mp3" }), "AAC"));
  참인가("비트레이트 25Mbps 초과", 문제(MP.reelsProblems(ok(), "a.mp4", { ...좋은추가, bitrate: 30_000_000 }), "25Mbps"));
  참인가("코덱을 읽지 못하면 알리기만 한다", (() => { const r = MP.reelsProblems(ok({ codec: "?" }), "a.mp4", 좋은추가); return r.problems.length === 0 && r.notes.some((x) => x.includes("코덱")); })());
  같나("스레드: 규격에 맞는 쇼츠", MP.threadsProblems(ok(), "a.mp4", 좋은추가).problems, []);
  참인가("스레드: 5분 초과", 문제(MP.threadsProblems(ok({ sec: 301 }), "a.mp4", 좋은추가), "5분"));
  같나("스레드: 3초 미만 제한은 없다", MP.threadsProblems(ok({ sec: 2 }), "a.mp4", 좋은추가).problems, []);
  참인가("스레드: 프레임 수 15", 문제(MP.threadsProblems(ok(), "a.mp4", { ...좋은추가, fps: 15 }), "23~60"));
}

/* ═══════════════════════════ 3. 연결 정보 ═══════════════════════════ */

async function 연결정보시험() {
  구역("연결 정보 — 실행 파일에 묶인 값이 없으면 기능이 숨는다");
  같나("올바른 meta.json", parseMetaJson('{"worker_url":"https://relay.example.test/","ig_app_id":"1","th_app_id":"2"}'), { worker_url: "https://relay.example.test", ig_app_id: "1", th_app_id: "2" });
  같나("https 가 아닌 주소는 받지 않는다", parseMetaJson('{"worker_url":"http://relay.example.test","ig_app_id":"1","th_app_id":"2"}'), null);
  참인가("이 컴퓨터의 시험용 주소는 http 도 된다", parseMetaJson('{"worker_url":"http://127.0.0.1:8787","ig_app_id":"1"}') !== null);
  같나("앱 번호가 하나도 없으면", parseMetaJson('{"worker_url":"https://relay.example.test"}'), null);
  같나("깨진 글", parseMetaJson("{깨짐"), null);
  await 모래상자(async () => {
    같나("묶인 값이 없으면 꺼짐", await MT.available(), { on: false, instagram: false, threads: false });
    setEmbeddedMetaForTest(열쇠);
    같나("둘 다 있으면 둘 다 켜짐", await MT.available(), { on: true, instagram: true, threads: true });
    setEmbeddedMetaForTest({ ...열쇠, th_app_id: "" });
    같나("스레드 번호가 없으면 인스타그램만", await MT.available(), { on: true, instagram: true, threads: false });
  });
}

/* ═══════════════════════════ 4. 토큰 ═══════════════════════════ */

async function 토큰시험() {
  구역("토큰 — 600 권한 · 만료 전 갱신 · 만료 · 갱신 실패");
  await 모래상자(async () => {
    setEmbeddedMetaForTest(열쇠);
    const meta = new 가짜메타().install();
    const ig = await 연결(meta, "instagram", "17841400000000001", "릴스계정");
    if (Deno.build.os !== "windows") 같나("토큰 파일은 본인만 읽는다(600)", (await Deno.stat(MT.storePath())).mode! & 0o777, 0o600);
    const 보기 = JSON.stringify(MT.accountsView());
    참인가("화면용 계정 목록에는 토큰 값이 없다", !보기.includes("TOK-") && 보기.includes("릴스계정"));
    같나("만료까지 남은 날", MT.accountsView()[0].days_left >= 49, true);

    같나("만료가 멀면 그대로 쓴다", await MT.freshToken(ig), "TOK-instagram-17841400000000001");
    같나("그때 메타 호출은 0건", meta.calls.length, 0);

    // 만료 5일 전 · 마지막 갱신 20일 전 → 갱신
    const 옛 = "TOK-instagram-17841400000000001";
    await MT.updateStore((s) => { s[ig].expires_at = new Date(Date.now() + 5 * 일).toISOString(); s[ig].refreshed_at = new Date(Date.now() - 20 * 일).toISOString(); });
    const 새 = await MT.freshToken(ig);
    참인가("만료가 가까우면 갱신해서 새 토큰을 돌려준다", 새 !== 옛 && 새.startsWith(옛));
    const rc = meta.callsTo(/^ig\.refresh$/);
    같나("갱신 호출: 한 번 · 인스타그램 그래프 · 갱신 종류", [rc.length, rc[0]?.host, rc[0]?.query.grant_type], [1, "graph.instagram.com", "ig_refresh_token"]);
    const s1 = MT.loadStore()[ig];
    참인가("저장소가 새 토큰·새 만료(약 60일)로 바뀐다", s1.access_token === 새 && Date.parse(s1.expires_at) - Date.now() > 59 * 일 && Date.parse(s1.expires_at) - Date.now() < 61 * 일 && !s1.error);
    참인가("갱신 기록이 남는다(토큰 값은 없다)", (await 로그("올리기.log")).includes("인스타그램 토큰 갱신") && !(await 로그("올리기.log")).includes("TOK-"));

    // 갱신은 24시간 뒤부터 가능
    await MT.updateStore((s) => { s[ig].expires_at = new Date(Date.now() + 5 * 일).toISOString(); s[ig].refreshed_at = new Date(Date.now() - 2 * 3600_000).toISOString(); });
    meta.clearCalls();
    await MT.freshToken(ig);
    같나("방금 받은 토큰(24시간 안)은 만료가 가까워도 갱신하지 않는다", meta.callsTo(/refresh/).length, 0);

    // 갱신 실패 — 아직 만료 전이면 지금 토큰으로 계속, 6시간 안에는 다시 두드리지 않는다
    meta.refreshFail = true;
    await MT.updateStore((s) => { s[ig].expires_at = new Date(Date.now() + 5 * 일).toISOString(); s[ig].refreshed_at = new Date(Date.now() - 20 * 일).toISOString(); delete s[ig].tried_at; });
    const 지금토큰 = MT.loadStore()[ig].access_token;
    같나("갱신이 실패해도 만료 전이면 지금 토큰을 돌려준다", await MT.freshToken(ig), 지금토큰);
    참인가("로그인이 풀린 것이면 까닭을 남긴다", /다시 연결/.test(MT.accountsView()[0].error ?? ""));
    meta.clearCalls();
    await MT.freshToken(ig);
    같나("6시간 안에는 같은 계정을 다시 두드리지 않는다", meta.callsTo(/refresh/).length, 0);
    meta.refreshFail = false;

    // 만료
    await MT.updateStore((s) => { s[ig].expires_at = new Date(Date.now() - 일).toISOString(); });
    await 던지나("이미 만료된 토큰은 쓰지 않는다", () => MT.freshToken(ig), /만료됐습니다/);
    await 던지나("연결이 끊긴 계정", () => MT.freshToken("ig:없음"), /연결이 끊긴/);
    같나("만료/끊김 확인에 메타 호출 0건", meta.callsTo(/^ig\./).length, 0);

    // 스레드 갱신은 스레드 쪽으로
    const th = await 연결(meta, "threads", "26310000000000002", "스레드계정", { left: 4, age: 30 });
    meta.clearCalls();
    await MT.freshToken(th);
    const rt = meta.callsTo(/^th\.refresh$/);
    같나("스레드 갱신: 스레드 그래프 · th_refresh_token", [rt.length, rt[0]?.host, rt[0]?.query.grant_type], [1, "graph.threads.com", "th_refresh_token"]);

    // 예약 작업이 부르는 갱신: 할 때가 된 계정만
    const ig2 = await 연결(meta, "instagram", "17841400000000009", "둘째계정", { left: 50, age: 3 });
    const ig3 = await 연결(meta, "instagram", "17841400000000008", "셋째계정", { left: 3, age: 40 });
    meta.clearCalls();
    const rd = await MT.refreshDue();
    같나("할 때가 된 계정만 메타를 부른다 (스레드·만료 계정 포함 점검)", [rd.checked >= 4, rd.due >= 1, meta.callsTo(/^ig\.refresh$/).length], [true, true, 1]);
    참인가("둘째(먼 만료)는 건드리지 않고 셋째만 갱신", MT.loadStore()[ig2].access_token === "TOK-instagram-17841400000000009" && MT.loadStore()[ig3].access_token !== "TOK-instagram-17841400000000008");
    await MT.updateStore((s) => { for (const k of Object.keys(s)) delete s[k]; });
    meta.clearCalls();
    같나("계정이 없으면 호출 0건", [await MT.refreshDue(), meta.calls.length], [{ checked: 0, due: 0 }, 0]);
  });
}

/* ═══════════════════════════ 5. 로그인 ═══════════════════════════ */

async function 로그인시험() {
  구역("로그인 — 중계 서버 경유 · 주소에 토큰 없음 · 한 번만 받아 간다");
  await 모래상자(async () => {
    setEmbeddedMetaForTest(열쇠);
    const meta = new 가짜메타().install();
    const T0 = new Date("2026-10-19T03:00:00Z");
    /** 브라우저가 앱으로 돌아온 것을 흉내 낸다 */
    const 돌아옴 = async (url: string, 값: Record<string, string>, nonce?: string) => {
      const u = new URL(url);
      const q = new URLSearchParams({ n: nonce ?? u.searchParams.get("nonce")!, ...값 });
      const r = await fetch(`http://127.0.0.1:${u.searchParams.get("port")}/meta/done?${q}`);
      return { status: r.status, text: await r.text() };
    };

    // 성공
    const s = await MT.startSignIn("instagram", { now: () => T0 });
    const u = new URL(s.url);
    같나("시작 주소는 중계 서버의 /ig/start", [u.origin, u.pathname], [열쇠.worker_url, "/ig/start"]);
    const challenge = u.searchParams.get("challenge")!;
    참인가("주소에는 포트·확인값(해시)·nonce 만 있다", [...u.searchParams.keys()].sort().join() === "challenge,nonce,port" && challenge.length === 43);
    같나("진행 중 표시", [MT.signin.state.running, MT.signin.state.provider], [true, "instagram"]);
    meta.pickups.set(challenge, { provider: "instagram", access_token: "LONG-IG-TOKEN", user_id: "17841400000000001", username: "릴스계정", account_type: "BUSINESS", expires_in: 5184000 });
    await 던지나("이미 열린 로그인이 있으면 또 열지 않는다", () => MT.startSignIn("threads"), /이미 로그인 창이 열려 있습니다/);
    const 틀림 = await 돌아옴(s.url, { ok: "1" }, "엉뚱한값");
    참인가("확인값이 틀리면 거절하고 계속 기다린다", 틀림.text.includes("확인값이 맞지 않습니다") && MT.signin.state.running && meta.calls.length === 0);
    const 맞음 = await 돌아옴(s.url, { ok: "1" });
    참인가("돌아온 쪽 화면: 연결 완료", 맞음.status === 200 && 맞음.text.includes("연결됐습니다"));
    같나("로그인 결과", await s.done, { key: "ig:17841400000000001", username: "릴스계정" });
    const pk = meta.callsTo(/^relay:POST \/pickup$/);
    같나("토큰을 받아 간 호출은 한 번", pk.length, 1);
    const verifier = String(pk[0].json?.verifier ?? "");
    같나("확인값은 verifier 의 해시", await sha(verifier), challenge);
    참인가("verifier 는 주소에 나온 적이 없다", verifier.length >= 40 && !s.url.includes(verifier));
    같나("한 번 가져가면 중계 서버에서 사라진다", meta.pickups.size, 0);
    const tok = MT.loadStore()["ig:17841400000000001"];
    참인가("토큰이 저장된다(60일)", tok.access_token === "LONG-IG-TOKEN" && Date.parse(tok.expires_at) === T0.getTime() + 5184000 * 1000 && tok.account_type === "BUSINESS");
    같나("끝난 상태", [MT.signin.state.running, MT.signin.state.done?.key], [false, "ig:17841400000000001"]);
    참인가("기록에는 계정 이름만(토큰 없음)", (await 로그("올리기.log")).includes("인스타그램 연결  @릴스계정") && !(await 로그("올리기.log")).includes("LONG-IG-TOKEN"));

    // 스레드
    const s2 = await MT.startSignIn("threads", { now: () => T0 });
    같나("스레드는 /th/start", new URL(s2.url).pathname, "/th/start");
    meta.pickups.set(new URL(s2.url).searchParams.get("challenge")!, { provider: "threads", access_token: "LONG-TH-TOKEN", user_id: "26310000000000002", username: "스레드계정", expires_in: 5184000 });
    await 돌아옴(s2.url, { ok: "1" });
    같나("스레드 로그인 결과", (await s2.done).key, "th:26310000000000002");

    // 거절·취소·실패
    const s3 = await MT.startSignIn("instagram");
    await 돌아옴(s3.url, { error: "access_denied" });
    await 던지나("연결을 허락하지 않으면", () => s3.done, /허락하지 않으셨습니다/);
    같나("그 뒤 진행 중이 아니다", MT.signin.state.running, false);

    const s4 = await MT.startSignIn("instagram");
    MT.signin.stop?.();
    await 던지나("사용자가 취소하면", () => s4.done, /취소했습니다/);

    const s5 = await MT.startSignIn("instagram");
    const 못받음 = await 돌아옴(s5.url, { ok: "1" });
    참인가("돌아오긴 했지만", 못받음.status === 200);
    await 던지나("중계 서버에 받아 갈 토큰이 없으면", () => s5.done, /토큰을 받아 오지 못했습니다/);

    const s6 = await MT.startSignIn("instagram");
    meta.pickups.set(new URL(s6.url).searchParams.get("challenge")!, { provider: "threads", access_token: "X", user_id: "1", username: "x", expires_in: 100 });
    await 돌아옴(s6.url, { ok: "1" });
    await 던지나("다른 종류의 답이면 저장하지 않는다", () => s6.done, /올바르지 않습니다/);
    참인가("그런 답으로는 저장소가 늘지 않았다", Object.keys(MT.loadStore()).length === 2);

    const s7 = await MT.startSignIn("instagram", { timeoutMs: 30 });
    await 던지나("시간이 지나면 접는다", () => s7.done, /로그인을 접었습니다/);

    setEmbeddedMetaForTest({ ...열쇠, th_app_id: "" });
    await 던지나("이 판에 스레드 번호가 없으면 시작하지 않는다", () => MT.startSignIn("threads"), /연결 정보가 들어 있지 않습니다/);
    setEmbeddedMetaForTest(null);
    await 던지나("연결 정보가 없는 판", () => MT.startSignIn("instagram"), /연결 정보가 들어 있지 않습니다/);
    같나("시작도 못 한 로그인은 호출 0건", meta.calls.filter((c) => c.name !== "relay:POST /pickup").length, 0);
  });
}

/* ═══════════════════════════ 6. 연결 끊기 · 채널 짝짓기 ═══════════════════════════ */

async function 연결끊기시험() {
  구역("채널 짝짓기 · 연결 끊기 (기본은 꺼짐)");
  await 모래상자(async (dir) => {
    setEmbeddedMetaForTest(열쇠);
    const fake = new 가짜구글();
    await 채널준비(dir, fake, { name: "채널A" });
    const meta = new 가짜메타().install(fake);
    같나("처음엔 아무 계정도 안 걸려 있다(꺼짐)", MT.bindingOf(confFor("채널A")), {});
    const ig = await 연결(meta, "instagram", "17841400000000001", "릴스계정");
    const th = await 연결(meta, "threads", "26310000000000002", "스레드계정");
    await 던지나("모르는 채널", () => MT.bindChannel("없는채널", "instagram", ig), /모르는 채널/);
    await 던지나("연결되지 않은 계정은 못 건다", () => MT.bindChannel("채널A", "instagram", "ig:없음"), /연결된 인스타그램 계정이 아닙니다/);
    await 던지나("종류가 다른 계정은 못 건다", () => MT.bindChannel("채널A", "instagram", th), /연결된 인스타그램 계정이 아닙니다/);
    await MT.bindChannel("채널A", "instagram", ig);
    await MT.bindChannel("채널A", "threads", th);
    같나("두 계정이 걸린다", MT.bindingOf(confFor("채널A")), { instagram: ig, threads: th });
    같나("채널 설정에 meta 칸으로 저장된다(옛 칸은 그대로)", [confFor("채널A")?.meta, confFor("채널A")?.times], [{ instagram: ig, threads: th }, ["09:00"]]);
    await MT.bindChannel("채널A", "threads", null);
    같나("null 이면 그 쪽만 끈다", MT.bindingOf(confFor("채널A")), { instagram: ig });
    같나("끊는다", [await MT.disconnect(ig), await MT.disconnect(ig)], [true, false]);
    참인가("토큰이 지워지고 채널의 짝도 풀린다(meta 칸 자체가 사라짐)", !(ig in MT.loadStore()) && !("meta" in (loadChannels()["채널A"] as Obj)) && th in MT.loadStore());
    참인가("끊음 기록(토큰 값 없음)", (await 로그("올리기.log")).includes("연결 끊음  ig:17841400000000001") && !(await 로그("올리기.log")).includes("TOK-"));
  });
}

/* ═══════════════════════════ 7. 담기 ═══════════════════════════ */

async function 담기시험() {
  구역("담기 — 계정이 걸린 채널의 쇼츠만, 나머지는 까닭을 적고 건너뜀");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const a = await 담기(w, "a.mp4");
    같나("계정이 걸린 채널의 쇼츠는 대기", [a.r.queued, a.r.why, J(a.id).phase, 상태(a.id)], [true, "대기", "영상대기", ["대기", "대기"]]);
    같나("담기는 메타를 한 번도 부르지 않는다", w.meta.calls.length, 0);
    참인가("글이 미리 만들어진다", J(a.id).text.caption.startsWith("첫 영상 제목\n\n설명 한 줄") && J(a.id).text.threads === "첫 영상 제목\n\n설명 한 줄" && J(a.id).text.topic === "태그가");
    참인가("영상 사본이 메타대기에 있고 원본도 그대로", (await 있나(J(a.id).file)) && J(a.id).file.includes("메타대기") && (await 있나(a.path)));
    같나("같은 영상은 두 번 담지 않는다", (await 담기(w, "a.mp4")).r, { queued: false, why: "이미 있음" });

    const b = await 담기(w, "b.mp4", { flags: { instagram: false } });
    같나("영상 쪽지가 인스타그램을 끄면 스레드만", 상태(b.id), [undefined, "대기"]);
    const c = await 담기(w, "c.mp4", { flags: { instagram: false, threads: false } });
    같나("둘 다 끄면 담지 않는다", [c.r, J(c.id)], [{ queued: false, why: "꺼짐" }, undefined]);

    const l = await 담기(w, "l.mp4", { long: true, kind: "롱폼", info: { ...쇼츠정보, w: 1920, h: 1080, display_w: 1920, display_h: 1080, sec: 400 } });
    같나("롱폼은 건너뜀 · 끝", [l.r.why, 상태(l.id), J(l.id).phase, J(l.id).file], ["건너뜀", ["건너뜀", "건너뜀"], "끝", ""]);
    참인가("롱폼 까닭이 적힌다", J(l.id).targets.instagram!.why!.includes("롱폼"));
    const g = await 담기(w, "g.mp4", { kind: "쇼츠", info: { ...쇼츠정보, w: 1920, h: 1080, display_w: 1920, display_h: 1080 } });
    참인가("가로 영상은 건너뜀", 상태(g.id).join() === "건너뜀,건너뜀" && J(g.id).targets.threads!.why!.includes("가로"));

    const v = await 담기(w, "v.mp4", { info: { ...쇼츠정보, codec: "vp9" } });
    참인가("코덱이 맞지 않으면 건너뜀 + 까닭", 상태(v.id).join() === "건너뜀,건너뜀" && J(v.id).targets.instagram!.why!.includes("영상 규격이 맞지 않아") && J(v.id).targets.instagram!.why!.includes("H.264"));
    const s = await 담기(w, "s.mp4", { info: { ...쇼츠정보, sec: 2 } });
    같나("2초 영상: 릴스는 건너뜀 · 스레드는 대기(스레드엔 3초 하한이 없다)", 상태(s.id), ["건너뜀", "대기"]);
    같나("하나라도 올릴 것이 있으면 사본을 둔다", [J(s.id).phase, (await 있나(J(s.id).file))], ["영상대기", true]);

    MP.setExtraProbeForTest(async () => ({ fps: 15, audio: "aac", bitrate: 1_000_000 }));
    const f = await 담기(w, "f.mp4");
    MP.setExtraProbeForTest(async () => null);
    참인가("추가 조사(프레임 수)가 맞지 않으면 건너뜀", 상태(f.id).join() === "건너뜀,건너뜀" && J(f.id).targets.instagram!.why!.includes("23~60"));

    await MT.updateStore((st) => { delete st[w.ig]; });
    const d = await 담기(w, "d.mp4");
    참인가("연결이 끊긴 계정은 건너뜀 + 다시 연결 안내", J(d.id).targets.instagram!.state === "건너뜀" && J(d.id).targets.instagram!.why!.includes("다시 연결") && J(d.id).targets.threads!.state === "대기");

    같나("건너뜀 줄이 기록에 남는다", (await 로그("올리기.log")).includes("인스타그램 건너뜀  [채널A]"), true);
    같나("끝난 일감 · 대기 중 요약", [MP.summary().waiting >= 3, J(l.id).done_at !== undefined], [true, true]);
    같나("담는 동안 메타 호출 0건", w.meta.calls.length, 0);
  });

  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { ig: false, th: false });
    같나("계정이 안 걸린 채널은 기본 꺼짐", (await 담기(w, "x.mp4")).r, { queued: false, why: "꺼짐" });
    const y = await 담기(w, "y.mp4", { flags: { instagram: true } });
    참인가("쪽지가 켜도 계정이 없으면 건너뜀 + 까닭", y.r.why === "건너뜀" && J(y.id).targets.instagram!.why!.includes("계정이 걸려 있지 않습니다") && J(y.id).targets.threads === undefined);
    같나("호출 0건", w.meta.calls.length, 0);
  });

  구역("영상 쪽지 json — 인스타그램·스레드 켜고 끄기");
  await 모래상자(async (dir) => {
    const p = `${dir}/n.json`;
    for (const [글, 바람] of [
      ['{"instagram":false,"threads":true}', { instagram: false, threads: true }],
      ['{"instagram":"off","threads":"on"}', { instagram: false, threads: true }],
      ['{"instagram":"모름"}', null],
      ['{"title":"제목"}', { title: "제목" }],
    ] as [string, Obj | null][]) {
      await Deno.writeTextFile(p, 글);
      const n = await readNote(p);
      같나(`쪽지 ${글}`, 바람 ? Object.fromEntries(Object.entries(n ?? {}).filter(([, v]) => v !== undefined)) : n, 바람);
    }
  });
}

/* ═══════════════════════════ 8. 올리기 한 바퀴 ═══════════════════════════ */

async function 올리기시험() {
  구역("올리기 — 공개가 확인돼야 올리고, 인스타그램 → 스레드 순서, 임시 보관은 끝나면 지운다");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const d = await 담기(w, "a.mp4");
    const 빈 = await MP.run(빠르게);
    같나("유튜브 공개 전에는 올리지 않는다(호출 0건)", [빈.posted, w.meta.calls.length], [0, 0]);
    같나("공개 확인(markPublic)", [await MP.markPublic(d.id), await MP.markPublic(d.id), J(d.id).phase], [true, false, "진행"]);
    const r = await MP.run({ ...빠르게, say });
    같나("한 바퀴: 둘 다 올림", [r.posted, r.failed, r.unknown, r.waiting, r.busy], [2, 0, 0, 0, false]);
    같나("호출 순서", w.meta.calls.map((c) => c.name), [
      "relay:POST /stage/ticket", "r2.put", "ig.container", "ig.status", "ig.publish", "ig.get", "ig.get",
      "th.container", "th.status", "th.publish", "th.get", "relay:POST /stage/delete",
    ]);
    const j = J(d.id);
    같나("인스타그램: 올림 · 번호 · 주소", [j.targets.instagram!.state, j.targets.instagram!.media_id!.startsWith("IGM"), j.targets.instagram!.url!.includes("instagram.com/reel/")], ["올림", true, true]);
    같나("스레드: 올림 · 방금 올린 인스타 영상 주소(가)로 가져갔다", [j.targets.threads!.state, j.targets.threads!.route, j.targets.threads!.url!.includes("threads.com")], ["올림", "instagram_media_url", true]);
    같나("일감은 끝", [j.phase, j.done_at !== undefined], ["끝", true]);

    const igc = [...w.meta.containers.values()].find((x) => x.kind === "ig")!;
    const thc = [...w.meta.containers.values()].find((x) => x.kind === "th")!;
    같나("릴스 요청: REELS · 피드 공유 · 글 · 일회용 주소", [igc.params.media_type, igc.params.share_to_feed, igc.params.caption === j.text.caption, igc.params.video_url.startsWith(`${열쇠.worker_url}/s/`)], ["REELS", "true", true, true]);
    같나("스레드 요청: VIDEO · 인스타 영상 주소 · 글 · 주제 태그", [thc.params.media_type, thc.params.video_url, thc.params.text, thc.params.topic_tag], ["VIDEO", w.meta.mediaUrl, j.text.threads, j.text.topic]);
    같나("게시 요청의 creation_id 는 방금 만든 컨테이너", [w.meta.callsTo(/^ig\.publish$/)[0].form.creation_id, w.meta.callsTo(/^th\.publish$/)[0].form.creation_id], [igc.id, thc.id]);
    같나("계정마다 자기 토큰만 쓴다", [
      w.meta.calls.filter((c) => c.name.startsWith("ig.")).every((c) => (c.form.access_token ?? c.query.access_token) === "TOK-instagram-17841400000000001"),
      w.meta.calls.filter((c) => c.name.startsWith("th.")).every((c) => (c.form.access_token ?? c.query.access_token) === "TOK-threads-26310000000000002"),
    ], [true, true]);
    const st = [...w.meta.staged.values()][0];
    const 크기 = (await Deno.stat(d.path)).size;
    같나("임시 보관: 파일 통째로 올렸다 · 끝나고 지웠다", [w.meta.staged.size, st.putBytes, st.bytes, st.deleted], [1, 크기, 크기, true]);
    참인가("장부의 보관 정보도 지워짐 표시(주소·서명 비움)", j.staged?.deleted === true && j.staged.get_url === "" && j.staged.delete_sig === "");
    참인가("내 사본은 치웠고 원본은 그대로", j.file === "" && (await 있나(d.path)));
    참인가("올림 기록(번호·주소)", (await 로그("올리기.log")).includes("인스타그램 올림  [채널A] 첫 영상 제목") && (await 로그("올리기.log")).includes("스레드 올림"));
    같나("두 번째 바퀴는 아무것도 안 한다", [(await MP.run(빠르게)).posted, w.meta.calls.length], [0, 12]);
    같나("화면용 목록", MP.listJobs().map((x) => [x.id, x.phase, x.targets.map((t) => [t.provider, t.state, t.actions])]), [[d.id, "끝", [["instagram", "올림", []], ["threads", "올림", []]]]]);
  });

  구역("올리기 — 인스타그램만 · 스레드만 · 예약 공개 · 취소 · 접힘");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    const d = await 완주(w, "a.mp4");
    같나("인스타그램만: 스레드 호출 0건", [d.run.posted, w.meta.calls.some((c) => c.name.startsWith("th."))], [1, false]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { ig: false });
    const d = await 완주(w, "a.mp4");
    같나("스레드만: 인스타 영상 주소가 없으니 임시 보관으로", [d.run.posted, J(d.id).targets.threads!.route, w.meta.callsTo(/relay:POST \/stage\/ticket/).length, w.meta.calls.some((c) => c.name.startsWith("ig."))], [1, "staging", 1, false]);
    같나("스레드 요청 영상 주소는 중계 서버의 일회용 주소", [...w.meta.containers.values()][0].params.video_url.startsWith(`${열쇠.worker_url}/s/`), true);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const d = await 담기(w, "a.mp4");
    const 열림 = new Date(Date.now() + 3 * 3600_000);
    await MP.markPublic(d.id, { publishAt: 열림.toISOString() });
    같나("예약 공개는 열리는 시각 2분 뒤부터", J(d.id).go_after, new Date(열림.getTime() + 2 * 분).toISOString());
    같나("열리기 전에는 올리지 않는다", [(await MP.run(빠르게)).posted, w.meta.calls.length], [0, 0]);
    같나("열린 뒤 1분은 아직", (await MP.run({ ...빠르게, now: new Date(열림.getTime() + 1 * 분) })).posted, 0);
    같나("열린 뒤 3분이면 올린다", (await MP.run({ ...빠르게, now: new Date(열림.getTime() + 3 * 분) })).posted, 2);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const a = await 담기(w, "a.mp4");
    같나("취소", [await MP.cancelJob(a.id), 상태(a.id), J(a.id).phase, await MP.cancelJob(a.id)], [true, ["취소", "취소"], "끝", false]);
    같나("취소하면 내 사본을 치우고 원본은 둔다", [J(a.id).file, await 있나(a.path)], ["", true]);
    같나("취소한 것은 공개돼도 올리지 않는다", [await MP.markPublic(a.id), (await MP.run(빠르게)).posted, w.meta.calls.length], [false, 0, 0]);
    const b = await 담기(w, "b.mp4");
    같나("유튜브에서 공개가 안 되면 접는다", [await MP.markDropped(b.id, "거부됨 — 저작권 위반"), 상태(b.id), J(b.id).phase], [true, ["취소", "취소"], "끝"]);
    참인가("접은 까닭이 적힌다", J(b.id).targets.instagram!.why!.includes("거부됨") && (await 로그("올리기.log")).includes("인스타·스레드 접음"));
    같나("접힌 것은 올리지 않는다", [await MP.markPublic(b.id), (await MP.run(빠르게)).posted, w.meta.calls.length], [false, 0, 0]);
    같나("없는 영상은 아무 일도 없다", [await MP.markPublic("없음"), await MP.markDropped("없음", "x")], [false, false]);
  });
}

/* ═══════════════════════════ 9. 스레드 영상 길 ═══════════════════════════ */

async function 스레드길시험() {
  구역("스레드 영상 길 — (가) 방금 올린 인스타 영상 주소 먼저, 안 되면 (나) 임시 보관");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.rejectMediaUrl = true;
    const d = await 완주(w, "a.mp4", {}, { say });
    const t = J(d.id).targets.threads!;
    같나("(가)가 안 되면 (나)로 바꿔 올린다", [d.run.posted, t.state, t.route, t.routes_failed], [2, "올림", "staging", ["instagram_media_url"]]);
    const thc = w.meta.callsTo(/^th\.container$/);
    같나("스레드 컨테이너는 두 번: 처음엔 인스타 주소, 다음엔 임시 보관 주소", [thc.length, thc[0].form.video_url, thc[1].form.video_url.startsWith(`${열쇠.worker_url}/s/`)], [2, w.meta.mediaUrl, true]);
    같나("임시 보관은 인스타그램 때 올린 것을 다시 쓴다(올리기 한 번)", [w.meta.callsTo(/stage\/ticket/).length, w.meta.callsTo(/^r2\.put$/).length], [1, 1]);
    같나("게시는 한 번뿐", w.meta.callsTo(/^th\.publish$/).length, 1);
    같나("끝나면 보관본을 지운다", [...w.meta.staged.values()].every((x) => x.deleted), true);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.mediaUrl = null;
    const d = await 완주(w, "a.mp4");
    같나("인스타 영상의 내려받기 주소가 없으면 처음부터 임시 보관", [d.run.posted, J(d.id).targets.threads!.route, J(d.id).targets.threads!.routes_failed, w.meta.callsTo(/^th\.container$/).length], [2, "staging", undefined, 1]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.igStatus = ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date();
    const r1 = await MP.run({ ...빠르게, now: t0 });
    같나("인스타가 아직 처리 중이면 스레드는 기다린다(인스타 영상 주소를 쓰려고)", [r1.posted, 상태(d.id), w.meta.calls.some((c) => c.name.startsWith("th."))], [0, ["올리는중", "대기"], false]);
    const r2 = await MP.run({ ...빠르게, now: new Date(t0.getTime() + 6 * 분) });
    같나("인스타가 끝나면 스레드가 이어서 올린다(가)", [r2.posted, J(d.id).targets.threads!.route], [2, "instagram_media_url"]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.igStatus = Array(40).fill("IN_PROGRESS");
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date();
    await MP.run({ ...빠르게, now: t0 });
    const r = await MP.run({ ...빠르게, now: new Date(t0.getTime() + 125 * 분) });
    같나("인스타가 2시간 넘게 끌면 스레드는 기다리지 않고 임시 보관으로 간다", [J(d.id).targets.threads!.state, J(d.id).targets.threads!.route, r.posted], ["올림", "staging", 1]);
  });
}

/* ═══════════════════════════ 10. 두 번 올리지 않기 ═══════════════════════════ */

async function 두번안올림시험() {
  구역("두 번 올리지 않기 — 답을 못 받은 「게시」는 절대 다시 보내지 않는다");
  const 게시수 = (w: 세상, k: "ig" | "th" = "ig") => w.meta.callsTo(new RegExp(`^${k}\\.publish$`)).length;

  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.igPublish = "5xx_posted";
    const d = await 완주(w, "a.mp4");
    const t = J(d.id).targets.instagram!;
    같나("게시가 5xx 로 끊겼지만 실제로는 올라간 경우: 최근 게시물에서 찾아 「올림」", [게시수(w), t.state, t.media_id?.startsWith("IGM"), t.checks], [1, "올림", true, 1]);
    같나("스레드는 이어서 올린다", J(d.id).targets.threads!.state, "올림");
    같나("게시 요청은 계속 1번", [게시수(w), (await MP.run(빠르게)).posted], [1, 0]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.igPublish = "timeout_posted";
    const d = await 완주(w, "a.mp4");
    같나("시간 초과로 끊겼지만 올라간 경우도 찾는다", [게시수(w), J(d.id).targets.instagram!.state], [1, "올림"]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.igPublish = "5xx_lost";
    const t0 = new Date(Date.now() + 10_000); // 공개 확인 시각(지금)보다 뒤여야 올릴 때가 된 것이다
    const d = await 완주(w, "a.mp4", {}, { now: t0 });
    let t = J(d.id).targets.instagram!;
    같나("올라갔는지 모르면 「결과불명」 · 다시 보내지 않는다", [t.state, 게시수(w), t.checks, w.meta.callsTo(/^ig\.recent$/).length], ["결과불명", 1, 1, 1]);
    참인가("사람 말 안내", t.why!.includes("확인이 필요합니다"));
    같나("스레드는 영향이 없다(임시 보관으로 올림)", [J(d.id).targets.threads!.state, J(d.id).targets.threads!.route], ["올림", "staging"]);
    같나("화면 단추: 확인 · 직접 정하기", MP.listJobs()[0].targets[0].actions, ["check", "resolve"]);
    참인가("다시 할 일이 남아 있어 사본은 둔다 · 보관본은 지움", (await 있나(J(d.id).file)) && J(d.id).staged?.deleted === true);
    for (let i = 1; i <= 6; i++) await MP.run({ ...빠르게, now: new Date(t0.getTime() + i * 31 * 분) });
    t = J(d.id).targets.instagram!;
    같나("몇 번을 돌려도 게시 요청은 1번 · 컨테이너도 1개", [게시수(w), w.meta.callsTo(/^ig\.container$/).length, t.state], [1, 1, "결과불명"]);
    같나("자동 확인은 읽기뿐이고 4번까지만", [w.meta.callsTo(/^ig\.recent$/).length, t.checks], [4, 4]);

    // 사람이 「안 올라갔다」고 하면 그때만 다시 올린다
    w.meta.igPublish = "ok";
    await 던지나("결과불명이 아닌 것은 정할 수 없다", () => MP.resolveTarget(d.id, "threads", "올림"), /결과불명/);
    await MP.resolveTarget(d.id, "instagram", "안올라감");
    같나("사람이 확인하면 다시 대기", [J(d.id).targets.instagram!.state, J(d.id).phase], ["대기", "진행"]);
    같나("그 뒤에야 다시 올라간다", [(await MP.run(빠르게)).posted, 게시수(w), J(d.id).targets.instagram!.state, 게시수(w, "th")], [1, 2, "올림", 1]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.igPublish = "timeout_lost";
    const d = await 완주(w, "a.mp4");
    await MP.resolveTarget(d.id, "instagram", "올림", { url: "https://www.instagram.com/reel/ABC/" });
    같나("사람이 「올라갔다」고 하면 올림으로 · 다시 올리지 않는다", [J(d.id).targets.instagram!.state, J(d.id).targets.instagram!.url, (await MP.run(빠르게)).posted, 게시수(w)], ["올림", "https://www.instagram.com/reel/ABC/", 0, 1]);
    같나("끝난 일감의 사본과 보관본은 치웠다", [J(d.id).phase, J(d.id).file], ["끝", ""]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    // 「게시」를 적어 두고 응답을 못 받은 채 프로그램이 꺼졌다고 치자
    const l = MP.loadJobs();
    Object.assign(l.jobs[d.id].targets.instagram!, { state: "게시요청중", container: "IGC-X", requested_at: new Date().toISOString() });
    await writeJson(dataPath("메타올리기.json"), l, { indent: 2 });
    const r = await MP.run(빠르게);
    같나("남아 있던 「게시요청중」은 다시 보내지 않고 「결과불명」으로", [J(d.id).targets.instagram!.state, 게시수(w), w.meta.callsTo(/container/).length, r.unknown], ["결과불명", 0, 0, 1]);
    참인가("그 까닭이 적힌다", (await 로그("올리기.log")).includes("게시 요청 뒤 끊김 — 다시 보내지 않음"));
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const [r1, r2] = await Promise.all([MP.run(빠르게), MP.run(빠르게)]);
    같나("동시에 두 곳에서 돌려도 한쪽만 올린다(다른 쪽은 「이미 돌고 있음」)", [[r1.busy, r2.busy].filter(Boolean).length, 게시수(w), 게시수(w, "th")], [1, 1, 1]);
  });

  구역("거절 · 아직 처리 중 — 올라가지 않았음이 분명한 것만 다시 시도");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.igPublish = "reject";
    const d = await 완주(w, "a.mp4");
    let t = J(d.id).targets.instagram!;
    같나("메타가 분명히 거절하면 「실패」 · 사람 말 안내", [t.state, 게시수(w), t.why!.includes("거절"), t.why!.includes("권한이 없습니다")], ["실패", 1, true, true]);
    같나("화면 단추: 다시 시도", MP.listJobs()[0].targets[0].actions, ["retry"]);
    같나("실패한 일감은 사본을 둔다", await 있나(J(d.id).file), true);
    w.meta.igPublish = "ok";
    await MP.retryTarget(d.id, "instagram");
    같나("다시 시도하면 대기", [J(d.id).targets.instagram!.state, J(d.id).phase], ["대기", "진행"]);
    await MP.run(빠르게);
    t = J(d.id).targets.instagram!;
    같나("다시 올렸다 · 컨테이너는 새로", [t.state, w.meta.callsTo(/^ig\.container$/).length, 게시수(w)], ["올림", 2, 2]);
    await 던지나("실패가 아닌 것은 다시 시도할 수 없다", () => MP.retryTarget(d.id, "instagram"), /실패/);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.igPublish = "notready";
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date();
    await MP.run({ ...빠르게, now: t0 });
    let t = J(d.id).targets.instagram!;
    같나("아직 처리 중(9007)이라는 답은 올라가지 않은 것 — 컨테이너를 다시 만들지 않고 기다린다", [t.state, 게시수(w), Date.parse(t.next_at!) - t0.getTime()], ["올리는중", 1, 2 * 분]);
    await MP.run({ ...빠르게, now: t0 });
    같나("기다리는 동안은 건드리지 않는다", [게시수(w), w.meta.callsTo(/^ig\.container$/).length], [1, 1]);
    w.meta.igPublish = "ok";
    await MP.run({ ...빠르게, now: new Date(t0.getTime() + 3 * 분) });
    t = J(d.id).targets.instagram!;
    같나("시간이 지나면 같은 컨테이너로 올린다", [t.state, 게시수(w), w.meta.callsTo(/^ig\.container$/).length], ["올림", 2, 1]);
  });
}

/* ═══════════════════════════ 11. 오류와 기다림 ═══════════════════════════ */

async function 오류와기다림시험() {
  구역("오류 — 일시 오류·한도는 나중에 다시, 로그인·권한 문제는 실패로 알린다");
  const 컨테이너길 = /graph\.instagram\.com\/v26\.0\/[^/]+\/media$/;
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(컨테이너길, 500, { error: { message: "An unexpected error has occurred.", code: 2 } });
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date();
    await MP.run({ ...빠르게, now: t0 });
    let t = J(d.id).targets.instagram!;
    같나("일시 오류: 10분 뒤로 미룬다 · 아직 대기", [t.state, t.tries, Date.parse(t.next_at!) - t0.getTime(), t.why!.includes("나중에 다시 시도")], ["대기", 1, 10 * 분, true]);
    await MP.run({ ...빠르게, now: t0 });
    같나("미룬 동안은 건드리지 않는다", [w.meta.callsTo(/^ig\.container$/).length, w.meta.callsTo(/ticket/).length], [1, 1]);
    await MP.run({ ...빠르게, now: new Date(t0.getTime() + 11 * 분) });
    같나("때가 되면 올린다 · 임시 보관은 다시 올리지 않고 쓴다", [J(d.id).targets.instagram!.state, w.meta.callsTo(/ticket/).length, w.meta.callsTo(/^r2\.put$/).length], ["올림", 1, 1]);
    t = J(d.id).targets.instagram!;
    참인가("올림이 되면 오류 문구는 지운다", t.why === undefined && t.next_at === undefined);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(컨테이너길, 400, { error: { message: "Application request limit reached", code: 4 } });
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date();
    await MP.run({ ...빠르게, now: t0 });
    const t = J(d.id).targets.instagram!;
    같나("한도에 걸리면 1시간 뒤", [t.state, Date.parse(t.next_at!) - t0.getTime(), t.why!.includes("한도")], ["대기", 60 * 분, true]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(컨테이너길, 400, { error: { message: "Error validating access token: Session has expired", code: 190 } });
    const d = await 완주(w, "a.mp4");
    const t = J(d.id).targets.instagram!;
    같나("로그인이 풀린 오류는 바로 실패 + 다시 연결 안내", [t.state, t.why!.includes("다시 연결"), 게시(w)], ["실패", true, 0]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(컨테이너길, 500, { error: { message: "일시 오류", code: 2 } }, 99);
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date();
    for (let i = 0; i < 5; i++) await MP.run({ ...빠르게, now: new Date(t0.getTime() + i * 11 * 분) });
    const t = J(d.id).targets.instagram!;
    같나("일시 오류가 5번 이어지면 실패로 알린다", [t.state, t.tries, w.meta.callsTo(/^ig\.container$/).length, 게시(w)], ["실패", 5, 5, 0]);
    참인가("실패 줄이 기록에 남는다", (await 로그("올리기.log")).includes("인스타그램 실패  [채널A]"));
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    await MT.updateStore((s) => { s[w.ig].expires_at = new Date(Date.now() - 일).toISOString(); });
    const d = await 완주(w, "a.mp4");
    const t = J(d.id).targets.instagram!;
    같나("토큰이 만료돼 있으면 메타를 부르지 않고 실패", [t.state, t.why!.includes("만료"), w.meta.calls.length], ["실패", true, 0]);
    참인가("계정 목록에도 까닭이 보인다", /만료/.test(MT.accountsView()[0].error ?? ""));
  });

  구역("처리 기다리기 · 처리 오류 · 임시 보관 오류");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.igStatus = ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date();
    const r1 = await MP.run({ ...빠르게, now: t0 });
    let t = J(d.id).targets.instagram!;
    같나("아직 처리 중이면 5분 뒤로 미룬다(최대 5번 확인)", [t.state, r1.waiting, w.meta.callsTo(/^ig\.status$/).length, Date.parse(t.next_at!) - t0.getTime(), 게시(w)], ["올리는중", 1, 5, 5 * 분, 0]);
    await MP.run({ ...빠르게, now: t0 });
    같나("미룬 동안은 상태도 안 본다", w.meta.callsTo(/^ig\.status$/).length, 5);
    await MP.run({ ...빠르게, now: new Date(t0.getTime() + 6 * 분) });
    t = J(d.id).targets.instagram!;
    같나("같은 컨테이너를 이어서 보고 끝나면 올린다", [t.state, w.meta.callsTo(/^ig\.container$/).length, w.meta.callsTo(/^ig\.status$/).length], ["올림", 1, 6]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.igStatus = ["ERROR"];
    const d = await 완주(w, "a.mp4");
    const t = J(d.id).targets.instagram!;
    같나("메타가 영상 처리에 실패하면 실패 + 까닭", [t.state, t.why!.includes("받아들이지 않았습니다"), 게시(w), d.run.failed], ["실패", true, 0, 1]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.putFail = true;
    const d = await 완주(w, "a.mp4");
    let t = J(d.id).targets.instagram!;
    같나("임시 보관 올리기가 거절되면 실패 · 메타는 부르지 않는다", [t.state, t.why!.includes("임시 보관에 올리지 못했습니다 (403)"), w.meta.callsTo(/^ig\./).length], ["실패", true, 0]);
    w.meta.putFail = false;
    await MP.retryTarget(d.id, "instagram");
    await MP.run(빠르게);
    같나("고친 뒤 다시 시도하면 올라간다", [J(d.id).targets.instagram!.state, 게시(w)], ["올림", 1]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(/relay\.example\.test\/stage\/ticket/, 401, { ok: false, why: "계정 확인에 실패했습니다" });
    const d = await 완주(w, "a.mp4");
    const t = J(d.id).targets.instagram!;
    같나("중계 서버가 계정을 확인하지 못하면 실패 + 까닭", [t.state, t.why!.includes("임시 보관 요청이 거절됐습니다 (401 — 계정 확인에 실패했습니다)")], ["실패", true]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(/relay\.example\.test\/stage\/ticket/, 503, { ok: false, why: "잠시 후" });
    const d = await 완주(w, "a.mp4");
    같나("중계 서버가 일시적으로 안 되면 나중에 다시", [J(d.id).targets.instagram!.state, J(d.id).targets.instagram!.next_at !== undefined], ["대기", true]);
  });
  구역("임시 보관 — 중계가 이번 달 R2 무료 한도로 닫았을 때 (과금이 생기지 않게 멈춘 것)");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const 열림 = new Date(Date.now() + 12 * 일);
    열림.setUTCHours(0, 0, 0, 0);
    const 날짜글 = `${열림.getMonth() + 1}월 ${열림.getDate()}일`;
    w.meta.failNext(/relay\.example\.test\/stage\/ticket/, 503, { ok: false, code: "monthly_free_cap", resource: "class_a", reopens_at: 열림.toISOString(), why: "중계가 적은 말" }, 2);
    const d = await 담기(w, "cap.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date(Date.now() + 1000);
    const r1 = await MP.run({ ...빠르게, now: t0 });
    const ig = J(d.id).targets.instagram!, th = J(d.id).targets.threads!;
    같나("인스타·스레드 모두 실패가 아니라 「대기」로 남고, 다시 열리는 시각까지 건드리지 않는다", [ig.state, th.state, ig.next_at, th.next_at, ig.tries, th.tries], ["대기", "대기", 열림.toISOString(), 열림.toISOString(), 0, 0]);
    같나("화면에 보이는 까닭: 「이번 달 무료 한도 도달 — N월 N일에 다시 열림」", [ig.why, th.why], [`이번 달 무료 한도 도달 — ${날짜글}에 다시 열림`, `이번 달 무료 한도 도달 — ${날짜글}에 다시 열림`]);
    const 보임 = MP.listJobs().find((x) => x.id === d.id)!.targets;
    같나("화면 목록에도 그 문구 · 단추 없음(자동으로 기다림)", [보임.map((x) => x.state), 보임.every((x) => x.why.includes(`${날짜글}에 다시 열림`)), 보임.every((x) => x.actions.length === 0)], [["대기", "대기"], true, true]);
    같나("메타(인스타·스레드)는 한 번도 부르지 않았다 · 올리기 결과는 대기 두 건", [w.meta.callsTo(/^(ig|th)\./).length, r1.waiting, r1.failed], [0, 2, 0]);
    참인가("기록에 「보류」 한 줄씩", ((await 로그("올리기.log")).match(/보류/g) ?? []).length === 2);
    참인가("유튜브 쪽 일감 구조는 그대로(영상 사본 보관 · 일감은 진행 중)", J(d.id).phase === "진행" && (await 있나(J(d.id).file)));

    const 호출 = w.meta.callsTo(/stage\/ticket/).length;
    await MP.run({ ...빠르게, now: new Date(t0.getTime() + 일) });
    await MP.run({ ...빠르게, now: new Date(열림.getTime() - 분) });
    같나("다시 열리는 시각 전에는 몇 번을 돌려도 중계를 다시 부르지 않는다", w.meta.callsTo(/stage\/ticket/).length, 호출);

    await MP.run({ ...빠르게, now: new Date(열림.getTime() + 분) });
    같나("다시 열린 뒤 처음 도는 때 올린다(이번엔 중계가 받아 준다)", [J(d.id).targets.instagram!.state, J(d.id).targets.threads!.state, 게시(w)], ["올림", "올림", 2]);
    참인가("올린 뒤에는 보류 까닭이 지워진다", !J(d.id).targets.instagram!.why && !J(d.id).targets.threads!.why);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(/relay\.example\.test\/stage\/ticket/, 429, { ok: false, code: "stage_full", retry_after: 1800, why: "가득" });
    const d = await 담기(w, "full.mp4");
    await MP.markPublic(d.id);
    const t0 = new Date(Date.now() + 1000);
    await MP.run({ ...빠르게, now: t0 });
    const t = J(d.id).targets.instagram!;
    같나("보관함이 가득 찬 것은 달 한도와 다르다: 30분 뒤 다시 · 시도 1번", [t.state, Date.parse(t.next_at!) - t0.getTime(), t.tries, t.why!.includes("가득")], ["대기", 30 * 분, 1, true]);
    await MP.run({ ...빠르게, now: new Date(t0.getTime() + 31 * 분) });
    같나("30분 뒤 다시 하면 올라간다", [J(d.id).targets.instagram!.state, 게시(w)], ["올림", 1]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.failNext(/relay\.example\.test\/stage\/ticket/, 503, { ok: false, code: "monthly_free_cap", reopens_at: "엉터리 시각" });
    const d = await 완주(w, "bad.mp4");
    같나("다시 열리는 시각이 엉터리면 한도 문구를 믿지 않고 일반 거절(5xx 라 나중에 다시)로 처리", [J(d.id).targets.instagram!.state, J(d.id).targets.instagram!.why!.includes("임시 보관 요청이 거절됐습니다 (503")], ["대기", true]);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    setEmbeddedMetaForTest(null);
    await MP.run(빠르게);
    같나("이 판에 연결 정보가 없으면 실패 + 까닭", [J(d.id).targets.instagram!.state, J(d.id).targets.instagram!.why!.includes("연결 정보가 이 판에 들어 있지 않습니다")], ["실패", true]);
    같나("메타 호출 0건", w.meta.callsTo(/^(ig|th)\./).length, 0);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    await Deno.remove(J(d.id).file);
    await MP.run(빠르게);
    참인가("올릴 사본이 사라졌으면 실패 + 까닭", J(d.id).targets.instagram!.state === "실패" && J(d.id).targets.instagram!.why!.includes("정리되어 없습니다"));
    await 던지나("사본이 없으면 다시 시도도 못 한다", () => MP.retryTarget(d.id, "instagram"), /사본이 이미 정리/);
  });
}

const 게시 = (w: 세상) => w.meta.callsTo(/\.publish$/).length;

/* ═══════════════════════════ 12. 청소 ═══════════════════════════ */

async function 청소시험() {
  구역("청소 — 오래된 것 정리 · 사본 보관 기한");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    const 옛 = await 담기(w, "old.mp4", { now: new Date(Date.now() - 15 * 일) });
    const 지난 = await 담기(w, "gone.mp4", { now: new Date(Date.now() - 61 * 일) });
    await MP.markDropped(지난.id, "시험", { now: new Date(Date.now() - 61 * 일) });
    await MP.run(빠르게);
    같나("14일 지나도 공개가 안 되면 접는다", [상태(옛.id), J(옛.id).phase, J(옛.id).file], [["취소", undefined], "끝", ""]);
    같나("60일 지난 끝난 기록은 지운다", J(지난.id), undefined);
    같나("청소 중 메타 호출 0건", w.meta.calls.length, 0);
  });
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    w.meta.igPublish = "5xx_lost";
    const d = await 완주(w, "a.mp4");
    참인가("확인이 필요한 동안은 사본을 둔다", (await 있나(J(d.id).file)) && J(d.id).file !== "");
    await MP.run({ ...빠르게, now: new Date(Date.now() + 8 * 일) });
    같나("7일이 지나면 사본을 치운다(원본은 그대로)", [J(d.id).file, await 있나(d.path), J(d.id).targets.instagram!.state], ["", true, "결과불명"]);
    같나("요약", MP.summary(), { waiting: 0, unknown: 1, failed: 0 });
  });
}

/* ═══════════════════════════ 13. 훅 ═══════════════════════════ */

async function 훅시험() {
  구역("훅 — 업로드 직후 담기 · 심사 통과 시 올릴 때로 · 어떤 실패도 유튜브를 막지 않는다");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const v1 = await 영상두기(w.c.folder, "영상1.mp4", { txt: "[제목]\n첫 영상 제목\n\n[설명]\n설명 한 줄\n\n[해시태그]\n#태그가 #태그나\n" });
    const vid = (await uploadOne(일감(w.c, v1), { say, waitScale: 0 }))!;
    같나("유튜브 쪽은 전과 같다 — 비공개로 올라간다", w.fake.callsTo(/^videos\.insert$/)[0].body.status?.privacyStatus, "private");
    같나("업로드가 끝나면 인스타·스레드 장부에 담긴다", [J(vid)?.phase, 상태(vid)], ["영상대기", ["대기", "대기"]]);
    참인가("글은 쿠팡 링크 전의 글", J(vid).text.caption.includes("첫 영상 제목") && J(vid).text.caption.includes("#태그가"));
    같나("업로드 때 메타 호출 0건", w.meta.calls.length, 0);

    // 심사 통과 → 올릴 때가 된다 → 올린다 (전체 이야기)
    const 예전 = isoWall(new Date(wallNow().getTime() - 40 * 분));
    await R.updatePending((items) => { for (const it of items) if (it.video_id === vid) it.uploaded = 예전; return items; });
    await R.run(true, "예약작업", { say });
    같나("유튜브가 공개되면 올릴 때로 바뀐다", [w.fake.videos.get(vid)!.status.privacyStatus, J(vid).phase], ["public", "진행"]);
    같나("그 뒤 한 바퀴에 둘 다 올라간다", [(await MP.run(빠르게)).posted, 상태(vid)], [2, ["올림", "올림"]]);

    // 영상 쪽지(json)가 인스타그램을 끈다
    const v2 = await 영상두기(w.c.folder, "영상2.mp4");
    await Deno.writeTextFile(v2.replace(/\.mp4$/, ".json"), '{"instagram": false}');
    const vid2 = (await uploadOne(일감(w.c, v2), { say, waitScale: 0 }))!;
    같나("쪽지가 인스타그램을 끄면 스레드만 담긴다", 상태(vid2), [undefined, "대기"]);
    // 받기에서 쪽지를 읽어 일감에 실은 값이 먼저다
    const v3 = await 영상두기(w.c.folder, "영상3.mp4");
    const vid3 = (await uploadOne(일감(w.c, v3, { 메타올림: { instagram: false, threads: false } }), { say, waitScale: 0 }))!;
    같나("일감에 실린 끔이 채널 설정보다 앞선다", J(vid3), undefined);
    // 롱폼
    const v4 = await 영상두기(w.c.folder, "영상4.mp4", { long: true });
    const vid4 = (await uploadOne(일감(w.c, v4), { say, waitScale: 0 }))!;
    참인가("롱폼은 건너뜀 + 까닭", 상태(vid4).join() === "건너뜀,건너뜀" && J(vid4).targets.instagram!.why!.includes("롱폼"));
    같나("유튜브 업로드는 모두 정상", [vid, vid2, vid3, vid4].every((x) => x.startsWith("FAKE")), true);
  });

  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    await Deno.writeTextFile(dataPath("메타대기"), "폴더 자리를 파일이 차지하고 있다");
    const v = await 영상두기(w.c.folder, "영상1.mp4");
    const vid = await uploadOne(일감(w.c, v), { say, waitScale: 0 });
    참인가("장부를 쓰지 못해도 유튜브 업로드는 끝까지 간다", typeof vid === "string" && vid.startsWith("FAKE"));
    참인가("그 까닭이 기록에 남는다 · 장부에는 아무것도 없다", (await 로그("올리기.log")).includes("인스타그램·스레드 준비 실패") && Object.keys(MP.loadJobs().jobs).length === 0);
    참인가("업로드 줄은 그대로 남는다", (await 로그("올리기.log")).includes(`업로드  [채널A] 영상1.mp4  ${vid}`));
  });

  구역("훅 — 심사 결과별: 공개 · 예약 · 거부 · 영상 없음");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    const 현재 = wallNow();
    const 올림 = (분전: number) => isoWall(new Date(현재.getTime() - 분전 * 분));
    let n = 0;
    const 영상 = async (o: { video?: Obj; pend?: Obj; 없음?: boolean } = {}) => {
      const id = `RV${++n}`;
      if (!o.없음) w.fake.addVideo({ id, channelId: w.c.id, snippet: { title: `영상 ${id}` }, status: { privacyStatus: "private", uploadStatus: "processed", ...(o.video ?? {}) } });
      await appendLedger({ 업로드시각: 올림(40), 채널: "채널A", 영상ID: id, 제목: `영상 ${id}`, 파일: `/f/${id}.mp4`, 길이초: "40.0", 해상도: "1080x1920", 공개설정: "비공개(검토대기)" });
      await R.updatePending((items) => { items.push({ channel: "채널A", video_id: id, title: `영상 ${id}`, publish_at: null, uploaded: 올림(40), 확인수: 0, 사람확인: false, 시각정한이: "auto", ...(o.pend ?? {}) }); return items; });
      await 담기(w, `${id}.mp4`, { videoId: id });
      return id;
    };
    const 먼 = new Date(Date.now() + 600 * 분).toISOString().replace(/\.\d{3}Z$/, "Z");
    const 거부 = await 영상({ video: { uploadStatus: "rejected", rejectionReason: "copyright" } });
    const 없음 = await 영상({ 없음: true });
    const 예약 = await 영상({ pend: { publish_at: 먼, 시각정한이: "user" } });
    const 공개 = await 영상();
    await R.run(true, "예약작업", { say });
    같나("거부된 영상은 접는다", [상태(거부), J(거부).phase], [["취소", "취소"], "끝"]);
    같나("유튜브에서 사라진 영상도 접는다", 상태(없음), ["취소", "취소"]);
    같나("공개 예약은 열리는 시각 2분 뒤부터", [J(예약).phase, J(예약).go_after], ["진행", new Date(Date.parse(먼) + 2 * 분).toISOString()]);
    같나("바로 공개된 영상은 지금부터", [J(공개).phase, Date.parse(J(공개).go_after!) <= Date.now()], ["진행", true]);
    const r = await MP.run(빠르게);
    같나("지금 올릴 수 있는 것은 공개된 영상 하나(둘 다 올라감)", [r.posted, 상태(공개), 상태(예약), 상태(거부)], [2, ["올림", "올림"], ["대기", "대기"], ["취소", "취소"]]);
  });

  구역("훅 — 심사확인(tick)의 마지막 단계");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    setEmbeddedMetaForTest(null);
    const t0 = await tick({ force: true, fire: async () => 0 });
    같나("연결 정보가 없는 판: 「꺼짐」이고 메타 호출 0건", [t0.steps.find((s) => s.name === "인스타·스레드")?.note, w.meta.calls.length], ["꺼짐", 0]);
    setEmbeddedMetaForTest(열쇠);
    const d = await 담기(w, "a.mp4");
    await MP.markPublic(d.id);
    const t1 = await tick({ force: true, fire: async () => 0 });
    const 단계 = t1.steps.find((s) => s.name === "인스타·스레드")!;
    같나("공개 확인된 것을 맨 끝 단계에서 올린다", [단계.ok, 단계.note.startsWith("올림 1"), J(d.id).targets.instagram!.state], [true, true, "올림"]);
    같나("다른 단계는 그대로 돈다(맨 끝 순서)", [t1.steps.length >= 8, t1.steps[t1.steps.length - 1].name], [true, "인스타·스레드"]);
  });
}

/* ═══════════════════════════ 14. 화면 길 ═══════════════════════════ */

async function 화면길시험() {
  구역("화면 길 — 모양 · 토큰 없음 · 잘못된 요청");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir, { th: false });
    const 길 = buildRoutes(newAppState() as never);
    const 몸 = (body: Obj) => ({ q: new URLSearchParams(), body, headers: new Headers(), req: new Request("http://127.0.0.1/"), port: 0 });
    const get = async () => (await 길.post["meta/get"](몸({}) as never)) as Obj;
    MT.signin.state = { running: false, provider: null };

    setEmbeddedMetaForTest(null);
    const 꺼짐 = await get();
    같나("연결 정보가 없으면 기능이 숨는다", [꺼짐.available.on, 꺼짐.accounts, 꺼짐.jobs], [false, [], []]);
    setEmbeddedMetaForTest(열쇠);

    const d = await 담기(w, "a.mp4");
    const g = await get();
    같나("연결 정보가 있으면 켜짐", [g.available.on, g.available.instagram, g.available.threads], [true, true, true]);
    같나("계정 목록", g.accounts.map((a: Obj) => [a.key, a.provider, a.username]), [[w.ig, "instagram", "릴스계정"]]);
    같나("채널 짝", g.channels, [{ alias: "채널A", instagram: w.ig }]);
    같나("일감 목록 · 요약", [g.jobs[0].id, g.jobs[0].targets[0].state, g.summary], [d.id, "대기", { waiting: 1, unknown: 0, failed: 0 }]);
    참인가("답에는 토큰 값이 없다", !JSON.stringify(g).includes("TOK-"));

    await 던지나("종류를 잘못 고르면", () => 길.post["meta/bind"](몸({ alias: "채널A", provider: "페이스북", key: w.ig }) as never), /인스타그램 또는 스레드/);
    await 던지나("모르는 계정으로 짝지으면", () => 길.post["meta/bind"](몸({ alias: "채널A", provider: "instagram", key: "ig:없음" }) as never), /연결된 인스타그램 계정이 아닙니다/);
    await 길.post["meta/bind"](몸({ alias: "채널A", provider: "instagram", key: "" }) as never);
    같나("빈 값이면 끈다", MT.bindingOf(confFor("채널A")), {});
    await 길.post["meta/bind"](몸({ alias: "채널A", provider: "instagram", key: w.ig }) as never);
    같나("다시 건다", MT.bindingOf(confFor("채널A")), { instagram: w.ig });
    await 던지나("올라갔는지 안 올라갔는지 고르지 않으면", () => 길.post["meta/job/resolve"](몸({ id: d.id, provider: "instagram" }) as never), /올라갔는지 안 올라갔는지/);
    await 던지나("취소할 것이 없으면", () => 길.post["meta/job/cancel"](몸({ id: "없음" }) as never), /취소할 수 있는/);
    같나("로그인 진행 확인: 안 한 상태", (await 길.post["meta/signin/check"](몸({}) as never).catch((e: Error) => ({ 오류: e.message }))) as Obj, { 오류: "로그인이 끝나지 않았습니다" });
    setEmbeddedMetaForTest({ ...열쇠, th_app_id: "" });
    같나("로그인 시작: 이 판에 번호가 없는 쪽은 거절(브라우저를 열지 않는다)", await 길.post["meta/signin/start"](몸({ provider: "threads" }) as never).then(() => "시작됨", (e: Error) => e.message), "이 판에는 스레드 연결 정보가 들어 있지 않습니다");
    setEmbeddedMetaForTest(열쇠);

    // 실패 → 다시 시도 (뒤에서 올린다)
    w.meta.igPublish = "reject";
    await MP.markPublic(d.id);
    await MP.run(빠르게);
    같나("실패한 올리기", J(d.id).targets.instagram!.state, "실패");
    w.meta.igPublish = "ok";
    await 길.post["meta/job/retry"](몸({ id: d.id, provider: "instagram" }) as never);
    await 뒤쪽끝(d.id, "instagram", ["올림", "실패"]);
    같나("다시 시도하면 뒤에서 올린다", J(d.id).targets.instagram!.state, "올림");

    // 끊기
    await 던지나("연결되지 않은 계정을 끊으면", () => 길.post["meta/disconnect"](몸({ key: "ig:없음" }) as never), /연결된 계정이 아닙니다/);
    await 길.post["meta/disconnect"](몸({ key: w.ig }) as never);
    같나("끊으면 계정 목록과 채널 짝이 비워진다", [(await get()).accounts, MT.bindingOf(confFor("채널A"))], [[], {}]);
  });
}

/* ═══════════════════════════ 15. 토큰이 새지 않는다 ═══════════════════════════ */

async function 새지않음시험() {
  구역("토큰이 새지 않는다 — 토큰 파일 밖 어디에도 값이 없다");
  await 모래상자(async (dir) => {
    const w = await 세상만들기(dir);
    w.meta.igPublish = "5xx_lost";
    const d = await 완주(w, "a.mp4");
    await MP.checkUnknown(d.id, "instagram", { now: new Date(Date.now() + 40 * 분) });
    const 토큰들 = ["TOK-instagram-17841400000000001", "TOK-threads-26310000000000002"];
    const 데이터 = Deno.env.get("GARASADAE_DATA_DIR")!;
    const 새는곳: string[] = [];
    let 저장소에있음 = false;
    for (const p of await 글파일들(데이터)) {
      const 글 = await Deno.readTextFile(p);
      const 있음 = 토큰들.some((t) => 글.includes(t));
      if (p.endsWith("메타토큰.json")) 저장소에있음 = 있음;
      else if (있음) 새는곳.push(p.slice(데이터.length));
    }
    같나("토큰은 메타토큰.json 에만 있다", [저장소에있음, 새는곳], [true, []]);
    참인가("화면용 목록·계정 목록·요약에도 없다", !JSON.stringify([MP.listJobs(), MT.accountsView(), MP.summary()]).includes("TOK-"));
    참인가("보고 줄에도 없다", !보고.join("\n").includes("TOK-"));
  });
}

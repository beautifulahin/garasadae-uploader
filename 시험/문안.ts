// AI 문안 시험 — 제목·설명·해시태그를 영상·채널에 맞게 자동으로 짓는다. 구글 AI 스튜디오는 가짜(setAiBackend), 유튜브는 가짜 서버만 쓴다. 실제 호출 0건.
import { 같나, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 영상두기, 채널준비 } from "./바탕.ts";
import {
  aiNotice, aiState, aiUsable, autoMeta, buildMetaPrompt, channelSamples, checkMetaText, clearMetaRecord, composeFromAi, finalizeMeta,
  isoDurationSec, metaRecordFor, pickSamples, productQueries, resolveMeta, sanitizeMeta, saveAiSettings, setAiBackend, splitHashFromDesc, testKey,
  type AiBackend, type Sample,
} from "../app/ai.ts";
import { uploadOne } from "../app/upload.ts";
import { receive } from "../app/receive.ts";
import { appSettings, saveAppSettings } from "../app/settings.ts";
import { editChannels, confFor } from "../app/channels.ts";
import { exitGate, ExitBlocked, resetSafetyCache } from "../app/safety.ts";
import { dataPath, readJsonSync, writeJson } from "../app/paths.ts";
import { forceToolMissing } from "../app/tools.ts";
import { systemZone, wall, wallToInstant } from "../app/clock.ts";
import { check } from "../app/shorts.ts";

type Obj = Record<string, any>;

/** 가짜 AI — 부를 때마다 요청을 모아 두고, 정해 둔 답을 차례로 준다 */
class 가짜AI implements AiBackend {
  metaCalls: { path: string; prompt: string; key: string; model: string }[] = [];
  textCalls: { prompt: string }[] = [];
  /** 영상 문안 답(함수면 호출 번호·프롬프트를 받는다). 부족하면 마지막 것을 되풀이 */
  answers: (Obj | ((n: number, prompt: string) => Obj | Error))[] = [];
  textAnswer: Obj | Error = { queries: [] };
  gate: Promise<void> | null = null;
  async meta(req: { path: string; prompt: string; key: string; model: string }): Promise<string> {
    const n = this.metaCalls.push({ path: req.path, prompt: req.prompt, key: req.key, model: req.model });
    if (this.gate) await this.gate;
    const a = this.answers[Math.min(n - 1, this.answers.length - 1)] ?? {};
    const v = typeof a === "function" ? a(n, req.prompt) : a;
    if (v instanceof Error) throw v;
    return JSON.stringify(v);
  }
  async text(req: { prompt: string }): Promise<string> {
    this.textCalls.push({ prompt: req.prompt });
    if (this.textAnswer instanceof Error) throw this.textAnswer;
    return JSON.stringify(this.textAnswer);
  }
}

const 좋은답 = (o: Obj = {}) => ({
  title: "비 오는 날 우산 하나로 끝내는 출근길", description: "갑자기 쏟아진 비에 우산 하나로 버틴 출근길 이야기.\n끝까지 보면 꿀팁이 있어요.",
  hashtags: ["우산", "출근길", "shorts"], keywords: ["비오는날", "우산추천", "출근", "장마", "꿀팁"], ...o,
});

const 로그글 = async (이름: string) => { try { return await Deno.readTextFile(dataPath("기록", 이름)); } catch { return ""; } };

export async function 실행() {
  구역("순수 계산 — 길이 읽기 · 표본 고르기 · 정리 · 검사");
  같나("ISO 길이 PT1M20S", isoDurationSec("PT1M20S"), 80);
  같나("ISO 길이 PT1H2M3S", isoDurationSec("PT1H2M3S"), 3723);
  같나("ISO 길이 PT45S / 이상한 글", [isoDurationSec("PT45S"), isoDurationSec("??")], [45, 0]);
  const S = (title: string, views: number, kind: "쇼츠" | "롱폼", at: string): Sample => ({ title, desc: "d", tags: [], views, sec: kind === "쇼츠" ? 30 : 600, kind, at });
  const 표본 = pickSamples([S("a", 100, "쇼츠", "2026-10-01"), S("b", 900, "쇼츠", "2026-09-01"), S("c", 500, "쇼츠", "2026-10-10"), S("d", 50, "쇼츠", "2026-10-11"), S("e", 5, "쇼츠", "2026-10-12"), S("L", 9999, "롱폼", "2026-10-13")], "쇼츠");
  같나("같은 꼴의 잘된 4개 + 최근 3개(겹치면 뺀다)", 표본.map((x) => x.title), ["b", "c", "a", "d", "e"]);
  같나("같은 꼴이 3개 미만이면 다른 꼴로 채운다", pickSamples([S("a", 1, "쇼츠", "2026-10-01"), S("L1", 50, "롱폼", "2026-10-02"), S("L2", 70, "롱폼", "2026-10-03")], "쇼츠").map((x) => x.title), ["a", "L2", "L1"]);
  const 정리 = sanitizeMeta({ title: "  <b>제목</b>\n  둘째 줄  ", desc: "설명 <script>\r\n\r\n\r\n\r\n끝", tags: ["#태그", "a,b", '따옴"표', "<x>", "태그", "가".repeat(40)] });
  같나("제목: 한 줄로·< > 는 전각으로", 정리.title, "＜b＞제목＜/b＞ 둘째 줄");
  같나("설명: < > 전각·빈 줄은 최대 하나", 정리.desc, "설명 ＜script＞\n\n끝");
  같나("태그: # 떼고·쉼표 따옴표 < > 제거·30자·겹침 제거", 정리.tags, ["태그", "ab", "따옴표", "x", "가".repeat(30)]);
  같나("제목은 100자에서 자른다(이모지를 반으로 안 가른다)", Array.from(sanitizeMeta({ title: "😀".repeat(120), desc: "", tags: [] }).title).length, 100);
  같나("설명 5000자 한도·여유를 두면 더 줄인다", [Array.from(sanitizeMeta({ title: "t", desc: "가".repeat(6000), tags: [] }).desc).length, Array.from(sanitizeMeta({ title: "t", desc: "가".repeat(6000), tags: [] }, { descLimit: 4200 }).desc).length], [5000, 4200]);
  같나("태그 전체 500자 이내", sanitizeMeta({ title: "t", desc: "", tags: Array.from({ length: 80 }, (_, i) => "태그번호" + i + "가나다라마") }).tags.join(",").length <= 500, true);
  같나("설명 맨 아래 해시태그 줄 떼기", splitHashFromDesc("본문\n\n#a #b\n#c"), { body: "본문", hashtags: ["a", "b", "c"] });
  같나("검사: 비어 있는 제목", checkMetaText({ title: "", desc: "", tags: [] }), ["제목이 비었습니다"]);
  같나("검사: 라벨이 제목 행세", checkMetaText({ title: "제목", desc: "", tags: [] })[0].startsWith("제목이 이상합니다"), true);
  같나("검사: 해시태그 15개 넘음", checkMetaText({ title: "t", desc: Array.from({ length: 16 }, (_, i) => "#t" + i).join(" "), tags: [] }).some((x) => x.includes("15개를 넘으면")), true);
  같나("검사: 채널 규격(한글 금지)", checkMetaText({ title: "한글", desc: "d\n\n#a", tags: [] }, { forbid_hangul: true }).some((x) => x.includes("한글")), true);
  같나("정상 문안은 통과", finalizeMeta({ title: "정상", desc: "본문\n\n#a #b", tags: ["a"] }).problems, []);

  구역("조립 — 쇼츠는 #shorts · 롱폼은 안 붙는다 · 고정 머리말·꼬리말·해시태그");
  const 쇼 = composeFromAi(좋은답(), { conf: null, kind: "쇼츠", rule: null });
  같나("쇼츠: 해시태그가 설명 맨 아래·shorts 포함", [쇼.desc.endsWith("#우산 #출근길 #shorts"), 쇼.tags.slice(0, 3)], [true, ["우산", "출근길", "shorts"]]);
  const 쇼2 = composeFromAi(좋은답({ hashtags: ["우산"] }), { conf: null, kind: "쇼츠", rule: null });
  같나("쇼츠: AI 가 빠뜨려도 #shorts 를 더한다", 쇼2.desc.endsWith("#우산 #shorts"), true);
  const 롱 = composeFromAi(좋은답(), { conf: null, kind: "롱폼", rule: null });
  같나("롱폼: AI 가 #shorts 를 줘도 뺀다", 롱.desc.includes("#shorts") || 롱.tags.includes("shorts"), false);
  const 규 = composeFromAi(좋은답(), { conf: null, kind: "쇼츠", rule: { forbid_shorts_tag: true } });
  같나("규격이 #shorts 를 금지하면 쇼츠에도 안 붙는다", 규.desc.includes("#shorts"), false);
  const 고 = composeFromAi(좋은답(), { conf: { channel_id: "x", folder: "", desc_head: "머리말입니다", desc_tail: "꼬리말입니다", fixed_tags: ["#고정", "우산"] }, kind: "쇼츠", rule: null });
  같나("머리말·본문·꼬리말·해시태그 순서", 고.desc.split("\n\n").slice(0, 3), ["머리말입니다", "갑자기 쏟아진 비에 우산 하나로 버틴 출근길 이야기.\n끝까지 보면 꿀팁이 있어요.", "꼬리말입니다"]);
  같나("고정 해시태그가 맨 앞·겹치면 한 번만", 고.desc.split("\n\n").at(-1), "#고정 #우산 #출근길 #shorts");

  구역("프롬프트 — 영상 내용 + 채널 말투 + 꼴 규칙");
  const p쇼 = buildMetaPrompt({ kind: "쇼츠", channel: "채널A", conf: { channel_id: "x", folder: "", tone: "반말로 가볍게", fixed_tags: ["고정"] }, sec: 41, w: 1080, h: 1920, have: {}, samples: [S("잘된 제목", 12345, "쇼츠", "2026-10-01")], fileName: "a.mp4" });
  같나("쇼츠 지시: 짧은 제목·짧은 설명", [p쇼.includes("40자 안팎"), p쇼.includes("2~3줄"), p쇼.includes("shorts 를 하나 포함")], [true, true, true]);
  같나("채널 표본이 실린다(조회수·꼴)", [p쇼.includes("잘된 제목"), p쇼.includes("조회 12,345 · 쇼츠")], [true, true]);
  같나("말투 메모·고정 해시태그가 실린다", [p쇼.includes("반말로 가볍게"), p쇼.includes("#고정")], [true, true]);
  const p롱 = buildMetaPrompt({ kind: "롱폼", channel: "채널A", conf: null, sec: 900, w: 1920, h: 1080, have: { title: "정해진 제목" }, samples: [], fileName: "b.mp4" });
  같나("롱폼 지시: 긴 설명·타임스탬프 금지·#shorts 금지", [p롱.includes("6~12줄"), p롱.includes("타임스탬프"), p롱.includes("shorts 는 넣지 마라")], [true, true, true]);
  같나("이미 사람이 정한 제목은 바꾸지 말라고 알린다", p롱.includes("제목(이미 정해짐 — 바꾸지 말고 여기에 맞춰라): 정해진 제목"), true);
  같나("표본이 없으면 없다고 알린다", p롱.includes("표본이 없다"), true);
  const p일 = buildMetaPrompt({ kind: "쇼츠", channel: "해외", conf: { channel_id: "x", folder: "", audio_language: "ja", meta_rule: { forbid_hangul: true, hashtags: 5, forbid_cta: true } }, sec: 30, w: 1080, h: 1920, have: {}, samples: [], fileName: "c.mp4" });
  같나("외국어 채널: 그 언어로·한글 금지·해시태그 개수·구독 유도 금지", [p일.includes("일본어로 지어라"), p일.includes("한글을 한 글자도 쓰지 마라"), p일.includes("정확히 5개"), p일.includes("구독·좋아요·알림 유도 문구")], [true, true, true, true]);

  구역("설정 — 기본 켜짐 · 열쇠 없으면 안내 · 열쇠 값은 어디에도 안 나온다");
  await 모래상자(async () => {
    같나("기본값: 켜짐·열쇠 없음 → 열쇠 안내가 필요", [aiState().enabled, aiState().hasKey, aiState().needsKey], [true, false, true]);
    같나("열쇠 없으면 문제 목록에 안내 한 줄", [aiNotice()?.kind, aiNotice()?.what, aiNotice()?.level], ["ai", "AI 열쇠를 넣으면 제목·설명·해시태그를 자동으로 지어 줍니다", "yellow"]);
    같나("열쇠 없으면 쓸 수 없고 까닭을 말한다", aiUsable("채널A"), { ok: false, why: "AI 열쇠가 없습니다 — 설정에서 열쇠를 넣으면 제목·설명·해시태그를 자동으로 지어 줍니다" });
    const fake = new 가짜AI(); setAiBackend(fake);
    같나("열쇠가 비었을 때 연결 시험은 안내", (await testKey("")).ok, false);
    const st = await saveAiSettings({ key: "KEY-비밀-1234", model: "m-test" });
    같나("열쇠를 저장하면 상태가 바뀐다 — 값은 응답에 없다", [st.hasKey, st.needsKey, JSON.stringify(st).includes("KEY-비밀")], [true, false, false]);
    같나("설정 파일은 권한 600", ((await Deno.stat(dataPath("앱설정.json"))).mode! & 0o777) === 0o600, true);
    같나("연결 시험(가짜 AI)", (await testKey()).ok, true);
    같나("연결 시험에 열쇠를 직접 줘도 된다", (await testKey("다른열쇠")).ok, true);
    같나("열쇠 문제 목록 안내가 사라진다", aiNotice(), null);
    await saveAiSettings({ on: false });
    같나("끄면 쓸 수 없다", aiUsable("채널A").why, "AI 문안이 꺼져 있습니다");
    await saveAiSettings({ on: true, clearKey: true });
    같나("열쇠 지우기", aiState().hasKey, false);
    setAiBackend(null);
  });

  구역("채널 말투 표본 — 이미 받은 youtube.readonly 로 하루 한 번만 읽는다");
  await 모래상자(async (dir) => {
    const fk = new 가짜구글(); fk.instantProcessing = true;
    const c = await 채널준비(dir, fk, { name: "채널A" });
    const 영상 = (id: string, title: string, views: number, dur: string, at: string, privacy = "public") =>
      fk.addVideo({ id, channelId: c.id, snippet: { title, description: `${title} 설명`, tags: ["가", "나"], publishedAt: at }, statistics: { viewCount: String(views) }, contentDetails: { duration: dur }, status: { privacyStatus: privacy } });
    영상("S1", "쇼츠 인기", 900, "PT30S", "2026-10-01T00:00:00Z"); 영상("S2", "쇼츠 보통", 100, "PT45S", "2026-10-05T00:00:00Z");
    영상("L1", "롱폼 하나", 500, "PT12M", "2026-09-20T00:00:00Z"); 영상("P1", "비공개 영상", 99999, "PT30S", "2026-10-06T00:00:00Z", "private");
    const now = new Date();
    const a = await channelSamples("채널A", "쇼츠", now);
    같나("같은 꼴 먼저·조회수 순·비공개는 빠진다", a.map((x) => x.title), ["쇼츠 인기", "쇼츠 보통", "롱폼 하나"]);
    같나("영상 길이로 쇼츠/롱폼을 가른다(근사)", a.map((x) => x.kind), ["쇼츠", "쇼츠", "롱폼"]);
    같나("유닛: 목록 1 + 영상 1", [fk.callsTo(/^playlistItems\./).length, fk.callsTo(/^videos\.list$/).length], [1, 1]);
    fk.clearCalls();
    await channelSamples("채널A", "롱폼", now);
    같나("하루 안에는 다시 읽지 않는다(호출 0건)", fk.calls.length, 0);
    await channelSamples("채널A", "쇼츠", new Date(now.getTime() + 25 * 3600_000));
    같나("하루가 지나면 다시 읽는다", fk.callsTo(/^playlistItems\./).length, 1);
    fk.failNext(/playlistItems/, 500, {}, 5);
    await Deno.remove(dataPath("채널말투표본.json"));
    같나("읽다 실패하면 던지지 않고 빈 표본", await channelSamples("채널A", "쇼츠", new Date(now.getTime() + 60 * 3600_000)), []);
    같나("실패는 AI.log 에 남는다", (await 로그글("AI.log")).includes("말투 표본을 못 읽음"), true);
  });

  구역("자동 문안 — 사람 > 쪽지 > 자동 > 파일 이름 (칸마다)");
  await 모래상자(async (dir) => {
    const fk = new 가짜구글(); fk.instantProcessing = true;
    const c = await 채널준비(dir, fk, { name: "채널A" });
    const ai = new 가짜AI(); ai.answers = [좋은답()]; setAiBackend(ai);
    await saveAiSettings({ key: "KEY-비밀-1234", on: true });
    const 정보 = async (f: string) => { const k = await check(f); return { sec: k.info.sec, w: k.info.w, h: k.info.h, kind: k.kind }; };
    const R = async (f: string, job: Obj = {}, extra: Obj = {}) => { const i = await 정보(f); return await resolveMeta({ channel: "채널A", file: f, kind: i.kind, sec: i.sec, w: i.w, h: i.h, job, generate: true, ...extra }); };

    // 1) 아무것도 없으면 AI 가 다 짓는다
    const v1 = await 영상두기(c.folder, "빈영상.mp4");
    const r1 = await R(v1);
    같나("문안이 하나도 없으면 AI 가 제목·설명·태그를 모두 짓는다", [r1.status, r1.source, r1.title], ["자동", { title: "자동", desc: "자동", tags: "자동" }, "비 오는 날 우산 하나로 끝내는 출근길"]);
    같나("AI 에 열쇠·모델·영상 경로가 간다", [ai.metaCalls[0].key, ai.metaCalls[0].model, ai.metaCalls[0].path === v1], ["KEY-비밀-1234", "gemini-3.5-flash-lite", true]);
    같나("쇼츠 꼴로 지었다", [r1.kind, r1.desc.endsWith("#shorts")], ["쇼츠", true]);
    같나("지은 것은 .txt 에 쓰지 않는다(사람이 정한 것으로 오해되지 않게)", await Deno.stat(v1.replace(/\.mp4$/, ".txt")).then(() => true, () => false), false);
    같나("지은 것을 기록해 둔다(미리보기가 읽는다)", metaRecordFor(v1)?.title, "비 오는 날 우산 하나로 끝내는 출근길");
    같나("검사를 통과했다", r1.checks, { ok: true, problems: [] });
    // 2) 같은 영상은 다시 안 부른다
    const 부름 = ai.metaCalls.length;
    const r1b = await R(v1);
    같나("같은 영상은 기록을 재사용한다(AI 호출 0건)", [r1b.cached, ai.metaCalls.length], [true, 부름]);
    같나("force 면 다시 짓는다", (await R(v1, {}, { force: true }), ai.metaCalls.length), 부름 + 1);
    같나("미리보기(generate=false)는 지어 둔 것만 쓰고 호출하지 않는다", (await R(v1, {}, { generate: false }), ai.metaCalls.length), 부름 + 1);
    const v1b = await 영상두기(c.folder, "아직안지음.mp4");
    같나("미리보기: 아직 안 지은 영상은 「올릴 때 자동으로」", (await R(v1b, {}, { generate: false })).why, "올릴 때 자동으로 지어집니다");
    // 3) 사람이 정한 것(txt)이 이긴다 — 칸마다
    const v2 = await 영상두기(c.folder, "사람글.mp4", { txt: "[제목]\n사람이 쓴 제목\n\n[설명]\n사람이 쓴 설명입니다\n\n[해시태그]\n#직접 #쓴\n" });
    const n2 = ai.metaCalls.length;
    const r2 = await R(v2);
    같나("제목·설명·태그를 사람이 다 썼으면 AI 를 부르지 않는다", [r2.status, r2.source, r2.title, ai.metaCalls.length], ["사람", { title: "사람", desc: "사람", tags: "사람" }, "사람이 쓴 제목", n2]);
    const v3 = await 영상두기(c.folder, "제목만.mp4", { txt: "[제목]\n제목만 사람이 씀\n" });
    const r3 = await R(v3);
    같나("제목만 사람이 썼으면 설명·태그만 자동", [r3.title, r3.source], ["제목만 사람이 씀", { title: "사람", desc: "자동", tags: "자동" }]);
    같나("그때 AI 에게 「제목은 이미 정해짐」 이라고 알린다", ai.metaCalls.at(-1)!.prompt.includes("제목(이미 정해짐 — 바꾸지 말고 여기에 맞춰라): 제목만 사람이 씀"), true);
    같나("txt 는 그대로 — 자동으로 지은 것이 섞여 들어가지 않는다", await Deno.readTextFile(v3.replace(/\.mp4$/, ".txt")), "[제목]\n제목만 사람이 씀\n");
    // 4) 쪽지
    const v4 = await 영상두기(c.folder, "쪽지글.mp4");
    await writeJson(v4.replace(/\.mp4$/, ".json"), { title: "쪽지 제목", description: "쪽지 설명" });
    const r4 = await R(v4);
    같나("쪽지의 제목·설명은 「쪽지」, 비어 있는 태그만 자동", [r4.title, r4.source], ["쪽지 제목", { title: "쪽지", desc: "쪽지", tags: "자동" }]);
    // 5) 일감에 직접 적은 값
    const v5 = await 영상두기(c.folder, "일감값.mp4");
    const r5 = await R(v5, { title: "일감 제목", desc: "일감 설명", tags: ["일감태그"] });
    같나("일감에 직접 적은 값도 사람이 정한 것", [r5.status, r5.title, r5.desc, r5.tags], ["사람", "일감 제목", "일감 설명", ["일감태그"]]);
    // 6) 열쇠 없음·끔·채널이 끔 → 파일 이름
    await saveAiSettings({ on: false });
    const v6 = await 영상두기(c.folder, "끈채로.mp4");
    const r6 = await R(v6);
    같나("꺼져 있으면 파일 이름이 제목", [r6.title, r6.source.title, r6.status], ["끈채로", "파일이름", "건너뜀"]);
    await saveAiSettings({ on: true });
    await editChannels((d) => { d["채널A"].ai = false; });
    const r7 = await R(await 영상두기(c.folder, "채널끔.mp4"));
    같나("이 채널이 AI 를 껐으면 파일 이름", [r7.source.title, r7.why], ["파일이름", "이 채널은 AI 문안을 껐습니다"]);
    await editChannels((d) => { delete d["채널A"].ai; });
    setAiBackend(null);
  });

  구역("자동 문안 — 롱폼 형식 · 검사 통과 · 다시 짓기 · 실패 · 30분 뒤 재시도");
  await 모래상자(async (dir) => {
    const fk = new 가짜구글(); fk.instantProcessing = true;
    const c = await 채널준비(dir, fk, { name: "채널A" });
    await saveAiSettings({ key: "KEY-비밀-1234", on: true });
    const ai = new 가짜AI(); setAiBackend(ai);
    const 정보 = async (f: string) => { const k = await check(f); return { sec: k.info.sec, w: k.info.w, h: k.info.h, kind: k.kind }; };
    const A = async (f: string, o: Obj = {}) => { const i = await 정보(f); return await autoMeta({ channel: "채널A", file: f, kind: i.kind, sec: i.sec, w: i.w, h: i.h, ...o }); };

    // 롱폼
    const L = await 영상두기(c.folder, "롱폼.mp4", { long: true });
    ai.answers = [좋은답({ description: "긴 설명 ".repeat(100), hashtags: ["여행", "shorts", "브이로그"], keywords: ["a", "b", "c", "d", "e", "f", "g", "h"] })];
    const rl = await A(L);
    같나("롱폼 지시가 간다(긴 설명)", ai.metaCalls[0].prompt.includes("6~12줄"), true);
    같나("롱폼에는 #shorts 가 없다", rl.record!.desc.includes("#shorts") || rl.record!.tags.includes("shorts"), false);
    같나("롱폼: 해시태그가 맨 아래", rl.record!.desc.endsWith("#여행 #브이로그"), true);

    // < > 와 너무 긴 제목·설명은 정리되어 통과
    const X = await 영상두기(c.folder, "정리.mp4");
    ai.answers = [좋은답({ title: "<긴>" + "가".repeat(150), description: "<b>설명</b> ".repeat(800) })];
    const rx = await A(X);
    같나("< > 글자와 길이를 정리해 검사를 통과한다", [rx.status, !/[<>]/.test(rx.record!.title + rx.record!.desc), Array.from(rx.record!.title).length <= 100, Array.from(rx.record!.desc).length <= 5000], ["자동", true, true, true]);

    // 규격에 걸리면 한 번 더 짓는다
    await editChannels((d) => { d["채널A"].meta_rule = { forbid_hangul: true, hashtags: 3 }; d["채널A"].audio_language = "ja"; });
    const J = await 영상두기(c.folder, "일본.mp4");
    ai.metaCalls.length = 0;
    ai.answers = [
      (_n, _p) => 좋은답({ title: "한글 제목", description: "한글 설명" }), // 1번째: 한글이 섞였다
      좋은답({ title: "雨の日の傘", description: "傘一本で通勤した話。", hashtags: ["傘", "通勤", "雨"], keywords: ["傘"] }),
    ];
    const rj = await A(J);
    같나("규격(한글 금지)에 걸리면 걸린 것을 알려 주고 한 번 더 짓는다", [rj.status, ai.metaCalls.length, ai.metaCalls[1].prompt.includes("앞서 지은 글이 검사에 걸렸다")], ["자동", 2, true]);
    같나("두 번째 글이 쓰인다", rj.record!.title, "雨の日の傘");
    같나("일본어로 지으라고 했다", ai.metaCalls[0].prompt.includes("일본어로 지어라"), true);
    같나("해시태그는 규격 개수(3)", splitHashFromDesc(rj.record!.desc).hashtags.length, 3);

    // 계속 못 지으면 포기 — 건너뜀 + 재시도 간격
    const F = await 영상두기(c.folder, "계속실패.mp4");
    ai.metaCalls.length = 0;
    ai.answers = [좋은답({ title: "한글만", description: "한글만" })];
    const rf = await A(F);
    같나("두 번 다 규격을 못 지키면 포기한다(건너뜀)", [rf.status, ai.metaCalls.length, rf.why.startsWith("지은 글이 문안 검사를 통과하지 못했습니다")], ["건너뜀", 2, true]);
    같나("그 영상은 AI 문안이 없는 것으로 남는다", metaRecordFor(F), null);
    const n = ai.metaCalls.length;
    await A(F);
    같나("30분 안에는 다시 부르지 않는다", ai.metaCalls.length, n);
    ai.answers = [좋은답({ title: "雨", description: "雨", hashtags: ["a", "b", "c"] })];
    const later = await A(F, { now: new Date(Date.now() + 31 * 60_000) });
    같나("30분이 지나면 다시 시도한다", later.status, "자동");
    await editChannels((d) => { delete d["채널A"].meta_rule; delete d["채널A"].audio_language; });

    // AI 호출 실패
    const E = await 영상두기(c.folder, "호출실패.mp4");
    ai.answers = [new Error("503 service unavailable key=SECRETKEY123&x=1")];
    const re = await A(E);
    같나("AI 호출이 실패해도 던지지 않는다 — 까닭을 한국말로", [re.status, re.why.startsWith("AI 가 문안을 짓지 못했습니다")], ["건너뜀", true]);
    같나("열쇠 글자는 까닭에 안 나온다", re.why.includes("SECRETKEY123"), false);
    같나("문제 목록에 한 줄 안내가 남는다", aiNotice()?.what, "AI 문안을 만들지 못한 영상이 있습니다");
    ai.answers = [new Error("403 API key not valid")];
    같나("열쇠 오류는 설정 확인을 안내", (await A(await 영상두기(c.folder, "열쇠오류.mp4"))).why.includes("설정에서 다시 확인"), true);
    ai.answers = ["이건 JSON 이 아님" as unknown as Obj];
    같나("AI 가 JSON 이 아닌 글을 줘도 던지지 않는다", (await A(await 영상두기(c.folder, "엉터리.mp4"))).status, "건너뜀");

    // 큰 영상(긴 영상)은 작은 사본이 필요 — ffmpeg 가 없으면 이유를 말하고 건너뜀(다시 시도 표식 없음)
    forceToolMissing("ffmpeg");
    const B = await 영상두기(c.folder, "아주긴.mp4", { sec: 1000 });
    ai.metaCalls.length = 0;
    const rb = await A(B);
    같나("15분이 넘는 영상은 작은 사본이 필요하다 — ffmpeg 가 없으면 건너뜀", [rb.status, rb.why.includes("ffmpeg"), ai.metaCalls.length], ["건너뜀", true, 0]);

    // 동시에 두 번 불려도 한 번만
    const K = await 영상두기(c.folder, "동시.mp4");
    let 풀기!: () => void;
    ai.gate = new Promise<void>((r) => { 풀기 = r; });
    ai.metaCalls.length = 0; ai.answers = [좋은답()];
    const p1 = A(K), p2 = A(K);
    await new Promise((r) => setTimeout(r, 30));
    풀기();
    const [x1, x2] = await Promise.all([p1, p2]);
    같나("같은 영상을 동시에 두 번 지으라 해도 AI 는 한 번만", [ai.metaCalls.length, x1.record?.title === x2.record?.title], [1, true]);
    ai.gate = null;
    같나("기록 지우기 → 다시 짓는다", [await clearMetaRecord(K), metaRecordFor(K)], [true, null]);
    setAiBackend(null);
  });

  구역("올리기 흐름 — 문안이 없는 영상이 자동 문안으로 올라가고, 실패해도 올라간다");
  await 모래상자(async (dir) => {
    const fk = new 가짜구글(); fk.instantProcessing = true;
    const c = await 채널준비(dir, fk, { name: "채널A" });
    await saveAiSettings({ key: "KEY-비밀-1234", on: true });
    const ai = new 가짜AI(); ai.answers = [좋은답()]; setAiBackend(ai);
    const job = (f: string, o: Obj = {}) => ({ channel: "채널A", file: f, _승인: "사람 승인", time_by: "user", ...o });
    const 보고: string[] = [];
    const v = await 영상두기(c.folder, "자동1.mp4");
    const vid = await uploadOne(job(v), { say: (s) => 보고.push(s), waitScale: 0 });
    const b = fk.callsTo(/^videos\.insert$/)[0].body;
    같나("올라간 제목·설명·태그가 자동으로 지은 것", [b.snippet.title, b.snippet.description.endsWith("#우산 #출근길 #shorts"), b.snippet.tags.slice(0, 3)], ["비 오는 날 우산 하나로 끝내는 출근길", true, ["우산", "출근길", "shorts"]]);
    같나("올리기 보고에 자동 문안이 알려진다", 보고.some((s) => s.includes("자동으로 지은 제목·설명·해시태그 을 씁니다 (쇼츠)")), true);
    같나("장부의 제목은 올라간 제목", (await Deno.readTextFile(dataPath("ledger.csv"))).includes("비 오는 날 우산 하나로 끝내는 출근길"), true);
    같나("txt 는 안 생긴다", await Deno.stat(v.replace(/\.mp4$/, ".txt")).then(() => true, () => false), false);
    참인가("영상이 올라갔다", !!vid);
    // 사람이 txt 로 제목을 정하면 그 칸은 사람 것
    const v2 = await 영상두기(c.folder, "자동2.mp4", { txt: "[제목]\n내가 정한 제목\n" });
    fk.clearCalls();
    await uploadOne(job(v2), { say: () => {}, waitScale: 0 });
    const b2 = fk.callsTo(/^videos\.insert$/)[0].body;
    같나("제목은 txt(사람), 설명·태그는 자동", [b2.snippet.title, b2.snippet.description.length > 0, b2.snippet.tags.length > 0], ["내가 정한 제목", true, true]);
    // AI 가 실패해도 업로드는 간다 — 파일 이름 제목으로
    ai.answers = [new Error("503 down")];
    const v3 = await 영상두기(c.folder, "파일이름제목.mp4");
    fk.clearCalls();
    const vid3 = await uploadOne(job(v3), { say: (s) => 보고.push(s), waitScale: 0 });
    같나("AI 가 실패해도 업로드는 막히지 않는다(파일 이름 제목)", [!!vid3, fk.callsTo(/^videos\.insert$/)[0].body.snippet.title], [true, "파일이름제목"]);
    같나("보고에 건너뜀 까닭이 남는다", 보고.some((s) => s.includes("AI 문안은 건너뜁니다")), true);
    // 열쇠가 없으면 지금처럼 파일 이름 (보고도 조용)
    await saveAiSettings({ clearKey: true });
    const v4 = await 영상두기(c.folder, "열쇠없음.mp4");
    보고.length = 0;
    await uploadOne(job(v4), { say: (s) => 보고.push(s), waitScale: 0 });
    같나("열쇠가 없으면 파일 이름 제목 + 보고는 안내 한 줄", [fk.callsTo(/^videos\.insert$/).at(-1)!.body.snippet.title, 보고.some((s) => s.includes("AI 열쇠가 없습니다"))], ["열쇠없음", true]);
    // 이미 올린 영상의 < > 는 정리된다
    await saveAiSettings({ key: "K2" });
    const v5 = await 영상두기(c.folder, "특수글자.mp4", { txt: "[제목]\n<제목> 입니다\n\n[설명]\n설명 <b>굵게</b>\n" });
    fk.clearCalls();
    await uploadOne(job(v5), { say: () => {}, waitScale: 0 });
    const b5 = fk.callsTo(/^videos\.insert$/)[0].body;
    같나("사람이 쓴 글의 < > 도 올리기 전에 정리한다(유튜브가 거부하는 글자)", [/[<>]/.test(b5.snippet.title + b5.snippet.description), b5.snippet.title], [false, "＜제목＞ 입니다"]);
    setAiBackend(null);
  });

  구역("받기·출구 — 문안이 없는 채로 받고, 규격이 있는 채널도 자동 문안으로 통과한다");
  await 모래상자(async (dir) => {
    const fk = new 가짜구글(); fk.instantProcessing = true;
    const c = await 채널준비(dir, fk, { name: "해외", conf: { meta_rule: { forbid_hangul: true, hashtags: 3 }, audio_language: "ja" } });
    await saveAiSettings({ key: "KEY-비밀-1234", on: true });
    const ai = new 가짜AI(); ai.answers = [좋은답({ title: "雨の日の傘", description: "傘一本で通勤した話。", hashtags: ["傘", "通勤", "雨"], keywords: ["傘"] })]; setAiBackend(ai);
    const 원본 = `${dir}/승인본`;
    const clock = wallToInstant(wall(2026, 10, 20, 12, 0), systemZone());
    const s1 = await 영상두기(원본, "문안없음.mp4");
    const r1 = await receive("해외", s1, { clock, youtubeHas: async () => "", say: () => {} });
    같나("문안이 하나도 없으면 곁글(txt)을 만들지 않는다 — 파일 이름이 제목으로 박히지 않게", await Deno.stat(r1.dst.replace(/\.mp4$/, ".txt")).then(() => true, () => false), false);
    같나("규격이 있어도 AI 가 올리기 직전에 채울 채널이면 받을 때 막지 않는다", r1.long, false);
    resetSafetyCache();
    const j = { channel: "해외", file: r1.dst, _승인: "사람 승인", time_by: "user", title: "", desc: "", tags: [] as string[] };
    const vid = await uploadOne(j, { say: () => {}, waitScale: 0 });
    같나("출구검사가 최종 글(AI 가 지은 것)로 규격을 재어 통과한다", [!!vid, fk.callsTo(/^videos\.insert$/)[0].body.snippet.title], [true, "雨の日の傘"]);
    // AI 가 규격을 못 지키면(출구에서 한글) — 한 번 더 짓다 포기하면 파일 이름(한글)이라 출구가 막는다
    ai.answers = [좋은답({ title: "한글제목", description: "한글" })];
    const s2 = await 영상두기(원본, "한글이름.mp4");
    const r2 = await receive("해외", s2, { clock, youtubeHas: async () => "", say: () => {} });
    const j2 = { channel: "해외", file: r2.dst, _승인: "사람 승인", time_by: "user", title: "", desc: "", tags: [] as string[] };
    fk.clearCalls();
    await 던지나("AI 도 규격을 못 지키고 파일 이름도 한글이면 출구가 막는다(규격 위반을 올리지 않는다)", () => uploadOne(j2, { say: () => {}, waitScale: 0 }), /문안 규격 미달/);
    같나("그때 유튜브 호출은 0건", fk.callsTo(/^videos\.insert/).length, 0);
    // 열쇠가 없는 규격 채널은 받을 때부터 막는다(예전 그대로)
    await saveAiSettings({ clearKey: true });
    const s3 = await 영상두기(원본, "문안없음3.mp4");
    await 던지나("열쇠가 없으면 받을 때 규격 검사를 그대로 한다(제목 없음)", () => receive("해외", s3, { clock, youtubeHas: async () => "", say: () => {} }), /문안 규격 미달/);
    // 출구: _meta 가 있으면 그것으로
    await saveAiSettings({ key: "K" });
    resetSafetyCache();
    const v = await 영상두기(c.folder, "출구.mp4");
    await exitGate({ channel: "해외", file: v, _승인: "x", _meta: { title: "雨", desc: "傘\n\n#a #b #c", tags: ["a"] } }, v);
    참인가("출구: 최종 글이 규격에 맞으면 곁글이 없어도 통과", true);
    await 던지나("출구: 최종 글이 규격을 어기면 막는다", () => exitGate({ channel: "해외", file: v, _승인: "x", _meta: { title: "한글", desc: "d\n\n#a #b #c", tags: [] } }, v), /문안 규격 미달/);
    void ExitBlocked;
    setAiBackend(null);
  });

  구역("쿠팡용 상품 검색어 — AI 가 0~3개 · 관련 없으면 빈 목록 · 못 쓰면 null");
  await 모래상자(async (dir) => {
    const fk = new 가짜구글();
    await 채널준비(dir, fk, { name: "채널A" });
    같나("열쇠가 없으면 null(규칙으로 넘어간다)", await productQueries({ title: "t", desc: "", tags: [], channel: "채널A" }), null);
    await saveAiSettings({ key: "K" });
    const ai = new 가짜AI(); setAiBackend(ai);
    ai.textAnswer = { queries: ["텀블러", "텀블러", "보온병", "컵", "네번째"] };
    같나("검색어는 겹침을 빼고 3개까지", (await productQueries({ title: "텀블러 추천", desc: "겨울 텀블러", tags: ["텀블러"], channel: "채널A", kind: "쇼츠" }))?.queries, ["텀블러", "보온병", "컵"]);
    같나("프롬프트: 관련 없으면 빈 목록·억지 금지", [ai.textCalls[0].prompt.includes("빈 목록"), ai.textCalls[0].prompt.includes("억지로 만들지 마라")], [true, true]);
    ai.textAnswer = { queries: [] };
    같나("AI 가 「관련 상품 없음」 이라면 빈 목록(null 이 아니다)", (await productQueries({ title: "대통령 발언", desc: "", tags: [], channel: "채널A" }))?.queries, []);
    ai.textAnswer = new Error("500 boom");
    같나("AI 호출이 실패하면 null", await productQueries({ title: "t", desc: "", tags: [], channel: "채널A" }), null);
    await editChannels((d) => { d["채널A"].ai = false; });
    ai.textAnswer = { queries: ["x"] };
    같나("채널이 AI 를 껐으면 null", await productQueries({ title: "t", desc: "", tags: [], channel: "채널A" }), null);
    setAiBackend(null);
  });

  구역("기본값 — 새 설치는 AI 문안이 켜져 있다");
  await 모래상자(async () => {
    같나("앱설정 기본 aiTitles 는 true", appSettings().aiTitles, true);
    await saveAppSettings({ aiTitles: false });
    같나("옛 사용자가 꺼 둔 값은 그대로 지켜진다", appSettings().aiTitles, false);
    같나("앱설정에 열쇠 값이 들어 있어도 설정 읽기 결과 외에는 안 나온다", JSON.stringify(aiState()).includes("aiKey"), false);
    void readJsonSync; void confFor;
  });
}

if (import.meta.main) {
  const { 결과 } = await import("./도구.ts");
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

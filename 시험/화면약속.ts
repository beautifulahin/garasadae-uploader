// 화면 약속 시험 — 화면 일꾼들이 만든 모의 응답(시험/모의/api_*.json)에 있는 칸이 진짜 서버 응답에도 있는지.
//
// 화면은 모의 응답을 보고 만들었다. 서버가 그 칸을 안 주면 화면이 조용히 비어 보인다 — 그래서 읽는 길마다
// 「모의 응답의 모든 칸 ⊆ 진짜 응답」 을 견준다(객체는 칸 이름, 배열은 첫 항목, 값의 종류는 보지 않는다).
// 진짜 응답은 가짜 구글과 임시 폴더로 채운 채널 둘·영상·올린 기록·발사대기·심사 대기가 있는 상자에서 얻는다.
import { 같나, 결과, 구역, 모래상자 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 영상두기, 채널준비 } from "./바탕.ts";
import { buildRoutes, newAppState } from "../app/routes.ts";
import { appendLedger } from "../app/ledger.ts";
import * as Q from "../app/queue.ts";
import * as R from "../app/review.ts";
import { dataPath, writeJson } from "../app/paths.ts";
import { isoWall, wallNow } from "../app/clock.ts";

const MOCK = new URL("./모의/", import.meta.url);

/** 모의에만 있고 진짜에는 (이 상자에서는) 없는 칸 — 까닭이 있는 것만 */
const 예외 = new Map<string, string>([
  ["health.lines[0]", "점검 줄이 글(「[주의] 항목 — 말」)로 온다 — 화면이 객체와 글 둘 다 읽는다"],
  ["stats.channels", "카드 목록이 {cards:[…]} 로 온다 — 화면이 둘 다 읽는다"],
  ["stats.review", "같음"],
  ["stats.lift", "같음"],
  ["state.channels[0].conf.pick", "채널 설정의 선택 방식 — 값이 정해진 채널에만 있다"],
]);

/** 날짜·채널 이름이 칸 이름이 되는 자리 — 모의의 특정 날짜·채널이 상자에 없다고 틀린 것은 아니다 */
const 이름이칸인자리 = [/^records\.byDay\.\d{4}-\d{2}-\d{2}/, /^records\.byChannel\.[^.]+\.\d{4}-\d{2}-\d{2}/];

function 차이(mock: unknown, real: unknown, path: string, out: string[]) {
  if (mock && typeof mock === "object" && !Array.isArray(mock)) {
    if (!real || typeof real !== "object" || Array.isArray(real)) { if (real !== null) out.push(`${path}: 객체여야 하는데 ${Array.isArray(real) ? "배열" : typeof real}`); return; }
    for (const k of Object.keys(mock)) {
      if (!(k in (real as Record<string, unknown>))) out.push(`${path}.${k}`);
      else 차이((mock as Record<string, unknown>)[k], (real as Record<string, unknown>)[k], `${path}.${k}`, out);
    }
  } else if (Array.isArray(mock)) {
    if (!Array.isArray(real)) { out.push(`${path}: 배열이어야 하는데 ${typeof real}`); return; }
    if (mock.length && real.length) 차이(mock[0], real[0], `${path}[0]`, out);
  }
}

export async function 실행() {
  구역("화면 약속 — 모의 응답의 모든 칸이 진짜 응답에도 있다 (읽는 길)");
  await 모래상자(async (dir) => {
    const g = new 가짜구글();
    const a = await 채널준비(dir, g, { name: "채널A", c: "a" });
    const b = await 채널준비(dir, g, { name: "채널B", c: "b", conf: { allow_not_short: true, publish: "now" } });
    const v1 = await 영상두기(a.folder, "a1.mp4", { txt: "첫 제목\n\n설명 한 줄\n\n#태그1 #태그2" });
    await 영상두기(a.folder, "a2.mp4");
    await 영상두기(b.folder, "b1.mp4", { long: true });
    for (let i = 1; i <= 4; i++) {
      g.addVideo({ id: `V${i}`, channelId: a.id, snippet: { title: `올린 영상 ${i}`, publishedAt: new Date(Date.now() - i * 86400000).toISOString() }, statistics: { viewCount: String(100 * i) } });
      await appendLedger({ 업로드시각: `2026-10-1${i}T09:00:00`, 채널: "채널A", 영상ID: `V${i}`, 제목: `올린 영상 ${i}`, 파일: `/f/${i}.mp4`, 길이초: "40.0", 해상도: "1080x1920", 공개설정: i === 1 ? "비공개(검토대기)" : "public", ...(i === 2 ? { 예약시각: "2026-10-30 09:00" } : {}) });
    }
    await appendLedger({ 업로드시각: isoWall(wallNow()), 채널: "채널A", 영상ID: "V0", 제목: "오늘 올린 영상", 파일: "/f/0.mp4", 길이초: "40.0", 해상도: "1080x1920", 공개설정: "비공개(검토대기)" });
    await writeJson(dataPath("policy.json"), { 수확기준: [{ 차수: 1, 이름: "1차", 구독자: 1000, 쇼츠조회90: 10000000, 시청시간365: 4000 }] });
    await Q.add({ file: v1, channel: "채널A", _alias: "채널A", _승인: "시험", title: "제목" } as never, "2026-10-30 10:00");
    await R.addPending("채널A", "V1", "올린 영상 1", null, "auto");

    const 길 = buildRoutes(Object.assign(newAppState(), {
      port: () => 1, tickEvery: () => 10, tick: async () => ({}),
      update: async () => ({ available: false, version: "", current: "2.0.0", notes: [], page: "", url: "", canInstall: false, reason: "", running: false, pct: 0, text: "", error: "", prompt: false }),
    }) as never);
    const ctx = (body: Record<string, unknown> = {}, q = "") => ({ q: new URLSearchParams(q), body, headers: new Headers(), req: new Request("http://127.0.0.1/"), port: 0 });
    // 읽기만 하는(또는 같은 값을 돌려주는) 길과 그 길에 줄 몸
    const 몸: Record<string, Record<string, unknown>> = {
      "inventory": { ch: "채널A" }, "text/get": { f: v1 }, "settings/get": {}, "secret/state": {}, "coupang/get": {}, "health": { ch: "채널A" },
      "preview": {}, "records": {}, "stats": {}, "issues": {}, "calendar": {}, "log": {}, "state": {}, "feedback/list": {}, "ai/suggest": { f: v1 }, "coupang/pick": { f: v1 },
      "say/parse": { t: "채널A 에 방금 만든 거 올려" },
    };
    const files = [...Deno.readDirSync(MOCK)].map((e) => e.name).filter((n) => n.startsWith("api_") && n.endsWith(".json")).sort();
    let 견준수 = 0;
    for (const f of files) {
      const post = f.endsWith(".post.json");
      const name = f.replace(/^api_/, "").replace(/(\.post)?\.json$/, "").replaceAll("_", "/");
      const body = 몸[name];
      if (!body) continue;
      const h = post ? 길.post[name] : (길.get[name] ?? 길.post[name]);
      if (!h) { 같나(`${name}: 서버에 이 길이 있다`, false, true); continue; }
      const isGet = !!길.get[name] && !post;
      const real = await h(ctx(isGet ? {} : body, isGet ? new URLSearchParams(body as Record<string, string>).toString() : "")) as Record<string, unknown>;
      const mock = JSON.parse(await Deno.readTextFile(new URL(f, MOCK)));
      const out: string[] = [];
      차이(mock, { ok: true, ...real }, name, out);
      const 못받음 = out.filter((x) => !예외.has(x.split(":")[0]) && !이름이칸인자리.some((re) => re.test(x)));
      같나(`${name}: 모의 응답의 칸이 모두 있다`, 못받음, []);
      견준수++;
    }
    같나("견준 길이 열 개 이상이다 (모의 자료가 사라지지 않았다)", 견준수 >= 10, true);
  });
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

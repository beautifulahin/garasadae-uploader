// 설명 시험 — 문제 진단(issues) · 올리기 전 확인 자료(preview) · 말로 시키기(say).
//
// 합성 상태(채널 설정·tokens·원장·pending·발사대기·잠금 파일)를 모래상자 데이터 폴더에 직접 써 넣고 돌린다.
// 구글에는 한 번도 닿지 않는다. 진짜 클립보드도 건드리지 않는다(가짜 실행기).
// say 의 기대값(시각 읽기·해석)은 원본 say.py 의 순수 함수를 격리 실행해 뽑은 값이다 — 같은 말은 같은 결과여야 한다.
import { 결과, 같나, 구역, 모래상자, 참인가 } from "./도구.ts";
import * as ISS from "../app/issues.ts";
import * as PV from "../app/preview.ts";
import * as SAY from "../app/say.ts";
import { APP_NAME, dataPath, writeJson } from "../app/paths.ts";
import { addDays, wall } from "../app/clock.ts";
import { type Channels, readMark, saveChannels, setMode, writeMark } from "../app/channels.ts";
import { saveStore, type Store } from "../app/ytcore.ts";
import { savePending } from "../app/review.ts";
import { setLocked } from "../app/safety.ts";
import { appendLedger } from "../app/ledger.ts";
import * as quota from "../app/quota.ts";
import { saveProfiles } from "../app/profile.ts";
import { setEmbeddedForTest } from "../app/embedded.ts";
import type { MediaInfo } from "../app/shorts.ts";

/** 가짜 채널 ID — 실제 ID 모양(UC + 22자)을 소스에 그대로 쓰지 않으려고 만들어 쓴다 */
const id = (c: string) => "UC" + c.repeat(22);
const 토큰값 = "TOKEN-SECRET-VALUE-9f3a";
const 열쇠값 = "CLIENT-SECRET-VALUE-77b";
const 바이트 = new Uint8Array([1, 2, 3]);

async function 폴더(dir: string, 이름: string, o: { 영상?: number; 검토필요?: number } = {}): Promise<string> {
  const f = `${dir}/영상/${이름}`;
  await Deno.mkdir(f, { recursive: true });
  for (let i = 1; i <= (o.영상 ?? 0); i++) await Deno.writeFile(`${f}/영상${i}.mp4`, 바이트);
  if (o.검토필요) {
    await Deno.mkdir(`${f}/검토필요`, { recursive: true });
    for (let i = 1; i <= o.검토필요; i++) await Deno.writeFile(`${f}/검토필요/막힌${i}.mp4`, 바이트);
  }
  return f;
}
const 토큰 = (cid: string, title: string) => ({ channel_id: cid, title, refresh_token: 토큰값, added: "2026-10-01T00:00:00", scopes: [] as string[] });
async function 열쇠파일() {
  await writeJson(dataPath("client_secret.json"), { installed: { client_id: "fake-id", client_secret: 열쇠값 } }, { secret: true });
}
const 줄 = (xs: ISS.Issue[]) => xs.map((i) => [i.level, i.kind, i.what]);
const 의 = (xs: ISS.Issue[], 채널: string) => xs.filter((i) => i.channel === 채널);

/** 쿠팡·AI 모듈은 시험이 끼워 넣은 것만 보게 한다 — 진짜 모듈이 생겨도 이 시험의 기대값이 흔들리지 않게 */
const 수집 = (chans: Channels, fn?: ISS.DailyFn, o: ISS.CollectOpts = {}) => ISS.collect(chans, fn, { extra: () => [], ...o });
/** 아직 없는 모듈 */
const 없는모듈: ISS.OptionalLoaders = {
  coupang: () => Promise.reject(new Error("Module not found coupang.ts")),
  ai: () => Promise.reject(new Error("Module not found ai.ts")),
};
const 쿠팡줄 = (what: string, channel = "정상") => ({ level: "yellow", kind: "coupang", channel, what, why: "한도를 넘었습니다", fix: null, auto: false });
const AI줄 = { level: "yellow", kind: "ai", channel: "", what: "AI 열쇠를 넣으면 제목·설명·해시태그를 자동으로 지어 줍니다", why: "문안(쪽지·txt)이 없는 영상은 지금은 파일 이름이 제목으로 올라갑니다", fix: { label: "설정 탭에서 AI 열쇠 넣기" }, auto: false };

/** 문제마다 하나씩 걸리도록 꾸민 세상 */
async function 세상(dir: string) {
  const 설정: Channels = {};
  const 토큰들: Store = {};
  const 차림 = async (이름: string, o: { cid?: string; 토큰?: boolean; 표식?: string | null; 영상?: number; 검토필요?: number; daily?: number; 폴더?: string }) => {
    const 값 = o.폴더 ?? await 폴더(dir, 이름, { 영상: o.영상 ?? 0, 검토필요: o.검토필요 });
    if (o.폴더 === undefined && o.표식 !== null) await writeMark(값, o.표식 ?? o.cid ?? "", 이름, 이름);
    설정[이름] = { channel_id: o.cid ?? "", folder: 값, daily: o.daily ?? 2, daily_rule: "fixed" };
    if (o.토큰 && o.cid) 토큰들[이름] = 토큰(o.cid, 이름);
  };
  await 차림("정상", { cid: id("a"), 토큰: true, 영상: 5 });
  await 차림("인증없음", { cid: "", 표식: "UCany" });
  await 차림("토큰없음", { cid: id("b"), 영상: 3 });
  await 차림("폴더없음", { cid: id("c"), 토큰: true, 폴더: `${dir}/없는/폴더` });
  await 차림("남의폴더", { cid: id("d"), 토큰: true, 표식: id("z"), 영상: 5 });
  await 차림("표식없음", { cid: id("e"), 토큰: true, 표식: null, 영상: 5 });
  await 차림("폴더미정", { cid: id("f"), 토큰: true, 폴더: "" });
  await 차림("재고모자람", { cid: id("g"), 토큰: true, 영상: 1 });
  await 차림("재고얕음", { cid: id("h"), 토큰: true, 영상: 3 });
  await 차림("재고충분", { cid: id("i"), 토큰: true, 영상: 4 });
  await 차림("빈폴더", { cid: id("j"), 토큰: true, 영상: 0 });
  await 차림("검토쌓임", { cid: id("k"), 토큰: true, 영상: 5, 검토필요: 2 });
  await saveChannels(설정 as Record<string, unknown>);
  await saveStore(토큰들);
  await 열쇠파일();
  await savePending([{ channel: "정상", video_id: "v1", title: "올린 영상", publish_at: null, uploaded: "2026-10-17T08:00:00", 확인수: 0, 사람확인: false, 시각정한이: "auto" }]);
  return 설정;
}


/* ── 기대값: 원본 say.py 의 순수 함수(_시각읽기·parse)를 격리 실행해 뽑았다. 같은 말은 같은 결과여야 한다. ── */
type 지금꼴 = [number, number, number, number, number, number];
const 지금들: 지금꼴[] = [
  [2026, 10, 17, 0, 30, 0],
  [2026, 10, 17, 7, 0, 0],
  [2026, 10, 17, 14, 30, 0],
  [2026, 10, 17, 14, 30, 1],
  [2026, 10, 17, 21, 0, 0],
  [2026, 10, 17, 22, 0, 0],
  [2026, 10, 17, 23, 58, 30],
  [2026, 12, 31, 23, 0, 0],
  [2026, 2, 28, 20, 0, 0],
  [2026, 10, 17, 9, 0, 0],
];
/** [말, 지금들마다의 읽은 시각] — null 은 못 읽은 것 */
const 시각기대: [string, (string | null)[]][] = [
  ["내일 아침 9시에", ["2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2027-01-01 09:00", "2026-03-01 09:00", "2026-10-18 09:00"]],
  ["오후 3시 반", ["2026-10-17 15:30", "2026-10-17 15:30", "2026-10-17 15:30", "2026-10-17 15:30", "2026-10-18 15:30", "2026-10-18 15:30", "2026-10-18 15:30", "2027-01-01 15:30", "2026-03-01 15:30", "2026-10-17 15:30"]],
  ["모레 저녁", [null, null, null, null, null, null, null, null, null, null]],
  ["모레 저녁 7시", ["2026-10-19 19:00", "2026-10-19 19:00", "2026-10-19 19:00", "2026-10-19 19:00", "2026-10-19 19:00", "2026-10-19 19:00", "2026-10-19 19:00", "2027-01-02 19:00", "2026-03-02 19:00", "2026-10-19 19:00"]],
  ["오늘 밤 8시", ["2026-10-17 20:00", "2026-10-17 20:00", "2026-10-17 20:00", "2026-10-17 20:00", "2026-10-18 20:00", "2026-10-18 20:00", "2026-10-18 20:00", "2027-01-01 20:00", "2026-03-01 20:00", "2026-10-17 20:00"]],
  ["21시에", ["2026-10-17 21:00", "2026-10-17 21:00", "2026-10-17 21:00", "2026-10-17 21:00", "2026-10-18 21:00", "2026-10-18 21:00", "2026-10-18 21:00", "2027-01-01 21:00", "2026-02-28 21:00", "2026-10-17 21:00"]],
  ["2시간 뒤", ["2026-10-17 02:30", "2026-10-17 09:00", "2026-10-17 16:30", "2026-10-17 16:30", "2026-10-17 23:00", "2026-10-18 00:00", "2026-10-18 01:58", "2027-01-01 01:00", "2026-02-28 22:00", "2026-10-17 11:00"]],
  ["40분 뒤", ["2026-10-17 01:10", "2026-10-17 07:40", "2026-10-17 15:10", "2026-10-17 15:10", "2026-10-17 21:40", "2026-10-17 22:40", "2026-10-18 00:38", "2026-12-31 23:40", "2026-02-28 20:40", "2026-10-17 09:40"]],
  ["1분 뒤", ["2026-10-17 00:32", "2026-10-17 07:02", "2026-10-17 14:32", "2026-10-17 14:32", "2026-10-17 21:02", "2026-10-17 22:02", "2026-10-18 00:00", "2026-12-31 23:02", "2026-02-28 20:02", "2026-10-17 09:02"]],
  ["9시 15분에", ["2026-10-17 09:15", "2026-10-17 09:15", "2026-10-17 21:15", "2026-10-17 21:15", "2026-10-17 21:15", "2026-10-18 09:15", "2026-10-18 09:15", "2027-01-01 09:15", "2026-02-28 21:15", "2026-10-17 09:15"]],
  ["9시에", ["2026-10-17 09:00", "2026-10-17 09:00", "2026-10-17 21:00", "2026-10-17 21:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2027-01-01 09:00", "2026-02-28 21:00", "2026-10-17 21:00"]],
  ["아침 9시", ["2026-10-17 09:00", "2026-10-17 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2027-01-01 09:00", "2026-03-01 09:00", "2026-10-18 09:00"]],
  ["새벽 2시", ["2026-10-17 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2027-01-01 02:00", "2026-03-01 02:00", "2026-10-18 02:00"]],
  ["밤 12시", ["2026-10-17 12:00", "2026-10-17 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2027-01-01 12:00", "2026-03-01 12:00", "2026-10-17 12:00"]],
  ["오전 12시", ["2026-10-17 12:00", "2026-10-17 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2027-01-01 12:00", "2026-03-01 12:00", "2026-10-17 12:00"]],
  ["12시", ["2026-10-17 12:00", "2026-10-17 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2027-01-01 12:00", "2026-03-01 12:00", "2026-10-17 12:00"]],
  ["0시", ["2026-10-17 12:00", "2026-10-17 12:00", "2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2027-01-01 00:00", "2026-03-01 00:00", "2026-10-17 12:00"]],
  ["24시", [null, null, null, null, null, null, null, null, null, null]],
  ["9시 60분", [null, null, null, null, null, null, null, null, null, null]],
  ["23시 59분", ["2026-10-17 23:59", "2026-10-17 23:59", "2026-10-17 23:59", "2026-10-17 23:59", "2026-10-17 23:59", "2026-10-17 23:59", "2026-10-17 23:59", "2026-12-31 23:59", "2026-02-28 23:59", "2026-10-17 23:59"]],
  ["낮 12시 반", ["2026-10-17 12:30", "2026-10-17 12:30", "2026-10-18 12:30", "2026-10-18 12:30", "2026-10-18 12:30", "2026-10-18 12:30", "2026-10-18 12:30", "2027-01-01 12:30", "2026-03-01 12:30", "2026-10-17 12:30"]],
  ["3시간 있다가", ["2026-10-17 03:30", "2026-10-17 10:00", "2026-10-17 17:30", "2026-10-17 17:30", "2026-10-18 00:00", "2026-10-18 01:00", "2026-10-18 02:58", "2027-01-01 02:00", "2026-02-28 23:00", "2026-10-17 12:00"]],
  ["5분 후", ["2026-10-17 00:35", "2026-10-17 07:05", "2026-10-17 14:35", "2026-10-17 14:35", "2026-10-17 21:05", "2026-10-17 22:05", "2026-10-18 00:03", "2026-12-31 23:05", "2026-02-28 20:05", "2026-10-17 09:05"]],
  ["내일 0시", ["2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2026-10-18 00:00", "2027-01-01 00:00", "2026-03-01 00:00", "2026-10-18 00:00"]],
  ["내일 오후 12시", ["2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2026-10-18 12:00", "2027-01-01 12:00", "2026-03-01 12:00", "2026-10-18 12:00"]],
  ["오후 2시 반", ["2026-10-17 14:30", "2026-10-17 14:30", "2026-10-18 14:30", "2026-10-18 14:30", "2026-10-18 14:30", "2026-10-18 14:30", "2026-10-18 14:30", "2027-01-01 14:30", "2026-03-01 14:30", "2026-10-17 14:30"]],
  ["8시", ["2026-10-17 08:00", "2026-10-17 08:00", "2026-10-17 20:00", "2026-10-17 20:00", "2026-10-18 08:00", "2026-10-18 08:00", "2026-10-18 08:00", "2027-01-01 08:00", "2026-03-01 08:00", "2026-10-17 20:00"]],
  ["저녁 6시", ["2026-10-17 18:00", "2026-10-17 18:00", "2026-10-17 18:00", "2026-10-17 18:00", "2026-10-18 18:00", "2026-10-18 18:00", "2026-10-18 18:00", "2027-01-01 18:00", "2026-03-01 18:00", "2026-10-17 18:00"]],
  ["낮 1시", ["2026-10-17 13:00", "2026-10-17 13:00", "2026-10-18 13:00", "2026-10-18 13:00", "2026-10-18 13:00", "2026-10-18 13:00", "2026-10-18 13:00", "2027-01-01 13:00", "2026-03-01 13:00", "2026-10-17 13:00"]],
  ["2시간 걸려", ["2026-10-17 02:00", "2026-10-17 14:00", "2026-10-18 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2026-10-18 02:00", "2027-01-01 02:00", "2026-03-01 02:00", "2026-10-17 14:00"]],
  ["모레 오후 3시 반", ["2026-10-19 15:30", "2026-10-19 15:30", "2026-10-19 15:30", "2026-10-19 15:30", "2026-10-19 15:30", "2026-10-19 15:30", "2026-10-19 15:30", "2027-01-02 15:30", "2026-03-02 15:30", "2026-10-19 15:30"]],
  ["내일 9시", ["2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2027-01-01 09:00", "2026-03-01 09:00", "2026-10-18 09:00"]],
  ["오늘 밤 11시 30분", ["2026-10-17 23:30", "2026-10-17 23:30", "2026-10-17 23:30", "2026-10-17 23:30", "2026-10-17 23:30", "2026-10-17 23:30", "2026-10-18 23:30", "2026-12-31 23:30", "2026-02-28 23:30", "2026-10-17 23:30"]],
  ["정각 9시", ["2026-10-17 09:00", "2026-10-17 09:00", "2026-10-17 21:00", "2026-10-17 21:00", "2026-10-18 09:00", "2026-10-18 09:00", "2026-10-18 09:00", "2027-01-01 09:00", "2026-02-28 21:00", "2026-10-17 21:00"]],
  ["7시", ["2026-10-17 07:00", "2026-10-17 19:00", "2026-10-17 19:00", "2026-10-17 19:00", "2026-10-18 07:00", "2026-10-18 07:00", "2026-10-18 07:00", "2027-01-01 07:00", "2026-03-01 07:00", "2026-10-17 19:00"]],
  ["11시", ["2026-10-17 11:00", "2026-10-17 11:00", "2026-10-17 23:00", "2026-10-17 23:00", "2026-10-17 23:00", "2026-10-17 23:00", "2026-10-18 11:00", "2027-01-01 11:00", "2026-02-28 23:00", "2026-10-17 11:00"]],
  ["6시 반", ["2026-10-17 06:30", "2026-10-17 18:30", "2026-10-17 18:30", "2026-10-17 18:30", "2026-10-18 06:30", "2026-10-18 06:30", "2026-10-18 06:30", "2027-01-01 06:30", "2026-03-01 06:30", "2026-10-17 18:30"]],
  ["그냥 올려", [null, null, null, null, null, null, null, null, null, null]],
  ["오전 7시에 올려", ["2026-10-17 07:00", "2026-10-18 07:00", "2026-10-18 07:00", "2026-10-18 07:00", "2026-10-18 07:00", "2026-10-18 07:00", "2026-10-18 07:00", "2027-01-01 07:00", "2026-03-01 07:00", "2026-10-18 07:00"]],
  ["새벽 5시 20분", ["2026-10-17 05:20", "2026-10-18 05:20", "2026-10-18 05:20", "2026-10-18 05:20", "2026-10-18 05:20", "2026-10-18 05:20", "2026-10-18 05:20", "2027-01-01 05:20", "2026-03-01 05:20", "2026-10-18 05:20"]],
];

interface 해석꼴 { chans: "고객" | "말"; text: string; norm: string; action: string | null; channels: string[]; count: number | null; pick: string | null; name_hint: string | null; 쏠때: string | null; publish: string | null; warn: string[] }
const 해석기대: 해석꼴[] = [
  {"chans": "고객", "text": "A채널에 방금 만들어진 파일 올려줘", "norm": "A채널에 방금 만들어진 파일 올려줘", "action": "upload", "channels": ["고객사A"], "count": null, "pick": "newest", "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "고객", "text": "고객사 B에 3번 파일 즉시 발행으로 올려", "norm": "고객사 B에 3번 파일 즉시 발행으로 올려", "action": "upload", "channels": ["고객사B"], "count": null, "pick": "index:3", "name_hint": null, "쏠때": null, "publish": "now", "warn": []},
  {"chans": "고객", "text": "고객사 C 오늘 뭐 올라가", "norm": "고객사 C 오늘 뭐 올라가", "action": "status", "channels": ["고객사C"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "고객", "text": "전체 현황 보여줘", "norm": "전체 현황 보여줘", "action": "status", "channels": ["고객사A", "고객사B", "고객사C"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "고객", "text": "고객사 A에 방금 들어온 영상 2개 예약으로 올려", "norm": "고객사 A에 방금 들어온 영상 2개 예약으로 올려", "action": "upload", "channels": ["고객사A"], "count": 2, "pick": "newest", "name_hint": null, "쏠때": null, "publish": "schedule", "warn": []},
  {"chans": "고객", "text": "고객사A 고객사B 올려", "norm": "고객사A 고객사B 올려", "action": "upload", "channels": ["고객사A", "고객사B"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": ["채널이 여럿 걸립니다: 고객사A, 고객사B"]},
  {"chans": "고객", "text": "공개해줘", "norm": "공개해줘", "action": "review", "channels": [], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "고객", "text": "검토해줘 고객사A", "norm": "검토해줘 고객사A", "action": "review", "channels": ["고객사A"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "고객", "text": "고객사C 마지막 파일 올려", "norm": "고객사C 마지막 파일 올려", "action": "upload", "channels": ["고객사C"], "count": null, "pick": "last", "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "고객", "text": "고객사B 5번째 영상 올려", "norm": "고객사B 5번째 영상 올려", "action": "upload", "channels": ["고객사B"], "count": null, "pick": "index:5", "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "채널A에 방금 만든 영상 2개 올려", "norm": "채널A에 방금 만든 영상 2개 올려", "action": "upload", "channels": ["채널A"], "count": 2, "pick": "newest", "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "요리채널 2건 장바구니 담아", "norm": "요리채널 2건 장바구니 담아", "action": "cart", "channels": ["요리"], "count": 2, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "여행채널 오래된 것 1개 즉시 올려줘", "norm": "여행채널 오래된 것 1개 즉시 올려줘", "action": "upload", "channels": ["여행"], "count": 1, "pick": "oldest", "name_hint": null, "쏠때": null, "publish": "now", "warn": []},
  {"chans": "말", "text": "채널A 3개 내일 아침 9시에", "norm": "채널A 3개 내일 아침 9시에", "action": null, "channels": ["채널A"], "count": 3, "pick": null, "name_hint": null, "쏠때": "2026-10-18 09:00", "publish": null, "warn": ["무엇을 하라는 건지 못 알아들었습니다 (올려 / 현황 / 공개)"]},
  {"chans": "말", "text": "하나 랜덤으로 담아", "norm": "하나 랜덤으로 담아", "action": "cart", "channels": [], "count": 1, "pick": "random", "name_hint": null, "쏠때": null, "publish": null, "warn": ["어느 채널인지 못 찾았습니다"]},
  {"chans": "말", "text": "'오늘의_영상' 올려", "norm": "'오늘의_영상' 올려", "action": "upload", "channels": [], "count": null, "pick": null, "name_hint": "오늘의_영상", "쏠때": null, "publish": null, "warn": ["어느 채널인지 못 찾았습니다"]},
  {"chans": "말", "text": "요리방 폴더에 올려", "norm": "요리방 폴더에 올려", "action": "upload", "channels": ["요리"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "담은 것 빼줘 채널A", "norm": "담은 것 빼줘 채널A", "action": "uncart", "channels": ["채널A"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "채널A 오늘 오후 3시 반에 올려줘 예약으로", "norm": "채널A 오늘 오후 3시 반에 올려줘 예약으로", "action": "upload", "channels": ["채널A"], "count": null, "pick": null, "name_hint": null, "쏠때": "2026-10-17 15:30", "publish": "schedule", "warn": []},
  {"chans": "말", "text": "채널A 2시간 뒤에 올려", "norm": "채널A 2시간 뒤에 올려", "action": "upload", "channels": ["채널A"], "count": null, "pick": null, "name_hint": null, "쏠때": "2026-10-17 16:30", "publish": null, "warn": []},
  {"chans": "말", "text": "채널A 파일명_001.mp4 올려", "norm": "채널A 파일명_001.mp4 올려", "action": "upload", "channels": ["채널A"], "count": null, "pick": null, "name_hint": "파일명_001.mp4", "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "채널A abc-def 올려", "norm": "채널A abc-def 올려", "action": "upload", "channels": ["채널A"], "count": null, "pick": null, "name_hint": "abc-def", "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "세 개 올려 채널A", "norm": "세 개 올려 채널A", "action": "upload", "channels": ["채널A"], "count": 3, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "여섯 편 올려 여행", "norm": "여섯 편 올려 여행", "action": "upload", "channels": ["여행"], "count": 6, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "한강 영상 올려 요리", "norm": "한강 영상 올려 요리", "action": "upload", "channels": ["요리"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "채널A 현황", "norm": "채널A 현황", "action": "status", "channels": ["채널A"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "채널 현황 알려줘", "norm": "채널 현황 알려줘", "action": "status", "channels": ["요리", "여행", "채널A", "채널B"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "", "norm": "", "action": null, "channels": [], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": ["무엇을 하라는 건지 못 알아들었습니다 (올려 / 현황 / 공개)", "어느 채널인지 못 찾았습니다"]},
  {"chans": "말", "text": "ㅋㅋㅋ", "norm": "ㅋㅋㅋ", "action": null, "channels": [], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": ["무엇을 하라는 건지 못 알아들었습니다 (올려 / 현황 / 공개)", "어느 채널인지 못 찾았습니다"]},
  {"chans": "말", "text": "채널B 올려", "norm": "채널B 올려", "action": "upload", "channels": ["채널B"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "여행 요리 올려", "norm": "여행 요리 올려", "action": "upload", "channels": ["요리", "여행"], "count": null, "pick": null, "name_hint": null, "쏠때": null, "publish": null, "warn": ["채널이 여럿 걸립니다: 요리, 여행"]},
  {"chans": "말", "text": "채널A 아무거나 3개 바로 올려", "norm": "채널A 아무거나 3개 바로 올려", "action": "upload", "channels": ["채널A"], "count": 3, "pick": "random", "name_hint": null, "쏠때": null, "publish": "now", "warn": []},
  {"chans": "말", "text": "  채널A   최신   영상   올려  ", "norm": "채널A 최신 영상 올려", "action": "upload", "channels": ["채널A"], "count": null, "pick": "newest", "name_hint": null, "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "“새벽_영상” 채널A 올려", "norm": "“새벽_영상” 채널A 올려", "action": "upload", "channels": ["채널A"], "count": null, "pick": null, "name_hint": "새벽_영상", "쏠때": null, "publish": null, "warn": []},
  {"chans": "말", "text": "채널A 2026-10-19 영상 올려", "norm": "채널A 2026-10-19 영상 올려", "action": "upload", "channels": ["채널A"], "count": null, "pick": null, "name_hint": "2026-10", "쏠때": null, "publish": null, "warn": []},
];

const 지금 = wall(2026, 10, 17, 12, 0, 0);

export async function 실행() {
  구역("문제 모으기 — 처음 켠 상태");
  await 모래상자(async (dir) => {
    const a = await 수집({});
    같나("계정을 아직 안 이었으면 한 줄만(노랑·할 일)", 줄(a), [["yellow", "할 일", "아직 계정을 연결하지 않았습니다"]]);
    같나("열쇠 파일이 없으면 원본 문구 그대로", a[0].why.startsWith("구글 로그인 파일을 넣고 계정을 연결하면"), true);
    같나("고침 단추", [a[0].fix?.label, a[0].fix?.api, a[0].auto], ["지금 연결하기", "/api/signin/start", false]);

    setEmbeddedForTest("browser", { client_id: "x", client_secret: "y" });
    const b = await 수집({});
    같나("실행 파일에 열쇠가 묶여 있으면 파일을 넣으라고 하지 않는다", b[0].why.startsWith("구글 계정을 연결하면 올릴 수 있습니다."), true);
    setEmbeddedForTest("browser", null);

    // 채널이 있어도 시작 전이면 인증 빨강을 채널 수만큼 늘어놓지 않는다
    const f = await 폴더(dir, "채널A", { 영상: 2 });
    await writeMark(f, "", "채널A", "채널A");
    const c = await 수집({ "채널A": { channel_id: "", folder: f } });
    같나("시작 전: cid 없는 채널은 빨강을 안 만든다", 줄(c), [["yellow", "할 일", "아직 계정을 연결하지 않았습니다"]]);
    // cid 가 있는데 토큰이 없으면 시작 전이어도 빨강이다(원본과 같다)
    await writeMark(f, id("q"), "채널A", "채널A");
    const d = await 수집({ "채널A": { channel_id: id("q"), folder: f } });
    같나("시작 전이어도 cid 가 있는데 토큰이 없으면 빨강", 줄(d), [["yellow", "할 일", "아직 계정을 연결하지 않았습니다"], ["red", "오류", "토큰이 없습니다"]]);

    // 연결된 계정이 하나라도 있으면 시작한 것이다(열쇠 파일 없이 실행 파일에 묶인 열쇠로 연결한 경우)
    await saveStore({ "채널A": 토큰(id("q"), "채널A") });
    const e = await 수집({ "채널A": { channel_id: "", folder: f } });
    같나("계정이 연결돼 있으면 시작한 것 — cid 없는 칸은 빨강", 줄(e), [["red", "오류", "채널 인증이 안 됐습니다"]]);
  });

  구역("문제 모으기 — 사례마다 올바른 등급·종류");
  await 모래상자(async (dir) => {
    const 설정 = await 세상(dir);
    const all = await 수집(설정);
    같나("정상 채널은 문제가 없다", 줄(의(all, "정상")), []);
    같나("인증 안 됨 → 빨강 오류", 줄(의(all, "인증없음")), [["red", "오류", "채널 인증이 안 됐습니다"]]);
    같나("토큰 없음(인증 끊김) → 빨강 오류", 줄(의(all, "토큰없음")), [["red", "오류", "토큰이 없습니다"]]);
    참인가("토큰 없음: 까닭에 채널 ID", 의(all, "토큰없음")[0].why.includes(id("b")));
    같나("폴더 없음 → 빨강 오류", 줄(의(all, "폴더없음")), [["red", "오류", "폴더 짝이 맞지 않습니다"]]);
    참인가("폴더 없음: 까닭", 의(all, "폴더없음")[0].why.startsWith("폴더를 찾을 수 없습니다"));
    같나("남의 폴더(표식 어긋남) → 빨강 오류", 줄(의(all, "남의폴더")), [["red", "오류", "폴더 짝이 맞지 않습니다"]]);
    같나("남의 폴더: 까닭은 첫 줄만", 의(all, "남의폴더")[0].why, "폴더가 다른 채널 것입니다");
    같나("표식 없음 → 노랑 경고, 자동 고침 가능", [줄(의(all, "표식없음")), 의(all, "표식없음")[0].auto], [[["yellow", "경고", "폴더 표식이 없습니다"]], true]);
    같나("표식 새기기는 바로 고치는 일", 의(all, "표식없음")[0].fix?.body, { act: "bind", ch: "표식없음" });
    같나("폴더 미정 → 노랑 경고(표식 새기기로 잘못 읽지 않는다)", [줄(의(all, "폴더미정")), 의(all, "폴더미정")[0].auto], [[["yellow", "경고", "폴더가 정해지지 않았습니다"]], false]);
    같나("대기가 오늘 몫보다 적다 → 노랑 작업불이행", 줄(의(all, "재고모자람")), [["yellow", "작업불이행", "오늘 2개 중 1개만 올라갑니다"]]);
    같나("재고 2일 미만 → 노랑 경고", 줄(의(all, "재고얕음")), [["yellow", "경고", "재고가 1.5일치뿐입니다"]]);
    같나("재고 2일치는 정상", 줄(의(all, "재고충분")), []);
    같나("폴더가 비면 여기서는 말하지 않는다(채널 탭의 재고 0일이 말한다)", 줄(의(all, "빈폴더")), []);
    같나("검토필요가 쌓임 → 노랑 경고", 줄(의(all, "검토쌓임")), [["yellow", "경고", "검토필요 2건"]]);
    참인가("검토필요: 폴더 열기가 그 하위 폴더를 가리킨다", String((의(all, "검토쌓임")[0].fix?.body as { path: string }).path).endsWith("/검토필요"));
    같나("심사 대기는 초록(진행) — 앱 전체 줄", 줄(의(all, "")), [["green", "진행", "검토 대기 1건"]]);
    같나("전체 건수", all.length, 4 + 5 + 1);
    같나("고객(대행) 방식의 인증 안내", [의(all, "토큰없음")[0].fix?.label, 의(all, "토큰없음")[0].fix?.cmd], ["인증하기", `${ISS.CLI} 인증 --alias "토큰없음"`]);
    같나("고객 방식의 재고 안내", 의(all, "재고모자람")[0].fix?.label, "고객에게 요청");
    await setMode("owner");
    const own = await 수집(설정);
    같나("소유주 방식의 인증 안내", [의(own, "토큰없음")[0].fix?.label, 의(own, "토큰없음")[0].fix?.cmd], ["로그인하기", `${ISS.CLI} 인증`]);
    같나("소유주 방식의 재고 안내(폴더에 넣기)", 의(own, "재고모자람")[0].fix?.label, "폴더에 영상 넣기");

    // 오늘 몫은 부르는 쪽이 정한다 — 숫자도 [숫자, 까닭]도, 동기도 비동기도 받는다
    같나("dailyFn(숫자)", 줄(의(await 수집(설정, () => 3), "재고얕음")), [["yellow", "경고", "재고가 1.0일치뿐입니다"]]);
    같나("dailyFn([숫자, 까닭] 비동기)", 줄(의(await 수집(설정, async () => [4, "고정 4개"]), "재고얕음")), [["yellow", "작업불이행", "오늘 4개 중 3개만 올라갑니다"]]);
    같나("같은 입력으로 두 번 불러도 같다", 줄(await 수집(설정)), 줄(all));
    같나("오늘 몫이 0 인 날은 재고 경고를 내지 않는다(쉬는 날)", [줄(의(await 수집(설정, () => 0), "재고얕음")), 줄(의(await 수집(설정, () => 0), "재고모자람"))], [[], []]);
  });

  await 모래상자(async (dir) => {
    await 열쇠파일();
    const f = `${dir}/집/영상/틸드`;
    await Deno.mkdir(f, { recursive: true });
    for (let i = 1; i <= 5; i++) await Deno.writeFile(`${f}/영상${i}.mp4`, 바이트);
    await writeMark(f, id("t"), "틸드", "틸드");
    await saveStore({ "틸드": 토큰(id("t"), "틸드") });
    같나("「~」로 적은 폴더도 같은 폴더로 읽는다(짝 검사가 못 푸는 것을 여기서 푼다)",
      줄(await 수집({ "틸드": { channel_id: id("t"), folder: "~/영상/틸드", daily: 2 } })), []);
  });

  같나("폴더 여는 명령: 운영체제마다", [ISS.openCmd("/a b", "darwin"), ISS.openCmd("C:\\a", "windows"), ISS.openCmd("/a", "linux")], ['open "/a b"', 'explorer "C:\\a"', 'xdg-open "/a"']);

  구역("같은 일은 한 번만");
  {
    const a: ISS.Issue = { level: "red", kind: "오류", channel: "채널A", what: "토큰이 없습니다", why: "x", fix: null, auto: false };
    const b: ISS.Issue = { ...a, channel: "채널B" };
    같나("같은 칸이 전부 같으면 하나로", ISS.dedupe([a, { ...a }, b, { ...a }]).map((x) => x.channel), ["채널A", "채널B"]);
    같나("차례는 처음 나온 대로", ISS.dedupe([b, a, b]).map((x) => x.channel), ["채널B", "채널A"]);
  }

  구역("요약·보고·신호등·확인했음");
  await 모래상자(async (dir) => {
    const 설정 = await 세상(dir);
    const all = await 수집(설정);
    같나("요약: 초록은 세지 않는다", ISS.summary(all), { red: 4, yellow: 5, green: 0 });

    const r = ISS.report(all);
    참인가("보고: 신호등 한 줄", r.includes("  ● 오류 4   ● 작업불이행·경고 5"));
    참인가("보고: 빨강이 남았다는 말", r.includes("  빨강이 남아 있으면 업로드가 진행되지 않습니다."));
    참인가("보고: 바로 고칠 수 있는 것 표시", r.some((l) => l.includes(`▸ 표식 새기기 (바로 고칠 수 있음):  ${ISS.CLI} 설정 --bind`)));
    참인가("보고: 초록(진행)은 나열하지 않는다", !r.some((l) => l.includes("검토 대기")));
    같나("보고: 문제가 없을 때", ISS.report([]), ["", "  ● 정상   문제가 없습니다.", ""]);
    같나("보고: 초록만 있을 때는 신호등이 정상", ISS.report(all.filter((i) => i.level === "green")).slice(0, 2), ["", "  ● 정상"]);

    // 확인했음
    같나("처음엔 확인한 적이 없다", ISS.readAck(), null);
    같나("신호등(확인 전)", ISS.lamp(all, 12, 지금), { level: "red", counts: { red: 4, yellow: 5, green: 3 }, ackedToday: false, folded: 0 });
    같나("장부의 내용: 숫자는 #, 차례는 정렬", ISS.ackKey(all).includes("오늘 #개 중 #개만 올라갑니다") && ISS.ackKey(all).split("·").length === 5, true);
    const 봉함 = await ISS.ack(all, 지금);
    같나("확인했음: 장부 한 줄", await Deno.readTextFile(ISS.ackPath()), `2026-10-17|${봉함}`);
    같나("확인 뒤 신호등: 노랑은 접히고 빨강은 그대로", ISS.lamp(all, 12, 지금), { level: "red", counts: { red: 4, yellow: 0, green: 8 }, ackedToday: true, folded: 5 });
    const 빨강뺀 = all.filter((i) => i.level !== "red");
    같나("빨강을 고치면 확인한 노랑은 정상으로 센다", ISS.lamp(빨강뺀, 12, 지금).level, "green");
    같나("숫자만 달라진 같은 경고는 계속 확인된 것", ISS.isAcked(빨강뺀.map((i) => ({ ...i, what: i.what.replace("2개 중 1개", "3개 중 2개") })), 지금), true);
    같나("내용이 달라지면 되살아난다", ISS.isAcked([...빨강뺀, { level: "yellow", kind: "경고", channel: "", what: "새 경고", why: "", fix: null, auto: false }], 지금), false);
    같나("날이 바뀌면 되살아난다", ISS.isAcked(빨강뺀, addDays(지금, 1)), false);
    같나("같은 날 늦은 시각은 그대로 확인됨", ISS.isAcked(빨강뺀, wall(2026, 10, 17, 23, 59)), true);
    const 빨강만 = all.filter((i) => i.level === "red");
    await ISS.ack(빨강만, 지금);
    같나("노랑이 없는데 확인했음을 눌러도 빨강은 안 접힌다", ISS.lamp(빨강만, 12, 지금), { level: "red", counts: { red: 4, yellow: 0, green: 8 }, ackedToday: false, folded: 0 });
    await Deno.writeTextFile(ISS.ackPath(), "깨진 줄");
    같나("장부가 깨졌으면 확인 안 한 것", ISS.isAcked(빨강뺀, 지금), false);
  });

  구역("AI 에게 붙여 넣을 설명글 — 비밀은 싣지 않는다");
  await 모래상자(async (dir) => {
    const 설정 = await 세상(dir);
    const all = await 수집(설정);
    const 글 = ISS.asPrompt(all.filter((i) => i.level !== "green"), 설정);
    참인가("머리말", 글.startsWith(`${APP_NAME}에서 아래 문제가 났습니다. 원인과 고치는 방법을 알려주세요.`));
    참인가("오류 구역", 글.includes("## 오류 4건 — 업로드가 막혔습니다"));
    참인가("경고 구역", 글.includes("## 작업불이행·경고 5건"));
    참인가("앱이 제안한 조치(빨강만)", 글.includes(`앱이 제안한 조치: ${ISS.CLI} 인증 --alias "토큰없음"`));
    참인가("그때 설정", 글.includes("## 그때 설정") && 글.includes("- 정상: 폴더 …/영상/정상 ·"));
    참인가("도구 구성", 글.includes("## 도구 구성") && 글.includes("YouTube Data API v3"));
    참인가("토큰 값이 없다", !글.includes(토큰값));
    참인가("열쇠 값이 없다", !글.includes(열쇠값));
    참인가("열쇠 파일 이름·내용이 없다", !글.includes("fake-id") && !글.includes("refresh_token"));
    참인가("집 폴더·데이터 폴더의 전체 경로가 없다", !글.includes(dir));
    참인가("비밀을 붙여 넣지 말라는 안내", 글.includes("비밀 값은 이 글에 들어 있지 않습니다"));
    같나("설정을 안 주면 그 구역이 없다", ISS.asPrompt(all).includes("## 그때 설정"), false);
    같나("문제가 없으면 구역도 없다", ISS.asPrompt([]).includes("## 오류"), false);
    같나("경로는 마지막 두 칸만", ISS.shortPaths("폴더를 찾을 수 없습니다: /Users/누군가/영상/채널A 확인"), "폴더를 찾을 수 없습니다: …/영상/채널A 확인");
    같나("윈도우 경로도", ISS.shortPaths("못 엽니다: C:\\Users\\누군가\\영상\\채널A"), "못 엽니다: …/영상/채널A");
    같나("주소는 건드리지 않는다", ISS.shortPaths("https://youtu.be/abcdefghijk 와 https://studio.youtube.com/video/x/edit"), "https://youtu.be/abcdefghijk 와 https://studio.youtube.com/video/x/edit");
    같나("짧은 경로는 그대로", ISS.shortPaths("/a/b"), "/a/b");
  });

  구역("선택 기능 줄 — 쿠팡 파트너스 경고 · AI 문안 안내 (동적으로 부른다)");
  await 모래상자(async (dir) => {
    같나("두 모듈이 아직 없으면 빈 줄(던지지 않는다)", await ISS.optionalIssues(없는모듈), []);
    같나("모듈은 있는데 함수가 아직 없으면 빈 줄", await ISS.optionalIssues({ coupang: () => Promise.resolve({}), ai: () => Promise.resolve({ 다른것: 1 }) }), []);
    같나("모듈이 null 을 줘도", await ISS.optionalIssues({ coupang: () => Promise.resolve(null), ai: () => Promise.resolve(undefined) }), []);
    같나("함수가 던져도(동기·비동기) 멈추지 않는다", await ISS.optionalIssues({
      coupang: () => Promise.resolve({ warnings: () => { throw new Error("깨짐"); } }),
      ai: () => Promise.resolve({ aiNotice: async () => { throw new Error("깨짐"); } }),
    }), []);
    await ISS.optionalIssues(없는모듈);
    await ISS.optionalIssues(없는모듈);
    같나("실패는 서버.log 에 남는다 — 같은 말은 한 번만",
      await Deno.readTextFile(`${dir}/데이터/기록/서버.log`).then((t) => t.split("선택 기능: coupang.warnings 를 못 불렀습니다 — Module not found coupang.ts").length - 1), 1);

    const 줄들 = await ISS.optionalIssues({
      coupang: () => Promise.resolve({ warnings: async () => [쿠팡줄("쿠팡 파트너스 연결이 풀렸습니다"), 쿠팡줄("오늘 검색 한도를 넘었습니다", "채널B")] }),
      ai: () => Promise.resolve({ aiNotice: () => AI줄 }),
    });
    같나("쿠팡 줄이 먼저, AI 안내가 뒤 — 받은 그대로(fix 에 cmd 칸만 채운다)", 줄들, [
      쿠팡줄("쿠팡 파트너스 연결이 풀렸습니다"), 쿠팡줄("오늘 검색 한도를 넘었습니다", "채널B"),
      { ...AI줄, fix: { label: "설정 탭에서 AI 열쇠 넣기", cmd: null } },
    ]);
    같나("aiNotice 가 null 이면(열쇠가 있으면) 안내 줄이 없다", (await ISS.optionalIssues({ ai: () => Promise.resolve({ aiNotice: () => null }), coupang: 없는모듈.coupang })).length, 0);
    같나("알아볼 수 없는 값은 건너뛴다", (await ISS.optionalIssues({
      coupang: () => Promise.resolve({ warnings: () => ["문자열", 7, null, { what: "" }, { 이름: "x" }, 쿠팡줄("살아남음")] }),
      ai: () => Promise.resolve({ aiNotice: () => 5 }),
    })).map((x) => x.what), ["살아남음"]);
    같나("등급이 이상하면 노랑, 종류가 없으면 등급 이름표", ISS.asIssue({ what: "x", level: "파랑" }), { level: "yellow", kind: "작업불이행", channel: "", what: "x", why: "", fix: null, auto: false });
    같나("fix 에 label 이 없으면 fix 를 버린다", ISS.asIssue({ what: "x", fix: { api: "/a" } })?.fix, null);
    같나("fix 의 api·body 는 보존", ISS.asIssue({ what: "x", fix: { label: "열기", api: "/api/a", body: { k: 1 } } })?.fix, { label: "열기", cmd: null, api: "/api/a", body: { k: 1 } });
    같나("너무 오래 걸리는 함수는 기다리지 않는다(화면이 몇 초마다 부르는 길)", await ISS.callOptional("ai", "느림", [], { ai: () => Promise.resolve({ 느림: () => new Promise(() => {}) }) }, 30), null);
    참인가("느린 것도 서버.log 에 적는다", await Deno.readTextFile(`${dir}/데이터/기록/서버.log`).then((t) => t.includes("선택 기능: ai.느림 가 30ms 안에 끝나지 않아 기다리지 않습니다")));
    같나("모듈을 부를 때 this 는 모듈 자신", await ISS.callOptional("ai", "who", [], { ai: () => Promise.resolve({ n: "나", who() { return (this as { n: string }).n; } }) }), "나");

    // collect 에 끼우기 — 진짜 모듈 대신 같은 모양의 가짜 줄
    const 설정 = await 세상(dir);
    const 기본 = await 수집(설정);
    const 끼움 = await ISS.collect(설정, undefined, { extra: () => [쿠팡줄("연결이 풀렸습니다") as ISS.Issue, AI줄 as unknown as ISS.Issue] });
    같나("끼운 줄은 끝에 붙고 앞의 줄은 그대로", [줄(끼움.slice(0, -2)), 끼움.slice(-2).map((x) => [x.kind, x.channel, x.what])], [줄(기본), [["coupang", "정상", "연결이 풀렸습니다"], ["ai", "", AI줄.what]]]);
    같나("비동기로 끼워도", (await ISS.collect(설정, undefined, { extra: async () => [쿠팡줄("연결이 풀렸습니다") as ISS.Issue] })).length, 기본.length + 1);
    같나("끼운 함수가 던져도 기본 줄은 나온다", 줄(await ISS.collect(설정, undefined, { extra: () => { throw new Error("깨짐"); } })), 줄(기본));
    같나("같은 줄을 두 번 끼워도 한 번만", (await ISS.collect(설정, undefined, { extra: () => [쿠팡줄("연결이 풀렸습니다") as ISS.Issue, 쿠팡줄("연결이 풀렸습니다") as ISS.Issue] })).length, 기본.length + 1);
    같나("진짜 모듈 길을 거쳐도 기본 줄은 그대로(모듈이 있든 없든)", 줄((await ISS.collect(설정)).filter((x) => x.kind !== "coupang" && x.kind !== "ai")), 줄(기본));

    // 신호등·확인했음·보고에도 같이 센다
    같나("끼운 노랑은 신호등 노랑에 센다", [ISS.summary(끼움), ISS.lamp(끼움, 12, 지금).counts], [{ red: 4, yellow: 7, green: 0 }, { red: 4, yellow: 7, green: 1 }]);
    await ISS.ack(끼움, 지금);
    같나("확인했음으로 같이 접힌다", ISS.lamp(끼움, 12, 지금).folded, 7);
    참인가("장부에 안내 줄이 들어간다", ISS.ackKey(끼움).includes("AI 열쇠를 넣으면"));
    const 보고 = ISS.report(끼움);
    참인가("보고: 영문 종류 이름표를 한글로", 보고.includes("  ● [쿠팡 파트너스] 정상") && 보고.includes("  ● [AI 문안]"));
    참인가("설명글에도 실린다", ISS.asPrompt(끼움).includes("- AI 열쇠를 넣으면 제목·설명·해시태그를 자동으로 지어 줍니다 — 문안(쪽지·txt)이 없는 영상은"));
  });

  구역("클립보드");
  {
    같나("맥: pbcopy(로케일 없는 곳을 위해 LANG)", ISS.clipboardPlan("darwin"), [{ cmd: "pbcopy", args: [], enc: "utf-8", env: { LANG: "en_US.UTF-8" } }]);
    같나("윈도우: clip + UTF-16LE", ISS.clipboardPlan("windows"), [{ cmd: "clip", args: [], enc: "utf-16le" }]);
    같나("리눅스: wl-copy → xclip → xsel", ISS.clipboardPlan("linux").map((s) => s.cmd), ["wl-copy", "xclip", "xsel"]);
    같나("UTF-16LE: 한글이 산다", [...ISS.encodeFor("가A", "utf-16le")], [0x00, 0xac, 0x41, 0x00]);
    같나("UTF-8", [...ISS.encodeFor("가", "utf-8")], [0xea, 0xb0, 0x80]);
    같나("이모지(서로게이트)도 코드 유닛대로", ISS.encodeFor("😀", "utf-16le").length, 4);

    const 불린 = [] as string[];
    const 첫째실패 = async (s: ISS.ClipStep) => { 불린.push(s.cmd); if (s.cmd === "wl-copy") throw new Deno.errors.NotFound("없음"); return s.cmd === "xclip"; };
    같나("있는 것을 만날 때까지 차례로(없는 도구는 건너뛴다)", [await ISS.copyToClipboard("글", 첫째실패, "linux"), 불린], [true, ["wl-copy", "xclip"]]);
    같나("끝까지 안 되면 false", await ISS.copyToClipboard("글", () => Promise.resolve(false), "linux"), false);
    const 그릇: { b: Uint8Array | null } = { b: null };
    await ISS.copyToClipboard("가", (_s, b) => { 그릇.b = b; return Promise.resolve(true); }, "windows");
    같나("윈도우로 넘기는 바이트", 그릇.b ? [...그릇.b] : null, [0x00, 0xac]);
  }

  구역("자동 고침 — 표식 새기기");
  await 모래상자(async (dir) => {
    const 설정 = await 세상(dir);
    await saveProfiles({ [id("e")]: { title: "표시 이름" } });
    const all = await 수집(설정);
    const 고친 = await ISS.autofix(all);
    같나("자동으로 고칠 수 있는 것은 표식 하나", 고친.fixed, 1);
    같나("표식 내용(채널ID·표시 이름·별칭)", await readMark(설정["표식없음"].folder).then((m) => [m?.channel_id, m?.channel_title, m?.alias]), [id("e"), "표시 이름", "표식없음"]);
    참인가("진행 줄", 고친.lines[0].includes("고치는 중 — [표식없음] 폴더 표식이 없습니다") && 고친.lines[1].includes("✓ 표식을 새겼습니다 — 표시 이름"));
    같나("고친 뒤 다시 모으면 그 경고가 없다", 의(await 수집(설정), "표식없음").length, 0);

    // 낡은 목록으로 한 번 더 — 이미 새겨진 것은 덮지 않고 고친 것으로 센다
    const 또 = await ISS.autofix(all);
    같나("이미 새겨져 있으면 그대로 두고 고친 것으로", [또.fixed, 또.lines[1].trim()], [1, "이미 새겨져 있습니다"]);

    // 다른 채널 표식이 있으면 덮어쓰지 않는다
    await Deno.remove(`${설정["표식없음"].folder}/.채널정보.json`);
    await writeMark(설정["표식없음"].folder, id("z"), "남", "남");
    const 거절 = await ISS.autofix(all);
    같나("다른 채널 표식은 덮어쓰지 않는다", [거절.fixed, (await readMark(설정["표식없음"].folder))?.channel_id], [0, id("z")]);
    참인가("거절 까닭", 거절.lines[1].includes("다른 채널 표식이 있어 덮어쓰지 않습니다"));

    같나("자동 고침이 아닌 것은 손대지 않는다", (await ISS.autofix(all.filter((i) => !i.auto))).fixed, 0);
    같나("kind 를 주면 그 종류만", (await ISS.autofix(all, { kind: "오류" })).fixed, 0);
    같나("없는 채널이면 실패로 알린다", (await ISS.autofix([{ level: "yellow", kind: "경고", channel: "없는채널", what: "x", why: "", fix: { label: "표식 새기기", cmd: null, body: { act: "bind" } }, auto: true }])).lines[1].includes("그런 채널이 없습니다"), true);
  });

  구역("원본 신호등에 없는 네 가지 — extras 옵션");
  await 모래상자(async (dir) => {
    const 설정 = await 세상(dir);
    같나("기본은 원본과 같다(잠금·밀림·사람 확인·한도를 안 센다)", (await 수집(설정)).length, 10);

    await setLocked(true);
    const 잠금 = (await 수집(설정, undefined, { extras: true, now: 지금 })).filter((i) => i.what === "올리기가 잠겨 있습니다");
    같나("잠금 → 노랑 경고", 줄(잠금), [["yellow", "경고", "올리기가 잠겨 있습니다"]]);
    같나("잠금 고침: 자물쇠 풀기", [잠금[0].fix?.api, 잠금[0].fix?.body], ["/api/upload/lock", { on: false }]);
    같나("옵션을 끄면 안 나온다", (await 수집(설정)).some((i) => i.what.includes("잠겨")), false);
    await setLocked(false);

    const 큐 = (쏠때: string) => [{ file: `${dir}/영상/정상/영상1.mp4`, channel: "정상", _alias: "정상", 쏠때, _승인: "사람" }];
    await writeJson(dataPath("발사대기.json"), 큐("2026-10-17T09:00:00"));
    const 밀림 = (await 수집(설정, undefined, { extras: true, now: 지금 })).filter((i) => i.what.includes("발사대기"));
    같나("예정 시각을 30분 넘기면 노랑 작업불이행", 줄(밀림), [["yellow", "작업불이행", "발사대기 1건이 예정 시각을 넘겼습니다"]]);
    같나("밀린 채널·까닭", [밀림[0].channel, 밀림[0].why.startsWith("가장 늦은 것이 3시간 0분 밀렸습니다")], ["정상", true]);
    await writeJson(dataPath("발사대기.json"), 큐("2026-10-17T11:45:00"));
    같나("15분 밀린 것은 아직 정상(틱이 10분마다 돈다)", (await 수집(설정, undefined, { extras: true, now: 지금 })).some((i) => i.what.includes("발사대기")), false);
    await writeJson(dataPath("발사대기.json"), 큐("2026-10-17T02:00:00"));
    같나("심야 금지 시간(자정~07시)에는 안 나가는 게 정상이라 세지 않는다",
      (await 수집(설정, undefined, { extras: true, now: wall(2026, 10, 17, 3, 0) })).some((i) => i.what.includes("발사대기")), false);

    await savePending([{ channel: "정상", video_id: "v2", title: "심사 안 끝남", publish_at: null, uploaded: "2026-10-17T08:00:00", 확인수: 1, 사람확인: true, 시각정한이: "auto" }]);
    const 사람 = (await 수집(설정, undefined, { extras: true, now: 지금 })).filter((i) => i.kind === "할 일");
    같나("사람 확인 필요 → 노랑 할 일", 줄(사람), [["yellow", "할 일", "사람이 확인할 영상 1건"]]);
    같나("스튜디오 열기", 사람[0].fix?.api, `/studio?cid=${id("a")}`);

    await quota.spend("videos.insert", "", 98);
    const 한도 = (await 수집(설정, undefined, { extras: true, now: 지금 })).filter((i) => i.what.includes("한도"));
    같나("오늘 올릴 수 있는 횟수가 3번 이하 → 노랑 경고", 줄(한도), [["yellow", "경고", "오늘 유튜브 한도가 얼마 남지 않았습니다"]]);
    참인가("한도 까닭에 남은 횟수", 한도[0].why.startsWith("올리기 2번 ·"));
  });

  구역("올리기 전 확인 자료");
  await 모래상자(async (dir) => {
    const A = await 폴더(dir, "채널A"), B = await 폴더(dir, "채널B");
    await saveChannels({
      "채널A": { channel_id: id("a"), folder: A },
      "채널B": { channel_id: id("b"), folder: B, meta_rule: { forbid_hangul: true } },
    });
    const 세로 = (sec = 30): MediaInfo => ({ w: 1080, h: 1920, display_w: 1080, display_h: 1920, codec: "h264", sec, mb: 12.3 });
    const 가로 = (sec = 600): MediaInfo => ({ w: 1920, h: 1080, display_w: 1920, display_h: 1080, codec: "h264", sec, mb: 400 });
    const 글 = (제목: string, 설명: string) => `[제목]\n${제목}\n\n[설명]\n${설명}\n\n[해시태그]\n#가 #나\n`;
    await Deno.writeTextFile(`${A}/영상 1.txt`, 글("첫 영상", "설명 첫 줄\n둘째 줄"));
    await Deno.writeTextFile(`${A}/영상 3.txt`, 글("긴 영상", "긴 설명"));
    await Deno.writeTextFile(`${A}/영상 4.txt`, 글("이미 올린 영상", "설명"));
    await Deno.writeFile(`${A}/영상 4.jpg`, new Uint8Array(2 * 1024 * 1024 + 1));
    await Deno.writeTextFile(`${A}/영상 5.txt`, 글("여분 영상", "설명"));
    await Deno.writeTextFile(`${B}/b1.txt`, 글("한글 제목", "Body text"));
    await Deno.writeTextFile(`${B}/b3.txt`, 글("English title", "Body text").replace("#가 #나", "#a #b"));
    await appendLedger({ 업로드시각: "2026-10-10T07:00:00", 채널: "채널A", 영상ID: "vid4", 제목: "이미 올린 영상", 파일: `${A}/영상 4.mp4` });

    const 자료 = await PV.build({
      "채널A": {
        info: { handle: id("a") }, note: "오래된 것부터 4개",
        items: [
          { file: `${A}/영상 1.mp4`, info: 세로(), when: "09:15", publishAt: "2026-10-18 09:15", fireAt: "2026-10-17T09:15:00", rank: 1 },
          { file: `${A}/영상 2.mp4`, info: 세로(45), when: "즉시 발행", rank: 2 },
          { file: `${A}/영상 3.mp4`, info: 가로(), publishAt: "2026-10-18 21:00", rank: 3 },
          { file: `${A}/영상 4.mp4`, info: 가로(300), rank: 4 },
          { file: `${A}/영상 5.mp4`, info: 세로(), spare: true },
        ],
      },
      "채널B": {
        items: [
          { file: `${B}/b1.mp4`, info: 세로() },
          { file: `${B}/b2.mp4`, info: 세로() },
          { file: `${B}/b3.mp4`, info: 세로() },
        ],
      },
    }, { now: 지금, sources: 없는모듈 });

    같나("머리: 만든 때·영상 수·체크 수·문제 수", [자료.at, 자료.total, 자료.picked, 자료.problems], ["2026-10-17T12:00:00", 8, 7, 5]);
    같나("채널 차례와 이름", 자료.channels.map((c) => [c.ch, c.count, c.picked, c.problems]), [["채널A", 5, 4, 3], ["채널B", 3, 3, 2]]);
    같나("채널 칸: handle · note", [자료.channels[0].handle, 자료.channels[0].note, 자료.channels[1].handle], [id("a"), "오래된 것부터 4개", ""]);

    const [a1, a2, a3, a4, a5] = 자료.channels[0].items;
    같나("정상 영상: 문제 없음", [a1.issues, a1.blocked, a1.checked], [[], false, true]);
    같나("정상 영상: 문안", [a1.title, a1.descHead, a1.titleLen, a1.tagCount, a1.textFrom], ["첫 영상", "설명 첫 줄", 4, 2, "영상 1.txt"]);
    같나("정상 영상: 종류·크기·시각", [a1.kind, a1.sec, a1.w, a1.h, a1.mb, a1.when, a1.publishAt, a1.fireAt], ["쇼츠", 30, 1080, 1920, 12.3, "09:15", "2026-10-18 09:15", "2026-10-17T09:15:00"]);
    같나("사유(추천 순위)", a1.reason, "오늘 올릴 몫 · 추천 1위");
    같나("쇼츠는 맞춤 썸네일이 없어도 정상", [a1.thumb.has, a1.thumb.needed], [false, false]);
    같나("설명 파일 없음 → 제목이 파일 이름", [a2.title, a2.textFrom, a2.issues], ["영상 2", null, ["설명 파일(.txt)이 없습니다 — 파일 이름을 제목으로 씁니다"]]);
    같나("입력의 when 이 그대로", a2.when, "즉시 발행");
    같나("롱폼인데 맞춤 썸네일 없음", [a3.kind, a3.thumb.needed, a3.thumb.has, a3.issues], ["롱폼", true, false, ["맞춤 썸네일이 없습니다 — 롱폼은 썸네일이 클릭률을 좌우합니다"]]);
    같나("when 이 없으면 공개 시각의 시·분", a3.when, "21:00");
    같나("이미 올림 + 2MB 넘는 썸네일", [a4.blocked, a4.thumb.has, a4.thumb.over, a4.thumb.name, a4.issues], [true, true, true, "영상 4.jpg", ["이미 올린 파일입니다 — 2026-10-10 [채널A]", "썸네일이 2MB 를 넘어 올라가지 않습니다 — 영상 4.jpg"]]);
    같나("여분: 체크 해제 · 대기 · 사유", [a5.spare, a5.checked, a5.when, a5.reason, a5.issues], [true, false, "대기", "여분 — 오늘 몫 밖이라 이번에는 올라가지 않습니다", []]);

    const [b1, b2, b3] = 자료.channels[1].items;
    같나("채널 문안 규격 미달 → 출구검사가 막을 것", [b1.blocked, b1.issues.length, b1.issues[0].startsWith("문안 규격 미달 — 제목에 한글")], [true, 1, true]);
    같나("규격이 있는데 곁파일이 없다", [b2.blocked, b2.issues.includes("문안 규격 미달 — 곁파일(.txt) 없음")], [true, true]);
    같나("규격을 지킨 영상", [b3.blocked, b3.issues], [false, []]);

    같나("쿠팡·AI 모듈이 없으면: 문안 기록 없음 · 링크 없음 · 아직", 자료.channels.flatMap((c) => c.items).every((x) => x.meta === null && x.links.length === 0 && x.linkStatus === "아직"), true);
    같나("JSON 으로 보낼 수 있다(왕복해도 같다)", JSON.parse(JSON.stringify(자료)), 자료);
    같나("종류를 잴 수 없으면 꾸며내지 않고 알린다",
      (await PV.build({ "채널B": { items: [{ file: `${B}/b3.mp4`, info: { sec: 0 } as MediaInfo }] } }, { sources: 없는모듈 })).channels[0].items[0].issues[0].startsWith("종류를 알 수 없습니다"), true);
    같나("입력에 종류가 있으면 그대로(잰 값을 다시 판정하지 않는다)", (await PV.build({ "채널B": { items: [{ file: `${B}/b3.mp4`, info: 세로(), kind: "롱폼" }] } }, { sources: 없는모듈 })).channels[0].items[0].kind, "롱폼");
    같나("빈 입력", await PV.build({}, { now: 지금, sources: 없는모듈 }).then((d) => [d.total, d.channels]), [0, []]);

    const 줄들 = PV.lines(자료);
    참인가("터미널 줄", 줄들.some((l) => l.includes("올리기 전 확인 — 채널 2개 · 영상 8개 (오늘 올릴 것 7개 · 문제 5개)")) && 줄들.some((l) => l.includes("⚠ 이미 올린 파일입니다")));
    같나("터미널 줄: 비었을 때", PV.lines(await PV.build({}, { sources: 없는모듈 })), ["", "  올릴 것이 없습니다.", ""]);

    // ── 이미 지어 둔 쿠팡 링크·AI 문안 — 기록만 읽는다
    await Deno.writeTextFile(`${A}/영상 6.txt`, "[제목]\n부분 제목\n");
    const 불린: string[] = [];
    const 가짜쿠팡 = {
      recordFor: (file: string) => {
        불린.push("recordFor");
        if (file.endsWith("영상 1.mp4")) return { status: "붙임", links: [{ name: "우산", url: "https://example.com/p/1" }, { name: "위험", url: "javascript:alert(1)" }, { name: "", url: "http://example.com/2" }, "엉뚱한것", { url: 5 }] };
        if (file.endsWith("영상 2.mp4")) return { status: "없음", links: [] };
        if (file.endsWith("영상 3.mp4")) return Promise.resolve({ status: "사람이넣음", links: [{ name: "쪽지 링크", url: "https://example.com/p/3" }] });
        if (file.endsWith("영상 4.mp4")) return { status: "처음보는상태", links: [] };
        if (file.endsWith("영상 5.mp4")) throw new Error("깨진 기록");
        return null;
      },
      pick: () => { 불린.push("pick"); throw new Error("미리보기가 상품을 검색하면 안 된다"); },
    };
    const 가짜AI = {
      metaRecordFor: (file: string) => {
        불린.push("metaRecordFor");
        if (file.endsWith("영상 1.mp4")) return { title: "무시될 제목", description: "무시될 설명", tags: ["무시"], at: "2026-10-17T10:00:00" };
        if (file.endsWith("영상 2.mp4")) return { title: "자동 제목", description: "자동 설명 첫 줄\n둘째 줄", tags: ["#자동", "태그"], at: "2026-10-17T11:00:00" };
        if (file.endsWith("영상 6.mp4")) return Promise.resolve({ title: "자동이 덮으면 안 되는 제목", description: "자동 설명", tags: ["자동태그"], at: "2026-10-17T12:00:00" });
        if (file.endsWith("영상 4.mp4")) return { title: "", description: "", tags: [], at: "x" };
        return null;
      },
      suggest: () => { 불린.push("suggest"); throw new Error("미리보기가 AI 를 부르면 안 된다"); },
    };
    const 영상들 = [1, 2, 3, 4, 5, 6].map((n) => ({ file: `${A}/영상 ${n}.mp4`, info: 세로() }));
    const 결 = await PV.build({ "채널A": { items: 영상들 } }, { now: 지금, sources: { coupang: () => Promise.resolve(가짜쿠팡), ai: () => Promise.resolve(가짜AI) } });
    const [c1, c2, c3, c4, c5, c6] = 결.channels[0].items;
    같나("기록만 읽는다 — 검색·AI 호출은 한 번도 안 한다", [불린.filter((x) => x === "recordFor").length, 불린.filter((x) => x === "metaRecordFor").length, 불린.includes("pick"), 불린.includes("suggest")], [6, 6, false, false]);
    같나("링크: 붙임 — http(s) 만 남긴다", [c1.linkStatus, c1.links], ["붙임", [{ name: "우산", url: "https://example.com/p/1" }, { name: "", url: "http://example.com/2" }]]);
    같나("링크: 없음", [c2.linkStatus, c2.links], ["없음", []]);
    같나("링크: 사람이 넣음(비동기 기록도)", [c3.linkStatus, c3.links], ["사람이넣음", [{ name: "쪽지 링크", url: "https://example.com/p/3" }]]);
    같나("링크: 모르는 상태는 아직", [c4.linkStatus, c4.links], ["아직", []]);
    같나("링크: 기록을 읽다 던지면 아직(미리보기는 계속)", [c5.linkStatus, c5.links], ["아직", []]);
    같나("사람이 문안을 다 정했으면 자동 기록이 있어도 사람 것", [c1.meta?.title, c1.meta?.source, c1.meta?.status, c1.title, c1.tagCount], ["첫 영상", { title: "사람", desc: "사람", tags: "사람" }, "사람", "첫 영상", 2]);
    같나("문안이 없는 영상은 자동 문안으로 채운다(# 는 뗀다)", [c2.meta?.title, c2.meta?.desc, c2.meta?.tags, c2.meta?.source, c2.meta?.status, c2.meta?.at],
      ["자동 제목", "자동 설명 첫 줄\n둘째 줄", ["자동", "태그"], { title: "자동", desc: "자동", tags: "자동" }, "자동", "2026-10-17T11:00:00"]);
    같나("합친 문안이 곧 올라갈 문안 — 칸 값도 같이 바뀐다", [c2.title, c2.descHead, c2.titleLen, c2.tagCount, c2.textFrom], ["자동 제목", "자동 설명 첫 줄", 5, 2, null]);
    같나("자동 문안이 채우는 영상은 「설명 파일 없음」이 문제가 아니다", c2.issues, []);
    같나("칸마다 따로: 제목은 사람, 설명·태그는 자동", [c6.meta?.title, c6.meta?.desc, c6.meta?.tags, c6.meta?.source, c6.meta?.status], ["부분 제목", "자동 설명", ["자동태그"], { title: "사람", desc: "자동", tags: "자동" }, "자동"]);
    같나("부분 문안: 설명이 비어 있다는 문제도 자동이 채우면 사라진다", c6.issues, []);
    같나("기록이 없는 영상은 meta 가 null", [c3.meta, c5.meta], [null, null]);
    같나("내용이 전부 빈 기록은 없는 것과 같다", c4.meta, null);
    같나("자동이 없고 문안도 없는 영상의 문제는 그대로", (await PV.build({ "채널A": { items: [{ file: `${A}/영상 2.mp4`, info: 세로() }] } }, { sources: 없는모듈 })).channels[0].items[0].issues, ["설명 파일(.txt)이 없습니다 — 파일 이름을 제목으로 씁니다"]);
    같나("JSON 으로 보낼 수 있다(링크·문안 포함)", JSON.parse(JSON.stringify(결)), 결);
    참인가("터미널 줄에도 표시", PV.lines(결).some((l) => l.endsWith("자동 제목 · 자동 문안")) && PV.lines(결).some((l) => l.endsWith("첫 영상 · 링크 2개")));
    같나("진짜 모듈 길로 불러도 던지지 않는다(모듈이 있든 없든)", (await PV.build({ "채널A": { items: 영상들 } })).total, 6);
  });

  구역("말로 시키기 — 원본 say.py 와 같은 해석");
  {
    같나("norm: 앞뒤를 걷고 공백은 하나로", SAY.norm("  채널A   최신 \n영상  "), "채널A 최신 영상");

    // 원본이 돌려준 값 그대로
    const 틀림: unknown[] = [];
    for (const [t, 기대] of 시각기대) {
      지금들.forEach((n, i) => {
        const 나온 = SAY.readTime(t, wall(...n));
        if (나온 !== 기대[i]) 틀림.push({ 말: t, 지금: n.join(","), 나온, 바람: 기대[i] });
      });
    }
    같나(`시각 읽기 ${시각기대.length * 지금들.length}건이 원본과 같다`, 틀림, []);

    const 말채널: Channels = { "요리": { channel_id: "", folder: "/data/요리방" }, "여행": { channel_id: "", folder: "/data/여행기" }, "채널A": { channel_id: "", folder: "/data/가나다" }, "채널B": { channel_id: "", folder: "" } };
    const 고객들: Channels = { "고객사A": { channel_id: "", folder: "/data/고객A" }, "고객사B": { channel_id: "", folder: "/data/고객B" }, "고객사C": { channel_id: "", folder: "/data/고객C" } };
    const 틀린해석: unknown[] = [];
    for (const g of 해석기대) {
      const p = SAY.parse(g.text, g.chans === "고객" ? 고객들 : 말채널, { now: wall(2026, 10, 17, 14, 30, 0) });
      const 나온 = { action: p.action, channels: p.channels, count: p.count, pick: p.pick, name_hint: p.name_hint, 쏠때: p.쏠때, publish: p.publish, warn: p.warn, text: p.text };
      const 바람 = { action: g.action, channels: g.channels, count: g.count, pick: g.pick, name_hint: g.name_hint, 쏠때: g.쏠때, publish: g.publish, warn: g.warn, text: g.norm };
      if (JSON.stringify(나온) !== JSON.stringify(바람)) 틀린해석.push({ 말: g.text, 나온, 바람 });
    }
    같나(`해석 ${해석기대.length}문장이 원본과 같다`, 틀린해석, []);

    // 설명서 맨 위·함수 머리의 예시 문장을 눈으로 읽히게도 적어 둔다
    const P = (t: string, c: Channels = 말채널) => SAY.parse(t, c, { now: wall(2026, 10, 17, 14, 30, 0) });
    같나("「A채널에 방금 만들어진 파일 올려줘」", [P("A채널에 방금 만들어진 파일 올려줘", 고객들).action, P("A채널에 방금 만들어진 파일 올려줘", 고객들).channels, P("A채널에 방금 만들어진 파일 올려줘", 고객들).pick], ["upload", ["고객사A"], "newest"]);
    같나("「고객사 B에 3번 파일 즉시 발행으로 올려」", [P("고객사 B에 3번 파일 즉시 발행으로 올려", 고객들).channels, P("고객사 B에 3번 파일 즉시 발행으로 올려", 고객들).pick, P("고객사 B에 3번 파일 즉시 발행으로 올려", 고객들).publish], [["고객사B"], "index:3", "now"]);
    같나("「고객사 C 오늘 뭐 올라가」는 현황", [P("고객사 C 오늘 뭐 올라가", 고객들).action, P("고객사 C 오늘 뭐 올라가", 고객들).channels], ["status", ["고객사C"]]);
    같나("「전체 현황 보여줘」는 전 채널", P("전체 현황 보여줘", 고객들).channels, ["고객사A", "고객사B", "고객사C"]);
    같나("「채널A 3개 내일 아침 9시에」: 채널·개수·시각은 읽고 동작은 되묻는다",
      [P("채널A 3개 내일 아침 9시에").channels, P("채널A 3개 내일 아침 9시에").count, P("채널A 3개 내일 아침 9시에").쏠때, P("채널A 3개 내일 아침 9시에").action, P("채널A 3개 내일 아침 9시에").warn],
      [["채널A"], 3, "2026-10-18 09:00", null, ["무엇을 하라는 건지 못 알아들었습니다 (올려 / 현황 / 공개)"]]);
    같나("fireAt 은 쏠때와 같은 값", [P("채널A 2시간 뒤에 올려").fireAt, P("채널A 2시간 뒤에 올려").쏠때], ["2026-10-17 16:30", "2026-10-17 16:30"]);
    같나("해석은 설정을 바꾸지 않는다", Object.keys(말채널), ["요리", "여행", "채널A", "채널B"]);

    같나("matchChannel: 하나", SAY.matchChannel("채널A 올려", 말채널), { hits: ["채널A"], why: "" });
    같나("matchChannel: 없음", SAY.matchChannel("아무 말", 말채널), { hits: [], why: "어느 채널인지 못 찾았습니다" });
    같나("matchChannel: 여럿이면 되묻는다", SAY.matchChannel("여행 요리", 말채널), { hits: ["요리", "여행"], why: "채널이 여럿 걸립니다: 요리, 여행" });
    같나("matchChannel: 흔한 낱말(고객사)만으로는 안 걸린다", SAY.matchChannel("고객사 올려", 고객들).hits, []);
    같나("matchChannel: 폴더 이름으로 부르기", SAY.matchChannel("요리방 폴더에 올려", 말채널).hits, ["요리"]);

    같나("describe", SAY.describe(P("채널A에 방금 만든 영상 2개 올려")), [
      "", '들은 말   "채널A에 방금 만든 영상 2개 올려"', "─".repeat(62),
      "  동작    업로드", "  채널    채널A", "  개수    2개", "  파일    가장 최근 것",
    ]);
    같나("describe: 장바구니·무작위도 죽지 않는다", [SAY.describe(P("하나 랜덤으로 담아"))[3], SAY.describe(P("하나 랜덤으로 담아")).includes("  파일    무작위")], ["  동작    장바구니 담기", true]);
  }

  구역("말로 시키기 — 폴더에서 고르기");
  await 모래상자(async (dir) => {
    const 폴 = await 폴더(dir, "채널A");
    const 초 = (s: number) => new Date(s * 1000);
    const 넣기 = async (이름: string, mtime: number) => {
      await Deno.writeFile(`${폴}/${이름}`, 바이트);
      await Deno.utime(`${폴}/${이름}`, 초(mtime), 초(mtime));
    };
    await 넣기("a_001.mp4", 1_000_000_000);
    await 넣기("b_002.mp4", 1_000_000_300);
    await 넣기("c_003.mp4", 1_000_000_200);
    await 넣기("한글영상.mp4".normalize("NFD"), 1_000_000_400);
    const cf = { channel_id: id("a"), folder: 폴 };
    const 이름들 = async (p: Parameters<typeof SAY.resolveFiles>[2]) => {
      const r = await SAY.resolveFiles("채널A", cf, p);
      return { files: r.files.map((f) => f.split("/").pop()!.normalize("NFC")), how: r.how };
    };
    const 없음 = { name_hint: null, pick: null };

    같나("고르는 말이 없으면 이름 순서대로", await 이름들(없음), { files: ["a_001.mp4", "b_002.mp4", "c_003.mp4", "한글영상.mp4"], how: "이름 순서대로" });
    같나("가장 최근에 들어온 것부터", await 이름들({ ...없음, pick: "newest" }), { files: ["한글영상.mp4", "b_002.mp4", "c_003.mp4", "a_001.mp4"], how: "가장 최근에 들어온 것부터" });
    같나("가장 오래된 것부터", await 이름들({ ...없음, pick: "oldest" }), { files: ["a_001.mp4", "c_003.mp4", "b_002.mp4", "한글영상.mp4"], how: "가장 오래된 것부터" });
    같나("이름 순 마지막", await 이름들({ ...없음, pick: "last" }), { files: ["한글영상.mp4"], how: "이름 순 마지막" });
    같나("이름 순 2번째", await 이름들({ ...없음, pick: "index:2" }), { files: ["b_002.mp4"], how: "이름 순 2번째" });
    같나("범위 밖 번호", await 이름들({ ...없음, pick: "index:9" }), { files: [], how: "9번 파일이 없습니다 (전체 4개)" });
    같나("0번도 범위 밖", await 이름들({ ...없음, pick: "index:0" }), { files: [], how: "0번 파일이 없습니다 (전체 4개)" });
    같나("이름 조각(대소문자 무시)", await 이름들({ name_hint: "B_002", pick: "oldest" }), { files: ["b_002.mp4"], how: "이름에 'B_002' 가 든 1개" });
    같나("맥 파일 이름(NFD)도 사람이 친 글(NFC)로 찾는다", await 이름들({ name_hint: "한글", pick: null }), { files: ["한글영상.mp4"], how: "이름에 '한글' 가 든 1개" });
    같나("이름 조각이 안 걸리면 고르는 방식으로", await 이름들({ name_hint: "없는이름", pick: "last" }), { files: ["한글영상.mp4"], how: "이름 순 마지막" });
    const 무작위 = await SAY.resolveFiles("채널A", cf, { ...없음, pick: "random" }, { rand: () => 0 });
    같나("무작위: 모두 들어 있고 뜻도 밝힌다", [무작위.files.length, new Set(무작위.files).size, 무작위.how], [4, 4, "무작위로"]);
    같나("무작위: 뽑는 법이 순서를 정한다", (await SAY.resolveFiles("채널A", cf, { ...없음, pick: "random" }, { rand: () => 0.999 })).files.map((f) => f.split("/").pop()!.normalize("NFC")), ["a_001.mp4", "b_002.mp4", "c_003.mp4", "한글영상.mp4"]);

    같나("폴더가 없으면 까닭을 돌려준다", (await SAY.resolveFiles("x", { channel_id: "", folder: `${dir}/없는곳` }, 없음)).how.startsWith("채널 폴더가 없습니다"), true);
    같나("폴더를 안 정했으면", (await SAY.resolveFiles("x", { channel_id: "", folder: "" }, 없음)).files, []);
    const 빈 = await 폴더(dir, "빈채널");
    같나("영상이 없으면", await SAY.resolveFiles("x", { channel_id: "", folder: 빈 }, 없음), { files: [], how: "폴더에 올릴 영상이 없습니다" });

    // 채널 말은 없고 파일 이름 조각만 있을 때
    const 둘째 = await 폴더(dir, "채널B", { 영상: 2 });
    const 둘: Channels = { "채널A": cf, "채널B": { channel_id: id("b"), folder: 둘째 } };
    같나("조각이 든 채널을 전 폴더에서 찾는다", [await SAY.channelsWithFile("b_002", 둘), await SAY.channelsWithFile("영상1", 둘), await SAY.channelsWithFile("없는조각", 둘)], [["채널A"], ["채널B"], []]);
    같나("폴더가 깨진 채널은 건너뛴다", await SAY.channelsWithFile("b_002", { ...둘, "채널C": { channel_id: "", folder: `${dir}/없는곳` } }), ["채널A"]);
  });
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}


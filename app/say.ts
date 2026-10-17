// 말로 시킨다 — "A채널에 방금 만들어진 파일 올려줘" 처럼. (파이썬: say.py)
//
//     A채널에 방금 만들어진 파일 올려줘
//     고객사 B에 3번 파일 즉시 발행으로 올려
//     고객사 C 오늘 뭐 올라가
//     전체 현황 보여줘
//
// ★ 반드시 확인을 거친다 ★
//   말을 잘못 알아들으면 **엉뚱한 채널에 올라가고 되돌릴 수 없다.**
//   그래서 자연어로는 절대 바로 실행하지 않는다. 이 파일은 **해석만** 한다 — 무엇으로 알아들었는지 돌려주고,
//   사람이 화면에서 승인해야 서버가 움직인다. 헷갈리면 묻고(warn), 못 알아들으면 못 알아들었다고 말한다.
//
// 왜 규칙 기반인가
//   명령의 폭이 좁다(채널·개수·파일·발행방식·동작). 이런 범위에서는 규칙 기반이 더 빠르고, 공짜고, 왜 그렇게 해석했는지
//   그대로 보여 줄 수 있다. "알아서 잘 해주는" 대신 "틀렸을 때 바로 보이는" 쪽을 골랐다.
//
// ───────── 원본과 다르게 한 점 (이유) ─────────
//   · 튜플 대신 객체를 돌려준다: matchChannel → { hits, why } · resolveFiles → { files, how } (picker.ts 와 같은 방식)
//   · 시각 읽기·해석에 `now` 를 받는다 — 시험이 시계를 고정한다. 안 주면 이 컴퓨터의 지금(벽시계).
//   · 원본 main() 의 터미널 출력은 describe() 가 줄로 돌려준다(실행·되묻기는 CLI 몫). 원본 main 은 장바구니 동작에서
//     KeyError 로 죽었고(act_ko 에 없다) 「무작위」를 「random번」으로 찍었다 — 바로잡았다.
//   · channelsWithFile: 원본 serve.py 의 「채널 말은 없고 파일 이름 조각만 있으면 그 조각이 든 채널을 전 폴더에서 찾는다」를
//     이 파일로 옮겼다(해석의 일부라서).
//   · 너무 큰 숫자(「99999999999시간 뒤」)는 원본에서 날짜 범위 오류로 죽었다 — 여기서는 시각을 못 읽은 것(null)으로 둔다.
import { baseName, cut } from "./paths.ts";
import { addDays, addHours, addMinutes, minuteWall, type Wall, wallNow, withTime } from "./clock.ts";
import type { ChannelConf, Channels } from "./channels.ts";
import { pendingFiles } from "./folders.ts";
import { choose } from "./picker.ts";
import type { MediaInfo } from "./shorts.ts";

// ── 말투 사전 ────────────────────────────────────────────────
// 위에서 아래로 찾는다: 「하나」가 「한」보다 앞이어야 「하나 랜덤으로」를 먼저 잡는다.
const NUM_KO: [string, number][] = [
  ["하나", 1], ["한", 1], ["둘", 2], ["두", 2], ["셋", 3], ["세", 3], ["넷", 4], ["네", 4],
  ["다섯", 5], ["여섯", 6], ["일곱", 7], ["여덟", 8], ["아홉", 9], ["열", 10],
];
const ACT_UPLOAD = ["올려", "올리", "업로드", "게시", "발행", "내보내", "쏴", "쏘아", "발사", "퍼블리시", "업해", "보내"];
const ACT_CART = ["담아", "담어", "담기", "장바구니", "카트", "골라놔", "골라 놔", "골라둬", "골라 둬", "체크해", "선택해"];
const ACT_UNCART = ["비워", "빼줘", "빼 줘", "취소해", "내려놔", "담은 것 빼", "체크 풀어"];
const ACT_STATUS = ["현황", "상태", "뭐 올라", "뭐올라", "보여", "알려", "확인해줘", "몇 개", "몇개", "재고", "얼마나 남", "몇 남", "브리핑", "요약"];
const ACT_REVIEW = ["공개", "검토", "심사"];
const NOW_WORDS = ["즉시", "바로", "지금 바로", "당장", "곧장", "즉각"];
const SCHED_WORDS = ["예약", "나중", "예정", "이따", "있다가"];
const NEWEST = ["방금", "최신", "새로", "새로운", "막 만든", "막 들어온", "방금 만들어진", "제일 새", "새 거", "최근"];
const OLDEST = ["오래된", "예전", "묵은", "제일 오래", "먼저 들어온", "맨 앞"];
const RANDOM = ["랜덤", "무작위", "아무거나", "아무 거나", "아무 영상"];

const has = (t: string, words: string[]) => words.some((w) => t.includes(w));

export function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

// 모든 채널 이름에 흔히 들어가는 낱말은 구별에 쓸 수 없다.
// 이걸 빼지 않으면 "고객사 B" 라고 말해도 '고객사' 때문에 전 채널이 걸린다.
const STOP = new Set(["고객사", "채널", "님", "쇼츠", "유튜브", "계정", "저장", "영상", "파일"]);

const 한글덩이 = (s: string) => (s.match(/[가-힣]{2,}/g) ?? []).filter((w) => !STOP.has(w));
const 중복없이 = (a: string[]) => [...new Set(a)];

/** 폴더 경로의 마지막 칸 (끝의 구분자는 무시) */
function leafOf(folder: string): string {
  return baseName(folder.replace(/[\\/]+$/, ""));
}

/** 말 속에서 채널을 찾는다. 여러 개가 걸리면 되묻는다. (파이썬 match_channel) */
export function matchChannel(text: string, chans: Channels): { hits: string[]; why: string } {
  let hits: string[] = [];
  for (const alias of Object.keys(chans)) {
    // 별칭 전체, 그리고 별칭에서 뽑은 낱말들로 견줘 본다(흔한 낱말은 뺀다)
    const parts = [alias, ...alias.split(/[\s\-·]+/).filter((w) => [...w].length >= 2 && !STOP.has(w))];
    // "고객사A-쇼츠" 를 "고객사A" 라고 부른다 — 별칭 속 한글 덩어리도 견준다
    parts.push(...한글덩이(alias));
    if (parts.some((p) => p && text.includes(p))) {
      hits.push(alias);
      continue;
    }
    // "A채널", "고객사A" 처럼 붙여 쓴 경우
    const m = /고객사\s*([A-Za-z가-힣])|([A-Za-z])\s*채널/.exec(text);
    if (m) {
      const letter = (m[1] ?? m[2] ?? "").toUpperCase();
      if (letter && alias.toUpperCase().replace(/ /g, "").includes(letter)) hits.push(alias);
    }
  }
  hits = 중복없이(hits);

  if (!hits.length) {
    // 거꾸로도 본다 — 말 속의 한글 토막("여행", "요리")이 별칭 안에 **들어 있으면** 그 채널이다. 여럿 걸리면 되묻는다.
    const 토막들 = 한글덩이(text);
    for (const alias of Object.keys(chans)) if (토막들.some((토) => alias.includes(토))) hits.push(alias);
    hits = 중복없이(hits);
  }
  if (!hits.length) {
    // 사람은 채널명보다 **폴더 이름**으로 부르기도 한다 ("여행 폴더에 올려").
    // 폴더 이름의 낱말(2자 이상)이 말에 들어 있으면 그 채널로 듣는다.
    const 토막들 = 한글덩이(text);
    for (const [alias, cf] of Object.entries(chans)) {
      const 폴더 = String(cf.folder ?? "");
      if (!폴더) continue;
      const 밑 = leafOf(폴더);
      const 낱말 = 밑.split(/[\s\-_·0-9]+/).filter((w) => [...w].length >= 2);
      if (낱말.some((w) => text.includes(w)) || 토막들.some((토) => [...토].length >= 3 && 밑.includes(토))) hits.push(alias);
    }
    hits = 중복없이(hits);
  }
  if (!hits.length) return { hits: [], why: "어느 채널인지 못 찾았습니다" };
  if (hits.length > 1) return { hits, why: `채널이 여럿 걸립니다: ${hits.join(", ")}` };
  return { hits, why: "" };
}

export type SayAction = "uncart" | "cart" | "review" | "upload" | "status" | null;

/** 해석 결과 — 칸 이름은 원본이 돌려주던 그대로다 */
export interface SayParse {
  /** 공백을 정리한 들은 말 */
  text: string;
  /** 되묻는 말 */
  warn: string[];
  /** uncart(빼기) · cart(담기) · review(검토 후 공개) · upload(올리기) · status(현황) · null(못 알아들음) */
  action: SayAction;
  channels: string[];
  count: number | null;
  /** random · newest · oldest · index:N · last · null */
  pick: string | null;
  /** 파일 이름 조각 — 따옴표로 감싼 것이 가장 확실하고, 없으면 밑줄·하이픈이 든 낱말 */
  name_hint: string | null;
  /** 시각을 말했으면 "YYYY-MM-DD HH:MM" — 발사대기(그 시각까지 이 컴퓨터가 보관)로 간다 */
  쏠때: string | null;
  /** 쏠때와 같은 값 (API 명세의 이름) */
  fireAt: string | null;
  /** now 즉시 · schedule 예약 · null 채널 설정을 따른다 */
  publish: "now" | "schedule" | null;
}

/** 말 → 할 일. 실행하지 않는다. (파이썬 parse) */
export function parse(text: string, chans: Channels, o: { now?: Wall } = {}): SayParse {
  const t = norm(text);
  const warn: string[] = [];

  // 동작
  let action: SayAction;
  if (has(t, ACT_UNCART)) action = "uncart"; // 장바구니에서 빼기 — 안 나가는 동작
  else if (has(t, ACT_CART)) action = "cart"; // 장바구니는 안 나가는 동작 — 되돌리기 쉽다
  else if (has(t, ACT_REVIEW) && !has(t, ACT_UPLOAD)) action = "review";
  else if (has(t, ACT_UPLOAD)) action = "upload";
  else if (has(t, ACT_STATUS)) action = "status";
  else {
    action = null;
    warn.push("무엇을 하라는 건지 못 알아들었습니다 (올려 / 현황 / 공개)");
  }

  // 채널
  const { hits, why } = matchChannel(t, chans);
  let channels = hits;
  if (why) warn.push(why);
  // 현황은 전체가 기본, 공개는 검토 대기 전체를 훑으므로 채널 지정이 필요 없다
  let warns = warn;
  if (!hits.length && (action === "status" || action === "review")) {
    channels = action === "status" ? Object.keys(chans) : [];
    warns = warn.filter((w) => !w.includes("채널"));
  }

  // 개수
  let count: number | null = null;
  const m = /(\d+)\s*(개|편|건)/.exec(t);
  if (m) {
    count = parseInt(m[1], 10);
  } else {
    for (const [k, v] of NUM_KO) {
      if (new RegExp(k + "\\s*(개|편|건)").test(t)) { count = v; break; }
    }
    if (count === null) {
      // "하나 랜덤으로 담아" — 단위가 없어도 숫자말은 숫자다.
      //   한/두/세/네 는 다른 말에 너무 잘 섞여서(한강·세로) 뺀다.
      for (const [k, v] of NUM_KO) {
        if ([...k].length >= 2 && new RegExp(`(?<![가-힣])${k}(?![가-힣])`).test(t)) { count = v; break; }
      }
    }
  }

  // 파일 고르기
  let pick: string | null;
  if (has(t, RANDOM)) pick = "random";
  else if (has(t, NEWEST)) pick = "newest";
  else if (has(t, OLDEST)) pick = "oldest";
  else {
    const mi = /(\d+)\s*번(째)?/.exec(t);
    if (mi) pick = `index:${mi[1]}`;
    else if (has(t, ["마지막", "맨 뒤", "맨뒤"])) pick = "last";
    else pick = null;
  }

  // 파일명 조각 — 따옴표로 감싼 것이 가장 확실하고, 없으면 밑줄 든 낱말
  let name_hint: string | null;
  const mq = /['"‘“]([^'"’”]{2,40})['"’”]/.exec(t);
  if (mq) {
    name_hint = mq[1].trim();
  } else {
    const mf = /([\p{L}\p{N}_]*[_\-][\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]{2,4})?)/u.exec(t);
    name_hint = mf ? mf[1] : null;
  }

  // 시각 — 있으면 발사대기(컴퓨터 보관 후 그 시각 업로드)로 간다
  const 쏠때 = readTime(t, o.now);

  // 발행 방식
  let publish: "now" | "schedule" | null;
  if (has(t, NOW_WORDS)) publish = "now";
  else if (has(t, SCHED_WORDS)) publish = "schedule";
  else publish = null; // 채널 설정을 따른다

  return { text: t, warn: warns, action, channels, count, pick, name_hint, 쏠때, fireAt: 쏠때, publish };
}

/**
 * 말 속의 시각을 "YYYY-MM-DD HH:MM" 으로. 없으면 null. (파이썬 _시각읽기)
 *
 * 알아듣는 것
 *   "내일 9시" · "모레 오후 3시 반" · "오늘 밤 8시" · "21시에"
 *   "2시간 뒤" · "40분 뒤" · "9시 15분에"
 * 잣대
 *   오전/아침/새벽 → 그대로, 오후/저녁/밤/낮 → +12.
 *   아무 말 없는 "8시" 는 **다가오는** 8시로 듣는다(지났으면 저녁, 저녁도 지났으면 내일 아침).
 * 못 읽는 것 (원본도 같다)
 *   숫자 없는 "모레 저녁" · 24시 이상 · 60분 이상 — null. 「밤 12시」·「오전 12시」는 낮 12시로 읽는다.
 */
export function readTime(t: string, now: Wall = wallNow()): string | null {
  const 글로 = (w: Wall) => (Number.isFinite(w.getTime()) && w.getUTCFullYear() <= 9999 ? minuteWall(w) : null);

  let m = /(\d+)\s*시간\s*(뒤|후|있다)/.exec(t);
  if (m) return 글로(addHours(now, parseInt(m[1], 10)));
  m = /(\d+)\s*분\s*(뒤|후|있다)/.exec(t);
  if (m) return 글로(addMinutes(now, Math.max(2, parseInt(m[1], 10))));

  m = /(\d{1,2})\s*시(?:\s*(반|(\d{1,2})\s*분))?/.exec(t);
  if (!m) return null;
  let 시 = parseInt(m[1], 10);
  const 분 = m[2] === "반" ? 30 : (m[3] ? parseInt(m[3], 10) : 0);
  if (시 > 23 || 분 > 59) return null;

  let 날 = withTime(now, 0, 0);
  if (t.includes("모레")) 날 = addDays(날, 2);
  else if (t.includes("내일")) 날 = addDays(날, 1);

  const 오후말 = has(t, ["오후", "저녁", "밤", "낮"]);
  const 오전말 = has(t, ["오전", "아침", "새벽"]);
  if (오후말 && 시 < 12) 시 += 12;
  let when = withTime(날, 시, 분);
  const 지남 = () => when.getTime() <= now.getTime();
  // 날짜 말도 오전오후 말도 없이 지난 시각이면 — 다가오는 쪽으로 민다
  if (!t.includes("내일") && !t.includes("모레") && !오전말 && 지남()) {
    if (시 < 12) when = withTime(when, 시 + 12, 분);
    if (지남()) when = withTime(addDays(when, 1), 시, 분);
  }
  if (지남()) when = addDays(when, 1);
  return 글로(when);
}

const 조용히 = () => {};
const 정보없음 = {} as MediaInfo; // 이름순·오래된순 고르기는 영상 실측값을 쓰지 않는다

/**
 * 어떤 파일을 말하는지 실제 폴더에서 찾는다. (파이썬 resolve_files)
 * 폴더를 못 읽으면 files 가 비고 how 에 까닭이 담긴다.
 */
export async function resolveFiles(
  _alias: string, cf: ChannelConf, p: Pick<SayParse, "name_hint" | "pick">, o: { rand?: () => number } = {},
): Promise<{ files: string[]; how: string }> {
  let files: string[];
  try {
    files = await pendingFiles(String(cf.folder ?? ""), 조용히);
  } catch (e) {
    return { files: [], how: e instanceof Error ? e.message : String(e) };
  }
  if (!files.length) return { files: [], how: "폴더에 올릴 영상이 없습니다" };

  const 고르기 = (mode: "order" | "oldest") =>
    choose(files.map((path) => ({ path, info: 정보없음 })), mode, files.length).chosen.map((x) => x.path);

  if (p.name_hint) {
    // 외장 파일명은 NFD 라 사람이 친 NFC 와 바이트가 다르다 — 꼭 맞춘다
    const 조각 = p.name_hint.normalize("NFC").toLowerCase();
    const hit = files.filter((f) => baseName(f).normalize("NFC").toLowerCase().includes(조각));
    if (hit.length) return { files: hit, how: `이름에 '${p.name_hint}' 가 든 ${hit.length}개` };
  }

  const pick = p.pick;
  if (pick === "newest") {
    const 때 = (f: string) => { try { return Deno.statSync(f).mtime?.getTime() ?? 0; } catch { return 0; } };
    return { files: files.map((f) => ({ f, t: 때(f) })).sort((a, b) => b.t - a.t).map((x) => x.f), how: "가장 최근에 들어온 것부터" };
  }
  if (pick === "oldest") return { files: 고르기("oldest"), how: "가장 오래된 것부터" };
  if (pick === "random") {
    const rand = o.rand ?? Math.random;
    const a = [...files];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return { files: a, how: "무작위로" };
  }
  const 이름순 = 고르기("order");
  if (pick === "last") return { files: [이름순[이름순.length - 1]], how: "이름 순 마지막" };
  if (pick && pick.startsWith("index:")) {
    const i = parseInt(pick.split(":")[1], 10);
    if (i >= 1 && i <= 이름순.length) return { files: [이름순[i - 1]], how: `이름 순 ${i}번째` };
    return { files: [], how: `${i}번 파일이 없습니다 (전체 ${이름순.length}개)` };
  }
  return { files: 이름순, how: "이름 순서대로" };
}

/**
 * 채널 말은 없는데 파일 이름 조각만 있을 때 — 그 조각이 든 영상이 있는 채널을 전 폴더에서 찾는다.
 * 딱 한 채널이면 그 채널로 듣고, 여럿이면 호출한 쪽이 되묻는다. (파이썬 serve.py say/parse 의 한 토막)
 */
export async function channelsWithFile(hint: string, chans: Channels): Promise<string[]> {
  const 조각 = hint.normalize("NFC").toLowerCase();
  const 걸린: string[] = [];
  for (const [k, cf] of Object.entries(chans)) {
    let fs: string[];
    try { fs = await pendingFiles(String(cf.folder ?? ""), 조용히); } catch { continue; }
    if (fs.some((f) => baseName(f).normalize("NFC").toLowerCase().includes(조각))) 걸린.push(k);
  }
  return 걸린;
}

const 동작말: Record<string, string> = {
  upload: "업로드", status: "현황 보기", review: "검토 후 공개", cart: "장바구니 담기", uncart: "장바구니 빼기",
};

/** 들은 대로 사람에게 보여 줄 줄들 — 「이렇게 알아들었습니다」. (파이썬 main 의 앞부분) */
export function describe(p: SayParse): string[] {
  const out = ["", `들은 말   "${p.text}"`, "─".repeat(62)];
  out.push(`  동작    ${p.action ? 동작말[p.action] : "?"}`);
  out.push(`  채널    ${p.channels.length ? p.channels.join(", ") : "—"}`);
  if (p.count) out.push(`  개수    ${p.count}개`);
  if (p.pick) {
    const ko = p.pick === "newest" ? "가장 최근 것" : p.pick === "oldest" ? "가장 오래된 것" :
      p.pick === "random" ? "무작위" : p.pick === "last" ? "이름 순 마지막" : `${p.pick.split(":").pop()}번`;
    out.push(`  파일    ${ko}`);
  }
  if (p.name_hint) out.push(`  이름    '${cut(p.name_hint, 40)}' 포함`);
  if (p.쏠때) out.push(`  시각    ${p.쏠때}`);
  if (p.publish) out.push(`  발행    ${p.publish === "now" ? "즉시" : "예약"}`);
  for (const w of p.warn) out.push(`  ⚠ ${w}`);
  return out;
}

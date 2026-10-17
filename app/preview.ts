// 올리기 전 확인 — 오늘 올라갈 영상들을 채널별로 정리한 **자료**. (파이썬: preview.py)
//
// 왜 필요한가
//   파일 이름과 길이만 봐서는 **내용이 맞는지** 알 수 없다. 고객이 잘못 넣었거나 편집이 덜 끝난 영상이 섞여도 이름은 멀쩡하다.
//   올리고 나면 되돌릴 수 없으니 올리기 전에 실제 화면을 본다. 화면(「올리기 전 확인」 모달)은 이 자료로 메인이 그린다.
//
// ★원본은 이 자료로 HTML 한 장을 만들어 브라우저에 띄웠다. 여기는 HTML 을 만들지 않는다 — JSON 으로 보낼 수 있는 자료만 만든다.
//   (영상 미리보기는 화면이 `<video src="/media?p=<file>">` 로, 맞춤 썸네일은 `/thumb?p=<thumb 경로>` 로 직접 보여 준다)
//
// ───────── 입력: build(byChannel) ─────────
//   { [채널 이름]: { info?: { handle? }, note?: string, items: [입력 영상...] } }
//
//   입력 영상 (오늘 몫을 먼저, 여분을 뒤에 — 원본과 같은 차례)
//   | 칸        | 뜻 |
//   |-----------|----|
//   | file      | 영상 경로(절대) |
//   | info      | shorts.check 가 잰 값 (w · h · sec · mb …) |
//   | when      | 사람에게 보일 시각 글: "09:15" · "즉시 발행" · "대기". 없으면 publishAt 의 시·분, 여분이면 "대기" |
//   | publishAt | 공개 시각 "YYYY-MM-DD HH:MM" (없으면 "") |
//   | fireAt    | 올리기(발사) 시각 "YYYY-MM-DDTHH:MM:SS" (없으면 "") |
//   | rank      | 추천 순위(1부터). 모르면 null |
//   | spare     | true 면 오늘 몫 밖의 여분(원본의 「대기」 칩) — 처음엔 체크 해제 |
//   | reason    | 이 영상이 왜 여기 있나. 없으면 spare·rank 로 만든다 |
//   | kind      | 쇼츠 | 롱폼. 없으면 info 로 판정 |
//
// ───────── 출력: PreviewData ─────────
//   | 칸                  | 뜻 |
//   |---------------------|----|
//   | at                  | 자료를 만든 때 (이 컴퓨터 시각) |
//   | total               | 영상 수 (여분 포함) |
//   | picked              | 처음부터 체크돼 있는 수 = 오늘 올릴 것 |
//   | problems            | 문제가 하나라도 있는 영상 수 |
//   | channels[]          | 채널마다 한 칸 |
//   |  ch                 | 채널 이름 |
//   |  handle             | 입력 info.handle (원본은 채널ID 를 넣어 왔다) |
//   |  note               | 채널 한 줄 설명 (고르기 방식 안내 등) |
//   |  count/picked/problems | 이 채널의 영상 수 · 체크된 수 · 문제 있는 수 |
//   |  items[]            | 영상마다 한 칸 ↓ |
//   |   file / name       | 경로 / 파일 이름 |
//   |   title / descHead  | 올라갈 제목 / 설명 첫 줄(52자) — 볼 때마다 새로 읽는다(문안은 수시로 고쳐진다) |
//   |   titleLen / descLen / tagCount | 제목·설명 글자 수 · 태그 수 |
//   |   textFrom          | 문안이 어느 파일에서 왔나(파일 이름). null 이면 파일 이름이 제목이 된다 |
//   |   kind / sec / w / h / mb | 종류 · 길이(초) · 크기 · 용량(MB) |
//   |   rank / spare / checked   | 추천 순위 · 여분 여부 · 처음 체크 상태(= !spare) |
//   |   when / publishAt / fireAt | 시각 (입력 그대로, 없으면 "") |
//   |   reason            | 사유 |
//   |   thumb             | { has, name, bytes, w, h, over, needed, path } — needed 는 롱폼(썸네일이 클릭률을 좌우) |
//   |   issues[]          | 사람이 읽는 문제들 (없으면 []) |
//   |   blocked           | true 면 올릴 때 출구검사가 막을 문제(이미 올림·문안 규격 미달)가 있다 |
//   |   meta              | 자동으로 **이미 지어 둔** 문안이 있을 때만 { title, desc, tags, source, status, at }, 없으면 null |
//   |                     |   source = 칸마다 어디서 왔나 { title, desc, tags } 각각 사람 · 쪽지 · 자동 · 파일이름 · ""(그 칸은 비어 있다) |
//   |                     |   status = 자동(하나라도 자동) · 사람 · 쪽지 — title/desc/tagCount 도 이 합친 값(사람 > 쪽지 > 자동 > 파일이름)이다 |
//   |   links[]           | 이미 골라 둔 쿠팡 상품 링크 [{ name, url }] (http/https 만; 없으면 []) |
//   |   linkStatus        | 붙임 · 없음 · 건너뜀 · 사람이넣음 · 아직(기록이 없다) |
//
// 문제로 잡는 것: 이미 올린 파일 · 설명 파일 없음/빈 설명/제목 잘림/제목이 라벨 · 채널 문안 규격 미달 · 롱폼인데 맞춤 썸네일 없음 ·
//   썸네일이 2MB 초과 · 종류를 알 수 없음. 쇼츠는 맞춤 썸네일이 없어도 정상이다(유튜브가 영상에서 뽑아 쓴다).
// 원본은 「이미 올림」「설명 파일 없음」 두 가지만 칩으로 보였다. 나머지는 올릴 때 가서야 알던 것을 미리 보이는 것이다.
//
// ───────── 쿠팡 파트너스·AI 문안 — 이미 지어 둔 것만 읽는다 ─────────
//   `coupang.ts` 의 recordFor(file) 과 `ai.ts` 의 metaRecordFor(file) 로 **기록만** 읽는다. 검색·AI 호출은 한 번도 하지 않는다 —
//   미리보기가 비용(쿠팡 검색 한도·AI 호출)을 쓰면 안 된다. 두 모듈은 동적 import 라 아직 없거나 던져도 미리보기는 그대로 나온다
//   (meta null · links [] · linkStatus "아직"). 자동 문안이 채우는 칸의 「설명 파일 없음」은 더는 문제가 아니라 문제 목록에서 뺀다.
import { baseName, cut, stemOf } from "./paths.ts";
import { isoWall, wallNow, type Wall } from "./clock.ts";
import { confFor, loadChannels } from "./channels.ts";
import type { MetaRule } from "./channels.ts";
import { uploadedNames } from "./ledger.ts";
import { checkMeta, findText, loadFor, splitLines, TITLE_MAX } from "./sidecar.ts";
import type { TextMeta } from "./sidecar.ts";
import { checkFile } from "./metacheck.ts";
import { classify } from "./shorts.ts";
import type { Kind, MediaInfo } from "./shorts.ts";
import { custom as customThumb } from "./thumbs.ts";
import { callOptional } from "./issues.ts";
import type { OptionalLoaders } from "./issues.ts";

export interface PreviewItemIn {
  file: string;
  info: MediaInfo;
  when?: string;
  publishAt?: string;
  fireAt?: string;
  rank?: number | null;
  spare?: boolean;
  reason?: string;
  kind?: Kind;
}
export interface PreviewChannelIn { info?: { handle?: string }; note?: string; items: PreviewItemIn[] }
export type PreviewIn = Record<string, PreviewChannelIn>;

export interface PreviewThumb {
  has: boolean;
  name: string;
  bytes: number;
  w: number;
  h: number;
  /** 2MB 를 넘어 유튜브가 거부할 것인가 */
  over: boolean;
  /** 이 영상에 맞춤 썸네일이 있어야 하나 (롱폼) */
  needed: boolean;
  /** 그림 파일 경로 (없으면 "") */
  path: string;
}

export type LinkStatus = "붙임" | "없음" | "건너뜀" | "사람이넣음" | "아직";
export interface LinkRef { name: string; url: string }

/** 칸마다 어디서 왔나: 사람(.txt) · 쪽지(.json) · 자동 · 파일이름 · ""(그 칸은 비어 있다) */
export interface MetaSource { title: string; desc: string; tags: string }
export interface PreviewMeta {
  title: string;
  desc: string;
  tags: string[];
  source: MetaSource;
  /** 자동(하나라도 자동으로 채움) · 사람 · 쪽지 */
  status: string;
  /** 자동으로 지은 때 (기록의 at) */
  at: string;
}

export interface PreviewItem {
  file: string;
  name: string;
  title: string;
  descHead: string;
  titleLen: number;
  descLen: number;
  tagCount: number;
  textFrom: string | null;
  kind: Kind;
  sec: number;
  w: number;
  h: number;
  mb: number;
  rank: number | null;
  spare: boolean;
  checked: boolean;
  when: string;
  publishAt: string;
  fireAt: string;
  reason: string;
  thumb: PreviewThumb;
  issues: string[];
  blocked: boolean;
  meta: PreviewMeta | null;
  links: LinkRef[];
  linkStatus: LinkStatus;
}
export interface PreviewChannel {
  ch: string;
  handle: string;
  note: string;
  count: number;
  picked: number;
  problems: number;
  items: PreviewItem[];
}
export interface PreviewData {
  at: string;
  total: number;
  picked: number;
  problems: number;
  channels: PreviewChannel[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 오늘 올라갈 영상들을 채널별 자료로. 읽을 때마다 문안·썸네일·올린 기록을 새로 본다. (파이썬 build — HTML 대신 자료) */
export async function build(byChannel: PreviewIn, o: { now?: Wall; sources?: OptionalLoaders } = {}): Promise<PreviewData> {
  const chans = loadChannels();
  const done = uploadedNames(); // 올린 기록은 한 번만 읽는다 — 영상마다 읽으면 수백 개에서 느려진다
  const channels: PreviewChannel[] = [];

  for (const [ch, data] of Object.entries(byChannel)) {
    const rule = confFor(ch, chans)?.meta_rule;
    const items: PreviewItem[] = [];
    for (const it of data.items ?? []) items.push(await buildItem(it, rule, done, o.sources ?? {}));
    channels.push({
      ch,
      handle: String(data.info?.handle ?? ""),
      note: String(data.note ?? ""),
      count: items.length,
      picked: items.filter((x) => x.checked).length,
      problems: items.filter((x) => x.issues.length).length,
      items,
    });
  }

  return {
    at: isoWall(o.now ?? wallNow()),
    total: channels.reduce((a, c) => a + c.count, 0),
    picked: channels.reduce((a, c) => a + c.picked, 0),
    problems: channels.reduce((a, c) => a + c.problems, 0),
    channels,
  };
}

async function buildItem(
  it: PreviewItemIn, rule: MetaRule | undefined,
  done: Map<string, [string, string, string]>, sources: OptionalLoaders,
): Promise<PreviewItem> {
  const name = baseName(it.file);
  const issues: string[] = [];
  let blocked = false;
  const spare = !!it.spare;

  // 종류 — 입력에 없으면 잰 값으로 판정한다. 읽을 수 없으면 꾸며내지 않고 문제로 알린다.
  let kind: Kind = it.kind ?? "쇼츠";
  if (!it.kind) {
    try { kind = classify(it.info); } catch (e) { issues.push(`종류를 알 수 없습니다 — ${errMsg(e)}`); }
  }

  // 문안 — 볼 때마다 새로 읽는다. 텍스트는 수시로 고쳐지므로 캐시하지 않는다.
  const stem = stemOf(name);
  let m: TextMeta = { title: stem.slice(0, TITLE_MAX), desc: "", tags: [], source: null };
  let bad: string[] = [];
  try {
    m = await loadFor(it.file);
    bad = (await checkMeta(it.file)).bad;
  } catch (e) {
    issues.push(`문안을 읽지 못했습니다 — ${cut(errMsg(e), 80)}`);
  }

  // 이미 지어 둔 자동 문안 — 읽기만 한다(AI 를 부르지 않는다). 칸마다 사람 > 쪽지 > 자동 > 파일이름.
  const meta = 합치기(m, stem, 읽은기록(await callOptional("ai", "metaRecordFor", [it.file], sources)));
  const 보임 = meta ?? { title: m.title, desc: m.desc, tags: m.tags };
  for (const b of bad) {
    // 자동 문안이 채우는 칸은 「없습니다」가 아니다
    if (meta && m.source === null && b.startsWith("설명 파일(.txt)이 없습니다")) continue;
    if (meta?.source.desc === "자동" && b === "설명이 비어 있습니다") continue;
    issues.push(b);
  }
  const { links, linkStatus } = 링크읽기(await callOptional("coupang", "recordFor", [it.file], sources));

  // 이미 올린 파일 — 출구검사가 막는다
  const up = done.get(name);
  if (up) {
    issues.push(`이미 올린 파일입니다 — ${up[0]} [${up[1]}]`);
    blocked = true;
  }

  // 채널 문안 규격 — 출구검사의 6번 문턱. 올릴 때 가서 막히기 전에 미리 보인다.
  if (rule && Object.keys(rule).length) {
    try {
      const txt = await findText(it.file);
      if (!txt) {
        issues.push("문안 규격 미달 — 곁파일(.txt) 없음");
        blocked = true;
      } else {
        const 흠 = await checkFile(rule, txt, m.tags);
        if (흠.length) {
          issues.push(`문안 규격 미달 — ${흠.join(", ")}`);
          blocked = true;
        }
      }
    } catch (e) {
      issues.push(`문안 규격을 잴 수 없습니다 — ${cut(errMsg(e), 80)}`);
    }
  }

  // 맞춤 썸네일 — 롱폼은 썸네일이 곧 클릭률이다. 없는데 있는 줄 알고 올리면 되돌릴 수 없다.
  const needed = kind === "롱폼";
  const th = await customThumb(it.file);
  const thumb: PreviewThumb = {
    has: th.있음, name: th.이름, bytes: th.크기, w: th.가로, h: th.세로, over: th.넘침, needed, path: th.path,
  };
  if (needed && !th.있음) issues.push("맞춤 썸네일이 없습니다 — 롱폼은 썸네일이 클릭률을 좌우합니다");
  if (th.넘침) issues.push(`썸네일이 2MB 를 넘어 올라가지 않습니다 — ${th.이름}`);

  const publishAt = String(it.publishAt ?? "");
  const when = it.when ?? (spare ? "대기" : publishAt.slice(11, 16));
  const rank = it.rank ?? null;

  return {
    file: it.file,
    name,
    title: 보임.title,
    descHead: cut(splitLines(보임.desc)[0] ?? "", 52),
    titleLen: [...보임.title].length,
    descLen: [...보임.desc].length,
    tagCount: 보임.tags.length,
    textFrom: m.source ? baseName(m.source) : null,
    kind,
    sec: it.info.sec,
    w: it.info.w,
    h: it.info.h,
    mb: it.info.mb,
    rank,
    spare,
    checked: !spare,
    when,
    publishAt,
    fireAt: String(it.fireAt ?? ""),
    reason: it.reason ?? (spare
      ? `여분 — 오늘 몫 밖이라 이번에는 올라가지 않습니다${rank ? ` (추천 ${rank}위)` : ""}`
      : `오늘 올릴 몫${rank ? ` · 추천 ${rank}위` : ""}`),
    thumb,
    issues,
    blocked,
    meta,
    links,
    linkStatus,
  };
}

/* ============================================================ 이미 지어 둔 것 읽기 */

interface AiRec { title: string; desc: string; tags: string[]; at: string }

/** ai.metaRecordFor 가 준 기록 → 꼴을 가다듬는다. 알아볼 칸이 하나도 없으면 null. */
function 읽은기록(x: unknown): AiRec | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const 글 = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const rec: AiRec = {
    title: 글(r.title),
    desc: 글(r.description ?? r.desc),
    tags: (Array.isArray(r.tags) ? r.tags : []).filter((t): t is string => typeof t === "string")
      .map((t) => t.trim().replace(/^#+/, "")).filter(Boolean),
    at: 글(r.at),
  };
  return rec.title || rec.desc || rec.tags.length ? rec : null;
}

/**
 * 사람이 정한 칸은 그대로 두고, 비어 있는 칸만 자동 문안으로 채운다 — 올릴 때 쓰는 우선순위와 같다.
 *   사람(영상 옆 .txt) > 쪽지(.json) > 자동 > 파일이름   (칸마다 따로: 제목·설명·태그)
 * 제목은 「파일 이름으로 대신 채운 것」을 사람이 정한 것으로 치지 않는다(loadFor 가 그렇게 채운다).
 */
function 합치기(m: TextMeta, stem: string, rec: AiRec | null): PreviewMeta | null {
  if (!rec) return null;
  const 사람 = m.source === null ? null : (/\.txt$/i.test(m.source) ? "사람" : "쪽지");
  const 제목정함 = 사람 !== null && !!m.title && m.title !== stem.slice(0, TITLE_MAX);
  const 설명정함 = 사람 !== null && !!m.desc.trim();
  const 태그정함 = 사람 !== null && m.tags.length > 0;
  const source: MetaSource = {
    title: 제목정함 ? 사람! : rec.title ? "자동" : "파일이름",
    desc: 설명정함 ? 사람! : rec.desc ? "자동" : "",
    tags: 태그정함 ? 사람! : rec.tags.length ? "자동" : "",
  };
  return {
    title: 제목정함 || !rec.title ? m.title : rec.title,
    desc: 설명정함 || !rec.desc ? m.desc : rec.desc,
    tags: 태그정함 || !rec.tags.length ? m.tags : rec.tags,
    source,
    status: Object.values(source).includes("자동") ? "자동" : (사람 ?? "자동"),
    at: rec.at,
  };
}

const 링크상태 = new Set(["붙임", "없음", "건너뜀", "사람이넣음"]);

/** coupang.recordFor 가 준 기록 → 링크와 상태. 기록이 없으면 「아직」. 주소는 http(s) 만 남긴다(화면이 링크로 그리므로). */
function 링크읽기(x: unknown): { links: LinkRef[]; linkStatus: LinkStatus } {
  if (!x || typeof x !== "object") return { links: [], linkStatus: "아직" };
  const r = x as Record<string, unknown>;
  const links: LinkRef[] = [];
  for (const l of Array.isArray(r.links) ? r.links : []) {
    if (!l || typeof l !== "object") continue;
    const { name, url } = l as Record<string, unknown>;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) links.push({ name: typeof name === "string" ? name : "", url });
  }
  const st = typeof r.status === "string" && 링크상태.has(r.status) ? r.status as LinkStatus : "아직";
  return { links, linkStatus: st };
}

/** 터미널용 — 같은 자료를 줄로 (`확인` 명령). 화면은 build 의 자료를 직접 쓴다. */
export function lines(data: PreviewData): string[] {
  if (!data.total) return ["", "  올릴 것이 없습니다.", ""];
  const out = ["", `  올리기 전 확인 — 채널 ${data.channels.length}개 · 영상 ${data.total}개 (오늘 올릴 것 ${data.picked}개 · 문제 ${data.problems}개)`];
  for (const c of data.channels) {
    out.push("", `  ${c.ch}  ${c.count}개 (체크 ${c.picked}개)${c.note ? " — " + c.note : ""}`);
    for (const x of c.items) {
      const 곁 = (x.meta?.status === "자동" ? " · 자동 문안" : "") + (x.links.length ? ` · 링크 ${x.links.length}개` : "");
      out.push(`    ${x.checked ? "✓" : "·"} ${x.when.padEnd(8)} ${x.kind} ${Math.round(x.sec)}초  ${cut(x.title, 40)}${곁}`);
      for (const p of x.issues) out.push(`        ⚠ ${p}`);
    }
  }
  out.push("");
  return out;
}

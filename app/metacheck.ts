// 문안 점검 — 올리기 전에 제목·설명·태그가 제대로 읽히는지, 채널 규격에 맞는지 미리 본다.
//   (파이썬: checktext.py  +  메타검사.py 의 일반화)
//
// 두 가지 일을 한다
//   ① 폴더 점검(lookFolder)  — 폴더의 영상마다 앱이 실제로 무엇을 읽는지 보여 준다.
//      영상 100개를 만든 뒤에 제목이 파일 이름으로 나가는 걸 알면 늦다(실제로 제목이 파일명으로 올라간 사고가 있었다).
//   ② 규격 검사(checkText)   — 채널 설정 `meta_rule` 이 켜져 있을 때만, 그 규격으로 곁파일 글을 잰다.
//      파이썬은 특정 채널(일본어 채널) 하나만 하드코딩된 잣대였다. 지금은 규칙 칸이 켜진 채널에 똑같이 적용한다.
//      · forbid_hangul     한글이 한 글자라도 있으면 흠 (일본어·영어 채널)
//      · hashtags          해시태그 정확한 개수 (올릴 때 끊기는 태그·겹침·본문에 섞인 태그도 함께)
//      · forbid_shorts_tag #shorts 금지
//      · forbid_cta        구독·좋아요·알림 유도 말 금지
//      · desc_min/desc_max 설명 본문 글자 수 (해시태그만 있는 줄은 뺀다)
//   ★원본에 박혀 있던 실측 숫자(설명 527~706자 등)는 기본값으로 쓰지 않는다 — 규칙에 값이 있을 때만 잰다.
//   ★「설명에 1️⃣2️⃣3️⃣ 번호 요약이 있나」는 한 채널의 글 모양이라 규칙 칸에 없다 — 옮기지 않았다.
import { baseName, extOf, join, stemOf } from "./paths.ts";
import { VIDEO_EXT } from "./folders.ts";
import { DESC_MAX, TAG_MAX, TITLE_MAX, loadFor, readSections, splitLines, 해시태그자 } from "./sidecar.ts";
import type { MetaRule } from "./channels.ts";

const chars = (s: string) => Array.from(s).length;
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ============================================================ ① 폴더 점검 */

export interface LookItem {
  file: string;
  title: string;
  titleLen: number;
  /** 설명의 첫 줄 */
  descFirst: string;
  descLen: number;
  tags: string[];
  /** 읽은 문안 파일 이름 (없으면 null — 제목이 파일 이름으로 나간다) */
  source: string | null;
  problems: string[];
  ok: boolean;
}

export interface LookResult {
  folder: string;
  /** 폴더가 실제로 있나 */
  exists: boolean;
  videos: number;
  /** 손볼 곳이 있는 영상 수 */
  bad: number;
  items: LookItem[];
}

/** 폴더의 문안 파일이 제대로 읽히는지 미리 본다. (파이썬 checktext.look) */
export async function lookFolder(folder: string): Promise<LookResult> {
  const out: LookResult = { folder, exists: false, videos: 0, bad: 0, items: [] };
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(folder)) {
      // 올리는 쪽(folders.ts)이 영상으로 보는 확장자와 똑같이 — 점검한 영상이 곧 올라갈 영상이다
      if (e.isFile && !e.name.startsWith(".") && VIDEO_EXT.has(extOf(e.name))) names.push(e.name);
    }
    out.exists = true;
  } catch {
    return out; // 폴더가 없거나 못 읽는다 — 부르는 쪽이 「폴더가 없습니다」로 말한다
  }
  names.sort();
  out.videos = names.length;

  for (const name of names) {
    const path = join(folder, name);
    const problems: string[] = [];
    let m = { title: "", desc: "", tags: [] as string[], source: null as string | null };
    try {
      m = await loadFor(path);
    } catch (e) {
      problems.push(`문안을 읽지 못했습니다 — ${errMsg(e).slice(0, 80)}`);
    }
    if (!problems.length) {
      if (!m.source) {
        problems.push("문안 파일 없음 — 제목이 파일 이름으로 나갑니다");
      } else {
        if (!m.title || m.title === stemOf(path)) problems.push("제목을 못 읽었습니다 — [제목] 항목을 확인하세요");
        if (!m.desc) problems.push("설명이 비었습니다");
        if (!m.tags.length) problems.push("태그가 없습니다 — #낱말 형태인지 확인하세요");
      }
      // 길이는 sidecar 가 자르는 단위(글자 수)로 본다 — 잘린 글이 한도와 같아진다
      if (m.title.length >= TITLE_MAX) problems.push(`제목이 ${TITLE_MAX}자에서 잘렸습니다`);
      if (m.desc.length >= DESC_MAX) problems.push(`설명이 ${DESC_MAX}자에서 잘렸습니다`);
    }
    if (problems.length) out.bad++;
    out.items.push({
      file: name,
      title: m.title,
      titleLen: chars(m.title),
      descFirst: m.desc ? (splitLines(m.desc)[0] ?? "").trim() : "",
      descLen: chars(m.desc),
      tags: m.tags,
      source: m.source ? baseName(m.source) : null,
      problems,
      ok: !problems.length,
    });
  }
  return out;
}

const 가로선 = "  " + "─".repeat(84);

/** 폴더 하나의 점검 결과를 터미널에 찍을 줄로. (파이썬 checktext.look 의 출력) */
export function formatLook(r: LookResult): string[] {
  if (!r.exists) return [`  폴더가 없습니다 — ${r.folder}`];
  if (!r.videos) return [`  영상이 없습니다 — ${r.folder}`];
  const L: string[] = ["", `  ${r.folder}   영상 ${r.videos}개`, 가로선];
  for (const it of r.items) {
    L.push(`  ${it.ok ? "✓" : "✕"} ${cut(it.file, 44)}`);
    L.push(`      제목  ${cut(it.title, 56) || "(없음)"}   [${it.titleLen}자]`);
    L.push(`      설명  ${cut(it.descFirst, 56) || "(없음)"}   [${it.descLen}자]`);
    L.push(`      태그  ${it.tags.slice(0, 6).join(", ") || "(없음)"}   [${it.tags.length}개]`);
    if (it.source) L.push(`      출처  ${it.source}`);
    for (const p of it.problems) L.push(`      ⚠ ${p}`);
    L.push("");
  }
  return L;
}

/** 여러 폴더를 본 뒤의 맺음말 줄들 */
export function formatLookSummary(rs: LookResult[]): string[] {
  const tot = rs.reduce((a, r) => a + r.videos, 0);
  const bad = rs.reduce((a, r) => a + r.bad, 0);
  const L = [가로선];
  if (!tot) L.push("  볼 영상이 없습니다.");
  else if (bad) {
    L.push(`  영상 ${tot}개 중 ${bad}개에 손볼 곳이 있습니다.`);
    L.push("  문안 파일은 영상과 같은 이름의 .txt 로, [제목] [설명] [해시태그] 항목을 둡니다.");
  } else L.push(`  영상 ${tot}개 모두 문안이 제대로 읽힙니다.`);
  L.push("");
  return L;
}

/* ============================================================ ② 규격 검사 */

// 한글 — 완성형·호환 자모에 더해 **풀어 쓴 자모**(맥 파일 이름 꼴 NFD · U+1100 대)·옛 자모 확장·반각 한글까지
// (파이썬 2026-10-04 검토: 풀어 쓴 「뮤직스타」 가 한글 0자로 지나갔다). 일본어 글자 대역과 겹치지 않는다.
// 범위를 \u 로 풀어 쓴 것은 눈에 안 보이는 자모가 섞여 있어 복사하다 깨지지 않게 하려는 것이다.
//   AC00-D7A3 완성형 · 3131-314E 3131-3163 호환 자모 · 1100-11FF 풀어 쓴 자모 · 3130-318F 호환 자모 영역
//   A960-A97F 옛 자모 확장-A · D7B0-D7FF 옛 자모 확장-B · FFA0-FFDC 반각 한글
const 한글 = /[\uAC00-\uD7A3\u3131-\u314E\u314F-\u3163\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF\uFFA0-\uFFDC]/g;

/** 한글이 몇 글자 들었나 */
export const countHangul = (s: string): number => (s.match(한글) ?? []).length;

// 구독(チャンネル登録·subscribe·구독) · 좋아요(高評価·グッドボタン·좋아요) · 알림(通知オン·ベルマーク…).
// 맨 「ベル」「いいね」「通知」는 안 넣는다 — 「レベル」(레벨)·작품명 『いいね！光源氏くん』 같은 정상 글이 걸린다
// (정리할 때는 걸린 줄을 통째로 지운다).
export const CTA = /チャンネル登録|高評価|グッドボタン|subscribe|구독|좋아요|通知をオン|通知オン|通知登録|通知ベル|ベルマーク|ベルボタン|알림/i;

// 해시태그만 있는 줄 — 낱말 안에서 다시 가르지 않아 되돌이(backtracking)가 없다.
// (옛 자 `\s*(#\S+\s*)+` 는 「#a」 24번 + 「 b」 한 줄에 9초가 걸렸다)
export const HASH_LINE = /^\s*#\S+(?:\s+#\S+)*\s*$/;

const 쇼츠 = /#shorts(?![\p{L}\p{N}_])/iu;

// sidecar 의 해시태그자(전역 깃발이 달려 있다)와 같은 모양의 「통째로 맞나」「앞에서부터 맞나」 짝
const 태그통째 = new RegExp("^" + 해시태그자.source + "$", "u");
const 태그앞 = new RegExp("^" + 해시태그자.source, "u");

/**
 * 「해시태그만 있는 줄을 뺀 글자 수」 — 줄을 떼고 \n 으로 이어 센다(앞뒤를 걷지 않는다). (파이썬 본문글자수)
 * 규칙의 desc_min·desc_max 는 이 자로 잰 값이어야 한다.
 */
export function bodyLength(desc: string): number {
  return chars(splitLines(desc).filter((l) => !HASH_LINE.test(l)).join("\n"));
}

/**
 * 비공개 태그를 유튜브 태그 칸 한도에 맞춘다 — 앞에서부터 담고 넘치면 멈춘다. (파이썬 fit_tags)
 * 셈: 낱말 + (띄어쓰기 있으면 따옴표 2) + (둘째부터 쉼표 1) ≤ limit. # 는 떼고, 겹친 것은 뺀다.
 * 한도 기본값은 유튜브의 500자에서 10자 여유를 둔 값이다.
 */
export function fitTags(tags: Iterable<unknown>, limit = TAG_MAX - 10): string[] {
  const out: string[] = [];
  let n = 0;
  for (const raw of tags) {
    const t = String(raw).trim().replace(/^#+/, "");
    if (!t || out.includes(t)) continue;
    const cost = chars(t) + (t.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (n + cost > limit) break;
    out.push(t);
    n += cost;
  }
  return out;
}

/** 해시태그 하나가 올라갈 때의 꼴(sidecar 가 끊는 그대로) — 통째로 빠지면 「(빠짐)」 */
function 올림꼴(h: string): string {
  return 태그앞.exec(h)?.[0] ?? "(빠짐)";
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 곁파일 글을 규격으로 잰다 — 흠 목록(비면 통과). 규격이 없으면 늘 빈 목록. (파이썬 글검사)
 *
 * tags — 일감에 실릴 비공개 태그(유튜브 태그 칸). 주면 한글 0자 검사에 함께 넣는다.
 * 해시태그는 **올라가는 꼴**로도 잰다 — 올릴 때 sidecar 가 해시태그자로 끊어 설명 맨 아래에 다시 붙이므로,
 * 기호가 든 태그(끊김)·겹친 태그·본문에 이미 있는 태그(맨 아래 줄에서 빠짐)는 「정확히 N개 · 맨 아래」가 깨진다.
 */
export function checkText(rule: MetaRule | null | undefined, text: string, tags?: string[]): string[] {
  if (!rule || !Object.keys(rule).length) return []; // 규칙 칸이 하나도 없으면 이 채널은 규격이 없는 것이다
  const { title: 제목, desc: 설명, tags: 해시태그 } = readSections(String(text ?? "").replace(/^\uFEFF/, ""));
  const 태그글 = 해시태그.join(" ");
  const 흠: string[] = [];
  if (!제목.trim()) 흠.push("제목 없음");

  if (rule.forbid_hangul) {
    const 값들: [string, string][] = [
      ["제목", 제목], ["설명", 설명], ["해시태그", 태그글], ["비공개 태그", (tags ?? []).map(String).join(" ")],
    ];
    for (const [이름, 값] of 값들) {
      const n = countHangul(값);
      if (n) 흠.push(`${이름}에 한글 ${n}자`);
    }
  }
  if (rule.forbid_cta) {
    const m = CTA.exec(제목) ?? CTA.exec(설명) ?? CTA.exec(태그글);
    if (m) 흠.push(`구독·좋아요·알림 유도 말 「${m[0]}」`);
  }
  if (rule.forbid_shorts_tag && (쇼츠.test(제목) || 쇼츠.test(설명) || 쇼츠.test(태그글))) {
    흠.push("#shorts 있음");
  }

  const 개수 = num(rule.hashtags);
  if (개수 !== null) {
    if (해시태그.length !== 개수) 흠.push(`해시태그 ${해시태그.length}개(정확히 ${개수}개)`);
    const 끊김 = 해시태그.filter((h) => !태그통째.test(h));
    if (끊김.length) {
      흠.push("해시태그가 올릴 때 끊긴다(기호가 들었다): " + 끊김.map((h) => `${h} → ${올림꼴(h)}`).join(" · "));
    }
    if (new Set(해시태그).size !== 해시태그.length) 흠.push("해시태그가 겹친다");
    const 본문해시 = splitLines(설명).filter((l) => !HASH_LINE.test(l)).flatMap((l) => l.match(해시태그자) ?? []);
    if (본문해시.length) {
      흠.push(`설명 본문에 해시태그가 있다(${본문해시.join(" ")}) — 맨 아래 줄에만 두세요(겹친 것은 올릴 때 맨 아래 줄에서 빠진다)`);
    }
  }

  // 본문 글자 수 — 올라가는 꼴(본문 + 빈 줄 + 해시태그 줄)에서 같은 자로 잰다.
  // 곁파일은 해시태그를 [해시태그] 칸에 따로 두고 올릴 때 설명 맨 아래에 다시 붙이므로, 규칙 값을 정한 쪽도 그 꼴로 쟀다.
  const 최소 = num(rule.desc_min), 최대 = num(rule.desc_max);
  if (최소 !== null || 최대 !== null) {
    const 본문 = splitLines(설명).filter((l) => !HASH_LINE.test(l)).join("\n").trim();
    const n = bodyLength(해시태그.length ? `${본문}\n\n${태그글}` : 본문);
    if ((최소 !== null && n < 최소) || (최대 !== null && n > 최대)) {
      const 범위 = 최소 !== null && 최대 !== null ? `${최소}~${최대} 밖` : 최소 !== null ? `${최소}자 이상이어야 함` : `${최대}자 이하여야 함`;
      흠.push(`설명 본문 ${n}자(${범위})`);
    }
  }
  return 흠;
}

/** 곁파일(.txt)을 읽어 잰다. 못 읽으면 그 사실이 흠이다. (파이썬 check) */
export async function checkFile(rule: MetaRule | null | undefined, txtPath: string, tags?: string[]): Promise<string[]> {
  if (!rule || !Object.keys(rule).length) return [];
  let 글: string;
  try {
    글 = await Deno.readTextFile(txtPath);
  } catch (e) {
    return [`곁파일을 못 읽음(${e instanceof Error ? e.name : "오류"})`];
  }
  return checkText(rule, 글, tags);
}

/**
 * 규격에 맞게 글을 정리한다. (파이썬: 받기의 _해외정리)
 *   · forbid_cta         구독·좋아요·알림 유도 줄을 통째로 지운다
 *   · hashtags           설명에서 해시태그만 있는 줄을 지우고(맨 아래에 태그 목록으로 다시 붙는다), 태그를 앞에서 N개로 맞춘다
 *   · forbid_shorts_tag  태그 목록에서 #shorts 를 뺀다 (뺀 뒤에 N개로 자른다 — 원본과 같은 차례)
 * 규격이 없으면 그대로 돌려준다. tags 는 # 가 붙었든 안 붙었든 받은 꼴 그대로 돌려준다.
 * ★제목과 본문 글은 고치지 않는다 — 본문 안의 #shorts 나 겹친 태그는 원본처럼 checkText 가 흠으로 잡아 사람이 고치게 한다.
 */
export function cleanForRule(
  rule: MetaRule | null | undefined, title: string, desc: string, tags: string[],
): { title: string; desc: string; tags: string[] } {
  if (!rule || !Object.keys(rule).length) return { title, desc, tags: [...tags] };
  let d = desc, g = [...tags];
  if (rule.forbid_cta) d = splitLines(d).filter((l) => !CTA.test(l)).join("\n");
  const 개수 = num(rule.hashtags);
  if (개수 !== null) d = splitLines(d).filter((l) => !HASH_LINE.test(l)).join("\n");
  d = d.trim();
  if (rule.forbid_shorts_tag) g = g.filter((x) => String(x).replace(/^#+/, "").toLowerCase() !== "shorts");
  if (개수 !== null) g = g.slice(0, Math.max(0, 개수));
  return { title, desc: d, tags: g };
}

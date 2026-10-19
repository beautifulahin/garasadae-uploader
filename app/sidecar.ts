// 영상 옆에 놓인 같은 이름의 텍스트 파일에서 제목·설명·해시태그를 읽는다. (파이썬 sidecar.py)
//
//     001_우산 셋_같은 방향.mp4
//     001_우산 셋_같은 방향.txt   ← 이걸 읽는다
//
// 파일 형식
//     [제목]
//     우산 세 개가 같은 방향으로 걸어간 이유
//
//     [설명]
//     여러 줄로 이어지는 설명…
//
//     [해시태그]
//     #우산 #비오는날 #shorts
//
// 없는 항목은 비워 둔다. txt 자체가 없으면 파일 이름을 제목으로 쓴다.
// 해시태그는 설명 끝에 붙이고, 태그 항목으로도 넣는다(유튜브는 둘을 따로 본다).
//
// 옛 앱(1.x)의 쪽지(`같은이름.json`)도 읽는다 — 받기(receive.ts)가 쪽지로 쓴다. 제목 우선순위는
// 「쪽지 > 영상 옆 txt > 파일 이름」이다.
import { baseName, dirName, exists, join, stemOf, withSuffix, writeTextAtomic } from "./paths.ts";

export const TITLE_MAX = 100; // 유튜브 제목 한도
export const DESC_MAX = 5000; // 설명 한도
export const TAG_MAX = 500; // 태그 전체 길이 한도(대략)

// 두 가지 형식을 다 받는다.
//   [제목]            대괄호로 감싼 것
//   제목              맨 앞 열에 낱말만 (어떤 제작기가 내는 형식)
// 뒤엣것은 들여쓴 줄이 내용이므로, 맨 앞 열에 붙어 있을 때만 구분자로 본다.
const 이름들 = "제목|설명|해시태그|태그|title|description|tags";
const SECTION = new RegExp(`^\\[(제목|설명|해시태그|title|description|tags)\\]\\s*$`, "i");
const BARE = new RegExp(`^(${이름들})\\s*(?:[(（].*)?$`, "i");
//   제목: 값          한 줄에 이름과 내용이 같이 있는 것
// 이 형식을 몰라서 글 전체가 「민글」로 처리됐고, 첫 줄(「제목: …」)이 이름표까지 통째로 유튜브에 올라갔다.
const INLINE = new RegExp(`^(${이름들})\\s*[:：]\\s*(.*)$`, "i");
//   ═══ 제목          장식 구분선 뒤에 이름 (또 다른 제작기의 납품 형식)
const DECO = new RegExp(`^[═=─—━-]{2,}\\s*(${이름들})(?![\\p{L}\\p{N}_]).*$`, "iu");
const KEY: Record<string, "title" | "desc" | "tags"> = {
  "제목": "title", "title": "title", "설명": "desc", "description": "desc",
  "해시태그": "tags", "태그": "tags", "tags": "tags",
};

/** 해시태그 한 낱말 — 올릴 때 이 자로 끊는다. 「・」「!」「『」 같은 기호에서 끊긴다. (파이썬 해시태그자) */
export const 해시태그자 = /#[\p{L}\p{N}_]+/gu;

/** 파이썬 str.splitlines() 와 같은 줄 가르기 */
export function splitLines(s: string): string[] {
  const out = s.split(new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]"));
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

export interface TextMeta { title: string; desc: string; tags: string[]; source: string | null }

const keyOf = (name: string) => KEY[name.toLowerCase()] ?? KEY[name];

/**
 * 제작 쪽 곁파일 글 → (제목, 설명, 해시태그 목록) — 받기(받을 때)와 문안 규격 검사가 같이 쓴다.
 * 칸 머리는 「[제목]」「■ 설명」「■ 태그 (5개)」처럼 20자가 안 되는 줄. 제목은 칸의 첫 줄, 설명은 칸 전체(앞뒤 공백 걷음),
 * 해시태그는 [해시태그] 칸의 #낱말. ■ 태그 칸(쉼표 낱말)은 칸으로만 끊고 쓰지 않는다.
 */
export function readSections(글: string): { title: string; desc: string; tags: string[] } {
  const 칸: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const l of splitLines(글)) {
    const m = /^\s*(?:■|\[)?\s*(제목|설명|해시태그|태그)/.exec(l);
    if (m && l.trim().length < 20) {
      cur = m[1];
      칸[cur] = [];
      continue;
    }
    if (cur) 칸[cur].push(l);
  }
  const 제목 = (splitLines((칸["제목"] ?? []).join("\n").trim())[0] ?? "");
  const 설명 = (칸["설명"] ?? []).join("\n").trim();
  const 태그 = ((칸["해시태그"] ?? []).join("\n").match(/#\S+/g) ?? []);
  return { title: 제목, desc: 설명, tags: 태그 };
}

/** 영상과 같은 이름의 txt. .txt 가 없으면 .md 도 본다. */
export async function findText(video: string): Promise<string | null> {
  for (const ext of [".txt", ".md"]) {
    const p = withSuffix(video, ext);
    try { if ((await Deno.stat(p)).isFile) return p; } catch { /* 다음 */ }
  }
  return null;
}

/** 제작기가 영상 옆에 둔 「정보.json」. 파일 이름 앞 번호로 짝을 찾는다 (001_제목.mp4 옆에 001_정보.json) */
export async function findInfoJson(video: string): Promise<string | null> {
  const num = stemOf(video).split("_")[0];
  if (!/^\d+$/.test(num)) return null;
  for (const name of [`${num}_정보.json`, `${num}_info.json`]) {
    const c = join(dirName(video), name);
    try { if ((await Deno.stat(c)).isFile) return c; } catch { /* 다음 */ }
  }
  return null;
}

/** 정보.json 에서 제목·설명·태그를 꺼낸다. 제목은 두 줄로 나뉘어 있을 수 있다. */
export async function parseInfoJson(path: string): Promise<TextMeta> {
  let d: Record<string, unknown>;
  try { d = JSON.parse(await Deno.readTextFile(path)); } catch { return { title: "", desc: "", tags: [], source: path }; }
  const t = (d["제목"] ?? d["title"] ?? "") as unknown;
  const title = Array.isArray(t) ? t.map((x) => String(x).trim()).filter(Boolean).join(" ") : String(t).trim();
  const bits: string[] = [];
  if (d["원본채널"]) bits.push(`원본 채널: ${d["원본채널"]}`);
  if (d["원본"]) bits.push(`원본 영상: ${d["원본"]}`);
  if (d["원본라이선스"]) bits.push(`라이선스: ${d["원본라이선스"]}`);
  if (d["주의"]) bits.push(`※ ${d["주의"]}`);
  let tags = (d["해시태그"] ?? d["tags"] ?? []) as unknown;
  if (typeof tags === "string") tags = [...tags.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
  const list = (Array.isArray(tags) ? tags : []).map((x) => String(x).replace(/^#+/, ""));
  return { title: title.slice(0, TITLE_MAX), desc: bits.join("\n").slice(0, DESC_MAX), tags: list, source: path };
}

/**
 * 줄 앞의 공통 들여쓰기를 걷어낸다. 문안 파일은 항목 아래를 들여써서 적는다. 그 들여쓰기는 파일을 읽기 좋게
 * 하려는 것이지 설명의 일부가 아니다. 걷어내지 않으면 화면에서 고쳐 저장할 때마다 2칸씩 불어난다
 * (실제로 671자가 709자가 됐다).
 */
function 벗기기(lines: string[]): string {
  const 있는줄 = lines.filter((x) => x.trim());
  if (!있는줄.length) return "";
  const 깊이 = Math.min(...있는줄.map((x) => x.length - x.trimStart().length));
  return lines.map((x) => (x.trim() ? x.slice(깊이) : "")).join("\n").trim();
}

/** 문안 글을 읽는다. (파이썬 sidecar.parse — 글 자체를 받는다) */
export function parseText(raw: string, source = ""): TextMeta {
  const buckets: Record<"title" | "desc" | "tags", string[]> = { title: [], desc: [], tags: [] };
  let cur: "title" | "desc" | "tags" | null = null;
  let 잡힘 = false;
  for (const line of splitLines(raw)) {
    const 벗 = line.trim();
    const m2 = INLINE.exec(벗);
    if (m2) {
      cur = keyOf(m2[1]) ?? null;
      잡힘 = true;
      const 값 = m2[2].trim();
      if (cur && 값) buckets[cur].push(값); // 같은 줄에 붙은 내용도 담는다
      continue;
    }
    const m = SECTION.exec(벗) ?? DECO.exec(벗) ?? BARE.exec(벗);
    if (m) {
      cur = keyOf(m[1]) ?? null;
      잡힘 = true;
      continue;
    }
    if (cur) buckets[cur].push(line);
  }

  // 항목 이름이 하나도 없는 글은 「민글」로 본다 — 첫 줄이 제목, 나머지가 설명. 롱폼 문안이 대개 이렇게 생겼다.
  // 예전에는 이런 파일을 통째로 못 읽고 파일 이름을 제목으로 올렸다. 빈 제목·빈 설명으로 나가는 것보다 이 짐작이 낫다.
  if (!잡힘) {
    const 줄 = splitLines(raw);
    const 있는 = 줄.map((x, i) => (x.trim() ? i : -1)).filter((i) => i >= 0);
    if (있는.length) {
      const 머리 = 있는[0];
      buckets.title = [줄[머리]];
      buckets.desc = 줄.slice(머리 + 1);
      // 본문에 흩어진 해시태그는 태그로도 쓴다
      buckets.tags = 줄.slice(머리 + 1).filter((x) => x.includes("#"));
    }
  }

  // 제목 칸에는 완성된 제목과 함께 조립 과정(1행/2행/✓ 확인)이 같이 적혀 있다. 첫 줄이 완성본이므로 그것만 쓴다.
  const tlines = buckets.title.map((x) => x.trim()).filter((x) => x)
    .filter((x) => !/^(\d+행|✓|✕|※)/.test(x) && !/^[═=─—━-]{2,}/.test(x)); // 장식 구분선은 제목이 아니다
  let title = (tlines[0] ?? "").slice(0, TITLE_MAX);
  // 어떤 제작기는 제목 뒤에 글자 수를 적는다 — "…벌어진 일  (16자)". 그 꼬리는 검수용 표기지 제목이 아니다.
  title = title.replace(/\s*[(（]\d+자[)）]\s*$/, "");
  let desc = 벗기기(buckets.desc);
  const tagLine = buckets.tags.join(" ");
  const tags = (tagLine.match(해시태그자) ?? []).map((t) => t.replace(/^#+/, ""));

  // 해시태그는 설명 끝에도 붙여야 화면에 노출된다. 다만 글쓴이가 설명 안에 이미 몇 개를 적어 두는 일이 흔하다.
  // 예전에는 「통째로 같은 줄」일 때만 걸러서 일부만 겹치면 열세 개가 통째로 또 붙었다. 낱개로 비교한다.
  const 이미 = new Set((desc.match(해시태그자) ?? []).map((x) => x.replace(/^#+/, "")));
  const 더할것 = tags.filter((t) => !이미.has(t));
  if (더할것.length) desc = (desc + "\n\n" + 더할것.map((t) => "#" + t).join(" ")).trim();

  // 태그 전체 길이 한도를 넘으면 뒤에서부터 덜어낸다
  while (tags.length && tags.reduce((a, t) => a + t.length + 1, 0) > TAG_MAX) tags.pop();

  return { title, desc: desc.slice(0, DESC_MAX), tags, source: source || null };
}

export async function parseFile(path: string): Promise<TextMeta> {
  const raw = new TextDecoder("utf-8").decode(await Deno.readFile(path)).replace(/^﻿/, "");
  return parseText(raw, path);
}

/** 문안이 어디서 왔나: txt = 영상 옆 글(사람이 쓰거나 화면에서 고친 것) · note = 쪽지(.json) · info = 제작기의 정보.json · none = 아무것도 없음 */
export type SideKind = "txt" | "note" | "info" | "none";

/** 칸마다 「실제로 사람(또는 쪽지)이 정한 것」인지 함께 돌려주는 읽기. 파일 이름으로 메운 제목은 given 이 아니다. */
export interface DetailedMeta extends TextMeta {
  kind: SideKind;
  titleGiven: boolean;
  descGiven: boolean;
  tagsGiven: boolean;
}

/**
 * 영상 하나의 문안을 칸마다 어디서 왔는지와 함께 읽는다. txt 가 없으면 쪽지(json) → 정보.json → 아무것도 없음 순서.
 * AI 자동 문안은 「사람·쪽지가 정하지 않은 칸」(given 이 false 인 칸)만 채운다 — 사람이 화면에서 고친 것 > 쪽지 > 자동 생성.
 */
export async function loadForDetailed(video: string): Promise<DetailedMeta> {
  const none = (title = ""): DetailedMeta => ({ title, desc: "", tags: [], source: null, kind: "none", titleGiven: false, descGiven: false, tagsGiven: false });
  const t = await findText(video);
  if (t === null) {
    // 쪽지(영상 옆 같은 이름 .json) — 옛 앱·다른 제작기가 두는 꼴. txt 가 없을 때만 읽는다(txt 는 받을 때 쪽지를 합쳐 쓴 것이라 더 나중 것이다).
    const note = await readNote(notePath(video));
    if (note && (note.title || note.description)) {
      return {
        title: (note.title ?? "").slice(0, TITLE_MAX), desc: note.description ?? "", tags: note.tags ?? [], source: notePath(video),
        kind: "note", titleGiven: !!note.title, descGiven: !!note.description, tagsGiven: !!(note.tags && note.tags.length),
      };
    }
    const j = await findInfoJson(video);
    if (j !== null) {
      const got = await parseInfoJson(j);
      return { ...got, kind: "info", titleGiven: !!got.title, descGiven: !!got.desc, tagsGiven: got.tags.length > 0 };
    }
    return none();
  }
  const got = await parseFile(t);
  return { ...got, kind: "txt", titleGiven: !!got.title, descGiven: !!got.desc, tagsGiven: got.tags.length > 0 };
}

/** 영상 하나에 붙일 메타데이터. 문안이 하나도 없으면 파일 이름을 제목으로. */
export async function loadFor(video: string): Promise<TextMeta> {
  const d = await loadForDetailed(video);
  const title = d.title || stemOf(video).slice(0, TITLE_MAX);
  return { title, desc: d.desc, tags: d.tags, source: d.source };
}

/** 올리기 전에 메타데이터가 온전한지 본다. (ok, 문제 목록) */
export async function checkMeta(video: string): Promise<{ ok: boolean; bad: string[] }> {
  const m = await loadFor(video);
  const bad: string[] = [];
  if (m.source === null) bad.push("설명 파일(.txt)이 없습니다 — 파일 이름을 제목으로 씁니다");
  else if (!m.desc) bad.push("설명이 비어 있습니다");
  if (m.title.length >= TITLE_MAX) bad.push(`제목이 ${TITLE_MAX}자에서 잘렸습니다`);
  // 라벨이 제목 행세를 하면 사고다 — "═══ 제목" 이 그대로 올라간 일이 있다.
  if (/[═━]/.test(m.title) || ["제목", "설명", "해시태그", "title", "description"].includes(m.title.trim())) {
    bad.push(`제목이 이상합니다(라벨/구분선?): ${m.title.slice(0, 30)}`);
  }
  return { ok: !bad.length, bad };
}

/**
 * 화면에서 고친 문안을 영상 옆 .txt 로 적는다.
 * 화면에만 담아 두면 앱을 닫는 순간 사라지고 다음에 열면 옛 제목이 다시 뜬다. 파일이 진실이어야 한다.
 * 이미 있던 파일은 `.txt.처음것` 으로 **한 번만** 남긴다 — 고칠 때마다 덮으면 두 번 고쳤을 때 원본이 사라진다.
 */
export async function saveFor(video: string, title: string, desc: string, tags: string | string[]): Promise<string> {
  const out = withSuffix(video, ".txt");
  let 태그: string[];
  if (typeof tags === "string") 태그 = tags.split(/[,\s]+/).map((t) => t.trim().replace(/^#+/, "")).filter(Boolean);
  else 태그 = (tags ?? []).map((t) => String(t).replace(/^#+/, "")).filter(Boolean);
  const 몸: string[] = title.trim() ? ["제목", `  ${title.trim().slice(0, TITLE_MAX)}`, ""] : [];   // 제목을 안 쓰는 저장(설명·태그만 고친 때)은 제목 칸을 만들지 않는다
  if (desc.trim()) {
    몸.push("설명", "");
    for (const ln of splitLines(desc.trim())) 몸.push(ln.trim() ? `  ${ln}` : "");
    몸.push("");
  }
  if (태그.length) 몸.push("태그", "  " + 태그.map((t) => "#" + t).join(" "), "");
  if (await exists(out)) {
    const 백 = out + ".처음것";
    if (!(await exists(백))) {
      try { await Deno.copyFile(out, 백); } catch { /* 백업은 덤이다 */ }
    }
  }
  await writeTextAtomic(out, 몸.join("\n"));
  return out;
}

/* ============================================================ 쪽지(옛 앱의 json 사이드카) */

export interface Note {
  title?: string;
  description?: string;
  /** 비공개 태그(유튜브 태그 칸) */
  tags?: string[];
  publishAt?: string;
  thumbnail?: string;
  categoryId?: string;
  language?: string;
  /** 이 영상만 인스타그램·스레드에 올릴지 — true/false. 안 적으면 채널 설정을 따른다(채널에 계정이 걸린 곳만 올린다). */
  instagram?: boolean;
  threads?: boolean;
}

/** 쪽지 json 을 읽는다. 모르는 칸은 버린다 — 남이 만든 json 이 들어와도 업로드가 깨지지 않아야 한다. */
export async function readNote(path: string): Promise<Note | null> {
  let d: Record<string, unknown>;
  try { d = JSON.parse((await Deno.readTextFile(path)).replace(/^﻿/, "")); } catch { return null; }
  if (!d || typeof d !== "object") return null;
  const 글 = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const n: Note = {};
  n.title = 글(d.title, TITLE_MAX);
  n.description = 글(d.description, DESC_MAX);
  const v = d.tags;
  if (typeof v === "string") n.tags = v.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
  else if (Array.isArray(v)) n.tags = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().replace(/^#/, "")).slice(0, 30);
  n.publishAt = 글(d.publishAt, 40);
  n.thumbnail = 글(d.thumbnail, 1024);
  if (typeof d.categoryId === "string" || typeof d.categoryId === "number") n.categoryId = String(d.categoryId);
  n.language = 글(d.language, 10);
  // 켜고 끄는 칸 — true/false 만 받는다(글자 "true"/"false"·"on"/"off" 도 받는다). 그 밖의 값은 안 적은 것으로 본다.
  const 참거짓 = (v: unknown): boolean | undefined => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") { const t = v.trim().toLowerCase(); if (["true", "on", "yes"].includes(t)) return true; if (["false", "off", "no"].includes(t)) return false; }
    return undefined;
  };
  n.instagram = 참거짓(d.instagram);
  n.threads = 참거짓(d.threads);
  return Object.values(n).some((x) => x !== undefined) ? n : null;
}

/** 영상 옆 쪽지 자리 — `001_제목.mp4` → `001_제목.json` */
export const notePath = (video: string) => withSuffix(video, ".json");

export { baseName };

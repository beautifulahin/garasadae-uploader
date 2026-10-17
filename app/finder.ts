// 열쇠 찾기 — 이 컴퓨터에 이미 있는 AI(구글 AI 스튜디오·Gemini)·쿠팡 파트너스 열쇠를 알려진 자리에서 **찾아서 미리 채워** 준다.
//
// 사장님 지시(2026-10): 「그 열쇠도 각 사람마다 저장소가 다를텐데 찾아서 넣도록해」.
// 사람마다 열쇠를 둔 자리가 다르다 — 환경변수에 둔 사람, 쉘 설정 파일에 export 해 둔 사람, 다른 도구(Gemini CLI·볼케이노 설치기)가 만든 파일을
// 쓰는 사람. 입력 창을 띄우기 전에 그 알려진 자리들을 훑어 찾은 것을 가려서 보여 주고, **시험을 통과한 것만 사람이 「이걸로 쓰기」 를 눌러야** 저장한다.
//
// 약속 (어기면 안 되는 것)
//   · **읽기만 한다.** 찾은 파일을 고치거나 옮기거나 지우거나 어디로 보내지 않는다. 연결 시험 때만 구글·쿠팡의 **공식 주소**로 간다.
//   · **값은 화면·로그·응답에 전체로 나오지 않는다.** 화면에는 가린 모습(「AIza…ABCD」)과 찾은 자리(「~/.zshrc」· 집 폴더 경로를 풀어 쓰지 않는다)만 간다.
//     전체 값은 이 모듈의 메모리에만 15분 있다가 사라진다. 화면은 값이 아니라 id 로 「이걸로 쓰기」 를 시킨다.
//   · **바로 저장하지 않는다.** 시험을 통과한 것만 saveAiSettings / connect 로 저장하고, 그것도 사람이 누른 뒤에만 한다.
//   · **창을 열 때만 찾는다** — 서버가 켜질 때나 뒤에서 몰래 훑지 않는다(화면이 scan 을 부른다).
//   · 찾는 자리는 아래 PLACES 한 곳에 모았다. 새 자리는 여기에 한 줄 더하면 된다.
import { dataDir, env, homeDir, join, log } from "./paths.ts";
import * as AI from "./ai.ts";

type Obj = Record<string, any>;

/* ============================================================ 찾는 자리 (한 곳) */

/** 환경변수 이름들 */
export const AI_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_AI_STUDIO_API_KEY", "GENAI_API_KEY"];
export const COUPANG_ACCESS_ENV = ["COUPANG_ACCESS_KEY", "COUPANG_PARTNERS_ACCESS_KEY", "COUPANG_API_ACCESS_KEY", "COUPANG_ACCESS"];
export const COUPANG_SECRET_ENV = ["COUPANG_SECRET_KEY", "COUPANG_PARTNERS_SECRET_KEY", "COUPANG_API_SECRET_KEY", "COUPANG_SECRET"];

/** 집 폴더 아래의 파일들 — 맥·리눅스·윈도우 모두 (없는 것은 건너뛴다) */
export const SHELL_FILES = [
  ".env", ".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".bashrc", ".profile", ".config/fish/config.fish",
  "Documents/PowerShell/Microsoft.PowerShell_profile.ps1", "Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1",
];
/** AI 열쇠가 들어 있을 수 있는 도구별 파일: 볼케이노 설치기 · Gemini CLI */
export const AI_FILES = [".volcano/keys/gemini", ".volcano/keys/gemini.pool.json", ".gemini/.env", ".gemini/settings.json"];
/** 쿠팡 열쇠 파일: 「ACCESS:SECRET」 한 줄 */
export const COUPANG_FILES = [".volcano/keys/coupang_partners"];

/** 한 파일에서 읽는 최대 크기 — 쉘 설정 파일이 아무리 커도 앞쪽만 본다 */
const 최대읽기 = 512 * 1024;
/** 구글 API 열쇠 꼴: AIza + 35자 (39자) 근처만 인정 */
const AI꼴 = /AIza[0-9A-Za-z_\-]{30,50}/g;

/* ============================================================ 시험용 주입 */

let 환경읽기: ((k: string) => string | undefined) | null = null;
/** 시험: 환경변수를 가짜로 — 진짜 환경의 열쇠를 건드리지 않게. null 이면 진짜. */
export function setFinderEnv(get: ((k: string) => string | undefined) | null) { 환경읽기 = get; }
const 환경 = (k: string): string => { try { return (환경읽기 ? 환경읽기(k) : Deno.env.get(k)) ?? ""; } catch { return ""; } };

/* ============================================================ 읽기 도우미 */

/** 파일 앞쪽만 읽는다. 없거나 못 읽으면 null. 읽기 전용 — 절대 쓰지 않는다. */
async function 읽기(path: string): Promise<string | null> {
  try {
    const f = await Deno.open(path, { read: true });
    try {
      const buf = new Uint8Array(최대읽기);
      let n = 0;
      while (n < buf.length) { const r = await f.read(buf.subarray(n)); if (r === null) break; n += r; }
      return new TextDecoder().decode(buf.subarray(0, n));
    } finally { f.close(); }
  } catch { return null; }
}

/** 화면에 보일 자리 이름 — 집 폴더는 「~」 로 줄인다(사용자 이름을 화면에 안 싣는다) */
const 자리이름 = (rel: string) => "~/" + rel.replace(/\\/g, "/");

/** 열쇠를 가린다 — 앞 4자 … 끝 4자 */
export function mask(v: string): string {
  const s = String(v);
  if (s.length <= 10) return s.slice(0, 1) + "…" + s.slice(-2);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 줄 하나에서 「이름 = 값」 꼴을 읽는다 — export · set -gx · $env: · setx · 그냥 이름=값, 따옴표 있든 없든 */
function 이름값(줄: string): { name: string; value: string } | null {
  const l = 줄.replace(/\r$/, "").trim();
  if (!l || l.startsWith("#") || l.startsWith("//")) return null;
  const m = /^(?:export\s+|set\s+-[A-Za-z]+\s+|\$env:|setx\s+|\$Env:)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\s)\s*(.+)$/.exec(l);
  if (!m) return null;
  let v = m[2].trim();
  const q = /^(["'])(.*?)\1/.exec(v);
  if (q) v = q[2];
  else v = v.split(/[\s#;]/)[0];
  return { name: m[1], value: v.trim() };
}

/** 글(쉘 설정·.env)에서 AI 열쇠 후보: 이름에 KEY·TOKEN 이 있고 값이 AIza 꼴 */
function aiFromLines(text: string): { value: string; name: string }[] {
  const out: { value: string; name: string }[] = [];
  for (const line of text.split("\n")) {
    const kv = 이름값(line);
    if (!kv || !/(KEY|TOKEN)/i.test(kv.name)) continue;
    const m = new RegExp("^" + AI꼴.source + "$").exec(kv.value);
    if (m) out.push({ value: kv.value, name: kv.name });
  }
  return out;
}

/** 글 어디에든 있는 AIza 꼴 (JSON·열쇠 파일·풀 파일) */
function aiAnywhere(text: string): string[] {
  return [...new Set(text.match(AI꼴) ?? [])];
}

/** 쿠팡: 「ACCESS:SECRET」 */
function coupangPair(text: string): { access: string; secret: string } | null {
  const line = text.split("\n").map((x) => x.trim()).find((x) => x && !x.startsWith("#") && x.includes(":"));
  if (!line) return null;
  const i = line.indexOf(":");
  const access = line.slice(0, i).trim().replace(/^["']|["']$/g, ""), secret = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  return access.length >= 8 && secret.length >= 16 && !/\s/.test(access + secret) ? { access, secret } : null;
}

/** 글(쉘 설정·.env)에서 쿠팡 쌍: 접근키 이름과 비밀키 이름이 둘 다 있을 때 */
function coupangFromLines(text: string): { access: string; secret: string } | null {
  let access = "", secret = "";
  for (const line of text.split("\n")) {
    const kv = 이름값(line);
    if (!kv || !kv.value) continue;
    if (COUPANG_ACCESS_ENV.includes(kv.name) || /^COUPANG.*ACCESS/i.test(kv.name)) access = kv.value;
    else if (COUPANG_SECRET_ENV.includes(kv.name) || /^COUPANG.*SECRET/i.test(kv.name)) secret = kv.value;
  }
  return access && secret ? { access, secret } : null;
}

/* ============================================================ 찾아 둔 것 (메모리에만 15분) */

interface Held { kind: "ai" | "coupang"; value: string; secret?: string; where: string[]; at: number; test: { ok: boolean; message: string } | null }
const 찾은것 = new Map<string, Held>();
const 유지ms = 15 * 60_000;

function 치우기() {
  const now = Date.now();
  for (const [k, v] of 찾은것) if (now - v.at > 유지ms) 찾은것.delete(k);
}

const 새id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export interface FoundView {
  id: string;
  /** 가린 모습 — 값 전체가 아니다 */
  masked: string;
  /** 찾은 자리들(집 폴더는 ~ 로) */
  where: string[];
  /** 연결 시험 결과(시험을 안 했으면 null) */
  test: { ok: boolean; message: string } | null;
}
export interface ScanResult { ai: FoundView[]; coupang: FoundView[]; tookMs: number }

/* ============================================================ 찾기 */

interface Cand { value: string; secret?: string; where: string }

/** AI 열쇠 후보들을 모든 자리에서 모은다(읽기만) */
export async function collectAi(): Promise<Cand[]> {
  const out: Cand[] = [];
  for (const name of AI_ENV) { const v = 환경(name).trim(); if (new RegExp("^" + AI꼴.source + "$").test(v)) out.push({ value: v, where: `환경변수 ${name}` }); }
  const home = homeDir();
  for (const rel of AI_FILES) {
    const t = await 읽기(join(home, ...rel.split("/")));
    if (t === null) continue;
    // 열쇠 파일·풀(JSON)·.env·설정 JSON: 어디에 있든 AIza 꼴이면 후보 — 이 파일들은 그 도구의 열쇠 자리다
    for (const v of aiAnywhere(t)) out.push({ value: v, where: 자리이름(rel) });
  }
  for (const rel of SHELL_FILES) {
    const t = await 읽기(join(home, ...rel.split("/")));
    if (t === null) continue;
    for (const f of aiFromLines(t)) out.push({ value: f.value, where: `${자리이름(rel)} (${f.name})` });
  }
  // 옛 판(v1.x) 설정에 넣어 두었던 열쇠 — 이행 전이거나 이행에서 못 옮긴 경우의 마지막 자리. 읽기만 한다.
  const 옛설정 = await 읽기(join(env("GARASADAE_OLD_DATA_DIR") || dataDir(), "config.json"));
  if (옛설정) {
    try {
      const j = JSON.parse(옛설정.replace(/^\uFEFF/, ""));
      const v = typeof j?.aiKey === "string" ? j.aiKey.trim() : "";
      if (new RegExp("^" + AI꼴.source + "$").test(v)) out.push({ value: v, where: "옛 판 설정(config.json)의 aiKey" });
    } catch { /* 깨진 설정은 건너뛴다 */ }
  }
  return out;
}

/** 쿠팡 열쇠 후보들 */
export async function collectCoupang(): Promise<Cand[]> {
  const out: Cand[] = [];
  const a = COUPANG_ACCESS_ENV.map(환경).find((v) => v.trim()), s = COUPANG_SECRET_ENV.map(환경).find((v) => v.trim());
  if (a && s) out.push({ value: a.trim(), secret: s.trim(), where: "환경변수 COUPANG_ACCESS_KEY·COUPANG_SECRET_KEY" });
  const home = homeDir();
  for (const rel of COUPANG_FILES) {
    const t = await 읽기(join(home, ...rel.split("/")));
    const p = t ? coupangPair(t) : null;
    if (p) out.push({ value: p.access, secret: p.secret, where: 자리이름(rel) });
  }
  for (const rel of SHELL_FILES) {
    const t = await 읽기(join(home, ...rel.split("/")));
    const p = t ? coupangFromLines(t) : null;
    if (p) out.push({ value: p.access, secret: p.secret, where: 자리이름(rel) });
  }
  return out;
}

/** 같은 값은 한 줄로 합치고(자리는 모은다), id 를 붙여 메모리에 둔다 */
function 합치기(kind: "ai" | "coupang", cands: Cand[]): Held[] {
  const by = new Map<string, Held>();
  for (const c of cands) {
    const k = c.value + "\u0000" + (c.secret ?? "");
    const h = by.get(k);
    if (h) { if (!h.where.includes(c.where)) h.where.push(c.where); }
    else by.set(k, { kind, value: c.value, secret: c.secret, where: [c.where], at: Date.now(), test: null });
  }
  return [...by.values()];
}

/** 시간 제한 — 시험이 오래 걸려 창이 멈춰 보이지 않게 */
const 시한 = <T>(p: Promise<T>, ms: number, 기본: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(기본), ms))]);

type CoupangMod = typeof import("./coupang.ts");

/**
 * 이 컴퓨터의 알려진 자리에서 열쇠를 찾는다. test 가 true(기본)면 찾은 것마다 공식 주소로 연결 시험을 한다(AI 최대 4개 · 쿠팡 최대 2쌍, 각 15초).
 * 시험을 통과한 것이 앞에 오고, 화면은 맨 앞의 통과한 것을 기본으로 고른다. 값은 응답에 없다(가린 모습과 id 뿐).
 */
export async function scan(o: { kind?: "ai" | "coupang" | "all"; test?: boolean; coupang?: CoupangMod | null } = {}): Promise<ScanResult> {
  const t0 = Date.now();
  치우기();
  const kind = o.kind ?? "all", doTest = o.test !== false;
  const res: ScanResult = { ai: [], coupang: [], tookMs: 0 };

  if (kind === "all" || kind === "ai") {
    const found = 합치기("ai", await collectAi());
    const 시험 = found.slice(0, 4);
    if (doTest) await Promise.all(시험.map(async (h) => { h.test = await 시한(AI.testKey(h.value).then((r) => ({ ok: r.ok, message: r.message })), 15_000, { ok: false, message: "시간이 오래 걸려 시험하지 못했습니다" }); }));
    found.sort((a, b) => Number(!!b.test?.ok) - Number(!!a.test?.ok));
    for (const h of found) { const id = 새id(); 찾은것.set(id, h); res.ai.push({ id, masked: mask(h.value), where: h.where, test: h.test }); }
  }
  if (kind === "all" || kind === "coupang") {
    const m = o.coupang === undefined ? await import("./coupang.ts").catch(() => null) : o.coupang;
    const found = 합치기("coupang", await collectCoupang());
    if (m && doTest) {
      for (const h of found.slice(0, 2)) { // 쿠팡은 검색 호출 한도(시간당 10회)가 있어 차례로·적게
        h.test = await 시한(m.probeKeys(h.value, h.secret ?? "").then((r) => ({ ok: r.ok, message: r.message })), 15_000, { ok: false, message: "시간이 오래 걸려 시험하지 못했습니다" });
      }
    }
    found.sort((a, b) => Number(!!b.test?.ok) - Number(!!a.test?.ok));
    for (const h of found) { const id = 새id(); 찾은것.set(id, h); res.coupang.push({ id, masked: `${mask(h.value)} · 비밀키 있음`, where: h.where, test: h.test }); }
  }
  res.tookMs = Date.now() - t0;
  // 어디서 몇 개를 찾았는지만 남긴다 — 값은 한 글자도 남기지 않는다
  await log(`🔎 열쇠 찾기: AI ${res.ai.length}개(통과 ${res.ai.filter((x) => x.test?.ok).length}) · 쿠팡 ${res.coupang.length}개(통과 ${res.coupang.filter((x) => x.test?.ok).length})`);
  return res;
}

/**
 * 찾아 둔 열쇠 하나를 「이걸로 쓰기」 — 사람이 누른 뒤에만 부른다. 저장 직전에 한 번 더 시험한다.
 * AI 는 연결 시험 후 저장하고 자동 문안을 켠다. 쿠팡은 connect(시험 후 저장 + 전체 자동 링크 켜기).
 */
export async function useFound(kind: "ai" | "coupang", id: string, o: { coupang?: CoupangMod | null } = {}): Promise<{ ok: boolean; message: string }> {
  치우기();
  const h = 찾은것.get(id);
  if (!h || h.kind !== kind) return { ok: false, message: "찾아 둔 열쇠가 없어졌습니다(15분이 지났거나 다시 찾았습니다). 「다시 찾기」를 눌러 주세요." };
  if (kind === "ai") {
    const r = await AI.connectKey(h.value);
    if (r.ok) 찾은것.delete(id);
    return r;
  }
  const m = o.coupang === undefined ? await import("./coupang.ts").catch(() => null) : o.coupang;
  if (!m) return { ok: false, message: "쿠팡 파트너스 기능을 불러오지 못했습니다" };
  const r = await m.connect(h.value, h.secret ?? "");
  if (r.ok) 찾은것.delete(id);
  return { ok: r.ok, message: r.message };
}

/** 시험: 찾아 둔 것을 비운다 */
export function forgetFound() { 찾은것.clear(); }


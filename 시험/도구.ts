// 시험 도구 — 한 줄 검사기, 모래상자(임시 데이터 폴더), 영상 만들기.
//
// 원칙
//   · 진짜 데이터 폴더·집 폴더·구글에 손대지 않는다: 시험마다 임시 폴더를 만들어
//     GARASADAE_DATA_DIR / GARASADAE_HOME 을 그리로 돌리고, GARASADAE_OFFLINE=1 로 네트워크를 막는다.
//   · 구글 호출은 가짜 서버(가짜구글.ts)가 받는다. 실제 업로드·공개·인증 요청은 한 건도 안 나간다.
import { setFetch, doFetch } from "../app/google.ts";
import { setQuiet } from "../app/paths.ts";
import { resetCache } from "../app/shorts.ts";
import { resetToolCache } from "../app/tools.ts";
import { forgetAccessTokens } from "../app/ytcore.ts";
import { setEmbeddedForTest, setEmbeddedMetaForTest } from "../app/embedded.ts";

export const 결과 = { 실패: 0, 통과: 0 };

export function 구역(제목: string) {
  console.log(`── ${제목} ──`);
}

export function 같나(무엇: string, 실제: unknown, 바람: unknown) {
  const a = JSON.stringify(실제), b = JSON.stringify(바람);
  if (a === b) { console.log(`  ✅ ${무엇}`); 결과.통과++; }
  else { console.log(`  ❌ ${무엇}\n     나온 것: ${a}\n     바란 것: ${b}`); 결과.실패++; }
}

export function 참인가(무엇: string, 값: unknown) {
  같나(무엇, !!값, true);
}

export async function 던지나(무엇: string, 함수: () => unknown | Promise<unknown>, 글귀?: RegExp) {
  try {
    await 함수();
    console.log(`  ❌ ${무엇} — 던져야 하는데 안 던졌다`); 결과.실패++;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (글귀 && !글귀.test(m)) { console.log(`  ❌ ${무엇} — 다른 오류: ${m}`); 결과.실패++; }
    else { console.log(`  ✅ ${무엇}`); 결과.통과++; }
  }
}

/** 임시 폴더를 만들고 환경을 그리로 돌려 일을 시킨 뒤 원래대로 되돌린다. */
export async function 모래상자<T>(일: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "garasadae_시험_" });
  const 앞 = {
    data: Deno.env.get("GARASADAE_DATA_DIR"), home: Deno.env.get("GARASADAE_HOME"),
    off: Deno.env.get("GARASADAE_OFFLINE"),
  };
  Deno.env.set("GARASADAE_DATA_DIR", `${dir}/데이터`);
  Deno.env.set("GARASADAE_HOME", `${dir}/집`);
  Deno.env.set("GARASADAE_OFFLINE", "1");
  await Deno.mkdir(`${dir}/데이터/기록`, { recursive: true });
  await Deno.mkdir(`${dir}/집`, { recursive: true });
  setQuiet(true);
  resetCache(); resetToolCache(); forgetAccessTokens(); setFetch(null);
  // 시험은 실제 내장 열쇠를 읽지 않는다 — 기본은 「없음」, 필요한 시험이 가짜 열쇠를 끼운다.
  setEmbeddedForTest("browser", null); setEmbeddedForTest("device", null); setEmbeddedMetaForTest(null);
  try {
    return await 일(dir);
  } finally {
    setFetch(null);
    setEmbeddedForTest("browser", undefined); setEmbeddedForTest("device", undefined); setEmbeddedMetaForTest(undefined);
    for (const [k, v] of [["GARASADAE_DATA_DIR", 앞.data], ["GARASADAE_HOME", 앞.home], ["GARASADAE_OFFLINE", 앞.off]] as const) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
    setQuiet(false);
    try { await Deno.remove(dir, { recursive: true }); } catch { /* 무시 */ }
  }
}

/* ───────────── 영상 파일 만들기 (손으로 짠 최소 MP4) ───────────── */

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const box = (type: string, ...body: Uint8Array[]) => { const b = cat(...body); return cat(u32(8 + b.length), new TextEncoder().encode(type), b); };
const zeros = (n: number) => new Uint8Array(n);

export interface Fx { w: number; h: number; sec: number; rotate?: number; sarH?: number; sarV?: number; extraBytes?: number }

/** 길이·크기·회전을 가진 최소 MP4 (ftyp + moov + mdat). 재생은 안 되지만 상자 구조는 진짜와 같다. */
export function 가짜MP4(o: Fx): Uint8Array {
  const ts = 1000;
  const mvhd = box("mvhd", cat(u32(0), u32(0), u32(0), u32(ts), u32(Math.round(o.sec * ts)), zeros(80)));
  const rad = ((o.rotate ?? 0) * Math.PI) / 180;
  const fx = (v: number) => u32(Math.round(v * 65536) >>> 0);
  const matrix = cat(fx(Math.cos(rad)), fx(Math.sin(rad)), u32(0), fx(-Math.sin(rad)), fx(Math.cos(rad)), u32(0), u32(0), u32(0), u32(0x40000000));
  const tkhd = box("tkhd", cat(u32(3), u32(0), u32(0), u32(1), u32(0), u32(Math.round(o.sec * ts)), zeros(8),
    zeros(2), zeros(2), zeros(2), zeros(2), matrix, u32(o.w * 65536), u32(o.h * 65536)));
  const mdhd = box("mdhd", cat(u32(0), u32(0), u32(0), u32(ts), u32(Math.round(o.sec * ts)), zeros(4)));
  const hdlr = box("hdlr", cat(u32(0), u32(0), new TextEncoder().encode("vide"), zeros(12), zeros(1)));
  const pasp = o.sarH ? box("pasp", u32(o.sarH), u32(o.sarV ?? 1)) : new Uint8Array(0);
  const entry = box("avc1", cat(zeros(6), new Uint8Array([0, 1]), zeros(16), new Uint8Array([(o.w >> 8) & 255, o.w & 255, (o.h >> 8) & 255, o.h & 255]),
    u32(0x00480000), u32(0x00480000), u32(0), new Uint8Array([0, 1]), zeros(32), new Uint8Array([0, 24, 255, 255]), pasp));
  const stsd = box("stsd", cat(u32(0), u32(1), entry));
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  const moov = box("moov", mvhd, trak);
  const ftyp = box("ftyp", new TextEncoder().encode("isom"), u32(512), new TextEncoder().encode("isomiso2mp41"));
  const mdat = box("mdat", zeros(o.extraBytes ?? 64));
  return cat(ftyp, moov, mdat);
}

export async function 영상쓰기(path: string, o: Fx): Promise<void> {
  await Deno.mkdir(path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || ".", { recursive: true });
  await Deno.writeFile(path, 가짜MP4(o));
}

export { doFetch };

// 원장(ledger.csv) — 올린 영상의 이력. 사고가 났을 때 소명할 수 있는 유일한 근거다.
//
// 현재 업로더(파이썬 csv 모듈)와 같은 꼴을 읽고 쓴다.
//   · 머리 14칸: 업로드시각 · 채널 · 영상ID · 제목 · 파일 · 길이초 · 해상도 · 아동용 · AI합성 ·
//     공개설정 · 공개시각 · 예약시각 · 고객확인자 · 확인일
//   · 줄 끝은 \r\n (파이썬 csv.writer 기본값), 읽을 때는 \n 도 \r\n 도 받는다. 앞의 BOM 도 받는다.
//   · 칸 안에 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다(QUOTE_MINIMAL).
import { dataPath, withFileLock, writeTextAtomic } from "./paths.ts";

export const LEDGER_HEAD = [
  "업로드시각", "채널", "영상ID", "제목", "파일", "길이초", "해상도", "아동용", "AI합성",
  "공개설정", "공개시각", "예약시각", "고객확인자", "확인일",
] as const;

export type LedgerRow = Record<string, string>;

export const ledgerPath = () => dataPath("ledger.csv");

/** CSV 글 → 줄들(칸 배열). 따옴표 안의 쉼표·줄바꿈·"" 이스케이프를 지킨다. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  let i = 0;
  const s = text.replace(/^﻿/, "");
  const n = s.length;
  let touched = false; // 현재 줄에 뭔가 있었나 (빈 줄 거르기)
  while (i < n) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; touched = true; i++; continue; }
    if (c === ",") { row.push(cell); cell = ""; touched = true; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      if (touched || cell !== "") { row.push(cell); rows.push(row); }
      row = []; cell = ""; touched = false; i++; continue;
    }
    cell += c; touched = true; i++;
  }
  if (touched || cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const 따옴표필요 = /[",\r\n]/;
export function csvCell(v: string): string {
  const s = String(v ?? "");
  return 따옴표필요.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + (rows.length ? "\r\n" : "");
}

/** 원장 전체를 칸 배열로 (머리 포함). 파일이 없으면 null. */
export function readLedgerRaw(): string[][] | null {
  let text: string;
  try { text = Deno.readTextFileSync(ledgerPath()); } catch { return null; }
  const rows = parseCsv(text);
  return rows.length ? rows : null;
}

/** 원장을 {칸이름: 값} 줄들로. 줄이 짧으면 빈 글로 채운다. 파일이 없으면 []. */
export function readLedger(): LedgerRow[] {
  const raw = readLedgerRaw();
  if (!raw) return [];
  const head = raw[0];
  return raw.slice(1).map((r) => {
    const o: LedgerRow = {};
    head.forEach((h, k) => { o[h] = r[k] ?? ""; });
    return o;
  });
}

/** 읽다가 막히면 던진다 — 「모르면 막는다」가 필요한 문(출구검사·공개 간격)이 쓴다. */
export function readLedgerStrict(): LedgerRow[] {
  let text: string;
  try { text = Deno.readTextFileSync(ledgerPath()); } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => {
    const o: LedgerRow = {};
    head.forEach((h, k) => { o[h] = r[k] ?? ""; });
    return o;
  });
}

export async function writeLedgerRaw(rows: string[][]): Promise<void> {
  await writeTextAtomic(ledgerPath(), toCsv(rows));
}

/**
 * 원장을 **잠그고** 읽어서 고쳐 쓴다. 화면 서버와 10분마다 도는 심사확인(따로 도는 프로세스)이 동시에 원장을 고쳐도 한 줄도 잃지 않게 —
 * 읽고 쓰는 사이에 다른 쪽이 한 줄 더하면 그 줄이 사라지던 구멍을 막는다. (잠금 파일은 sync.ts 가 쓰는 것과 같다: `.ledger.lock`)
 * 고치기 함수가 rows 를 돌려주면 그것을 쓰고, null 이면 쓰지 않는다. 함수 안에서 updateLedger/appendLedger/patchLedger 를 다시 부르면 안 된다(자기 잠금에 막힌다).
 */
export async function updateLedger<T>(
  고치기: (raw: string[][] | null) => { rows: string[][] | null; out: T } | Promise<{ rows: string[][] | null; out: T }>,
): Promise<T> {
  const r = await withFileLock(dataPath(".ledger.lock"), async () => {
    const got = await 고치기(readLedgerRaw());
    if (got.rows) await writeLedgerRaw(got.rows);
    return got.out;
  });
  return r as T;
}

/** 한 줄 덧붙인다. 파일이 없으면 머리부터 만든다. (파이썬 upload.write_ledger) */
export async function appendLedger(row: LedgerRow): Promise<void> {
  await updateLedger((raw) => {
    const head = raw ? raw[0] : [...LEDGER_HEAD];
    const line = head.map((h) => row[h] ?? "");
    return { rows: raw ? [...raw, line] : [head, line], out: undefined };
  });
}

/**
 * 영상 하나의 칸을 고친다. 바뀐 게 있으면 true.
 * patch 의 값이 undefined 면 건드리지 않는다. onlyIfEmpty 에 든 칸은 이미 값이 있으면 덮지 않는다
 * (공개시각 — 우리가 공개시킨 순간을 적어 둔 것이 더 정확하다).
 */
export async function patchLedger(
  videoId: string,
  patch: Record<string, string | undefined>,
  onlyIfEmpty: string[] = [],
): Promise<boolean> {
  return await updateLedger((raw) => {
    if (!raw) return { rows: null, out: false };
    const head = raw[0];
    const idx = head.indexOf("영상ID");
    if (idx < 0) return { rows: null, out: false };
    let changed = false;
    for (const r of raw.slice(1)) {
      while (r.length < head.length) r.push("");
      if (r[idx] !== videoId) continue;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        const c = head.indexOf(k);
        if (c < 0) continue;
        if (onlyIfEmpty.includes(k) && r[c]) continue;
        if (r[c] !== v) { r[c] = v; changed = true; }
      }
    }
    return { rows: changed ? raw : null, out: changed };
  });
}

/** 영상 id → 줄 */
export function ledgerById(): Map<string, LedgerRow> {
  const m = new Map<string, LedgerRow>();
  for (const r of readLedger()) if (r["영상ID"]) m.set(r["영상ID"], r);
  return m;
}

/** 파일 이름 → 올린 때·채널·영상ID  (verify.uploaded_names — 완료 폴더를 옮기거나 지워도 원장은 남는다) */
export function uploadedNames(): Map<string, [string, string, string]> {
  const out = new Map<string, [string, string, string]>();
  for (const r of readLedger()) {
    const f = (r["파일"] ?? "").trim();
    if (!f) continue;
    const base = f.split(/[\\/]/).pop() ?? f;
    out.set(base, [(r["업로드시각"] ?? "").slice(0, 10), r["채널"] ?? "", r["영상ID"] ?? ""]);
  }
  return out;
}

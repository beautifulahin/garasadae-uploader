// 가라사대 업로더 — 임시 보관(R2) 무료 한도 장부 (Durable Object 하나)
//
// 왜 있나
//   클라우드플레어 R2 에는 과금 상한도 자동 정지도 없다. R2 를 쓰는 곳은 이 중계뿐이므로, 중계가 스스로 무료 한도 안에서 멈춰
//   「과금이 생길 수 없게」 한다. 이 장부가 이번 구간의 Class A(쓰기·목록) · Class B(읽기) 횟수와 보관 용량을 센다.
//
// 어떻게 세나 (R2 요금 문서 기준 · README 참고)
//   · 호출하기 *전에* 미리 잡아 둔다(예약): 한도를 넘길 호출은 아예 하지 않는다.
//   · 한도 판단과 기록은 이 객체 안에서 한 번에 끝난다(blockConcurrencyWhile) — 동시 요청 둘이 마지막 한 칸을 다퉈도 하나만 통과한다.
//     (KV 는 최종 일관성이라 두 요청이 같은 숫자를 읽고 둘 다 통과할 수 있어 쓰지 않는다.)
//   · 숫자는 일부러 넉넉히(위쪽으로) 센다: 올리기 주소 하나는 Class A 3건으로 잡고(올리기 1 + 다시 시도 2), 보관 용량은 올리는 사람이
//     말한 크기를 그날 최고치로 센다(클라우드플레어도 「하루 최고 보관량의 평균」으로 GB-월을 계산한다).
//   · 문턱은 무료 한도의 80%(기본). 지우기(Class 없음 · 무료)는 어떤 경우에도 멈추지 않는다.
//
// 이 파일도 Cloudflare 전용 형식을 쓰지 않는 평범한 TypeScript 다 — 시험이 가짜 저장소로 그대로 부른다.

/** R2 표준 저장소의 월 무료 한도 (https://developers.cloudflare.com/r2/pricing/) */
export const R2_FREE = { classA: 1_000_000, classB: 10_000_000, gbMonth: 10 };
/** 요금 문서의 GB — 10억 바이트로 잡는다(바이트 수가 더 적게 나오는 쪽 = 더 일찍 멈춘다) */
const GB = 1_000_000_000;
/** GB-월 = 「하루 최고 보관량」을 청구 기간(30일)으로 나눈 평균 */
const 청구일수 = 30;

/** 올리기 주소 하나가 쓸 수 있는 Class A: 올리기 1건 + 앱의 다시 시도 2건 (R2 로 곧장 가서 중계가 못 보는 호출) */
export const 티켓A예약 = 3;
/** 새 보관을 받으려면 남아 있어야 하는 Class B (메타가 이 영상을 읽어 갈 몫) */
export const 티켓B여유 = 20;
/** 임시본 수명 — 중계의 읽기 주소 수명(1시간)과 같다 */
export const 영상수명ms = 60 * 60_000;
/** 장부가 보관 표를 들고 있는 시간: 수명 + 크론이 늦을 몫 */
const 표유지ms = 영상수명ms + 30 * 60_000;
/** 올린 영상이 말한 크기보다 이만큼 이상 크면 지운다 */
const 크기여유 = 1024 * 1024;
/** 동시에 들고 있는 보관 표의 수 (장부 크기를 묶어 두는 안전장치) */
export const 최대표 = 1000;

export interface LedgerConfig {
  /** 무료 한도 중 몇 %에서 멈출지 (0 초과 0.95 이하) */
  ratio: number;
  /** 동시에 보관 중인 영상 총용량 상한(바이트) */
  stageMaxBytes: number;
  /** 청구 구간이 시작되는 날(1~28, UTC) — 클라우드플레어 청구일에 맞춘다. 기본 1 = 달력 월 */
  cycleDay: number;
}
export interface LedgerEnv { R2_CAP_RATIO?: string; R2_STAGE_MAX_BYTES?: string; R2_CYCLE_DAY?: string }

/** 설정 변수를 읽는다. 이상한 값은 기본값으로 — 잘못 적어서 한도가 풀리는 일이 없게 위쪽도 막는다. */
export function readLedgerConfig(env: LedgerEnv = {}): LedgerConfig {
  const r = Number(env.R2_CAP_RATIO);
  const ratio = Number.isFinite(r) && r > 0 && r <= 0.95 ? r : 0.8;
  const mb = Number(env.R2_STAGE_MAX_BYTES);
  const 위 = Math.floor(R2_FREE.gbMonth * GB * ratio);
  const stageMaxBytes = Number.isInteger(mb) && mb >= 1024 * 1024 ? Math.min(mb, 위) : Math.min(2_000_000_000, 위);
  const d = Number(env.R2_CYCLE_DAY);
  const cycleDay = Number.isInteger(d) && d >= 1 && d <= 28 ? d : 1;
  return { ratio, stageMaxBytes, cycleDay };
}

/* ============================================================ 장부 모양 */

export interface LedgerState {
  v: 1;
  /** 이번 구간이 시작된 날 (YYYY-MM-DD · UTC) */
  cycle: string;
  /** 이번 구간에 센 Class A · Class B (예약 포함 — 실제보다 같거나 크다) */
  a: number;
  b: number;
  /** 날짜 → 그날 보관 용량 최고치(바이트) */
  peak: Record<string, number>;
  /** 보관 중이라고 보는 영상: 이름 → 말한 크기 · 만든 시각 · 장부에서 빼는 시각 */
  tix: Record<string, { sz: number; at: number; ex: number }>;
}
export interface LedgerStore { get(): Promise<LedgerState | undefined>; put(s: LedgerState): Promise<void> }

export type LedgerReq =
  | { op: "ticket"; now: number; name: string; size: number }
  | { op: "read"; now: number; n: number }
  | { op: "list"; now: number; pages: number }
  | { op: "release"; now: number; id: string }
  | { op: "sweep"; now: number; present: { name: string; size: number; uploaded: number }[] }
  | { op: "usage"; now: number };

/** 시각(now)을 뺀 요청 — 부르는 쪽이 시계를 붙여 보낸다 */
export type LedgerAsk = LedgerReq extends infer R ? (R extends LedgerReq ? Omit<R, "now"> : never) : never;

export interface Refusal {
  ok: false;
  code: "monthly_free_cap" | "stage_full" | "bad_request";
  /** 무엇이 문턱에 닿았나 */
  resource?: "class_a" | "class_b" | "storage";
  /** 다음에 열리는 시각 (다음 구간 시작 · ISO) */
  reopens_at?: string;
  /** 일시적일 때 다시 해 볼 만한 시간(초) */
  retry_after?: number;
}
export type LedgerRes = { ok: true; [k: string]: unknown } | Refusal;

/* ============================================================ 구간 · 문턱 */

const 날짜 = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 지금이 속한 청구 구간의 시작·다음 시작 (UTC 00:00) */
export function cycleBounds(now: number, day: number): { start: number; next: number } {
  const d = new Date(now);
  const m = d.getUTCDate() < day ? d.getUTCMonth() - 1 : d.getUTCMonth(); // -1 이어도 Date.UTC 가 전년 12월로 접어 준다
  return { start: Date.UTC(d.getUTCFullYear(), m, day), next: Date.UTC(d.getUTCFullYear(), m + 1, day) };
}

const 문턱 = (cfg: LedgerConfig) => ({
  a: Math.floor(R2_FREE.classA * cfg.ratio), b: Math.floor(R2_FREE.classB * cfg.ratio), gb: R2_FREE.gbMonth * cfg.ratio,
});
const 보관합 = (s: LedgerState) => Object.values(s.tix).reduce((n, t) => n + t.sz, 0);
const 피크합 = (s: LedgerState) => Object.values(s.peak).reduce((n, v) => n + v, 0);
const 한달GB = (peakSum: number) => peakSum / 청구일수 / GB;

/** 장부를 읽고, 구간이 바뀌었으면 센 숫자를 새로 시작하고, 시간이 지난 보관 표를 뺀다 */
async function load(store: LedgerStore, cfg: LedgerConfig, now: number): Promise<LedgerState> {
  const key = 날짜(cycleBounds(now, cfg.cycleDay).start);
  let s = await store.get();
  if (!s || s.v !== 1) s = { v: 1, cycle: key, a: 0, b: 0, peak: {}, tix: {} };
  // 새 구간으로만 초기화한다(시계가 거꾸로 가거나 시작일 설정이 바뀌어도 센 숫자가 지워지지 않게 — 위쪽으로만 센다)
  else if (key > s.cycle) { s.cycle = key; s.a = 0; s.b = 0; s.peak = {}; }
  for (const [n, t] of Object.entries(s.tix)) if (t.ex <= now) delete s.tix[n];
  notePeak(s, now);
  return s;
}
function notePeak(s: LedgerState, now: number) {
  const day = 날짜(now);
  s.peak[day] = Math.max(s.peak[day] ?? 0, 보관합(s));
}

const 이름꼴 = /^[0-9a-f]{32}\.(mp4|mov)$/;
const 닫힘 = (cfg: LedgerConfig, now: number, resource: Refusal["resource"]): Refusal => ({
  ok: false, code: "monthly_free_cap", resource, reopens_at: new Date(cycleBounds(now, cfg.cycleDay).next).toISOString(),
});

/* ============================================================ 일 하나 — 읽고 · 판단하고 · 적는 것이 한 덩어리 */

export async function ledgerOp(store: LedgerStore, cfg: LedgerConfig, req: LedgerReq): Promise<LedgerRes> {
  const now = Number(req.now);
  if (!Number.isFinite(now)) return { ok: false, code: "bad_request" };
  const cap = 문턱(cfg);
  const s = await load(store, cfg, now);

  switch (req.op) {
    case "ticket": {
      if (!이름꼴.test(String(req.name)) || !Number.isInteger(req.size) || req.size < 1) return { ok: false, code: "bad_request" };
      if (s.a + 티켓A예약 > cap.a) return 닫힘(cfg, now, "class_a");
      if (s.b + 티켓B여유 > cap.b) return 닫힘(cfg, now, "class_b");
      const stored = 보관합(s);
      // 이 영상을 더하면 오늘의 최고치가 올라간다 — 올라간 뒤의 한 달 보관 추정이 문턱을 넘으면 받지 않는다
      const today = 날짜(now);
      const newPeak = Math.max(s.peak[today] ?? 0, stored + req.size);
      if (한달GB(피크합(s) - (s.peak[today] ?? 0) + newPeak) > cap.gb) return 닫힘(cfg, now, "storage");
      // 지금 동시에 들고 있는 양 — 곧(영상이 지워지면) 풀리는 일시적인 막힘
      if (Object.keys(s.tix).length >= 최대표 || stored + req.size > cfg.stageMaxBytes) {
        const soon = Math.min(...Object.values(s.tix).map((t) => t.ex), now + 표유지ms);
        return { ok: false, code: "stage_full", retry_after: Math.max(60, Math.ceil((soon - now) / 1000)) };
      }
      s.a += 티켓A예약;
      s.tix[req.name] = { sz: req.size, at: now, ex: now + 표유지ms };
      notePeak(s, now);
      await store.put(s);
      return { ok: true };
    }

    case "read": {
      const n = Math.min(10, Math.max(1, Math.floor(Number(req.n)) || 1));
      if (s.b + n > cap.b) return 닫힘(cfg, now, "class_b");
      s.b += n;
      await store.put(s);
      return { ok: true };
    }

    case "list": {
      // 크론의 목록 조회(Class A) — 청소는 멈추지 않지만 무료 한도 자체(100%)를 넘기는 호출은 하지 않는다
      const n = Math.min(100, Math.max(1, Math.floor(Number(req.pages)) || 1));
      if (s.a + n > R2_FREE.classA) return 닫힘(cfg, now, "class_a");
      s.a += n;
      await store.put(s);
      return { ok: true };
    }

    case "release": {
      // 앱이 지웠다고 알려 온 영상(mp4·mov 어느 쪽이든)을 보관 목록에서 뺀다. 그날 최고치는 그대로 둔다(하루 최고 보관량이 기준).
      const 빼기 = [`${req.id}.mp4`, `${req.id}.mov`].filter((n) => s.tix[n]);
      for (const n of 빼기) delete s.tix[n];
      if (빼기.length) await store.put(s);
      return { ok: true };
    }

    case "sweep": {
      // 크론이 R2 에서 실제로 읽은 목록과 장부를 맞춘다: 너무 오래된 것 · 말한 것보다 큰 것 · 장부에 없는 것을 가려낸다.
      // 지울 것도 일단 실제 크기로 장부에 올린 뒤 그날 최고치에 반영하고 뺀다 — 있었던 만큼은 센다.
      const kill: string[] = [];
      let 표수 = Object.keys(s.tix).length;
      for (const o of req.present) {
        const t = s.tix[o.name];
        const 오래 = now - o.uploaded >= 영상수명ms;
        if (t) {
          if (오래 || o.size > t.sz + 크기여유) kill.push(o.name);
          if (o.size > t.sz) t.sz = o.size;
          continue;
        }
        // 장부에 없는 영상(중계를 거치지 않고 들어온 것). 표가 가득 차면 더 받지 않고 지운다 — 우리가 낸 주소의 영상은 항상 표가 있다.
        if (오래 || 표수 >= 최대표) kill.push(o.name); else 표수++;
        s.tix[o.name] = { sz: o.size, at: o.uploaded, ex: o.uploaded + 표유지ms };
      }
      notePeak(s, now);
      for (const n of kill) delete s.tix[n];
      await store.put(s);
      return { ok: true, kill };
    }

    case "usage": {
      const b = cycleBounds(now, cfg.cycleDay);
      const stored = 보관합(s);
      const gb = 한달GB(피크합(s));
      const 막힌 = [
        ...(s.a + 티켓A예약 > cap.a ? ["class_a"] : []),
        ...(s.b + 티켓B여유 > cap.b ? ["class_b"] : []),
        ...(gb > cap.gb ? ["storage"] : []),
      ];
      return {
        ok: true,
        cycle: { start: new Date(b.start).toISOString(), next_start: new Date(b.next).toISOString(), start_day: cfg.cycleDay },
        ratio: cfg.ratio,
        class_a: { used: s.a, soft_cap: cap.a, free: R2_FREE.classA, percent_of_free: Math.round(s.a / R2_FREE.classA * 10000) / 100 },
        class_b: { used: s.b, soft_cap: cap.b, free: R2_FREE.classB, percent_of_free: Math.round(s.b / R2_FREE.classB * 10000) / 100 },
        storage: {
          gb_month_estimate: Math.round(gb * 1000) / 1000, soft_cap_gb_month: cap.gb, free_gb_month: R2_FREE.gbMonth,
          stored_bytes_now: stored, stored_bytes_cap: cfg.stageMaxBytes, tickets: Object.keys(s.tix).length, tickets_max: 최대표,
          today_peak_bytes: s.peak[날짜(now)] ?? 0,
        },
        blocked: 막힌,
        note: "예약을 포함해 실제보다 같거나 크게 센 값입니다. 이 장부는 이 중계가 하는 R2 호출만 압니다.",
      };
    }
  }
  return { ok: false, code: "bad_request" }; // 모르는 일
}

/* ============================================================ Durable Object 본체 (SQLite 저장소 · 무료 플랜 가능) */

interface DurableStateLike {
  storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
  blockConcurrencyWhile<T>(cb: () => Promise<T>): Promise<T>;
}

/**
 * 장부 객체. 중계는 항상 같은 이름의 객체 하나만 부른다.
 * 일 하나(읽기 → 판단 → 쓰기)를 blockConcurrencyWhile 로 감싸 다른 요청이 중간에 끼어들지 못하게 한다.
 */
export class R2Ledger {
  constructor(private state: DurableStateLike, private env: LedgerEnv) {}
  async fetch(req: Request): Promise<Response> {
    const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let body: LedgerReq;
    try { body = await req.json() as LedgerReq; } catch { return out({ ok: false, code: "bad_request" }, 400); }
    const store: LedgerStore = { get: () => this.state.storage.get<LedgerState>("L"), put: (s) => this.state.storage.put("L", s) };
    const res = await this.state.blockConcurrencyWhile(() => ledgerOp(store, readLedgerConfig(this.env), body));
    return out(res);
  }
}

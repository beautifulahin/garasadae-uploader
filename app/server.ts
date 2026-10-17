// 화면 서버 — 이 컴퓨터 안에서만 닿는 작은 웹 서버. (파이썬: serve.py)
//
// 왜 서버인가: 화면(브라우저)이 누른 것을 이 컴퓨터에 적고, 영상을 재생하고, 폴더를 고르려면 127.0.0.1 로만 여는 서버가 필요하다. 바깥에서는 못 들어온다.
//
// 문지기 (모든 요청이 먼저 지난다)
//   · Host 가 127.0.0.1/localhost 의 이 포트가 아니면 거절한다(DNS 되돌림 공격 — 다른 사이트가 내 컴퓨터 서버를 부리는 것을 막는다).
//   · Origin 이 있으면 이 서버 자신이어야 한다. 예외는 공개 안내 페이지가 「이미 실행 중인 앱을 찾아 업데이트」 하려고 부르는 세 길뿐이다.
//   · 시키는 길(POST)은 JSON 으로 와야 한다(다른 사이트는 서버 허락 없이 JSON 을 못 보낸다) — 끌어다 놓기(drop)만 파일 바이트.
//   · 영상·그림 재생은 등록된 채널 폴더 안의 파일만 내준다.
//   · 올리기는 표(ticket)·사람이 누른 출처·20개·되풀이 검사를 지난다(safety.ts).
//
// 심사확인 틱: 서버가 켜져 있는 동안은 여기서 10분마다 돈다(꺼져 있으면 예약 작업이 돈다 — tick.ts 가 겹침을 막는다).
import { APP_VERSION, extOf, join, log } from "./paths.ts";
import { composePage, readAsset } from "./uipage.ts";
import { Bad, buildRoutes, type Ctx, type Handler, newAppState } from "./routes.ts";
import * as TK from "./tick.ts";
import * as SG from "./settings.ts";
import * as V from "./views.ts";
import * as PLAT from "./platform.ts";
import { checkUpdate, installUpdate, type UpdateInfo } from "./update.ts";
import { artDir } from "./profile.ts";
import { loadChannels } from "./channels.ts";
import { setTelegramAlerts } from "./notify.ts";

type Obj = Record<string, any>;

export interface ServerOpts {
  /** 쓸 포트(0 이면 운영체제가 빈 포트를 준다) */
  port?: number;
  /** 10분마다 도는 심사확인을 서버가 돌리나(기본 참) */
  tick?: boolean;
  /** 켠 뒤 새 버전을 보고, 있으면 묻지 않고 받는다(기본 참) */
  autoUpdate?: boolean;
  /** 심사확인 첫 실행을 늦추는 시간(ms, 기본 20초) */
  firstTickMs?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  /** 지금 심사확인 한 번 */
  runTick: () => Promise<TK.TickResult>;
  shutdown: () => Promise<void>;
}

/** 공개 안내 페이지가 이미 실행 중인 앱을 찾아 부르는 것을 허락한다(그 밖의 사이트는 안 된다) */
const ALLOWED_ORIGINS = ["https://beautifulahin.github.io"];
const PUBLIC_PATHS = ["/api/state", "/api/update/check", "/api/update/install"];

const 한시간 = 60 * 60_000;
const 한줄 = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};

export async function startServer(o: ServerOpts = {}): Promise<RunningServer> {
  const S = { ...newAppState(), ownerSeen: 0 } as ReturnType<typeof newAppState> & { ownerSeen: number } & Obj;
  let port = 0;
  let 판정보: UpdateInfo | null = null;
  const timers: number[] = [];
  const 넘어진판 = new Map<string, number>();

  // 앱 설정에 적힌 텔레그램 알림 여부를 알림 모듈에 알린다
  try { setTelegramAlerts(SG.appSettings().telegramAlerts); } catch { /* 기본값 */ }

  /* ── 새 판 보기(네트워크) — 상태 응답은 이 기억만 읽는다. 화면이 1.5초마다 부르는 길에서 네트워크를 기다리면 안 된다 ── */
  const 새판보기 = async (force = false) => {
    try { 판정보 = await checkUpdate(force); } catch { /* 못 보면 다음에 */ }
  };
  const 새판보기글 = (): Obj => {
    const i = 판정보;
    const declines = SG.appSettings().updateDeclines;
    return {
      available: !!i?.available, version: i?.version ?? "", current: APP_VERSION, notes: String(i?.notes ?? "").split("\n").filter(Boolean),
      page: i?.page ?? "", url: i?.url ?? "", canInstall: !!i?.canInstall, reason: i?.reason ?? "",
      running: S.upd.running, pct: S.upd.pct, text: S.upd.text, error: S.upd.error,
      prompt: !!i?.available && (declines[i.version] ?? 0) < 2,
    };
  };

  // routes 가 쓰는 살아 있는 값들
  const state = Object.assign(S, {
    port: () => port, tickEvery: () => SG.appSettings().tickMinutes, residentOn: o.tick !== false,
    tick: () => runTick(), update: async () => 새판보기글(),
  }) as unknown as import("./routes.ts").AppState;
  const R = buildRoutes(state);

  /* ── 심사확인 ── */
  let 도는중: Promise<TK.TickResult> | null = null;
  const runTick = (): Promise<TK.TickResult> => {
    if (도는중) return 도는중;
    const p = TK.tick({ force: true }).catch(async (e) => {
      await log(`[예외] 심사확인: ${한줄(e)}`);
      return { skipped: `오류 — ${한줄(e)}`, fired: 0, reviewed: null, steps: [], lines: [] } as TK.TickResult;
    }).finally(() => { 도는중 = null; });
    도는중 = p;
    return p;
  };
  let 끝남 = false;
  const 틱반복 = async () => {
    if (끝남) return;
    try {
      // 겹쳐 돌지 않게 tick() 이 마지막으로 돈 때를 본다(force 아님) — 예약 작업과 같이 있어도 한 번만 돈다
      if (!도는중) await TK.tick({}).catch(async (e) => { await log(`[예외] 심사확인: ${한줄(e)}`); });
    } finally {
      // 도는 사이에 서버가 꺼졌으면 다음 차례를 걸지 않는다 — 걸면 꺼진 뒤에도 프로세스가 10분 더 남는다
      if (!끝남) timers.push(setTimeout(틱반복, Math.max(1, SG.appSettings().tickMinutes) * 60_000) as unknown as number);
    }
  };
  if (o.tick !== false) timers.push(setTimeout(틱반복, o.firstTickMs ?? 20_000) as unknown as number);

  /* ── 새 판 자동 받기: 켠 직후 한 번, 그 뒤 한 시간에 한 번. 올리는 중이거나 전에 거절한 판이면 건너뛴다. ── */
  const 새판받기 = async () => {
    try {
      if (S.upd.running || S.job.running) return;
      await 새판보기(false);
      const info = 판정보;
      if (!info?.available || !info.canInstall) return;
      if ((SG.appSettings().updateDeclines[info.version] ?? 0) > 0) return; // 전에 「아니오」 를 누른 판은 몰래 밀어 넣지 않는다
      if (Date.now() - (넘어진판.get(info.version) ?? 0) < 6 * 한시간) return;
      await log(`⬆️  새 버전 ${info.version} — 묻지 않고 바로 받습니다`);
      S.upd = { running: true, pct: 0, text: "준비 중…", error: "" };
      try {
        await installUpdate(info, (pct, text) => { S.upd.pct = pct; S.upd.text = text; });
      } catch (e) {
        넘어진판.set(info.version, Date.now());
        S.upd = { running: false, pct: 0, text: "", error: 한줄(e) };
        await log(`⚠️  자동 업데이트 실패: ${S.upd.error} — 화면에서 다시 시도할 수 있습니다 (6시간 뒤 스스로 다시 해 봅니다)`);
      }
    } catch { /* 다음 시간에 */ }
  };
  if (o.autoUpdate !== false) {
    timers.push(setTimeout(async () => { await 새판받기(); if (!끝남) timers.push(setInterval(() => { 새판받기().catch(() => {}); }, 한시간) as unknown as number); }, 5000) as unknown as number);
  } else {
    void 새판보기(false);
  }

  /* ── 요청 처리 ── */
  const hostOk = (h: string) => { const x = h.toLowerCase(); return x === `127.0.0.1:${port}` || x === `localhost:${port}` || x === "127.0.0.1" || x === "localhost"; };
  const originOk = (origin: string, path: string) => {
    if (!origin) return true;
    if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
    return ALLOWED_ORIGINS.includes(origin) && PUBLIC_PATHS.includes(path);
  };
  const corsFor = (req: Request, path: string): Record<string, string> => {
    const origin = req.headers.get("origin") ?? "";
    if (!origin || !ALLOWED_ORIGINS.includes(origin) || !PUBLIC_PATHS.includes(path)) return {};
    return {
      "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, access-control-request-private-network", "access-control-max-age": "600",
      "access-control-allow-private-network": "true",
    };
  };

  const jsonRes = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
  /** 실패 응답 — 새 이름 why 와 옛 공개 안내 페이지가 읽는 error 를 함께 싣는다 */
  const failRes = (why: string, status = 200, extra: Record<string, string> = {}) => jsonRes({ ok: false, why, error: why }, status, extra);

  /** 영상·그림 내주기(구간 요청 지원 — 재생 위치를 옮길 때) */
  const serveFile = async (req: Request, path: string): Promise<Response> => {
    let st: Deno.FileInfo;
    try { st = await Deno.stat(path); if (!st.isFile) throw new Error("not file"); } catch { return new Response("", { status: 404 }); }
    const ctype = MIME[extOf(path).toLowerCase()] ?? "application/octet-stream";
    const size = st.size;
    const range = req.headers.get("range");
    const f = await Deno.open(path, { read: true });
    let start = 0, end = size - 1, status = 200;
    const headers: Record<string, string> = { "content-type": ctype, "accept-ranges": "bytes", "cache-control": "no-store" };
    if (range && range.startsWith("bytes=")) {
      const [a, b] = range.slice(6).split("-");
      start = a ? Number(a) : 0;
      end = b ? Math.min(Number(b), size - 1) : size - 1;
      if (!(start >= 0) || start > end) { f.close(); return new Response("", { status: 416 }); }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    const len = end - start + 1;
    headers["content-length"] = String(len);
    await f.seek(start, Deno.SeekMode.Start);
    let left = len;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        if (left <= 0) { try { f.close(); } catch { /* 이미 닫힘 */ } ctl.close(); return; }
        const buf = new Uint8Array(Math.min(262144, left));
        const n = await f.read(buf);
        if (n === null) { try { f.close(); } catch { /* 이미 닫힘 */ } ctl.close(); return; }
        left -= n;
        ctl.enqueue(buf.subarray(0, n));
      },
      cancel() { try { f.close(); } catch { /* 이미 닫힘 */ } },
    });
    return new Response(stream, { status, headers });
  };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    const cors = corsFor(req, p);

    // ── 문지기 ──
    if (!hostOk(req.headers.get("host") ?? "")) return failRes("이 주소로는 열 수 없습니다", 403);
    const origin = req.headers.get("origin") ?? "";
    if (!originOk(origin, p)) return failRes("다른 곳에서 부른 요청입니다", 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
    if (p.startsWith("/api/") && site && !["same-origin", "none"].includes(site) && !(origin && cors["access-control-allow-origin"])) {
      return failRes("다른 곳에서 부른 요청입니다", 403);
    }

    try {
      /* ---------- 화면과 정적 파일 ---------- */
      if (req.method === "GET" || req.method === "HEAD") {
        if (p === "/" || p === "/index.html") return new Response(await composePage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        if (p.startsWith("/ui/")) {
          const a = await readAsset(decodeURIComponent(p.slice(4)));
          return a ? new Response(a.body as BodyInit, { headers: { "content-type": a.type, "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
        }
        if (p === "/alive") return new Response("ok");
        if (p === "/favicon.ico") return new Response(null, { status: 204 });
        if (p === "/media" || p === "/thumb") {
          const f = url.searchParams.get("p") ?? "";
          if (!f) return new Response("", { status: 400 });
          if (!V.underRoots(f)) return new Response("", { status: 403 }); // 등록된 채널 폴더 안의 파일만 내준다
          if (p === "/thumb" && !/\.(jpe?g|png|webp)$/i.test(f)) return new Response("", { status: 403 });
          if (p === "/media" && !/\.(mp4|m4v|mov|webm)$/i.test(f)) return new Response("", { status: 403 });
          return await serveFile(req, f);
        }
        if (p === "/art") {
          const name = url.searchParams.get("f") ?? "";
          if (!name || /[\\/]/.test(name) || name.startsWith(".")) return new Response("", { status: 400 });
          return await serveFile(req, join(artDir(), name));
        }
        if (p === "/studio") {
          const cid = url.searchParams.get("cid") ?? "";
          if (!/^UC[\w-]{22}$/.test(cid)) return new Response("채널 번호가 올바르지 않습니다", { status: 400 });
          // 열리는 쪽(브라우저)이 같은 계정으로 로그인돼 있어야 한다 — 채널 칸의 크롬 프로필 이름이 있으면 그 프로필로
          const conf = Object.values(loadChannels()).find((c) => c.channel_id === cid);
          const target = `https://studio.youtube.com/channel/${cid}/videos`;
          const prof = String(conf?.studio_profile ?? "");
          if (prof && /^(Default|Profile \d+)$/.test(prof) && Deno.build.os === "darwin") {
            try { new Deno.Command("open", { args: ["-na", "Google Chrome", "--args", `--profile-directory=${prof}`, target], stdout: "null", stderr: "null" }).spawn(); return new Response("ok"); } catch { /* 기본 브라우저로 */ }
          }
          await PLAT.openUrl(target, SG.appSettings().browser);
          return new Response("ok");
        }
      }

      /* ---------- API ---------- */
      if (p.startsWith("/api/")) {
        const name = p.slice(5);
        const isGet = req.method === "GET";
        const table = isGet ? R.get : R.post;
        const h: Handler | undefined = table[name];
        if (!h) {
          // 있는 길인데 방법이 틀렸나
          if ((isGet ? R.post : R.get)[name]) return failRes("이 길은 " + (isGet ? "POST" : "GET") + " 로만 열립니다", 405);
          return failRes("모르는 요청입니다", 404);
        }
        let body: Obj = {};
        if (!isGet) {
          const ct = (req.headers.get("content-type") ?? "").toLowerCase();
          if (name === "drop") {
            if (!ct.startsWith("application/octet-stream")) return failRes("파일 바이트로 보내 주세요", 415);
          } else {
            if (!ct.startsWith("application/json")) return failRes("JSON 으로 보내 주세요", 415, cors);
            const txt = await req.text();
            if (txt.length > 4 * 1024 * 1024) return failRes("보낸 내용이 너무 큽니다", 413, cors);
            try { body = txt.trim() ? JSON.parse(txt) : {}; } catch { return failRes("JSON 이 아닙니다", 400, cors); }
            if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
          }
        }
        const ctx: Ctx = { q: url.searchParams, body, headers: req.headers, req, port };
        // 상태를 읽는 길(GET state)은 창의 주인 표를 본다 — 창은 하나만 살려 둔다(8초 넘게 안 보이면 다음 창이 주인)
        if (name === "state") {
          const tab = url.searchParams.get("tab") ?? "";
          const now = Date.now();
          if (tab) {
            if (url.searchParams.get("claim") === "1" || !S.owner || now - S.ownerSeen > 8000) S.owner = tab;
            if (tab === S.owner) S.ownerSeen = now;
          }
        }
        const out = await h(ctx);
        if (out instanceof Response) return out;
        const data: Obj = out ?? {};
        const res: Obj = name === "state" ? { ...data, updating: { running: S.upd.running, pct: S.upd.pct, text: S.upd.text, error: S.upd.error } } : { ok: true, ...data };
        return jsonRes(res, 200, cors);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      if (e instanceof Bad) return jsonRes({ ...e.extra, ok: false, why: e.why, error: e.why }, e.status, cors);
      await log(`[예외] ${p}: ${한줄(e)}`);
      return failRes(한줄(e), 500, cors);
    }
  };

  /* ── 켜기 ── */
  const want = o.port ?? 0;
  const srv = Deno.serve({ port: want, hostname: "127.0.0.1", onListen: (a) => { port = a.port; } }, handler);
  for (let i = 0; i < 100 && !port; i++) await new Promise((r) => setTimeout(r, 10));

  return {
    port, url: `http://127.0.0.1:${port}`, runTick,
    shutdown: async () => {
      끝남 = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      // 돌고 있던 심사확인이 있으면 끝나기를 잠깐(최대 5초) 기다린다 — 파일을 쓰는 중에 끊기지 않게
      if (도는중) await Promise.race([도는중.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      try { await srv.shutdown(); } catch { /* 이미 꺼짐 */ }
    },
  };
}


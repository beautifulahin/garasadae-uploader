// 로컬 웹 UI + API
import {
  APP_NAME, APP_VERSION, Config, DEFAULTS, IS_MAC, IS_WIN, dataDir, desktopDir, join,
  loadConfig, loadTokens, log, saveConfig, clearTokens, tailLog,
} from "./paths.ts";
import { accessToken, authUrl, checkChannel, exchange, revoke } from "./auth.ts";
import { Engine, studioEditorUrl } from "./watcher.ts";
import { autoStartEnabled, isCompiled, openPath, openUrl, pickFolder, setAutoStart } from "./platform.ts";
import { checkUpdate, installUpdate, UpdateInfo } from "./update.ts";

let upState = { running: false, pct: 0, text: "", error: "" };

const UI = await Deno.readTextFile(new URL("./ui.html", import.meta.url));

/** 안내 페이지에서만 말을 걸 수 있게 허용한다. 다른 사이트는 접근할 수 없다. */
const ALLOWED_ORIGINS = [
  "https://beautifulahin.github.io",
  "http://127.0.0.1:8777",
  "http://localhost:8777",
];
/** 바깥 페이지가 쓸 수 있는 통로 — 업데이트 관련만 열어 둔다 */
const PUBLIC_PATHS = ["/api/state", "/api/update/check", "/api/update/install"];

function corsFor(req: Request, path: string): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!origin || !ALLOWED_ORIGINS.includes(origin) || !PUBLIC_PATHS.includes(path)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, access-control-request-private-network",
    "access-control-max-age": "600",
    // 크롬은 공개 사이트가 내 컴퓨터 주소로 요청하는 걸 따로 막는다. 그 허용 표시.
    "access-control-allow-private-network": "true",
  };
}

let corsHeaders: Record<string, string> = {};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders,
    },
  });

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
     <body style="background:#0b0b11;color:#ededf4;font-family:-apple-system,'Malgun Gothic',sans-serif;text-align:center;padding:90px 20px">
     ${body}</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

export function startServer(engine: Engine, port: number) {
  return Deno.serve({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  }, async (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    corsHeaders = corsFor(req, p);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      // 구글은 루프백 리디렉션에 경로를 붙일 수 없어 콜백이 "/" 로 돌아온다.
      const isCallback = url.searchParams.has("code") || url.searchParams.has("error");

      if ((p === "/" || p === "/index.html") && !isCallback) {
        return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      /* ---------------- 상태 ---------------- */
      if (p === "/api/state") {
        engine.lastSeen = Date.now();
        const cfg = engine.cfg;
        const tok = await loadTokens();
        return json({
          app: APP_NAME,
          platform: IS_WIN ? "windows" : IS_MAC ? "mac" : "linux",
          compiled: isCompiled(),
          dataDir: dataDir(),
          config: { ...cfg, clientSecret: cfg.clientSecret ? "********" : "" },
          authed: !!tok,
          channel: tok?.channel ?? null,
          channelError: tok?.channelError ?? "",
          channelErrorUrl: tok?.channelErrorUrl ?? "",
          autoStart: await autoStartEnabled(),
          version: APP_VERSION,
          update: await checkUpdate(false),
          updatePrompt: await updatePrompt(cfg),
          updating: upState,
          // 첫 실행에서 한 번만 물어본다 (구글 연결이 끝난 뒤)
          askAutoStart: isCompiled() && !!tok && !cfg.autoStartAsked && !(await autoStartEnabled()),
          ...engine.snapshot(),
        });
      }

      if (p === "/api/log") return json({ lines: await tailLog(80) });

      /* ---------------- 설정 ---------------- */
      if (p === "/api/config" && req.method === "POST") {
        const patch = await req.json();
        const cur = await loadConfig();
        if (patch.clientSecret === "********") delete patch.clientSecret;
        const next: Config = { ...DEFAULTS, ...cur, ...patch };
        next.pollSeconds = clamp(next.pollSeconds, 2, 3600);
        next.stableChecks = clamp(next.stableChecks, 1, 60);
        next.dailyLimit = clamp(next.dailyLimit, 1, 50);
        next.maxRetries = clamp(next.maxRetries, 1, 10);
        if (Array.isArray(patch.tags)) next.tags = patch.tags;
        else if (typeof patch.tags === "string") {
          next.tags = patch.tags.split(",").map((s: string) => s.trim()).filter(Boolean);
        }
        await saveConfig(next);
        await engine.reloadConfig();
        await engine.ensureDirs();
        return json({ ok: true });
      }

      if (p === "/api/defaults") {
        return json({ desktop: await desktopDir(), suggested: join(await desktopDir(), "업로드대기") });
      }

      /* ---------------- 인증 ---------------- */
      if (p === "/api/auth/url" && req.method === "POST") {
        const cfg = await loadConfig();
        if (!cfg.clientId || !cfg.clientSecret) {
          return json({ error: "먼저 클라이언트 ID와 보안 비밀번호를 저장해 주세요." }, 400);
        }
        return json({ url: await authUrl(cfg) });
      }

      if (isCallback || p === "/oauth/callback") {
        const code = url.searchParams.get("code");
        const st = url.searchParams.get("state") ?? "";
        const err = url.searchParams.get("error");
        if (err || !code) {
          return page("인증 실패", `<h2 style="color:#ff4466">❌ 인증에 실패했습니다</h2>
            <p style="color:#8e8ea8">${esc(err ?? "인증 코드를 받지 못했습니다")}</p>
            <p style="color:#5a5a72;font-size:13px">이 창을 닫고 앱에서 다시 시도해 주세요.</p>`);
        }
        try {
          const cfg = await loadConfig();
          const tok = await exchange(cfg, code, st);
          if (tok.channelError) {
            return page("설정이 하나 남았습니다", `
              <h2 style="color:#f0b429">⚠️ 로그인은 됐지만 설정이 하나 남았습니다</h2>
              <p style="color:#8e8ea8;max-width:560px;margin:14px auto;line-height:1.8">${esc(tok.channelError)}</p>
              ${tok.channelErrorUrl ? `<p><a href="${esc(tok.channelErrorUrl)}" target="_blank"
                 style="display:inline-block;margin-top:8px;padding:10px 18px;border-radius:8px;background:#4c8dff;color:#fff;text-decoration:none;font-weight:600">🔗 구글 설정 화면 열기</a></p>` : ""}
              <p style="color:#5a5a72;font-size:13px;margin-top:22px">처리한 뒤 앱 화면에서 <b>연결 점검</b> 을 눌러주세요.</p>`);
          }
          return page("연결 완료", `<h2 style="color:#2dd4a8">✅ 연결되었습니다</h2>
            <p style="color:#ededf4;font-size:18px">${esc(tok.channel?.title ?? "")}</p>
            <p style="color:#5a5a72;font-size:13px">이 창을 닫고 앱으로 돌아가세요.</p>
            <script>setTimeout(()=>window.close(),2500)</script>`);
        } catch (e) {
          return page("인증 실패", `<h2 style="color:#ff4466">❌ 인증에 실패했습니다</h2>
            <p style="color:#8e8ea8;max-width:520px;margin:0 auto;line-height:1.7">${esc(e instanceof Error ? e.message : String(e))}</p>`);
        }
      }

      if (p === "/api/auth/check" && req.method === "POST") {
        const tok = await loadTokens();
        if (!tok) return json({ error: "먼저 구글 계정을 연결해 주세요." }, 400);
        const cfg = await loadConfig();
        try { tok.access_token = await accessToken(cfg); } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const t = await checkChannel(tok);
        if (t.channelError) return json({ ok: false, error: t.channelError, url: t.channelErrorUrl });
        engine.blocked = "";
        engine.blockedUrl = "";
        return json({ ok: true, channel: t.channel });
      }

      if (p === "/api/auth/logout" && req.method === "POST") {
        await revoke();
        await clearTokens();
        await log("🚪 로그아웃");
        return json({ ok: true });
      }

      /* ---------------- 대기 항목 ---------------- */
      if (p === "/api/item/meta" && req.method === "POST") {
        const { name, title, description } = await req.json();
        const it = engine.pending.get(name);
        if (!it) return json({ error: "항목을 찾을 수 없습니다." }, 404);
        if (typeof title === "string") it.title = title.slice(0, 100);
        if (typeof description === "string") it.description = description.slice(0, 5000);
        return json({ ok: true });
      }

      if (p === "/api/item/upload" && req.method === "POST") {
        const { name } = await req.json();
        const it = engine.pending.get(name);
        if (!it) return json({ error: "항목을 찾을 수 없습니다." }, 404);
        if (engine.uploading) return json({ error: "다른 업로드가 진행 중입니다." }, 409);
        if (!it.title.trim()) return json({ error: "제목을 입력해 주세요." }, 400);
        engine.uploadOne(it);                       // 백그라운드로 진행
        return json({ ok: true });
      }

      if (p === "/api/item/hold" && req.method === "POST") {
        const { name } = await req.json();
        return json({ ok: await engine.hold(name) });
      }

      /* ---------------- 기타 ---------------- */
      // 화면에 끌어다 놓은 파일을 감시 폴더에 저장한다
      if (p === "/api/drop" && req.method === "POST") {
        const raw = req.headers.get("x-filename") ?? "";
        let name = decodeURIComponent(raw).replace(/[/\\]/g, "_").trim();
        if (!name) return json({ error: "파일 이름을 읽지 못했습니다." }, 400);
        if (!req.body) return json({ error: "파일 내용이 비어 있습니다." }, 400);

        await engine.ensureDirs();
        const dir = engine.cfg.watchDir;
        const dot = name.lastIndexOf(".");
        const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
        let dest = join(dir, name);
        let i = 1;
        while (await fileExists(dest)) dest = join(dir, `${base} (${i++})${ext}`);

        // 아직 쓰는 중인 파일로 오인하지 않도록 임시 이름으로 받은 뒤 옮긴다
        const tmp = dest + ".part";
        const f = await Deno.open(tmp, { write: true, create: true, truncate: true });
        try {
          await req.body.pipeTo(f.writable);
        } catch (e) {
          try { f.close(); } catch { /* 이미 닫힘 */ }
          try { await Deno.remove(tmp); } catch { /* 무시 */ }
          return json({ error: `파일을 저장하지 못했습니다: ${e instanceof Error ? e.message : e}` }, 500);
        }
        await Deno.rename(tmp, dest);
        await log(`📥 화면에서 받은 파일: ${dest.split(/[/\\]/).pop()}`);
        return json({ ok: true, name: dest.split(/[/\\]/).pop() });
      }

      // "음악 넣으시겠어요?" 팝업의 답변
      if (p === "/api/ask/answer" && req.method === "POST") {
        const { open, remember } = await req.json();
        const target = engine.ask;
        engine.ask = null;
        if (open && target) await openUrl(studioEditorUrl(target.id));
        if (remember === "always" || remember === "never") {
          const cfg = await loadConfig();
          cfg.studioAfter = remember;
          await saveConfig(cfg);
          await engine.reloadConfig();
        }
        return json({ ok: true });
      }

      // 취소를 누른 횟수를 기록한다. 두 번 거절하면 그 버전은 다시 묻지 않는다.
      if (p === "/api/update/decline" && req.method === "POST") {
        const info = await checkUpdate(false);
        if (!info.version) return json({ ok: true });
        const cfg = await loadConfig();
        const n = (cfg.updateDeclines[info.version] ?? 0) + 1;
        cfg.updateDeclines = { [info.version]: n };   // 옛 버전 기록은 버린다
        await saveConfig(cfg);
        await engine.reloadConfig();
        await log(`🔕 업데이트 ${info.version} 거절 (${n}번째)${n >= 2 ? " — 이 버전은 다시 묻지 않습니다" : ""}`);
        return json({ ok: true, times: n });
      }

      if (p === "/api/update/check" && req.method === "POST") {
        return json(await checkUpdate(true));
      }

      if (p === "/api/update/install" && req.method === "POST") {
        if (upState.running) return json({ error: "이미 업데이트를 진행 중입니다." }, 409);
        const info: UpdateInfo = await checkUpdate(true);
        if (!info.available) return json({ error: "이미 최신 버전입니다." }, 400);
        if (!info.canInstall) return json({ error: info.reason || "이 상태에서는 자동 설치할 수 없습니다.", page: info.page }, 400);
        if (engine.uploading) return json({ error: "업로드가 진행 중입니다. 끝난 뒤에 다시 눌러 주세요." }, 409);

        upState = { running: true, pct: 0, text: "준비 중…", error: "" };
        installUpdate(info, (pct, text) => { upState.pct = pct; upState.text = text; })
          .catch(async (e) => {
            upState = { running: false, pct: 0, text: "", error: e instanceof Error ? e.message : String(e) };
            await log(`⚠️  업데이트 실패: ${upState.error}`);
          });
        return json({ ok: true });
      }

      if (p === "/api/openfolder" && req.method === "POST") {
        await engine.ensureDirs();
        await openPath(engine.cfg.watchDir);
        return json({ ok: true });
      }

      if (p === "/api/pickfolder" && req.method === "POST") {
        const picked = await pickFolder(engine.cfg.watchDir);
        return json({ path: picked });
      }

      if (p === "/api/autostart" && req.method === "POST") {
        const { on, asked } = await req.json();
        const m = await setAutoStart(!!on);
        const cfg = await loadConfig();
        cfg.autoStart = !!on;
        if (asked) cfg.autoStartAsked = true;
        await saveConfig(cfg);
        await engine.reloadConfig();
        return json({ ok: true, message: m });
      }

      if (p === "/api/pause" && req.method === "POST") {
        const { on } = await req.json();
        engine.paused = !!on;
        await log(engine.paused ? "⏸  감시 일시정지" : "▶️  감시 재개");
        return json({ ok: true, paused: engine.paused });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log(`⚠️  요청 처리 오류 ${p}: ${msg}`);
      return json({ error: msg }, 500);
    }
  });
}

async function fileExists(p: string) {
  try { await Deno.stat(p); return true; } catch { return false; }
}

/** 업데이트를 물어볼지, 몇 번째 물음인지 */
async function updatePrompt(cfg: Config) {
  const info = await checkUpdate(false);
  const times = info.version ? (cfg.updateDeclines[info.version] ?? 0) : 0;
  return { show: info.available && times < 2, times, second: times === 1 };
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number(n) || lo));

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

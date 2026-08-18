// 로컬 웹 UI + API
import {
  APP_NAME, Config, DEFAULTS, IS_MAC, IS_WIN, dataDir, desktopDir, join,
  loadConfig, loadTokens, log, saveConfig, clearTokens, tailLog,
} from "./paths.ts";
import { accessToken, authUrl, checkChannel, exchange, revoke } from "./auth.ts";
import { Engine } from "./watcher.ts";
import { autoStartEnabled, isCompiled, openPath, pickFolder, setAutoStart } from "./platform.ts";

const UI = await Deno.readTextFile(new URL("./ui.html", import.meta.url));

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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

    try {
      // 구글은 루프백 리디렉션에 경로를 붙일 수 없어 콜백이 "/" 로 돌아온다.
      const isCallback = url.searchParams.has("code") || url.searchParams.has("error");

      if ((p === "/" || p === "/index.html") && !isCallback) {
        return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      /* ---------------- 상태 ---------------- */
      if (p === "/api/state") {
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
        const { on } = await req.json();
        const m = await setAutoStart(!!on);
        const cfg = await loadConfig();
        cfg.autoStart = !!on;
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

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number(n) || lo));

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

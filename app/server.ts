// 로컬 웹 UI + API
import {
  APP_NAME, APP_VERSION, CHANNEL_DEFAULTS, Channel, Config, IS_MAC, IS_WIN, REPO,
  clearTokens, credsOf, dataDir, desktopDir, join, loadConfig, loadTokens, log,
  newChannelId, safeFolderName, saveConfig, tailLog,
} from "./paths.ts";
import { accessToken, authUrl, checkChannel, exchange, revoke } from "./auth.ts";
import { Manager, studioEditorUrl } from "./watcher.ts";
import { autoStartEnabled, isCompiled, listBrowsers, openPath, openUrl, pickFolder, setAutoStart } from "./platform.ts";
import { checkUpdate, installUpdate, UpdateInfo } from "./update.ts";

const UI = await Deno.readTextFile(new URL("./ui.html", import.meta.url));

let upState = { running: false, pct: 0, text: "", error: "" };

/** 안내 페이지에서만 말을 걸 수 있게 허용한다. 다른 사이트는 접근할 수 없다. */
const ALLOWED_ORIGINS = [
  "https://beautifulahin.github.io",
  "http://127.0.0.1:8777",
  "http://localhost:8777",
];
const PUBLIC_PATHS = ["/api/state", "/api/update/check", "/api/update/install"];

function corsFor(req: Request, path: string): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!origin || !ALLOWED_ORIGINS.includes(origin) || !PUBLIC_PATHS.includes(path)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, access-control-request-private-network",
    "access-control-max-age": "600",
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

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  const v = Number(n);
  return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
};

/** 채널 하나의 현재 모습 (로그인 상태까지) */
async function channelView(cfg: Config, ch: Channel) {
  const tok = await loadTokens(ch.id);
  return {
    ...ch,
    clientSecret: ch.clientSecret ? "********" : "",
    authed: !!tok,
    youtube: tok?.channel ?? null,
    channelError: tok?.channelError ?? "",
    channelErrorUrl: tok?.channelErrorUrl ?? "",
    usesCredsOf: ch.sharesWith,
    hasCreds: !!credsOf(cfg, ch).clientId,
  };
}

export function startServer(engine: Manager, port: number) {
  return Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    corsHeaders = corsFor(req, p);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    try {
      const isCallback = url.searchParams.has("code") || url.searchParams.has("error");

      if ((p === "/" || p === "/index.html") && !isCallback) {
        return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      /* ---------------- 상태 ---------------- */
      if (p === "/api/state") {
        engine.lastSeen = Date.now();
        const cfg = engine.cfg;
        const snap = engine.snapshot();
        const views = await Promise.all(cfg.channels.map((c) => channelView(cfg, c)));
        const up = await checkUpdate(false);
        const times = up.version ? (cfg.updateDeclines[up.version] ?? 0) : 0;
        return json({
          app: APP_NAME,
          version: APP_VERSION,
          platform: IS_WIN ? "windows" : IS_MAC ? "mac" : "linux",
          compiled: isCompiled(),
          dataDir: dataDir(),
          settings: {
            port: cfg.port,
            pollSeconds: cfg.pollSeconds,
            stableChecks: cfg.stableChecks,
            notifications: cfg.notifications,
            baseDir: cfg.baseDir,
            browser: cfg.browser,
          },
          browsers: await listBrowsers(),
          channelList: views,
          autoStart: await autoStartEnabled(),
          askAutoStart: isCompiled() && views.some((v) => v.authed) && !cfg.autoStartAsked &&
            !(await autoStartEnabled()),
          update: up,
          updating: upState,
          updatePrompt: { show: up.available && times < 2, times, second: times === 1 },
          ...snap,
        });
      }

      if (p === "/api/log") return json({ lines: await tailLog(80) });

      /* ---------------- 공통 설정 ---------------- */
      if (p === "/api/settings" && req.method === "POST") {
        const patch = await req.json();
        const cfg = await loadConfig(true);
        if (typeof patch.baseDir === "string" && patch.baseDir.trim()) cfg.baseDir = patch.baseDir.trim();
        if (patch.pollSeconds !== undefined) cfg.pollSeconds = clamp(patch.pollSeconds, 2, 3600, 5);
        if (patch.stableChecks !== undefined) cfg.stableChecks = clamp(patch.stableChecks, 1, 60, 3);
        if (patch.notifications !== undefined) cfg.notifications = !!patch.notifications;
        if (typeof patch.browser === "string") cfg.browser = patch.browser.trim();
        await saveConfig(cfg);
        await engine.reloadConfig();
        await engine.ensureDirs();
        return json({ ok: true });
      }

      if (p === "/api/defaults") {
        const d = await desktopDir();
        return json({ desktop: d, suggested: join(d, "업로드대기") });
      }

      /* ---------------- 채널 ---------------- */
      if (p === "/api/channel/add" && req.method === "POST") {
        const { name, clientId, clientSecret, sharesWith, folder } = await req.json();
        const cfg = await loadConfig(true);
        const nm = String(name ?? "").trim();
        if (!nm) return json({ error: "채널 이름을 입력해 주세요." }, 400);
        if (cfg.channels.some((c) => c.name === nm)) {
          return json({ error: "같은 이름의 채널이 이미 있습니다." }, 400);
        }
        const share = String(sharesWith ?? "").trim();
        const cid = String(clientId ?? "").trim();
        const sec = String(clientSecret ?? "").trim();
        if (!share) {
          if (!cid.includes("apps.googleusercontent.com")) {
            return json({ error: "클라이언트 ID 형식이 올바르지 않습니다. (....apps.googleusercontent.com)" }, 400);
          }
          if (!sec) return json({ error: "클라이언트 보안 비밀번호를 입력해 주세요." }, 400);
        } else if (!cfg.channels.some((c) => c.id === share)) {
          return json({ error: "같이 쓸 채널을 찾을 수 없습니다." }, 400);
        }

        const ch: Channel = {
          ...structuredClone(CHANNEL_DEFAULTS),
          id: newChannelId(),
          name: nm,
          folder: String(folder ?? "").trim() || join(cfg.baseDir, safeFolderName(nm)),
          clientId: share ? "" : cid,
          clientSecret: share ? "" : sec,
          sharesWith: share,
          enabled: true,
          createdAt: new Date().toISOString(),
        };
        cfg.channels.push(ch);
        await saveConfig(cfg);
        await engine.reloadConfig();
        await engine.ensureDirs();
        await log(`➕ 채널 추가: ${ch.name} → ${ch.folder}`);
        return json({ ok: true, id: ch.id });
      }

      if (p === "/api/channel/update" && req.method === "POST") {
        const patch = await req.json();
        const cfg = await loadConfig(true);
        const ch = cfg.channels.find((c) => c.id === patch.id);
        if (!ch) return json({ error: "채널을 찾을 수 없습니다." }, 404);

        if (typeof patch.name === "string" && patch.name.trim()) {
          const nm = patch.name.trim();
          if (cfg.channels.some((c) => c.id !== ch.id && c.name === nm)) {
            return json({ error: "같은 이름의 채널이 이미 있습니다." }, 400);
          }
          ch.name = nm;
        }
        if (typeof patch.folder === "string" && patch.folder.trim()) ch.folder = patch.folder.trim();
        if (typeof patch.clientId === "string") ch.clientId = patch.clientId.trim();
        if (typeof patch.clientSecret === "string" && patch.clientSecret !== "********") {
          ch.clientSecret = patch.clientSecret.trim();
        }
        if (typeof patch.sharesWith === "string") {
          const s = patch.sharesWith.trim();
          if (s && s === ch.id) return json({ error: "자기 자신과는 공유할 수 없습니다." }, 400);
          if (s && !cfg.channels.some((c) => c.id === s)) {
            return json({ error: "같이 쓸 채널을 찾을 수 없습니다." }, 400);
          }
          ch.sharesWith = s;
        }
        for (const k of ["privacy", "categoryId", "language", "description", "titlePrefix",
          "titleSuffix", "afterUpload", "studioAfter"] as const) {
          if (typeof patch[k] === "string") (ch[k] as string) = patch[k];
        }
        for (const k of ["madeForKids", "notifySubscribers", "reviewMode", "enabled"] as const) {
          if (patch[k] !== undefined) (ch[k] as boolean) = !!patch[k];
        }
        if (patch.dailyLimit !== undefined) ch.dailyLimit = clamp(patch.dailyLimit, 1, 50, 6);
        if (Array.isArray(patch.tags)) ch.tags = patch.tags;
        else if (typeof patch.tags === "string") {
          ch.tags = patch.tags.split(",").map((s: string) => s.trim()).filter(Boolean);
        }
        await saveConfig(cfg);
        await engine.reloadConfig();
        await engine.ensureDirs();
        return json({ ok: true });
      }

      if (p === "/api/channel/remove" && req.method === "POST") {
        const { id } = await req.json();
        const cfg = await loadConfig(true);
        const ch = cfg.channels.find((c) => c.id === id);
        if (!ch) return json({ error: "채널을 찾을 수 없습니다." }, 404);
        const dependents = cfg.channels.filter((c) => c.sharesWith === ch.id);
        if (dependents.length) {
          return json({
            error: `${dependents.map((c) => c.name).join(", ")} 채널이 이 채널의 구글 설정을 같이 쓰고 있습니다. 그 채널들을 먼저 정리해 주세요.`,
          }, 400);
        }
        cfg.channels = cfg.channels.filter((c) => c.id !== id);
        await saveConfig(cfg);
        await revoke(id);
        await clearTokens(id);
        await engine.reloadConfig();
        await log(`➖ 채널 삭제: ${ch.name} (폴더와 파일은 그대로 둡니다)`);
        return json({ ok: true });
      }

      if (p === "/api/channel/auth/url" && req.method === "POST") {
        const { id } = await req.json();
        const cfg = await loadConfig(true);
        const ch = cfg.channels.find((c) => c.id === id);
        if (!ch) return json({ error: "채널을 찾을 수 없습니다." }, 404);
        if (!credsOf(cfg, ch).clientId) {
          return json({ error: "이 채널의 클라이언트 ID와 보안 비밀번호를 먼저 저장해 주세요." }, 400);
        }
        try {
          return json({ url: await authUrl(cfg, ch) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }

      if (p === "/api/channel/auth/check" && req.method === "POST") {
        const { id } = await req.json();
        const cfg = await loadConfig(true);
        const ch = cfg.channels.find((c) => c.id === id);
        if (!ch) return json({ error: "채널을 찾을 수 없습니다." }, 404);
        const tok = await loadTokens(ch.id);
        if (!tok) return json({ error: "먼저 구글 계정을 연결해 주세요." }, 400);
        try { tok.access_token = await accessToken(cfg, ch); } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
        const t = await checkChannel(ch.id, tok);
        if (t.channelError) return json({ ok: false, error: t.channelError, url: t.channelErrorUrl });
        engine.blocks.delete(ch.id);
        return json({ ok: true, youtube: t.channel });
      }

      if (p === "/api/channel/auth/logout" && req.method === "POST") {
        const { id } = await req.json();
        await revoke(id);
        await clearTokens(id);
        await log("🚪 채널 연결 해제");
        return json({ ok: true });
      }

      if (p === "/api/channel/pickfolder" && req.method === "POST") {
        const { id } = await req.json();
        const cfg = await loadConfig(true);
        const ch = cfg.channels.find((c) => c.id === id);
        const picked = await pickFolder(ch?.folder ?? cfg.baseDir);
        return json({ path: picked });
      }

      if (p === "/api/channel/openfolder" && req.method === "POST") {
        const { id } = await req.json();
        const cfg = await loadConfig(true);
        const ch = cfg.channels.find((c) => c.id === id);
        const target = ch?.folder ?? cfg.baseDir;
        try { await Deno.mkdir(target, { recursive: true }); } catch { /* 무시 */ }
        await openPath(target);
        return json({ ok: true });
      }

      /* ---------------- 로그인 콜백 ---------------- */
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
          const cfg = await loadConfig(true);
          const { channel, tokens } = await exchange(cfg, code, st);
          await engine.reloadConfig();
          if (tokens.channelError) {
            return page("설정이 하나 남았습니다", `
              <h2 style="color:#f0b429">⚠️ 로그인은 됐지만 설정이 하나 남았습니다</h2>
              <p style="color:#ededf4;font-size:15px">${esc(channel.name)}</p>
              <p style="color:#8e8ea8;max-width:560px;margin:14px auto;line-height:1.8">${esc(tokens.channelError)}</p>
              ${tokens.channelErrorUrl ? `<p><a href="${esc(tokens.channelErrorUrl)}" target="_blank"
                 style="display:inline-block;margin-top:8px;padding:10px 18px;border-radius:8px;background:#4c8dff;color:#fff;text-decoration:none;font-weight:600">🔗 구글 설정 화면 열기</a></p>` : ""}
              <p style="color:#5a5a72;font-size:13px;margin-top:22px">처리한 뒤 앱 화면에서 <b>연결 점검</b> 을 눌러주세요.</p>`);
          }
          return page("연결 완료", `<h2 style="color:#2dd4a8">✅ 연결되었습니다</h2>
            <p style="color:#ededf4;font-size:18px">${esc(channel.name)} · ${esc(tokens.channel?.title ?? "")}</p>
            <p style="color:#5a5a72;font-size:13px">이 창을 닫고 앱으로 돌아가세요.</p>
            <script>setTimeout(()=>window.close(),2500)</script>`);
        } catch (e) {
          return page("인증 실패", `<h2 style="color:#ff4466">❌ 인증에 실패했습니다</h2>
            <p style="color:#8e8ea8;max-width:520px;margin:0 auto;line-height:1.7">${esc(e instanceof Error ? e.message : String(e))}</p>`);
        }
      }

      /* ---------------- 대기 항목 ---------------- */
      if (p === "/api/item/meta" && req.method === "POST") {
        const { key, title, description } = await req.json();
        const it = engine.pending.get(key);
        if (!it) return json({ error: "항목을 찾을 수 없습니다." }, 404);
        if (typeof title === "string") it.title = title.slice(0, 100);
        if (typeof description === "string") it.description = description.slice(0, 5000);
        return json({ ok: true });
      }

      if (p === "/api/item/upload" && req.method === "POST") {
        const { key } = await req.json();
        const it = engine.pending.get(key);
        if (!it) return json({ error: "항목을 찾을 수 없습니다." }, 404);
        if (engine.uploadingKey) return json({ error: "다른 업로드가 진행 중입니다." }, 409);
        if (!it.title.trim()) return json({ error: "제목을 입력해 주세요." }, 400);
        engine.uploadOne(it);
        return json({ ok: true });
      }

      if (p === "/api/item/hold" && req.method === "POST") {
        const { key } = await req.json();
        return json({ ok: await engine.hold(key) });
      }

      /* ---------------- 화면에 끌어다 놓은 파일 ---------------- */
      if (p === "/api/drop" && req.method === "POST") {
        const raw = req.headers.get("x-filename") ?? "";
        const want = (req.headers.get("x-channel") ?? "").trim();   // 쉼표로 여러 개, "*" 는 전체
        const name = decodeURIComponent(raw).replace(/[/\\]/g, "_").trim();
        if (!name) return json({ error: "파일 이름을 읽지 못했습니다." }, 400);
        if (!req.body) return json({ error: "파일 내용이 비어 있습니다." }, 400);

        const cfg = engine.cfg;
        const enabled = cfg.channels.filter((c) => c.enabled);
        if (!enabled.length) return json({ error: "먼저 채널을 하나 만들어 주세요." }, 400);

        let targets: Channel[];
        if (want === "*") targets = enabled;
        else {
          const ids = want.split(",").map((x) => x.trim()).filter(Boolean);
          targets = ids.length
            ? enabled.filter((c) => ids.includes(c.id))
            : [enabled[0]];
          if (!targets.length) targets = [enabled[0]];
        }

        await engine.ensureDirs();

        // 여러 채널로 보낼 수 있으므로 먼저 임시 파일로 받아 둔다
        const tmp = await Deno.makeTempFile({ prefix: "garasadae_drop_" });
        try {
          const f = await Deno.open(tmp, { write: true, truncate: true });
          await req.body.pipeTo(f.writable);
        } catch (e) {
          try { await Deno.remove(tmp); } catch { /* 무시 */ }
          return json({ error: `파일을 받지 못했습니다: ${e instanceof Error ? e.message : e}` }, 500);
        }

        const dot = name.lastIndexOf(".");
        const [base, ext2] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
        const sent: string[] = [];
        for (const ch of targets) {
          try {
            let dest = join(ch.folder, name);
            let i = 1;
            while (await fileExists(dest)) dest = join(ch.folder, `${base} (${i++})${ext2}`);
            // 아직 쓰는 중인 파일로 오인하지 않도록 임시 이름으로 놓고 옮긴다
            const part = dest + ".part";
            await Deno.copyFile(tmp, part);
            await Deno.rename(part, dest);
            sent.push(ch.name);
          } catch (e) {
            await log(`⚠️  [${ch.name}] 파일을 넣지 못했습니다: ${e instanceof Error ? e.message : e}`);
          }
        }
        try { await Deno.remove(tmp); } catch { /* 무시 */ }
        if (!sent.length) return json({ error: "파일을 넣지 못했습니다." }, 500);
        await log(`📥 화면에서 받은 파일: ${name} → ${sent.join(", ")}`);
        return json({ ok: true, channels: sent });
      }

      /* ---------------- 의견 ---------------- */
      if (p === "/api/feedback" && req.method === "POST") {
        const { kind, title, body } = await req.json();
        const t = String(title ?? "").trim().slice(0, 120);
        const b = String(body ?? "").trim().slice(0, 4000);
        if (!t) return json({ error: "제목을 입력해 주세요." }, 400);
        if (!b) return json({ error: "내용을 입력해 주세요." }, 400);

        const kindLabel: Record<string, string> = {
          bug: "🐞 오류 신고", idea: "💡 기능 요청", etc: "💬 기타 의견",
        };
        const label = kindLabel[kind] ?? kindLabel.etc;
        const os = IS_WIN ? "윈도우" : IS_MAC ? "맥" : "리눅스";
        const when = new Date().toLocaleString("ko-KR");

        let saved = "";
        try {
          const f = join(await desktopDir(), "가라사대_피드백.txt");
          let prev = "";
          try { prev = await Deno.readTextFile(f); } catch { /* 처음이면 없음 */ }
          const n = (prev.match(/^\d+\. /gm) ?? []).length + 1;
          const entry = `${n}. [${label}] ${t}\n` +
            `   보낸 때 : ${when}\n` +
            `   환경    : ${os} · 프로그램 ${APP_VERSION}\n` +
            `   내용    : ${b.split("\n").join("\n             ")}\n\n`;
          const head = prev ? "" : "가라사대 업로더 — 보낸 의견 모음\n" + "=".repeat(40) + "\n\n";
          await Deno.writeTextFile(f, head + prev + entry);
          saved = f;
        } catch (e) {
          await log(`⚠️  의견을 파일로 저장하지 못했습니다: ${e instanceof Error ? e.message : e}`);
        }

        const issueBody = `${b}\n\n---\n환경: ${os} · 프로그램 ${APP_VERSION}\n보낸 때: ${when}`;
        const issueUrl = `https://github.com/${REPO}/issues/new?` + new URLSearchParams({
          title: `[${label.replace(/^\S+\s/, "")}] ${t}`,
          body: issueBody,
        });
        await log(`💬 의견 접수: ${t}`);
        return json({ ok: true, url: issueUrl, saved });
      }

      if (p === "/api/openself" && req.method === "POST") {
        const cfg = await loadConfig(true);
        await openUrl(`http://127.0.0.1:${cfg.port}`, cfg.browser);
        return json({ ok: true });
      }

      if (p === "/api/broadcast/send" && req.method === "POST") {
        const { names, channels } = await req.json();
        const list: string[] = Array.isArray(names) ? names : [];
        if (!list.length) return json({ error: "보낼 영상을 골라 주세요." }, 400);
        const ids: string[] = Array.isArray(channels) ? channels : [];
        const r = await engine.sendBroadcast(list, ids);
        if (!r.sent.length) return json({ error: "보내지 못했습니다. 채널을 골랐는지 확인해 주세요." }, 400);
        return json({ ok: true, ...r });
      }

      if (p === "/api/broadcast/hold" && req.method === "POST") {
        const { names } = await req.json();
        await engine.holdBroadcast(Array.isArray(names) ? names : []);
        return json({ ok: true });
      }

      if (p === "/api/openbroadcast" && req.method === "POST") {
        const dir = engine.broadcastDir();
        if (!dir || !engine.useBroadcast()) {
          return json({ error: "채널이 둘 이상일 때 쓸 수 있습니다." }, 400);
        }
        try { await Deno.mkdir(dir, { recursive: true }); } catch { /* 무시 */ }
        await openPath(dir);
        return json({ ok: true });
      }

      if (p === "/api/openfeedback" && req.method === "POST") {
        const f = join(await desktopDir(), "가라사대_피드백.txt");
        try { await Deno.stat(f); } catch {
          return json({ error: "아직 보낸 의견이 없습니다." }, 404);
        }
        await openPath(f);
        return json({ ok: true });
      }

      /* ---------------- 음악 팝업 ---------------- */
      if (p === "/api/ask/answer" && req.method === "POST") {
        const { open, remember, channelId } = await req.json();
        const target = engine.ask;
        engine.ask = null;
        if (open && target) await openUrl(studioEditorUrl(target.id), engine.cfg.browser);
        if (remember === "always" || remember === "never") {
          const cfg = await loadConfig(true);
          const ch = cfg.channels.find((c) => c.id === channelId) ??
            cfg.channels.find((c) => c.name === target?.channelName);
          if (ch) ch.studioAfter = remember;
          else for (const c of cfg.channels) c.studioAfter = remember;
          await saveConfig(cfg);
          await engine.reloadConfig();
        }
        return json({ ok: true });
      }

      /* ---------------- 업데이트 ---------------- */
      if (p === "/api/update/check" && req.method === "POST") return json(await checkUpdate(true));

      if (p === "/api/update/decline" && req.method === "POST") {
        const info = await checkUpdate(false);
        if (!info.version) return json({ ok: true });
        const cfg = await loadConfig(true);
        const n = (cfg.updateDeclines[info.version] ?? 0) + 1;
        cfg.updateDeclines = { [info.version]: n };
        await saveConfig(cfg);
        await engine.reloadConfig();
        await log(`🔕 업데이트 ${info.version} 거절 (${n}번째)${n >= 2 ? " — 이 버전은 다시 묻지 않습니다" : ""}`);
        return json({ ok: true, times: n });
      }

      if (p === "/api/update/install" && req.method === "POST") {
        if (upState.running) return json({ error: "이미 업데이트를 진행 중입니다." }, 409);
        const info: UpdateInfo = await checkUpdate(true);
        if (!info.available) return json({ error: "이미 최신 버전입니다." }, 400);
        if (!info.canInstall) return json({ error: info.reason || "이 상태에서는 자동 설치할 수 없습니다.", page: info.page }, 400);
        if (engine.uploadingKey) return json({ error: "업로드가 진행 중입니다. 끝난 뒤에 다시 눌러 주세요." }, 409);

        upState = { running: true, pct: 0, text: "준비 중…", error: "" };
        installUpdate(info, (pct, text) => { upState.pct = pct; upState.text = text; })
          .catch(async (e) => {
            upState = { running: false, pct: 0, text: "", error: e instanceof Error ? e.message : String(e) };
            await log(`⚠️  업데이트 실패: ${upState.error}`);
          });
        return json({ ok: true });
      }

      /* ---------------- 기타 ---------------- */
      if (p === "/api/autostart" && req.method === "POST") {
        const { on, asked } = await req.json();
        const m = await setAutoStart(!!on);
        const cfg = await loadConfig(true);
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

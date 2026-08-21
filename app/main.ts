// 가라사대 업로더 — 진입점
import { APP_NAME, APP_VERSION, dataDir, ensureDataDir, loadConfig, log, saveConfig } from "./paths.ts";
import { Manager } from "./watcher.ts";
import { autoUpdateOnStart, startServer } from "./server.ts";
import { openUrl, 쓰던탭에다시 } from "./platform.ts";

const VERSION = APP_VERSION;

async function main() {
  const args = new Set(Deno.args);
  const background = args.has("--background") || args.has("-b");

  await ensureDataDir();
  const cfg = await loadConfig();
  await saveConfig(cfg);                       // 첫 실행 시 기본 설정 파일 생성

  // 포트가 이미 쓰이고 있다면, 우리 프로그램인지 다른 프로그램인지 가려낸다
  if (await portBusy(cfg.port)) {
    if (await isOurApp(cfg.port)) {
      // ★이미 돌고 있는데 또 눌렀다 = **화면을 보고 싶다는 뜻**이다.
      //   끼움 화면(소재국 …)이 있으면 그 첫 번째로 곧장 연다 — 검토·승인이
      //   거기 있어서 다시 누르는 것이지, 감시 목록을 보려는 것이 아니다
      //   (사용자 지시 2026-08-21: "재접속 누르면 바로 소재국으로 바로 열리게").
      const 첫끼움 = cfg.panels?.[0]?.name ?? "";
      const url = `http://127.0.0.1:${cfg.port}` +
        (첫끼움 ? "#" + encodeURIComponent(첫끼움) : "");
      console.log(`${APP_NAME} 가 이미 실행 중입니다 → ${url}`);
      // ★**새 탭을 또 만들지 않는다.** 이미 열려 있는 우리 탭이 있으면 그 자리에서
      //   다시 불러온다(사용자 지시 2026-08-21). 못 찾으면 그때만 새로 연다.
      if (!background) {
        const 밑 = `http://127.0.0.1:${cfg.port}`;
        if (!await 쓰던탭에다시(밑, url, cfg.browser)) await openUrl(url, cfg.browser);
      }
      Deno.exit(0);
    }
    // 다른 프로그램이 쓰는 중 → 빈 포트를 찾아 옮긴다
    const free = await findFreePort(cfg.port + 1, 30);
    if (!free) {
      await fatal(`${cfg.port} 번을 포함해 쓸 수 있는 통신 포트를 찾지 못했습니다.\n` +
        `보안 프로그램이 막고 있을 수 있습니다.`, background);
      return;
    }
    await log(`⚠️  ${cfg.port} 번을 다른 프로그램이 쓰고 있어 ${free} 번으로 옮깁니다`);
    cfg.port = free;
    await saveConfig(cfg);
  }

  const url = `http://127.0.0.1:${cfg.port}`;

  const engine = new Manager();
  await engine.init();

  startServer(engine, cfg.port);

  // 감시 폴더 만들기는 화면을 띄운 뒤에 한다.
  // 맥에서는 "데스크탑 폴더에 접근하려고 합니다" 권한 창이 뜨는데,
  // 사용자가 답할 때까지 멈추기 때문에 이걸 먼저 하면 화면이 안 열린다.
  engine.ensureDirs();

  console.log(`
┌───────────────────────────────────────────────
│  ${APP_NAME} v${VERSION}
│  화면    ${url}
│  채널    ${cfg.channels.length}개${cfg.channels.length ? " · " + cfg.channels.map((c) => c.name).join(", ") : " (시작하기 탭에서 추가하세요)"}
│  폴더    ${cfg.baseDir}
│  설정    ${dataDir()}
│  ${background ? "백그라운드 모드로 실행 중입니다." : "이 창을 닫으면 자동 업로드가 멈춥니다."}
└───────────────────────────────────────────────`);
  await log(`▶️  ${APP_NAME} v${VERSION} 시작 (${background ? "백그라운드" : "일반"})`);

  // 껐다 켠 뒤에도 옛 탭이 떠 있을 수 있다 — 그 자리에서 다시 불러 준다
  if (!background && !await 쓰던탭에다시(url, url, cfg.browser)) {
    await openUrl(url, cfg.browser);
  }

  // 켠 직후 새 버전이 있으면 묻지 않고 받는다 (화면에는 진행 막대가 보인다)
  autoUpdateOnStart(engine);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, () => {
        console.log("\n종료합니다…");
        engine.halt();
        Deno.exit(0);
      });
    } catch { /* 윈도우에서 미지원인 신호는 무시 */ }
  }

  await engine.loop();
}

async function portBusy(port: number): Promise<boolean> {
  try {
    const l = Deno.listen({ port, hostname: "127.0.0.1" });
    l.close();
    return false;
  } catch {
    return true;
  }
}

/** 그 포트를 쓰는 게 우리 프로그램인지 확인한다. */
async function isOurApp(port: number): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const j = await r.json();
    return j?.app === APP_NAME;
  } catch {
    return false;
  }
}

async function findFreePort(from: number, tries: number): Promise<number | null> {
  for (let p = from; p < from + tries; p++) {
    if (!(await portBusy(p))) return p;
  }
  return null;
}

/** 치명적 오류를 사용자가 읽을 수 있게 보여주고 끝낸다. */
async function fatal(message: string, background: boolean) {
  await log(`💥 ${message}`);
  console.error(`\n────────────────────────────────────\n  ${APP_NAME} 를 시작할 수 없습니다\n────────────────────────────────────\n${message}\n`);
  if (!background) {
    console.error("이 창을 닫으려면 Enter 를 누르세요.");
    try { await readLine(); } catch { /* 입력을 받을 수 없는 환경 */ }
  }
  Deno.exit(1);
}

async function readLine(): Promise<void> {
  const buf = new Uint8Array(64);
  await Deno.stdin.read(buf);
}

if (import.meta.main) {
  main().catch(async (e) => {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    await log(`💥 시작 실패: ${msg}`);
    console.error(`\n────────────────────────────────────\n  ${APP_NAME} 를 시작할 수 없습니다\n────────────────────────────────────\n${msg}\n`);
    if (!Deno.args.includes("--background")) {
      console.error("이 창을 닫으려면 Enter 를 누르세요.");
      try { const b = new Uint8Array(64); await Deno.stdin.read(b); } catch { /* 무시 */ }
    }
    Deno.exit(1);
  });
}

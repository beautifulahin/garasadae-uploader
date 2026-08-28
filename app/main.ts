// 가라사대 업로더 — 진입점
import { APP_NAME, APP_VERSION, dataDir, ensureDataDir, loadConfig, log, saveConfig, 도는포트정하기 } from "./paths.ts";
import { Manager } from "./watcher.ts";
import { 텔레그램설정 } from "./platform.ts";
import { autoUpdateOnStart, startServer } from "./server.ts";
import { openUrl, 쓰던탭에다시 } from "./platform.ts";

const VERSION = APP_VERSION;

async function main() {
  const args = new Set(Deno.args);
  const background = args.has("--background") || args.has("-b");

  await ensureDataDir();
  const cfg = await loadConfig();
  텔레그램설정(cfg.telegramAlerts);   // 막힌 소식을 텔레그램으로도 보낼지
  await saveConfig(cfg);                       // 첫 실행 시 기본 설정 파일 생성

  /* ── 통신 자리(포트) 잡기 ─────────────────────────────────────
     ★공개판 신고 #1 (2026-08-21, 윈도우): "127.0.0.1에서 연결을 거부했습니다" 가
       **지속적으로** 떴다. 프로그램은 멀쩡히 돌고 있는데 사람이 보는 주소만 죽어
       있었던 것으로 본다. 뿌리는 둘이었다.
       ① 자리를 한 번 옮기면 그 자리가 **설정에 그대로 굳어** 다음부터도 8777 이
          아니었다. 안내문·오류사전은 전부 8777 이라 사람은 영영 못 들어간다.
          업데이트 뒤 다시 켤 때가 특히 그렇다 — 방금 꺼진 판이 자리를 아직
          놓지 않아 잠깐 차 있고, 그 순간 옆자리로 옮겨 굳어 버린다.
       ② 옮겨 간 뒤 다시 실행하면 8777 은 비어 있으니 "이미 도는 판"을 못 찾고
          **두 번째 판**이 떠 버린다. 같은 영상이 두 번 올라갈 수 있는 자리다.
     그래서 ⓐ 늘 기본 자리(8777)부터 되찾아 보고, ⓑ 원하던 자리는 곧바로
     포기하지 않고 잠깐 기다렸다 다시 보고, ⓒ 도는 판은 이웃 자리까지 뒤진다. */
  const 원하는자리 = cfg.port;   // 설정에 적힌 자리. 비켜 가더라도 여기에 굳히지 않는다.

  // 이미 우리 프로그램이 돌고 있나 — 옮겨 가 있을 수 있으니 이웃 자리까지 본다
  const 도는곳 = await 도는우리앱(원하는자리, 30);
  if (도는곳 !== null) {
    // ★이미 돌고 있는데 또 눌렀다 = **화면을 보고 싶다는 뜻**이다.
    const url = `http://127.0.0.1:${도는곳}`;
    console.log(`${APP_NAME} 가 이미 실행 중입니다 → ${url}`);
    // ★**새 탭을 또 만들지 않는다.** 이미 열려 있는 우리 탭이 있으면 그 자리에서
    //   다시 불러온다(사용자 지시 2026-08-21). 못 찾으면 그때만 새로 연다.
    if (!background) {
      if (!await 쓰던탭에다시(url, url, cfg.browser)) await openUrl(url, cfg.browser);
    }
    Deno.exit(0);
  }

  const 자리 = await 자리잡기(원하는자리);
  if (자리 === null) {
    await fatal(`${원하는자리} 번을 포함해 쓸 수 있는 통신 포트를 찾지 못했습니다.\n` +
      `보안 프로그램이 막고 있을 수 있습니다.`, background);
    return;
  }
  if (자리 !== 원하는자리) {
    await log(`⚠️  ${원하는자리} 번을 다른 프로그램이 쓰고 있어 이번에는 ${자리} 번으로 갑니다 — `
      + `화면 주소는 http://127.0.0.1:${자리} 입니다. 다음에 켤 때 ${원하는자리} 번이 비어 있으면 `
      + `그리로 돌아갑니다.`);
  }
  // 이번 실행 동안만 갈아 끼운다 (설정 파일에는 원하는 자리가 그대로 남는다)
  도는포트정하기(자리);
  cfg.port = 자리;

  const url = `http://127.0.0.1:${cfg.port}`;

  const engine = new Manager();
  await engine.init();

  startServer(engine, cfg.port);

  // 감시 폴더 만들기는 화면을 띄운 뒤에 한다.
  // 맥에서는 "데스크탑 폴더에 접근하려고 합니다" 권한 창이 뜨는데,
  // 사용자가 답할 때까지 멈추기 때문에 이걸 먼저 하면 화면이 안 열린다.
  engine.ensureDirs().catch(() => {});     // 넘어져도 프로그램까지 끝나지는 않게

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

/** 돌고 있는 우리 프로그램의 자리를 찾는다. 없으면 null.
 *  ★옮겨 가 있을 수 있으니 이웃 자리까지 본다. 비어 있는 자리는 두드리지 않는다. */
async function 도는우리앱(원하는자리: number, 폭: number): Promise<number | null> {
  for (let p = 원하는자리; p < 원하는자리 + 폭; p++) {
    if (!await portBusy(p)) continue;      // 비어 있으면 두드릴 것도 없다
    if (await isOurApp(p)) return p;
  }
  return null;
}

/** 설 자리를 고른다. 원하던 자리는 곧바로 포기하지 않는다.
 *  ★업데이트 뒤 다시 켤 때 방금 꺼진 판이 자리를 아직 놓는 중일 수 있다. */
async function 자리잡기(원하는자리: number): Promise<number | null> {
  for (let i = 0; i < 4; i++) {
    if (!await portBusy(원하는자리)) return 원하는자리;
    if (i < 3) await new Promise((r) => setTimeout(r, 400));
  }
  return await findFreePort(원하는자리 + 1, 30);
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

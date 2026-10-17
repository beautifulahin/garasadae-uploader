// 가라사대 업로더 — 진입점
//
//   GarasadaeUploader                 화면 서버를 띄우고 브라우저를 연다 (이미 돌고 있으면 그 화면만 연다)
//   GarasadaeUploader --background    화면 없이 서버만 (자동 시작이 부른다)
//   GarasadaeUploader 심사확인         10분마다 도는 점검 한 번 (자동 시작이 부른다)
//   GarasadaeUploader <명령> …         한글 명령줄 (cli.ts — 올려 · 공개 · 문제 · 설정 · 인증 …)
//
// 켤 때마다 가장 먼저: 옮길 옛 판(v1.x) 자료가 있으면 복사본을 떠 두고 새 판으로 옮긴 뒤 하나씩 확인한다(migrate.ts).
//   화면 서버·심사확인·명령줄이 모두 같은 잠금을 지나므로 동시에 켜져도 한 번만 옮긴다. 확인이 안 되면 새 판은 올리기·공개를 멈춘 채 켜지고,
//   화면의 문제 목록에 빨간 줄과 「다시 옮기기」가 뜬다(hold.ts) — 옛 자료는 그대로 살아 있다.
import { APP_NAME, APP_VERSION, dataDir, ensureDataDir, log } from "./paths.ts";
import * as SG from "./settings.ts";
import { startServer } from "./server.ts";
import { runCli } from "./cli.ts";
import { ensureMigrated, formatReport } from "./migrate.ts";
import { autoStartStatus, openUrl, reuseBrowserTab, setAutoStart } from "./platform.ts";
import { setTelegramAlerts } from "./notify.ts";
import { loadChannels } from "./channels.ts";

/* ============================================================ 통신 자리(포트) */

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

/**
 * 돌고 있는 우리 프로그램의 자리를 찾는다. 없으면 null.
 * ★옮겨 가 있을 수 있으니 이웃 자리까지 본다. 비어 있는 자리는 두드리지 않는다.
 */
async function 도는우리앱(원하는자리: number, 폭: number): Promise<number | null> {
  for (let p = 원하는자리; p < 원하는자리 + 폭; p++) {
    if (!await portBusy(p)) continue;
    if (await isOurApp(p)) return p;
  }
  return null;
}

/**
 * 설 자리를 고른다. 원하던 자리는 곧바로 포기하지 않는다.
 * ★업데이트 뒤 다시 켤 때 방금 꺼진 판이 자리를 아직 놓는 중일 수 있다.
 * ★옆자리로 비켜 가도 설정에 굳히지 않는다(굳히면 다음부터도 8777 이 아니게 되어 안내문의 주소로 못 들어간다) — 이번 실행 동안만이다.
 */
async function 자리잡기(원하는자리: number): Promise<number | null> {
  for (let i = 0; i < 4; i++) {
    if (!await portBusy(원하는자리)) return 원하는자리;
    if (i < 3) await new Promise((r) => setTimeout(r, 400));
  }
  return await findFreePort(원하는자리 + 1, 30);
}

/* ============================================================ 시작 */

/** 어느 길로 켜든 먼저 하는 준비 */
async function boot() {
  await ensureDataDir();
  try { setTelegramAlerts(SG.appSettings().telegramAlerts); } catch { /* 기본값 */ }
}

/** 옛 판 자료 이행 — 끝났거나 옮길 것이 없으면 조용히 지나간다. 했으면 보고를 기록과 화면(콘솔)에 남긴다. */
async function migrateFirst(quiet = false): Promise<void> {
  try {
    const rep = await ensureMigrated(quiet ? () => {} : undefined);
    if (!rep) return;
    for (const l of formatReport(rep)) { if (!quiet) console.log(l); await log(l); }
  } catch (e) {
    await log(`⚠️  옛 판 자료 이행을 확인하지 못했습니다 — ${(e as Error).message.split("\n")[0]}`);
  }
}

/**
 * 옛 판(v1)이 만든 자동 시작(서버 하나)만 있으면 새 판의 작업 둘(서버 + 10분마다 심사확인)로 올린다 — 자동 업데이트된 사람도 심사확인이 돌게.
 * 이미 새 작업이 있거나, 사람이 자동 시작을 안 켰으면 아무것도 안 한다. 이 프로세스를 띄운 작업은 platform.ts 가 내리지 않는다.
 */
async function upgradeLegacyAutoStart() {
  try {
    const st = await autoStartStatus();
    if (!st.supported || !st.serve || st.tick) return;
    const msg = await setAutoStart(true);
    await log(`🔁 옛 판의 자동 시작을 새 방식(작업 둘)으로 올렸습니다 — ${msg.split("\n")[0]}`);
  } catch (e) {
    await log(`(옛 자동 시작을 새 방식으로 올리지 못했습니다 — ${(e as Error).message.split("\n")[0]})`);
  }
}

async function serve(background: boolean) {
  await migrateFirst(background);

  const s = SG.appSettings();
  const 원하는자리 = s.port;

  // 이미 우리 프로그램이 돌고 있나 — 옮겨 가 있을 수 있으니 이웃 자리까지 본다
  const 도는곳 = await 도는우리앱(원하는자리, 30);
  if (도는곳 !== null) {
    // ★이미 돌고 있는데 또 눌렀다 = **화면을 보고 싶다는 뜻**이다. 새 탭을 또 만들지 않고 열려 있는 탭을 다시 불러온다.
    const url = `http://127.0.0.1:${도는곳}`;
    console.log(`${APP_NAME} 가 이미 실행 중입니다 → ${url}`);
    if (!background && !await reuseBrowserTab(url, url, s.browser)) await openUrl(url, s.browser);
    Deno.exit(0);
  }

  const 자리 = await 자리잡기(원하는자리);
  if (자리 === null) {
    await fatal(`${원하는자리} 번을 포함해 쓸 수 있는 통신 포트를 찾지 못했습니다.\n보안 프로그램이 막고 있을 수 있습니다.`, background);
    return;
  }
  if (자리 !== 원하는자리) {
    await log(`⚠️  ${원하는자리} 번을 다른 프로그램이 쓰고 있어 이번에는 ${자리} 번으로 갑니다 — 화면 주소는 http://127.0.0.1:${자리} 입니다. 다음에 켤 때 ${원하는자리} 번이 비어 있으면 그리로 돌아갑니다.`);
  }

  const server = await startServer({ port: 자리 });
  const url = server.url;
  const chans = loadChannels();
  const names = Object.keys(chans);

  console.log(`
┌───────────────────────────────────────────────
│  ${APP_NAME} v${APP_VERSION}
│  화면    ${url}
│  채널    ${names.length}개${names.length ? " · " + names.join(", ") : " (시작하기에서 채널을 연결하세요)"}
│  설정    ${dataDir()}
│  ${background ? "백그라운드 모드로 실행 중입니다." : "이 창을 닫으면 자동 업로드가 멈춥니다."}
└───────────────────────────────────────────────`);
  await log(`▶️  ${APP_NAME} v${APP_VERSION} 시작 (${background ? "백그라운드" : "일반"}) — ${url}`);

  // 껐다 켠 뒤에도 옛 탭이 떠 있을 수 있다 — 그 자리에서 다시 불러 준다
  if (!background && !await reuseBrowserTab(url, url, s.browser)) await openUrl(url, s.browser);

  // 옛 판 자동 시작 → 새 방식 (화면을 막지 않게 뒤에서)
  void upgradeLegacyAutoStart();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(sig, async () => {
        console.log("\n종료합니다…");
        await server.shutdown();
        Deno.exit(0);
      });
    } catch { /* 윈도우에서 미지원인 신호는 무시 */ }
  }

  await new Promise<void>(() => {}); // 서버가 끝날 때까지 (신호가 오면 위에서 끝낸다)
}

/** 치명적 오류를 사용자가 읽을 수 있게 보여주고 끝낸다. */
async function fatal(message: string, background: boolean) {
  await log(`💥 ${message}`);
  console.error(`\n────────────────────────────────────\n  ${APP_NAME} 를 시작할 수 없습니다\n────────────────────────────────────\n${message}\n`);
  if (!background) {
    console.error("이 창을 닫으려면 Enter 를 누르세요.");
    try { await Deno.stdin.read(new Uint8Array(64)); } catch { /* 입력을 받을 수 없는 환경 */ }
  }
  Deno.exit(1);
}

async function main() {
  const args = Deno.args.filter((a) => a !== "--background" && a !== "-b");
  const background = args.length !== Deno.args.length;
  await boot();

  if (args.length) {
    // 도움말·버전은 아무 준비 없이. 나머지는 옛 판 자료 이행부터 확인한 뒤 명령을 푼다.
    const quiet = ["도움말", "-h", "--help", "버전", "-v", "--version", "이행"].includes(args[0]);
    if (!quiet && args[0] !== "심사확인") await migrateFirst(false);
    const r = await runCli(args);
    if (r === null) { console.error(`알 수 없는 인자입니다: ${args.join(" ")}\n\`${APP_NAME} 도움말\` 로 명령을 볼 수 있습니다.`); Deno.exit(1); }
    if ("code" in r) Deno.exit(r.code);
    // serve: 화면 서버
  }
  await serve(background);
}

if (import.meta.main) {
  main().catch(async (e) => {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    await log(`💥 시작 실패: ${msg}`);
    console.error(`\n────────────────────────────────────\n  ${APP_NAME} 를 시작할 수 없습니다\n────────────────────────────────────\n${msg}\n`);
    if (!Deno.args.includes("--background")) {
      console.error("이 창을 닫으려면 Enter 를 누르세요.");
      try { await Deno.stdin.read(new Uint8Array(64)); } catch { /* 무시 */ }
    }
    Deno.exit(1);
  });
}

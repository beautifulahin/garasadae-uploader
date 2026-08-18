// 가라사대 업로더 — 진입점
import { APP_NAME, dataDir, ensureDataDir, loadConfig, log, saveConfig } from "./paths.ts";
import { Engine } from "./watcher.ts";
import { startServer } from "./server.ts";
import { openUrl } from "./platform.ts";

const VERSION = "1.0.0";

async function main() {
  const args = new Set(Deno.args);
  const background = args.has("--background") || args.has("-b");

  await ensureDataDir();
  const cfg = await loadConfig();
  await saveConfig(cfg);                       // 첫 실행 시 기본 설정 파일 생성

  const url = `http://127.0.0.1:${cfg.port}`;

  // 이미 실행 중이면 창만 띄우고 종료 (중복 실행 방지)
  if (await alreadyRunning(cfg.port)) {
    console.log(`${APP_NAME} 가 이미 실행 중입니다 → ${url}`);
    if (!background) await openUrl(url);
    Deno.exit(0);
  }

  const engine = new Engine();
  await engine.init();
  await engine.ensureDirs();

  startServer(engine, cfg.port);

  console.log(`
┌───────────────────────────────────────────────
│  ${APP_NAME} v${VERSION}
│  화면    ${url}
│  감시    ${cfg.watchDir}
│  설정    ${dataDir()}
│  ${background ? "백그라운드 모드로 실행 중입니다." : "이 창을 닫으면 자동 업로드가 멈춥니다."}
└───────────────────────────────────────────────`);
  await log(`▶️  ${APP_NAME} v${VERSION} 시작 (${background ? "백그라운드" : "일반"})`);

  if (!background) await openUrl(url);

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

async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const l = Deno.listen({ port, hostname: "127.0.0.1" });
    l.close();
    return false;
  } catch {
    return true;
  }
}

if (import.meta.main) {
  main().catch(async (e) => {
    await log(`💥 시작 실패: ${e instanceof Error ? e.stack ?? e.message : e}`);
    console.error(e);
    Deno.exit(1);
  });
}

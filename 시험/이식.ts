// 이식 시험 — 운영체제 도구(app/platform.ts)와 옛 판 자료 이행(app/migrate.ts).
//
// 진짜 launchd · 작업 스케줄러 · 선택창 · 클립보드 · 구글은 한 번도 안 부른다.
//   · 명령은 전부 가짜 실행기(setRunner)가 받는다. launchctl 도 schtasks 도 진짜로는 안 나간다.
//   · 자동 실행 파일은 모래상자의 가짜 집(GARASADAE_HOME) 아래에만 쓴다. 끝에서 진짜 ~/Library/LaunchAgents 가
//     그대로인지 따로 잰다(읽기만 — 이름·크기·바뀐 때).
//   · 옛 자료는 전부 가짜 값이다: 열쇠 「fake-id…」 · 「fake-secret」 · 토큰 「fake-refresh」. 채널 이름도 가짜.
//   · 토큰 갱신은 가짜 구글이 받는다. 옛 열쇠로 실제 갱신 요청이 나가는지(요청 본문의 client_id)를 가짜 서버 앞에서 잰다.
import { 같나, 결과, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import {
  allowSleep, AutoStartConflict, autoStartStatus, clipboardWrite, type CmdResult, type CmdRunner, exeArgv, exePath,
  isAwakeHeld, isCompiled, keepAwake, listBrowsers, openPath, openUrl, type Os, pickFile, pickFolder, REVIEW_LABEL,
  reuseBrowserTab, SERVE_LABEL, setAutoStart, setExeForTest, setHoldSpawner, setOsForTest, setRunner,
} from "../app/platform.ts";
import { detectOld, formatReport, migrate, type MigrationReport } from "../app/migrate.ts";
import { APP_ID, APP_NAME, dataDir, dataPath, env, exists, IS_MAC, join, readJsonSync, recordPath } from "../app/paths.ts";
import { loadChannels } from "../app/channels.ts";
import { accessToken, clientFor, forgetAccessTokens, loadStore, SCOPES_LEGACY } from "../app/ytcore.ts";
import { loadPolicies } from "../app/daily.ts";
import { migrationHold } from "../app/hold.ts";
import { appendLedger, readLedger, uploadedNames } from "../app/ledger.ts";

/* ─────────── 가짜 명령 실행기 ─────────── */

type Opts = Parameters<CmdRunner>[2];
interface Call { cmd: string; args: string[]; opts?: Opts }
type Handler = (c: Call) => Partial<CmdResult> | undefined;

function 가짜실행기(h?: Handler) {
  const calls: Call[] = [];
  const r: CmdRunner = (cmd, args, opts) => {
    const c: Call = { cmd, args, opts };
    calls.push(c);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...(h?.(c) ?? {}) });
  };
  return { calls, r };
}
const 줄 = (c: Call) => `${c.cmd} ${c.args.join(" ")}`;

async function 가짜환경(os: Os, exe: string[], h: Handler | undefined, 일: (calls: Call[]) => Promise<void>) {
  const { calls, r } = 가짜실행기(h);
  setRunner(r); setOsForTest(os); setExeForTest(exe);
  try { await 일(calls); } finally { setRunner(null); setOsForTest(null); setExeForTest(null); }
}

/* ─────────── 작은 도구 ─────────── */

const 글 = (p: string) => Deno.readTextFile(p);
const 풀기 = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
/** plist 의 ProgramArguments 글자들 */
function 인자들(t: string): string[] {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(t);
  return m ? [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => 풀기(x[1])) : [];
}
/** 맥의 plutil 로 plist 를 JSON 으로 — 진짜 plist 파서가 읽어 주는지까지 본다 (맥이 아니면 null) */
async function plist를JSON으로(path: string): Promise<Record<string, any> | null> {
  if (!IS_MAC) return null;
  try {
    const o = await new Deno.Command("plutil", { args: ["-convert", "json", "-o", "-", path], stdout: "piped", stderr: "null" }).output();
    return o.code === 0 ? JSON.parse(new TextDecoder().decode(o.stdout)) : null;
  } catch { return null; }
}
async function 해시(path: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
/** 폴더 아래 모든 파일의 내용 해시 (뿌리 기준 상대 경로) */
async function 찍기(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p); else if (e.isFile) out[p.slice(root.length)] = await 해시(p);
    }
  };
  try { await walk(root); } catch { /* 폴더가 없으면 빈 것 */ }
  return out;
}
/** 진짜 폴더의 이름·크기·바뀐 때 (읽기만) */
async function 목록찍기(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const st = await Deno.lstat(join(dir, e.name));
      out.push(`${e.name}|${st.size}|${st.mtime?.getTime() ?? 0}`);
    }
  } catch { /* 없으면 빈 것 */ }
  return out.sort();
}
const 정렬 = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(정렬)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, 정렬(x)]))
    : v;
/** 칸 순서와 상관없이 같은 값인가 */
const 같은값 = (무엇: string, 실제: unknown, 바람: unknown) => 같나(무엇, 정렬(실제), 정렬(바람));
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const UC = (c: string) => "UC" + c.repeat(22);

/* ═══════════════════════════ 1. 운영체제 도구 ═══════════════════════════ */

const 남의plist = (label: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>exec ./venv/bin/python -u server.py</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
`;

/** 옛 판(v1.8.4)이 만들던 plist 그대로 */
const 옛판plist = (앱: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${APP_ID}</string>
  <key>ProgramArguments</key>
  <array><string>${앱}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
</dict></plist>
`;

async function 맥시험() {
  구역("자동 실행 — 맥 LaunchAgent 둘 (serve · review)");
  await 모래상자(async (dir) => {
    const uid = Deno.uid() ?? 0;
    const 앱 = `${dir}/앱 & <상자>/업로드 앱.app/Contents/MacOS/GarasadaeUploader`;   // 공백·한글·XML 특수문자가 든 경로
    const LA = `${dir}/집/Library/LaunchAgents`;
    const sP = `${LA}/${SERVE_LABEL}.plist`, rP = `${LA}/${REVIEW_LABEL}.plist`;
    참인가("작업 이름은 APP_ID 에 .serve / .review 를 붙인 것", SERVE_LABEL === `${APP_ID}.serve` && REVIEW_LABEL === `${APP_ID}.review`);
    참인가("가짜 집 아래에만 쓴다 (진짜 LaunchAgents 가 아니다)", sP.startsWith(dir) && !sP.startsWith(`${env("HOME")}/Library`));

    await 가짜환경("mac", [앱], undefined, async (calls) => {
      let st = await autoStartStatus();
      같나("처음에는 꺼져 있다 (켤 수 있고, 옛 파일·충돌 없음)", [st.on, st.serve, st.tick, st.supported, st.legacy, st.conflict], [false, false, false, true, false, []]);
      참인가("방식 설명에 두 작업 이름이 있다", st.how.includes(SERVE_LABEL) && st.how.includes(REVIEW_LABEL));

      const msg = await setAutoStart(true);
      참인가("켰다고 알린다", /등록했습니다/.test(msg) && !/⚠️/.test(msg));
      같나("launchctl 은 올리기(bootstrap)만 — serve 다음 review", calls.map(줄), [`launchctl bootstrap gui/${uid} ${sP}`, `launchctl bootstrap gui/${uid} ${rP}`]);

      const sT = await 글(sP), rT = await 글(rP);
      같나("serve 인자 = 실행 파일 + --background (특수문자 경로도 그대로)", 인자들(sT), [앱, "--background"]);
      같나("review 인자 = 실행 파일 + 심사확인", 인자들(rT), [앱, "심사확인"]);
      참인가("경로의 & < 는 XML 로 이스케이프된다", sT.includes("&amp;") && sT.includes("&lt;"));
      참인가("serve: 라벨 · RunAtLoad true · ThrottleInterval", sT.includes(`<string>${SERVE_LABEL}</string>`) && /<key>RunAtLoad<\/key>\s*<true\/>/.test(sT) && /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/.test(sT));
      참인가("serve: KeepAlive 는 「실패로 끝났을 때만」(SuccessfulExit=false) — 이미 돌 때 또 띄워져 끝나는 것을 끝없이 되살리지 않는다",
        /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/.test(sT));
      참인가("review: 600초마다 · RunAtLoad false · KeepAlive 없음",
        /<key>StartInterval<\/key>\s*<integer>600<\/integer>/.test(rT) && /<key>RunAtLoad<\/key>\s*<false\/>/.test(rT) && !rT.includes("KeepAlive"));
      참인가("이 앱이 만든 표식이 박혀 있다", sT.includes("garasadae-uploader:autostart") && rT.includes("garasadae-uploader:autostart"));
      참인가("출력 기록은 기록/ 폴더 안", sT.includes(recordPath("자동실행_서버.log").replace(/&/g, "&amp;").replace(/</g, "&lt;")) || sT.includes("자동실행_서버.log"));
      참인가("기록 폴더가 미리 만들어졌다 (없으면 launchd 가 출력 파일을 못 열어 작업이 안 뜬다)", await exists(recordPath()));
      const js = await plist를JSON으로(sP);
      if (js) {
        같나("[plutil] 진짜 plist 파서가 읽는다: 라벨", js.Label, SERVE_LABEL);
        같나("[plutil] ProgramArguments", js.ProgramArguments, [앱, "--background"]);
        같나("[plutil] KeepAlive", js.KeepAlive, { SuccessfulExit: false });
        const jr = await plist를JSON으로(rP);
        같나("[plutil] review StartInterval · RunAtLoad", [jr?.StartInterval, jr?.RunAtLoad], [600, false]);
      }
      참인가("권한 옵션: GARASADAE_* 환경이 정해져 있으면 작업에도 넘긴다 (같은 데이터 폴더를 쓰게)", sT.includes("<key>GARASADAE_DATA_DIR</key>"));

      st = await autoStartStatus();
      같나("켠 뒤: 둘 다 켜짐", [st.on, st.serve, st.tick, st.legacy, st.conflict], [true, true, true, false, []]);

      // ── 같은 내용이면 건드리지 않는다
      calls.length = 0;
      const 앞 = [await 해시(sP), await 해시(rP)];
      await setAutoStart(true);
      같나("다시 켜도 파일을 안 바꾼다", [await 해시(sP), await 해시(rP)], 앞);
      같나("이미 올라가 있으면 확인(print)만 — 내리지도 다시 올리지도 않는다", calls.map(줄), [`launchctl print gui/${uid}/${SERVE_LABEL}`, `launchctl print gui/${uid}/${REVIEW_LABEL}`]);

    });

    // 가짜 환경은 겹쳐 쓰지 않는다 — 안쪽이 끝나며 바깥 환경까지 지운다
    await 가짜환경("mac", [앱], (c) => (c.args[0] === "print" ? { code: 113 } : undefined), async (calls) => {
      await setAutoStart(true);
      같나("올라가 있지 않으면 확인 뒤 올린다", calls.map(줄), [
        `launchctl print gui/${uid}/${SERVE_LABEL}`, `launchctl bootstrap gui/${uid} ${sP}`,
        `launchctl print gui/${uid}/${REVIEW_LABEL}`, `launchctl bootstrap gui/${uid} ${rP}`]);
    });

    await 가짜환경("mac", [앱], undefined, async (calls) => {
      // ── 실행 파일이 바뀌면 내리고 다시 올린다
      setExeForTest([`${dir}/다른자리/GarasadaeUploader`]);
      await setAutoStart(true);
      같나("내용이 바뀌면 내리고(bootout) 다시 올린다", calls.map(줄), [
        `launchctl bootout gui/${uid}/${SERVE_LABEL}`, `launchctl bootstrap gui/${uid} ${sP}`,
        `launchctl bootout gui/${uid}/${REVIEW_LABEL}`, `launchctl bootstrap gui/${uid} ${rP}`]);
      같나("새 실행 파일로 갈아끼웠다", 인자들(await 글(sP)), [`${dir}/다른자리/GarasadaeUploader`, "--background"]);
      setExeForTest([앱]);

      // ── 끄기
      calls.length = 0;
      const off = await setAutoStart(false);
      참인가("껐다고 알린다", /껐습니다/.test(off));
      같나("끄기: 파일을 지우고 내린다 — 심사확인 먼저, 서버(자기 자신일 수 있다)는 맨 마지막", calls.map(줄), [
        `launchctl bootout gui/${uid}/${REVIEW_LABEL}`, `launchctl bootout gui/${uid}/${SERVE_LABEL}`]);
      같나("끈 뒤 파일이 없다", [await exists(sP), await exists(rP)], [false, false]);
      const 끈뒤 = await autoStartStatus();
      같나("끈 뒤 상태", [끈뒤.on, 끈뒤.serve, 끈뒤.tick], [false, false, false]);
    });
  });

  await 모래상자(async (dir) => {
    const uid = Deno.uid() ?? 0;
    const 앱 = `${dir}/앱/GarasadaeUploader`;
    const LA = `${dir}/집/Library/LaunchAgents`;
    const sP = `${LA}/${SERVE_LABEL}.plist`, rP = `${LA}/${REVIEW_LABEL}.plist`, 옛P = `${LA}/${APP_ID}.plist`;

    // ── 남의 작업(파이썬 업로더 등)과 이름이 겹친다 — 쓰지 않고 오류로 멈춘다
    구역("자동 실행 — 같은 이름의 남의 작업은 건드리지 않는다");
    await Deno.mkdir(LA, { recursive: true });
    await Deno.writeTextFile(sP, 남의plist(SERVE_LABEL));
    await Deno.writeTextFile(rP, 남의plist(REVIEW_LABEL));
    const 남의앞 = [await 해시(sP), await 해시(rP)];
    await 가짜환경("mac", [앱], undefined, async (calls) => {
      const st = await autoStartStatus();
      같나("상태: 남의 것이 충돌로 보이고 켤 수 없다", [st.on, st.supported, st.conflict], [false, false, [SERVE_LABEL, REVIEW_LABEL]]);
      참인가("상태 설명이 이유를 말한다", /같은 이름의 다른 프로그램/.test(st.how));
      let 잡힘: unknown = null;
      try { await setAutoStart(true); } catch (e) { 잡힘 = e; }
      참인가("켜려 하면 AutoStartConflict 로 멈춘다", 잡힘 instanceof AutoStartConflict);
      같나("충돌한 파일 둘이 오류에 담긴다", (잡힘 as AutoStartConflict).files, [sP, rP]);
      같나("launchctl 을 한 번도 부르지 않았다 (남의 작업을 내리지 않았다)", calls.length, 0);
      같나("남의 파일은 한 글자도 안 바뀌었다", [await 해시(sP), await 해시(rP)], 남의앞);
      const 끔 = await setAutoStart(false);
      같나("끄기도 남의 작업은 안 건드린다 (내리지도 지우지도 않는다)", [calls.length, await 해시(sP), await 해시(rP)], [0, ...남의앞]);
      참인가("건드리지 않았다고 알린다", /건드리지 않았습니다/.test(끔));
    });

    // 하나만 남의 것이어도 **하나도** 안 쓴다
    await Deno.remove(rP);
    await 가짜환경("mac", [앱], undefined, async (calls) => {
      await 던지나("serve 만 남의 것이어도 멈춘다", () => setAutoStart(true), /같은 이름의 다른 프로그램/);
      같나("review 도 새로 쓰지 않았다", await exists(rP), false);
      같나("명령도 없다", calls.length, 0);
    });
    await Deno.remove(sP);

    // ── 옛 판(v1)의 plist — 새 이름으로 갈아끼운다. 옛 파일은 지우지 않고 .이전_<날짜> 로
    구역("자동 실행 — 옛 판(v1) plist 를 새 이름으로 갈아끼운다");
    const 옛글 = 옛판plist(앱);
    await Deno.writeTextFile(옛P, 옛글);
    await 가짜환경("mac", [앱], undefined, async (calls) => {
      let st = await autoStartStatus();
      같나("옛 판 파일이 있으면 켜진 것으로 보이고 legacy 로 알린다", [st.on, st.serve, st.tick, st.legacy], [true, true, false, true]);
      const msg = await setAutoStart(true);
      같나("옛 판 라벨을 내리고 새 둘을 올린다", calls.map(줄), [
        `launchctl bootout gui/${uid}/${APP_ID}`, `launchctl bootstrap gui/${uid} ${sP}`, `launchctl bootstrap gui/${uid} ${rP}`]);
      같나("옛 파일은 제자리에서 사라지고", await exists(옛P), false);
      const 치움 = [...Deno.readDirSync(LA)].map((e) => e.name).filter((n) => n.startsWith(`${APP_ID}.plist.이전_`));
      같나("지우지 않고 .이전_<날짜> 로 옮겨 두었다", 치움.length, 1);
      같나("옮긴 파일 내용은 그대로", await 글(`${LA}/${치움[0]}`), 옛글);
      참인가("알림에 치운 자리가 있다", msg.includes(".이전_"));
      st = await autoStartStatus();
      같나("이제 새 방식으로 둘 다 켜짐 (옛 파일 없음)", [st.serve, st.tick, st.legacy], [true, true, false]);
    });

    // 옛 판 plist 만 있을 때 끄면 그것도 치운다
    await Deno.remove(sP); await Deno.remove(rP);
    for (const n of [...Deno.readDirSync(LA)].map((e) => e.name)) if (n.includes(".이전_")) await Deno.remove(`${LA}/${n}`);
    await Deno.writeTextFile(옛P, 옛글);
    await 가짜환경("mac", [앱], undefined, async (calls) => {
      await setAutoStart(false);
      같나("옛 판만 있어도 끄면 내리고 치운다", [calls.map(줄), await exists(옛P)], [[`launchctl bootout gui/${uid}/${APP_ID}`], false]);
    });

    // 같은 이름이지만 옛 판 것이 아닌 파일(파이썬 따위)은 옛 판으로 오인해 치우지 않는다
    for (const e of [...Deno.readDirSync(LA)]) if (e.name.includes(".이전_")) await Deno.remove(`${LA}/${e.name}`);
    await Deno.writeTextFile(옛P, 남의plist(APP_ID));
    const 남은앞 = await 해시(옛P);
    await 가짜환경("mac", [앱], undefined, async (calls) => {
      const st = await autoStartStatus();
      같나("옛 판처럼 안 생긴 같은 이름 파일은 legacy 가 아니다", [st.legacy, st.on], [false, false]);
      await setAutoStart(true);
      같나("켜도 그 파일은 그대로, 내리지도 않는다", [await 해시(옛P), calls.map(줄).filter((x) => x.includes(`/${APP_ID} `) || x.endsWith(`/${APP_ID}`))], [남은앞, []]);
    });
  });

  구역("자동 실행 — 이 앱을 띄운 작업은 내리지 않는다 (자기 자신을 죽이지 않게)");
  await 모래상자(async (dir) => {
    const uid = Deno.uid() ?? 0;
    const 앱 = `${dir}/앱/GarasadaeUploader`;
    const LA = `${dir}/집/Library/LaunchAgents`;
    const sP = `${LA}/${SERVE_LABEL}.plist`, rP = `${LA}/${REVIEW_LABEL}.plist`, 옛P = `${LA}/${APP_ID}.plist`;
    const 앞환경 = env("XPC_SERVICE_NAME");        // launchd 가 작업이 띄운 프로세스에 넣어 주는 값
    try {
      await 가짜환경("mac", [앱], undefined, async () => { await setAutoStart(true); });

      // (1) 서버 작업이 띄운 프로세스가 「끄기」를 처리한다 — 서버를 내리면 응답도 못 하고 끝난다
      Deno.env.set("XPC_SERVICE_NAME", SERVE_LABEL);
      await 가짜환경("mac", [앱], undefined, async (calls) => {
        const msg = await setAutoStart(false);
        같나("끄기: 심사확인만 내린다 (서버는 자기 자신이라 내리지 않는다)", calls.map(줄), [`launchctl bootout gui/${uid}/${REVIEW_LABEL}`]);
        같나("파일은 둘 다 지웠다 (다음 로그인부터 안 켜진다)", [await exists(sP), await exists(rP)], [false, false]);
        참인가("내리지 않았다고 알린다", msg.includes("내리지 않았습니다") && msg.includes(SERVE_LABEL));
      });

      // (2) 실행 파일이 바뀐 채 서버 작업이 띄운 프로세스가 다시 켠다
      Deno.env.delete("XPC_SERVICE_NAME");
      await 가짜환경("mac", [앱], undefined, async () => { await setAutoStart(true); });
      Deno.env.set("XPC_SERVICE_NAME", SERVE_LABEL);
      await 가짜환경("mac", [`${앱}2`], undefined, async (calls) => {
        const msg = await setAutoStart(true);
        같나("바뀐 실행 파일: review 는 내리고 다시 올리지만 serve 는 파일만 바꾼다", calls.map(줄), [
          `launchctl bootout gui/${uid}/${REVIEW_LABEL}`, `launchctl bootstrap gui/${uid} ${rP}`]);
        같나("serve 파일은 새 내용이다 (다음 로그인부터 적용)", 인자들(await 글(sP)), [`${앱}2`, "--background"]);
        참인가("다음 로그인부터 바뀐다고 알린다", msg.includes("다음 로그인부터"));
      });

      // (3) 옛 판 작업이 띄운 프로세스 — 업데이트로 같은 자리의 실행 파일이 새 판이 되었다
      Deno.env.set("XPC_SERVICE_NAME", APP_ID);
      await Deno.remove(sP); await Deno.remove(rP);
      await Deno.writeTextFile(옛P, 옛판plist(앱));
      await 가짜환경("mac", [앱], undefined, async (calls) => {
        const msg = await setAutoStart(true);
        같나("옛 판 작업은 내리지 않고(자기 자신) 새 둘은 올린다", calls.map(줄), [
          `launchctl bootstrap gui/${uid} ${sP}`, `launchctl bootstrap gui/${uid} ${rP}`]);
        같나("옛 파일은 옆으로 치웠다", [await exists(옛P), [...Deno.readDirSync(LA)].some((e) => e.name.startsWith(`${APP_ID}.plist.이전_`))], [false, true]);
        참인가("알림", msg.includes(APP_ID) && msg.includes("내리지 않았습니다"));
      });
    } finally {
      if (앞환경) Deno.env.set("XPC_SERVICE_NAME", 앞환경); else Deno.env.delete("XPC_SERVICE_NAME");
    }
  });

  await 모래상자(async (dir) => {
    const 앱 = `${dir}/앱/GarasadaeUploader`;
    const sP = `${dir}/집/Library/LaunchAgents/${SERVE_LABEL}.plist`;
    구역("자동 실행 — 올리기 실패 · 개발 실행");
    await 가짜환경("mac", [앱], (c) => (c.args[0] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error" } : undefined), async () => {
      const msg = await setAutoStart(true);
      참인가("못 올렸으면 숨기지 않고 알린다 (까닭 포함)", msg.includes("⚠️") && msg.includes("Input/output error"));
      참인가("파일은 남아 다음 로그인 때 쓰인다", await exists(sP));
    });
    // 개발 실행(deno run) — 등록하지 않는다 (앞 시험이 남긴 plist 는 먼저 치운다)
    await Deno.remove(sP);
    const { calls, r } = 가짜실행기();
    setRunner(r); setOsForTest("mac"); setExeForTest(null);
    try {
      참인가("[개발] isCompiled() 는 false", !isCompiled());
      참인가("[개발] exePath() 는 deno run -A main.ts 꼴", /\srun -A .*main\.ts$/.test(exePath()) && exeArgv().length === 4);
      참인가("[개발] 켜기는 등록하지 않고 안내만", /개발 모드/.test(await setAutoStart(true)));
      const st = await autoStartStatus();
      같나("[개발] 상태: 지원 안 함 + 이유", [st.supported, /개발 실행/.test(st.how)], [false, true]);
      같나("[개발] 명령도 파일도 없다", [calls.length, await exists(sP)], [0, false]);
      참인가("[개발] 끄기는 문제없이 끝난다", /껐습니다/.test(await setAutoStart(false)));
    } finally { setRunner(null); setOsForTest(null); }
    setExeForTest(["/a b/exe"]);
    같나("[컴파일] 실행 파일 자리 그대로", [isCompiled(), exePath()], [true, "/a b/exe"]);
    setExeForTest(null);
  });
}

async function 윈도우시험() {
  구역("자동 실행 — 윈도우 시작 프로그램 .vbs + 작업 스케줄러");
  await 모래상자(async (dir) => {
    const exe = "C:\\Program Files\\업로드 앱\\GarasadaeUploader.exe";
    const S = `${dir}/집/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/${APP_NAME}.vbs`;
    const R = dataPath("심사확인실행.vbs");
    const 읽기 = async (p: string) => {
      const b = await Deno.readFile(p);
      return { bom: b[0] === 0xFF && b[1] === 0xFE, text: new TextDecoder("utf-16le").decode(b.subarray(2)) };
    };
    await 가짜환경("win", [exe], (c) => (c.cmd === "schtasks" && c.args[0] === "/query" ? { code: 0 } : undefined), async (calls) => {
      const msg = await setAutoStart(true);
      참인가("켰다고 알린다", /자동 실행되도록 등록했습니다/.test(msg) && !/⚠️/.test(msg));
      const s = await 읽기(S);
      참인가("시작 프로그램 .vbs 는 UTF-16 LE + 앞 표시(BOM) — 한글 경로가 안 깨진다", s.bom);
      참인가("--background 로 창 없이 켠다 (Run … , 0 = 숨김)", s.text.includes('Run """C:\\Program Files\\업로드 앱\\GarasadaeUploader.exe"" --background", 0, False'));
      참인가("표식이 있다", s.text.includes("garasadae-uploader:autostart"));
      const r = await 읽기(R);
      참인가("심사확인 실행기도 UTF-16, 숨김 + 끝날 때까지 기다림(True)", r.bom && r.text.includes('Run """C:\\Program Files\\업로드 앱\\GarasadaeUploader.exe"" 심사확인", 0, True'));
      같나("schtasks 로 10분마다 작업을 만든다", calls.filter((c) => c.cmd === "schtasks").map((c) => c.args), [
        ["/create", "/tn", REVIEW_LABEL, "/tr", `wscript.exe //B //Nologo "${R}"`, "/sc", "minute", "/mo", "10", "/f"]]);
      const st = await autoStartStatus();
      같나("상태: 시작 프로그램 + 작업 둘 다", [st.on, st.serve, st.tick, st.supported], [true, true, true, true]);

      calls.length = 0;
      const off = await setAutoStart(false);
      참인가("껐다", /껐습니다/.test(off));
      같나("끄기: 작업 삭제", calls.filter((c) => c.cmd === "schtasks").map((c) => c.args), [["/delete", "/tn", REVIEW_LABEL, "/f"]]);
      같나("끄기: 두 파일 모두 사라졌다", [await exists(S), await exists(R)], [false, false]);
    });

    // 작업 스케줄러가 실패하면 숨기지 않고 알린다 (시작 프로그램은 이미 써졌다)
    await 가짜환경("win", [exe], (c) => (c.cmd === "schtasks" ? { code: 1, stderr: "ERROR: Access is denied." } : undefined), async () => {
      const msg = await setAutoStart(true);
      참인가("작업 스케줄러 실패를 알린다", msg.includes("⚠️") && msg.includes("Access is denied"));
      참인가("시작 프로그램은 써져 있다", await exists(S));
      await setAutoStart(false);
    });

    // 옛 판 .vbs — 같은 자리를 갱신하되 사본을 데이터 폴더에 남긴다 (시작 폴더에 낯선 확장자를 두지 않는다)
    const 옛vbs = `' ${APP_NAME} 자동 시작\r\nCreateObject("WScript.Shell").Run """C:\\old\\GarasadaeUploader.exe"" --background", 0, False\r\n`;
    const utf16 = (s: string) => { const o = new Uint8Array(2 + s.length * 2); o[0] = 0xFF; o[1] = 0xFE; for (let i = 0; i < s.length; i++) { o[2 + i * 2] = s.charCodeAt(i) & 255; o[3 + i * 2] = s.charCodeAt(i) >> 8; } return o; };
    await Deno.writeFile(S, utf16(옛vbs));
    await 가짜환경("win", [exe], (c) => (c.cmd === "schtasks" && c.args[0] === "/query" ? { code: 1 } : undefined), async () => {
      const st = await autoStartStatus();
      같나("옛 판 .vbs 는 켜진 것으로 보이고 legacy", [st.serve, st.legacy, st.tick], [true, true, false]);
      await setAutoStart(true);
      같나("갈아끼웠다 (새 표식)", (await 읽기(S)).text.includes("garasadae-uploader:autostart"), true);
      const 옛폴더 = [...Deno.readDirSync(dataPath("자동시작_옛판"))].map((e) => e.name);
      같나("옛 파일은 데이터 폴더에 .이전_<날짜> 로 남았다", 옛폴더.length === 1 && 옛폴더[0].startsWith(`${APP_NAME}.vbs.이전_`), true);
      같나("옛 사본 내용 그대로", new TextDecoder("utf-16le").decode((await Deno.readFile(dataPath("자동시작_옛판", 옛폴더[0]))).subarray(2)), 옛vbs);
      await setAutoStart(false);
    });

    // 시작 프로그램에 같은 이름의 남의 파일
    await Deno.writeFile(S, utf16("MsgBox \"남의 파일\"\r\n"));
    const 앞 = await 해시(S);
    await 가짜환경("win", [exe], undefined, async (calls) => {
      await 던지나("남의 .vbs 가 있으면 켜지 않는다", () => setAutoStart(true), /같은 이름의 다른 파일/);
      같나("남의 파일은 그대로, 명령도 없다", [await 해시(S), calls.length], [앞, 0]);
      const 끔 = await setAutoStart(false);
      같나("끄기도 남의 파일은 안 지운다", [await 해시(S), /건드리지 않았습니다/.test(끔)], [앞, true]);
    });
  });
}

async function 리눅스시험() {
  구역("자동 실행 — 리눅스 .desktop (+ cron 안내)");
  await 모래상자(async (dir) => {
    const exe = "/opt/업로드 앱/GarasadaeUploader";
    const D = `${dir}/집/.config/autostart/${SERVE_LABEL}.desktop`;
    const 옛D = `${dir}/집/.config/autostart/${APP_ID}.desktop`;
    await 가짜환경("linux", [exe], (c) => (c.cmd === "crontab" ? { code: 1, stderr: "no crontab" } : undefined), async () => {
      let st = await autoStartStatus();
      같나("처음: 꺼짐 · 10분 작업은 앱이 못 다루니 지원 안 함 + 이유", [st.on, st.supported, /cron/.test(st.how), st.how.includes("*/10")], [false, false, true, true]);
      const msg = await setAutoStart(true);
      참인가("알림에 cron 줄이 있다", msg.includes("crontab -e") && msg.includes(`*/10 * * * * "${exe}" 심사확인`));
      const t = await 글(D);
      참인가(".desktop 내용", t.includes("[Desktop Entry]") && t.includes("Type=Application") && t.includes(`Exec="${exe}" --background`) && t.includes("X-GNOME-Autostart-enabled=true"));
      참인가("표식", t.includes("garasadae-uploader:autostart"));
      st = await autoStartStatus();
      같나("켠 뒤: 로그인 실행만 켜짐", [st.on, st.serve, st.tick], [true, true, false]);
      await setAutoStart(false);
      같나("끄면 파일이 없다", await exists(D), false);
    });
    await 가짜환경("linux", [exe], (c) => (c.cmd === "crontab" ? { code: 0, stdout: `# 메모\n*/10 * * * * "${exe}" 심사확인\n` } : undefined), async () => {
      같나("cron 에 넣어 두었으면 tick 이 켜짐으로 보인다", (await autoStartStatus()).tick, true);
    });
    // 옛 판 .desktop 은 새 이름으로 갈아끼우고 옛것은 .이전_<날짜> 로
    await Deno.mkdir(`${dir}/집/.config/autostart`, { recursive: true });
    const 옛글 = `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec="/old/GarasadaeUploader" --background\nX-GNOME-Autostart-enabled=true\n`;
    await Deno.writeTextFile(옛D, 옛글);
    await 가짜환경("linux", [exe], (c) => (c.cmd === "crontab" ? { code: 1 } : undefined), async () => {
      같나("옛 판 .desktop 은 legacy", (await autoStartStatus()).legacy, true);
      await setAutoStart(true);
      같나("옛 파일은 제자리에서 사라지고 옆으로 치워졌다", [await exists(옛D), (await 글(`${옛D}.이전_${[...Deno.readDirSync(`${dir}/집/.config/autostart`)].map((e) => e.name).find((n) => n.startsWith(`${APP_ID}.desktop.이전_`))!.split("이전_")[1]}`)) === 옛글], [false, true]);
    });
    // 남의 파일이 같은 이름
    await Deno.writeTextFile(D, "[Desktop Entry]\nName=남의것\nExec=/bin/true\n");
    await 가짜환경("linux", [exe], (c) => (c.cmd === "crontab" ? { code: 1 } : undefined), async () => {
      await 던지나("남의 .desktop 이 있으면 켜지 않는다", () => setAutoStart(true), /같은 이름의 다른 파일/);
    });
  });
}

async function 도구시험() {
  구역("선택창 — 맥 (값은 인자로, 스크립트 글에 끼우지 않는다)");
  await 모래상자(async (dir) => {
    const 안내 = '내 "안내문" \\ $x';
    await 가짜환경("mac", ["/x"], (c) => (c.cmd === "osascript" ? { stdout: "/영상/폴더 이름/\n" } : undefined), async (calls) => {
      같나("폴더를 고르면 끝의 / 를 뗀다", await pickFolder(dir, 안내), "/영상/폴더 이름");
      const c = calls[0];
      같나("osascript -e 스크립트 안내문 시작자리", [c.cmd, c.args[0], c.args[2], c.args[3]], ["osascript", "-e", 안내, dir]);
      참인가("안내문이 스크립트 글에 안 들어갔다 (따옴표가 스크립트를 깨지 못한다)", !c.args[1].includes("안내문") && c.args[1].includes("on run argv"));
      참인가("시작 자리가 있는 폴더면 default location 을 단다", c.args[1].includes("default location"));
      calls.length = 0;
      await pickFolder(`${dir}/없는폴더`, "x");
      참인가("없는 폴더면 default location 을 안 단다 (스크립트 오류 방지)", !calls[0].args[1].includes("default location"));
    });
    await 가짜환경("mac", ["/x"], (c) => (c.cmd === "osascript" ? { code: 1, stderr: "User canceled. (-128)" } : undefined), async () => {
      같나("취소하면 null", [await pickFolder(dir), await pickFile("파일", dir)], [null, null]);
    });
    await 가짜환경("mac", ["/x"], (c) => (c.cmd === "osascript" ? { stdout: "/a/client_secret.json\n" } : undefined), async (calls) => {
      같나("파일을 고르면 그 경로", await pickFile("열쇠", dir, ["JSON", ".txt", "*.PNG", 'a"b', "../x"]), "/a/client_secret.json");
      참인가("확장자는 영문·숫자만 남겨 of type 으로 (엉뚱한 글자는 버린다)", calls[0].args[1].includes('of type {"json", "txt", "png"}'));
      calls.length = 0;
      await pickFile("열쇠", dir);
      참인가("filters 를 안 주면 of type 이 없다", !calls[0].args[1].includes("of type"));
    });
  });

  구역("선택창 — 윈도우 · 리눅스");
  await 모래상자(async (dir) => {
    await 가짜환경("win", ["x.exe"], (c) => (c.cmd === "powershell" ? { stdout: b64("C:\\영상\\폴더 하나") + "\r\n" } : undefined), async (calls) => {
      같나("윈도우: Base64 로 받아 한글 경로를 되돌린다", await pickFolder("C:\\시작", "안내"), "C:\\영상\\폴더 하나");
      같나("윈도우: 안내문·시작 자리는 환경변수로", [calls[0].opts?.env?.GU_PROMPT, calls[0].opts?.env?.GU_START], ["안내", "C:\\시작"]);
      참인가("윈도우: -STA 로 띄운다", calls[0].args.includes("-STA") && calls[0].cmd === "powershell");
      calls.length = 0;
      같나("윈도우 파일 선택", await pickFile("열쇠", "C:\\시작", ["json"]), "C:\\영상\\폴더 하나");
      참인가("윈도우: 필터 글", String(calls[0].opts?.env?.GU_FILTER).includes("*.json") && String(calls[0].opts?.env?.GU_FILTER).includes("모든 파일"));
    });
    await 가짜환경("win", ["x.exe"], () => ({ code: 0, stdout: "" }), async () => {
      같나("윈도우: 취소(아무것도 안 나옴)는 null", await pickFolder("x"), null);
    });
    // 리눅스: zenity 가 없으면 kdialog 로, 취소는 null
    await 가짜환경("linux", ["x"], (c) => (c.cmd === "zenity" ? { code: 127 } : c.cmd === "kdialog" ? { stdout: "/home/나/영상\n" } : undefined), async (calls) => {
      같나("리눅스: zenity 가 없으면 kdialog", await pickFolder("/home/나"), "/home/나/영상");
      같나("호출 순서", calls.map((c) => c.cmd), ["zenity", "kdialog"]);
    });
    await 가짜환경("linux", ["x"], (c) => (c.cmd === "zenity" ? { code: 1 } : undefined), async (calls) => {
      같나("리눅스: zenity 취소는 null (kdialog 로 안 넘어간다)", [await pickFile("열쇠"), calls.map((c) => c.cmd)], [null, ["zenity"]]);
    });
  });

  구역("클립보드");
  await 모래상자(async () => {
    await 가짜환경("mac", ["x"], undefined, async (calls) => {
      같나("맥: pbcopy 에 표준 입력으로", [await clipboardWrite("한글 text"), calls[0].cmd, calls[0].opts?.input], [true, "pbcopy", "한글 text"]);
    });
    await 가짜환경("win", ["x.exe"], undefined, async (calls) => {
      await clipboardWrite("한글 text");
      같나("윈도우: PowerShell 에 환경변수로 (clip 은 한글이 깨진다)", [calls[0].cmd, calls[0].opts?.env?.GU_TEXT], ["powershell", "한글 text"]);
    });
    await 가짜환경("win", ["x.exe"], (c) => (c.cmd === "powershell" ? { code: 1 } : undefined), async (calls) => {
      같나("윈도우: PowerShell 이 안 되면 clip 으로", [await clipboardWrite("a"), calls.map((c) => c.cmd)], [true, ["powershell", "clip"]]);
    });
    const 앞 = env("WAYLAND_DISPLAY");
    Deno.env.set("WAYLAND_DISPLAY", "wayland-0");
    try {
      await 가짜환경("linux", ["x"], (c) => (c.cmd === "wl-copy" ? { code: 127 } : undefined), async (calls) => {
        같나("리눅스(웨이랜드): wl-copy → 없으면 xclip", [await clipboardWrite("a"), calls.map((c) => c.cmd), calls[1].opts?.quiet], [true, ["wl-copy", "xclip"], true]);
      });
    } finally { if (앞) Deno.env.set("WAYLAND_DISPLAY", 앞); else Deno.env.delete("WAYLAND_DISPLAY"); }
    await 가짜환경("linux", ["x"], () => ({ code: 127 }), async () => {
      같나("리눅스: 도구가 하나도 없으면 false", await clipboardWrite("a"), false);
    });
  });

  구역("폴더 · 주소 열기");
  await 모래상자(async () => {
    await 가짜환경("mac", ["x"], undefined, async (calls) => {
      같나("주소: open <주소>", [await openUrl("http://127.0.0.1:8777/"), 줄(calls[0]), calls[0].opts?.detach], [true, "open http://127.0.0.1:8777/", true]);
      calls.length = 0;
      await openUrl("https://example.com/?a=1&b=2", "Google Chrome");
      같나("브라우저를 지정하면 open -a", 줄(calls[0]), "open -a Google Chrome https://example.com/?a=1&b=2");
      calls.length = 0;
      같나("http 가 아닌 주소는 열지 않는다 (file: · javascript: · 옵션처럼 보이는 글)", [
        await openUrl("file:///etc/passwd"), await openUrl("javascript:alert(1)"), await openUrl("-a Calculator"), await openUrl(""), calls.length], [false, false, false, false, 0]);
      await openPath("-weird");
      같나("폴더 열기: 옵션처럼 보이면 ./ 를 붙인다", 줄(calls[0]), "open ./-weird");
    });
    await 가짜환경("win", ["x.exe"], undefined, async (calls) => {
      await openUrl("https://example.com/?a=1&b=2");
      같나("윈도우: cmd start 를 거치지 않는다 (& 가 명령으로 읽힌다)", 줄(calls[0]), "rundll32 url.dll,FileProtocolHandler https://example.com/?a=1&b=2");
      calls.length = 0;
      await openUrl("https://example.com/?a=1&b=2", "chrome.exe");
      같나("윈도우: 브라우저 지정은 Start-Process, 값은 환경변수로", [calls[0].cmd, calls[0].opts?.env?.GU_BROWSER, calls[0].opts?.env?.GU_URL], ["powershell", "chrome.exe", "https://example.com/?a=1&b=2"]);
      calls.length = 0;
      await openPath("C:/영상/폴더");
      같나("윈도우: explorer 에 역슬래시로", 줄(calls[0]), "explorer C:\\영상\\폴더");
    });
    await 가짜환경("linux", ["x"], undefined, async (calls) => {
      await openUrl("https://example.com/");
      await openPath("/home/나");
      같나("리눅스: xdg-open", calls.map(줄), ["xdg-open https://example.com/", "xdg-open /home/나"]);
    });
    await 가짜환경("mac", ["x"], () => ({ code: 127, stderr: "없는 명령" }), async () => {
      같나("명령이 없으면 false", await openPath("/x"), false);
    });
  });

  구역("이미 열려 있는 탭 다시 쓰기");
  await 모래상자(async () => {
    const 주소 = 'http://127.0.0.1:8777/?x="1"';
    await 가짜환경("mac", ["x"], (c) => (c.cmd === "/bin/ps" ? { stdout: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n/usr/sbin/cfprefsd\n" } : c.cmd === "osascript" ? { stdout: "1\n" } : undefined), async (calls) => {
      같나("크롬 탭을 찾아 다시 불렀다", await reuseBrowserTab("http://127.0.0.1:8777", 주소, ""), true);
      const o = calls.find((c) => c.cmd === "osascript")!;
      같나("주소는 인자(argv)로 넘기고 스크립트에는 안 끼운다", [o.args[2], o.args[3], o.args[1].includes("127.0.0.1"), o.args[1].includes('tell application "Google Chrome"')], ["http://127.0.0.1:8777", 주소, false, true]);
    });
    await 가짜환경("mac", ["x"], (c) => (c.cmd === "/bin/ps" ? { stdout: "/Applications/Firefox.app/Contents/MacOS/firefox\n" } : undefined), async (calls) => {
      같나("파이어폭스·Arc 는 못 시킨다 → false (osascript 도 안 부른다)", [await reuseBrowserTab("a", "b", "Firefox"), calls.filter((c) => c.cmd === "osascript").length], [false, 0]);
    });
    await 가짜환경("mac", ["x"], (c) => (c.cmd === "/bin/ps" ? { stdout: "/Applications/Safari.app/Contents/MacOS/Safari\n" } : c.cmd === "osascript" ? { stdout: "0\n" } : undefined), async (calls) => {
      같나("사파리에 그 탭이 없으면 false", [await reuseBrowserTab("a", "b"), calls.find((c) => c.cmd === "osascript")!.args[1].includes("current tab")], [false, true]);
    });
    await 가짜환경("win", ["x.exe"], undefined, async (calls) => {
      같나("맥이 아니면 시도하지 않는다", [await reuseBrowserTab("a", "b"), calls.length], [false, 0]);
    });
  });

  구역("잠 안 자기 (올리는 동안만)");
  await 모래상자(async () => {
    const got: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
    let killed = 0;
    setHoldSpawner((cmd, args, e) => { got.push({ cmd, args, env: e }); return { kill: () => { killed++; } }; });
    try {
      setOsForTest("mac");
      keepAwake(); keepAwake();
      같나("맥: 두 번 불러도 한 번만 붙든다 (caffeinate -i -w <내 pid>)", [got.length, got[0].cmd, got[0].args, isAwakeHeld()], [1, "caffeinate", ["-i", "-w", String(Deno.pid)], true]);
      allowSleep(); allowSleep();
      같나("놓으면 한 번만 끝내고 붙들지 않는다", [killed, isAwakeHeld()], [1, false]);
      setOsForTest("win");
      keepAwake();
      참인가("윈도우: 숨은 PowerShell + SetThreadExecutionState, 내 pid 를 환경변수로", got[1].cmd === "powershell" && got[1].args.includes("-WindowStyle") && got[1].args.join(" ").includes("SetThreadExecutionState") && got[1].env?.GU_PID === String(Deno.pid));
      allowSleep();
      setOsForTest("linux");
      keepAwake();
      참인가("리눅스: systemd-inhibit", got[2].cmd === "systemd-inhibit" && got[2].args.some((a) => a.startsWith("--pid=")));
      allowSleep();
      setHoldSpawner(() => null);
      keepAwake();
      같나("붙들이를 못 띄우면 붙든 척하지 않는다", isAwakeHeld(), false);
    } finally { allowSleep(); setHoldSpawner(null); setOsForTest(null); }
  });

  구역("브라우저 목록");
  await 모래상자(async (dir) => {
    await Deno.mkdir(`${dir}/집/Applications/Arc.app`, { recursive: true });
    await Deno.mkdir(`${dir}/집/Applications/Safari.app`, { recursive: true });
    setOsForTest("mac");
    try {
      const l = await listBrowsers();
      참인가("맥: 내 폴더(~/Applications)의 브라우저도 찾는다", l.some((b) => b.id === "Arc" && b.name === "Arc") && l.some((b) => b.id === "Safari" && b.name === "사파리"));
      참인가("모든 항목에 id · name", l.every((b) => b.id && b.name));
    } finally { setOsForTest(null); }
    // 리눅스: PATH 에서 찾는다
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(`${dir}/bin/firefox`, "#!/bin/sh\n");
    const 앞 = env("PATH");
    Deno.env.set("PATH", `${dir}/bin`);
    setOsForTest("linux");
    try {
      같나("리눅스: PATH 의 브라우저", await listBrowsers(), [{ id: "firefox", name: "파이어폭스" }]);
    } finally { Deno.env.set("PATH", 앞); setOsForTest(null); }
  });
}

/* ═══════════════════════════ 2. 옛 판 자료 이행 ═══════════════════════════ */

/** 가짜 구글 + 갱신 요청이 쓴 열쇠를 적어 두는 감시 (가짜구글.ts 는 고치지 않고 handle 만 감싼다) */
class 감시구글 extends 가짜구글 {
  갱신: { client_id: string; client_secret: string; refresh: string; scope: string }[] = [];
  constructor() {
    super();
    const 원래 = this.handle;
    this.handle = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/token") {
        const b = init?.body;
        const f = b instanceof URLSearchParams ? b : new URLSearchParams(String(b ?? ""));
        if (f.get("grant_type") === "refresh_token") {
          this.갱신.push({ client_id: f.get("client_id") ?? "", client_secret: f.get("client_secret") ?? "", refresh: f.get("refresh_token") ?? "", scope: f.get("scope") ?? "" });
        }
      }
      return 원래(input, init);
    };
  }
}

const FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl";
const 가짜비밀들 = ["fake-secret", "fake-refresh", "apps.googleusercontent.com", "fake-key", "fake-access"];

interface 옛자리 { 폴더A: string; 폴더B: string; 폴더C: string }

/** 합성 옛 자료를 쓴다 (전부 가짜 값). oldDir 은 옛 파일이 놓일 자리. */
async function 옛자료쓰기(dir: string, oldDir: string = dataDir()): Promise<옛자리> {
  const 폴더A = `${dir}/영상/폴더A`, 폴더B = `${dir}/영상/폴더B_없음`, 폴더C = `${dir}/영상/폴더C`;
  for (const d of [`${폴더A}/_완료`, `${폴더A}/_실패`, `${폴더A}/_보류`, 폴더C]) await Deno.mkdir(d, { recursive: true });
  for (const f of ["a1.mp4", "a2.mov", "note.txt", ".숨김.mp4", "_완료/old1.mp4", "_완료/old2.mp4", "_실패/f1.mp4"]) await Deno.writeFile(`${폴더A}/${f}`, new Uint8Array([1]));
  const 이 = (id: string, name: string, extra: Record<string, unknown>) => ({
    id, name, folder: "", clientId: "", clientSecret: "", sharesWith: "", enabled: true, createdAt: "2026-08-20T01:02:03.000Z",
    privacy: "private", categoryId: "22", language: "ko", tags: [], description: "", titlePrefix: "", titleSuffix: "",
    madeForKids: false, notifySubscribers: true, reviewMode: false, afterUpload: "move", dailyLimit: 6, studioAfter: "ask",
    dupGuard: true, publishSlots: [], firstComment: false, firstCommentText: "", retitleHours: 0, retitleTemplate: "", ...extra,
  });
  const cfg = {
    schema: 2, port: 8888, pollSeconds: 9, stableChecks: 4, notifications: false, telegramAlerts: false,
    autoStart: true, autoStartAsked: true, updateDeclines: { "1.8.0": 2 }, baseDir: `${dir}/집/Desktop/업로드대기`,
    browser: "Google Chrome", aiTitles: true, aiKey: "fake-key-AAAA", aiModel: "fake-model",
    channels: [
      이("ch_aaaa1111", "채널A", {
        folder: 폴더A, clientId: "fake-id.apps.googleusercontent.com", clientSecret: "fake-secret", privacy: "public",
        language: "ko", tags: ["태그1", "태그2"], description: "설명 A", titlePrefix: "[A] ", dailyLimit: 3,
        publishSlots: ["19:00", "07:00", "7:00", "25:00"], firstComment: true, firstCommentText: "댓글",
      }),
      이("ch_bbbb2222", "채널B", {
        folder: 폴더B, sharesWith: "ch_aaaa1111", enabled: false, privacy: "unlisted", afterUpload: "delete", dailyLimit: 0,
        madeForKids: true, reviewMode: true, studioAfter: "always", categoryId: "24", language: "en", retitleHours: 6,
        retitleTemplate: "{제목}!", notifySubscribers: false, dupGuard: false, titleSuffix: " 끝",
      }),
      이("ch_cccc3333", "채널C", { folder: 폴더C, clientId: "fake-id-c.apps.googleusercontent.com", clientSecret: "fake-secret-c", afterUpload: "trash", dailyLimit: 6 }),
    ],
  };
  await Deno.mkdir(`${oldDir}/tokens`, { recursive: true });
  await Deno.writeTextFile(`${oldDir}/config.json`, JSON.stringify(cfg, null, 2));
  await Deno.writeTextFile(`${oldDir}/tokens/ch_aaaa1111.json`, JSON.stringify({
    access_token: "fake-access", refresh_token: "fake-refresh", expires_at: 1,
    scope: `${SCOPES_LEGACY.join(" ")} ${FORCE_SSL}`, channel: { id: UC("a"), title: "채널A 제목", thumb: "", subs: "1" },
  }));
  await Deno.writeTextFile(`${oldDir}/tokens/ch_bbbb2222.json`, JSON.stringify({ refresh_token: "fake-refresh-b", channel: { id: UC("b"), title: "채널B 제목" } }));
  // 채널C 는 로그인 정보 파일이 없다
  const 올림 = [
    { id: "vid_3", title: "영상 3", file: "c3.mp4", size: 3, privacy: "private", at: "2026-10-09T09:00:00", channelId: "ch_aaaa1111", channelName: "채널A", hash: "h3", publishAt: "2026-10-19T00:00:00.000Z" },
    { id: "vid_2", title: '영상, 2 "따옴표"', file: "b2.mp4", size: 2, privacy: "public", at: "2026-10-08T08:00:00", channelId: "ch_bbbb2222", channelName: "채널B" },
    { id: "vid_1", title: '영상, 1 "따옴표"', file: "a1.mp4", size: 1, privacy: "public", at: "2026-10-07T07:00:00", channelId: "ch_aaaa1111", channelName: "채널A" },
    { id: "", title: "id 없음", file: "none.mp4", at: "2026-10-07T06:00:00" },
    { id: "vid_1", title: "중복", file: "dup.mp4", at: "2026-10-07T05:00:00", channelId: "ch_aaaa1111", channelName: "채널A" },
    { id: "vid_x", title: "깨진 예약", file: "x.mp4", privacy: "private", at: "2026-10-06T04:00:00", channelId: "ch_zzzz9999", channelName: "지운 채널", publishAt: "읽을 수 없는 글" },
  ];
  await Deno.writeTextFile(`${oldDir}/state.json`, JSON.stringify({
    uploads: 올림, stats: { vid_1: { views: 1, likes: 0, comments: 0, at: 1 } }, statsAt: 1,
    jobs: [{ kind: "comment", videoId: "vid_1", channelId: "ch_aaaa1111", at: 1, text: "x", tries: 0 }], kept: {}, failed: {}, quota: {},
  }));
  await Deno.writeTextFile(`${oldDir}/uploader.log`, "2026-10-09 09:00:00 시작\n");
  return { 폴더A, 폴더B, 폴더C };
}

const 원본들 = ["config.json", "state.json", "uploader.log", "tokens/ch_aaaa1111.json", "tokens/ch_bbbb2222.json"];
async function 원본해시(oldDir: string): Promise<Record<string, string>> {
  const o: Record<string, string> = {};
  for (const f of 원본들) o[f] = await 해시(`${oldDir}/${f}`);
  return o;
}
const 요약 = (r: MigrationReport) => ({
  ok: r.ok, channels: r.channels, names: r.channelNames, tokens: r.tokens, needLogin: r.needLogin, ledgerRows: r.ledgerRows,
  ledgerSkipped: r.ledgerSkipped, policies: r.policies, settings: [...r.settings].sort(),
});

async function 이행시험() {
  구역("이행 — 옛 판(v1.x) 자료를 새 모양으로");
  await 모래상자(async (dir) => {
    const g = new 감시구글();
    g.addChannel({ id: UC("a"), title: "채널A 제목" }, "fake-refresh").addChannel({ id: UC("b"), title: "채널B 제목" }, "fake-refresh-b").install();
    const 자리 = await 옛자료쓰기(dir);
    await appendLedger({ 업로드시각: "2026-10-08T08:00:00", 채널: "채널B", 영상ID: "vid_2", 제목: "새 앱이 이미 적은 줄", 파일: "b2.mp4" });
    const 원본앞 = await 원본해시(dataDir());

    const 옛 = await detectOld();
    같나("detectOld: 옛 자료를 찾는다", [옛.needed, 옛.done, 옛.configFound, 옛.stateFound, 옛.channels, 옛.tokenFiles, 옛.singleToken, 옛.uploads], [true, false, true, true, 3, 2, false, 6]);

    // ── 시험 이행(dryRun): 아무것도 쓰지 않는다
    const 말: string[] = [];
    const 전부앞 = await 찍기(dataDir());
    const 시험 = await migrate({ dryRun: true, say: (l) => 말.push(l) });
    같나("dryRun 은 데이터 폴더를 한 글자도 안 바꾼다 (새 파일도 없다)", await 찍기(dataDir()), 전부앞);
    참인가("dryRun 보고: 시험이라고 표시 · 일을 한 것으로 보고", 시험.dryRun && 시험.ran && 시험.ok);
    같나("dryRun 이 센 숫자", 요약(시험), {
      ok: true, channels: 3, names: ["채널A", "채널B", "채널C"], tokens: 2, needLogin: ["채널C"], ledgerRows: 3, ledgerSkipped: 2, policies: 1,
      settings: ["aiKey", "aiModel", "aiTitles", "autoStart", "autoStartAsked", "browser", "osNotify", "port", "telegramAlerts", "updateDeclines"],
    });
    참인가("dryRun 보고 첫 줄이 시험이라고 말한다", formatReport(시험)[0].includes("이행 시험"));

    // ── 진짜 이행
    말.length = 0;
    const r = await migrate({ say: (l) => 말.push(l) });
    같은값("진짜 이행도 dryRun 이 센 것과 같다", 요약(r), 요약(시험));
    참인가("끝까지 갔다 (ok · ran · 이미 한 게 아님)", r.ok && r.ran && !r.already && !r.dryRun && r.errors.length === 0);

    // 채널 칸 — 필드 변환 표
    const 채널 = loadChannels();
    같은값("채널A 칸", 채널["채널A"], {
      channel_id: UC("a"), folder: 자리.폴더A, prefix: "", publish: "schedule", times: ["07:00", "19:00"], after_review: "public", after_upload: "move",
      title_prefix: "[A] ", desc: "설명 A", tags: ["태그1", "태그2"], audio_language: "ko", daily_rule: "fixed", daily: 3,
    });
    같은값("채널B 칸 (삭제→휴지통 · 슬롯 없음→바로 · 아동용 · 없는 폴더는 비우고 옛 자리 기억)", 채널["채널B"], {
      channel_id: UC("b"), folder: "", old_folder: 자리.폴더B, prefix: "", publish: "now", after_review: "unlisted", after_upload: "trash",
      audio_language: "en", made_for_kids: true,
    });
    같은값("채널C 칸 (로그인 없음 → channel_id 비움)", 채널["채널C"], {
      channel_id: "", folder: 자리.폴더C, prefix: "", publish: "now", after_review: "private", after_upload: "trash", audio_language: "ko", daily_rule: "fixed", daily: 6,
    });
    같나("폴더를 만들지 않았다", await exists(자리.폴더B), false);

    // 열쇠 파일 · 토큰
    for (const [f, id, sec] of [["client_secret_채널A.json", "fake-id.apps.googleusercontent.com", "fake-secret"], ["client_secret_채널B.json", "fake-id.apps.googleusercontent.com", "fake-secret"]] as const) {
      const k = JSON.parse(await 글(dataPath(f)));
      같나(`전용 열쇠 파일 ${f}`, [k.installed.client_id, k.installed.client_secret], [id, sec]);
    }
    같나("채널C(로그인 없음)는 열쇠 파일도 안 만든다", await exists(dataPath("client_secret_채널C.json")), false);
    if (Deno.build.os !== "windows") {
      같나("열쇠 파일·토큰 파일 권한 600", [
        (await Deno.stat(dataPath("client_secret_채널A.json"))).mode! & 0o777, (await Deno.stat(dataPath("tokens.json"))).mode! & 0o777], [0o600, 0o600]);
    }
    const 저장소 = loadStore();
    같나("토큰이 들어간 채널", Object.keys(저장소), ["채널A", "채널B"]);
    같은값("채널A 토큰 항목 (scope→scopes · channel.id→channel_id · createdAt→added(이 컴퓨터 시각))", 저장소["채널A"], {
      channel_id: UC("a"), title: "채널A 제목", refresh_token: "fake-refresh", added: "2026-08-20T10:02:03",
      scopes: [...SCOPES_LEGACY, FORCE_SSL], how: "browser", secret: "client_secret_채널A.json",
    });
    같은값("채널B 토큰 (scope 없으면 옛 두 범위 · sharesWith 로 A 의 열쇠)", 저장소["채널B"], {
      channel_id: UC("b"), title: "채널B 제목", refresh_token: "fake-refresh-b", added: "2026-08-20T10:02:03",
      scopes: [...SCOPES_LEGACY], how: "browser", secret: "client_secret_채널B.json",
    });
    같나("로그인을 못 옮긴 채널은 다시 연결하라고 알린다", r.needLogin, ["채널C"]);

    // 옛 열쇠로 진짜 갱신이 된다 (가짜 구글이 받는 요청 본문으로 확인)
    forgetAccessTokens();
    같나("채널A: 옛 토큰이 옛 열쇠로 갱신된다", await accessToken(저장소["채널A"]), "AT:fake-refresh");
    같나("채널B: 공유 열쇠로 갱신된다", await accessToken(저장소["채널B"]), "AT:fake-refresh-b");
    같은값("갱신 요청에 실린 열쇠·범위", g.갱신, [
      { client_id: "fake-id.apps.googleusercontent.com", client_secret: "fake-secret", refresh: "fake-refresh", scope: [...SCOPES_LEGACY, FORCE_SSL].join(" ") },
      { client_id: "fake-id.apps.googleusercontent.com", client_secret: "fake-secret", refresh: "fake-refresh-b", scope: SCOPES_LEGACY.join(" ") },
    ]);
    같나("clientFor 도 전용 열쇠를 고른다", (await clientFor(저장소["채널A"])).client_id, "fake-id.apps.googleusercontent.com");

    // 원장
    const 원장 = readLedger();
    같나("원장 순서: 이미 있던 줄 + 옛 기록(오래된 것부터)", 원장.map((x) => x["영상ID"]), ["vid_2", "vid_x", "vid_1", "vid_3"]);
    같나("이미 원장에 있던 vid_2 는 덮지 않았다", 원장[0]["제목"], "새 앱이 이미 적은 줄");
    같은값("vid_3: 필드 변환 (예약시각은 Z 를 이 컴퓨터 시각으로, 나머지 칸은 빈칸)", 원장[3], {
      업로드시각: "2026-10-09T09:00:00", 채널: "채널A", 영상ID: "vid_3", 제목: "영상 3", 파일: "c3.mp4", 길이초: "", 해상도: "", 아동용: "", AI합성: "",
      공개설정: "private", 공개시각: "", 예약시각: "2026-10-19 09:00", 고객확인자: "", 확인일: "",
    });
    같나("vid_1: 공개설정은 privacy 글자 그대로(public)", [원장[2]["공개설정"], 원장[2]["예약시각"]], ["public", ""]);
    같나("읽을 수 없는 예약시각은 비우고(원장을 읽는 쪽이 멈추지 않게) 채널은 옛 이름 그대로", [원장[1]["예약시각"], 원장[1]["채널"]], ["", "지운 채널"]);
    참인가("그 사실을 경고로 알린다", r.warnings.some((w) => w.includes("예약 시각을 읽지 못한")));
    같나("제목의 쉼표·따옴표가 안 깨졌다 (원장을 다시 읽어 보면)", 원장[2]["제목"], '영상, 1 "따옴표"');
    참인가("글로는 따옴표로 감싸 이스케이프했다 (파이썬 csv 와 같은 꼴)", (await 글(dataPath("ledger.csv"))).includes('"영상, 1 ""따옴표"""'));
    참인가("옛 파일 이름으로 다시 올리려는 것이 이제 중복으로 걸린다", uploadedNames().has("c3.mp4") && uploadedNames().has("a1.mp4"));
    참인가("영상 ID 가 없는 기록은 건너뛰고 알린다", r.skipped.some((s) => s.includes("영상 ID 가 없어")));

    // 일 한도 정책
    const 정책 = loadPolicies();
    같나("정책은 로그인이 있고 한도가 있는 채널A 하나", 정책.map((p) => p.cfg.channel_id), [UC("a")]);
    같은값("채널A 정책 (하루 업로드 편수 → cap_uploads true · kind 없음)", {
      label: 정책[0].cfg.label, aliases: 정책[0].cfg.aliases, daily_limit: 정책[0].cfg.daily_limit, cap_uploads: 정책[0].cfg.cap_uploads, kind: 정책[0].cfg.kind,
    }, { label: "채널A", aliases: ["채널A"], daily_limit: 3, cap_uploads: true, kind: undefined });
    참인가("채널C 는 채널 ID 를 몰라 정책을 못 만들고 알린다", r.warnings.some((w) => w.startsWith("[채널C] 하루 6편 한도")));

    // 앱 설정
    const 앱설정 = readJsonSync<Record<string, unknown>>(dataPath("앱설정.json"), {});
    같은값("앱 설정 (notifications→osNotify · aiKey 값은 파일에만)", 앱설정, {
      port: 8888, browser: "Google Chrome", osNotify: false, telegramAlerts: false, autoStart: true, autoStartAsked: true,
      updateDeclines: { "1.8.0": 2 }, aiTitles: true, aiKey: "fake-key-AAAA", aiModel: "fake-model",
    });
    같나("옛 기본(바탕화면 업로드대기) baseDir 은 새 앱 설정으로 가져오지 않았다", "baseDir" in 앱설정, false);
    참인가("그 사실을 참고로 적었다", r.notes.some((n) => n.includes("새 채널 기본 폴더")));
    if (Deno.build.os !== "windows") 같나("앱설정.json 권한 600 (aiKey 가 든다)", (await Deno.stat(dataPath("앱설정.json"))).mode! & 0o777, 0o600);

    // 버린 것
    const 버림 = r.dropped.join("\n");
    for (const 조각 of [
      "[채널A] 첫 댓글 자동 달기", "[채널B] 검토 모드", "[채널B] 올린 뒤 스튜디오 열기(always)", "[채널B] 제목 자동 교체", "[채널B] 구독자 알림 끄기",
      "[채널B] 중복 올리기 막기 끄기", "[채널B] 구글 프로젝트 공유", "[채널B] 제목 꼬리말", "[채널B] 카테고리(24)", "밀린 뒷일 1건", "영상별 성적 기록 1건", "파일 지문(hash)", "폴더 감시 주기",
    ]) 참인가(`버린 것에 적혔다 — ${조각}`, 버림.includes(조각));
    참인가("force-ssl 이 필요해 못 옮긴다고 까닭을 적었다", /force-ssl/.test(버림));
    참인가("쓰지 않던 기본 설정은 소음으로 적지 않았다 (채널A 의 스튜디오·알림)", !버림.includes("[채널A] 올린 뒤 스튜디오") && !버림.includes("[채널A] 구독자"));
    참인가("꺼 둔 채널이었음을 참고로 적었다", r.notes.some((n) => n.startsWith("[채널B] 옛 앱에서 감시를 꺼 둔")));
    참인가("삭제→휴지통 변경을 참고로 적었다", r.notes.some((n) => n.includes("「올린 뒤 삭제」였던 설정은 「휴지통으로」")));

    // 폴더 현황
    같은값("폴더 현황 (영상 수만 센다 — 옛 _완료 · _실패 · _보류 는 건드리지 않는다)", r.folders, [
      { channel: "채널A", folder: 자리.폴더A, exists: true, waiting: 2, done: 2, failed: 1, held: 0 },
      { channel: "채널B", folder: "", exists: false, waiting: 0, done: 0, failed: 0, held: 0 },
      { channel: "채널C", folder: 자리.폴더C, exists: true, waiting: 0, done: 0, failed: 0, held: 0 },
    ]);
    참인가("없는 폴더는 경고로 알렸다 (만들지 않고)", r.warnings.some((w) => w.startsWith("[채널B] 옛 폴더가 지금 없습니다")));

    // 옛 파일은 그대로
    같나("옛 파일(config · state · tokens/ · uploader.log)은 한 글자도 안 바뀌었다", await 원본해시(dataDir()), 원본앞);
    같나("옛 폴더의 영상도 그대로 (_완료 안의 영상도)", [await exists(`${자리.폴더A}/a1.mp4`), await exists(`${자리.폴더A}/_완료/old1.mp4`), await exists(`${자리.폴더A}/_실패/f1.mp4`)], [true, true, true]);

    // 이행기록
    const 기록 = readJsonSync<Record<string, any>>(dataPath("이행기록.json"), {});
    같나("이행기록.json 이 남았다 (일시 · 보고)", [typeof 기록.일시, 기록.report?.channels, 기록.report?.tokens, 기록.report?.dropped?.length > 0], ["string", 3, 2, true]);

    // 열쇠·토큰 값이 어디에도 안 나왔다
    const 기록텍스트 = await 글(dataPath("이행기록.json"));
    const 로그 = await 글(recordPath("서버.log")).catch(() => "");
    const 보이는곳: [string, string][] = [
      ["보고 JSON", JSON.stringify(r)], ["보고 줄", formatReport(r).join("\n")], ["이행기록.json", 기록텍스트], ["기록/서버.log", 로그], ["진행 말", 말.join("\n")],
    ];
    for (const [어디, 내용] of 보이는곳) {
      const 샌것 = 가짜비밀들.filter((s) => 내용.includes(s));
      같나(`열쇠·토큰 값이 새지 않았다 — ${어디}`, 샌것, []);
    }
    참인가("진행 말은 채널 이름과 개수 정도만", 말.some((l) => l.includes("「채널A」")));

    // ── 두 번째: 아무것도 안 한다 (멱등)
    const 끝뒤 = await 찍기(dataDir());
    const 둘째 = await migrate({ say: (l) => 말.push(l) });
    참인가("두 번째는 「이미 했다」", 둘째.already && !둘째.ran && 둘째.ok);
    같나("두 번째는 아무것도 바꾸지 않는다", await 찍기(dataDir()), 끝뒤);
    같나("둘째 보고는 첫 보고의 숫자를 그대로 보여 준다", [둘째.channels, 둘째.tokens, 둘째.ledgerRows], [3, 2, 3]);
    같나("formatReport 는 이미 했다고 말한다", formatReport(둘째)[0].includes("이미 옮겨 두었습니다"), true);
    const 둘째시험 = await migrate({ dryRun: true });
    참인가("끝난 뒤의 dryRun 도 이미 했다", 둘째시험.already && 둘째시험.dryRun);
    같나("detectOld: 끝났다고 알린다", [(await detectOld()).done, (await detectOld()).needed], [true, false]);

    // ── 기록만 없는 상태(이행 도중 끊긴 것을 흉내)에서 다시 돌려도 같은 결과로 수렴한다
    await Deno.remove(dataPath("이행기록.json"));
    const 제외 = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("/기록/") && k !== "/이행기록.json"));
    const 앞2 = 제외(await 찍기(dataDir()));
    const 다시 = await migrate({ say: () => {} });
    같나("[끊긴 뒤 재개] 끝까지 간다", 다시.ok && 다시.ran && !다시.already, true);
    같나("[끊긴 뒤 재개] 새 채널·원장 줄·정책은 더하지 않는다", [다시.channels, 다시.ledgerRows, 다시.policies], [0, 0, 0]);
    같나("[끊긴 뒤 재개] 이미 자리 잡은 로그인 정보는 그대로 센다", 다시.tokens, 2);
    같나("[끊긴 뒤 재개] 데이터가 한 글자도 안 바뀌었다 (이행기록·로그 제외)", 제외(await 찍기(dataDir())), 앞2);
    참인가("[끊긴 뒤 재개] 이행기록이 다시 남았다", await exists(dataPath("이행기록.json")));
    g.uninstall();
  });

  구역("이행 — 아주 옛 단일 tokens.json (채널 하나짜리)");
  await 모래상자(async (dir) => {
    const g = new 감시구글();
    g.addChannel({ id: UC("a"), title: "내 채널 제목" }, "fake-refresh").install();
    const 폴더 = `${dir}/영상/옛폴더`;
    await Deno.mkdir(폴더, { recursive: true });
    await Deno.writeFile(`${폴더}/x.mp4`, new Uint8Array([1]));
    await Deno.writeTextFile(`${dataDir()}/config.json`, JSON.stringify({
      watchDir: 폴더, clientId: "fake-id.apps.googleusercontent.com", clientSecret: "fake-secret", privacy: "public",
      afterUpload: "keep", dailyLimit: 2, publishSlots: ["12:00"], port: 9000,
    }));
    const 옛토큰 = JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh", expires_at: 1, scope: SCOPES_LEGACY.join(" "), channel: { id: UC("a"), title: "내 채널 제목" } });
    await Deno.writeTextFile(`${dataDir()}/tokens.json`, 옛토큰);
    const 옛 = await detectOld();
    같나("detectOld: 단일 토큰도 대상", [옛.needed, 옛.singleToken, 옛.channels], [true, true, 1]);

    const r = await migrate({ say: () => {} });
    참인가("끝까지 갔다", r.ok && r.ran);
    const 사본들 = [...Deno.readDirSync(dataDir())].map((e) => e.name).filter((n) => n.startsWith("tokens.json.옛판_"));
    같나("새 꼴로 덮기 전에 사본을 먼저 만들었다", 사본들.length, 1);
    같나("사본은 원본과 한 글자도 다르지 않다", await 글(`${dataDir()}/${사본들[0]}`), 옛토큰);
    const 저장소 = loadStore();
    같나("새 tokens.json 은 새 꼴 (채널 이름 → 항목)", Object.keys(저장소), ["내 채널"]);
    같은값("「내 채널」 항목", 저장소["내 채널"], {
      channel_id: UC("a"), title: "내 채널 제목", refresh_token: "fake-refresh", scopes: [...SCOPES_LEGACY], how: "browser", secret: "client_secret_내_채널.json",
      added: 저장소["내 채널"]?.added,
    });
    참인가("added 는 읽을 수 있는 시각", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(저장소["내 채널"]?.added)));
    같나("전용 열쇠 파일이 평평한 옛 설정의 열쇠로 만들어졌다", JSON.parse(await 글(dataPath("client_secret_내_채널.json"))).installed.client_id, "fake-id.apps.googleusercontent.com");
    forgetAccessTokens();
    같나("옛 단일 토큰이 옛 열쇠로 갱신된다", await accessToken(저장소["내 채널"]), "AT:fake-refresh");
    같나("갱신 요청의 열쇠", [g.갱신[0].client_id, g.갱신[0].client_secret], ["fake-id.apps.googleusercontent.com", "fake-secret"]);
    같은값("평평한 옛 설정이 「내 채널」 한 칸으로", loadChannels()["내 채널"], {
      channel_id: UC("a"), folder: 폴더, prefix: "", publish: "schedule", times: ["12:00"], after_review: "public", after_upload: "keep", daily_rule: "fixed", daily: 2,
    });
    같나("일 한도 정책도 만들어졌다", loadPolicies().map((p) => [p.cfg.channel_id, p.cfg.daily_limit]), [[UC("a"), 2]]);
    참인가("백업했다고 참고로 적었다", r.notes.some((n) => n.includes("백업하고 새 꼴로 바꿨습니다")));
    같나("끝난 뒤 detectOld", [(await detectOld()).singleToken, (await detectOld()).done], [false, true]);
    같나("한 글자도 샌 데 없다", 가짜비밀들.filter((s) => (JSON.stringify(r) + formatReport(r).join("")).includes(s)), []);
    g.uninstall();
  });

  구역("이행 — 옛 자료가 다른 폴더에 있다 (GARASADAE_OLD_DATA_DIR)");
  await 모래상자(async (dir) => {
    const 옛폴더 = `${dir}/옛자료`;
    const g = new 감시구글();
    g.addChannel({ id: UC("a"), title: "채널A 제목" }, "fake-refresh").addChannel({ id: UC("b"), title: "채널B 제목" }, "fake-refresh-b").install();
    await 옛자료쓰기(dir, 옛폴더);
    const 앞 = await 찍기(옛폴더);
    const 앞환경 = env("GARASADAE_OLD_DATA_DIR");
    Deno.env.set("GARASADAE_OLD_DATA_DIR", 옛폴더);
    try {
      같나("detectOld: 옛 폴더를 본다", [(await detectOld()).dir, (await detectOld()).needed], [옛폴더, true]);
      const r = await migrate({ say: () => {} });
      참인가("끝까지 갔다", r.ok && r.ran && r.channels === 3);
      같나("옛 폴더는 한 글자도 안 바뀌었다 (새 파일도 안 생겼다)", await 찍기(옛폴더), 앞);
      참인가("새 파일은 새 데이터 폴더에 생겼다", await exists(dataPath("channels.json")) && await exists(dataPath("tokens.json")) && await exists(dataPath("이행기록.json")));
      같나("옛 폴더에 이행기록을 안 남겼다", await exists(`${옛폴더}/이행기록.json`), false);
    } finally {
      if (앞환경) Deno.env.set("GARASADAE_OLD_DATA_DIR", 앞환경); else Deno.env.delete("GARASADAE_OLD_DATA_DIR");
    }
    g.uninstall();
  });

  구역("이행 — 새 앱에 같은 이름이 이미 있을 때 · 이름 정리 · 열쇠 파일 이름 충돌");
  await 모래상자(async (dir) => {
    const g = new 감시구글();
    g.addChannel({ id: UC("a"), title: "채널A 제목" }, "fake-refresh").addChannel({ id: UC("b"), title: "채널B 제목" }, "fake-refresh-b").install();
    const 자리 = await 옛자료쓰기(dir);
    // 새 앱에 「채널A」가 이미 있다 — 다른 유튜브 채널이고, 다른 로그인이 붙어 있다
    await Deno.writeTextFile(dataPath("channels.json"), JSON.stringify({ "채널A": { channel_id: UC("z"), folder: `${dir}/다른폴더`, prefix: "" } }));
    await Deno.mkdir(`${dir}/다른폴더`, { recursive: true });
    await Deno.writeTextFile(dataPath("tokens.json"), JSON.stringify({ "채널A": { channel_id: UC("z"), title: "z", refresh_token: "other-refresh", added: "2026-01-01T00:00:00" } }));
    const 앞 = { 채널: await 글(dataPath("channels.json")), 토큰: await 글(dataPath("tokens.json")) };
    const r = await migrate({ say: () => {} });
    참인가("끝까지 갔다 (옛 채널을 하나도 버리지 않아 확인도 통과)", r.ok && r.ran && r.verify?.ok === true && !r.held);
    같나("새 앱의 같은 이름 채널 칸은 그대로", loadChannels()["채널A"], { channel_id: UC("z"), folder: `${dir}/다른폴더`, prefix: "" });
    같나("새 앱의 같은 이름 로그인도 그대로", (loadStore()["채널A"] as { refresh_token: string }).refresh_token, "other-refresh");
    같나("옛 채널A 는 버리지 않고 이름에 번호를 붙여 따로 옮겼다 (채널B·C 도)", r.channelNames, ["채널A (2)", "채널B", "채널C"]);
    같나("옛 채널A 의 채널 ID·폴더가 번호 붙은 칸으로 이어졌다", [loadChannels()["채널A (2)"]?.channel_id, loadChannels()["채널A (2)"]?.folder], [UC("a"), 자리.폴더A]);
    같나("옛 채널A 의 로그인도 번호 붙은 이름으로 (새 앱의 다른 로그인은 그대로)", (loadStore()["채널A (2)"] as { refresh_token: string }).refresh_token, "fake-refresh");
    참인가("이름을 비켜 간 까닭을 참고로 적었다", r.notes.some((n) => n.startsWith("[채널A (2)] 옛 이름 「채널A」")));
    같나("그 이름의 정책은 번호 붙은 채널(옛 채널A 의 채널 ID)에 걸렸다 — 엉뚱한 채널에 한도가 걸리지 않는다", loadPolicies().map((p) => [p.cfg.channel_id, p.cfg.label]), [[UC("a"), "채널A (2)"]]);
    같나("원장은 채널과 상관없이 옮겼다", readLedger().length, 4);
    같나("옛 채널A 의 열쇠 파일은 번호 붙은 이름으로 만들었고, 새 앱의 채널A 몫은 건드리지 않았다", [await exists(dataPath("client_secret_채널A_(2).json")), await exists(dataPath("client_secret_채널A.json"))], [true, false]);
    같나("확인이 옛 채널 3개를 모두 이어받았다고 말한다", [r.verify?.oldChannels, r.verify?.newChannels, r.verify?.totalChannels], [3, 3, 4]);
    void 앞; void 자리;
    g.uninstall();
  });

  await 모래상자(async (dir) => {
    const g = new 감시구글();
    g.addChannel({ id: UC("a"), title: "가" }, "r1").addChannel({ id: UC("b"), title: "나" }, "r2").addChannel({ id: UC("c"), title: "다" }, "r3").install();
    const 이 = (id: string, name: string, extra: Record<string, unknown>) => ({ id, name, folder: "", dailyLimit: 0, ...extra });
    await Deno.mkdir(`${dataDir()}/tokens`, { recursive: true });
    await Deno.writeTextFile(`${dataDir()}/config.json`, JSON.stringify({ schema: 2, channels: [
      이("ch_1", "채 널", { clientId: "id-1.apps.googleusercontent.com", clientSecret: "fake-secret-1" }),
      이("ch_2", "채_널", { clientId: "id-2.apps.googleusercontent.com", clientSecret: "fake-secret-2" }),
      이("ch_3", "채 널", { clientId: "id-3.apps.googleusercontent.com", clientSecret: "fake-secret-3" }),
      이("ch_4", "_숨김", { clientId: "id-1.apps.googleusercontent.com", clientSecret: "fake-secret-1" }),
    ] }));
    const 쓴다 = (id: string, rt: string, ch: string) => Deno.writeTextFile(`${dataDir()}/tokens/${id}.json`, JSON.stringify({ refresh_token: rt, channel: { id: UC(ch), title: ch } }));
    await 쓴다("ch_1", "r1", "a"); await 쓴다("ch_2", "r2", "b"); await 쓴다("ch_3", "r3", "c");
    const r = await migrate({ say: () => {} });
    같나("같은 이름은 (2) 를 붙이고, 「_」로 시작하는 이름(설명 메모로 읽힌다)은 다듬는다", r.channelNames, ["채 널", "채_널", "채 널 (2)", "숨김"]);
    const 저장소 = loadStore();
    같나("토큰이 들어간 채널", Object.keys(저장소).sort(), ["채 널", "채 널 (2)", "채_널"]);
    const 파일들 = Object.values(저장소).map((e) => e.secret);
    같나("이름이 같게 줄어드는 채널도 열쇠 파일이 서로 다르다", new Set(파일들).size, 3);
    for (const [이름, id] of [["채 널", "id-1"], ["채_널", "id-2"], ["채 널 (2)", "id-3"]] as const) {
      같나(`${이름}: 전용 열쇠가 자기 것이다`, (await clientFor(저장소[이름])).client_id, `${id}.apps.googleusercontent.com`);
    }
    같나("새 앱이 보는 채널 목록에 다듬은 이름이 있다", Object.keys(loadChannels()), ["채 널", "채_널", "채 널 (2)", "숨김"]);
    g.uninstall();
  });

  구역("이행 — 동시에 두 번 불러도 한 번만 돈다 · BOM 이 붙은 옛 파일");
  await 모래상자(async (dir) => {
    const g = new 감시구글();
    g.addChannel({ id: UC("a"), title: "채널A 제목" }, "fake-refresh").addChannel({ id: UC("b"), title: "채널B 제목" }, "fake-refresh-b").install();
    await 옛자료쓰기(dir);
    const [x, y] = await Promise.all([migrate({ say: () => {} }), migrate({ say: () => {} })]);
    같나("화면 서버와 명령줄이 동시에 불러도: 한쪽만 하고 한쪽은 「이미 했다」", [x.ran !== y.ran, x.already !== y.already, x.ok && y.ok], [true, true, true]);
    같나("원장 줄이 겹치지 않는다 (영상 ID 네 개가 한 번씩, 오래된 것부터)", readLedger().map((r) => r["영상ID"]), ["vid_x", "vid_1", "vid_2", "vid_3"]);
    같나("채널 칸도 겹치지 않는다", Object.keys(loadChannels()), ["채널A", "채널B", "채널C"]);
    g.uninstall();
  });
  await 모래상자(async () => {
    // 윈도우 메모장이 저장한 JSON 에는 앞에 BOM 이 붙는다
    await Deno.writeTextFile(`${dataDir()}/config.json`, "\uFEFF" + JSON.stringify({ schema: 2, channels: [{ id: "ch_1", name: "채널A", folder: "", dailyLimit: 0 }] }));
    const r = await migrate({ say: () => {} });
    같나("BOM 이 붙은 config.json 도 읽는다", [r.ok, r.channelNames], [true, ["채널A"]]);
  });

  구역("이행 — 깨진 config.json · 옮길 것이 없을 때");
  await 모래상자(async () => {
    await Deno.writeTextFile(`${dataDir()}/config.json`, '{"channels": [ {"name": "채널A", "clientSecret": "fake-secret"');
    const 앞 = await 찍기(dataDir());
    const r = await migrate({ say: () => {} });
    참인가("깨졌으면 멈추고 알린다 (ok=false)", !r.ok && r.errors.length === 1 && r.errors[0].includes("config.json"));
    const 데이터만 = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.endsWith(".lock") && k !== "/이행보류.json"));
    같나("옛 자료·새 구조는 아무것도 쓰지 않았다 (이행기록도 · 복사본도 없다 — 멈춤 표시와 빈 잠금 파일만 빼고)", 데이터만(await 찍기(dataDir())), 데이터만(앞));
    같나("대신 새 판을 멈춘다 (옮기지 못한 채 새 판이 혼자 돌지 않게) — 까닭에 config.json 이 있다", [migrationHold()?.reasons.some((x) => x.includes("config.json")), r.held], [true, true]);
    같나("오류 글에 파일 내용 조각이 섞이지 않는다", r.errors.join("").includes("fake-secret"), false);
    참인가("formatReport 가 멈췄다고 말한다", formatReport({ ...r, ran: true }).some((l) => l.includes("멈췄습니다")));
  });
  await 모래상자(async () => {
    const 옛 = await detectOld();
    같나("아무것도 없는 새 설치: 이행할 것 없음", [옛.needed, 옛.done, 옛.configFound, 옛.singleToken], [false, false, false, false]);
    const r = await migrate({ say: () => {} });
    같나("migrate 도 아무 일 없이 끝나고 기록을 안 남긴다", [r.ok, r.ran, r.already, await exists(dataPath("이행기록.json"))], [true, false, false, false]);
    같나("formatReport", formatReport(r), ["옮길 옛 판 자료가 없습니다."]);
  });
}

export async function 실행() {
  const 진짜런치에이전트 = join(env("HOME"), "Library", "LaunchAgents");
  const 앞 = await 목록찍기(진짜런치에이전트);
  await 맥시험();
  await 윈도우시험();
  await 리눅스시험();
  await 도구시험();
  await 이행시험();
  구역("진짜 집은 그대로");
  같나("진짜 ~/Library/LaunchAgents 는 이름·크기·바뀐 때가 하나도 안 바뀌었다 (시험은 가짜 집에만 썼다)", await 목록찍기(진짜런치에이전트), 앞);
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

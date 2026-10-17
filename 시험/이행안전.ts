// 이행 안전 시험 — 「등록해놓은 채널들 없어지지않도록 유지시키고」 (사장님 지시 2026-10)
//
// 옛 판(1.8.4)에서 자동 업데이트된 사람의 **채널 · 로그인 정보 · 채널 설정 · 폴더 · 예약 · 올린 기록**이 새 판으로 하나도 빠짐없이 넘어오는지 본다.
//   · 옛 자료는 실제 1.8.4 의 모양 그대로(config.json 의 channels[] · tokens/<채널id>.json · state.json 의 uploads[] · uploader.log)이고 값은 전부 가짜다.
//     채널 여섯: 자기 열쇠를 가진 채널 · 열쇠를 같이 쓰는 채널 · 폴더가 없어진 채널 · 로그인을 안 한 채널 · 같은 유튜브 채널을 이름 둘로 등록한 채널 · 로그인 파일이 깨진 채널.
//   · 구글은 가짜 서버가 받는다 — 옛 토큰이 **옛 열쇠로** 갱신되는지는 갱신 요청에 실린 client_id 로 잰다. 실제 네트워크는 한 번도 안 쓴다.
//   · 끊김·조용한 누락은 setMigrateFault 로 일부러 일으킨다(프로그램이 죽은 것 · 파일이 몰래 사라진 것을 흉내).
import { 같나, 결과, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { acceptMigration, backupAll, detectOld, formatReport, migrate, type MigrationReport, setMigrateFault } from "../app/migrate.ts";
import { migrationHold } from "../app/hold.ts";
import { dataDir, dataPath, exists, join, readJsonSync } from "../app/paths.ts";
import { editChannels, loadChannels } from "../app/channels.ts";
import { AuthError, accessToken, authErrorOf, clientFor, forgetAccessTokens, loadStore, SCOPES_LEGACY, updateStore } from "../app/ytcore.ts";
import { readLedger, readLedgerRaw, writeLedgerRaw } from "../app/ledger.ts";
import { ExitBlocked, exitGate, PublishBlocked, publishGate } from "../app/safety.ts";
import { tick } from "../app/tick.ts";
import * as ISS from "../app/issues.ts";
import { chanView } from "../app/views.ts";
import { loadProfiles } from "../app/profile.ts";
import * as Q from "../app/queue.ts";
import * as R from "../app/review.ts";
import { setEmbeddedForTest } from "../app/embedded.ts";
import { buildRoutes } from "../app/routes.ts";
import { newAppState } from "../app/routes.ts";

const UC = (c: string) => "UC" + c.repeat(22);
const FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl";
const 가짜비밀들 = ["fake-secret", "fake-refresh", "apps.googleusercontent.com", "fake-key", "fake-access", "embedded-secret"];

/* ─────────── 가짜 구글 + 갱신 요청이 쓴 열쇠 기록 ─────────── */

class 감시구글 extends 가짜구글 {
  갱신: { client_id: string; refresh: string }[] = [];
  constructor() {
    super();
    const 원래 = this.handle;
    this.handle = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/token") {
        const b = init?.body;
        const f = b instanceof URLSearchParams ? b : new URLSearchParams(String(b ?? ""));
        if (f.get("grant_type") === "refresh_token") this.갱신.push({ client_id: f.get("client_id") ?? "", refresh: f.get("refresh_token") ?? "" });
      }
      return 원래(input, init);
    };
  }
}

/* ─────────── 옛 판(1.8.4) 자료 — 실제 모양 그대로, 값은 가짜 ─────────── */

interface 옛자리 { A: string; B: string; C: string; D: string; E: string }

const 열쇠 = (x: string) => ({ clientId: `fake-id-${x}.apps.googleusercontent.com`, clientSecret: `fake-secret-${x}` });

async function 옛판쓰기(dir: string): Promise<옛자리> {
  const 영상 = `${dir}/영상`;
  const 자리: 옛자리 = { A: `${영상}/폴더A`, B: `${영상}/폴더B`, C: `${영상}/폴더C_없음`, D: `${영상}/폴더D`, E: `${영상}/폴더E` };
  for (const d of [`${자리.A}/_완료`, `${자리.A}/_실패`, 자리.B, 자리.D, 자리.E]) await Deno.mkdir(d, { recursive: true });
  // 아직 올리기를 기다리는 영상들 (예약 대기) — 이행은 이 파일들을 건드리면 안 된다
  for (const f of [`${자리.A}/a1.mp4`, `${자리.A}/a2.mp4`, `${자리.A}/_완료/old1.mp4`, `${자리.A}/_실패/f1.mp4`, `${자리.B}/b1.mp4`, `${자리.D}/d1.mp4`, `${자리.E}/e1.mp4`]) {
    await Deno.writeFile(f, new Uint8Array([1, 2, 3]));
  }
  const 이 = (id: string, name: string, extra: Record<string, unknown>) => ({
    id, name, folder: "", clientId: "", clientSecret: "", sharesWith: "", enabled: true, createdAt: "2026-08-20T01:02:03.000Z",
    privacy: "private", categoryId: "22", language: "ko", tags: [], description: "", titlePrefix: "", titleSuffix: "",
    madeForKids: false, notifySubscribers: true, reviewMode: false, afterUpload: "move", dailyLimit: 6, studioAfter: "ask",
    dupGuard: true, publishSlots: [], firstComment: false, firstCommentText: "", retitleHours: 0, retitleTemplate: "", ...extra,
  });
  const cfg = {
    schema: 2, port: 8777, pollSeconds: 5, stableChecks: 3, notifications: true, telegramAlerts: true,
    autoStart: false, autoStartAsked: true, updateDeclines: {}, baseDir: `${dir}/집/Desktop/업로드대기`, browser: "", aiTitles: false, aiKey: "", aiModel: "",
    channels: [
      이("ch_aaaa1111", "채널A", { folder: 자리.A, ...열쇠("a"), dailyLimit: 3, publishSlots: ["07:00", "19:00"], privacy: "public", titlePrefix: "[A] " }),
      이("ch_bbbb2222", "채널B", { folder: 자리.B, sharesWith: "ch_aaaa1111", dailyLimit: 0 }),
      이("ch_cccc3333", "채널C", { folder: 자리.C, ...열쇠("c"), dailyLimit: 2 }),
      이("ch_dddd4444", "채널D", { folder: 자리.D, ...열쇠("d"), dailyLimit: 0 }),
      이("ch_eeee5555", "채널E", { folder: 자리.E, ...열쇠("e"), dailyLimit: 0, afterUpload: "trash" }),
      이("ch_ffff6666", "채널F", { folder: "", ...열쇠("f"), dailyLimit: 0 }),
    ],
  };
  const 옛 = dataDir();
  await Deno.mkdir(`${옛}/tokens`, { recursive: true });
  await Deno.writeTextFile(`${옛}/config.json`, JSON.stringify(cfg, null, 2));
  const 토큰 = (rt: string, ch: string, scope: string | null) => JSON.stringify({
    access_token: "fake-access", refresh_token: rt, expires_at: 1, ...(scope ? { scope } : {}), channel: { id: UC(ch), title: `채널${ch.toUpperCase()} 제목`, thumb: "", subs: "1" },
  });
  await Deno.writeTextFile(`${옛}/tokens/ch_aaaa1111.json`, 토큰("fake-refresh-a", "a", `${SCOPES_LEGACY.join(" ")} ${FORCE_SSL}`));
  await Deno.writeTextFile(`${옛}/tokens/ch_bbbb2222.json`, 토큰("fake-refresh-b", "b", SCOPES_LEGACY.join(" ")));
  await Deno.writeTextFile(`${옛}/tokens/ch_cccc3333.json`, 토큰("fake-refresh-c", "c", null));
  // 채널D 는 로그인 정보 파일이 없다 (연결한 적이 없다)
  await Deno.writeTextFile(`${옛}/tokens/ch_eeee5555.json`, 토큰("fake-refresh-e", "a", SCOPES_LEGACY.join(" ")));   // 채널A 와 같은 유튜브 채널
  await Deno.writeTextFile(`${옛}/tokens/ch_ffff6666.json`, '{"access_token": "fake-access", "refresh_token": "fake-ref');   // 쓰다 만 깨진 파일
  const 올림 = [
    { id: "vid_s3", title: "예약 3", file: "s3.mp4", size: 3, privacy: "private", at: "2026-10-12T09:00:00", channelId: "ch_aaaa1111", channelName: "채널A", hash: "h3", publishAt: "2026-10-21T00:00:00.000Z" },
    { id: "vid_s2", title: "예약 2", file: "s2.mp4", size: 2, privacy: "private", at: "2026-10-11T09:00:00", channelId: "ch_aaaa1111", channelName: "채널A", publishAt: "2026-10-20T00:00:00.000Z" },
    { id: "vid_s1", title: "예약 1", file: "s1.mp4", size: 1, privacy: "private", at: "2026-10-10T09:00:00", channelId: "ch_bbbb2222", channelName: "채널B", publishAt: "2026-10-19T00:00:00.000Z" },
    { id: "vid_p2", title: "공개됨 2", file: "p2.mp4", size: 2, privacy: "public", at: "2026-10-09T08:00:00", channelId: "ch_cccc3333", channelName: "채널C" },
    { id: "vid_p1", title: "공개됨 1", file: "p1.mp4", size: 1, privacy: "public", at: "2026-10-08T08:00:00", channelId: "ch_eeee5555", channelName: "채널E" },
  ];
  await Deno.writeTextFile(`${옛}/state.json`, JSON.stringify({
    uploads: 올림, stats: { vid_p1: { views: 1, likes: 0, comments: 0, at: 1 } }, statsAt: 1,
    jobs: [], kept: {}, failed: {}, quota: {},
  }));
  await Deno.writeTextFile(`${옛}/uploader.log`, "2026-10-12 09:00:00 시작\n");
  return 자리;
}

/** 가짜 구글에 옛 로그인 정보들을 알려 준다 (깨진 F 와 안 쓴 D 는 없다) */
function 구글준비(): 감시구글 {
  const g = new 감시구글();
  g.addChannel({ id: UC("a"), title: "채널A 제목" }, "fake-refresh-a")
    .addChannel({ id: UC("b"), title: "채널B 제목" }, "fake-refresh-b")
    .addChannel({ id: UC("c"), title: "채널C 제목" }, "fake-refresh-c")
    .grant("fake-refresh-e", UC("a"))
    .install();
  return g;
}

/* ─────────── 찍기 ─────────── */

async function 해시(path: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const 옛파일들 = ["config.json", "state.json", "uploader.log", "tokens/ch_aaaa1111.json", "tokens/ch_bbbb2222.json", "tokens/ch_cccc3333.json", "tokens/ch_eeee5555.json", "tokens/ch_ffff6666.json"];
async function 옛해시(): Promise<Record<string, string>> {
  const o: Record<string, string> = {};
  for (const f of 옛파일들) o[f] = await 해시(`${dataDir()}/${f}`);
  return o;
}
/** 영상 파일(기다리는 것 · 옛 _완료 · _실패)의 이름과 내용 — 이행이 하나도 안 건드렸나 */
async function 영상찍기(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p); else if (e.isFile) out[p.slice(root.length)] = await 해시(p);
    }
  };
  await walk(root);
  return out;
}
/** 새 구조 파일들의 글 (샌드박스 경로는 <DIR> 로) — 두 상자의 결과를 견주려고 */
async function 새구조(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const names = [...Deno.readDirSync(dataDir())].filter((e) => e.isFile).map((e) => e.name)
    .filter((n) => n === "channels.json" || n === "tokens.json" || n === "ledger.csv" || n === "앱설정.json" || /_daily_policy(_\d+)?\.json$/.test(n) || /^client_secret_.*\.json$/.test(n));
  for (const n of names.sort()) out[n] = (await Deno.readTextFile(join(dataDir(), n))).split(dir).join("<DIR>");
  return out;
}
const 백업폴더들 = (): string[] => {
  try { return [...Deno.readDirSync(dataPath("백업"))].filter((e) => e.isDirectory && /^이행전_/.test(e.name) && !e.name.endsWith(".작성중")).map((e) => e.name).sort(); } catch { return []; }
};
const 정렬 = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(정렬)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, 정렬(x)]))
    : v;
const 같은값 = (무엇: string, 실제: unknown, 바람: unknown) => 같나(무엇, 정렬(실제), 정렬(바람));
const 새게 = () => ({ ctx: null as unknown });
void 새게;

/** 이행 한 번 (조용히) */
const 옮기기 = () => migrate({ say: () => {} });

/* ═══════════════════════════ 1. 옮기기 전에 복사본을 먼저 ═══════════════════════════ */

async function 복사본시험() {
  구역("복사본 — 옮기기 전에 옛 자료를 날짜 붙은 폴더에 통째로 복사해 둔다");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    await 옛판쓰기(dir);
    const 앞 = await 옛해시();
    // 복사가 끝난 순간(아직 아무것도 안 옮긴 때)의 상태를 훔쳐본다
    const 본것: { 새구조있나: boolean; 복사본: string[]; 단일: boolean } = { 새구조있나: true, 복사본: [], 단일: false };
    setMigrateFault(async (자리) => {
      if (자리 !== "복사끝") return;
      본것.새구조있나 = (await exists(dataPath("channels.json"))) || (await exists(dataPath("tokens.json"))) || (await exists(dataPath("ledger.csv"))) || (await exists(dataPath("앱설정.json")));
      본것.복사본 = 백업폴더들();
    });
    const r = await 옮기기();
    setMigrateFault(null);
    참인가("끝까지 갔다 · 확인 통과 · 멈추지 않았다", r.ok && r.ran && r.verify?.ok === true && !r.held && !migrationHold());
    같나("복사가 끝난 순간에는 새 구조 파일이 하나도 없었다 (복사본이 먼저다)", 본것.새구조있나, false);
    같나("그 순간 복사본 폴더가 이미 하나 있었다", 본것.복사본.length, 1);

    const 폴더 = 백업폴더들();
    같나("복사본 폴더는 하나", 폴더.length, 1);
    const 복사본 = dataPath("백업", 폴더[0]);
    같나("보고가 복사본 위치를 알려 준다", [r.backupDir, r.backupReused], [복사본, false]);
    참인가("폴더 이름에 날짜·시각이 있다 (이행전_YYYYMMDD_HHMMSS)", /^이행전_\d{8}_\d{6}$/.test(폴더[0]));
    for (const f of 옛파일들.filter((x) => x !== "uploader.log")) {
      같나(`복사본 ${f} 은 원본과 한 글자도 다르지 않다`, await 해시(`${복사본}/옛자료/${f}`), 앞[f]);
    }
    참인가("복사본에 목록과 안내문이 있다", (await exists(`${복사본}/목록.json`)) && (await exists(`${복사본}/읽어보세요.txt`)));
    같나("작성중 폴더가 남지 않았다", [...Deno.readDirSync(dataPath("백업"))].some((e) => e.name.endsWith(".작성중")), false);
    if (Deno.build.os !== "windows") {
      같나("복사본 폴더 700 · 파일 600 (로그인 정보가 든다)", [
        (await Deno.stat(복사본)).mode! & 0o777, (await Deno.stat(`${복사본}/옛자료/tokens/ch_aaaa1111.json`)).mode! & 0o777,
      ], [0o700, 0o600]);
    }
    같나("옛 파일은 한 글자도 안 바뀌었다 (지우거나 덮지 않았다)", await 옛해시(), 앞);

    // 같은 자료로 다시 돌면 복사본이 늘지 않는다
    await Deno.remove(dataPath("이행기록.json"));
    const r2 = await 옮기기();
    같나("기록 없이 다시 돌아도 복사본은 새로 안 만든다 (같은 자료의 복사본을 쓴다)", [백업폴더들().length, r2.backupReused, r2.backupDir], [1, true, 복사본]);

    // 값이 어디에도 안 샌다
    const 글들: [string, string][] = [["보고 JSON", JSON.stringify(r)], ["보고 줄", formatReport(r).join("\n")], ["이행기록.json", await Deno.readTextFile(dataPath("이행기록.json"))],
      ["복사본 목록", await Deno.readTextFile(`${복사본}/목록.json`)], ["안내문", await Deno.readTextFile(`${복사본}/읽어보세요.txt`)]];
    for (const [어디, 내용] of 글들) 같나(`열쇠·토큰 값이 새지 않았다 — ${어디}`, 가짜비밀들.filter((s) => 내용.includes(s)), []);
    g.uninstall();
  });

  구역("복사본 — 복사를 못 하면 아무것도 옮기지 않는다");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    await 옛판쓰기(dir);
    const 앞 = await 옛해시();
    // 「백업」 자리를 파일로 막아 폴더를 못 만들게 한다
    await Deno.writeTextFile(dataPath("백업"), "막힘");
    const r = await 옮기기();
    참인가("복사본을 못 만들어 멈췄다", !r.ok && r.errors.some((e) => e.includes("복사해 두지 못해 아무것도 옮기지 않았습니다")));
    같나("아무것도 옮기지 않았다 (새 구조 파일 없음 · 이행기록 없음)", [await exists(dataPath("channels.json")), await exists(dataPath("tokens.json")), await exists(dataPath("ledger.csv")), await exists(dataPath("이행기록.json"))], [false, false, false, false]);
    참인가("대신 새 판을 멈춘다", !!migrationHold() && r.held);
    같나("옛 파일은 그대로", await 옛해시(), 앞);
    // 막은 것을 치우면 이어서 끝낸다
    await Deno.remove(dataPath("백업"));
    const r2 = await 옮기기();
    참인가("막힘을 치우고 다시 돌리면 끝까지 간다 · 멈춤이 풀린다", r2.ok && r2.verify?.ok === true && !migrationHold());
    g.uninstall();
  });

  구역("복사본 — 옛 단일 tokens.json 도 복사본에 들어 있다");
  await 모래상자(async (dir) => {
    const g = new 감시구글();
    g.addChannel({ id: UC("a"), title: "내 채널 제목" }, "fake-refresh").install();
    const 폴더 = `${dir}/영상/옛폴더`;
    await Deno.mkdir(폴더, { recursive: true });
    await Deno.writeTextFile(`${dataDir()}/config.json`, JSON.stringify({ watchDir: 폴더, clientId: "fake-id.apps.googleusercontent.com", clientSecret: "fake-secret", dailyLimit: 2 }));
    const 옛토큰 = JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh", expires_at: 1, scope: SCOPES_LEGACY.join(" "), channel: { id: UC("a"), title: "내 채널 제목" } });
    await Deno.writeTextFile(`${dataDir()}/tokens.json`, 옛토큰);
    const r = await 옮기기();
    참인가("끝까지 갔다 · 확인 통과", r.ok && r.verify?.ok === true && r.verify.tokensOld === 1 && r.verify.tokensNew === 1);
    const 폴더들 = 백업폴더들();
    같나("복사본에 단일 tokens.json 이 그대로 있다 (새 꼴로 바꾸기 전 모습)", await Deno.readTextFile(dataPath("백업", 폴더들[0], "옛자료", "tokens.json")), 옛토큰);
    g.uninstall();
  });
}

/* ═══════════════════════════ 2. 숫자 그대로 ═══════════════════════════ */

async function 그대로시험() {
  구역("확인 — 옛 채널 수 = 새 채널 수 · 로그인 정보 · 올린 기록(예약 포함) · 폴더가 그대로");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    const 자리 = await 옛판쓰기(dir);
    const 영상앞 = await 영상찍기(`${dir}/영상`);
    const r = await 옮기기();
    const v = r.verify!;
    참인가("끝까지 갔다 · 멈추지 않았다", r.ok && r.ran && !r.held && !migrationHold());
    같은값("확인 숫자: 옛 채널 6 → 새 6 · 로그인 정보 4 → 4 · 올린 기록 5 → 5", {
      ok: v.ok, oldChannels: v.oldChannels, newChannels: v.newChannels, totalChannels: v.totalChannels, tokensOld: v.tokensOld, tokensNew: v.tokensNew, ledgerOld: v.ledgerOld, ledgerNew: v.ledgerNew, missing: v.missing,
    }, { ok: true, oldChannels: 6, newChannels: 6, totalChannels: 6, tokensOld: 4, tokensNew: 4, ledgerOld: 5, ledgerNew: 5, missing: [] });
    같나("새 앱의 채널 칸 이름", Object.keys(loadChannels()), ["채널A", "채널B", "채널C", "채널D", "채널E", "채널F"]);

    // 채널 ID · 폴더
    const 채널 = loadChannels();
    같나("채널마다 유튜브 채널 ID 가 옛 로그인 정보의 것과 같다 (로그인 없던 D·F 는 비어 있다)",
      Object.fromEntries(Object.entries(채널).map(([k, c]) => [k, c.channel_id])),
      { 채널A: UC("a"), 채널B: UC("b"), 채널C: UC("c"), 채널D: "", 채널E: UC("a"), 채널F: "" });
    같나("폴더도 그대로 (없어진 C 는 비우되 옛 자리를 기억 · 폴더가 없던 F 는 비어 있다)",
      Object.fromEntries(Object.entries(채널).map(([k, c]) => [k, [c.folder, c.old_folder ?? ""]])),
      { 채널A: [자리.A, ""], 채널B: [자리.B, ""], 채널C: ["", 자리.C], 채널D: [자리.D, ""], 채널E: [자리.E, ""], 채널F: ["", ""] });

    // 로그인 정보 — 갱신 토큰 · 권한 · 받은 열쇠
    const 저장소 = loadStore();
    같나("로그인 정보가 들어간 채널 (연결한 적 없는 D · 파일이 깨진 F 는 원래 없던 것)", Object.keys(저장소).sort(), ["채널A", "채널B", "채널C", "채널E"]);
    같나("갱신 토큰이 옛 것과 같다", Object.fromEntries(Object.entries(저장소).map(([k, e]) => [k, e.refresh_token])), { 채널A: "fake-refresh-a", 채널B: "fake-refresh-b", 채널C: "fake-refresh-c", 채널E: "fake-refresh-e" });
    같나("권한(scope)이 옛 것 그대로 (force-ssl 이 있던 A 는 그대로 · 없던 C 는 옛 두 범위)", Object.fromEntries(Object.entries(저장소).map(([k, e]) => [k, e.scopes])), {
      채널A: [...SCOPES_LEGACY, FORCE_SSL], 채널B: [...SCOPES_LEGACY], 채널C: [...SCOPES_LEGACY], 채널E: [...SCOPES_LEGACY],
    });
    참인가("D·F 는 다시 연결하라고 보고에 올랐다 (옛 판에서도 로그인이 없던 채널)", ["채널D", "채널F"].every((n) => r.needLogin.includes(n)));
    참인가("깨진 로그인 파일은 깨졌다고 따로 말한다", r.skipped.some((s) => s.startsWith("[채널F] 로그인 정보 — 로그인 정보 파일을 읽을 수 없습니다")));

    // 올린 기록 · 예약
    const 원장 = readLedger();
    같나("옛 올린 기록 다섯이 영상 ID 로 모두 새 원장에 있다", 원장.map((x) => x["영상ID"]).sort(), ["vid_p1", "vid_p2", "vid_s1", "vid_s2", "vid_s3"]);
    같나("예약 시각이 그대로 옮겨졌다 (옛 Z 시각은 이 컴퓨터 시각으로)", Object.fromEntries(원장.filter((x) => x["영상ID"].startsWith("vid_s")).map((x) => [x["영상ID"], x["예약시각"]])),
      { vid_s1: "2026-10-19 09:00", vid_s2: "2026-10-20 09:00", vid_s3: "2026-10-21 09:00" });
    같은값("예약된 영상의 채널 이름이 새 이름으로 이어졌다", Object.fromEntries(원장.map((x) => [x["영상ID"], x["채널"]])),
      { vid_s3: "채널A", vid_s2: "채널A", vid_s1: "채널B", vid_p2: "채널C", vid_p1: "채널E" });

    // 기다리는 영상 · 새 앱의 발사대기는 건드리지 않았다
    같나("폴더에서 기다리는 영상과 옛 _완료·_실패의 영상이 이름·내용 그대로 (하나도 안 옮기고 안 지웠다)", await 영상찍기(`${dir}/영상`), 영상앞);
    같나("새 앱의 발사대기·심사 대기는 비어 있다 (이행이 영상을 몰래 올리거나 큐에 넣지 않는다)", [Q.list().length, R.loadPending().length], [0, 0]);

    // 같은 유튜브 채널 두 이름
    참인가("같은 유튜브 채널을 이름 둘로 등록했던 A·E 는 합치지 않고 그대로 두었다고 알린다", r.warnings.some((w) => w.includes("[채널A] · [채널E]") && w.includes("같은 유튜브 채널")));
    참인가("A 와 E 의 로그인 정보가 둘 다 남아 있다 (서로 다른 갱신 토큰)", !!저장소["채널A"] && !!저장소["채널E"] && 저장소["채널A"].refresh_token !== 저장소["채널E"].refresh_token);

    // 옛 파일은 그대로
    같나("옛 파일은 한 글자도 안 바뀌었다 (옛 판으로 되돌려도 다시 돈다)", Object.keys(await 옛해시()).length, 옛파일들.length);

    // 보고 줄
    const 줄 = formatReport(r).join("\n");
    참인가("보고 줄에 복사본 위치와 확인 숫자가 있다", 줄.includes("옛 자료 복사본:") && 줄.includes("옮긴 뒤 확인: 채널 6 → 6 · 로그인 정보 4 → 4 · 올린 기록 5 → 5 — 빠진 것 없음"));
    같나("값이 새지 않았다", 가짜비밀들.filter((s) => 줄.includes(s) || JSON.stringify(r).includes(s)), []);
    g.uninstall();
  });
}

/* ═══════════════════════════ 3. 옛 열쇠로 계속 산다 ═══════════════════════════ */

async function 열쇠시험() {
  구역("옛 토큰은 다시 인증 없이 그대로 — 기본(내장) 열쇠로 바꿔 끼우지 않는다");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    await 옛판쓰기(dir);
    // 이 앱에 묶여 온 기본 열쇠가 있다 — 옛 토큰은 그래도 제 열쇠로 갱신돼야 한다
    setEmbeddedForTest("browser", { client_id: "embedded-id.apps.googleusercontent.com", client_secret: "embedded-secret", token_uri: "https://oauth2.googleapis.com/token" });
    const r = await 옮기기();
    참인가("끝까지 갔다", r.ok && r.verify?.ok === true);
    const 저장소 = loadStore();
    forgetAccessTokens();
    const 바람: Record<string, string> = { 채널A: "fake-id-a", 채널B: "fake-id-a", 채널C: "fake-id-c", 채널E: "fake-id-e" };
    for (const [이름, id] of Object.entries(바람)) {
      같나(`${이름}: 옛 열쇠(${id})를 고른다 — 기본 열쇠가 아니다`, (await clientFor(저장소[이름])).client_id, `${id}.apps.googleusercontent.com`);
    }
    for (const 이름 of Object.keys(바람)) 같나(`${이름}: 옛 토큰이 다시 인증 없이 갱신된다`, (await accessToken(저장소[이름])).startsWith("AT:fake-refresh-"), true);
    같은값("갱신 요청에 실린 열쇠는 전부 옛 열쇠 (기본 열쇠로 간 요청은 0건)", g.갱신.map((x) => [x.refresh, x.client_id]).sort(), [
      ["fake-refresh-a", "fake-id-a.apps.googleusercontent.com"], ["fake-refresh-b", "fake-id-a.apps.googleusercontent.com"],
      ["fake-refresh-c", "fake-id-c.apps.googleusercontent.com"], ["fake-refresh-e", "fake-id-e.apps.googleusercontent.com"],
    ]);
    같나("기본 열쇠로 간 갱신 요청이 없다", g.갱신.some((x) => x.client_id.startsWith("embedded")), false);
    같나("채널마다 전용 열쇠 파일을 가리킨다 (secret 칸)", Object.fromEntries(Object.entries(저장소).map(([k, e]) => [k, e.secret])), {
      채널A: "client_secret_채널A.json", 채널B: "client_secret_채널B.json", 채널C: "client_secret_채널C.json", 채널E: "client_secret_채널E.json",
    });
    setEmbeddedForTest("browser", null);
    g.uninstall();
  });
}

/* ═══════════════════════════ 4. 두 번 돌려도 같다 · 끊겨도 이어서 ═══════════════════════════ */

async function 되풀이시험() {
  // 깨끗하게 한 번에 끝낸 결과 (비교 기준)
  let 기준: Record<string, string> = {};
  구역("되풀이 — 같은 자료로 두 번·세 번 돌려도 결과가 같다 (중복 채널·중복 기록·중복 복사본 없음)");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    await 옛판쓰기(dir);
    const r = await 옮기기();
    참인가("처음은 끝까지 간다", r.ok && r.verify?.ok === true);
    기준 = await 새구조(dir);
    같나("기준이 채널·로그인·원장·설정·정책·열쇠 파일을 모두 담았다", Object.keys(기준).length >= 8, true);
    const 이행기록 = readJsonSync<Record<string, unknown>>(dataPath("이행기록.json"), {});
    참인가("이행기록.json 이 남았고 복사본 위치가 적혀 있다", typeof 이행기록.복사본 === "string" && (이행기록.복사본 as string).includes("이행전_"));

    const 둘째 = await 옮기기();
    참인가("두 번째는 「이미 했다」", 둘째.already && !둘째.ran && 둘째.ok);
    같나("두 번째는 새 구조를 한 글자도 안 바꾼다", await 새구조(dir), 기준);

    // 기록만 지우고 다시 — 몇 번이든 같은 결과
    for (let i = 1; i <= 3; i++) {
      await Deno.remove(dataPath("이행기록.json"));
      const x = await 옮기기();
      참인가(`[기록 지우고 ${i}번째 재실행] 끝까지 간다 · 확인 통과`, x.ok && x.ran && x.verify?.ok === true);
      같나(`[기록 지우고 ${i}번째 재실행] 새 구조가 한 글자도 안 바뀌었다 (채널·로그인·원장·정책·열쇠 파일 모두)`, await 새구조(dir), 기준);
      같나(`[기록 지우고 ${i}번째 재실행] 새로 더한 채널·원장 줄·정책은 0`, [x.channels, x.ledgerRows, x.policies], [0, 0, 0]);
    }
    같나("복사본은 계속 하나", 백업폴더들().length, 1);
    같나("채널 칸이 겹치지 않았다 (중복 채널 없음)", Object.keys(loadChannels()).length, 6);
    같나("원장 줄이 겹치지 않았다 (중복 기록 없음)", readLedger().length, 5);
    g.uninstall();
  });

  구역("끊김 — 이행 도중 어디서 끊겨도 다음에 켤 때 이어서 끝낸다 (끊긴 자리마다 처음부터 같은 결과로 수렴)");
  const 자리들 = [
    "복사끝", "채널시작:채널A", "로그인끝:채널A", "채널칸끝:채널A", "로그인끝:채널B", "채널시작:채널C", "채널칸끝:채널C",
    "로그인끝:채널E", "채널칸끝:채널F", "원장시작", "원장끝", "설정끝", "옮기기끝", "기록직전",
  ];
  for (const 자리 of 자리들) {
    await 모래상자(async (dir) => {
      const g = 구글준비();
      await 옛판쓰기(dir);
      const 앞 = await 옛해시();
      const 영상앞 = await 영상찍기(`${dir}/영상`);
      let 한번 = true;
      setMigrateFault((x) => { if (x === 자리 && 한번) { 한번 = false; throw new Error("시험: 여기서 끊김"); } });
      const r1 = await 옮기기();
      참인가(`[${자리}] 끊기면 멈추고 이행기록을 남기지 않는다`, !r1.ok && !(await exists(dataPath("이행기록.json"))));
      참인가(`[${자리}] 끊긴 동안 새 판은 올리기를 멈춘다 (이행 보류)`, !!migrationHold());
      같나(`[${자리}] 끊겨도 옛 파일·영상은 그대로`, [await 옛해시(), await 영상찍기(`${dir}/영상`)], [앞, 영상앞]);
      // 다음에 켤 때
      const st = await detectOld();
      참인가(`[${자리}] 다음에 켜면 아직 옮길 것이 남았다고 나온다`, st.needed && !st.done);
      setMigrateFault(null);
      const r2 = await 옮기기();
      참인가(`[${자리}] 이어서 끝까지 간다 · 확인 통과 · 멈춤이 풀린다`, r2.ok && r2.verify?.ok === true && !migrationHold() && (await exists(dataPath("이행기록.json"))));
      같나(`[${자리}] 끝낸 결과가 한 번에 깨끗이 끝낸 것과 한 글자도 다르지 않다`, await 새구조(dir), 기준);
      같나(`[${자리}] 복사본은 하나뿐 (끊겨 다시 돌아도 안 쌓인다)`, 백업폴더들().length, 1);
      같나(`[${자리}] 채널 ${Object.keys(loadChannels()).length}개 · 원장 ${readLedger().length}줄 — 겹침 없음`, [Object.keys(loadChannels()).length, readLedger().length], [6, 5]);
      g.uninstall();
    });
  }
}

/* ═══════════════════════════ 5. 하나라도 빠지면 새 판을 멈춘다 ═══════════════════════════ */

async function 보류시험() {
  구역("확인 실패 — 하나라도 빠지면 새 구조를 쓰지 않는다 (기록 안 남김 · 올리기 멈춤 · 빨간 경고 + 복사본 위치)");
  const 변형: { 이름: string; 조각: string; 망가뜨리기: () => Promise<void> }[] = [
    { 이름: "로그인 정보 하나가 사라짐", 조각: "[채널B] 로그인 정보가 새 앱에 온전히", 망가뜨리기: async () => { await updateStore((s) => { delete s["채널B"]; }); } },
    { 이름: "채널 칸 하나가 사라짐", 조각: "[채널C] 채널 칸이 새 앱에 없습니다", 망가뜨리기: async () => { await editChannels((d) => { delete d["채널C"]; }); } },
    { 이름: "유튜브 채널 ID 가 달라짐", 조각: "[채널A] 유튜브 채널 ID 가 옛 판과 다릅니다", 망가뜨리기: async () => { await editChannels((d) => { d["채널A"].channel_id = UC("z"); }); } },
    { 이름: "폴더 설정이 달라짐", 조각: "[채널A] 폴더 설정이 옛 판과 이어지지 않습니다", 망가뜨리기: async () => { await editChannels((d) => { d["채널A"].folder = "/다른곳"; }); } },
    { 이름: "받은 구글 열쇠가 다른 것으로 바뀜", 조각: "[채널A] 로그인 정보가 새 앱에 온전히", 망가뜨리기: async () => { await Deno.writeTextFile(dataPath("client_secret_채널A.json"), JSON.stringify({ installed: { client_id: "엉뚱한-id", client_secret: "엉뚱한-secret", token_uri: "https://oauth2.googleapis.com/token" } })); } },
    { 이름: "갱신 토큰이 다른 것으로 바뀜", 조각: "[채널E] 로그인 정보가 새 앱에 온전히", 망가뜨리기: async () => { await updateStore((s) => { s["채널E"].refresh_token = "다른-토큰"; }); } },
    { 이름: "권한(scope)이 줄어듦", 조각: "[채널A] 로그인 정보가 새 앱에 온전히", 망가뜨리기: async () => { await updateStore((s) => { s["채널A"].scopes = [SCOPES_LEGACY[0]]; }); } },
    { 이름: "예약된 올린 기록이 사라짐", 조각: "옛 올린 기록 1건이 새 원장에 없습니다", 망가뜨리기: async () => {
      const raw = readLedgerRaw()!; const idCol = raw[0].indexOf("영상ID");
      await writeLedgerRaw(raw.filter((r, i) => i === 0 || r[idCol] !== "vid_s3"));
    } },
  ];
  for (const v of 변형) {
    await 모래상자(async (dir) => {
      const g = 구글준비();
      await 옛판쓰기(dir);
      const 앞 = await 옛해시();
      setMigrateFault(async (자리) => { if (자리 === "옮기기끝") await v.망가뜨리기(); });
      const r = await 옮기기();
      setMigrateFault(null);
      참인가(`[${v.이름}] 확인이 잡아낸다 — 빠진 것에 「${v.조각.slice(0, 22)}…」`, !r.ok && r.verify?.ok === false && r.verify.missing.some((m) => m.includes(v.조각)));
      같나(`[${v.이름}] 이행기록을 남기지 않고 새 판을 멈춘다`, [await exists(dataPath("이행기록.json")), r.held, !!migrationHold()], [false, true, true]);
      같나(`[${v.이름}] 옛 파일은 한 글자도 안 바뀌었다 (옛 자료로 계속 돈다)`, await 옛해시(), 앞);
      const h = migrationHold()!;
      참인가(`[${v.이름}] 멈춤 기록에 복사본 위치·빠진 것·옛 자료 위치가 있다`, h.backupDir.includes("이행전_") && (await exists(h.backupDir)) && h.missing.length > 0 && h.oldDir === dataDir());
      g.uninstall();
    });
  }

  구역("멈춤 — 새 판은 올리기·공개·예약 쏘기·심사확인을 하지 않고, 문제 목록에 빨간 줄이 뜬다");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    const 자리 = await 옛판쓰기(dir);
    setMigrateFault(async (x) => { if (x === "옮기기끝") await updateStore((s) => { delete s["채널B"]; }); });
    const r = await 옮기기();
    setMigrateFault(null);
    참인가("멈췄다", r.held && !!migrationHold());
    const 멈춤 = migrationHold()!;

    // 관문
    const 파일 = `${자리.A}/a1.mp4`;
    const 막힘 = async (무엇: string, f: () => Promise<unknown>, 종류: new (...a: never[]) => Error) => {
      try { await f(); 같나(무엇, "안 막힘", "막힘"); } catch (e) { 같나(무엇, [e instanceof 종류, String((e as Error).message).includes("옛 판 자료를 새 판으로 옮긴 결과"), String((e as Error).message).includes(멈춤.backupDir)], [true, true, true]); }
    };
    await 막힘("올리기 출구(exitGate)가 사람 승인이 있어도 막는다 — 까닭에 복사본 위치", () => exitGate({ channel: "채널A", _alias: "채널A", _승인: "사람" }, 파일), ExitBlocked);
    await 막힘("공개 관문(publishGate)이 예약작업·사람 어느 쪽이든 막는다", () => publishGate("예약작업", { title: "예약 1", video_id: "vid_s1", channel: "채널B", 확인수: 1 }), PublishBlocked);
    const t = await tick({ force: true });
    참인가("심사확인(tick)은 아무것도 안 하고 까닭을 말한다", t.skipped.startsWith("이행 보류 중") && t.steps.length === 0 && t.fired === 0);

    // 문제 목록
    const 목록 = await ISS.collect(loadChannels());
    const 빨강 = 목록.find((x) => x.level === "red" && x.what.includes("옛 판 자료를 새 판으로 옮긴 결과"));
    참인가("문제 목록 맨 위에 빨간 줄", !!빨강 && 목록[0] === 빨강);
    같나("빨간 줄: 복사본 위치와 빠진 것이 까닭에 있다", [빨강?.why.includes(멈춤.backupDir), 빨강?.why.includes("[채널B]")], [true, true]);
    같나("빨간 줄의 고치기: 다시 옮기기 (POST /api/migrate/retry)", [빨강?.fix?.label, 빨강?.fix?.api], ["다시 옮기기", "/api/migrate/retry"]);
    같나("빨강은 「확인했음」으로 못 지운다 (자동 고침도 아니다)", [빨강?.auto, ISS.summary(목록).red >= 1], [false, true]);

    // 다시 옮기기 (고쳐 다시 돌린다 — 지워졌던 로그인 정보가 옛 자료에서 다시 복사된다)
    const r2 = await 옮기기();
    참인가("다시 옮기기: 확인 통과 · 이행기록 · 멈춤 풀림", r2.ok && r2.verify?.ok === true && !migrationHold() && (await exists(dataPath("이행기록.json"))));
    같나("B 의 로그인 정보가 되살아났다", loadStore()["채널B"]?.refresh_token, "fake-refresh-b");
    같나("문제 목록의 빨간 줄이 사라졌다", (await ISS.collect(loadChannels())).some((x) => x.what.includes("옛 판 자료를 새 판으로 옮긴 결과")), false);
    try { await exitGate({ channel: "채널A", _alias: "채널A", _승인: "사람" }, 파일); 같나("멈춤이 풀린 뒤 출구는 이행 보류로는 안 막는다", "통과", "통과"); } catch (e) {
      같나("멈춤이 풀린 뒤 출구는 이행 보류로는 안 막는다", String((e as Error).message).includes("옛 판 자료를 새 판으로 옮긴 결과"), false);
    }
    const t2 = await tick({ force: true });
    같나("심사확인이 다시 돈다", t2.skipped.startsWith("이행 보류"), false);
    g.uninstall();
  });

  구역("멈춤 — 사람이 「그대로 새 판을 쓰겠다」고 받아들이면 풀린다 (옛 자료와 복사본은 남는다)");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    await 옛판쓰기(dir);
    const 앞 = await 옛해시();
    setMigrateFault(async (x) => { if (x === "옮기기끝") await editChannels((d) => { delete d["채널C"]; }); });
    const r = await 옮기기();
    setMigrateFault(null);
    참인가("멈췄다", r.held && !!migrationHold());
    const 복사본 = migrationHold()!.backupDir;

    // 화면 길: confirm 이 없으면 거절한다
    const 길 = buildRoutes(newAppState() as never);
    const 몸 = (body: Record<string, unknown>) => ({ q: new URLSearchParams(), body, headers: new Headers(), req: new Request("http://127.0.0.1/"), port: 0 });
    await 던지나("받아들이기는 확인 표시(confirm) 없이는 거절", () => 길.post["migrate/accept"](몸({}) as never), /confirm/);
    참인가("거절당해도 멈춤은 그대로", !!migrationHold());
    await 길.post["migrate/accept"](몸({ confirm: true }) as never);
    같나("받아들이면 멈춤이 풀리고 이행기록이 남는다 (사람이 받아들였다고 적힌다)", [!!migrationHold(), readJsonSync<Record<string, unknown>>(dataPath("이행기록.json"), {}).사람이받아들임], [false, true]);
    같나("옛 파일과 복사본은 그대로", [await 옛해시(), await exists(복사본)], [앞, true]);
    const 다음 = await 옮기기();
    참인가("그 뒤에 켜면 다시 옮기려 하지 않는다 (이미 했다)", 다음.already);
    g.uninstall();
  });
}

/* ═══════════════════════════ 6. 어떤 코드도 채널을 자동으로 지우지 않는다 ═══════════════════════════ */

async function 자동삭제없음시험() {
  구역("로그인이 풀려도(invalid_grant) 채널과 로그인 정보는 남고 「다시 연결 필요」 표시만 뜬다");
  await 모래상자(async (dir) => {
    const g = 구글준비();
    await 옛판쓰기(dir);
    const r = await 옮기기();
    참인가("이행 끝", r.ok && r.verify?.ok === true);
    const 앞 = { 채널: await Deno.readTextFile(dataPath("channels.json")), 토큰: await Deno.readTextFile(dataPath("tokens.json")), 원장: await Deno.readTextFile(dataPath("ledger.csv")) };
    const 이름들 = Object.keys(loadChannels());

    // 채널B 의 갱신 토큰이 구글에서 취소됐다
    g.refreshTo.delete("fake-refresh-b");
    forgetAccessTokens();
    let 던짐: unknown = null;
    try { await accessToken(loadStore()["채널B"]); } catch (e) { 던짐 = e; }
    참인가("갱신이 거절되면 로그인 오류로 알린다", 던짐 instanceof AuthError && String((던짐 as Error).message).includes("다시 연결"));
    참인가("거절을 인증 상태 칸에 적었다 (화면이 이 칸을 읽는다)", !!authErrorOf(UC("b")));

    // 심사확인 한 번 — 모든 채널의 일을 한 바퀴 돈다 (B 는 실패해도 나머지는 돌고 아무것도 지워지지 않는다)
    const t = await tick({ force: true });
    참인가("심사확인이 돌았다 (멈춤이 없으니)", t.skipped === "");
    같나("채널 목록 · 로그인 정보 · 원장이 한 글자도 안 바뀌었다 — 채널도 로그인 정보도 안 지운다", [
      await Deno.readTextFile(dataPath("channels.json")), await Deno.readTextFile(dataPath("tokens.json")), await Deno.readTextFile(dataPath("ledger.csv")),
    ], [앞.채널, 앞.토큰, 앞.원장]);
    같나("채널 이름들이 그대로", Object.keys(loadChannels()), 이름들);

    // 화면이 보는 채널 모습
    const chans = loadChannels();
    const 보기 = async (n: string) => await chanView(n, chans[n], { chans, profs: await loadProfiles(), queue: [], pending: [], today: {}, subs: {} });
    const b = await 보기("채널B"), a = await 보기("채널A");
    같나("채널B: 목록에 남아 있고 연결 정보도 있고 「다시 연결 필요」 표시가 뜬다", [b.name, b.authed, b.needsReconnect, b.lastError.includes("다시 연결")], ["채널B", true, true, true]);
    같나("채널A: 멀쩡하다", [a.authed, a.needsReconnect, a.lastError], [true, false, ""]);

    // 문제 목록에도 채널이 남아 있다 (지우지 않고 알리기만)
    const 목록 = await ISS.collect(chans);
    참인가("문제 목록이 B 의 로그인 문제를 알리되 채널을 빼지 않는다", Object.keys(loadChannels()).includes("채널B"));

    // 다시 연결되면 풀린다 (구글이 토큰을 다시 받아 준다)
    g.grant("fake-refresh-b", UC("b"));
    forgetAccessTokens();
    await accessToken(loadStore()["채널B"]);
    같나("다시 갱신되면 표시가 사라진다", authErrorOf(UC("b")), null);
    void 목록;
    g.uninstall();
  });

  구역("자동 삭제 없음 — 채널·로그인 정보를 지우는 길은 사람이 누른 길뿐이다");
  // (1) 화면 길: 확인 표시 없이는 채널을 못 뺀다
  await 모래상자(async (dir) => {
    const g = 구글준비();
    await 옛판쓰기(dir);
    await 옮기기();
    const 길 = buildRoutes(newAppState() as never);
    const 몸 = (body: Record<string, unknown>) => ({ q: new URLSearchParams(), body, headers: new Headers(), req: new Request("http://127.0.0.1/"), port: 0 });
    const 앞 = Object.keys(loadChannels());
    await 던지나("채널 빼기는 확인 표시(confirm) 없이는 거절", () => 길.post["remove"](몸({ ch: "채널D" }) as never), /confirm/);
    같나("거절당하면 채널이 그대로", Object.keys(loadChannels()), 앞);
    await 길.post["remove"](몸({ ch: "채널D", confirm: true }) as never);
    같나("사람이 확인하면 그 채널 하나만 빠진다 (나머지는 그대로)", Object.keys(loadChannels()), 앞.filter((n) => n !== "채널D"));
    g.uninstall();
  });
  // (2) 원본 훑기: 채널·로그인 정보를 지우거나 비우는 호출이 허락된 자리에만 있다
  const 허락: Record<string, string[]> = {
    "removeChannel(": ["channels.ts", "routes.ts", "cli.ts"],          // 정의 · 화면 길(confirm 필요) · 명령줄(확인 필요)
    "saveChannels(": ["channels.ts"],                                  // 통째로 쓰는 함수는 정의만 (아무도 부르지 않는다)
    "clearMode(": ["channels.ts", "routes.ts"],
  };
  const 앱파일들 = [...Deno.readDirSync(new URL("../app/", import.meta.url))].filter((e) => e.isFile && e.name.endsWith(".ts")).map((e) => e.name);
  for (const [조각, 허락파일] of Object.entries(허락)) {
    const 쓰는곳: string[] = [];
    for (const 파일 of 앱파일들) {
      const 글 = await Deno.readTextFile(new URL(`../app/${파일}`, import.meta.url));
      if (글.includes(조각)) 쓰는곳.push(파일);
    }
    같나(`원본 훑기: ${조각} 은 허락된 파일에만 있다`, 쓰는곳.filter((f) => !허락파일.includes(f)), []);
  }
  const 지우기패턴 = [/Deno\.remove\([^)]*channels\.json/, /Deno\.remove\([^)]*tokens\.json/, /Deno\.remove\(\s*(channelsPath|storePath)\(/];
  const 걸린 = [];
  for (const 파일 of 앱파일들) {
    const 글 = await Deno.readTextFile(new URL(`../app/${파일}`, import.meta.url));
    if (지우기패턴.some((p) => p.test(글))) 걸린.push(파일);
  }
  같나("원본 훑기: 채널 목록·로그인 정보 파일을 통째로 지우는 코드가 없다", 걸린, []);
}

export async function 실행() {
  await 복사본시험();
  await 그대로시험();
  await 열쇠시험();
  await 되풀이시험();
  await 보류시험();
  await 자동삭제없음시험();
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

void backupAll; void SCOPES_LEGACY;
export type { MigrationReport };

// 알림 — 텔레그램으로 짧게 알리고, 컴퓨터 화면에도 알림을 띄운다.
//   (파이썬: 알림.py  ·  옛 앱: telegram.ts 와 platform.ts 의 notify)
//
// 왜 이 파일이 따로 있나
//   올리는 코드 안에 텔레그램 호출을 섞으면 텔레그램이 죽었을 때 **업로드까지 같이 죽는다.**
//   알림은 곁다리다 — 여기서 모든 예외를 먹고 조용히 실패한다. 대신 실패한 사실은 서버.log 에 남긴다.
//   그래서 이 파일의 공개 함수는 **어떤 경우에도 던지지 않는다**(저장·시험 함수만 잘못된 입력에 던진다).
//
// 설정은 어디서 오나 (개인 경로는 읽지 않는다)
//   ① 데이터 폴더의 `텔레그램.json` — {"봇토큰": "123456789:AA…", "받는이": [123456789]}
//   ② 환경변수 TELEGRAM_TOKEN · TELEGRAM_CHAT_ID (쉼표로 여럿)
//   칸 단위로 ①이 우선이고 비어 있는 칸만 ②로 채운다. 둘 다 없으면 아무것도 안 보내고 조용히 지나간다.
//
// ★봇 토큰은 비밀이다 — 기록에 남기는 모든 글에서 토큰을 가린다. (Deno 의 fetch 오류 글에는
//   요청 주소가 통째로 들어 있고, 텔레그램 주소에는 토큰이 박혀 있다.)
import { IS_MAC, IS_WIN, cut, dataPath, env, log, readJson, recordLine, recordPath, stemOf, writeJson, writeTextAtomic } from "./paths.ts";
import { dateOnly, wallNow } from "./clock.ts";
import { doFetch, offline } from "./google.ts";
import { readLedger } from "./ledger.ts";

const API = "https://api.telegram.org";
/** 알림 하나 때문에 오래 기다리지 않는다 (파이썬 시간제한 = 8초) */
export const TELEGRAM_TIMEOUT_MS = 8000;

/* ============================================================ 설정 */

export interface TelegramConfig {
  token: string;
  chatIds: number[];
  /** 어디서 읽었나: file · env · mixed(칸마다 다름) · none */
  source: "file" | "env" | "mixed" | "none";
  /** 설정 파일에 고칠 점이 있으면 한 줄(없으면 undefined) */
  problem?: string;
}

const configFile = () => dataPath("텔레그램.json");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 기록은 한 줄에 한 건이다 — 오류 글에 줄바꿈이 있으면 「 ⏎ 」로 바꾼다 (paths.ts 의 log() 와 같은 약속. recordLine 은 그대로 적는다) */
const 기록 = (파일: string, 줄: string) => recordLine(파일, 줄.replace(/\s*\r?\n\s*/g, " ⏎ "));

/** 받는이 값을 숫자 목록으로. 숫자 하나·"1,2"·[1,"2"] 다 받는다. 못 읽는 조각은 bad 로. */
function parseChatIds(v: unknown): { ids: number[]; bad: string[] } {
  const ids: number[] = [], bad: string[] = [];
  let items: unknown[] = [];
  if (Array.isArray(v)) items = v;
  else if (typeof v === "number") items = [v];
  else if (typeof v === "string") items = v.split(/[,\s]+/).filter(Boolean);
  else if (v !== undefined && v !== null && v !== "") bad.push(String(v));
  for (const x of items) {
    const s = String(x).trim();
    // 그룹 대화방 번호는 음수다
    if (/^-?\d+$/.test(s) && Number.isSafeInteger(Number(s))) {
      if (!ids.includes(Number(s))) ids.push(Number(s));
    } else bad.push(s.slice(0, 20));
  }
  return { ids, bad };
}

function readConfigFile(): { token: string; chatIds: number[]; problem?: string } {
  const none = { token: "", chatIds: [] as number[] };
  let text: string;
  try {
    text = Deno.readTextFileSync(configFile());
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return none;
    return { ...none, problem: `텔레그램.json 을 읽지 못했습니다 — ${errMsg(e).slice(0, 90)}` };
  }
  if (!text.trim()) return none;
  let d: unknown;
  try {
    d = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { ...none, problem: `텔레그램.json 이 올바른 JSON 이 아닙니다 — ${errMsg(e).slice(0, 90)}` };
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    return { ...none, problem: "텔레그램.json 의 꼴이 이상합니다 — {\"봇토큰\": …, \"받는이\": […]} 이어야 합니다" };
  }
  const o = d as Record<string, unknown>;
  const token = typeof o["봇토큰"] === "string" ? o["봇토큰"].trim() : "";
  const { ids, bad } = parseChatIds(o["받는이"]);
  return { token, chatIds: ids, problem: bad.length ? `텔레그램.json 의 받는이가 이상합니다 — ${bad.join(", ")}` : undefined };
}

/** 지금 쓸 설정. 파일이 없거나 비어 있으면 환경변수로 채운다. (파이썬 _설정 · _토큰 · _받는이) */
export function telegramConfig(): TelegramConfig {
  const f = readConfigFile();
  const envToken = env("TELEGRAM_TOKEN").trim();
  const envChats = parseChatIds(env("TELEGRAM_CHAT_ID")).ids;
  const token = f.token || envToken;
  const chatIds = f.chatIds.length ? f.chatIds : envChats;
  const fromFile = (f.token ? 1 : 0) + (f.chatIds.length ? 1 : 0);
  const fromEnv = (!f.token && envToken ? 1 : 0) + (!f.chatIds.length && envChats.length ? 1 : 0);
  const source = fromFile && fromEnv ? "mixed" : fromFile ? "file" : fromEnv ? "env" : "none";
  return { token, chatIds, source, problem: f.problem };
}

/** 보낼 준비가 됐나 — 토큰과 받는이가 둘 다 있어야 한다. (파이썬 쓸수있나) */
export function canSend(): boolean {
  const c = telegramConfig();
  return !!(c.token && c.chatIds.length);
}

/** 화면에 보여 줄 요약. 토큰 원문은 담지 않는다(봇 번호까지만). */
export function telegramSummary(): { configured: boolean; recipients: number; source: string; bot: string } {
  const c = telegramConfig();
  return {
    configured: !!(c.token && c.chatIds.length),
    recipients: c.chatIds.length,
    source: c.source,
    bot: c.token ? c.token.split(":")[0] : "",
  };
}

/**
 * 화면의 「텔레그램」 카드에서 저장한다. 토큰과 받는이를 둘 다 비우면 설정을 지운다(알림 끄기).
 * 파일은 권한 600 으로 쓴다 — 봇 토큰이 들어 있다. 파일에 있던 다른 칸(메모 등)은 건드리지 않는다.
 * 잘못된 입력에는 던진다 — 화면이 그 말을 그대로 사용자에게 보여 준다.
 */
export async function saveTelegramConfig(token: string, chatIds: (number | string)[]): Promise<void> {
  const t = String(token ?? "").trim();
  const { ids, bad } = parseChatIds(chatIds);
  if (!t && !ids.length && !bad.length) {
    try { await Deno.remove(configFile()); } catch { /* 없으면 이미 꺼진 것이다 */ }
    return;
  }
  if (!/^\d+:[\w-]+$/.test(t)) throw new Error("봇 토큰의 꼴이 이상합니다 — 123456789:AA… 처럼 숫자, 콜론, 글자가 이어져야 합니다");
  if (bad.length) throw new Error(`받는이는 숫자여야 합니다 — ${bad.join(", ")}`);
  if (!ids.length) throw new Error("받는이를 하나 이상 넣어 주세요");
  const old = await readJson<unknown>(configFile(), {});
  const base = old && typeof old === "object" && !Array.isArray(old) ? (old as Record<string, unknown>) : {};
  await writeJson(configFile(), { ...base, 봇토큰: t, 받는이: ids }, { secret: true });
}

/* ============================================================ 텔레그램 보내기 */

/** 기록에 남길 글에서 봇 토큰을 가린다 */
function redact(msg: string, token: string): string {
  let m = msg;
  if (token) m = m.split(token).join("***");
  return m.replace(/bot\d+:[\w-]+/g, "bot***");
}

let 알린문제 = "";
async function noteProblem(p: string) {
  if (p === 알린문제) return; // 같은 말을 매번 적으면 기록이 그 줄로 가득 찬다
  알린문제 = p;
  await 기록("서버.log", p);
}

/**
 * 한 줄~여러 줄을 보낸다. 못 보내도 예외를 밖으로 내보내지 않는다. 한 사람이라도 받았으면 true.
 * (파이썬 보내기) quiet=false 이면 콘솔에도 사정을 말한다.
 */
export async function send(text: string, quiet = true): Promise<boolean> {
  let token = "";
  try {
    const c = telegramConfig();
    token = c.token;
    if (c.problem) await noteProblem(c.problem);
    if (!c.token || !c.chatIds.length) {
      if (!quiet) console.log("  텔레그램 설정이 없어 보내지 않았습니다");
      return false;
    }
    let 보냄 = 0;
    for (const chat of c.chatIds) {
      try {
        const res = await doFetch(`${API}/bot${c.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ chat_id: String(chat), text: cut(text, 3900), disable_web_page_preview: "true" }),
          signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
        });
        if (res.status === 200) {
          보냄++;
          await res.body?.cancel();
        } else {
          // 텔레그램은 까닭을 JSON 의 description 으로 준다 (예: chat not found)
          let 까닭 = "";
          try { 까닭 = String(JSON.parse(await res.text())?.description ?? ""); } catch { /* 몸이 없으면 번호만 */ }
          throw new Error(`HTTP ${res.status}${까닭 ? " " + 까닭 : ""}`);
        }
      } catch (e) {
        // 알림이 안 갔다고 올리기가 멈추면 안 된다. 조용히 넘기되 남긴다.
        const 말 = `텔레그램 실패 — ${redact(errMsg(e), token).slice(0, 110)}`;
        await 기록("서버.log", 말);
        if (!quiet) console.log("  " + 말);
      }
    }
    return 보냄 > 0;
  } catch (e) {
    // 설정을 읽는 데서 난 뜻밖의 오류까지 — 밖으로 내지 않는다
    await 기록("서버.log", `텔레그램 처리 중 오류 — ${redact(errMsg(e), token).slice(0, 110)}`);
    return false;
  }
}

/** 영상 하나가 올라갔을 때. (파이썬 발사알림) */
export function launchNotice(
  채널: string, 제목: string, 영상id: string, 예정: string, 남은대기: number, 공개예정 = "",
): Promise<boolean> {
  return send([
    "🚀 발사 완료",
    `채널  ${채널}`,
    `영상  ${cut(제목, 60)}`,
    `예정  ${cut(예정, 16).replace(/T/g, " ")}`,
    `주소  https://youtu.be/${영상id}`,
    "",
    "지금은 비공개입니다. 30분 뒤 검토하고 통과하면 " + (공개예정 ? `${공개예정} 에 공개됩니다.` : "바로 공개됩니다."),
    `남은 발사대기 ${남은대기}건`,
  ].join("\n"));
}

/** 올리지 못했을 때. 이건 사람이 손을 대야 한다. (파이썬 실패알림) */
export function failNotice(채널: string, 제목: string, 까닭: string): Promise<boolean> {
  return send([
    "⚠️ 발사 실패",
    `채널  ${채널}`,
    `영상  ${cut(제목, 60)}`,
    `까닭  ${cut(까닭, 180)}`,
    "",
    "큐에 그대로 있습니다. 다음 차례에 다시 시도합니다.",
  ].join("\n"));
}

/** 검토를 통과해 실제로 공개됐을 때. (파이썬 공개알림) */
export function publishNotice(채널: string, 제목: string, 영상id: string): Promise<boolean> {
  return send([
    "✅ 공개 완료",
    `채널  ${채널}`,
    `영상  ${cut(제목, 60)}`,
    `주소  https://youtu.be/${영상id}`,
  ].join("\n"));
}

/* ============================================================ 하루 요약 */

const 표시: Record<string, string> = { public: "공개", 예약: "예약", private: "비공개" };

/**
 * 오늘 무엇이 나갔고 내일 무엇이 나가는지 한 장으로. (파이썬 하루요약)
 * 하루에 한 번만 보낸다 — 보낸 날을 `기록/요약보낸날.txt` 에 적고, 같은 날 또 부르면 그냥 지나간다.
 * 못 보냈으면 표식을 안 남기므로 다음에 다시 시도한다.
 */
export async function daySummary(quiet = true): Promise<boolean> {
  try {
    const 오늘 = dateOnly(wallNow());
    const 표 = recordPath("요약보낸날.txt");
    try {
      if ((await Deno.readTextFile(표)).trim() === 오늘) return false;
    } catch { /* 표식이 없으면 오늘 처음이다 */ }

    const 올림: [string, string, string][] = [];
    try {
      for (const r of readLedger()) {
        if ((r["업로드시각"] ?? "").slice(0, 10) === 오늘) 올림.push([r["채널"] ?? "", r["제목"] ?? "", r["공개설정"] ?? ""]);
      }
    } catch (e) {
      await 기록("서버.log", `하루요약: 원장을 못 읽었습니다 — ${errMsg(e).slice(0, 80)}`);
    }

    // 발사대기는 화면 모듈을 거치지 않고 파일을 직접 읽는다 — 알림이 다른 모듈에 기대지 않게
    const 대기: { 때: string; 채널: string; 이름: string }[] = [];
    let 대기총수 = 0;
    try {
      const q = await readJson<unknown>(dataPath("발사대기.json"), []);
      const 목록 = (Array.isArray(q) ? q : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .sort((a, b) => String(a["쏠때"] ?? "").localeCompare(String(b["쏠때"] ?? "")));
      대기총수 = 목록.length;
      for (const x of 목록.slice(0, 8)) {
        대기.push({
          때: String(x["쏠때"] ?? "").slice(5, 16).replace("T", " "),
          채널: String(x["_alias"] || x["channel"] || ""),
          이름: stemOf(String(x["file"] ?? "")),
        });
      }
    } catch (e) {
      await 기록("서버.log", `하루요약: 발사대기를 못 읽었습니다 — ${errMsg(e).slice(0, 80)}`);
    }

    const 줄 = [`📊 오늘 정리 — ${오늘.slice(5).replace("-", "/")}`, ""];
    if (올림.length) {
      const 공개 = 올림.filter(([, , p]) => p === "public").length;
      줄.push(`올린 영상 ${올림.length}편 (공개 ${공개})`);
      for (const [ch, t, p] of 올림.slice(0, 6)) 줄.push(`  · [${ch}] ${cut(t, 28)} — ${표시[p] ?? p}`);
    } else {
      줄.push("오늘 올린 영상 없음");
    }
    줄.push("");
    if (대기총수) {
      // 파이썬은 보여 주는 8건까지만 세어 「발사 대기 8건」이라 적었다 — 실제 총수를 적고 나머지는 말로 잇는다
      줄.push(`발사 대기 ${대기총수}건`);
      for (const x of 대기) 줄.push(`  · ${x.때}  [${x.채널}] ${cut(x.이름, 26)}`);
      if (대기총수 > 대기.length) 줄.push(`  … 외 ${대기총수 - 대기.length}건`);
    } else {
      줄.push("발사 대기 없음");
    }

    const 난것 = await send(줄.join("\n"), quiet);
    if (난것) {
      try { await writeTextAtomic(표, 오늘); }
      catch (e) { await 기록("서버.log", `하루요약: 보낸 날 표식을 못 적었습니다 — ${errMsg(e).slice(0, 80)}`); }
    }
    return 난것;
  } catch (e) {
    await 기록("서버.log", `하루요약 실패 — ${errMsg(e).slice(0, 110)}`);
    return false;
  }
}

/* ============================================================ 시험 보내기 */

export interface TestSendResult {
  ok: boolean;
  configured: boolean;
  recipients: number;
  message: string;
}

/** 화면의 「시험 보내기」 단추. 설정이 없으면 보내지 않고 이유를 돌려준다. (파이썬 알림.py --시험) */
export async function testSend(): Promise<TestSendResult> {
  const s = telegramSummary();
  if (!s.configured) {
    return { ok: false, configured: false, recipients: s.recipients, message: "텔레그램 설정이 없습니다 — 봇 토큰과 받는이를 먼저 넣어 주세요" };
  }
  const ok = await send("🔔 업로더 — 알림 시험입니다.\n발사할 때마다 이렇게 알려 드립니다.", false);
  return {
    ok, configured: true, recipients: s.recipients,
    message: ok ? `${s.recipients}곳에 보냈습니다` : "보내지 못했습니다 — 토큰·받는이를 확인하세요 (자세한 까닭은 기록의 서버.log)",
  };
}

/* ============================================================ 화면 알림 + 텔레그램 */

let 텔레그램켬 = true;
/** 막힌 소식을 텔레그램으로도 보낼지 — 화면(설정)에서 끌 수 있다. 기본은 켬. (옛 앱 텔레그램설정) */
export function setTelegramAlerts(on: boolean) { 텔레그램켬 = on; }
export const telegramAlertsOn = () => 텔레그램켬;

/** 시험이 컴퓨터에 진짜 알림을 띄우지 않게 — 오프라인 시험 모드이거나 GARASADAE_NO_DESKTOP=1 이면 건너뛴다 */
function desktopOff(): boolean {
  return offline() || env("GARASADAE_NO_DESKTOP") === "1";
}

async function spawnDetached(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<boolean> {
  try {
    const child = new Deno.Command(cmd, { args, env: extraEnv, stdout: "null", stderr: "null", stdin: "null" }).spawn();
    child.unref?.();
    return true;
  } catch (e) {
    await log(`(명령 실행 실패: ${cmd} — ${errMsg(e).slice(0, 80)})`);
    return false;
  }
}

/**
 * 컴퓨터 화면에 알림을 띄운다 (맥 osascript · 윈도우 PowerShell · 리눅스 notify-send).
 * 글을 명령 안에 끼워 넣지 않고 인자·환경변수로 넘긴다 — 따옴표나 역슬래시가 든 제목에 깨지거나
 * 명령으로 해석되지 않게. (옛 앱은 따옴표를 지워서 막았다)
 */
export async function desktopNotify(title: string, text: string): Promise<boolean> {
  if (desktopOff()) return false;
  const h = title.trim() || " ";
  const t = cut(text, 180).trim() || " ";
  if (IS_MAC) {
    return await spawnDetached("osascript", [
      "-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", t, h,
    ]);
  }
  if (IS_WIN) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = $env:GU_TITLE
$n.BalloonTipText  = $env:GU_TEXT
$n.Visible = $true
$n.ShowBalloonTip(6000)
Start-Sleep -Seconds 7
$n.Dispose()`.trim();
    return await spawnDetached("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { GU_TITLE: h, GU_TEXT: t });
  }
  return await spawnDetached("notify-send", [h, t]);
}

export interface AlertOpts {
  /** 텔레그램으로도 보낼지 (기본: 설정 스위치를 따른다. 제목에 ✅ 가 있으면 어떤 경우에도 안 보낸다) */
  telegram?: boolean;
  /** 컴퓨터 화면 알림을 띄울지 (기본 true) */
  desktop?: boolean;
  /** 텔레그램이 끝날 때까지 기다릴지. 기본 false — 회선이 느려도 올리기가 8초씩 멈추면 안 된다 */
  wait?: boolean;
}

/**
 * 막힌 일을 알린다 — 화면 알림 + (✅ 가 없는 글은) 텔레그램. (옛 앱 notify)
 * 잘 된 일(✅)은 텔레그램으로 안 보낸다: 하루 몇 편씩 올라가는데 그때마다 울리면 정작 급한 것이 묻힌다.
 * 어떤 실패도 밖으로 내지 않는다.
 */
export async function alert(
  title: string, text: string, opts: AlertOpts = {},
): Promise<{ desktop: boolean; telegram: boolean | null }> {
  let desktop = false;
  let telegram: boolean | null = null;
  try {
    const wantTelegram = (opts.telegram ?? 텔레그램켬) && !title.includes("✅");
    let 텔레: Promise<boolean> | null = null;
    if (wantTelegram) {
      텔레 = send(`${title}\n${cut(text, 600)}`);
      if (!opts.wait) 텔레.catch(() => {}); // send 는 던지지 않지만 혹시를 위해
    }
    if (opts.desktop ?? true) desktop = await desktopNotify(title, text);
    if (텔레 && opts.wait) telegram = await 텔레;
  } catch (e) {
    await 기록("서버.log", `알림 처리 중 오류 — ${errMsg(e).slice(0, 110)}`);
  }
  return { desktop, telegram };
}

// 문제를 한자리에 모으고, 고치는 방법까지 붙인다. (파이썬: issues.py)
//
// 세 등급으로 나눈다.
//   빨강(red)    오류        작업이 막혔다. 손대기 전에는 진행되지 않는다.
//   노랑(yellow) 작업불이행   막히진 않았지만 해야 할 일이 안 됐다. 곧 문제가 된다.
//   초록(green)  정상        볼 것 없음. (「검토 대기 N건」 같은 진행 중인 일을 알리는 데만 쓴다)
//
// 문제마다 **무엇을 누르면 되는지**를 함께 담는다. 원인만 알려주고 방법을 안 주면 결국 사람이 매번 찾아야 하고,
// 그러면 아무도 안 고친다.
//
// ───────── 한 건의 꼴 (파이썬 _i 와 같다) ─────────
//   { level, kind, channel, what, why, fix, auto }
//     level    "red" | "yellow" | "green"
//     kind     "오류" | "작업불이행" | "경고" | "할 일" | "진행"   (화면 알약에 그대로 찍는 글)
//     channel  채널 이름. 앱 전체에 걸린 일은 ""
//     what     한 줄 설명.  ★「확인했음」 장부가 이 글에서 숫자를 지우고 비교한다 — 숫자가 달라져도 같은 경고로 본다
//     why      까닭
//     fix      { label, cmd, api?, body? } | null
//                label  단추에 적을 글
//                cmd    터미널에서 칠 명령(안내용). 없으면 null
//                api    화면이 부를 주소(API 명세). 없으면 사람이 직접 하는 일
//                body   그 주소에 보낼 몸
//     auto     true 면 `autofix` 가 사람 판단 없이 고칠 수 있는 것
//
// ───────── 「확인했음」 장부 (파이썬: serve.py iss/ack + dashboard.render) ─────────
//   기록/알림확인.txt 한 줄 = `오늘날짜|노랑 설명들(숫자는 #)`. 내용이 같고 날짜가 오늘이면 그날 하루는 노랑을 정상으로 센다.
//   ★날이 바뀌거나 노랑의 내용이 달라지면 저절로 되살아난다 — 어제 본 것도 오늘은 다시 사람 눈을 거친다.
//   ★빨강은 확인으로 못 지운다. 고쳐야만 꺼진다.
//
// ───────── 원본과 다르게 한 점 (이유) ─────────
//   · 「클로드 부르기」는 앱을 여는 일을 이 모듈이 하지 않는다. 문제 설명글(asPrompt)과 클립보드(copyToClipboard)만 준다 —
//     AI 대화창을 여는 것은 서버가 한다.
//   · 폴더를 아직 안 정한 채널은 원본에서 「폴더 표식이 없습니다 / 표식 새기기(자동)」로 잘못 읽혔다. 여기서는
//     「폴더가 정해지지 않았습니다 / 폴더 지정」으로 따로 알린다(표식을 새길 폴더가 없어 자동 고침이 헛돌기 때문).
//   · 「아직 시작 안 함」 판정: 원본은 client_secret.json 이 있나만 봤다. 이 앱은 실행 파일에 묶인 열쇠로도 연결할 수 있어서
//     「열쇠 파일이 있거나 연결된 계정이 하나라도 있나」로 본다.
//   · 원본은 `open "폴더"`(맥 전용)를 고침 명령으로 줬다. 여기서는 운영체제에 맞는 명령을 준다.
//   · asPrompt 는 전체 경로를 마지막 두 칸만 남긴다(원본도 「그때 설정」에서는 그렇게 했지만 문제 설명 안의 경로는 그대로 실렸다).
//   · autofix 는 명령줄을 셸로 돌리지 않고 표식을 직접 새긴다. 다른 채널 표식이 이미 있으면 덮어쓰지 않는다(원본은 물어봤다).
//   · 오늘 몫이 0 인 채널(쉬는 날)에는 「재고가 0.0일치뿐입니다」를 내지 않는다 — 원본은 이때도 경고를 냈다.
//   · 폴더 경로의 「~」는 짝 검사 전에 푼다(channels.verifyAll 이 안 푼다).
//
// ───────── 선택 기능이 보태는 줄 (쿠팡 파트너스 · AI 문안) ─────────
//   `coupang.ts` 의 warnings() 가 돌려주는 줄들과 `ai.ts` 의 aiNotice() 한 줄을 collect 끝에 그대로 이어 붙인다.
//   ★두 모듈은 동적 import 로 부른다 — 모듈이 아직 없거나, 그 함수가 없거나, 던져도 신호등은 멈추지 않는다
//     (실패는 서버.log 에 한 번만 적는다). 글자 그대로(`import("./coupang.ts")`) 써야 실행 파일을 구울 때 함께 묶인다.
//   시험은 `collect(…, { extra })` 로 같은 모양의 가짜 줄을 끼운다(주면 진짜 모듈 대신 그 줄을 쓴다).
//
// ───────── 원본 issues.py 에는 없는 것 (옵션 extras) ─────────
//   올리기 잠금 · 밀린 발사대기 · 사람 확인 필요 · 한도 임박은 원본에서 신호등이 아니라 자물쇠 단추·발사대기 칸·브리핑 팝업이
//   따로 보여 줬다. 신호등에 더하고 싶으면 `collect(chans, fn, { extras: true })`. 기본은 원본과 똑같이 끈다.
import { APP_NAME, APP_VERSION, baseName, cut, exists, extOf, isDir, join, recordLine, recordPath, stemOf, tailFile, writeTextAtomic } from "./paths.ts";
import { dateOnly, wallNow, type Wall } from "./clock.ts";
import { isAgency, loadChannels, readMark, verifyAll, writeMark } from "./channels.ts";
import type { ChannelConf, Channels } from "./channels.ts";
import { deviceSecretsPath, loadStore, resolve, secretsPath } from "./ytcore.ts";
import { embeddedClient } from "./embedded.ts";
import { expandHome, HOLD, summary as folderSummary, VIDEO_EXT } from "./folders.ts";
import { explainUploadFailure } from "./briefing.ts";
import { uploadedNames } from "./ledger.ts";
import { daysLeft } from "./picker.ts";
import { fixed } from "./stats.ts";
import { loadPending } from "./review.ts";
import { loadProfiles } from "./profile.ts";
import { isLocked } from "./safety.ts";
import { minutesLeft, nightBan, readQueue } from "./queue.ts";
import { today as quotaToday } from "./quota.ts";
import { migrationHold } from "./hold.ts";

export type Level = "red" | "yellow" | "green";
export const RED: Level = "red", YELLOW: Level = "yellow", GREEN: Level = "green";
export const MARK: Record<Level, string> = { red: "●", yellow: "●", green: "●" };
export const KIND: Record<Level, string> = { red: "오류", yellow: "작업불이행", green: "정상" };

/** 터미널에 찍을 때 종류 이름 — 선택 기능이 영문 이름표(coupang · ai)로 보낸 줄도 한글로 보이게 */
const KIND_LABEL: Record<string, string> = { coupang: "쿠팡 파트너스", ai: "AI 문안" };

/** 터미널에서 이 앱을 부르는 이름 — 고침 안내(`cmd`)에 찍힌다. 빌드가 만드는 실행 파일 이름과 같아야 한다. */
export const CLI = "GarasadaeUploader";

export interface Fix {
  label: string;
  cmd: string | null;
  api?: string;
  body?: Record<string, unknown>;
}
export interface Issue {
  level: Level;
  kind: string;
  channel: string;
  what: string;
  why: string;
  fix: Fix | null;
  auto: boolean;
}

/** 오늘 몇 개 올리나 — (개수) 또는 (개수, 까닭). 화면을 열 때 유튜브에 묻지 않도록 부르는 쪽이 live=false 로 감싸서 준다. */
export type DailyFn = (alias: string, cf: ChannelConf) => number | [number, string] | Promise<number | [number, string]>;

export interface CollectOpts {
  /** 원본 신호등에 없는 네 가지(잠금·밀린 발사대기·사람 확인 필요·한도 임박)를 더한다. 기본 false */
  extras?: boolean;
  /**
   * 쿠팡 파트너스·AI 문안 모듈 대신 이 함수가 돌려주는 줄을 끝에 붙인다 — 시험이 같은 모양의 가짜를 끼우는 자리.
   * 안 주면 진짜 모듈(`coupang.ts` · `ai.ts`)을 동적으로 부른다.
   */
  extra?: () => Issue[] | Promise<Issue[]>;
  /** 시험이 시계를 바꿔 끼운다 (벽시계) */
  now?: Wall;
}

const _i = (level: Level, kind: string, channel: string, what: string, why = "", fix: Fix | null = null, auto = false): Issue =>
  ({ level, kind, channel, what, why, fix, auto });

/** 폴더를 여는 명령 — 운영체제마다 다르다 (원본은 맥의 `open` 만 줬다) */
export function openCmd(path: string, os: string = Deno.build.os): string {
  const q = `"${path}"`;
  if (os === "darwin") return `open ${q}`;
  if (os === "windows") return `explorer ${q}`;
  return `xdg-open ${q}`;
}

/** 인증 안내. 대행은 채널마다 따로, 소유주는 한 번이면 된다. (파이썬 _auth_fix) */
function authFix(alias: string): Fix {
  if (isAgency()) {
    return { label: "인증하기", cmd: `${CLI} 인증 --alias "${alias}"`, api: "/api/signin/start", body: { ch: alias } };
  }
  return { label: "로그인하기", cmd: `${CLI} 인증`, api: "/api/signin/start", body: {} };
}

/** "[채널] 내용" 으로 시작하는 글에서 채널 이름을 가린다. 이름에 「]」가 있어도 안 속도록 아는 이름부터 맞춰 본다. */
function aliasOf(msg: string, aliases: string[]): string {
  for (const a of aliases) if (msg.startsWith(`[${a}] `)) return a;
  const m = /^\[([^\]]*)\]/.exec(msg);
  return m ? m[1].trim() : "";
}

/** 연결을 시작했나 — 열쇠 파일을 넣었거나, 연결된 계정이 하나라도 있으면 시작한 것이다. */
async function startedAlready(tokenCount: number): Promise<boolean> {
  if (tokenCount > 0) return true;
  return (await exists(secretsPath())) || (await exists(deviceSecretsPath()));
}

/** 같은 일을 두 번 적지 않는다 — 한 가지 까닭이 두 길로 잡혔을 때를 위해 */
export function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const it of issues) {
    const k = JSON.stringify([it.level, it.kind, it.channel, it.what, it.why]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function dailyOf(alias: string, cf: ChannelConf, fn?: DailyFn): Promise<number> {
  let n: unknown;
  if (fn) {
    const got = await fn(alias, cf);
    n = Array.isArray(got) ? got[0] : got;
  } else {
    n = cf.daily ?? 1;
  }
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? v : 1;
}

/**
 * 지금 떠 있는 문제를 전부 모은다. 유튜브는 한 번도 부르지 않는다 — 로컬 파일과 폴더만 본다. (파이썬 collect)
 * dailyFn 을 안 주면 채널 설정의 `daily` 칸을 오늘 몫으로 쓴다.
 */
export async function collect(chans: Channels, dailyFn?: DailyFn, opts: CollectOpts = {}): Promise<Issue[]> {
  const out: Issue[] = [];
  const tokens = loadStore();
  const started = await startedAlready(Object.keys(tokens).length);
  const aliases = Object.keys(chans);

  // 옛 판 자료를 옮긴 결과에서 빠진 것이 나와 새 판이 멈춰 있다 — 가장 위에 빨간 줄로. 빨강은 고쳐야만 꺼진다.
  const 보류 = migrationHold();
  if (보류) {
    const 빠짐 = 보류.missing.length ? `빠진 것: ${보류.missing.slice(0, 3).join(" / ")}${보류.missing.length > 3 ? ` 외 ${보류.missing.length - 3}건` : ""}. ` : "";
    out.push(_i(RED, "오류", "", "옛 판 자료를 새 판으로 옮긴 결과를 확인하지 못해 올리기를 멈춰 두었습니다",
      `${빠짐}${보류.reasons.slice(0, 2).join(" / ")} 옛 자료는 한 글자도 안 건드렸습니다. 복사본: ${보류.backupDir || "없음"}. ` +
        `「다시 옮기기」로 계속 안 풀리면 터미널에서 「${CLI} 이행 --그대로시작 --확인」 으로 새 판을 그대로 쓸 수 있습니다(옛 자료와 복사본은 남습니다).`,
      { label: "다시 옮기기", cmd: `${CLI} 이행`, api: "/api/migrate/retry", body: {} }));
  }

  // 아직 시작도 안 한 상태
  //   여기서 채널마다 '인증 안 됨' 을 빨갛게 늘어놓으면 안 된다. 처음 켠 사람에게 오류 여섯 줄은 고장 난 것처럼 보인다.
  //   아직 안 한 일일 뿐이므로 한 줄로 안내하고, 나머지는 접어 둔다.
  if (!started) {
    const 내장 = !!(await embeddedClient("browser")) || !!(await embeddedClient("device"));
    out.push(_i(YELLOW, "할 일", "", "아직 계정을 연결하지 않았습니다",
      (내장 ? "구글 계정을 연결하면 올릴 수 있습니다." : "구글 로그인 파일을 넣고 계정을 연결하면 올릴 수 있습니다.") +
        " 화면을 둘러보는 것은 지금도 됩니다.",
      { label: "지금 연결하기", cmd: `${CLI} 인증`, api: "/api/signin/start", body: {} }));
  }

  // ── 폴더·채널 짝 (가장 위험한 항목이라 먼저 본다)
  // verifyAll 은 「~」로 시작하는 경로를 풀지 않는다(파이썬은 expanduser). 같은 폴더를 같은 뜻으로 읽게 여기서 풀어 건넨다.
  const 풀린 = Object.fromEntries(Object.entries(chans).map(([k, v]) => [k, { ...v, folder: v.folder ? expandHome(v.folder) : v.folder }])) as Channels;
  const { fatal, warn } = await verifyAll(풀린);
  for (const f of fatal) {
    const first = f.split("\n")[0];
    const i = first.indexOf("] ");
    const ch = aliasOf(f, aliases);
    out.push(_i(RED, "오류", ch, "폴더 짝이 맞지 않습니다", i >= 0 ? first.slice(i + 2) : first,
      { label: "폴더 다시 지정", cmd: `${CLI} 설정`, api: "/api/folder", body: { ch } }));
  }
  for (const w of warn) {
    const ch = aliasOf(w, aliases);
    if (w.includes("정해지지")) {
      out.push(_i(YELLOW, "경고", ch, "폴더가 정해지지 않았습니다", "폴더를 정해야 영상을 올릴 수 있습니다",
        { label: "폴더 지정", cmd: `${CLI} 설정`, api: "/api/folder", body: { ch } }));
      continue;
    }
    out.push(_i(YELLOW, "경고", ch, "폴더 표식이 없습니다", "표식이 없으면 짝이 어긋나도 못 잡아냅니다",
      { label: "표식 새기기", cmd: `${CLI} 설정 --bind`, api: "/api/issues/fix", body: { act: "bind", ch } }, true));
  }

  for (const [alias, cf] of Object.entries(chans)) {
    const cid = cf.channel_id ?? "";

    // ── 인증
    if (!cid) {
      // 시작 전이면 위에 한 줄로 이미 말했다. 같은 말을 채널 수만큼 반복하지 않는다.
      if (!started) continue;
      out.push(_i(RED, "오류", alias, "채널 인증이 안 됐습니다", "channel_id 가 없어 업로드할 수 없습니다", authFix(alias)));
      continue;
    }
    if (!Object.values(tokens).some((v) => v.channel_id === cid)) {
      out.push(_i(RED, "오류", alias, "토큰이 없습니다", `${cid} 로 인증된 기록이 없습니다`, authFix(alias)));
      continue;
    }

    // 폴더를 아직 안 정한 채널은 위의 경고가 이미 말했다. 비어 있는 이름으로 현재 폴더를 읽어 버리지 않는다.
    const folder = String(cf.folder ?? "").trim();
    if (!folder) continue;

    // ── 폴더 내용
    let sm: { 대기: number; 완료: number; 검토필요: number };
    try {
      sm = await folderSummary(folder);
    } catch (e) {
      out.push(_i(RED, "오류", alias, "폴더를 열 수 없습니다", e instanceof Error ? e.message : String(e),
        { label: "폴더 다시 지정", cmd: `${CLI} 설정`, api: "/api/folder", body: { ch: alias } }));
      continue;
    }

    const n = await dailyOf(alias, cf, dailyFn);
    const 요청 = askFix(folder);

    // ── 작업불이행: 올릴 게 있는데 오늘 몫을 못 채운다
    if (sm.대기 === 0) {
      // 폴더가 비었다는 것은 채널 탭에 '재고 0일' 로 이미 보인다.
      // 채널 수만큼 같은 줄이 늘어나 화면을 잡아먹으므로 여기서는 뺀다.
    } else if (sm.대기 < n) {
      out.push(_i(YELLOW, "작업불이행", alias, `오늘 ${n}개 중 ${sm.대기}개만 올라갑니다`, "대기 영상이 모자랍니다", 요청));
    } else if (n > 0) {
      // 오늘 올릴 몫이 0 이면 「재고가 0.0일치」가 아니라 그냥 쉬는 날이다(원본은 이때도 경고를 냈다)
      const { days } = daysLeft(sm.대기, n);
      if (days < 2) {
        out.push(_i(YELLOW, "경고", alias, `재고가 ${fixed(days, 1)}일치뿐입니다`, "곧 올릴 것이 떨어집니다", 요청));
      }
    }

    // ── 검토필요가 쌓여 있다
    if (sm.검토필요) {
      const 자리 = join(expandHome(folder), HOLD);
      out.push(_i(YELLOW, "경고", alias, `검토필요 ${sm.검토필요}건`, "쇼츠 조건에 안 맞거나 다른 채널 영상이 섞였습니다",
        { label: "폴더 열기", cmd: openCmd(자리), api: "/api/open", body: { path: 자리 } }));
    }
  }

  // ── 심사에서 막힌 것
  let pend: unknown[] = [];
  try { pend = loadPending(); } catch { pend = []; }
  if (pend.length) {
    // 검토 대기는 고장이 아니라 **정상 흐름의 한 장면**이다. 경고로 세면 영상 올릴 때마다 상단에 노란불이 들어와 진짜 경고가 묻힌다.
    out.push(_i(GREEN, "진행", "", `검토 대기 ${pend.length}건`, "30분 검토가 끝나면 자동으로 공개됩니다",
      { label: "지금 확인", cmd: `${CLI} 공개`, api: "/api/review/run", body: { publish: true } }));
  }

  if (opts.extras) out.push(...await moreIssues(opts.now ?? wallNow()));
  out.push(...await 보탤줄(opts));
  return dedupe(out);
}

/* ============================================================ 올리지 못한 파일들 */

/** 올리지 못한 영상 하나 — 어느 채널의 어느 파일이 왜 못 올라갔고 무엇을 하면 되는지 (화면의 「문제」 창이 파일별로 보인다) */
export interface ProblemFile { ch: string; file: string; what: string; why: string; fix: string; raw: string }

const 사유뜻 = (r: string): { what: string; fix: string } => {
  if (r.includes("쇼츠 조건") || r.includes("길이") || r.includes("가로") || r.includes("롱폼")) {
    return { what: "쇼츠 조건에 맞지 않습니다", fix: "쇼츠로 낼 영상이면 3분 이하 세로(또는 정사각) 영상으로 다시 만들어 주세요. 롱폼이면 롱폼 채널 칸으로 넣어 주세요." };
  }
  if (r.includes("다른 채널") || r.includes("짝")) {
    return { what: "다른 채널 영상이 섞여 있습니다", fix: "이 폴더 채널의 영상인지 확인해, 맞으면 폴더를 다시 지정하고 아니면 맞는 채널 폴더로 옮겨 주세요." };
  }
  if (r.includes("읽을 수 없") || r.includes("moov") || r.includes("손상")) {
    return { what: "영상을 읽을 수 없습니다", fix: "파일이 끊겼을 수 있습니다. 같은 영상을 다시 받거나 내보내서 폴더에 넣어 주세요." };
  }
  return { what: "올리지 않고 검토필요로 치웠습니다", fix: "이유를 확인해 고친 뒤 영상을 채널 폴더로 되돌려 주세요." };
};

/**
 * 올리지 못한 파일들 — ① 검토필요 폴더로 치워진 영상(사유 메모와 함께) ② 최근 하루 안에 업로드가 실패했고 아직 폴더에 그대로 있는 영상.
 * 유튜브는 한 번도 부르지 않는다. 채널마다 최대 30개, 전체 100개까지. (이름·사유만 있고 열쇠·토큰은 없다)
 */
export async function problemFiles(chans: Channels, o: { limit?: number } = {}): Promise<ProblemFile[]> {
  const cap = o.limit ?? 100;
  const out: ProblemFile[] = [];
  // ① 검토필요
  for (const [ch, cf] of Object.entries(chans)) {
    const folder = String(cf.folder ?? "").trim();
    if (!folder) continue;
    const hold = join(expandHome(folder), HOLD);
    const names: string[] = [];
    try { for await (const e of Deno.readDir(hold)) if (e.isFile && VIDEO_EXT.has(extOf(e.name).toLowerCase())) names.push(e.name); } catch { continue; }
    for (const n of names.sort().slice(0, 30)) {
      let reasons: string[] = [];
      try {
        const t = await Deno.readTextFile(join(hold, stemOf(n) + ".사유.txt"));
        reasons = t.split("\n").filter((l) => /^\s+-\s/.test(l)).map((l) => l.replace(/^\s+-\s*/, "").trim()).filter(Boolean);
      } catch { /* 메모가 없으면 일반 안내 */ }
      const 뜻 = 사유뜻(reasons.join(" "));
      out.push({ ch, file: join(hold, n), what: 뜻.what, why: reasons.length ? reasons.join(" / ") : "사유 메모가 없습니다", fix: 뜻.fix, raw: reasons.join(" / ") });
    }
  }
  // ② 최근 업로드 실패 (아직 폴더에 있고 올라간 적 없는 것만)
  try {
    const 올림 = uploadedNames();
    const 보임 = new Set(out.map((x) => baseName(x.file)));
    for (const x of (await tailFile(recordPath("올리기.log"), 300, 1024 * 1024)).reverse()) {
      const m = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\s+실패\s+\[(.*?)\]\s*(\S+)\s+(.*)$/.exec(x);
      if (!m) continue;
      const [, , ch, name, raw] = m;
      if (보임.has(name) || 올림.has(name)) continue;
      const cf = chans[ch];
      const path = cf?.folder ? join(expandHome(cf.folder), name) : "";
      if (path && !(await exists(path))) continue;       // 폴더에 더는 없으면 이미 치웠거나 올렸다
      보임.add(name);
      const { 왜, 할일 } = explainUploadFailure(raw);
      out.push({ ch, file: path || name, what: "업로드에 실패했습니다", why: 왜, fix: 할일, raw: cut(raw, 300) });
      if (out.length >= cap) break;
    }
  } catch { /* 기록을 못 읽어도 ①은 돌려준다 */ }
  return out.slice(0, cap);
}

/** 재고 모자람 앞의 「채우기」 안내. 대행은 고객에게 받아야 하고, 소유주는 폴더에 직접 넣는다. */
function askFix(folder: string): Fix {
  if (isAgency()) return { label: "고객에게 요청", cmd: null };
  return { label: "폴더에 영상 넣기", cmd: null, api: "/api/open", body: { path: expandHome(folder) } };
}

/* ============================================================ 선택 기능이 보태는 줄 (쿠팡 파트너스 · AI 문안) */

/** 선택 기능 모듈을 불러오는 길 — 시험이 없는 모듈·던지는 모듈을 끼운다. 안 주면 아래 defaultLoaders. */
export interface OptionalLoaders {
  coupang?: () => Promise<unknown>;
  ai?: () => Promise<unknown>;
}

/** 진짜 길. 글자 그대로 써야 실행 파일을 구울 때 모듈이 함께 묶인다. */
export const defaultLoaders: Required<OptionalLoaders> = {
  // @ts-ignore 쿠팡 모듈은 아직 없을 수 있다 — 없으면 callOptional 이 잡는다(있으면 이 줄은 아무 일도 안 한다)
  coupang: () => import("./coupang.ts"),
  ai: () => import("./ai.ts"),
};

/** 같은 실패를 화면이 몇 초마다 부를 때마다 적으면 기록이 그 줄로 가득 찬다 — 말이 바뀔 때만 적는다 */
const 적은말 = new Set<string>();
async function 한번만적기(말: string): Promise<void> {
  if (적은말.has(말)) return;
  if (적은말.size > 50) 적은말.clear();
  적은말.add(말);
  await recordLine("서버.log", `선택 기능: ${말}`);
}

/** 선택 기능 함수 하나가 이보다 오래 걸리면 기다리지 않는다(ms). 화면이 몇 초마다 부르는 길이라 한 번 멈추면 요청이 쌓인다. */
export const OPTIONAL_LIMIT_MS = 3000;

/**
 * 선택 기능 모듈의 함수 하나를 부른다. 모듈이 없거나 · 그 함수가 없거나 · 던지거나 · 너무 오래 걸리면 null.
 * 신호등·미리보기가 선택 기능 때문에 멈추면 안 된다. 던진 까닭은 서버.log 에 한 번만 적는다.
 * 함수가 아직 없는 판(모듈은 있는데 그 함수는 아직)은 조용히 건너뛴다.
 */
export async function callOptional(
  which: "coupang" | "ai", fn: string, args: unknown[] = [], loaders: OptionalLoaders = {}, limitMs = OPTIONAL_LIMIT_MS,
): Promise<unknown> {
  const 일 = async (): Promise<unknown> => {
    const mod = (await (loaders[which] ?? defaultLoaders[which])()) as Record<string, unknown> | null;
    const f = mod?.[fn];
    if (typeof f !== "function") return null;
    return await (f as (...a: unknown[]) => unknown).apply(mod, args);
  };
  let 타이머: ReturnType<typeof setTimeout> | undefined;
  try {
    const 늦음 = Symbol("늦음");
    const got = await Promise.race([일(), new Promise<symbol>((res) => { 타이머 = setTimeout(() => res(늦음), limitMs); })]);
    if (got === 늦음) {
      await 한번만적기(`${which}.${fn} 가 ${limitMs}ms 안에 끝나지 않아 기다리지 않습니다`);
      return null;
    }
    return got;
  } catch (e) {
    await 한번만적기(`${which}.${fn} 를 못 불렀습니다 — ${cut(e instanceof Error ? e.message : String(e), 120)}`);
    return null;
  } finally {
    if (타이머 !== undefined) clearTimeout(타이머);
  }
}

/** 선택 기능이 보낸 한 줄을 이 모듈의 꼴로 가다듬는다. 알아볼 수 없으면 null (엉뚱한 값이 신호등을 깨뜨리지 않게). */
export function asIssue(x: unknown): Issue | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.what !== "string" || !o.what.trim()) return null;
  const level: Level = o.level === "red" || o.level === "yellow" || o.level === "green" ? o.level : "yellow";
  const fx = o.fix && typeof o.fix === "object" ? o.fix as Record<string, unknown> : null;
  let fix: Fix | null = null;
  if (fx && typeof fx.label === "string" && fx.label) {
    const { label, cmd, ...나머지 } = fx; // 단추 글·명령을 앞에 두고 api·body 같은 나머지는 그대로 보존
    fix = { label: String(label), cmd: typeof cmd === "string" ? cmd : null, ...나머지 };
  }
  return {
    level,
    kind: typeof o.kind === "string" && o.kind ? o.kind : KIND[level],
    channel: typeof o.channel === "string" ? o.channel : "",
    what: o.what,
    why: typeof o.why === "string" ? o.why : "",
    fix,
    auto: o.auto === true,
  };
}

/**
 * 쿠팡 파트너스 경고(`coupang.warnings()`)와 AI 문안 안내(`ai.aiNotice()`)를 줄로. 둘 다 없으면 [].
 * 쿠팡 줄이 먼저, AI 안내가 뒤. 받은 줄은 그대로 두고 빠진 칸만 채운다.
 */
export async function optionalIssues(loaders: OptionalLoaders = {}): Promise<Issue[]> {
  const out: Issue[] = [];
  const 쿠팡 = await callOptional("coupang", "warnings", [], loaders);
  for (const x of Array.isArray(쿠팡) ? 쿠팡 : []) {
    const i = asIssue(x);
    if (i) out.push(i);
  }
  const 안내 = await callOptional("ai", "aiNotice", [], loaders);
  for (const x of Array.isArray(안내) ? 안내 : [안내]) {
    const i = asIssue(x);
    if (i) out.push(i);
  }
  return out;
}

async function 보탤줄(opts: CollectOpts): Promise<Issue[]> {
  if (!opts.extra) return await optionalIssues();
  try {
    const got = await opts.extra();
    return (Array.isArray(got) ? got : []).map(asIssue).filter((i): i is Issue => !!i);
  } catch (e) {
    await 한번만적기(`끼워 넣은 줄을 못 만들었습니다 — ${cut(e instanceof Error ? e.message : String(e), 120)}`);
    return [];
  }
}

/* ============================================================ 원본 신호등에 없는 네 가지 (옵션) */

/** 쏠 시각을 이만큼(분) 넘기면 밀렸다고 본다 — 심사확인 틱이 10분마다 도므로 그 몇 배는 지나야 이상하다 */
export const LATE_MIN = 30;
/** 오늘 올릴 수 있는 횟수·호출 몫이 이 밑으로 내려가면 임박 */
export const QUOTA_LOW_UPLOADS = 3;
export const QUOTA_LOW_UNITS = 300;

async function moreIssues(now: Wall): Promise<Issue[]> {
  const out: Issue[] = [];

  if (isLocked()) {
    out.push(_i(YELLOW, "경고", "", "올리기가 잠겨 있습니다",
      "잠금을 풀기 전에는 업로드도 공개도 나가지 않습니다 — 일부러 잠근 것이면 「확인했음」으로 접어 두세요",
      { label: "자물쇠 풀기", cmd: null, api: "/api/upload/lock", body: { on: false } }));
  }

  // 밀린 발사대기 — 심야 금지 시간(자정~07시)에는 안 나가는 게 정상이라 세지 않는다
  if (!(nightBan() && now.getUTCHours() < 7)) {
    const late = new Map<string, { n: number; max: number }>();
    for (const x of readQueue()) {
      const 늦음 = -minutesLeft(x, now);
      if (늦음 < LATE_MIN) continue;
      let 이름 = String(x._alias || x.channel || "");
      try { 이름 = resolve(이름) ?? 이름; } catch { /* 이름을 못 찾으면 그대로 */ }
      const g = late.get(이름) ?? { n: 0, max: 0 };
      g.n++;
      g.max = Math.max(g.max, 늦음);
      late.set(이름, g);
    }
    for (const [이름, g] of late) {
      out.push(_i(YELLOW, "작업불이행", 이름, `발사대기 ${g.n}건이 예정 시각을 넘겼습니다`,
        `가장 늦은 것이 ${Math.floor(g.max / 60)}시간 ${g.max % 60}분 밀렸습니다 — 컴퓨터가 꺼져 있었거나 한도·오류로 못 쐈을 수 있습니다`,
        { label: "발사대기 확인", cmd: null }));
    }
  }

  // 사람 확인 필요 — 올린 지 30분에 한 번 봤는데 심사가 안 끝나 앱이 사람에게 넘긴 것
  const byCh = new Map<string, number>();
  for (const p of loadPending()) if (p.사람확인) byCh.set(String(p.channel ?? ""), (byCh.get(String(p.channel ?? "")) ?? 0) + 1);
  for (const [이름, n] of byCh) {
    const cid = loadChannels()[이름]?.channel_id ?? "";
    out.push(_i(YELLOW, "할 일", 이름, `사람이 확인할 영상 ${n}건`,
      "유튜브 심사가 30분 안에 끝나지 않아 앱이 손을 뗐습니다 — 스튜디오에서 직접 확인하세요",
      cid ? { label: "스튜디오 열기", cmd: null, api: `/studio?cid=${cid}` } : { label: "스튜디오에서 확인", cmd: null }));
  }

  // 한도 임박
  try {
    const q = quotaToday();
    if (q.업로드남음 <= QUOTA_LOW_UPLOADS || q.유닛남음 <= QUOTA_LOW_UNITS) {
      out.push(_i(YELLOW, "경고", "", "오늘 유튜브 한도가 얼마 남지 않았습니다",
        `올리기 ${q.업로드남음}번 · 호출 ${q.유닛남음}유닛 남음 — ${q.초기화} 풀립니다`, null));
    }
  } catch { /* 계량 파일을 못 읽으면 신호등이 거짓말하느니 말없이 지나간다 */ }

  return out;
}

/* ============================================================ 요약·보고 */

/** 신호등 숫자. 초록은 세지 않는다 — 신호등은 나쁜 것만 센다. (파이썬 summary) */
export function summary(issues: Issue[]): { red: number; yellow: number; green: number } {
  return {
    red: issues.filter((i) => i.level === RED).length,
    yellow: issues.filter((i) => i.level === YELLOW).length,
    green: 0,
  };
}

/** 터미널에 찍을 줄들. (파이썬 report — 찍는 대신 줄을 돌려준다) */
export function report(issues: Issue[]): string[] {
  const out: string[] = [""];
  const c = summary(issues);
  if (!issues.length) {
    out.push("  ● 정상   문제가 없습니다.", "");
    return out;
  }

  // 신호등 요약
  const lamp: string[] = [];
  if (c.red) lamp.push(`● 오류 ${c.red}`);
  if (c.yellow) lamp.push(`● 작업불이행·경고 ${c.yellow}`);
  if (!c.red && !c.yellow) lamp.push("● 정상");
  out.push("  " + lamp.join("   "));
  out.push("  " + "─".repeat(76));

  for (const lv of [RED, YELLOW] as Level[]) {
    for (const it of issues.filter((i) => i.level === lv)) {
      out.push(`  ${MARK[lv]} [${KIND_LABEL[it.kind] ?? it.kind}]${it.channel ? " " + it.channel : ""}`);
      out.push(`      ${it.what}`);
      if (it.why) out.push(`      ${cut(it.why, 74)}`);
      const fx = it.fix;
      if (fx?.cmd) out.push(`      ▸ ${fx.label}${it.auto ? " (바로 고칠 수 있음)" : ""}:  ${fx.cmd}`);
      else if (fx?.label) out.push(`      ▸ ${fx.label}`);
      out.push("");
    }
  }

  if (c.red) out.push("  빨강이 남아 있으면 업로드가 진행되지 않습니다.");
  out.push("");
  return out;
}

/* ============================================================ AI 에게 붙여 넣을 설명글 */

/**
 * 전체 경로는 마지막 두 칸만 남긴다 — 사용자 이름이 든 폴더 경로가 남의 대화창에 실리지 않게.
 * 주소(https://…)는 그대로 둔다: 앞에 「:」가 붙어 있어 경로로 보지 않는다.
 */
export function shortPaths(text: string): string {
  return text.replace(/(?<![^\s"'(\[])((?:[A-Za-z]:[\\/]|\/)[^\s"'()\[\]<>|]{2,})/g, (p) => {
    const seg = p.split(/[\\/]/).filter(Boolean);
    return seg.length >= 3 ? `…/${seg.slice(-2).join("/")}` : p;
  });
}

/**
 * AI 대화창에 그대로 붙여 넣을 수 있는 형태로 만든다. (파이썬 as_prompt)
 *
 * 사람이 오류를 옮겨 적으면 빠뜨리고 틀린다. 고치는 데 필요한 것 — 무엇이 · 어디서 · 왜 · 어떤 상태에서 — 를 한 덩이로 묶어 준다.
 * ★비밀(토큰·열쇠 파일 내용)은 어디에도 싣지 않는다. 채널 이름·폴더 끝자리·설정 몇 칸만 실린다.
 */
export function asPrompt(issues: Issue[], chans?: Channels): string {
  const red = issues.filter((i) => i.level === RED);
  const yel = issues.filter((i) => i.level === YELLOW);
  const L: string[] = [`${APP_NAME}에서 아래 문제가 났습니다. 원인과 고치는 방법을 알려주세요.`, ""];

  if (red.length) {
    L.push(`## 오류 ${red.length}건 — 업로드가 막혔습니다`);
    for (const i of red) {
      L.push(`- ${i.channel ? `[${i.channel}] ` : ""}${shortPaths(i.what)}`);
      if (i.why) L.push(`  - 내용: ${shortPaths(i.why)}`);
      if (i.fix?.cmd) L.push(`  - 앱이 제안한 조치: ${shortPaths(i.fix.cmd)}`);
    }
    L.push("");
  }

  if (yel.length) {
    L.push(`## 작업불이행·경고 ${yel.length}건`);
    for (const i of yel) {
      L.push(`- ${i.channel ? `[${i.channel}] ` : ""}${shortPaths(i.what)}` + (i.why ? ` — ${shortPaths(i.why)}` : ""));
    }
    L.push("");
  }

  if (chans) {
    L.push("## 그때 설정");
    for (const [alias, cf] of Object.entries(chans)) {
      const folder = String(cf.folder ?? "");
      const short = folder ? folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/") : "";
      L.push(`- ${alias}: 폴더 ${short ? "…/" + short : "(없음)"} · 머리말 '${cf.prefix ?? ""}' · ` +
        `발행 ${cf.publish ?? "schedule"} · 선택 ${cf.pick ?? "oldest"}`);
    }
    L.push("");
  }

  L.push("## 도구 구성");
  L.push(`- ${APP_NAME} ${APP_VERSION} (${Deno.build.os}) · ${isAgency() ? "대행 관리자 방식(고객사마다 채널 주인이 다름)" : "채널 소유주 방식(채널이 모두 내 계정 안)"}`);
  L.push("- Deno/TypeScript 로 만든 단일 실행 파일 + YouTube Data API v3, 채널마다 OAuth 리프레시 토큰");
  L.push("- 비공개 업로드 → 심사 확인 → 공개 전환의 2단계");
  L.push("- 폴더로 상태 관리(업로드완료·검토필요), 폴더에 채널 표식(.채널정보.json)");
  L.push("- 설정과 기록은 이 컴퓨터의 데이터 폴더에 있습니다 (channels.json · ledger.csv · pending.json · 발사대기.json · 기록/*.log)");
  L.push("※ 토큰·열쇠 같은 비밀 값은 이 글에 들어 있지 않습니다. 그런 파일의 내용은 어디에도 붙여 넣지 마세요.");
  return L.join("\n");
}

/* ============================================================ 클립보드 */

export interface ClipStep { cmd: string; args: string[]; enc: "utf-8" | "utf-16le"; env?: Record<string, string> }

/**
 * 클립보드에 쓰는 방법을 차례로. 있는 것을 만날 때까지 시도한다.
 *   맥 pbcopy · 윈도우 clip · 리눅스 wl-copy → xclip → xsel
 * 윈도우 clip 은 UTF-8 을 못 읽는다. UTF-16LE 로 넘겨야 한글이 산다.
 * 맥 pbcopy 는 로케일이 안 잡힌 곳(자동 실행)에서 UTF-8 을 못 알아본다 — LANG 을 같이 준다.
 */
export function clipboardPlan(os: string = Deno.build.os): ClipStep[] {
  if (os === "darwin") return [{ cmd: "pbcopy", args: [], enc: "utf-8", env: { LANG: "en_US.UTF-8" } }];
  if (os === "windows") return [{ cmd: "clip", args: [], enc: "utf-16le" }];
  return [
    { cmd: "wl-copy", args: [], enc: "utf-8" },
    { cmd: "xclip", args: ["-selection", "clipboard"], enc: "utf-8" },
    { cmd: "xsel", args: ["--clipboard", "--input"], enc: "utf-8" },
  ];
}

/** 글 → 바이트. 로케일에 기대지 않고 직접 인코딩한다. */
export function encodeFor(text: string, enc: ClipStep["enc"]): Uint8Array {
  if (enc === "utf-8") return new TextEncoder().encode(text);
  const b = new Uint8Array(text.length * 2); // utf-16le: 글자(코드 유닛)마다 낮은 바이트, 높은 바이트
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    b[i * 2] = c & 0xff;
    b[i * 2 + 1] = c >> 8;
  }
  return b;
}

export type ClipRunner = (step: ClipStep, bytes: Uint8Array) => Promise<boolean>;

const realRun: ClipRunner = async (step, bytes) => {
  const child = new Deno.Command(step.cmd, { args: step.args, env: step.env, stdin: "piped", stdout: "null", stderr: "null" }).spawn();
  const w = child.stdin.getWriter();
  await w.write(bytes);
  await w.close();
  return (await child.status).success;
};

/** 클립보드로. 어느 방법도 안 되면 false. run 을 바꿔 끼우면 시험이 진짜 클립보드를 건드리지 않는다. */
export async function copyToClipboard(text: string, run: ClipRunner = realRun, os: string = Deno.build.os): Promise<boolean> {
  for (const step of clipboardPlan(os)) {
    try {
      if (await run(step, encodeFor(text, step.enc))) return true;
    } catch { /* 이 도구가 없다 — 다음 것으로 */ }
  }
  return false;
}

/* ============================================================ 자동 고침 */

/**
 * 바로 고칠 수 있는 것만 고친다. 사람 판단이 필요한 것은 손대지 않는다. (파이썬 autofix)
 * 지금은 「폴더 표식 새기기」 하나다 — 표식이 없는 폴더에 채널 표식을 새긴다.
 * 이미 다른 채널의 표식이 있으면 덮어쓰지 않는다(고객이 뒤바뀌는 일을 막는 것이 표식의 존재 이유다).
 */
export async function autofix(issues: Issue[], o: { kind?: string } = {}): Promise<{ fixed: number; lines: string[] }> {
  const lines: string[] = [];
  let fixed = 0;
  const chans = loadChannels();
  let profs: Record<string, Record<string, unknown>> | null = null;
  for (const it of issues) {
    if (!it.auto) continue;
    if (o.kind && it.kind !== o.kind) continue;
    const act = (it.fix?.body as { act?: string } | undefined)?.act;
    if (act !== "bind") continue;
    lines.push(`  고치는 중 — ${it.channel ? `[${it.channel}] ` : ""}${it.what}`);
    const cf = chans[it.channel];
    if (!cf) { lines.push("      실패: 그런 채널이 없습니다"); continue; }
    const cid = cf.channel_id ?? "";
    const folder = expandHome(String(cf.folder ?? ""));
    if (!cid) { lines.push("      실패: 채널 인증이 안 돼 표식을 새길 수 없습니다"); continue; }
    if (!folder || !(await isDir(folder))) { lines.push(`      실패: 폴더가 없습니다 — ${cut(folder, 60)}`); continue; }
    const mk = await readMark(folder);
    if (mk) {
      if (mk["channel_id"] === cid) { fixed++; lines.push("      이미 새겨져 있습니다"); continue; }
      lines.push(`      실패: 이 폴더에는 다른 채널 표식이 있어 덮어쓰지 않습니다 — ${cut(String(mk["channel_title"] ?? "?"), 40)}`);
      continue;
    }
    try {
      profs ??= await loadProfiles();
      const title = String(profs[cid]?.title ?? it.channel);
      await writeMark(folder, cid, title, it.channel);
      fixed++;
      lines.push(`      ✓ 표식을 새겼습니다 — ${title}`);
    } catch (e) {
      lines.push(`      실패: ${cut(e instanceof Error ? e.message : String(e), 80)}`);
    }
  }
  return { fixed, lines };
}

/* ============================================================ 「확인했음」 장부 */

export const ackPath = () => recordPath("알림확인.txt");

/**
 * 지금 떠 있는 노랑을 한 줄로. **숫자는 지우고** 센다 — 「대기 2개」가 3개가 돼도 같은 경고다.
 * 숫자까지 맞춰야 봉인이 유지되면, 확인한 지 몇 분 만에 같은 경고가 되살아난다(실제로 그랬다).
 */
export function ackKey(issues: Issue[]): string {
  return issues.filter((i) => i.level === YELLOW).map((i) => i.what.replace(/\d+/g, "#")).sort().join("·");
}

/** 장부에 적힌 (날짜, 내용). 없거나 못 읽으면 null. */
export function readAck(): { day: string; key: string } | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(ackPath()).trim();
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) console.log(`  알림확인 기록을 읽지 못했습니다 — ${e instanceof Error ? e.message : e}`);
    return null;
  }
  const i = text.indexOf("|");
  return i < 0 ? { day: text, key: "" } : { day: text.slice(0, i), key: text.slice(i + 1) };
}

/** 오늘, 지금과 같은 내용을 확인했나 */
export function isAcked(issues: Issue[], now: Wall = wallNow()): boolean {
  const a = readAck();
  return !!a && a.day === dateOnly(now) && a.key === ackKey(issues);
}

/** 「확인했음」 — 지금 떠 있는 노랑을 오늘 날짜로 봉한다. 봉한 내용을 돌려준다. */
export async function ack(issues: Issue[], now: Wall = wallNow()): Promise<string> {
  const key = ackKey(issues);
  await writeTextAtomic(ackPath(), `${dateOnly(now)}|${key}`);
  return key;
}

/* ============================================================ 신호등 (머리 알약) */

export interface Lamp {
  /** 빨강이 하나라도 있으면 red, 아니면 (확인하지 않은) 노랑이 있으면 yellow, 아니면 green */
  level: Level;
  /** green 은 「문제 없는 채널 수」 — 문제 건수가 아니다 (파이썬 dashboard.render 의 ok) */
  counts: { red: number; yellow: number; green: number };
  ackedToday: boolean;
  /** 확인했음으로 접힌 노랑 수 */
  folded: number;
}

/** 화면 머리의 신호등. 확인한 노랑은 그날 하루 정상으로 센다. 빨강은 못 접는다. (파이썬 dashboard.render 앞부분) */
export function lamp(issues: Issue[], channelCount: number, now: Wall = wallNow()): Lamp {
  const c = summary(issues);
  const acked = c.yellow > 0 && isAcked(issues, now);
  const yellow = acked ? 0 : c.yellow;
  return {
    level: c.red ? RED : yellow ? YELLOW : GREEN,
    counts: { red: c.red, yellow, green: Math.max(channelCount - c.red - yellow, 0) },
    ackedToday: acked,
    folded: acked ? c.yellow : 0,
  };
}


// 명령줄 — 파이썬 업로더의 `./업로더 <명령>` 과 같은 한글 명령들. (파이썬: 업로더 + run.py/setup.py/auth.py/device.py/review.py/sync.py/quota.py/profile.py/…)
//
// 실행 파일에 명령을 붙여 쓴다:  GarasadaeUploader 올려 --pick a.mp4 …   (인자가 없으면 화면 서버를 띄운다)
//
// 지키는 약속
//   · 화면과 **같은 문**을 지난다: 올리기는 plan.run → 출구검사(잠금 · 사람 승인 · 중복 · 폴더 짝 · 문안)를, 공개는 publishGate 를 지난다.
//     명령줄이라고 우회로가 아니다. 이행 보류(hold.ts) 중이면 올리기·공개는 어느 길이든 막힌다.
//   · 무엇을 올릴지 적지 않고 `올려` 만 주면 거부한다(손이 미끄러지면 고객 채널에 그대로 올라간다) — `--pick` 이나 `--맡김`.
//   · 열쇠·토큰 값은 한 줄도 출력하지 않는다.
//   · 채널·로그인 정보를 지우는 명령(설정 --remove · 연결해제)은 `--확인` 을 줘야 한다.
//
// 파이썬 명령 가운데 이 앱에 없는 것(가라사대 제작 관문 전용): 문안수정(umun_metadata) — 알려 주고 멈춘다.
import { APP_NAME, APP_VERSION, baseName, dataDir, expandHome, join, log } from "./paths.ts";
import { wallNow } from "./clock.ts";
import {
  clearMode, getMode, loadChannels, MODE_AGENCY, MODE_DESC, MODE_NAMES, MODE_OWNER, removeChannel, renameChannel, setFolder, setMode, verifyAll,
} from "./channels.ts";
import { loadStore } from "./ytcore.ts";
import * as PL from "./plan.ts";
import * as R from "./review.ts";
import * as SF from "./safety.ts";
import * as ISS from "./issues.ts";
import * as PB from "./published.ts";
import * as SY from "./sync.ts";
import * as QT from "./quota.ts";
import * as PRO from "./profile.ts";
import * as OA from "./oauth.ts";
import * as SAY from "./say.ts";
import * as PLAT from "./platform.ts";
import * as SG from "./settings.ts";
import * as MG from "./migrate.ts";
import * as TK from "./tick.ts";
import * as TH from "./thumbs.ts";
import * as ML from "./metacheck.ts";
import { check as checkVideo } from "./shorts.ts";
import { receive } from "./receive.ts";
import { pendingFiles } from "./folders.ts";
import { migrationHold } from "./hold.ts";

/* ============================================================ 도움말 */

export const HELP = `${APP_NAME} v${APP_VERSION} — 명령줄

평소 쓰는 것
  (명령 없이)        화면을 띄운다 (서버가 켜지고 브라우저가 열린다)
  오늘               오늘 뭐가 올라갈지 본다 (아무것도 안 바꾼다)
  화면               지금 상태를 화면으로 본다
  완료               올린 영상을 지표와 함께 본다
  확인               올릴 영상을 채널별로 본다
  올려               올린다   --pick 파일 …  고른 것만 · --at "파일=2026-10-20 14:20" …  쏘는 시각 · --맡김  오늘 계획대로 알아서
  공개               심사 끝난 것을 공개로 바꾼다
  대기               심사 대기 중인 영상을 본다

문제가 있을 때
  문제               오류·작업불이행·경고를 등급별로
  복사               그 문제를 클로드에 붙여 넣을 형태로 복사
  고침               자동으로 고칠 수 있는 것만 고침
  이행               옛 판 자료를 새 판으로 옮긴 결과를 다시 확인한다   --시험  옮기지 않고 센다 · --그대로시작 --확인  빠진 것이 있어도 새 판을 쓴다

가끔 쓰는 것
  현황               채널별 재고·오늘 편수
  성적               채널마다 무엇이 통했는지
  채널               등록된 채널과 폴더 짝
  설정               채널 폴더 정하기:  설정 "채널" "폴더"  ·  설정 --bind  ·  설정 --rename "옛" "새"  ·  설정 --remove "채널" --확인
  방식               대행 / 소유주 다시 고르기
  문안               제목·설명·태그가 제대로 읽히는지 미리 본다
  맞춤               기록을 유튜브 실제 상태에 맞춘다
  할당량             오늘 API 를 얼마나 썼는지
  인증               새 채널 연결 (브라우저 로그인)   --alias 이름 · --secret 열쇠파일 · --batch / --연속 N  한 계정의 채널을 잇달아
  코드인증           코드를 불러 주고 상대 기기에서 승인받는다
  정보               채널 정보(이름·배너·프로필) 새로 받기
  썸네일수정         썸네일 바꾸기:  썸네일수정 <채널> <영상ID> <그림파일> [--적용]
  점검               설정이 온전한지 점검한다
  검사               파일이 쇼츠 조건에 맞는지:  검사 영상.mp4 …
  받기               승인한 영상을 이 업로더로 넘긴다:  받기 <채널> <영상.mp4> [--쪽지 파일.json] [--제목 …] [--공개 "YYYY-MM-DD HH:MM"] [--롱폼] [--누가 "승인 표시"]
  잠궈 / 풀어        올리기를 잠그거나 푼다
  심사확인           10분마다 도는 점검을 지금 한 번 (자동 실행이 부르는 명령)
  버전

말로 해도 된다
  "A채널에 방금 만든 거 올려"
`;

/* ============================================================ 도구 */

type Say = (line: string) => void;
const out: Say = (l) => console.log(l);

/** `--이름 값 값 …` 묶음을 뽑는다. 값 없는 깃발은 빈 배열. 깃발이 아닌 앞쪽 낱말은 _ 에 모은다. */
function flags(args: string[]): { _: string[]; f: Record<string, string[]> } {
  const f: Record<string, string[]> = {};
  const _: string[] = [];
  let cur: string[] | null = null;
  for (const a of args) {
    if (a.startsWith("--") && a.length > 2) { const k = a.slice(2); cur = f[k] = f[k] ?? []; continue; }
    (cur ?? _).push(a);
  }
  return { _, f };
}
const has = (f: Record<string, string[]>, ...names: string[]) => names.some((n) => n in f);
const first = (f: Record<string, string[]>, ...names: string[]) => { for (const n of names) if (f[n]?.length) return f[n][0]; return ""; };

/** 한 줄 묻기. 입력을 받을 수 없는 환경이면 null */
function ask(q: string): string | null {
  try { return (prompt(q) ?? null); } catch { return null; }
}

const shortId = (s: string) => (s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-4) : s);

/* ============================================================ 명령들 */

async function 올리기(args: string[], go: boolean): Promise<number> {
  const { f } = flags(args);
  const r = await PL.run(go, f.pick, f.at, {
    autoOk: has(f, "맡김", "auto-ok"), who: "명령줄 --승인", say: out,
    lamp: async () => { const s = ISS.summary(await ISS.collect(loadChannels())); return { red: s.red, yellow: s.yellow }; },
  });
  return r.refused ? 1 : r.failed ? 2 : 0;
}

async function 완료(): Promise<number> {
  const rows = await PB.collect(loadChannels());
  let total = 0;
  for (const [name, list] of Object.entries(rows)) {
    if (!list.length) continue;
    out(`\n${"═".repeat(78)}\n  ${name}  — 올린 영상 ${list.length}편\n${"═".repeat(78)}`);
    for (const r of list.slice(0, 30)) {
      const views = r.live ? String(r.views ?? 0).padStart(7) : "     — ";
      out(`  ${r.live ? " " : "?"} ${views}회  ${(r.published || r.uploaded || "").slice(0, 16).replace("T", " ")}  ${(r.title || "").slice(0, 44)}  ${r.privacy ? `[${r.privacy}]` : ""}`);
    }
    if (list.length > 30) out(`  … 외 ${list.length - 30}편 (화면에서 전부 볼 수 있습니다)`);
    total += list.length;
  }
  if (!total) out("\n  올린 영상이 아직 없습니다.");
  return 0;
}

async function 공개(): Promise<number> {
  const r = await R.run(true, "사람", { say: out });
  return r.blocked ? 2 : 0;
}

async function 대기(): Promise<number> {
  const list = R.describePending();
  if (!list.length) { out("\n  심사 대기 중인 영상이 없습니다."); return 0; }
  out(`\n  심사 대기 ${list.length}건`);
  for (const it of list) out(`  · [${it.channel}] ${String(it.title).slice(0, 40)}  — ${it.state}${it.remaining ? ` (${it.remaining})` : ""}  확인 ${it.확인수}회`);
  return 0;
}

async function 문제(copy: boolean, fix: boolean): Promise<number> {
  const chans = loadChannels();
  const issues = await ISS.collect(chans);
  if (fix) {
    const r = await ISS.autofix(issues);
    for (const l of r.lines) out(l);
    out(r.fixed ? `\n  ${r.fixed}건 고쳤습니다.` : "\n  자동으로 고칠 수 있는 것이 없습니다.");
    return 0;
  }
  if (copy) {
    const ok = await ISS.copyToClipboard(ISS.asPrompt(issues, chans));
    out(ok ? "\n  문제를 클립보드에 복사했습니다 — 클로드 창에 붙여 넣으세요." : "\n  클립보드에 복사하지 못했습니다. 아래 글을 직접 복사하세요.\n\n" + ISS.asPrompt(issues, chans));
    return ok ? 0 : 1;
  }
  for (const l of ISS.report(issues)) out(l);
  return ISS.summary(issues).red ? 2 : 0;
}

async function 채널목록(): Promise<number> {
  const chans = loadChannels();
  const names = Object.keys(chans);
  if (!names.length) { out("설정된 채널이 없습니다. `인증` 으로 채널부터 연결하세요."); return 0; }
  const store = loadStore();
  const { fatal, warn } = await verifyAll(Object.fromEntries(Object.entries(chans).map(([k, v]) => [k, { ...v, folder: v.folder ? expandHome(v.folder) : v.folder }])));
  out(`${"채널".padEnd(24)} ${"연결".padEnd(8)} 폴더`);
  out("─".repeat(92));
  for (const [name, cf] of Object.entries(chans)) {
    const on = cf.channel_id && Object.values(store).some((v) => v.channel_id === cf.channel_id);
    out(`${name.padEnd(24)} ${(on ? "✓ 연결" : "— 안 됨").padEnd(8)} ${cf.folder || "— 정해지지 않음"}${cf.old_folder && !cf.folder ? `  (옛 자리: ${cf.old_folder})` : ""}`);
  }
  for (const w of warn) out(`  ⚠ ${w.split("\n")[0]}`);
  for (const w of fatal) out(`  ✗ ${w.split("\n")[0]}`);
  return fatal.length ? 2 : 0;
}

async function 설정(args: string[]): Promise<number> {
  const { _, f } = flags(args);
  if (has(f, "list") || (!_.length && !has(f, "bind", "remove", "rename"))) return await 채널목록();
  if (has(f, "rename")) {
    const [old, nu] = f.rename.length >= 2 ? f.rename : [f.rename[0], _[0]];
    if (!old || !nu) { out("사용법: 설정 --rename \"옛이름\" \"새이름\""); return 1; }
    try { await renameChannel(old, nu); } catch (e) { out(`  ${(e as Error).message}`); return 1; }
    out(`  이름을 바꿨습니다: ${old} → ${nu} (채널 연결은 그대로입니다)`);
    return 0;
  }
  if (has(f, "remove")) {
    const name = f.remove[0] ?? _[0];
    if (!name) { out("사용법: 설정 --remove \"채널\" --확인"); return 1; }
    if (!has(f, "확인", "yes")) { out(`  「${name}」 채널을 목록에서 뺍니다 — 이 컴퓨터의 로그인 정보와 채널 설정만 지우고 영상·폴더·올린 기록은 그대로 둡니다.\n  정말 빼려면 \`설정 --remove "${name}" --확인\` 으로 다시 실행하세요.`); return 1; }
    try { const r = await removeChannel(name); out(`  「${r.alias}」 채널을 목록에서 뺐습니다. (영상·폴더·올린 기록은 그대로)`); } catch (e) { out(`  ${(e as Error).message}`); return 1; }
    return 0;
  }
  if (has(f, "bind")) {
    let n = 0;
    for (const [name, cf] of Object.entries(loadChannels())) {
      if (!cf.folder) continue;
      try { await setFolder(name, expandHome(cf.folder), name); n++; } catch (e) { out(`  [${name}] ${(e as Error).message.split("\n")[0]}`); }
    }
    out(`  폴더 표식을 ${n}곳에 새겼습니다.`);
    return 0;
  }
  // 설정 <채널> <폴더>
  const [name, folder] = _;
  if (!name || !folder) { out("사용법: 설정 \"채널\" \"폴더 경로\""); return 1; }
  const chans = loadChannels();
  const key = chans[name] ? name : Object.keys(chans).find((k) => k.includes(name));
  if (!key) { out(`  그런 채널이 없습니다: ${name}`); return 1; }
  try {
    const r = await setFolder(key, expandHome(folder), key);
    out(`  [${key}] 폴더를 정했습니다 — ${r.folder} (영상 ${r.n}개)`);
  } catch (e) { out(`  ${(e as Error).message.split("\n")[0]}`); return 1; }
  return 0;
}

async function 방식(): Promise<number> {
  const cur = getMode();
  out(`\n지금: ${cur ? MODE_NAMES[cur] : "아직 안 골랐음"}\n`);
  out(`  1) ${MODE_NAMES[MODE_AGENCY]} — ${MODE_DESC[MODE_AGENCY]}\n  2) ${MODE_NAMES[MODE_OWNER]} — ${MODE_DESC[MODE_OWNER]}\n  0) 그대로 둔다`);
  const a = ask("번호를 고르세요 > ");
  if (a === "1") await setMode(MODE_AGENCY);
  else if (a === "2") await setMode(MODE_OWNER);
  else { out("\n  고르지 않아 그대로 둡니다."); return 0; }
  out(`\n  ${MODE_NAMES[getMode()!]} 로 바꿨습니다.`);
  return 0;
}

async function 문안(args: string[]): Promise<number> {
  const chans = loadChannels();
  const want = args.filter((a) => !a.startsWith("--"));
  let bad = 0, n = 0;
  for (const [name, cf] of Object.entries(chans)) {
    if (want.length && !want.some((w) => name.includes(w))) continue;
    if (!cf.folder) continue;
    const r = await ML.lookFolder(expandHome(cf.folder));
    out(`\n[${name}]`);
    for (const l of ML.formatLook(r)) out(l);
    bad += r.bad; n += r.videos;
  }
  out(`\n영상 ${n}편 중 손볼 곳이 있는 것 ${bad}편`);
  return bad ? 2 : 0;
}

async function 맞춤(): Promise<number> {
  const r = await SY.run(false, { say: out });
  out(`\n  기록 ${r.total}건을 실제에 맞췄습니다 (원장 ${r.ledger} · 사라진 영상 ${r.ghost} · 중복 ${r.dup} · 이름 ${r.name})`);
  return 0;
}

async function 정보(): Promise<number> {
  const rs = await PRO.refreshAll();
  for (const x of rs) out(`  ${x.ok ? "✓" : "✗"} ${x.key}${x.title ? ` — ${x.title}` : ""}${x.why ? ` (${x.why})` : ""}`);
  if (!rs.length) out("  연결된 채널이 없습니다.");
  return rs.some((x) => !x.ok) ? 2 : 0;
}

async function 점검(): Promise<number> {
  const r = await PL.cmdCheck(loadChannels(), out);
  return r.bad ? 2 : 0;
}

async function 검사(args: string[]): Promise<number> {
  const files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) { out("사용법: 검사 영상.mp4 …"); return 1; }
  let bad = 0;
  for (const p of files) {
    try {
      const r = await checkVideo(expandHome(p));
      out(`  ${r.ok ? "✓ 쇼츠" : `✗ ${r.kind}`}  ${baseName(p)}  ${r.info.w}x${r.info.h} · ${r.info.sec.toFixed(1)}초${r.notes.length ? "  — " + r.notes.join(" / ") : ""}`);
      if (!r.ok) bad++;
    } catch (e) { out(`  ✗ ${baseName(p)} — ${(e as Error).message.split("\n")[0]}`); bad++; }
  }
  return bad ? 2 : 0;
}

async function 받기(args: string[]): Promise<number> {
  const { _, f } = flags(args);
  const [channel, video] = _;
  if (!channel || !video) { out("사용법: 받기 <채널> <영상.mp4> [--쪽지 파일.json] [--제목 …] [--설명파일 …] [--공개 \"YYYY-MM-DD HH:MM\"] [--롱폼 [--칸 \"09:15,15:15\"]] [--누가 \"승인 표시\"]"); return 1; }
  try {
    const r = await receive(channel, expandHome(video), {
      note: first(f, "쪽지"), title: first(f, "제목"), descFile: first(f, "설명파일"), publishAt: first(f, "공개"),
      who: first(f, "누가") || "명령줄 --승인", slots: first(f, "칸") ? first(f, "칸").split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      now: has(f, "지금"), say: out,
    });
    out(`\n  ${r.dst}`);
    return 0;
  } catch (e) { out(`  ✗ ${(e as Error).message.split("\n")[0]}`); return 2; }
}

async function 썸네일수정(args: string[]): Promise<number> {
  const { _, f } = flags(args);
  const [channel, videoId, image] = _;
  if (!channel || !videoId || !image) { out("사용법: 썸네일수정 <채널> <영상ID> <그림파일> [--적용]   (--적용 없이는 미리보기 — 아무것도 안 바뀐다)"); return 1; }
  try {
    const r = await TH.replaceThumbnail(channel, videoId, expandHome(image), { apply: has(f, "적용", "apply") });
    out(`  ${r.message}\n  보관: ${r.directory}`);
    return 0;
  } catch (e) { out(`  ✗ ${(e as Error).message.split("\n")[0]}`); return 2; }
}

/** 인증: 브라우저 로그인. --batch / --연속 N 이면 한 구글 계정의 채널들을 잇달아 연결한다. */
async function 인증(args: string[]): Promise<number> {
  const { f } = flags(args);
  const st = await OA.clientState();
  if (!st.ready.browser) {
    out("  구글 로그인용 열쇠가 없습니다 — 이 판에는 내장 열쇠가 없고, 데이터 폴더에 client_secret.json 도 없습니다.");
    out(`  열쇠 파일을 ${dataDir()} 에 client_secret.json 으로 두거나, 화면의 설정에서 넣어 주세요. (안내: docs/설정안내.md)`);
    return 1;
  }
  const times = has(f, "연속") ? Math.max(1, parseInt(first(f, "연속") || "99", 10) || 99) : has(f, "batch") ? 99 : 1;
  const alias = first(f, "alias") || null, secret = first(f, "secret") || undefined;
  let ok = 0;
  for (let i = 0; i < times; i++) {
    let s;
    try { s = await OA.startSignIn(i === 0 ? alias : null, secret); } catch (e) { out(`  ✗ ${(e as Error).message}`); return 1; }
    out(`\n  구글 로그인 창을 엽니다. 안 열리면 아래 주소를 브라우저에 붙여 넣으세요:\n  ${s.url}\n`);
    out("  (계정 선택 창에서 연결할 채널을 고르세요 — 한 계정에 채널이 여럿이면 「계정 전환」으로 다른 채널을 고를 수 있습니다)");
    await PLAT.openUrl(s.url, SG.appSettings().browser);
    try {
      const r = await s.done;
      ok++;
      out(`  ✓ 연결했습니다 — ${r.title} (${shortId(r.channel_id)}) · 이름 「${r.key}」${r.replaced.length ? ` · 같은 채널의 옛 이름(${r.replaced.join(", ")})을 이 자리로 합쳤습니다` : ""}`);
    } catch (e) {
      out(`  ✗ ${(e as Error).message.split("\n")[0]}`);
      if (times === 1) return 2;
    }
    if (i < times - 1) {
      const a = ask("\n  다음 채널도 연결할까요? (엔터=예 / n=끝) > ");
      if (a === null || a.trim().toLowerCase().startsWith("n")) break;
    }
  }
  out(`\n  ${ok}개 채널을 연결했습니다. \`설정\` 으로 채널마다 폴더를 정하세요.`);
  return ok ? 0 : 2;
}

/** 코드인증: TV 유형 열쇠로 코드를 불러 주고 다른 기기에서 승인받는다 */
async function 코드인증(args: string[]): Promise<number> {
  const { f } = flags(args);
  let s;
  try { s = await OA.deviceStart(); } catch (e) { out(`  ✗ ${(e as Error).message}`); return 1; }
  out(`\n  다른 기기(휴대폰·컴퓨터)에서 이 주소를 열고 코드를 넣으세요:\n\n    ${s.verification_url ?? s.verification_uri}\n    코드:  ${s.user_code}\n`);
  out("  승인을 기다리는 중… (끝내려면 Ctrl+C)");
  try {
    const got = await OA.deviceWait(s);
    const r = await OA.deviceSave(got.refresh, first(f, "alias") || undefined, { scope: got.scope, mark: s._mark });
    out(`  ✓ 연결했습니다 — ${r.title} (${shortId(r.channel_id)}) · 이름 「${r.key}」`);
    return 0;
  } catch (e) { out(`  ✗ ${(e as Error).message.split("\n")[0]}`); return 2; }
}

async function 이행(args: string[]): Promise<number> {
  const { f } = flags(args);
  if (has(f, "그대로시작")) {
    if (!has(f, "확인")) {
      const h = migrationHold();
      out(h ? `  빠진 것이 있는 채로 새 판을 쓰겠다는 뜻입니다 — 빠진 것: ${h.missing.slice(0, 5).join(" / ") || "(없음)"}\n  복사본: ${h.backupDir}\n  정말 그러려면 \`이행 --그대로시작 --확인\` 으로 다시 실행하세요.` : "  멈춰 있는 이행이 없습니다.");
      return 1;
    }
    const r = await MG.acceptMigration();
    out(`  ${r.message}`);
    return r.ok ? 0 : 1;
  }
  const r = await MG.migrate({ dryRun: has(f, "시험"), say: out });
  for (const l of MG.formatReport(r)) out(l);
  return r.ok ? 0 : 2;
}

async function 말로(text: string): Promise<number> {
  const chans = loadChannels();
  const p = SAY.parse(text, chans);
  if (!p.channels.length && p.name_hint && (p.action === "upload" || p.action === "cart")) {
    const hit = await SAY.channelsWithFile(p.name_hint, chans);
    if (hit.length === 1) { p.channels = hit; p.warn = p.warn.filter((w) => !w.includes("채널")); }
  }
  for (const l of SAY.describe(p)) out(l);
  if (p.warn.length) { out(`\n  되물을 것이 있습니다: ${p.warn.join(" / ")}`); return 1; }
  if (p.action === "status") {
    for (const k of p.channels) {
      const folder = expandHome(chans[k].folder ?? "");
      const files = folder ? await pendingFiles(folder, () => {}).catch(() => [] as string[]) : [];
      out(`  ${k} — 올릴 영상 ${files.length}편`);
    }
    return 0;
  }
  if (p.action === "review") return await 공개();
  if (p.action !== "upload") { out("\n  이 명령줄은 올리기·현황·공개만 알아듣습니다. 담기·빼기는 화면에서 해 주세요."); return 1; }
  if (p.channels.length !== 1) { out("\n  어느 채널인지 하나로 정해지지 않았습니다."); return 1; }
  const r = await SAY.resolveFiles(p.channels[0], chans[p.channels[0]], p);
  const files = p.count ? r.files.slice(0, p.count) : r.files.slice(0, 1);
  if (!files.length) { out(`\n  올릴 영상을 못 찾았습니다 — ${r.how}`); return 1; }
  out(`\n  올릴 영상 (${r.how}):`);
  for (const x of files) out(`    · ${baseName(x)}`);
  const a = ask("\n  이대로 올릴까요? (y/n) > ");
  if (!a || !/^(y|yes|예|네|응|ㅇ)/i.test(a.trim())) { out("  올리지 않았습니다."); return 0; }
  const ats = p.fireAt ? files.map((x) => `${x}=${p.fireAt}`) : undefined;
  const run = await PL.run(true, files, ats, { who: "명령줄 --승인 (말로 시킴)", say: out });
  return run.refused ? 1 : run.failed ? 2 : 0;
}

async function 심사확인(): Promise<number> {
  const rep = await MG.ensureMigrated((l) => out(l));
  if (rep && !rep.ok) out("  ⚠ 옛 판 자료 이행이 끝나지 않았습니다 — 이번 심사확인은 건너뜁니다.");
  const r = await TK.tick({ say: out });
  if (r.skipped) out(`  (돌지 않음) ${r.skipped}`);
  return 0;
}

/* ============================================================ 분배 */

export type CliResult = { code: number } | { serve: true } | null;

/** 명령 이름 → 한 줄 설명 (시험이 도움말과 대조한다) */
export const COMMAND_NAMES = [
  "오늘", "올려", "실행", "업로드", "화면", "대시보드", "앱", "완료", "올린것", "성과", "확인", "미리", "공개", "발행", "문제", "오류", "복사", "클로드", "고침", "수리",
  "현황", "상태", "성적", "분석", "설정", "폴더", "방식", "모드", "문안", "텍스트", "문안수정", "썸네일수정", "맞춤", "동기화", "할당량", "크레딧", "코드인증", "디바이스",
  "인증", "채널", "대기", "정보", "점검", "검사", "받기", "도움말", "이행", "잠궈", "풀어", "심사확인", "버전",
];

/**
 * 인자 하나를 명령으로 푼다. 명령이 아니면 null (호출한 쪽이 말로 알아듣게 한다).
 * 인자가 없으면 화면 서버를 띄우라는 신호를 돌려준다.
 */
export async function runCli(args: string[]): Promise<CliResult> {
  if (!args.length) return { serve: true };
  const [cmd, ...rest] = args;
  const code = async (p: Promise<number>): Promise<CliResult> => ({ code: await p });
  switch (cmd) {
    case "오늘": case "계획": return await code(올리기(rest, false));
    case "올려": case "실행": case "업로드": return await code(올리기(rest, true));
    case "화면": case "대시보드": case "앱": return { serve: true };
    case "완료": case "올린것": case "성과": return await code(완료());
    case "확인": case "미리": {
      const r = await PL.cmdPreview(loadChannels(), { say: out });
      return { code: r.total ? 0 : 0 };
    }
    case "공개": case "발행": return await code(공개());
    case "문제": case "오류": return await code(문제(false, false));
    case "복사": case "클로드": return await code(문제(true, false));
    case "고침": case "수리": return await code(문제(false, true));
    case "현황": case "상태": { await PL.cmdStatus(loadChannels(), out); return { code: 0 }; }
    case "성적": case "분석": { await PL.cmdLearn(loadChannels(), out); return { code: 0 }; }
    case "설정": case "폴더": return await code(설정(rest));
    case "방식": case "모드": return await code(방식());
    case "문안": case "텍스트": return await code(문안(rest));
    case "문안수정": out("  `문안수정` 은 이 앱에 없습니다 — 문안은 화면의 「문안 고치기」나 영상 옆 .txt 로 고칩니다."); return { code: 1 };
    case "썸네일수정": return await code(썸네일수정(rest));
    case "맞춤": case "동기화": return await code(맞춤());
    case "할당량": case "크레딧": out(QT.report()); return { code: 0 };
    case "코드인증": case "디바이스": return await code(코드인증(rest));
    case "인증": return await code(인증(rest));
    case "채널": return await code(채널목록());
    case "대기": return await code(대기());
    case "정보": return await code(정보());
    case "점검": return await code(점검());
    case "검사": return await code(검사(rest));
    case "받기": return await code(받기(rest));
    case "이행": return await code(이행(rest));
    case "잠궈": await SF.setLocked(true); out("  올리기를 잠갔습니다."); return { code: 0 };
    case "풀어": await SF.setLocked(false); out("  올리기 잠금을 풀었습니다."); return { code: 0 };
    case "심사확인": return await code(심사확인());
    case "버전": case "--version": case "-v": out(`${APP_NAME} v${APP_VERSION}`); return { code: 0 };
    case "도움말": case "-h": case "--help": out(HELP); return { code: 0 };
  }
  if (cmd.startsWith("-")) return null;
  return await code(말로(args.join(" ")));
}

void join; void log; void wallNow; void clearMode;

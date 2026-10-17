// 환경 점검 — 이 컴퓨터에서 앱이 제대로 돌 수 있는지 읽기만 해서 알려 준다.  (파이썬: 환경점검.py)
//
// 원칙 (원본과 같다)
//   읽기만 한다. 로그인 정보를 열지 않고, 내려받지 않고, 계정에 아무것도 하지 않는다.
//   데이터 폴더에 쓸 수 있는지 보려고 임시 파일 하나를 만들었다 바로 지우는 것이 유일한 쓰기다
//   (폴더가 아직 없으면 만들지 않고, 가장 가까운 위쪽 폴더에서 같은 시험을 한다).
//
// 원본과 다른 점
//   원본은 파이썬·소스 파일 목록(serve.py · requirements.txt · 약관 페이지 …)이 다 있어야 통과였다.
//   이 앱은 단일 실행 파일이라 코드 파일이 없고, 데이터 파일은 필요할 때 앱이 만든다. 그래서 「없으면 막히는 파일」은 없다.
//   파일 목록은 있으면 좋은 것들을 보여 주고 없을 때 어떻게 되는지를 적는다(예: policy.json 은 없어도 안전한 기본값으로 동작한다).
//   ffprobe 가 없는 것도 실패가 아니다 — 내장 판독기가 mp4/mov/webm 의 길이·크기를 직접 읽는다.
import { APP_NAME, APP_VERSION, IS_MAC, IS_WIN, dataDir, dataPath, dirName, exists, isDir, join } from "./paths.ts";
import { findTool } from "./tools.ts";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface FileCheck {
  name: string;
  present: boolean;
  /** 없으면 앱이 못 돌아가나 — 지금은 모두 false 다(앱이 필요할 때 만든다) */
  required: boolean;
  /** 이 파일이 무엇이고, 없으면 어떻게 되는지 */
  note: string;
}

export interface EnvReport {
  /** 사람이 읽는 이름: macOS · Windows · Linux */
  osName: string;
  /** Deno.build.os 그대로: darwin · windows · linux … */
  os: string;
  release: string;
  arch: string;
  deno: string;
  appVersion: string;
  /** 단일 실행 파일로 돌고 있나 (개발 중 deno run 이면 false) */
  compiled: boolean;
  execPath: string;
  dataDir: string;
  dataDirExists: boolean;
  dataDirWritable: boolean;
  /** 쓸 수 없을 때의 이유, 아직 없을 때의 안내 (없으면 빈 글) */
  dataDirNote: string;
  /** ffprobe 자리 (없으면 빈 글) */
  ffprobe: string;
  ffmpeg: string;
  /** 영상 길이·크기를 재는 쪽: "ffprobe" 또는 "내장 판독기" */
  prober: string;
  files: FileCheck[];
  /** 앱이 돌 수 있는 상태인가 — 지금은 데이터 폴더에 쓸 수 있느냐가 전부다 */
  ok: boolean;
  /** ok 를 막는 문제 */
  problems: string[];
  /** 알아 두면 좋은 것 (막지는 않는다) */
  notes: string[];
  /** 터미널에 그대로 찍을 수 있는 사람이 읽는 줄들 (formatReport 와 같다) */
  lines: string[];
}

const 점검파일: { name: string; note: string }[] = [
  { name: "channels.json", note: "채널 ↔ 폴더 짝. 없으면 채널 탭에서 처음 연결할 때 만들어집니다" },
  { name: "tokens.json", note: "채널 로그인 정보. 없으면 아직 연결한 채널이 없는 것입니다" },
  { name: "client_secret.json", note: "구글 로그인용 열쇠 파일(브라우저 로그인). 코드 인증만 쓰면 없어도 됩니다" },
  { name: "device_secret.json", note: "구글 로그인용 열쇠 파일(코드 인증). 브라우저 로그인만 쓰면 없어도 됩니다" },
  { name: "policy.json", note: "운영 원칙(아동용 · AI 합성 표시 · 카테고리). 없어도 동작합니다 — 안전한 기본값을 쓰고, 앱이 처음 켜질 때 한 번 적어 둡니다" },
  { name: "ledger.csv", note: "올린 영상의 이력(원장). 처음 올릴 때 만들어집니다" },
];

function osNameOf(os: string): string {
  if (os === "darwin" || IS_MAC) return "macOS";
  if (os === "windows" || IS_WIN) return "Windows";
  if (os === "linux") return "Linux";
  return os;
}

function safe<T>(f: () => T, fallback: T): T {
  try { return f(); } catch { return fallback; } // 권한이 없어 못 읽는 값은 「모름」으로 둔다 — 점검이 그것 때문에 멈추면 안 된다
}

/** 데이터 폴더에 쓸 수 있나 — 임시 파일을 만들었다 지운다. 폴더가 없으면 가장 가까운 위쪽 폴더에서 한다. */
async function checkWritable(dir: string): Promise<{ exists: boolean; writable: boolean; note: string }> {
  let probe = dir;
  const there = await isDir(dir);
  // 폴더 자리에 파일이 놓여 있으면 앱이 폴더를 만들 수 없다 — 위쪽 폴더에 쓸 수 있다고 안심시키면 안 된다
  if (!there && await exists(dir)) return { exists: false, writable: false, note: `${dir} 자리에 폴더가 아니라 파일이 있습니다` };
  if (!there) {
    while (!(await isDir(probe))) {
      const up = dirName(probe);
      if (up === probe || up === ".") break;
      probe = up;
    }
  }
  const test = join(probe, `.쓰기시험_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`);
  try {
    await Deno.writeTextFile(test, "ok");
  } catch (e) {
    return { exists: there, writable: false, note: `${probe} 에 쓸 수 없습니다 — ${errMsg(e).slice(0, 100)}` };
  }
  try {
    await Deno.remove(test);
  } catch (e) {
    // 만들어졌다면 쓸 수는 있는 것이다. 지우지 못한 시험 파일은 사람이 알 수 있게 알린다.
    return { exists: there, writable: true, note: `시험 파일을 지우지 못했습니다(${test}) — ${errMsg(e).slice(0, 60)}` };
  }
  return { exists: there, writable: true, note: there ? "" : `아직 없습니다 — 처음 켤 때 앱이 만듭니다 (${dir})` };
}

/** 점검 결과를 모은다. 읽기만 한다. */
export async function report(): Promise<EnvReport> {
  const os = Deno.build.os;
  const execPath = safe(() => Deno.execPath(), "");
  const dir = dataDir();
  const w = await checkWritable(dir);
  const ffprobe = await findTool("ffprobe");
  const ffmpeg = await findTool("ffmpeg");

  const files: FileCheck[] = [];
  for (const f of 점검파일) files.push({ name: f.name, present: await exists(dataPath(f.name)), required: false, note: f.note });

  const problems: string[] = [];
  const notes: string[] = [];
  if (!w.writable) problems.push(`데이터 폴더에 쓸 수 없습니다 — ${w.note}`);
  else if (w.note) notes.push(w.note);
  if (!ffprobe) notes.push("ffprobe 가 없어 내장 판독기로 mp4/mov/webm 의 길이·크기를 읽습니다. 다른 형식(avi 등)은 ffprobe 를 설치해야 올릴 수 있습니다");
  if (!ffmpeg) notes.push("ffmpeg 가 없습니다 — 이미 올라간 영상의 썸네일을 바꾸는 기능(같은 그림인지 비교)에만 필요합니다");
  const has = (n: string) => files.find((x) => x.name === n)?.present ?? false;
  if (!has("tokens.json") && !has("client_secret.json") && !has("device_secret.json")) {
    notes.push("구글 로그인용 열쇠 파일이 아직 없습니다 — 채널 탭에서 넣어야 채널을 연결할 수 있습니다");
  }

  const r: EnvReport = {
    osName: osNameOf(os), os,
    release: safe(() => Deno.osRelease(), ""),
    arch: Deno.build.arch,
    deno: Deno.version.deno,
    appVersion: APP_VERSION,
    compiled: !!execPath && !/(^|[\\/])deno(\.exe)?$/i.test(execPath),
    execPath,
    dataDir: dir, dataDirExists: w.exists, dataDirWritable: w.writable, dataDirNote: w.note,
    ffprobe, ffmpeg,
    prober: ffprobe ? "ffprobe" : "내장 판독기",
    files, ok: problems.length === 0, problems, notes, lines: [],
  };
  r.lines = formatReport(r);
  return r;
}

/** 터미널에 찍는 줄들 (파이썬은 JSON 을 그대로 찍었다 — 사람이 읽는 말로 바꿨다) */
export function formatReport(r: EnvReport): string[] {
  const L: string[] = [];
  L.push(`환경 점검 — ${APP_NAME} ${r.appVersion}`);
  L.push(`  운영체제    ${r.osName} ${r.arch}${r.release ? ` (${r.release})` : ""}`);
  L.push(`  실행 방식   ${r.compiled ? "단일 실행 파일" : "개발 모드(deno)"}   Deno ${r.deno}`);
  L.push(`  데이터 폴더  ${r.dataDir}`);
  L.push(`              ${r.dataDirWritable ? "✓ 쓸 수 있음" : "✕ 쓸 수 없음"}${r.dataDirNote ? ` — ${r.dataDirNote}` : ""}`);
  L.push(`  영상 판독기  ${r.prober}${r.ffprobe ? `  ${r.ffprobe}` : ""}`);
  L.push(`  ffmpeg      ${r.ffmpeg ? r.ffmpeg : "없음"}`);
  L.push("  데이터 파일");
  for (const f of r.files) L.push(`    ${f.present ? "✓" : "·"} ${f.name} — ${f.present ? "있음" : "없음"}${f.present ? "" : `  (${f.note})`}`);
  for (const n of r.notes) L.push(`  참고  ${n}`);
  L.push(r.ok ? "  결과  이상 없음" : `  결과  고칠 곳 ${r.problems.length}개`);
  for (const p of r.problems) L.push(`    ✕ ${p}`);
  return L;
}

// 보관 · 백업 — 날마다 자료를 날짜 붙여 따로 남기고, 외장하드로 한 방향 미러를 뜬다.
//   (파이썬: 보관.py  +  백업.py)
//
// ───────── 보관(keepToday) ─────────
// 왜 필요한가
//   어느 날 어제 영상별 기록이 통째로 없는 것을 발견했다. 백업본에도 없었다. 두 가지가 겹친 결과다.
//   1. 그 기록은 사람이 「갱신」을 눌러야만 쌓였다. 안 누른 날은 빈다.
//   2. 백업이 `rsync --delete` 였다. **원본에서 사라지면 10분 뒤 백업에서도 사라진다.** 그건 복사본이지 백업이 아니다.
//      시점 복구가 안 된다.
//   일별 조회수 기록은 성격이 특별하다 — **한 번 놓치면 영원히 못 채운다.** 유튜브는 지금 누적값만 주지 지나간 날의
//   하루치를 주지 않는다. 그래서 이 자료만큼은 날짜별로 따로 얼려 둔다.
//   기록/보관/YYYY-MM-DD/ 아래에 그날의 자료 사본. 같은 날 여러 번 돌려도 덮어쓸 뿐 늘지 않는다.
//
// ───────── 미러(mirror) ─────────
// 왜 rsync 를 버리고 앱이 직접 하나
//   예약 작업(launchd)이 돌리는 rsync 는 외장 볼륨을 못 연다(`Operation not permitted` — rsync 에는 TCC 권한이 없다).
//   그래서 이틀간 자동 백업이 458회 연속 실패했는데 로그에 rc=1 만 남아 아무도 몰랐다. 앱은 이미 외장 권한이 있다.
//   규칙: 이쪽 컴퓨터가 언제나 원본, 외장은 사본만 받는다 · 원본에서 사라진 것은 사본에서도 지운다 · 다시 만들 수 있는 것은 안 보낸다.
//   외장 파일명은 NFD 로 풀려 있을 수 있다 — **비교는 언제나 NFC 로 정규화**해서 한다(이름이 달라 보여서 같은 파일을
//   지웠다 다시 복사하는 헛일을 막는다).
import { APP_ID, dataDir, dataPath, dirName, exists, isDir, join, log, recordLine, recordPath, withFileLock, writeJson } from "./paths.ts";
import { addDays, dateOnly, isoWall, wallNow } from "./clock.ts";
import { backupTarget } from "./tools.ts";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 기록은 한 줄에 한 건이다 — 오류 글에 줄바꿈이 있으면 「 ⏎ 」로 바꾼다 (paths.ts 의 log() 와 같은 약속. recordLine 은 그대로 적는다) */
const 기록 = (파일: string, 줄: string) => recordLine(파일, 줄.replace(/\s*\r?\n\s*/g, " ⏎ "));

/* ============================================================ 보관 */

/** 놓치면 되살릴 수 없는 것들만 고른다. 코드는 백업으로 충분하다. (파이썬 지킬것) */
export const KEEP_FILES = [
  "구독기록.json", // 채널 총계·구독자 하루 한 점
  "영상기록.json", // 영상별 조회수 하루 한 점  ← 제일 중요
  "성적.json", // 지표 캐시(그날 무엇이 몇 회였나)
  "ledger.csv", // 올린 것 원장
  "pending.json", // 검토 대기
];
/** 이보다 오래된 날짜 폴더는 치운다 (파이썬 보관일) */
export const KEEP_DAYS = 400;

export const keepDir = () => recordPath("보관");

/** 파일을 복사하되 수정 시각을 그대로 둔다(파이썬 copy2). 임시 이름으로 받아 이름을 바꿔 — 복사하다 끊겨도 반쪽 파일이 안 남는다. */
async function copyKeepingTime(src: string, dest: string): Promise<void> {
  const tmp = `${dest}.${Date.now().toString(36)}.tmp`;
  try {
    await Deno.copyFile(src, tmp);
    try {
      const st = await Deno.stat(src);
      if (st.mtime) await Deno.utime(tmp, st.atime ?? st.mtime, st.mtime);
    } catch { /* 시각을 못 맞춰도 내용은 온전하다 */ }
    await Deno.rename(tmp, dest);
  } catch (e) {
    try { await Deno.remove(tmp); } catch { /* 없으면 그만 */ }
    throw e;
  }
}

/** 오늘 몫을 남긴다. 남긴 파일 수를 돌려준다. (파이썬 남기기) */
export async function keepToday(quiet = false): Promise<number> {
  const 오늘 = dateOnly(wallNow());
  const 칸 = join(keepDir(), 오늘);
  try {
    await Deno.mkdir(칸, { recursive: true });
  } catch (e) {
    await log(`  보관 폴더를 만들지 못했습니다 — ${errMsg(e)}`);
    return 0;
  }
  let 남긴것 = 0;
  for (const 이름 of KEEP_FILES) {
    const 원본 = dataPath(이름);
    if (!(await exists(원본))) continue;
    try {
      await copyKeepingTime(원본, join(칸, 이름));
      남긴것++;
    } catch (e) {
      // 조용히 넘기면 어느 날 자료가 없는 이유를 알 수 없다.
      await log(`  ${이름} 을 보관하지 못했습니다 — ${errMsg(e)}`);
    }
  }
  await 오래된것치우기();
  if (!quiet) console.log(`  ${오늘} 자료 ${남긴것}개 보관했습니다 → ${칸}`);
  return 남긴것;
}

const 날짜폴더 = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 400일 지난 날짜 폴더를 치운다. 날짜 모양(YYYY-MM-DD)인 폴더만 건드린다 — 파이썬은 이름이 글자로 더 작기만 하면
 * 무엇이든 지웠다(사람이 보관 폴더에 따로 넣어 둔 폴더까지).
 */
async function 오래된것치우기(): Promise<void> {
  const 자를날 = dateOnly(addDays(wallNow(), -KEEP_DAYS));
  try {
    for await (const e of Deno.readDir(keepDir())) {
      if (!e.isDirectory || !날짜폴더.test(e.name) || e.name >= 자를날) continue;
      try {
        await Deno.remove(join(keepDir(), e.name), { recursive: true });
      } catch (x) {
        await log(`  오래된 보관을 치우지 못했습니다 — ${e.name}: ${errMsg(x)}`);
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) await log(`  오래된 보관을 치우지 못했습니다 — ${errMsg(e)}`);
  }
}

export interface KeptDay {
  /** YYYY-MM-DD */
  date: string;
  files: number;
  bytes: number;
}

/** 무엇이 남아 있나 — 오래된 날부터. (파이썬 목록 · --목록) */
export async function listKept(): Promise<KeptDay[]> {
  const out: KeptDay[] = [];
  try {
    for await (const e of Deno.readDir(keepDir())) {
      if (!e.isDirectory) continue;
      let files = 0, bytes = 0;
      try {
        for await (const f of Deno.readDir(join(keepDir(), e.name))) {
          if (!f.isFile) continue;
          files++;
          try { bytes += (await Deno.stat(join(keepDir(), e.name, f.name))).size; } catch { /* 방금 사라졌으면 셈에서 뺀다 */ }
        }
      } catch { /* 읽을 수 없는 폴더는 0개로 보인다 */ }
      out.push({ date: e.name, files, bytes });
    }
  } catch { /* 아직 보관한 것이 없다 */ }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ============================================================ 미러 */

/** 백업 대상 폴더에 남기는 표식 — 이 폴더는 이 앱의 미러 대상이라는 뜻 (아래 안전 장치 참고) */
export const MIRROR_MARK_NAME = ".백업표식.json";

// 미러에서 뺄 것 — 「다시 만들 수 있는 것」과 「복사할 가치가 없거나 복사하다 깨지는 것」.
//   .DS_Store · Thumbs.db · desktop.ini  운영체제가 폴더마다 만드는 찌꺼기
//   __pycache__ · .venv · .썸네일        옛(파이썬) 앱이 만들던 캐시 — 같은 폴더를 옛 앱과 함께 쓰는 사람을 위해 파이썬의 제외 목록을 그대로 둔다
//   영상정보.json                        영상 판독 캐시 — 다시 재면 생긴다(shorts.ts)
//   *.lock                               잠금 파일 — 프로세스가 열고 있을 수 있고 담을 내용이 없다
//   *.tmp                                원자적 쓰기의 중간 파일(paths.ts) — 복사하는 사이 이름이 바뀌어 사라진다
//   (백업 대상이 원본 폴더 안에 있으면 그 폴더도 뺀다 — mirror() 가 알아낸다. 자기 사본을 또 복사하며 끝없이 커지는 재귀를 막는다)
// ★기록/보관 은 **기본으로 뺀 것이 없다**: 원본(파이썬)도 「백업 쪽으로는 그대로 따라간다」고 적어 두었고, 날짜별 사본이
//   외장에도 있어야 「원본이 망가진 채 미러에 퍼진 날에도 어제 것이 남는」 보관의 뜻이 산다(미러는 지우기까지 하므로).
//   크기는 하루 몇 개의 작은 파일이라 무시할 만하다. 빼고 싶으면 아래 MIRROR_SKIP_PATHS 에 "기록/보관" 한 줄만 넣으면 된다.
//   .백업표식.json                       대상 폴더에 남기는 표식(아래 안전 장치) — 지우기 대상이 되면 안 된다
const 제외이름 = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "__pycache__", ".venv", ".썸네일", "영상정보.json", MIRROR_MARK_NAME]);
const 제외꼬리 = [".lock", ".tmp"];
/** 원본 폴더 기준 상대 경로(/ 로 구분)로 지정하는 제외 — 기본은 없다 */
export const MIRROR_SKIP_PATHS: string[] = [];
const 제외인가 = (name: string) => 제외이름.has(name) || 제외꼬리.some((x) => name.endsWith(x));

const nfc = (s: string) => s.normalize("NFC");

interface 파일정보 { path: string; size: number; mtime: number }

/** 뿌리 아래 파일들을 {NFC 상대경로: 정보} 로. 한 군데라도 못 읽으면 던진다 — 반쯤 읽은 목록으로 지우기를 하면 안 된다. */
async function 긁기(뿌리: string, 건너뛸폴더: string[] = []): Promise<Map<string, 파일정보>> {
  const out = new Map<string, 파일정보>();
  async function 걷기(dir: string, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      if (제외인가(e.name) || e.isSymlink) continue;
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (MIRROR_SKIP_PATHS.some((x) => nfc(x) === nfc(r))) continue;
      if (e.isDirectory) {
        if (!건너뛸폴더.includes(p)) await 걷기(p, r);
      } else if (e.isFile) {
        try {
          const st = await Deno.stat(p);
          out.set(nfc(r), { path: p, size: st.size, mtime: st.mtime?.getTime() ?? 0 });
        } catch (x) {
          if (!(x instanceof Deno.errors.NotFound)) throw x; // 읽는 사이 사라진 파일은 없는 것으로 친다
        }
      }
    }
  }
  await 걷기(뿌리, "");
  return out;
}

async function 폴더들(뿌리: string): Promise<string[]> {
  const out: string[] = [];
  async function 걷기(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isDirectory || e.isSymlink || 제외인가(e.name)) continue;
      const p = join(dir, e.name);
      out.push(p);
      await 걷기(p);
    }
  }
  await 걷기(뿌리);
  return out;
}

async function 진짜경로(p: string): Promise<string> {
  try { return await Deno.realPath(p); } catch { return p; } // 아직 없는 경로는 적힌 그대로 본다
}

function 안에있나(child: string, root: string): boolean {
  const sep = child.includes("\\") && !child.includes("/") ? "\\" : "/";
  const c = nfc(child), r = nfc(root).replace(/[\\/]+$/, "");
  return c === r || c.startsWith(r + sep);
}

/** 외장 볼륨의 뿌리 — 경로만 보고 알 수 있을 때 (맥 /Volumes/이름 · 윈도우 드라이브 · 리눅스 /media /mnt) */
function 볼륨뿌리(p: string): string | null {
  const m = /^(\/Volumes\/[^/]+|\/run\/media\/[^/]+\/[^/]+|\/media\/[^/]+\/[^/]+|\/media\/[^/]+|\/mnt\/[^/]+|[A-Za-z]:[\\/])/.exec(p);
  return m ? m[1] : null;
}

export interface MirrorResult {
  /** 0 = 끝남 · 1 = 실패 · 2 = 건너뜀(외장이 없거나 다른 백업이 도는 중) */
  code: 0 | 1 | 2;
  total: number;
  copied: number;
  deleted: number;
  message: string;
}

/**
 * 맥 → 외장 한 방향 미러. 대상은 경로설정.json 의 백업대상(tools.ts backupTarget). (파이썬 백업.미러)
 * 외장이 안 붙어 있으면 건너뛴다(코드 2) — 실패(1)와 구분해서, 외장을 뺀 날을 오류로 세지 않게.
 */
export async function mirror(quiet = false): Promise<MirrorResult> {
  // 실패(1)는 조용 모드에서도 서버.log 에 남긴다 — 원본은 그냥 rc=1 만 남아 이틀간 458번 실패한 걸 아무도 몰랐다.
  // 건너뜀(2)은 외장을 뺀 날의 정상 상태라 기록하지 않는다. 콘솔에는 조용 모드가 아닐 때만 말한다.
  const 결과 = async (code: 0 | 1 | 2, message: string, total = 0, copied = 0, deleted = 0): Promise<MirrorResult> => {
    if (code === 1) await 기록("서버.log", `백업 실패 — ${message}`);
    if (!quiet) console.log(message);
    return { code, total, copied, deleted, message };
  };

  const src = dataDir();
  const dst = backupTarget();

  // 외장이 붙어 있나 — 대상 경로로 가린다: 경로에서 볼륨 뿌리를 알 수 있으면 그것, 모르면 파이썬처럼 두 단계 위 폴더.
  // (경로설정.json 의 외장뿌리는 「영상이 사는 드라이브」라 백업과는 다른 드라이브일 수 있다 — 여기서 보지 않는다. 원본도 그랬다.)
  const 뿌리 = 볼륨뿌리(dst) ?? dirName(dirName(dst));
  if (!(await isDir(뿌리))) return await 결과(2, "외장하드가 연결돼 있지 않습니다");

  // 한 번에 하나만 — 예약 작업과 사람이 누른 백업이 겹쳐 같은 파일을 서로 지우지 않게
  const 일 = async (): Promise<MirrorResult> => {
    // 대상이 원본 안에 있으면 그 폴더는 건너뛴다(자기 사본을 또 복사하며 끝없이 커진다). 원본이 대상 안에 있으면 멈춘다.
    let 건너뛸: string[] = [];
    try {
      await Deno.mkdir(dst, { recursive: true });
      const s = await 진짜경로(src), d = await 진짜경로(dst);
      if (안에있나(s, d)) return await 결과(1, `백업 대상이 원본 폴더를 품고 있어 멈췄습니다 — ${dst}`);
      if (안에있나(d, s)) 건너뛸 = [join(src, d.slice(s.length).replace(/^[\\/]+/, ""))];
    } catch (e) {
      return await 결과(1, `백업 폴더를 만들지 못했습니다 — ${errMsg(e)}`);
    }

    // 안전 장치 — 미러는 원본에 없는 파일을 사본에서 **지운다.** 백업 대상을 엉뚱한 폴더(문서 폴더, 옛 앱의 백업 …)로
    // 잘못 적으면 그 안의 파일이 통째로 사라진다. 그래서 대상이 비어 있거나, 이 앱이 표식을 남긴 폴더일 때만 돈다.
    // (원본은 이 장치가 없었다 — 혼자 쓰는 앱이라 대상이 늘 정해져 있었지만, 남의 컴퓨터에 깔리는 앱은 다르다)
    const 표식 = join(dst, MIRROR_MARK_NAME);
    try {
      if (!(await exists(표식))) {
        let 있는것 = false;
        for await (const e of Deno.readDir(dst)) if (!제외인가(e.name)) { 있는것 = true; break; } // 하나만 보이면 된다
        if (있는것) {
          return await 결과(
            1,
            `백업 대상 폴더에 이미 다른 파일이 있어 멈췄습니다 — ${dst}\n` +
              `  미러는 원본에 없는 파일을 지우기 때문에, 대상은 빈 폴더이거나 이 앱이 만든 폴더여야 합니다. 빈 폴더를 골라 주세요.\n` +
              `  (이 폴더가 맞다면 안에 ${MIRROR_MARK_NAME} 파일을 만들어 두면 됩니다)`,
          );
        }
        await writeJson(표식, { 설명: "이 폴더는 앱이 원본을 그대로 비춰 두는 백업 자리입니다. 원본에 없는 파일은 지워집니다.", 앱: APP_ID, 만든때: isoWall(wallNow()) });
      }
    } catch (e) {
      return await 결과(1, `백업 폴더를 확인하지 못했습니다 — ${errMsg(e)}`);
    }

    // 양쪽을 다 읽은 뒤에만 움직인다. 못 읽은 곳이 있으면 아무것도 지우지 않고 멈춘다
    // (파이썬은 못 읽은 폴더를 조용히 건너뛰어, 읽다 만 목록으로 사본을 지울 수 있었다).
    let 원본: Map<string, 파일정보>, 사본: Map<string, 파일정보>;
    try {
      원본 = await 긁기(src, 건너뛸);
      사본 = await 긁기(dst);
    } catch (e) {
      return await 결과(1, `폴더를 읽지 못해 멈췄습니다(아무것도 지우지 않았습니다) — ${errMsg(e)}`);
    }

    let 복사 = 0;
    for (const [키, s] of 원본) {
      const 있던 = 사본.get(키);
      // 크기와 수정 시각이 같으면 같은 파일 — 안 건드린다 (외장 파일 시스템은 시각을 2초 단위로 둔다)
      if (있던 && 있던.size === s.size && Math.abs(있던.mtime - s.mtime) < 2000) continue;
      const d = 있던?.path ?? join(dst, ...키.split("/"));
      try {
        await Deno.mkdir(dirName(d), { recursive: true });
        await copyKeepingTime(s.path, d);
        복사++;
      } catch (e) {
        // 복사가 하나라도 실패하면 지우기까지 가지 않는다 — 덜 채운 사본에서 또 지우면 안 된다
        return await 결과(1, `복사 못 함 ${키} — ${errMsg(e)}`, 원본.size, 복사, 0);
      }
    }

    let 지움 = 0;
    for (const [키, d] of 사본) {
      if (원본.has(키)) continue;
      try {
        await Deno.remove(d.path);
        지움++;
      } catch (e) {
        await log(`지우지 못함 ${키} — ${errMsg(e)}`);
      }
    }
    // 빈 폴더 정리(깊은 곳부터). 비어 있을 때만 지워진다.
    try {
      for (const p of (await 폴더들(dst)).sort((a, b) => b.length - a.length)) {
        try { await Deno.remove(p); } catch { /* 안 비었으면 그대로 둔다 */ }
      }
    } catch (e) {
      await log(`빈 폴더를 치우지 못했습니다 — ${errMsg(e)}`);
    }
    return await 결과(0, `파일 ${원본.size}개 · 새로 복사 ${복사} · 지움 ${지움}`, 원본.size, 복사, 지움);
  };

  let 돈: MirrorResult | null;
  try {
    돈 = await withFileLock(dataPath("백업.lock"), 일, { wait: false });
  } catch (e) {
    // 잠금 파일을 못 열거나 뜻밖의 오류 — 던지지 않고 실패로 돌려준다(예약 작업이 이 함수를 부른다)
    return await 결과(1, `백업을 시작하지 못했습니다 — ${errMsg(e)}`);
  }
  if (돈 === null) return await 결과(2, "이미 다른 백업이 돌고 있습니다");
  return 돈;
}

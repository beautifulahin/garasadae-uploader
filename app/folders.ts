// 채널 폴더 관리 — 지정한 폴더 하나만 있으면 나머지는 알아서 만든다. (파이썬: folders.py)
//
// 채널마다 로컬 폴더를 하나 정해 두면 그 안이 이렇게 정리된다.
//
//     채널A/                      ← 여기에 영상을 넣기만 하면 된다
//       A_0827_01.mp4             올릴 차례를 기다리는 영상
//       업로드완료/                업로드가 끝나면 앱이 만들어 옮긴다
//       검토필요/                  쇼츠 조건에 안 맞아 올리지 않은 것 (사유.txt 가 나란히)
//
// 하위 폴더는 **필요해질 때 만든다.** 아무 일 없는 채널의 폴더는 깨끗하게 비어 있다.
import { baseName, dataPath, dirName, expandHome, extOf, homeDir, join, readJsonSync, recordLine, stemOf } from "./paths.ts";
export { expandHome };
import { uploadedNames } from "./ledger.ts";
import { pathConfig } from "./tools.ts";
import { appSettings, defaultBaseDir } from "./settings.ts";
import { moveToTrashPlain } from "./trash.ts";
import type { ChannelConf } from "./channels.ts";

export const DONE = "업로드완료";
export const HOLD = "검토필요";
export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);
/** 영상 곁에 붙어 다니는 파일들 — 같이 움직여야 짝이 안 깨진다 */
export const SIDE_EXT = [".txt", ".md", ".json", ".jpg", ".png", ".webp"];

const isVideoName = (n: string) => VIDEO_EXT.has(extOf(n).toLowerCase()) && !n.startsWith(".");

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile) out.push(join(dir, e.name));
  } catch { /* 폴더가 없으면 빈 목록 */ }
  return out;
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await Deno.stat(p)).isDirectory; } catch { return false; }
}

/**
 * 원장에 적힌 파일 이름. **여기 있으면 올린 것이다.** (파이썬 올린것들)
 *
 * 폴더 위치로 판단하지 않는 이유: `업로드완료` 라는 이름을 다른 데서 다른 뜻으로 쓴다. 어떤 제작 프로그램은 사람이
 * 「통과」라고 승인한 편을 그 폴더에 넣는다 — 아직 안 올린 것인데도. 그러면 업로더가 「이미 올렸다」로 읽고 영원히 건너뛴다.
 * 폴더는 사람이 옮기고 이름도 겹친다. **원장은 우리가 적는다.** 올렸는지 아닌지는 원장만 안다.
 */
export function uploadedFileNames(): Set<string> {
  try { return new Set(uploadedNames().keys()); } catch (e) {
    console.log(`  원장을 읽지 못했습니다 — ${(e as Error).message}`);
    return new Set();
  }
}

/** 발사대기에 담긴 파일 경로들 — 이미 사람이 시각을 정해 보낸 것이다 */
function queuedFiles(): Set<string> {
  try {
    const q = readJsonSync<unknown>(dataPath("발사대기.json"), []);
    return new Set(Array.isArray(q) ? q.map((x) => String((x as Record<string, unknown>).file ?? "")) : []);
  } catch (e) {
    console.log(`  발사대기를 읽지 못했습니다 — ${(e as Error).message}`);
    return new Set();
  }
}

/**
 * 올릴 차례를 기다리는 영상. (파이썬 pending_files)
 * 본 폴더를 훑고, **`업로드완료` 안에 있지만 원장에 없는 것**도 함께 올린다 — 사람이 승인 뜻으로 그 폴더에 넣어 둔 편이 조용히 묻히지 않도록.
 */
export async function pendingFiles(folder: string, say: (s: string) => void = console.log): Promise<string[]> {
  const d = expandHome(folder);
  if (!(await isDirectory(d))) throw new Error(`채널 폴더가 없습니다: ${d}`);
  const videos = async (x: string) => (await listFiles(x)).filter((f) => isVideoName(baseName(f)));
  let files = await videos(d);
  // ★루트 재고에는 검수 게이트를 대지 않는다 — 재작업본을 같은 이름으로 다시 납품하는 채널은 옛 검수 기록이 영상 옆에 남는다.
  //   기록만 보고 빼면 멀쩡한 재작업 완료본이 사라져 보인다(실제로 7개가 4개로 줄었다). 검수 게이트는 완료 폴더 구조(아래)에만 둔다.

  // 발사대기에 담긴 것은 이미 사람이 시각을 정해 보낸 것이다. 장바구니에 그대로 남아 있으면 두 번 고르게 되고,
  // 화면에서도 '아직 안 보낸 것' 처럼 보인다. 큐에 있으면 여기서 뺀다.
  const 큐 = queuedFiles();
  if (큐.size) files = files.filter((f) => !큐.has(f));

  const 완 = join(d, DONE);
  if (await isDirectory(완)) {
    const 올린 = uploadedFileNames();
    const 묻힌: string[] = [];
    for (const f of await videos(완)) {
      if (올린.has(baseName(f)) || 큐.has(f)) continue;
      if (await rejectedCopy(f)) continue;
      묻힌.push(f);
    }
    if (묻힌.length) {
      say(`  ※ '${DONE}' 안에 아직 안 올린 영상 ${묻힌.length}개가 있어 함께 올립니다 (원장 기준)`);
      for (const f of 묻힌) say(`     · ${baseName(f)}`);
      files = files.concat(묻힌);
    }
  }
  return files.sort((a, b) => (baseName(a) < baseName(b) ? -1 : baseName(a) > baseName(b) ? 1 : 0));
}

/**
 * 옆의 검수 기록이 PASS 가 아니면 참 — 재고로 되살리면 안 되는 판이다. (파이썬 _불합격본)
 * 실제 사고: 재작업 판정을 받은 편이 발사 전에 완료 폴더로 치워졌는데, 이 구조가 「원장에 없는 영상」이라며 재고로 되살려 화면에 올렸다.
 * 라운드가 여러 번이면(.검수.json < .검수.r2.json < …) 마지막 라운드의 판정이 그 편의 판정이다.
 */
async function rejectedCopy(f: string): Promise<boolean> {
  const dir = dirName(f), stem = stemOf(baseName(f));
  const 기록들: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.startsWith(stem + ".검수") && e.name.endsWith(".json")) 기록들.push(e.name);
    }
  } catch { return false; }
  if (!기록들.length) return false; // 검수 기록이 없으면 판단하지 않는다
  기록들.sort();
  try {
    const v = String((JSON.parse(await Deno.readTextFile(join(dir, 기록들[기록들.length - 1]))) as Record<string, unknown>).verdict ?? "");
    return !["", "PASS"].includes(v.toUpperCase());
  } catch {
    return false; // 깨진 기록으로 멀쩡한 재고를 막지 않는다
  }
}

async function pathExists(p: string): Promise<boolean> {
  try { await Deno.lstat(p); return true; } catch { return false; }
}

/** 옮긴다. 다른 저장 장치로 가는 이동은 복사 뒤 지운다. */
export async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await Deno.rename(src, dest);
  } catch {
    await Deno.copyFile(src, dest);
    await Deno.remove(src);
  }
}

/** 하위 폴더를 (없으면 만들어) 그 안으로 옮긴다. 같은 이름이 있으면 번호를 붙인다. (파이썬 _move_into) */
export async function moveInto(src: string, sub: string): Promise<string> {
  const destDir = join(dirName(src), sub);
  await Deno.mkdir(destDir, { recursive: true });
  const name = baseName(src);
  let dest = join(destDir, name);
  let n = 2;
  while (await pathExists(dest)) {
    dest = join(destDir, `${stemOf(name)} (${n})${extOf(name)}`);
    n++;
  }
  await moveFile(src, dest);
  return dest;
}

/**
 * 영상과 같은 이름의 문안·표지 파일도 함께 옮긴다. (파이썬 _move_side)
 * 영상만 옮기면 .txt 가 원폴더에 남아, 나중에 그 영상의 제목을 다시 읽을 때 파일 이름으로 돌아간다. 실제로 그 일이 있었다.
 */
async function moveSide(src: string, destSub: string): Promise<string[]> {
  const moved: string[] = [];
  const stem = stemOf(baseName(src));
  for (const f of await listFiles(dirName(src))) {
    const name = baseName(f);
    if (f === src) continue;
    // 001.mp4 → 001.txt / 001.poster.jpg / 001.job.json 까지
    if (stemOf(name) === stem || name.startsWith(stem + ".")) {
      if (SIDE_EXT.includes(extOf(name).toLowerCase())) {
        try {
          moved.push(baseName(await moveInto(f, destSub)));
        } catch (e) {
          // 조용히 넘기지 않는다. 실제로 문안·썸네일이 안 따라간 적이 있는데, 예외를 삼켜 원인을 끝내 못 찾았다.
          const m = (e as Error).message.slice(0, 110);
          console.log(`    곁 파일을 못 옮겼습니다 — ${name}: ${m}`);
          await recordLine("올리기.log", `곁파일이동실패  ${name}  ${(e as Error).name}: ${m}`);
        }
      }
    }
  }
  return moved;
}

/** 앱이 사본을 두는 곳(올릴 사본만 두는 곳)의 뿌리. 경로설정.json 의 「영상뿌리」로 바꿀 수 있고, 아니면 설정의 상위 폴더. (파이썬: 사본 전용 폴더) */
export function managedRoot(): string {
  return pathConfig()["영상뿌리"] || appSettings().baseDir || defaultBaseDir();
}

function insideManagedRoot(src: string): boolean {
  const real = (p: string) => { try { return Deno.realPathSync(p); } catch { return p; } };
  const root = real(managedRoot()).replace(/[\\/]+$/, "");
  const f = real(src);
  return f.startsWith(root + "/") || f.startsWith(root + "\\");
}

/** 올린 뒤 원본을 어떻게 할지: "trash" 휴지통 · "move" 업로드완료 폴더 · "keep" 그대로 */
export function afterUploadMode(src: string, cf?: Pick<ChannelConf, "after_upload"> | null): "trash" | "move" | "keep" {
  const m = String(cf?.after_upload ?? "").trim();
  if (m === "trash" || m === "move" || m === "keep") return m;
  // 정해 두지 않았으면 자리를 따른다 — 앱이 사본을 두는 곳이면 휴지통, 사람의 폴더면 업로드완료로 옮긴다.
  return insideManagedRoot(src) ? "trash" : "move";
}

/**
 * 업로드 성공 후에만 부른다. 순서를 바꾸면 실패한 영상이 완료로 들어간다. (파이썬 mark_done)
 *
 * 사본 자리(앱이 사본만 두는 곳)면 영상과 문안 파일을 휴지통으로 치운다 — 원본은 따로 보관돼 있으므로, 지우지 않고 휴지통으로(되살릴 수 있게).
 * 올린 기록은 장부(ledger.csv)에 남아 중복 업로드는 그대로 막힌다. 그 밖(사람의 폴더)은 `업로드완료` 폴더로 옮긴다.
 */
export async function markDone(src: string, cf?: Pick<ChannelConf, "after_upload"> | null): Promise<string> {
  const mode = afterUploadMode(src, cf);
  if (mode === "keep") return src;
  if (mode === "trash") {
    const stem = stemOf(baseName(src)), dir = dirName(src);
    for (const f of [src, ...[".txt", ".json", ".jpg", ".png"].map((x) => join(dir, stem + x))]) {
      try {
        const st = await Deno.stat(f).catch(() => null);
        if (st?.isFile) await moveToTrashPlain(f);
      } catch { /* 한 파일이 안 가도 나머지는 치운다 */ }
    }
    return src;
  }
  const out = await moveInto(src, DONE);
  await moveSide(src, DONE);
  return out;
}

/** 쇼츠 조건 미달 등으로 올리지 않은 것. 사유를 같은 이름의 txt 로 남긴다. (파이썬 mark_hold) */
export async function markHold(src: string, reasons: string[]): Promise<string> {
  const moved = await moveInto(src, HOLD);
  await moveSide(src, HOLD);
  const note = join(dirName(moved), stemOf(baseName(moved)) + ".사유.txt");
  await Deno.writeTextFile(note, `${baseName(src)}\n\n올리지 않은 이유\n` + reasons.map((r) => `  - ${r}`).join("\n") + "\n");
  return moved;
}

/** 채널 폴더 현황 — 화면에 그대로 보여줄 수 있는 숫자. (파이썬 summary) */
export async function summary(folder: string): Promise<{ 대기: number; 완료: number; 검토필요: number }> {
  const d = expandHome(folder);
  const count = async (sub?: string) => {
    const p = sub ? join(d, sub) : d;
    if (!(await isDirectory(p))) return 0;
    return (await listFiles(p)).filter((f) => VIDEO_EXT.has(extOf(f).toLowerCase())).length;
  };
  return { 대기: await count(), 완료: await count(DONE), 검토필요: await count(HOLD) };
}

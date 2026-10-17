// 컴퓨터마다 다른 경로는 전부 여기서 정한다. (파이썬 경로.py)
//
// 우선순위
//   1) 데이터 폴더의 `경로설정.json`
//   2) 그 컴퓨터에서 흔한 자리 (PATH · 맥 홈브류 · 윈도우 PATHEXT)
//   3) 없으면 「없다」고 분명히 말한다. 특정 컴퓨터의 경로를 기본값으로 박지 않는다
//      (배포본에 그대로 실린다 — 파이썬에서 실제로 실릴 뻔했다).
import { dataPath, env, exists, IS_WIN, join, readJsonSync } from "./paths.ts";

export function pathConfig(): Record<string, string> {
  return readJsonSync<Record<string, string>>(dataPath("경로설정.json"), {});
}

/** 외장하드 기본 자리 — 실제로는 없는 이름이라 백업이 조용히 건너뛴다 */
function 기본외장(): string {
  return IS_WIN ? "D:\\외장" : "/Volumes/외장";
}

/** 사본을 받을 폴더. 경로설정.json 의 백업대상. */
export function backupTarget(): string {
  return pathConfig()["백업대상"] || join(기본외장(), "백업", "가라사대업로더");
}
/** 영상이 사는 외장 볼륨의 뿌리 — 붙었는지 확인할 때 쓴다 */
export function externalRoot(): string {
  return pathConfig()["외장뿌리"] || 기본외장();
}

const 추가자리 = IS_WIN ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"];
const 캐시 = new Map<string, string>();

async function which(name: string): Promise<string> {
  const dirs = (env("PATH") || "").split(IS_WIN ? ";" : ":").filter(Boolean);
  for (const d of 추가자리) if (!dirs.includes(d)) dirs.push(d);
  const exts = IS_WIN ? ["", ...(env("PATHEXT") || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const d of dirs) {
    for (const x of exts) {
      const p = join(d, name + x);
      try {
        if ((await Deno.stat(p)).isFile) return p;
      } catch { /* 다음 */ }
    }
  }
  return "";
}

/** ffmpeg · ffprobe 의 자리. 없으면 빈 글. (경로설정.json 의 같은 이름 칸이 먼저) */
export async function findTool(name: "ffmpeg" | "ffprobe"): Promise<string> {
  if (캐시.has(name)) return 캐시.get(name)!;
  let found = "";
  const v = pathConfig()[name];
  if (v && await exists(v)) found = v;
  else found = await which(name);
  캐시.set(name, found);
  return found;
}

/** 시험: 도구 자리 캐시를 비운다 */
export function resetToolCache() { 캐시.clear(); }
/** 시험: 도구가 없는 컴퓨터를 흉내 낸다 */
export function forceToolMissing(name: string) { 캐시.set(name, ""); }

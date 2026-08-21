// 같은 편을 두 번 올리는 것을 막는다.
//
// 왜 있나 (H-187, 2026-08-21)
//   여러 세션이 같은 소재로 영상을 두 번 만들어 두 번 올라간 일이 있었다. 제작 쪽은
//   `이력.py`·`완성본지킴.py` 로 막아 두었는데 **업로더는 뚫려 있었다** — 마지막
//   관문인데 문이 없었다.
//   여태 막힌 것은 `afterUpload:"keep"` 으로 둔 파일뿐이고(watcher 의 state.kept),
//   기본값인 `_완료로 옮기기`로 쓰면 같은 mp4 를 다시 떨굴 때 그대로 또 올라갔다.
//
// 무엇으로 가리나 — 두 가지를 본다
//   ① **파일 지문** — 똑같은 파일이 다시 들어온 경우. 확실하다.
//   ② **제목** — 다시 만들어 파일은 다르지만 같은 편인 경우. 이쪽이 실제로 잦다.
//
// ★막기만 하고 지우지는 않는다. 화면에 세워 두고 사용자가 「그래도 올리기」를
//   누르면 그때 올라간다. 사람이 일부러 다시 올리려는 것을 프로그램이 이길 수는 없다.

import { UploadRec } from "./paths.ts";

/** 파일의 지문. 앞 1MB · 뒤 1MB · 크기를 합쳐 sha256 을 낸다.
 *
 * ★통째로 읽지 않는 까닭 — 영상은 크다(수백 MB). 앞뒤만 봐도 **같은 파일이
 *   다시 들어온 것**은 확실히 걸러진다. 서로 다른 영상이 앞 1MB·뒤 1MB·크기까지
 *   모두 같을 일은 사실상 없다.
 * ★다시 렌더한 판은 어차피 지문이 달라진다 — 그건 제목 쪽에서 잡는다.
 */
export async function fileFingerprint(path: string): Promise<string> {
  const 조각 = 1024 * 1024;
  const st = await Deno.stat(path);
  const size = st.size;
  const f = await Deno.open(path, { read: true });
  try {
    const 앞 = new Uint8Array(Math.min(조각, size));
    await 채우기(f, 앞);
    let 뒤 = new Uint8Array(0);
    if (size > 조각 * 2) {
      뒤 = new Uint8Array(조각);
      await f.seek(size - 조각, Deno.SeekMode.Start);
      await 채우기(f, 뒤);
    }
    const 합 = new Uint8Array(앞.length + 뒤.length + 8);
    합.set(앞, 0);
    합.set(뒤, 앞.length);
    new DataView(합.buffer).setBigUint64(앞.length + 뒤.length, BigInt(size));
    const d = await crypto.subtle.digest("SHA-256", 합);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } finally {
    try { f.close(); } catch { /* 무시 */ }
  }
}

async function 채우기(f: Deno.FsFile, buf: Uint8Array) {
  let read = 0;
  while (read < buf.length) {
    const n = await f.read(buf.subarray(read));
    if (n === null) break;
    read += n;
  }
}

/** 제목을 견주기 좋은 꼴로 깎는다 — 띄어쓰기·문장부호·이모지를 털어 낸다.
 *  "(속보)'개헌 왜 이렇게 급해요?'" 와 "개헌 왜 이렇게 급해요" 를 같은 것으로 본다. */
export function 제목열쇠(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[\s​]/g, "")
    // 한글·영문·숫자만 남긴다. 괄호·따옴표·이모지·물음표는 판을 가르지 못한다.
    .replace(/[^0-9a-z가-힣ㄱ-ㆎ]/g, "");
}

/** 한쪽이 다른 쪽을 통째로 품고 있으면 같은 편으로 본다.
 *
 * ★왜 '똑같은가' 만 보면 안 되나 — 채널에 `titlePrefix`("(속보)") 를 걸어 두면
 *   파일 이름에서 딴 제목에는 그것이 붙고, **쪽지에 적어 준 제목에는 안 붙는다**.
 *   그래서 같은 편인데 한쪽만 "(속보)" 가 붙어 서로 다른 것으로 보였다(실측).
 * ★짧은 쪽이 여덟 자는 되어야 한다. "개헌" 같은 토막이 아무 데나 걸리면
 *   멀쩡한 편이 자꾸 세워져 성가시다.
 */
const 품는최소 = 8;
function 같은편인가(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [짧, 긺] = a.length <= b.length ? [a, b] : [b, a];
  return 짧.length >= 품는최소 && 긺.includes(짧);
}

export interface DupHit {
  /** 무엇이 같아서 걸렸나 */
  why: "file" | "title";
  rec: UploadRec;
}

/**
 * 이미 올린 것들 가운데 같은 편을 찾는다. 없으면 null.
 *
 * @param days 며칠 치까지 볼까. 오래전 것까지 보면 **일부러 다시 올리는 것**까지
 *             막혀 성가시다. 기본 30일.
 */
export function findDuplicate(
  uploads: UploadRec[],
  opt: { channelId: string; hash: string; title: string; days?: number },
): DupHit | null {
  const 문턱 = Date.now() - (opt.days ?? 30) * 86400_000;
  const 열쇠 = 제목열쇠(opt.title);
  let 제목맞음: DupHit | null = null;

  for (const u of uploads) {
    if (u.channelId !== opt.channelId) continue;
    const t = Date.parse(u.at);
    if (Number.isFinite(t) && t < 문턱) continue;
    // 파일이 같은 것이 제일 확실하다 — 찾는 즉시 돌려준다
    if (opt.hash && u.hash && u.hash === opt.hash) return { why: "file", rec: u };
    // 제목은 한 번 기억만 해 두고 계속 본다(더 확실한 파일 일치가 있을 수 있다)
    if (!제목맞음 && 같은편인가(제목열쇠(u.title), 열쇠)) 제목맞음 = { why: "title", rec: u };
  }
  return 제목맞음;
}

/** 사람에게 보일 한 줄 */
export function dupMessage(hit: DupHit): string {
  const 때 = hit.rec.at.replace("T", " ").slice(0, 16);
  return hit.why === "file"
    ? `같은 파일을 ${때} 에 이미 올렸습니다 (${hit.rec.title}). 그래도 올리려면 「그래도 올리기」를 누르세요.`
    : `같은 제목을 ${때} 에 이미 올렸습니다 (${hit.rec.title}). 그래도 올리려면 「그래도 올리기」를 누르세요.`;
}

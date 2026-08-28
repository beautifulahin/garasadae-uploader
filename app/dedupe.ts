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
//      채널 접두·접미를 뗀 뒤 **똑같을 때만** 같은 편으로 본다. 품기(부분 일치)로 보다가
//      멀쩡히 다른 편이 걸리는 일이 있어 2026-08-28 에 없앴다 (공개판 신고 #2).
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

/** 채널이 붙이는 접두·접미를 떼어 낸다.
 *
 * ★왜 필요한가 — 채널에 `titlePrefix`("(속보)") 를 걸어 두면 파일 이름에서 딴
 *   제목에는 그것이 붙고, **쪽지에 적어 준 제목에는 안 붙는다**. 그래서 같은
 *   편인데 한쪽만 "(속보)" 가 붙어 서로 다른 것으로 보였다(실측).
 * ★붙는 말은 채널 설정에 적혀 있으니 **짐작하지 않고 그것만** 뗀다.
 */
function 껍질벗기기(열쇠: string, 접두: string, 접미: string): string {
  let s = 열쇠;
  if (접두 && s.length > 접두.length && s.startsWith(접두)) s = s.slice(접두.length);
  if (접미 && s.length > 접미.length && s.endsWith(접미)) s = s.slice(0, -접미.length);
  return s;
}

/** 접두·접미를 뗀 뒤 **똑같아야** 같은 편으로 본다.
 *
 * ★예전에는 "한쪽이 다른 쪽을 품고 있으면" 같은 편으로 봤다(여덟 자 이상).
 *   그런데 제목이 짧은 숏폼에서는 멀쩡히 다른 편이 서로를 품는 일이 잦다 —
 *   「여당만 몰랐던 209일」 과 「여당만 몰랐던 209일의 진실」 은 다른 영상인데
 *   품는다는 이유로 중복으로 세워졌다. 실제 신고(2026-08-27, 공개판 1.7.18):
 *   "제목이 애초에 서로 다른데 중복영상이라고 보류할지 그대로 올릴지 뜹니다".
 * ★품기를 두었던 까닭(접두·접미가 한쪽에만 붙는 것)은 위 `껍질벗기기` 가
 *   채널 설정을 보고 정확히 처리한다. 그래서 여기서는 짐작을 없앤다.
 * ★같은 파일을 다시 떨구는 것은 제목과 상관없이 **지문**이 잡는다.
 */
function 같은편인가(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b;
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
  opt: {
    channelId: string;
    hash: string;
    title: string;
    days?: number;
    /** 채널이 제목 앞뒤에 붙이는 말. 견주기 전에 양쪽에서 뗀다. */
    titlePrefix?: string;
    titleSuffix?: string;
  },
): DupHit | null {
  const 문턱 = Date.now() - (opt.days ?? 30) * 86400_000;
  const 접두 = 제목열쇠(opt.titlePrefix ?? "");
  const 접미 = 제목열쇠(opt.titleSuffix ?? "");
  const 열쇠 = 껍질벗기기(제목열쇠(opt.title), 접두, 접미);
  let 제목맞음: DupHit | null = null;

  for (const u of uploads) {
    if (u.channelId !== opt.channelId) continue;
    const t = Date.parse(u.at);
    if (Number.isFinite(t) && t < 문턱) continue;
    // 파일이 같은 것이 제일 확실하다 — 찾는 즉시 돌려준다
    if (opt.hash && u.hash && u.hash === opt.hash) return { why: "file", rec: u };
    // 제목은 한 번 기억만 해 두고 계속 본다(더 확실한 파일 일치가 있을 수 있다)
    if (!제목맞음 && 같은편인가(껍질벗기기(제목열쇠(u.title), 접두, 접미), 열쇠)) {
      제목맞음 = { why: "title", rec: u };
    }
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

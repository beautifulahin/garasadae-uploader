// 이 영상이 이 채널 것이 맞는가 — 올리기 전에 짚는다. (파이썬: verify.py)
//
// 30개 채널을 돌리다 보면 가장 자주 나는 사고가 **엉뚱한 채널에 올리는 것**이다.
// 한번 올라가면 되돌릴 수 없으니(비공개로 바꿔도 이미 올라간 것은 남는다) 사전에 막는다.
//
// 세 겹으로 본다.
//   1) 파일 이름 규칙   채널마다 정한 머리말로 시작하는가
//   2) 중복 업로드      이미 '업로드완료' 에 같은 이름이 있는가
//   3) 원장 이력        같은 이름이 원장에 있는가(완료 폴더를 옮기거나 지워도 원장은 남는다)
//
// 머리말 규칙은 channels.json 의 prefix 로 정한다. 비워 두면 이름 검사는 건너뛴다.
import { baseName, dirName, exists, isDir, join } from "./paths.ts";
import { uploadedNames } from "./ledger.ts";
import { DONE, expandHome } from "./folders.ts";

/** 검사가 읽는 채널 설정 칸 — 모르는 칸은 그냥 지나간다 */
export interface VerifyConf { prefix?: unknown; folder?: unknown; channel_id?: unknown; [k: string]: unknown }
/** 토큰 저장소를 이 검사가 읽는 만큼만 본 꼴 (ytcore.Store 와 호환) */
export type TokenView = Record<string, { channel_id?: string } | undefined>;
/** 원장에 남은 올린 이력 {파일이름: [올린날, 채널, 영상ID]} (ledger.uploadedNames 의 값) */
export type UploadedMap = Map<string, [string, string, string]>;

const nfc = (s: string) => s.normalize("NFC");

/**
 * (올려도 되는가, 문제 목록)  (파이썬: verify.check_file)
 *
 * 세 번째 인자는 시험·대량 검사를 위한 것이다: 파일마다 원장을 다시 읽으면(수백 편 × 수천 줄) 느려지므로
 * 부르는 쪽이 한 번 읽은 것을 넘길 수 있다. 안 주면 부를 때마다 읽는다(원본과 같다).
 */
export async function checkFile(
  path: string, channelConf: VerifyConf, ledgerNames?: UploadedMap,
): Promise<[boolean, string[]]> {
  const name = baseName(path);
  const problems: string[] = [];

  // 1) 이름 머리말 — 다른 고객 파일이 섞여 들어온 것을 잡는다.
  //    맥은 파일 이름을 풀어쓴 꼴(NFD)로 줄 수 있어, 두 쪽을 같은 꼴(NFC)로 맞춰 견준다
  //    (안 맞추면 멀쩡한 영상이 「검토필요」 폴더로 옮겨진다).
  const prefix = String(channelConf.prefix ?? "").trim();
  if (prefix && !nfc(name).startsWith(nfc(prefix))) {
    problems.push(`파일 이름이 '${prefix}' 로 시작하지 않습니다 — 다른 고객 영상이 섞였는지 확인하세요`);
  }

  // 2) 이미 올린 것과 같은 이름인가 — 완료 폴더
  const done = join(dirName(path), DONE);
  if (await isDir(done) && await exists(join(done, name))) {
    problems.push(`'${DONE}' 에 같은 이름이 있습니다 — 이미 올린 영상입니다`);
  }

  // 3) 원장에 이력이 남아 있는가 (폴더를 옮겨도 잡힌다)
  const map = ledgerNames ?? uploadedNames();
  const hit = map.get(name) ?? map.get(nfc(name)) ?? map.get(name.normalize("NFD"));
  if (hit) {
    const [when, ch, vid] = hit;
    problems.push(`이미 올린 영상입니다 — ${when} [${ch}] https://youtu.be/${vid}`);
  }

  return [problems.length === 0, problems];
}

function isDirSync(p: string): boolean {
  try { return Deno.statSync(p).isDirectory; } catch { return false; }
}

/**
 * 채널 설정 자체가 온전한지. 앱 시작할 때 한 번 본다. (파이썬: verify.check_channel_conf)
 * 원본은 「auth.py 로 인증하세요」라고 말했다 — 새 앱에는 그 파일이 없으니 채널 탭에서 연결하라고 말한다.
 */
export function checkChannelConf(_name: string, conf: VerifyConf, tokens: TokenView): string[] {
  const bad: string[] = [];
  const folder = String(conf.folder ?? "");
  if (!folder) bad.push("폴더가 지정되지 않았습니다");
  else if (!isDirSync(expandHome(folder))) bad.push(`폴더를 찾을 수 없습니다: ${folder}`);

  const cid = String(conf.channel_id ?? "");
  if (!cid) bad.push("channel_id 가 없습니다 — 채널 탭에서 구글 계정을 연결하면 자동으로 채워집니다");
  else if (!Object.values(tokens).some((v) => v?.channel_id === cid)) {
    bad.push(`인증되지 않은 채널입니다 (${cid}) — 채널 탭에서 먼저 연결하세요`);
  }
  return bad;
}

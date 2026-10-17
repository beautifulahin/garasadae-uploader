// 실행 파일 안에만 묶인 구글 로그인 열쇠. (현재 업로더가 한 벌의 client_secret.json · device_secret.json 으로 모든 채널을 잇는 것과 같은 방식)
//
// 지키는 약속
//   · 열쇠 값은 소스·git·문서·시험·로그 어디에도 두지 않는다. 이 파일에는 값이 없다.
//   · build.sh 가 굽는 동안만 build/.client/ 에 복사해 `deno compile --include` 로 실행 파일 안에 묶고, 굽고 나면 지운다.
//     (build/.client/ 와 열쇠 파일 이름은 .gitignore 에 올라 있고, 점검.sh 가 추적되는 파일의 열쇠 모양을 막는다.)
//   · 값을 돌려주기만 하고 출력하지 않는다. 화면에는 「내장 열쇠 있음/없음」 같은 참·거짓만 보인다.
//   · 개발 중 `deno run` 에는 묶인 파일이 없으므로 null 이다 — 그때는 데이터 폴더의 열쇠 파일(옛 방식)만 쓴다.
import { OAUTH_TOKEN } from "./google.ts";

export interface ClientConf {
  client_id: string;
  client_secret: string;
  token_uri?: string;
  /** 실행 파일에 묶여 온 열쇠인가 */
  embedded?: boolean;
}

/** browser = 구글 로그인(데스크톱 유형) · device = 코드 인증(TV 및 입력 제한 기기 유형) */
export type EmbeddedKind = "browser" | "device";

const 파일이름: Record<EmbeddedKind, string> = { browser: "client_secret.json", device: "device_secret.json" };
const 캐시 = new Map<EmbeddedKind, ClientConf | null>();
const 시험값: Partial<Record<EmbeddedKind, ClientConf | null>> = {};

/** 구글이 주는 열쇠 파일 글을 읽는다 (installed · web · 납작한 꼴 모두) */
export function parseClientJson(text: string): ClientConf | null {
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    const c = ((d.installed ?? d.web ?? d) as Record<string, unknown>) ?? {};
    if (!c.client_id) return null;
    return { client_id: String(c.client_id), client_secret: String(c.client_secret ?? ""), token_uri: String(c.token_uri ?? OAUTH_TOKEN) };
  } catch {
    return null;
  }
}

/** 이 실행 파일에 묶인 열쇠. 없으면 null. */
export async function embeddedClient(kind: EmbeddedKind): Promise<ClientConf | null> {
  if (kind in 시험값) {
    const t = 시험값[kind];
    return t ? { ...t, embedded: true } : null;
  }
  if (캐시.has(kind)) return 캐시.get(kind) ?? null;
  let conf: ClientConf | null = null;
  try {
    const text = await Deno.readTextFile(new URL(`../build/.client/${파일이름[kind]}`, import.meta.url));
    const c = parseClientJson(text);
    if (c) conf = { ...c, embedded: true };
  } catch { /* 묶인 파일이 없다 — 개발 실행이거나 열쇠 없이 구운 판 */ }
  캐시.set(kind, conf);
  return conf;
}

/** 화면에 보이는 것은 참·거짓뿐이다 */
export async function embeddedState(): Promise<{ browser: boolean; device: boolean }> {
  return { browser: !!(await embeddedClient("browser")), device: !!(await embeddedClient("device")) };
}

/** 시험이 묶인 열쇠를 가짜로 끼우거나(conf) 없는 것으로(null) 바꾼다. undefined 면 원래대로. */
export function setEmbeddedForTest(kind: EmbeddedKind, conf: ClientConf | null | undefined) {
  if (conf === undefined) delete 시험값[kind];
  else 시험값[kind] = conf;
  캐시.delete(kind);
}

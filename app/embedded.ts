// 실행 파일 안에 묶는 것 — 인스타그램·스레드 연결 정보(meta.json)뿐이다.
//
// ★2.2.0 부터 **구글 로그인 열쇠(client_secret.json · device_secret.json)는 배포 판에 묶지 않는다.**
//   2.0.0 ~ 2.1.0 은 만든 사람의 열쇠를 실행 파일에 묶어, 배포를 받은 모든 사용자가 한 구글 프로젝트의 하루 할당량을 같이 썼다
//   (한 사람이 다 쓰면 모두가 그날 업로드가 막혔다). 이제 사용자가 자기 구글 클라우드 열쇠를 데이터 폴더에 넣어 쓴다.
//   · 여기에는 구글 열쇠를 읽는 코드가 없다 — build/.client/ 에 열쇠가 섞여 들어와도 읽지 않고, build.sh · 점검.sh 가 막는다.
//   · 열쇠 값은 소스·git·문서·시험·로그 어디에도 두지 않는다. 화면에는 「열쇠 있음/없음」 같은 참·거짓만 보인다.

import { OAUTH_TOKEN } from "./google.ts";

/** 구글이 주는 열쇠 파일에서 읽은 값 */
export interface ClientConf {
  client_id: string;
  client_secret: string;
  token_uri?: string;
}

/** browser = 구글 로그인(데스크톱 유형) · device = 코드 인증(TV 및 입력 제한 기기 유형) */
export type KeyKind = "browser" | "device";

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

/* ───────────── 인스타그램·스레드 연결 (메타 앱) ─────────────
 * 앱 번호와 중계 주소는 비밀이 아니다(앱 비밀은 중계 서버에만 있다). 그래도 구글 열쇠와 같은 방식으로 실행 파일에 묶는다 —
 * 값을 소스·문서·시험에 두지 않고, 없으면(개발 실행·묶지 않고 구운 판) 기능이 화면에 나타나지 않는다. */

export interface MetaConf {
  /** 로그인 중계(Cloudflare Worker) 주소 — https 만 (이 컴퓨터의 시험용 주소는 http 도 된다) */
  worker_url: string;
  /** 인스타그램 로그인용 메타 앱 번호 · 스레드용 앱 번호 — 없는 쪽은 그 기능만 숨는다 */
  ig_app_id: string;
  th_app_id: string;
  embedded?: boolean;
}
let 메타캐시: MetaConf | null | undefined;
let 메타시험값: MetaConf | null | undefined;

/** build/.client/meta.json 글을 읽는다. 쓸 수 없는 모양이면 null */
export function parseMetaJson(text: string): MetaConf | null {
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    const url = String(d.worker_url ?? "").trim().replace(/\/+$/, "");
    const ig = String(d.ig_app_id ?? "").trim(), th = String(d.th_app_id ?? "").trim();
    const 안전 = /^https:\/\/[^\s/]+/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url);
    if (!안전 || (!ig && !th)) return null;
    return { worker_url: url, ig_app_id: ig, th_app_id: th };
  } catch { return null; }
}

/** 이 실행 파일에 묶인 메타 연결 정보. 없으면 null — 그때는 인스타·스레드 기능이 화면에 나타나지 않는다. */
export async function embeddedMeta(): Promise<MetaConf | null> {
  if (메타시험값 !== undefined) return 메타시험값 ? { ...메타시험값, embedded: true } : null;
  if (메타캐시 !== undefined) return 메타캐시;
  let conf: MetaConf | null = null;
  try {
    const c = parseMetaJson(await Deno.readTextFile(new URL("../build/.client/meta.json", import.meta.url)));
    if (c) conf = { ...c, embedded: true };
  } catch { /* 묶인 파일이 없다 — 개발 실행이거나 메타 연결 없이 구운 판 */ }
  메타캐시 = conf;
  return conf;
}

/** 시험이 묶인 메타 연결을 가짜로 끼우거나(conf) 없는 것으로(null) 바꾼다. undefined 면 원래대로. */
export function setEmbeddedMetaForTest(conf: MetaConf | null | undefined) {
  메타시험값 = conf;
  메타캐시 = undefined;
}

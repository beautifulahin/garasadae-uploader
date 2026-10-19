// 오류 글에 토큰·코드·비밀이 섞여 나가지 않게 하는 한 곳 — 로그인 중계(worker)와 앱(app/meta.ts)이 같은 것을 쓴다.
// 바깥 의존이 없는 평범한 TypeScript 라서 Cloudflare 번들에도 앱 빌드에도 그대로 들어간다.
//
// 순서가 중요하다: 먼저 가리고 그 다음에 자른다 (자르다가 토큰 앞부분만 남지 않게).
//   1) 이름=값 · "이름":"값" 꼴에서 비밀로 보이는 이름의 값  2) Bearer 뒤의 값  3) 24자 이상 이어진 토큰 모양 글자

/** 값이 비밀일 수 있는 이름들 (code 뒤의 짧은 숫자 — 예: "code":400 — 는 비밀이 아니라 진단 값이라 남긴다) */
const 이름값 = /\b(access_token|refresh_token|client_secret|signed_request|verifier|challenge|authorization|state|code|token|secret|password)\b(["']?\s*[:=]\s*["']?)(?!\d{1,6}(?![\w-]))[^\s"'&,;}\]]+/gi;
const 베어러 = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const 긴토큰 = /[A-Za-z0-9_\-.~+/=]{24,}/g;

/** 오류 글을 한 줄로 만들고, 토큰·코드로 보이는 값을 「…」로 가린 뒤 max 글자로 자른다 */
export function 오류글(s: unknown, max = 120): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
    .replace(이름값, "$1$2…").replace(베어러, "Bearer …").replace(긴토큰, "…");
  return t.slice(0, max);
}

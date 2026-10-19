// 논리 시험 — 앱을 띄우지 않고 규칙만 시험한다. 점검.sh 가 부른다.
//
//   deno run -A --no-lock 논리시험.ts            전부
//   deno run -A --no-lock 논리시험.ts 기초 안전   이름을 준 것만
//   deno run -A --no-lock 논리시험.ts 브라우저     진짜 화면을 헤드리스 크롬으로 (크롬이 없으면 건너뜀 · 이름을 줘야만 돈다)
//
// 구글·유튜브·쿠팡에는 한 번도 닿지 않는다: 가짜 서버(시험/가짜구글.ts · 시험마다 setFetch)와 임시 폴더(시험/도구.ts 모래상자)만 쓴다.
// 진짜 집 폴더·진짜 환경변수·진짜 자동 실행(launchd 등)도 건드리지 않는다 — 시험마다 가짜 집과 가짜 환경을 쓴다.
import { 결과 } from "./시험/도구.ts";

const 모듈들: Record<string, () => Promise<{ 실행: () => Promise<void> }>> = {
  기초: () => import("./시험/기초.ts"),
  안전: () => import("./시험/안전.ts"),
  올리기: () => import("./시험/올리기.ts"),
  심사: () => import("./시험/심사.ts"),
  받기: () => import("./시험/받기.ts"),
  인증: () => import("./시험/인증.ts"),
  문안: () => import("./시험/문안.ts"),
  지표: () => import("./시험/지표.ts"),
  운영: () => import("./시험/운영.ts"),
  하루한도: () => import("./시험/하루한도.ts"),
  계획: () => import("./시험/계획.ts"),
  동기화: () => import("./시험/동기화.ts"),
  설명: () => import("./시험/설명.ts"),
  이식: () => import("./시험/이식.ts"),
  이행안전: () => import("./시험/이행안전.ts"),
  쿠팡: () => import("./시험/쿠팡.ts"),
  열쇠찾기: () => import("./시험/열쇠찾기.ts"),
  화면: () => import("./시험/화면점검.ts"),
  화면약속: () => import("./시험/화면약속.ts"),
  서버: () => import("./시험/서버.ts"),
  메타: () => import("./시험/메타.ts"),
  메타중계: () => import("./시험/메타중계.ts"),
  브라우저: () => import("./시험/브라우저.ts"),   // 크롬이 있어야 한다 — 이름을 줘야만 돈다
};
/** 이름을 주지 않았을 때 건너뛰는 시험(크롬을 띄우는 느린 시험) */
const 따로돎 = new Set(["브라우저"]);

const 고른것 = Deno.args.length ? Deno.args : Object.keys(모듈들).filter((k) => !따로돎.has(k));
for (const 이름 of 고른것) {
  if (!모듈들[이름]) { console.log(`❌ 모르는 시험: ${이름} (있는 것: ${Object.keys(모듈들).join(", ")})`); Deno.exit(2); }
  console.log(`\n══ ${이름} ══`);
  await (await 모듈들[이름]()).실행();
}

console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
if (결과.실패) Deno.exit(1);

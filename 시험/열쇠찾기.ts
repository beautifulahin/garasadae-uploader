// 열쇠 찾기 시험 — 이 컴퓨터의 알려진 자리에서 AI·쿠팡 열쇠를 읽기만 해서 찾고, 가려서 보이고, 시험을 통과한 것만 저장하는지.
//
// 진짜 집 폴더·진짜 환경변수는 한 번도 안 본다: 시험마다 가짜 집(GARASADAE_HOME)과 가짜 환경(setFinderEnv)만 쓴다.
// 구글 AI 스튜디오·쿠팡 서버도 가짜다: AI 는 setAiBackend, 쿠팡은 setFetch. 열쇠는 전부 가짜 값이다.
import { 같나, 결과, 구역, 모래상자, 참인가 } from "./도구.ts";
import { setFetch } from "../app/google.ts";
import { dataDir, dataPath, exists, homeDir, join, readJsonSync, recordPath } from "../app/paths.ts";
import { aiState, setAiBackend } from "../app/ai.ts";
import { appSettings } from "../app/settings.ts";
import * as cp from "../app/coupang.ts";
import { AI_ENV, collectAi, forgetFound, mask, scan, setFinderEnv, useFound } from "../app/finder.ts";

/** 가짜 AI 열쇠 — 「AIza」 뒤 35자. 이름에 GOOD 이 든 것만 서버가 받아 준다 */
const 열쇠 = (이름: string) => ("AIza" + 이름 + "x".repeat(40)).slice(0, 39);
const 좋은 = 열쇠("GOODaaaaaaaaaaaaaaaaaaaaaaaaaaaaAB12");
const 좋은2 = 열쇠("GOODbbbbbbbbbbbbbbbbbbbbbbbbbbbbCD34");
const 나쁜 = 열쇠("BADccccccccccccccccccccccccccccccEF56");

function 가짜AI() {
  const 불린: string[] = [];
  setAiBackend({
    meta: () => Promise.reject(new Error("쓰지 않는다")),
    text: ({ key }) => {
      불린.push(key);
      return key.includes("GOOD") ? Promise.resolve("{}") : Promise.reject(new Error("열쇠가 거절됐습니다 (400)"));
    },
  });
  return 불린;
}

/** 가짜 쿠팡: 아는 접근키 하나만 받아 준다 (서명은 쿠팡 시험이 따로 본다) */
function 가짜쿠팡(접근키: string) {
  const 불린: string[] = [];
  setFetch((input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const m = /access-key=([^,]+),/.exec(new Headers(init?.headers).get("authorization") ?? "");
    불린.push(`${new URL(href).hostname} ${m?.[1] ?? ""}`);
    if (new URL(href).hostname !== "api-gateway.coupang.com") return Promise.reject(new Error("쿠팡 말고 다른 곳으로 나갔다"));
    if (m?.[1] !== 접근키) return Promise.resolve(new Response(JSON.stringify({ code: "ERROR", message: "Invalid signature or access key" }), { status: 401 }));
    return Promise.resolve(new Response(JSON.stringify({
      rCode: "0", rMessage: "", data: { productData: [{ productId: 1, productName: "가짜 상품", productPrice: 1000, productUrl: "https://link.coupang.com/re/AFFSDP?x=1" }], landingUrl: "https://link.coupang.com/re/AFFSDP" },
    }), { status: 200 }));
  });
  return 불린;
}

const 쓰기 = async (rel: string, text: string) => {
  const p = join(homeDir(), ...rel.split("/"));
  await Deno.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(p, text);
  return p;
};
const 훑기 = async () => {
  const o: Record<string, string> = {};
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) await walk(p); else if (e.isFile) o[p] = await Deno.readTextFile(p).catch(() => "");
    }
  };
  await walk(homeDir());
  return o;
};
const 환경없음 = () => setFinderEnv(() => undefined);

async function 자리별() {
  구역("AI 열쇠 찾기 — 자리마다 (가짜 집에서 한 자리씩만 채우고 읽는다)");
  const 경우: { 이름: string; 채우기: () => Promise<void>; 자리: string }[] = [
    { 이름: "환경변수 GEMINI_API_KEY", 채우기: async () => setFinderEnv((k) => (k === "GEMINI_API_KEY" ? 좋은 : undefined)), 자리: "환경변수 GEMINI_API_KEY" },
    { 이름: "환경변수 GOOGLE_API_KEY", 채우기: async () => setFinderEnv((k) => (k === "GOOGLE_API_KEY" ? 좋은 : undefined)), 자리: "환경변수 GOOGLE_API_KEY" },
    { 이름: "환경변수 GOOGLE_GENAI_API_KEY", 채우기: async () => setFinderEnv((k) => (k === "GOOGLE_GENAI_API_KEY" ? 좋은 : undefined)), 자리: "환경변수 GOOGLE_GENAI_API_KEY" },
    { 이름: "~/.volcano/keys/gemini (열쇠만 한 줄)", 채우기: async () => { await 쓰기(".volcano/keys/gemini", 좋은 + "\n"); }, 자리: "~/.volcano/keys/gemini" },
    { 이름: "~/.volcano/keys/gemini.pool.json (여러 개)", 채우기: async () => { await 쓰기(".volcano/keys/gemini.pool.json", JSON.stringify({ keys: [좋은, 나쁜] })); }, 자리: "~/.volcano/keys/gemini.pool.json" },
    { 이름: "~/.gemini/.env", 채우기: async () => { await 쓰기(".gemini/.env", `# 설정\nGEMINI_API_KEY=${좋은}\n`); }, 자리: "~/.gemini/.env" },
    { 이름: "~/.gemini/settings.json", 채우기: async () => { await 쓰기(".gemini/settings.json", JSON.stringify({ security: { auth: { apiKey: 좋은 } } })); }, 자리: "~/.gemini/settings.json" },
    { 이름: "~/.zshrc (export · 큰따옴표)", 채우기: async () => { await 쓰기(".zshrc", `alias ll='ls -l'\nexport GOOGLE_API_KEY="${좋은}"\n`); }, 자리: "~/.zshrc (GOOGLE_API_KEY)" },
    { 이름: "~/.bash_profile (export · 따옴표 없음)", 채우기: async () => { await 쓰기(".bash_profile", `export GEMINI_API_KEY=${좋은}\n`); }, 자리: "~/.bash_profile (GEMINI_API_KEY)" },
    { 이름: "~/.env", 채우기: async () => { await 쓰기(".env", `GEMINI_API_KEY='${좋은}'\n`); }, 자리: "~/.env (GEMINI_API_KEY)" },
    { 이름: "~/.config/fish/config.fish (set -gx)", 채우기: async () => { await 쓰기(".config/fish/config.fish", `set -gx GEMINI_API_KEY ${좋은}\n`); }, 자리: "~/.config/fish/config.fish (GEMINI_API_KEY)" },
    { 이름: "윈도우 파워셸 프로필 ($env:)", 채우기: async () => { await 쓰기("Documents/PowerShell/Microsoft.PowerShell_profile.ps1", `$env:GEMINI_API_KEY = "${좋은}"\n`); }, 자리: "~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1 (GEMINI_API_KEY)" },
    { 이름: "옛 판 설정(config.json)의 aiKey", 채우기: async () => { await Deno.writeTextFile(join(dataDir(), "config.json"), JSON.stringify({ schema: 2, aiKey: 좋은, channels: [] })); }, 자리: "옛 판 설정(config.json)의 aiKey" },
  ];
  for (const c of 경우) {
    await 모래상자(async () => {
      환경없음();
      await c.채우기();
      const 앞 = await 훑기();
      const 불린 = 가짜AI();
      const r = await scan({ kind: "ai", coupang: null });
      같나(`[${c.이름}] 찾았다 — 하나, 자리 이름이 맞다`, [r.ai.length >= 1, r.ai[0]?.where.includes(c.자리)], [true, true]);
      같나(`[${c.이름}] 가려서 보인다 (앞 4자 … 끝 4자)`, r.ai[0]?.masked, mask(좋은));
      참인가(`[${c.이름}] 찾은 열쇠를 공식 주소로 시험했다 — 통과 표시`, r.ai[0]?.test?.ok === true && 불린.includes(좋은));
      같나(`[${c.이름}] 응답에 열쇠 전체 값이 없다`, JSON.stringify(r).includes(좋은), false);
      같나(`[${c.이름}] 읽기만 했다 — 집 폴더가 한 글자도 안 바뀌었다`, await 훑기(), 앞);
      setAiBackend(null); forgetFound();
    });
  }
  setFinderEnv(null);
}

async function 가림과저장() {
  구역("AI 열쇠 찾기 — 같은 열쇠는 한 줄로 · 시험 통과한 것이 앞 · 통과한 것만 저장 · 값이 안 샌다");
  await 모래상자(async () => {
    setFinderEnv((k) => (k === "GEMINI_API_KEY" ? 좋은 : undefined));
    await 쓰기(".zshrc", `export GOOGLE_API_KEY="${나쁜}"\nexport GEMINI_API_KEY="${좋은}"\n# export GEMINI_API_KEY="${좋은2}"\n`);
    await 쓰기(".volcano/keys/gemini.pool.json", JSON.stringify([좋은2]));
    await 쓰기(".bashrc", `export OPENAI_API_KEY=sk-1234567890\nexport GEMINI_API_KEY=AIzaShort\n`);
    const 앞 = await 훑기();
    가짜AI();
    const r = await scan({ kind: "ai", coupang: null });
    같나("같은 열쇠(환경변수 + .zshrc)는 한 줄로 합치고 자리를 모았다", r.ai.find((x) => x.masked === mask(좋은))?.where.sort(), ["~/.zshrc (GEMINI_API_KEY)", "환경변수 GEMINI_API_KEY"]);
    같나("주석 처리된 줄·남의 열쇠·짧은 글자는 안 가져온다 (찾은 것은 좋은·나쁜·풀 속 좋은2 셋)", r.ai.map((x) => x.masked).sort(), [mask(좋은), mask(좋은2), mask(나쁜)].sort());
    같나("시험 통과한 것이 앞에, 거절된 것이 뒤에", r.ai.map((x) => x.test?.ok), [true, true, false]);
    같나("거절된 열쇠에는 까닭이 있다", r.ai.at(-1)?.test?.message.includes("거절"), true);
    const 글 = JSON.stringify(r) + (await Deno.readTextFile(recordPath("서버.log")).catch(() => ""));
    같나("응답과 서버.log 어디에도 열쇠 전체 값이 없다", [좋은, 좋은2, 나쁜].filter((k) => 글.includes(k)), []);
    같나("읽기만 했다 (집 폴더 그대로)", await 훑기(), 앞);
    같나("아무것도 저장하지 않았다 — 찾기만으로는 열쇠가 설정에 들어가지 않는다", [appSettings().aiKey, aiState().connected, appSettings().aiPrompted], ["", false, false]);

    // 거절된 열쇠를 「이걸로 쓰기」 → 저장 안 됨
    const 나쁜줄 = r.ai.find((x) => x.test?.ok === false)!;
    const u0 = await useFound("ai", 나쁜줄.id);
    같나("시험에 떨어진 열쇠는 「이걸로 쓰기」를 눌러도 저장하지 않는다", [u0.ok, appSettings().aiKey], [false, ""]);

    // 통과한 열쇠 → 저장 + 자동 문안 켜짐 + 입력 창을 봤다고 기록
    const 좋은줄 = r.ai.find((x) => x.masked === mask(좋은))!;
    const u1 = await useFound("ai", 좋은줄.id);
    같나("통과한 열쇠는 한 번 눌러 저장된다 — 연결됨 · 자동 문안 켜짐 · 입력 창 기록", [u1.ok, aiState().connected, aiState().enabled, appSettings().aiKey === 좋은, appSettings().aiPrompted], [true, true, true, true, true]);
    같나("저장 결과 글에도 열쇠가 없다", JSON.stringify(u1).includes(좋은), false);
    같나("열쇠가 든 설정 파일은 권한 600 (맥·리눅스)", Deno.build.os === "windows" ? 0o600 : (await Deno.stat(dataPath("앱설정.json"))).mode! & 0o777, 0o600);
    const u2 = await useFound("ai", 좋은줄.id);
    같나("한 번 쓴 id 는 없어진다 (다시 쓰려면 다시 찾는다)", [u2.ok, u2.message.includes("다시 찾기")], [false, true]);

    // 15분이 지나면 id 가 사라진다
    const r2 = await scan({ kind: "ai", coupang: null, test: false });
    const 앞시계 = Date.now;
    Date.now = () => 앞시계() + 16 * 60_000;
    try {
      const u3 = await useFound("ai", r2.ai[0].id);
      같나("찾은 지 15분이 지나면 id 가 만료된다 (전체 값은 메모리에 15분만)", [u3.ok, u3.message.includes("15분")], [false, true]);
    } finally { Date.now = 앞시계; }
    setAiBackend(null); setFinderEnv(null); forgetFound();
  });

  구역("AI 열쇠 찾기 — 아무것도 없으면 빈 목록 (입력칸은 빈 채로, 안내만)");
  await 모래상자(async () => {
    환경없음(); 가짜AI();
    const r = await scan({ kind: "ai", coupang: null });
    같나("빈 목록", [r.ai.length, r.coupang.length], [0, 0]);
    같나("collectAi 도 빈 목록", (await collectAi()).length, 0);
    setAiBackend(null); setFinderEnv(null);
  });

  구역("AI 열쇠 찾기 — 환경변수 이름 목록은 한 곳에 있다");
  같나("자리 목록(AI_ENV)에 흔한 이름들이 있다", ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"].every((n) => AI_ENV.includes(n)), true);
}

async function 쿠팡찾기() {
  구역("쿠팡 열쇠 찾기 — 자리마다 · 접근키만 보이고 비밀키는 안 보인다 · 통과한 것만 저장");
  const 접근 = "TESTACCESSKEY0001", 비밀 = "TESTSECRETKEYTESTSECRETKEY0001";
  const 접근나 = "TESTACCESSKEY0002", 비밀나 = "TESTSECRETKEYTESTSECRETKEY0002";
  const 경우: { 이름: string; 채우기: () => Promise<void>; 자리: string }[] = [
    { 이름: "~/.volcano/keys/coupang_partners (ACCESS:SECRET)", 채우기: async () => { await 쓰기(".volcano/keys/coupang_partners", `${접근}:${비밀}\n`); }, 자리: "~/.volcano/keys/coupang_partners" },
    { 이름: "환경변수 COUPANG_ACCESS_KEY + COUPANG_SECRET_KEY", 채우기: async () => setFinderEnv((k) => ({ COUPANG_ACCESS_KEY: 접근, COUPANG_SECRET_KEY: 비밀 } as Record<string, string>)[k]), 자리: "환경변수 COUPANG_ACCESS_KEY·COUPANG_SECRET_KEY" },
    { 이름: "~/.zshrc 에 두 줄", 채우기: async () => { await 쓰기(".zshrc", `export COUPANG_ACCESS_KEY="${접근}"\nexport COUPANG_SECRET_KEY="${비밀}"\n`); }, 자리: "~/.zshrc" },
  ];
  for (const c of 경우) {
    await 모래상자(async () => {
      환경없음();
      await c.채우기();
      const 앞 = await 훑기();
      const 불린 = 가짜쿠팡(접근);
      const r = await scan({ kind: "coupang", coupang: cp });
      같나(`[${c.이름}] 찾았다 — 하나, 자리가 맞다, 시험 통과`, [r.coupang.length, r.coupang[0]?.where.includes(c.자리), r.coupang[0]?.test?.ok], [1, true, true]);
      같나(`[${c.이름}] 가려서 보인다 · 비밀키가 있다는 말만`, r.coupang[0]?.masked, `${mask(접근)} · 비밀키 있음`);
      같나(`[${c.이름}] 응답에 접근키·비밀키 전체 값이 없다`, [접근, 비밀].filter((k) => JSON.stringify(r).includes(k)), []);
      참인가(`[${c.이름}] 쿠팡 공식 주소로만 시험했다`, 불린.length === 1 && 불린[0].startsWith("api-gateway.coupang.com"));
      같나(`[${c.이름}] 읽기만 했다`, await 훑기(), 앞);
      같나(`[${c.이름}] 찾기만으로는 저장하지 않았다`, [cp.hasKeys(), cp.loadSettings().enabled], [false, false]);
      const u = await useFound("coupang", r.coupang[0].id, { coupang: cp });
      같나(`[${c.이름}] 「이걸로 쓰기」 한 번으로 저장 + 자동 링크 켜짐`, [u.ok, cp.hasKeys(), cp.loadSettings().enabled, cp.loadSettings().connected], [true, true, true, true]);
      같나(`[${c.이름}] 저장 결과 글에도 값이 없다`, [접근, 비밀].filter((k) => JSON.stringify(u).includes(k)), []);
      setFetch(null); setFinderEnv(null); forgetFound();
    });
  }

  await 모래상자(async () => {
    환경없음();
    await 쓰기(".volcano/keys/coupang_partners", `${접근나}:${비밀나}\n`);
    가짜쿠팡(접근);
    const r = await scan({ kind: "coupang", coupang: cp });
    같나("시험에 떨어진 쌍은 목록엔 보이되 통과 표시가 없다", [r.coupang.length, r.coupang[0]?.test?.ok], [1, false]);
    const u = await useFound("coupang", r.coupang[0].id, { coupang: cp });
    같나("떨어진 쌍은 「이걸로 쓰기」를 눌러도 저장하지 않는다", [u.ok, cp.hasKeys()], [false, false]);
    setFetch(null); setFinderEnv(null); forgetFound();
  });
  await 모래상자(async () => {
    환경없음();
    const r = await scan({ kind: "coupang", coupang: cp });
    같나("아무것도 없으면 빈 목록", r.coupang.length, 0);
    setFinderEnv(null);
  });
}

async function 둘다() {
  구역("열쇠 찾기 — 한 번에 AI·쿠팡 둘 다 (kind 를 안 주면)");
  await 모래상자(async () => {
    setFinderEnv((k) => (k === "GEMINI_API_KEY" ? 좋은 : undefined));
    await 쓰기(".volcano/keys/coupang_partners", "TESTACCESSKEY0001:TESTSECRETKEYTESTSECRETKEY0001\n");
    가짜AI(); 가짜쿠팡("TESTACCESSKEY0001");
    const r = await scan({ coupang: cp });
    같나("둘 다 찾았다", [r.ai.length, r.coupang.length, r.ai[0].test?.ok, r.coupang[0].test?.ok], [1, 1, true, true]);
    같나("걸린 시간(tookMs)이 숫자로 온다", typeof r.tookMs === "number", true);
    같나("서버.log 에는 개수만 남고 값은 없다", (await Deno.readTextFile(recordPath("서버.log"))).includes("열쇠 찾기: AI 1개(통과 1) · 쿠팡 1개(통과 1)"), true);
    같나("파일이 없던 자리를 만들지 않았다 (집 폴더에는 우리가 둔 두 파일 구조뿐)", await exists(join(homeDir(), ".gemini")), false);
    setAiBackend(null); setFetch(null); setFinderEnv(null); forgetFound();
  });
}

export async function 실행() {
  await 자리별();
  await 가림과저장();
  await 쿠팡찾기();
  await 둘다();
}

if (import.meta.main) {
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

void readJsonSync;

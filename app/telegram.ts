// 막힌 일을 텔레그램으로 알린다 (개인판).
//
// 왜 있나 (사용자 지시 2026-08-22)
//   업로더는 사람 없이 혼자 돈다. 그런데 막혔다는 소식은 **맥 알림** 하나뿐이라,
//   자리를 비운 사이에 로그인이 풀리거나(🔑) 중복으로 세워지거나(🛑) 열 번 실패해
//   치워져도(⏸) 아무도 모른다. 돌아와 보면 몇 시간이 비어 있다.
//
// 어떻게 되나
//   `notify()` 가 부를 때 같이 나간다. **잘 된 일(✅)은 안 보낸다** — 하루 몇 편씩
//   올라가는데 그때마다 울리면 정작 급한 것을 놓친다.
//
// 열쇠는 어디서 오나
//   ① 환경변수 `TELEGRAM_TOKEN` · `TELEGRAM_CHAT_ID`
//   ② 없으면 `~/.volcano/env` 에서 읽는다 (개인판이 쓰는 자리. 없으면 그냥 안 보낸다)
//   ★열쇠가 없으면 조용히 아무 일도 안 한다. 공개판에서 이 파일은 늘 잠들어 있다.

import { join } from "./paths.ts";

interface 열쇠 {
  token: string;
  chat: string;
}
let 캐시: 열쇠 | null | undefined;          // undefined = 아직 안 찾아봄, null = 없음

function 홈(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
}

/** `export NAME=값` 꼴에서 값만 뽑는다. 따옴표는 털어 낸다. */
function 값뽑기(글: string, 이름: string): string {
  for (const 줄 of 글.split("\n")) {
    const m = 줄.match(new RegExp(`^\\s*(?:export\\s+)?${이름}\\s*=\\s*(.+)$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "").split(",")[0].trim();
  }
  return "";
}

async function 열쇠찾기(): Promise<열쇠 | null> {
  if (캐시 !== undefined) return 캐시;
  let token = Deno.env.get("TELEGRAM_TOKEN") ?? "";
  let chat = (Deno.env.get("TELEGRAM_CHAT_ID") ?? "").split(",")[0].trim();
  if (!token || !chat) {
    try {
      const 글 = await Deno.readTextFile(join(홈(), ".volcano", "env"));
      token ||= 값뽑기(글, "TELEGRAM_TOKEN");
      chat ||= 값뽑기(글, "TELEGRAM_CHAT_ID");
    } catch { /* 파일이 없으면 그만이다 */ }
  }
  캐시 = token && chat ? { token, chat } : null;
  return 캐시;
}

/** 열쇠가 있나 — 화면에서 "켤 수 있는 상태인지" 보이는 데 쓴다. */
export async function 텔레그램쓸수있나(): Promise<boolean> {
  return (await 열쇠찾기()) !== null;
}

/**
 * 한 줄 보낸다. 실패해도 **던지지 않는다** — 알림 때문에 업로드가 멈추면 안 된다.
 * @returns 보냈으면 true
 */
export async function 텔레그램(text: string): Promise<boolean> {
  const k = await 열쇠찾기();
  if (!k) return false;
  try {
    const body = new URLSearchParams({ chat_id: k.chat, text: text.slice(0, 3500) });
    const r = await fetch(`https://api.telegram.org/bot${k.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

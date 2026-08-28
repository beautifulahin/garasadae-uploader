// 영상을 보고 제목·설명·태그를 지어 준다 (선택 기능).
//
// 사용자 지시(2026-08-28)
//   "내가 올리면 제목·설명이 달리듯이 다른 사람도 달 수 있게 해라."
//
// 왜 이런 꼴인가 — **열쇠는 각자 넣는다**
//   만든 사람의 열쇠를 프로그램에 박으면 두 가지가 망가진다. ① 배포 파일에서
//   그대로 뽑아낼 수 있고 ② 남이 쓴 요금을 만든 사람이 낸다.
//   구글 클라이언트 ID·비밀번호를 각자 발급받아 자기 컴퓨터에만 두는 지금 방식과
//   똑같이, AI 열쇠도 각자 넣는다. 무료 등급으로 돈다.
//
// 어떻게 하나
//   ① 영상을 구글 AI 스튜디오(File API)에 올린다
//   ② 다 읽을 때까지 기다린다 (ACTIVE)
//   ③ 제목·설명·태그를 JSON 으로 받는다 (responseSchema 로 꼴을 못 박는다)
//   ④ **올린 영상을 지운다** — 남의 서버에 남겨 두지 않는다
//   실측(2026-08-28, 45~51MB 쇼츠): 올리기 8초 · 읽기 10초 · 짓기 6초 = 25초 안팎.
//
// ★실패해도 **업로드를 막지 않는다.** 못 지으면 지금까지처럼 파일 이름이 제목이 된다.
// ★쪽지(sidecar)나 사람이 화면에서 고친 제목이 있으면 부르지도 않는다 — 그쪽이 이긴다.

import { log } from "./paths.ts";

const 파일API = "https://generativelanguage.googleapis.com";
export const 기본모델 = "gemini-3.5-flash-lite";   // 실측 24초. flash 는 29초로 조금 낫다
/** 이보다 큰 영상은 건너뛴다 — 올리는 데만 한참 걸리고 무료 등급도 버겁다. */
const 너무큼 = 300 * 1024 * 1024;

export interface 지은것 {
  title: string;
  description: string;
  tags: string[];
}

export interface 밑감 {
  키: string;
  모델?: string;
  /** 채널 이름·기본 설명 — 말투를 그 채널에 맞추라고 알려 준다 */
  채널?: string;
  안내?: string;
}

async function 보내고받기(req: Request, 이름: string): Promise<Response> {
  // 503(붐빔)·429(한도)·5xx 는 잠깐 쉬었다 다시 — 실측에서 503 이 실제로 났다
  let 마지막 = "";
  for (let i = 0; i < 3; i++) {
    const r = await fetch(req.clone());
    if (r.ok) return r;
    마지막 = `${r.status} ${(await r.text()).slice(0, 200)}`;
    if (r.status !== 429 && r.status !== 503 && r.status < 500) break;
    await new Promise((s) => setTimeout(s, 4000 * (i + 1)));
  }
  throw new Error(`${이름}: ${마지막}`);
}

/** 영상을 올리고 파일 이름·주소를 돌려준다. */
async function 올리기(경로: string, 키: string): Promise<{ 이름: string; 주소: string }> {
  const 크기 = (await Deno.stat(경로)).size;
  const 시작 = await 보내고받기(
    new Request(`${파일API}/upload/v1beta/files?key=${키}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(크기),
        "X-Goog-Upload-Header-Content-Type": "video/mp4",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "upload" } }),
    }), "올릴 자리 받기");
  const 올릴곳 = 시작.headers.get("X-Goog-Upload-URL");
  await 시작.body?.cancel();
  if (!올릴곳) throw new Error("올릴 자리를 받지 못했습니다.");

  const f = await Deno.open(경로, { read: true });
  const r = await fetch(올릴곳, {
    method: "POST",
    headers: {
      "Content-Length": String(크기),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: f.readable,
  });
  if (!r.ok) throw new Error(`영상 올리기: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { 이름: j.file.name, 주소: j.file.uri };
}

/** 다 읽을 때까지 기다린다. 너무 오래 걸리면 포기한다. */
async function 읽힐때까지(이름: string, 키: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${파일API}/v1beta/${이름}?key=${키}`);
    if (!r.ok) { await r.body?.cancel(); throw new Error(`영상 상태: ${r.status}`); }
    const j = await r.json();
    if (j.state === "ACTIVE") return;
    if (j.state === "FAILED") throw new Error("구글이 이 영상을 읽지 못했습니다.");
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("영상을 읽는 데 2분이 넘게 걸려 그만두었습니다.");
}

async function 지우기(이름: string, 키: string): Promise<void> {
  try {
    const r = await fetch(`${파일API}/v1beta/${이름}?key=${키}`, { method: "DELETE" });
    await r.body?.cancel();
  } catch { /* 못 지워도 구글이 48시간 뒤 스스로 지운다 */ }
}

function 지시글(밑: 밑감): string {
  const 결 = 밑.채널 ? `\n이 영상은 「${밑.채널}」 채널에 올라간다.` : "";
  const 참고 = 밑.안내?.trim() ? `\n채널이 늘 쓰는 설명(말투 참고용):\n${밑.안내.slice(0, 500)}` : "";
  return "이 영상을 보고 유튜브에 올릴 제목·설명·태그를 한국어로 지어라." + 결 + 참고 + `
- title: 100자 이내. 영상에 **실제로 나온 내용**만. 없는 말을 지어내지 마라.
- description: 3~5줄로 무슨 내용인지 적고, 맨 끝 줄에 해시태그 5개.
- tags: 검색어 5~8개.`;
}

/**
 * 영상을 보고 제목·설명·태그를 짓는다. 못 지으면 null (업로드는 그대로 간다).
 */
export async function 메타지어보기(경로: string, 밑: 밑감): Promise<지은것 | null> {
  if (!밑.키) return null;
  let 올린것: { 이름: string; 주소: string } | null = null;
  const t0 = Date.now();
  try {
    const 크기 = (await Deno.stat(경로)).size;
    if (크기 > 너무큼) {
      await log(`   🤖 영상이 커서(${(크기 / 1048576).toFixed(0)}MB) 자동 제목은 건너뜁니다`);
      return null;
    }
    올린것 = await 올리기(경로, 밑.키);
    await 읽힐때까지(올린것.이름, 밑.키);

    const 모델 = 밑.모델 || 기본모델;
    const r = await 보내고받기(
      new Request(`${파일API}/v1beta/models/${모델}:generateContent?key=${밑.키}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { file_data: { mime_type: "video/mp4", file_uri: 올린것.주소 } },
              { text: 지시글(밑) },
            ],
          }],
          generationConfig: {
            responseMimeType: "application/json",
            // ★꼴을 못 박지 않으면 tags 가 빈 배열로 온다 (실측 2026-08-28)
            responseSchema: {
              type: "OBJECT",
              properties: {
                title: { type: "STRING" },
                description: { type: "STRING" },
                tags: { type: "ARRAY", items: { type: "STRING" }, minItems: 5, maxItems: 8 },
              },
              required: ["title", "description", "tags"],
            },
          },
        }),
      }), "제목 짓기");

    const j = await r.json();
    const 글 = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const o = JSON.parse(글);
    const 지음: 지은것 = {
      title: String(o.title ?? "").trim().slice(0, 100),
      description: String(o.description ?? "").trim().slice(0, 5000),
      tags: Array.isArray(o.tags)
        ? o.tags.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 8)
        : [],
    };
    if (!지음.title) return null;
    await log(`   🤖 제목을 지었습니다 (${((Date.now() - t0) / 1000).toFixed(0)}초): ${지음.title}`);
    return 지음;
  } catch (e) {
    // ★조용히 넘어간다. 제목을 못 지었다고 영상이 안 올라가면 안 된다.
    await log(`   ⚠️  자동 제목을 짓지 못해 파일 이름을 씁니다 — ${e instanceof Error ? e.message : e}`);
    return null;
  } finally {
    if (올린것) await 지우기(올린것.이름, 밑.키);
  }
}

/** 설정 화면의 「시험해 보기」 — 열쇠가 살아 있는지만 가볍게 본다. */
export async function 열쇠확인(키: string, 모델?: string): Promise<{ ok: boolean; message: string }> {
  if (!키.trim()) return { ok: false, message: "열쇠를 넣어 주세요." };
  try {
    const r = await fetch(`${파일API}/v1beta/models/${모델 || 기본모델}:generateContent?key=${키.trim()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "안녕이라고만 답해라." }] }] }),
    });
    const 글 = await r.text();
    if (r.ok) return { ok: true, message: "열쇠가 정상입니다. 이제 영상마다 제목·설명이 지어집니다." };
    if (r.status === 400 || r.status === 403) {
      return { ok: false, message: "열쇠가 잘못되었거나 권한이 없습니다. 다시 확인해 주세요." };
    }
    return { ok: false, message: `구글이 거절했습니다 (${r.status}). ${글.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, message: `연결하지 못했습니다 — ${e instanceof Error ? e.message : e}` };
  }
}

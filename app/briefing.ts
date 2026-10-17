// 브리핑 — 문제가 생기면 앱이 스스로 설명한다.  (파이썬: 브리핑.py)
//
// 왜 필요한가
//   기록에는 `실패   [채널] 파일 오류글…` 같은 줄이 남는다. 그건 개발자가 읽는 말이지 사람이 읽는 말이 아니다.
//   무엇이 잘못됐는지, 왜 그런지, 무엇을 하면 되는지가 안 적혀 있다. 이 파일은 그 줄들을 읽어 **네 가지**로 다시 쓴다.
//     무슨 일   한 줄로
//     왜        그렇게 된 까닭
//     뜻        지금 무엇이 어떻게 된 상태인가 (특히 고객 채널에 영향이 갔나)
//     할 일     사람이 무엇을 하면 되는가
//   화면은 이것을 팝업으로 띄운다. 한 번 확인한 것은 다시 안 뜬다(화면이 id 로 기억한다).
//
// 무엇을 읽나
//   기록/올리기.log      업로드 실패 · 발사 실패/무산 · 사람확인필요
//   기록/서버.log        서버가 죽은 자리 — 「[예외]」로 시작하는 줄(파이썬의 Traceback 에 해당)
//   pending.json         확인해도 심사가 안 끝난 것(사람확인)
//   채널 폴더            못 읽는 폴더가 있으면 화면이 옛 값을 보여 주고 있다는 뜻
//
// 무엇을 띄우고 무엇을 안 띄우나
//   띄운다 — 사람이 **손을 대야** 끝나는 일: 영상이 안 올라갔다 · 심사가 안 끝났다 · 앱 서버가 죽었다 · 인증이 풀렸다 · 할당량이 떨어졌다
//   안 띄운다 — 앱이 스스로 처리했거나 그냥 알림인 것: 안전장치가 막았다(제 일을 한 것이다) · 곁 파일이 안 따라갔다(영상은 멀쩡하다)
//               · 썸네일이 안 붙었지만 자동으로 다시 시도 중이다 · 정상 업로드
//   ★이 선을 넘기지 마라. 자잘한 것까지 띄우면 사람이 팝업을 닫는 버릇이 들고, 정작 고객 채널에 문제가 생긴 날 그 팝업도 그냥 닫힌다.
import { cut, dataPath, readJson, recordLine, recordPath, tailFile } from "./paths.ts";
import { addHours, isoWall, parseWall, wallNow } from "./clock.ts";
import type { Wall } from "./clock.ts";
import { loadChannels } from "./channels.ts";

export const 볼시간 = 48; // 이보다 오래된 것은 안 띄운다(시간)
export const 최대 = 5; // 한 번에 이만큼까지만
const 띄울급 = ["큰일", "살펴봄"];

export type BriefLevel = "큰일" | "살펴봄" | "알림";

/** 팝업 한 건. 칸 이름은 화면이 그대로 읽는다(파이썬 브리핑과 같은 이름). */
export interface Brief {
  /** 같은 일을 두 번 띄우지 않도록 원문에서 만든 짧은 이름 */
  id: string;
  /** "10-19 09:00" */
  때: string;
  급: BriefLevel;
  무슨일: string;
  왜: string;
  뜻: string;
  할일: string;
  원문: string;
}
interface Raw extends Brief { 순간: number }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 기록은 한 줄에 한 건이다 — 오류 글에 줄바꿈이 있으면 「 ⏎ 」로 바꾼다 (paths.ts 의 log() 와 같은 약속. recordLine 은 그대로 적는다) */
const 기록 = (파일: string, 줄: string) => recordLine(파일, 줄.replace(/\s*\r?\n\s*/g, " ⏎ "));

/** 같은 점검 실패를 화면이 몇 초마다 부를 때마다 적으면 기록이 그 줄로 가득 찬다 — 말이 바뀔 때만 적는다 */
const 적은말 = new Set<string>();
async function 한번만(말: string) {
  if (적은말.has(말)) return;
  if (적은말.size > 50) 적은말.clear();
  적은말.add(말);
  await 기록("서버.log", `브리핑: ${말}`);
}

async function 딱지(x: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(x));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

async function 꾸리기(t: Wall, 급: BriefLevel, 무슨일: string, 왜: string, 뜻: string, 할일: string, 원문 = ""): Promise<Raw> {
  return {
    id: await 딱지(원문 || 무슨일),
    때: isoWall(t).slice(5, 16).replace("T", " "),
    급, 무슨일, 왜, 뜻, 할일,
    원문: cut(원문, 300),
    순간: t.getTime(),
  };
}

const 줄머리 = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

/** 기록 파일의 뒤쪽 줄 중 볼시간 안에 든 것 (시각이 없는 줄은 버린다) */
async function 최근줄(파일: string, now: Wall, n = 300): Promise<{ t: Wall; x: string }[]> {
  const 자를때 = addHours(now, -볼시간).getTime();
  const out: { t: Wall; x: string }[] = [];
  for (const x of await tailFile(recordPath(파일), n, 1024 * 1024)) {
    const m = 줄머리.exec(x);
    const t = m ? parseWall(m[1]) : null;
    if (t && t.getTime() >= 자를때) out.push({ t, x });
  }
  return out;
}

/** 줄의 「맨 앞 낱말」 — 시각과 두 칸을 뗀 뒤 첫 덩어리. 기록 줄은 `낱말 [채널] 내용` 꼴이다. */
function 낱말(x: string): string {
  return (x.replace(줄머리, "").trimStart().split(/\s+/, 1)[0] ?? "");
}

/** 오류 문구를 보고 까닭과 할 일을 사람 말로. (파이썬 _업로드실패까닭) */
export function explainUploadFailure(원문: string): { 왜: string; 할일: string } {
  const t = 원문.toLowerCase();
  if (t.includes("quota") || t.includes("할당량")) {
    return { 왜: "오늘 쓸 수 있는 유튜브 할당량을 다 썼습니다.", 할일: "한국 시간 오후 4~5시(태평양 자정)에 초기화됩니다. 그 뒤 다시 올려 주세요." };
  }
  if (t.includes("invalid_grant") || t.includes("invalid_scope") || t.includes("unauthorized") || t.includes("401") ||
    원문.includes("인증이 만료") || 원문.includes("로그인이 풀")) {
    return { 왜: "이 채널의 인증이 풀렸습니다.", 할일: "설정 화면에서 그 채널을 코드 인증으로 다시 연결해 주세요." };
  }
  if (t.includes("403")) {
    return { 왜: "유튜브가 권한을 거부했습니다. 채널 권한이나 범위 문제일 수 있습니다.", 할일: "그 채널의 인증을 다시 받아 보시고, 그래도 안 되면 알려 주세요." };
  }
  if (t.includes("connection") || t.includes("timeout") || t.includes("ssl") || t.includes("incompleteread") ||
    원문.includes("네트워크") || 원문.includes("연결 끊김") || 원문.includes("응답하지 않")) {
    return {
      왜: "전송 중 연결이 끊겼습니다.",
      할일: "회선 상태를 보시고 다시 올려 주세요. 이어올리기가 붙어 있어 대개는 저절로 다시 붙습니다.",
    };
  }
  if (원문.includes("쇼츠 조건")) {
    return { 왜: "세로 9:16·3분 이내가 아니어서 쇼츠로 올리지 않았습니다.", 할일: "롱폼이면 롱폼 폴더에 넣으세요. 쇼츠로 낼 것이면 영상을 고쳐 주세요." };
  }
  if (원문.includes("파일이 없습니다") || t.includes("not found")) {
    return { 왜: "올리려던 파일을 찾지 못했습니다.", 할일: "파일이 옮겨졌거나 지워졌는지 확인해 주세요." };
  }
  return { 왜: cut(원문, 160) || "까닭을 읽지 못했습니다.", 할일: "다시 시도해 보시고, 되풀이되면 이 내용을 알려 주세요." };
}

/**
 * 지금 띄울 브리핑을 모은다 — 최근 것부터 같은 일은 하나만, 최대 5건. (파이썬 모으기)
 * 어느 점검이 실패해도 나머지는 계속 간다(실패한 사실은 서버.log 에 한 번 남는다).
 */
export async function collect(): Promise<Brief[]> {
  const now = wallNow();
  const 난것: Raw[] = [];

  /* ── 업로드가 실패했다 ───────────────────────────────────
     기록 줄은 `낱말 [채널] 내용` 꼴이다. 무슨 줄인지는 **맨 앞 낱말**로만 가른다 — 파이썬은 줄 어디든 「실패」가 들었으면
     업로드 실패로 읽어서, 제목에 「실패」가 든 영상이 잘 올라간 줄이나 썸네일 실패 줄까지 「영상이 올라가지 않았습니다」로 떴다. */
  try {
    for (const { t, x } of await 최근줄("올리기.log", now)) {
      const 맨앞 = 낱말(x);
      if (맨앞 === "발사무산") {
        const m = /발사무산 \[(.*?)\] (\S+).*?\(예정 ([^)]*)\)/.exec(x);
        const [채널, 파일, 예정] = m ? [m[1], m[2], m[3]] : ["?", "", ""];
        난것.push(await 꾸리기(
          t, "큰일",
          `[${채널}] 예약 발사가 무산됐습니다`,
          `발사 시각(${예정})에 '${cut(파일, 40)}' 이 제자리에 없었습니다. 예약을 건 뒤 파일이 옮겨졌거나 지워진 것입니다 — ` +
            "검수에서 불합격해 완료 폴더로 치워진 경우가 가장 흔합니다.",
          "그 예약은 취소됐고 유튜브에는 아무것도 올라가지 않았습니다. 다른 예약들은 그대로 갑니다.",
          "검수 불합격으로 치워진 것이면 재작업본이 오기를 기다렸다가 새로 예약하세요. 파일이 멀쩡히 있는 것이면 " +
            "채널 폴더 제자리에 두고 다시 발사 대기를 걸어 주세요.",
          x,
        ));
      } else if (맨앞 === "발사실패") {
        const m = /발사실패 \[(.*?)\] (\S+)\s+(.*?)\s+\(큐에/.exec(x);
        const [채널, 까닭] = m ? [m[1], m[3]] : ["?", x];
        const { 왜, 할일 } = explainUploadFailure(까닭);
        난것.push(await 꾸리기(
          t, "큰일",
          `[${채널}] 예약 발사가 실패했습니다`,
          왜,
          "영상은 유튜브에 올라가지 않았고, 예약은 큐에 그대로 남아 10분마다 다시 시도합니다. 원인이 그대로면 계속 실패합니다.",
          할일, x,
        ));
      } else if (맨앞 === "사람확인필요") {
        난것.push(await 꾸리기(
          t, "살펴봄",
          "심사가 끝나지 않아 확인이 필요합니다",
          "올린 뒤 정해진 횟수만큼 확인했지만 유튜브 심사가 아직 안 끝났습니다. 긴 영상이거나 유튜브 쪽이 밀렸을 때 납니다.",
          "영상은 비공개로 안전하게 있습니다. 자동 공개는 멈췄습니다.",
          "유튜브 스튜디오에서 상태를 보시고, 괜찮으면 직접 공개하세요.", x,
        ));
      } else if (맨앞 === "썸네일포기") {
        // 썸네일 실패·재시도 줄(썸네일실패 · 썸네일재시도실패)은 팝업이 아니다 — 영상은 올라갔고 앱이 알아서 다시 붙이는 중이다.
        // 앱이 끝내 포기했을 때만 사람이 봐야 한다.
        난것.push(await 꾸리기(
          t, "살펴봄",
          "썸네일이 끝내 안 붙었습니다",
          "영상은 올라갔는데 썸네일을 여러 번 다시 붙여 봐도 안 됐습니다. 채널 전화번호 인증이 안 됐거나 그림 파일이 없어졌을 때 납니다.",
          "영상은 유튜브에 제대로 올라가 있고 썸네일만 기본 화면입니다.",
          "채널이 전화번호 인증(youtube.com/verify)을 마쳤는지 보시고, 유튜브 스튜디오에서 썸네일을 직접 바꿔 주세요.", x,
        ));
      } else if (
        맨앞.endsWith("실패") && !맨앞.startsWith("썸네일") && !맨앞.startsWith("곁파일") && !맨앞.startsWith("대기열")
      ) {
        // 「실패   [채널] 파일  오류글」 — 곁파일 이동 실패는 영상이 멀쩡히 올라갔고 폴더 정리만 안 된 것이라 팝업까지는 아니다
        const 이름 = /\[(.*?)\]\s*(\S+)/.exec(x);
        const 채널 = 이름 ? 이름[1] : "?";
        const 까닭 = x.split("  ").at(-1) ?? x;
        const { 왜, 할일 } = explainUploadFailure(까닭);
        난것.push(await 꾸리기(
          t, "큰일",
          `[${채널}] 영상이 올라가지 않았습니다`,
          왜,
          "그 영상은 유튜브에 없습니다. 파일은 폴더에 그대로 있으니 다시 올릴 수 있습니다. 고객 채널에 잘못 올라간 것은 없습니다.",
          할일, x,
        ));
      }
    }
  } catch (e) {
    await 한번만(`올리기.log 점검 실패 — ${errMsg(e).slice(0, 80)}`);
  }
  // 안전장치가 막은 것은 팝업으로 띄우지 않는다. 그건 제 일을 한 것이지 문제가 아니다 (올리기감시.log 에는 그대로 남는다).

  /* ── 서버가 죽었다 ─────────────────────────────────────── */
  try {
    const 줄 = await tailFile(recordPath("서버.log"), 3000, 1024 * 1024);
    let 자리 = -1;
    for (let i = 줄.length - 1; i >= 0; i--) {
      if (/^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+)?\[예외\]/.test(줄[i])) { 자리 = i; break; }
    }
    if (자리 >= 0) {
      const 머리 = 줄머리.exec(줄[자리]);
      const 때 = (머리 ? parseWall(머리[1]) : null) ?? now;
      // 파이썬은 오래된 Traceback 도 서버.log 에 남아 있는 동안 계속 띄웠다 — 볼시간 안의 것만 띄운다
      if (때.getTime() >= addHours(now, -볼시간).getTime()) {
        const 끝 = [줄[자리]];
        for (let i = 자리 + 1; i < 줄.length && 끝.length < 14 && !줄머리.test(줄[i]); i++) 끝.push(줄[i]);
        // 한 줄짜리 예외는 줄바꿈이 「 ⏎ 」로 바뀌어 있다 — 첫 조각이 오류 문구다. 문구가 비었으면 다음 흔적 줄에서 찾는다.
        const 조각 = 끝[0].replace(/^.*?\[예외\]/, "").split("⏎").map((x) => x.trim()).filter(Boolean);
        const 왜 = 조각[0] ?? (끝.slice(1).find((l) => l.trim()) ?? "").trim();
        난것.push(await 꾸리기(
          때, "큰일",
          "앱 서버에 오류가 났습니다",
          cut(왜, 160),
          "화면이 안 뜨거나 누른 것이 안 먹혔을 수 있습니다. 올린 영상과 기록은 파일에 남아 있어 잃지 않습니다.",
          "앱을 닫았다 다시 열어 주세요. 되풀이되면 이 내용을 알려 주세요.",
          // 시각은 id 에 넣지 않는다 — 같은 오류가 되풀이돼도 한 번 확인한 것은 다시 안 뜬다 (파이썬은 시각 없는 Traceback 글이라 같았다)
          끝.map((l) => l.replace(줄머리, "").trimStart()).join("\n"),
        ));
      }
    }
  } catch (e) {
    await 한번만(`서버.log 점검 실패 — ${errMsg(e).slice(0, 80)}`);
  }

  /* ── 폴더를 못 읽어 낡은 값을 보여 주고 있다 ───────────────
     이게 조용히 넘어가면 화면의 모든 숫자가 옛것인데 사람은 모른다.
     실제로 폴더 하나가 옮겨졌을 뿐인데 지표가 통째로 멈춰 보인 적이 있다. */
  try {
    const 못읽음: string[] = [];
    for (const [k, v] of Object.entries(loadChannels())) {
      const 폴더 = String(v.folder ?? "");
      if (!폴더) continue; // 아직 폴더를 안 정한 채널은 이 점검의 대상이 아니다
      try {
        for await (const _ of Deno.readDir(폴더)) break; // 첫 항목만 읽어 본다
      } catch {
        못읽음.push(`${k} → ${폴더}`);
      }
    }
    if (못읽음.length) {
      난것.push(await 꾸리기(
        now, "큰일",
        "폴더를 읽지 못해 화면이 옛 값을 보여 주고 있습니다",
        "아래 폴더를 못 읽습니다. 옮겼거나 이름이 바뀌었거나 외장이 빠졌을 때 납니다.\n  " + 못읽음.slice(0, 4).join("\n  "),
        "화면의 대기 수·지표·목록이 마지막으로 읽은 값 그대로입니다. 지금 상태가 아닙니다. 이 상태에서는 새로 올린 영상도 안 보입니다.",
        "폴더를 제자리에 두시거나, 설정에서 그 채널의 폴더를 다시 골라 주세요.",
        "canread:" + 못읽음.join("|"),
      ));
    }
  } catch (e) {
    await 한번만(`폴더 점검 실패 — ${errMsg(e).slice(0, 80)}`);
  }

  /* ── 확인해도 안 풀린 것(사람 확인 대기) ─────────────────── */
  try {
    const 대기 = await readJson<unknown>(dataPath("pending.json"), []);
    for (const it of Array.isArray(대기) ? 대기 : []) {
      if (!it || typeof it !== "object" || !(it as Record<string, unknown>)["사람확인"]) continue;
      const o = it as Record<string, unknown>;
      const 번호 = Number(o["확인수"] ?? 0);
      난것.push(await 꾸리기(
        now, "살펴봄",
        `[${o["channel"] ?? "?"}] 심사가 끝나지 않았습니다`,
        `'${cut(o["title"] ?? "", 34)}' 를 ${번호 > 0 ? `${번호}번 ` : ""}확인했지만 유튜브 심사가 아직 진행 중입니다.`,
        "비공개로 안전하게 있습니다. 자동 공개는 멈췄습니다.",
        `스튜디오에서 확인하세요 — https://studio.youtube.com/video/${o["video_id"] ?? ""}/edit`,
        `pending:${o["video_id"] ?? ""}`,
      ));
    }
  } catch (e) {
    await 한번만(`pending.json 점검 실패 — ${errMsg(e).slice(0, 80)}`);
  }

  // 같은 것이 여러 번이면 하나만, 최근 것부터 (시각은 글자가 아니라 실제 순간으로 가른다 — 해가 바뀌는 날에도 맞게)
  const 본것 = new Set<string>();
  const 정리: Brief[] = [];
  for (const x of [...난것].sort((a, b) => b.순간 - a.순간)) {
    if (!띄울급.includes(x.급) || 본것.has(x.id)) continue;
    본것.add(x.id);
    const { 순간: _, ...나머지 } = x;
    정리.push(나머지);
  }
  return 정리.slice(0, 최대);
}

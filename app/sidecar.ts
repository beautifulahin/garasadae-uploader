// 곁딸린 쪽지(sidecar) — 영상마다 다른 제목·설명·태그·썸네일을 옆에 적어 둔다.
//
// 사용자 지시(2026-08-20):
//   "영상마다 제목·해시태그·설명이 자동으로 입력되고, 핵심 장면을 썸네일로 지정"
//   지금까지는 제목을 파일 이름에서 따오고 설명·태그는 채널 기본값 하나를 모든
//   영상에 똑같이 썼다. 영상마다 다르게 넣을 자리가 없었다.
//
//   001_제목.mp4
//   001_제목.json   ← 이 쪽지. 있으면 채널 기본값 대신 이것을 쓴다.
//
// ★없으면 지금까지와 똑같이 돈다. 쪽지는 **덤**이지 조건이 아니다.
// ★모르는 항목은 조용히 버린다. 남이 만든 json 이 들어와도 업로드가 깨지지 않아야 한다.

import { join, log } from "./paths.ts";

export interface Sidecar {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  language?: string;
  privacy?: string;
  madeForKids?: boolean;
  notifySubscribers?: boolean;
  /** 썸네일 그림 — 절대경로이거나 영상과 같은 폴더의 파일 이름 */
  thumbnail?: string;
  /** 예약 공개 시각 (RFC3339, 예: 2026-08-21T19:00:00+09:00).
   *  ★유튜브는 **비공개로 올린 것만** 예약할 수 있다. privacy 를 안 적으면 여기서
   *    private 으로 맞춘다 — 안 그러면 유튜브가 예약을 통째로 무시한다. */
  publishAt?: string;
  /** 올린 직후 달 첫 댓글. 채널에서 `firstComment` 를 켜 두어야 나간다.
   *  ★고정은 못 한다 — 유튜브 API 에 고정하는 길이 없다. 스튜디오에서 손으로 누른다. */
  firstComment?: string;
  /** 갈아끼울 두 번째 제목. 채널의 `retitleHours` 가 지나면 이것으로 바뀐다. */
  titleB?: string;
}

const 공개값 = new Set(["public", "private", "unlisted"]);

function 글(v: unknown, 최대: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 최대) : undefined;
}

/** 영상 옆의 쪽지 자리 — `001_제목.mp4` → `001_제목.json` */
export function sidecarPath(videoPath: string): string {
  const i = videoPath.lastIndexOf(".");
  return (i > 0 ? videoPath.slice(0, i) : videoPath) + ".json";
}

/** 쪽지를 읽는다. 없거나 깨졌으면 null — 그 경우 채널 기본값으로 간다. */
export async function readSidecar(videoPath: string): Promise<Sidecar | null> {
  const 자리 = sidecarPath(videoPath);
  let 글월: string;
  try {
    글월 = await Deno.readTextFile(자리);
  } catch {
    return null;                            // 쪽지가 없는 것은 잘못이 아니다
  }
  let 날것: Record<string, unknown>;
  try {
    날것 = JSON.parse(글월);
  } catch (e) {
    await log(`   ⚠️  쪽지를 읽지 못했습니다(${e instanceof Error ? e.message : e}) — 채널 기본값으로 올립니다`);
    return null;
  }
  if (!날것 || typeof 날것 !== "object") return null;

  const s: Sidecar = {};
  s.title = 글(날것.title, 100);
  s.description = 글(날것.description, 5000);
  if (Array.isArray(날것.tags)) {
    const t = 날것.tags.filter((x): x is string => typeof x === "string" && !!x.trim())
      .map((x) => x.trim().replace(/^#/, ""))     // 해시태그로 적어 와도 받는다
      .slice(0, 30);
    if (t.length) s.tags = t;
  }
  const cat = 날것.categoryId;
  if (typeof cat === "string" || typeof cat === "number") s.categoryId = String(cat);
  s.language = 글(날것.language, 10);
  const 공개 = 글(날것.privacy, 10);
  if (공개 && 공개값.has(공개)) s.privacy = 공개;
  else if (공개) await log(`   ⚠️  쪽지의 공개설정 '${공개}' 은 모르는 값이라 넘어갑니다`);
  if (typeof 날것.madeForKids === "boolean") s.madeForKids = 날것.madeForKids;
  if (typeof 날것.notifySubscribers === "boolean") s.notifySubscribers = 날것.notifySubscribers;
  s.thumbnail = 글(날것.thumbnail, 1024);
  s.firstComment = 글(날것.firstComment, 9000);
  s.titleB = 글(날것.titleB, 100);

  const 때 = 글(날것.publishAt, 40);
  if (때) {
    if (Number.isNaN(Date.parse(때))) {
      await log(`   ⚠️  쪽지의 예약 시각 '${때}' 을 못 읽어 그냥 올립니다`);
    } else if (Date.parse(때) <= Date.now()) {
      await log(`   ⚠️  쪽지의 예약 시각이 이미 지나 그냥 올립니다 (${때})`);
    } else {
      s.publishAt = new Date(때).toISOString();
      // 예약은 비공개로 올린 것만 걸린다. 공개로 적혀 있으면 비공개로 바로잡는다.
      if (s.privacy && s.privacy !== "private") {
        await log(`   · 예약이 걸려 있어 공개설정을 private 으로 맞춥니다`);
      }
      s.privacy = "private";
    }
  }

  return Object.values(s).some((v) => v !== undefined) ? s : null;
}

/** 썸네일 그림의 실제 자리 — 쪽지에 파일 이름만 적혀 있으면 영상과 같은 폴더에서 찾는다 */
export function thumbPath(videoPath: string, thumbnail: string): string {
  if (thumbnail.startsWith("/") || /^[A-Za-z]:[\\/]/.test(thumbnail)) return thumbnail;
  const i = Math.max(videoPath.lastIndexOf("/"), videoPath.lastIndexOf("\\"));
  return join(videoPath.slice(0, i), thumbnail);
}

/** 채널에 적어 둔 **틀**에 그 영상 제목을 끼워 넣는다 (2026-08-22).
 *
 *  `"{제목} (결국 이렇게 됐습니다)"` + `"개헌 왜 이렇게 급해요"`
 *      → `"개헌 왜 이렇게 급해요 (결국 이렇게 됐습니다)"`
 *
 * ★틀이 비어 있으면 빈 글을 돌려준다 — 부르는 쪽에서 "안 한다"로 읽는다.
 * ★`{제목}` 이 없는 틀은 그대로 쓴다(늘 같은 말을 다는 경우).
 */
export function 틀채우기(틀: string, 제목: string): string {
  if (!틀 || !틀.trim()) return "";
  return 틀.replaceAll("{제목}", 제목 ?? "").trim();
}

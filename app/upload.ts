// 업로드 — 한 편씩 비공개로 올리고 장부(ledger.csv)에 남긴다. (파이썬: upload.py)
//
// 올리기 전에 두 가지를 반드시 통과해야 한다.
//   1) 영상 실측 — 길이·화면비로 쇼츠/롱폼을 자동 구분한다 (shorts.ts)
//   2) 아동용 표시(made_for_kids) — 법적 신고 항목이라 운영 원칙(policy.json)의 값을 따른다.
// 모든 업로드는 ledger.csv 에 기록된다(사고 시 소명 근거).
//
// 업로드는 **언제나 비공개**로 올라간다(2단계 공개 원칙). 심사를 통과한 것만 review.ts 가 공개로 바꾼다.
// 어느 길로 오든(화면 단추 · 발사대기 · 명령줄) 이 함수의 출구검사를 지난다 — 안전장치를 빠뜨릴 수 없다.
import { baseName, cut, dataPath, readJsonSync, recordLine, writeJson } from "./paths.ts";
import { addMinutes, isoWall, minuteWall, parseWall, systemZone, wallNow, wallToInstant } from "./clock.ts";
import { appendLedger } from "./ledger.ts";
import { exitGate } from "./safety.ts";
import { check, normalizeJob } from "./shorts.ts";
import { resolveMeta } from "./ai.ts";
import { confFor } from "./channels.ts";
import { resolve, ytFor, 상태살피기 } from "./ytcore.ts";
import { insertVideo, thumbnailsSet, type UploadHandle } from "./youtube.ts";
import { addPending } from "./review.ts";
import { policyForChannel, uploadSlot } from "./daily.ts";
import { findThumb, recordFailure } from "./thumbs.ts";

type Obj = Record<string, any>;
/** 올릴 일감 한 건 (발사대기에 담기는 그 모양). file · channel 은 꼭 있어야 한다. */
export type Job = Record<string, any>;

/* ============================================================ 운영 원칙 */

export interface Policy { made_for_kids: boolean; contains_synthetic_media: boolean; default_category: number; [k: string]: unknown }

const policyFile = () => dataPath("policy.json");

/**
 * 운영 원칙(policy.json)을 읽는다. 영상마다 정하는 값이 아니라 사업 방침이다. (파이썬 load_policy)
 * 파일이 없으면 만들지 않고 안전한 기본값(아동용 아님 · AI 합성 없음 · 카테고리 22)으로 읽는다 —
 * 처음 쓰는 사람이 이 파일 때문에 막히지 않게, 앱이 처음 켜질 때 ensurePolicy() 가 한 번 써 둔다.
 */
export function loadPolicy(): Policy {
  const d = readJsonSync<Obj>(policyFile(), {});
  return {
    ...d,
    made_for_kids: d.made_for_kids === undefined ? false : !!d.made_for_kids,
    contains_synthetic_media: d.contains_synthetic_media === undefined ? false : !!d.contains_synthetic_media,
    default_category: Number(d.default_category ?? 22) || 22,
  };
}

/** 처음 켤 때 policy.json 이 없으면 기본값을 눈에 보이게 적어 둔다 (있으면 손대지 않는다) */
export async function ensurePolicy(): Promise<boolean> {
  try { await Deno.stat(policyFile()); return false; } catch { /* 없다 */ }
  await writeJson(policyFile(), {
    "_설명": "운영 원칙 — 영상마다 정하는 값이 아니라 채널 운영 방침입니다. 아동용 콘텐츠는 만들지 않는다면 false 를 그대로 두세요.",
    made_for_kids: false,
    contains_synthetic_media: false,
    default_category: 22,
  });
  return true;
}

/* ============================================================ 시각 */

const 시각꼴 = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/** '2026-09-01 09:00' (이 컴퓨터 시각) → API 가 받는 UTC 표기. (파이썬 to_rfc3339) */
export function toRfc3339(text: string): string {
  const s = String(text ?? "").trim();
  const w = 시각꼴.test(s) ? parseWall(s) : null;
  if (!w) throw new Error(`발행 시각 형식을 못 읽었습니다: ${JSON.stringify(text)}  (예: 2026-09-01 09:00)`);
  return wallToInstant(w, systemZone()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/* ============================================================ 장부 */

/**
 * 업로드 이력을 남긴다. 사고가 났을 때 소명할 수 있는 유일한 근거다.
 * (누가 준 파일을, 어느 채널에, 언제, 어떤 확인을 거쳐 올렸는가)  (파이썬 write_ledger)
 */
export async function writeLedger(
  job: Job, videoId: string, info: { sec: number; w: number; h: number }, mfk: boolean, synth: boolean,
): Promise<void> {
  await appendLedger({
    "업로드시각": isoWall(wallNow()),
    "채널": String(job._alias || job.channel),
    "영상ID": videoId,
    "제목": String(job._title || job.title || ""),
    "파일": String(job.file),
    "길이초": info.sec.toFixed(1),
    "해상도": `${info.w}x${info.h}`,
    "아동용": mfk ? "True" : "False",
    "AI합성": synth ? "True" : "False",
    "공개설정": "비공개(검토대기)",
    "공개시각": "", // 아직 비공개다. 공개될 때 채운다.
    "예약시각": String(job.publish_at ?? ""),
    "고객확인자": String(job.approved_by ?? ""),
    "확인일": String(job.approved_on ?? ""),
  });
}

/* ============================================================ 올리기 */

export interface UploadOpts {
  /** 올리지 않고 계획만 확인 */
  dry?: boolean;
  /** 긴급중단 손잡이 */
  handle?: UploadHandle;
  onProgress?: (sent: number, total: number) => void;
  /** 한 줄 보고 (화면·콘솔) */
  say?: (line: string) => void;
  /** 이어올리기 재시도 대기 배율(시험은 0) */
  waitScale?: number;
}

/** 일감 하나를 올린다. 일 한도(편성기)의 마지막 보루 안에서. 올라간 영상 id 를 돌려준다(시험이면 null). (파이썬 upload_one) */
export async function uploadOne(job: Job, o: UploadOpts = {}): Promise<string | null> {
  return await uploadSlot(String(job.channel), job, () => uploadOneInner(job, o), { dry: !!o.dry });
}

async function uploadOneInner(job: Job, o: UploadOpts): Promise<string | null> {
  const say = (s: string) => { (o.say ?? console.log)(s); };
  const path = String(job.file ?? "");
  let st: Deno.FileInfo | null = null;
  try { st = await Deno.stat(path); } catch { /* 아래에서 알린다 */ }
  if (!st?.isFile) throw new Error(`파일이 없습니다: ${path}`);

  // 아동용 표시는 policy.json 의 운영 원칙을 따른다.
  const pol = loadPolicy();
  // 승인형 일 한도 정책이 걸린 채널은 승인한 영상을 정한 분 뒤에 예약한다 (파이썬 rescene +10분의 일반형)
  const 승인형 = policyForChannel(String(job.channel));
  if (승인형 && 승인형.cfg.schema === "approved-daily-v1" && (!job.publish_at || job.time_by !== "user")) {
    job.publish_at = minuteWall(addMinutes(wallNow(), Number(승인형.cfg.publish_delay_minutes ?? 10)));
    job.time_by = "user";
  }
  const mfkConf = confFor(String(job.channel))?.made_for_kids;
  const mfk = mfkConf === undefined ? !!pol.made_for_kids : !!mfkConf;
  const synth = job.synthetic === undefined ? !!pol.contains_synthetic_media : !!job.synthetic;

  // 실제 파일로 구분한다. 종류 판정은 승인·출구 검사를 대신하지 않는다.
  const chk = await check(path);
  const info = chk.info;
  Object.assign(job, await normalizeJob(job, info));
  for (const n of chk.notes) say(`  · 참고: ${n}`);

  // ── 제목·설명·해시태그 — 칸마다 「사람이 화면에서 고친 것(txt)·일감에 적은 것 > 쪽지(json) > AI 자동 > 파일 이름」 ──────────
  //   영상 옆 txt/json 이 정하지 않은 칸만 AI 가 영상 내용과 이 채널의 말투를 보고 짓는다(같은 영상은 기록을 재사용 · 실패하면 파일 이름으로 — 업로드를 막지 않는다).
  //   어느 쪽이든 유튜브가 거부하는 것(< > · 100자·5000자·태그 500자)은 여기서 정리한다 — 전송이 끝난 뒤에 거부당하면 되돌릴 수 없다.
  const 채널키 = resolve(String(job.channel)) ?? String(job.channel);
  const 쿠팡 = await 쿠팡모듈();
  const 쿠팡켬 = !!(쿠팡 && safeSync(() => 쿠팡.channelOn(채널키)));
  const meta = await resolveMeta({
    channel: 채널키, file: path, kind: chk.kind, sec: info.sec, w: info.w, h: info.h, job: { title: job.title, desc: job.desc, tags: job.tags },
    generate: true, reserve: 쿠팡켬 ? 800 : 0, // 쿠팡 링크 블록이 붙을 자리
  });
  const title = meta.title;
  let desc = meta.desc;
  const tags: string[] = meta.tags;
  if (meta.status === "자동") {
    const 지은 = (["title", "desc", "tags"] as const).filter((k) => meta.source[k] === "자동").map((k) => ({ title: "제목", desc: "설명", tags: "해시태그" }[k])).join("·");
    say(`    ${meta.cached ? "지어 둔" : "자동으로 지은"} ${지은} 을 씁니다 (${meta.kind}) — 「${cut(title, 40)}」`);
  } else if (meta.why && !/꺼져 있습니다|올릴 때 자동으로/.test(meta.why)) {
    say(`    AI 문안은 건너뜁니다 — ${meta.why}`);
  }
  if (meta.checks.problems.length) say(`    ⚠ 문안 검사에 걸린 것: ${meta.checks.problems.join(" · ")}`);

  // ── 쿠팡 파트너스 — 영상 소재에 맞는 상품 링크를 설명 끝에 (사용자의 파트너스 계정 · 관련 없으면 안 붙임 · 실패해도 업로드는 간다) ──
  let 쿠팡결과: { status: string; links: { name: string; url: string }[] } | null = null;
  if (쿠팡켬 && 쿠팡) {
    try {
      const r = await 쿠팡.forUpload({ channel: 채널키, file: path, title, desc, tags, kind: chk.kind });
      desc = r.desc;
      if (r.pick) {
        쿠팡결과 = { status: r.pick.status, links: r.pick.links };
        if (r.pick.status === "붙임") say(`    쿠팡 상품 링크 ${r.pick.links.length}개를 설명 끝에 붙입니다 — ${r.pick.links.map((x: { name: string }) => cut(x.name, 20)).join(" · ")}`);
        else if (r.pick.status === "건너뜀") say(`    쿠팡 링크는 건너뜁니다 — ${r.pick.why}`);
      }
    } catch (e) {
      say(`    쿠팡 링크는 건너뜁니다 — ${cut(e instanceof Error ? e.message : String(e), 100)}`);
    }
  }

  const body: Obj = {
    snippet: {
      title,
      description: desc,
      tags,
      categoryId: String(job.category ?? pol.default_category ?? 22),
    },
    status: {
      selfDeclaredMadeForKids: mfk,
      // AI 합성 나레이션 공개. 채널별로 끄려면 명세에 synthetic: false
      containsSyntheticMedia: synth,
      // 2단계 공개 원칙: 업로드는 언제나 비공개. 공개 전환은 review.ts 가 심사 통과 후에 한다.
      privacyStatus: "private",
      // 퍼가기·통계 공개를 올릴 때 못박는다. 공개 전환은 지금 값을 읽어 그대로 실으므로(영상바꾸기),
      // 올릴 때 true 가 아니면 false 가 끝까지 간다. 둘 다 유튜브 스튜디오 기본값(켬)이다.
      embeddable: true,
      publicStatsViewable: true,
    },
  };
  // 채널 칸에 audio_language 가 있으면 제목·음성 언어를 못박는다 (값이 없는 채널은 아무것도 안 넣는다).
  const 말 = String(confFor(String(job.channel))?.audio_language ?? "").trim();
  if (말) {
    body.snippet.defaultLanguage = 말;
    body.snippet.defaultAudioLanguage = 말;
  }

  const label = `[${job.channel}] ${cut(title, 40)}`;
  if (o.dry) {
    say(`  (시험) ${label}  ← ${baseName(path)}  ${info.w}x${info.h} · ${info.sec.toFixed(1)}초  ${job.영상종류}`);
    return null;
  }

  const yt = await ytFor(String(job.channel));
  // ── 마지막 문턱 ──────────────────────────────────────────
  //   여기를 지나면 되돌릴 수 없다. 어느 길로 왔든(화면 단추·명령줄·발사대기) 반드시 이 검사를 통과해야 한다.
  //   새 길이 생겨도 여기를 지나므로 안전장치를 빠뜨릴 수가 없다.
  job._meta = { title, desc, tags }; // 출구의 문안 규격 검사는 올라갈 최종 글로 잰다(AI 가 지었든 사람이 썼든)
  await exitGate(job, path);

  let 단계 = -1;
  const resp = await insertVideo(yt, path, body, {
    handle: o.handle,
    waitScale: o.waitScale,
    onProgress: (sent, total) => {
      o.onProgress?.(sent, total);
      const p = total ? Math.floor((sent / total) * 10) : 10;
      if (p !== 단계) { 단계 = p; say(`  ${label}  ${String(Math.floor((sent / total) * 100)).padStart(3)}%`); }
    },
  });
  const vid = String(resp.id);
  await 상태살피기("올림", vid, body.status, resp.status ?? null);

  // 지난 시각을 예약으로 적어 두면 나중에 공개 전환이 통째로 거부되고, 영상은 비공개인 채로 남는다. 여기서 걸러 '심사 끝나면 바로' 로 돌린다.
  let at: string | null = null;
  if (job.publish_at) {
    try {
      at = toRfc3339(String(job.publish_at));
      if (new Date(at).getTime() <= Date.now()) {
        say(`    예약 ${job.publish_at} 은 이미 지났습니다 — 심사가 끝나는 대로 공개합니다`);
        at = null;
      }
    } catch {
      // 형식이 틀린 예약은 올라간 뒤에 알려 봐야 소용없다 — 심사 끝나는 대로 공개로 돌린다 (영상은 이미 올라갔다)
      say(`    예약 시각을 읽지 못했습니다(${job.publish_at}) — 심사가 끝나는 대로 공개합니다`);
      at = null;
    }
  }

  // 목록에는 사람이 읽는 이름으로 남긴다(채널ID로 남기면 화면에서 못 알아본다)
  const 이름 = resolve(String(job.channel)) ?? String(job.channel);
  job._alias = 이름; // 원장도 같은 이름을 쓰게
  job._title = title; // 실제로 올라간 제목

  // 장부를 가장 먼저 남긴다 — 영상은 이미 유튜브에 있다. 뒤의 일이 어긋나도 같은 파일을 두 번 올리지 않게.
  // (파이썬은 대기 목록·썸네일 뒤에 적었다. 결과는 같고 끊겼을 때의 틈이 줄어든다.)
  await writeLedger(job, vid, info, mfk, synth);
  await addPending(이름, vid, title, at, String(job.time_by ?? "auto"));
  say(`  ${label}  비공개 업로드 완료  https://youtu.be/${vid}  (${at ? `검토 후 예약 ${job.publish_at}` : "검토 후 공개"})`);

  // 영상 옆에 같은 이름의 그림이 있으면 맞춤 썸네일로 올린다.
  //   쇼츠는 유튜브가 영상에서 뽑아 쓰지만 롱폼은 썸네일이 곧 클릭률이다.
  //   thumbnails.set 은 youtube.upload 권한이면 되므로 코드 인증으로도 된다 (force-ssl 이 필요 없다).
  const th = await findThumb(path);
  if (th && "skippedBig" in th) {
    say(`    썸네일이 2MB를 넘어 건너뜁니다 — ${baseName(th.skippedBig)}`);
  } else if (th) {
    try {
      const bytes = await Deno.readFile(th.path);
      await thumbnailsSet(yt, vid, bytes, th.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg");
      say(`  ${label}  썸네일 올림 — ${baseName(th.path)}`);
    } catch (e) {
      // 썸네일이 실패해도 영상은 이미 올라갔다. 여기서 멈추면 안 된다.
      say(`  ${label}  썸네일은 못 올렸습니다 — ${cut(e instanceof Error ? e.message : String(e), 110)}`);
      if (confFor(String(job.channel))?.thumb_watch || confFor(이름)?.thumb_watch) {
        try { await recordFailure(이름, path, vid, th.path, e); } catch (x) { say(`    썸네일 재시도 표식을 못 남겼습니다 — ${cut(String(x), 90)}`); }
      }
    }
  }
  await recordLine("올리기.log", `업로드  [${이름}] ${baseName(path)}  ${vid}`);
  if (쿠팡결과 && 쿠팡) { try { await 쿠팡.attachVideoId(path, vid); } catch { /* 기록일 뿐이다 */ } }
  return vid;
}


/** 쿠팡 모듈 — 없거나 불러오다 실패해도 업로드는 간다(fail-open) */
async function 쿠팡모듈(): Promise<typeof import("./coupang.ts") | null> {
  try { return await import("./coupang.ts"); } catch { return null; }
}
function safeSync<T>(f: () => T): T | null { try { return f(); } catch { return null; } }

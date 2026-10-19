// 검토 후 공개 — 올린 영상의 상태를 확인하고 이상 없는 것만 공개로 바꾼다. (파이썬: review.py)
//
// 흐름
//   upload.ts  →  비공개로 올리고 pending.json 에 적어 둔다
//   review.ts  →  유튜브 처리·심사 결과를 확인
//                 이상 없음 → 공개(또는 예약 발행)로 전환
//                 문제 있음 → 공개하지 않고 사유와 함께 남긴다
//
// 왜 이렇게 하나: 바로 공개로 올리면 저작권 클레임이나 부적절 판정이 이미 공개된 뒤에 뜬다.
// 비공개로 올려 심사를 통과시킨 뒤 여는 것이 사고를 막는 유일한 순서다.
import { cut, dataPath, readJsonSync, recordLine, withFileLock, writeJson } from "./paths.ts";
import { instantToWall, isoWall, minuteWall, parseInstant, parseNaive, systemZone, wallNow, type Wall } from "./clock.ts";
import { ytFor, 영상바꾸기 } from "./ytcore.ts";
import { videosList } from "./youtube.ts";
import { patchLedger } from "./ledger.ts";
import { manualPrivateHas, publishGate } from "./safety.ts";
import { policyForChannel } from "./daily.ts";
import { publishNotice } from "./notify.ts";
import * as MP from "./metapost.ts";

type Obj = Record<string, any>;

/** 사람이 읽을 수 있는 사유 */
export const REJECT_KO: Record<string, string> = {
  claim: "저작권 클레임", copyright: "저작권 위반", duplicate: "중복 영상",
  inappropriate: "부적절한 콘텐츠", legal: "법적 사유", length: "길이 문제",
  termsOfUse: "약관 위반", trademark: "상표권",
  uploaderAccountClosed: "계정 폐쇄", uploaderAccountSuspended: "계정 정지",
};
export const FAIL_KO: Record<string, string> = {
  codec: "코덱 문제", conversion: "변환 실패", emptyFile: "빈 파일",
  invalidFile: "잘못된 파일", tooSmall: "파일이 너무 작음", uploadAborted: "업로드 중단",
};
export const CLAIM_KO: Record<string, string> = {
  blocked: "일부 지역에서 차단됨", monetize: "권리자가 수익을 가져감", track: "권리자가 조회수만 추적", "": "저작권 신고 있음",
};

export interface PendingItem {
  channel: string;
  video_id: string;
  title: string;
  publish_at: string | null;
  uploaded: string;
  /** 지금까지 몇 번 봤나 */
  확인수: number;
  /** 한 번 봐도 안 풀려 사람에게 넘겼나 */
  사람확인: boolean;
  /** user = 사람이 고름(지킨다) · auto = 앱이 계획한 것 */
  시각정한이: string;
  마지막확인?: string;
  사람확인시각?: string;
  간격대기?: string;
  [k: string]: unknown;
}

const pendingFile = () => dataPath("pending.json");

export function loadPending(): PendingItem[] {
  const v = readJsonSync<unknown>(pendingFile(), []);
  return Array.isArray(v) ? (v as PendingItem[]) : [];
}

export async function savePending(items: PendingItem[]): Promise<void> {
  await writeJson(pendingFile(), items, { indent: 2 });
}

/**
 * 대기 목록을 잠그고 고친다. 화면 서버·예약 작업·명령줄이 같은 파일을 만지므로 읽고-고치고-쓰기를 한 번에 한다.
 * (파이썬은 잠금이 없어서, 검토 도중 새로 올라간 영상이 목록을 덮어쓰며 사라질 수 있었다.)
 */
export async function updatePending<T>(고치기: (items: PendingItem[]) => PendingItem[] | { items: PendingItem[]; result: T }): Promise<T | undefined> {
  return await withFileLock(dataPath(".pending.lock"), async () => {
    const r = 고치기(loadPending());
    const items = Array.isArray(r) ? r : r.items;
    await savePending(items);
    return Array.isArray(r) ? undefined : r.result;
  }) as T | undefined;
}

/** 예약 시각이 이미 지났나. 읽을 수 없는 값이면 지나지 않은 것으로 본다. (파이썬 _지났나) */
export function isPast(when: string, now: Date = new Date()): boolean {
  const t = parseInstant(String(when ?? ""));
  return !!t && t.getTime() <= now.getTime();
}

/* ─────────── 확인 원칙 (2026-08-28 확정) ───────────
 *
 *   영상 하나당 **올린 지 30분 뒤에 딱 한 번**만 확인한다. 그게 전부다.
 *
 * 예전에는 [10, 30, 60, 300] 분에 네 번씩 봤고, 그 전에는 한 시간마다 대기 중인 것을 전부 다시 조회했다.
 * 영상 하나가 유튜브에 네 번 물어보게 되고, 대기가 쌓이면 곱해진다. 유튜브 심사는 대개 몇 분 안에 끝나므로 30분이면
 * 충분하고, 30분에 안 끝난 것은 몇 번 더 본다고 달라지지 않는다. 그런 것은 기계가 붙들고 있지 말고 사람에게 넘기는 편이 낫다.
 * 이 값을 늘리고 싶어지면 먼저 생각할 것: 늘린 만큼 유튜브 호출이 곱해진다. */
export const CHECK_AT = [30]; // 분 — 한 번뿐이다
export const MAX_CHECKS = 1; // CHECK_AT 길이와 같게 유지할 것

/** 승인형 일 한도 정책(approved-daily-v1)이 걸린 채널은 올리자마자 바로 본다 (파이썬 승인형 편성기의 applies) */
const approvedChannel = (channel: unknown) => policyForChannel(String(channel ?? ""))?.cfg.schema === "approved-daily-v1";

export interface LookTurn { look: boolean; remaining: number; done: boolean; turn: number }

/** 이 영상을 지금 볼 차례인가. (파이썬 _언제볼차례) */
export function whenToLook(it: PendingItem, now: Date = new Date()): LookTurn {
  const n = Number(it.확인수 ?? 0);
  if (approvedChannel(it.channel) && !it.사람확인 && n < MAX_CHECKS) return { look: true, remaining: 0, done: false, turn: n + 1 };
  if (it.사람확인) return { look: false, remaining: 0, done: true, turn: n };
  if (n >= MAX_CHECKS) return { look: false, remaining: 0, done: true, turn: n };
  const up = parseNaive(String(it.uploaded ?? ""));
  if (!up) return { look: true, remaining: 0, done: false, turn: n + 1 };
  const at = new Date(up.getTime() + CHECK_AT[n] * 60_000);
  const left = (at.getTime() - wallNow(systemZone(), now).getTime()) / 60_000;
  return { look: left <= 0, remaining: Math.max(Math.trunc(left), 0), done: false, turn: n + 1 };
}

/** 올린 영상 하나를 대기 목록에 올린다 — upload.ts 가 부른다. (파이썬 add_pending) */
export async function addPending(
  channel: string, videoId: string, title: string, publishAt: string | null, timeBy = "auto",
): Promise<void> {
  await updatePending((items) => {
    items.push({
      channel, video_id: videoId, title, publish_at: publishAt, uploaded: isoWall(wallNow()),
      확인수: 0, 사람확인: false, 시각정한이: timeBy,
    });
    return items;
  });
}

/**
 * (판정, 사유) — 판정은 ok / wait / bad / claim 중 하나. (파이썬 judge)
 * claim 은 「올라가긴 했는데 권리자 신고가 붙은 것」. 공개해도 되는 경우가 많지만, 모르고 공개하는 것과 알고 공개하는 것은 다르다.
 */
export function judge(st: Obj, pd: Obj): [string, string] {
  const up = st.uploadStatus;
  if (up === "rejected") {
    const r = st.rejectionReason ?? "?";
    return ["bad", `거부됨 — ${REJECT_KO[r] ?? r}`];
  }
  if (up === "failed") {
    const r = st.failureReason ?? "?";
    return ["bad", `실패 — ${FAIL_KO[r] ?? r}`];
  }
  if (up === "deleted") return ["bad", "삭제된 영상"];

  const proc = pd.processingStatus;
  if (proc === "failed") return ["bad", "유튜브 처리 실패"];
  if (proc === "processing" || up === "uploaded") return ["wait", "아직 처리 중"];
  if (up === "processed" && (proc === "succeeded" || proc === "terminated" || proc == null)) {
    // 심사는 통과했지만 제한이 걸려 있는가. (권리자 신고 상세는 youtubepartner 권한이 있어야 읽을 수 있다 — 우리 권한으로 볼 수 있는 흔적만 본다)
    const lic = st.license;
    if (st.embeddable === false || st.publicStatsViewable === false) return ["claim", "일부 설정이 제한돼 있습니다 — 스튜디오에서 확인하세요"];
    if (lic && lic !== "youtube" && lic !== "creativeCommon") return ["claim", `라이선스 표시가 다릅니다 — ${lic}`];
    return ["ok", "이상 없음"];
  }
  return ["wait", `상태 확인 중 (upload=${up}, processing=${proc})`];
}

/**
 * 원장에 「공개시각」과 「공개설정」을 함께 적는다. (파이썬 _공개시각적기)
 * 공개설정까지 여기서 고치는 이유: 예전에는 sync 만 공개설정을 고쳤다. sync 는 유튜브에 물어봐야 하므로 할당량이 없으면 못 돈다.
 * 그러면 우리가 방금 공개시킨 영상이 화면에는 며칠씩 「비공개」로 남는다. 우리가 연 것은 우리가 안다 — 여기서 적는다.
 */
export async function stampPublished(videoId: string, 시각: string, 설정 = "public"): Promise<void> {
  try {
    await patchLedger(videoId, { 공개시각: 시각 || undefined, 공개설정: 설정 || undefined }, ["공개시각"]);
  } catch (e) {
    // 조용히 넘기면 공개시각이 왜 안 적히는지 알 수 없다.
    console.log(`  공개시각을 적지 못했습니다 — ${(e as Error).message.slice(0, 80)}`);
  }
}

export interface ReviewResult {
  /** 보고 줄들 (화면·로그에 그대로 보인다) */
  lines: string[];
  opened: number;
  kept: number;
  blocked: number;
  /** 대기 목록이 비어 있었다 */
  empty: boolean;
}

export interface RunOpts {
  /** 시험이 시계를 바꿔 끼운다 */
  now?: Date;
  /** 한 줄 보고가 나올 때마다 (콘솔·화면 로그) */
  say?: (line: string) => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim();

/* 인스타그램·스레드 올리기 장부에 알린다 — 장부 쓰기뿐이고 네트워크를 쓰지 않는다. 어떤 오류도 유튜브 검토·공개를 막지 않는다. */
async function metaPublic(vid: string, publishAt: string | null, now: Date) {
  try { await MP.markPublic(vid, { publishAt, now }); } catch (e) { await recordLine("올리기.log", `인스타·스레드 공개 알림 실패  ${vid}  ${cut(errText(e), 80)}`); }
}
async function metaDropped(vid: string, why: string, now: Date) {
  try { await MP.markDropped(vid, why, { now }); } catch (e) { await recordLine("올리기.log", `인스타·스레드 접기 실패  ${vid}  ${cut(errText(e), 80)}`); }
}

/**
 * 검토하고, 통과한 것을 공개로 바꾼다. (파이썬 run)
 *
 * 누가: 공개까지 하려면 **누가 시켰는지 밝혀야 한다** — "예약작업" 또는 "사람". 밝히지 않으면 검토만 하고 공개는 건너뛴다.
 * 진단·시험 코드가 실수로 영상을 공개시키는 사고를 막는다(2026-08-28 에 점검 도구가 그랬다).
 *
 * 채널을 훑지 않는다: 확인은 우리가 올린 영상만 지목해서 한다(videos.list?id=...). 채널 전체를 훑지 않는다.
 * 예전에는 여기서 sync 를 먼저 불렀고, 그것은 원장에 이름이 오른 모든 채널에 videos.list 를 한 번씩 날렸다.
 * 대기가 하나도 없는 날에도 그랬고 하루 1,000건이 넘었다. 원장 청소가 필요하면 사람이 갱신을 누를 때 한다.
 */
export async function run(doPublish: boolean, 누가 = "", o: RunOpts = {}): Promise<ReviewResult> {
  const lines: string[] = [];
  const say = (s: string) => { lines.push(s); o.say?.(s); };
  const now = o.now ?? new Date();
  const res: ReviewResult = { lines, opened: 0, kept: 0, blocked: 0, empty: false };

  const items = loadPending();
  if (!items.length) {
    say("검토 대기 중인 영상이 없습니다.");
    res.empty = true;
    return res;
  }
  say(`검토 대기 ${items.length}건` + (doPublish ? "" : "  (확인만 — 바꾸지 않습니다)"));

  // 영상 id → 새 모습(남김) 또는 null(목록에서 뺌). 안 건드린 것은 그대로 둔다.
  const 결정 = new Map<string, PendingItem | null>();
  let opened = 0, blocked = 0;

  for (const it of items) {
    const tag = `[${it.channel}] ${cut(it.title, 34)}`;
    const vid = it.video_id;
    const keep = () => { 결정.set(vid, it); };
    const drop = () => { 결정.set(vid, null); };

    // 볼 차례가 아니면 조회하지 않는다. 유닛도 안 쓰고 목록에 그대로 둔다.
    let 차 = whenToLook(it, now);
    // ── 유튜브가 늦을 때의 구제 ─────────────────────────────────
    //   확인 시각에 유튜브 심사가 안 끝나 있으면 확인 횟수만 소진되고 영상은 비공개로 영영 남았다
    //   (실제로 겪음 — 30분 심사가 40분 걸림). 느린 심사가 확인이면, 1시간에 한 번씩만 다시 본다. 12시간까지.
    //   그 뒤에도 안 풀리면 진짜 문제일 수 있으니 사람 몫으로 남긴다.
    if (차.done && it.사람확인) {
      const 올린 = parseNaive(String(it.uploaded ?? ""));
      const 마지막 = parseNaive(String(it.마지막확인 ?? ""));
      const 지금 = wallNow(systemZone(), now);
      if (올린 && 마지막 && 지금.getTime() - 올린.getTime() < 12 * 3600_000 && 지금.getTime() - 마지막.getTime() >= 3600_000) {
        차 = { done: false, look: true, turn: Number(it.확인수 ?? 1) + 1, remaining: 0 };
        say(`  ${tag}  유튜브 심사가 늦어 한 번 더 봅니다 (올린 지 ${Math.floor((지금.getTime() - 올린.getTime()) / 3600_000)}시간)`);
      }
    }
    if (차.done) {
      // 확인을 다 썼는데 아직 안 풀렸다 — 여기서부터는 사람 몫이다.
      // 자동으로 계속 두드리면 언제까지고 목록에 남아 진짜 문제를 가린다.
      if (!it.사람확인) {
        it.사람확인 = true;
        it.사람확인시각 = isoWall(wallNow(systemZone(), now));
        say(`  ${tag}  ⚠ ${MAX_CHECKS}번 확인했지만 아직 심사 중입니다 — 사람이 봐 주세요`);
        say(`       https://studio.youtube.com/video/${vid}/edit`);
        await recordLine("올리기.log", `사람확인필요  [${it.channel}] ${cut(it.title, 40)} — ${MAX_CHECKS}번 확인해도 심사 안 끝남`);
        blocked++;
      }
      keep();
      continue;
    }
    if (!차.look) {
      say(`  ${tag}  ${차.turn}번째 확인까지 ${차.remaining}분 남음`);
      keep();
      continue;
    }

    it.확인수 = 차.turn;
    it.마지막확인 = isoWall(wallNow(systemZone(), now));
    let 현재: Obj | null = null;
    let verdict = "", why = "";
    let yt;
    try {
      yt = await ytFor(it.channel);
      const got = await videosList(yt, [vid], "status,processingDetails");
      // 이 조회의 status 를 공개 전환 때 「지금 값」으로 다시 쓴다(유닛 추가 없음).
      현재 = got[0] ?? null;
      if (!현재) {
        say(`  ${tag}  영상을 찾을 수 없습니다 (삭제됨?)`);
        await metaDropped(vid, "유튜브에서 영상을 찾을 수 없습니다", now);
        blocked++;
        drop();
        continue;
      }
      // 관리자가 스튜디오에서 직접 공개로 돌렸을 수 있다. 그러면 앱이 할 일은 없다. 목록에서 빼고 넘어간다.
      const 지금 = 현재.status?.privacyStatus;
      if (지금 === "public" || 지금 === "unlisted") {
        say(`  ${tag}  이미 ${지금 === "public" ? "공개" : "일부 공개"}입니다 — 목록에서 뺍니다`);
        if (지금 === "public") await metaPublic(vid, null, now);
        else await metaDropped(vid, "유튜브에서 일부 공개로 바뀌어 있습니다", now);
        opened++;
        drop();
        continue;
      }
      [verdict, why] = judge(현재.status ?? {}, 현재.processingDetails ?? {});
    } catch (e) {
      say(`  ${tag}  조회 실패: ${errText(e).slice(0, 90)}`);
      keep();
      continue;
    }

    if (verdict === "wait") { say(`  ${tag}  대기 — ${why}`); keep(); continue; }
    if (verdict === "claim") {
      say(`  ${tag}  ⚠ 확인 필요 — ${why}`);
      say(`       https://studio.youtube.com/video/${vid}/edit`);
      say("       괜찮으면 스튜디오에서 직접 공개하시거나, 다음 회차에 다시 봅니다.");
      keep();
      blocked++;
      continue;
    }
    if (verdict === "bad") {
      say(`  ${tag}  ⚠ 공개하지 않음 — ${why}`);
      say(`       https://studio.youtube.com/video/${vid}/edit`);
      await metaDropped(vid, why, now);
      blocked++;
      drop();
      continue;
    }

    // 사람이 비공개로 내린 영상이 어떤 경로로든 대기 목록에 남아 있으면 여기서 내려놓는다. 안 그러면 매시간 공개를 재시도한다.
    try {
      if (manualPrivateHas(vid)) {
        say(`  ${tag}  사람이 내린 영상 — 자동 공개하지 않고 목록에서 뺍니다`);
        await metaDropped(vid, "사람이 비공개로 내린 영상입니다", now);
        drop();
        continue;
      }
    } catch (e) {
      say(`  ${tag}  수동비공개 확인 실패 — ${errText(e)}`);
    }

    // 이상 없음
    if (!doPublish) { say(`  ${tag}  공개 가능 — ${why}`); keep(); continue; }

    // 바꿀 칸만 적는다. 나머지(embeddable·publicStatsViewable·selfDeclaredMadeForKids·containsSyntheticMedia·license)는
    // 영상바꾸기가 지금 값대로 실어 보낸다. 예전엔 privacyStatus 만 보내서 전 채널 영상의 퍼가기·통계 공개가 꺼지고 합성 표시가 지워졌다.
    let 바꿀: Obj = { privacyStatus: "public" };
    let 예약: string | null = it.publish_at ?? null;
    // 앱이 알아서 잡은 시각은 「계획」일 뿐이다. 심사가 끝났으면 그 시각을 기다리지 않고 바로 공개한다 — 검토만 통과하면
    // 빨리 나가는 편이 낫고, 몇 시간을 비공개로 묵혀 둘 이유가 없다. 사람이 화면에서 직접 고른 시각은 약속이므로 그대로 지킨다.
    if (예약 && (it.시각정한이 ?? "auto") !== "user") {
      say(`  ${tag}  검토 끝 — 예약(${예약.slice(0, 16)})을 기다리지 않고 지금 공개합니다`);
      예약 = null;
    }
    if (예약 && isPast(예약, now)) {
      // 지난 시각을 publishAt 으로 보내면 유튜브가 거부한다. 그러면 영상은 비공개인 채로 영영 남는다. 이미 지난 예약은 지금 여는 것이 맞다.
      say(`  ${tag}  예약 시각(${예약.slice(0, 16)})이 지나 지금 공개합니다`);
      예약 = null;
    }
    if (예약) {
      // 예약이 잡혀 있으면 그 시각에 열리게 둔다(비공개 유지 + publishAt).
      바꿀 = { privacyStatus: "private", publishAt: 예약 };
    }
    try {
      // ── 공개 문턱 ─────────────────────────────────────────
      //   업로드와 별개로 여기도 잠근다. 밖으로 나가는 일은 모두 문을 하나 지나야 한다.
      //   예약은 UTC(…Z)로 저장돼 있다. 원장 시각은 이 컴퓨터 시각이므로 바꿔서 잰다.
      //   (그냥 Z 를 떼면 9시간 어긋나 엉뚱한 칸과 부딪힌다 — 2026-09-18 실측)
      let 열릴때: Wall | null = null;
      if (예약) {
        const t = parseInstant(예약);
        열릴때 = t ? instantToWall(t, systemZone()) : null;
      }
      await publishGate(누가, it, 열릴때);
      await 영상바꾸기(yt, vid, { status: 바꿀, 지금: 현재 });
      const when = 예약 ? `예약 ${예약}` : "즉시 공개";
      // ★ 예약을 건 것은 **아직 공개된 것이 아니다.** 유튜브에서 비공개인 채로 그 시각을 기다린다.
      //   예전에는 이때도 'public' 으로 적어, 화면에 「공개됨」으로 나왔다(실제로는 예약 대기였다). 상태를 있는 그대로 적는다.
      if (예약) await stampPublished(vid, "", "예약");
      else await stampPublished(vid, minuteWall(wallNow(systemZone(), now)), "public");
      say(`  ${tag}  공개 전환 완료 — ${when}`);
      // 인스타·스레드는 유튜브가 열리는 때에 맞춘다(즉시 공개면 지금, 예약이면 그 시각 뒤)
      await metaPublic(vid, 예약, now);
      // 예약을 건 것은 아직 안 열렸다. **실제로 열린 것만** 알린다.
      if (!예약) {
        try { await publishNotice(it.channel ?? "", it.title ?? "", vid); }
        catch (e) { say(`    알림 실패 — ${errText(e).slice(0, 60)}`); }
      }
      opened++;
      drop();
    } catch (e) {
      const 말 = errText(e).split("\n")[0];
      if (말.includes("공개 간격")) {
        // 간격 대기는 검토를 쓴 것이 아니다. 횟수를 되돌려 놓아야 다음 회차에 다시 보고(상태 재확인 포함) 때가 되면 나간다.
        // 안 되돌리면 MAX_CHECKS 소진 → 「사람이 봐 주세요」로 좌초한다.
        it.확인수 = Math.max(0, Number(it.확인수 ?? 1) - 1);
        it.간격대기 = 말;
      }
      say(`  ${tag}  공개하지 않았습니다 — ${말}`);
      keep();
    }
  }

  // 검토하는 동안 새로 올라간 영상이 있을 수 있다 — 잠그고 다시 읽어, 내가 본 것만 바꾸고 나머지는 그대로 둔다.
  await updatePending((cur) => cur.flatMap((x) => {
    if (!결정.has(x.video_id)) return [x];
    const d = 결정.get(x.video_id);
    return d ? [d] : [];
  }));

  res.opened = opened;
  res.blocked = blocked;
  res.kept = [...결정.values()].filter(Boolean).length;
  say(`\n공개 ${opened}건 · 보류 ${res.kept}건 · 차단 ${blocked}건`);
  if (blocked) say("차단된 건은 스튜디오에서 직접 확인하고 고객에게 알리세요.");
  return res;
}

/** 화면의 「심사 대기」 줄에 보이는 모습 (유튜브를 부르지 않는다) */
export function describePending(now: Date = new Date()) {
  return loadPending().map((it) => {
    const t = whenToLook(it, now);
    const state = it.사람확인 ? "사람확인" : it.간격대기 ? "간격대기" : t.look ? "볼차례" : "대기";
    return {
      channel: it.channel, video_id: it.video_id, title: it.title, publish_at: it.publish_at, uploaded: it.uploaded,
      확인수: it.확인수, state, remaining: t.remaining, 간격대기: it.간격대기 ?? "",
    };
  });
}

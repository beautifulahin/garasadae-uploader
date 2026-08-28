// 폴더 감시 엔진 — 채널마다 폴더를 하나씩 지켜보며 자동으로 올린다.
import {
  Channel, Config, IS_WIN, Job, State, credsOf, join, loadConfig, loadState, loadTokens,
  localDate, localStamp, log, projectKey, quotaDate, quotaResetAt, safeFolderName, saveState,
} from "./paths.ts";
import {
  DAILY_QUOTA, insertComment, setThumbnail, THUMB_COST, updateVideoTitle, UPLOAD_COST,
  uploadVideo, verifyVideo, VideoMeta, WRITE_COST,
} from "./youtube.ts";
import { readSidecar, Sidecar, sidecarPath, thumbPath, 틀채우기 } from "./sidecar.ts";
import { ErrKind, UploadError } from "./errors.ts";
import { accessToken, assertSameChannel, 고급권한있나, 고급기능켰나 } from "./auth.ts";
import { moveToTrash, notify, openUrl, 잠깨우기끝, 잠깨워두기, 쓰던탭에다시 } from "./platform.ts";
import { dupMessage, fileFingerprint, findDuplicate } from "./dedupe.ts";
import { 메타지어보기 } from "./ai.ts";
import { nextSlot, 슬롯말 } from "./slots.ts";
import { refreshStats, statsRows } from "./stats.ts";

const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".webm", ".mkv", ".flv", ".wmv", ".mpg", ".mpeg", ".mts", ".m2ts",
]);
const SKIP_SUFFIX = [".part", ".crdownload", ".download", ".tmp", ".partial", ".!ut"];
/** 여기에 넣으면 사용 중인 모든 채널로 복사되어 각각 올라간다 */
export const BROADCAST_DIR = "모든채널";
export const DONE_DIR = "_완료";
export const FAIL_DIR = "_실패";
export const HOLD_DIR = "_보류";
const SUB_DIRS = new Set([DONE_DIR, FAIL_DIR, HOLD_DIR]);

export type PendingStatus = "watching" | "ready" | "uploading" | "done" | "error";

export interface Pending {
  key: string;            // 채널id|파일이름 — 채널이 달라도 같은 이름을 구분한다
  channelId: string;
  channelName: string;
  name: string;
  path: string;
  size: number;
  title: string;
  description: string;
  stable: number;
  status: PendingStatus;
  progress: number;
  sent: number;
  error: string;
  helpUrl: string;
  videoId: string;
  verified: boolean;
  detectedAt: number;
  retryAt: number;
  tries: number;
  /** 영상 옆에 놓인 쪽지(`같은이름.json`). 없으면 null — 그러면 채널 기본값으로 간다. */
  sidecar: Sidecar | null;
  /** AI 가 지은 태그. 쪽지·채널 태그가 없을 때만 쓴다. */
  aiTags?: string[];
  /** 사람이 화면에서 제목을 고쳤나 — 고쳤으면 AI 가 덮지 않는다. */
  titleEdited?: boolean;
  /** 사람이 화면에서 설명을 고쳤나. */
  descEdited?: boolean;
  /** 파일 지문. 올리기 직전에 낸다(dedupe.fileFingerprint). */
  hash: string;
  /** 같은 편이라 막혔을 때의 까닭. 비어 있으면 안 막힌 것이다. */
  dup: string;
  /** 사용자가 「그래도 올리기」를 눌렀다 — 중복 막기를 이번 한 번 건너뛴다. */
  forced: boolean;
  /** 예약이 걸렸으면 그 시각(RFC3339). 화면에 보여 준다. */
  publishAt: string;
}

function ext(name: string) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}
function stem(name: string) {
  const i = name.lastIndexOf(".");
  return i < 0 ? name : name.slice(0, i);
}
export function isVideoFile(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~$")) return false;
  const low = name.toLowerCase();
  if (SKIP_SUFFIX.some((s) => low.endsWith(s))) return false;
  return VIDEO_EXT.has(ext(name));
}

/** 음악을 넣는 스튜디오 편집기 주소 */
export function studioEditorUrl(id: string): string {
  return `https://studio.youtube.com/video/${id}/editor`;
}

export interface ChannelBlock { message: string; url: string }

/** 쪽지의 승인 표식이 **이 파일**을 가리키는가 (H-241).
 *  source·finalOk·md5·sha256·at 네 가지 꼴은 readSidecar 가 이미 걸렀다. 여기서는 뜻을 본다:
 *  review.approve 가 준 것이고 FINAL 이 참이며, 현재 파일의 전체 sha256 이 표식과 같아야 한다.
 *  전체 해시는 제목이 겹친 그 드문 갈래에서만 한 번 낸다. 못 읽으면 false(현행대로 세운다). */
export async function 승인된수정본인가(s: Sidecar | null, path: string): Promise<boolean> {
  const a = s?.approval;
  if (!a || a.source !== "review.approve" || a.finalOk !== true) return false;
  if (!/^[0-9a-f]{32}$/.test(a.md5) || !/^[0-9a-f]{64}$/.test(a.sha256)) return false;
  try {
    const d = await crypto.subtle.digest("SHA-256", await Deno.readFile(path));
    const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === a.sha256;
  } catch {
    return false;
  }
}

export class Manager {
  cfg!: Config;
  state!: State;
  pending = new Map<string, Pending>();
  running = false;
  uploadingKey = "";
  paused = false;
  /** 로그인이 풀린 채널 — 채널id → 까닭. 올리려다 실패하기 전에 미리 알린다. */
  loginAlerts = new Map<string, string>();
  private lastLoginCheck = 0;
  lastSeen = 0;
  lastError = "";
  /** 채널별로 "사용자가 고쳐야 하는 문제" */
  blocks = new Map<string, ChannelBlock>();
  /** 업로드가 끝나 음악을 넣을지 물어볼 영상 */
  ask: { id: string; title: string; channelName: string } | null = null;
  private stop = false;
  private rotate = 0;
  /** 모든채널 폴더의 파일이 저장을 마쳤는지 세는 값 */
  private fanSeen = new Map<string, { size: number; count: number }>();

  async init() {
    this.cfg = await loadConfig(true);
    this.state = await loadState();
  }

  async reloadConfig() {
    this.cfg = await loadConfig(true);
  }

  channels(): Channel[] {
    return this.cfg.channels.filter((c) => c.enabled);
  }

  channelById(id: string): Channel | undefined {
    return this.cfg.channels.find((c) => c.id === id);
  }

  /** 감시할 폴더 목록. 상위 폴더에 바로 넣은 영상은 첫 번째 채널로 보낸다. */
  scanTargets(): { folder: string; ch: Channel }[] {
    const list = this.channels()
      .filter((ch) => !samePath(ch.folder, this.broadcastDir()))
      .map((ch) => ({ folder: ch.folder, ch }));
    const base = this.cfg.baseDir;
    if (base && list.length && !list.some((t) => samePath(t.folder, base))) {
      list.push({ folder: base, ch: list[0].ch });
    }
    return list;
  }

  /** 모든채널 폴더는 채널이 둘 이상일 때만 쓴다 */
  broadcastDir(): string {
    return this.cfg.baseDir ? join(this.cfg.baseDir, BROADCAST_DIR) : "";
  }
  useBroadcast(): boolean {
    return this.channels().length >= 2 && !!this.cfg.baseDir;
  }

  async ensureDirs() {
    if (this.cfg.baseDir) {
      try { await Deno.mkdir(this.cfg.baseDir, { recursive: true }); } catch { /* 무시 */ }
    }
    if (this.useBroadcast()) {
      try { await Deno.mkdir(this.broadcastDir(), { recursive: true }); } catch { /* 무시 */ }
    }
    for (const ch of this.channels()) {
      try { await Deno.mkdir(ch.folder, { recursive: true }); } catch (e) {
        await log(`⚠️  [${ch.name}] 폴더를 만들지 못했습니다: ${ch.folder} — ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /* ----------------------------------------- 한도 */

  private today() { return localDate(); }

  /** 할당량은 **태평양 날짜**로 센다 — 구글이 그 날짜로 세기 때문이다(paths.quotaDate). */
  quotaOf(ch: Channel): { used: number; left: number } {
    const key = projectKey(this.cfg, ch);
    const q = this.state.quota[key];
    if (!q || q.date !== quotaDate()) {
      this.state.quota[key] = { date: quotaDate(), used: 0 };
      return { used: 0, left: DAILY_QUOTA };
    }
    return { used: q.used, left: DAILY_QUOTA - q.used };
  }

  addQuota(ch: Channel, n: number) {
    const key = projectKey(this.cfg, ch);
    const q = this.state.quota[key];
    if (!q || q.date !== this.today()) this.state.quota[key] = { date: this.today(), used: n };
    else q.used += n;
  }

  todayCount(channelId?: string): number {
    const d = this.today();
    return this.state.uploads.filter((u) =>
      u.at.slice(0, 10) === d && (!channelId || u.channelId === channelId)
    ).length;
  }

  limitReached(ch: Channel): boolean {
    // ★사용자 지시(2026-08-21): "한도 상관없이 새로운 게 기준에 도달하면 뿌려."
    //   그래서 `dailyLimit <= 0` 이면 **하루 한도를 안 본다.**
    //   다만 유튜브 API 할당량은 남겨 둔다 — 그건 우리가 정한 규칙이 아니라
    //   넘기면 업로드가 **실패하는** 바깥의 한계다(무시하면 조용히 안 올라간다).
    if (ch.dailyLimit > 0 && this.todayCount(ch.id) >= ch.dailyLimit) return true;
    return this.quotaOf(ch).left < UPLOAD_COST;
  }

  /* ----------------------------------------- 훑기 */

  async scan() {
    const alive = new Set<string>();
    for (const { folder, ch } of this.scanTargets()) {
      let entries: Deno.DirEntry[] = [];
      try {
        entries = [];
        for await (const e of Deno.readDir(folder)) entries.push(e);
      } catch { continue; }        // 폴더가 없으면 다음 tick 에서 다시 만든다

      for (const e of entries) {
        if (!e.isFile || !isVideoFile(e.name)) continue;
        const path = join(folder, e.name);
        let size = 0;
        try { size = (await Deno.stat(path)).size; } catch { continue; }

        const key = `${ch.id}|${e.name}`;
        // '그대로 두기' 로 이미 올린 파일은 다시 올리지 않는다
        if (this.state.kept[key] === size) continue;
        alive.add(key);

        let p = this.pending.get(key);
        if (!p) {
          // 쪽지는 영상을 **처음 본 그때 한 번만** 읽는다. 훑기는 5초마다 도는데
          // 매번 읽으면 파일을 쓸데없이 두드린다.
          const 쪽지 = await readSidecar(path);
          if (쪽지) await log(`   📝 쪽지를 찾았습니다: ${stem(e.name)}.json`);
          p = {
            key, channelId: ch.id, channelName: ch.name,
            name: e.name, path, size,
            title: (쪽지?.title ??
              `${ch.titlePrefix}${stem(e.name)}${ch.titleSuffix}`).slice(0, 100),
            description: 쪽지?.description ?? ch.description,
            stable: 0, status: "watching", progress: 0, sent: 0,
            error: "", helpUrl: "", videoId: "", verified: false,
            detectedAt: Date.now(), retryAt: 0, tries: 0, sidecar: 쪽지,
            hash: "", dup: "", forced: false, publishAt: "",
          };
          this.pending.set(key, p);
          await log(`🎬 [${ch.name}] 새 영상 감지: ${e.name}`);
        }
        p.path = path;
        p.channelName = ch.name;
        if (p.status === "uploading" || p.status === "done") continue;
        if (p.size === size && size > 0) p.stable++;
        else { p.size = size; p.stable = 0; }
        if (p.status !== "error" && p.stable >= this.cfg.stableChecks) p.status = "ready";
      }
    }

    for (const [key, p] of this.pending) {
      if (!alive.has(key) && p.status !== "uploading" && p.status !== "done") {
        this.pending.delete(key);
      }
    }
  }

  /** 모든채널 폴더에 들어온 영상 목록. 자동으로 뿌리지 않고 사용자가 고를 때까지 기다린다. */
  staged: { name: string; path: string; size: number; ready: boolean; at: number }[] = [];

  /** 모든채널 폴더를 훑어 '보낼 수 있는 영상' 목록을 갱신한다. */
  async scanBroadcast() {
    if (!this.useBroadcast()) { this.staged = []; return; }
    const dir = this.broadcastDir();
    const list: typeof this.staged = [];
    const alive = new Set<string>();

    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isFile || !isVideoFile(e.name)) continue;
        const path = join(dir, e.name);
        let size = 0;
        try { size = (await Deno.stat(path)).size; } catch { continue; }
        alive.add(e.name);

        const prev = this.fanSeen.get(e.name);
        if (prev && prev.size === size && size > 0) prev.count++;
        else this.fanSeen.set(e.name, { size, count: 0 });
        const cnt = this.fanSeen.get(e.name)?.count ?? 0;

        const known = this.staged.find((x) => x.name === e.name);
        if (!known) await log(`📥 [모든채널] 대기: ${e.name} — 화면에서 보낼 채널을 골라주세요`);
        list.push({ name: e.name, path, size, ready: cnt >= this.cfg.stableChecks, at: known?.at ?? Date.now() });
      }
    } catch { /* 폴더가 없으면 다음에 만든다 */ }

    for (const name of [...this.fanSeen.keys()]) if (!alive.has(name)) this.fanSeen.delete(name);
    this.staged = list.sort((a, b) => a.at - b.at);
  }

  /** 고른 영상을 고른 채널들로 보낸다. 원본은 모든채널/_완료 에 보관한다. */
  async sendBroadcast(names: string[], channelIds: string[]): Promise<{ sent: string[]; failed: string[] }> {
    const targets = channelIds.length
      ? this.channels().filter((c) => channelIds.includes(c.id))
      : this.channels();
    const sent: string[] = [], failed: string[] = [];
    if (!targets.length) return { sent, failed: names };

    for (const name of names) {
      const item = this.staged.find((x) => x.name === name);
      if (!item) { failed.push(name); continue; }
      const done: string[] = [];
      for (const ch of targets) {
        try {
          await Deno.mkdir(ch.folder, { recursive: true });
          let dest = join(ch.folder, name);
          let i = 1;
          while (await fileExists(dest)) dest = join(ch.folder, `${stem(name)} (${i++})${ext(name)}`);
          const part = dest + ".part";
          await Deno.copyFile(item.path, part);
          await Deno.rename(part, dest);
          done.push(ch.name);
        } catch (e) {
          await log(`   ⚠️  [${ch.name}] 복사 실패: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (!done.length) { failed.push(name); continue; }
      try {
        const keep = join(this.broadcastDir(), DONE_DIR);
        await Deno.mkdir(keep, { recursive: true });
        let dest = join(keep, name);
        let i = 1;
        while (await fileExists(dest)) dest = join(keep, `${stem(name)} (${i++})${ext(name)}`);
        await Deno.rename(item.path, dest);
      } catch (e) {
        await log(`   ⚠️  원본 보관 실패: ${e instanceof Error ? e.message : e}`);
      }
      this.fanSeen.delete(name);
      sent.push(name);
      await log(`📤 [모든채널] ${name} → ${done.join(", ")} (${done.length}개 채널)`);
    }
    await this.scanBroadcast();
    return { sent, failed };
  }

  /** 고른 영상을 보내지 않고 치운다 */
  async holdBroadcast(names: string[]) {
    for (const name of names) {
      const item = this.staged.find((x) => x.name === name);
      if (!item) continue;
      try {
        const keep = join(this.broadcastDir(), HOLD_DIR);
        await Deno.mkdir(keep, { recursive: true });
        let dest = join(keep, name);
        let i = 1;
        while (await fileExists(dest)) dest = join(keep, `${stem(name)} (${i++})${ext(name)}`);
        await Deno.rename(item.path, dest);
        this.fanSeen.delete(name);
        await log(`⏸  [모든채널] 보류: ${name}`);
      } catch (e) {
        await log(`   ⚠️  보류 실패: ${e instanceof Error ? e.message : e}`);
      }
    }
    await this.scanBroadcast();
  }

  meta(p: Pending, ch: Channel): VideoMeta {
    // 쪽지에 적힌 것이 채널 기본값을 덮는다. 안 적힌 것은 그대로 채널 것을 쓴다.
    const s = p.sidecar;
    return {
      title: p.title,
      description: p.description,
      // 쪽지 > 채널이 걸어 둔 태그 > AI 가 지은 태그. 채널 태그를 비워 둔 사람만 AI 것을 쓴다.
      tags: s?.tags ?? (ch.tags.length ? ch.tags : (p.aiTags ?? ch.tags)),
      categoryId: s?.categoryId ?? ch.categoryId,
      language: s?.language ?? ch.language,
      madeForKids: s?.madeForKids ?? ch.madeForKids,
      notifySubscribers: s?.notifySubscribers ?? ch.notifySubscribers,
      // 쪽지에 적힌 예약이 먼저다. 안 적혀 있을 때만 슬롯이 잡아 준 자리를 쓴다.
      publishAt: s?.publishAt ?? (p.publishAt || undefined),
      // 예약이 걸리면 반드시 비공개여야 한다 — 공개로 올리면 유튜브가 예약을 통째로
      // 무시하고 바로 띄운다. buildBody 가 한 번 더 거르지만 여기서도 맞춰 준다.
      privacy: (s?.publishAt || p.publishAt) ? "private" : (s?.privacy ?? ch.privacy),
    };
  }

  /* ----------------------------------------- 업로드 */

  async uploadOne(p: Pending): Promise<void> {
    if (this.uploadingKey) return;
    const ch = this.channelById(p.channelId);
    if (!ch) { this.pending.delete(p.key); return; }

    this.uploadingKey = p.key;
    p.retryAt = 0;
    p.status = "uploading";
    p.progress = 0;
    p.error = "";
    await log(`📤 [${ch.name}] 업로드 시작: ${p.name} (${fmtSize(p.size)})`);

    try {
      // ★쪽지를 **올리기 직전에 한 번 더** 본다.
      //   영상을 먼저 떨구고 쪽지를 나중에 만드는 흐름이 있다(설명을 뽑는 데 시간이
      //   걸린다). 처음 봤을 때 없었다고 그대로 두면 채널 기본값으로 올라가 버린다.
      if (!p.sidecar) {
        p.sidecar = await readSidecar(p.path);
        if (p.sidecar) {
          await log(`   📝 쪽지를 뒤늦게 찾았습니다: ${stem(p.name)}.json`);
          if (p.sidecar.title) p.title = p.sidecar.title.slice(0, 100);
          if (p.sidecar.description) p.description = p.sidecar.description;
        }
      }
      /* ── 영상을 보고 제목·설명을 지어 본다 (선택 기능, 사용자 지시 2026-08-28) ──
         ★순서가 중요하다 — **중복 검사보다 먼저** 짓는다. 중복은 제목으로 가리므로,
           파일 이름으로 견주고 나서 제목을 바꾸면 검사가 헛돈다.
         ★사람이 고친 것·쪽지에 적힌 것이 이긴다. 못 지어도 그냥 넘어간다. */
      if (this.cfg.aiTitles && this.cfg.aiKey && !p.sidecar?.title && !p.titleEdited) {
        const 지음 = await 메타지어보기(p.path, {
          키: this.cfg.aiKey, 모델: this.cfg.aiModel,
          채널: ch.name, 안내: ch.description,
        });
        if (지음) {
          p.title = `${ch.titlePrefix}${지음.title}${ch.titleSuffix}`.slice(0, 100);
          if (!p.sidecar?.description && !p.descEdited) p.description = 지음.description;
          if (지음.tags.length && !p.sidecar?.tags?.length) p.aiTags = 지음.tags;
        }
      }

      /* ── 같은 편을 두 번 올리는 것을 막는다 (H-187) ──────────────
         ★올리기 **직전**에 본다. 훑을 때 보면 그 사이에 다른 편이 올라가 판이
           달라질 수 있다. 여기가 마지막 관문이다. */
      if (ch.dupGuard && !p.forced) {
        try {
          if (!p.hash) p.hash = await fileFingerprint(p.path);
        } catch { /* 지문을 못 내면 제목만으로 본다 */ }
        const 겹침 = findDuplicate(this.state.uploads, {
          channelId: ch.id, hash: p.hash, title: p.title,
          // 접두·접미는 파일 이름에서 딴 제목에만 붙는다 — 견주기 전에 양쪽에서 뗀다
          titlePrefix: ch.titlePrefix, titleSuffix: ch.titleSuffix,
        });
        // ★승인된 수정본 (H-241) — 판정 결과는 그대로 쓰고 **해석만** 여기서 한다.
        //   why:"file"(같은 파일)은 예외 없이 세운다. why:"title"(제목만 같음)일 때만, 쪽지의
        //   승인 표식(review.approve · finalOk · 해시)이 **현재 파일의 전체 sha256** 과 맞으면
        //   지나간다. 그 한 갈래에서만 전체 해시를 한 번 낸다. 나머지는 전부 현행(사람 확인).
        if (겹침 && 겹침.why === "title" && await 승인된수정본인가(p.sidecar, p.path)) {
          await log(`✅ [${ch.name}] 승인된 수정본 — 동일 제목의 이전 기록(${겹침.rec.id})은 있으나 `
            + `review.approve 표식 + 현재 파일 해시 일치 확인: ${p.name}`);
        } else if (겹침) {
          p.status = "error";
          p.dup = dupMessage(겹침);
          p.error = p.dup;
          p.retryAt = 0;                       // 저절로 다시 시도하지 않는다
          this.uploadingKey = "";
          // ★두 제목을 다 남긴다 — 잘못 세웠다는 신고가 오면 이 줄이 유일한 증거다
          await log(`🛑 [${ch.name}] 중복이라 세웠습니다: ${p.name} — ${p.dup}`);
          await log(`   견준 것: 이번 「${p.title}」 ↔ 먼저 올린 「${겹침.rec.title}」 (${겹침.why})`);
          if (this.cfg.notifications) {
            await notify("가라사대 업로더 🛑", `[${ch.name}] 같은 편이 이미 올라가 있습니다`);
          }
          return;
        }
      }

      /* ── 공개 시각 나누기 ────────────────────────────────────
         쪽지에 적힌 예약이 있으면 그것을 쓴다. 없고 채널에 슬롯이 적혀 있을 때만
         빈 자리를 물린다. 슬롯이 비어 있으면(기본값) 아무 일도 안 한다. */
      if (!p.sidecar?.publishAt && ch.publishSlots.length) {
        const 찬자리 = this.state.uploads
          .filter((u) => u.channelId === ch.id && u.publishAt)
          .map((u) => u.publishAt!);
        const 자리 = nextSlot(ch.publishSlots, 찬자리);
        if (자리) {
          p.publishAt = 자리;
          await log(`   ⏰ 공개 자리를 잡았습니다: ${슬롯말(자리)}`);
        } else {
          await log(`   ⚠️  공개 자리를 못 잡았습니다(3주 안이 다 찼습니다) — 예약 없이 올립니다`);
        }
      }

      // 올리는 동안은 맥이 잠들지 않게 붙든다
      잠깨워두기();

      // 올리기 직전에 채널이 맞는지 본다 — 1점, 잘못 올라가면 되돌릴 수 없다
      await assertSameChannel(this.cfg, ch);
      this.addQuota(ch, 1);

      const res = await uploadVideo(this.cfg, ch, p.path, this.meta(p, ch), (sent, total) => {
        p.sent = sent;
        p.progress = total ? Math.round((sent / total) * 100) : 0;
      });
      p.videoId = res.id;
      p.status = "done";
      p.progress = 100;
      this.blocks.delete(ch.id);
      this.addQuota(ch, UPLOAD_COST);
      delete this.state.failed[p.key];
      this.state.uploads.unshift({
        id: res.id,
        title: res.snippet?.title ?? p.title,
        file: p.name,
        size: p.size,
        privacy: res.status?.privacyStatus ?? ch.privacy,
        at: localStamp(),
        channelId: ch.id,
        channelName: ch.name,
        verified: false,
        hash: p.hash,
        publishAt: p.sidecar?.publishAt ?? (p.publishAt || undefined),
      });
      this.state.uploads = this.state.uploads.slice(0, 500);
      await saveState(this.state);
      await log(`✅ [${ch.name}] 완료: ${p.name} → https://youtu.be/${res.id}`);
      if (p.sidecar?.publishAt) {
        await log(`   ⏰ ${new Date(p.sidecar.publishAt).toLocaleString()} 에 저절로 공개됩니다`);
      }

      // 쪽지에 썸네일 그림이 적혀 있으면 얹는다. 실패해도 업로드는 이미 끝난 것이다.
      if (p.sidecar?.thumbnail) {
        const 그림자리 = thumbPath(p.path, p.sidecar.thumbnail);
        const t = await setThumbnail(this.cfg, ch, res.id, 그림자리);
        this.addQuota(ch, THUMB_COST);
        await log(t.ok ? `   🖼  썸네일을 얹었습니다` : `   ⚠️  ${t.message}`);
      }
      await this.뒷일걸기(p, ch, res.id);
      if (this.cfg.notifications) await notify("가라사대 업로더 ✅", `[${ch.name}] ${p.title} 업로드 완료`);

      // 유튜브에 실제로 올라갔는지 확인한 뒤에야 원본을 처리한다
      const v = await verifyVideo(this.cfg, ch, res.id);
      p.verified = v.ok;
      this.addQuota(ch, 1);
      if (this.state.uploads[0]?.id === res.id) this.state.uploads[0].verified = v.ok;
      await saveState(this.state);

      if (v.ok) {
        await log(`   🔎 유튜브 확인됨 (${v.status})`);
        await this.disposeDone(p, ch);
        if (ch.studioAfter === "always") {
          await openUrl(studioEditorUrl(res.id), this.cfg.browser);
          await log(`   🎬 스튜디오 편집기를 열었습니다`);
        } else if (ch.studioAfter === "ask") {
          this.ask = { id: res.id, title: p.title, channelName: ch.name };
          if (Date.now() - this.lastSeen > 15_000) {
            const 밑 = `http://127.0.0.1:${this.cfg.port}`;
            if (!await 쓰던탭에다시(밑, 밑, this.cfg.browser)) {
              await openUrl(밑, this.cfg.browser);
            }
            await log(`   💬 음악을 넣을지 묻기 위해 화면을 열었습니다`);
          }
        }
      } else {
        await log(`   ⚠️  ${v.message} — 원본을 지우지 않고 ${DONE_DIR} 폴더에 보관합니다`);
        p.error = `${v.message} 원본 파일은 ${DONE_DIR} 폴더에 그대로 두었습니다.`;
        await this.moveTo(p, DONE_DIR);
        if (this.cfg.notifications) {
          await notify("가라사대 업로더 ⚠️", "유튜브 확인 실패 — 원본을 보관했습니다");
        }
      }
      setTimeout(() => this.pending.delete(p.key), 60_000);
    } catch (e) {
      const err = e instanceof UploadError ? e : new UploadError(e instanceof Error ? e.message : String(e));
      const kind: ErrKind = err.kind;
      p.status = "error";
      p.error = err.message;
      p.helpUrl = err.helpUrl;
      this.lastError = `[${ch.name}] ${err.message}`;

      if (kind === "config" || kind === "quota") {
        this.blocks.set(ch.id, { message: err.message, url: err.helpUrl });
        p.retryAt = Date.now() + (kind === "quota" ? 60 * 60_000 : 3 * 60_000);
        await log(`⛔ [${ch.name}] ${p.name} → ${err.message}`);
        if (this.cfg.notifications) await notify("가라사대 업로더 ⛔", `[${ch.name}] ${err.message.slice(0, 100)}`);
      } else if (kind === "temporary") {
        p.tries++;
        // ★여태 '잠깐 오류' 는 **끝없이** 다시 시도했다. 되는 날도 있지만, 안 되는
        //   것이면 그 한 편이 대기열 맨 앞에 눌러앉아 뒤엣것을 계속 막는다.
        //   열 번(대략 한 시간 반)이면 잠깐이 아니다 — 치우고 다음으로 넘어간다.
        if (p.tries >= 10) {
          await log(`⏸  [${ch.name}] ${p.name} → 열 번을 시도해도 안 됩니다(${err.message}) — ${HOLD_DIR} 로 치웁니다`);
          await this.moveTo(p, HOLD_DIR);
          this.pending.delete(p.key);
          if (this.cfg.notifications) {
            await notify("가라사대 업로더 ⏸", `[${ch.name}] ${p.name} — 계속 실패해 ${HOLD_DIR} 로 옮겼습니다`);
          }
        } else {
          const wait = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(p.tries - 1, 4));
          p.retryAt = Date.now() + wait;
          await log(`⏳ [${ch.name}] ${p.name} → ${err.message} (${Math.round(wait / 1000)}초 후 재시도, ${p.tries}/10)`);
        }
      } else {
        p.tries++;
        this.state.failed[p.key] = p.tries;
        await saveState(this.state);
        await log(`❌ [${ch.name}] 실패(${p.tries}/3) ${p.name} → ${err.message}`);
        if (p.tries >= 3) {
          await this.moveTo(p, FAIL_DIR);
          this.pending.delete(p.key);
          if (this.cfg.notifications) await notify("가라사대 업로더 ❌", `[${ch.name}] ${p.name} 업로드 실패`);
        } else {
          p.retryAt = Date.now() + 30_000 * p.tries;
        }
      }
    } finally {
      this.uploadingKey = "";
      잠깨우기끝();
    }
  }

  /** 올린 뒤에 할 일(첫 댓글·제목 갈아끼우기)을 장부에 걸어 둔다.
   *
   * ★여기서 바로 하지 않는다. 첫 댓글은 영상이 처리되기 전에 달면 실패하고,
   *   제목 갈아끼우기는 애초에 몇 시간 뒤의 일이다. 장부에 적어 두고 `뒷일하기`
   *   가 때가 되면 꺼내 쓴다 — 프로그램을 껐다 켜도 남는다.
   * ★권한(force-ssl)이 없으면 걸지 않는다. 걸어 봐야 403 만 쌓인다. */
  async 뒷일걸기(p: Pending, ch: Channel, videoId: string) {
    if (!고급기능켰나(ch)) return;
    if (!await 고급권한있나(ch.id)) {
      await log(`   ⚠️  [${ch.name}] 첫 댓글·제목 갈아끼우기 권한이 없습니다 — 채널 탭에서 다시 연결해 주세요`);
      return;
    }
    // 예약이 걸렸으면 **뜨는 때**를 기준으로 센다 — 아직 비공개인 영상에
    // 댓글을 달아 봐야 아무도 못 본다.
    const 기준 = Date.parse(p.publishAt || p.sidecar?.publishAt || "") || Date.now();

    /* ★쪽지에 적힌 것이 먼저고, 없으면 채널에 적어 둔 틀을 쓴다 (2026-08-22).
       여태는 **쪽지에 적어야만** 됐다. 켜 놓고도 아무 일이 없어 안 되는 줄 알았다는
       말이 나와, 늘 같은 말을 다는 채널은 한 번만 적어 두면 되게 했다. */
    const 댓글 = p.sidecar?.firstComment || 틀채우기(ch.firstCommentText, p.title);
    if (ch.firstComment && 댓글) {
      this.state.jobs.push({
        kind: "comment", videoId, channelId: ch.id,
        at: 기준 + 3 * 60_000,                 // 처리될 틈을 3분 준다
        text: 댓글, tries: 0,
      });
      await log(`   💬 첫 댓글을 걸어 두었습니다${p.sidecar?.firstComment ? "" : " (채널 기본값)"}`);
    }
    const 새제목 = p.sidecar?.titleB || 틀채우기(ch.retitleTemplate, p.title);
    if (ch.retitleHours > 0 && 새제목) {
      this.state.jobs.push({
        kind: "retitle", videoId, channelId: ch.id,
        at: 기준 + ch.retitleHours * 3600_000,
        text: 새제목.slice(0, 100), tries: 0,
      });
      await log(`   ✏️  ${ch.retitleHours}시간 뒤 제목을 갈아끼웁니다: ${새제목}`);
    }
    await saveState(this.state);
  }

  /** 때가 된 뒷일을 하나씩 해치운다. 한 번에 하나만 — 서둘 일이 아니다. */
  async 뒷일하기() {
    const 지금 = Date.now();
    const i = this.state.jobs.findIndex((j) => j.at <= 지금);
    if (i < 0) return;
    const job: Job = this.state.jobs[i];
    const ch = this.channelById(job.channelId);
    if (!ch) { this.state.jobs.splice(i, 1); await saveState(this.state); return; }

    let ok = false, msg = "";
    try {
      if (job.kind === "comment") {
        const r = await insertComment(this.cfg, ch, job.videoId, job.text);
        ok = r.ok; msg = r.message;
        if (ok) await log(`💬 [${ch.name}] 첫 댓글을 달았습니다 — 고정은 스튜디오에서 손으로 눌러야 합니다`);
      } else {
        const r = await updateVideoTitle(this.cfg, ch, job.videoId, job.text);
        ok = r.ok; msg = r.message;
        if (ok) {
          await log(`✏️  [${ch.name}] 제목을 갈아끼웠습니다: ${r.before} → ${job.text}`);
          const u = this.state.uploads.find((x) => x.id === job.videoId);
          if (u) {
            /* ★바꾼 순간을 찍어 둔다 — 이것이 있어야 앞뒤를 갈라 견줄 수 있다.
               조회수는 마지막으로 잰 값을 쓴다(성적은 한 시간마다 잰다). */
            u.titleA = r.before || u.title;
            u.retitledAt = Date.now();
            u.viewsAtRetitle = this.state.stats[job.videoId]?.views ?? 0;
            u.title = job.text;
          }
        }
      }
      this.addQuota(ch, WRITE_COST);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }

    if (ok) {
      this.state.jobs.splice(i, 1);
    } else {
      job.tries++;
      if (job.tries >= 3) {
        this.state.jobs.splice(i, 1);
        await log(`⚠️  [${ch.name}] ${job.kind === "comment" ? "첫 댓글을" : "제목 갈아끼우기를"} 접습니다 — ${msg}`);
        if (this.cfg.notifications) {
          await notify("가라사대 업로더 ⚠️", `${job.kind === "comment" ? "첫 댓글" : "제목 바꾸기"} 실패 — ${msg.slice(0, 80)}`);
        }
      } else {
        job.at = 지금 + 30 * 60_000;
        await log(`   ⏳ ${job.kind === "comment" ? "첫 댓글을" : "제목 갈아끼우기를"} 30분 뒤 다시 해 봅니다 (${msg})`);
      }
    }
    await saveState(this.state);
  }

  /** 업로드에 성공한 파일을 채널 설정에 따라 처리한다. */
  /** 영상을 치울 때 쪽지도 같은 운명으로 보낸다.
   *  ★안 지우면 폴더에 쪽지만 남고, 나중에 같은 이름의 다른 영상에 잘못 붙는다. */
  async disposeSidecar(p: Pending, mode: string) {
    if (!p.sidecar) return;
    const 자리 = sidecarPath(p.path);
    try {
      if (mode === "trash") {
        if (!await moveToTrash(자리)) await Deno.remove(자리);
      } else if (mode === "delete") {
        await Deno.remove(자리);
      } else {
        const parent = 자리.slice(0, Math.max(자리.lastIndexOf("/"), 자리.lastIndexOf("\\")));
        const target = join(parent, DONE_DIR);
        await Deno.mkdir(target, { recursive: true });
        await Deno.rename(자리, join(target, 자리.slice(parent.length + 1)));
      }
    } catch { /* 쪽지 처리는 덤이다 — 여기서 막혀도 업로드는 끝난 것으로 둔다 */ }
  }

  async disposeDone(p: Pending, ch: Channel) {
    const mode = ch.afterUpload;
    await this.disposeSidecar(p, mode);
    if (mode === "keep") {
      this.state.kept[p.key] = p.size;
      await saveState(this.state);
      return;
    }
    if (mode === "trash") {
      const ok = await moveToTrash(p.path);
      await log(ok ? `   🗑  휴지통으로 보냈습니다: ${p.name}` : `   ⚠️  휴지통 실패 — ${DONE_DIR} 폴더로 옮깁니다`);
      if (!ok) await this.moveTo(p, DONE_DIR);
      return;
    }
    if (mode === "delete") {
      try {
        await Deno.remove(p.path);
        await log(`   ❎ 파일을 삭제했습니다: ${p.name}`);
      } catch (e) {
        await log(`   ⚠️  삭제 실패 (${e instanceof Error ? e.message : e}) — ${DONE_DIR} 폴더로 옮깁니다`);
        await this.moveTo(p, DONE_DIR);
      }
      return;
    }
    await this.moveTo(p, DONE_DIR);
  }

  async moveTo(p: Pending, dir: string) {
    try {
      const parent = p.path.slice(0, Math.max(p.path.lastIndexOf("/"), p.path.lastIndexOf("\\")));
      const target = join(parent, dir);
      await Deno.mkdir(target, { recursive: true });
      let dest = join(target, p.name);
      let i = 1;
      while (await fileExists(dest)) dest = join(target, `${stem(p.name)} (${i++})${ext(p.name)}`);
      await Deno.rename(p.path, dest);
    } catch (e) {
      await log(`   ⚠️  파일 이동 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

/** 로그인이 살아 있는지 미리 확인한다.
   *
   * 동의 화면을 게시하지 않으면 7일마다 풀리는데, 지금까지는 **올리려다 실패해야** 알았다.
   * 채널이 여러 개면 그중 하나가 조용히 풀려 있어도 모르고 지나간다.
   * 토큰 갱신은 유튜브 사용량을 쓰지 않으므로 하루 한도와 무관하다.
   */
  async checkLogins(force = false) {
    const EVERY = 6 * 60 * 60_000;
    if (!force && Date.now() - this.lastLoginCheck < EVERY) return;
    this.lastLoginCheck = Date.now();

    for (const ch of this.channels()) {
      if (!(await loadTokens(ch.id))) continue;          // 아직 연결 안 한 채널
      try {
        await accessToken(this.cfg, ch);
        if (this.loginAlerts.delete(ch.id)) await log(`🔑 [${ch.name}] 로그인이 되살아났습니다`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (this.loginAlerts.get(ch.id) === msg) continue;   // 같은 까닭으로 두 번 알리지 않는다
        this.loginAlerts.set(ch.id, msg);
        await log(`🔑 [${ch.name}] 로그인이 풀렸습니다 — ${msg}`);
        if (this.cfg.notifications) {
          await notify("가라사대 업로더 🔑", `[${ch.name}] 로그인이 풀렸습니다. 다시 연결해 주세요`);
        }
      }
    }
  }

  /** 중복이라 세워 둔 것을 사용자가 그래도 올리겠다고 할 때. */
  force(key: string): boolean {
    const p = this.pending.get(key);
    if (!p || p.status === "uploading") return false;
    p.forced = true;
    p.dup = "";
    p.error = "";
    p.status = "ready";
    p.retryAt = 0;
    p.tries = 0;
    return true;
  }

    async hold(key: string) {
    const p = this.pending.get(key);
    if (!p || p.status === "uploading") return false;
    await this.moveTo(p, HOLD_DIR);
    this.pending.delete(key);
    await log(`⏸  보류: ${p.name}`);
    return true;
  }

  /* ----------------------------------------- 순환 */

  /** 올릴 수 있는 다음 영상 하나를 고른다. 채널을 돌아가며 골라 한 채널이 독차지하지 않게 한다. */
  private async pickNext(): Promise<Pending | null> {
    const chans = this.channels();
    if (!chans.length) return null;
    const now = Date.now();
    for (let i = 0; i < chans.length; i++) {
      const ch = chans[(this.rotate + i) % chans.length];
      if (this.limitReached(ch)) continue;
      if (!(await loadTokens(ch.id))) continue;         // 아직 연결 안 된 채널은 건너뛴다
      const items = [...this.pending.values()].filter((p) => p.channelId === ch.id);
      const ready = items.find((p) =>
        p.status === "ready" || (p.status === "error" && p.retryAt > 0 && p.retryAt <= now)
      );
      if (!ready) continue;
      if (ch.reviewMode && ready.status === "ready") continue;   // 검토 모드
      this.rotate = (this.rotate + i + 1) % chans.length;
      return ready;
    }
    return null;
  }

  async tick() {
    try {
      await this.ensureDirs();
      await this.scanBroadcast();
      await this.scan();
      await this.checkLogins();
      if (this.paused || this.uploadingKey) return;
      const next = await this.pickNext();
      if (next) { await this.uploadOne(next); return; }
      // 올릴 것이 없을 때만 뒷일을 본다 — 올리는 쪽이 언제나 먼저다
      await this.뒷일하기();
      await this.성적재기();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      await log(`⚠️  감시 오류: ${this.lastError}`);
    }
  }

  async loop() {
    this.running = true;
    const names = this.channels().map((c) => c.name).join(", ") || "(등록된 채널 없음)";
    await log(`👀 감시 시작 · 채널 ${this.channels().length}개: ${names}`);
    const warned = new Set<string>();
    while (!this.stop) {
      await this.tick();
      for (const ch of this.channels()) {
        if (this.limitReached(ch)) {
          if (!warned.has(ch.id)) {
            warned.add(ch.id);
            await log(`⏸  [${ch.name}] 오늘 업로드 한도에 도달했습니다. 내일 자동 재개됩니다.`);
            if (this.cfg.notifications) await notify("가라사대 업로더 ⏸", `[${ch.name}] 오늘 한도 도달`);
          }
        } else warned.delete(ch.id);
      }
      await new Promise((r) => setTimeout(r, Math.max(2, this.cfg.pollSeconds) * 1000));
    }
    this.running = false;
  }

  halt() { this.stop = true; }

  /* ----------------------------------------- 성적 */

  /** 성적을 얼마 만에 다시 잴까. 1점짜리라 자주 물어도 되지만, 조회수가 분 단위로
   *  달라지는 것도 아니다. */
  private static 성적간격 = 60 * 60_000;
  성적재는중 = false;

  async 성적재기(force = false) {
    if (this.성적재는중) return;
    if (!force && Date.now() - (this.state.statsAt || 0) < Manager.성적간격) return;
    if (!this.state.uploads.length) return;
    this.성적재는중 = true;
    try {
      const r = await refreshStats(this.cfg, this.state, this.channels(), (ch, n) => this.addQuota(ch, n));
      await saveState(this.state);
      if (force || r.잰편수) await log(`📊 성적을 새로 쟀습니다 — ${r.잰편수}편 (${r.점}점)`);
    } finally {
      this.성적재는중 = false;
    }
  }

  /* ----------------------------------------- 화면에 넘길 요약 */

  snapshot() {
    const items = [...this.pending.values()].sort((a, b) => a.detectedAt - b.detectedAt);
    const chans = this.cfg.channels.map((ch) => {
      const q = this.quotaOf(ch);
      const block = this.blocks.get(ch.id);
      return {
        id: ch.id,
        name: ch.name,
        folder: ch.folder,
        enabled: ch.enabled,
        sharesWith: ch.sharesWith,
        hasCreds: !!credsOf(this.cfg, ch).clientId,
        todayCount: this.todayCount(ch.id),
        dailyLimit: ch.dailyLimit,
        quotaUsed: q.used,
        quotaLeft: q.left,
        quotaResetAt: quotaResetAt(),          // 할당량이 다시 차오르는 때
        quotaDate: quotaDate(),
        capacityLeft: Math.max(0, ch.dailyLimit > 0
          ? Math.min(ch.dailyLimit - this.todayCount(ch.id), Math.floor(q.left / UPLOAD_COST))
          : Math.floor(q.left / UPLOAD_COST)),   // 0 = 하루 한도 없음
        limitReached: this.limitReached(ch),
        waiting: items.filter((p) => p.channelId === ch.id && p.status !== "done").length,
        blocked: block?.message ?? "",
        blockedUrl: block?.url ?? "",
        privacy: ch.privacy,
        afterUpload: ch.afterUpload,
        studioAfter: ch.studioAfter,
        reviewMode: ch.reviewMode,
      };
    });
    return {
      items,
      channels: chans,
      broadcastDir: this.useBroadcast() ? this.broadcastDir() : "",
      staged: this.staged,
      uploading: !!this.uploadingKey,
      running: this.running,
      paused: this.paused,
      ask: this.ask,
      loginAlerts: [...this.loginAlerts].map(([id, message]) => ({
        id, name: this.channelById(id)?.name ?? "", message,
      })),
      lastError: this.lastError,
      todayCount: this.todayCount(),
      /* ★공개 상태는 **지금 유튜브가 아는 값**으로 보인다 (2026-08-24).
         올릴 때 값만 적어 두고 안 바꿔서, 비공개로 올린 뒤 손으로 공개한 편이
         계속 「비공개」로 보였다. 성적을 잴 때 받아 온 값이 있으면 그것을 쓴다. */
      uploads: this.state.uploads.slice(0, 60).map((u) => ({
        ...u, privacy: this.state.stats[u.id]?.privacy || u.privacy,
      })),
      failed: this.state.failed,
      stats: statsRows(this.state).slice(0, 120),
      statsAt: this.state.statsAt,
      statsBusy: this.성적재는중,
      jobs: this.state.jobs.map((j) => ({
        kind: j.kind, videoId: j.videoId, at: j.at, text: j.text.slice(0, 60), tries: j.tries,
      })),
    };
  }
}

function samePath(a: string, b: string) {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
async function fileExists(p: string) {
  try { await Deno.stat(p); return true; } catch { return false; }
}
export function fmtSize(n: number): string {
  return n > 1073741824 ? (n / 1073741824).toFixed(2) + "GB" : (n / 1048576).toFixed(1) + "MB";
}
export { IS_WIN, safeFolderName, SUB_DIRS };

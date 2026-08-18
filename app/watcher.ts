// 폴더 감시 엔진 — 새 영상을 감지해 안정화되면 업로드한다.
import { Config, IS_WIN, State, join, loadConfig, loadState, loadTokens, log, saveState } from "./paths.ts";
import { DAILY_QUOTA, ErrKind, UPLOAD_COST, UploadError, uploadVideo, VideoMeta } from "./youtube.ts";
import { moveToTrash, notify } from "./platform.ts";

const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".webm", ".mkv", ".flv", ".wmv", ".mpg", ".mpeg", ".mts", ".m2ts",
]);
const SKIP_SUFFIX = [".part", ".crdownload", ".download", ".tmp", ".partial", ".!ut"];
export const DONE_DIR = "_완료";
export const FAIL_DIR = "_실패";
export const HOLD_DIR = "_보류";

export type PendingStatus = "watching" | "ready" | "uploading" | "done" | "error";

export interface Pending {
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
  videoId: string;
  detectedAt: number;
  retryAt: number;      // 이 시각 이후에 다시 시도
  tries: number;
  helpUrl: string;
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

export class Engine {
  cfg!: Config;
  state!: State;
  pending = new Map<string, Pending>();
  running = false;
  uploading = false;
  lastError = "";
  blocked = "";          // 사용자가 구글 설정을 고쳐야 하는 상태
  blockedUrl = "";
  paused = false;
  private stop = false;

  async init() {
    this.cfg = await loadConfig();
    this.state = await loadState();
  }

  async reloadConfig() {
    this.cfg = await loadConfig();
  }

  /** 오늘 올린 개수 */
  todayCount(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.state.uploads.filter((u) => u.at.slice(0, 10) === today).length;
  }

  quotaLeft(): number {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.quotaDate !== today) {
      this.state.quotaDate = today;
      this.state.quotaUsed = 0;
    }
    return DAILY_QUOTA - this.state.quotaUsed;
  }

  limitReached(): boolean {
    return this.todayCount() >= this.cfg.dailyLimit || this.quotaLeft() < UPLOAD_COST;
  }

  snapshot() {
    return {
      items: [...this.pending.values()].sort((a, b) => a.detectedAt - b.detectedAt),
      uploading: this.uploading,
      running: this.running,
      paused: this.paused,
      todayCount: this.todayCount(),
      quotaUsed: this.state.quotaUsed,
      quotaLeft: this.quotaLeft(),
      limitReached: this.limitReached(),
      lastError: this.lastError,
      blocked: this.blocked,
      blockedUrl: this.blockedUrl,
      uploads: this.state.uploads.slice(0, 50),
      failed: this.state.failed,
    };
  }

  async ensureDirs() {
    await Deno.mkdir(this.cfg.watchDir, { recursive: true });
  }

  /** 폴더를 훑어 pending 목록을 갱신한다. 크기가 stableChecks 번 그대로면 ready. */
  async scan() {
    await this.ensureDirs();
    const seenNow = new Set<string>();
    for await (const e of Deno.readDir(this.cfg.watchDir)) {
      if (!e.isFile || !isVideoFile(e.name)) continue;
      const path = join(this.cfg.watchDir, e.name);
      let size = 0;
      try { size = (await Deno.stat(path)).size; } catch { continue; }

      // '그대로 두기' 로 이미 올린 파일이면 다시 올리지 않는다
      if (this.state.kept[e.name] === size) continue;
      seenNow.add(e.name);

      let p = this.pending.get(e.name);
      if (!p) {
        p = {
          name: e.name, path, size,
          title: this.decorate(stem(e.name)).slice(0, 100),
          description: this.cfg.description,
          stable: 0, status: "watching", progress: 0, sent: 0,
          error: "", videoId: "", detectedAt: Date.now(),
          retryAt: 0, tries: 0, helpUrl: "",
        };
        this.pending.set(e.name, p);
        await log(`🎬 새 영상 감지: ${e.name}`);
      }
      if (p.status === "uploading" || p.status === "done") continue;
      if (p.size === size && size > 0) p.stable++;
      else { p.size = size; p.stable = 0; }
      if (p.status !== "error" && p.stable >= this.cfg.stableChecks) p.status = "ready";
    }
    // 사라진 파일 정리 (업로드 중인 것은 유지)
    for (const [name, p] of this.pending) {
      if (!seenNow.has(name) && p.status !== "uploading" && p.status !== "done") {
        this.pending.delete(name);
      }
    }
  }

  decorate(base: string): string {
    return `${this.cfg.titlePrefix}${base}${this.cfg.titleSuffix}`;
  }

  meta(p: Pending): VideoMeta {
    return {
      title: p.title,
      description: p.description,
      tags: this.cfg.tags,
      categoryId: this.cfg.categoryId,
      language: this.cfg.language,
      privacy: this.cfg.privacy,
      madeForKids: this.cfg.madeForKids,
      notifySubscribers: this.cfg.notifySubscribers,
    };
  }

  async uploadOne(p: Pending): Promise<void> {
    if (this.uploading) return;
    p.retryAt = 0;
    this.uploading = true;
    p.status = "uploading";
    p.progress = 0;
    p.error = "";
    await log(`📤 업로드 시작: ${p.name} (${fmtSize(p.size)})`);

    try {
      const res = await uploadVideo(this.cfg, p.path, this.meta(p), (sent, total) => {
        p.sent = sent;
        p.progress = total ? Math.round((sent / total) * 100) : 0;
      });
      p.videoId = res.id;
      p.status = "done";
      this.blocked = "";
      this.blockedUrl = "";
      p.progress = 100;
      this.state.quotaUsed += UPLOAD_COST;
      delete this.state.failed[p.name];
      this.state.uploads.unshift({
        id: res.id,
        title: res.snippet?.title ?? p.title,
        file: p.name,
        size: p.size,
        privacy: res.status?.privacyStatus ?? this.cfg.privacy,
        at: new Date().toISOString().slice(0, 19),
      });
      this.state.uploads = this.state.uploads.slice(0, 300);
      await saveState(this.state);
      await log(`✅ 완료: ${p.name} → https://youtu.be/${res.id}`);
      if (this.cfg.notifications) await notify("가라사대 업로더 ✅", `${p.title} 업로드 완료`);
      await this.disposeDone(p);
      setTimeout(() => this.pending.delete(p.name), 60_000);   // 1분간 결과 표시 후 정리
    } catch (e) {
      const err = e instanceof UploadError ? e : new UploadError(e instanceof Error ? e.message : String(e));
      const kind: ErrKind = err.kind;
      p.status = "error";
      p.error = err.message;
      p.helpUrl = err.helpUrl;
      this.lastError = err.message;

      if (kind === "config" || kind === "quota") {
        // 재시도해도 소용없는 상태 — 횟수를 소모하지 않고 파일도 그대로 둔다
        this.blocked = err.message;
        this.blockedUrl = err.helpUrl;
        p.retryAt = Date.now() + (kind === "quota" ? 60 * 60_000 : 3 * 60_000);
        await log(`⛔ ${p.name} → ${err.message}`);
        if (this.cfg.notifications) {
          await notify("가라사대 업로더 ⛔", err.message.slice(0, 120));
        }
      } else if (kind === "temporary") {
        // 잠깐의 문제 — 점점 간격을 늘려가며 계속 시도 (횟수 제한 없음)
        p.tries++;
        const wait = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(p.tries - 1, 4));
        p.retryAt = Date.now() + wait;
        await log(`⏳ ${p.name} → ${err.message} (${Math.round(wait / 1000)}초 후 재시도)`);
      } else {
        // 이 파일 자체의 문제 — 정해진 횟수만 시도하고 _실패 로 옮긴다
        p.tries++;
        this.state.failed[p.name] = p.tries;
        await saveState(this.state);
        await log(`❌ 실패(${p.tries}/${this.cfg.maxRetries}) ${p.name} → ${err.message}`);
        if (p.tries >= this.cfg.maxRetries) {
          await this.moveTo(p, FAIL_DIR);
          this.pending.delete(p.name);
          if (this.cfg.notifications) await notify("가라사대 업로더 ❌", `${p.name} 업로드 실패`);
        } else {
          p.retryAt = Date.now() + 30_000 * p.tries;
        }
      }
    } finally {
      this.uploading = false;
    }
  }

  /** 업로드에 성공한 파일을 설정에 따라 처리한다. */
  async disposeDone(p: Pending) {
    const mode = this.cfg.afterUpload;

    if (mode === "keep") {
      // 그대로 두되, 다시 감지해서 또 올리지 않도록 기록해 둔다
      this.state.kept[p.name] = p.size;
      await saveState(this.state);
      return;
    }
    if (mode === "trash") {
      const ok = await moveToTrash(p.path);
      await log(ok ? `   🗑  휴지통으로 보냈습니다: ${p.name}` : `   ⚠️  휴지통 실패 — _완료 폴더로 옮깁니다`);
      if (!ok) await this.moveTo(p, DONE_DIR);
      return;
    }
    if (mode === "delete") {
      try {
        await Deno.remove(p.path);
        await log(`   ❎ 파일을 삭제했습니다: ${p.name}`);
      } catch (e) {
        await log(`   ⚠️  삭제 실패 (${e instanceof Error ? e.message : e}) — _완료 폴더로 옮깁니다`);
        await this.moveTo(p, DONE_DIR);
      }
      return;
    }
    await this.moveTo(p, DONE_DIR);
  }

  async moveTo(p: Pending, dir: string) {
    try {
      const target = join(this.cfg.watchDir, dir);
      await Deno.mkdir(target, { recursive: true });
      let dest = join(target, p.name);
      let i = 1;
      while (await fileExists(dest)) dest = join(target, `${stem(p.name)} (${i++})${ext(p.name)}`);
      await Deno.rename(p.path, dest);
    } catch (e) {
      await log(`   ⚠️  파일 이동 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** UI에서 보류: 파일을 _보류 폴더로 옮겨 감시 대상에서 제외 */
  async hold(name: string) {
    const p = this.pending.get(name);
    if (!p || p.status === "uploading") return false;
    await this.moveTo(p, HOLD_DIR);
    this.pending.delete(name);
    await log(`⏸  보류: ${name}`);
    return true;
  }

  async tick() {
    try {
      await this.scan();
      if (this.paused || this.uploading) return;
      if (!(await loadTokens())) return;          // 구글 미연결이면 감지만 하고 대기
      if (this.limitReached()) return;
      const now = Date.now();
      const next = [...this.pending.values()].find((p) =>
        (p.status === "ready" || (p.status === "error" && p.retryAt > 0 && p.retryAt <= now))
      );
      if (!next) return;
      if (this.cfg.reviewMode && next.status === "ready") return;   // 검토 모드
      await this.uploadOne(next);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      await log(`⚠️  감시 오류: ${this.lastError}`);
    }
  }

  async loop() {
    this.running = true;
    await log(`👀 감시 시작: ${this.cfg.watchDir} (공개범위 ${this.cfg.privacy}, ${this.cfg.pollSeconds}초 간격)`);
    let warned = false;
    while (!this.stop) {
      await this.tick();
      if (this.limitReached() && !warned) {
        warned = true;
        await log("⏸  오늘 업로드 한도에 도달했습니다. 내일 자동 재개됩니다.");
        if (this.cfg.notifications) await notify("가라사대 업로더 ⏸", "오늘 업로드 한도에 도달했습니다");
      } else if (!this.limitReached()) warned = false;
      await new Promise((r) => setTimeout(r, Math.max(2, this.cfg.pollSeconds) * 1000));
    }
    this.running = false;
  }

  halt() { this.stop = true; }
}

async function fileExists(p: string) {
  try { await Deno.stat(p); return true; } catch { return false; }
}
export function fmtSize(n: number): string {
  return n > 1073741824 ? (n / 1073741824).toFixed(2) + "GB" : (n / 1048576).toFixed(1) + "MB";
}
export { IS_WIN };

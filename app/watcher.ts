// 폴더 감시 엔진 — 채널마다 폴더를 하나씩 지켜보며 자동으로 올린다.
import {
  Channel, Config, IS_WIN, State, credsOf, join, loadConfig, loadState, loadTokens,
  localDate, localStamp, log, projectKey, quotaDate, quotaResetAt, safeFolderName, saveState,
} from "./paths.ts";
import { DAILY_QUOTA, UPLOAD_COST, uploadVideo, verifyVideo, VideoMeta } from "./youtube.ts";
import { ErrKind, UploadError } from "./errors.ts";
import { accessToken, assertSameChannel } from "./auth.ts";
import { moveToTrash, notify, openUrl } from "./platform.ts";

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
    if (this.todayCount(ch.id) >= ch.dailyLimit) return true;
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
          p = {
            key, channelId: ch.id, channelName: ch.name,
            name: e.name, path, size,
            title: `${ch.titlePrefix}${stem(e.name)}${ch.titleSuffix}`.slice(0, 100),
            description: ch.description,
            stable: 0, status: "watching", progress: 0, sent: 0,
            error: "", helpUrl: "", videoId: "", verified: false,
            detectedAt: Date.now(), retryAt: 0, tries: 0,
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
    return {
      title: p.title,
      description: p.description,
      tags: ch.tags,
      categoryId: ch.categoryId,
      language: ch.language,
      privacy: ch.privacy,
      madeForKids: ch.madeForKids,
      notifySubscribers: ch.notifySubscribers,
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
      });
      this.state.uploads = this.state.uploads.slice(0, 500);
      await saveState(this.state);
      await log(`✅ [${ch.name}] 완료: ${p.name} → https://youtu.be/${res.id}`);
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
            await openUrl(`http://127.0.0.1:${this.cfg.port}`, this.cfg.browser);
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
        const wait = Math.min(10 * 60_000, 30_000 * 2 ** Math.min(p.tries - 1, 4));
        p.retryAt = Date.now() + wait;
        await log(`⏳ [${ch.name}] ${p.name} → ${err.message} (${Math.round(wait / 1000)}초 후 재시도)`);
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
    }
  }

  /** 업로드에 성공한 파일을 채널 설정에 따라 처리한다. */
  async disposeDone(p: Pending, ch: Channel) {
    const mode = ch.afterUpload;
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
      if (next) await this.uploadOne(next);
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
        capacityLeft: Math.max(0, Math.min(ch.dailyLimit - this.todayCount(ch.id), Math.floor(q.left / UPLOAD_COST))),
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
      uploads: this.state.uploads.slice(0, 60),
      failed: this.state.failed,
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

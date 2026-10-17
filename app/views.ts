// 화면에 보낼 자료 만들기 — 상태(/api/state) · 영상 벽(/api/inventory) · 기록(/api/records) · 달력. (파이썬: serve.py 의 state·dashboard.gather)
//
// 원칙
//   · **유튜브를 부르지 않는다.** 화면이 1.5초마다 읽는 자료라서, 놀 때는 호출이 0건이어야 한다(저장된 기록·파일만 읽는다).
//   · 무거운 계산(문제 모으기·브리핑·구독 스냅샷)은 잠깐(3~10초) 기억해 두고 쓴다.
//   · 칸 이름과 모양은 API_명세.md 가 진실이다.
import { baseName, dataPath, dirName, expandHome, extOf, isDir, join, readJsonSync, recentLog, stemOf } from "./paths.ts";
import { dateOnly, isoWall, parseInstant, parseNaive, systemZone, instantToWall, wallNow, type Wall } from "./clock.ts";
import { APP_NAME, APP_VERSION } from "./paths.ts";
import { type ChannelConf, type Channels, boundOk, confFor, getMode, isLongChannel, loadChannels, modeFeatures, modeWords, MODE_AGENCY } from "./channels.ts";
import { authErrorOf, canPublish, deviceSecretsPath, loadStore, resolve, secretsPath, type TokenEntry } from "./ytcore.ts";
import { loadProfiles } from "./profile.ts";
import { readLedger, uploadedNames } from "./ledger.ts";
import * as Q from "./queue.ts";
import * as R from "./review.ts";
import * as D from "./daily.ts";
import * as ISS from "./issues.ts";
import * as BR from "./briefing.ts";
import * as QT from "./quota.ts";
import * as PF from "./perf.ts";
import * as SG from "./settings.ts";
import { aiState, metaRecordFor, resolveMeta } from "./ai.ts";
import { check as checkVideo, classify, ledgerRowIsLong, probe, type Kind } from "./shorts.ts";
import { alreadyUploaded, sameChannelKeys } from "./receive.ts";
import { pendingFiles, summary as folderSummary } from "./folders.ts";
import { custom as customThumb, findThumb } from "./thumbs.ts";
import { loadForDetailed } from "./sidecar.ts";
import { findDuplicates, type PickItem } from "./picker.ts";
import { clientState } from "./oauth.ts";
import { lastTick } from "./tick.ts";
import { telegramSummary } from "./notify.ts";
import { inside } from "./safety.ts";
import { migrationHold } from "./hold.ts";

type Obj = Record<string, any>;

/* ============================================================ 잠깐 기억 */

const 기억 = new Map<string, { at: number; v: unknown }>();
/** 같은 열쇠의 계산을 ms 동안 재사용한다 (화면이 1.5초마다 부르는 무거운 계산용) */
export async function memo<T>(key: string, ms: number, f: () => Promise<T>): Promise<T> {
  const 있음 = 기억.get(key);
  const now = Date.now();
  if (있음 && now - 있음.at < ms) return 있음.v as T;
  const v = await f();
  기억.set(key, { at: now, v });
  return v;
}
export function forgetMemo(prefix = "") { for (const k of [...기억.keys()]) if (k.startsWith(prefix)) 기억.delete(k); }

/* ============================================================ 폴더·경로 */

/** 등록된 채널 폴더들(~ 를 푼 것) */
export function channelFolders(chans: Channels = loadChannels()): string[] {
  const out: string[] = [];
  for (const cf of Object.values(chans)) if (cf.folder) out.push(expandHome(cf.folder));
  return out;
}

/** 이 경로가 등록된 채널 폴더 안에 있나 — 영상 재생·문안 고치기·휴지통은 이 안에서만 */
export function underRoots(p: string, chans: Channels = loadChannels()): boolean {
  return channelFolders(chans).some((r) => inside(p, r));
}

/** 이 파일이 어느 채널 폴더에 있나 (별칭). 없으면 null. 같은 폴더를 두 칸이 쓰면 앞 칸. */
export function channelOfFile(file: string, chans: Channels = loadChannels()): string | null {
  let best: [string, number] | null = null;
  for (const [name, cf] of Object.entries(chans)) {
    if (!cf.folder) continue;
    const r = expandHome(cf.folder);
    if (inside(file, r) && (!best || r.length > best[1])) best = [name, r.length];
  }
  return best ? best[0] : null;
}

/* ============================================================ 쿠팡·AI 를 선택 모듈로 읽기 (없어도 화면은 나온다) */

type CoupangMod = typeof import("./coupang.ts");
let 쿠팡캐시: CoupangMod | null | undefined;
export async function coupangMod(): Promise<CoupangMod | null> {
  if (쿠팡캐시 !== undefined) return 쿠팡캐시;
  try { 쿠팡캐시 = await import("./coupang.ts"); } catch { 쿠팡캐시 = null; }
  return 쿠팡캐시;
}

export interface LinkRef { name: string; url: string }
export async function linksOf(file: string): Promise<{ links: LinkRef[]; linkStatus: string; linkWhy: string }> {
  const m = await coupangMod();
  try {
    const r = m?.recordFor(file);
    if (r) return { links: (r.links ?? []).filter((x: LinkRef) => /^https?:\/\//.test(x.url)), linkStatus: r.status, linkWhy: r.status === "건너뜀" ? r.why : "" };
  } catch { /* 기록을 못 읽어도 화면은 나온다 */ }
  return { links: [], linkStatus: "아직", linkWhy: "" };
}

/* ============================================================ 채널 한 칸 */

const 이름맵 = (chans: Channels) => Object.keys(chans);

function keyFrom(entry: TokenEntry | null): string {
  if (!entry) return "";
  if (entry.secret) return "전용";
  if (entry.client === "내장") return "내장";
  const own = entry.how === "device" ? deviceSecretsPath() : secretsPath();
  try { Deno.statSync(own); return "파일"; } catch { /* 없다 */ }
  return "내장";
}

function entryOf(name: string, chans: Channels): TokenEntry | null {
  const store = loadStore();
  if (store[name]) return store[name];
  const cid = chans[name]?.channel_id;
  if (cid) for (const v of Object.values(store)) if (v.channel_id === cid) return v;
  return null;
}

export interface ChanView {
  name: string; channelId: string; title: string; authed: boolean; how: string; canPublish: boolean; keyFrom: string; secretFile: string;
  folder: string; folderOk: boolean; bound: boolean; counts: { 대기: number; 완료: number; 검토필요: number };
  queued: number; reviewing: number; todayUploaded: number; policy: string | null; conf: ChannelConf;
  avatar: string; banner: string; handle: string; subs: number | null; subsExact: boolean; isLong: boolean; lastError: string;
  /** 일 한도 정책의 숫자들(글을 해석하지 않아도 되게) — 정책이 없으면 null */
  policyConf: Obj | null;
  /** 하루 몫(정책 상한 > 고정 편수, 모르면 null)과 오늘 남은 편수 */
  dailyLimit: number | null; dailyLeft: number | null;
  /** 구글이 로그인을 거절했다(만료·취소) — 채널은 그대로 두고 「다시 연결 필요」 표시만 한다. 채널·로그인 정보를 지우지 않는다 */
  needsReconnect: boolean;
}

const 폴더현황 = async (folder: string) => await memo("folder:" + folder, 3000, () => folderSummary(folder));

export async function chanView(name: string, cf: ChannelConf, ctx: {
  chans: Channels; profs: Record<string, Obj>; queue: Obj[]; pending: R.PendingItem[]; today: Record<string, number>; subs: Record<string, Obj>;
}): Promise<ChanView> {
  const entry = entryOf(name, ctx.chans);
  const cid = cf.channel_id || entry?.channel_id || "";
  const pr = ctx.profs[cid] ?? {};
  const same = sameChannelKeys(name);
  const tokKey = resolve(name) ?? name;
  const folder = expandHome(cf.folder ?? "");
  let counts = { 대기: 0, 완료: 0, 검토필요: 0 };
  let folderOk = false;
  if (folder) { folderOk = await isDir(folder); if (folderOk) counts = await 폴더현황(folder); }
  const belongs = (ch: unknown) => { const c = String(ch ?? ""); return same.has(c) || c === cid || c === tokKey; };
  const art = (pr.art ?? {}) as Obj;
  const sub = ctx.subs[name] ?? {};
  const policy = D.policyForChannel(name);
  const err = authErrorOf(cid);
  const todayN = [...same, tokKey].reduce((n, k, i, a) => (a.indexOf(k) === i ? n + (ctx.today[k] ?? 0) : n), 0);
  // 하루 몫: 정책 파일의 상한 > 채널 설정의 고정 편수. 아무 데도 정해지지 않았으면 모른다(null)
  const polLimit = Number(policy?.cfg.daily_limit);
  const dailyLimit: number | null = Number.isFinite(polLimit) && polLimit > 0 ? polLimit : cf.daily_rule === "fixed" && Number(cf.daily) > 0 ? Number(cf.daily) : null;
  return {
    name, channelId: cid, title: entry?.title || pr.title || "", authed: !!entry, how: entry?.how ?? "", canPublish: entry ? canPublish(entry) : false,
    keyFrom: keyFrom(entry), secretFile: entry?.secret ?? "", folder: cf.folder ?? "", folderOk, bound: folderOk ? await boundOk(cf) : false, counts,
    queued: ctx.queue.filter((j) => belongs(j.channel) || belongs(j._alias)).length,
    reviewing: ctx.pending.filter((x) => belongs(x.channel)).length,
    todayUploaded: todayN,
    policy: policy ? D.describePolicy(policy.cfg) : null, conf: cf,
    policyConf: policy ? Object.fromEntries(["daily_limit", "kind", "cap_uploads", "day_start_hour", "overflow_day_start_hour", "publish_gap_minutes", "review_lead_minutes"].map((k) => [k, (policy.cfg as Obj)[k] ?? null])) : null,
    avatar: art.avatar ? `/art?f=${encodeURIComponent(String(art.avatar))}` : "", banner: art.banner ? `/art?f=${encodeURIComponent(String(art.banner))}` : "",
    handle: pr.handle ?? sub.handle ?? "", subs: sub.subs ?? pr.subscribers ?? null, subsExact: !!(sub.exact ?? pr.subscribers_exact),
    isLong: isLongChannel(cf), lastError: err ? err.why : "", needsReconnect: !!err,
    dailyLimit, dailyLeft: dailyLimit === null ? null : Math.max(0, dailyLimit - todayN),
  };
}

/* ============================================================ 발사대기·심사 줄 */

const 제목기억 = new Map<string, { at: number; title: string; source: string }>();

/** 발사대기 한 줄의 제목·출처 — 파일을 읽지만 5초 동안 기억한다(AI·유튜브 호출 없음) */
async function titleOf(file: string, channel: string, job: Obj): Promise<{ title: string; source: string }> {
  const m = 제목기억.get(file);
  if (m && Date.now() - m.at < 5000) return m;
  let title = baseName(file).replace(/\.[^.]+$/, ""), source = "파일이름";
  try {
    const r = await resolveMeta({ channel, file, kind: (job.영상종류 as Kind) ?? "쇼츠", sec: 0, w: 0, h: 0, job: { title: job.title, desc: job.desc, tags: job.tags }, generate: false });
    title = r.title; source = r.source.title;
  } catch { /* 제목을 못 읽으면 파일 이름 */ }
  const v = { at: Date.now(), title, source };
  if (제목기억.size > 400) 제목기억.clear();
  제목기억.set(file, v);
  return v;
}

function hasNeighborThumb(file: string): boolean {
  const stem = file.replace(/\.[^.]+$/, "");
  for (const x of [".jpg", ".jpeg", ".png"]) { try { if (Deno.statSync(stem + x).isFile) return true; } catch { /* 다음 */ } }
  return false;
}

export async function queueView(now: Wall): Promise<Obj[]> {
  const out: Obj[] = [];
  for (const j of Q.list()) {
    const file = String(j.file ?? "");
    const ch = resolve(String(j.channel ?? "")) ?? String(j._alias || j.channel || "");
    const t = await titleOf(file, ch, j);
    const left = Q.minutesLeft(j, now);
    out.push({
      file, name: baseName(file), channel: String(j.channel ?? ""), alias: ch, kind: j.영상종류 || (j.롱폼 ? "롱폼" : "쇼츠"),
      title: t.title, titleSource: t.source, fireAt: String(j.쏠때 ?? ""), publishAt: String(j.publish_at ?? ""), minutesLeft: left, late: left < 0,
      approvedBy: String(j._승인 ?? ""), thumb: hasNeighborThumb(file), ...(await linksOf(file)),
      meta: (() => { const rec = metaRecordFor(file); return rec ? { title: rec.title, desc: rec.description, tags: rec.tags, status: rec.status, at: rec.at } : null; })(),
    });
  }
  return out;
}

export function reviewView(now: Date = new Date()): Obj[] {
  const out: Obj[] = [];
  const ledger = new Map(readLedger().map((r) => [r["영상ID"], r]));
  for (const x of R.loadPending()) {
    // 다음 확인 시각 — 첫 확인은 올린 지 30분 뒤, 그 뒤는 시간당 재확인(12시간까지)
    let next = "";
    const up = parseNaive(String(x.uploaded ?? ""));
    if (up) {
      if (Number(x.확인수 ?? 0) === 0) next = isoWall(new Date(up.getTime() + R.CHECK_AT[0] * 60_000));
      else if (x.사람확인 && now.getTime() - 0 > 0) {
        const last = parseNaive(String(x.마지막확인 ?? x.uploaded ?? ""));
        const w = wallNow(systemZone(), now);
        if (last && up.getTime() > w.getTime() - 12 * 3600_000) next = isoWall(new Date(last.getTime() + 3600_000));
      }
    }
    const row = ledger.get(x.video_id);
    out.push({
      id: x.video_id, ch: x.channel, t: String(x.title ?? "").slice(0, 40), n: Number(x.확인수 ?? 0), human: !!x.사람확인, next, gap: x.간격대기 ?? "",
      publishAt: x.publish_at ?? null, kind: row ? (ledgerRowIsLong(row) ? "롱폼" : "쇼츠") : "",
    });
  }
  return out;
}

/** 오늘 올린 것 중 공개·예약 칸(아직 심사 중인 것은 뺀다) */
export function todayView(): { items: Obj[]; stats: Obj } {
  const 오늘 = dateOnly(wallNow());
  const waiting = new Set(R.loadPending().map((x) => x.video_id));
  const rows = readLedger();
  const items: Obj[] = [];
  let 편 = 0, 공 = 0;
  for (const r of rows) {
    if ((r["업로드시각"] ?? "").slice(0, 10) !== 오늘) continue;
    편++;
    if ((r["공개설정"] ?? "").trim() === "public") 공++;
    if (waiting.has(r["영상ID"])) continue;
    const 예약 = (r["예약시각"] ?? "").trim();
    items.push({
      id: r["영상ID"], ch: r["채널"], t: (r["제목"] ?? "").slice(0, 40), reserve: 예약.length >= 16 ? 예약.slice(11, 16) : "",
      visibility: (r["공개설정"] ?? "").trim(), kind: ledgerRowIsLong(r) ? "롱폼" : "쇼츠",
    });
  }
  return { items, stats: { 올림: 편, 공개: 공, 누적: rows.length, 채널별: PF.uploadedToday() } };
}

export function recentView(n = 8): Obj[] {
  const rows = readLedger().slice().sort((a, b) => ((a["업로드시각"] ?? "") < (b["업로드시각"] ?? "") ? 1 : -1)).slice(0, n);
  return rows.map((r) => ({
    id: r["영상ID"], ch: r["채널"], t: (r["제목"] ?? "").slice(0, 40), at: r["업로드시각"] ?? "", kind: ledgerRowIsLong(r) ? "롱폼" : "쇼츠",
    thumbUrl: `https://i.ytimg.com/vi/${r["영상ID"]}/mqdefault.jpg`,
  }));
}

/* ============================================================ 상태 */

export interface StateExtra {
  owner: string;
  upload: Obj;
  update: Obj;
  ask: Obj | null;
  askAutoStart: boolean;
  tickEvery: number;
  residentOn: boolean;
}

export async function buildState(ex: StateExtra, chans: Channels = loadChannels()): Promise<Obj> {
  const now = wallNow();
  const names = 이름맵(chans);
  const [profs, subs] = await Promise.all([loadProfiles(), memo("subs", 5000, () => PF.subscriberSnapshot(chans))]);
  const queue = Q.list();
  const pending = R.loadPending();
  const today = PF.uploadedToday();
  const chanList: ChanView[] = [];
  for (const n of names) chanList.push(await chanView(n, chans[n], { chans, profs, queue, pending, today, subs: subs as Record<string, Obj> }));

  // 문제 신호등 — 5초 기억
  const issues = await memo("issues", 5000, async () => {
    try { return await ISS.collect(chans, (_a, cf) => cf.daily_rule === "fixed" ? [Number(cf.daily ?? 1), `고정 ${cf.daily ?? 1}개`] : [Number(cf.daily_fallback ?? 1), ""]); } catch { return [] as ISS.Issue[]; }
  });
  const lamp = ISS.lamp(issues, names.length, now);
  const brief = await memo("brief", 10000, async () => { try { return await BR.collect(); } catch { return [] as BR.Brief[]; } });
  const td = todayView();
  const q = QT.today();
  const wait = chanList.reduce((n, c) => n + c.counts.대기, 0);
  const cs = await clientState();
  const cm = await coupangMod();
  let coupang: Obj = { connected: false, enabled: false, needsPrompt: false, usage: { used: 0, limit: 10, resetMin: 0 }, warn: "" };
  if (cm) {
    try {
      const st = cm.loadSettings();
      const w = cm.warnings();
      coupang = { connected: st.connected, enabled: st.enabled, needsPrompt: cm.needsPrompt(), usage: cm.usage(), warn: w.length ? w[0].what : "" };
    } catch { /* 쿠팡 상태를 못 읽어도 화면은 나온다 */ }
  }
  const last = lastTick();
  const hold = migrationHold();
  return {
    ok: true, app: APP_NAME, version: APP_VERSION, now: isoWall(now), owner: ex.owner,
    mode: getMode(), words: modeWords(), features: modeFeatures(), agency: getMode() !== "owner",
    locked: (await import("./safety.ts")).isLocked(), night: { ban: Q.nightBan() }, paused: Q.paused(),
    tick: { last: last ? isoWall(last) : "", every: ex.tickEvery, residentOn: ex.residentOn },
    quota: {
      units: q.유닛, unitsLeft: q.유닛남음, unitCap: q.유닛한도, uploads: q.업로드, uploadsLeft: q.업로드남음, uploadCap: q.업로드한도,
      reset: q.초기화, readsCap: QT.READ_CAP, calls: q.내역,
      projects: Object.entries(QT.todayByProject()).map(([name, v]) => ({ name, units: v.유닛, uploads: v.업로드 })),
    },
    channels: chanList, channelList: chanList,
    queue: await queueView(now), review: reviewView(), today: td.items,
    todayStats: { ...td.stats, 대기: wait }, recent: recentView(),
    issues: { level: lamp.level, counts: lamp.counts, ackedToday: lamp.ackedToday },
    brief: brief.map((b) => ({ level: b.급 === "큰일" ? "red" : "yellow", text: b.무슨일, why: b.왜, todo: b.할일, channel: "", at: b.때, key: b.id })),
    upload: ex.upload, update: ex.update, ask: ex.ask, askAutoStart: ex.askAutoStart,
    subscribers: Object.fromEntries(Object.entries(subs as Record<string, Obj>).map(([n, v]) => [n, { subs: v.subs, exact: v.exact, at: v.at, text: v.subsText, grow: v.grow, title: v.title }])),
    welcome: { channels: names.length, authed: chanList.filter((c) => c.authed).length, ready: cs.ready },
    coupang, ai: aiState(), telegram: telegramSummary(),
    // 옛 판 자료를 옮긴 결과에서 빠진 것이 나와 새 판이 멈춰 있나 — 멈춰 있으면 화면은 빨간 안내와 「다시 옮기기」를 보인다
    migrate: hold ? { hold: true, backupDir: hold.backupDir, missing: hold.missing, reasons: hold.reasons, oldChannels: hold.oldChannels, newChannels: hold.newChannels, at: hold.at } : { hold: false },
  };
}

/* ============================================================ 영상 벽 (재고) */

export interface InvItem {
  file: string; name: string; size: number; sec: number; w: number; h: number; kind: Kind | ""; kindOk: boolean;
  title: string; desc: string; tags: string[]; source: string | null; sourceKind: string;
  thumb: Obj | null; dup: string; why: string; mtime: string; inQueue: boolean;
  meta: Obj | null; links: LinkRef[]; linkStatus: string; linkWhy: string;
}

/** 영상 벽 카드 하나 — 영상 판독(캐시) · 문안 출처 · 맞춤 썸네일 · 중복. 파일을 못 읽으면 null. picks 를 주면 판독한 영상을 거기 더한다(중복 묶음 계산용). */
export async function invItem(key: string, f: string, queued: Set<string> = new Set(Q.list().map((j) => String(j.file))), picks?: PickItem[]): Promise<InvItem | null> {
  let st: Deno.FileInfo | null = null;
  try { st = await Deno.stat(f); } catch { return null; }
  let kind: Kind | "" = "", sec = 0, w = 0, h = 0, why = "", kindOk = true;
  try {
    const info = await probe(f);
    kind = classify(info); sec = info.sec; w = info.display_w; h = info.display_h;
    picks?.push({ path: f, info });
  } catch (e) { kindOk = false; why = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 120); }
  const det = await loadForDetailed(f).catch(() => null);
  const title = det?.titleGiven ? det.title : "";
  const thumb = kind === "롱폼" || hasNeighborThumb(f)
    ? await customThumb(f).then((c) => ({ has: c.있음, name: c.이름, path: c.path, bytes: c.크기, w: c.가로, h: c.세로, over: c.넘침 })).catch(() => null)
    : null;
  const rec = metaRecordFor(f);
  return {
    file: f, name: baseName(f), size: st.size, sec, w, h, kind, kindOk, title, desc: det?.descGiven ? det.desc : "", tags: det?.tagsGiven ? det.tags : [],
    source: det?.source ? baseName(det.source) : null, sourceKind: det?.kind ?? "none", thumb, dup: alreadyUploaded(key, baseName(f), title), why,
    mtime: st.mtime ? isoWall(instantToWall(st.mtime)) : "", inQueue: queued.has(f),
    meta: rec ? { title: rec.title, desc: rec.description, tags: rec.tags, status: rec.status, at: rec.at } : null, ...(await linksOf(f)),
  };
}

/** 채널 폴더의 올릴 차례 영상들 — 50개씩 쪽. 유튜브를 부르지 않는다(영상 판독은 캐시) */
export async function inventory(ch: string, offset = 0, limit = 50): Promise<Obj> {
  const chans = loadChannels();
  const cf = confFor(ch, chans);
  if (!cf) throw new Error(`모르는 채널입니다 — ${ch}`);
  const key = Object.keys(chans).find((k) => chans[k] === cf) ?? ch;
  const folder = expandHome(cf.folder ?? "");
  if (!folder) return { ok: true, ch: key, total: 0, offset, items: [], dupGroups: [], note: "폴더가 아직 정해지지 않았습니다" };
  const files = await pendingFiles(folder, () => {});
  const total = files.length;
  const slice = files.slice(offset, offset + limit);
  const queued = new Set(Q.list().map((j) => String(j.file)));
  const items: InvItem[] = [];
  const picks: PickItem[] = [];
  for (const f of slice) {
    const it = await invItem(key, f, queued, picks);
    if (it) items.push(it);
  }
  return { ok: true, ch: key, total, offset, items, dupGroups: findDuplicates(picks) };
}

/* ============================================================ 기록 (올린 영상) */

export async function records(o: { offset?: number; limit?: number; ch?: string; day?: string } = {}): Promise<Obj> {
  const offset = o.offset ?? 0, limit = Math.min(o.limit ?? 30, 300);
  const perf = await PF.perfLoad();
  const metrics = new Map<string, Obj>();
  for (const e of Object.values(perf)) for (const r of [...(e.rows ?? []), ...(e.톱30 ?? [])]) metrics.set(r.id, r);
  const rows = readLedger().slice().sort((a, b) => ((a["업로드시각"] ?? "") < (b["업로드시각"] ?? "") ? 1 : -1));
  // 날짜별 {n: 올린 수, open: 그중 이미 공개된 수, ch: {채널: 수}} · 채널별 최근 7일(오늘 포함, 0 도 적는다)
  const byDay: Record<string, { n: number; open: number; ch: Record<string, number> }> = {};
  const 이레 = Array.from({ length: 7 }, (_, i) => dateOnly(new Date(wallNow().getTime() - (6 - i) * 86400000)));
  const byChannel: Record<string, Record<string, number>> = {};
  for (const name of Object.keys(loadChannels())) byChannel[name] = Object.fromEntries(이레.map((d) => [d, 0]));
  const filtered: Obj[] = [];
  for (const r of rows) {
    const day = (r["업로드시각"] ?? "").slice(0, 10), ch = r["채널"] ?? "";
    const d = (byDay[day] ??= { n: 0, open: 0, ch: {} });
    d.n++;
    if ((r["공개설정"] ?? "").trim() === "public" || (r["공개시각"] ?? "").trim()) d.open++;
    d.ch[ch] = (d.ch[ch] ?? 0) + 1;
    if (이레.includes(day)) { const w = (byChannel[ch] ??= Object.fromEntries(이레.map((x) => [x, 0]))); w[day]++; }
    if (o.ch && ch !== o.ch) continue;
    if (o.day && day !== o.day) continue;
    const id = r["영상ID"] ?? "";
    const m = metrics.get(id);
    const [w, h] = (r["해상도"] ?? "0x0").split("x");
    const lk = await linksOf(String(r["파일"] ?? ""));
    filtered.push({
      id, ch, t: r["제목"] ?? "", at: r["업로드시각"] ?? "", kind: ledgerRowIsLong(r) ? "롱폼" : "쇼츠", sec: Number(r["길이초"] ?? 0) || 0,
      size: `${w}x${h}`, visibility: (r["공개설정"] ?? "").trim(), publishAt: r["예약시각"] ?? "", publishedAt: r["공개시각"] ?? "",
      views: m ? m.views : null, likes: m ? m.likes : null, comments: m ? m.comments : null,
      url: id ? `https://youtu.be/${id}` : "", studioUrl: id ? `https://studio.youtube.com/video/${id}/edit` : "",
      ...lk, metaSource: "",
    });
  }
  // 날짜 칸이 수백 개가 되지 않게 가장 최근 90일만
  const days = Object.keys(byDay).sort().reverse().slice(0, 90);
  const 최근날: typeof byDay = {};
  for (const k of days) 최근날[k] = byDay[k];
  return { ok: true, total: filtered.length, offset, items: filtered.slice(offset, offset + limit), byDay: 최근날, byChannel, log: await recentLog(40) };
}

/** 영상 id → 원장 줄 (비공개로 내리기·기록에서 찾는다) */
export function recordsById(): Map<string, Record<string, string>> {
  const m = new Map<string, Record<string, string>>();
  for (const r of readLedger()) if (r["영상ID"]) m.set(r["영상ID"], r);
  return m;
}

/* ============================================================ 달력 */

export async function calendar(now: Wall = wallNow()): Promise<Obj> {
  const q = await queueView(now);
  const days = new Map<string, Obj[]>(), byChannel: Record<string, number> = Object.fromEntries(Object.keys(loadChannels()).map((n) => [n, 0]));
  for (const it of q) {
    const d = String(it.fireAt).slice(0, 10) || "미정";
    (days.get(d) ?? days.set(d, []).get(d)!).push(it);
    byChannel[it.alias] = (byChannel[it.alias] ?? 0) + 1;
  }
  return { ok: true, days: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, items]) => ({ date, items })), byChannel };
}

void MODE_AGENCY; void uploadedNames; void join; void dirName; void stemOf; void extOf; void parseInstant; void readJsonSync; void dataPath; void checkVideo; void findThumb; void SG;

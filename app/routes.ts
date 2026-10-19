// 화면 ↔ 서버 약속의 구현 — /api/* 길들. (파이썬: serve.py 의 _api)
//
// 약속은 API_명세.md 한 곳이다. 여기서는 길마다 「읽는 길(GET)」과 「시키는 길(POST)」을 나눠 두고, 시키는 길은 모두
//   사람이 그 순간 누른 것만 받는다(server.ts 의 문지기가 출처·내용 종류를 먼저 본다).
// 원칙
//   · 읽는 길은 유튜브를 부르지 않는다(저장된 기록·파일만). 유튜브를 부르는 길은 이름이 분명하다(…/refresh · …/check · …/run).
//   · 올리기·공개·비공개로 내리기·휴지통은 사람이 누른 것만. 안전장치(safety.ts)는 길마다 따로가 아니라 출구 하나에 있다.
//   · 오류는 `{ok:false, why:"사람이 읽는 한국어"}` — 화면이 그대로 보인다.
//   · 열쇠·토큰 값은 어떤 응답에도 없다.
import { APP_VERSION, baseName, cut, dataDir, dataPath, dirName, expandHome, extOf, isDir, join, log, readJson, readJsonSync, recentLog, recordLine, stemOf, writeJson, writeTextAtomic, desktopDir, IS_MAC, IS_WIN, tailFile, recordPath } from "./paths.ts";
import { dateOnly, isoWall, minuteWall, parseNaive, parseWall, systemZone, wallNow, wallToInstant } from "./clock.ts";
import {
  type ChannelConf, addChannelByName, clearMode, confFor, editChannels, getMode, loadChannels, loadChannelsRaw, orderChannels, removeChannel, renameChannel,
  setFolder, setMode,
} from "./channels.ts";
import { ytFor, loadStore, resolve, updateStore, accessToken, entryFor, LookupError, AuthError, deviceSecretsPath, secretsPath } from "./ytcore.ts";
import { channelMine, thumbnailsSet } from "./youtube.ts";
import { 영상바꾸기 } from "./ytcore.ts";
import * as Q from "./queue.ts";
import * as R from "./review.ts";
import * as D from "./daily.ts";
import * as SF from "./safety.ts";
import * as PL from "./plan.ts";
import * as SY from "./sync.ts";
import * as RC from "./recall.ts";
import * as QT from "./quota.ts";
import * as ST from "./statsview.ts";
import * as PF from "./perf.ts";
import * as AN from "./analytics.ts";
import * as HL from "./health.ts";
import * as PB from "./published.ts";
import * as SB from "./subs.ts";
import * as PRO from "./profile.ts";
import * as ISS from "./issues.ts";
import * as BR from "./briefing.ts";
import * as PV from "./preview.ts";
import * as SAY from "./say.ts";
import * as NF from "./notify.ts";
import * as AR from "./archive.ts";
import * as EV from "./envcheck.ts";
import * as SC from "./selfcheck.ts";
import * as TH from "./thumbs.ts";
import * as TR from "./trash.ts";
import * as PLAT from "./platform.ts";
import * as OA from "./oauth.ts";
import * as AI from "./ai.ts";
import * as UP from "./upload.ts";
import * as SG from "./settings.ts";
import * as MG from "./migrate.ts";
import * as TK from "./tick.ts";
import * as MT from "./meta.ts";
import * as MP from "./metapost.ts";
import * as FD from "./finder.ts";
import { holdReason } from "./hold.ts";
import { receive } from "./receive.ts";
import { markHold, pendingFiles, summary as folderSummary } from "./folders.ts";
import { check as checkVideo, classify, probe } from "./shorts.ts";
import { loadForDetailed, saveFor } from "./sidecar.ts";
import { choose, report as pickReport, type PickItem } from "./picker.ts";
import { checkUpdate, installUpdate, type UpdateInfo } from "./update.ts";
import * as V from "./views.ts";
import { pathConfig } from "./tools.ts";
import { findTool } from "./tools.ts";

type Obj = Record<string, any>;

/* ============================================================ 길 꼴 */

export interface Ctx {
  q: URLSearchParams;
  body: Obj;
  headers: Headers;
  req: Request;
  port: number;
}
export type Handler = (c: Ctx) => Promise<Obj | Response | void>;

export class Bad extends Error {
  /** extra: 실패 답에 함께 실을 칸 (예: 올리기 표에서 폴더에 없는 파일 목록 missing) */
  constructor(public why: string, public status = 200, public extra: Obj = {}) { super(why); }
}

/** 올리는 중인 일 하나 (화면의 진행 창이 읽는다) */
export interface JobState {
  running: boolean;
  files: string[];
  log: string[];
  rc: number | null;
  stopped: boolean;
  handle: { aborted: boolean };
  progress: { file: string; pct: number } | null;
  startedAt: number;
}
const 빈일 = (): JobState => ({ running: false, files: [], log: [], rc: null, stopped: false, handle: { aborted: false }, progress: null, startedAt: 0 });

export interface UpdateState { running: boolean; pct: number; text: string; error: string }

export interface AppState {
  owner: string;
  job: JobState;
  signinAlias: string | null;
  upd: UpdateState;
  ask: Obj | null;
  residentOn: boolean;
  tickEvery: () => number;
  /** 서버가 켜져 있는 곳의 포트 */
  port: () => number;
  tick: () => Promise<TK.TickResult>;
  update: () => Promise<Obj>;
}

export function newAppState(): Omit<AppState, "port" | "tick" | "update" | "tickEvery"> {
  return { owner: "", job: 빈일(), signinAlias: null, upd: { running: false, pct: 0, text: "", error: "" }, ask: null, residentOn: false };
}

const 말 = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim();
const 한줄 = (e: unknown) => 말(e).split("\n")[0].slice(0, 200);
const need = (v: unknown, what: string): string => { const s = String(v ?? "").trim(); if (!s) throw new Bad(`${what} 이(가) 비었습니다`); return s; };

/** 채널 이름(별칭) 또는 채널 id → [별칭, 설정] */
function chanOf(ch: unknown): [string, ChannelConf] {
  const key = String(ch ?? "").trim();
  const chans = loadChannels();
  if (chans[key]) return [key, chans[key]];
  for (const [k, v] of Object.entries(chans)) if (v.channel_id && v.channel_id === key) return [k, v];
  throw new Bad(`모르는 채널입니다 — ${key || "(이름 없음)"}`);
}

/** 영상 경로 하나를 받아 등록된 채널 폴더 안인지 보고 절대 경로로 */
function videoPath(f: unknown): string {
  const p = String(f ?? "").trim();
  if (!p) throw new Bad("어느 영상인지 모르겠습니다");
  if (!V.underRoots(p)) throw new Bad("등록된 채널 폴더 안의 파일만 다룰 수 있습니다");
  return p;
}

const 시각꼴 = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

/* ============================================================ 길 만들기 */

export function buildRoutes(S: AppState): { get: Record<string, Handler>; post: Record<string, Handler> } {
  const get: Record<string, Handler> = {};
  const post: Record<string, Handler> = {};

  const push = (line: string) => { S.job.log.push(line.endsWith("\n") ? line : line + "\n"); if (S.job.log.length > 3000) S.job.log.splice(0, 1000); };

  /* ──────────────── 상태·목록 (읽기) ──────────────── */

  get["state"] = async (c) => {
    const tab = c.q.get("tab") ?? "";
    if (tab && c.q.get("claim") === "1") S.owner = tab; // 새 창이 열리면 주인을 그쪽으로 — 옛 창은 물러난다
    const upd = await S.update();
    // 자동 시작 질문은 운영체제 파일을 읽는 일이라 1.5초마다 다시 하지 않는다 (30초 기억 · 답하면 바로 비운다)
    const ask = S.ask ?? (await V.memo("autostartAsk", 30_000, autostartAsk));
    return await V.buildState({
      owner: S.owner || tab, upload: { running: S.job.running, n: S.job.files.length, done: S.job.rc === null ? 0 : S.job.files.length, stopped: S.job.stopped },
      update: upd, ask, askAutoStart: ask?.id === "autostart", tickEvery: S.tickEvery(), residentOn: S.residentOn,
    });
  };

  /** 컴퓨터를 켤 때 항상 실행할까요? — 채널이 생긴 뒤 한 번만 묻는다 */
  const autostartAsk = async (): Promise<Obj | null> => {
    const s = SG.appSettings();
    if (s.autoStartAsked || s.autoStart) return null;
    if (!Object.keys(loadChannels()).length) return null;
    const st = await PLAT.autoStartStatus().catch(() => null);
    if (!st?.supported) return null;
    return {
      id: "autostart", title: "컴퓨터를 켤 때 항상 실행할까요?",
      body: "켜두면 이 창을 닫아도, 컴퓨터를 껐다 켜도 뒤에서 계속 발사 시각을 지켜보고 올립니다. 10분마다 심사 결과를 확인해 공개하는 작업도 함께 켜집니다. 나중에 설정 탭에서 언제든 바꿀 수 있습니다.",
      choices: [{ id: "yes", label: "🔌 항상 켜기", primary: true }, { id: "no", label: "필요할 때만 켤게요" }],
    };
  };

  get["log"] = async (c) => ({ lines: await recentLog(Math.min(Number(c.q.get("n") ?? 80) || 80, 400)) });

  get["issues"] = async () => {
    const chans = loadChannels();
    const issues = await ISS.collect(chans, (_a, cf) => cf.daily_rule === "fixed" ? [Number(cf.daily ?? 1), `고정 ${cf.daily ?? 1}개`] : [Number(cf.daily_fallback ?? 1), ""], { extras: true });
    const lamp = ISS.lamp(issues, Object.keys(chans).length);
    return { level: lamp.level, counts: lamp.counts, ackedToday: lamp.ackedToday, items: issues, files: await ISS.problemFiles(chans) };
  };

  get["brief"] = async () => ({ items: await BR.collect() });

  get["calendar"] = async () => await V.calendar();

  get["preview"] = async () => {
    const chans = loadChannels();
    const r = await PL.cmdPreview(chans, { say: () => {} });
    const byChannel: PV.PreviewIn = {};
    for (const ch of r.channels) {
      byChannel[ch.name] = {
        info: { handle: "" }, note: [ch.note, ch.timeNote, ch.stockNote].filter(Boolean).join(" · "),
        items: await Promise.all(ch.items.map(async (it) => {
          let mb = 0;
          try { mb = (await Deno.stat(it.file)).size / 1048576; } catch { /* 없다 */ }
          return {
            file: it.file, info: { w: it.info.w, h: it.info.h, display_w: it.info.w, display_h: it.info.h, codec: "", sec: it.info.sec, mb },
            when: it.immediate ? "즉시 발행" : it.publishAt ? it.publishAt.slice(11, 16) : "대기", publishAt: it.publishAt, fireAt: it.fireAt,
            rank: it.rank, spare: it.spare, reason: it.reason, kind: it.kind,
          };
        })),
      };
    }
    return { ...(await PV.build(byChannel)), plan: r.lines };
  };

  get["inventory"] = async (c) => {
    try {
      return await V.inventory(need(c.q.get("ch"), "채널"), Number(c.q.get("offset") ?? 0) || 0, Math.min(Number(c.q.get("limit") ?? 50) || 50, 200));
    } catch (e) { if (e instanceof Bad) throw e; throw new Bad(한줄(e)); }
  };

  get["records"] = async (c) => await V.records({
    offset: Number(c.q.get("offset") ?? 0) || 0, limit: Number(c.q.get("limit") ?? 30) || 30, ch: c.q.get("ch") ?? "", day: c.q.get("day") ?? "",
  });

  get["stats"] = async (c) => {
    const chans = loadChannels();
    const want = c.q.get("ch") ?? "";
    const use = want ? Object.fromEntries(Object.entries(chans).filter(([k]) => k === want)) : chans;
    // 폴더 쪽(대기·완료·재고)은 폴더를 아는 여기서 넘긴다
    const foot: Record<string, { wait: number; done: number; days: number }> = {};
    for (const [n, cf] of Object.entries(use)) {
      if (!cf.folder) continue;
      const f = expandHome(cf.folder);
      if (!(await isDir(f))) continue;
      const sm = await folderSummary(f);
      const [daily] = await PL.dailyForChannel(n, cf, false).catch(() => [1] as [number]);
      foot[n] = { wait: sm.대기, done: sm.완료, days: Math.round((sm.대기 / Math.max(1, daily)) * 10) / 10 };
    }
    return { channels: await ST.statsView(use, { foot }), review: await ST.reviewView(use), lift: await ST.liftView(use), at: isoWall(wallNow()), harvest: await PF.harvestMap(use) };
  };

  get["published"] = async (c) => {
    const chans = loadChannels();
    const ch = c.q.get("ch") ?? "";
    const off = Number(c.q.get("offset") ?? 0) || 0;
    const live = c.q.get("live") === "1";
    const all = live ? await PB.collect(ch ? { [ch]: chans[ch] } as never : chans) : null;
    const rows = all ?? Object.fromEntries(Object.entries(PB.fromLedger()).map(([k, v]) => [k, v.map((x) => ({ ...x, live: false }))]));
    const list = ch ? (rows[ch] ?? []) : Object.values(rows).flat();
    return { total: list.length, offset: off, items: list.slice(off, off + PB.PAGE), live };
  };

  get["feedback/list"] = async () => await feedbackList();

  /* ──────────────── 올리기 (사람이 그 순간 누른 것만) ──────────────── */

  post["upload/ticket"] = async (c) => {
    const files = (Array.isArray(c.body.files) ? c.body.files : []).map(String).filter(Boolean);
    if (!files.length) throw new Bad("담긴 영상이 없습니다");
    if (SF.isLocked()) throw new Bad("올리기가 잠겨 있습니다. 자물쇠를 풀어 주세요.");
    const 보류 = holdReason();
    if (보류) throw new Bad(보류);
    // 지금 폴더에 없는 파일이 있으면 표를 주지 않고 목록을 알린다 — 화면이 장바구니에서 그 영상들을 빼고 다시 누르게 한다
    //   (모르는 채로 표를 주면 「고른 영상이 바뀌었습니다」 로 시작이 거절된다)
    const missing: string[] = [];
    for (const f of files) if (!(await Deno.stat(f).then((x) => x.isFile, () => false))) missing.push(f);
    if (missing.length) throw new Bad(`폴더에 없는 영상이 ${missing.length}개 있습니다 — 옮겨졌거나 지워졌는지 확인해 주세요`, 200, { missing });
    return { t: SF.giveTicket(files), n: files.length, many: files.length > SF.MAX_AT_ONCE, limit: SF.MAX_AT_ONCE };
  };

  post["upload/lock"] = async (c) => {
    if (c.body.on === true || c.body.on === false) await SF.setLocked(!!c.body.on);
    return { locked: SF.isLocked() };
  };

  post["upload/start"] = async (c) => {
    if (S.job.running) throw new Bad("이미 올리는 중입니다");
    const files = (Array.isArray(c.body.files) ? c.body.files : []).map(String).filter(Boolean);
    if (!files.length) throw new Bad("담긴 영상이 없습니다");
    // 여기서 막지 못하면 고객 채널에 영상이 올라간다. 되돌릴 수 없다. (표 · 출처 · 20개 · 되풀이 · 잠금)
    try {
      await SF.allowUpload(String(c.body.t ?? ""), files, c.headers, { many: !!c.body.many });
    } catch (e) { if (e instanceof SF.Refusal) throw new Bad(e.message); throw e; }
    for (const f of files) if (!V.underRoots(f)) throw new Bad(`등록된 채널 폴더 밖의 파일입니다 — ${baseName(f)}`);
    const at: Obj = c.body.at && typeof c.body.at === "object" ? c.body.at : {};
    for (const [f, t] of Object.entries(at)) if (t && !시각꼴.test(String(t))) throw new Bad(`시각을 읽지 못했습니다 — ${baseName(f)}: ${t}`);
    S.job = { ...빈일(), running: true, files, startedAt: Date.now() };
    void runUpload(files, at);
    return { n: files.length };
  };

  /** 올리기를 그 자리에서 돌리고, 나오는 말을 그대로 화면에 흘려보낸다 */
  const runUpload = async (files: string[], at: Obj) => {
    const job = S.job;
    PLAT.keepAwake();
    try {
      const ats = Object.entries(at).filter(([, t]) => t).map(([f, t]) => `${f}=${t}`);
      const r = await PL.run(true, files, ats, {
        who: "사람이 고름(--pick)", say: (l) => push(l), handle: job.handle,
        onProgress: (f: string, sent: number, total: number) => { job.progress = { file: baseName(f), pct: total ? Math.floor((sent / total) * 100) : 0 }; },
      });
      job.rc = r.failed ? 1 : 0;
      V.forgetMemo();
    } catch (e) {
      push(`\n실행하지 못했습니다 — ${한줄(e)}\n`);
      job.rc = -1;
      await log(`[예외] 올리기: ${말(e)}`);
    } finally {
      job.running = false;
      PLAT.allowSleep();
    }
  };

  post["upload/check"] = async () => ({
    running: S.job.running, log: S.job.log.join("").slice(-6000), stopped: S.job.stopped, rc: S.job.rc, progress: S.job.progress,
  });

  /** 긴급중단 — 아직 시작하지 않은 영상은 확실히 안 올라간다. 전송 중이던 한 개는 유튜브에 남을 수 있어 멈춘 뒤 실제 상태를 확인해 사실대로 알린다. */
  post["upload/stop"] = async () => {
    if (!S.job.running) throw new Bad("지금 올리는 중이 아닙니다");
    S.job.stopped = true;
    S.job.handle.aborted = true;
    await recordLine("올리기감시.log", "긴급중단 — 사람이 멈춤");
    push("\n" + "─".repeat(46) + "\n  긴급중단 — 사람이 멈췄습니다.\n  아직 시작하지 않은 영상은 올라가지 않았습니다.\n  전송 중이던 한 개는 유튜브에 남았을 수 있어 지금 확인합니다…\n");
    void (async () => {
      // 멈춘 전송이 끝나기를 잠깐 기다린 뒤 유튜브와 맞춰 본다
      for (let i = 0; i < 40 && S.job.running; i++) await new Promise((r) => setTimeout(r, 250));
      try {
        const r = await SY.run(true, {});
        push((r.lines ?? []).join("\n"));
      } catch (e) { push(`  확인하지 못했습니다 — ${한줄(e)}`); }
      push(`\n  지금 심사 대기 ${R.loadPending().length}건입니다.\n  '기록' 탭에서 실제로 올라간 것을 확인하세요.\n${"─".repeat(46)}`);
    })();
    return { killed: "멈췄습니다" };
  };

  post["night/toggle"] = async () => {
    const ban = await Q.toggleNight();
    await recordLine("올리기.log", `심야발사 ${ban ? "금지" : "허용"} 로 바꿈 (사람)`);
    return { ban };
  };

  post["pause"] = async (c) => {
    const on = await Q.setPaused(!!c.body.on);
    await log(on ? "⏸  예약 쏘기 일시정지" : "▶️  예약 쏘기 재개");
    return { paused: on };
  };

  /* ──────────────── 받기 · 끌어다 놓기 · 파일 고르기 ──────────────── */

  post["file/pick"] = async (c) => {
    const p = await PLAT.pickFile(String(c.body.prompt ?? "영상 파일을 고르세요"), "", c.body.kind === "video" ? ["mp4", "mov", "m4v", "webm"] : undefined);
    if (!p) throw new Bad("취소했습니다");
    return { path: p };
  };

  post["receive"] = async (c) => {
    const [key] = chanOf(c.body.ch);
    const lines: string[] = [];
    const r = await receive(key, need(c.body.file, "영상"), {
      note: c.body.note ? String(c.body.note) : undefined, title: c.body.title ? String(c.body.title) : undefined,
      publishAt: c.body.publishAt ? String(c.body.publishAt) : undefined, slots: Array.isArray(c.body.slots) ? c.body.slots.map(String) : undefined,
      now: !!c.body.now, who: c.body.who ? String(c.body.who) : "사람 승인 (화면)", say: (l) => lines.push(l.trim()),
    }).catch((e) => { throw new Bad(한줄(e)); });
    V.forgetMemo("folder:");
    return { dst: r.dst, kind: r.long ? "롱폼" : "쇼츠", publishAt: r.publishAt, fireAt: r.fireAt, thumb: r.thumb, replaced: r.replaced, lines };
  };

  // 끌어다 놓기 — 브라우저는 끌어온 파일의 경로를 모르므로 바이트를 받아 그 채널 폴더에 저장한다(곁 문안은 만들지 않는다)
  post["drop"] = async (c) => {
    const [, cf] = chanOf(c.q.get("ch"));
    if (!cf.folder) throw new Bad("이 채널은 폴더가 아직 없습니다. 채널 탭에서 폴더를 정해 주세요.");
    const raw = baseName(String(c.q.get("name") ?? "").replace(/[\\/]/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, " ").trim();
    if (!raw || raw.startsWith(".")) throw new Bad("파일 이름이 이상합니다");
    if (!/\.(mp4|mov|m4v|webm)$/i.test(raw)) throw new Bad("영상 파일(mp4·mov·m4v·webm)만 받습니다");
    const folder = expandHome(cf.folder);
    await Deno.mkdir(folder, { recursive: true });
    let name = raw, n = 2;
    while (await Deno.stat(join(folder, name)).then(() => true, () => false)) { name = `${stemOf(raw)} (${n})${extOf(raw)}`; n++; }
    const dest = join(folder, name);
    const tmp = dest + ".받는중";
    const f = await Deno.open(tmp, { write: true, create: true, truncate: true });
    try { await c.req.body?.pipeTo(f.writable); } catch (e) { try { await Deno.remove(tmp); } catch { /* 없다 */ } throw new Bad(`받지 못했습니다 — ${한줄(e)}`); }
    await Deno.rename(tmp, dest);
    let kind = "", size = 0;
    try { size = (await Deno.stat(dest)).size; kind = classify(await probe(dest)); } catch { /* 종류를 못 읽어도 저장은 됐다 */ }
    V.forgetMemo("folder:");
    await log(`📥 화면에서 받은 파일: ${name} → ${baseName(folder)}`);
    return { saved: dest, name, kind, size };
  };

  /* ──────────────── 영상 만지기 (재고) ──────────────── */

  post["inventory/pick"] = async (c) => {
    const [key, cf] = chanOf(c.body.ch);
    const folder = expandHome(cf.folder ?? "");
    if (!folder) throw new Bad("이 채널은 폴더가 아직 없습니다");
    const files = await pendingFiles(folder, () => {});
    const items: PickItem[] = [];
    for (const f of files) { try { items.push({ path: f, info: await probe(f) }); } catch { /* 못 읽는 것은 못 고른다 */ } }
    const mode = String(c.body.mode ?? cf.pick ?? "oldest");
    const n = Math.max(1, Math.min(Number(c.body.n ?? 1) || 1, 500));
    const ins = mode === "suggest" ? await (await import("./insight.ts")).learn(cf.channel_id || key).catch(() => null) : null;
    const r = choose(items, mode, n, Array.isArray(c.body.picked) ? c.body.picked.map(String) : undefined, ins);
    const queued = new Set(Q.list().map((j) => String(j.file)));
    const cards = (await Promise.all(r.chosen.map((x) => V.invItem(key, x.path, queued)))).filter(Boolean);
    return { chosen: r.chosen.map((x) => x.path), items: cards, note: r.note, report: pickReport(items, n, 12, ins) };
  };

  post["text/get"] = async (c) => {
    const f = videoPath(c.body.f);
    const ch = V.channelOfFile(f) ?? "";
    const det = await loadForDetailed(f);
    const bad = (await import("./sidecar.ts")).checkMeta(f);
    return { title: det.title, desc: det.desc, tags: det.tags, source: det.source ? baseName(det.source) : null, kind: det.kind, bad: (await bad).bad, ch };
  };

  post["text/save"] = async (c) => {
    const f = videoPath(c.body.f);
    const title = String(c.body.title ?? "").trim();
    if (!title) throw new Bad("제목이 비었습니다");
    const desc = String(c.body.desc ?? "");
    const tags = Array.isArray(c.body.tags) ? c.body.tags.map(String) : String(c.body.tags ?? "");
    // 화면은 보이는 세 칸을 모두 보낸다. 고치지 않은 칸까지 .txt(= 「사람」)로 굳히면 쪽지·자동 문안이 그 칸에서 영영 밀려난다.
    //   그래서 지금 쓰이는 값과 같고 그 값이 사람이 쓴 것이 아닌 칸은 .txt 에 쓰지 않는다 (사람이 이미 쓴 칸은 그대로 다시 쓴다).
    const keep = { title: true, desc: true, tags: true };
    try {
      const ch = V.channelOfFile(f) ?? "";
      const k = await checkVideo(f);
      const cur = await AI.resolveMeta({ channel: ch, file: f, kind: k.kind, sec: k.info.sec, w: k.info.w, h: k.info.h, generate: false });
      const 태그글 = (v: string | string[]) => (Array.isArray(v) ? v : v.split(/[,\s]+/)).map((t) => String(t).trim().replace(/^#+/, "")).filter(Boolean).join(" ");
      if (cur.source.title !== "사람" && cur.title.trim() === title) keep.title = false;
      if (cur.source.desc !== "사람" && cur.desc.trim() === desc.trim()) keep.desc = false;
      if (cur.source.tags !== "사람" && 태그글(cur.tags) === 태그글(tags)) keep.tags = false;
    } catch { /* 지금 값을 못 읽으면 세 칸 모두 쓴다 */ }
    if (!keep.title && !keep.desc && !keep.tags) {
      const got0 = await (await import("./sidecar.ts")).loadFor(f);
      return { where: "", unchanged: true, title: got0.title, tags: got0.tags.join(", "), desc: got0.desc };
    }
    const out = await saveFor(f, keep.title ? title : "", keep.desc ? desc : "", keep.tags ? tags : []);
    const got = await (await import("./sidecar.ts")).loadFor(f);
    V.forgetMemo();
    return { where: baseName(out), title: got.title, tags: got.tags.join(", "), desc: got.desc, written: Object.entries(keep).filter(([, v]) => v).map(([k]) => k) };
  };

  post["video/trash"] = async (c) => {
    const f = videoPath(c.body.f);
    try {
      const got = await TR.sendToTrash(f, V.channelFolders());
      V.forgetMemo("folder:");
      return { name: got.영상, together: got.함께, n: got.개수 };
    } catch (e) { throw new Bad(e instanceof TR.TrashError ? e.message : `휴지통으로 보내지 못했습니다 — ${한줄(e)}`); }
  };

  post["video/hold"] = async (c) => {
    const f = videoPath(c.body.f);
    const moved = await markHold(f, [String(c.body.reason ?? "사람이 검토필요로 치움").slice(0, 200)]);
    V.forgetMemo("folder:");
    return { to: moved };
  };

  /* ──────────────── 영상 문안 (AI) ──────────────── */

  post["ai/suggest"] = async (c) => {
    const f = videoPath(c.body.f);
    const ch = V.channelOfFile(f);
    if (!ch) throw new Bad("이 영상이 어느 채널 폴더에 있는지 모르겠습니다");
    const k = await checkVideo(f).catch((e) => { throw new Bad(`영상을 읽지 못했습니다 — ${한줄(e)}`); });
    const queued = Q.list().find((j) => j.file === f);
    const r = await AI.resolveMeta({
      channel: ch, file: f, kind: k.kind, sec: k.info.sec, w: k.info.w, h: k.info.h, generate: true, force: !!c.body.force,
      job: queued ? { title: queued.title, desc: queued.desc, tags: queued.tags } : undefined,
    });
    const lk = await V.linksOf(f);
    const ai = AI.aiState();
    return {
      title: r.title, desc: r.desc, tags: r.tags, source: r.source, status: r.status, why: r.why, cached: r.cached, kind: r.kind, checks: r.checks, ...lk,
      // 열쇠가 없어 못 지었을 때 화면이 열쇠 안내를 띄우는 표 (글을 읽어 짐작하지 않게)
      code: r.status === "건너뜀" && !ai.hasKey ? "needs_key" : "",
    };
  };

  post["ai/clear"] = async (c) => ({ cleared: await AI.clearMetaRecord(videoPath(c.body.f)) });

  post["ai/test"] = async (c) => await AI.testKey(c.body.key ? String(c.body.key) : undefined, c.body.model ? String(c.body.model) : undefined);

  /** 열쇠를 넣고 연결 시험 — 통과하면 저장하고 **바로 자동 문안을 켠다**. 틀리면 저장하지 않는다. (열쇠 값은 응답에 없다) */
  post["ai/connect"] = async (c) => {
    const r = await AI.connectKey(String(c.body.key ?? ""), c.body.model !== undefined ? String(c.body.model) : undefined);
    if (!r.ok) throw new Bad(r.message);
    V.forgetMemo();
    return { message: r.message };
  };
  post["ai/later"] = async () => { await AI.markAiPrompted(); return {}; };
  post["ai/disconnect"] = async () => { await AI.disconnectAi(); V.forgetMemo(); return {}; };
  /** 열쇠 입력 창을 닫는다(나중에·닫기) — AI 와 쿠팡을 한꺼번에 「봤다」고 기록해 다시 자동으로 띄우지 않는다 */
  post["prompt/later"] = async () => {
    await AI.markAiPrompted();
    const m = await V.coupangMod();
    try { await m?.markPrompted(); } catch { /* 쿠팡 쪽을 못 적어도 AI 는 적었다 */ }
    return {};
  };

  /* ── 옛 판 자료 이행 — 멈춤이 걸렸을 때 다시 옮기기 · 그대로 쓰기 ── */
  post["migrate/retry"] = async () => {
    const MG = await import("./migrate.ts");
    const r = await MG.migrate({ say: () => {} });
    V.forgetMemo();
    return { migrated: r.ok, already: r.already, held: r.held, backupDir: r.backupDir, lines: MG.formatReport(r).slice(0, 60) };
  };
  /** 빠진 것이 있는 채로 새 판을 쓰겠다고 받아들인다 — 사람이 확인 창에서 누른 것만(confirm=true). 옛 자료와 복사본은 남는다 */
  post["migrate/accept"] = async (c) => {
    if (c.body.confirm !== true) throw new Bad("확인 표시(confirm)가 없습니다 — 화면의 확인 창에서 눌러 주세요");
    const MG = await import("./migrate.ts");
    const r = await MG.acceptMigration();
    if (!r.ok) throw new Bad(r.message);
    V.forgetMemo();
    return { message: r.message };
  };

  /* ── 이 컴퓨터에 이미 있는 열쇠 찾기 (읽기만 · 값은 가려서 · 사람이 누른 것만 저장) ── */
  post["finder/scan"] = async (c) => {
    const k = c.body.kind === "ai" || c.body.kind === "coupang" ? c.body.kind : "all";
    return { ...(await FD.scan({ kind: k })) };
  };
  post["finder/use"] = async (c) => {
    const kind = c.body.kind === "coupang" ? "coupang" : "ai";
    const r = await FD.useFound(kind, String(c.body.id ?? ""));
    if (!r.ok) throw new Bad(r.message);
    V.forgetMemo();
    return { message: r.message };
  };

  post["ai/save"] = async (c) => {
    const st = await AI.saveAiSettings({ on: c.body.on, key: c.body.key, model: c.body.model, clearKey: !!c.body.clearKey });
    return { ...st };
  };

  /* ──────────────── 쿠팡 파트너스 ──────────────── */

  const coupang = async () => {
    const m = await V.coupangMod();
    if (!m) throw new Bad("쿠팡 파트너스 기능을 불러오지 못했습니다");
    return m;
  };

  post["coupang/get"] = async () => {
    const m = await coupang();
    const st = m.loadSettings();
    return {
      connected: st.connected, enabled: st.enabled, mode: st.mode, maxLinks: st.maxLinks, perHour: st.perHour, disclosure: st.disclosure,
      defaultSubId: st.defaultSubId, usage: m.usage(), ai: { available: AI.aiState().hasKey && AI.aiState().enabled }, lastTest: st.lastTest,
      warnings: m.warnings().map((w) => w.what), prompted: SG.appSettings().coupangPrompted,
    };
  };
  post["coupang/connect"] = async (c) => {
    const m = await coupang();
    const r = await m.connect(String(c.body.accessKey ?? ""), String(c.body.secretKey ?? ""));
    if (!r.ok) throw new Bad(r.message);
    V.forgetMemo();
    return { message: r.message, sample: r.sample };
  };
  post["coupang/later"] = async () => { await (await coupang()).markPrompted(); return {}; };
  post["coupang/test"] = async () => await (await coupang()).testConnection();
  post["coupang/save"] = async (c) => {
    const patch: Obj = {};
    for (const k of ["enabled", "mode", "maxLinks", "perHour", "disclosure", "defaultSubId"]) if (c.body[k] !== undefined) patch[k] = c.body[k];
    await (await coupang()).saveSettings(patch);
    return {};
  };
  post["coupang/disconnect"] = async () => { await (await coupang()).disconnect(); V.forgetMemo(); return {}; };
  post["coupang/pick"] = async (c) => {
    const m = await coupang();
    const f = videoPath(c.body.f);
    const ch = V.channelOfFile(f);
    if (!ch) throw new Bad("이 영상이 어느 채널 폴더에 있는지 모르겠습니다");
    const k = await checkVideo(f).catch((e) => { throw new Bad(`영상을 읽지 못했습니다 — ${한줄(e)}`); });
    const meta = await AI.resolveMeta({ channel: ch, file: f, kind: k.kind, sec: k.info.sec, w: k.info.w, h: k.info.h, generate: false });
    const r = await m.pickForVideo({ channel: ch, file: f, title: meta.title, desc: meta.desc, tags: meta.tags, kind: k.kind, force: !!c.body.force });
    return { status: r.status, links: r.links, queries: r.queries, why: r.why, cached: r.cached, block: r.block };
  };
  post["coupang/clear"] = async (c) => ({ cleared: await (await coupang()).clearRecord(videoPath(c.body.f)) });

  /* ──────────────── 발사대기 만지기 ──────────────── */

  post["shoot/retime"] = async (c) => {
    const f = need(c.body.f, "파일");
    const 새 = String(c.body.when ?? "").replace("T", " ").trim().slice(0, 16);
    if (!새) throw new Bad("파일과 시각이 다 있어야 합니다");
    const t = parseWall(새);
    if (!t) throw new Bad(`시각을 읽지 못했습니다 — ${새}`);
    const now = wallNow();
    if (t.getTime() <= now.getTime() + 2 * 60_000) throw new Bad("지난(또는 2분 안쪽) 시각으로는 못 바꿉니다");
    if (Q.nightBan() && t.getUTCHours() < 7) throw new Bad("자정~아침 7시는 발사 금지 시간대입니다 — 🌙 스위치를 풀거나 7시 이후로 잡아 주세요");
    const item = Q.list().find((x) => x.file === f);
    if (!item) throw new Bad("발사대기에 없습니다 (이미 쏘았거나 취소됐습니다)");
    const 옛 = String(item.쏠때 ?? "").slice(0, 16);
    if (!(await Q.add({ ...item }, `${isoWall(t).slice(0, 16)}:00`, () => {}))) throw new Bad("바꾸지 못했습니다");
    await recordLine("올리기.log", `수정   발사시각 ${baseName(f)}  ${옛} → ${새}`);
    return { name: baseName(f), fireAt: `${isoWall(t).slice(0, 16)}:00` };
  };

  post["shoot/cancel"] = async (c) => {
    const f = need(c.body.f, "파일");
    const item = Q.list().find((x) => x.file === f);
    if (!item) throw new Bad("발사대기에 없습니다 (이미 쏘았거나 취소됐습니다)");
    if (!(await Q.remove(f))) throw new Bad("빼지 못했습니다");
    await recordLine("올리기.log", `취소   발사대기에서 뺌 — ${baseName(f)}  (예정이던 시각 ${item.쏠때 ?? ""})`);
    return { name: baseName(f), left: Q.list().length };
  };

  post["shoot/now"] = async (c) => {
    const f = need(c.body.f, "파일");
    const item = Q.list().find((x) => x.file === f);
    if (!item) throw new Bad("발사대기에 없습니다 (이미 쏘았거나 취소됐습니다)");
    // 쏠 시각을 지금으로 당긴 뒤 같은 길(출구검사·잠금·한도)로 쏜다
    await Q.add({ ...item }, isoWall(new Date(wallNow().getTime() - 60_000)), () => {});
    const lines: string[] = [];
    const n = await Q.fire({ file: f, say: (l) => lines.push(l.trim()) });
    V.forgetMemo();
    return { fired: n, lines };
  };

  post["sched/cancel"] = async (c) => {
    const mode = String(c.body.mode ?? ""), k = String(c.body.k ?? "");
    const d = Q.list();
    const nfc = (s: unknown) => String(s ?? "").normalize("NFC");
    const alias = (x: Obj) => { const ch = String(x._alias || x.channel || ""); return resolve(ch) ?? ch; };
    let 대상: Obj[];
    if (mode === "one") 대상 = d.filter((x) => nfc(x.file) === nfc(k));
    else if (mode === "day") 대상 = d.filter((x) => String(x.쏠때 ?? "").slice(0, 10) === k);
    else if (mode === "ch") 대상 = d.filter((x) => nfc(alias(x)) === nfc(k));
    else if (mode === "all") 대상 = [...d];
    else throw new Bad("무엇을 취소할지 모르겠습니다");
    if (!대상.length) throw new Bad("해당하는 예약이 없습니다 (이미 쏘았거나 취소됐습니다)");
    const n = await Q.removeMany(대상.map((x) => String(x.file ?? "")));
    const 말글 = ({ one: `영상 ${baseName(k).slice(0, 40)}`, day: `날짜 ${k}`, ch: `채널 ${k}`, all: "전체" } as Record<string, string>)[mode];
    await recordLine("올리기.log", `취소   달력 묶음 취소(${말글}) — ${n}건`);
    return { removed: n, left: Q.list().length };
  };

  /* ──────────────── 심사·공개·동기화·비공개로 내리기 ──────────────── */

  post["review/run"] = async (c) => {
    const publish = !!c.body.publish;
    const r = await R.run(publish, publish ? "사람" : "");
    V.forgetMemo();
    return { lines: r.lines, opened: r.opened, kept: r.kept, blocked: r.blocked };
  };

  post["sync/run"] = async () => {
    const r = await SY.run(false, {});
    V.forgetMemo();
    return { lines: r.lines ?? [], changes: { ledger: r.ledger, ghost: r.ghost, dup: r.dup, name: r.name } };
  };

  post["tick"] = async () => {
    const r = await S.tick();
    V.forgetMemo();
    return { lines: r.lines, skipped: r.skipped, fired: r.fired, steps: r.steps };
  };

  /** 이미 올린 영상을 비공개로 되돌린다 — 지우는 것이 아니라 감추는 것이다. 사람이 내린 것은 기계가 다시 공개하지 않는다. */
  post["video/hide"] = async (c) => {
    const vid = need(c.body.v, "영상");
    const row = V.recordsById().get(vid);
    if (!row) throw new Bad("원장에 없는 영상입니다");
    const 채널 = row["채널"] ?? "", 제목 = row["제목"] ?? "";
    let 새 = "private";
    try {
      const yt = await ytFor(채널);
      // 읽고 합쳐서 쓴다(영상바꾸기) — privacyStatus 만 보내면 퍼가기·통계 공개·합성 표시가 지워진다. 예약(publishAt)은 싣지 않는다 —
      // 내린 영상이 예약 시각에 다시 열리면 안 된다.
      const r = await 영상바꾸기(yt, vid, { status: { privacyStatus: "private" } });
      새 = (r as Obj)?.status?.privacyStatus ?? "private";
    } catch (e) { throw new Bad(`비공개로 바꾸지 못했습니다 — ${한줄(e)}`); }
    await R.stampPublished(vid, "", 새);
    await SF.manualPrivateAdd(vid, 채널, 제목); // 기계가 다시 공개하지 못하게 명단에 올린다
    await R.updatePending((items) => items.filter((x) => x.video_id !== vid)); // 심사 대기에서도 뺀다(재시도 원천 차단)
    await recordLine("올리기.log", `비공개  [${채널}] ${제목.slice(0, 40)}  ${vid}  (사람이 내림)`);
    NF.send(`🔒 비공개로 내렸습니다\n채널  ${채널}\n영상  ${제목.slice(0, 60)}\nhttps://youtu.be/${vid}`).catch(() => {});
    V.forgetMemo();
    return { v: vid, state: 새, name: 제목.slice(0, 40) };
  };

  /* ──────────────── 지표·성적 (사람이 누를 때만 유튜브를 부른다) ──────────────── */

  post["perf/refresh"] = async (c) => {
    const chans = loadChannels();
    const want = String(c.body.ch ?? "all");
    const names = (want === "" || want === "all" ? Object.keys(chans) : [want]).filter((n) => n in chans);
    if (!names.length) throw new Bad(`모르는 채널입니다 — ${want}`);
    try { await PF.perfFetch(names); } catch (e) { throw new Bad(한줄(e)); }
    V.forgetMemo();
    return { n: names.length, units: names.length * 3 };
  };

  post["analytics/refresh"] = async () => {
    const chans = loadChannels();
    const keys = Object.keys(chans).filter((n) => resolve(n));
    const stat = await PRO.refreshStatistics(chans, { force: true }).catch(() => null);
    const r = keys.length ? await AN.refreshThrottled(keys) : { recent: false, received: [], failed: [] };
    V.forgetMemo();
    return { received: (r as Obj).받음 ?? (r as Obj).received ?? [], failed: (r as Obj).실패 ?? (r as Obj).failed ?? [], recent: !!((r as Obj).최근 ?? (r as Obj).recent), subs: !!stat };
  };

  post["health"] = async (c) => {
    const r = await HL.evaluate(need(c.body.ch, "채널"));
    return { grade: r.등급, lines: r.줄들.map((x) => `${x.항목} · ${x.등급} — ${x.말}`), rows: r.줄들 };
  };

  /* ──────────────── 문제·알림·말로 시키기 ──────────────── */

  post["iss/ack"] = async () => {
    const chans = loadChannels();
    const issues = await ISS.collect(chans);
    const 봉함 = await ISS.ack(issues);
    V.forgetMemo("issues");
    return { 봉함: 봉함.slice(0, 80) };
  };

  post["issues/fix"] = async (c) => {
    const chans = loadChannels();
    const issues = await ISS.collect(chans);
    const r = await ISS.autofix(issues, { kind: c.body.kind ? String(c.body.kind) : undefined });
    V.forgetMemo();
    return { fixed: r.fixed, lines: r.lines };
  };

  post["issues/copy"] = async () => {
    const chans = loadChannels();
    const issues = await ISS.collect(chans);
    const text = ISS.asPrompt(issues.filter((i) => i.level !== "green"), chans);
    const ok = await ISS.copyToClipboard(text);
    return { copied: ok, chars: text.length };
  };

  post["claude/open"] = async () => {
    const chans = loadChannels();
    const issues = await ISS.collect(chans);
    const copied = await ISS.copyToClipboard(ISS.asPrompt(issues.filter((i) => i.level !== "green"), chans));
    // 문제 내용을 복사해 두고 AI 앱을 열어 본다 — 앱이 알아서 고치는 게 아니라 사람이 AI 와 이어서 말하게 해 주는 다리다
    let opened = false;
    if (IS_MAC) opened = (await PLAT.openPath("/Applications/Claude.app").catch(() => false)) || false;
    if (!copied && !opened) throw new Bad("문제 내용을 복사하지 못했습니다");
    return { copied, opened };
  };

  post["say/parse"] = async (c) => {
    const text = String(c.body.t ?? "").trim();
    if (!text) throw new Bad("말이 비었습니다");
    const chans = loadChannels();
    const p = SAY.parse(text, chans);
    const out: Obj = {
      action: p.action, channels: p.channels, count: p.count, publish: p.publish, fireAt: p.fireAt ?? p.쏠때 ?? null,
      warn: [...p.warn], files: [], pick: "", status: [],
    };
    if (!p.channels.length && p.name_hint && (p.action === "upload" || p.action === "cart")) {
      const hit = await SAY.channelsWithFile(p.name_hint, chans);
      if (hit.length === 1) { p.channels = hit; out.channels = hit; out.warn = out.warn.filter((w: string) => !w.includes("채널")); }
      else if (hit.length > 1) out.warn.push(`'${p.name_hint}' 가 여러 채널에 있습니다: ${hit.join(", ")}`);
    }
    if ((p.action === "upload" || p.action === "cart" || p.action === "uncart") && p.channels.length === 1) {
      const r = await SAY.resolveFiles(p.channels[0], chans[p.channels[0]], p);
      let files = r.files;
      if (p.count) files = files.slice(0, p.count);
      out.files = files.slice(0, 500).map((x: string) => baseName(x));
      out.paths = files.slice(0, 500);
      out.pick = r.how;
    }
    if (p.action === "status") {
      for (const k of p.channels) {
        try {
          const sm = await folderSummary(expandHome(chans[k].folder ?? ""));
          out.status.push(`${k} — 대기 ${sm.대기} · 완료 ${sm.완료}` + (sm.검토필요 ? ` · 검토필요 ${sm.검토필요}` : ""));
        } catch { out.status.push(`${k} — 폴더를 읽지 못했습니다`); }
      }
    }
    return out;
  };

  /* ──────────────── 열쇠·연결 (인증) ──────────────── */

  post["secret/state"] = async (c) => {
    const st = await OA.clientState();
    const store = loadStore();
    const done = new Set(Object.values(store).map((v) => v.channel_id).filter(Boolean));
    const want = (Array.isArray(c.body.need) ? c.body.need : []).map(String).filter(Boolean);
    const chans = loadChannels();
    const missing = (want.length ? want : Object.keys(chans)).filter((k) => k in chans && !done.has(chans[k].channel_id ?? "") && !resolve(k));
    return { client: st.client, device: st.device, embedded: st.embedded, ready: st.ready, channels: st.channels, missing };
  };

  post["secret/save"] = async (c) => {
    const kind = c.body.kind === "device" ? "device" : "client";
    try {
      const r = c.body.json !== undefined ? await OA.saveClientFile(kind, { json: String(c.body.json) }) : await OA.saveClientFile(kind, { clientId: String(c.body.clientId ?? ""), clientSecret: String(c.body.clientSecret ?? "") });
      return { where: r.where, kind };
    } catch (e) { throw new Bad(한줄(e)); }
  };

  post["secret/pick"] = async (c) => {
    const kind = c.body.kind === "device" ? "device" : "client";
    const label = kind === "client" ? "구글 로그인용 (데스크톱 앱)" : "코드 인증용 (TV 및 입력 제한 기기)";
    const p = await PLAT.pickFile(`${label} 열쇠 파일`, "", ["json"]);
    if (!p) throw new Bad("취소했습니다");
    let text = "";
    try { text = await Deno.readTextFile(p); } catch { throw new Bad("파일을 읽지 못했습니다"); }
    try { const r = await OA.saveClientFile(kind, { json: text }); return { where: r.where, kind }; } catch (e) { throw new Bad(한줄(e)); }
  };

  post["channel/secret"] = async (c) => {
    const [key] = chanOf(c.body.ch);
    let file = "";
    try {
      file = c.body.json !== undefined ? await OA.saveChannelClientJson(key, String(c.body.json)) : await OA.saveChannelClientFile(key, { clientId: String(c.body.clientId ?? "").trim(), clientSecret: String(c.body.clientSecret ?? "").trim() });
    } catch (e) { throw new Bad(한줄(e)); }
    await editChannels((d) => { d[key].secret_file = file; });
    return { file };
  };
  post["channel/secret/clear"] = async (c) => {
    const [key] = chanOf(c.body.ch);
    await editChannels((d) => { delete d[key].secret_file; }); // 파일은 그대로 둔다 — 연결만 푼다
    return {};
  };

  post["add"] = async (c) => {
    const name = String(c.body.name ?? "").trim();
    if (!name) throw new Bad("이름이 비었습니다");
    try { await addChannelByName(name); } catch (e) { throw new Bad(한줄(e)); }
    // 폴더는 새 채널 폴더의 기본 위치에 바로 만든다 — 영상을 넣기만 하면 된다
    try {
      const folder = join(SG.appSettings().baseDir, name.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "채널");
      await Deno.mkdir(folder, { recursive: true });
      await setFolder(name, folder, name);
    } catch (e) { await log(`  새 채널의 기본 폴더를 못 만들었습니다 — ${한줄(e)}`); }
    return { name };
  };

  post["order"] = async (c) => {
    const names = (Array.isArray(c.body.names) ? c.body.names : []).map(String).filter(Boolean);
    if (!names.length) throw new Bad("순서가 비었습니다");
    const chans = loadChannels();
    const 모름 = names.filter((n) => !(n in chans));
    if (모름.length) throw new Bad(`모르는 채널입니다 — ${모름.slice(0, 3).join(", ")}`);
    return { order: await orderChannels(names) };
  };

  post["rename"] = async (c) => {
    const [old] = chanOf(c.body.ch);
    try { await renameChannel(old, String(c.body.name ?? "")); } catch (e) { throw new Bad(한줄(e)); }
    return { name: String(c.body.name ?? "").trim() };
  };

  /**
   * 채널을 목록에서 뺀다 — **사람이 확인 창에서 누른 것만**(confirm=true). 새 판의 어떤 자동 작업도 채널을 지우지 않는다
   * (로그인이 풀려도 채널은 남고 「다시 연결 필요」 표시만 뜬다). 올린 기록·영상·폴더는 그대로 남는다.
   */
  post["remove"] = async (c) => {
    if (c.body.confirm !== true) throw new Bad("확인 표시(confirm)가 없습니다 — 화면의 확인 창에서 눌러야 채널을 뺍니다");
    const [alias] = chanOf(c.body.ch);
    const r = await removeChannel(alias); // 올린 기록은 남긴다. 목록에서만 뺀다.
    return { alias: r.alias };
  };

  post["folder"] = async (c) => {
    const [alias, cf] = chanOf(c.body.ch);
    const got = await PLAT.pickFolder(expandHome(cf.folder ?? ""), `[${alias}] 영상이 들어올 폴더`);
    if (!got) throw new Bad("취소했습니다");
    try { return await setFolder(alias, got, alias); } catch (e) { throw new Bad(한줄(e)); }
  };

  post["folder/set"] = async (c) => {
    const [alias] = chanOf(c.body.ch);
    const p = expandHome(String(c.body.path ?? ""));
    if (!p) throw new Bad("폴더 경로가 비었습니다");
    await Deno.mkdir(p, { recursive: true }).catch(() => {});
    try { return await setFolder(alias, p, alias); } catch (e) { throw new Bad(한줄(e)); }
  };

  const 허용칸: Record<string, "text" | "num" | "bool" | "list" | "obj" | "times" | "tri"> = {
    prefix: "text", title_prefix: "text", desc: "text", approved_by: "text", audio_language: "text", date: "text", desc_head: "text", desc_tail: "text", tone: "text",
    studio_profile: "text", daily_rule: "text", publish: "text", pick: "text", after_review: "text", after_upload: "text",
    daily: "num", daily_fallback: "num", allow_not_short: "bool", 롱폼: "bool", 회수: "bool", 회수제외: "bool", thumb_watch: "bool", ai: "bool",
    made_for_kids: "tri", tags: "list", fixed_tags: "list", times: "times", long_slots: "times", window: "list", rule: "obj", meta_rule: "obj", coupang: "obj",
  };
  const 고르기: Record<string, string[]> = {
    daily_rule: ["views", "fixed", "auto"], publish: ["schedule", "now"], pick: ["order", "oldest", "suggest", "manual"],
    after_review: ["public", "unlisted", "private"], after_upload: ["trash", "move", "keep", ""],
  };

  post["channel/update"] = async (c) => {
    const [alias] = chanOf(c.body.ch);
    const set: Obj = c.body.set && typeof c.body.set === "object" ? c.body.set : {};
    const conf = await editChannels((d) => {
      const cur = d[alias] as Obj;
      for (const [k, v] of Object.entries(set)) {
        const kind = 허용칸[k];
        if (!kind) throw new Bad(`바꿀 수 없는 칸입니다 — ${k}`);
        if (v === null || v === undefined) { delete cur[k]; continue; }
        if (kind === "text") {
          const s = String(v).trim();
          if (고르기[k] && !고르기[k].includes(s)) throw new Bad(`${k} 에는 ${고르기[k].filter(Boolean).join(" · ")} 중에서 골라 주세요`);
          if (s === "") delete cur[k]; else cur[k] = s;
        } else if (kind === "num") {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Bad(`${k} 숫자가 이상합니다`);
          cur[k] = Math.trunc(n);
        } else if (kind === "bool") cur[k] = !!v;
        else if (kind === "tri") { if (v === "" || v === "default") delete cur[k]; else cur[k] = v === true || v === "true" || v === "yes"; }
        else if (kind === "list") {
          const a = (Array.isArray(v) ? v : String(v).split(/[,\n]/)).map((x: unknown) => String(x).trim().replace(/^#+/, "")).filter(Boolean);
          if (k === "window") { const w = a.map(Number); if (w.length !== 2 || w.some((x) => !Number.isFinite(x))) throw new Bad("하루 창은 「시작 끝」 두 숫자입니다"); cur[k] = w; } else cur[k] = a;
        } else if (kind === "times") {
          const a = (Array.isArray(v) ? v : String(v).split(/[,\s]+/)).map((x: unknown) => String(x).trim()).filter(Boolean);
          for (const t of a) if (!/^\d{1,2}:\d{2}$/.test(t)) throw new Bad(`시각은 「09:15」 꼴이어야 합니다 — ${t}`);
          cur[k] = a.map((t: string) => t.padStart(5, "0"));
        } else if (kind === "obj") {
          if (typeof v !== "object" || Array.isArray(v) && k !== "rule") throw new Bad(`${k} 모양이 이상합니다`);
          if (k === "coupang") {
            const o = v as Obj, out: Obj = {};
            if (o.on !== undefined) out.on = !!o.on;
            if (o.sub_id !== undefined) { const s = String(o.sub_id).replace(/[^A-Za-z0-9]/g, "").slice(0, 30); if (s) out.sub_id = s; }
            if (o.mode !== undefined && ["auto", "rule", "off"].includes(String(o.mode))) out.mode = o.mode;
            if (Object.keys(out).length) cur.coupang = out; else delete cur.coupang;
          } else if (k === "meta_rule") {
            const o = v as Obj, out: Obj = {};
            for (const b of ["forbid_hangul", "forbid_shorts_tag", "forbid_cta"]) if (o[b]) out[b] = true;
            for (const n of ["hashtags", "desc_min", "desc_max"]) if (o[n] !== undefined && o[n] !== "" && o[n] !== null) { const x = Number(o[n]); if (!Number.isFinite(x) || x < 0) throw new Bad(`${n} 숫자가 이상합니다`); out[n] = Math.trunc(x); }
            if (Object.keys(out).length) cur.meta_rule = out; else delete cur.meta_rule;
          } else cur[k] = v; // rule: [{min_views, daily}]
        }
      }
      return cur as ChannelConf;
    }).catch((e) => { throw e instanceof Bad ? e : new Bad(한줄(e)); });
    V.forgetMemo();
    return { conf };
  };

  post["channel/policy"] = async (c) => {
    const [alias, cf] = chanOf(c.body.ch);
    const cid = cf.channel_id || entryOf(alias);
    if (!cid) throw new Bad("이 채널은 아직 구글에 연결되지 않아 채널 번호를 모릅니다 — 먼저 구글 계정을 연결해 주세요");
    const limit = Number(c.body.daily_limit);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) throw new Bad("하루 편수는 1~100 사이로 적어 주세요");
    const p: Obj = { channel_id: cid, label: alias, daily_limit: Math.trunc(limit), aliases: [alias] };
    // null/빈 글은 「그 칸을 지운다」(쇼츠·롱폼 전부로 되돌리기 · 밀릴 때 시작 시각을 따로 두지 않기). 안 보낸 칸은 그대로 둔다.
    if (c.body.kind === null || c.body.kind === "") p.kind = null;
    else if (c.body.kind === "쇼츠" || c.body.kind === "롱폼") p.kind = c.body.kind;
    if (c.body.cap_uploads !== undefined) p.cap_uploads = !!c.body.cap_uploads;
    for (const k of ["day_start_hour", "overflow_day_start_hour", "publish_gap_minutes", "review_lead_minutes"]) {
      if (c.body[k] === null) p[k] = null;
      else if (c.body[k] !== undefined && c.body[k] !== "") p[k] = Number(c.body[k]);
    }
    await D.writePolicy(p as never);
    const pol = D.policyForChannel(alias);
    V.forgetMemo();
    return { text: pol ? D.describePolicy(pol.cfg) : "" };
  };
  const entryOf = (alias: string) => loadStore()[alias]?.channel_id ?? "";
  post["channel/policy/clear"] = async (c) => {
    const [alias, cf] = chanOf(c.body.ch);
    const cid = cf.channel_id || entryOf(alias);
    return { removed: cid ? await D.removePolicy(cid) : false };
  };

  /* ── 브라우저 로그인 (관리자 계정 하나로 채널만 바꿔 고른다) ── */
  post["signin/start"] = async (c) => {
    const alias = String(c.body.ch ?? "").trim() || null;
    const cf = alias ? confFor(alias) : null;
    const secret = c.body.secret ? String(c.body.secret) : (cf as Obj | null)?.secret_file ? String((cf as Obj).secret_file) : undefined;
    let r;
    try { r = await OA.startSignIn(alias, secret); } catch (e) { throw new Bad(한줄(e)); }
    S.signinAlias = alias;
    r.done.then(() => { V.forgetMemo(); }).catch(() => {});
    await PLAT.openUrl(r.url, SG.appSettings().browser).catch(() => false);
    return { url: r.url };
  };
  post["signin/check"] = async () => {
    const st = OA.signin.state;
    if (st.running) return { state: "waiting" };
    if (st.done) return { state: "done", ...st.done };
    throw new Bad(st.why || "로그인이 끝나지 않았습니다");
  };
  post["signin/stop"] = async () => { OA.signin.stop?.(); return {}; };

  /* ── 인스타그램·스레드 (연결 정보가 실행 파일에 들어 있는 판에서만 화면에 나타난다) ──
     토큰 값은 어떤 답에도 싣지 않는다. 호출하는 것은 중계 서버·메타뿐이다(구글 문과 같은 doFetch 한 문). */
  const 메타쪽 = (v: unknown): MT.Provider => {
    if (v === "instagram" || v === "threads") return v;
    throw new Bad("인스타그램 또는 스레드를 골라 주세요");
  };
  post["meta/get"] = async () => {
    const av = await MT.available();
    if (!av.on) return { available: av, accounts: [], channels: [], jobs: [], summary: { waiting: 0, unknown: 0, failed: 0 }, signin: { running: false } };
    const st = MT.signin.state;
    return {
      available: av,
      accounts: MT.accountsView(),
      channels: Object.entries(loadChannels()).map(([alias, cf]) => ({ alias, ...MT.bindingOf(cf) })),
      jobs: MP.listJobs(20),
      summary: MP.summary(),
      signin: { running: st.running, provider: st.provider, why: st.why ?? "", done: st.done ? { username: st.done.username, provider: st.done.provider } : null },
    };
  };
  post["meta/signin/start"] = async (c) => {
    const provider = 메타쪽(c.body.provider);
    let r;
    try { r = await MT.startSignIn(provider); } catch (e) { throw new Bad(한줄(e)); }
    await PLAT.openUrl(r.url, SG.appSettings().browser).catch(() => false);
    return { url: r.url };
  };
  post["meta/signin/check"] = async () => {
    const st = MT.signin.state;
    if (st.running) return { state: "waiting" };
    if (st.done) return { state: "done", username: st.done.username, provider: st.done.provider };
    throw new Bad(st.why || "로그인이 끝나지 않았습니다");
  };
  post["meta/signin/stop"] = async () => { MT.signin.stop?.(); return {}; };
  post["meta/disconnect"] = async (c) => {
    const key = String(c.body.key ?? "");
    if (!(await MT.disconnect(key))) throw new Bad("연결된 계정이 아닙니다");
    return {};
  };
  post["meta/bind"] = async (c) => {
    const key = String(c.body.key ?? "");
    try { await MT.bindChannel(String(c.body.alias ?? ""), 메타쪽(c.body.provider), key || null); } catch (e) { if (e instanceof Bad) throw e; throw new Bad(한줄(e)); }
    return {};
  };
  /** 올리는 일은 오래 걸릴 수 있어 기다리지 않고 뒤에서 돌린다 — 같은 영상을 두 번 올리지 않게 run 이 잠금으로 막는다 */
  const 뒤에서올리기 = () => { MP.run({}).catch(() => {}); };
  post["meta/job/retry"] = async (c) => {
    try { await MP.retryTarget(String(c.body.id ?? ""), 메타쪽(c.body.provider)); } catch (e) { if (e instanceof Bad) throw e; throw new Bad(한줄(e)); }
    뒤에서올리기();
    return {};
  };
  post["meta/job/check"] = async (c) => await MP.checkUnknown(String(c.body.id ?? ""), 메타쪽(c.body.provider));
  post["meta/job/resolve"] = async (c) => {
    const outcome = c.body.outcome === "올림" ? "올림" : c.body.outcome === "안올라감" ? "안올라감" : null;
    if (!outcome) throw new Bad("올라갔는지 안 올라갔는지 골라 주세요");
    try { await MP.resolveTarget(String(c.body.id ?? ""), 메타쪽(c.body.provider), outcome, { url: c.body.url ? String(c.body.url) : undefined }); } catch (e) { if (e instanceof Bad) throw e; throw new Bad(한줄(e)); }
    if (outcome === "안올라감") 뒤에서올리기();
    return {};
  };
  post["meta/job/cancel"] = async (c) => {
    if (!(await MP.cancelJob(String(c.body.id ?? "")))) throw new Bad("취소할 수 있는 올리기가 없습니다");
    return {};
  };

  /* ── 코드 인증 (TV·입력 제한 기기 방식) ── */
  post["code/start"] = async (c) => {
    const alias = String(c.body.ch ?? "").trim();
    try {
      const s = await OA.deviceStart();
      OA.codeSessions.set(alias || "_", s);
      return { url: s.verification_url ?? s.verification_uri, code: s.user_code, secs: Number(s.expires_in ?? 1800) };
    } catch (e) { throw new Bad(e instanceof OA.NotReady ? e.message : `코드를 받지 못했습니다 — ${한줄(e)}`); }
  };
  post["code/check"] = async (c) => {
    const alias = String(c.body.ch ?? "").trim();
    const s = OA.codeSessions.get(alias || "_");
    if (!s) throw new Bad("시작된 인증이 없습니다");
    let r;
    try { r = await OA.devicePoll(s); } catch (e) { throw new Bad(한줄(e)); }
    if (r.state === "waiting" || r.state === "slow") {
      const left = Math.floor(s._started + Number(s.expires_in ?? 1800) - Date.now() / 1000);
      return { state: "waiting", left: Math.max(left, 0) };
    }
    if (r.state !== "ok") { OA.codeSessions.delete(alias || "_"); throw new Bad(r.state === "denied" ? r.why : "코드가 만료됐습니다. 다시 시작하세요."); }
    try {
      const got = await OA.deviceSave(r.refresh, alias || undefined, { scope: r.scope, mark: s._mark });
      OA.codeSessions.delete(alias || "_");
      V.forgetMemo();
      return { state: "done", title: got.title, key: got.key };
    } catch (e) { throw new Bad(`저장하지 못했습니다 — ${한줄(e)}`); }
  };
  post["code/stop"] = async (c) => { OA.codeSessions.delete(String(c.body.ch ?? "").trim() || "_"); return {}; };

  post["channel/check"] = async (c) => {
    const [alias] = chanOf(c.body.ch);
    try {
      const yt = await ytFor(alias);
      const it = await channelMine(yt, "snippet");
      if (!it) throw new Bad("이 인증에 연결된 채널이 없습니다");
      return { title: it.snippet?.title ?? "", channel_id: it.id, units: 1 };
    } catch (e) {
      if (e instanceof Bad) throw e;
      throw new Bad(e instanceof LookupError || e instanceof AuthError ? e.message : `연결을 확인하지 못했습니다 — ${한줄(e)}`);
    }
  };

  post["channel/logout"] = async (c) => {
    // 로그인 정보를 지우는 길 — 사람이 확인 창에서 누른 것만(confirm=true). 로그인이 풀려도(invalid_grant) 새 판이 스스로 지우는 일은 없다.
    if (c.body.confirm !== true) throw new Bad("확인 표시(confirm)가 없습니다 — 화면의 확인 창에서 눌러야 연결을 해제합니다");
    const [alias] = chanOf(c.body.ch);
    const key = resolve(alias) ?? alias;
    // 토큰 항목만 지운다 — 영상·폴더·기록은 그대로. (구글 쪽 권한 취소는 사용자가 구글 계정 설정에서 한다: 같은 계정을 다른 곳에서 쓰고 있을 수 있어 여기서 취소하지 않는다.)
    const had = await updateStore((s) => { const h = key in s; delete s[key]; return h; });
    V.forgetMemo();
    return { removed: had };
  };

  post["profile/refresh"] = async (c) => {
    const [alias] = chanOf(c.body.ch);
    try {
      const prof = await PRO.fetchProfile(resolve(alias) ?? alias);
      prof.art = await PRO.downloadArt(prof);
      await PRO.remember(prof);
      return {};
    } catch (e) { throw new Bad(`채널 정보를 받지 못했습니다 — ${한줄(e)}`); }
  };

  /* ──────────────── 설정 ──────────────── */

  post["settings/get"] = async () => {
    const s = SG.appSettings();
    const pol = UP.loadPolicy();
    const auto = await PLAT.autoStartStatus().catch(() => null);
    const paths = pathConfig();
    const ff = await findTool("ffprobe").catch(() => "");
    return {
      settings: {
        osNotify: s.osNotify, telegram: { ...NF.telegramSummary(), alerts: s.telegramAlerts },
        ai: { on: s.aiTitles, hasKey: !!s.aiKey.trim(), model: s.aiModel },
        policy: { made_for_kids: pol.made_for_kids, contains_synthetic_media: pol.contains_synthetic_media, default_category: pol.default_category },
        paths: { 백업대상: paths["백업대상"] ?? "", 외장뿌리: paths["외장뿌리"] ?? "", 영상뿌리: paths["영상뿌리"] ?? "", ffmpeg: paths["ffmpeg"] ?? "", ffprobe: paths["ffprobe"] ?? "" },
        autoStart: { on: !!auto?.on, supported: !!auto?.supported, serve: !!auto?.serve, tick: !!auto?.tick, how: auto?.how ?? "" },
        browser: s.browser, browsers: await PLAT.listBrowsers().catch(() => []),
        baseDir: s.baseDir, defaultBaseDir: SG.defaultBaseDir(), tickMinutes: s.tickMinutes,
        dataDir: dataDir(), exePath: PLAT.exePath(), version: APP_VERSION, tools: { ffprobe: ff ? "path" : "native" },
        mode: getMode(),
        recall: { on: RC.recallOn(), viewsBar: RC.VIEWS_BAR, minAgeHours: RC.MIN_AGE_HOURS, maxPerRound: RC.MAX_PER_ROUND },
        quota: { reset: QT.today().초기화, readsCap: QT.READ_CAP, unitCap: QT.today().유닛한도, uploadCap: QT.today().업로드한도 },
      },
    };
  };

  post["settings/save"] = async (c) => {
    const b: Obj = c.body.settings && typeof c.body.settings === "object" ? c.body.settings : c.body;
    const patch: Obj = {};
    if (b.osNotify !== undefined) patch.osNotify = !!b.osNotify;
    if (b.telegramAlerts !== undefined) patch.telegramAlerts = !!b.telegramAlerts;
    if (b.browser !== undefined) patch.browser = String(b.browser);
    if (b.baseDir !== undefined) patch.baseDir = String(b.baseDir).trim();
    if (b.tickMinutes !== undefined) patch.tickMinutes = Math.max(1, Math.min(120, Number(b.tickMinutes) || 10));
    if (Object.keys(patch).length) {
      await SG.saveAppSettings(patch);
      if (patch.telegramAlerts !== undefined) NF.setTelegramAlerts(!!patch.telegramAlerts);
    }
    if (b.policy && typeof b.policy === "object") {
      const cur = UP.loadPolicy();
      const raw = readJsonSync<Obj>(dataPath("policy.json"), {});
      await writeJson(dataPath("policy.json"), {
        ...raw, made_for_kids: b.policy.made_for_kids === undefined ? cur.made_for_kids : !!b.policy.made_for_kids,
        contains_synthetic_media: b.policy.contains_synthetic_media === undefined ? cur.contains_synthetic_media : !!b.policy.contains_synthetic_media,
        default_category: b.policy.default_category === undefined ? cur.default_category : Number(b.policy.default_category) || 22,
      });
    }
    if (b.paths && typeof b.paths === "object") {
      const cur = readJsonSync<Obj>(dataPath("경로설정.json"), {});
      for (const k of ["백업대상", "외장뿌리", "영상뿌리", "ffmpeg", "ffprobe"]) if (b.paths[k] !== undefined) { const v = String(b.paths[k]).trim(); if (v) cur[k] = v; else delete cur[k]; }
      await writeJson(dataPath("경로설정.json"), cur);
    }
    if (b.ai && typeof b.ai === "object") await AI.saveAiSettings({ on: b.ai.on, key: b.ai.key, model: b.ai.model, clearKey: !!b.ai.clearKey });
    return {};
  };

  post["telegram/save"] = async (c) => {
    try {
      const ids = (Array.isArray(c.body.chatIds) ? c.body.chatIds : String(c.body.chatIds ?? "").split(/[,\s]+/)).map(String).filter(Boolean);
      await NF.saveTelegramConfig(String(c.body.token ?? ""), ids);
      return {};
    } catch (e) { throw new Bad(한줄(e)); }
  };
  post["telegram/test"] = async () => { const r = await NF.testSend(); if (!r.ok) throw new Bad(r.message); return { sent: r.recipients, message: r.message }; };

  post["autostart"] = async (c) => {
    let m = "";
    try { m = await PLAT.setAutoStart(!!c.body.on); } catch (e) { throw new Bad(한줄(e)); }
    await SG.saveAppSettings({ autoStart: !!c.body.on, ...(c.body.asked ? { autoStartAsked: true } : {}) });
    V.forgetMemo("autostartAsk");
    return { on: !!c.body.on, message: m };
  };

  post["mode/set"] = async (c) => { try { await setMode(String(c.body.m ?? "")); return {}; } catch (e) { throw new Bad(한줄(e)); } };
  post["mode/clear"] = async () => { await clearMode(); return {}; };

  post["ask/answer"] = async (c) => {
    const id = String(c.body.id ?? ""), choice = String(c.body.choice ?? "");
    if (id === "autostart") {
      if (choice === "yes") {
        try { await PLAT.setAutoStart(true); await SG.saveAppSettings({ autoStart: true, autoStartAsked: true }); } catch (e) { await SG.saveAppSettings({ autoStartAsked: true }); throw new Bad(한줄(e)); }
      } else await SG.saveAppSettings({ autoStartAsked: true });
    }
    if (S.ask?.id === id) S.ask = null;
    V.forgetMemo("autostartAsk");
    return {};
  };

  post["update/check"] = async () => ({ ...(await checkUpdate(true)) });
  post["update/decline"] = async () => {
    const info = await checkUpdate(false);
    if (!info.version) return {};
    const s = SG.appSettings();
    const n = (s.updateDeclines[info.version] ?? 0) + 1;
    await SG.saveAppSettings({ updateDeclines: { [info.version]: n } });
    await log(`🔕 업데이트 ${info.version} 거절 (${n}번째)${n >= 2 ? " — 이 버전은 다시 묻지 않습니다" : ""}`);
    return { times: n };
  };
  post["update/install"] = async () => {
    if (S.upd.running) throw new Bad("이미 업데이트를 진행 중입니다.");
    const info: UpdateInfo = await checkUpdate(true);
    if (!info.available) throw new Bad("이미 최신 버전입니다.");
    if (!info.canInstall) throw new Bad(info.reason || "이 상태에서는 자동 설치할 수 없습니다.");
    if (S.job.running) throw new Bad("업로드가 진행 중입니다. 끝난 뒤에 다시 눌러 주세요.");
    S.upd = { running: true, pct: 0, text: "준비 중…", error: "" };
    installUpdate(info, (pct, text) => { S.upd.pct = pct; S.upd.text = text; }).catch(async (e) => {
      S.upd = { running: false, pct: 0, text: "", error: 말(e) };
      await log(`⚠️  업데이트 실패: ${S.upd.error}`);
    });
    return {};
  };

  /* ──────────────── 점검·보관·기타 ──────────────── */

  post["env/check"] = async () => { const r = await EV.report(); return { lines: EV.formatReport(r), ok: r.ok }; };
  post["self/check"] = async () => {
    const lines: string[] = [];
    const rep = await SC.runChecks(SC.defaultChecks(), { say: (l: string) => lines.push(l) } as never);
    return { lines, ok: (rep as Obj).ok ?? true };
  };
  post["archive/keep"] = async () => ({ kept: await AR.keepToday(true), days: (await AR.listKept()).length });
  post["archive/mirror"] = async () => { const r = await AR.mirror(true); return { code: r.code, copied: r.copied, deleted: r.deleted, message: r.message }; };

  post["open"] = async (c) => {
    const p = expandHome(String(c.body.path ?? ""));
    if (!p) throw new Bad("경로가 비었습니다");
    const ok = V.underRoots(p) || p === dataDir() || p === SG.appSettings().baseDir;
    if (!ok) throw new Bad("등록된 채널 폴더만 열 수 있습니다");
    if (!(await PLAT.openPath(p))) throw new Bad("열지 못했습니다");
    return {};
  };
  /** 폴더 고르는 운영체제 창 — 설정 탭의 「고르기」. 고른 경로만 돌려주고 아무것도 바꾸지 않는다. */
  post["dir/pick"] = async (c) => {
    const got = await PLAT.pickFolder(expandHome(String(c.body.start ?? "")), cut(String(c.body.prompt ?? "폴더를 고르세요"), 80));
    if (!got) throw new Bad("선택이 취소되었습니다");
    return { path: got };
  };
  post["openself"] = async (c) => { await PLAT.openUrl(`http://127.0.0.1:${c.port}/`, SG.appSettings().browser); return {}; };

  post["thumb/inspect"] = async (c) => { const [alias] = chanOf(c.body.ch); return { ...(await TH.inspectLongforms(alias)) }; };
  post["thumb/replace"] = async (c) => {
    const [alias] = chanOf(c.body.ch);
    const img = String(c.body.file ?? "");
    if (!img) throw new Bad("바꿀 그림 파일을 골라 주세요");
    try { return { ...(await TH.replaceThumbnail(alias, need(c.body.videoId, "영상"), img, { apply: c.body.apply === true })) }; } catch (e) { throw new Bad(한줄(e)); }
  };

  post["feedback"] = async (c) => await sendFeedback(c.body);
  post["openfeedback"] = async () => {
    const f = join(await desktopDir(), "가라사대_피드백.txt");
    try { await Deno.stat(f); } catch { throw new Bad("아직 보낸 의견이 없습니다."); }
    await PLAT.openPath(f);
    return {};
  };

  void minuteWall; void parseNaive; void wallToInstant; void dateOnly; void systemZone; void tailFile; void recordPath; void accessToken; void entryFor; void IS_WIN; void dirName; void SF; void thumbnailsSet; void loadChannelsRaw; void readJson; void deviceSecretsPath; void secretsPath; void MG; void TK; void cut; void writeTextAtomic;
  return { get, post };
}


/* ============================================================ 의견 (옛 앱과 같은 모양) */

const 의견 = { 목록: null as unknown[] | null, 본때: 0 };

async function sendFeedback(b: Obj): Promise<Obj> {
  const t = String(b.title ?? "").trim().slice(0, 120);
  const body = String(b.body ?? "").trim().slice(0, 4000);
  if (!t) throw new Bad("제목을 입력해 주세요.");
  if (!body) throw new Bad("내용을 입력해 주세요.");
  const kindLabel: Record<string, string> = { bug: "🐞 오류 신고", idea: "💡 기능 요청", etc: "💬 기타 의견" };
  const label = kindLabel[String(b.kind)] ?? kindLabel.etc;
  const os = IS_WIN ? "윈도우" : IS_MAC ? "맥" : "리눅스";
  const when = new Date().toLocaleString("ko-KR");
  let saved = "";
  try {
    const f = join(await desktopDir(), "가라사대_피드백.txt");
    let prev = "";
    try { prev = await Deno.readTextFile(f); } catch { /* 처음이면 없음 */ }
    const n = (prev.match(/^\d+\. /gm) ?? []).length + 1;
    const entry = `${n}. [${label}] ${t}\n   보낸 때 : ${when}\n   환경    : ${os} · 프로그램 ${APP_VERSION}\n   내용    : ${body.split("\n").join("\n             ")}\n\n`;
    const head = prev ? "" : "가라사대 업로더 — 보낸 의견 모음\n" + "=".repeat(40) + "\n\n";
    await Deno.writeTextFile(f, head + prev + entry);
    saved = f;
  } catch (e) { await log(`⚠️  의견을 파일로 저장하지 못했습니다: ${말(e)}`); }
  const REPO = (await import("./paths.ts")).REPO;
  const issueBody = `${body}\n\n---\n환경: ${os} · 프로그램 ${APP_VERSION}\n보낸 때: ${when}`;
  const 라벨 = b.kind === "idea" ? "💡 요청" : b.kind === "bug" ? "🐞 오류" : "";
  const url = `https://github.com/${REPO}/issues/new?` + new URLSearchParams({
    title: `[${label.replace(/^\S+\s/, "")}] ${t}`, body: issueBody, ...(라벨 ? { labels: `${라벨},🆕 접수` } : {}),
  });
  await log(`💬 의견 접수: ${t}`);
  return { url, saved };
}

/** 보낸 의견이 지금 어디까지 왔나 — 게시판을 프로그램 안에서 보여 준다. 로그인 없이 읽고(공개 저장소) 5분 동안 재사용한다(IP 당 시간 60회 제한). */
async function feedbackList(): Promise<Obj> {
  const 이제 = Date.now();
  if (의견.목록 && 이제 - 의견.본때 < 5 * 60_000) return { items: 의견.목록 };
  try {
    const REPO = (await import("./paths.ts")).REPO;
    const r = await fetch(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=30&sort=created&direction=desc`, {
      // ★User-Agent 는 ASCII 여야 한다 — 한글을 넣으면 헤더를 못 만들고 통째로 실패한다(실측 2026-08-28). 깃허브는 UA 를 요구한다.
      headers: { Accept: "application/vnd.github+json", "User-Agent": "garasadae-uploader" }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { await r.body?.cancel(); throw new Bad(`게시판을 읽지 못했습니다 (${r.status}).`); }
    const 날것 = await r.json();
    의견.목록 = (Array.isArray(날것) ? 날것 : []).filter((x: Obj) => !x.pull_request).map((x: Obj) => ({
      number: x.number, title: x.title, closed: x.state === "closed", at: x.created_at, url: x.html_url, labels: ((x.labels ?? []) as { name: string }[]).map((l) => l.name),
    }));
    의견.본때 = 이제;
    return { items: 의견.목록 };
  } catch (e) { throw e instanceof Bad ? e : new Bad(`게시판에 연결하지 못했습니다 — ${한줄(e)}`); }
}

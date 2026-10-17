// 채널 정보 자동 수집 — 채널명·배너·프로필 사진을 유튜브에서 그대로 가져온다. (파이썬 profile.py)
//
// 처음 인증할 때 한 번 받아 두면 앱 화면에 채널 이름과 배너가 자동으로 나온다.
// 표시용 이름은 나중에 자유롭게 바꿔도 되고, 실제 채널은 channel_id 로 묶이므로 연결이 풀리지 않는다.
//
// 구독자 수의 정확도
//   Data API 는 유효숫자 3자리로 내림한다(1,724명은 1720). 1,000명 미만은 1명 단위로 읽힌다.
//   정확값(subscribers_exact)이 한 번 기록된 채널은 공개 근삿값이 그것을 덮어쓰지 못한다.
//   (맥의 로그인된 크롬 스튜디오에서 읽는 장치는 이 앱에 없다 — 정확값은 확인 대기로 표시한다.)
import { dataPath, join, readJson, recordPath, withFileLock, writeJson, log, exists } from "./paths.ts";
import { doFetch } from "./google.ts";
import { channelMine, channelsById } from "./youtube.ts";
import { loadStore, resolve, ytFor } from "./ytcore.ts";

type Obj = Record<string, any>;

export const profilesPath = () => dataPath("profiles.json");
export const artDir = () => dataPath("채널이미지");
export const statStatePath = () => recordPath("구독갱신.json");
export const STAT_INTERVAL = 60;

export function apiStatistics(st: Obj, now: number): Obj {
  const count = st.hiddenSubscriberCount || !("subscriberCount" in st) ? null : parseInt(st.subscriberCount, 10);
  return {
    subscribers: count,
    subscribers_api: count,
    subscribers_exact: count !== null && count < 1000,
    subscribers_source: "youtube_data_api",
    subscribers_at: now,
    views: "viewCount" in st ? parseInt(st.viewCount, 10) : null,
    videos: "videoCount" in st ? parseInt(st.videoCount, 10) : null,
    statistics_at: now,
  };
}

/** 채널명·설명·배너·프로필 사진 주소를 받아온다. 1유닛. */
export async function fetchProfile(channelKey: string): Promise<Obj> {
  const yt = await ytFor(channelKey);
  const ch = await channelMine(yt, "snippet,brandingSettings,statistics");
  if (!ch) throw new Error("채널 정보를 읽지 못했습니다");
  const sn = ch.snippet ?? {}, br = ch.brandingSettings ?? {}, st = ch.statistics ?? {};
  const th = sn.thumbnails ?? {};
  const avatar = (th.high ?? th.medium ?? th.default ?? {}).url;
  return {
    channel_id: ch.id,
    title: sn.title ?? "",
    handle: sn.customUrl ?? "",
    description: String(sn.description ?? "").slice(0, 300),
    avatar,
    banner: br.image?.bannerExternalUrl,
    ...apiStatistics(st, Date.now() / 1000),
  };
}

/** 배너와 프로필 사진을 로컬에 받아 둔다. 앱이 네트워크 없이도 그릴 수 있게. */
export async function downloadArt(prof: Obj): Promise<Obj> {
  await Deno.mkdir(artDir(), { recursive: true });
  const saved: Obj = {};
  for (const [kind, raw] of [["avatar", prof.avatar], ["banner", prof.banner]] as const) {
    if (!raw) continue;
    // 배너 원본은 매우 크다. 화면에 쓰기 좋은 폭으로 받는다.
    const url = kind === "banner" ? raw + "=w1280-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj" : raw;
    const dest = join(artDir(), `${prof.channel_id}_${kind}.jpg`);
    try {
      const r = await doFetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`${r.status}`);
      await Deno.writeFile(dest, new Uint8Array(await r.arrayBuffer()));
      saved[kind] = dest;
    } catch (e) {
      saved[kind] = null;
      await log(`    ${kind} 내려받기 실패: ${String(e instanceof Error ? e.message : e).slice(0, 60)}`);
    }
  }
  return saved;
}

export async function loadProfiles(): Promise<Record<string, Obj>> {
  return await readJson<Record<string, Obj>>(profilesPath(), {});
}
export async function saveProfiles(d: Record<string, Obj>): Promise<void> {
  await writeJson(profilesPath(), d);
}
export async function removeProfile(cid: string): Promise<void> {
  await withFileLock(dataPath("profiles.lock"), async () => {
    const d = await loadProfiles();
    if (cid in d) { delete d[cid]; await saveProfiles(d); }
  });
}

/** 읽은 채널 정보를 표시용 저장소에도 반영한다. 정확값을 공개 근삿값이 덮지 않게 지킨다. */
export async function remember(prof: Obj): Promise<Obj> {
  const r = await withFileLock(dataPath("profiles.lock"), async () => {
    const data = await loadProfiles();
    const cid = String(prof.channel_id);
    const old = data[cid] ?? {};
    const incoming = { ...prof };
    if (incoming.subscribers_source === "youtube_data_api" && incoming.subscribers != null &&
      !incoming.subscribers_exact && old.subscribers_exact) {
      // 수동 지표·일일 수집이 주인의 정확한 숫자를 낮은 공개 숫자로 바꾸거나 옛 값을 새것이라 주장하면 안 된다.
      for (const k of ["subscribers", "subscribers_exact", "subscribers_source", "subscribers_at"]) incoming[k] = old[k];
    }
    data[cid] = { ...old, ...incoming };
    await saveProfiles(data);
    return data[cid];
  });
  return r as Obj;
}

export async function statisticsState(): Promise<Obj> {
  return await readJson<Obj>(statStatePath(), {});
}

export async function statisticsDue(now = Date.now() / 1000): Promise<boolean> {
  const at = (await statisticsState()).attempted_at;
  return at === undefined || at === null || now - at >= STAT_INTERVAL || now < at;
}

/**
 * 현재 등록 채널 총계를 한 번에 조회. 여러 탭·실패 재시도도 1분 간격.
 * 사람이 새로고침을 눌렀을 때만 force 로 부른다.
 */
export async function refreshStatistics(
  chans: Record<string, { channel_id?: string }>, o: { now?: number; force?: boolean } = {},
): Promise<Obj> {
  const now = o.now ?? Date.now() / 1000;
  const r = await withFileLock(dataPath("구독갱신.lock"), async () => {
    if (!o.force && !(await statisticsDue(now))) return await statisticsState();
    const ids = [...new Set(Object.entries(chans).filter(([k, v]) => !k.startsWith("_") && v.channel_id)
      .map(([, v]) => v.channel_id!))];
    const state: Obj = { attempted_at: now, updated: [], errors: {}, exact_updated: [] };
    await writeJson(statStatePath(), state);
    try {
      const key = ids.map((cid) => resolve(cid)).find(Boolean);
      if (!key) throw new Error("조회할 수 있는 인증 채널이 없습니다");
      const yt = await ytFor(key);
      for (let s = 0; s < ids.length; s += 50) {
        const batch = ids.slice(s, s + 50);
        const items = await channelsById(yt, batch, "statistics");
        const received = new Set<string>();
        for (const ch of items) {
          const cid = ch.id, st = ch.statistics ?? {};
          if (!batch.includes(cid) || !Object.keys(st).length) continue;
          const prof: Obj = { channel_id: cid, ...apiStatistics(st, now) };
          await remember(prof);
          if (prof.subscribers_exact) state.exact_updated.push(cid);
          received.add(cid);
          state.updated.push(cid);
        }
        for (const cid of batch) if (!received.has(cid)) state.errors[cid] = "채널 총계를 읽지 못했습니다";
      }
    } catch (exc) {
      state.errors.request = `${exc instanceof Error ? exc.name : "오류"}: ${String(exc instanceof Error ? exc.message : exc).slice(0, 160)}`;
      await log(`  구독자 갱신 실패 — ${state.errors.request}`);
    }
    // 1,000명 이상은 공개 값의 자릿수가 깎인다. 이 앱은 스튜디오 화면을 읽는 장치가 없으므로
    // 추측하거나 정확한 값인 척하지 않고 「정확값 확인 대기」로 둔다.
    const stored = await loadProfiles();
    const wanted = ids.filter((cid) => (stored[cid]?.subscribers_api ?? 0) >= 1000);
    if (wanted.length) {
      state.exact_errors = Object.fromEntries(wanted.map((cid) => [cid, "정확한 구독자 수는 스튜디오 화면에서만 읽힙니다(이 앱은 읽지 않음)"]));
    }
    // 오늘 점을 구독 기록에도 남긴다
    try {
      const { record } = await import("./subs.ts");
      const after = await loadProfiles();
      for (const cid of state.updated as string[]) {
        const prof = after[cid];
        if (!prof) continue;
        for (const [name, cf] of Object.entries(chans)) {
          if (!name.startsWith("_") && cf.channel_id === cid) {
            await record(name, prof.subscribers, prof.views, prof.videos, { exact: prof.subscribers_exact, source: prof.subscribers_source });
          }
        }
      }
    } catch (e) {
      // 구독 기록은 덤이다 — 못 남겨도 갱신은 끝낸다. 다만 왜 기록이 안 쌓이는지 알 수 있게 한 줄은 남긴다.
      await log(`  구독 기록을 남기지 못했습니다 — ${String(e instanceof Error ? e.message : e).slice(0, 80)}`);
    }
    await writeJson(statStatePath(), state);
    return state;
  });
  return r as Obj;
}

/** 등록된 모든 토큰 채널의 정보를 새로 받는다 (`정보` 명령) */
export async function refreshAll(): Promise<{ key: string; ok: boolean; title?: string; why?: string }[]> {
  const out: { key: string; ok: boolean; title?: string; why?: string }[] = [];
  for (const key of Object.keys(loadStore())) {
    try {
      const prof = await fetchProfile(key);
      prof.art = await downloadArt(prof);
      const got = await remember(prof);
      out.push({ key, ok: true, title: got.title });
    } catch (e) {
      out.push({ key, ok: false, why: String(e instanceof Error ? e.message : e).slice(0, 70) });
    }
  }
  return out;
}

export { exists };

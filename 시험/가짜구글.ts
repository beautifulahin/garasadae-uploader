// 가짜 구글 서버 — 시험이 구글 대신 받는 메모리 속 흉내. 실제 네트워크는 한 번도 안 쓴다.
//
// 흉내 내는 것
//   · OAuth: 토큰 갱신(refresh_token) · 인가 코드 교환(authorization_code) · 기기 코드(device_code)
//   · channels.list(mine / id) · videos.list(part별) · videos.update(part를 통째로 갈아 끼움 — 진짜 유튜브처럼
//     보내지 않은 칸은 지워진다) · videos:batchGetStats(공개 영상만) · 이어올리기 videos.insert(308/200)
//   · thumbnails.set · playlistItems.list · youtubeAnalytics reports · 텔레그램 · 이미지 내려받기
//   · 오류 주입(failNext) · 호출 기록(calls)
import { setFetch } from "../app/google.ts";

type Obj = Record<string, any>;

export interface FakeChannel { id: string; title: string; handle?: string; subs?: number | null; views?: number; videos?: number }
export interface FakeVideo {
  id: string; channelId: string;
  snippet: Obj; status: Obj; statistics: Obj; contentDetails: Obj; processingDetails: Obj;
}
export interface Call { method: string; url: string; path: string; query: Record<string, string>; body: any; auth: string; name: string }

export class 가짜구글 {
  channels = new Map<string, FakeChannel>();
  /** 리프레시 토큰 → 채널 id */
  refreshTo = new Map<string, string>();
  /** 인가 코드 → {refresh, scope} (브라우저 로그인 시험) */
  codes = new Map<string, { refresh: string; scope: string; noRefresh?: boolean }>();
  /** 기기 코드 상태: pending | ok | denied | slow */
  devices = new Map<string, { state: string; refresh?: string; scope?: string }>();
  videos = new Map<string, FakeVideo>();
  calls: Call[] = [];
  telegram: { token: string; chat: string; text: string }[] = [];
  thumbs: { videoId: string; bytes: number; mime: string }[] = [];
  private failures: { match: RegExp; status: number; body: Obj; times: number }[] = [];
  private uploads = new Map<string, { total: number; got: number; body: Obj; channelId: string; chunks: number }>();
  private seq = 0;
  /** 업로드 조각을 일부러 한 번 끊는다 (이어올리기 시험) */
  dropNextChunk = false;
  /** 올린 영상이 곧바로 처리 끝으로 보이게 */
  instantProcessing = false;
  /** 시험에서 쓰는 시계 (기본 지금) */
  now = () => new Date();

  install() { setFetch(this.handle); return this; }
  uninstall() { setFetch(null); }

  addChannel(c: FakeChannel, refresh?: string) {
    this.channels.set(c.id, { subs: 0, views: 0, videos: 0, handle: "@" + c.title, ...c });
    if (refresh) this.refreshTo.set(refresh, c.id);
    return this;
  }
  grant(refresh: string, channelId: string) { this.refreshTo.set(refresh, channelId); return this; }

  /** 다음 n 번의 요청 중 주소가 match 인 것을 오류로 돌려준다 */
  failNext(match: RegExp, status: number, body: Obj = {}, times = 1) {
    this.failures.push({ match, status, body, times });
    return this;
  }

  addVideo(v: Partial<FakeVideo> & { id: string; channelId: string }): FakeVideo {
    const full: FakeVideo = {
      id: v.id, channelId: v.channelId,
      snippet: { title: "제목", description: "", tags: [], categoryId: "22", publishedAt: this.now().toISOString(), channelId: v.channelId, ...(v.snippet ?? {}) },
      status: { uploadStatus: "processed", privacyStatus: "public", embeddable: true, publicStatsViewable: true, selfDeclaredMadeForKids: false, license: "youtube", ...(v.status ?? {}) },
      statistics: { viewCount: "0", likeCount: "0", commentCount: "0", ...(v.statistics ?? {}) },
      contentDetails: { duration: "PT40S", ...(v.contentDetails ?? {}) },
      processingDetails: { processingStatus: "succeeded", ...(v.processingDetails ?? {}) },
    };
    this.videos.set(v.id, full);
    return full;
  }

  /** 올라간 영상의 처리·심사가 끝났다고 표시 */
  finishProcessing(id: string) {
    const v = this.videos.get(id)!;
    v.status.uploadStatus = "processed";
    v.processingDetails = { processingStatus: "succeeded" };
  }

  callsTo(re: RegExp): Call[] { return this.calls.filter((c) => re.test(c.name) || re.test(c.path)); }
  clearCalls() { this.calls = []; }

  /* ───────────── 요청 처리 ───────────── */

  private json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }
  private err(status: number, reason: string, message = reason, extra: Obj = {}) {
    return this.json({ error: { code: status, message, errors: [{ reason, message }], status: extra.status ?? "" } }, status);
  }
  private tokenChannel(auth: string): string | null {
    const m = /^Bearer AT:(.+)$/.exec(auth);
    return m ? (this.refreshTo.get(m[1]) ?? null) : null;
  }

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const auth = headers.get("authorization") ?? "";
    let body: any = init?.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { /* 폼 글 그대로 */ } }
    const query = Object.fromEntries(url.searchParams.entries());
    const path = url.pathname;
    const name = this.nameOf(url, method);
    this.calls.push({ method, url: url.toString(), path, query, body: body instanceof Uint8Array ? `<${body.length}바이트>` : body, auth, name });

    for (const f of this.failures) {
      if (f.times > 0 && f.match.test(url.toString())) { f.times--; return this.json(f.body, f.status); }
    }

    // ── 이미지 내려받기
    if (url.host === "fake.img") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
    // ── 텔레그램
    if (url.host === "api.telegram.org") {
      const m = /bot([^/]+)\/sendMessage/.exec(path);
      const form = body instanceof URLSearchParams ? body : new URLSearchParams(String(body ?? ""));
      this.telegram.push({ token: m?.[1] ?? "", chat: form.get("chat_id") ?? "", text: form.get("text") ?? "" });
      return this.json({ ok: true });
    }
    // ── OAuth
    if (url.host === "oauth2.googleapis.com") return this.oauth(path, body, headers);
    // ── 이어올리기 세션
    if (url.host === "fake.upload") return this.uploadChunk(url, method, headers, body);

    const ch = this.tokenChannel(auth);
    if (!ch) return this.err(401, "authError", "Invalid Credentials");

    if (path === "/youtube/v3/channels" && method === "GET") return this.channelsList(query, ch);
    if (path === "/youtube/v3/videos" && method === "GET") return this.videosList(query, ch);
    if (path === "/youtube/v3/videos:batchGetStats") return this.batchStats(query);
    if (path === "/youtube/v3/videos" && method === "PUT") return this.videosUpdate(query, body, ch);
    if (path === "/upload/youtube/v3/videos" && method === "POST") return this.uploadInit(query, body, headers, ch);
    if (path === "/upload/youtube/v3/thumbnails/set" && method === "POST") {
      this.thumbs.push({ videoId: query.videoId, bytes: body?.length ?? 0, mime: headers.get("content-type") ?? "" });
      return this.json({ items: [{ default: { url: "https://fake.img/t.jpg" } }] });
    }
    if (path === "/youtube/v3/playlistItems") return this.playlist(query);
    if (path === "/v2/reports") return this.json({ columnHeaders: [], rows: [] });
    return this.err(404, "notFound", `가짜 서버가 모르는 주소: ${method} ${path}`);
  };

  private nameOf(url: URL, method: string): string {
    const p = url.pathname;
    if (p.includes("videos:batchGetStats")) return "videos.batchGetStats";
    if (url.host.includes("youtubeanalytics")) return "analytics.query";
    if (p.startsWith("/upload/youtube/v3/videos")) return "videos.insert";
    if (p.startsWith("/upload/youtube/v3/thumbnails")) return "thumbnails.set";
    const m = /\/youtube\/v3\/([A-Za-z]+)/.exec(p);
    if (!m) return url.host;
    if (m[1] === "videos") return method === "PUT" ? "videos.update" : "videos.list";
    return `${m[1]}.${method === "GET" ? "list" : method.toLowerCase()}`;
  }

  private oauth(path: string, body: any, _h: Headers): Response {
    const f = body instanceof URLSearchParams ? body : new URLSearchParams(String(body ?? ""));
    if (path === "/device/code") {
      const n = ++this.seq;
      const code = `DEV${n}`;
      this.devices.set(code, { state: "pending" });
      return this.json({ device_code: code, user_code: `ABCD-${1000 + n}`, verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 });
    }
    if (path === "/token") {
      const g = f.get("grant_type");
      if (g === "refresh_token") {
        const rt = f.get("refresh_token") ?? "";
        if (!this.refreshTo.has(rt)) return this.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
        return this.json({ access_token: `AT:${rt}`, expires_in: 3600, scope: f.get("scope") ?? "", token_type: "Bearer" });
      }
      if (g === "authorization_code") {
        const c = this.codes.get(f.get("code") ?? "");
        if (!c || !f.get("code_verifier")) return this.json({ error: "invalid_grant", error_description: "Bad code" }, 400);
        return this.json({ access_token: `AT:${c.refresh}`, ...(c.noRefresh ? {} : { refresh_token: c.refresh }), expires_in: 3600, scope: c.scope });
      }
      if (g === "urn:ietf:params:oauth:grant-type:device_code") {
        const d = this.devices.get(f.get("device_code") ?? "");
        if (!d) return this.json({ error: "invalid_grant" }, 400);
        if (d.state === "pending") return this.json({ error: "authorization_pending" }, 428);
        if (d.state === "slow") { d.state = "pending"; return this.json({ error: "slow_down" }, 400); }
        if (d.state === "denied") return this.json({ error: "access_denied", error_description: "사용자가 거절" }, 403);
        if (d.state === "expired") return this.json({ error: "expired_token" }, 400);
        return this.json({ access_token: `AT:${d.refresh}`, refresh_token: d.refresh, expires_in: 3600, scope: d.scope ?? "" });
      }
    }
    return this.json({ error: "unsupported_grant_type" }, 400);
  }

  private channelsList(q: Record<string, string>, tokenCh: string): Response {
    const parts = (q.part ?? "").split(",");
    const make = (c: FakeChannel): Obj => {
      const o: Obj = { id: c.id };
      if (parts.includes("snippet")) o.snippet = { title: c.title, customUrl: c.handle, description: "소개", thumbnails: { high: { url: "https://fake.img/a.jpg" } } };
      if (parts.includes("brandingSettings")) o.brandingSettings = { image: { bannerExternalUrl: "https://fake.img/b" } };
      if (parts.includes("statistics")) {
        o.statistics = c.subs === null ? { hiddenSubscriberCount: true, viewCount: String(c.views ?? 0), videoCount: String(c.videos ?? 0) }
          : { subscriberCount: String(c.subs ?? 0), viewCount: String(c.views ?? 0), videoCount: String(c.videos ?? 0) };
      }
      if (parts.includes("contentDetails")) o.contentDetails = { relatedPlaylists: { uploads: "UU" + c.id.slice(2) } };
      return o;
    };
    if (q.mine === "true") {
      const c = this.channels.get(tokenCh);
      return this.json({ items: c ? [make(c)] : [] });
    }
    const ids = (q.id ?? "").split(",").filter(Boolean);
    return this.json({ items: ids.map((i) => this.channels.get(i)).filter(Boolean).map((c) => make(c!)) });
  }

  private pick(v: FakeVideo, parts: string[]): Obj {
    const o: Obj = { id: v.id };
    for (const p of parts) if ((v as any)[p]) o[p] = structuredClone((v as any)[p]);
    return o;
  }

  private videosList(q: Record<string, string>, tokenCh: string): Response {
    const parts = (q.part ?? "").split(",").filter(Boolean);
    const ids = (q.id ?? "").split(",").filter(Boolean);
    const items = ids.map((i) => this.videos.get(i)).filter((v): v is FakeVideo => !!v && v.channelId === tokenCh)
      .map((v) => this.pick(v, parts));
    return this.json({ items });
  }

  private batchStats(q: Record<string, string>): Response {
    const parts = (q.part ?? "").split(",").filter(Boolean);
    const ids = (q.id ?? "").split(",").filter(Boolean);
    // 공개 영상만 준다
    const items = ids.map((i) => this.videos.get(i)).filter((v): v is FakeVideo => !!v && v.status.privacyStatus === "public")
      .map((v) => this.pick(v, parts));
    return this.json({ items });
  }

  /** 진짜 유튜브처럼: 보낸 part 를 통째로 갈아 끼운다. 보내지 않은 칸은 지워진다. */
  private videosUpdate(q: Record<string, string>, body: any, tokenCh: string): Response {
    const v = this.videos.get(body?.id);
    if (!v || v.channelId !== tokenCh) return this.err(404, "videoNotFound");
    const parts = (q.part ?? "").split(",");
    if (parts.includes("status")) {
      const s = body.status ?? {};
      if (s.publishAt && s.privacyStatus !== "private") return this.err(400, "invalidPublishAt", "publishAt 은 비공개일 때만");
      if (s.publishAt && Date.parse(s.publishAt) <= this.now().getTime()) return this.err(400, "invalidPublishAt", "이미 지난 예약");
      v.status = { uploadStatus: v.status.uploadStatus, ...s };
    }
    if (parts.includes("snippet")) {
      const sn = body.snippet ?? {};
      if (!sn.title) return this.err(400, "invalidVideoMetadata", "title 필요");
      v.snippet = { publishedAt: v.snippet.publishedAt, channelId: v.snippet.channelId, ...sn };
    }
    return this.json(this.pick(v, parts));
  }

  private playlist(q: Record<string, string>): Response {
    const cid = "UC" + (q.playlistId ?? "").slice(2);
    const vids = [...this.videos.values()].filter((v) => v.channelId === cid)
      .sort((a, b) => String(b.snippet.publishedAt).localeCompare(String(a.snippet.publishedAt)));
    const max = Number(q.maxResults ?? 50);
    const start = Number(q.pageToken ?? 0);
    const page = vids.slice(start, start + max);
    return this.json({
      items: page.map((v) => ({ snippet: { title: v.snippet.title, resourceId: { videoId: v.id }, publishedAt: v.snippet.publishedAt }, contentDetails: { videoId: v.id } })),
      nextPageToken: start + max < vids.length ? String(start + max) : undefined,
    });
  }

  /* ───────────── 이어올리기 ───────────── */

  private uploadInit(q: Record<string, string>, body: any, h: Headers, channelId: string): Response {
    if (q.uploadType !== "resumable") return this.err(400, "badRequest", "resumable 만 흉내 냅니다");
    const id = String(++this.seq);
    this.uploads.set(id, { total: Number(h.get("x-upload-content-length")), got: 0, body, channelId, chunks: 0 });
    return new Response(null, { status: 200, headers: { location: `https://fake.upload/session/${id}` } });
  }

  private uploadChunk(url: URL, method: string, h: Headers, body: any): Response {
    const id = url.pathname.split("/").pop()!;
    const u = this.uploads.get(id);
    if (!u) return this.err(404, "notFound");
    this.calls.push({ method, url: url.toString(), path: url.pathname, query: {}, body: `<조각 ${h.get("content-range")}>`, auth: "", name: "videos.insert#chunk" });
    const cr = h.get("content-range") ?? "";
    if (/^bytes \*\//.test(cr)) {
      if (u.got >= u.total) return this.json(this.finishUpload(id));
      return new Response(null, { status: 308, headers: u.got ? { range: `bytes=0-${u.got - 1}` } : {} });
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    if (!m) return this.err(400, "badRange");
    if (this.dropNextChunk) { this.dropNextChunk = false; throw new TypeError("연결이 끊겼습니다(시험)"); }
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a !== u.got) return new Response(null, { status: 308, headers: u.got ? { range: `bytes=0-${u.got - 1}` } : {} });
    u.got = b + 1;
    u.chunks++;
    if (u.got >= u.total) return this.json(this.finishUpload(id));
    return new Response(null, { status: 308, headers: { range: `bytes=0-${u.got - 1}` } });
  }

  private finishUpload(id: string): Obj {
    const u = this.uploads.get(id)!;
    const vid = `FAKE${String(id).padStart(6, "0")}`;
    if (!this.videos.has(vid)) {
      const sn = u.body?.snippet ?? {};
      const st = u.body?.status ?? {};
      this.videos.set(vid, {
        id: vid, channelId: u.channelId,
        snippet: { ...sn, publishedAt: this.now().toISOString(), channelId: u.channelId },
        status: {
          uploadStatus: this.instantProcessing ? "processed" : "uploaded", privacyStatus: st.privacyStatus ?? "private",
          embeddable: st.embeddable, publicStatsViewable: st.publicStatsViewable,
          selfDeclaredMadeForKids: st.selfDeclaredMadeForKids, ...(st.containsSyntheticMedia !== undefined ? {} : {}), license: "youtube",
          ...(st.publishAt ? { publishAt: st.publishAt } : {}),
        },
        statistics: { viewCount: "0", likeCount: "0", commentCount: "0" },
        contentDetails: { duration: "PT40S" },
        processingDetails: { processingStatus: this.instantProcessing ? "succeeded" : "processing" },
      });
    }
    const v = this.videos.get(vid)!;
    return { id: vid, snippet: { title: v.snippet.title }, status: { privacyStatus: v.status.privacyStatus, embeddable: v.status.embeddable, publicStatsViewable: v.status.publicStatsViewable } };
  }
}

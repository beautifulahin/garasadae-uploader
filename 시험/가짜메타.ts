// 가짜 메타 세상 — 시험이 인스타그램·스레드·로그인 중계 서버·임시 보관(R2) 대신 받는 메모리 속 흉내. 실제 네트워크는 한 번도 안 쓴다.
//
// 흉내 내는 것
//   · 중계 서버: POST /pickup (한 번만) · POST /stage/ticket · POST /stage/delete        (https://relay.example.test)
//   · 임시 보관 PUT                                                                    (https://r2.example.test)
//   · 인스타그램 그래프: 토큰 갱신 · 컨테이너(릴스) 만들기 · 상태 · 게시 · 최근 게시물 · permalink/media_url
//   · 스레드 그래프: 같은 것
//   · 오류 주입(failNext) · 게시 결과 모드(올라갔는데 5xx / 안 올라가고 5xx / 시간 초과 …) · 호출 기록(calls)
// 그 밖의 주소는 가짜 구글(있으면)에게 넘기고, 그것도 없으면 시험이 틀린 것이므로 오류로 돌려준다.
import { setFetch } from "../app/google.ts";
import type { 가짜구글 } from "./가짜구글.ts";

type Obj = Record<string, any>;

export interface MetaCall { method: string; url: string; host: string; path: string; query: Record<string, string>; form: Record<string, string>; json: Obj | null; name: string; bytes?: number }

export type PublishMode = "ok" | "5xx_posted" | "5xx_lost" | "timeout_posted" | "timeout_lost" | "notready" | "reject";

interface Container { id: string; kind: "ig" | "th"; params: Record<string, string>; polls: number; failed?: string }

const sha256b64u = async (t: string) => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export class 가짜메타 {
  worker = "https://relay.example.test";
  calls: MetaCall[] = [];
  /** 이 토큰들만 맞는 토큰으로 받는다 (아니면 메타가 190 로그인 만료로 돌려준다) */
  validTokens = new Set<string>();
  /** challenge → 가져갈 토큰 꾸러미 (한 번 가져가면 사라진다) */
  pickups = new Map<string, Obj>();
  staged = new Map<string, { bytes: number; ext: string; deleted: boolean; putBytes: number; putLength: string | null }>();
  putFail = false;
  containers = new Map<string, Container>();
  igMedia: { id: string; caption: string; permalink: string; timestamp: string }[] = [];
  thPosts: { id: string; text: string; permalink: string; timestamp: string }[] = [];
  /** 컨테이너 상태가 처음부터 차례로 나온다 (마지막 값은 계속 나온다) */
  igStatus: string[] = ["FINISHED"];
  thStatus: string[] = ["FINISHED"];
  igPublish: PublishMode = "ok";
  thPublish: PublishMode = "ok";
  /** 인스타 영상의 내려받기 주소 — null 이면 media_url 칸이 없다 */
  mediaUrl: string | null = "https://cdn.example.test/reel.mp4";
  /** true 면 스레드가 인스타 media_url 로는 영상을 처리하지 못한다(ERROR) */
  rejectMediaUrl = false;
  refreshFail = false;
  private failures: { match: RegExp; status: number; body: Obj; times: number }[] = [];
  private seq = 0;

  install(g?: 가짜구글) {
    setFetch(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (["relay.example.test", "r2.example.test", "graph.instagram.com", "graph.threads.com", "cdn.example.test"].includes(url.host)) return await this.handle(url, init);
      if (g) return await g.handle(input, init);
      return new Response(JSON.stringify({ error: { message: `가짜 메타가 모르는 주소: ${url}` } }), { status: 404 });
    });
    return this;
  }
  failNext(match: RegExp, status: number, body: Obj = {}, times = 1) { this.failures.push({ match, status, body, times }); return this; }
  callsTo(re: RegExp): MetaCall[] { return this.calls.filter((c) => re.test(c.name)); }
  clearCalls() { this.calls = []; }

  private json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
  private gerr(status: number, code: number, message: string, sub = 0) {
    return this.json({ error: { message, type: "OAuthException", code, ...(sub ? { error_subcode: sub } : {}), fbtrace_id: "x" } }, status);
  }

  async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    let form: Record<string, string> = {};
    let json: Obj | null = null;
    let bytes: number | undefined;
    const b = init?.body;
    if (b instanceof URLSearchParams) form = Object.fromEntries(b.entries());
    else if (typeof b === "string") { try { json = JSON.parse(b); } catch { form = Object.fromEntries(new URLSearchParams(b).entries()); } }
    else if (b instanceof Uint8Array) bytes = b.length;
    const query = Object.fromEntries(url.searchParams.entries());
    const path = url.pathname;
    const name = this.nameOf(url, method);
    this.calls.push({ method, url: url.toString(), host: url.host, path, query, form, json, name, bytes });
    for (const f of this.failures) if (f.times > 0 && f.match.test(url.toString())) { f.times--; return this.json(f.body, f.status); }

    if (url.host === "relay.example.test") return await this.relay(method, path, json, url);
    if (url.host === "r2.example.test") {
      if (method !== "PUT") return new Response("no", { status: 405 });
      if (this.putFail) return new Response("<Error/>", { status: 403 });
      const id = /\/put\/([0-9a-f]{32})\./.exec(path)?.[1] ?? "";
      const st = this.staged.get(id);
      if (st) { st.putBytes = bytes ?? 0; st.putLength = new Headers(init?.headers as HeadersInit | undefined).get("content-length"); }
      return new Response(null, { status: 200 });
    }
    if (url.host === "cdn.example.test") return new Response(new Uint8Array([0]), { status: 200 });
    return this.graph(url.host === "graph.instagram.com" ? "ig" : "th", method, path, query, form, init);
  }

  private nameOf(url: URL, method: string): string {
    const p = url.pathname;
    if (url.host === "relay.example.test") return `relay:${method} ${p}`;
    if (url.host === "r2.example.test") return "r2.put";
    const k = url.host === "graph.instagram.com" ? "ig" : url.host === "graph.threads.com" ? "th" : "x";
    const rest = p.replace(/^\/v[\d.]+/, "");
    if (/\/refresh_access_token$/.test(rest)) return `${k}.refresh`;
    if (/\/(media|threads)$/.test(rest)) return method === "POST" ? `${k}.container` : `${k}.recent`;
    if (/\/(media_publish|threads_publish)$/.test(rest)) return `${k}.publish`;
    if (url.searchParams.get("fields")?.includes("status")) return `${k}.status`;
    return `${k}.get`;
  }

  /* ───────────── 중계 서버 ───────────── */

  private async relay(method: string, path: string, body: Obj | null, url: URL): Promise<Response> {
    if (method === "POST" && path === "/pickup") {
      const key = await sha256b64u(String(body?.verifier ?? ""));
      const got = this.pickups.get(key);
      if (!got) return this.json({ ok: false, why: "받아 갈 토큰이 없습니다" }, 404);
      this.pickups.delete(key);
      return this.json({ ok: true, ...got });
    }
    if (method === "POST" && path === "/stage/ticket") {
      if (!this.validTokens.has(String(body?.token ?? ""))) return this.json({ ok: false, why: "계정 확인에 실패했습니다" }, 401);
      const id = (++this.seq).toString(16).padStart(32, "a");
      const ext = body?.ext === "mov" ? "mov" : "mp4";
      this.staged.set(id, { bytes: Number(body?.size), ext, deleted: false, putBytes: 0, putLength: null });
      const exp = Date.now() + 3600_000;
      return this.json({
        ok: true, id, name: `${id}.${ext}`, put_url: `https://r2.example.test/put/${id}.${ext}?X-Amz-Signature=fake`, put_expires_in: 600,
        get_url: `${this.worker}/s/${id}.${ext}?e=${exp}&s=fakesig`, get_expires_at: new Date(exp).toISOString(), delete_sig: "delsig-" + id.slice(-4),
      });
    }
    if (method === "POST" && path === "/stage/delete") {
      const s = this.staged.get(String(body?.id ?? ""));
      if (s) s.deleted = true;
      return this.json({ ok: true });
    }
    void url;
    return new Response("not found", { status: 404 });
  }

  /* ───────────── 메타 그래프 ───────────── */

  private tokenOk(form: Record<string, string>, query: Record<string, string>): boolean {
    return this.validTokens.has(form.access_token ?? query.access_token ?? "");
  }

  private statusOf(c: Container): string {
    const seq = c.kind === "ig" ? this.igStatus : this.thStatus;
    const s = c.failed ? "ERROR" : (seq[Math.min(c.polls, seq.length - 1)] ?? "FINISHED");
    c.polls++;
    return s;
  }

  private graph(k: "ig" | "th", method: string, path: string, q: Record<string, string>, form: Record<string, string>, init?: RequestInit): Response {
    const rest = path.replace(/^\/v[\d.]+/, "");
    const stamp = new Date().toISOString();

    if (/\/refresh_access_token$/.test(rest)) {
      const t = q.access_token ?? "";
      if (this.refreshFail || !this.validTokens.has(t)) return this.gerr(400, 190, "Error validating access token: Session has expired");
      const next = `${t}~r${++this.seq}`;
      this.validTokens.add(next);
      return this.json({ access_token: next, token_type: "bearer", expires_in: 5184000 });
    }
    if (!this.tokenOk(form, q)) return this.gerr(400, 190, "Invalid OAuth access token - Cannot parse access token");

    const mC = /^\/([^/]+)\/(media|threads)$/.exec(rest);
    if (mC && method === "POST") {
      const isReel = k === "ig";
      if (isReel && form.media_type !== "REELS") return this.gerr(400, 100, "media_type 가 REELS 가 아닙니다");
      if (!isReel && form.media_type !== "VIDEO") return this.gerr(400, 100, "media_type 가 VIDEO 가 아닙니다");
      if (!/^https:\/\//.test(form.video_url ?? "")) return this.gerr(400, 100, "video_url 이 공개 주소가 아닙니다");
      const id = `${k.toUpperCase()}C${++this.seq}`;
      const c: Container = { id, kind: k, params: form, polls: 0 };
      if (!isReel && this.rejectMediaUrl && form.video_url === this.mediaUrl) c.failed = "영상을 가져올 수 없습니다";
      this.containers.set(id, c);
      return this.json({ id });
    }
    if (mC && method === "GET") {
      const list = k === "ig"
        ? this.igMedia.map((m) => ({ id: m.id, caption: m.caption, permalink: m.permalink, timestamp: m.timestamp }))
        : this.thPosts.map((m) => ({ id: m.id, text: m.text, permalink: m.permalink, timestamp: m.timestamp }));
      return this.json({ data: list.slice(-10).reverse() });
    }
    const mP = /^\/([^/]+)\/(media_publish|threads_publish)$/.exec(rest);
    if (mP && method === "POST") {
      const c = this.containers.get(form.creation_id ?? "");
      if (!c) return this.gerr(400, 100, "creation_id 를 찾을 수 없습니다");
      const mode = k === "ig" ? this.igPublish : this.thPublish;
      const post = () => {
        const id = `${k.toUpperCase()}M${++this.seq}`;
        if (k === "ig") this.igMedia.push({ id, caption: c.params.caption ?? "", permalink: `https://www.instagram.com/reel/${id}/`, timestamp: stamp });
        else this.thPosts.push({ id, text: c.params.text ?? "", permalink: `https://www.threads.com/@x/post/${id}`, timestamp: stamp });
        return id;
      };
      if (mode === "notready") return this.gerr(400, 9007, "The media is not ready for publishing, please wait for a moment", 2207027);
      if (mode === "reject") return this.gerr(403, 10, "Application does not have permission for this action");
      if (mode === "5xx_posted") { post(); return this.gerr(500, 2, "An unexpected error has occurred. Please retry your request later."); }
      if (mode === "5xx_lost") return this.gerr(500, 2, "An unexpected error has occurred. Please retry your request later.");
      if (mode === "timeout_posted") { post(); throw new DOMException("The signal has timed out", "TimeoutError"); }
      if (mode === "timeout_lost") throw new DOMException("The signal has timed out", "TimeoutError");
      return this.json({ id: post() });
    }
    const mG = /^\/([^/]+)$/.exec(rest);
    if (mG && method === "GET") {
      const id = mG[1];
      const c = this.containers.get(id);
      if (c) {
        const st = this.statusOf(c);
        return k === "ig" ? this.json({ status_code: st, status: st === "ERROR" ? "Error: 영상을 처리하지 못했습니다" : st, id })
          : this.json({ status: st, ...(st === "ERROR" ? { error_message: c.failed ?? "영상을 처리하지 못했습니다" } : {}), id });
      }
      const m = k === "ig" ? this.igMedia.find((x) => x.id === id) : this.thPosts.find((x) => x.id === id);
      if (m) {
        const fields = q.fields ?? "";
        return this.json({ id, ...(fields.includes("permalink") ? { permalink: m.permalink } : {}), ...(fields.includes("media_url") && this.mediaUrl ? { media_url: this.mediaUrl } : {}) });
      }
      return this.gerr(400, 100, `Object ${id} does not exist`);
    }
    void init;
    return this.gerr(404, 100, `가짜 메타가 모르는 주소: ${method} ${rest}`);
  }
}

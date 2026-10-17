// 시험 바탕 — 가짜 채널 하나를 연결해 두고 시작하는 도우미. 구글에는 한 번도 닿지 않는다.
//
// 모래상자() 안에서 부른다. 만드는 것: 가짜 구글 서버 · 내장 열쇠(가짜) · tokens.json 항목 · channels.json 칸 · 채널 폴더.
import { 가짜구글 } from "./가짜구글.ts";
import { 영상쓰기 } from "./도구.ts";
import { setEmbeddedForTest } from "../app/embedded.ts";
import { editChannels } from "../app/channels.ts";
import { putEntry, SCOPES } from "../app/ytcore.ts";
import { isoWall, wallNow } from "../app/clock.ts";

export const 가짜열쇠 = { client_id: "fake-id.apps.googleusercontent.com", client_secret: "fake-secret", token_uri: "https://oauth2.googleapis.com/token" };

/** UC + 22자 가짜 채널 id (소스에 실제 모양의 글자를 직접 쓰지 않으려고 만들어 쓴다) */
export const 가짜채널id = (c: string) => "UC" + c.repeat(22);

export interface 채널준비결과 {
  fake: 가짜구글;
  name: string;
  id: string;
  refresh: string;
  folder: string;
}

/**
 * 채널 하나를 연결된 상태로 만든다.
 *  - name: 채널 이름(별칭), c: 채널 id 를 만드는 한 글자, conf: channels.json 칸에 더할 것
 */
export async function 채널준비(
  dir: string, fake: 가짜구글, o: { name?: string; c?: string; conf?: Record<string, unknown>; how?: "browser" | "device" } = {},
): Promise<채널준비결과> {
  const name = o.name ?? "채널A";
  const id = 가짜채널id(o.c ?? "x");
  const refresh = `refresh-${encodeURIComponent(name).replace(/%/g, "")}`; // 헤더에 실리는 값이라 ASCII 여야 한다
  const folder = `${dir}/영상/${name}`;
  await Deno.mkdir(folder, { recursive: true });
  fake.install();
  fake.addChannel({ id, title: name }, refresh);
  setEmbeddedForTest("browser", { ...가짜열쇠 });
  setEmbeddedForTest("device", { ...가짜열쇠 });
  await putEntry(name, {
    channel_id: id, title: name, refresh_token: refresh, added: isoWall(wallNow()), scopes: [...SCOPES],
    how: o.how ?? "browser", client: "내장",
  });
  await editChannels((d) => {
    d[name] = { channel_id: id, folder, prefix: "", times: ["09:00"], publish: "schedule", daily_rule: "auto", daily_fallback: 1, ...(o.conf ?? {}) };
  });
  return { fake, name, id, refresh, folder };
}

/** 채널 폴더에 가짜 영상을 하나 둔다. 쇼츠(세로 40초) 또는 롱폼(가로 400초). 곁글도 쓸 수 있다. */
export async function 영상두기(
  folder: string, name: string, o: { long?: boolean; sec?: number; w?: number; h?: number; txt?: string; mb?: number } = {},
): Promise<string> {
  const path = `${folder}/${name}`;
  await 영상쓰기(path, {
    w: o.w ?? (o.long ? 1920 : 1080), h: o.h ?? (o.long ? 1080 : 1920), sec: o.sec ?? (o.long ? 400 : 40),
    extraBytes: Math.round((o.mb ?? 0) * 1024 * 1024),
  });
  if (o.txt !== undefined) await Deno.writeTextFile(path.replace(/\.[^.]+$/, ".txt"), o.txt);
  return path;
}

/** 지금부터 n 분 뒤의 이 컴퓨터 시각 글자 ("YYYY-MM-DD HH:MM") */
export function 분뒤(n: number): string {
  const w = wallNow();
  const t = new Date(w.getTime() + n * 60_000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

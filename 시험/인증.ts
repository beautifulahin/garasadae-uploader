// 인증 시험 — 관리자 계정 하나로 로그인(브라우저·코드 인증)하고 채널을 바꿔 고른다. 앱에 묶인 열쇠(내장) · 내 열쇠 · 채널 전용 열쇠.
// 구글에는 한 번도 닿지 않는다(가짜 서버). 브라우저 로그인의 돌아오는 주소는 이 컴퓨터 안(127.0.0.1)에서만 오간다.
import { 같나, 구역, 던지나, 모래상자, 참인가 } from "./도구.ts";
import { 가짜구글 } from "./가짜구글.ts";
import { 가짜열쇠, 가짜채널id, 채널준비 } from "./바탕.ts";
import {
  accessToken, AuthError, canPublish, clientFor, deviceSecretsPath, entryFor, loadStore, pickClient, putEntry, SCOPES, secretsPath, SCOPES_LEGACY,
  forgetAccessTokens, type TokenEntry,
} from "../app/ytcore.ts";
import { clientState, deviceSave, deviceStart, devicePoll, deviceWait, NotReady, registerToken, saveChannelClientFile, saveChannelClientJson, saveClientFile, signin, startSignIn } from "../app/oauth.ts";
import { embeddedState, parseClientJson, setEmbeddedForTest } from "../app/embedded.ts";
import { setFetch } from "../app/google.ts";
import { loadChannels } from "../app/channels.ts";
import { dataPath, readJsonSync, writeJson } from "../app/paths.ts";
import { loadProfiles } from "../app/profile.ts";

type Obj = Record<string, any>;

/** 가짜 서버로 가는 요청의 폼 몸을 엿본다 (어느 열쇠로 갱신했는지 보려고) */
function 엿보기(fake: 가짜구글) {
  const 본 = [] as URLSearchParams[];
  setFetch((i, init) => {
    if (init?.body instanceof URLSearchParams) 본.push(init.body);
    return fake.handle(i, init);
  });
  return 본;
}
const 로그전부 = async () => {
  let t = "";
  try { for await (const e of Deno.readDir(dataPath("기록"))) if (e.isFile) t += await Deno.readTextFile(dataPath("기록", e.name)); } catch { /* 없다 */ }
  return t;
};

export async function 실행() {
  구역("앱에 묶인 열쇠(내장) 읽기");
  같나("구글이 주는 파일(installed)을 읽는다", parseClientJson(JSON.stringify({ installed: { client_id: "a", client_secret: "b" } }))?.client_id, "a");
  같나("납작한 꼴도 읽는다", parseClientJson('{"client_id":"a","client_secret":"b"}')?.client_secret, "b");
  같나("client_id 가 없으면 null", parseClientJson('{"installed":{}}'), null);
  같나("깨진 글은 null", parseClientJson("이건 JSON 이 아님"), null);

  구역("어느 열쇠로 갱신하나 — 채널 전용 > 내장 표식 > 내 파일 > 내장 > 다른 종류");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글();
    await 채널준비(dir, fake, { name: "채널A" });
    const 본 = 엿보기(fake);
    const e = (o: Partial<TokenEntry> = {}): TokenEntry => ({ channel_id: "UCq", title: "t", refresh_token: "refresh-ch", added: "x", ...o });
    같나("표식이 「내장」이면 내장 열쇠", (await clientFor(e({ client: "내장" }))).client_id, 가짜열쇠.client_id);
    같나("내장 열쇠는 표시가 붙는다", (await clientFor(e({ client: "내장" }))).embedded, true);
    같나("아무 표식이 없고 내 파일도 없으면 내장", (await clientFor(e())).client_id, 가짜열쇠.client_id);
    // 내 파일을 둔다
    await saveClientFile("client", { clientId: "mine.apps.googleusercontent.com", clientSecret: "mine-secret" });
    같나("내 파일이 있으면(옛 사용자) 내 파일이 내장보다 앞선다", (await clientFor(e())).client_id, "mine.apps.googleusercontent.com");
    같나("그래도 내장 표식이 있는 토큰은 계속 내장 열쇠로 갱신한다(다른 열쇠로 갱신하면 구글이 거부한다)", (await clientFor(e({ client: "내장" }))).client_id, 가짜열쇠.client_id);
    // 채널 전용
    const 파일 = await saveChannelClientFile("채널 A", { clientId: "own.apps.googleusercontent.com", clientSecret: "own-secret" });
    같나("전용 열쇠 파일 이름은 안전한 글자로", 파일, "client_secret_채널_A.json");
    같나("채널 전용 열쇠가 가장 앞선다", (await clientFor(e({ secret: 파일, client: "내장" }))).client_id, "own.apps.googleusercontent.com");
    await 던지나("전용 파일이 사라졌으면 분명히 말한다", () => clientFor(e({ secret: "없는파일.json" })), /전용 열쇠 파일\(없는파일\.json\)을 읽지 못했습니다/);
    // 코드 인증 토큰은 TV 열쇠
    같나("코드 인증으로 받은 토큰은 device 열쇠(내장)로 간다", (await clientFor(e({ how: "device", client: "내장" }))).client_id, 가짜열쇠.client_id);
    await saveClientFile("device", { clientId: "tv.apps.googleusercontent.com", clientSecret: "tv-secret" });
    같나("내 TV 열쇠 파일이 있으면 그것", (await clientFor(e({ how: "device" }))).client_id, "tv.apps.googleusercontent.com");
    같나("저장된 파일은 같은 이름으로 데이터 폴더에 있다", [secretsPath().endsWith("client_secret.json"), deviceSecretsPath().endsWith("device_secret.json")], [true, true]);
    // 아무것도 없으면
    setEmbeddedForTest("browser", null); setEmbeddedForTest("device", null);
    await Deno.remove(secretsPath()); await Deno.remove(deviceSecretsPath());
    await 던지나("열쇠가 하나도 없으면 어디서 넣는지 알려 준다", () => clientFor(e()), /내 열쇠 쓰기/);
    setEmbeddedForTest("browser", { ...가짜열쇠 }); setEmbeddedForTest("device", { ...가짜열쇠 });

    구역("접근 토큰 — 발급 당시의 범위로 갱신한다");
    forgetAccessTokens(); 본.length = 0;
    fake.grant("refresh-keep", 가짜채널id("k"));
    const at = await accessToken(e({ refresh_token: "refresh-keep", client: "내장", scopes: [...SCOPES_LEGACY] }));
    같나("접근 토큰을 받는다", at, "AT:refresh-keep");
    같나("갱신 요청에 그 토큰이 받은 범위를 싣는다(범위를 늘렸다가 옛 토큰이 invalid_scope 로 죽은 일)", 본.at(-1)?.get("scope"), SCOPES_LEGACY.join(" "));
    같나("내장 열쇠로 갱신한다", [본.at(-1)?.get("client_id"), 본.at(-1)?.get("client_secret")], [가짜열쇠.client_id, 가짜열쇠.client_secret]);
    forgetAccessTokens();
    await 던지나("취소된 토큰은 한국말로 안내한다", () => accessToken(e({ refresh_token: "refresh-gone", client: "내장" })), /인증이 만료되었거나 취소되었습니다/);
    같나("공개 전환 권한이 없는 옛 토큰은 알 수 있다", [canPublish(e({ scopes: [...SCOPES_LEGACY] })), canPublish(e({ scopes: [...SCOPES] })), canPublish(e())], [false, true, false]);
    같나("범위는 세 개뿐", SCOPES.length, 3);
    같나("force-ssl 은 요청하지 않는다(코드 인증이 거부한다)", SCOPES.some((s) => s.includes("force-ssl")), false);
  });

  구역("새 연결이 쓸 열쇠 고르기 (pickClient)");
  await 모래상자(async () => {
    setEmbeddedForTest("browser", { ...가짜열쇠 }); setEmbeddedForTest("device", { ...가짜열쇠 });
    같나("내 파일도 전용도 없으면 내장 — 토큰에 「내장」 표식", (await pickClient("browser")).mark, { client: "내장" });
    같나("코드 인증도 내장 device 열쇠", (await pickClient("device")).mark, { client: "내장" });
    await saveClientFile("client", { clientId: "mine.apps.googleusercontent.com", clientSecret: "s" });
    같나("내 파일이 있으면 그것(표식 없음)", [(await pickClient("browser")).conf.client_id, (await pickClient("browser")).mark], ["mine.apps.googleusercontent.com", {}]);
    const f = await saveChannelClientFile("전용", { clientId: "own.apps.googleusercontent.com", clientSecret: "o" });
    같나("전용 파일을 지정하면 그것(표식 secret)", [(await pickClient("browser", f)).conf.client_id, (await pickClient("browser", f)).mark], ["own.apps.googleusercontent.com", { secret: f }]);
    await 던지나("지정한 전용 파일이 없으면", () => pickClient("browser", "없음.json"), /전용 열쇠 파일\(없음\.json\)을 읽지 못했습니다/);
    setEmbeddedForTest("browser", null);
    await Deno.remove(secretsPath());
    await 던지나("내장도 없고 파일도 없으면 안내", () => pickClient("browser"), /내 열쇠 쓰기/);
  });

  구역("열쇠 파일 넣기 (내 열쇠 쓰기 — 고급)");
  await 모래상자(async () => {
    await saveClientFile("client", { json: JSON.stringify({ installed: { client_id: "x.apps.googleusercontent.com", client_secret: "y", project_id: "p" } }) });
    같나("JSON 파일을 올리면 같은 꼴(installed)로 저장된다", readJsonSync<Obj>(secretsPath(), {}).installed?.client_id, "x.apps.googleusercontent.com");
    같나("비밀번호가 든 파일은 권한 600 (맥·리눅스)", ((await Deno.stat(secretsPath())).mode! & 0o777) === 0o600, true);
    await saveClientFile("device", { clientId: "t.apps.googleusercontent.com", clientSecret: "s2" });
    같나("ID·비밀번호를 붙여넣어도 된다", readJsonSync<Obj>(deviceSecretsPath(), {}).installed?.client_secret, "s2");
    await 던지나("웹 애플리케이션 유형은 거절하고 까닭을 말한다", () => saveClientFile("client", { json: JSON.stringify({ web: { client_id: "w", client_secret: "z" } }) }), /웹 애플리케이션/);
    await 던지나("client_id 가 없는 파일", () => saveClientFile("client", { json: "{}" }), /client_id 가 없습니다/);
    await 던지나("JSON 이 아닌 글", () => saveClientFile("client", { json: "안녕" }), /JSON 파일이 아닙니다/);
    await 던지나("클라이언트 ID 형식이 틀리면", () => saveClientFile("client", { clientId: "abc", clientSecret: "s" }), /클라이언트 ID 형식이 올바르지 않습니다/);
    await 던지나("비밀번호가 비면", () => saveClientFile("client", { clientId: "a.apps.googleusercontent.com", clientSecret: " " }), /보안 비밀번호를 입력/);
    const 전용 = await saveChannelClientJson("전용채널", JSON.stringify({ installed: { client_id: "c.apps.googleusercontent.com", client_secret: "cs" } }));
    같나("채널 전용 열쇠도 JSON 파일로 넣을 수 있다", [전용, readJsonSync<Obj>(dataPath(전용), {}).installed?.client_id], ["client_secret_전용채널.json", "c.apps.googleusercontent.com"]);
    await 던지나("전용 열쇠 JSON 이 웹 유형이면 거절", () => saveChannelClientJson("x", JSON.stringify({ web: { client_id: "w", client_secret: "z" } })), /웹 애플리케이션|client_id/);
    const st = await clientState();
    같나("열쇠 상태: 내 파일·내장·준비됨", [st.client, st.device, st.embedded, st.ready], [true, true, { browser: false, device: false }, { browser: true, device: true }]);
    같나("상태 글(embeddedState)은 참·거짓뿐이다 — 값이 안 보인다", JSON.stringify(await embeddedState()).includes("secret"), false);
  });

  구역("① 브라우저 로그인 — select_account consent · 돌아오는 주소 · 같은 채널 갱신 · 채널 정보");
  await 모래상자(async (dir) => {
    const fake = new 가짜구글(); fake.install();
    setEmbeddedForTest("browser", { ...가짜열쇠 });
    const idA = 가짜채널id("a"), idB = 가짜채널id("b");
    fake.addChannel({ id: idA, title: "첫째 채널", handle: "@첫째", subs: 11 });
    fake.addChannel({ id: idB, title: "둘째 채널", subs: 22 });
    fake.codes.set("CODE-A", { refresh: "refresh-A", scope: SCOPES.join(" ") });
    fake.grant("refresh-A", idA);
    fake.codes.set("CODE-B", { refresh: "refresh-B", scope: SCOPES.join(" ") });
    fake.grant("refresh-B", idB);
    const 돌아옴 = async (url: string, 값: Record<string, string>) => {
      const u = new URL(url);
      const redirect = u.searchParams.get("redirect_uri")!;
      const r = await fetch(`${redirect}/?${new URLSearchParams({ state: u.searchParams.get("state")!, ...값 })}`);
      return await r.text();
    };

    const { url, done } = await startSignIn("첫째별칭");
    const q = new URL(url).searchParams;
    같나("계정과 채널을 매번 고르게 한다(select_account consent)", q.get("prompt"), "select_account consent");
    같나("리프레시 토큰을 받는다(offline)", q.get("access_type"), "offline");
    같나("범위는 세 개뿐", q.get("scope")!.split(" ").length, 3);
    같나("PKCE(S256)", q.get("code_challenge_method"), "S256");
    같나("내장 열쇠로 시작한다", q.get("client_id"), 가짜열쇠.client_id);
    참인가("돌아오는 주소는 이 컴퓨터(127.0.0.1)의 임시 포트", /^http:\/\/127\.0\.0\.1:\d+$/.test(q.get("redirect_uri")!));
    같나("진행 중이라고 알린다", [signin.state.running, signin.state.alias], [true, "첫째별칭"]);
    await 던지나("로그인 창이 이미 열려 있으면 두 번째는 막는다", () => startSignIn("또"), /이미 로그인 창이 열려 있습니다/);
    // 잘못된 state 는 무시
    const 틀림 = await fetch(`${q.get("redirect_uri")}/?code=CODE-A&state=엉뚱`);
    같나("state 가 다르면 거절 화면(연결 안 됨)", (await 틀림.text()).includes("인증 상태가 일치하지 않습니다"), true);
    같나("그래도 아직 기다리는 중", signin.state.running, true);
    const 쪽 = await 돌아옴(url, { code: "CODE-A" });
    같나("연결 완료 화면", 쪽.includes("연결됐습니다"), true);
    const res = await done;
    같나("등록 결과", [res.key, res.channel_id, res.title, res.replaced, res.slotMade], ["첫째별칭", idA, "첫째 채널", [], true]);
    const ent = loadStore()["첫째별칭"];
    같나("토큰 항목: 어떻게·어느 열쇠로·받은 범위", [ent.how, ent.client, ent.scopes, ent.channel_id], ["browser", "내장", [...SCOPES], idA]);
    같나("channels.json 에 자리가 생긴다", [loadChannels()["첫째별칭"]?.channel_id, loadChannels()["첫째별칭"]?.publish], [idA, "schedule"]);
    const 프로필 = await loadProfiles();
    같나("채널 정보(핸들·구독자)를 받아 둔다", [프로필[idA]?.handle, 프로필[idA]?.subscribers], ["@첫째", 11]);
    같나("끝난 뒤 상태", [signin.state.running, signin.state.done?.key], [false, "첫째별칭"]);
    같나("같은 계정으로 둘째 채널 연결 — 계정 고르기 화면이 또 뜬다", (await (async () => {
      const s2 = await startSignIn("둘째별칭");
      await 돌아옴(s2.url, { code: "CODE-B" });
      return (await s2.done).key;
    })()), "둘째별칭");
    같나("두 채널이 따로 저장된다", Object.keys(loadStore()).sort(), ["둘째별칭", "첫째별칭"]);
    // 같은 채널을 다른 별칭으로 다시 연결하면 그 자리를 갱신(중복 방지)
    const s3 = await startSignIn("새이름");
    await 돌아옴(s3.url, { code: "CODE-A" });
    const r3 = await s3.done;
    같나("같은 채널을 다시 연결하면 옛 별칭을 치운다", [r3.replaced, Object.keys(loadStore()).sort()], [["첫째별칭"], ["둘째별칭", "새이름"]]);
    같나("channels.json 에는 같은 채널의 자리를 하나만 더 만들지 않는다", r3.slotMade, false);
    // 거절·토큰 없음·취소
    const s4 = await startSignIn("거절");
    const 거절쪽 = await 돌아옴(s4.url, { error: "access_denied" });
    같나("구글 로그인 창에서 거부하면 안내", 거절쪽.includes("권한을 거부하셨습니다"), true);
    await 던지나("거부는 오류로 끝난다", () => s4.done, /권한을 거부/);
    같나("그 뒤 상태 — 이유를 남긴다", [signin.state.running, String(signin.state.why).includes("권한을 거부")], [false, true]);
    fake.codes.set("CODE-NOREFRESH", { refresh: "refresh-C", scope: SCOPES.join(" "), noRefresh: true });
    const s5 = await startSignIn("토큰없음");
    await 돌아옴(s5.url, { code: "CODE-NOREFRESH" });
    await 던지나("리프레시 토큰을 못 받으면 서드파티 권한 삭제를 안내", () => s5.done, /리프레시 토큰을 못 받았습니다/);
    const s6 = await startSignIn("취소");
    signin.stop?.();
    await 던지나("취소하면 접는다", () => s6.done, /취소했습니다/);
    같나("연결된 채널 수·열쇠 상태는 로그에 값이 안 남는다", (await 로그전부()).includes("fake-secret") || (await 로그전부()).includes("refresh-A"), false);
    void dir;
  });

  구역("② 코드 인증 — 주소와 코드를 보여 주고 상대가 자기 기기에서 승인한다");
  await 모래상자(async () => {
    const fake = new 가짜구글(); fake.install();
    setEmbeddedForTest("device", { ...가짜열쇠 });
    const id = 가짜채널id("d");
    fake.addChannel({ id, title: "코드 채널" });
    fake.grant("refresh-D", id);
    const s = await deviceStart();
    같나("화면에 띄울 주소와 코드", [s.verification_url, /^ABCD-\d+$/.test(s.user_code), s.expires_in], ["https://www.google.com/device", true, 1800]);
    같나("내장 열쇠로 시작했다는 표식이 따라다닌다", s._mark, { client: "내장" });
    같나("아직 승인 전", (await devicePoll(s)).state, "waiting");
    fake.devices.get(s.device_code)!.state = "slow";
    같나("너무 자주 물으면 간격을 늘리라고 한다", (await devicePoll(s)).state, "slow");
    fake.devices.set(s.device_code, { state: "ok", refresh: "refresh-D", scope: SCOPES.join(" ") });
    const p = await devicePoll(s);
    같나("승인되면 리프레시 토큰", [p.state, p.state === "ok" ? p.refresh : ""], ["ok", "refresh-D"]);
    const saved = await deviceSave("refresh-D", "코드별칭", { scope: SCOPES.join(" "), mark: s._mark });
    같나("저장: 코드 인증으로 · 내장 열쇠로 · 채널 정보까지", [saved.key, saved.channel_id, loadStore()["코드별칭"].how, loadStore()["코드별칭"].client], ["코드별칭", id, "device", "내장"]);
    같나("코드 인증 토큰은 TV(device) 열쇠로 갱신된다", (await clientFor(loadStore()["코드별칭"])).client_id, 가짜열쇠.client_id);
    const s2 = await deviceStart();
    fake.devices.set(s2.device_code, { state: "denied" });
    같나("거절되면 이유를 준다", (await devicePoll(s2)).state, "denied");
    const s3 = await deviceStart();
    fake.devices.set(s3.device_code, { state: "expired" });
    같나("코드가 만료되면 알린다", (await devicePoll(s3)).state, "expired");
    await 던지나("deviceWait 는 만료를 오류로", () => deviceWait(s3), /만료/);
    const s4 = await deviceStart();
    fake.devices.set(s4.device_code, { state: "denied" });
    await 던지나("deviceWait 는 거절을 오류로", () => deviceWait(s4), /사용자가 거절/);
    setEmbeddedForTest("device", null);
    await 던지나("TV 열쇠가 하나도 없으면 안내(NotReady)", () => deviceStart(), (NotReady as unknown as { prototype: Error }) ? /TV 및 입력 제한 기기/ : /./);
  });

  구역("등록 — 채널 정보를 받아 두고 열쇠 표식을 남긴다");
  await 모래상자(async () => {
    const fake = new 가짜구글(); fake.install();
    setEmbeddedForTest("browser", { ...가짜열쇠 });
    const id = 가짜채널id("r");
    fake.addChannel({ id, title: "등록 채널" });
    fake.grant("refresh-R", id);
    const f = await saveChannelClientFile("등록", { clientId: "own.apps.googleusercontent.com", clientSecret: "o" });
    const r = await registerToken({ refresh: "refresh-R", how: "browser", granted: [...SCOPES], secretFile: f });
    같나("별칭을 안 주면 유튜브 채널 이름", r.key, "등록 채널");
    같나("전용 열쇠 표식이 항목에 남는다", [loadStore()["등록 채널"].secret, loadStore()["등록 채널"].client], [f, undefined]);
    같나("entryFor 는 별칭·채널 id 둘 다 받는다", [entryFor("등록 채널").key, entryFor(id).key], ["등록 채널", "등록 채널"]);
    await 던지나("없는 채널은 어디서 연결하는지 알려 준다", async () => entryFor("없는채널"), /채널 탭에서 구글 계정을 연결/);
    await putEntry("직접", { channel_id: id, title: "x", refresh_token: "r", added: "x" });
    같나("putEntry 도 같은 채널이면 옛 별칭을 치운다", Object.keys(loadStore()), ["직접"]);
  });
}

if (import.meta.main) {
  const { 결과 } = await import("./도구.ts");
  await 실행();
  console.log(결과.실패 ? `\n❌ ${결과.실패}개 틀렸다 (통과 ${결과.통과})` : `\n🟢 전부 통과 (${결과.통과}개)`);
  if (결과.실패) Deno.exit(1);
}

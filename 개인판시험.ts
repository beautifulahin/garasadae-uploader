import { fileFingerprint, findDuplicate, 제목열쇠 } from "./app/dedupe.ts";
import { nextSlot, 슬롯말 } from "./app/slots.ts";
import { 슬롯정리 } from "./app/paths.ts";
import { EMPTY_STATE, localStamp, State, UploadRec } from "./app/paths.ts";
import { statsRows } from "./app/stats.ts";
import { 틀채우기 } from "./app/sidecar.ts";

let 실패 = 0;
function 같나(무엇: string, 실제: unknown, 바람: unknown) {
  const a = JSON.stringify(실제), b = JSON.stringify(바람);
  if (a === b) console.log(`  ✅ ${무엇}`);
  else { console.log(`  ❌ ${무엇}\n     나온 것: ${a}\n     바란 것: ${b}`); 실패++; }
}

console.log("── 제목 열쇠 ──");
같나("괄호·따옴표·물음표를 털어 낸다",
  제목열쇠("(속보)'개헌 왜 이렇게 급해요?'"), 제목열쇠("속보 개헌 왜 이렇게 급해요"));
같나("띄어쓰기가 달라도 같다", 제목열쇠("여당만 몰랐던 209일"), 제목열쇠("여당만몰랐던209일"));
같나("다른 편은 다르다", 제목열쇠("개헌 급해요") === 제목열쇠("개헌 안 급해요"), false);

console.log("── 지문 ──");
const t = await Deno.makeTempDir();
await Deno.writeFile(`${t}/a.mp4`, new Uint8Array(3_000_000).fill(7));
await Deno.copyFile(`${t}/a.mp4`, `${t}/a복사.mp4`);
const b = new Uint8Array(3_000_000).fill(7); b[2_999_999] = 9;   // 끝만 다르다
await Deno.writeFile(`${t}/b.mp4`, b);
const ha = await fileFingerprint(`${t}/a.mp4`);
같나("같은 파일은 같은 지문", ha, await fileFingerprint(`${t}/a복사.mp4`));
같나("끝이 다르면 다른 지문", ha === await fileFingerprint(`${t}/b.mp4`), false);
같나("지문 길이 64", ha.length, 64);

console.log("── 중복 찾기 ──");
const 이제 = new Date();
const 어제 = new Date(Date.now() - 86400_000).toISOString().slice(0, 19);
const 넉달전 = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 19);
const ups: UploadRec[] = [
  { id: "V1", title: "(속보)'여당만 몰랐던 209일'", file: "a.mp4", size: 1, privacy: "public",
    at: 어제, channelId: "ch1", channelName: "내", hash: ha },
  { id: "V0", title: "아주 옛날 편", file: "z.mp4", size: 1, privacy: "public",
    at: 넉달전, channelId: "ch1", channelName: "내", hash: "옛지문" },
];
같나("같은 파일이면 걸린다",
  findDuplicate(ups, { channelId: "ch1", hash: ha, title: "전혀 다른 제목" })?.why, "file");
같나("같은 제목이면 걸린다",
  findDuplicate(ups, { channelId: "ch1", hash: "다른지문", title: "여당만 몰랐던 209일" })?.why, "title");
같나("다른 채널이면 안 걸린다",
  findDuplicate(ups, { channelId: "ch2", hash: ha, title: "여당만 몰랐던 209일" }), null);
같나("새 편은 안 걸린다",
  findDuplicate(ups, { channelId: "ch1", hash: "새지문", title: "아주 새로운 편" }), null);
같나("접두어가 한쪽에만 붙어도 걸린다",
  findDuplicate(ups, { channelId: "ch1", hash: "다른지문", title: "(속보)'여당만 몰랐던 209일' 완전판" })?.why, "title");
같나("여덟 자 안 되는 토막은 안 걸린다",
  findDuplicate(ups, { channelId: "ch1", hash: "다른지문", title: "209일" }), null);
같나("30일 넘은 것은 안 걸린다",
  findDuplicate(ups, { channelId: "ch1", hash: "옛지문", title: "아주 옛날 편" }), null);

console.log("── 슬롯 ──");
같나("꼴 추리기", 슬롯정리(["7:00", "19:00", "25:00", "12:60", "12:00", "07:00", "쓰레기"]),
  ["07:00", "12:00", "19:00"]);
const 아침 = new Date(2026, 7, 22, 6, 0, 0);                 // 8월 22일 06:00
const s1 = nextSlot(["07:00", "12:00", "19:00"], [], 아침);
같나("한 시간 뒤 자리를 잡는다", new Date(s1).getHours(), 7);
같나("같은 날이다", new Date(s1).getDate(), 22);
const s2 = nextSlot(["07:00", "12:00", "19:00"], [s1], 아침);
같나("찬 자리는 건너뛴다", new Date(s2).getHours(), 12);
const s3 = nextSlot(["07:00"], [], new Date(2026, 7, 22, 6, 50, 0));
같나("너무 붙은 자리(10분 뒤)는 건너뛰어 다음 날로", new Date(s3).getDate(), 23);
같나("슬롯이 없으면 빈 글", nextSlot([], [], 아침), "");
const 다참 = [];
for (let d = 0; d <= 21; d++) 다참.push(new Date(2026, 7, 22 + d, 7, 0, 0).toISOString());
같나("3주가 다 차면 빈 글", nextSlot(["07:00"], 다참, 아침), "");
같나("사람이 읽는 꼴", 슬롯말(new Date(2026, 7, 22, 7, 0).toISOString()), "8월 22일(토) 07:00");

await Deno.remove(t, { recursive: true });

console.log("── 성적 기준 시각 ──");
{
  const 이제ms = Date.now();
  // ★`at` 는 이 컴퓨터 시간 꼴로 적힌다(localStamp). UTC 문자열을 넣으면
  //   Date.parse 가 그것을 다시 이 컴퓨터 시간으로 읽어 9시간이 어긋난다.
  const 올린때 = localStamp(new Date(이제ms - 14 * 3600_000));                   // 14시간 전에 올림
  const 뜬때 = new Date(이제ms - 1 * 3600_000).toISOString();                   // 1시간 전에 뜸
  const 나중 = new Date(이제ms + 3 * 3600_000).toISOString();                   // 3시간 뒤에 뜬다
  const 틀: Omit<UploadRec, "id"> = {
    title: "편", file: "a.mp4", size: 1, privacy: "public",
    at: 올린때, channelId: "ch1", channelName: "내",
  };
  const st: State = {
    ...EMPTY_STATE,
    uploads: [
      { ...틀, id: "예약", publishAt: 뜬때 },
      { ...틀, id: "그냥" },
      { ...틀, id: "아직", publishAt: 나중 },
    ],
    stats: {
      예약: { views: 1400, likes: 0, comments: 0, at: 이제ms },
      그냥: { views: 1400, likes: 0, comments: 0, at: 이제ms },
      아직: { views: 0, likes: 0, comments: 0, at: 이제ms },
    },
  };
  const rows = statsRows(st);
  const 예약 = rows.find((r) => r.id === "예약")!;
  const 그냥 = rows.find((r) => r.id === "그냥")!;
  const 아직 = rows.find((r) => r.id === "아직")!;
  같나("예약 공개는 뜬 때부터 센다 (1시간)", Math.round(예약.hours), 1);
  같나("예약 없는 편은 올린 때부터 센다 (14시간)", Math.round(그냥.hours), 14);
  같나("같은 조회수라도 예약 쪽이 훨씬 높게 나온다", 예약.perHour > 그냥.perHour * 10, true);
  같나("아직 안 뜬 편은 예정", 아직.pending, true);
  같나("예정은 줄 끝에 선다", rows[rows.length - 1].id, "아직");
  // ★화면은 `since` 를 그대로 잘라 쓴다. 세계표준시로 적으면 아홉 시간 어긋난다.
  같나("기준 시각은 이 컴퓨터 시간 꼴", 예약.since, localStamp(new Date(Date.parse(뜬때))));
  같나("기준 시각에 Z 나 +09:00 이 안 붙는다", /[Z+]/.test(예약.since), false);
}


console.log("── 채널 기본값 틀 ──");
같나("{제목} 자리에 제목이 들어간다",
  틀채우기("{제목} (결국 이렇게 됐습니다)", "개헌 왜 급해요"), "개헌 왜 급해요 (결국 이렇게 됐습니다)");
같나("틀이 비면 빈 글 — 안 한다는 뜻", 틀채우기("   ", "아무거나"), "");
같나("{제목} 이 없으면 그대로 쓴다", 틀채우기("구독 부탁드립니다", "아무거나"), "구독 부탁드립니다");

console.log("── 제목 갈아끼우기 앞뒤 ──");
{
  const 이제ms = Date.now();
  const st: State = {
    ...EMPTY_STATE,
    uploads: [{
      id: "AB", title: "새 제목", file: "a.mp4", size: 1, privacy: "public",
      at: localStamp(new Date(이제ms - 10 * 3600_000)),      // 10시간 전에 떴다
      channelId: "ch1", channelName: "내",
      titleA: "옛 제목",
      retitledAt: 이제ms - 5 * 3600_000,                      // 5시간 전에 갈아끼웠다
      viewsAtRetitle: 1000,                                   // 그때까지 1,000
    }],
    stats: { AB: { views: 3000, likes: 0, comments: 0, at: 이제ms } },
  };
  const r = statsRows(st)[0];
  같나("갈아끼운 편으로 표시된다", r.swapped, true);
  같나("앞 구간은 5시간에 1,000 → 200", Math.round(r.perHourA), 200);
  같나("뒤 구간은 5시간에 2,000 → 400", Math.round(r.perHourB), 400);
  같나("옛 제목을 들고 있다", r.titleA, "옛 제목");
}

console.log("── 안 갈아끼운 편 ──");
{
  const st: State = {
    ...EMPTY_STATE,
    uploads: [{
      id: "N", title: "그냥", file: "a.mp4", size: 1, privacy: "public",
      at: localStamp(new Date(Date.now() - 3600_000)), channelId: "ch1", channelName: "내",
    }],
    stats: { N: { views: 100, likes: 0, comments: 0, at: Date.now() } },
  };
  같나("앞뒤 견줌이 안 붙는다", statsRows(st)[0].swapped, false);
}

console.log(실패 ? `\n❌ ${실패}개 틀렸다` : "\n🟢 전부 통과");
if (실패) Deno.exit(1);

import { fileFingerprint, findDuplicate, 제목열쇠 } from "./app/dedupe.ts";
import { nextSlot, 슬롯말 } from "./app/slots.ts";
import { 슬롯정리 } from "./app/paths.ts";
import { UploadRec } from "./app/paths.ts";

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
console.log(실패 ? `\n❌ ${실패}개 틀렸다` : "\n🟢 전부 통과");
if (실패) Deno.exit(1);

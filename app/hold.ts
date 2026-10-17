// 이행 보류 — 옛 판 자료를 새 판으로 옮긴 뒤 **하나라도 빠졌거나 끝까지 못 갔을 때** 새 판이 일을 멈추는 장치.
//
// 사장님 지시(2026-10): 「등록해놓은 채널들 없어지지않도록 유지시키고」.
//   옛 판에서 자동 업데이트된 사람의 채널(로그인 정보 · 채널 설정 · 폴더 · 올린 기록)이 새 판으로 **하나도 빠짐없이** 넘어왔는지
//   이행이 끝난 직후 확인한다(migrate.ts 의 verifyMigration). 빠진 것이 있으면:
//     · 이행 기록(이행기록.json)을 남기지 않는다 → 다음에 켤 때 처음부터 이어서 다시 한다(몇 번을 해도 결과가 같다).
//     · 이 파일(이행보류.json)을 남긴다 → 새 판은 **올리기·공개·예약 쏘기를 하지 않는다**(safety 의 두 관문과 심사확인이 이 파일을 본다).
//       옛 자료는 한 글자도 안 건드렸으니 그대로 살아 있고, 옛 판으로 되돌려도 다시 돈다.
//     · 문제 목록에 빨간 줄을 띄우고 **백업 위치**를 알려 준다.
//   고치고 다시 옮겨 검사가 통과하면 이 파일은 「풀림」으로 바뀐다(지우지 않고 기록으로 남긴다).
//
// 이 모듈은 다른 모듈에 기대지 않는다(관문 쪽 모듈이 가져다 써도 돌고 도는 일이 없게) — 파일 읽기·쓰기만 한다.
import { dataPath, readJsonSync, writeJson } from "./paths.ts";
import { isoWall, wallNow } from "./clock.ts";

export interface HoldRecord {
  schema: 1;
  /** 지금도 멈춰 있나 */
  active: boolean;
  /** 멈춘 때 (이 컴퓨터 시각) */
  at: string;
  /** 풀린 때 (풀렸으면) */
  resolvedAt?: string;
  /** 풀린 방법: 다시 옮겨 통과 | 사람이 그대로 시작을 받아들임 */
  resolvedBy?: "verified" | "accepted";
  /** 옛 자료의 복사본이 있는 폴더 (이행 직전에 떠 둔 것) */
  backupDir: string;
  /** 옛 자료가 있는 폴더 (손대지 않았다) */
  oldDir: string;
  /** 멈춘 까닭 (사람 말 — 열쇠·토큰 값은 들어 있지 않다) */
  reasons: string[];
  /** 새 판에 빠진 것 (사람 말) */
  missing: string[];
  oldChannels: number;
  newChannels: number;
}

export const holdFile = () => dataPath("이행보류.json");

/** 지금 멈춰 있으면 그 기록, 아니면 null (파일이 없거나 이미 풀렸거나 읽을 수 없으면 null) */
export function migrationHold(): HoldRecord | null {
  const r = readJsonSync<Partial<HoldRecord> | null>(holdFile(), null);
  return r && typeof r === "object" && r.active === true ? (r as HoldRecord) : null;
}

/** 관문이 쓰는 한 줄 — 멈춰 있지 않으면 빈 글 */
export function holdReason(): string {
  const h = migrationHold();
  if (!h) return "";
  return `옛 판 자료를 새 판으로 옮긴 결과를 확인하는 중에 문제가 있어 새 판은 올리기·공개를 멈춰 두었습니다. 옛 자료는 그대로입니다(복사본: ${h.backupDir || "없음"}). 문제 목록의 빨간 줄을 보고 「다시 옮기기」를 눌러 주세요.`;
}

/** 멈춤을 건다 (이미 멈춰 있으면 최신 내용으로 바꾼다) */
export async function setHold(rec: Omit<HoldRecord, "schema" | "active" | "at"> & { at?: string }): Promise<void> {
  const out: HoldRecord = { schema: 1, active: true, at: rec.at ?? isoWall(wallNow()), ...rec };
  await writeJson(holdFile(), out);
}

/** 멈춤을 푼다. 기록은 지우지 않고 「풀림」으로 바꾼다. 멈춰 있지 않았으면 false */
export async function resolveHold(by: "verified" | "accepted"): Promise<boolean> {
  const h = readJsonSync<Partial<HoldRecord> | null>(holdFile(), null);
  if (!h || h.active !== true) return false;
  await writeJson(holdFile(), { ...h, active: false, resolvedAt: isoWall(wallNow()), resolvedBy: by });
  return true;
}

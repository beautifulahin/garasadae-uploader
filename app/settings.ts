// 앱 설정 — 화면·알림·자동 실행처럼 이 프로그램에만 있는 설정 한 칸. (파이썬 업로더에는 없는 파일 — 나머지 데이터 파일은 파이썬과 같은 이름·꼴이다)
//
// 데이터 폴더의 `앱설정.json` 한 파일. 못 읽으면 기본값으로 간다(첫 실행·깨진 파일).
// 화면에서 바꾼 값만 적고, 모르는 칸은 보존한다(사람이 손으로 적은 칸이나 새 판이 더한 칸을 지우지 않게).
import { dataPath, homeDir, join, readJsonSync, writeJson } from "./paths.ts";

export interface AppSettings {
  /** 화면 주소의 기본 자리. 다른 프로그램이 쓰고 있으면 이웃 자리로 비켜 가되, 여기에 굳히지 않는다. */
  port: number;
  /** 화면을 띄울 브라우저 (비우면 이 컴퓨터의 기본) */
  browser: string;
  /** 업로드 완료·오류 때 컴퓨터 알림 */
  osNotify: boolean;
  /** 막힌 소식을 텔레그램으로도 */
  telegramAlerts: boolean;
  autoStart: boolean;
  autoStartAsked: boolean;
  updateDeclines: Record<string, number>;
  /** 새 채널의 폴더를 만들 상위 폴더 */
  baseDir: string;
  /** 문안이 없는 영상의 제목·설명·해시태그를 AI 가 지어 주나 (2.0 부터 기본 켜짐 — 본인 열쇠가 있어야 돈다) */
  aiTitles: boolean;
  aiKey: string;
  aiModel: string;
  /** 화면 서버가 켜져 있는 동안 심사확인 틱을 도는 간격(분) */
  tickMinutes: number;
  /** 쿠팡 파트너스 열쇠 입력 창을 이미 한 번 보여 줬나 (「나중에」·닫기·저장 모두 본 것으로 친다 — 다시 자동으로 안 띄운다) */
  coupangPrompted: boolean;
  /** AI 열쇠 입력 창을 이미 한 번 보여 줬나 (쿠팡과 같다 — 「나중에」·닫기·저장 모두 본 것으로 친다) */
  aiPrompted: boolean;
  [k: string]: unknown;
}

export const SETTINGS_DEFAULTS: AppSettings = {
  port: 8777,
  browser: "",
  osNotify: true,
  telegramAlerts: true,
  autoStart: false,
  autoStartAsked: false,
  updateDeclines: {},
  baseDir: "",
  aiTitles: true,
  aiKey: "",
  aiModel: "",
  tickMinutes: 10,
  coupangPrompted: false,
  aiPrompted: false,
};

const file = () => dataPath("앱설정.json");

function clamp(v: unknown, lo: number, hi: number, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

/** 채널 폴더를 만들 기본 상위 폴더 — 집 폴더 안의 한 곳 (바탕화면에 두지 않는다) */
export function defaultBaseDir(): string {
  return join(homeDir(), "가라사대업로더영상");
}

/** 지금 설정 (파일을 매번 읽는다 — 작고, 화면이 바꾼 값이 곧바로 보이게) */
export function appSettings(): AppSettings {
  const raw = readJsonSync<Record<string, unknown>>(file(), {});
  const s: AppSettings = { ...structuredClone(SETTINGS_DEFAULTS), ...raw } as AppSettings;
  s.port = clamp(s.port, 1024, 65535, 8777);
  s.tickMinutes = clamp(s.tickMinutes, 1, 120, 10);
  s.updateDeclines = (raw.updateDeclines && typeof raw.updateDeclines === "object") ? raw.updateDeclines as Record<string, number> : {};
  if (!s.baseDir) s.baseDir = defaultBaseDir();
  return s;
}

/** 바꾼 칸만 적는다 (나머지는 그대로). 새 설정을 돌려준다. */
export async function saveAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const raw = readJsonSync<Record<string, unknown>>(file(), {});
  const next = { ...raw, ...patch };
  await writeJson(file(), next, { secret: true }); // aiKey 가 들어 있을 수 있어 권한 600
  return appSettings();
}

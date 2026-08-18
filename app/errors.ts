// 오류 성격 구분 — 재시도 정책이 여기에 따라 달라진다.
// auth.ts 와 youtube.ts 가 함께 쓰므로 별도 파일로 둔다 (서로 물고 도는 것을 막기 위해).
export type ErrKind =
  | "config"     // 사용자가 구글 설정을 고쳐야 함 (재시도해도 소용없음)
  | "quota"      // 오늘 한도 소진 (내일 재개)
  | "temporary"  // 일시적 (재시도하면 됨)
  | "fatal";     // 이 파일 자체의 문제

export class UploadError extends Error {
  constructor(message: string, public kind: ErrKind = "fatal", public helpUrl = "") {
    super(message);
    this.name = "UploadError";
  }
}

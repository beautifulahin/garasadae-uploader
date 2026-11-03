#!/usr/bin/env python3
"""배포 파일(실행 파일 · 압축)에 구글 로그인 열쇠가 묶여 있는지 본다. build.sh 와 점검.sh 가 부른다.

  python3 배포/열쇠검사.py <파일> [<파일> ...]      열쇠가 하나라도 있으면 끝값 1

2.2.0 부터 배포 판에는 구글 로그인 열쇠(client_secret.json · device_secret.json)를 묶지 않는다.
이 검사기는 값을 한 글자도 출력하지 않는다 — 「없음 / 있음」과 종류·개수만 말한다.
찾는 것
  · 구글 클라이언트 ID 모양  <숫자>-<영숫자>.apps.googleusercontent.com
  · 구글 클라이언트 보안 비밀번호 모양  GOCSPX-<10자 이상>
  · 만든 사람의 실제 열쇠 값 — GARASADAE_CLIENT_DIR 또는 배포/.클라이언트경로 가 가리키는 폴더의 열쇠 파일에서 읽은 값을 그대로 찾는다(읽기만 · 출력 안 함)
앱 화면의 입력 칸 예시("....apps.googleusercontent.com" · "GOCSPX-...")는 숫자·글자가 이어지지 않아 걸리지 않는다.
"""
import json
import os
import pathlib
import re
import sys

모양 = {
    "클라이언트 ID": re.compile(rb"\d{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com"),
    "보안 비밀번호": re.compile(rb"GOCSPX-[A-Za-z0-9_\-]{10,}"),
}


def 실제값():
    """만든 사람의 열쇠 파일에서 읽은 값들 (없으면 빈 목록). 읽기만 하고 밖으로 내보내지 않는다."""
    폴더들 = []
    if os.environ.get("GARASADAE_CLIENT_DIR"):
        폴더들.append(os.environ["GARASADAE_CLIENT_DIR"])
    경로 = pathlib.Path(__file__).resolve().parent / ".클라이언트경로"
    if 경로.is_file():
        줄 = 경로.read_text(encoding="utf-8").splitlines()
        if 줄:
            폴더들.append(줄[0].strip())
    값 = set()
    for d in 폴더들:
        for 이름 in ("client_secret.json", "device_secret.json"):
            fp = pathlib.Path(d) / 이름
            if not fp.is_file():
                continue
            try:
                j = json.loads(fp.read_text(encoding="utf-8"))
                c = j.get("installed") or j.get("web") or j
                for k in ("client_id", "client_secret"):
                    v = str(c.get(k, ""))
                    if len(v) >= 8:
                        값.add(v.encode("utf-8"))
            except Exception:
                pass
    return 값


def 검사(파일, 값들):
    """(찾은 종류별 개수, 실제 값이 든 개수) — 값은 돌려주지 않는다"""
    b = pathlib.Path(파일).read_bytes()
    종류 = {k: len(p.findall(b)) for k, p in 모양.items()}
    실제 = sum(1 for v in 값들 if v in b)
    return 종류, 실제


def main(argv):
    파일들 = [a for a in argv if not a.startswith("--")]
    if not 파일들:
        print("사용법: python3 배포/열쇠검사.py <파일> [<파일> ...]")
        return 2
    값들 = 실제값()
    나쁨 = False
    for f in 파일들:
        if not pathlib.Path(f).is_file():
            print(f"  ❌ 검사할 파일이 없음: {f}")
            나쁨 = True
            continue
        종류, 실제 = 검사(f, 값들)
        있음 = [f"{k} {n}개" for k, n in 종류.items() if n] + ([f"만든 사람의 열쇠 값 {실제}칸"] if 실제 else [])
        이름 = pathlib.Path(f).name
        if 있음:
            print(f"  ❌ 구글 열쇠 있음 — {이름}: {' · '.join(있음)}")
            나쁨 = True
        else:
            print(f"  ✅ 구글 열쇠 없음 — {이름}" + (f" (만든 사람의 열쇠 {len(값들)}칸과도 대조)" if 값들 else " (모양만 검사)"))
    return 1 if 나쁨 else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

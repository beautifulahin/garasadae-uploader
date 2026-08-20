#!/bin/bash
# 개인판을 공개판에 맞춰 다시 짓는다 — 공개판(main) 위에 **쪽지**를 얹는다.
#
# 사용자 지시(2026-08-20): "내꺼는 니가 특별관리 해줘. 공개 릴리즈가 버전업이 되면
#                          내껀 자동으로 버전되게"
#
# 하는 일
#   ① 공개판(origin/main)을 받아 온다
#   ② 개인판 가지에 합친다 (쪽지는 개인판에만 있다)
#   ③ 점검 → 빌드 → /Applications 에 갈아끼운다
#   ④ 텔레그램으로 알린다
#
# ★바뀐 게 없으면 아무것도 하지 않는다. 그래서 자주 돌려도 된다.
# ★업로드가 도는 중이면 건드리지 않고 다음 번으로 미룬다.
set -e
cd "$(dirname "$0")"

로그() { echo "[$(date '+%m-%d %H:%M')] $*"; }
텔레그램() {
  local 글="$1"
  local 토큰=$(grep -m1 '^export TELEGRAM_TOKEN' ~/.volcano/env 2>/dev/null | cut -d= -f2- | tr -d ' "')
  local 방=$(grep -m1 '^export TELEGRAM_CHAT_ID' ~/.volcano/env 2>/dev/null | cut -d= -f2- | tr -d ' "' | cut -d, -f1)
  [ -n "$토큰" ] && [ -n "$방" ] && curl -s -o /dev/null \
    "https://api.telegram.org/bot$토큰/sendMessage" \
    --data-urlencode "chat_id=$방" --data-urlencode "text=$글" || true
}

git fetch -q origin main
합칠것=$(git rev-list --count 개인판..origin/main 2>/dev/null || echo 0)
if [ "$합칠것" = "0" ]; then
  로그 "공개판에 새로운 것이 없다 — 그대로 둔다"
  exit 0
fi
로그 "공개판에 새 것 ${합칠것}개 — 개인판을 다시 짓는다"

# 올리는 중이면 미룬다. 교체하다 업로드가 끊기면 그 편이 반쯤 올라간다.
if curl -s --max-time 3 "http://127.0.0.1:8777/api/state" 2>/dev/null | grep -q '"uploading":true'; then
  로그 "지금 올리는 중이라 미룬다"
  텔레그램 "⏸ 업로더 개인판 갱신을 미뤘다 — 지금 올리는 중"
  exit 0
fi

git checkout -q 개인판
if ! git merge -q origin/main -m "공개판을 개인판에 합친다"; then
  로그 "합치다 부딪혔다 — 손으로 풀어야 한다"
  텔레그램 "⚠️ 업로더 개인판 합치기 실패 — 손으로 풀어야 한다 (git status)"
  exit 1
fi

버전=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')
./점검.sh >/dev/null
./build.sh >/dev/null
로그 "빌드 끝 — v$버전"

pkill -f GarasadaeUploader || true
sleep 2
rm -rf "/Applications/가라사대 업로더.app"
cp -R "dist/맥-애플실리콘/가라사대 업로더.app" /Applications/
open "/Applications/가라사대 업로더.app"
로그 "갈아끼웠다 — v$버전 (쪽지 포함)"
텔레그램 "⬆️ 업로더 개인판을 공개판 v$버전 에 맞춰 다시 지었다 (쪽지 기능 그대로)"

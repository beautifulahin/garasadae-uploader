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

# ★도중에 엎어지면 **조용히 죽지 않는다.** 점검이나 빌드가 실패하면 옛 판이 그대로
#   돌고 있는데, 그걸 모르면 "새 공개판 기능이 왜 없지?" 하고 헤매게 된다.
trap 'rc=$?; [ $rc -ne 0 ] && 텔레그램 "⚠️ 업로더 개인판 갱신이 ${rc} 로 멈췄다 — 옛 판이 그대로 돈다. 터미널에서 개인판.sh 를 돌려 무엇이 막혔는지 보라."' EXIT

# ※ 변수 이름은 영문만 쓴다 — bash 가 한글 변수를 못 읽는다.
로그() { echo "[$(date '+%m-%d %H:%M')] $*"; }
텔레그램() {
  # ※ bash 는 변수 이름에 한글을 못 쓴다. 함수 이름은 되지만 변수는 안 된다 —
  #   여기 `local 글=` 로 뒀더니 알림이 통째로 안 나갔다(2026-08-20 발견).
  local msg="$1"
  local token=$(grep -m1 '^export TELEGRAM_TOKEN' ~/.volcano/env 2>/dev/null | cut -d= -f2- | tr -d ' "')
  local chat=$(grep -m1 '^export TELEGRAM_CHAT_ID' ~/.volcano/env 2>/dev/null | cut -d= -f2- | tr -d ' "' | cut -d, -f1)
  [ -n "$token" ] && [ -n "$chat" ] && curl -s -o /dev/null \
    "https://api.telegram.org/bot$token/sendMessage" \
    --data-urlencode "chat_id=$chat" --data-urlencode "text=$msg" || true
}

git fetch -q origin main
ahead=$(git rev-list --count 개인판..origin/main 2>/dev/null || echo 0)

# 지금 형편을 적어 둔다 — 소재앱이 이것을 읽어 화면에 보인다
pub_msg=$(LC_ALL=en_US.UTF-8 git log -1 --format=%s origin/main 2>/dev/null | LC_ALL=en_US.UTF-8 cut -c1-40)
ver_now=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')
mkdir -p ~/.volcano
cat > ~/.volcano/개인판상태.json <<JSON
{
 "확인때": "$(date -Iseconds)",
 "밀린것": $ahead,
 "지금판": "$ver_now",
 "공개끝": "$(echo "$pub_msg" | sed 's/"//g')"
}
JSON
if [ "$ahead" = "0" ]; then
  로그 "공개판에 새로운 것이 없다 — 그대로 둔다"
  exit 0
fi
로그 "공개판에 새 것 ${ahead}개 — 개인판을 다시 짓는다"

# 올리는 중이면 미룬다. 교체하다 업로드가 끊기면 그 편이 반쯤 올라간다.
if curl -s --max-time 3 "http://127.0.0.1:8777/api/state" 2>/dev/null | grep -q '"uploading":true'; then
  로그 "지금 올리는 중이라 미룬다"
  텔레그램 "⏸ 업로더 개인판 갱신을 미뤘다 — 지금 올리는 중"
  exit 0
fi

git checkout -q 개인판
# ★유일하게 사람 손이 필요한 자리 — 공개판이 쪽지와 **같은 줄**을 고쳤을 때다.
#   그때는 억지로 합치지 않고 되돌린 뒤 알린다. 반쯤 합쳐진 것으로 빌드하면 안 된다.
if ! git merge -q origin/main -m "공개판을 개인판에 합친다"; then
  git merge --abort || true
  로그 "합치다 부딪혔다 — 손으로 풀어야 한다"
  텔레그램 "⚠️ 업로더 개인판 합치기 충돌 — 공개판이 쪽지와 같은 줄을 고쳤다. 손으로 풀어야 한다."
  exit 1
fi

ver=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')
if ! ./점검.sh >/dev/null 2>&1; then
  로그 "점검 실패 — 갈아끼우지 않는다"
  텔레그램 "⚠️ 업로더 개인판 점검 실패 — 옛 판을 그대로 둔다"
  exit 1
fi
./build.sh >/dev/null
로그 "빌드 끝 — v$ver"

pkill -f GarasadaeUploader || true
sleep 2
rm -rf "/Applications/가라사대 업로더.app"
cp -R "dist/맥-애플실리콘/가라사대 업로더.app" /Applications/
# 화면에서 공개판과 구분되게 이름표를 붙인다 — 버전 숫자는 바탕이 된 공개판과 같아서
# 그것만으로는 "이거 공개판 아니야?" 하고 헷갈린다(실제로 그랬다).
echo "개인판" > "/Applications/가라사대 업로더.app/Contents/Resources/label.txt"
open "/Applications/가라사대 업로더.app"
로그 "갈아끼웠다 — v$ver (쪽지 포함)"
텔레그램 "⬆️ 업로더 개인판을 공개판 v$ver 에 맞춰 다시 지었다 (쪽지 기능 그대로)"

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
# ★`dirname $0` 을 쓰면 안 된다 — 도는 사본은 `~/.volcano` 에 있어서 거기로 들어간다.
#   저장소 자리를 곧바로 적는다(2026-08-22 에 ~/volcano_jobs 에서 옮겼다).
cd "$HOME/가라사대/youtube-uploader"

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

# ★**도는 사본이 낡았는지 스스로 본다** (2026-08-22).
#   이 파일은 저장소 밖(~/.volcano)에서 돌기 때문에, 저장소 것만 고치고 사본을 안
#   바꾸면 **고친 줄 알고 옛것이 계속 돈다.** 실제로 어제 고친 방아쇠가 사본에 안
#   옮겨져, 개인판에 얹은 것이 또 안 깔렸다(H-190 두 번째). 어긋나면 시끄럽게 군다.
me="$HOME/.volcano/개인판.sh"
src="$HOME/가라사대/youtube-uploader/개인판.sh"
if [ -f "$src" ] && ! cmp -s "$me" "$src"; then
  로그 "도는 사본이 저장소 것과 다르다 — 저장소 것으로 갈아끼운다"
  cp "$src" "$me"
  텔레그램 "🔁 업로더 개인판 갱신 스크립트를 저장소 판으로 갈아끼웠다. 이번 바퀴는 새 판으로 다시 돈다."
  exec /bin/bash "$me" "$@"
fi

git fetch -q origin main
ahead=$(git rev-list --count 개인판..origin/main 2>/dev/null || echo 0)

# ★**개인판 스스로 고친 것도 세어야 한다** (2026-08-22).
#   여태 방아쇠는 `공개판이 앞섰나` 하나뿐이었다. 그래서 개인판 가지에만 얹은 것은
#   **영영 안 깔렸다.** 실제로 08-21 22:04 에 얹은 「중복 막기·성적·공개 슬롯」이
#   여섯 시간 넘게 소스에만 있었고, 돌고 있는 앱은 21:41 판이었다 —
#   업로더의 **마지막 관문인 중복 막기가 꺼져 있는 줄도 몰랐다**(H-190).
#   그래서 **깔린 것이 어느 커밋인지** 도장을 찍어 두고, 가지가 그보다 앞서면 다시 짓는다.
stamp=~/.volcano/개인판빌드.json
built=$(grep -o '"커밋": *"[^"]*"' "$stamp" 2>/dev/null | sed 's/.*"\(.*\)"/\1/')
if [ -n "$built" ]; then
  mine=$(git rev-list --count "$built"..개인판 2>/dev/null || echo 0)
else
  mine=0                      # 도장이 없으면 첫 판이다 — 아래에서 앱과 대 본다
fi
# 도장이 없던 때(처음 한 번)는 **앱보다 소스가 새로우면** 다시 짓는다.
if [ -z "$built" ]; then
  app_mtime=$(stat -f %m "/Applications/가라사대 업로더.app/Contents/MacOS/GarasadaeUploader" 2>/dev/null || echo 0)
  src_mtime=$(git log -1 --format=%ct 개인판 2>/dev/null || echo 0)
  [ "$src_mtime" -gt "$app_mtime" ] && mine=1
fi

# 지금 형편을 적어 둔다 — 소재앱이 이것을 읽어 화면에 보인다
pub_msg=$(LC_ALL=en_US.UTF-8 git log -1 --format=%s origin/main 2>/dev/null | LC_ALL=en_US.UTF-8 cut -c1-40)
ver_now=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')
mkdir -p ~/.volcano
cat > ~/.volcano/개인판상태.json <<JSON
{
 "확인때": "$(date -Iseconds)",
 "밀린것": $ahead,
 "안깔린것": $mine,
 "지금판": "$ver_now",
 "공개끝": "$(echo "$pub_msg" | sed 's/"//g')"
}
JSON
if [ "$ahead" = "0" ] && [ "$mine" = "0" ]; then
  로그 "공개판에도 개인판에도 새로운 것이 없다 — 그대로 둔다"
  exit 0
fi
로그 "새 것 — 공개판 ${ahead}개 · 개인판 ${mine}개 — 다시 짓는다"

# 올리는 중이면 미룬다. 교체하다 업로드가 끊기면 그 편이 반쯤 올라간다.
if curl -s --max-time 3 "http://127.0.0.1:8777/api/state" 2>/dev/null | grep -q '"uploading":true'; then
  로그 "지금 올리는 중이라 미룬다"
  텔레그램 "⏸ 업로더 개인판 갱신을 미뤘다 — 지금 올리는 중"
  exit 0
fi

git checkout -q 개인판
# ★유일하게 사람 손이 필요한 자리 — 공개판이 쪽지와 **같은 줄**을 고쳤을 때다.
#   그때는 억지로 합치지 않고 되돌린 뒤 알린다. 반쯤 합쳐진 것으로 빌드하면 안 된다.
if [ "$ahead" != "0" ] && ! git merge -q origin/main -m "공개판을 개인판에 합친다"; then
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
# ★`build.sh` 는 **main 이 아니면 굽기를 거절한다**(2026-08-21 사고: 다른 가지의
#   기능이 공개 릴리스에 섞여 나갔다). 개인판 가지는 그 문을 열쇠로 지난다 —
#   build.sh 주석에는 "개인판.sh 가 그렇게 부른다" 고 적혀 있었는데, 정작
#   여기에 열쇠가 없어 **자동 갱신이 그날부터 한 번도 성공하지 못했다**(H-190).
VOLCANO_BUILD_ANY=1 ./build.sh >/dev/null
로그 "빌드 끝 — v$ver"

pkill -f GarasadaeUploader || true
sleep 2
# ★**지우지 말고 치운다** (사용자 지시 2026-08-21). 새 판이 안 뜨면 되돌릴 것이
#   있어야 한다. 옛 판은 한 벌만 남긴다.
mkdir -p ~/.volcano/옛앱
rm -rf ~/.volcano/옛앱/가라사대\ 업로더.app.이전 2>/dev/null || true
[ -d "/Applications/가라사대 업로더.app" ] && \
  mv "/Applications/가라사대 업로더.app" ~/.volcano/옛앱/"가라사대 업로더.app.이전"
cp -R "dist/맥-애플실리콘/가라사대 업로더.app" /Applications/
# 화면에서 공개판과 구분되게 이름표를 붙인다 — 버전 숫자는 바탕이 된 공개판과 같아서
# 그것만으로는 "이거 공개판 아니야?" 하고 헷갈린다(실제로 그랬다).
echo "개인판" > "/Applications/가라사대 업로더.app/Contents/Resources/label.txt"
open "/Applications/가라사대 업로더.app"
# 무엇을 깔았는지 도장을 찍는다 — 다음 바퀴가 이것을 보고 판정한다
cat > ~/.volcano/개인판빌드.json <<JSON
{
 "깐때": "$(date -Iseconds)",
 "커밋": "$(git rev-parse 개인판)",
 "판": "$ver"
}
JSON
로그 "갈아끼웠다 — v$ver (쪽지 포함)"
텔레그램 "⬆️ 업로더 개인판을 공개판 v$ver 에 맞춰 다시 지었다 (쪽지 기능 그대로)"

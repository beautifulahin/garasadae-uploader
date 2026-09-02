#!/bin/bash
# 가라사대 업로더 — 맥 한 줄 설치
#
#   curl -fsSL https://beautifulahin.github.io/garasadae-uploader/install.sh | bash
#
# ■ 왜 터미널로 받나
#   브라우저(크롬·사파리)로 받은 파일에는 맥이 「인터넷에서 받음」 표(com.apple.quarantine)를
#   붙인다. 그 표가 붙어 있으면 공증(애플 심사)을 받지 않은 앱은 「열지 않음」 창에 막힌다.
#   curl 로 받으면 그 표가 아예 붙지 않아서, 공증 없이도 창이 뜨지 않는다. (2026-09-02 실측 확인)
#
# ■ 손댈 때 주의
#   · bash 는 변수 이름에 한글을 못 쓴다 — 한글 변수를 썼다가 "태그=v1.7.16: command not found"
#     로 멈춘 적이 있다(2026-08-21, 릴리스.sh 주석 참고). 변수 이름은 영어로 짓는다.
#   · 이 파일은 파이프로 bash 에 먹인다. stdin 이 스크립트 자신이므로 read 로 사용자 입력을
#     받으면 안 된다. 물어보지 말고 끝까지 알아서 한다.
#   · rm -rf 를 쓰지 않는다(저장소 규칙: 지우지 말고 치운다). 이미 깔린 앱은 옮겨서 남긴다.
#   · 릴리스를 새로 올려도 이 파일은 고칠 것이 없다 — releases/latest/download 를 쓴다.

set -euo pipefail

BASE_URL="https://github.com/beautifulahin/garasadae-uploader/releases/latest/download"
APP_NAME="가라사대 업로더.app"
# 설치 위치. 시험할 때만 GARASADAE_DEST 로 바꾼다(평소에는 손대지 않는다).
DEST_ROOT="${GARASADAE_DEST:-/Applications}"

tmp_dir=""
cleanup () {
  # 내가 mktemp 로 만든 임시 폴더만 지운다. rm -rf 는 쓰지 않는다.
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    /usr/bin/find "$tmp_dir" -delete 2>/dev/null || true
  fi
}
trap cleanup EXIT

say  () { printf '%s\n' "$*"; }
fail () {
  printf '\n❌ %s\n' "$1"
  shift
  if [ $# -gt 0 ]; then printf '   %s\n' "$@"; fi
  exit 1
}

say ""
say "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
say "  가라사대 업로더 설치"
say "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ① 맥인지 확인
if [ "$(uname -s)" != "Darwin" ]; then
  fail "이 설치 방법은 맥에서만 됩니다." \
       "윈도우를 쓰신다면 아래에서 garasadae-uploader-windows.zip 을 받으세요." \
       "https://github.com/beautifulahin/garasadae-uploader/releases/latest"
fi

# ② 칩 가르기 — 로제타 안에서 돌면 uname 이 x86_64 라고 답하므로 하드웨어를 따로 본다
is_arm=0
if [ "$(uname -m)" = "arm64" ]; then
  is_arm=1
else
  arm_flag="$( { sysctl -n hw.optional.arm64 || /usr/sbin/sysctl -n hw.optional.arm64 ; } 2>/dev/null || echo 0 )"
  [ "$arm_flag" = "1" ] && is_arm=1
fi

if [ "$is_arm" = "1" ]; then
  asset="garasadae-uploader-mac-apple-silicon.zip"
  chip_name="Apple 칩"
else
  asset="garasadae-uploader-mac-intel.zip"
  chip_name="Intel 칩"
fi
say "[1/6] 내 맥: $chip_name — $asset 를 받습니다."

# ③ 내려받기
tmp_dir="$(mktemp -d)"
say "[2/6] 내려받는 중… (30MB 정도, 인터넷 속도에 따라 10초~1분)"
if ! curl -fL --retry 2 --progress-bar -o "$tmp_dir/$asset" "$BASE_URL/$asset"; then
  fail "내려받지 못했습니다." \
       "인터넷 연결을 확인하고 잠시 뒤 같은 명령을 다시 붙여넣어 보세요." \
       "계속 안 되면 아래 주소를 브라우저로 열어 파일이 있는지 확인해 주세요." \
       "$BASE_URL/$asset"
fi
if [ ! -s "$tmp_dir/$asset" ]; then
  fail "받은 파일이 비어 있습니다. 잠시 뒤 다시 해 주세요."
fi

# ④ 풀기 — 실행권한과 코드서명을 온전히 보존하려면 unzip 이 아니라 ditto 여야 한다
say "[3/6] 압축을 푸는 중…"
if ! ditto -x -k "$tmp_dir/$asset" "$tmp_dir/x" 2>/dev/null; then
  fail "받은 파일의 압축을 풀지 못했습니다." \
       "받다가 끊겼을 수 있습니다. 같은 명령을 한 번 더 붙여넣어 주세요."
fi

# ⑤ 앱 찾기
app_src="$(/usr/bin/find "$tmp_dir/x" -maxdepth 3 -type d -name '*.app' -print 2>/dev/null | head -1)"
if [ -z "$app_src" ] || [ ! -d "$app_src/Contents/MacOS" ]; then
  fail "압축 안에서 「${APP_NAME}」 을 찾지 못했습니다." \
       "배포 파일이 잘못 올라갔을 수 있습니다. 아래로 알려 주세요." \
       "https://github.com/beautifulahin/garasadae-uploader/issues"
fi

# ⑥ 놓을 자리 정하기 — /Applications 에 못 쓰면 홈 폴더의 Applications 로
if [ ! -d "$DEST_ROOT" ] || [ ! -w "$DEST_ROOT" ]; then
  say ""
  say "⚠️  $DEST_ROOT 에 넣을 권한이 없습니다."
  say "   대신 홈 폴더의 Applications 에 넣습니다."
  say "   (Finder 에서 보시려면 위 메뉴 「이동」 → 「홈」 → Applications 폴더)"
  DEST_ROOT="$HOME/Applications"
  mkdir -p "$DEST_ROOT" 2>/dev/null || true
  if [ ! -w "$DEST_ROOT" ]; then
    fail "$HOME/Applications 에도 넣지 못했습니다." \
         "맥을 다시 켠 뒤 같은 명령을 다시 해 보시고, 그래도 안 되면 알려 주세요." \
         "https://github.com/beautifulahin/garasadae-uploader/issues"
  fi
fi
dest_app="$DEST_ROOT/$APP_NAME"

# 이미 깔려 있으면 지우지 말고 치운다
if [ -e "$dest_app" ]; then
  backup_dir="$HOME/.가라사대업로더_이전/$(date +%Y%m%d_%H%M)"
  mkdir -p "$backup_dir"
  if ! mv "$dest_app" "$backup_dir/"; then
    fail "이미 있는 앱을 옮기지 못했습니다." \
         "앱이 실행 중이면 먼저 끄고 같은 명령을 다시 해 주세요."
  fi
  say "[4/6] 이미 있던 앱은 지우지 않고 옮겨 두었습니다 → $backup_dir"
else
  say "[4/6] 처음 설치입니다."
fi

# ⑦ 놓기
if ! ditto "$app_src" "$dest_app"; then
  fail "$DEST_ROOT 에 넣지 못했습니다." \
       "저장 공간이 모자라지 않은지 확인하고 다시 해 주세요."
fi
say "[5/6] 넣었습니다 → $dest_app"

# ⑧ 안전벨트 — 혹시라도 붙은 「인터넷에서 받음」 표를 떼어 둔다
xattr -dr com.apple.quarantine "$dest_app" 2>/dev/null || true

# ⑨ 열기
say "[6/6] 실행합니다…"
if open "$dest_app" 2>/dev/null; then
  say ""
  say "✅ 설치가 끝났습니다."
  say "   잠시 뒤 브라우저에 설정 화면이 뜹니다."
  say "   안 뜨면 브라우저 주소창에 http://127.0.0.1:8777 을 넣어 주세요."
else
  say ""
  say "✅ 설치는 끝났습니다. 다만 자동으로 실행되지 않았습니다."
  say "   Finder 에서 $DEST_ROOT 의 「${APP_NAME}」 을 더블클릭해 주세요."
fi

# ⑩ 다음부터
say ""
say "   다음부터는 그냥 더블클릭하면 열립니다. 경고창은 나오지 않습니다."
say "   처음 한 번은 구글 계정 연결이 필요합니다 (약 10분, 화면의 「시작하기」 탭)."
say ""

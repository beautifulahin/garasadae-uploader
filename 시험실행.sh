#!/bin/bash
# 실제 사용 중인 설정·포트를 건드리지 않고 시험해 보기 위한 실행기.
# 별도 설정 폴더와 포트를 쓰므로 돌아가고 있는 진짜 앱과 충돌하지 않는다.
cd "$(dirname "$0")" || exit 1
SANDBOX="${SANDBOX:-/tmp/가라사대_시험}"
PORT="${PORT:-9777}"

mkdir -p "$SANDBOX"
if [ ! -f "$SANDBOX/config.json" ]; then
  cat > "$SANDBOX/config.json" <<CFG
{ "port": $PORT, "watchDir": "$SANDBOX/업로드대기", "privacy": "private", "afterUpload": "keep" }
CFG
fi

echo "설정 폴더 : $SANDBOX"
echo "감시 폴더 : $SANDBOX/업로드대기"
echo "화면      : http://127.0.0.1:$PORT"
echo "구글 연결 정보가 없으므로 실제 업로드는 일어나지 않습니다."
echo
GARASADAE_DATA_DIR="$SANDBOX" exec deno run -A --no-lock app/main.ts "$@"

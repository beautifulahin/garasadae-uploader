#!/bin/bash
# 실제 사용 중인 설정·포트·자동 시작을 건드리지 않고 써 보기 위한 실행기.
# 임시 데이터 폴더·가짜 집 폴더·다른 포트를 쓰므로 돌아가고 있는 진짜 앱과 충돌하지 않는다.
#   ./시험실행.sh                      화면을 띄운다 (브라우저가 열린다)
#   ./시험실행.sh 오늘                 명령줄 (같은 임시 폴더에서)
#   SANDBOX=/tmp/내시험 PORT=9780 ./시험실행.sh
#   ※ 옛 판(1.x) 자료 이행을 눈으로 보려면 SANDBOX 폴더에 config.json · tokens/ · state.json 을 넣고 켠다.
cd "$(dirname "$0")" || exit 1
SANDBOX="${SANDBOX:-/tmp/가라사대_시험}"
PORT="${PORT:-9777}"

mkdir -p "$SANDBOX/집"
if [ ! -f "$SANDBOX/앱설정.json" ]; then
  echo "{ \"port\": $PORT }" > "$SANDBOX/앱설정.json"
fi

echo "데이터 폴더 : $SANDBOX"
echo "가짜 집     : $SANDBOX/집   (자동 시작·열쇠 찾기가 진짜 집 폴더를 보지 않는다)"
echo "화면        : http://127.0.0.1:$PORT"
echo "구글 연결 정보가 없으므로 실제 업로드는 일어나지 않습니다."
echo
GARASADAE_DATA_DIR="$SANDBOX" GARASADAE_HOME="$SANDBOX/집" exec deno run -A --no-lock app/main.ts "$@"

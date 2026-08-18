#!/bin/bash
# 가라사대 유튜브 업로더 실행기
cd "$(dirname "$0")" || exit 1
PORT=8000

# 이미 켜져 있으면 브라우저만 열기
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "이미 서버가 실행 중입니다 (포트 $PORT)"
  open "http://localhost:$PORT"
  exit 0
fi

echo "=============================================="
echo " 가라사대 유튜브 업로더"
echo " http://localhost:$PORT"
echo " 종료하려면 이 창에서 Control+C"
echo "=============================================="
( sleep 1; open "http://localhost:$PORT" ) &
python3 -m http.server $PORT

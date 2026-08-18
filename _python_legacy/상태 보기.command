#!/bin/bash
cd "$(dirname "$0")" || exit 1
clear
python3 autoupload.py status
echo
echo "── 최근 로그 20줄 ───────────────────────────"
tail -n 20 logs/uploader.log 2>/dev/null || echo "(로그 없음)"
echo
echo "창을 닫으려면 아무 키나 누르세요."
read -n 1 -s

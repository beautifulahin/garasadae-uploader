#!/bin/bash
cd "$(dirname "$0")" || exit 1
clear
echo "=============================================="
echo "  가라사대 자동 업로더 — 최초 설정"
echo "=============================================="
python3 autoupload.py setup
echo
echo "설정이 끝났으면 '자동업로드 켜기.command' 를 실행하세요."
echo "창을 닫으려면 아무 키나 누르세요."
read -n 1 -s

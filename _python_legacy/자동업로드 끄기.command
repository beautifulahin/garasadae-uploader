#!/bin/bash
cd "$(dirname "$0")" || exit 1
launchctl bootout "gui/$UID/com.garasadae.uploader" 2>/dev/null \
  || launchctl unload "$HOME/Library/LaunchAgents/com.garasadae.uploader.plist" 2>/dev/null
echo "⚪️ 자동 업로드를 껐습니다. (설정과 기록은 그대로 남습니다)"
echo; echo "창을 닫으려면 아무 키나 누르세요."
read -n 1 -s

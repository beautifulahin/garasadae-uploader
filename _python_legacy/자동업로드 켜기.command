#!/bin/bash
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/com.garasadae.uploader.plist"
PY3="$(command -v python3 || echo /usr/bin/python3)"
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"

if [ ! -f "$DIR/tokens.json" ]; then
  echo "❌ 먼저 setup.command 로 구글 로그인을 해주세요."
  read -n 1 -s; exit 1
fi

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.garasadae.uploader</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY3</string>
    <string>$DIR/autoupload.py</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>$DIR/logs/daemon.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/daemon.err.log</string>
</dict></plist>
PL

launchctl bootout "gui/$UID/com.garasadae.uploader" 2>/dev/null
launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
sleep 1
echo
if launchctl list | grep -q com.garasadae.uploader; then
  echo "🟢 자동 업로드가 켜졌습니다."
  python3 autoupload.py status
else
  echo "❌ 시작 실패. logs/daemon.err.log 를 확인하세요."
fi
echo; echo "창을 닫으려면 아무 키나 누르세요."
read -n 1 -s

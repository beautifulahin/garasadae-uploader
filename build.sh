#!/bin/bash
# 가라사대 업로더 — 배포용 빌드 (맥에서 윈도우용까지 만든다)
set -e
cd "$(dirname "$0")"
OUT=dist
PERM="--allow-net --allow-read --allow-write --allow-env --allow-run --allow-sys"
INC="--include app/ui.html"
APP="가라사대 업로더"
EXEC="GarasadaeUploader"   # 번들 내부 실행파일은 ASCII 여야 코드서명이 유효하다
rm -rf "$OUT"; mkdir -p "$OUT"

compile () {  # $1=타깃 $2=출력경로
  echo "▶ $1"
  deno compile --no-lock $PERM $INC --target "$1" -o "$2" app/main.ts >/dev/null
}

make_app () {  # $1=바이너리 $2=.app 만들 폴더
  local B="$2/$APP.app/Contents"
  mkdir -p "$B/MacOS" "$B/Resources"
  mv "$1" "$B/MacOS/$EXEC"
  chmod +x "$B/MacOS/$EXEC"
  printf '1.0.0\n' > "$B/Resources/version.txt"
  cat > "$B/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$EXEC</string>
  <key>CFBundleDisplayName</key><string>가라사대 업로더</string>
  <key>CFBundleIdentifier</key><string>com.garasadae.uploader</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleExecutable</key><string>$EXEC</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PL
  rm -rf "$2/$APP.app/Contents/_CodeSignature"
  codesign --force --sign - "$2/$APP.app" 2>/dev/null || true
  codesign --verify --strict "$2/$APP.app" 2>/dev/null \
    && echo "  ↳ 코드서명 확인" || echo "  ↳ ⚠️ 코드서명 검증 실패"
}

# ---------- 맥 (애플 실리콘) ----------
mkdir -p "$OUT/맥-애플실리콘"
compile aarch64-apple-darwin "$OUT/_tmp_arm"
make_app "$OUT/_tmp_arm" "$OUT/맥-애플실리콘"

# ---------- 맥 (인텔) ----------
mkdir -p "$OUT/맥-인텔"
compile x86_64-apple-darwin "$OUT/_tmp_x64"
make_app "$OUT/_tmp_x64" "$OUT/맥-인텔"

# ---------- 윈도우 ----------
mkdir -p "$OUT/윈도우"
compile x86_64-pc-windows-msvc "$OUT/윈도우/가라사대업로더.exe"

# ---------- 안내문 동봉 ----------
cp 배포/맥_처음읽어주세요.txt "$OUT/맥-애플실리콘/처음 읽어주세요.txt"
cp 배포/맥_처음읽어주세요.txt "$OUT/맥-인텔/처음 읽어주세요.txt"
cp 배포/윈도우_처음읽어주세요.txt "$OUT/윈도우/처음 읽어주세요.txt"

# ---------- 압축 ----------
cd "$OUT"
for d in 맥-애플실리콘 맥-인텔 윈도우; do
  zip -qry "가라사대업로더-$d.zip" "$d"
done
cd ..

echo
find "$OUT" -maxdepth 2 -name "*.zip" -o -maxdepth 2 -name "*.app" -o -maxdepth 2 -name "*.exe" | sort
du -sh "$OUT"/*.zip 2>/dev/null || du -sh "$OUT"/*/*.zip 2>/dev/null
echo "✅ 완료 — dist 폴더의 zip 을 배포하세요."

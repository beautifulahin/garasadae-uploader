#!/bin/bash
# 가라사대 업로더 — 배포용 빌드 (맥에서 윈도우용까지 만든다)
set -e
cd "$(dirname "$0")"
OUT=dist
PERM="--allow-net --allow-read --allow-write --allow-env --allow-run --allow-sys"
INC="--include app/ui.html"
VER=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')
APP="가라사대 업로더"
EXEC="GarasadaeUploader"   # 번들 내부 실행파일은 ASCII 여야 코드서명이 유효하다
# 빌드 전에 반드시 점검을 통과해야 한다 (같은 실수를 되풀이하지 않기 위한 관문)
if ! ./점검.sh; then
  echo
  echo "❌ 점검에 실패해 빌드를 멈춥니다."
  exit 1
fi
echo

rm -rf "$OUT"; mkdir -p "$OUT"
echo "버전: $VER"

compile () {  # $1=타깃 $2=출력경로
  echo "▶ $1"
  deno compile --no-lock $PERM $INC --target "$1" -o "$2" app/main.ts >/dev/null
}

make_app () {  # $1=바이너리 $2=.app 만들 폴더
  local B="$2/$APP.app/Contents"
  mkdir -p "$B/MacOS" "$B/Resources"
  mv "$1" "$B/MacOS/$EXEC"
  chmod +x "$B/MacOS/$EXEC"
  printf "%s\n" "$VER" > "$B/Resources/version.txt"
  cat > "$B/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$EXEC</string>
  <key>CFBundleDisplayName</key><string>가라사대 업로더</string>
  <key>CFBundleIdentifier</key><string>com.garasadae.uploader</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
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
# 파일 이름은 반드시 app/update.ts 의 assetName() 과 같아야 한다.
# 자동 업데이트가 이 이름으로 내려받기 때문에, 이름이 어긋나면 업데이트가 조용히 멈춘다.
# 그래서 여기서 짓고, 아래에서 update.ts 와 대조한다.
ZIP_ARM="garasadae-uploader-mac-apple-silicon.zip"
ZIP_X64="garasadae-uploader-mac-intel.zip"
ZIP_WIN="garasadae-uploader-windows.zip"

# 맥용은 zip 명령을 그대로 쓴다 (.app 의 실행권한·서명 파일을 온전히 보존한다).
cd "$OUT"
zip -qry "$ZIP_ARM" "맥-애플실리콘"
zip -qry "$ZIP_X64" "맥-인텔"
cd ..

# 윈도우용은 파이썬으로 압축한다.
# 맥의 zip 은 한글 이름을 UTF-8 로 넣으면서 'UTF-8 이름' 표시(플래그 11)를 켜지 않는다.
# 그러면 한국어 윈도우 탐색기가 CP949 로 잘못 읽어 이름이 깨지고 "파일을 찾을 수 없습니다" 가 난다.
# 파이썬 zipfile 은 이 플래그를 제대로 켠다. (2026-08-19 실제 사고)
python3 - "$OUT" "$ZIP_WIN" <<'PY'
import os, sys, zipfile
out, name = sys.argv[1], sys.argv[2]
src = "윈도우"
os.chdir(out)
with zipfile.ZipFile(name, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        z.write(root, root + "/")
        for f in sorted(files):
            z.write(os.path.join(root, f))
PY

# 윈도우 압축파일이 실제로 UTF-8 플래그를 켰는지 확인한다 (안 켜졌으면 빌드 실패).
python3 - "$OUT" "$ZIP_WIN" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1] + "/" + sys.argv[2])
bad = [i.orig_filename for i in z.infolist() if not (i.flag_bits & 0x800)]
if bad:
    print("❌ 윈도우 압축파일의 이름이 UTF-8 로 표시되지 않았습니다:", bad)
    sys.exit(1)
print("  ↳ 윈도우 압축파일 이름 UTF-8 확인 (%d 항목)" % len(z.infolist()))
PY

# 만든 파일 이름이 자동 업데이트가 찾는 이름과 같은지 대조한다.
# 어긋나면 배포는 되는데 업데이트만 안 되어, 한참 뒤에야 알아챈다.
python3 - "$OUT" "$ZIP_ARM" "$ZIP_X64" "$ZIP_WIN" <<'PY'
import os, re, sys, pathlib
out, made = sys.argv[1], sys.argv[2:]
src = pathlib.Path("app/update.ts").read_text(encoding="utf-8")
want = set(re.findall(r'"(garasadae-uploader-[a-z0-9-]+[.]zip)"', src))
if not want:
    print("\u274c app/update.ts 에서 배포 파일 이름을 찾지 못했습니다"); sys.exit(1)
if want != set(made):
    print("\u274c 배포 파일 이름이 자동 업데이트가 찾는 이름과 다릅니다.")
    print("   update.ts 가 찾는 것:", sorted(want))
    print("   빌드가 만든 것      :", sorted(made))
    sys.exit(1)
missing = [n for n in made if not os.path.exists(os.path.join(out, n))]
if missing:
    print("\u274c 만들어지지 않은 배포 파일:", missing); sys.exit(1)
print("  \u21b3 배포 파일 이름 %d개가 자동 업데이트와 일치" % len(made))
PY

echo
find "$OUT" -maxdepth 2 -name "*.zip" -o -maxdepth 2 -name "*.app" -o -maxdepth 2 -name "*.exe" | sort
du -sh "$OUT"/*.zip 2>/dev/null || du -sh "$OUT"/*/*.zip 2>/dev/null
# 패치 내용을 릴리스에 함께 올린다 — 앱이 업데이트 창에 이것을 보여 준다
if [ -f "배포/릴리스노트_$VER.md" ]; then
  cp "배포/릴리스노트_$VER.md" "$OUT/notes.md"
  echo "  ↳ notes.md (업데이트 창에 보일 패치 내용)"
fi

echo "✅ 완료 — dist 폴더의 zip 3개를 그대로 릴리스에 올리세요 (이름을 바꾸면 안 됩니다)."

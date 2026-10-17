#!/bin/bash
# 가라사대 업로더 — 배포용 빌드 (맥에서 윈도우용까지 만든다)
#
#   ./build.sh          맥(애플 실리콘·인텔) + 윈도우 + 압축 3개  (릴리스용)
#   ./build.sh --맥     이 컴퓨터용 맥 실행 파일 하나만 (빠른 확인용 — 압축·릴리스 파일은 안 만든다)
#
# 빌드만 한다. 올리기·릴리스·푸시는 하지 않는다 (릴리스는 릴리스.sh 를 따로, 배포 지시를 받았을 때만).
set -e
cd "$(dirname "$0")"
OUT=dist
ONLY_MAC=0
case "${1:-}" in --맥|--mac) ONLY_MAC=1 ;; "") ;; *) echo "모르는 인자: $1  (쓸 수 있는 것: --맥)"; exit 2 ;; esac
PERM="--allow-net --allow-read --allow-write --allow-env --allow-run --allow-sys"
INC="--include app/ui.html --include app/ui"
VER=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')

# ── 어느 가지에서 굽는지 못 박는다 ────────────────────────────
# ★2026-08-21 사고: 다른 가지에 선 채로 빌드해 **공개 릴리스에 그 가지의 기능이
#   들어간 바이너리**가 올라갔다. dist 는 곧 릴리스에 올라가는 것이므로, 여기서 막는다.
#   자기 판을 굽는 것은 VOLCANO_BUILD_ANY=1 을 주면 된다.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
if [ "$BRANCH" != "main" ] && [ "${VOLCANO_BUILD_ANY:-0}" != "1" ]; then
  echo "❌ 지금 가지가 '$BRANCH' 입니다. 배포용 빌드는 main 에서만 합니다."
  echo "   (자기 판을 구우려면  VOLCANO_BUILD_ANY=1 ./build.sh )"
  exit 1
fi
APP="가라사대 업로더"
EXEC="GarasadaeUploader"   # 번들 내부 실행파일은 ASCII 여야 코드서명이 유효하다
# 빌드 전에 반드시 점검을 통과해야 한다 (같은 실수를 되풀이하지 않기 위한 관문)
if ! ./점검.sh; then
  echo
  echo "❌ 점검에 실패해 빌드를 멈춥니다."
  exit 1
fi
echo

# 이전 빌드 결과는 지우지 않고 옆으로 치운다 (dist.이전_날짜시각 — .gitignore 에 올라 있다)
if [ -d "$OUT" ]; then mv "$OUT" "$OUT.이전_$(date +%Y%m%d_%H%M%S)"; fi
mkdir -p "$OUT"
echo "버전: $VER"

# ── 이 앱에 묶는 구글 로그인 열쇠 (사장님 지시: 「껍데기만 빼고 전부 동일」) ───────────────────
#   · 열쇠 파일은 만든 사람의 것이다. 소스·git·문서·로그 어디에도 값을 두지 않는다 — 굽는 동안만 build/.client/ 에 복사해
#     deno compile --include 로 실행 파일 안에 묶고, 굽고 나면(성공이든 실패든) 바로 지운다. (build/.client/ 는 .gitignore)
#   · 열쇠가 든 폴더의 자리는 환경변수 GARASADAE_CLIENT_DIR 또는 배포/.클라이언트경로(한 줄짜리 파일 · .gitignore) 로만 알려 준다.
#     값은 이 스크립트가 출력하지 않는다 — 「있음/없음」만 말한다.
#   · 열쇠가 없으면 열쇠 없이 구워진다(사용자가 자기 열쇠 파일을 넣어야 로그인된다). 채널 전용 열쇠(채널마다 따로 쓰는 열쇠)는 묶지 않는다.
CLIENT_SRC="${GARASADAE_CLIENT_DIR:-}"
if [ -z "$CLIENT_SRC" ] && [ -f "배포/.클라이언트경로" ]; then CLIENT_SRC="$(head -1 배포/.클라이언트경로)"; fi
rm -rf build/.client
trap 'rm -rf build/.client' EXIT
mkdir -p build/.client
BAKED=""
for f in client_secret.json device_secret.json; do
  if [ -n "$CLIENT_SRC" ] && [ -f "$CLIENT_SRC/$f" ]; then
    cp "$CLIENT_SRC/$f" "build/.client/$f"; chmod 600 "build/.client/$f"; BAKED="$BAKED $f"
  fi
done
if [ -n "$BAKED" ]; then echo "  ↳ 내장 로그인 열쇠를 묶습니다:$BAKED (값은 출력하지 않습니다 · 굽고 나면 지웁니다)"
else echo "  ↳ ⚠️ 내장 로그인 열쇠 없이 굽습니다 — 이 판은 사용자가 열쇠 파일을 넣어야 로그인됩니다"; fi
INC="$INC --include build/.client"

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

# ---------- 맥 전용(--맥): 이 컴퓨터의 칩에 맞는 하나만 ----------
if [ "$ONLY_MAC" = "1" ]; then
  if [ "$(uname -m)" = "arm64" ]; then T=aarch64-apple-darwin; D="맥-애플실리콘"; else T=x86_64-apple-darwin; D="맥-인텔"; fi
  mkdir -p "$OUT/$D"
  compile "$T" "$OUT/_tmp_native"
  make_app "$OUT/_tmp_native" "$OUT/$D"
  echo
  echo "✅ 맥 실행 파일만 구웠습니다 (--맥) — $OUT/$D/ · 압축·릴리스 파일은 만들지 않았습니다."
  { echo "가지: $BRANCH"; echo "커밋: $(git rev-parse --short HEAD 2>/dev/null)"
    echo "버전: $VER"; echo "구운때: $(date -Iseconds)"; echo "범위: 맥만 (--맥)"; } > "$OUT/_BUILT_FROM.txt"
  exit 0
fi

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

# macOS 15 부터 「오른쪽 클릭 → 열기」 우회가 없어졌다. 처음 한 번 여는 도우미를 함께 넣는다.
# (더블클릭으로 돌아야 하므로 실행권한을 반드시 준다.)
cp 배포/열기.command "$OUT/맥-애플실리콘/열기.command"
cp 배포/열기.command "$OUT/맥-인텔/열기.command"
chmod 755 "$OUT/맥-애플실리콘/열기.command" "$OUT/맥-인텔/열기.command"

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

# 무엇으로 구웠는지 남긴다 — 릴리스 전에 이 파일을 확인한다
{ echo "가지: $BRANCH"; echo "커밋: $(git rev-parse --short HEAD 2>/dev/null)"
  echo "버전: $VER"; echo "구운때: $(date -Iseconds)"; } > "$OUT/_BUILT_FROM.txt"

echo "✅ 완료 — dist 폴더의 zip 3개를 그대로 릴리스에 올리세요 (이름을 바꾸면 안 됩니다)."

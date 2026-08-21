#!/bin/bash
# 릴리스 올리기 — **main 에서 구운 것만** 올라가게 막는다.
#
# ★2026-08-21 사고: 다른 가지에서 구운 바이너리를 공개 릴리스에 덮어써서,
#   그 가지에만 있어야 할 기능이 배포본에 실려 나갔다. 3분 만에 되돌렸지만
#   사람 눈으로 잡은 것이라 다음에도 잡힌다는 보장이 없다. 그래서 기계가 막는다.
#
#   ./릴리스.sh v1.7.16 "가라사대 업로더 1.7.16"
set -e
cd "$(dirname "$0")"
태그="$1"; 제목="${2:-가라사대 업로더 ${1#v}}"
[ -z "$태그" ] && { echo "쓰는 법: ./릴리스.sh v1.7.16 [제목]"; exit 1; }

[ -f dist/_BUILT_FROM.txt ] || { echo "❌ dist 가 없습니다. ./build.sh 를 먼저 하세요."; exit 1; }
구운가지=$(grep '^가지:' dist/_BUILT_FROM.txt | cut -d' ' -f2)
구운버전=$(grep '^버전:' dist/_BUILT_FROM.txt | cut -d' ' -f2)
지금가지=$(git rev-parse --abbrev-ref HEAD)
소스버전=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')

[ "$구운가지" = "main" ] || { echo "❌ dist 는 '$구운가지' 에서 구운 것입니다. main 에서 다시 구우세요."; exit 1; }
[ "$지금가지" = "main" ] || { echo "❌ 지금 가지가 '$지금가지' 입니다."; exit 1; }
[ "$구운버전" = "$소스버전" ] || { echo "❌ 구운 것($구운버전)과 소스($소스버전)의 버전이 다릅니다."; exit 1; }
[ "v$소스버전" = "$태그" ] || { echo "❌ 태그($태그)와 버전(v$소스버전)이 다릅니다."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "❌ 커밋 안 한 것이 있습니다."; exit 1; }

# 개인판에만 있어야 할 것이 섞였는지 마지막으로 뒤진다
B="dist/맥-애플실리콘/가라사대 업로더.app/Contents/MacOS/GarasadaeUploader"
샌것=$(strings "$B" 2>/dev/null | grep -c 'sidecarPath\|readSidecar' || true)
[ "$샌것" = "0" ] || { echo "❌ 배포본에 개인판 기능이 섞여 있습니다($샌것곳). 올리지 않습니다."; exit 1; }

노트="배포/릴리스노트_${소스버전}.md"
[ -f "$노트" ] || { echo "❌ $노트 가 없습니다."; exit 1; }

echo "✅ 검사 통과 — main · v$소스버전 · 깨끗함. 올립니다."
gh release create "$태그" dist/*.zip dist/notes.md --title "$제목" --notes-file "$노트"

#!/bin/bash
# 릴리스 올리기 — **main 에서 구운 것만** 올라가게 막는다.
#
# ★2026-08-21 사고: 다른 가지에서 구운 바이너리를 공개 릴리스에 덮어써서,
#   그 가지에만 있어야 할 기능이 배포본에 실려 나갔다. 3분 만에 되돌렸지만
#   사람 눈으로 잡은 것이라 다음에도 잡힌다는 보장이 없다. 그래서 기계가 막는다.
#
#   ./릴리스.sh v1.7.16 "가라사대 업로더 1.7.16"
# ※ bash 는 변수 이름에 한글을 못 쓴다 — 한글 변수를 썼다가
#   "태그=v1.7.16: command not found" 로 멈췄다(2026-08-21).
set -e
cd "$(dirname "$0")"
tag="$1"; title="${2:-가라사대 업로더 ${1#v}}"
[ -z "$tag" ] && { echo "쓰는 법: ./릴리스.sh v1.7.16 [제목]"; exit 1; }

[ -f dist/_BUILT_FROM.txt ] || { echo "❌ dist 가 없습니다. ./build.sh 를 먼저 하세요."; exit 1; }
built_branch=$(grep '^가지:' dist/_BUILT_FROM.txt | cut -d' ' -f2)
built_ver=$(grep '^버전:' dist/_BUILT_FROM.txt | cut -d' ' -f2)
now_branch=$(git rev-parse --abbrev-ref HEAD)
src_ver=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')

[ "$built_branch" = "main" ] || { echo "❌ dist 는 '$built_branch' 에서 구운 것입니다. main 에서 다시 구우세요."; exit 1; }
[ "$now_branch" = "main" ] || { echo "❌ 지금 가지가 '$now_branch' 입니다."; exit 1; }
[ "$built_ver" = "$src_ver" ] || { echo "❌ 구운 것($built_ver)과 소스($src_ver)의 버전이 다릅니다."; exit 1; }
[ "v$src_ver" = "$tag" ] || { echo "❌ 태그($tag)와 버전(v$src_ver)이 다릅니다."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "❌ 커밋 안 한 것이 있습니다."; exit 1; }

# (2026-08-25) 개인판을 공개판에 합쳤다 — 쪽지·성적·슬롯은 이제 공개 기능이라 「섞임 검사」를 뺐다.
notes="배포/릴리스노트_${src_ver}.md"
[ -f "$notes" ] || { echo "❌ $notes 가 없습니다."; exit 1; }

echo "✅ 검사 통과 — main · v$src_ver · 깨끗함. 올립니다."
gh release create "$tag" dist/*.zip dist/notes.md --title "$title" --notes-file "$notes"

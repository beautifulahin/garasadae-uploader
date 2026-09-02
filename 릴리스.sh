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

# ---------- 문서 사이트(gh-pages) 올리기 ----------
# ★2026-09-02: 깃허브 페이지의 소스는 docs/ 가 아니라 **gh-pages 라는 딴 가지**다.
#   그동안 사람이 손으로 옮겨서, main 의 docs/ 를 고쳐도 사이트는 낡은 채로 남아 있었다.
#   docs/install.sh(맥 한 줄 설치)가 그 주소에서 살아야 하므로 여기서 기계가 옮긴다.
#
#   · 지금 작업 폴더의 가지는 절대 갈아타지 않는다 — git worktree 로 딴 데 붙여서 쓰고 뗀다.
#   · .nojekyll 은 손대지 않는다 (gh-pages 에 이미 있다).
#   · 바뀐 것이 없으면 커밋하지 않는다.
#   · 여기서 실패해도 **이미 올라간 릴리스는 건드리지 않는다.** 손으로 올리라고 알리고 끝낸다.
#   · rm -rf 를 쓰지 않는다(저장소 규칙). 임시 폴더는 내가 만든 것만 find -delete 로 치운다.
publish_docs () {
  local wt_base wt_dir file names rc
  wt_base="$(mktemp -d)"
  wt_dir="$wt_base/site"
  rc=0

  git fetch --quiet origin gh-pages || return 1
  git worktree add --quiet -B gh-pages "$wt_dir" origin/gh-pages || return 1

  names=()
  for file in docs/*.html docs/install.sh; do
    if [ -f "$file" ]; then
      cp "$file" "$wt_dir/" || rc=1
      names+=("$(basename "$file")")
    fi
  done
  if [ ${#names[@]} -eq 0 ]; then rc=1; fi

  if [ "$rc" = "0" ]; then
    git -C "$wt_dir" add -- "${names[@]}" || rc=1
  fi

  if [ "$rc" = "0" ]; then
    if git -C "$wt_dir" diff --cached --quiet; then
      echo "   ↳ 문서 사이트는 이미 최신입니다 (올릴 것 없음)."
    else
      git -C "$wt_dir" commit -q -m "문서 사이트 갱신 — v$src_ver" || rc=1
      if [ "$rc" = "0" ]; then
        git -C "$wt_dir" push --quiet origin gh-pages || rc=1
      fi
      if [ "$rc" = "0" ]; then
        echo "   ↳ 문서 사이트를 올렸습니다: ${names[*]}"
      fi
    fi
  fi

  # 뒷정리 — 붙였던 worktree 를 떼고 임시 폴더를 치운다
  git worktree remove --force "$wt_dir" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  if [ -d "$wt_base" ]; then /usr/bin/find "$wt_base" -delete 2>/dev/null || true; fi
  return "$rc"
}

echo "📄 문서 사이트(gh-pages)를 갱신합니다…"
if ! publish_docs; then
  echo ""
  echo "⚠️  릴리스는 올라갔지만 **문서 사이트 올리기는 실패**했습니다."
  echo "   릴리스는 그대로 둡니다. 아래를 손으로 해 주세요."
  echo "     git fetch origin gh-pages"
  echo "     git worktree add -B gh-pages /tmp/site origin/gh-pages"
  echo "     cp docs/*.html docs/install.sh /tmp/site/"
  echo "     git -C /tmp/site add -A && git -C /tmp/site commit -m '문서 사이트 갱신'"
  echo "     git -C /tmp/site push origin gh-pages"
  echo "     git worktree remove /tmp/site"
fi

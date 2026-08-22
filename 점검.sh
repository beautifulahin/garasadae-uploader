#!/bin/bash
# 빌드 전 자동 점검 — 지금까지 실제로 냈던 실수를 다시 내지 않기 위한 검사기.
# 하나라도 실패하면 빌드를 멈춘다.
cd "$(dirname "$0")" || exit 1
FAIL=0
ok(){ echo "  ✅ $1"; }
ng(){ echo "  ❌ $1"; FAIL=1; }

echo "── 1. 타입·문법 ─────────────────────────────"
if deno check --no-lock app/main.ts >/dev/null 2>&1; then ok "TypeScript 전체 통과"; else ng "TypeScript 오류 (deno check app/main.ts 로 확인)"; fi

python3 - <<'PY'
import re, sys, json, collections, pathlib
s = pathlib.Path('app/ui.html').read_text(encoding='utf-8')
fail = []

# ── 2. 화면 스타일 (2026-08-19 실제 사고: style 묶음을 잃어 팝업이 본문에 나열됨)
need = ['.modal{','.modal.on{','.modal-box{','.mbtn{','.dash{','.panel{','.chcard{','.chrow{',
        '.howto{','.tro{','.must{','.hintline{','.grid2{','.flabel{','.p13{','.danger{',
        '.gauge{','.thumbs{','.thumb{','.drop{','.qc{','.qc-top{','.hrow{','.empty{','.toast{',
        '.tabs{','.tab{','.tp{','.hdr{','.logo{','.fin{','.tgl{','.go{','.tb{','.card{','.kv{','.mini{','.seg{']
miss = [n for n in need if n not in s]
print("── 2. 화면 스타일 ───────────────────────────")
if miss: print("  ❌ 필수 CSS 규칙 누락:", ", ".join(miss)); fail.append(1)
else: print(f"  ✅ 필수 CSS 규칙 {len(need)}종 모두 존재")

blocks = re.findall(r'<style>(.*?)</style>', s, re.S)
bad = [i+1 for i,b in enumerate(blocks) if b.count('{') != b.count('}')]
if bad: print(f"  ❌ style 블록 중괄호 불균형: {bad}번째"); fail.append(1)
else: print(f"  ✅ style 블록 {len(blocks)}개 중괄호 균형")

# 팝업이 기본으로 숨겨지는지 (본문에 나열되지 않도록)
m = re.search(r'\.modal\{([^}]*)\}', s)
if not m or 'display:none' not in m.group(1):
    print("  ❌ .modal 이 기본으로 숨겨지지 않음 — 팝업이 화면에 그대로 나열됩니다"); fail.append(1)
else: print("  ✅ 팝업 기본 숨김")

# ── 3. 화면 구조
print("── 3. 화면 구조 ─────────────────────────────")
ids = re.findall(r'\bid="([^"]+)"', s)
dup = {k:v for k,v in collections.Counter(ids).items() if v>1}
if dup: print("  ❌ 중복 id:", dup); fail.append(1)
else: print(f"  ✅ id 중복 없음 ({len(ids)}개)")

import html.parser
class P(html.parser.HTMLParser):
    def __init__(s): super().__init__(); s.stack=[]
    def handle_starttag(s,t,a):
        if t not in ('meta','link','br','img','input','hr'): s.stack.append(t)
    def handle_endtag(s,t):
        if s.stack and s.stack[-1]==t: s.stack.pop()
p=P(); p.feed(s)
if p.stack: print("  ❌ 닫히지 않은 태그:", p.stack); fail.append(1)
else: print("  ✅ 태그 균형")

# ── 4. 버튼이 부르는 함수가 실제로 있는지
print("── 4. 버튼 동작 ─────────────────────────────")
calls = set(re.findall(r'on(?:click|input|change)=\\?["\']?(\w+)\(', s))
defined = (set(re.findall(r'function\s+(\w+)\s*\(', s))
           | set(re.findall(r'async function\s+(\w+)', s))
           | set(re.findall(r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(', s)))
missing = sorted(c for c in calls if c not in defined)
if missing: print("  ❌ 정의 없는 함수 호출:", missing); fail.append(1)
else: print(f"  ✅ 버튼이 부르는 함수 {len(calls)}개 모두 존재")

# ── 5. 개인정보가 배포본에 남지 않았는지
print("── 5. 개인정보 ──────────────────────────────")
# 실제 값만 잡는다. 입력창 안내문(GOCSPX-... / ....apps.googleusercontent.com)은 예시라 제외.
patterns = {
  '개인 채널명': r'자유시간',
  '사용자 이름': r'kimtaeyun',
  '프로젝트 번호': r'\b74259647806\b',
  '채널 ID': r'UC[\w-]{22}',
  '실제 보안 비밀번호': r'GOCSPX-[A-Za-z0-9_\-]{6,}',
  '실제 클라이언트 ID': r'\b\d{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com',
}
found=[]
for f in list(pathlib.Path('app').rglob('*')) + [pathlib.Path('README.md')] + list(pathlib.Path('docs').rglob('*.md')):
    if not f.is_file(): continue
    try: t=f.read_text(encoding='utf-8')
    except Exception: continue
    for label, pat in patterns.items():
        if re.search(pat, t): found.append(f"{f} → {label}")
if found: print("  ❌ 개인정보 흔적:", found); fail.append(1)
else: print("  ✅ 개인 채널명·계정·열쇠 흔적 없음")

# ── 6. 버전 일관성
print("── 6. 버전 ──────────────────────────────────")
ver = re.search(r'APP_VERSION = "([^"]+)"', pathlib.Path('app/paths.ts').read_text(encoding='utf-8')).group(1)
b = pathlib.Path('build.sh').read_text(encoding='utf-8')
if 'APP_VERSION' in b: print(f"  ✅ 버전 {ver} · 빌드가 소스에서 읽음")
else: print("  ❌ build.sh 가 버전을 소스에서 읽지 않음"); fail.append(1)

sys.exit(1 if fail else 0)
PY
[ $? -ne 0 ] && FAIL=1

echo "── 6.5 개인판 논리 (중복 막기·슬롯·성적·틀) ──"
# 순수 함수라 앱을 안 띄우고도 시험할 수 있다. 여기서 막히면 빌드하지 않는다.
# ※ 변수 이름은 영문만 쓴다 — bash 가 한글 변수를 못 읽는다(또 당했다).
# ★가짓수를 손으로 적어 두었더니 시험을 더해도 21 인 채로 남아 거짓말을 했다.
#   세어서 적는다 (2026-08-22).
TESTOUT=$(deno run --allow-read --allow-write --allow-env --no-lock 개인판시험.ts 2>&1)
if echo "$TESTOUT" | grep -q "전부 통과"; then
  echo "  ✅ 개인판 논리 $(echo "$TESTOUT" | grep -c '✅')종 통과"
else
  echo "$TESTOUT" | sed 's/^/  /'
  FAIL=1
fi

echo "── 7. 실제 실행 · 이전(마이그레이션) ─────────"
T=$(mktemp -d)
mkdir -p "$T/옛폴더"
cat > "$T/config.json" <<CFG
{"watchDir":"$T/옛폴더","clientId":"old.apps.googleusercontent.com","clientSecret":"s",
 "privacy":"unlisted","afterUpload":"delete","dailyLimit":6,"port":9999,
 "tags":["가","나"],"titlePrefix":"[前] "}
CFG
echo '{"refresh_token":"r","channel":{"title":"옛채널","thumb":"","subs":"1"}}' > "$T/tokens.json"
TODAY=$(date +%Y-%m-%d)
# ★할당량은 **태평양 날짜**로 센다(1.7.6~). 유튜브가 그 날짜로 세기 때문이다.
#   여기서 이 컴퓨터 날짜를 쓰면, 시차가 있는 곳에서는 시험이 늘 실패한다.
TODAY_PT=$(TZ=America/Los_Angeles date +%Y-%m-%d)
echo "{\"uploads\":[{\"id\":\"V1\",\"title\":\"옛영상\",\"file\":\"a.mp4\",\"size\":1,\"privacy\":\"private\",\"at\":\"${TODAY}T00:00:00\"}],\"quotaUsed\":1600,\"quotaDate\":\"$TODAY_PT\"}" > "$T/state.json"
GARASADAE_DATA_DIR="$T" deno run -A --no-lock app/main.ts --background >/dev/null 2>&1 &
PID=$!
sleep 5
R=$(curl -s -m 3 http://127.0.0.1:9999/api/state)
kill $PID 2>/dev/null; lsof -ti tcp:9999 | xargs kill -9 2>/dev/null
echo "$R" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  ❌ 실행 실패 (화면이 응답하지 않음)'); sys.exit(1)
c=d['channelList'][0] if d['channelList'] else None
if not c: print('  ❌ 옛 설정이 채널로 옮겨지지 않음'); sys.exit(1)
checks=[('채널 생성',c['name']!=''),('폴더 유지','옛폴더' in c['folder']),
        ('로그인 유지',c['authed']),('설정 유지',c['privacy']=='unlisted' and c['afterUpload']=='delete'),
        ('태그 유지',c['tags']==['가','나']),('접두어 유지',c['titlePrefix']=='[前] '),
        ('기록 유지',len(d['uploads'])==1 and d['uploads'][0]['channelName']!=''),
        ('오늘 쿼터 유지',d['channels'][0]['quotaUsed']==1600),
        ('오늘 업로드 수 유지',d['channels'][0]['todayCount']==1)]
bad=[n for n,o in checks if not o]
for n,o in checks: print(('  ✅ ' if o else '  ❌ ')+n)
sys.exit(1 if bad else 0)"
[ $? -ne 0 ] && FAIL=1
rm -rf "$T"

echo
if [ $FAIL -eq 0 ]; then echo "🟢 점검 통과 — 빌드해도 됩니다"; else echo "🔴 점검 실패 — 위 항목을 고친 뒤 다시 실행하세요"; fi
exit $FAIL

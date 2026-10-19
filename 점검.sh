#!/bin/bash
# 빌드 전 자동 점검 — 지금까지 실제로 냈던 실수를 다시 내지 않기 위한 검사기.
# 하나라도 실패하면 빌드를 멈춘다. (구글·유튜브·쿠팡에는 한 번도 닿지 않는다 — 가짜 서버와 임시 폴더만 쓴다)
cd "$(dirname "$0")" || exit 1
FAIL=0
ok(){ echo "  ✅ $1"; }
ng(){ echo "  ❌ $1"; FAIL=1; }

echo "── 1. 타입·문법 ─────────────────────────────"
if deno check --no-lock app/main.ts app/cli.ts >/dev/null 2>&1; then ok "TypeScript 통과 (앱 전체)"; else ng "TypeScript 오류 (deno check app/main.ts 로 확인)"; fi
if deno check --no-lock 시험/*.ts 논리시험.ts >/dev/null 2>&1; then ok "TypeScript 통과 (시험 코드)"; else ng "시험 코드 TypeScript 오류 (deno check 시험/*.ts 로 확인)"; fi
if bash -n build.sh 2>/dev/null; then ok "build.sh 문법"; else ng "build.sh 문법 오류"; fi

echo "── 2. 개인정보·열쇠가 배포본에 남지 않았는지 ──"
# 값은 한 줄도 출력하지 않는다 — 어느 파일에 걸렸는지와 어떤 종류인지만 말한다.
python3 - <<'PY'
import re, sys, os, json, subprocess, pathlib
root = pathlib.Path('.')
def git(*a):
    try: return subprocess.run(['git', *a], capture_output=True, text=True, check=True).stdout
    except Exception: return ''
# 추적되는 파일 + 아직 추적 안 되지만 .gitignore 에도 안 걸리는 파일 (= 곧 올라갈 수 있는 파일)
files = [f for f in (git('ls-files', '-z').split('\0') + git('ls-files', '-z', '--others', '--exclude-standard').split('\0')) if f]
files = [f for f in files if not f.startswith(('_python_legacy/', 'dist/')) and pathlib.Path(f).is_file()]
patterns = {
  '개인 채널명': r'자유시간|우격다짐|자유의외침|애국청년|우문현답|ReapyWorld|oshi_daily|rescene_daily|aeguk|garasadae_long',
  '사용자 이름': r'kimtaeyun',
  '프로젝트 번호': r'\b74259647806\b',
  '채널 ID': r'UC[\w-]{22}',
  '실제 보안 비밀번호': r'GOCSPX-[A-Za-z0-9_\-]{6,}',
  '실제 클라이언트 ID': r'\b\d{6,}-[a-z0-9]{10,}\.apps\.googleusercontent\.com',
  '구글 프로젝트 이름': r'shorts-uploader-\d+',
  '실제 AI 열쇠 모양': r'AIza[0-9A-Za-z_\-]{35}',
}
# 이 검사기와 시험 코드는 일부러 가짜 모양/금지어를 적는다 — 시험이 쓰는 가짜 값은 아래 허용 표시를 단다
SKIP = {'점검.sh', 'index.html', 'start.command'}   # 루트의 index.html · start.command 는 앱 이전 시절의 낡은 실행기(개발 메모가 든다) — 앱에 들어가지 않는다
found = []
for f in files:
    if f in SKIP: continue
    try: t = pathlib.Path(f).read_text(encoding='utf-8')
    except Exception: continue
    for label, pat in patterns.items():
        for m in re.finditer(pat, t):
            if label == '채널 ID' and re.fullmatch(r'UC(.)\1{21}', m.group(0)): continue   # 같은 글자 22개 = 가짜 모양
            line = t[:m.start()].count('\n') + 1
            seg = t.splitlines()[line - 1] if t.splitlines() else ''
            # 시험의 가짜 값·안내 예시(입력창 placeholder)는 허용: 「가짜」「fake」「예시」「placeholder」 같은 줄 표시
            if re.search(r'가짜|fake|예시|placeholder|\.\.\.|…|금지|패턴|정규식', seg, re.I): continue
            found.append(f'{f}:{line} → {label}')
            break
# 내장 열쇠 원본의 실제 값이 소스에 있으면 안 된다 (값은 읽기만 하고 출력하지 않는다)
src_dirs = []
if os.environ.get('GARASADAE_CLIENT_DIR'): src_dirs.append(os.environ['GARASADAE_CLIENT_DIR'])
p = pathlib.Path('배포/.클라이언트경로')
if p.is_file():
    src_dirs.append(p.read_text(encoding='utf-8').splitlines()[0].strip())
secrets = set()
for d in src_dirs:
    for n in ('client_secret.json', 'device_secret.json', 'meta.json'):
        fp = pathlib.Path(d) / n
        if fp.is_file():
            try:
                j = json.loads(fp.read_text(encoding='utf-8')); c = j.get('installed') or j.get('web') or j
                for k in ('client_id', 'client_secret', 'ig_app_id', 'th_app_id', 'worker_url'):
                    v = str(c.get(k, ''))
                    if len(v) >= 8: secrets.add(v)
            except Exception: pass
leak = []
for f in files:
    if f in SKIP: continue
    try: t = pathlib.Path(f).read_text(encoding='utf-8')
    except Exception: continue
    if any(v in t for v in secrets): leak.append(f)
bad = False
if found: print('  ❌ 개인정보·열쇠 흔적:', found[:20], '…' if len(found) > 20 else ''); bad = True
else: print('  ✅ 개인 채널명·계정·열쇠 모양 흔적 없음 (추적·올라갈 파일 %d개 검사)' % len(files))
if leak: print('  ❌ 내장 열쇠의 실제 값이 들어간 파일:', leak); bad = True
else: print('  ✅ 내장 열쇠의 실제 값은 어느 파일에도 없음' + (' (원본 %d칸과 대조)' % len(secrets) if secrets else ' (원본 열쇠 파일이 없어 모양만 검사)'))
ig = pathlib.Path('.gitignore').read_text(encoding='utf-8')
need = ['build/.client/', 'client_secret*.json', 'device_secret.json', '배포/.클라이언트경로', '쿠팡파트너스.json', '앱설정.json']
miss = [n for n in need if n not in ig]
if miss: print('  ❌ .gitignore 에 빠진 칸:', miss); bad = True
else: print('  ✅ .gitignore 가 열쇠·로그인 정보 파일을 막고 있음')
if pathlib.Path('build/.client').exists() and any(pathlib.Path('build/.client').iterdir()):
    print('  ❌ build/.client 에 열쇠가 남아 있음 (빌드 뒤에 지워져야 함)'); bad = True
sys.exit(1 if bad else 0)
PY
[ $? -ne 0 ] && FAIL=1

echo "── 3. 버전 ──────────────────────────────────"
VER=$(grep -o 'APP_VERSION = "[^"]*"' app/paths.ts | head -1 | sed 's/.*"\(.*\)"/\1/')
if grep -q 'APP_VERSION' build.sh; then ok "버전 $VER · 빌드가 소스에서 읽음"; else ng "build.sh 가 버전을 소스에서 읽지 않음"; fi
if [ -f "배포/릴리스노트_$VER.md" ]; then ok "릴리스 노트 있음 (배포/릴리스노트_$VER.md)"; else ng "배포/릴리스노트_$VER.md 가 없음"; fi
if grep -Eq 'kimtaeyun|자유시간|우격다짐|애국청년|UC[A-Za-z0-9_-]{22}' "배포/릴리스노트_$VER.md" 2>/dev/null; then ng "릴리스 노트에 개인정보 흔적 (공개 문서입니다)"; else ok "릴리스 노트에 개인 채널명·이름·채널 ID 없음"; fi

echo "── 4. 논리 시험 (규칙·안전장치·이행·열쇠 찾기·화면) ──"
# 가짜 구글 서버와 임시 폴더만 쓴다. 여기서 막히면 빌드하지 않는다.
# ※ 변수 이름은 영문만 쓴다 — bash 가 한글 변수를 못 읽는다.
TESTOUT=$(TZ=Asia/Seoul deno run --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys --no-lock 논리시험.ts 2>&1)
if echo "$TESTOUT" | grep -q "전부 통과"; then
  ok "논리 시험 $(echo "$TESTOUT" | grep -c '✅')종 통과"
else
  echo "$TESTOUT" | grep -v "^  ✅" | sed 's/^/  /' | tail -60
  FAIL=1
fi

echo "── 5. 실제 실행 · 옛 판(1.8.4) 자료 이행 ─────"
# 임시 데이터 폴더·가짜 집·다른 포트에서 진짜 앱을 띄운다. 실제 사용 중인 설정·포트·자동 시작에는 닿지 않는다.
T=$(mktemp -d)
mkdir -p "$T/data/tokens" "$T/home" "$T/영상/채널가" "$T/영상/채널나"
echo "x" > "$T/영상/채널가/a1.mp4"; echo "x" > "$T/영상/채널나/b1.mp4"
cat > "$T/data/config.json" <<CFG
{"schema":2,"port":8777,"pollSeconds":5,"stableChecks":3,"notifications":true,"telegramAlerts":false,
 "autoStart":false,"autoStartAsked":true,"updateDeclines":{},"baseDir":"$T/home/Desktop/업로드대기","browser":"","aiTitles":false,"aiKey":"","aiModel":"",
 "channels":[
  {"id":"ch_aaaa1111","name":"채널가","folder":"$T/영상/채널가","clientId":"old-a.apps.googleusercontent.com","clientSecret":"fake-secret-a","sharesWith":"","enabled":true,"createdAt":"2026-08-20T01:02:03.000Z","privacy":"private","categoryId":"22","language":"ko","tags":["가","나"],"description":"","titlePrefix":"[前] ","titleSuffix":"","madeForKids":false,"notifySubscribers":true,"reviewMode":false,"afterUpload":"move","dailyLimit":3,"studioAfter":"ask","dupGuard":true,"publishSlots":["07:00","19:00"],"firstComment":false,"firstCommentText":"","retitleHours":0,"retitleTemplate":""},
  {"id":"ch_bbbb2222","name":"채널나","folder":"$T/영상/채널나","clientId":"","clientSecret":"","sharesWith":"ch_aaaa1111","enabled":true,"createdAt":"2026-08-21T01:02:03.000Z","privacy":"public","categoryId":"22","language":"ko","tags":[],"description":"","titlePrefix":"","titleSuffix":"","madeForKids":false,"notifySubscribers":true,"reviewMode":false,"afterUpload":"trash","dailyLimit":0,"studioAfter":"ask","dupGuard":true,"publishSlots":[],"firstComment":false,"firstCommentText":"","retitleHours":0,"retitleTemplate":""}
 ]}
CFG
echo '{"access_token":"fake-access","refresh_token":"fake-refresh-a","expires_at":1,"scope":"https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly","channel":{"id":"UCaaaaaaaaaaaaaaaaaaaaaa","title":"가 제목","thumb":"","subs":"1"}}' > "$T/data/tokens/ch_aaaa1111.json"
echo '{"access_token":"fake-access","refresh_token":"fake-refresh-b","expires_at":1,"channel":{"id":"UCbbbbbbbbbbbbbbbbbbbbbb","title":"나 제목","thumb":"","subs":"2"}}' > "$T/data/tokens/ch_bbbb2222.json"
TODAY=$(date +%Y-%m-%d)
echo "{\"uploads\":[{\"id\":\"VID_1\",\"title\":\"옛 영상 하나\",\"file\":\"old1.mp4\",\"size\":1,\"privacy\":\"private\",\"at\":\"${TODAY}T00:00:00\",\"channelId\":\"ch_aaaa1111\",\"channelName\":\"채널가\",\"publishAt\":\"2099-01-02T00:00:00.000Z\"},{\"id\":\"VID_2\",\"title\":\"옛 영상 둘\",\"file\":\"old2.mp4\",\"size\":2,\"privacy\":\"public\",\"at\":\"${TODAY}T01:00:00\",\"channelId\":\"ch_bbbb2222\",\"channelName\":\"채널나\"}],\"stats\":{},\"jobs\":[],\"kept\":{},\"failed\":{},\"quota\":{}}" > "$T/data/state.json"
# 이 시험이 쓸 포트는 앱 설정으로 못 박는다 (옛 설정의 8777 은 실제 사용 중일 수 있다)
PORT=$((20000 + RANDOM % 20000))
echo "{\"port\": $PORT}" > "$T/data/앱설정.json"
BEFORE=$(cd "$T/data" && shasum config.json state.json tokens/*.json | shasum | cut -d' ' -f1)
run_app(){
  GARASADAE_DATA_DIR="$T/data" GARASADAE_HOME="$T/home" GARASADAE_OFFLINE=1 GARASADAE_NO_DESKTOP=1 \
    deno run -A --no-lock app/main.ts --background >"$T/app.out" 2>&1 &
  APP_PID=$!
  for i in $(seq 1 60); do
    if curl -s -m 2 "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}
stop_app(){ kill "$APP_PID" 2>/dev/null; sleep 1; kill -9 "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; }
if run_app; then
  R=$(curl -s -m 5 "http://127.0.0.1:$PORT/api/state")
  H=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: evil.example" "http://127.0.0.1:$PORT/api/state")
  O=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://evil.example" -H "Content-Type: application/json" -d '{}' "http://127.0.0.1:$PORT/api/upload/lock")
  C=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H "Content-Type: text/plain" -d '{}' "http://127.0.0.1:$PORT/api/upload/lock")
  P=$(curl -s -m 5 "http://127.0.0.1:$PORT/" | grep -c "가라사대")
  RECS=$(curl -s -m 5 "http://127.0.0.1:$PORT/api/records?limit=50")
  stop_app
  AFTER=$(cd "$T/data" && shasum config.json state.json tokens/*.json | shasum | cut -d' ' -f1)
  echo "$R" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('  ❌ 실행 실패 (화면이 응답하지 않음)'); sys.exit(1)
ch={c['name']:c for c in d.get('channels',[])}
checks=[('버전 2.x', d.get('version','').startswith('2.')),('옛 채널 둘이 그대로', sorted(ch)==['채널가','채널나']),
        ('로그인 유지(둘 다)', all(c['authed'] for c in ch.values())),('채널 ID 유지', ch['채널가']['channelId']=='UCaaaaaaaaaaaaaaaaaaaaaa' and ch['채널나']['channelId']=='UCbbbbbbbbbbbbbbbbbbbbbb'),
        ('폴더 유지', ch['채널가']['folder'].endswith('채널가') and ch['채널나']['folder'].endswith('채널나')),
        ('채널 설정 유지(접두어·태그·공개칸)', ch['채널가']['conf'].get('title_prefix')=='[前] ' and ch['채널가']['conf'].get('tags')==['가','나'] and ch['채널가']['conf'].get('times')==['07:00','19:00']),
        ('대기 중인 영상 수 유지', ch['채널가']['counts']['대기']==1 and ch['채널나']['counts']['대기']==1),
        ('이행 보류 없음', d.get('migrate',{}).get('hold') is False),
        ]
bad=[n for n,o in checks if not o]
for n,o in checks: print(('  ✅ ' if o else '  ❌ ')+n)
sys.exit(1 if bad else 0)"
  [ $? -ne 0 ] && FAIL=1
  echo "$RECS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ids=sorted(x['id'] for x in d.get('items',[]))
sched=[x for x in d.get('items',[]) if x['id']=='VID_1']
good = ids==['VID_1','VID_2'] and sched and str(sched[0].get('publishAt','')).startswith('2099-01')
print('  ✅ 올린 기록 둘이 그대로(예약 시각 포함)' if good else '  ❌ 올린 기록이 달라짐: %s' % ids)
sys.exit(0 if good else 1)"
  [ $? -ne 0 ] && FAIL=1
  [ "$H" = "403" ] && ok "엉뚱한 Host 로 부르면 막는다 (403)" || ng "엉뚱한 Host 가 통과함 ($H)"
  [ "$O" = "403" ] && ok "다른 사이트에서 부르면 막는다 (403)" || ng "다른 Origin 이 통과함 ($O)"
  [ "$C" = "415" ] && ok "JSON 이 아닌 POST 는 거절한다 (415)" || ng "JSON 이 아닌 POST 가 통과함 ($C)"
  [ "$P" -ge 1 ] && ok "화면(/)이 뜬다" || ng "화면(/)이 안 뜸"
  [ "$BEFORE" = "$AFTER" ] && ok "옛 파일(config · state · tokens/)은 한 글자도 안 바뀜" || ng "옛 파일이 바뀌었음"
  ls "$T/data/백업" 2>/dev/null | grep -q "이행전_" && ok "옮기기 전 복사본이 만들어짐" || ng "복사본이 없음"
  [ -f "$T/data/이행기록.json" ] && ok "이행기록.json 이 남음" || ng "이행기록.json 이 없음"
  # 한 번 더 켜기 — 이미 옮겼으니 아무것도 다시 옮기지 않아야 한다
  CH1=$(cat "$T/data/channels.json" "$T/data/tokens.json" "$T/data/ledger.csv" | shasum | cut -d' ' -f1)
  if run_app; then
    curl -s -m 5 "http://127.0.0.1:$PORT/api/state" >/dev/null
    stop_app
    CH2=$(cat "$T/data/channels.json" "$T/data/tokens.json" "$T/data/ledger.csv" | shasum | cut -d' ' -f1)
    [ "$CH1" = "$CH2" ] && ok "두 번째로 켜도 채널·로그인·기록이 그대로 (다시 옮기지 않음)" || ng "두 번째로 켜자 자료가 바뀜"
  else
    stop_app; ng "두 번째 실행 실패"
  fi
else
  stop_app; echo "  ----- 앱 출력 -----"; tail -20 "$T/app.out" | sed 's/^/  /'; ng "앱이 뜨지 않음"
fi
rm -rf "$T"

echo
if [ $FAIL -eq 0 ]; then echo "🟢 점검 통과 — 빌드해도 됩니다"; else echo "🔴 점검 실패 — 위 항목을 고친 뒤 다시 실행하세요"; fi
exit $FAIL

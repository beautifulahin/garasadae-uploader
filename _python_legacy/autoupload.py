#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
가라사대 자동 업로더 — 지정 폴더를 감시하다가 새 영상이 들어오면 유튜브에 업로드한다.
표준 라이브러리만 사용한다 (pip 설치 불필요).

  python3 autoupload.py setup    최초 1회 구글 로그인
  python3 autoupload.py run      감시 시작 (launchd 가 이 모드로 실행)
  python3 autoupload.py once     지금 폴더에 있는 것만 1회 처리
  python3 autoupload.py status   상태 출력
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, date
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONF_F = HERE / "config.json"
TOKEN_F = HERE / "tokens.json"
STATE_F = HERE / "state.json"
LOG_F = HERE / "logs" / "uploader.log"

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".avi", ".webm", ".mkv", ".flv", ".wmv", ".mpg", ".mpeg"}
SKIP_SUFFIX = (".part", ".crdownload", ".download", ".tmp", ".sb-")
CHUNK = 8 * 1024 * 1024          # 8MB (256KB 배수여야 함)
UPLOAD_COST = 1600               # 영상 1건당 API 쿼터
DAILY_QUOTA = 10000

DEFAULTS = {
    "watch_dir": str(Path.home() / "Desktop" / "업로드대기"),
    "poll_seconds": 5,
    "stable_checks": 3,
    "privacy": "private",
    "category_id": "22",
    "language": "ko",
    "tags": [],
    "description": "",
    "made_for_kids": False,
    "notify_subscribers": True,
    "after_upload": "move",      # move | keep
    "max_retries": 3,
    "daily_limit": 6,
    "mac_notification": True,
    "client_id": "",
    "client_secret": "",
}


# ------------------------------------------------------------------ 유틸
def log(msg, echo=True):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    LOG_F.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_F, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    if echo:
        print(line, flush=True)


def notify(title, text):
    if not cfg().get("mac_notification", True):
        return
    try:
        t = text.replace('"', "'")[:200]
        subprocess.run(
            ["osascript", "-e", f'display notification "{t}" with title "{title}"'],
            capture_output=True, timeout=5,
        )
    except Exception:
        pass


_cfg_cache = None


def cfg(reload=False):
    global _cfg_cache
    if _cfg_cache is None or reload:
        data = dict(DEFAULTS)
        if CONF_F.exists():
            try:
                data.update(json.loads(CONF_F.read_text(encoding="utf-8")))
            except Exception as e:
                log(f"⚠️  config.json 읽기 실패, 기본값 사용: {e}")
        _cfg_cache = data
    return _cfg_cache


def save_cfg(data):
    CONF_F.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    cfg(reload=True)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path, data, private=False):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    if private:
        os.chmod(path, 0o600)


def state():
    return load_json(STATE_F, {"uploads": [], "failed": {}, "quota_date": "", "quota_used": 0})


def fmt_size(n):
    return f"{n/1073741824:.2f}GB" if n > 1073741824 else f"{n/1048576:.1f}MB"


# ------------------------------------------------------------------ HTTP
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """resumable 업로드의 308 응답이 리다이렉트로 처리되면 안 된다."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def http(url, data=None, headers=None, method="GET", timeout=120):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    return OPENER.open(req, timeout=timeout)


# ------------------------------------------------------------------ 인증
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"
REDIRECT_PORT = 8721
REDIRECT_URI = f"http://127.0.0.1:{REDIRECT_PORT}"


def oauth_setup():
    c = cfg(reload=True)
    cid, csec = c.get("client_id", "").strip(), c.get("client_secret", "").strip()

    if not cid:
        print("\n구글 클라우드 콘솔에서 발급한 '데스크톱 앱' OAuth 클라이언트 정보가 필요합니다.")
        print("(사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 유형: 데스크톱 앱)\n")
        cid = input("클라이언트 ID: ").strip()
        csec = input("클라이언트 보안 비밀번호: ").strip()
        if not cid or not csec:
            print("❌ 입력이 비어 있습니다.")
            return 1
        c["client_id"], c["client_secret"] = cid, csec
        save_cfg(c)

    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).decode().rstrip("=")
    st = secrets.token_urlsafe(16)

    params = urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": REDIRECT_URI, "response_type": "code",
        "scope": SCOPE, "access_type": "offline", "prompt": "consent",
        "state": st, "code_challenge": challenge, "code_challenge_method": "S256",
    })

    box = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            box.update({k: v[0] for k, v in q.items()})
            ok = "code" in box and box.get("state") == st
            body = (
                "<meta charset='utf-8'><body style='background:#0b0b11;color:#ededf4;"
                "font-family:-apple-system,sans-serif;text-align:center;padding:80px'>"
                + ("<h2 style='color:#2dd4a8'>✅ 연결되었습니다</h2>"
                   "<p>이 창을 닫고 터미널로 돌아가세요.</p>"
                   if ok else
                   "<h2 style='color:#ff4466'>❌ 인증 실패</h2>"
                   f"<p>{box.get('error','알 수 없는 오류')}</p>")
                + "</body>"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", REDIRECT_PORT), H)
    threading.Thread(target=srv.handle_request, daemon=True).start()

    url = f"{AUTH_URL}?{params}"
    print("\n브라우저에서 구글 로그인 창을 엽니다…")
    print("열리지 않으면 아래 주소를 직접 붙여넣으세요:\n" + url + "\n")
    webbrowser.open(url)

    for _ in range(300):
        if box:
            break
        time.sleep(1)
    srv.server_close()

    if "code" not in box:
        print("❌ 인증 코드를 받지 못했습니다: " + box.get("error", "시간 초과"))
        return 1

    data = urllib.parse.urlencode({
        "client_id": cid, "client_secret": csec, "code": box["code"],
        "code_verifier": verifier, "grant_type": "authorization_code",
        "redirect_uri": REDIRECT_URI,
    }).encode()
    try:
        with http(TOKEN_URL, data=data,
                  headers={"Content-Type": "application/x-www-form-urlencoded"},
                  method="POST") as r:
            tok = json.loads(r.read())
    except urllib.error.HTTPError as e:
        print("❌ 토큰 교환 실패: " + e.read().decode(errors="replace")[:400])
        return 1

    if "refresh_token" not in tok:
        print("❌ refresh_token 이 없습니다. 구글 계정 > 보안 > 서드파티 액세스에서 기존 권한을 지우고 다시 시도하세요.")
        return 1

    tok["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    save_json(TOKEN_F, tok, private=True)
    log("✅ 인증 완료, 토큰 저장됨")

    try:
        ch = api_get("channels", {"part": "snippet,statistics", "mine": "true"})
        item = (ch.get("items") or [{}])[0]
        name = item.get("snippet", {}).get("title", "?")
        subs = item.get("statistics", {}).get("subscriberCount", "?")
        print(f"\n🎉 연결된 채널: {name} (구독자 {int(subs):,})" if subs.isdigit()
              else f"\n🎉 연결된 채널: {name}")
    except Exception as e:
        print(f"(채널 정보 조회 실패: {e})")
    return 0


def access_token():
    tok = load_json(TOKEN_F, None)
    if not tok:
        raise RuntimeError("인증 정보가 없습니다. 먼저 setup 을 실행하세요.")
    if tok.get("expires_at", 0) > time.time() and tok.get("access_token"):
        return tok["access_token"]

    c = cfg()
    data = urllib.parse.urlencode({
        "client_id": c["client_id"], "client_secret": c["client_secret"],
        "refresh_token": tok["refresh_token"], "grant_type": "refresh_token",
    }).encode()
    with http(TOKEN_URL, data=data,
              headers={"Content-Type": "application/x-www-form-urlencoded"},
              method="POST") as r:
        new = json.loads(r.read())
    tok["access_token"] = new["access_token"]
    tok["expires_at"] = time.time() + new.get("expires_in", 3600) - 60
    save_json(TOKEN_F, tok, private=True)
    return tok["access_token"]


def api_get(path, params):
    url = f"https://www.googleapis.com/youtube/v3/{path}?{urllib.parse.urlencode(params)}"
    with http(url, headers={"Authorization": "Bearer " + access_token()}) as r:
        return json.loads(r.read())


# ------------------------------------------------------------------ 업로드
def build_meta(path):
    c = cfg()
    snippet = {
        "title": path.stem[:100] or "제목 없음",
        "description": c.get("description", "")[:5000],
        "tags": [t for t in c.get("tags", []) if t][:30],
        "categoryId": str(c.get("category_id", "22")),
    }
    if c.get("language"):
        snippet["defaultLanguage"] = c["language"]
        snippet["defaultAudioLanguage"] = c["language"]
    status = {
        "privacyStatus": c.get("privacy", "private"),
        "selfDeclaredMadeForKids": bool(c.get("made_for_kids", False)),
    }
    return {"snippet": snippet, "status": status}


def upload(path: Path):
    c = cfg()
    size = path.stat().st_size
    token = access_token()

    params = {"uploadType": "resumable", "part": "snippet,status"}
    if not c.get("notify_subscribers", True):
        params["notifySubscribers"] = "false"

    body = json.dumps(build_meta(path), ensure_ascii=False).encode("utf-8")
    with http(
        "https://www.googleapis.com/upload/youtube/v3/videos?" + urllib.parse.urlencode(params),
        data=body, method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": str(size),
            "X-Upload-Content-Type": "video/*",
        },
    ) as r:
        session = r.headers.get("Location")
    if not session:
        raise RuntimeError("업로드 세션 URL을 받지 못했습니다")

    log(f"   세션 생성 · {fmt_size(size)} 전송 시작")
    offset, fails, last_pct = 0, 0, -10
    with open(path, "rb") as f:
        while offset < size:
            f.seek(offset)
            chunk = f.read(CHUNK)
            end = offset + len(chunk) - 1
            try:
                with http(session, data=chunk, method="PUT", timeout=600,
                          headers={
                              "Content-Length": str(len(chunk)),
                              "Content-Range": f"bytes {offset}-{end}/{size}",
                          }) as r:
                    return json.loads(r.read())          # 200/201 = 완료
            except urllib.error.HTTPError as e:
                if e.code == 308:                        # 계속 이어서
                    rng = e.headers.get("Range")
                    offset = int(rng.split("-")[1]) + 1 if rng else end + 1
                    fails = 0
                    pct = int(offset / size * 100)
                    if pct - last_pct >= 10:
                        log(f"   … {pct}% ({fmt_size(offset)}/{fmt_size(size)})")
                        last_pct = pct
                elif e.code in (500, 502, 503, 504):     # 일시 오류 → 재개
                    fails += 1
                    if fails > 5:
                        raise RuntimeError(f"서버 오류 반복 ({e.code})")
                    wait = 2 ** fails
                    log(f"   ⚠️  {e.code} 오류, {wait}초 후 재시도")
                    time.sleep(wait)
                    offset = resume_offset(session, size, offset)
                else:
                    raise RuntimeError(f"{e.code} {e.read().decode(errors='replace')[:300]}")
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                fails += 1
                if fails > 5:
                    raise RuntimeError(f"네트워크 오류 반복: {e}")
                wait = 2 ** fails
                log(f"   ⚠️  네트워크 오류, {wait}초 후 재시도 ({e})")
                time.sleep(wait)
                offset = resume_offset(session, size, offset)
    raise RuntimeError("업로드가 끝났는데 응답이 없습니다")


def resume_offset(session, size, fallback):
    """중단 지점을 서버에 물어본다."""
    try:
        with http(session, data=b"", method="PUT",
                  headers={"Content-Length": "0", "Content-Range": f"bytes */{size}"}) as r:
            return size
    except urllib.error.HTTPError as e:
        if e.code == 308:
            rng = e.headers.get("Range")
            return int(rng.split("-")[1]) + 1 if rng else 0
    except Exception:
        pass
    return fallback


# ------------------------------------------------------------------ 감시
def is_candidate(p: Path):
    if not p.is_file() or p.name.startswith(".") or p.name.startswith("~"):
        return False
    if p.suffix.lower() not in VIDEO_EXT:
        return False
    if any(p.name.lower().endswith(s) for s in SKIP_SUFFIX):
        return False
    return True


def quota_left(st):
    today = date.today().isoformat()
    if st.get("quota_date") != today:
        st["quota_date"], st["quota_used"] = today, 0
    return DAILY_QUOTA - st["quota_used"]


def process(path: Path, st):
    c = cfg()
    key = path.name
    limit = c.get("daily_limit", 6)
    today = date.today().isoformat()
    done_today = sum(1 for u in st["uploads"] if u["at"][:10] == today)
    if done_today >= limit:
        return "quota"
    if quota_left(st) < UPLOAD_COST:
        return "quota"

    log(f"📤 업로드 시작: {key} ({fmt_size(path.stat().st_size)})")
    try:
        res = upload(path)
    except Exception as e:
        n = st["failed"].get(key, 0) + 1
        st["failed"][key] = n
        log(f"❌ 실패({n}/{c.get('max_retries',3)}) {key} → {e}")
        if n >= c.get("max_retries", 3):
            fail_dir = path.parent / "_실패"
            fail_dir.mkdir(exist_ok=True)
            try:
                shutil.move(str(path), str(fail_dir / path.name))
                log(f"   {key} → _실패 폴더로 이동")
            except Exception as me:
                log(f"   이동 실패: {me}")
            notify("가라사대 업로더 ❌", f"{key} 업로드 실패")
        save_json(STATE_F, st)
        return "fail"

    vid = res.get("id", "")
    st["quota_used"] = st.get("quota_used", 0) + UPLOAD_COST
    st["failed"].pop(key, None)
    st["uploads"].insert(0, {
        "id": vid, "title": res.get("snippet", {}).get("title", path.stem),
        "file": key, "size": path.stat().st_size,
        "privacy": res.get("status", {}).get("privacyStatus", c.get("privacy")),
        "at": datetime.now().isoformat(timespec="seconds"),
    })
    st["uploads"] = st["uploads"][:300]
    save_json(STATE_F, st)
    log(f"✅ 완료: {key} → https://www.youtube.com/watch?v={vid}")
    notify("가라사대 업로더 ✅", f"{path.stem} 업로드 완료")

    if c.get("after_upload") == "move":
        done_dir = path.parent / "_완료"
        done_dir.mkdir(exist_ok=True)
        dest = done_dir / path.name
        i = 1
        while dest.exists():
            dest = done_dir / f"{path.stem} ({i}){path.suffix}"
            i += 1
        try:
            shutil.move(str(path), str(dest))
        except Exception as e:
            log(f"   ⚠️  파일 이동 실패: {e}")
    return "ok"


def scan(watch: Path, seen: dict, st):
    """크기가 안정된 파일만 업로드 대상으로 넘긴다."""
    c = cfg()
    need = c.get("stable_checks", 3)
    for p in sorted(watch.iterdir()):
        if not is_candidate(p):
            continue
        try:
            sz = p.stat().st_size
        except OSError:
            continue
        e = seen.get(p.name)
        if e and e["size"] == sz and sz > 0:
            e["count"] += 1
        else:
            e = seen[p.name] = {"size": sz, "count": 0, "said": False}
        if e["count"] >= need:
            if not e["said"]:
                log(f"🎬 새 영상 감지: {p.name}")
                e["said"] = True
            r = process(p, st)
            if r == "quota":
                e["count"] = need          # 다음 기회에 바로 재시도
                return "quota"
            seen.pop(p.name, None)
    for name in [k for k in seen if not (watch / k).exists()]:
        seen.pop(name, None)
    return "ok"


def run(once=False):
    c = cfg(reload=True)
    watch = Path(c["watch_dir"]).expanduser()
    watch.mkdir(parents=True, exist_ok=True)
    log(f"👀 감시 시작: {watch}  (공개범위: {c['privacy']}, {c['poll_seconds']}초 간격)")
    if not TOKEN_F.exists():
        log("❌ 인증 정보 없음 — setup.command 를 먼저 실행하세요")
        return 1

    seen, warned = {}, False
    while True:
        st = state()
        try:
            r = scan(watch, seen, st)
            if r == "quota" and not warned:
                log("⏸  오늘 업로드 한도에 도달했습니다. 내일 자동 재개합니다.")
                notify("가라사대 업로더 ⏸", "오늘 업로드 한도 도달")
                warned = True
            elif r == "ok":
                warned = False
        except Exception as e:
            log(f"⚠️  감시 중 오류: {e}")
        save_json(STATE_F, st)
        if once:
            return 0
        time.sleep(max(2, c.get("poll_seconds", 5)))


def status():
    c = cfg(reload=True)
    st = state()
    watch = Path(c["watch_dir"]).expanduser()
    today = date.today().isoformat()
    waiting = [p.name for p in watch.iterdir() if is_candidate(p)] if watch.exists() else []
    done_today = [u for u in st["uploads"] if u["at"][:10] == today]
    print(f"""
┌─ 가라사대 자동 업로더 ─────────────────────────
│ 감시 폴더 : {watch}
│ 인증      : {'✅ 완료' if TOKEN_F.exists() else '❌ 없음 (setup 필요)'}
│ 데몬      : {'🟢 실행 중' if daemon_running() else '⚪️ 정지'}
│ 공개 범위 : {c['privacy']}
│ 대기 파일 : {len(waiting)}개 {waiting[:5]}
│ 오늘 완료 : {len(done_today)}개 / 한도 {c.get('daily_limit',6)}개
│ 쿼터 사용 : {st.get('quota_used',0):,} / {DAILY_QUOTA:,}
│ 누적 완료 : {len(st['uploads'])}개
└────────────────────────────────────────────""")
    for u in st["uploads"][:10]:
        print(f"  {u['at'][:16]}  {u['title'][:34]:36} https://youtu.be/{u['id']}")
    if st["failed"]:
        print("\n  실패 대기:", st["failed"])
    print(f"\n  로그: tail -f '{LOG_F}'")


def daemon_running():
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=5).stdout
        return "com.garasadae.uploader" in out
    except Exception:
        return False


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if not CONF_F.exists():
        save_cfg(dict(DEFAULTS))
    try:
        if cmd == "setup":
            sys.exit(oauth_setup())
        elif cmd == "run":
            sys.exit(run(once=False) or 0)
        elif cmd == "once":
            sys.exit(run(once=True) or 0)
        else:
            status()
    except KeyboardInterrupt:
        print("\n중단됨")

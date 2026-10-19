# 인스타그램·스레드 로그인 중계 (Cloudflare Worker)

가라사대 업로더가 인스타그램 릴스·스레드에 자동으로 올릴 때 쓰는 작은 중계 서버다.
사용자는 앱에서 「인스타그램 연결」·「스레드 연결」을 누르고 로그인만 하면 된다. 아래 일은 **앱 소유자가 한 번만** 하면 된다.

## 왜 필요한가

- 메타 앱의 「앱 비밀」은 누구나 받아 가는 실행 파일 안에 넣을 수 없다. 로그인 코드를 토큰으로 바꾸는 한 단계(앱 비밀이 필요한 유일한 단계)만 이 중계가 한다.
- 인스타그램 로그인 방식은 영상을 직접 올리는 길(이어올리기)이 없고 **메타가 가져갈 수 있는 공개 영상 주소**가 있어야 한다. 그래서 이 중계가 영상을 1시간 이하로만 임시 보관(R2)하고 서명된 읽기 주소를 준다.
- 토큰을 쓰는 모든 호출(올리기·갱신)은 앱이 메타로 직접 한다. 중계는 토큰을 5분 넘게 갖지 않는다.

## 길

| 길 | 하는 일 |
|---|---|
| `GET /ig/start` · `/th/start` | 앱이 연 브라우저가 처음 닿는 곳. 서명한 state 를 만들어 메타 로그인 창으로 보낸다 |
| `GET /ig/callback` · `/th/callback` | 메타가 로그인 뒤 돌려보내는 곳. 코드를 장기 토큰으로 바꿔 KV 에 5분만 두고, 브라우저는 `http://127.0.0.1:<포트>/meta/done` 으로 돌려보낸다 (**주소에 토큰을 싣지 않는다**) |
| `POST /pickup` | 앱이 verifier 를 보여 주고 토큰을 한 번만 받아 간다 (받으면 바로 지운다) |
| `POST /stage/ticket` · `/stage/delete` | 영상 임시 보관: 일회용 업로드 주소를 주고, 올린 뒤 지운다 (사용자 한 명 하루 40번) |
| `GET /s/<번호>.mp4` | 메타 서버가 영상을 가져가는 서명된 읽기 주소 (1시간) |
| `POST /ig/deauthorize` · `/th/deauthorize` | 메타 「연결 해제 콜백」 |
| `POST /ig/delete` · `/th/delete` | 메타 「데이터 삭제 요청 콜백」 (응답으로 `/deletion?code=` 상태 쪽 주소를 돌려준다) |

## 소유자가 할 일 (순서대로)

### 1. 메타 개발자 앱 만들기

1. https://developers.facebook.com 에서 앱을 만든다 (유형: 비즈니스 또는 「기타」).
2. 인스타그램 쪽: 앱에 **Instagram** 제품(「인스타그램 로그인을 통한 API」)을 추가한다. 권한은 `instagram_business_basic` · `instagram_business_content_publish`.
3. 스레드 쪽: 앱에 **Threads API** 사용 사례를 추가한다. 권한은 `threads_basic` · `threads_content_publish`.
   - 인스타그램과 스레드는 앱 번호·앱 비밀이 각각 따로 나온다 (제품 설정 화면에 보인다). 메모해 둔다: `IG_APP_ID` · `IG_APP_SECRET` · `TH_APP_ID` · `TH_APP_SECRET`.
4. 각 제품 설정에 주소를 등록한다 (`<중계 주소>` = 아래 4번에서 정해지는 `PUBLIC_URL`):
   - 유효한 OAuth 리디렉션 URI: `<중계 주소>/ig/callback` (인스타그램) · `<중계 주소>/th/callback` (스레드)
   - 연결 해제 콜백 URL: `<중계 주소>/ig/deauthorize` · `<중계 주소>/th/deauthorize`
   - 데이터 삭제 요청 URL: `<중계 주소>/ig/delete` · `<중계 주소>/th/delete`
5. 앱 설정 → 기본: 개인정보처리방침 URL 에 이 저장소의 `docs/privacy.html` 이 게시된 주소를, 이용약관에는 `docs/terms.html` 주소를 넣는다. 앱 아이콘·카테고리도 채운다.

### 2. 클라우드플레어 준비

```
cd worker/meta-auth
wrangler kv namespace create META_KV          # 나온 id 를 wrangler.toml 의 kv_namespaces 에 적는다
wrangler r2 bucket create garasadae-meta-stage # 공개 접근을 켜지 않는다 (비공개 그대로)
```

R2 대시보드 → 「R2 API 토큰 관리」에서 이 버킷에만 「객체 읽기 및 쓰기」 권한을 가진 토큰을 만든다. 나오는 액세스 키 ID·비밀 액세스 키를 아래 3번에서 넣는다. 계정 번호(`R2_ACCOUNT_ID`)는 대시보드 주소 또는 오른쪽 위에 보인다.

### 3. 비밀 넣기 (저장소·파일에는 절대 적지 않는다)

```
wrangler secret put IG_APP_SECRET
wrangler secret put TH_APP_SECRET
wrangler secret put SIGN_KEY                 # 아무 긴 글, 예: openssl rand -base64 48
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

### 4. wrangler.toml 의 자리표시자 채우고 배포

`IG_APP_ID` · `TH_APP_ID` · `R2_ACCOUNT_ID` · `META_KV` 의 id · `PUBLIC_URL`(배포되는 주소, 끝에 `/` 없이)을 채운 뒤:

```
wrangler deploy
```

배포 뒤 `<중계 주소>/` 를 브라우저로 열어 「가라사대 업로더 로그인 중계」 쪽이 보이면 된다. 이 주소를 위 1-4 의 메타 앱 설정에 등록한다.

### 5. 앱에 연결 정보 묻어 두기

업로더 빌드 때 열쇠 폴더(`배포/.클라이언트경로` 가 가리키는 폴더, 구글 열쇠 `client_secret.json` 이 있는 곳)에 `meta.json` 한 파일을 둔다. **앱 비밀은 넣지 않는다.**

```
{ "worker_url": "https://garasadae-meta-auth.내계정.workers.dev", "ig_app_id": "…", "th_app_id": "…" }
```

`build.sh` 가 이 파일을 실행 파일 옆에 묻는다. 파일이 없으면 앱의 「인스타·스레드 연결」 칸이 화면에서 숨는다 (유튜브 기능에는 영향이 없다). `점검.sh` 가 이 값들이 저장소·문서에 새지 않았는지 확인한다.

### 6. 시험 사용자 초대 (앱 심사 전)

메타 앱이 「개발 모드」인 동안은 앱의 **역할에 넣은 계정(관리자·개발자·테스터)**만 로그인·게시할 수 있다.

- 인스타그램: 앱 대시보드 → 앱 역할 → 역할 → 「Instagram 테스터」 추가. 초대받은 사람이 인스타그램 앱 설정(웹 → 앱 및 웹사이트 → 테스터 초대)에서 수락한다.
- 스레드: 같은 방식으로 「Threads 테스터」 추가 후 스레드 계정 설정에서 수락한다.
- 계정은 **비즈니스 또는 크리에이터** 계정이어야 한다 (개인 계정은 게시 API 가 막힌다).

### 7. 앱 심사 (일반 사용자에게 열려면)

심사를 통과하기 전에는 위 6번의 시험 사용자만 쓸 수 있다. 심사에서 보통 요구하는 것:

- 「고급 액세스」를 요청하는 권한마다 사용 설명 + **화면 녹화 영상** (로그인 → 올릴 영상 지정 → 게시되는 과정). 영어 자막 또는 설명이 있으면 좋다.
- 개인정보처리방침 URL (`docs/privacy.html` — 메타 데이터를 어떻게 다루는지 적혀 있다) · 데이터 삭제 요청 URL · 연결 해제 콜백 URL.
- 앱 아이콘(1024×1024) · 카테고리 · 연락처 이메일.
- 사업자 인증(비즈니스 인증)이 요구될 수 있다. 개인 개발자는 시간이 더 걸린다.
- 심사용 시험 계정 안내 (심사자가 따라 해 볼 수 있는 순서).

## 확인되지 않은 것 (실제 메타·클라우드플레어로는 시험하지 않았다)

- 콜백 요청 형식: 연결 해제·삭제 콜백은 `signed_request`(앱 비밀로 HMAC-SHA256 확인)로 가정했다. 심사 화면의 「콜백 시험」 단추로 한 번 확인한다.
- KV 는 최종 일관성이라, 아주 드물게 같은 토큰이 두 번 가져가질 가능성이 이론상 있다 (verifier 를 아는 쪽만 가져갈 수 있어 보안에는 영향 없음).
- R2 객체 수명은 크론(10분)으로 지운다. R2 수명 규칙의 최소 단위가 1일이라 규칙 대신 크론을 쓴다.
- 스레드가 방금 올린 인스타그램 영상 주소(`media_url`)를 영상으로 받아 주는지는 실제로 해 봐야 안다. 안 받으면 앱이 자동으로 임시 보관 길로 한 번 다시 시도한다.

## 시험

메타·클라우드플레어를 부르지 않는 가짜 KV·R2·메타 서버로 한다. 저장소 루트(`youtube-uploader`)에서:

```
TZ=Asia/Seoul deno run --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys --no-lock 논리시험.ts 메타중계
```

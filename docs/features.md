# j-mail 기능 목록

j-mail이 제공해야 하는 기능 목록이다. 근거는 [`decisions.md`](decisions.md)의 결정 번호와 제품군 공통 결정(`j-groupware/docs/architecture.md`의 S 번호)이고, 담당 Item은 PMT 통합 project 분류 `j-mail`이다. 모두 구현 전이다.

화면은 j-groupware "메일" 메뉴(GW-31)가 그린다.

작성일: 2026-10-07

## 1. 메일 수신과 발신 차단

| ID | 기능 | 핵심 동작 | 사용 주체 | 근거 | Item |
| --- | --- | --- | --- | --- | --- |
| ML-01 | SMTP 수신·보관 | Mailpit(버전 고정, loopback SMTP)이 고객 서버 내부 메일 수신·보관 | 고객 서버의 서비스·스크립트 | 결정 1·4 | E1 |
| ML-02 | 허용 수신자 | 허용 tenant의 `<username>@<tenant>.jgw.test`만 받고 나머지는 SMTP 거부 | Mailpit | 결정 2·3 | E2 |
| ML-03 | 외부 발신 차단 | relay 미설정, 방화벽 25/465/587 egress 차단 | 고객 서버 | 결정 2 | E2·E7 |

## 2. 받은편지함 API (내부, j-groupware 중계)

호출: j-groupware 서버, 사용자 Bearer(aud `j-mail`, `mail:read`).

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| ML-10 | 메일 목록 | 수신자·발신자·제목·시각, 페이지 | 결정 5 | E3 |
| ML-11 | 메일 상세 | 헤더, 텍스트·HTML 본문 | 결정 5 | E3 |
| ML-12 | tenant 격리 | 수신자가 `@<tenant>.jgw.test`인 메일만, 다른 tenant 메일 id는 404 | 결정 5 | E3 |
| ML-13 | 인증·권한 | Bearer 검증, `mail:read` 검사, 401·403·404·503 구분 | 결정 5·6 | E3 |

## 3. 알림

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| ML-20 | 새 메일 알림 | Mailpit webhook 수신 → 수신자 username별 `mail.new`를 outbox에 기록 → j-groupware 알림 센터로 재시도 송신(`dedupKey` = 메일 id) | 결정 10, S17 | E8 |

## 4. 기반·운영

| ID | 기능 | 핵심 동작 | 근거 | Item |
| --- | --- | --- | --- | --- |
| ML-30 | 저장소 골격·DB | `jgw_mail`·전용 계정·마이그레이션(알림 outbox), Mailpit Compose | 결정 8·9, S2 | E1 |
| ML-31 | contracts | 목록·상세 DTO, 오류 코드, 게시 | 결정 9, S10 | E3 |
| ML-32 | 고객 서버 검증 | 설치·해지(Mailpit 중지·볼륨 백업), egress 차단, j-groupware 메일 화면 확인 | S13·S14 | E7 |

## 5. 범위 밖·backlog

사용자별 받은편지함 필터, j-messenger mail 모드 연결(실제 MTA), SMTP AUTH·STARTTLS, 메일 보존 정책.

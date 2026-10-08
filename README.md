# j-mail

테스트 전용 내부 SMTP·같은 tenant의 공유 받은편지함이다. 현재 E1/E2 기반을 구현했으며 E3 HTTP API는 다음 묶음이다. 외부 이메일 발송·운영 설치를 수행하지 않는다.

Node 22.18 이상, PostgreSQL 18.6, 정확한 digest의 Mailpit 1.31.4를 사용한다. `apps/server`·`packages/contracts` 골격과 전용 DB checksum migration이 있다. contracts는 아직 private 골격이며 게시하지 않았다. 설치는 `.npmrc.example`을 ignored `.npmrc`로 복사하고 승인된 loopback 레지스트리에서 `npm ci` 한다.

```sh
npm run check
node scripts/prepare-cloud-tests.mjs
docker compose --env-file ../.suite-runtime/j-mail/compose.env -f ../.suite-runtime/j-mail/compose.yaml -p j-mail-cloud-test up -d
npm run test:integration
```

prepare는 새 격리 fixture에만 사용한다. 기존 env·DB·키를 덮어쓰지 않는다. TLS·env·시험 결과는 체크아웃 밖 private 폴더에 둔다. fixture 암호와 인증서는 운영 자격이 아니다. 생산 설정 예시와 Compose는 아직 적용하지 않은 입력이며 고객 VM 설치기가 아니다.

Mailpit 생산 profile은 고객 VM당 한 tenant, SMTP/API/UI loopback, 릴레이 없음, volume 원본 저장, 명시적인 SMTP 수신자 허용 regex다. 테스트는 외부로 연결할 수 없는 `--network none` 컨테이너의 private Unix socket만 loopback으로 연결하여 실제 SMTP를 보낸다. 방화벽 egress와 VM/systemd 인수는 아직 실행하지 않았다.

[기능 명세](docs/feature-specifications.md), [기반 검증](docs/cloud-foundation-verification-2026-10-08.md)을 따른다.

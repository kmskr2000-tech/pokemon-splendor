# 지갑 · 참가비 · 관전 베팅 · 운영 수수료 설정 가이드

이 문서는 멀티플레이에 추가된 유료 기능(선충전 지갑, 참가비, 관전자 베팅, 운영 수수료)을
실제로 켜기 위해 운영자가 해야 하는 일을 정리한 것입니다.

> **법적 주의**: 현금을 걸고 승패에 따라 돈이 오가는 구조는 한국 법상 도박(형법 246조 등)에
> 해당할 수 있습니다. 실제 서비스 전에 반드시 법률 검토를 받으세요. 이 코드는 기능 구현일 뿐이며
> 운영 책임은 운영자에게 있습니다.

## 1. 전체 구조

```
브라우저 (GitHub Pages 정적 사이트)
  ├─ 게임/멀티 (기존) ─────────── Firebase RTDB  pkmspl-rooms/      (누구나 읽기/쓰기)
  ├─ 관전 (watch-only 피어) ────── 같은 방 노드, guests/{id}.spectator = true
  ├─ 지갑 읽기 ──────────────── RTDB  pkmspl-wallet/   (본인 것만 읽기, 쓰기 불가)
  ├─ 충전 요청 쓰기 ─────────── RTDB  pkmspl-wallet/deposits/{id}  (본인 uid, pending만)
  └─ 돈이 움직이는 모든 요청 ── Cloud Functions (callable, asia-southeast1)
                                   payEntry · placeBet · startRoom · reportResult · cancelRoom
                                   requestWithdraw · decideDeposit · decideWithdraw · resolveRoom · setConfig
```

- 잔액은 **브라우저가 직접 바꿀 수 없습니다.** 모든 입출금은 Cloud Function이 RTDB 트랜잭션으로 처리하고
  원장(`ledger`)에 한 줄씩 남깁니다.
- 충전은 **계좌이체 → 앱에서 충전 요청 → 운영자가 운영 탭에서 승인** 흐름입니다. 결제 PG 없음.
- 출금은 요청 즉시 잔액에서 차감(보류)되고, 운영자가 실제 이체 후 "이체 완료"를 누르면 끝납니다.
  거절하면 잔액으로 환불됩니다.

## 2. Firebase 콘솔에서 할 일

1. **Authentication → Sign-in method → Google 사용 설정.**
   승인된 도메인에 GitHub Pages 도메인(`xxx.github.io`)을 추가합니다.
2. **Realtime Database → 규칙**: `firebase/database.rules.json` 내용으로 교체 (또는 아래 CLI 배포).
3. **요금제를 Blaze(종량제)로 변경.** Cloud Functions는 Blaze에서만 배포됩니다.
   (무료 할당량이 커서 이 규모에서는 거의 0원입니다.)
4. 운영자 지정: 본인 계정으로 앱에서 한 번 로그인한 뒤, Authentication 사용자 목록에서 **UID**를 복사하고
   RTDB에 아래 노드를 직접 만듭니다. 이 노드는 어떤 클라이언트/함수도 쓸 수 없습니다 (콘솔에서만).
   ```
   pkmspl-wallet/config/admins/<내UID>: true
   ```
5. (선택) 같은 `config` 아래 기본값:
   ```
   bank:        "국민 123456-78-901234 홍길동"   ← 앱 운영 탭에서도 수정 가능
   feeRate:     0.1          (10%)              ← 운영 탭에서 수정 가능
   betGraceMs:  90000        (게임 시작 후 베팅 마감까지 90초)
   minDeposit:  1000
   maxBet:      100000
   entryFees:   [1000, 3000, 5000, 10000]       (방 만들 때 선택지)
   enabled:     true
   ```

## 3. Cloud Functions 배포

```bash
npm i -g firebase-tools
firebase login
cp .firebaserc.example .firebaserc        # 프로젝트 id 확인
cd functions && npm install && cd ..
firebase deploy --only functions,database
```

리전은 `asia-southeast1`(RTDB와 동일)로 고정되어 있습니다. 클라이언트도 같은 리전을 호출합니다
(`src/wallet/wallet.js`의 `FUNCTIONS_REGION`).

배포 전까지 앱은 그대로 동작합니다. 지갑/참가비/베팅 버튼을 누르면
"지갑 서버(Cloud Functions)가 아직 배포되지 않았어요" 안내가 뜹니다. 무료 방·관전은 함수 없이도 됩니다.

## 4. 돈의 흐름

| 상황 | 처리 |
| --- | --- |
| 참가비 방 만들기 | 방장 로그인 필수. `createEscrow`가 `pkmspl-escrow/{방코드}` 생성 |
| 참가비 내기 | `payEntry`: 잔액 차감 → `players/{uid}` 기록. 전원 납부 전엔 시작 버튼 비활성 |
| 게임 시작 | `startRoom`: 납부 재검증, 로비 나간 사람·사라진 대상 베팅 환불, 베팅 마감시각 설정 |
| 관전자 베팅 | `placeBet`: 잔액 차감, 풀에 적립. 참가자는 베팅 불가. 마감 = 시작 + `betGraceMs` |
| 게임 종료 | 참가자 클라이언트들이 각자 `reportResult`로 순위를 보고. 방장 + 과반이 **일치**하면 자동 정산 |
| 결과 불일치 | `status: disputed`. 운영 탭에서 "방장 결과로 정산" 또는 "전액 환불" |
| 방장이 시작 전 나감 | `cancelRoom`: 참가비·베팅 전액 환불 |
| 게임 중 방이 사라짐 | 정산 안 됨 → 운영 탭 "미정산 방"에서 수동 처리 |

정산 규칙 (`src/wallet/settle.js` = `functions/settle.js`):
- 우승자 = 사람 참가자 중 최종 순위가 가장 높은 사람(들). AI는 상금 대상이 아님.
- 상금 = 참가비 합계 − 수수료(feeRate). 공동 우승은 균등 분배, 나머지 원 단위는 수수료로.
- 베팅은 패리뮤추얼: 전체 풀 − 수수료를 우승자에게 건 사람들이 **베팅 금액 비율**로 나눔.
  우승자에게 아무도 안 걸었으면 전액 환불(수수료 없음).
- 수수료는 `pkmspl-wallet/fees/`에 건별, `feeTotal`에 누적. 운영 탭 상단에 표시.
  실제 현금은 이미 충전 때 운영자 계좌에 들어와 있으므로, 수수료는 "유저에게 돌려줄 의무가 없는 몫"입니다.

## 5. 신뢰 경계 (알고 있어야 할 한계)

- 게임 결과는 서버가 다시 계산하지 않습니다. 참가자 클라이언트들의 **보고가 일치할 때**만 자동 정산되고,
  어긋나면 운영자가 판단합니다. 담합(전원이 같은 거짓 결과 보고)은 막지 못합니다.
- `pkmspl-rooms`는 기존대로 누구나 쓸 수 있습니다(게임 진행 자체는 로그인 불필요). 돈과 관련된 상태는
  전부 `pkmspl-escrow`/`pkmspl-wallet`에 있고 이쪽은 함수만 씁니다.
- 관전자는 방장 브로드캐스트를 그대로 받아 보는 것이므로, 방장 승계 시 새 방장이 관전자 목록을 이어받습니다.

## 6. 로컬 확인

```bash
node --test "tests/*.test.mjs"   # 정산 수학 테스트
firebase emulators:start --only functions,database   # 함수 로컬 실행 (선택)
```

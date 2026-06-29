# gjc Telegram 연동 — 메모리/싱글톤 검증 절차

이 문서는 CLI Launcher의 gjc 텔레그램 연동이 **메모리를 과도하게 점유하지 않고**,
**여러 프로젝트/창에서도 백그라운드 데몬이 1개만 도는지**를 검증하는 절차다.

## 왜 검증이 단순한가 (설계 근거)

런처는 **얇은 래퍼**다. 자체 텔레그램 프로세스를 띄우지 않고, gjc의 네이티브
데몬을 설정(`gjc notify setup`)·감지만 한다. 따라서 메모리/싱글톤은 구조적으로 gjc가 보장한다:

- **싱글톤**: gjc는 봇 토큰당 long-poll owner를 1개만 둔다(`acquireDaemonOwnership` /
  `isFreshLiveOwner`). 세션은 `.gjc/state/notifications/<sessionId>.json` 엔드포인트로
  단일 데몬에 attach한다 → 창/프로젝트 수와 무관하게 데몬 프로세스는 1개.
- **메모리**: 세션마다 프로세스가 늘지 않는다(엔드포인트 파일 + 공유 rate-limit pool).
  데몬은 1개의 bun 프로세스다.
- **정리**: 마지막 세션이 끊기면 `notifications.daemon.idleTimeoutMs`(기본 60000ms=60초,
  사용자 설정 가능) 후 데몬이 스스로 종료한다. 런처는 능동 `daemon stop`을 호출하지
  않으므로(외부 세션 보호) 누수/좀비 위험이 없다.

## 합격 기준

| 항목 | 합격선 |
|---|---|
| 데몬 개수 | 세션 1/2/4 × 창 1/2 어느 조합에서도 telegram 데몬이 **정확히 1개** |
| RSS 비례성 | RSS가 세션·창 수에 **비례 증가하지 않음**(셀 간 상한 변동 < 20%) |
| 유휴 CPU | 30초 유휴 시 평균 CPU **< 1%** |
| 정리 | 모든 세션 종료 후 **~60초 내** 데몬 자동 종료(idleTimeout) |
| 외부 세션 보호 | 런처 마지막 창을 닫아도 런처 밖(터미널) gjc 세션이 쓰던 데몬은 **생존** |

## 측정 절차

1. **데몬 PID 확인**

   ```sh
   gjc daemon status --all --json
   # → [{"kind":"telegram","configured":true,"runtime":{... pid? ...}}]
   ```

   `runtime`에 pid가 있으면 그것을 쓰고, 없으면 명령행 매칭으로 telegram 데몬
   프로세스를 찾는다.

2. **RSS / CPU 조회**

   - Windows:
     ```powershell
     Get-Process -Id <pid> | Select-Object Id, @{n='RSS_MB';e={[math]::Round($_.WorkingSet64/1MB,1)}}, CPU
     # 또는: tasklist /FI "PID eq <pid>" /FO CSV
     ```
   - macOS / Linux:
     ```sh
     ps -o pid,rss,%cpu -p <pid>   # rss는 KB
     ```

3. **매트릭스 실행**: 아래 각 셀에서 (a) 데몬 개수 (b) RSS (c) 30초 유휴 평균 CPU를 기록.

   | | 창 1개 | 창 2개 |
   |---|---|---|
   | 세션 1개 | | |
   | 세션 2개 | | |
   | 세션 4개 | | |

4. **정리 확인**: 모든 gjc 세션/창을 닫고 60초 대기 후 `gjc daemon status --all --json`의
   telegram이 미실행(또는 not running)으로 바뀌는지 확인.

5. **외부 세션 보호**: 터미널에서 `gjc`(텔레그램 ON) 세션을 띄운 채 런처의 마지막 창을
   닫고, 터미널 세션의 데몬이 계속 사는지 확인(런처는 stop을 호출하지 않으므로 자명 통과).

## 현재 검증 상태 / 한계

- **코드 경로 단위 검증 완료**: 버전 게이트, 토큰/chatId 형식, `notify setup` 인자
  구성(셸 보간 없음), `daemon status` telegram 감지는 `test/unit/telegramSettings.test.ts`로
  검증됨. 런처는 능동 `daemon stop`/참조계수를 두지 않음(코드상 확인).
- **실측 미수행(환경 제약)**: 위 RSS/CPU 매트릭스는 **실제 봇 토큰으로 데몬을 기동해야**
  측정 가능하다. BotFather 토큰 + chatId를 발급해 `gjc notify setup`으로 구성한 뒤 이
  절차를 1회 수행해 표를 채우면 된다. 데몬 수명주기·싱글톤은 gjc 소유라 측정값은 gjc의
  내장 보장을 확인하는 성격이다.

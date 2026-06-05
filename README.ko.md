<p align="center">
  <img src="icons/icon-128.png" alt="CLI Launcher for Claude, Codex, Kiro & Antigravity" width="96" height="96"/>
</p>

<h1 align="center">CLI Launcher for Claude, Codex, Kiro & Antigravity</h1>

<p align="center">
  <strong>Claude Code를 VSCode 안에서 띄우고, 대화도 markdown으로 같이 보고,
  워크스페이스 자동 sync까지 하는 익스텐션.</strong>
</p>

<p align="center">
  <em><a href="https://docs.anthropic.com/en/docs/claude-code/overview">Claude Code CLI</a>를
  위한 VSCode / Antigravity 익스텐션.</em>
</p>

<p align="center">
  <a href="./README.md">English README</a>
</p>

---

Claude Code 자체가 좋아서 매일 쓴다. 그런데 좋아할수록 자꾸 거슬리는 것들이 있었다.

- 터미널을 따로 띄워야 한다.
- 세션 기록이 jsonl로만 남아서 한눈에 안 보인다.
- 응답이 끝났는지 보러 매번 창을 들락날락한다. 길게 생각할 때는 기다리느라 다른 일도 잘 못 한다.
- 답 안의 파일 경로·URL·폴더를 매번 손으로 옮겨 타이핑하거나 복사 붙여넣기 해야 한다.
- 자주 쓰는 명령(`/init`, 자주 보내는 prompt prefix 등)을 매번 다시 타이핑한다.
- 디바이스 두 대 이상에서 같은 워크스페이스를 쓰면 `git pull` / `git push`를 자꾸 까먹는다.
- 사용량(5시간 / 7일)이 어디까지 찼는지 모르고 막 쓰다 갑자기 막힌다.

이걸 다 풀고 싶어서, **cli-launcher-for-claude** 라는 VSCode/VSCodium 익스텐션을 만들었다.

![cli-launcher-for-claude TUI 패널 — VSCode 안에서 Claude Code 세션이 진행 중인 모습](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/02-cli-launcher-tui.png)

이런 모양이다. VSCode 안에 Claude Code 세션을 띄우고 하단에 입력란이 있다. 상단 탭으로 여러 세션을 동시에 굴리고, HUD가 사용량을 알려준다.

## 무엇을 하는가

**한 줄로**: VSCode 안에 Claude Code를 띄우고, 대화를 깔끔한 markdown으로 같이 보고, 워크스페이스의 git push/pull도 자동으로 처리한다.

조금 풀어 쓰면:

- **CLI 그대로 + 위에 얹는 편의** — Claude Code CLI의 모든 기능은 100% 그대로 살아있다. 그 위에 자주 부딪히는 마찰만 위로 얹는다.
- **TUI 패널** — Claude Code 세션을 VSCode 패널 안에서 직접 띄운다. 새 터미널 안 열어도 됨.
- **세션 트리 + 그룹** — 세션마다 제목을 직접 붙이고, 관련된 세션끼리 그룹/폴더로 묶어 보관. 보관해둔 세션은 트리에서 골라 다시 불러와서 이어 작업할 수 있다. (제목을 안 붙이면 첫 메시지 기반 AI 자동 제목으로 fallback.)
- **Reader-Live** — 진행 중인 대화를 markdown으로 같이 본다. 코드 블록, 인용, 표가 그대로 렌더링. xterm.js 터미널과 split layout으로 동시에.
- **상태 + 알림** — 응답이 진행 중이면 탭과 패널 테두리가 **노란색으로 글로우**, 끝나면 **초록색**으로 바뀐다. 시스템 알림도 같이 띄워서 다른 일 하다가도 자연스럽게 알아챈다.
- **Repo Sync** — 워크스페이스 변경을 5분 debounce로 감지해서 자동 commit + push. VSCode 종료 시 마지막 commit. 디바이스 이름이 commit 메시지에 박힘 (`[Mac] auto-sync: ...`).
- **다중 계정 전환** — 회사 / 개인 Claude 계정을 매번 `/logout` → 브라우저 → `/login` 하지 않고 프로필로 저장해뒀다가 바꿔 끼운다. 스냅샷은 `~/.claude/account-switcher/<slug>/`에 저장. 액티브 프로필 인식은 credentials hash → `accountUuid` → `userID + email` → email 4단 cascade라 백그라운드 토큰 회전이 일어나도 "저장 안 됨"으로 슬며시 빠지지 않는다. **하단 상태바 왼쪽에 활성 계정명**(`$(account) Acme` 또는 이메일)이 상시 표시되며 클릭 → QuickPick으로 저장된 계정 즉시 전환. 명령 팔레트 *Switch Claude Account…* 또는 설정 모달(⚙) *Switch Account…* 버튼으로도 동일하게 열림. 첫 저장 때 한 번만 OAuth 토큰 복사 동의 안내가 뜬다.
- **HUD** — 상단 status bar에 5시간 / 7일 사용률 + 다음 리셋 시각. 클릭 시 상세.
- **자동 링크 + 컨텍스트 메뉴** — 응답 안의 파일 경로·URL·폴더는 자동으로 클릭 가능. 클릭 한 번에 IDE에서 파일이 열리고, URL은 브라우저로, 폴더는 Finder/탐색기로. 텍스트 선택 후 우클릭하면 "Open File / Open Folder / Copy" 메뉴.
- **커스텀 버튼** — 자주 쓰는 명령(`/init` 같은 슬래시, 자주 보내는 prompt, 큰 페이스트 payload 등)을 버튼으로 등록. 클릭 한 번에 입력란에 자동 입력.
- **똑똑한 paste** — 클립보드의 이미지를 붙여넣으면 자동으로 temp 파일로 저장 + 작은 미리보기 팝업 + 경로(`@/tmp/...png`)가 입력란에 박힘. 대량 텍스트는 자동으로 `.txt` 파일로 변환해서 경로만 박힌다 — 입력란 안 막히고 Claude는 같은 내용을 받음.
- **Settings UI** — gear modal에서 모든 옵션 토글.

## 왜 만들었나

**첫 번째, 세션 가시성**. Claude Code TUI는 좋지만 긴 대화를 위로 스크롤하면서 보는 게 불편하다. Reader가 있으면 jsonl을 그대로 읽어서 markdown으로 깔끔하게 본다. 코드 블록 강조, 표, 링크 다 살아있다.

세션 자체의 식별도 같은 결로 풀었다. Claude Code의 세션은 내부적으로 ID로만 식별돼서, 한참 지나면 어떤 세션이 무엇이었는지 알아보기 어렵다. cli-launcher는 세션마다 **제목을 직접 붙이고**, 관련 세션끼리 **그룹/폴더로 묶어 보관**할 수 있다. 좌측 트리에서 보관해둔 세션을 골라 다시 불러와 이어 작업할 수도 있다. 제목을 안 붙이면 첫 메시지 기반으로 AI가 자동 제목을 달아줘서 식별은 항상 살아있다.

![cli-launcher-for-claude Reader-Live — 위쪽 markdown 채팅 + 아래쪽 xterm 터미널 split layout](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/03-cli-launcher-reader.png)

같은 세션을 위에서는 markdown 결로, 아래에서는 진짜 터미널로 동시에 본다. 위 화면은 read-only가 아니어서 화면 맨 아래 입력란으로 메시지를 보낼 수도 있다. 비율은 가운데 splitter를 드래그해서 조절.

**두 번째, 응답 상태가 한눈에 보여야 한다**. Claude가 깊게 생각할 때는 1분 넘게 걸린다. 그동안 끝났는지 매번 창을 보러 가는 게 매번 맥을 끊었다. 그래서 **상태를 시각적으로 박았다** — 응답이 진행 중이면 탭과 패널 테두리가 **노란색으로 글로우**, 끝나면 **초록색**으로 바뀐다. 시스템 알림도 같이 띄운다.

다른 일을 하다가도 옆눈으로 색만 흘끗 보면 끝났는지 알 수 있다. 길게 생각하는 작업을 던져두고 다른 창에서 일하다 알림이 뜨면 그제야 돌아오면 된다.

**세 번째, 멀티 디바이스**. 회사 PC / 집 데스크탑 / Mac 세 대를 오가는데, 매번 "그쪽에서 push 했나?"가 의심스럽다. **종료의 게으름이 시작의 불안을 만든다**. Repo Sync가 종료 측 게으름을 풀어주면 시작 측 의심도 같이 풀린다.

**네 번째, 사용량 가시성**. Claude Code의 rate limit 정보를 실시간으로 보고 싶었다. status bar에 박아두면 흘끗 보고 페이스 조절이 된다.

**다섯 번째, CLI는 그대로, 흐름은 더 매끄럽게**. cli-launcher의 가장 중요한 원칙은 **Claude Code CLI의 모든 기능을 100% 그대로 둔다**는 것이다. 그 위에 자주 부딪히는 마찰만 얹는다. 무언가를 가리거나 대체하지 않는다.

답 안에 파일 경로가 나오면 매번 손으로 잡아서 옮기는 게 귀찮았다. 그래서 응답 텍스트 안의 파일·URL·폴더가 **자동으로 클릭 가능**하게 만들었다. 클릭 한 번에 IDE에서 파일이 열리고, URL은 브라우저, 폴더는 Finder. 우클릭 메뉴로도 같은 동작.

자주 쓰는 명령은 매번 다시 타이핑하지 않으려고 **커스텀 버튼**으로 등록한다. `/init`, 자주 쓰는 prompt prefix, 큰 페이스트 payload 같은 것들. 버튼 클릭 한 번이면 입력란에 자동으로 박힌다.

paste도 마찬가지다. 클립보드에 이미지가 있으면 그대로 `Cmd+V` — cli-launcher가 자동으로 temp 파일로 저장하고, 입력란에는 그 경로(`@/tmp/...png`)만 박는다. 동시에 작은 미리보기 팝업도 떠서 "내가 어떤 이미지를 붙였는지" 한눈에 확인된다. 대량 텍스트(수백 줄짜리 로그나 코드)를 붙여넣을 때도 같은 원리 — 자동으로 `.txt` 파일로 변환되고 경로만 박힌다. **입력란이 막히지 않고**, Claude는 똑같은 내용을 본다.

![cli-launcher-for-claude HUD status bar — Claude Running + 5h 29% + 7d 53% + 다음 리셋 시각](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/05-cli-launcher-hud.png)

5시간 윈도우와 7일 윈도우의 사용률을 동시에 보여준다. 다음 리셋 시각까지 옆에 박혀 있어서 "지금 멈출지 더 갈지" 같은 사소한 결정이 빨라진다.

## 어떻게 쓰나

**설치**:

세 가지 방법:

1. **Open VSX**: Antigravity 또는 (Open VSX 갤러리가 등록된) VSCode 의 Extensions 뷰에서
   *CLI Launcher for Claude, Codex, Kiro & Antigravity* 검색 — [Open VSX 페이지](https://open-vsx.org/extension/rockuen/cli-launcher-for-claude).
2. **VSIX**: [GitHub Releases](https://github.com/rockuen/cli-launcher-for-claude/releases)
   에서 최신 `cli-launcher-for-claude-<platform>-<version>.vsix` 다운로드 →
   *Extensions: Install from VSIX...* 로 설치.
3. **소스 빌드**:
   ```bash
   git clone https://github.com/rockuen/cli-launcher-for-claude.git
   cd cli-launcher-for-claude
   npm install && npm run build && npm run package
   ```

`claude` 가 `PATH` 에 있어야 합니다 (`npm install -g @anthropic-ai/claude-code`
또는 공식 standalone 설치).

**기본 사용**:

1. 명령 팔레트 (`Cmd/Ctrl + Shift + P`) → `Claude Code Launcher: Open Panel`
2. 패널에서 `New Session` → 작업 시작
3. (선택) 헤더 👁 토글로 split layout 진입 — Reader 영역이 위, TUI가 아래
4. (선택) gear modal에서 **Repo Sync** 활성화 + 워크스페이스 path 설정

**Repo Sync 활성화**:

설정은 두 가지 경로 — 패널 안 ⚙ Settings modal에서 토글로, 또는 워크스페이스 `.vscode/settings.json`에 박는다.

![cli-launcher-for-claude Settings modal — 폰트, 테마, Split Layout, Repo Sync 등 옵션 토글](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/04-cli-launcher-settings.png)

코드로 박을 때:

```jsonc
// .vscode/settings.json (워크스페이스)
{
  "claudeCodeLauncher.repoSync.enabled": true,
  "claudeCodeLauncher.repoSync.path": "${workspaceFolder}",
  "claudeCodeLauncher.repoSync.deviceName": "Mac"   // 처음 활성화 시 입력 prompt
}
```

`${workspaceFolder}` 또는 `${userHome}` substitution을 지원해서, 디바이스마다 절대 경로를 박을 필요가 없다. vault repo 안 `.vscode/settings.json`에 commit해두면 다른 디바이스에서 자동으로 fit한다.

## 누구한테 좋을까

- **Claude Code를 매일 쓰는 사람** — TUI만으로는 답답한 분
- **VSCode/VSCodium 안에서 작업 흐름을 통일하고 싶은 사람**
- **여러 디바이스에서 같은 vault/repo를 오가는 사람**
- **Claude Code 사용량을 한눈에 보고 싶은 사람**

## 어디서 받나

- **Open VSX**: [open-vsx.org/extension/rockuen/cli-launcher-for-claude](https://open-vsx.org/extension/rockuen/cli-launcher-for-claude)
- **GitHub**: [github.com/rockuen/cli-launcher-for-claude](https://github.com/rockuen/cli-launcher-for-claude)
- 현재 v3.5.4 (Reader-Live + Repo Sync + Settings UI + 자동 링크 + 세션 트리/그룹 + Ctrl+Wheel 줌 다 들어감)

## 한 가지 솔직한 노트

이 익스텐션은 OMC (oh-my-claudecode)가 깔린 환경에서 가장 잘 동작한다. HUD가 OMC가 가공한 사용량 캐시 파일을 읽기 때문이다. OMC 없이도 TUI / Reader / Repo Sync는 다 동작하지만, HUD 만은 비어 보인다. OMC 분리 버전은 향후 검토 예정.

## 마치며

작은 도구지만 만들면서 **"내가 매일 쓰는 흐름"** 자체가 정리됐다. 만들 때마다 `tmp/` 같은 임시 위치에 산만하게 흩어졌던 것들이 하나의 패널 안에서 깔끔하게 모인다.

Claude Code를 더 많이 쓰는 분들에게 도움이 되면 좋겠다. 의견/이슈는
[GitHub Issues](https://github.com/rockuen/cli-launcher-for-claude/issues)로.

---

## License

MIT — see [LICENSE](./LICENSE).

<p align="center">
  <img src="icons/icon-128.png" alt="CLI Launcher for Claude, Codex, Grok, Kiro & Antigravity" width="96" height="96"/>
</p>

<h1 align="center">CLI Launcher for Claude, Codex, Grok, Kiro & Antigravity</h1>

<p align="center">
  <strong>Claude Code·Codex·Grok·Kiro·Antigravity 다섯 개의 AI 코딩 CLI를 VSCode 안 탭에서 띄우고,
  대화를 markdown으로 같이 보고, 세션을 트리로 관리하고, 워크스페이스 git sync까지 하는 익스텐션.</strong>
</p>

<p align="center">
  <em><a href="https://docs.anthropic.com/en/docs/claude-code/overview">Claude Code</a> · Codex ·
  Grok · Kiro · Antigravity CLI를 위한 VSCode / Antigravity 익스텐션.</em>
</p>

<p align="center">
  <a href="./README.md">English README</a>
</p>

---

Claude Code가 좋아서 매일 쓴다. 그러다 Codex도, Grok도, Kiro도, Antigravity도 하나씩 손에 익었다. AI 코딩 CLI는 터미널에서 그냥 쓸 때도 좋지만, 손에 쥔 게 늘어날수록 터미널 하나로는 부족하다는 게 또렷해졌다.

- 에이전트마다 터미널을 따로 띄워야 한다.
- 세션 기록이 CLI마다 제각각(어떤 건 jsonl, 어떤 건 SQLite)이라 한눈에 안 보인다.
- 응답이 끝났는지 보러 매번 창을 들락날락한다. 길게 생각할 때는 기다리느라 다른 일도 잘 못 한다.
- 답 안의 파일 경로·URL·폴더를 매번 손으로 옮겨 타이핑하거나 복사 붙여넣기 해야 한다.
- 자주 쓰는 명령(`/init`, 자주 보내는 prompt prefix 등)을 매번 다시 타이핑한다.
- 디바이스 두 대 이상에서 같은 워크스페이스를 쓰면 `git pull` / `git push`를 자꾸 까먹는다.
- 사용량(5시간 / 7일)이 어디까지 찼는지 모르고 막 쓰다 갑자기 막힌다.

이걸 다 풀고 싶어서 **cli-launcher** 라는 VSCode/VSCodium 익스텐션을 만들었다. 처음엔 Claude Code 하나만 감쌌는데, 지금은 다섯 개의 CLI를 같은 패널 안에서 똑같은 방식으로 굴린다.

![cli-launcher TUI 패널 — VSCode 안에서 세션이 진행 중인 모습](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/02-cli-launcher-tui.png)

이런 모양이다. VSCode 안에 세션을 띄우고 하단에 입력란이 있다. 상단 탭으로 여러 세션을 동시에 굴리고, HUD가 사용량을 알려준다.

## 무엇을 하는가

**한 줄로**: Claude Code·Codex·Grok·Kiro·Antigravity를 VSCode 안 탭에서 띄우고, 대화를 깔끔한 markdown으로 같이 보고, 세션을 트리로 관리하고, 워크스페이스의 git push/pull도 자동으로 처리한다.

조금 풀어 쓰면:

- **CLI 그대로 + 위에 얹는 편의** — 각 CLI의 모든 기능은 100% 그대로 살아있다. 그 위에 자주 부딪히는 마찰만 얹는다. 무언가를 가리거나 대체하지 않는다.
- **다섯 개의 에이전트, 한 패널** — Claude / Codex / Grok / Kiro / Antigravity를 같은 Webview 탭에서 띄운다. 에이전트마다 세션 뷰가 따로 있고, 탭은 자기 에이전트 색을 띤다.
- **세션 트리 + 그룹** — 세션마다 제목을 직접 붙이고, 관련된 세션끼리 그룹/폴더로 묶어 보관. 보관해둔 세션은 트리에서 골라 다시 불러와 이어 작업할 수 있다.
- **Reader-Live** — 진행 중인 대화를 markdown으로 같이 본다. 코드 블록, 인용, 표가 그대로 렌더링. xterm.js 터미널과 split layout으로 동시에. (Antigravity만 예외 — 아래 "다섯 개의 에이전트"에서 설명.)
- **상태 + 알림** — 응답이 진행 중이면 탭과 패널 테두리가 **노란색으로 글로우**, 끝나면 **초록색**으로 바뀐다. 시스템 알림도 같이 띄워서 다른 일 하다가도 자연스럽게 알아챈다.
- **핸드오프** — 한 에이전트의 대화 맥락을 다른 에이전트에게 넘긴다. "여기까지 Claude랑 했는데 이어서 Codex한테" 같은 흐름.
- **Repo Sync** — 워크스페이스 변경을 자동 commit + push. 디바이스 이름이 commit 메시지에 박힌다.
- **다중 계정 전환** — Claude 계정을 프로필로 저장해뒀다가 바꿔 끼운다. (Windows/Linux는 파일, **macOS는 Keychain** 기반.)
- **HUD** — 5시간 / 7일 사용률 + 다음 리셋 시각.

## 다섯 개의 에이전트

cli-launcher는 다섯 개의 AI 코딩 CLI를 같은 방식으로 감싼다. 각 CLI가 세션을 저장하는 방식이 다 달라서(파일이냐 DB냐, ID를 누가 매기냐) 안쪽 처리는 제각각이지만, 쓰는 입장에서는 똑같다 — 탭에서 띄우고, 트리에서 고르고, reader로 본다.

| 에이전트 | CLI | Reader | 톤 | 권한 토글 |
|---|---|---|---|---|
| **Claude** | `claude` | ✅ markdown | 코랄 | `--dangerously-skip-permissions` |
| **Codex** (OpenAI) | `codex` | ✅ markdown | 슬레이트 | `--dangerously-bypass-approvals-and-sandbox` |
| **Grok** (xAI) | `grok` | ✅ markdown | 그린 | `--always-approve` |
| **Kiro** | `kiro-cli` | ✅ markdown (tool-use 포함) | 퍼플 | `--trust-all-tools` |
| **Antigravity** (Google) | `agy` | ❌ (터미널 전용) | 아주어 | `--dangerously-skip-permissions` |

- **기본은 Claude만 켜져 있다.** 나머지는 **설정 → Agent**에서 켜면, 설치돼 있는 것만 새 세션 picker와 사이드바 세션 뷰에 나타난다.
- **탭은 자기 에이전트 색을 자동으로 띤다** (Auto 테마). 터미널 출력 색은 안 건드리고 하단 입력 영역의 톤만 바뀌어서, 지금 어느 에이전트인지 한눈에 보이면서도 출력은 일관되게 유지된다. 원하면 한 색으로 고정할 수도 있다.
- **Antigravity만 reader가 없다.** `agy`는 대화를 protobuf-in-SQLite로 저장해서 markdown으로 풀어낼 수가 없다. 그래서 Antigravity 탭은 터미널 단독으로 열린다. 핸드오프도 Antigravity로 *받는* 건 되지만(맥락을 프롬프트에 주입), Antigravity에서 다른 에이전트로 *주는* 건 안 된다 — 대화를 못 읽으니까.
- 각 권한 토글은 해당 에이전트의 "묻지 말고 실행" 모드다. 신뢰하는 작업에서만 쓰고, 기본은 전부 꺼져 있다.

## 왜 만들었나

**첫 번째, 세션 가시성**. CLI의 TUI는 좋지만 긴 대화를 위로 스크롤하면서 보는 게 불편하다. Reader가 있으면 세션 파일을 그대로 읽어서 markdown으로 깔끔하게 본다. 코드 블록 강조, 표, 링크 다 살아있다.

세션 자체의 식별도 같은 결로 풀었다. 각 CLI의 세션은 내부적으로 ID로만 식별돼서, 한참 지나면 어떤 세션이 무엇이었는지 알아보기 어렵다. cli-launcher는 세션마다 **제목을 직접 붙이고**, 관련 세션끼리 **그룹/폴더로 묶어 보관**할 수 있다. 좌측 트리에서 보관해둔 세션을 골라 다시 불러와 이어 작업할 수도 있다. 제목을 안 붙이면 첫 메시지 기반으로 자동 제목을 달아줘서 식별은 항상 살아있다.

![cli-launcher Reader-Live — 위쪽 markdown 채팅 + 아래쪽 xterm 터미널 split layout](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/03-cli-launcher-reader.png)

같은 세션을 위에서는 markdown 결로, 아래에서는 진짜 터미널로 동시에 본다. 위 화면은 read-only가 아니어서 화면 맨 아래 입력란으로 메시지를 보낼 수도 있다. 비율은 가운데 splitter를 드래그해서 조절.

**두 번째, 응답 상태가 한눈에 보여야 한다**. AI가 깊게 생각할 때는 1분 넘게 걸린다. 그동안 끝났는지 매번 창을 보러 가는 게 매번 맥을 끊었다. 그래서 **상태를 시각적으로 박았다** — 응답이 진행 중이면 탭과 패널 테두리가 **노란색으로 글로우**, 끝나면 **초록색**으로 바뀐다. 시스템 알림도 같이 띄운다. 다른 일을 하다가도 옆눈으로 색만 흘끗 보면 끝났는지 알 수 있다.

**세 번째, 멀티 디바이스**. 회사 PC / 집 데스크탑 / Mac 세 대를 오가는데, 매번 "그쪽에서 push 했나?"가 의심스럽다. **종료의 게으름이 시작의 불안을 만든다**. Repo Sync가 종료 측 게으름을 풀어주면 시작 측 의심도 같이 풀린다. 워크스페이스 변경을 5분 debounce로 감지해서 자동 commit + push, VSCode 종료 시 마지막 commit, 디바이스 이름이 commit 메시지에 박힌다(`[Mac] auto-sync: …`).

**네 번째, 사용량 가시성**. Claude Code의 rate limit 정보를 실시간으로 보고 싶었다. status bar에 박아두면 흘끗 보고 페이스 조절이 된다.

![cli-launcher HUD status bar — Running + 5h 29% + 7d 53% + 다음 리셋 시각](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/05-cli-launcher-hud.png)

**다섯 번째, CLI는 그대로, 흐름은 더 매끄럽게**. cli-launcher의 가장 중요한 원칙은 **각 CLI의 모든 기능을 100% 그대로 둔다**는 것이다. 그 위에 자주 부딪히는 마찰만 얹는다. 무언가를 가리거나 대체하지 않는다.

답 안에 파일 경로가 나오면 매번 손으로 잡아서 옮기는 게 귀찮았다. 그래서 응답 텍스트 안의 파일·URL·폴더가 **자동으로 클릭 가능**하게 만들었다. 클릭 한 번에 IDE에서 파일이 열리고, URL은 브라우저, 폴더는 Finder. 자주 쓰는 명령은 **커스텀 버튼**으로 등록해서 클릭 한 번에 입력란에 박는다. 클립보드의 이미지를 붙여넣으면 자동으로 temp 파일로 저장하고 경로(`@/tmp/...png`)만 입력란에 박는다 — 대량 텍스트도 같은 원리로 `.txt`로 변환되어 **입력란이 막히지 않는다**.

## 주요 기능

- **에이전트별 세션 뷰** — Claude / Codex / Grok / Kiro / Antigravity 각각의 사이드바 트리. 그룹·폴더(최대 3단 중첩)·드래그앤드롭·이름 변경·휴지통.
- **Reader-Live** — 진행 중 대화를 markdown으로. split layout 또는 standalone. 빈 세션엔 브랜디드 환영 화면. (Antigravity 제외)
- **reader 발신자 이름 커스텀** — reader에 뜨는 "나"의 이름(전역)과 에이전트별 AI 이름을 설정에서 바꾼다.
- **상태 인식 탭** — idle / running / done / error / needs-attention. 인터랙티브 프롬프트(`[Y/n]`, 메뉴 등)는 7초 임계 무시하고 즉시 needs-attention + 데스크탑 알림.
- **에이전트 테마** — 입력 영역 톤이 에이전트를 따라간다(Auto). 한 색 고정도 가능.
- **핸드오프** — 활성화된 다른 에이전트로 대화 맥락 전달.
- **세션 링크** — 세션 우클릭(또는 툴바 🔗)으로 그 세션을 다시 여는 링크를 복사한다. 할 일 관리 앱·노트·채팅에 붙여두고 나중에 누르면 에디터가 뜨면서 그 세션이 그대로 재개된다. 세션 폴더를 열고 있는 창에서 열린다.
- **다중 계정 전환** — Claude 로그인을 프로필로 저장/전환. 활성 계정명이 하단 상태바에 상시 표시, 클릭하면 QuickPick. Windows/Linux는 `~/.claude/.credentials.json`, **macOS는 Keychain**에서 토큰을 읽고 쓴다.
- **자동 링크 + 컨텍스트 메뉴** — 응답 안의 파일/URL/폴더 클릭, 선택 후 우클릭 메뉴.
- **어디 있든 파일 찾기** — 세션 작업 폴더 밖에 있는 파일명을 클릭하면 OS 파일 인덱스(Windows=Everything, macOS=Spotlight, Linux=`locate`)로 찾아서 연다. 하나면 바로 열고, 여러 개면 선택창. 일회성 설치는 *어떻게 쓰나* 참고.
- **커스텀 버튼 / 똑똑한 paste / 입력 히스토리 / 작업 큐** — 입력 패널 편의.
- **슬래시 자동완성** — Claude Code 빌트인 카탈로그 + 개인 PKM/OMC 카탈로그(override 파일).
- **Repo Sync** — 자동 commit + push, `${workspaceFolder}` 치환 지원.
- **HUD** — 5시간 / 7일 사용률 + 리셋 시각 + 모델명.
- **선택: tmux/psmux 백엔드** — 같은 Webview 탭 안에서 멀티플렉서 세션으로. 외부 attach + 멀티 머신 워크플로.
- **선택: OMC 모드** — oh-my-claudecode가 깔려 있으면 CCG 뷰어 + HUD가 켜진다.

## 어떻게 쓰나

**설치** — 세 가지 방법:

1. **Open VSX**: Antigravity 또는 (Open VSX 갤러리가 등록된) VSCode 의 Extensions 뷰에서
   *CLI Launcher for Claude, Codex, Grok, Kiro & Antigravity* 검색 — [Open VSX 페이지](https://open-vsx.org/extension/rockuen/cli-launcher-for-claude).
2. **VSIX**: [GitHub Releases](https://github.com/rockuen/cli-launcher-for-claude/releases)
   에서 최신 `cli-launcher-for-claude-<platform>-<version>.vsix` 다운로드 →
   *Extensions: Install from VSIX...* 로 설치.
3. **소스 빌드**:
   ```bash
   git clone https://github.com/rockuen/cli-launcher-for-claude.git
   cd cli-launcher-for-claude
   npm install && npm run build && npm run package
   ```

적어도 `claude` 가 `PATH` 에 있어야 한다 (`npm install -g @anthropic-ai/claude-code`
또는 공식 standalone 설치). Codex / Grok / Kiro / Antigravity는 각 CLI를 설치한 뒤 **설정 → Agent**에서 켜면 된다.

**선택 — "어디 있든 파일 찾기"**: 세션 작업 폴더 밖에 있는 파일 링크를 클릭하면 OS 파일
인덱스로 찾아서 연다. 기본 켜짐이고, 백엔드가 없으면 조용히 기존 동작으로 돌아간다.

- **Windows** — [Everything](https://www.voidtools.com/) 설치(계속 실행) + 명령줄 도구
  [`es.exe`](https://www.voidtools.com/support/everything/command_line_interface/) 설치.
  `es.exe` 를 `%LOCALAPPDATA%\Programs\everything-cli\` 에 두거나(자동 감지)
  `claudeCodeLauncher.fileLocator.esPath` 로 경로를 지정한다.
- **macOS** — 설치할 것 없음. Spotlight 의 `mdfind` 가 내장돼 있다.
- **Linux** — `plocate`(또는 `mlocate`) 설치 후 DB를 한 번 생성: `sudo apt install plocate && sudo updatedb`.

**기본 사용**:

1. 에디터 제목 표시줄의 런처 아이콘 클릭(또는 `Cmd/Ctrl + Shift + ;`) → 에이전트 선택(Claude / Codex / Grok / Kiro / Antigravity).
2. 작업 시작. 같은 에이전트로 탭을 더 열려면 탭 안의 `+`.
3. 보관해둔 세션은 사이드바 **CLI Launcher** 액티비티의 에이전트별 **Sessions** 트리에서 클릭해 재개.
4. (선택) 헤더 👁 토글로 split layout 진입 — Reader가 위, 터미널이 아래.
5. (선택) gear modal(⚙)에서 **Repo Sync** 활성화 + 워크스페이스 path 설정.

![cli-launcher Settings modal — 폰트, 테마, Split Layout, Repo Sync, Agent 등 옵션 토글](https://raw.githubusercontent.com/rockuen/cli-launcher-for-claude/main/docs/images/04-cli-launcher-settings.png)

**Repo Sync** 는 패널 안 ⚙ Settings modal에서 토글하거나, 워크스페이스 `.vscode/settings.json`에 직접 박는다:

```jsonc
// .vscode/settings.json (워크스페이스)
{
  "claudeCodeLauncher.repoSync.enabled": true,
  "claudeCodeLauncher.repoSync.path": "${workspaceFolder}",
  "claudeCodeLauncher.repoSync.deviceName": "Mac"   // 처음 활성화 시 입력 prompt
}
```

`${workspaceFolder}` / `${userHome}` 치환을 지원해서, 디바이스마다 절대 경로를 박을 필요가 없다. vault repo 안 `.vscode/settings.json`에 commit해두면 다른 디바이스에서 자동으로 맞는다.

## 누구한테 좋을까

- **Claude Code(혹은 Codex / Grok / Kiro / Antigravity)를 매일 쓰는 사람** — TUI만으로는 답답한 분
- **여러 AI 코딩 CLI를 오가는 사람** — 한 패널에서 같은 방식으로 굴리고 싶은 분
- **VSCode/VSCodium 안에서 작업 흐름을 통일하고 싶은 사람**
- **여러 디바이스에서 같은 vault/repo를 오가는 사람**
- **사용량을 한눈에 보고 싶은 사람**

## 한 가지 솔직한 노트

- **HUD는 OMC(oh-my-claudecode)가 깔린 환경에서 가장 잘 동작한다.** HUD가 OMC가 가공한 사용량 캐시 파일을 읽기 때문이다. OMC 없이도 나머지(TUI / Reader / Repo Sync / 다중 에이전트)는 다 동작하지만, HUD만은 비어 보인다.
- **Antigravity는 reader가 없다.** 대화가 protobuf-in-SQLite라서 markdown으로 못 푼다. 터미널 단독으로 쓰고, 핸드오프는 받는 것만 된다.
- **다중 계정 전환은 현재 Claude 전용이다.** macOS는 Keychain, 그 외는 파일에서 토큰을 다룬다.

## 마치며

작은 도구지만 만들면서 **"내가 매일 쓰는 흐름"** 자체가 정리됐다. 에이전트가 하나에서 다섯으로 늘어도, 산만하게 흩어졌던 것들이 하나의 패널 안에서 깔끔하게 모인다.

AI 코딩 CLI를 더 많이 쓰는 분들에게 도움이 되면 좋겠다. 의견/이슈는
[GitHub Issues](https://github.com/rockuen/cli-launcher-for-claude/issues)로.

전체 변경 이력은 [`CHANGELOG.md`](./CHANGELOG.md).

---

## License

MIT — see [LICENSE](./LICENSE).

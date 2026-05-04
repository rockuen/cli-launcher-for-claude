<p align="center">
  <img src="icons/icon-128.png" alt="CLI Launcher for Claude" width="96" height="96"/>
</p>

<h1 align="center">CLI Launcher for Claude</h1>

<p align="center">
  <strong>Webview 탭 안에서 Claude Code CLI 를 실행 — 상태 아이콘, 세션 관리,
  테마, 옵션 tmux/psmux 백엔드, OMC 통합까지.</strong>
</p>

<p align="center">
  <em><a href="https://docs.anthropic.com/en/docs/claude-code/overview">Claude Code CLI</a>
  를 위한 VSCode / Antigravity 익스텐션.</em>
</p>

<p align="center">
  <a href="./README.md">English README</a>
</p>

---

## 왜 만들었나

Claude Code 자체는 평범한 터미널에서도 잘 동작하지만, 터미널은 얇은 호스트입니다 — 세션별
상태 표시도, 저장/복원도, 테마도, 백엔드 빠른 전환도 없고 OMC 산출물을 띄울 자리도 없습니다.
**CLI Launcher** 는 CLI 를 Webview 탭으로 감싸 각 세션에 자체 아이콘 + 라이프사이클을 주고,
사이드바 트리에서 그룹화 + 다시 붙기를 지원하며, 필요할 때 tmux/psmux 세션 안에서 돌릴 수도
있습니다. OMC 통합은 단일 모드 토글 뒤에 격리되어 있어 OMC 미사용자에게는 추가 표면이
보이지 않습니다.

## 설치

세 가지 방법:

1. **Open VSX**: Antigravity 또는 (Open VSX 갤러리가 등록된) VSCode 의 Extensions 뷰에서
   *CLI Launcher for Claude* 검색 — [Open VSX 페이지](https://open-vsx.org/extension/rockuen/cli-launcher-for-claude).
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

## 빠른 시작

- **세션 열기**: `Cmd/Ctrl+Shift+;` 또는 에디터 타이틀바의 Claude 아이콘 클릭.
- **세션 이어하기**: 사이드바 → Claude Code 활동의 **Sessions** 트리 항목 클릭.
- **설정**: 런처 패널 상단 톱니(⚙) 아이콘.

## 기능

### 상태 인식 터미널
- PTY 스트림에 따라 탭 아이콘이 **idle / running / done / error / needs-attention**
  로 전환됩니다.
- 외곽 글로우 + 응답 타이머가 같은 상태를 미러링.
- **인터랙티브 프롬프트 fast-path**: `[Y/n]`, `Press Enter to continue…` 같은 패턴이
  뜨면 7초 running threshold 를 기다리지 않고 즉시 `needs-attention` 로 전환.
- 포커스가 없는 탭이 attention 상태면 타이틀이 깜빡입니다.

### 세션 관리
- IDE 재시작 사이의 **저장 / 복원** (sessions.json 에 저장 — workspaceState 종속 없음).
- **Resume Later** 그룹 + **Recent Sessions** + **Trash** 빌트인.
- **사용자 정의 그룹** — 드래그앤드롭, 이름 변경, 삭제, 순서 변경.
- **3 단계까지 중첩 가능한 서브 폴더** (`Work → Backend → API`). 그룹 우클릭 → *Add Sub-Group*.
- **서브 세션**: *Nest Under Session…* 로 한 세션을 다른 세션 아래에 중첩.

### Context 사용량 인디케이터
- 툴바 진행 바가 Claude Code 의 `ctx:XX%` 상태를 읽어 윈도우가 차오르는 만큼
  녹색 → 주황 → 빨강으로 색상 코딩.
- 바를 클릭하면 `/context` 로 수동 새로고침.

### 입력 패널
- 슬래시 커맨드 자동완성 (`/` 입력 시 후보 표시). Claude Code 빌트인 카탈로그 전체
  (`/compact`, `/clear`, `/resume`, `/usage`, `/effort`, `/output-style`, `/statusline`,
  `/security-review`, `/agents`, `/mcp`, `/hooks`, `/permissions`, …) 를 기본 제공.
  `customSlashCommands` 로 추가한 사용자 항목도 머지되며, 본인의 PKM/OMC 카탈로그는
  gitignore 된 override 파일로 끼워 넣을 수 있습니다 — §_본인 슬래시 등록하기_ 참조.
- 작업 큐 (여러 프롬프트 큐잉 → 순차 실행).
- 사용자 정의 버튼 (라벨 + 슬래시 커맨드), Settings 에서 설정.
- Ctrl/Cmd+Up/Down 입력 히스토리.
- 파일 드래그앤드롭 / 이미지 붙여넣기 / 큰 텍스트 → 파일 (임계값 설정 가능).

### 테마와 커스터마이징
- 7 종 테마: Default / Midnight / Ocean / Forest / Sunset / Aurora / Warm.
- 상태 기반 애니메이션이 적용된 배경 입자 효과.
- 폰트 크기 / 패밀리 설정.
- 인앱 Settings UI; JSON 으로 export/import.

### 중괄호 확장 경로 열기
- 파일/폴더 클릭 핸들러가 `worker-{1,2,3}/answer.md` 같은 패턴 (OMC 팀 산출물에서 흔한)
  을 확장해 매칭되는 항목을 한 번에 모두 엽니다.

## OMC 모드

OMC 의존 기능은 **단일 컨텍스트 키로 게이팅** 됩니다. OMC 가 설치되어 있지 않으면
(또는 그냥 쓰고 싶지 않으면) 추가 표면이 노출되지 않습니다.

토글: command palette → *Enter OMC Mode* / *Exit OMC Mode*. 익스텐션이 처음
로컬 OMC 설치 (`~/.omc/` + `omc` CLI + 유효 config) 를 감지하면 OMC 모드를
자동으로 켤지 한 번 묻습니다.

### OMC 모드에서 추가로 켜지는 것

- **CCG (Claude-Codex-Gemini) 뷰어** — 모든 `/ccg` 산출물 페어
  (`.omc/artifacts/ask/codex-*.md` ↔ `gemini-*.md`) 의 사이드바 트리 + 페어별
  Webview 비교. 명령: *Show CCG*, *Refresh CCG*, *Open CCG Pair*, *Rerun CCG*.
- **HUD 상태바 아이템** — 우측 하단 알약 — 모델 / 컨텍스트% / 누적 비용 /
  5h rate-limit %. `<workspace>/.omc/state/hud-stdin-cache.json` 가 데이터 소스.
  *그 캐시는 Claude Code 의 `statusLine` 커맨드로 등록된 스크립트가 작성합니다
  (정식 producer 는 OMC 의 `omc-hud.mjs`). 캐시가 없으면 HUD 바는 idle 상태.*
- **HUD 스냅샷 명령** — *Show HUD Snapshot* 으로 현재 HUD JSON 을 출력 패널에 덤프.

## 옵션 tmux/psmux 백엔드

런처는 같은 Webview 탭 안에서 attached tmux (Mac/Linux) 또는 psmux (Windows)
세션으로 claude 를 감쌀 수 있습니다. Webview UI 는 동일하고 — 아래 깔린 pty 만
바뀝니다 — power user 는 외부 attach + 멀티 머신 워크플로우를 런처의 터미널 편의
없이 그대로 누릴 수 있습니다.

### 모드 전환
- **인앱**: Settings (⚙) → *Default Terminal* → `Webview` or `tmux / psmux`.
- **명령별 override**:
  - command palette → *Open Claude Code* (항상 Webview)
  - command palette → *Open Claude Code in tmux/psmux* (항상 multiplexer)
- **세션별 override** (저장된 세션 우클릭): *Resume in Webview* / *Resume in tmux/psmux*.

### 세션 라이프사이클
기본 (`kill-on-close`) 은 런처 탭을 닫으면 tmux/psmux 세션도 같이 죽여 claude 를
완전히 정리합니다 — Webview 백엔드와 동일 라이프사이클, 좀비 없음.

외부 attach 워크플로우용으로는 *Multiplexer Lifecycle* 을 `Leave detached` 로 변경:
- 탭을 닫아도 세션이 살아남음. 어느 터미널에서나
  `tmux attach -t cli-launcher-XXXXXXXX` 로 다시 붙기 가능.
- 마무리 시 *Clean Up Detached Multiplexer Sessions* (command palette) 로 일괄 정리.

`tmux` / `psmux` 가 `PATH` 에 없으면 multiplexer 설정은 일회성 안내 메시지와 함께
조용히 Webview 백엔드로 fallback — 깨진 UI 가 노출되지 않습니다.

## 본인 슬래시 등록하기

자동완성 드롭다운은 Claude Code 빌트인 카탈로그 전체와 Settings 의 사용자 편집
가능한 `customSlashCommands` 리스트를 함께 표시합니다. **고정된 개인 카탈로그**
(본인의 `.claude/commands/*.md` PKM 프로젝트 슬래시, oh-my-claudecode 스킬 셋,
또는 공유 컬렉션 등) 가 있다면, 익스텐션이 시작 시 픽업하는 **override 파일**
하나만 두면 됩니다.

### 빠른 셋업 — Claude Code 에 이 프롬프트를 붙여 넣기

cli-launcher 를 소스 repo (또는 fork) 안에서 사용 중이라면, 그 repo 안에서
Claude Code 세션을 열고 아래 프롬프트를 붙여 넣으세요. Claude 가 로컬 환경을
스캔해 PKM + OMC 카탈로그가 채워진 `src/lib/slashRegistry.local.js` 를 생성합니다:

```
cli-launcher-for-claude 의 src/lib/slashRegistry.local.js 를 생성해줘.

스캔 대상:
1. 현재 옵시디언 vault / 프로젝트 (`~/path/to/your/vault`) 의 `.claude/commands/*.md`.
   각 파일에서 frontmatter 의 `name` 과 `description` 추출 — description 이
   비어 있으면 파일명을 사람이 읽기 좋게 변환한 형태로 fallback. 이게 PKM_COMMANDS —
   cmd `/<name>`, desc { ko, en }.
2. 설치된 oh-my-claudecode 스킬 (`~/.claude/plugins/cache/omc/oh-my-claudecode/<version>/skills/*/SKILL.md`).
   각 스킬의 `description` 라인 사용. 이게 OMC_SKILLS — cmd `/oh-my-claudecode:<skill>`,
   desc { ko, en }.
3. CLAUDE.md (또는 메모리) 에서 사용자가 실제로 자주 쓰는 짧은 OMC alias
   (예: `/ccg`, `/team`, `/ralplan`, `/deep-interview`, `/omc-setup`,
   `/omc-doctor`) 추려서 OMC_ALIASES.

각 entry 스키마: `{ cmd: '/foo', desc: { ko: '한국어', en: 'English' } }`.
한쪽 언어가 없는 경우 한↔영 번역. `module.exports = { PKM_COMMANDS, OMC_ALIASES,
OMC_SKILLS }` 로 export.

`src/lib/slashRegistry.js` 는 손대지 말고 .local.js sibling 만 생성해.
```

익스텐션을 reload (`Developer: Reload Window`) 하면 자동완성 드롭다운이
새 항목들을 픽업합니다. 각 카탈로그는 desc 에 태그가 붙음: `[PKM] …`,
`[OMC alias] …`, `[OMC] …`. 태그를 입력해 필터링 가능.

### 직접 작성하기

손으로 편집하고 싶으면 `src/lib/slashRegistry.local.js` 생성:

```js
const PKM_COMMANDS = [
  { cmd: '/blog', desc: { ko: '블로그 글', en: 'Blog post' } },
  { cmd: '/idea', desc: { ko: '아이디어 추출', en: 'Capture idea' } },
];

const OMC_ALIASES = [
  { cmd: '/ccg', desc: { ko: 'Codex+Gemini 리뷰', en: 'Codex+Gemini review' } },
];

const OMC_SKILLS = [
  { cmd: '/oh-my-claudecode:autopilot',
    desc: { ko: '자율 실행', en: 'Autopilot full autonomous run' } },
];

module.exports = { PKM_COMMANDS, OMC_ALIASES, OMC_SKILLS };
```

이 파일은 `.gitignore` 에 등록되어 있어 published vsix 에는 절대 포함되지 않습니다.
각 카탈로그를 독립적으로 켜고 끌 수 있음:

| 설정                                                      | 기본값    | 효과                                                        |
| ------------------------------------------------------- | ------ | --------------------------------------------------------- |
| `claudeCodeLauncher.slashRegistry.includeBuiltinExtras` | `true` | 추가 Claude Code 빌트인 (`/resume`, `/usage`, `/effort`, …) 표시 |
| `claudeCodeLauncher.slashRegistry.includePkm`           | `true` | override 의 `[PKM]` 태그 항목 표시                               |
| `claudeCodeLauncher.slashRegistry.includeOmc`           | `true` | override 의 `[OMC]` / `[OMC alias]` 태그 항목 표시               |

override 파일이 없으면 public 빌드는 빌트인 추가 토글에만 영향을 주므로 드롭다운이
깔끔하게 유지됩니다.

## Settings 레퍼런스

모든 설정은 `claudeCodeLauncher.*` 아래. 자주 쓰는 것:

| 키 | 목적 | 기본값 |
|---|---|---|
| `terminal.defaultBackend` | `webview` 또는 `multiplexer` | `webview` |
| `terminal.multiplexerLifecycle` | `kill-on-close` 또는 `detached` | `kill-on-close` |
| `multiplexer.preferred` | `auto` / `tmux` / `psmux` / `none` | `auto` |
| `defaultTheme` | 7 종 테마 중 하나 | `default` |
| `defaultFontSize` | 8–22 | `11` |
| `defaultFontFamily` | CSS font stack | D2Coding 우선 |
| `soundEnabled` / `particlesEnabled` | UI 폴리시 토글 | `true` / `true` |
| `autoEffortMax` | /effort max 자동 승급 | `false` |
| `customButtons` | 추가 슬래시 커맨드 단축 | `[]` |
| `customSlashCommands` | 자동완성 추가 항목 | `[]` |
| `slashRegistry.includeBuiltinExtras` | Claude Code 빌트인 보충 노출 | `true` |
| `slashRegistry.includePkm` | override 의 `[PKM]` 항목 노출 | `true` |
| `slashRegistry.includeOmc` | override 의 `[OMC]` 항목 노출 | `true` |
| `fileAssociations` | 확장자별 열기 방식 | 합리적 디폴트 |
| `pasteToFileThreshold` | 자동 파일화 붙여넣기 크기 | `2000` |

같은 항목 (Default Terminal, Multiplexer Lifecycle, Theme, Font 등) 이 인앱
Settings 모달에도 들어가 있어 대부분 런처를 떠날 일이 없습니다.

## 명령

자주 쓰는 것 (나머지는 *Claude* 카테고리의 command palette 에서):

- *Open Claude Code* / *Open Claude Code in tmux/psmux* — 백엔드 명시 실행
- Sessions 트리 우클릭:
  - *Move to Group…* (중첩 그룹은 들여쓰기로 표시 + *New Sub-Group…*)
  - *Add Sub-Group* (depth ≤ 3)
  - *Resume in Webview* / *Resume in tmux/psmux*
  - *Rename Group* / *Delete Group* (자손도 같이 처리)
- *Show CCG* / *Refresh CCG* / *Rerun CCG* (OMC 모드)
- *Show HUD Snapshot* (OMC 모드)
- *Clean Up Detached Multiplexer Sessions*

## 아키텍처 개요

```
extension.js              ← 얇은 re-export
└─ src/activation.js      ← v2.6.x JS 라이프사이클, 명령 등록
└─ src/panel/             ← Webview 터미널 (xterm.js + node-pty / mux client)
└─ src/tree/              ← Sessions 사이드바 (drag-and-drop, 중첩 그룹)
└─ src/handlers/          ← open-file, paste-image, brace expansion, …
└─ src/orchestration/     ← TS, OMC 통합 레이어 (lazy load)
   ├─ core/OMCRuntime.ts  ← ~/.omc + omc CLI 감지
   ├─ core/omcMode.ts     ← 컨텍스트 키 + 상태바 + 온보딩
   ├─ core/StateWatcher.ts ← .omc/state/hud-stdin-cache.json
   ├─ core/CcgArtifactWatcher.ts
   ├─ core/multiplexerLauncher.ts (legacy detached path)
   ├─ backends/Tmux|PsmuxBackend.ts
   ├─ ui/HUDStatusBarItem.ts
   ├─ ui/CcgTreeProvider.ts + CcgViewerPanel.ts
   └─ webview/ccg-viewer-main.ts (esbuild bundled)
```

v2.6.x JS 코어는 그대로 — orchestration 코드는 위에 얹혀
`require('./out/orchestration')` 로 로드되므로 OMC 미사용자는 v2.6.6 런처
모습을 그대로 봅니다.

## 버전 / 이력

- **v3.4.0** — 슬래시 자동완성 확장: Claude Code 빌트인 보충 + 개인 카탈로그
  override (`slashRegistry.local.js`, gitignored) 메커니즘. PKM / OMC 카탈로그를
  직접 끼워 넣을 수 있는 토글 3 종 추가.
- **v3.0.0** — OMC 통합 아크: TS+esbuild 툴체인, multiplexer 추상화 (tmux/psmux),
  OMC 모드, CCG 뷰어, HUD 상태바, 옵션 multiplexer 터미널, 중괄호 확장 경로 열기,
  중첩 세션 그룹 (max depth 3), 인앱 settings UI.
- **v2.7.25** — 마지막 v2.6.6 deprecation 마커 (이 repo 가 잠시 Podium 으로
  fork 됐던 시점). Podium 실험은 [v0.16.0 으로 archive](https://github.com/rockuen/podium/releases/tag/v0.16.0)
  되었고 활성 개발은 2026-04-26 부터 여기로 회귀.
- **v2.6.x** — 안정 런처 (상태 아이콘, 세션 저장/복원, 테마, ctx 바, 사용자 정의
  버튼, drag-and-drop). 모두 v3.0 안에 그대로 ship 중.

전체 변경 이력: [`CHANGELOG.md`](./CHANGELOG.md).

## 라이선스

[MIT](./LICENSE). Made by [@rockuen](https://github.com/rockuen).

import { HEX } from './colors';

/**
 * Single source of truth for CLI Launcher webview styling. Injected into every
 * panel's `<style>` block so palette, spacing, typography, and scrollbar
 * behaviour stay in lockstep.
 *
 * Panels still keep their own panel-specific rules, but they should reference
 * these CSS variables rather than hard-coding colors or sizes.
 */
export function buildSharedWebviewCss(): string {
  return `
  :root {
    /* palette */
    --ccl-bg-editor: #0c0c0c;
    --ccl-bg-titlebar: #141414;
    --ccl-bg-card: #1a1a1a;
    --ccl-bg-panel: #101010;
    --ccl-bg-input: #1e1e1e;
    --ccl-border: #2a2a2a;
    --ccl-border-focus: #3a3a3a;
    --ccl-border-strong: #3f3f3f;
    --ccl-text-primary: #e5e5e5;
    --ccl-text-secondary: #9ca3af;
    --ccl-text-disabled: #6b7280;
    --ccl-text-inverse: #0c0c0c;
    --ccl-text-link: #60a5fa;

    /* brand + agent accents (align with HEX in colors.ts) */
    --ccl-claude: ${HEX.claude};
    --ccl-codex: ${HEX.codex};
    --ccl-gemini: ${HEX.gemini};
    --ccl-omc: ${HEX.omc};
    --ccl-leader: ${HEX.omc};

    /* status */
    --ccl-running: ${HEX.statusRunning};
    --ccl-success: ${HEX.statusDone};
    --ccl-error: ${HEX.statusFailed};
    --ccl-cancelled: ${HEX.statusCancelled};
    --ccl-idle: ${HEX.statusIdle};

    /* radii */
    --ccl-radius-sm: 3px;
    --ccl-radius-md: 4px;
    --ccl-radius-lg: 8px;
    --ccl-radius-full: 999px;

    /* sizing */
    --ccl-header-h: 56px;
    --ccl-btn-h: 32px;
    --ccl-btn-sm-h: 28px;
    --ccl-input-h: 36px;
    --ccl-chip-h: 22px;

    /* typography */
    --ccl-font-sans: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --ccl-font-mono: "Cascadia Code", Consolas, "Courier New", ui-monospace, monospace;
    --ccl-fs-xs: 10px;
    --ccl-fs-sm: 11px;
    --ccl-fs-md: 12px;
    --ccl-fs-lg: 13px;
    --ccl-fs-xl: 14px;
    --ccl-fs-2xl: 16px;

    /* legacy aliases — keep existing panel rules working without edits */
    --bg-editor: var(--ccl-bg-editor);
    --bg-titlebar: var(--ccl-bg-titlebar);
    --bg-card: var(--ccl-bg-card);
    --bg-panel: var(--ccl-bg-panel);
    --bg-input: var(--ccl-bg-input);
    --bg-backdrop: rgba(0, 0, 0, 0.55);
    --bg-button: var(--ccl-omc);
    --bg-button-hover: #F97316;
    --border: var(--ccl-border);
    --border-focus: var(--ccl-border-focus);
    --text-primary: var(--ccl-text-primary);
    --text-secondary: var(--ccl-text-secondary);
    --text-disabled: var(--ccl-text-disabled);
    --text-inverse: var(--ccl-text-inverse);
    --text-link: var(--ccl-text-link);
    --accent-claude: var(--ccl-claude);
    --accent-codex: var(--ccl-codex);
    --accent-gemini: var(--ccl-gemini);
    --accent-omc: var(--ccl-omc);
    --accent-leader: var(--ccl-leader);
    --status-running: var(--ccl-running);
    --status-success: var(--ccl-success);
    --status-error: var(--ccl-error);
    --status-cancelled: var(--ccl-cancelled);
    --status-idle: var(--ccl-idle);
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    width: 100%;
    background: var(--ccl-bg-editor);
    color: var(--ccl-text-primary);
    font-family: var(--ccl-font-sans);
    font-size: var(--ccl-fs-lg);
    line-height: 1.4;
  }

  /* Consistent scrollbar across all CLI Launcher webviews (Chromium only,
     which is all we target — Antigravity + VSCode). */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: var(--ccl-bg-card);
    border-radius: 5px;
    border: 2px solid transparent;
    background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--ccl-border-strong);
    background-clip: content-box;
  }
  ::-webkit-scrollbar-corner { background: transparent; }

  ::selection { background: rgba(251, 146, 60, 0.35); color: var(--ccl-text-primary); }

  /* Focus ring baseline */
  :focus-visible { outline: 2px solid var(--ccl-omc); outline-offset: 2px; }

  /* Keyboard-style shortcut hints — used in modal footers */
  .ccl-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    padding: 0 6px;
    height: 20px;
    line-height: 20px;
    background: var(--ccl-bg-input);
    border: 1px solid var(--ccl-border);
    border-radius: var(--ccl-radius-sm);
    font-family: var(--ccl-font-mono);
    font-size: var(--ccl-fs-xs);
    color: var(--ccl-text-secondary);
  }

  /* Small "pill" labels — used in headers and chips */
  .ccl-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--ccl-chip-h);
    padding: 0 8px;
    border-radius: var(--ccl-radius-full);
    background: var(--ccl-bg-card);
    border: 1px solid var(--ccl-border);
    font-size: var(--ccl-fs-sm);
    font-weight: 600;
    color: var(--ccl-text-secondary);
  }
  .ccl-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  `;
}

import * as vscode from 'vscode';
import type { HUDStdinCache } from '../types/hud';
import { COLOR_IDS } from './colors';

export class HUDStatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.name = 'CLI Launcher HUD';
    this.item.command = 'claudeCodeLauncher.hud.show';
    this.setIdle();
  }

  update(hud: HUDStdinCache | null): void {
    if (!hud) {
      this.setIdle();
      return;
    }

    const parts: string[] = [];
    const fh = hud.rate_limits?.five_hour;
    const sd = hud.rate_limits?.seven_day;

    if (fh && typeof fh.used_percentage === 'number') {
      const reset = formatResetClock(fh.resets_at);
      parts.push(`$(clock) 5h:${formatPct(fh.used_percentage)}%${reset ? ` (${reset})` : ''}`);
    }

    if (sd && typeof sd.used_percentage === 'number') {
      const reset = formatResetMonthDayHour(sd.resets_at);
      parts.push(`$(calendar) 7d:${formatPct(sd.used_percentage)}%${reset ? ` (${reset})` : ''}`);
    }

    this.item.text = parts.length > 0 ? parts.join('  ') : '$(organization) HUD';
    this.item.tooltip = buildTooltip(hud);

    const maxPct = Math.max(
      typeof fh?.used_percentage === 'number' ? fh.used_percentage : 0,
      typeof sd?.used_percentage === 'number' ? sd.used_percentage : 0,
    );
    this.item.color = new vscode.ThemeColor(
      maxPct >= 85
        ? COLOR_IDS.statusFailed
        : maxPct >= 60
        ? COLOR_IDS.statusRunning
        : COLOR_IDS.omc,
    );
    this.item.show();
  }

  show(): void {
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  private setIdle(): void {
    this.item.text = '$(organization) HUD';
    this.item.tooltip = 'CLI Launcher HUD — no OMC state detected yet';
    this.item.color = new vscode.ThemeColor(COLOR_IDS.statusIdle);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function formatPct(v: unknown): string {
  return typeof v === 'number' ? v.toFixed(1) : '?';
}

function formatResetClock(unix?: number): string | undefined {
  if (typeof unix !== 'number') return undefined;
  const d = new Date(unix * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatResetMonthDayHour(unix?: number): string | undefined {
  if (typeof unix !== 'number') return undefined;
  const d = new Date(unix * 1000);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const h24 = d.getHours();
  const period = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${m}/${day},${h12}${period}`;
}

function buildTooltip(hud: HUDStdinCache): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**CLI Launcher HUD**\n\n`);

  const rl = hud.rate_limits;
  if (rl?.five_hour) {
    const reset = formatResetClock(rl.five_hour.resets_at);
    md.appendMarkdown(
      `- $(watch) 5h limit: ${formatPct(rl.five_hour.used_percentage)}%` +
        (reset ? ` (resets at ${reset})` : '') +
        `\n`,
    );
  }
  if (rl?.seven_day) {
    const reset = formatResetMonthDayHour(rl.seven_day.resets_at);
    md.appendMarkdown(
      `- $(calendar) 7d limit: ${formatPct(rl.seven_day.used_percentage)}%` +
        (reset ? ` (resets at ${reset})` : '') +
        `\n`,
    );
  }

  md.appendMarkdown(`\n_Click to open CLI Launcher HUD._`);
  return md;
}

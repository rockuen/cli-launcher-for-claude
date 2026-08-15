// Account module entry — facade exposed to `src/activation.js` via
// `require('../out/account')`. Mirrors the orchestration module's
// pattern (`src/orchestration/index.ts` → `out/orchestration/index.js`).
//
// Only the two UI entry points + the status bar factory are re-exported;
// the profile mutation surface (saveProfile/switchProfile/…) stays
// internal to the module so activation.js can't accidentally bypass
// the QuickPick + modal confirmation flow.
export { openAccountSwitcher, promptSaveCurrentAccount } from "./switcher";
export {
  createAccountStatusBar,
  refreshAccountStatusBar,
} from "./accountStatusBar";

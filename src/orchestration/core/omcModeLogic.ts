// omcModeLogic — pure state-machine for OMC mode initial decision.
//
// No vscode dependency — importable in unit tests without a mock host.

export interface InitialModeInputs {
  /** Value stored under OMC_MODE_PREF_KEY in globalState (undefined = never set). */
  manualPreference: boolean | undefined;
  /** Whether the onboarding prompt has already been shown. */
  onboardingShown: boolean;
  /** Whether OMC is detected as installed on this machine. */
  omcInstalled: boolean;
}

export type InitialModeDecision =
  | { state: 'active' }
  | { state: 'inactive' }
  | { state: 'show-onboarding' };

/**
 * Decide the initial OMC mode state from stored preferences + detection result.
 * Pure function — no side-effects, deterministic, fully unit-testable.
 */
export function decideInitialMode(inputs: InitialModeInputs): InitialModeDecision {
  const { manualPreference, onboardingShown, omcInstalled } = inputs;

  if (manualPreference === true) {
    return { state: 'active' };
  }

  if (manualPreference === false) {
    return { state: 'inactive' };
  }

  // manualPreference is undefined — first run.
  if (omcInstalled && !onboardingShown) {
    return { state: 'show-onboarding' };
  }

  return { state: 'inactive' };
}

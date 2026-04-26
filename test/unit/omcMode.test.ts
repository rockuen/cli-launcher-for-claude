// Phase 4 — OMC mode state-machine tests.
//
// Only `decideInitialMode` is tested here — it is a pure function with no
// vscode dependency, so no mocking framework is needed.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { decideInitialMode } from '../../src/orchestration/core/omcModeLogic';

test('decideInitialMode: manualPreference=true → active', () => {
  const result = decideInitialMode({
    manualPreference: true,
    onboardingShown: false,
    omcInstalled: false,
  });
  assert.deepEqual(result, { state: 'active' });
});

test('decideInitialMode: manualPreference=false → inactive', () => {
  const result = decideInitialMode({
    manualPreference: false,
    onboardingShown: false,
    omcInstalled: true,
  });
  assert.deepEqual(result, { state: 'inactive' });
});

test('decideInitialMode: first run, OMC installed, onboarding not shown → show-onboarding', () => {
  const result = decideInitialMode({
    manualPreference: undefined,
    onboardingShown: false,
    omcInstalled: true,
  });
  assert.deepEqual(result, { state: 'show-onboarding' });
});

test('decideInitialMode: first run, OMC not installed → inactive', () => {
  const result = decideInitialMode({
    manualPreference: undefined,
    onboardingShown: false,
    omcInstalled: false,
  });
  assert.deepEqual(result, { state: 'inactive' });
});

test('decideInitialMode: onboarding already shown, OMC installed → inactive (no re-prompt)', () => {
  const result = decideInitialMode({
    manualPreference: undefined,
    onboardingShown: true,
    omcInstalled: true,
  });
  assert.deepEqual(result, { state: 'inactive' });
});

test('decideInitialMode: onboarding already shown, OMC not installed → inactive', () => {
  const result = decideInitialMode({
    manualPreference: undefined,
    onboardingShown: true,
    omcInstalled: false,
  });
  assert.deepEqual(result, { state: 'inactive' });
});

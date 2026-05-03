import { describe, it, expect, afterEach } from 'vitest';
import { getFixtureName } from './live-fixture.js';

describe('getFixtureName', () => {
  const originalValue = process.env.VAULTKIT_LIVE_FIXTURE_NAME;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.VAULTKIT_LIVE_FIXTURE_NAME;
    } else {
      process.env.VAULTKIT_LIVE_FIXTURE_NAME = originalValue;
    }
  });

  it('throws when VAULTKIT_LIVE_FIXTURE_NAME is unset', () => {
    delete process.env.VAULTKIT_LIVE_FIXTURE_NAME;
    expect(() => getFixtureName()).toThrow(/VAULTKIT_LIVE_FIXTURE_NAME is not set/);
  });

  it('returns the env value when set', () => {
    process.env.VAULTKIT_LIVE_FIXTURE_NAME = 'vk-live-shared-12345-67890';
    expect(getFixtureName()).toBe('vk-live-shared-12345-67890');
  });

  it('throws when env value is empty string', () => {
    process.env.VAULTKIT_LIVE_FIXTURE_NAME = '';
    expect(() => getFixtureName()).toThrow(/VAULTKIT_LIVE_FIXTURE_NAME is not set/);
  });
});

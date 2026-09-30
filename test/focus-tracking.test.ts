import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetWindowFocusTracking,
  shouldBringWindowToFront,
  bringWindowToFront,
} from '../src/lib/apply/launcher';

describe('Auto-Apply Window Focus Tracking', () => {
  beforeEach(() => {
    resetWindowFocusTracking();
  });

  it('allows window to come to front for the first job apply', () => {
    expect(shouldBringWindowToFront(false)).toBe(true);
  });

  it('blocks window from coming to front on subsequent job applies', () => {
    // First job apply brings window to front
    expect(shouldBringWindowToFront(false)).toBe(true);
    bringWindowToFront('Chrome', false);

    // Subsequent job applies must NOT bring window to front
    expect(shouldBringWindowToFront(false)).toBe(false);
    expect(shouldBringWindowToFront(false)).toBe(false);
  });

  it('allows forced focus (user intervention, captcha, login, manual button click)', () => {
    // Bring window to front once
    bringWindowToFront('Chrome', false);
    expect(shouldBringWindowToFront(false)).toBe(false);

    // Force focus overrides tracking
    expect(shouldBringWindowToFront(true)).toBe(true);
  });

  it('resets focus tracking when a new session or queue starts', () => {
    bringWindowToFront('Chrome', false);
    expect(shouldBringWindowToFront(false)).toBe(false);

    // New queue starts or user resets
    resetWindowFocusTracking();
    expect(shouldBringWindowToFront(false)).toBe(true);
  });
});

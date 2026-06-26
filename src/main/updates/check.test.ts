import { describe, it, expect } from 'vitest';
import { isNewer } from './check';

describe('isNewer', () => {
  it('detects a newer patch / minor / major', () => {
    expect(isNewer('0.0.20', '0.0.19')).toBe(true);
    expect(isNewer('0.1.0', '0.0.19')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  });

  it('is false for the same or an older version', () => {
    expect(isNewer('0.0.19', '0.0.19')).toBe(false);
    expect(isNewer('0.0.18', '0.0.19')).toBe(false);
    expect(isNewer('0.9.9', '1.0.0')).toBe(false);
  });

  it('compares the numeric core, ignoring -rc / build suffixes', () => {
    expect(isNewer('0.0.20-rc.1', '0.0.19')).toBe(true);
    // same core → not newer (an rc of the version you already run)
    expect(isNewer('0.0.19-rc.5', '0.0.19')).toBe(false);
  });

  it('returns false for unparseable input rather than throwing', () => {
    expect(isNewer('garbage', '0.0.1')).toBe(false);
    expect(isNewer('0.0.1', 'nope')).toBe(false);
  });
});

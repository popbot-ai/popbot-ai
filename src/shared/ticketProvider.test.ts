import { describe, it, expect } from 'vitest';
import { TICKET_PROVIDERS } from './ticketProvider';

describe('TICKET_PROVIDERS', () => {
  it('keys each provider by its own id', () => {
    for (const [key, meta] of Object.entries(TICKET_PROVIDERS)) {
      expect(meta.id).toBe(key);
      expect(meta.label.length).toBeGreaterThan(0);
    }
  });

  it('declares all capability flags as booleans (UI feature-detects these)', () => {
    const flags = ['changeStatus', 'projectFilter', 'priority', 'promoteOnSpawn'] as const;
    for (const meta of Object.values(TICKET_PROVIDERS)) {
      for (const flag of flags) {
        expect(typeof meta.capabilities[flag]).toBe('boolean');
      }
    }
  });

  it('ships Linear as a provider', () => {
    expect(TICKET_PROVIDERS.linear).toBeDefined();
    expect(TICKET_PROVIDERS.linear.capabilities.changeStatus).toBe(true);
  });
});

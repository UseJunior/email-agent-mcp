import { describe, it, expect } from 'vitest';
import { dedupThreadContent } from './dedup.js';

describe('content-engine/Thread Dedup (Stub for v1)', () => {
  it('Scenario: Quoted text preserved', () => {
    const body = 'Sounds good, let me review.\n\nOn March 1, Alice wrote:\n> Can you take a look at the attached contract?\n> Let me know your thoughts.';

    // v1: preserves the full quoted content (no stripping)
    const result = dedupThreadContent(body);
    expect(result).toContain('Sounds good, let me review');
    expect(result).toContain('On March 1, Alice wrote:');
    expect(result).toContain('Can you take a look at the attached contract?');
    expect(result).toBe(body); // no-op in v1
  });
});

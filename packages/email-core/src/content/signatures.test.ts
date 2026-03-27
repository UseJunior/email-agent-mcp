import { describe, it, expect } from 'vitest';
import { stripSignature } from './signatures.js';

describe('content-engine/Signature Stripping', () => {
  it('Scenario: Common signature pattern', () => {
    const body = 'Thanks for the update on the contract.\n\nLet me know if you need anything else.\n-- \nJohn Doe\nSenior Partner';

    const result = stripSignature(body);
    expect(result).toContain('Thanks for the update');
    expect(result).toContain('Let me know if you need anything else');
    expect(result).not.toContain('John Doe');
    expect(result).not.toContain('Senior Partner');
  });
});

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

  it('strips a mobile client footer in the latter half of the message', () => {
    const body = 'The revised agreement looks good to me.\n\nSent from my iPhone';

    expect(stripSignature(body)).toBe('The revised agreement looks good to me.');
  });

  it('strips a confidentiality disclaimer in the latter half of the message', () => {
    const body = [
      'The revised agreement looks good to me.',
      '',
      'CONFIDENTIALITY: This email is intended only for the named recipient.',
    ].join('\n');

    expect(stripSignature(body)).toBe('The revised agreement looks good to me.');
  });
});

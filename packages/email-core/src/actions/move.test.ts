import { describe, it, expect } from 'vitest';

// Spec: email-categorize — Requirements: Flag Email, Mark Read State, Move to Folder
// Tests written FIRST (spec-driven). Implementation pending.

describe('email-categorize/Flag Email', () => {
  it('Scenario: Flag as important', async () => {
    // WHEN flag_email is called with {id: "msg123"}
    // THEN sets the importance flag (Graph: flag, Gmail: star)
    expect.fail('Not implemented — awaiting flag_email action');
  });
});

describe('email-categorize/Mark Read State', () => {
  it('Scenario: Mark as read', async () => {
    // WHEN mark_read is called with {id: "msg123"}
    // THEN marks the email as read
    expect.fail('Not implemented — awaiting mark_read action');
  });
});

describe('email-categorize/Move to Folder', () => {
  it('Scenario: Archive email', async () => {
    // WHEN move_to_folder is called with {id: "msg123", folder: "archive"}
    // THEN moves the email to the archive folder
    expect.fail('Not implemented — awaiting move_to_folder action');
  });
});

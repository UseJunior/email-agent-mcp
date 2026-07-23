import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForLiveMailbox } from './launch-prep-smoke.mjs';

const connected = {
  name: 'work@example.com',
  provider: 'microsoft',
  status: 'connected',
  isDefault: true,
  warnings: [],
};

test('launch smoke accepts an immediately connected mailbox', async () => {
  let calls = 0;
  const result = await waitForLiveMailbox(async () => {
    calls += 1;
    return connected;
  });

  assert.equal(result, connected);
  assert.equal(calls, 1);
});

test('launch smoke waits for lazy initialization to connect', async () => {
  const statuses = [
    {
      name: 'pending',
      provider: 'pending',
      status: 'connecting',
      isDefault: false,
      warnings: ['Authenticating — provider is warming up'],
    },
    connected,
  ];
  const delays = [];
  let mailboxArgument = '';

  const result = await waitForLiveMailbox(
    async () => {
      mailboxArgument = 'work';
      return statuses.shift();
    },
    {
      delay: async milliseconds => {
        delays.push(milliseconds);
      },
    },
  );

  assert.equal(result, connected);
  assert.equal(mailboxArgument, 'work');
  assert.deepEqual(delays, [250]);
});

test('launch smoke fails immediately for a terminal mailbox state', async () => {
  let calls = 0;

  await assert.rejects(
    waitForLiveMailbox(async () => {
      calls += 1;
      return {
        name: 'none',
        provider: 'none',
        status: 'not configured',
        isDefault: false,
        warnings: ['Run email-agent-mcp configure'],
      };
    }),
    /Live mailbox not configured/,
  );

  assert.equal(calls, 1);
});

test('launch smoke times out with the last status and warnings', async () => {
  let nowMs = 0;
  let calls = 0;

  await assert.rejects(
    waitForLiveMailbox(
      async () => {
        calls += 1;
        return {
          name: 'pending',
          provider: 'pending',
          status: 'connecting',
          isDefault: false,
          warnings: ['still warming up'],
        };
      },
      {
        timeoutMs: 500,
        pollIntervalMs: 200,
        now: () => nowMs,
        delay: async milliseconds => {
          nowMs += milliseconds;
        },
      },
    ),
    error => {
      assert.match(error.message, /within 500ms/);
      assert.match(error.message, /Last status: connecting/);
      assert.match(error.message, /still warming up/);
      return true;
    },
  );

  assert.equal(calls, 4);
});

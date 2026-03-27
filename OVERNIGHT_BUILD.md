# agent-email — Overnight Implementation Loop

## How to Run

Paste this into a new Claude Code session in `~/Projects/agent-email`:

```
/ralph-loop Implement the agent-email spec, one spec at a time, until all tests pass. Follow the instructions in OVERNIGHT_BUILD.md exactly. --max-iterations 50 --completion-promise 'All tests pass and spec coverage is 100%'
```

---

## Your Task

You are implementing `agent-email` — an open-source MCP server for email connectivity. The test suite and specs are already written. Your job is to make all the tests pass by implementing the actual code, one spec at a time.

## Essential Files to Read First

1. `AGENTS.md` — project conventions (TypeScript ESM, snake_case tools, stderr logging)
2. `TEST_PLAN.md` — test suite structure and traceability pattern
3. `~/.claude/plans/abstract-humming-flute.md` — the full approved architecture plan
4. `openspec/project.md` — tech stack, security defaults, multi-mailbox design

## The Loop

Each iteration:

### Step 1: Assess Current State

```bash
npm run test:run 2>&1 | tail -40       # How many tests pass/fail?
npm run check:spec-coverage 2>&1       # Which specs have test coverage?
git log --oneline -5                   # What was done in previous iterations?
```

### Step 2: Pick the Next Spec

Work through specs in this order (dependencies flow downward):

| Priority | Spec | Package | Why This Order |
|----------|------|---------|---------------|
| 1 | `provider-interface` | email-core | Interfaces first — everything depends on these |
| 2 | `content-engine` | email-core | Content transformation — used by read actions |
| 3 | `email-security` | email-core | Allowlists — used by write actions |
| 4 | `email-read` | email-core | Read actions — simplest, test the action pattern |
| 5 | `email-write` | email-core | Write actions — depends on security + content |
| 6 | `email-categorize` | email-core | Categorize actions |
| 7 | `email-threading` | email-core | Threading — depends on read |
| 8 | `email-attachments` | email-core | Attachment handling |
| 9 | `mailbox-config` | email-core | Multi-mailbox config actions |
| 10 | `observability` | email-core | Logging infrastructure |
| 11 | `provider-microsoft` | provider-microsoft | Graph API provider |
| 12 | `provider-gmail` | provider-gmail | Gmail provider |
| 13 | `mcp-transport` | email-mcp | MCP server adapter |
| 14 | `cli` | email-mcp | CLI entry point |
| 15 | `email-watcher` | email-mcp | Watcher process |

**Rule**: Only move to the next spec when ALL tests for the current spec pass.

### Step 3: Implement

For each spec:

1. **Read the spec**: `openspec/specs/{spec-name}/spec.md`
2. **Read the tests**: find the test file(s) for this spec (see TEST_PLAN.md mapping)
3. **If tests don't exist yet**: create them following the TEST_PLAN.md pattern — `describe('spec-id/requirement')` → `it('Scenario: ...')`
4. **Implement the source code** to make tests pass
5. **Run tests**: `npm run test:run -- --reporter=verbose 2>&1`
6. **Fix failures**: iterate until all tests for this spec pass
7. **Commit**: `git add -A && git commit -m "Implement {spec-name} spec"`

### Step 4: Verify and Continue

```bash
npm run test:run 2>&1 | tail -5       # Confirm no regressions
npm run build 2>&1                     # Confirm it compiles
```

If tests pass for the current spec and no regressions, move to the next spec. If there are regressions, fix them before moving on.

## Implementation Rules

### TypeScript Conventions
- ESM with explicit `.js` suffixes in imports: `import { Foo } from './foo.js';`
- `snake_case` for action names, `PascalCase` for types
- Strict mode — no `any` types unless absolutely necessary
- All actions defined in `packages/email-core/src/actions/`

### Action Pattern (DRY)
Every action follows this pattern:

```typescript
// packages/email-core/src/actions/list.ts
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import type { EmailProvider } from '../providers/provider.js';

const ListEmailsInput = z.object({
  mailbox: z.string().optional(),
  unread: z.boolean().optional(),
  limit: z.number().optional().default(25),
  folder: z.string().optional().default('inbox'),
});

const ListEmailsOutput = z.object({
  emails: z.array(z.object({
    id: z.string(),
    subject: z.string(),
    from: z.string(),
    receivedAt: z.string(),
    isRead: z.boolean(),
    hasAttachments: z.boolean(),
  })),
});

export const listEmailsAction: EmailAction<
  z.infer<typeof ListEmailsInput>,
  z.infer<typeof ListEmailsOutput>
> = {
  name: 'list_emails',
  description: 'List recent emails with filtering',
  input: ListEmailsInput,
  output: ListEmailsOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (provider, input) => {
    const messages = await provider.listMessages({
      unread: input.unread,
      limit: input.limit,
      folder: input.folder,
    });
    return { emails: messages.map(m => ({ /* map fields */ })) };
  },
};
```

### Mock Provider for Tests
Create a `MockEmailProvider` in `packages/email-core/src/testing/mock-provider.ts` that implements all capability interfaces with in-memory data:

```typescript
export class MockEmailProvider implements EmailReader, EmailSender {
  private messages: EmailMessage[] = [];

  addMessage(msg: EmailMessage): void { this.messages.push(msg); }

  async listMessages(opts: ListOptions): Promise<EmailMessage[]> {
    let results = [...this.messages];
    if (opts.unread) results = results.filter(m => !m.isRead);
    if (opts.limit) results = results.slice(0, opts.limit);
    return results;
  }
  // ... implement all interface methods
}
```

### Security Implementation
- Send allowlist: load from `AGENT_EMAIL_SEND_ALLOWLIST` env var (path to JSON file) at startup
- Receive allowlist: load from `AGENT_EMAIL_RECEIVE_ALLOWLIST` env var
- Check allowlist in the action's `run()` method, before calling the provider
- No MCP tool to modify allowlists

### MCP Server (~100 lines)
The MCP server auto-registers all actions:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EMAIL_ACTIONS } from '@usejunior/email-core';

function createServer(): Server {
  const server = new Server({ name: 'agent-email', version: '0.1.0' },
    { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: EMAIL_ACTIONS.map(a => ({
      name: a.name,
      description: a.description,
      inputSchema: zodToJsonSchema(a.input),
      annotations: a.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const action = EMAIL_ACTIONS.find(a => a.name === req.params.name);
    if (!action) throw new Error(`Unknown tool: ${req.params.name}`);
    const input = action.input.parse(req.params.arguments);
    const result = await action.run(provider, input);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}
```

### Logging
- Use `console.error()` for all logging (goes to stderr)
- NEVER use `console.log()` in the MCP server (corrupts stdio transport)

## Completion Criteria

The loop ends when ALL of these are true:
1. `npm run test:run` — all tests pass (0 failures)
2. `npm run build` — all packages compile (0 errors)
3. `npm run check:spec-coverage` — all spec scenarios have matching tests
4. Every spec (1-15) has been implemented and committed

When all conditions are met, output:
```
<promise>All tests pass and spec coverage is 100%</promise>
```

## What NOT to Do

- Do NOT skip tests or mark them as `.skip`
- Do NOT modify spec files (they are the source of truth)
- Do NOT add dependencies beyond what's in the plan (zod, MCP SDK, Graph client, Gmail client, vitest)
- Do NOT use `console.log()` in any source file
- Do NOT implement features not in the specs
- Do NOT spend more than 3 iterations on a single spec — if stuck, commit progress, leave a TODO comment, and move to the next spec

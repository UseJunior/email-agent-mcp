# agent-email Test Suite — Implementation Brief

## Objective

Build a comprehensive test suite for `~/Projects/agent-email` that **traces every test back to an OpenSpec scenario**. Tests are written FIRST (before implementation code). Each test should fail initially and pass once the corresponding feature is implemented.

## Repository Context

- **This repo**: `~/Projects/agent-email` — TypeScript monorepo, 5 npm workspace packages, Vitest
- **Reference repo**: `~/Projects/safe-docx` — same monorepo pattern, has a working spec-traceability system
- **Plan file**: `~/.claude/plans/abstract-humming-flute.md` — approved architecture plan with full details
- **15 OpenSpec specs** in `openspec/specs/` — each has Requirements with `#### Scenario:` entries

## Traceability Pattern

Every test must tie back to an OpenSpec scenario. Use a lightweight `describe/it` naming convention (no Allure for now):

```typescript
// Pattern: describe("spec-id/requirement-name") → it("Scenario: exact scenario name")
describe('email-read/list-emails', () => {
  it('Scenario: List unread emails from inbox', async () => {
    // WHEN list_emails is called with {unread: true, limit: 10}
    // THEN returns up to 10 unread emails from default inbox
  });

  it('Scenario: Default limit applied', async () => {
    // WHEN list_emails is called with no limit
    // THEN a default limit (25) is applied
  });
});
```

The `describe` block names the spec and requirement (`spec-id/requirement-name`). The `it` block names the exact scenario from the spec. This makes it trivial to grep for coverage gaps.

## Spec Coverage Validation

Create a script at `scripts/check-spec-coverage.mjs` that:
1. Parses all `#### Scenario:` entries from `openspec/specs/*/spec.md`
2. Scans all `*.test.ts` files for `it('Scenario: ...')` strings
3. Reports which scenarios have tests and which are uncovered
4. Exits non-zero if any scenario lacks a test

Add to root `package.json`: `"check:spec-coverage": "node scripts/check-spec-coverage.mjs"`

Reference: `~/Projects/safe-docx/packages/docx-mcp/scripts/validate_openspec_coverage.mjs`

## Package Test Layout

Tests live alongside source in each package (Vitest convention):

```
packages/
├── email-core/src/
│   ├── actions/
│   │   ├── list.ts              # (not yet implemented)
│   │   ├── list.test.ts         # ← tests for list_emails action
│   │   ├── send.ts
│   │   ├── send.test.ts         # ← tests for send_email action
│   │   └── ...
│   ├── content/
│   │   ├── sanitize.test.ts     # ← content-engine spec tests
│   │   └── ...
│   └── security/
│       ├── send-allowlist.test.ts
│       └── receive-allowlist.test.ts
├── provider-microsoft/src/
│   ├── email-graph-provider.test.ts
│   └── ...
├── provider-gmail/src/
│   └── email-gmail-provider.test.ts
├── email-mcp/src/
│   ├── server.test.ts           # MCP transport tests
│   └── watcher.test.ts          # Watcher tests
```

## Spec-to-Test Mapping (all 15 specs)

| Spec | Package | Test File(s) | Scenarios to Cover |
|------|---------|-------------|-------------------|
| email-read | email-core | `actions/list.test.ts`, `actions/read.test.ts`, `actions/search.test.ts` | 5 scenarios |
| email-write | email-core | `actions/reply.test.ts`, `actions/send.test.ts` | 11 scenarios |
| email-categorize | email-core | `actions/label.test.ts`, `actions/move.test.ts` | 7 scenarios |
| email-threading | email-core | `actions/conversation.test.ts` | 4 scenarios |
| email-security | email-core | `security/send-allowlist.test.ts`, `security/receive-allowlist.test.ts` | 12 scenarios |
| email-attachments | email-core | `actions/attachments.test.ts` | 6 scenarios |
| content-engine | email-core | `content/sanitize.test.ts`, `content/signatures.test.ts`, `content/dedup.test.ts` | 6 scenarios |
| mailbox-config | email-core | `actions/configure.test.ts`, `actions/status.test.ts` | 7 scenarios |
| provider-interface | email-core | `providers/provider.test.ts` | 5 scenarios |
| provider-microsoft | provider-microsoft | `email-graph-provider.test.ts`, `auth.test.ts`, `subscriptions.test.ts` | 15 scenarios |
| provider-gmail | provider-gmail | `email-gmail-provider.test.ts`, `auth.test.ts`, `push.test.ts` | 5 scenarios |
| mcp-transport | email-mcp | `server.test.ts` | 5 scenarios |
| cli | email-mcp | `cli.test.ts` | 6 scenarios |
| email-watcher | email-mcp | `watcher.test.ts` | 8 scenarios |
| observability | email-core | `observability.test.ts` | 7 scenarios |

**Total: ~100 scenarios across 15 specs.**

## Testing Approach

1. **Unit tests with mock providers** — email-core actions are tested against a `MockEmailProvider` that implements the capability interfaces. No real API calls.

2. **Provider tests with mock HTTP** — provider-microsoft and provider-gmail tests mock HTTP responses (use `msw` or manual mocks). Test Graph-specific quirks: validation token GET+POST, webhook dedup at 9ms, zombie detection, createReplyAll flow.

3. **MCP integration tests** — use `@modelcontextprotocol/sdk` test client to connect to the server via stdio and verify tool listing + dispatch.

4. **Security tests** — explicitly test allowlist enforcement, path traversal rejection for body_file, binary file detection, error sanitization.

## Key Testing Priorities (from production wisdom)

These are patterns that broke in production in `junior-AI-email-bot`. Test them first:

- **Send allowlist blocks replies when empty** (not just sends)
- **Validation token works on both GET and POST**
- **Webhook dedup with <10ms gap between duplicates**
- **body_file rejects `../` traversal, symlinks, binary files**
- **Graceful truncation at 3.5MB** (don't cut inside HTML tags)
- **Binary file detection from actual bytes** (not declared content type)
- **Error sanitization strips file paths and API keys**
- **Multi-mailbox: write actions fail when mailbox omitted with >1 configured**
- **Content engine preserves tables and strips tracking pixels**

## How to Start

```bash
cd ~/Projects/agent-email
npm install                        # install workspace deps
# Then create test files following the pattern above
# Each test should initially fail (no implementation yet)
npm run test:run                   # verify tests exist and fail
npm run check:spec-coverage        # verify all scenarios have tests
```

## Reference Files

- Approved plan: `~/.claude/plans/abstract-humming-flute.md`
- 15 spec files: `openspec/specs/*/spec.md`
- safe-docx traceability script: `~/Projects/safe-docx/packages/docx-mcp/scripts/validate_openspec_coverage.mjs`
- safe-docx test examples: `~/Projects/safe-docx/packages/docx-mcp/src/tools/*.test.ts`
- Graph subscription wisdom: search `junior-AI-email-bot` for `docs/wisdom/deployment/webhook-*` and `app/routers/webhook.py`

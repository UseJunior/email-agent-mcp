## Why

`read_email` returns the full MIME body including all nested reply chains. A 3-line reply in a long thread can return ~12 KB where ~99% is `>>>>>>>>>>>` history the LLM caller already has from earlier turns. There is no opt-in to strip quoted history today, even though the cost of the wasted context is borne entirely by the agent consumer.

## What Changes

- Add an opt-in `strip_quoted_history: boolean` parameter (default `false`) to the `read_email` action and MCP tool.
- When `true`, detect a **terminal** quoted-history block — Gmail/Apple "On … wrote:" preamble, Outlook header cluster, or terminal `>`-prefix run — and replace it with a `[...prior thread truncated]` marker.
- Operate on already-normalized text emitted by the existing content engine (`transformEmailContent`); do not re-process raw HTML.
- Refactor the MCP `read_email` tool from a hand-rolled duplicate into a thin adapter that delegates to `readEmailAction.run(...)`, restoring the "actions are the single source of truth, MCP is a thin adapter" convention.

## Impact

- Affected specs: `email-read`
- Affected code: `packages/email-core/src/content/`, `packages/email-core/src/actions/read.ts`, `packages/email-core/src/index.ts`, `packages/email-mcp/src/server.ts`
- User-visible behavior: callers that pass `strip_quoted_history: true` receive a body with the terminal quoted-history block replaced by a short marker. Default behavior is unchanged. Inline blockquotes the user wrote in their latest reply are preserved.

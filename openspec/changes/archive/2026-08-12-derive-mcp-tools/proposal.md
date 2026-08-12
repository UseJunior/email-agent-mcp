# Derive MCP Tools From Actions

## Why

The MCP server hand-maintains its core-backed tool list despite `EMAIL_ACTIONS` being the canonical action registry. New actions can silently fail to reach MCP clients.

## What Changes

- Derive standard MCP tools from `EMAIL_ACTIONS`.
- Keep the five state-aware tools as explicit overrides.
- Make intentionally non-MCP configuration actions an explicit asserted exclusion, if they remain in the canonical registry.
- Add parity coverage preventing registry/tool-list drift.

## Impact

- Affected specs: `mcp-transport`
- Affected code: `email-mcp` server and tests

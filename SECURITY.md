# Security Policy

## Supported Versions

Security fixes are prioritized for the latest published `0.x` release line and `main`.

## Reporting a Vulnerability

Please report vulnerabilities privately to `steven@usejunior.com`.

Include:

- affected package(s) and version(s)
- reproduction steps or proof of concept
- impact assessment
- suggested mitigation (if available)

Do not open a public issue for an unpatched vulnerability.

## Response Expectations

- Initial acknowledgement target: within 3 business days.
- Triage and severity assessment target: within 7 business days.
- Fix timeline depends on severity and complexity.

## Scope Notes

- `email-agent-mcp` handles OAuth tokens (Microsoft MSAL, Gmail OAuth) and email content locally.
- Credentials are stored in the OS keychain (MSAL) and local config files under `~/.email-agent-mcp/`.
- The MCP server runs locally over stdio transport; no network listener is exposed.
- Send/receive allowlists and the delete-disabled-by-default policy are security-critical features — bypasses are in scope.
- External dependencies (Graph API, Gmail API, MCP SDK) are monitored through normal dependency updates and CI.

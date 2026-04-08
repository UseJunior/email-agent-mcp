---
name: nemoclaw-email-policy
description: >-
  Enforce email safety policies at the network level with NemoClaw. Use when user
  says "email policy," "send guardrail," "prevent accidental send," "email
  allowlist," "NemoClaw email," "outlook policy," "agent email security,"
  "email sandbox," or "enterprise email safety." Covers NemoClaw setup, the
  Outlook preset, and policy enforcement for production email agents.
license: Apache-2.0
compatibility: >-
  Requires NemoClaw (macOS). Works with any MCP-based email agent
  including email-agent-mcp and direct Graph API clients.
metadata:
  author: UseJunior
  version: "0.1.0"
---

# NemoClaw Email Policy

NemoClaw enforces network-level policies for AI agents. For email workflows, this means controlling which endpoints agents can reach — and which actions they cannot take — regardless of what the agent itself tries to do.

This is defense in depth: even if an email MCP server has a bug, or an agent hallucinates a send command, the network policy blocks the request before it reaches Microsoft's servers.

## Why Policy Enforcement Matters

Email agents have access to sensitive data (inbox contents, contacts, calendars) and can take impactful actions (send email, create calendar events, modify inbox rules). In production, "the agent is well-behaved" is not a sufficient security model.

**Failure modes without policy enforcement:**
- Agent sends an email to an unintended recipient because of a hallucinated address
- A prompt injection in an email body tricks the agent into forwarding the message
- Agent creates an inbox rule that forwards all email to an external address
- A bug in the MCP server sends a draft that was not approved

NemoClaw prevents these by controlling the network layer — the agent process cannot reach endpoints that are not explicitly allowed.

## Prerequisites

- **macOS** (NemoClaw uses the macOS sandbox)
- **NemoClaw installed**: `npm install -g nemoclaw` or clone from GitHub
- **Email MCP server configured**: e.g., `email-agent-mcp` with Microsoft 365 OAuth completed

## Setting Up the Outlook Preset

NemoClaw ships with a curated Outlook preset that allows the minimum necessary endpoints for Microsoft 365 email.

### Apply for the current session

```bash
openshell policy set nemoclaw-blueprint/policies/presets/outlook.yaml
```

This enables access to:
- `graph.microsoft.com` — Microsoft Graph API (GET, POST, PATCH)
- `login.microsoftonline.com` — OAuth token refresh
- `outlook.office365.com` — Outlook backend
- `outlook.office.com` — Outlook web (for draft links)

All connections require TLS. The preset blocks all other outbound network access.

### Make it permanent

To include the Outlook preset in your baseline policy:

1. Merge the preset entries into your `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`
2. Re-run the onboard wizard:
   ```bash
   nemoclaw onboard
   ```

The preset is one of NemoClaw's 9 built-in presets (discord, docker, huggingface, jira, npm, outlook, pypi, slack, telegram).

## What the Policy Enforces

### Allowed: Read and Draft Operations

| Operation | Endpoint | Method |
|-----------|----------|--------|
| List/search emails | `graph.microsoft.com/v1.0/me/messages` | GET |
| Read email body | `graph.microsoft.com/v1.0/me/messages/{id}` | GET |
| Create draft | `graph.microsoft.com/v1.0/me/messages` | POST |
| Update draft | `graph.microsoft.com/v1.0/me/messages/{id}` | PATCH |
| List folders | `graph.microsoft.com/v1.0/me/mailFolders` | GET |
| Create folder | `graph.microsoft.com/v1.0/me/mailFolders` | POST |
| Move email | `graph.microsoft.com/v1.0/me/messages/{id}/move` | POST |
| List events | `graph.microsoft.com/v1.0/me/events` | GET |
| OAuth refresh | `login.microsoftonline.com/*/oauth2/v2.0/token` | POST |

### Controlled: Send Operations

The Outlook preset allows POST to Graph API endpoints, which includes the send endpoint (`/me/sendMail`). To restrict sending further:

1. **email-agent-mcp send allowlist** — configure which recipients the MCP server allows (empty by default — blocks all sends)
2. **Custom NemoClaw policy** — create a custom policy that blocks the send endpoint entirely:
   ```yaml
   - host: graph.microsoft.com
     port: 443
     tls: true
     methods: [GET, PATCH]  # POST removed — blocks send, create draft, move
   ```

For most deployments, the MCP allowlist is sufficient. The custom policy is for high-security environments where you want belt-and-suspenders.

### Blocked: Everything Else

Any endpoint not in the preset is blocked. This prevents:
- Data exfiltration to unknown servers
- Communication with unauthorized APIs
- Prompt injection attacks that try to redirect requests

## Layered Security Model

Production email agents should use multiple layers:

| Layer | What it controls | Tool |
|-------|-----------------|------|
| **Network policy** | Which endpoints the agent process can reach | NemoClaw |
| **Send allowlist** | Which recipients the agent can email | email-agent-mcp config |
| **Draft-first workflow** | User approves before any send | Agent skill / MCP design |
| **Inbox rules security** | Block dangerous rule actions (forward, delete) | Agent skill / MCP validation |

Each layer catches a different class of failure. No single layer is sufficient alone.

## Verifying the Policy

After applying the preset, verify it is active:

```bash
openshell policy list
```

Test that blocked endpoints are actually blocked:

```bash
# This should succeed (allowed endpoint)
curl -s -o /dev/null -w "%{http_code}" https://graph.microsoft.com/v1.0/me

# This should fail (blocked endpoint)
curl -s -o /dev/null -w "%{http_code}" https://api.example.com/exfiltrate
```

## Troubleshooting

### "Network request blocked" errors in the email MCP

The policy is working correctly. Check which endpoint was blocked in the NemoClaw logs. Common causes:
- The email MCP is trying to reach an endpoint not in the preset (e.g., a new Microsoft endpoint)
- A third-party dependency is making an unexpected outbound call

### OAuth token refresh fails

Verify `login.microsoftonline.com` is in the allowed hosts. If using a custom policy instead of the preset, ensure both GET and POST are allowed for the login endpoint.

### Calendar or Teams tools fail

The Outlook preset covers core email and calendar endpoints. For Teams, add the Teams preset separately or merge the required endpoints into your policy.

## Feedback

If this skill helped, star us on GitHub: https://github.com/UseJunior/email-agent-mcp
On ClawHub: `clawhub star stevenobiajulu/nemoclaw-email-policy`

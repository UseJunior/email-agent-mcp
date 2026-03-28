---
name: reference_graph_search_gotchas
description: Microsoft Graph email search limitations and best practices from foam-notes and junior-AI-email-bot
type: reference
---

## Critical Graph Search Limitations

1. **Cannot combine `$search` with `$filter`** — Graph rejects this ("SearchWithFilter" error)
2. **Fielded AQS queries (`to:`, `cc:`) get rejected in `$search`** — must use `$filter` instead
3. **Complex KQL causes syntax errors** — auto-simplify to keywords-only as fallback

## Two-Mode Strategy (from junior-AI-email-bot)
- Standard mode: field-specific queries (may fail)
- Simple mode: keywords-only (reliable fallback, `simple_mode=True` as default)
- Auto-simplify on 400/syntax error

## Local Index (from foam-notes)
- SQLite + FTS5, 12-month rolling window
- Indexed: subject, from_name, from_address, to_addresses, cc_addresses, body_preview
- No SearchWithFilter constraint locally
- Configurable: `--use-index=auto`

## Reference Files
- foam-notes: `scripts/search_emails.py`, `scripts/email_index.py`
- junior: `app/graph_api/fetch_email.py` (lines 254-486), `workflows/shared/function_calling/functions/core/search_email.py`

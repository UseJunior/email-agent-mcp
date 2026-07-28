# @usejunior/email-agent-mcp

Compatibility package for existing scoped-package users.

The canonical distribution is [`email-agent-mcp`](https://www.npmjs.com/package/email-agent-mcp):

```bash
npx -y email-agent-mcp
```

Both package names are published from the same release and resolve to the same
CLI and MCP server implementation. New installations should use the unscoped
package.

## Body formats

The compose tools (`send_email`, `reply_to_email`, `create_draft`,
`update_draft`) accept an optional `format`: `markdown` (default, rendered as
GFM), `html` (unsanitised passthrough — your markup and inline CSS are not
sanitised or rewritten), or `text` — plus `force_black` (default true), which wraps
rendered HTML in a `<div style="color: #000000;">` so Outlook dark mode does
not hide the text. `read_email` accepts `format: "html"` to return the
message's raw body HTML instead of the markdown default. When writing raw HTML
back, pass `format: "html"` **and** `force_black: false` — otherwise each
round trip nests another force-black wrapper.

See the [`email-agent-mcp` package README](https://www.npmjs.com/package/email-agent-mcp)
for the full tool reference.

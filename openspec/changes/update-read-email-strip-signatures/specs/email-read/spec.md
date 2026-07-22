## ADDED Requirements

### Requirement: Optional Signature Stripping on the MCP Read Surface

The MCP `read_email` tool SHALL accept an optional `strip_signatures` boolean parameter and forward it to the underlying read action, rather than hardcoding a value.

The MCP-level default SHALL be `false`, preserving the body existing MCP callers receive today. This differs deliberately from the core action's own default of `true`: adopting `true` at the transport layer would silently change the content returned to every existing caller. The tool description SHALL mention the flag so callers can discover it.

When both stripping flags are set, the transforms SHALL apply in the established order — quoted-history stripping first, then signature stripping — so the two are composable rather than mutually exclusive.

The two transforms interact. Signature stripping cuts everything from the RFC-3676 `-- ` delimiter onward, so when a signature precedes the quoted-history block, the signature pass also removes the truncation marker that quote stripping inserted. The requirement is that both the signature and the quoted history are gone and the authored text survives; the marker is NOT guaranteed to appear in that shape.

#### Scenario: Signatures stripped when the flag is requested
- **WHEN** the MCP `read_email` tool is called with `{id: "msg123", strip_signatures: true}` on a message ending in an RFC-3676 `-- ` delimited signature
- **THEN** the returned body has the signature block removed
- **AND** the authored message text above it is preserved

#### Scenario: Signatures preserved by default over MCP
- **WHEN** the MCP `read_email` tool is called with `{id: "msg123"}` and no `strip_signatures`
- **THEN** the returned body retains the signature block, identical to current MCP behavior

#### Scenario: Both stripping flags compose
- **WHEN** the MCP `read_email` tool is called with `{id: "msg123", strip_signatures: true, strip_quoted_history: true}` on a message whose RFC-3676 signature sits immediately before a terminal quoted-history block
- **THEN** the returned body contains neither the signature nor the quoted history
- **AND** the authored reply text is preserved
- **AND** the truncation marker is not required to survive, because signature stripping cuts from a delimiter that precedes it

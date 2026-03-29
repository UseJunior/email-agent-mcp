// Type shim for HeadersInit used by @modelcontextprotocol/sdk transport types.
// This avoids adding the full DOM lib just for this one type.
type HeadersInit = [string, string][] | Record<string, string> | Headers;

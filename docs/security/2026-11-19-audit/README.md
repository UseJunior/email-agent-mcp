# Distribution dependency audit, 2026-11-19

Machine-readable full and production-only snapshots before/after are adjacent JSON files. Production findings fall from 18 (1 critical, 10 high, 7 moderate) to zero. Full audit critical findings fall from 2 to zero. CI now runs `npm audit --omit=dev --audit-level=high`; this rejects any production high/critical advisory, including newly disclosed drift on unchanged dependencies.

Updated compatible lockfile ranges, plus `@googleapis/gmail` 4 → 22 and `google-auth-library` 8 → 11 together. The generated Gmail client and its common/auth library must share the current OAuth2Client class; mixing auth major versions fails TypeScript due to private member identity. Auth, broker refresh, API request-shape and Microsoft cache-path suites are retained. No force audit fix or package downgrade was used.

| Before production finding | Runtime path and exposure | Resolution |
| --- | --- | --- |
| @azure/identity, @azure/msal-node | Microsoft token acquisition and cached auth; authentication input/redirect handling | Compatible dependency refresh |
| @azure/identity-cache-persistence | Microsoft native cache integration; local credential persistence | Compatible dependency refresh |
| @googleapis/gmail, googleapis-common, uuid | Gmail API/auth HTTP client; old common/auth transitive dependencies | Gmail 22 + auth 11 |
| @modelcontextprotocol/sdk, @hono/node-server, hono | MCP adapter transport/HTTP support; default deployment is local stdio, HTTP paths not the default entry point | Compatible dependency refresh |
| express-rate-limit, body-parser, proxy-addr, qs | SDK HTTP stack, including proxy-address/body parsing; critical proxy-addr path is transitive | Compatible dependency refresh |
| fast-uri | Schema/URI handling in dependency chain; may process untrusted structured inputs | Compatible dependency refresh |
| marked | Markdown email-body rendering; authored content can be untrusted | Compatible dependency refresh |
| ip-address | HTTP/proxy network address processing in dependency graph | Compatible dependency refresh |
| node-forge | Certificate/cryptography support in dependency graph | Compatible dependency refresh |
| zod | Tool argument/schema parsing at the MCP boundary | Compatible dependency refresh |

The full audit retains nine development findings under the `@vercel/node` 5 build/type package (busboy, undici, path-to-regexp, nft/static-config, glob/minimatch and ajv). Broker handlers import its request/response types using `import type`; these imports erase from the deployed handler JavaScript and the package is not part of npm production dependency closure. npm recommends downgrading @vercel/node to 4, which is not adopted without runtime compatibility review. No production risk exception is introduced.

The deprecated broker `@vercel/kv` client is retained pending the hosting decision in #112 as requested in #147. That hosting migration and the development build-tool findings remain tracked by #147; this PR fixes the distribution blocker rather than claiming the entire epic is finished.

The patched Google and Azure releases declare Node >=22. Package engine metadata is raised to >=22 throughout the suite, and CI now tests Node 22 and 24. This is a deliberate minimum-runtime change to avoid advertising unsupported Node 20 compatibility; the release must call it out.

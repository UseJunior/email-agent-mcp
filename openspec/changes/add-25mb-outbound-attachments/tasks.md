## 1. Specification and validation

- [x] Specify the 25 MB per-attachment limit and provider upload routing
- [x] Verify MCP/action validation returns a clear error above 25 MB

## 2. Microsoft Graph

- [x] Add authenticated upload-session creation and chunk PUT support
- [x] Route large direct sends, drafts, replies, updates, and scheduled sends through draft attachment uploads
- [x] Add threshold, chunking, and oversize tests

## 3. Gmail

- [x] Add raw MIME multipart media uploads for messages above 5 MB
- [x] Cover send, create draft, and update draft upload routing in tests

## 4. Documentation and verification

- [x] Update provider and root documentation
- [x] Run OpenSpec validation, type checks, and relevant/full tests

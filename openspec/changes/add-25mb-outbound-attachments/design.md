# Design: Provider upload paths for 25 MB attachments

## Microsoft Graph

Small attachment sets may remain inline. When any attachment or the combined encoded payload crosses the conservative inline threshold, create the message as a draft without attachments, add every attachment through the draft attachment collection, and then send when the caller requested immediate delivery. Attachments above the inline threshold use `createUploadSession`; their bytes are sent in sequential chunks whose sizes are multiples of 320 KiB.

This draft-first route also covers replies and scheduled messages because those operations already prepare a draft before delivery. Provider validation independently rejects any individual file above 25 MB so callers that bypass the action layer still receive a clear error.

## Gmail

Continue using Gmail's JSON `raw` request for encoded messages at or below 5 MB. Decode the already-built base64url MIME message and use the endpoint's multipart media-upload form above that threshold. Thread metadata stays in the JSON metadata part while the RFC 822 bytes are supplied as `message/rfc822` media.

## Failure behavior

Upload failures before a send are terminal and leave a draft where Graph has already created one. Delivery calls preserve the existing ambiguous-delivery classification. Draft attachment replacement remains non-atomic because Graph exposes delete and upload as separate operations; existing partial-update errors continue to identify that state.

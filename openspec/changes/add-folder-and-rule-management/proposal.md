## Why

Agents can only organize messages reactively today. Microsoft 365 users cannot create custom folders or server-side inbox rules, so recurring mail must be rediscovered and moved during every agent session instead of being handled continuously by Exchange.

## What Changes

- Add `list_folders`, `create_folder`, and `delete_folder` actions backed by a new `EmailFolderManager` provider capability.
- Recursively enumerate Microsoft Graph mail folders across every page, expose computed paths, and resolve custom folder names or paths for `move_to_folder`.
- Add a 60-second folder resolver cache that is invalidated after folder creation or deletion.
- Protect well-known/system folders from `delete_folder`, whether they are requested by well-known name or resolved Graph id.
- Add `list_inbox_rules`, `create_inbox_rule`, and `delete_inbox_rule` actions backed by a new `EmailRuleManager` provider capability.
- Return faithful Graph inbox-rule data when listing rules, while limiting rule creation to safe actions and rejecting `forwardTo`, `forwardAsAttachmentTo`, `redirectTo`, and `delete` with a typed error.
- Require callers to affirm that a human approved every `create_inbox_rule` request.
- Add the delegated Microsoft Graph `MailboxSettings.ReadWrite` scope. Existing Microsoft accounts must re-consent before using folder and inbox-rule management.
- Leave Gmail unchanged: Gmail uses labels and does not provide the same folder/server-rule capabilities, so these actions return the standard typed `NOT_SUPPORTED` result.
- Update the English tool reference.

## Impact

- Affected specs: `email-folders`, `email-inbox-rules`, `provider-interface`
- Affected code: `packages/email-core/src/providers/provider.ts`, `packages/email-core/src/actions/`, `packages/email-core/src/index.ts`, `packages/provider-microsoft/src/email-graph-provider.ts`, `packages/provider-microsoft/src/auth.ts`, `README.md`
- Authentication: Microsoft delegated users must re-consent to `MailboxSettings.ReadWrite`.
- Compatibility: existing well-known `move_to_folder` destinations remain unchanged; providers without the new optional capabilities degrade with `NOT_SUPPORTED`.

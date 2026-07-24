# OAuth verification video compositor

This tool assembles the Google OAuth reviewer video for Email Agent MCP. It
uses modular HTML/CSS/JavaScript scenes for framing and callouts, and authentic
screen recordings for every OAuth or Gmail interaction.

It deliberately has no npm dependencies and sits outside the repository's
production workspaces. Headless Chromium renders deterministic frames; ffmpeg
encodes the MP4.

## What to select in Google Auth Platform

For `gmail.modify`, select exactly:

- **Email client**
- **Email productivity**

Do not select Email backup/takeout or Email reporting and monitoring.

Before recording, the production project must contain only the Web application
client `Email Agent MCP Broker` for this reviewed storyboard. Google asks the
demo to cover every OAuth client assigned to the project. Move
development/Desktop clients to a separate project; if another production
client is genuinely required, extend the storyboard and validator to cover it
before recording.

## Authenticity boundary

The generated graphics are presentation only. The final video must contain the
real, continuous Google consent flow and real commands against a dedicated test
mailbox. Never recreate Google's screens in HTML for submission.

`storyboard` mode renders conspicuous placeholders and a permanent
`NOT FOR GOOGLE SUBMISSION` watermark. `final` mode fails closed unless every
capture and manual safety attestation is present.

Current reliable Gmail proof:

- `list_emails`
- `search_emails`
- `read_email`
- `get_thread`
- `send_email`
- `reply_to_email`

Do not show label, read/unread, star, move, or Trash operations: the Gmail
provider does not currently implement them. Draft and attachment tooling is
implemented and unit-tested, but add it to the required review story only after
those paths pass an end-to-end live Gmail smoke.

## Storyboard draft

Requirements:

- Node.js 20+
- ffmpeg/ffprobe
- Chromium, Chrome, or a Playwright Chromium cache

Run:

```bash
cd tools/oauth-verification-video
npm run doctor
npm run preflight:storyboard
npm run artifacts
npm run render:storyboard
```

The watermarked draft is written to
`dist/oauth-verification-storyboard.mp4`. It contains no real review evidence
and must not be uploaded to Google.

## Capture preparation

Use a dedicated, empty Gmail account and a clean English-language browser
profile. Revoke previous app access before recording so the complete consent
flow appears. Use synthetic messages only.

### macOS recording director

The director is intentionally semi-automated. AppleScript arranges Terminal
and the browser and runs only reviewed non-secret command files. You must
personally select the Google account, enter any password or MFA value, review
and grant consent, type the explicit `SEND` and `REPLY` confirmations for the
synthetic writes, and revoke access. It does not use Accessibility keystrokes
or automate browser clicks.

Before the first rehearsal:

1. In **System Settings → Privacy & Security → Screen & System Audio
   Recording**, allow the Terminal or script runner that will launch the
   director. Relaunch it after granting access.
2. Allow Apple Events automation of Terminal and Google Chrome when macOS asks.
   Accessibility permission is not required.
3. Turn on Focus, close notifications and unrelated tabs, use a clean English
   Chrome profile, enlarge Terminal/browser text, and select 1920×1080 display
   scaling.
4. Seed a two-message self-thread named `EA-MCP REVIEW READ 001` in the
   otherwise empty review mailbox.
5. Publish a post-`0.1.9` CLI release containing `gmail.modify`, deploy the
   production broker, and revoke the mailbox's prior grant.

Copy the example configuration, replace its mailbox and exact package version,
set `exampleOnly` to `false`, and confirm each preparation item only after
checking it:

```bash
cd tools/oauth-verification-video
cp recording.example.json recording.local.json
npm run record:dry-run
npm run record:script
npm run record:preflight
```

`record:preflight` downloads and inspects the named public package. It fails if
the Gmail provider lacks `gmail.modify`, still contains `mail.google.com`, uses
a floating version, cannot reach the production broker, or any operator
confirmation remains false. To exercise macOS Screen Recording permission with
a disposable one-second take, run:

```bash
node scripts/record-live.mjs \
  --config recording.local.json \
  --preflight --online --check-capture
```

Record one resumable, uniquely named take at a time:

```bash
node scripts/record-live.mjs --config recording.local.json --record identity
node scripts/record-live.mjs --config recording.local.json --record auth-platform
node scripts/record-live.mjs --config recording.local.json --record configure
node scripts/record-live.mjs --config recording.local.json --record oauth-consent
node scripts/record-live.mjs --config recording.local.json --record connected
node scripts/record-live.mjs --config recording.local.json --record read
node scripts/record-live.mjs --config recording.local.json --record send-reply
node scripts/record-live.mjs --config recording.local.json --record revoke
```

The OAuth-consent take begins before the validated
`https://oauth.usejunior.com/api/start` URL opens and remains continuous until
Terminal reports the connection result. The director never persists that
one-time URL.

After independently reviewing and accepting the takes, populate the ignored
render manifest without changing any attestation:

```bash
node scripts/record-live.mjs --config recording.local.json --sync-project
```

Copy `project.example.json` to the ignored `project.local.json`, then place
recordings in the ignored `captures/` directory:

| Capture ID | Required proof |
|---|---|
| `identity` | Product page, privacy link, and Google-data section |
| `auth-platform` | Production Web client, `gmail.modify`, Email client, Email productivity |
| `configure` | Released CLI version and hosted-broker configure handoff |
| `oauth-consent` | Continuous real Google OAuth flow with complete permission visible |
| `connected` | Successful connection and status for the test mailbox |
| `read` | Search, read, and thread retrieval for seeded synthetic mail |
| `send-reply` | Self-send, Gmail confirmation, reply, and resulting thread |
| `revoke` | Local credential-removal guidance and Google Account revocation UI |

Example capture entry:

```json
{
  "oauth-consent": {
    "file": "captures/04-oauth-consent.mov",
    "kind": "video"
  }
}
```

Replace the null Web-client ID with the full non-secret client ID shown in
Google Auth Platform. Set every attestation in `project.local.json` to `true`
only after auditing the actual OAuth-client inventory and inspecting the
footage. In particular, confirm that no client secret, access token,
refresh token, token file, password, recovery prompt, personal message,
notification, bookmark, or unrelated browser tab is visible.

## Final render

Normalize raw recordings into deterministic frame sequences, preflight the
operator manifest, then render:

```bash
npm run captures:normalize
npm run preflight:final
npm run render:final
```

To mux a separately recorded and reviewed narration track:

```bash
npm run render:final -- --narration .work/narration.wav
```

Raw capture audio is discarded by default. A supplied narration track is
padded or trimmed to the exact reviewed timeline and encoded as AAC.

`captures:normalize` writes `.work/project.render.json`; the final renderer
uses that generated manifest. Authentic media, expanded frames, local
attestations, and all MP4 output are gitignored.

The generated companion material lives in `review/`:

- `SHOT_LIST.md`
- `NARRATION.md`
- `subtitles.vtt`

Those files derive from `src/storyboard.mjs`, which is the single source of
truth for timing and reviewer copy.

## Renderer options

`scripts/render.mjs` accepts:

```text
--mode storyboard|final
--project <manifest>
--output <mp4>
--narration <reviewed-audio-file>
--fps <frames-per-second>
--chrome <browser-binary>
--ffmpeg <ffmpeg-binary>
--frames <maximum-frame-count>
--keep-frames
```

Use `OAUTH_VIDEO_CHROME` and `OAUTH_VIDEO_FFMPEG` to override binary discovery
without putting machine-specific paths in the project manifest.

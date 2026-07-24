import {compileTimeline, formatTimestamp} from '../../src/core/timeline.mjs';
import {scenes} from '../../src/storyboard.mjs';
import {displayCommandPlans} from './commands.mjs';

const MANUAL_NOTES = {
  identity: 'Open the public product page, click the privacy link, and show the Google-data/Limited Use section.',
  'auth-platform': 'Show the sole production Web client and non-secret client ID, then Data Access with gmail.modify, Email client, and Email productivity. Never reveal the client secret.',
  configure: 'The director shows the released version and starts configure. Stop this take only after the production broker URL is visible; leave configure waiting.',
  'oauth-consent': 'Start before the broker URL opens with a clean profile already signed in to the dedicated account. Expand the permission and manually click Continue/Allow. If a password or MFA prompt appears, abort the take and prepare the profile; never enter secrets on camera. Do not cut before Terminal reports Connected.',
  connected: 'Show status for the dedicated synthetic mailbox. Never open token files.',
  read: 'Run list, search, read, and thread retrieval for the seeded synthetic subject.',
  'send-reply': 'Send only to the dedicated mailbox, confirm in Gmail, run the threaded reply with reply_all false, and confirm the resulting thread in Gmail.',
  revoke: 'Show the public local-removal guidance, then manually revoke access from Google Account third-party connections. Never show token contents.',
};

export function buildLiveOperatorScript(config) {
  const timeline = compileTimeline(scenes);
  const commands = displayCommandPlans(config);
  const lines = [
    '# Real Google OAuth verification recording script',
    '',
    '> Generated locally from the reviewed storyboard and recording configuration.',
    '> Contains no credentials or tokens. Do not upload raw takes.',
    '',
    '## Session configuration',
    '',
    `- Public package: \`${config.packageSpec}\``,
    `- Dedicated mailbox: \`${config.reviewMailbox}\``,
    `- Broker: \`${config.brokerUrl}\``,
    `- Display: ${config.display}`,
    '',
    'Use a clean English browser profile, Focus mode, an otherwise empty dedicated mailbox, and 1920×1080 display scaling. Keep every Google account, password, MFA, consent, send/reply confirmation, and revoke action manual.',
    '',
  ];

  for (const scene of timeline.scenes.filter(item => item.type === 'capture')) {
    lines.push(`## ${formatTimestamp(scene.startMs, false)} — ${scene.title}`);
    lines.push('');
    lines.push(`Capture ID: \`${scene.capture}\``);
    lines.push('');
    lines.push(MANUAL_NOTES[scene.capture] ?? scene.recordingInstruction);
    lines.push('');
    const commandNames = scene.capture === 'send-reply'
      ? ['send', 'reply']
      : commands[scene.capture]
        ? [scene.capture]
        : [];
    for (const commandName of commandNames) {
      lines.push(`### ${commandName} command`);
      lines.push('');
      lines.push('```zsh');
      lines.push(...commands[commandName]);
      lines.push('```');
      lines.push('');
    }
    lines.push(`Narration: ${scene.narration}`);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

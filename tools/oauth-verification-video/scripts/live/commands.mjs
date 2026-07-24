import {relative} from 'node:path';
import {toolRoot} from '../paths.mjs';

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function cliPrefix(config) {
  return `EMAIL_AGENT_MCP_HOME=${shellQuote(config.emailAgentHome.absolute)} npx --yes ${shellQuote(config.packageSpec)}`;
}

function workPath(config, name) {
  return `${config.workDirectory.absolute}/${name}`;
}

export function buildCommandPlans(config) {
  const cli = cliPrefix(config);
  const mailbox = shellQuote(config.reviewMailbox);
  const work = shellQuote(config.workDirectory.absolute);
  const readJson = shellQuote(workPath(config, 'read-search.json'));
  const sendJson = shellQuote(workPath(config, 'send.json'));
  const seedArgs = shellQuote(JSON.stringify({
    query: `subject:"${config.seedSubject}"`,
    limit: 5,
  }));
  const listArgs = shellQuote(JSON.stringify({folder: 'inbox', limit: 5}));

  return {
    configure: [
      'clear',
      `${cli} --version`,
      `${cli} configure --provider gmail --mailbox ${mailbox} --broker-url ${shellQuote(config.brokerUrl)}`,
    ],
    connected: [
      'clear',
      `${cli} status`,
    ],
    read: [
      'clear',
      `mkdir -p ${work}`,
      `${cli} call list_emails --mailbox ${mailbox} --args ${listArgs} | jq .`,
      `${cli} call search_emails --mailbox ${mailbox} --args ${seedArgs} | tee ${readJson} | jq .`,
      `READ_ID="$(jq -er '.emails[0].id' ${readJson})"`,
      `${cli} call read_email --mailbox ${mailbox} --args "$(jq -cn --arg id "$READ_ID" '{id:$id,strip_quoted_history:true,strip_signatures:true}')" | jq .`,
      `${cli} call get_thread --mailbox ${mailbox} --args "$(jq -cn --arg id "$READ_ID" '{message_id:$id}')" | jq .`,
    ],
    send: [
      'clear',
      `mkdir -p ${work}`,
      `${cli} call send_email --mailbox ${mailbox} --args "$(jq -cn --arg to ${mailbox} --arg subject ${shellQuote(config.writeSubject)} '{to:$to,subject:$subject,body:"Synthetic verification message sent by Email Agent MCP. No personal data."}')" | tee ${sendJson} | jq .`,
      `jq -er '.messageId' ${sendJson} >/dev/null`,
    ],
    reply: [
      `SEND_ID="$(jq -er '.messageId' ${sendJson})"`,
      `${cli} call reply_to_email --mailbox ${mailbox} --args "$(jq -cn --arg id "$SEND_ID" '{message_id:$id,body:"Synthetic threaded reply sent by Email Agent MCP. No personal data.",reply_all:false}')" | jq .`,
      `${cli} call get_thread --mailbox ${mailbox} --args "$(jq -cn --arg id "$SEND_ID" '{message_id:$id}')" | jq .`,
    ],
  };
}

export function commandFileContents(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('A command file requires at least one safe command');
  }
  if (lines.some(line => typeof line !== 'string' || line.includes('\0'))) {
    throw new Error('Command file contains invalid text');
  }
  return `#!/bin/zsh\nset -euo pipefail\nset -x\n${lines.join('\n')}\n`;
}

export function displayCommandPlans(config) {
  const plans = buildCommandPlans(config);
  const display = {};
  for (const [name, lines] of Object.entries(plans)) {
    display[name] = lines.map(line =>
      line
        .replaceAll(config.emailAgentHome.absolute, relative(toolRoot, config.emailAgentHome.absolute))
        .replaceAll(config.workDirectory.absolute, relative(toolRoot, config.workDirectory.absolute)),
    );
  }
  return display;
}

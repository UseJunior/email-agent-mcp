import { loadMailboxMetadata, DelegatedAuthManager } from '@usejunior/provider-microsoft';

async function main() {
  const metadata = await loadMailboxMetadata('steven-at-usejunior-com');
  if (!metadata) { console.error('No metadata found'); process.exit(1); }

  const auth = new DelegatedAuthManager(
    { mode: 'delegated', clientId: metadata.clientId, tenantId: metadata.tenantId },
    'work',
  );
  await auth.reconnect();
  const token = await auth.getAccessToken();

  // Follow all pages from $deltatoken=latest
  let url: string | undefined = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=latest&$select=subject,from,id';
  let pageCount = 0;
  let totalItems = 0;

  while (url) {
    pageCount++;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await resp.json() as Record<string, unknown>;
    const items = (body['value'] as unknown[] || []);
    totalItems += items.length;
    console.error(`Page ${pageCount}: ${items.length} items`);

    if (body['@odata.deltaLink']) {
      console.error(`\nGot deltaLink after ${pageCount} pages, ${totalItems} total items ✓`);
      process.exit(0);
    }
    url = body['@odata.nextLink'] as string | undefined;
  }

  console.error(`\nNO deltaLink after ${pageCount} pages, ${totalItems} items!`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

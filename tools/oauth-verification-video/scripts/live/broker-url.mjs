const BROKER_START_ORIGIN = 'https://oauth.usejunior.com';
const BROKER_START_PATH = '/api/start';

export function validateBrokerStartUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OAuth broker start URL is not a valid URL');
  }
  if (
    url.origin !== BROKER_START_ORIGIN
    || url.pathname !== BROKER_START_PATH
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error(`Refusing non-production broker URL: ${url.origin}${url.pathname}`);
  }
  if (!url.searchParams.has('session')) {
    throw new Error('OAuth broker start URL is missing its session parameter');
  }
  return url.href;
}

export function extractBrokerStartUrl(terminalContents) {
  const candidates = String(terminalContents).match(/https:\/\/oauth\.usejunior\.com\/api\/start\?[^\s"'<>]+/g) ?? [];
  for (const candidate of candidates.toReversed()) {
    try {
      return validateBrokerStartUrl(candidate);
    } catch {
      // Continue past stale or malformed lookalikes in prior terminal output.
    }
  }
  throw new Error('The production broker start URL is not visible in Terminal yet');
}

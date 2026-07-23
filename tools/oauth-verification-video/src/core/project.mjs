const REQUIRED_FEATURES = ['Email client', 'Email productivity'];
const REQUIRED_ATTESTATIONS = [
  'oauthClientInventoryAudited',
  'dedicatedTestMailbox',
  'authenticUneditedInteractions',
  'englishConsentScreen',
  'previousGrantRevokedBeforeCapture',
  'noSecretsTokensOrPersonalMailVisible',
  'appScopeAndBrandingMatchSubmission',
];

export const EXPECTED_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export function captureRequirements(scenes) {
  const seen = new Set();
  return scenes
    .filter(scene => scene.type === 'capture')
    .filter(scene => {
      if (seen.has(scene.capture)) return false;
      seen.add(scene.capture);
      return true;
    })
    .map(scene => ({
      id: scene.capture,
      title: scene.title,
      instruction: scene.recordingInstruction,
      requiredKind: scene.requiredKind ?? 'video',
      minimumDurationMs: scene.minimumCaptureMs ?? scene.durationMs,
    }));
}

export function validateProjectShape(project, scenes, mode) {
  const errors = [];
  const warnings = [];
  const submission = project?.submission ?? {};
  const captures = project?.captures ?? {};
  const requirements = captureRequirements(scenes);

  if (submission.appName !== 'email-agent-mcp') {
    errors.push('submission.appName must exactly match "email-agent-mcp"');
  }
  if (submission.requestedScope !== EXPECTED_SCOPE) {
    errors.push(`submission.requestedScope must be ${EXPECTED_SCOPE}`);
  }

  const features = Array.isArray(submission.dataAccessFeatures)
    ? [...submission.dataAccessFeatures].sort()
    : [];
  if (JSON.stringify(features) !== JSON.stringify([...REQUIRED_FEATURES].sort())) {
    errors.push('Select exactly "Email client" and "Email productivity" in Data Access');
  }

  for (const requirement of requirements) {
    const capture = captures[requirement.id];
    if (!capture?.file) {
      const message = `${requirement.id}: ${requirement.instruction}`;
      if (mode === 'final') errors.push(`Missing authentic capture — ${message}`);
      else warnings.push(`Storyboard placeholder — ${message}`);
      continue;
    }

    if (mode === 'final' && requirement.requiredKind === 'video' && capture.kind === 'image') {
      errors.push(`${requirement.id}: interactive evidence must be video, not a static image`);
    }
    if (mode === 'final' && requirement.requiredKind === 'video') {
      if (typeof capture.frames !== 'string' || !/%0?\d*d/.test(capture.frames)) {
        errors.push(`${requirement.id}: capture must be normalized to a frame sequence before final render`);
      }
      if (!Number.isInteger(capture.frameCount) || capture.frameCount <= 0) {
        errors.push(`${requirement.id}: normalized capture must declare a positive frameCount`);
      }
      if (!Number.isFinite(capture.fps) || capture.fps <= 0) {
        errors.push(`${requirement.id}: normalized capture must declare a positive fps`);
      }
      if (
        Number.isInteger(capture.frameCount)
        && capture.frameCount > 0
        && Number.isFinite(capture.fps)
        && capture.fps > 0
        && (capture.frameCount / capture.fps) * 1000 < requirement.minimumDurationMs
      ) {
        errors.push(`${requirement.id}: authentic capture must be at least ${requirement.minimumDurationMs}ms`);
      }
    }
  }

  if (mode === 'final') {
    const clients = Array.isArray(submission.productionOAuthClients)
      ? submission.productionOAuthClients
      : [];
    if (clients.length !== 1) {
      errors.push('The production project must declare exactly one OAuth client before final render');
    } else {
      const [client] = clients;
      if (client.type !== 'Web application') {
        errors.push('The sole production OAuth client must be a Web application');
      }
      if (typeof client.clientId !== 'string' || !client.clientId.endsWith('.apps.googleusercontent.com')) {
        errors.push('The production Web client must declare its full non-secret client ID');
      }
      if (client.coveredByCapture !== 'oauth-consent') {
        errors.push(`${client.name ?? 'OAuth client'} is not covered by the oauth-consent capture`);
      }
    }

    for (const key of REQUIRED_ATTESTATIONS) {
      if (project?.attestations?.[key] !== true) {
        errors.push(`Missing final attestation: ${key}`);
      }
    }
  }

  return {errors, warnings, requirements};
}

export function projectCapture(project, captureId) {
  return project?.captures?.[captureId] ?? {file: null};
}

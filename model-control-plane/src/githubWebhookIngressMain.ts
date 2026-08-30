import { createGitHubWebhookIngressServer } from './githubWebhookIngress.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

const host = process.env.GITHUB_WEBHOOK_INGRESS_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.GITHUB_WEBHOOK_INGRESS_PORT ?? 8322);
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  throw new Error('GITHUB_WEBHOOK_INGRESS_PORT_INVALID');
}

const server = createGitHubWebhookIngressServer({
  webhookSecret: required('GITHUB_WEBHOOK_SECRET'),
  eventToken: required('MODEL_CP_V3_GITHUB_EVENT_TOKEN'),
  repository: required('GITHUB_WEBHOOK_REPOSITORY'),
  projectKey: required('GITHUB_WEBHOOK_PROJECT_KEY'),
  repositoryPath: required('GITHUB_WEBHOOK_REPOSITORY_PATH'),
  remote: process.env.GITHUB_WEBHOOK_REMOTE,
  targetUrl: process.env.GITHUB_WEBHOOK_EVENT_TARGET,
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, resolve);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

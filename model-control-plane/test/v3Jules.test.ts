import assert from 'node:assert/strict';
import test from 'node:test';

import { buildControlPlane } from '../src/app.js';
import {
  JulesApiClient,
  type CreateJulesSessionInput,
  type JulesApiPort,
  type JulesRequest,
  type JulesSession,
} from '../src/v3/jules.js';

class SecretReader {
  reads = 0;
  read(key: string) {
    this.reads += 1;
    assert.equal(key, 'JULES_API_KEY');
    return 'test-jules-key';
  }
}

test('Jules API adapter discovers a source and creates an explicit AUTO_CREATE_PR session', async () => {
  const secrets = new SecretReader();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const request: JulesRequest = async (url, init) => {
    requests.push({ url, init });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-goog-api-key'), 'test-jules-key');
    if (url.endsWith('/sources?pageSize=100')) {
      return new Response(
        JSON.stringify({
          sources: [
            {
              name: 'sources/github-example-project',
              id: 'github-example-project',
              githubRepo: {
                owner: 'example',
                repo: 'project',
                defaultBranch: { displayName: 'main' },
                branches: [{ displayName: 'main' }, { displayName: 'develop' }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/sessions') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.prompt, 'Find and repair one evidence-backed bug.');
      assert.equal(body.automationMode, 'AUTO_CREATE_PR');
      assert.equal(body.requirePlanApproval, false);
      assert.deepEqual(body.sourceContext, {
        source: 'sources/github-example-project',
        githubRepoContext: { startingBranch: 'main' },
      });
      return new Response(
        JSON.stringify({
          name: 'sessions/123',
          id: '123',
          title: 'Proactive bug hunt',
          state: 'QUEUED',
          url: 'https://jules.google.com/session/123',
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const client = new JulesApiClient({ secrets, request });

  const source = await client.findSource('example/project');
  assert.equal(source?.name, 'sources/github-example-project');
  assert.equal(source?.defaultBranch, 'main');
  const session = await client.createSession({
    repository: 'example/project',
    startingBranch: 'main',
    prompt: 'Find and repair one evidence-backed bug.',
    title: 'Proactive bug hunt',
    autoCreatePullRequest: true,
  });
  assert.equal(session.name, 'sessions/123');
  assert.equal(session.state, 'QUEUED');
  assert.equal(requests.length, 3);
  assert.equal(secrets.reads, 3);
});

test('Jules API adapter does not enable AUTO_CREATE_PR unless the caller explicitly requests it', async () => {
  const request: JulesRequest = async (url, init) => {
    if (url.includes('/sources?')) {
      return new Response(
        JSON.stringify({
          sources: [
            {
              name: 'sources/github-example-project',
              githubRepo: {
                owner: 'example',
                repo: 'project',
                branches: [{ displayName: 'main' }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal('automationMode' in body, false);
    return new Response(JSON.stringify({ name: 'sessions/456', state: 'QUEUED' }), {
      status: 200,
    });
  };
  const client = new JulesApiClient({ secrets: new SecretReader(), request });
  await client.createSession({
    repository: 'example/project',
    startingBranch: 'main',
    prompt: 'Investigate only.',
  });
});

test('Jules API adapter normalizes completed pull-request output behind its own contract', async () => {
  const request: JulesRequest = async () =>
    new Response(
      JSON.stringify({
        name: 'sessions/789',
        id: '789',
        state: 'COMPLETED',
        outputs: [
          {
            pullRequest: {
              url: 'https://github.com/example/project/pull/42',
              title: 'Repair bug',
              description: 'Untrusted agent-authored description',
            },
          },
        ],
      }),
      { status: 200 },
    );
  const client = new JulesApiClient({ secrets: new SecretReader(), request });
  const session = await client.getSession('sessions/789');
  assert.equal(session.state, 'COMPLETED');
  assert.deepEqual(session.pullRequests, [
    {
      url: 'https://github.com/example/project/pull/42',
      title: 'Repair bug',
      description: 'Untrusted agent-authored description',
    },
  ]);
});

class FakeJules implements JulesApiPort {
  createInputs: CreateJulesSessionInput[] = [];
  async findSource(repository: string) {
    return {
      name: 'sources/digital-biome',
      repository,
      defaultBranch: 'main',
      branches: ['main'],
    };
  }
  async createSession(input: CreateJulesSessionInput): Promise<JulesSession> {
    this.createInputs.push(input);
    return {
      name: 'sessions/session-1',
      id: 'session-1',
      state: 'QUEUED',
      url: 'https://jules.google.com/session/session-1',
      pullRequests: [],
    };
  }
  async getSession(name: string): Promise<JulesSession> {
    return { name, state: 'COMPLETED', pullRequests: [] };
  }
}

test('Jules control-plane routes remain unavailable without credentials and use only the adapter when configured', async () => {
  const unconfigured = await buildControlPlane({ dbFile: ':memory:', logger: false, env: {} });
  try {
    const response = await unconfigured.app.inject({
      method: 'POST',
      url: '/api/v3/development/jules/sessions',
      payload: {
        repository: 'example/project',
        startingBranch: 'main',
        prompt: 'Find a bug.',
        autoCreatePullRequest: true,
      },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'JULES_API_UNCONFIGURED');
  } finally {
    await unconfigured.app.close();
  }

  const fake = new FakeJules();
  const configured = await buildControlPlane({
    dbFile: ':memory:',
    logger: false,
    env: {},
    v3Jules: fake,
  });
  try {
    const create = await configured.app.inject({
      method: 'POST',
      url: '/api/v3/development/jules/sessions',
      payload: {
        repository: 'example/project',
        startingBranch: 'main',
        prompt: 'Find a bug.',
        title: 'Proactive audit',
        autoCreatePullRequest: true,
      },
    });
    assert.equal(create.statusCode, 201);
    assert.equal(create.json().name, 'sessions/session-1');
    assert.equal(fake.createInputs[0]?.autoCreatePullRequest, true);

    const get = await configured.app.inject({
      method: 'GET',
      url: '/api/v3/development/jules/sessions/session-1',
    });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().state, 'COMPLETED');
  } finally {
    await configured.app.close();
  }
});

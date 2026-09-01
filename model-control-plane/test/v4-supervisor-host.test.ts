import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpOpenHandsSupervisorClient } from '../src/v4/adapters/openhands.js';

test('OpenHands supervisor conversations persist bounded input without running a second model', async () => {
  const calls: Array<{ url: string; body: Record<string, any>; headers: Record<string, string> }> = [];
  const fake = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)) as Record<string, any>,
      headers: init.headers as Record<string, string>,
    });
    if (String(url).endsWith('/api/conversations')) {
      return new Response(JSON.stringify({ id: 'conversation-1' }), { status: 201 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
  const client = new HttpOpenHandsSupervisorClient('http://openhands.test', 'session-key', fake);
  await client.createSupervisorConversation({ supervisorId: 'supervisor-1', planId: 'plan-1', projectionDigest: 'digest-1', boundedInstruction: 'bounded projection' });
  await client.resumeSupervisorConversation({ conversationId: 'conversation-1', boundedInstruction: 'next bounded projection' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.body.initial_message.run, false);
  assert.equal(calls[0]?.body.max_iterations, 1);
  assert.deepEqual(calls[0]?.body.agent.include_default_tools, []);
  assert.equal(calls[1]?.body.run, false);
  assert.equal(calls[0]?.headers['X-Session-API-Key'], 'session-key');
  assert.equal(JSON.stringify(calls).includes('authorization'), false);
});

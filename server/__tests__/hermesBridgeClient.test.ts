import { describe, expect, it } from 'vitest';

import {
  BridgeClient,
  type HermesBoard,
  type HermesSpawn,
  SseParser,
} from '../src/providers/hermes/bridgeClient.js';

function sseResponse(body: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('SseParser', () => {
  it('parses a complete board event block', () => {
    const parser = new SseParser();
    const events = parser.push('event: board\ndata: {"a":1}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'board', data: '{"a":1}' });
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    const events = parser.push('event: board\r\ndata: {"a":1}\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"a":1}');
  });

  it('buffers partial events across chunks', () => {
    const parser = new SseParser();
    const first = parser.push('event: board\ndata: {"a"');
    expect(first).toHaveLength(0);
    const second = parser.push(':1}\n\n');
    expect(second).toHaveLength(1);
    expect(second[0].data).toBe('{"a":1}');
  });

  it('ignores non-board events and comments', () => {
    const parser = new SseParser();
    const events = parser.push(': keepalive\n\nevent: ping\ndata: x\n\nevent: board\ndata: {}\n\n');
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('ping');
    expect(events[1].event).toBe('board');
  });
});

describe('BridgeClient', () => {
  it('subscribes to SSE and parses board frames', async () => {
    const board: HermesBoard = { teams: [{ name: 'memoflow', workers: [] }] };
    let resolveBoard: (b: HermesBoard) => void = () => {};
    const received = new Promise<HermesBoard>((r) => {
      resolveBoard = r;
    });
    const fetchImpl = (async () =>
      sseResponse(`event: board\ndata: ${JSON.stringify(board)}\n\n`)) as typeof fetch;
    const client = new BridgeClient({
      baseUrl: 'http://127.0.0.1:8787',
      onBoard: resolveBoard,
      pollIntervalMs: 1000,
      fetchImpl,
    });
    client.start();
    const b = await received;
    expect(b.teams[0].name).toBe('memoflow');
    expect(client.isSubscribed()).toBe(true);
    client.stop();
  });

  it('falls back to polling /api/board when SSE is unavailable', async () => {
    const board: HermesBoard = { teams: [{ name: 'memoflow', workers: [] }] };
    let resolveBoard: (b: HermesBoard) => void = () => {};
    const received = new Promise<HermesBoard>((r) => {
      resolveBoard = r;
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/events')) {
        return new Response('unavailable', { status: 503 });
      }
      return new Response(JSON.stringify(board), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const client = new BridgeClient({
      baseUrl: 'http://127.0.0.1:8787',
      onBoard: resolveBoard,
      pollIntervalMs: 10,
      fetchImpl,
    });
    client.start();
    const b = await received;
    expect(b.teams[0].name).toBe('memoflow');
    expect(client.isSubscribed()).toBe(false);
    client.stop();
  });

  it('polls /api/spawns and invokes onSpawns (unwrapping the { spawns: [] } envelope)', async () => {
    const spawns: HermesSpawn[] = [
      {
        profileId: 'memoflow',
        runtime: 'opencode',
        cwd: '/workspace/repos/memoflow',
        command: 'opencode run',
        createdAt: Date.now(),
      },
    ];
    let resolveSpawns: (s: HermesSpawn[]) => void = () => {};
    const received = new Promise<HermesSpawn[]>((r) => {
      resolveSpawns = r;
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/api/events')) {
        return new Response('unavailable', { status: 503 });
      }
      if (u.endsWith('/api/spawns')) {
        return new Response(JSON.stringify({ spawns }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ teams: [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const client = new BridgeClient({
      baseUrl: 'http://127.0.0.1:8787',
      onBoard: () => {},
      onSpawns: resolveSpawns,
      pollIntervalMs: 10,
      fetchImpl,
    });
    client.start();
    const s = await received;
    expect(s).toHaveLength(1);
    expect(s[0].command).toBe('opencode run');
    client.stop();
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/index.ts';
import { FakeOllama } from './helpers.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'oh-verify-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const make = (client: FakeOllama, verify?: { command: string; maxRounds?: number }) =>
  new Agent({ client: client as never, model: 'm', cwd: dir, mode: 'auto-edit', skills: false, memory: false, verify, approve: async () => ({ kind: 'allow' }) });

describe('verify step', () => {
  // The check passes once ok.txt says "fixed".
  const check = `grep -q fixed ok.txt || { echo "ok.txt is not fixed" >&2; exit 1; }`;

  it('sends failing checks back to the agent until they pass', async () => {
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'ok.txt', content: 'broken' } }] }],
      [{ content: 'Done.' }], // claims done, but the check fails
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'ok.txt', content: 'fixed' } }] }],
      [{ content: 'Really done.' }],
    ]);
    const agent = make(client, { command: check });
    const statuses: string[] = [];
    agent.on((e) => e.type === 'verify' && statuses.push(e.status));
    await agent.send('fix ok.txt');

    expect(statuses).toEqual(['running', 'failed', 'running', 'passed']);
    const feedback = agent.messages.find((m) => m.content.startsWith('[Verify]'))!;
    expect(feedback.content).toContain('ok.txt is not fixed');
    expect(agent.messages.at(-1)!.content).toBe('Really done.');
  });

  it('gives up after maxRounds', async () => {
    const client = new FakeOllama([
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'ok.txt', content: 'broken' } }] }],
      [{ content: 'Done.' }],
      [{ toolCalls: [{ name: 'write_file', arguments: { path: 'ok.txt', content: 'still broken' } }] }],
      [{ content: 'Done again.' }],
      [{ content: 'The check still fails; I could not fix it.' }],
    ]);
    const agent = make(client, { command: check, maxRounds: 2 });
    await agent.send('fix ok.txt');
    // Both failures reach the agent, so its last answer can say so; there's no third check.
    expect(agent.messages.filter((m) => m.content.startsWith('[Verify]'))).toHaveLength(2);
    expect(client.requests).toHaveLength(5);
    expect(agent.messages.at(-1)!.content).toContain('still fails');
  });

  it('skips verification when the turn changed nothing', async () => {
    await writeFile(path.join(dir, 'ok.txt'), 'broken');
    const client = new FakeOllama([[{ content: 'Just answering a question.' }]]);
    const agent = make(client, { command: check });
    const statuses: string[] = [];
    agent.on((e) => e.type === 'verify' && statuses.push(e.status));
    await agent.send('what is in ok.txt?');
    expect(statuses).toEqual([]);
  });
});

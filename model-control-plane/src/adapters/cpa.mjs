import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export class CpaAdapter {
  constructor({ gatewayctl = '/usr/local/sbin/gatewayctl', sudo = true } = {}) {
    this.gatewayctl = gatewayctl;
    this.sudo = sudo;
  }

  async runWithInput(command, args, input) {
    const file = this.sudo ? 'sudo' : this.gatewayctl;
    const argv = this.sudo ? [this.gatewayctl, command, ...args] : [command, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '',
        stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
          : reject(new Error(stderr.trim() || `gatewayctl exited ${code}`)),
      );
      child.stdin.end(String(input ?? ''));
    });
  }

  async addChannel({
    name,
    protocol,
    baseUrl,
    models,
    apiKey,
    weight = 100,
    priority = 0,
    proxyUrl = 'direct',
  }) {
    if (!apiKey) throw new Error('upstream API key is required');
    const args = [
      '--name',
      name,
      '--protocol',
      protocol,
      '--base-url',
      baseUrl,
      '--weight',
      String(weight),
      '--priority',
      String(priority),
      '--proxy-url',
      proxyUrl,
    ];
    for (const model of models ?? []) {
      const upstream = typeof model === 'string' ? model : model.name;
      const alias = typeof model === 'string' ? model : model.alias || model.name;
      args.push('--model', upstream === alias ? upstream : `${upstream}=${alias}`);
    }
    if (!(models ?? []).length) throw new Error('at least one model is required');
    return this.runWithInput('add-channel', args, apiKey);
  }

  async run(command, args = []) {
    const allowed = new Set([
      'enable-channel',
      'disable-channel',
      'test-channel',
      'quarantine-channel',
      'reconcile',
      'set-model-alias',
    ]);
    if (!allowed.has(command)) throw new Error(`unsupported CPA command: ${command}`);
    const file = this.sudo ? 'sudo' : this.gatewayctl;
    const argv = this.sudo ? [this.gatewayctl, command, ...args] : [command, ...args];
    const { stdout, stderr } = await execFileAsync(file, argv, {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  async enable(name, reason = 'model-control-plane') {
    return this.run('enable-channel', [name, '--reason', reason]);
  }
  async disable(name, reason = 'model-control-plane') {
    return this.run('disable-channel', [name, '--reason', reason]);
  }
  async test(name) {
    return this.run('test-channel', [name]);
  }
  async quarantine(name, minutes = 30, reason = 'model-control-plane') {
    return this.run('quarantine-channel', [name, '--minutes', String(minutes), '--reason', reason]);
  }
  async reconcile() {
    return this.run('reconcile');
  }
  async bindAlias(name, model, alias) {
    return this.run('set-model-alias', [name, '--alias', alias, '--model', model]);
  }
  async unbindAlias(name, alias) {
    return this.run('set-model-alias', [name, '--alias', alias, '--remove']);
  }

  async status() {
    const file = this.sudo ? 'sudo' : this.gatewayctl;
    const args = this.sudo ? [this.gatewayctl, 'status'] : ['status'];
    const { stdout } = await execFileAsync(file, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return [];
    return lines.slice(1).map((line) => {
      const [name, protocol, status, models = '', lastTest = ''] = line.split('\t');
      const allModels = models
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      return {
        name,
        protocol,
        enabled: status === 'enabled',
        models: allModels.filter((model) => !model.startsWith('position:')),
        logicalAliases: allModels.filter((model) => model.startsWith('position:')),
        lastTest,
        health: lastTest === 'pass' ? 'healthy' : lastTest === 'fail' ? 'degraded' : 'unknown',
      };
    });
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class CpaAdapter {
  constructor({ gatewayctl = '/usr/local/sbin/gatewayctl', sudo = true } = {}) {
    this.gatewayctl = gatewayctl;
    this.sudo = sudo;
  }

  async command(command, args = [], timeout = 60_000) {
    const file = this.sudo ? 'sudo' : this.gatewayctl;
    const argv = this.sudo ? [this.gatewayctl, command, ...args] : [command, ...args];
    const { stdout, stderr } = await execFileAsync(file, argv, {
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  }

  async test(name) {
    return this.command('test-channel', [name]);
  }

  async status() {
    const { stdout } = await this.command('status', [], 15_000);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return [];
    return lines.slice(1).map((line) => {
      const [name, protocol, status, models = '', lastTest = ''] = line.split('\t');
      const allModels = models
        .split(',')
        .map((value) => value.trim())
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

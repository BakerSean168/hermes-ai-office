import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function firstConfiguredApiKey(configFile) {
  let text;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  let inKeys = false;
  for (const line of lines) {
    if (/^api-keys\s*:/i.test(line.trim())) {
      inKeys = true;
      continue;
    }
    if (!inKeys) continue;
    if (line.trim() && !/^\s/.test(line)) break;
    const match = line.match(/^\s*-\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/);
    if (match?.[1]) return match[1];
  }
  return '';
}

export class CpaAdapter {
  constructor({
    gatewayctl = '/usr/local/sbin/gatewayctl',
    sudo = true,
    baseUrl = 'http://127.0.0.1:8317',
    configFile = '/opt/cpa/cpa/config.yaml',
  } = {}) {
    this.gatewayctl = gatewayctl;
    this.sudo = sudo;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.configFile = configFile;
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

  async models() {
    const apiKey = firstConfiguredApiKey(this.configFile);
    if (!apiKey) throw new Error('CPA_CLIENT_KEY_UNAVAILABLE');
    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Error('CPA_MODEL_DISCOVERY_UNAVAILABLE');
    }
    if (!response.ok) throw new Error('CPA_MODEL_DISCOVERY_UNAVAILABLE');
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) return [];
    return payload.data
      .map((item) => (item && typeof item === 'object' ? String(item.id ?? '') : ''))
      .filter(Boolean);
  }
}

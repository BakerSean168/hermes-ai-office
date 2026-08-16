import fs from 'node:fs';

export class CpaUsageAdapter {
  constructor({
    baseUrl = 'http://127.0.0.1:8317',
    keyFile = '/opt/cpa/.mgmt_password',
    pluginId = 'cap-token-usage-tracker',
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.keyFile = keyFile;
    this.pluginId = pluginId;
  }

  async request(path) {
    const key = fs.readFileSync(this.keyFile, 'utf8').trim();
    if (!key) throw new Error('empty CPA management key');
    const url = `${this.baseUrl}/v0/resource/plugins/${encodeURIComponent(this.pluginId)}/${path}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'X-Management-Key': key },
    });
    if (!response.ok) throw new Error(`CPA usage plugin returned HTTP ${response.status}`);
    return response.json();
  }

  async snapshot(range = '30d') {
    const encoded = encodeURIComponent(range);
    const [stats, costs] = await Promise.all([
      this.request(`stats?range=${encoded}`),
      this.request(`costs?range=${encoded}`).catch(() => null),
    ]);
    return { range, stats, costs };
  }
}

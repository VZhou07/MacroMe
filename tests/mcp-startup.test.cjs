const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
test('MCP initializes and lists tools with a minimal PATH from outside the checkout', async () => {
  const child = spawn(path.resolve(__dirname, '../scripts/macrome-mcp.sh'), [], {
    cwd: '/tmp', env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  let stderr = '', buffer = '';
  child.stderr.on('data', data => { stderr += data; });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MCP handshake timed out')), 15000);
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`MCP exited before tool listing: ${code}; ${stderr}`)));
      child.stdout.on('data', data => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const response = JSON.parse(line);
            if (response.id === 1) {
              assert.equal(response.result.serverInfo.name, 'macrome');
              send({ method: 'notifications/initialized' });
              send({ id: 2, method: 'tools/list', params: {} });
            } else if (response.id === 2) {
              assert.equal(response.result.tools.length, 3);
              resolve();
            }
          } catch (error) { reject(error); }
        }
      });
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    });
    assert.match(stderr, /tools ready on stdio/);
  } finally { clearTimeout(timer); child.stdin.end(); child.kill(); }
});

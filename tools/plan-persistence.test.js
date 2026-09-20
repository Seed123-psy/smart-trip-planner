const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const mock = (name, exports) => {
  const id = require.resolve(name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
let user = { id: 7, role: 'admin' }, stored;
const generated = { city: '重庆', days: [{ visits: [] }] };
mock('./planner', { plan: async () => generated });
mock('./api-router', { handleApi: async () => false });
mock('./user-keys', { resolvePlanKey: async () => ({ user, owner: 'user', options: {} }) });
mock('./trips', { save: async input => {
  await new Promise(resolve => setImmediate(resolve));
  stored = input;
  return { id: 'saved-trip', claimToken: 'claim-token' };
} });
const { handleRequest } = require('../serve');

for (const streaming of [false, true]) {
  test(`${streaming ? 'SSE' : 'JSON'} 生成等待落库并返回归属与认领凭证`, async () => {
    for (const viewer of [{ id: 7, role: 'admin' }, null]) {
      user = viewer; stored = null;
      const req = new PassThrough({ autoDestroy: false });
      Object.assign(req, { method: 'POST', url: '/api/plan', headers: {
        'content-type': 'application/json', accept: streaming ? 'text/event-stream' : 'application/json'
      } });
      let output = '';
      const res = { writeHead() {}, write(chunk) { output += chunk; }, end(chunk = '') { output += chunk; } };
      const pending = handleRequest(req, res);
      setImmediate(() => req.end('{}'));
      await pending;
      assert.equal(stored.userId, viewer ? viewer.id : null);
      assert.deepEqual(stored.plan, generated);
      const result = streaming ? JSON.parse(output.match(/event: result\ndata: ([^\n]+)/)[1]) : JSON.parse(output);
      assert.equal(result.tripId, 'saved-trip');
      assert.equal(result.claimToken, 'claim-token');
      req.destroy();
    }
  });
}

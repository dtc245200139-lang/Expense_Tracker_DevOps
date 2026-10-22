const assert = require('node:assert/strict');
const { once } = require('node:events');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const session = require('express-session');

let persistedSessions = 0;
const sessions = new Map();
const serverPath = path.resolve(__dirname, '../server.js');
const originalLoad = Module._load;

class TestSessionStore extends session.Store {
    get(sid, callback) {
        callback(null, sessions.get(sid));
    }

    set(sid, value, callback) {
        sessions.set(sid, value);
        persistedSessions += 1;
        callback(null);
    }

    destroy(sid, callback) {
        sessions.delete(sid);
        callback(null);
    }

    touch(sid, value, callback) {
        sessions.set(sid, value);
        callback(null);
    }
}

Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === serverPath && request === './db') {
        return {
            pool: {},
            query: async () => ({ rows: [] })
        };
    }
    if (parent && parent.filename === serverPath && request === 'connect-pg-simple') {
        return () => TestSessionStore;
    }
    return originalLoad.call(this, request, parent, isMain);
};

let app;
try {
    app = require(serverPath);
} finally {
    Module._load = originalLoad;
}

test('health and metrics requests do not persist CSRF sessions', async (t) => {
    persistedSessions = 0;
    sessions.clear();

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
    }));

    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal(healthResponse.headers.get('set-cookie'), null);
    assert.equal(persistedSessions, 0);

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.match(await metricsResponse.text(), /http_requests_total/);
    assert.equal(metricsResponse.headers.get('set-cookie'), null);
    assert.equal(persistedSessions, 0);

    const loginResponse = await fetch(`${baseUrl}/login`);
    assert.equal(loginResponse.status, 200);
    assert.match(await loginResponse.text(), /name="_csrf"/);
    assert.equal(persistedSessions, 1);
});

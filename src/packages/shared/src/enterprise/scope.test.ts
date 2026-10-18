import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type Response } from 'express';
import {
  DEFAULT_ENTERPRISE_ID,
  EnterpriseScopeError,
  enterpriseOf,
  isEnterpriseId,
  parseEnterpriseId,
  requireEnterprise,
  type EnterpriseId,
} from './scope.js';

interface Profile {
  slug: string;
}

const PROFILES = new Map<string, Profile>([['default', { slug: 'acme' }], ['contoso-eu', { slug: 'contoso' }]]);

function lookup(id: EnterpriseId): Profile | undefined {
  return PROFILES.get(id);
}

function describeScope(res: Response): { id: string; slug: string } {
  const { id, profile } = enterpriseOf<Profile>(res);
  return { id, slug: profile.slug };
}

function scopedApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/enterprises/:enterpriseId', requireEnterprise(lookup));
  app.all('/api/enterprises/:enterpriseId/scope', (_req, res) => {
    res.json(describeScope(res));
  });
  app.get('/unscoped', (_req, res) => {
    res.json(describeScope(res));
  });
  app.use((error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
    const status = error instanceof EnterpriseScopeError ? error.status : 500;
    res.status(status).json({ code: error instanceof EnterpriseScopeError ? error.code : 'internal' });
  });
  return app;
}

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server: Server = await new Promise((resolve) => {
    const listening = scopedApp().listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function call(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function errorCode(url: string, init?: RequestInit): Promise<[number, unknown]> {
  const { status, body } = await call(url, init);
  const code = (body as { error?: { code?: unknown } }).error?.code;
  return [status, code];
}

function isScopeError(status: number, code: string): (error: unknown) => boolean {
  return (error) => error instanceof EnterpriseScopeError && error.status === status && error.code === code;
}

function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

test('accepts IDs of 2 to 32 lowercase letters, digits and inner hyphens', () => {
  for (const id of ['ab', 'default', 'contoso-eu', 'a1', `a${'b'.repeat(30)}c`]) {
    assert.equal(parseEnterpriseId(id), id);
  }
  assert.equal(isEnterpriseId(DEFAULT_ENTERPRISE_ID), true);
});

test('rejects malformed IDs with invalid_enterprise_id', () => {
  const malformed = ['a', '1abc', 'Abc', 'abc-', '-abc', 'ab_c', 'ab.c', `a${'b'.repeat(31)}c`, ' abc', 'abc\n', 42];
  for (const raw of malformed) {
    assert.throws(() => parseEnterpriseId(raw), isScopeError(400, 'invalid_enterprise_id'), String(raw));
  }
});

test('rejects a missing ID with enterprise_scope_required', () => {
  for (const raw of [undefined, null, '']) {
    assert.throws(() => parseEnterpriseId(raw), isScopeError(400, 'enterprise_scope_required'));
  }
});

test('stores the resolved enterprise for the route handler', async () => {
  await withApp(async (baseUrl) => {
    assert.deepEqual(await call(`${baseUrl}/api/enterprises/contoso-eu/scope`), {
      status: 200,
      body: { id: 'contoso-eu', slug: 'contoso' },
    });
    assert.deepEqual(await call(`${baseUrl}/api/enterprises/default/scope`), {
      status: 200,
      body: { id: 'default', slug: 'acme' },
    });
  });
});

test('answers 404 for unknown and 400 for malformed path IDs', async () => {
  await withApp(async (baseUrl) => {
    assert.deepEqual(await errorCode(`${baseUrl}/api/enterprises/unknown/scope`), [404, 'enterprise_not_found']);
    assert.deepEqual(await errorCode(`${baseUrl}/api/enterprises/Default/scope`), [400, 'invalid_enterprise_id']);
    assert.deepEqual(await errorCode(`${baseUrl}/api/enterprises/a/scope`), [400, 'invalid_enterprise_id']);
  });
});

test('accepts matching header, query and body IDs', async () => {
  await withApp(async (baseUrl) => {
    const url = `${baseUrl}/api/enterprises/contoso-eu/scope?enterpriseId=contoso-eu`;
    const init = postJson({ enterpriseId: 'contoso-eu' }, { 'x-enterprise-id': 'contoso-eu' });
    assert.equal((await call(url, init)).status, 200);
  });
});

test('rejects a header, query or body ID that names another enterprise', async () => {
  await withApp(async (baseUrl) => {
    const url = `${baseUrl}/api/enterprises/contoso-eu/scope`;
    const conflict = [400, 'enterprise_scope_conflict'];
    assert.deepEqual(await errorCode(url, { headers: { 'x-enterprise-id': 'default' } }), conflict);
    assert.deepEqual(await errorCode(`${url}?enterpriseId=default`), conflict);
    assert.deepEqual(await errorCode(`${url}?enterpriseId=contoso-eu&enterpriseId=contoso-eu`), conflict);
    assert.deepEqual(await errorCode(url, postJson({ enterpriseId: 'default' })), conflict);
    assert.deepEqual(await errorCode(url, postJson({ enterpriseId: null })), conflict);
  });
});

test('checks conflicts before revealing whether the path enterprise exists', async () => {
  await withApp(async (baseUrl) => {
    const init = { headers: { 'x-enterprise-id': 'default' } };
    const result = await errorCode(`${baseUrl}/api/enterprises/unknown/scope`, init);
    assert.deepEqual(result, [400, 'enterprise_scope_conflict']);
  });
});

test('reports a route mounted without requireEnterprise as a server error', async () => {
  await withApp(async (baseUrl) => {
    assert.deepEqual(await call(`${baseUrl}/unscoped`), { status: 500, body: { code: 'enterprise_scope_missing' } });
  });
});

test('error bodies use the shared API error shape', async () => {
  await withApp(async (baseUrl) => {
    const { body } = await call(`${baseUrl}/api/enterprises/unknown/scope`);
    const { error } = body as { error: { code: string; message: string } };
    assert.equal(error.code, 'enterprise_not_found');
    assert.equal(error.message, 'Enterprise "unknown" was not found.');
  });
});

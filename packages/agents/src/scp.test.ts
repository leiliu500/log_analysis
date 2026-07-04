import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { invokeApplication } from './scp.js';

/** Start a throwaway server that captures the request it receives. */
async function capture(): Promise<{ url: string; got: Promise<{ contentType: string; body: string }>; close: () => void }> {
  let resolve!: (v: { contentType: string; body: string }) => void;
  const got = new Promise<{ contentType: string; body: string }>((r) => (resolve = r));
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      resolve({ contentType: req.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, got, close: () => server.close() };
}

test('multipart POST sends payload + file fields to the endpoint URL', async () => {
  const s = await capture();
  try {
    const res = await invokeApplication({
      application: 'scp',
      url: s.url,
      request: { transactionType: 'USSS', messageId: '001' },
      file: { name: 'sample.xml', contentBase64: Buffer.from('<hello/>').toString('base64'), contentType: 'application/xml' },
      asForm: true,
    });
    assert.equal(res.status, 200);
    const { contentType, body } = await s.got;
    assert.match(contentType, /multipart\/form-data; boundary=/);
    assert.match(body, /name="payload"/);
    assert.match(body, /"transactionType":"USSS"/);
    assert.match(body, /name="file"; filename="sample\.xml"/);
    assert.match(body, /<hello\/>/);
  } finally {
    s.close();
  }
});

test('no file → JSON body (backward compatible)', async () => {
  const s = await capture();
  try {
    await invokeApplication({ application: 'scp', url: s.url, request: { a: 1 } });
    const { contentType, body } = await s.got;
    assert.match(contentType, /application\/json/);
    assert.equal(body, JSON.stringify({ a: 1 }));
  } finally {
    s.close();
  }
});

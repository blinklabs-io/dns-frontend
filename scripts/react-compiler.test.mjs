import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('Vite applies React Compiler to the application', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  })
  try {
    const result = await server.transformRequest('/src/App.tsx')
    assert.ok(result, 'Vite must transform the application entry component')
    assert.match(
      result.code,
      /react\.memo_cache_sentinel/,
      'React Compiler must emit memo-cache checks for the application',
    )
  } finally {
    await server.close()
  }
})

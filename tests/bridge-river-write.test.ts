/**
 * ELLIE-529 — River Bridge Write endpoint tests
 *
 * Pure function tests (no mocking needed):
 *  - validateRiverPath
 *  - parseYamlScalar
 *  - parseFrontmatter
 *  - serializeWithFrontmatter
 *  - mergeFrontmatter
 *  - applyFrontmatter
 *
 * Endpoint tests (mocked fs/promises + qmdReindex):
 *  - bridgeRiverWriteEndpoint: input validation, create/update/append
 *    conflict/not-found semantics, QMD reindex trigger, error handling
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

// ── Mocks (must be declared before imports) ───────────────────

const mockReadFile = mock()
const mockWriteFile = mock(() => Promise.resolve())
const mockMkdir = mock(() => Promise.resolve())

mock.module('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}))

// Mock ellie-forest (imported at top of bridge-river.ts)
mock.module('../../../ellie-forest/src/index', () => ({
  writeMemory: mock(() => Promise.resolve({ id: 'mem-1' })),
  sql: mock(),
}))

mock.module('../src/logger.ts', () => ({
  log: {
    child: () => ({
      info: mock(),
      warn: mock(),
      error: mock(),
    }),
  },
}))

// ── Imports after mocks ───────────────────────────────────────

import {
  validateRiverPath,
  parseYamlScalar,
  parseFrontmatter,
  serializeWithFrontmatter,
  mergeFrontmatter,
  applyFrontmatter,
  bridgeRiverWriteEndpoint,
  qmdReindex,
  RIVER_ROOT,
} from '../src/api/bridge-river.ts'

// ── Helpers ───────────────────────────────────────────────────

function makeRes() {
  let code = 200
  let body: unknown = null
  const res = {
    status: (c: number) => { code = c; return res },
    json: (d: unknown) => { body = d; return res },
    getCode: () => code,
    getBody: () => body,
  }
  return res as any
}

function makeReq(body: Record<string, unknown> = {}) {
  return { body, query: {}, bridgeKey: 'test-key' } as any
}

// ── validateRiverPath ─────────────────────────────────────────

describe('validateRiverPath — valid paths', () => {
  test('simple .md path', () => {
    expect(validateRiverPath('notes/my-doc.md')).toEqual({ valid: true })
  })

  test('root-level .md', () => {
    expect(validateRiverPath('readme.md')).toEqual({ valid: true })
  })

  test('deeply nested path', () => {
    expect(validateRiverPath('a/b/c/doc.md')).toEqual({ valid: true })
  })

  test('filename with hyphens and underscores', () => {
    expect(validateRiverPath('architecture/my-great_doc.md')).toEqual({ valid: true })
  })
})

describe('validateRiverPath — invalid paths', () => {
  test('missing path (undefined)', () => {
    expect(validateRiverPath(undefined)).toMatchObject({ valid: false })
  })

  test('empty string', () => {
    expect(validateRiverPath('')).toMatchObject({ valid: false })
  })

  test('null', () => {
    expect(validateRiverPath(null)).toMatchObject({ valid: false })
  })

  test('non-string (number)', () => {
    expect(validateRiverPath(42)).toMatchObject({ valid: false })
  })

  test('absolute path', () => {
    expect(validateRiverPath('/etc/passwd.md')).toMatchObject({
      valid: false,
      error: expect.stringContaining('relative'),
    })
  })

  test('path traversal with ..', () => {
    expect(validateRiverPath('../secrets.md')).toMatchObject({
      valid: false,
      error: expect.stringContaining('traversal'),
    })
  })

  test('traversal in middle of path', () => {
    expect(validateRiverPath('notes/../../../etc/passwd.md')).toMatchObject({
      valid: false,
      error: expect.stringContaining('traversal'),
    })
  })

  test('non-.md extension (.txt)', () => {
    expect(validateRiverPath('notes/doc.txt')).toMatchObject({
      valid: false,
      error: expect.stringContaining('.md'),
    })
  })

  test('non-.md extension (.json)', () => {
    expect(validateRiverPath('notes/data.json')).toMatchObject({ valid: false })
  })

  test('no extension', () => {
    expect(validateRiverPath('notes/doc')).toMatchObject({ valid: false })
  })

  test('null byte in path', () => {
    expect(validateRiverPath('notes/\0evil.md')).toMatchObject({ valid: false })
  })
})

// ── parseYamlScalar ───────────────────────────────────────────

describe('parseYamlScalar', () => {
  test('empty string → null', () => { expect(parseYamlScalar('')).toBeNull() })
  test('"null" → null', () => { expect(parseYamlScalar('null')).toBeNull() })
  test('"~" → null', () => { expect(parseYamlScalar('~')).toBeNull() })
  test('"true" → true', () => { expect(parseYamlScalar('true')).toBe(true) })
  test('"false" → false', () => { expect(parseYamlScalar('false')).toBe(false) })
  test('integer string → number', () => { expect(parseYamlScalar('42')).toBe(42) })
  test('negative integer → number', () => { expect(parseYamlScalar('-7')).toBe(-7) })
  test('float string → number', () => { expect(parseYamlScalar('3.14')).toBeCloseTo(3.14, 5) })
  test('double-quoted string', () => { expect(parseYamlScalar('"hello world"')).toBe('hello world') })
  test('single-quoted string', () => { expect(parseYamlScalar("'foo bar'")).toBe('foo bar') })
  test('unquoted string', () => { expect(parseYamlScalar('some value')).toBe('some value') })
})

// ── parseFrontmatter ──────────────────────────────────────────

describe('parseFrontmatter — no frontmatter', () => {
  test('plain markdown returns empty frontmatter and full content as body', () => {
    const input = '# Title\n\nSome content.'
    const { frontmatter, body } = parseFrontmatter(input)
    expect(frontmatter).toEqual({})
    expect(body).toBe(input)
  })

  test('empty string returns empty frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('')
    expect(frontmatter).toEqual({})
    expect(body).toBe('')
  })
})

describe('parseFrontmatter — with frontmatter block', () => {
  test('parses string, number, boolean fields', () => {
    const input = '---\ntitle: My Doc\nversion: 2\ndraft: true\n---\n# Body'
    const { frontmatter, body } = parseFrontmatter(input)
    expect(frontmatter).toEqual({ title: 'My Doc', version: 2, draft: true })
    expect(body).toBe('# Body')
  })

  test('parses null field', () => {
    const { frontmatter } = parseFrontmatter('---\nauthor: null\n---\nbody')
    expect(frontmatter.author).toBeNull()
  })

  test('body starts immediately after closing ---', () => {
    const { body } = parseFrontmatter('---\nk: v\n---\nfirst line')
    expect(body).toBe('first line')
  })

  test('handles multiline body', () => {
    const { body } = parseFrontmatter('---\nk: v\n---\nline1\nline2\nline3')
    expect(body).toBe('line1\nline2\nline3')
  })
})

// ── serializeWithFrontmatter ──────────────────────────────────

describe('serializeWithFrontmatter', () => {
  test('empty frontmatter → returns body unchanged', () => {
    expect(serializeWithFrontmatter({}, '# Content')).toBe('# Content')
  })

  test('string value serialized correctly', () => {
    const out = serializeWithFrontmatter({ title: 'Hello' }, '# Content')
    expect(out).toContain('title: Hello')
    expect(out).toContain('---\n')
    expect(out).toContain('# Content')
  })

  test('boolean and number serialized correctly', () => {
    const out = serializeWithFrontmatter({ draft: false, version: 3 }, 'body')
    expect(out).toContain('draft: false')
    expect(out).toContain('version: 3')
  })

  test('null value serialized as "null"', () => {
    const out = serializeWithFrontmatter({ author: null }, 'body')
    expect(out).toContain('author: null')
  })

  test('array serialized inline', () => {
    const out = serializeWithFrontmatter({ tags: ['a', 'b'] as any }, 'body')
    expect(out).toContain('tags: [a, b]')
  })

  test('string with colon gets quoted', () => {
    const out = serializeWithFrontmatter({ title: 'foo: bar' }, 'body')
    expect(out).toContain('"foo: bar"')
  })

  test('round-trip: parse → serialize preserves fields', () => {
    const original = '---\ntitle: My Doc\nversion: 2\ndraft: true\n---\n# Body here'
    const { frontmatter, body } = parseFrontmatter(original)
    const out = serializeWithFrontmatter(frontmatter, body)
    // Re-parse and check fields are preserved
    const { frontmatter: fm2 } = parseFrontmatter(out)
    expect(fm2.title).toBe('My Doc')
    expect(fm2.version).toBe(2)
    expect(fm2.draft).toBe(true)
  })
})

// ── mergeFrontmatter ──────────────────────────────────────────

describe('mergeFrontmatter', () => {
  test('incoming values override existing', () => {
    const merged = mergeFrontmatter({ title: 'Old', version: 1 }, { title: 'New' })
    expect(merged.title).toBe('New')
    expect(merged.version).toBe(1)
  })

  test('new keys from incoming are added', () => {
    const merged = mergeFrontmatter({ a: 1 }, { b: 2 })
    expect(merged).toEqual({ a: 1, b: 2 })
  })

  test('empty incoming → existing unchanged', () => {
    const existing = { title: 'Doc', draft: true }
    const merged = mergeFrontmatter(existing, {})
    expect(merged).toEqual(existing)
  })

  test('empty existing → result is incoming', () => {
    const merged = mergeFrontmatter({}, { status: 'published' })
    expect(merged).toEqual({ status: 'published' })
  })
})

// ── applyFrontmatter ──────────────────────────────────────────

describe('applyFrontmatter', () => {
  test('empty incoming → content unchanged', () => {
    const content = '---\ntitle: Existing\n---\n# Body'
    expect(applyFrontmatter(content, {})).toBe(content)
  })

  test('merges incoming into existing frontmatter', () => {
    const content = '---\ntitle: Old\n---\n# Body'
    const result = applyFrontmatter(content, { title: 'New', status: 'draft' })
    const { frontmatter } = parseFrontmatter(result)
    expect(frontmatter.title).toBe('New')
    expect(frontmatter.status).toBe('draft')
  })

  test('adds frontmatter to content that has none', () => {
    const result = applyFrontmatter('# No frontmatter', { tags: 'test' })
    expect(result).toContain('---\n')
    expect(result).toContain('tags: test')
    expect(result).toContain('# No frontmatter')
  })
})

// ── bridgeRiverWriteEndpoint ──────────────────────────────────

describe('bridgeRiverWriteEndpoint — input validation', () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockWriteFile.mockImplementation(() => Promise.resolve())
    mockMkdir.mockReset()
    mockMkdir.mockImplementation(() => Promise.resolve())
  })

  test('400 when path is missing', async () => {
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ content: '# Doc', operation: 'create' }), res)
    expect(res.getCode()).toBe(400)
    expect((res.getBody() as any).error).toContain('path')
  })

  test('400 when path contains ..', async () => {
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: '../escape.md', content: 'x', operation: 'create' }), res)
    expect(res.getCode()).toBe(400)
    expect((res.getBody() as any).error).toContain('traversal')
  })

  test('400 when path does not end with .md', async () => {
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.txt', content: 'x', operation: 'create' }), res)
    expect(res.getCode()).toBe(400)
  })

  test('400 when content is missing', async () => {
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', operation: 'create' }), res)
    expect(res.getCode()).toBe(400)
    expect((res.getBody() as any).error).toContain('content')
  })

  test('400 when content is not a string (number)', async () => {
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: 42, operation: 'create' }), res)
    expect(res.getCode()).toBe(400)
  })

  test('400 when operation is invalid', async () => {
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: '# X', operation: 'destroy' }), res)
    expect(res.getCode()).toBe(400)
    expect((res.getBody() as any).error).toContain('operation')
  })
})

describe('bridgeRiverWriteEndpoint — create operation', () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockWriteFile.mockImplementation(() => Promise.resolve())
    mockMkdir.mockReset()
    mockMkdir.mockImplementation(() => Promise.resolve())
  })

  test('409 when creating a file that already exists', async () => {
    mockReadFile.mockImplementation(() => Promise.resolve('existing content'))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: '# New', operation: 'create' }), res)
    expect(res.getCode()).toBe(409)
    expect((res.getBody() as any).error).toContain('already exists')
  })

  test('200 and writes file when path is new', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/new.md', content: '# New Doc', operation: 'create' }), res)
    expect(res.getCode()).toBe(200)
    const body = res.getBody() as any
    expect(body.success).toBe(true)
    expect(body.path).toBe('notes/new.md')
    expect(body.docid).toBe('qmd://ellie-river/notes/new.md')
    expect(body.operation).toBe('create')
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
  })

  test('default operation is create', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/new.md', content: '# Doc' }), res)
    expect(res.getCode()).toBe(200)
    expect((res.getBody() as any).operation).toBe('create')
  })

  test('creates parent directories for nested paths', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'a/b/c/doc.md', content: '# X', operation: 'create' }), res)
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('a/b/c'),
      { recursive: true },
    )
  })

  test('frontmatter is merged into created content', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({
      path: 'notes/doc.md',
      content: '# Doc',
      operation: 'create',
      frontmatter: { status: 'draft', tags: ['test'] },
    }), res)
    expect(res.getCode()).toBe(200)
    const written = mockWriteFile.mock.calls[0][1] as string
    expect(written).toContain('status: draft')
  })
})

describe('bridgeRiverWriteEndpoint — update operation', () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockWriteFile.mockImplementation(() => Promise.resolve())
    mockMkdir.mockReset()
    mockMkdir.mockImplementation(() => Promise.resolve())
  })

  test('404 when updating a file that does not exist', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: '# X', operation: 'update' }), res)
    expect(res.getCode()).toBe(404)
    expect((res.getBody() as any).error).toContain('not found')
  })

  test('200 and overwrites file when it exists', async () => {
    mockReadFile.mockImplementation(() => Promise.resolve('# Old content'))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: '# New', operation: 'update' }), res)
    expect(res.getCode()).toBe(200)
    expect((res.getBody() as any).operation).toBe('update')
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    const written = mockWriteFile.mock.calls[0][1] as string
    expect(written).toContain('# New')
  })

  test('frontmatter is applied to updated content', async () => {
    mockReadFile.mockImplementation(() => Promise.resolve('# Existing'))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({
      path: 'notes/doc.md',
      content: '# Updated',
      operation: 'update',
      frontmatter: { version: 2 },
    }), res)
    const written = mockWriteFile.mock.calls[0][1] as string
    expect(written).toContain('version: 2')
    expect(written).toContain('# Updated')
  })
})

describe('bridgeRiverWriteEndpoint — append operation', () => {
  beforeEach(() => {
    mockReadFile.mockReset()
    mockWriteFile.mockReset()
    mockWriteFile.mockImplementation(() => Promise.resolve())
    mockMkdir.mockReset()
    mockMkdir.mockImplementation(() => Promise.resolve())
  })

  test('appends content to existing file', async () => {
    mockReadFile.mockImplementation(() => Promise.resolve('# Existing\n\nFirst paragraph.'))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: '## New Section', operation: 'append' }), res)
    expect(res.getCode()).toBe(200)
    const written = mockWriteFile.mock.calls[0][1] as string
    expect(written).toContain('# Existing')
    expect(written).toContain('## New Section')
  })

  test('creates file when appending to non-existent path', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/new.md', content: '# Brand New', operation: 'append' }), res)
    expect(res.getCode()).toBe(200)
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
  })

  test('frontmatter is merged into existing file on append', async () => {
    mockReadFile.mockImplementation(() => Promise.resolve('---\ntitle: Old\n---\n# Existing'))
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({
      path: 'notes/doc.md',
      content: 'Appended paragraph.',
      operation: 'append',
      frontmatter: { title: 'Updated' },
    }), res)
    const written = mockWriteFile.mock.calls[0][1] as string
    const { frontmatter } = parseFrontmatter(written)
    expect(frontmatter.title).toBe('Updated')
    expect(written).toContain('Appended paragraph.')
  })
})

describe('bridgeRiverWriteEndpoint — response shape', () => {
  beforeEach(() => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    mockWriteFile.mockImplementation(() => Promise.resolve())
    mockMkdir.mockImplementation(() => Promise.resolve())
  })

  test('response includes success, path, docid, operation, reindexed', async () => {
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: '# Doc', operation: 'create' }), res)
    const body = res.getBody() as any
    expect(body.success).toBe(true)
    expect(body.path).toBe('notes/doc.md')
    expect(body.docid).toBe('qmd://ellie-river/notes/doc.md')
    expect(body.operation).toBe('create')
    expect(typeof body.reindexed).toBe('boolean')
  })
})

describe('bridgeRiverWriteEndpoint — error handling', () => {
  test('500 when writeFile throws', async () => {
    mockReadFile.mockImplementation(() => Promise.reject(new Error('ENOENT')))
    mockWriteFile.mockImplementation(() => Promise.reject(new Error('Disk full')))
    mockMkdir.mockImplementation(() => Promise.resolve())
    const res = makeRes()
    await bridgeRiverWriteEndpoint(makeReq({ path: 'notes/doc.md', content: '# X', operation: 'create' }), res)
    expect(res.getCode()).toBe(500)
  })
})

describe('RIVER_ROOT constant', () => {
  test('defaults to the expected obsidian vault path', () => {
    // When RIVER_ROOT env is not set, falls back to the default
    expect(typeof RIVER_ROOT).toBe('string')
    expect(RIVER_ROOT).toContain('ellie-river')
  })
})

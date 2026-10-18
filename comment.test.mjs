import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARKER, MAX_COMMENT, ERROR_BODY, buildComment, isInSync, upsertComment, guard } from './comment.mjs'

test('buildComment prefixes the marker', () => {
  const body = buildComment('## Drift\n- API: +1 endpoint', false)
  assert.ok(body.startsWith(MARKER))
  assert.equal(MARKER, '<!-- modudraft-drift-check -->')
  assert.match(body, /API: \+1 endpoint/)
})

test('buildComment renders In sync with the checked line', () => {
  const body = buildComment('In sync\n\nChecked: openapi.yaml, schema.sql\n', true)
  assert.ok(body.startsWith(MARKER))
  assert.match(body, /In sync ✓/)
  assert.match(body, /Checked: openapi\.yaml, schema\.sql/)
})

function mockFetch(pages, calls) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init })
    if (!init.method || init.method === 'GET') {
      const page = Number(new URL(url).searchParams.get('page') || 1)
      return { ok: true, status: 200, json: async () => pages[page - 1] ?? [] }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }
}

test('upsertComment PATCHes an existing marker comment', async () => {
  const calls = []
  const f = mockFetch([[{ id: 1, body: 'x' }, { id: 7, body: `${MARKER}\nold`, user: { type: 'Bot' } }]], calls)
  await upsertComment({ repo: 'o/r', pr: 5, token: 't', body: `${MARKER}\nnew`, fetch: f })
  const last = calls.at(-1)
  assert.equal(last.method, 'PATCH')
  assert.match(last.url, /\/repos\/o\/r\/issues\/comments\/7$/)
  assert.equal(JSON.parse(last.init.body).body, `${MARKER}\nnew`)
  assert.equal(last.init.headers.Authorization, 'Bearer t')
})

test('upsertComment POSTs when none has the marker', async () => {
  const calls = []
  const f = mockFetch([[{ id: 1, body: 'x' }]], calls)
  await upsertComment({ repo: 'o/r', pr: 5, token: 't', body: `${MARKER}\nnew`, fetch: f })
  const last = calls.at(-1)
  assert.equal(last.method, 'POST')
  assert.match(last.url, /\/repos\/o\/r\/issues\/5\/comments$/)
})

test('upsertComment paginates', async () => {
  const calls = []
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'x' }))
  const f = mockFetch([full, [{ id: 500, body: MARKER, user: { type: 'Bot' } }]], calls)
  await upsertComment({ repo: 'o/r', pr: 5, token: 't', body: MARKER, fetch: f })
  assert.match(calls.at(-1).url, /comments\/500$/)
})

test('upsertComment throws on API failure', async () => {
  const f = async () => ({ ok: false, status: 403, text: async () => 'nope' })
  await assert.rejects(() => upsertComment({ repo: 'o/r', pr: 1, token: 't', body: 'b', fetch: f }), /403/)
})

test('guard skips without a key on PR events', () => {
  assert.deepEqual(guard({ event: 'pull_request', onDrift: 'fail', allowUpdateOnPr: false, apiKey: '' }), { skip: 'no-key' })
})

test('guard fails without a key on non-PR events', () => {
  assert.throws(() => guard({ event: 'push', onDrift: 'fail', allowUpdateOnPr: false, apiKey: '' }), /MODUDRAFT_API_KEY secret is not set/)
})

test('guard refuses update-diagram on PRs', () => {
  assert.throws(
    () => guard({ event: 'pull_request', onDrift: 'update-diagram', allowUpdateOnPr: false, apiKey: 'k' }),
    /update-diagram on pull requests needs allow-update-on-pr: true/,
  )
})

test('guard allows override and other cases', () => {
  assert.deepEqual(guard({ event: 'pull_request', onDrift: 'update-diagram', allowUpdateOnPr: true, apiKey: 'k' }), { ok: true })
  assert.deepEqual(guard({ event: 'push', onDrift: 'update-diagram', allowUpdateOnPr: false, apiKey: 'k' }), { ok: true })
  assert.deepEqual(guard({ event: 'pull_request', onDrift: 'fail', allowUpdateOnPr: false, apiKey: 'k' }), { ok: true })
})

test('guard rejects invalid on-drift', () => {
  assert.throws(() => guard({ event: 'push', onDrift: 'bogus', allowUpdateOnPr: false, apiKey: 'k' }), /on-drift/)
})

test('guard fails closed for update-diagram on every non-write event', () => {
  for (const event of ['pull_request_review', 'pull_request_review_comment', 'issue_comment', 'workflow_run', 'pull_request_target', 'pull_request']) {
    assert.throws(() => guard({ event, onDrift: 'update-diagram', allowUpdateOnPr: false, apiKey: 'k' }), /allow-update-on-pr: true/, event)
    assert.deepEqual(guard({ event, onDrift: 'update-diagram', allowUpdateOnPr: true, apiKey: 'k' }), { ok: true })
  }
  for (const event of ['push', 'workflow_dispatch', 'schedule']) {
    assert.deepEqual(guard({ event, onDrift: 'update-diagram', allowUpdateOnPr: false, apiKey: 'k' }), { ok: true })
  }
})

test('buildComment writes a short error body only for empty input', () => {
  for (const body of [buildComment('', false), buildComment('   \n', true), buildComment('', false, { exitCode: 2 })]) {
    assert.ok(body.startsWith(MARKER))
    assert.match(body, new RegExp(ERROR_BODY.replace('—', '—')))
  }
})

test('exit 2 with output posts the CLI markdown, errors included, never the in-sync shortcut', () => {
  const md = '**Errors in 1 file**\n\nChecked: `openapi.yaml`\n\n### Errors\n\n- `openapi.yaml`: bad yaml\n'
  for (const inSync of [false, true]) {
    const body = buildComment(md, inSync, { exitCode: 2 })
    assert.ok(body.startsWith(MARKER))
    assert.match(body, /### Errors/)
    assert.match(body, /bad yaml/)
    assert.doesNotMatch(body, /In sync ✓/)
    assert.doesNotMatch(body, new RegExp(ERROR_BODY))
  }
  // Even a stale "In sync" headline with exit 2 is not shortened.
  const stale = '**In sync**\n\n### Errors\n\n- `a.yaml`: broken\n'
  assert.match(buildComment(stale, isInSync(stale), { exitCode: 2 }), /broken/)
})

test('the in-sync comment keeps the Warnings section', () => {
  const md =
    '**In sync**\n\nChecked: `openapi.yaml`\n\n### Warnings\n\n- file listing stopped at 50000 files; globs may miss files\n'
  const body = buildComment(md, isInSync(md))
  assert.match(body, /In sync ✓/)
  assert.match(body, /### Warnings/)
  assert.match(body, /globs may miss files/)
  assert.doesNotMatch(buildComment('**In sync**\n\nChecked: `a`\n', true), /Warnings/)
})

test('buildComment truncates long reports under the limit', () => {
  const body = buildComment('x'.repeat(200000), false)
  assert.ok(body.length <= MAX_COMMENT)
  assert.ok(body.startsWith(MARKER))
  assert.match(body, /…truncated, see the job summary/)
  assert.ok(buildComment('short', false).length < 100)
})

test('upsertComment ignores human comments that quote the marker', async () => {
  const calls = []
  const f = mockFetch(
    [[{ id: 1, body: `${MARKER} quoted`, user: { type: 'User' } }, { id: 2, body: `see ${MARKER}`, user: { type: 'Bot' } }]],
    calls,
  )
  await upsertComment({ repo: 'o/r', pr: 5, token: 't', body: `${MARKER}\nnew`, fetch: f })
  assert.equal(calls.at(-1).method, 'POST')
})

test('in-sync detection accepts the real bold CLI output', () => {
  const md = '**In sync**\n\nChecked: `docker-compose.yml`, `openapi.yaml`\n'
  assert.equal(isInSync(md), true)
  assert.equal(isInSync('In sync\n'), true)
  assert.equal(isInSync('## Drift\n- API: +1'), false)
  const body = buildComment(md, isInSync(md))
  assert.match(body, /In sync ✓/)
  assert.match(body, /Checked: `docker-compose\.yml`, `openapi\.yaml`/)
})

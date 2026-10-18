// Helpers for the drift-check Action: PR comment upsert and input guard.
// Plain ES module, Node 20+, no dependencies.
import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MARKER = '<!-- modudraft-drift-check -->'
const ON_DRIFT = ['report', 'fail', 'update-diagram']

export const MAX_COMMENT = 60000
export const ERROR_BODY = 'Drift check failed to run — see the job log.'
const TRUNC_NOTE = '\n\n…truncated, see the job summary'

/** The "### Warnings" section of the CLI markdown (it is the last section), or ''. */
function warningsSection(text) {
  const i = text.search(/^### Warnings\s*$/m)
  return i < 0 ? '' : text.slice(i).trim()
}

export function buildComment(markdown, inSync, { exitCode, max = MAX_COMMENT } = {}) {
  const text = String(markdown ?? '').trim()
  // Only an empty output gets the short error body: on exit 2 the CLI markdown lists the errors.
  if (!text) return `${MARKER}\n${ERROR_BODY}\n`
  if (inSync && Number(exitCode) !== 2) {
    const checked = text.split('\n').find((l) => l.trim().startsWith('Checked:'))
    const warnings = warningsSection(text)
    const short = [
      MARKER,
      '## Modudraft drift check',
      '',
      'In sync ✓',
      ...(checked ? ['', checked.trim()] : []),
      ...(warnings ? ['', warnings] : []),
      '',
    ].join('\n')
    if (short.length <= max) return short
  }
  const head = `${MARKER}\n`
  if (head.length + text.length + 1 <= max) return `${head}${text}\n`
  return `${head}${text.slice(0, max - head.length - TRUNC_NOTE.length - 1)}${TRUNC_NOTE}\n`
}

export function isInSync(markdown) {
  return /^\s*[*_]*In sync/m.test(String(markdown ?? ''))
}

export function isStickyComment(c) {
  return c?.user?.type === 'Bot' && typeof c.body === 'string' && c.body.startsWith(MARKER)
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
}

async function ensureOk(res, what) {
  if (!res.ok) {
    const detail = typeof res.text === 'function' ? await res.text() : ''
    throw new Error(`GitHub API ${what} failed: ${res.status} ${detail}`.trim())
  }
}

export async function upsertComment({ repo, pr, token, body, fetch: f = fetch, apiUrl = 'https://api.github.com' }) {
  const base = `${apiUrl}/repos/${repo}`
  let existing = null
  for (let page = 1; !existing; page++) {
    const res = await f(`${base}/issues/${pr}/comments?per_page=100&page=${page}`, { headers: headers(token) })
    await ensureOk(res, 'list comments')
    const items = await res.json()
    existing = items.find(isStickyComment) ?? null
    if (items.length < 100) break
  }
  const res = existing
    ? await f(`${base}/issues/comments/${existing.id}`, { method: 'PATCH', headers: headers(token), body: JSON.stringify({ body }) })
    : await f(`${base}/issues/${pr}/comments`, { method: 'POST', headers: headers(token), body: JSON.stringify({ body }) })
  await ensureOk(res, existing ? 'update comment' : 'create comment')
  return { updated: Boolean(existing) }
}

const PR_EVENTS = ['pull_request', 'pull_request_target']
const WRITE_EVENTS = ['push', 'workflow_dispatch', 'schedule']

export function guard({ event, onDrift, allowUpdateOnPr, apiKey }) {
  if (!apiKey) {
    // Secrets are withheld from fork pull requests; anywhere else a missing key is a setup mistake.
    if (PR_EVENTS.includes(event)) return { skip: 'no-key' }
    throw new Error('MODUDRAFT_API_KEY secret is not set (pass it as the api-key input)')
  }
  if (!ON_DRIFT.includes(onDrift)) throw new Error(`on-drift must be one of ${ON_DRIFT.join(', ')} (got "${onDrift}")`)
  if (onDrift === 'update-diagram' && !allowUpdateOnPr && !WRITE_EVENTS.includes(event)) {
    const where = PR_EVENTS.includes(event) ? 'pull requests' : `${event} events`
    throw new Error(`update-diagram on ${where} needs allow-update-on-pr: true`)
  }
  return { ok: true }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

async function main(cmd) {
  const env = process.env
  if (cmd === 'guard') {
    try {
      const r = guard({
        event: env.GITHUB_EVENT_NAME,
        onDrift: env.INPUT_ON_DRIFT,
        allowUpdateOnPr: env.INPUT_ALLOW_UPDATE_ON_PR === 'true',
        apiKey: env.MODUDRAFT_API_KEY,
      })
      if (r.skip) {
        console.log('::warning::No api-key provided (secrets are unavailable on fork pull requests); skipping the drift check.')
        setOutput('skip', 'true')
      } else {
        setOutput('skip', 'false')
      }
    } catch (e) {
      console.log(`::error::${e.message}`)
      process.exit(2)
    }
    return
  }
  if (cmd === 'upsert') {
    // Never change the job result: any failure here is a warning.
    try {
      let markdown = ''
      try {
        markdown = readFileSync(env.DRIFT_OUTPUT_FILE, 'utf8')
      } catch {}
      const exitCode = env.EXIT_CODE
      if (!markdown.trim()) console.log('::error::Drift check failed to run; see the job log.')
      else if (Number(exitCode) === 2) console.log('::error::Drift check reported errors; see the job summary.')
      const inSync = isInSync(markdown)
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
      const pr = event.pull_request?.number
      if (!pr) throw new Error('No pull_request.number in the event payload')
      await upsertComment({
        repo: env.GITHUB_REPOSITORY,
        pr,
        token: env.GITHUB_TOKEN,
        body: buildComment(markdown, inSync, { exitCode }),
        apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      })
    } catch (e) {
      console.log(`::warning::Could not post the PR comment: ${e.message}`)
    }
    return
  }
  console.error(`Unknown command: ${cmd}`)
  process.exit(2)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch((e) => {
    console.log(`::error::${e.message}`)
    process.exit(2)
  })
}

import { chromium, expect } from 'playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dir, '..')
const require = createRequire(join(root, 'package.json'))
const stage = mkdtempSync(join(tmpdir(), 'projects-detail-browser-'))
const report = join(root, 'test-results/bakin-ui-detail-interactions')
const errors: string[] = []
const checks: string[] = []
const result = await Bun.build({ entrypoints: [join(root, 'tests/detail.fixture.tsx')], outdir: stage, target: 'browser', format: 'esm', splitting: true,
  naming: { entry: 'fixture.[ext]', chunk: '[name]-[hash].[ext]' }, define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{ name: 'canonical-css', setup(builder) { builder.onResolve({ filter: /^@makinbakin\/sdk\/styles\.css$/ }, () => ({ path: 'styles', namespace: 'canonical-css' })); builder.onLoad({ filter: /.*/, namespace: 'canonical-css' }, () => ({ contents: '', loader: 'css' })) } }],
})
if (!result.success) throw new Error(result.logs.map(String).join('\n'))
await Bun.write(join(stage, 'sdk-styles.css'), readFileSync(require.resolve('@makinbakin/sdk/styles.css')))
await Bun.write(join(stage, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/sdk-styles.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>')
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  const file = Bun.file(join(stage, path === '/' ? 'index.html' : path))
  return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
} })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const requests = () => page.evaluate(() => (window as any).__projectsFixture.state.requests as { method: string; path: string; body: any }[])
  const composer = page.getByRole('textbox', { name: /^Message / })
  const dock = page.getByRole('complementary', { name: 'Project conversation' })

  await page.goto(server.url.href)
  await page.locator('[data-slot="project-tab-panel"] [data-conv-empty]').waitFor()
  await expect(page.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true')
  await expect(composer).toHaveCount(1)
  await expect(dock).toHaveCount(0)
  await composer.fill('Keep this draft')
  await page.getByRole('tab', { name: 'Plan' }).click()
  await page.locator('[data-md-changed-block]').waitFor()
  await expect(dock).toBeVisible()
  await expect(composer).toHaveCount(1)
  await expect(composer).toHaveValue('Keep this draft')
  await dock.getByRole('button', { name: 'Collapse project conversation' }).click()
  await expect(composer).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand project conversation' }).click()
  await expect(composer).toHaveValue('Keep this draft')
  checks.push('one composer in every tab and dock state; the draft survives tab switches and collapse')

  await page.getByRole('tab', { name: 'Steps' }).click()
  await expect(page.getByText('1 of 2 steps done', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Add a step', exact: true }).fill('Retained step draft')
  await page.evaluate(() => { (window as any).__projectsFixture.state.loseAddReply = true })
  await page.getByRole('button', { name: 'Add step' }).click()
  await expect(page.getByText('Could not reach Projects. Check your connection and retry.')).toBeVisible()
  await page.getByRole('button', { name: 'Add step' }).click()
  await expect(page.getByRole('textbox', { name: 'Add a step', exact: true })).toHaveValue('')
  expect(await page.evaluate(() => (window as any).__projectsFixture.state.project.tasks.filter((item: any) => item.title === 'Retained step draft').length)).toBe(1)
  checks.push('a lost add response keeps the step draft and retries one receipt without a duplicate')

  for (const [title, value] of [['Prepare camera gear', 'First saved description'], ['Confirm walking route', 'Second saved description']]) {
    await page.getByRole('button', { name: title, exact: true }).click()
    await page.getByRole('button', { name: `Edit details for ${title}` }).click()
    await page.getByRole('textbox', { name: `Details for ${title}` }).fill(value!)
  }
  await page.evaluate(() => { (window as any).__projectsFixture.state.failures['PUT /api/plugins/projects/sample/checklist/t002'] = 1 })
  await page.getByRole('button', { name: 'Back to projects' }).click()
  await page.getByRole('button', { name: 'Save all and leave' }).click()
  await expect(page.getByText('The plan is saved. Some step edits remain unsaved; retry saves only the unfinished work.')).toBeVisible()
  await page.getByRole('button', { name: 'Save all and leave' }).click()
  await expect(page.getByRole('heading', { name: 'Project list fixture' })).toBeVisible()
  const sent = await requests()
  expect(sent.filter(request => request.method === 'PUT' && request.path.endsWith('/checklist/t001'))).toHaveLength(1)
  expect(sent.filter(request => request.method === 'PUT' && request.path.endsWith('/checklist/t002'))).toHaveLength(2)
  expect(sent.filter(request => request.path.endsWith('/ask'))).toHaveLength(0)
  checks.push('Save all keeps partial successes, retries only pending drafts, and never sends the composer draft')

  await page.goto(`${server.url.href}?scenario=plan-updated`)
  await expect(page.getByText(/^Plan updated/)).toBeVisible()
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.getByRole('tab', { name: /^Plan/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('plan-history-diff')).toBeVisible()
  await expect.poll(async () => (await requests()).filter(request => request.path.endsWith('/plan/seen')).map(request => request.body)).toEqual([{ revision: 2 }])
  checks.push('"Plan updated" reviews changes against the last-seen revision and marks the new one seen')
  await page.close()

  const mobile = await browser.newPage({ viewport: { width: 320, height: 800 } })
  mobile.setDefaultTimeout(15_000)
  mobile.on('pageerror', error => errors.push(error.message))
  mobile.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await mobile.goto(`${server.url.href}?tab=steps`)
  await mobile.getByRole('list', { name: 'Project steps' }).waitFor()
  await expect(mobile.getByRole('complementary', { name: 'Project conversation' })).toHaveCount(0)
  await expect(mobile.getByRole('textbox', { name: /^Message / })).toHaveCount(0)
  await mobile.getByRole('button', { name: 'Ask Main' }).click()
  await expect(mobile.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true')
  await expect(mobile.getByRole('textbox', { name: /^Message / })).toHaveCount(1)
  await mobile.evaluate(() => { document.documentElement.style.fontSize = '200%' })
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  await mobile.screenshot({ path: join(report, 'mobile-conversation-200.png'), fullPage: true })
  checks.push('mobile drops the dock for an Ask button that opens the conversation; 200% text fits')

  await mobile.goto(`${server.url.href}?tab=plan&scenario=history-error`)
  await expect(mobile.getByText('Plan history unavailable')).toBeVisible()
  await mobile.getByRole('button', { name: 'Try again', exact: true }).click()
  await mobile.locator('[data-md-changed-block]').waitFor()
  checks.push('a history failure is retryable and never presented as empty')
  expect(errors).toEqual([])
  await Bun.write(join(report, 'report.json'), JSON.stringify({ status: 'passed', checks, errors }, null, 2))
  await Bun.write(join(report, 'index.html'), `<!doctype html><title>Projects detail interactions</title><h1>Projects detail interactions passed</h1><ul>${checks.map(check => `<li>${check}</li>`).join('')}</ul><img src="mobile-conversation-200.png" alt="Mobile conversation at 200% text">`)
  console.log(`Passed ${checks.length} Projects detail browser scenarios. Report: ${report}/index.html`)
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: join(report, 'failure.png'), fullPage: true }).catch(() => {})
    await Bun.write(join(report, 'failure.html'), await page.content())
  }
  console.error('Browser console:', errors)
  throw error
} finally { await browser.close(); server.stop(true); rmSync(stage, { recursive: true, force: true }) }

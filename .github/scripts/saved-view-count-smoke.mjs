// Run only on a disposable hosted runner with a fresh local NocoDB backend.
// Requires Playwright (including Chromium) installed beside this script.
// FRONTEND_URL defaults to http://127.0.0.1:3000; BACKEND_URL to :8080.
// SMOKE_ARTIFACT_DIR defaults to $RUNNER_TEMP/bounty-browser-artifacts.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, request } from 'playwright'

function isLoopback(rawUrl, protocols = ['http:', 'https:']) {
  try {
    const url = new URL(rawUrl)
    return protocols.includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password
  } catch {
    return false
  }
}

const frontend = process.env.FRONTEND_URL || 'http://127.0.0.1:3000'
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8080'
assert.ok(isLoopback(frontend) && isLoopback(backend), 'Smoke URLs must use loopback HTTP(S) hosts')
const artifactDir = resolve(process.env.SMOKE_ARTIFACT_DIR ||
  join(process.env.RUNNER_TEMP || tmpdir(), 'bounty-browser-artifacts'))
const suffix = randomBytes(6).toString('hex')
const email = `smoke-${suffix}@example.invalid`
const password = `Smoke!${randomBytes(24).toString('hex')}Aa9`
let token = ''
let browser, context, page, apiContext
let phase = 'startup'
let blockedRequests = 0

function stage(name) {
  phase = name
  console.log(`Smoke: ${name}`)
}

async function api(method, path, data) {
  const url = new URL(path, backend)
  assert.ok(isLoopback(url.href) && url.origin === new URL(backend).origin,
    'Fixture API request must stay on the configured local backend')
  let response
  try {
    response = await apiContext.fetch(url.href, {
      method,
      data,
      headers: token ? { 'xc-auth': token } : {},
      maxRedirects: 0,
      timeout: 30_000,
    })
  } catch {
    throw new Error(`Local API transport failed: ${method} ${url.pathname}`)
  }
  assert.ok(response.ok(), `Local API returned HTTP ${response.status()}: ${method} ${url.pathname}`)
  try {
    return await response.json()
  } catch {
    throw new Error(`Local API returned invalid JSON: ${method} ${url.pathname}`)
  }
}

function entityId(entity, label) {
  assert.ok(entity && typeof entity.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(entity.id),
    `Local API did not return a valid ${label} ID`)
  return entity.id
}

async function eventually(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(250)
  }
  throw new Error(`Timed out: ${description}`)
}

async function screenshot(name) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(artifactDir, name), fullPage: true, timeout: 15_000 })
  }
}

try {
  await mkdir(artifactDir, { recursive: true })
  apiContext = await request.newContext()
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update'],
  })
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    serviceWorkers: 'block',
  })
  context.setDefaultTimeout(30_000)
  // The GUI includes optional third-party widgets. No browser request may leave loopback.
  await context.route('**/*', async route => {
    if (isLoopback(route.request().url())) return route.continue()
    blockedRequests++
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', socket => {
    if (isLoopback(socket.url(), ['ws:', 'wss:'])) socket.connectToServer()
    else {
      blockedRequests++
      socket.close()
    }
  })
  page = await context.newPage()

  stage('create disposable fixture account and base')
  const signup = await api('POST', '/api/v1/auth/user/signup', {
    email, password, firstname: 'Smoke', lastname: 'Fixture', ignore_subscribe: true,
  })
  assert.ok(typeof signup.token === 'string' && signup.token.length > 20,
    'Fresh local signup must return a token; use an empty disposable backend')
  token = signup.token
  const base = await api('POST', '/api/v2/meta/bases', { title: `Count smoke ${suffix}` })
  const baseId = entityId(base, 'base')
  const identity = await api('GET', `/api/v1/auth/user/me?base_id=${baseId}`)
  const baseList = await api('GET', '/api/v2/meta/bases')
  const listedBase = baseList.list?.find(item => item.id === baseId)
  console.log(`Fixture role scope: ${JSON.stringify({
    org_roles: identity.roles ?? null,
    effective_base_roles: identity.base_roles ?? null,
    sidebar_project_role: listedBase?.project_role ?? null,
    sidebar_workspace_role: listedBase?.workspace_role ?? null,
  })}`)

  stage('create three rows and a saved view matching two rows')
  const table = await api('POST', `/api/v2/meta/bases/${baseId}/tables`, {
    title: 'Smoke tasks',
    table_name: `smoke_tasks_${suffix}`,
    columns: [
      { title: 'Id', column_name: 'Id', uidt: 'ID', dt: 'integer', pk: true, ai: true, rqd: true },
      { title: 'Title', column_name: 'Title', uidt: 'SingleLineText', dt: 'text', pv: true },
      { title: 'Status', column_name: 'Status', uidt: 'SingleLineText', dt: 'text' },
    ],
  })
  const tableId = entityId(table, 'table')
  const tableMeta = await api('GET', `/api/v2/meta/tables/${tableId}`)
  assert.ok(Array.isArray(tableMeta.columns), 'Table metadata must include columns')
  const statusId = entityId(tableMeta.columns.find(column => column.title === 'Status'), 'Status column')
  await api('POST', `/api/v2/tables/${tableId}/records`, [
    { Title: 'Review invoice', Status: 'pending' },
    { Title: 'Review receipt', Status: 'pending' },
    { Title: 'Completed item', Status: 'done' },
  ])
  const viewTitle = 'Needs review'
  const view = await api('POST', `/api/v2/meta/tables/${tableId}/grids`, { title: viewTitle })
  const viewId = entityId(view, 'view')
  await api('POST', `/api/v2/meta/views/${viewId}/filters`, {
    fk_column_id: statusId, comparison_op: 'eq', value: 'pending', logical_op: 'and',
  })
  assert.equal((await api('GET', `/api/v2/tables/${tableId}/records/count`)).count, 3,
    'Fixture table must contain three rows')
  assert.equal((await api('GET', `/api/v2/tables/${tableId}/records/count?viewId=${viewId}`)).count, 2,
    'Saved filter must match exactly two rows before GUI testing')

  stage('sign in through the GUI')
  await page.goto(new URL('/signin', frontend).href, { waitUntil: 'domcontentloaded' })
  await page.getByTestId('nc-form-signin__email').fill(email)
  await page.getByTestId('nc-form-signin__password').fill(password)
  await page.getByTestId('nc-form-signin__submit').click()
  await page.waitForURL(url => !url.pathname.includes('/signin'), { timeout: 30_000 })
  stage('complete optional first-login onboarding')
  const onboarding = page.getByTestId('nc-onboarding-flow-container')
  const skipOnboarding = page.getByTestId('nc-onboarding-flow-skip-button')
  const dashboardReady = page.getByTestId('nc-ws-home-topbar-title')
  await skipOnboarding.or(dashboardReady).first().waitFor({ state: 'visible' })
  if (await skipOnboarding.isVisible()) {
    // Skip saves is_new_user=false before hiding onboarding; wait for both effects.
    const [savedProfile] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === '/api/v1/user/profile'),
      skipOnboarding.click(),
    ])
    assert.ok(savedProfile.ok(), 'Onboarding completion must persist successfully')
    await onboarding.waitFor({ state: 'hidden' })
  }
  await dashboardReady.waitFor({ state: 'visible' })
  stage('open the saved filtered view')
  const viewUrl = new URL(`/nc/${baseId}/${tableId}/${viewId}`, frontend).href
  await page.goto(viewUrl, { waitUntil: 'domcontentloaded' })

  const sidebarView = page.getByTestId(`view-sidebar-view-${viewTitle}`)
  const sidebarTitle = sidebarView.getByTestId('sidebar-view-title')
  const count = sidebarView.getByTestId('sidebar-view-record-count')
  await sidebarView.waitFor({ state: 'visible' })
  assert.equal(await count.count(), 0, 'Count must initially be opt-in')

  async function changeSettings(showCount) {
    await sidebarView.hover()
    await sidebarView.locator('.nc-sidebar-view-node-context-btn').click()
    await page.getByTestId(`view-sidebar-view-actions-${viewTitle}`)
      .filter({ visible: true })
      .getByTestId('view-record-count-menu').click()
    const settings = page.getByTestId('view-record-count-settings')
    await settings.waitFor({ state: 'visible' })
    await settings.getByRole('checkbox', { name: 'Show record count beside the view name', exact: true })
      .setChecked(showCount)
    await settings.getByRole('checkbox', { name: 'Bold the view name when it has records', exact: true })
      .setChecked(true)
    await page.getByRole('dialog').filter({ has: settings }).getByRole('button', { name: 'Save', exact: true }).click()
    await settings.waitFor({ state: 'hidden' })
  }

  async function assertSidebar(showCount) {
    await sidebarTitle.waitFor({ state: 'visible' })
    await eventually(async () => showCount
      ? (await count.count()) === 1 && (await count.textContent()).replace(/\s/g, '') === '(2)'
      : (await count.count()) === 0,
    showCount ? 'sidebar shows saved-view count (2)' : 'sidebar count is hidden')
    await eventually(async () => Number(await sidebarTitle.evaluate(element => getComputedStyle(element).fontWeight)) >= 700,
      'nonempty saved-view title is visibly bold')
  }

  async function assertPersisted(showCount) {
    const response = await api('GET', `/api/v2/meta/tables/${tableId}/views`)
    assert.ok(Array.isArray(response.list), 'View list must include a list array')
    const saved = response.list.find(item => item.id === viewId)
    assert.ok(saved, 'Saved view must still exist')
    const meta = typeof saved.meta === 'string' ? JSON.parse(saved.meta) : saved.meta
    assert.equal(meta?.recordCount?.showCount, showCount, 'Count visibility must persist on the backend')
    assert.equal(meta?.recordCount?.boldWhenNonEmpty, true, 'Bold setting must persist on the backend')
  }

  stage('enable count and bold through the real sidebar menu')
  await changeSettings(true)
  await assertSidebar(true)
  await assertPersisted(true)
  stage('reload and verify persisted count and bold')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await assertSidebar(true)
  await screenshot('saved-view-count-enabled.png')

  stage('disable count through the menu while keeping bold enabled')
  await changeSettings(false)
  await assertSidebar(false)
  await assertPersisted(false)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await assertSidebar(false)
  await screenshot('saved-view-count-disabled.png')
  console.log(`PASS: saved count 2 of 3, bold, reload persistence, and independent count disabling; ${blockedRequests} external requests blocked.`)
} catch (error) {
  try { await screenshot('saved-view-count-failure.png') } catch { /* Preserve the original failure. */ }
  let message = error instanceof Error ? error.message : 'Unknown smoke-test failure'
  for (const secret of [password, token]) if (secret) message = message.split(secret).join('[REDACTED]')
  console.error(`FAIL during ${phase}: ${message}`)
  process.exitCode = 1
} finally {
  await context?.close()
  await browser?.close()
  await apiContext?.dispose()
}

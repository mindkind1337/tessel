// What the demo shows: an invented project and what its scripted agents do. Pure
// data, in both languages: the simulator (simulator.js) feeds it to Tessel through
// the same calls and events the real main process uses.

export const TEAM_ID = 'team-demo'
// The team tools' version: panes that have it are not restarted to get it.
export const TOOLS_VERSION = 'demo'
export const PROJECT = { id: 'ws-demo-shop', name: 'sample-shop', cwd: 'C:\\Projects\\sample-shop' }
export const SECOND_PROJECT = { id: 'ws-demo-docs', name: 'docs-site', cwd: 'C:\\Projects\\docs-site' }

export const PANES = {
  ada: 'pane-demo-ada',
  bohr: 'pane-demo-bohr',
  curie: 'pane-demo-curie',
  dirac: 'pane-demo-dirac',
  term: 'pane-demo-term',
  emmy: 'pane-demo-emmy',
  docsTerm: 'pane-demo-docs-term'
}

// A session id in the shape Tessel checks, invented.
const session = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const SHELLS = [
  { id: 'powershell', name: 'Windows PowerShell' },
  { id: 'pwsh', name: 'PowerShell 7' },
  { id: 'cmd', name: 'Command Prompt' },
  { id: 'gitbash', name: 'Git Bash' },
  { id: 'wsl', name: 'WSL' }
]

// The agents detected "on this computer". The whole list comes from Tessel's own
// presets (virtual:tessel-agents, see vite.config.mjs).
export const AVAILABLE_AGENTS = ['claude', 'codex', 'gemini', 'opencode']

export const MODELS = {
  claude: { model: 'claude-sonnet-4-5', effort: 'medium' },
  codex: { model: 'gpt-5-codex', effort: 'medium' },
  gemini: { model: 'gemini-2.5-pro' },
  opencode: { model: 'anthropic/claude-sonnet-4-5' }
}

// The saved layout, as src/main/index.js 'layout:load' would answer it.
export function savedLayout({ uiLanguage }) {
  const now = Date.now()
  const agent = (id, agentId, title, accent, name, num, sessionNumber) => ({
    type: 'leaf',
    id,
    kind: 'agent',
    shellId: 'powershell',
    title,
    agentId,
    agentCommand: agentId,
    accent,
    paneName: name,
    num,
    team: TEAM_ID,
    teamTools: true,
    toolsVersion: TOOLS_VERSION,
    sessionId: session(sessionNumber),
    launchedAt: now - 40 * 60 * 1000,
    startDir: PROJECT.cwd,
    broadcast: true,
    lastModel: MODELS[agentId]
  })
  const shell = (id, num, cwd) => ({ type: 'leaf', id, kind: 'shell', shellId: 'powershell', title: 'Windows PowerShell', num, startDir: cwd, broadcast: true })
  const tree = {
    type: 'split',
    dir: 'row',
    sizes: [50, 50],
    children: [
      {
        type: 'split',
        dir: 'col',
        sizes: [38, 31, 31],
        children: [
          agent(PANES.ada, 'claude', 'Claude Code', '#d97757', 'Ada', 1, 1),
          agent(PANES.bohr, 'codex', 'Codex CLI', '#10a37f', 'Bohr', 2, 2),
          agent(PANES.curie, 'gemini', 'Gemini CLI', '#4285f4', 'Curie', 3, 3)
        ]
      },
      {
        type: 'split',
        dir: 'col',
        sizes: [66, 34],
        children: [
          {
            type: 'leaf',
            kind: 'chat',
            id: PANES.dirac,
            agentId: 'claude',
            title: 'Claude',
            paneName: 'Dirac',
            num: 4,
            team: TEAM_ID,
            cwd: PROJECT.cwd,
            projectDir: PROJECT.cwd,
            sessionId: session(4),
            model: MODELS.claude.model,
            effort: MODELS.claude.effort
          },
          shell(PANES.term, 5, PROJECT.cwd)
        ]
      }
    ]
  }
  const docsTree = {
    type: 'split',
    dir: 'row',
    sizes: [50, 50],
    children: [
      { ...agent(PANES.emmy, 'claude', 'Claude Code', '#d97757', 'Emmy', 6, 6), team: null, startDir: SECOND_PROJECT.cwd },
      shell(PANES.docsTerm, 7, SECOND_PROJECT.cwd)
    ]
  }
  return {
    version: 2,
    selectedShell: 'powershell',
    broadcast: false,
    sidebarCollapsed: false,
    sidebarWidth: 216,
    taskPanelWidth: 330,
    taskPanelOpen: true,
    sidePanelTab: 'tasks',
    currentIndex: 0,
    placement: 'right',
    teams: [{ id: TEAM_ID, name: 'Checkout', color: '#6c9cff' }],
    settings: { uiLanguage, compactDefaults: true, restoreWorkspaces: true, desktopNotifications: false, alertSound: 'none' },
    workspaces: [
      { id: PROJECT.id, name: PROJECT.name, cwd: PROJECT.cwd, tree },
      { id: SECOND_PROJECT.id, name: SECOND_PROJECT.name, cwd: SECOND_PROJECT.cwd, tree: docsTree }
    ]
  }
}

// Everything the agents say, in the visitor's language. L(english, french).
export function createScript(lang) {
  const L = (en, fr) => (lang === 'fr' ? fr : en)
  const minutes = (n) => Date.now() - n * 60 * 1000

  const card = (id, en, fr, column, paneId, agoMinutes = 10) => {
    const at = minutes(agoMinutes)
    return {
      id,
      title: L(en, fr),
      column,
      paneId,
      wsId: PROJECT.id,
      createdAt: at - 5 * 60 * 1000,
      columnSince: at,
      ...(column === 'todo' ? {} : { startedAt: column === 'done' ? at - 12 * 60 * 1000 : at }),
      ...(column === 'done' ? { doneAt: at } : {}),
      ...(column === 'doing' && paneId ? { doingSince: at } : {})
    }
  }

  const tasks = [
    card('task-demo-rules', 'Tax rules per country', 'Règles de taxes par pays', 'todo', null, 2),
    card('task-demo-receipt', 'Show the tax on the receipt', 'Afficher la taxe sur le reçu', 'todo', PANES.curie, 3),
    card('task-demo-vat', 'Add VAT to the cart total', 'Ajouter la TVA au total du panier', 'doing', PANES.ada, 6),
    card('task-demo-review', 'Review the checkout form', 'Examiner le formulaire de paiement', 'doing', PANES.bohr, 5),
    card('task-demo-docs', 'Write the tax docs', 'Rédiger la doc sur les taxes', 'doing', PANES.curie, 4),
    card('task-demo-migrate', 'Migrate the orders table', 'Migrer la table des commandes', 'doing', PANES.dirac, 3),
    card('task-demo-coupons', 'Coupon codes at checkout', 'Codes promo au paiement', 'review', PANES.bohr, 20),
    card('task-demo-rounding', 'Fix rounding in totals', 'Corriger l’arrondi des totaux', 'done', PANES.ada, 35),
    card('task-demo-ci', 'Run the tests on every push', 'Lancer les tests à chaque envoi', 'done', PANES.curie, 55)
  ]

  // Tokens, time and estimated cost per card and pane (JobCostLine.vue).
  const usage = (input, output, cached, minutesWorked, usd, model, provider) => ({
    status: 'ok',
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: Math.round(cached / 12),
    durationMs: minutesWorked * 60000,
    usd,
    known: true,
    model,
    provider,
    estimated: true
  })
  const costs = {
    'task-demo-vat': usage(18400, 6200, 96000, 6, 0.21, 'claude-sonnet-4-5', 'claude'),
    'task-demo-review': usage(12700, 3100, 41000, 5, 0.09, 'gpt-5-codex', 'codex'),
    'task-demo-docs': usage(9100, 2800, 22000, 4, 0.04, 'gemini-2.5-pro', 'gemini'),
    'task-demo-migrate': usage(7300, 1900, 30000, 3, 0.07, 'claude-sonnet-4-5', 'claude'),
    'task-demo-coupons': usage(30100, 9400, 180000, 18, 0.38, 'gpt-5-codex', 'codex'),
    'task-demo-rounding': usage(11000, 2600, 52000, 9, 0.12, 'claude-sonnet-4-5', 'claude'),
    'task-demo-ci': usage(6400, 1500, 12000, 7, 0.03, 'gemini-2.5-pro', 'gemini')
  }

  // Terminal agents: what is on screen when the visitor arrives, then each step.
  //   { add: [...] } new conversation rows     { work: text | null } the working line
  //   { state: 'working' | 'idle' } the dot    { move: [card, column] } a board change
  //   { wait: ms } a pause (the steps run at their own pace)
  const agents = {
    [PANES.ada]: {
      kind: 'claude',
      footerNote: L('⏵⏵ accept edits on (shift+tab to cycle)', '⏵⏵ accept edits on (shift+tab to cycle)'),
      placeholder: '',
      state: 'working',
      start: [
        { user: L('Add VAT to the cart total and cover it with tests', 'Ajoute la TVA au total du panier et couvre-la de tests') },
        { say: L('I’ll read the cart code first.', 'Je lis d’abord le code du panier.') },
        { tool: 'Read', arg: 'src/cart/total.ts' },
        { out: [L('Read 42 lines', '42 lignes lues')] }
      ],
      work: L('Thinking…', 'Réflexion…'),
      steps: [
        { wait: 3200 },
        { work: L('Editing src/cart/total.ts…', 'Modification de src/cart/total.ts…') },
        { wait: 2800 },
        {
          add: [
            { tool: 'Update', arg: 'src/cart/total.ts' },
            { del: 'return subtotal(items)' },
            { add: 'const tax = taxFor(items, country)' },
            { add: 'return roundCents(subtotal(items) + tax)' },
            { blank: true }
          ]
        },
        { wait: 2600 },
        { work: L('Writing tests…', 'Écriture des tests…') },
        { wait: 3600 },
        { add: [{ tool: 'Write', arg: 'src/cart/total.test.ts' }, { out: [L('Wrote 38 lines', '38 lignes écrites')] }] },
        { wait: 2200 },
        { work: L('Running the tests…', 'Lancement des tests…') },
        { wait: 3400 },
        { add: [{ tool: 'Bash', arg: 'npm test -- cart' }, { out: ['PASS src/cart/total.test.ts', 'Tests: 12 passed, 12 total'] }] },
        { wait: 1800 },
        { work: null, state: 'idle', move: ['task-demo-vat', 'review'], add: [{ say: L('VAT is in the cart total, with 12 tests passing. Ready for review.', 'La TVA est dans le total du panier et les 12 tests passent. Prêt pour examen.') }] },
        { wait: 11000 },
        { state: 'working', move: ['task-demo-rules', 'doing'], claim: ['task-demo-rules'], add: [{ user: L('Now the tax rules per country', 'Maintenant, les règles de taxes par pays') }], work: L('Reading the tax table…', 'Lecture de la table des taxes…') },
        { wait: 4200 },
        { add: [{ tool: 'Read', arg: 'src/tax/rates.json' }, { out: [L('Read 27 lines', '27 lignes lues')] }] },
        { wait: 3000 },
        { work: L('Editing src/tax/rules.ts…', 'Modification de src/tax/rules.ts…') },
        { wait: 4200 },
        { add: [{ tool: 'Update', arg: 'src/tax/rules.ts' }, { add: 'export const rateFor = (country) => rates[country] ?? 0' }, { blank: true }] },
        { wait: 2400 },
        { work: null, state: 'idle', move: ['task-demo-rules', 'done'], add: [{ say: L('Rules added for the 27 countries in the table.', 'Règles ajoutées pour les 27 pays de la table.') }] }
      ]
    },
    [PANES.bohr]: {
      kind: 'codex',
      footerNote: 'gpt-5-codex medium · 78% context left',
      placeholder: '',
      state: 'working',
      start: [
        { user: L('Review the checkout form validation', 'Examine la validation du formulaire de paiement') },
        { tool: 'Explored', arg: 'src/checkout/form.ts, rules.ts' },
        { tool: 'Ran', arg: 'npm run lint' },
        { out: [L('0 problems', '0 problème')] }
      ],
      work: L('Working', 'Au travail'),
      steps: [
        { wait: 4800 },
        { add: [{ say: L('The postal code is checked only after the card field. It should run first.', 'Le code postal n’est vérifié qu’après le champ de la carte. Il devrait l’être en premier.') }] },
        { wait: 3800 },
        { add: [{ tool: 'Edited', arg: 'src/checkout/form.ts (+4 -2)' }] },
        { wait: 4200 },
        { add: [{ tool: 'Ran', arg: 'npm test -- checkout' }, { out: ['Tests: 31 passed, 31 total'] }] },
        { wait: 3000 },
        { work: null, state: 'idle', move: ['task-demo-review', 'review'], add: [{ say: L('Review done: one fix applied, 31 tests pass.', 'Examen terminé : une correction appliquée, 31 tests passent.') }] },
        { wait: 16000 },
        { state: 'working', move: ['task-demo-coupons', 'done'], add: [{ user: L('Finish the coupon branch', 'Termine la branche des codes promo') }], work: L('Working', 'Au travail') },
        { wait: 5400 },
        { add: [{ tool: 'Ran', arg: 'npm test' }, { out: ['Tests: 148 passed, 148 total'] }] },
        { wait: 2800 },
        { work: null, state: 'idle', add: [{ say: L('Coupons are finished. All 148 tests pass.', 'Les codes promo sont terminés. Les 148 tests passent.') }] }
      ]
    },
    [PANES.curie]: {
      kind: 'gemini',
      footerNote: '~\\sample-shop (main)   gemini-2.5-pro',
      placeholder: L('Type your message', 'Tapez votre message'),
      state: 'working',
      start: [
        { user: L('Write the docs for the new tax rule', 'Rédige la doc de la nouvelle règle de taxe') },
        { say: L('I’ll start from the current checkout docs.', 'Je pars de la doc actuelle du paiement.') },
        { tool: 'ReadFile', arg: 'docs/checkout.md' },
        { blank: true }
      ],
      work: L('Drafting the section', 'Rédaction de la section'),
      steps: [
        { wait: 6400 },
        { add: [{ tool: 'WriteFile', arg: 'docs/taxes.md' }, { blank: true }] },
        { wait: 3400 },
        { work: L('Checking the links', 'Vérification des liens') },
        { wait: 4200 },
        { work: null, state: 'idle', move: ['task-demo-docs', 'review'], add: [{ say: L('The tax page is written and linked from the checkout docs.', 'La page sur les taxes est écrite et liée à la doc du paiement.') }] },
        { wait: 9000 },
        { state: 'working', move: ['task-demo-receipt', 'doing'], claim: ['task-demo-receipt'], add: [{ user: L('Show the tax on the receipt', 'Affiche la taxe sur le reçu') }], work: L('Reading the receipt template', 'Lecture du modèle de reçu') },
        { wait: 5200 },
        { add: [{ tool: 'Edit', arg: 'src/receipt/template.html' }, { blank: true }] },
        { wait: 3600 },
        { work: null, state: 'idle', move: ['task-demo-receipt', 'review'], add: [{ say: L('The receipt now shows the tax on its own line.', 'Le reçu affiche maintenant la taxe sur sa propre ligne.') }] }
      ]
    },
    [PANES.emmy]: {
      kind: 'claude',
      footerNote: L('⏵⏵ accept edits on (shift+tab to cycle)', '⏵⏵ accept edits on (shift+tab to cycle)'),
      placeholder: '',
      state: 'idle',
      start: [
        { user: L('Fix the broken links on the home page', 'Corrige les liens brisés de la page d’accueil') },
        { tool: 'Bash', arg: 'npm run check-links' },
        { out: [L('3 broken links fixed', '3 liens brisés corrigés')] },
        { say: L('Done. All links work again.', 'Terminé. Tous les liens fonctionnent de nouveau.') }
      ],
      steps: []
    }
  }

  // The plain terminal: what it shows, then what the script runs in it.
  const shells = {
    [PANES.term]: {
      cwd: PROJECT.cwd,
      banner: [],
      steps: [{ wait: 2400 }, { type: 'git status -s' }, { wait: 9000 }, { type: 'git log --oneline' }]
    },
    [PANES.docsTerm]: { cwd: SECOND_PROJECT.cwd, banner: [], steps: [] }
  }

  // The native chat pane: its conversation so far, and the approval card it waits on.
  const chat = {
    paneId: PANES.dirac,
    card: 'task-demo-migrate',
    model: MODELS.claude.model,
    sessionId: session(4),
    command: 'npm run db:migrate',
    history: [
      { type: 'user', id: 'demo-u1', text: L('Migrate the orders table for the new tax column', 'Migre la table des commandes pour la nouvelle colonne de taxe'), status: 'accepted' },
      { type: 'assistant', messageId: 'demo-m1', text: L('I’ll check the current schema first.', 'Je vérifie d’abord le schéma actuel.') },
      { type: 'tool', id: 'demo-t1', name: 'Read', input: { file_path: `${PROJECT.cwd}\\db\\schema.sql` }, status: 'running' },
      { type: 'toolResult', id: 'demo-t1', isError: false, text: 'CREATE TABLE orders (id INTEGER PRIMARY KEY, total_cents INTEGER, ...)' },
      { type: 'assistant', messageId: 'demo-m2', text: L('The migration adds `tax_cents`, with 0 for past orders. It needs your approval to run:', 'La migration ajoute `tax_cents`, à 0 pour les commandes passées. Elle a besoin de votre approbation pour s’exécuter :') }
    ],
    approved: {
      result: L('Migrated orders: added tax_cents (1,204 rows)', 'Commandes migrées : tax_cents ajoutée (1 204 lignes)'),
      say: L('Migration done: `tax_cents` is in place and past orders kept their totals.', 'Migration terminée : `tax_cents` est en place et les commandes passées gardent leur total.')
    },
    denied: L('Understood: I won’t run it. Tell me when you want to go ahead.', 'Compris : je ne la lance pas. Dites-moi quand vous voulez continuer.'),
    reply: L(
      'This is a simulation, so nothing ran. In Tessel, this message goes to your own agent, on your own computer.',
      'Ceci est une simulation, rien n’a donc été exécuté. Dans Tessel, ce message va à votre propre agent, sur votre ordinateur.'
    )
  }

  // What a visitor typing gets back, in a shell or from an agent.
  const words = {
    agentReply: L(
      'This is a simulation, so nothing ran. In Tessel, this prompt goes to your own agent, on your own computer.',
      'Ceci est une simulation, rien n’a donc été exécuté. Dans Tessel, cette demande va à votre propre agent, sur votre ordinateur.'
    ),
    agentGreeting: L('Ready. This agent is simulated: type something to see the pane work.', 'Prêt. Cet agent est simulé : tapez quelque chose pour voir le panneau travailler.'),
    agentWorking: L('Working…', 'Au travail…'),
    shellNotFound: (cmd) =>
      L(`${cmd}: not run. This terminal is simulated: nothing runs on your computer or anywhere else. Try: help`, `${cmd} : non exécuté. Ce terminal est simulé : rien ne s’exécute sur votre ordinateur ni ailleurs. Essayez : help`),
    shellHelp: L('A simulated terminal. Try: dir, git status, git log, echo, cls, or the name of an agent (claude, codex, gemini).', 'Un terminal simulé. Essayez : dir, git status, git log, echo, cls, ou le nom d’un agent (claude, codex, gemini).')
  }

  // The Usage menu's invented quotas.
  const hours = (n) => new Date(Date.now() + n * 3600 * 1000).toISOString()
  const usageRows = {
    claude: { id: 'claude', name: 'Claude Code', accountId: null, plan: 'Max', source: 'usage', windows: [{ label: '5-hour', usedPct: 34, resetsAt: hours(2.6) }, { label: 'Weekly', usedPct: 58, resetsAt: hours(61) }] },
    codex: { id: 'codex', name: 'Codex', accountId: null, plan: 'Pro', source: 'usage', windows: [{ label: '5-hour', usedPct: 12, resetsAt: hours(4.1) }, { label: 'Weekly', usedPct: 27, resetsAt: hours(90) }] }
  }
  const stats = { ok: true, totalAgentsSpawned: 128, totalAgentTimeMs: 214 * 3600 * 1000, totalPRsCreated: 37, firstEventAt: minutes(60 * 24 * 40) }
  const needs = [
    { id: 'node', name: 'Node.js', status: 'ok', detail: '' },
    { id: 'git', name: 'Git', status: 'ok', detail: '' },
    { id: 'tools', name: L('Team tools', 'Outils d’équipe'), status: 'ok', detail: '' }
  ]
  const commits = GIT.log.map((line, i) => {
    const short = line.slice(0, 7)
    const subject = line.slice(8)
    const id = short + '0'.repeat(33)
    const next = GIT.log[i + 1]
    return { id, parentIds: next ? [next.slice(0, 7) + '0'.repeat(33)] : [], subject, message: subject, author: 'Sample Dev', displayId: short, timestamp: minutes(60 * (i + 2) * (i + 1)), references: [] }
  })

  return { tasks, costs, agents, shells, chat, words, usage: usageRows, stats, needs, commits }
}

// The invented project's files, for the Files tab, the editor and Source Control.
export const FILES = {
  'README.md': '# sample-shop\n\nAn invented shop, for this demo. Nothing here is real.\n\n- `src/cart`: the cart and its total\n- `src/checkout`: the checkout form\n- `src/tax`: tax rates per country\n',
  'package.json': '{\n  "name": "sample-shop",\n  "version": "1.4.0",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run",\n    "db:migrate": "node db/migrate.js"\n  }\n}\n',
  'db/schema.sql': 'CREATE TABLE orders (\n  id INTEGER PRIMARY KEY,\n  total_cents INTEGER NOT NULL,\n  tax_cents INTEGER NOT NULL DEFAULT 0\n);\n',
  'db/migrate.js': "// Adds the tax column to past orders.\nexport async function up(db) {\n  await db.exec('ALTER TABLE orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0')\n}\n",
  'docs/checkout.md': '# Checkout\n\nThe form checks the postal code first, then the card.\n',
  'docs/taxes.md': '# Taxes\n\nThe tax is worked out per country from `src/tax/rates.json`.\n',
  'src/cart/total.ts': "import { taxFor } from '../tax/rules'\nimport type { Item } from './types'\n\nexport const subtotal = (items: Item[]) =>\n  items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)\n\nconst roundCents = (value: number) => Math.round(value)\n\nexport function cartTotal(items: Item[], country: string) {\n  const tax = taxFor(items, country)\n  return roundCents(subtotal(items) + tax)\n}\n",
  'src/cart/total.test.ts': "import { describe, expect, it } from 'vitest'\nimport { cartTotal } from './total'\n\ndescribe('cartTotal', () => {\n  it('adds the tax of the country', () => {\n    expect(cartTotal([{ priceCents: 1000, quantity: 2 }], 'FR')).toBe(2400)\n  })\n})\n",
  'src/cart/types.ts': 'export interface Item {\n  priceCents: number\n  quantity: number\n}\n',
  'src/checkout/form.ts': "import { isPostalCode, isCardNumber } from './rules'\n\nexport function validate(form: { postal: string; card: string }) {\n  if (!isPostalCode(form.postal)) return 'postal'\n  if (!isCardNumber(form.card)) return 'card'\n  return null\n}\n",
  'src/checkout/rules.ts': 'export const isPostalCode = (value: string) => /^[A-Z0-9 -]{3,10}$/i.test(value)\nexport const isCardNumber = (value: string) => /^[0-9 ]{12,23}$/.test(value)\n',
  'src/receipt/template.html': '<section class="receipt">\n  <p>Subtotal: {{subtotal}}</p>\n  <p>Tax: {{tax}}</p>\n  <p>Total: {{total}}</p>\n</section>\n',
  'src/tax/rates.json': '{\n  "CA": 0.05,\n  "DE": 0.19,\n  "FR": 0.2\n}\n',
  'src/tax/rules.ts': "import rates from './rates.json'\n\nexport const rateFor = (country: string) => rates[country] ?? 0\n"
}

// What the changed files were before: the left side of a diff.
export const ORIGINALS = {
  'src/cart/total.ts': `import type { Item } from './types'

export const subtotal = (items: Item[]) =>
  items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0)

export function cartTotal(items: Item[]) {
  return subtotal(items)
}
`,
  'src/checkout/form.ts': `import { isPostalCode, isCardNumber } from './rules'

export function validate(form: { postal: string; card: string }) {
  if (!isCardNumber(form.card)) return 'card'
  if (!isPostalCode(form.postal)) return 'postal'
  return null
}
`
}

// git status of the invented project: path -> letter.
export const CHANGES = {
  'src/cart/total.ts': 'M',
  'src/cart/total.test.ts': 'U',
  'src/checkout/form.ts': 'M',
  'docs/taxes.md': 'U'
}

// Its branch and last commits.
export const GIT = {
  branch: 'main',
  log: ['4f1c2ab Coupon codes at checkout', '9d07e3c Fix rounding in totals', 'b21fa60 Run the tests on every push', '07aa3d1 Checkout form'],
  head: '4f1c2ab9d07e3cb21fa6007aa3d19c5e1f2ab340'
}

import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Persona } from '../types'
import { parseGenerated, pickOption, spoken } from '../hooks/persona'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const NOVA = {
  name: 'Nova',
  glyph: '🚀',
  color: 'magenta',
  voice: 'Karen',
  tagline: 'Fast, then correct.',
  prompt: 'You are Nova, an upbeat release engineer who ships small changes often and explains every step briefly.',
}

/** Stubs every call the mod makes at session start; returns the store the test can read. */
function boot(on: On, seed: Record<string, unknown> = {}) {
  const saved = new Map<string, unknown>(Object.entries(seed))
  const spokenTexts: string[] = []
  const commands: string[] = []
  const clock = mock.clock(on)
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'sidekick' } }))
  on('command.run', ($, e) => {
    commands.push(`${e.command} ${e.args}`.trim())
    return { text: '' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  on('audio.speak', ($, e) => {
    spokenTexts.push(e.text)
    return { value: { via: 'system' } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('fs.exists', () => ({ value: true }))
  const submitted: { text: string; asUser?: true }[] = []
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, asUser: (e.origin as { asUser?: true }).asUser })
    return { text: e.text }
  })
  const utterances: string[] = []
  on('process.spawn', async function* ($, e) {
    const said = utterances.shift() ?? ''
    yield { stream: 'stderr', text: 'listening\n' }
    if (said) {
      yield { stream: 'stderr', text: `partial:${said.split(' ')[0]}\n` }
      yield { stream: 'stdout', text: `${said}\n` }
    }
    return { value: { code: said ? 0 : 2, signal: null } }
  })
  return { saved, spokenTexts, commands, clock, submitted, utterances }
}

/** Runs /sidekick <args> as the person would. */
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'sidekick', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

/** Lets a promise the mod left running (a spoken greeting) finish. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 2000 && !done(); i++) await Promise.resolve()
}

test('/sidekick new creates a persona, activates it and greets aloud', async ($, on) => {
  const { saved, spokenTexts } = boot(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Here you go:\n' + JSON.stringify(NOVA), usage: USAGE } }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const answer = await run($, 'new an upbeat release engineer named Nova')

  expect(answer.text).toContain('🚀 Nova is ready')
  const roster = saved.get('personas') as Persona[]
  expect(roster.map(p => p.id)).toEqual(['ada', 'rudy', 'nova'])
  expect(saved.get('active')).toBe('nova')
  await settle(() => spokenTexts.length > 0)
  expect(spokenTexts[0]).toBe('Nova here. Fast, then correct.')
  await settle(() => false)
})

test('a finished turn is spoken in the persona voice, unless muted', async ($, on) => {
  const { spokenTexts } = boot(on, { active: 'rudy' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.turn.complete({ turnId: 't1', answer: 'Fixed the **build**. See `Makefile`.\n\n```sh\nmake\n```', durationMs: 10, isAborted: false, reason: 'answer' })
  await settle(() => spokenTexts.length > 0)
  expect(spokenTexts).toEqual(['Fixed the build. See Makefile.'])

  await run($, 'mute')
  await $.turn.complete({ turnId: 't2', answer: 'Silence.', durationMs: 10, isAborted: false, reason: 'answer' })
  await settle(() => false)
  expect(spokenTexts).toEqual(['Fixed the build. See Makefile.'])
})

test('/sidekick talk listens hands-free and sends what was said as the prompt', async ($, on) => {
  const { spokenTexts, submitted, utterances } = boot(on, { active: 'ada' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  utterances.push('refactor the auth middleware')
  const answer = await run($, 'talk')
  expect(answer.text).toContain('Talk mode on')
  await settle(() => submitted.length > 0)
  expect(spokenTexts[0]).toBe("Ada here. I'm listening.")
  expect(submitted).toEqual([{ text: 'refactor the auth middleware', asUser: true }])

  // the reply is spoken (head only), then the sidekick listens again and hears "end talk"
  utterances.push('okay end talk please')
  await $.turn.complete({ turnId: 't1', answer: 'Done, the tests pass.\n\n---\n\n```ts\nconst x = 1\n```', durationMs: 10, isAborted: false, reason: 'answer' })
  await settle(() => spokenTexts.length >= 3)
  expect(spokenTexts.slice(1)).toEqual(['Done, the tests pass.', 'Talk mode off.'])
  await settle(() => false)
  expect(submitted.length).toBe(1)

  const band = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'AbovePrompt',
    viewport: { columns: 100, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  })
  // talk mode is off again, so the band draws nothing of its own
  expect(await band.find({ type: 'Text', text: /is ready/ })).toBeUndefined()
  await band.unmount()
})

test('in talk mode a question is asked and answered by voice', async ($, on) => {
  const { spokenTexts, utterances, submitted } = boot(on, { active: 'rudy' })
  on('tool.call', () => ({ result: 'the dialog was shown' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  utterances.push('deploy the thing')
  await run($, 'talk')
  await settle(() => submitted.length > 0)
  await settle(() => false)

  utterances.push('the second one')
  const out = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Deploy where?', header: 'Target', options: [{ label: 'Staging', description: '' }, { label: 'Production', description: '' }], multiSelect: false }],
  })
  expect(out).toMatchObject({ result: { answers: { 'Deploy where?': 'Production' } } })
  expect(spokenTexts.at(-1)).toBe('Deploy where? 1: Staging. 2: Production.')

  // nothing understood twice: the dialog takes over
  const fallback = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'Alpha', description: '' }, { label: 'Beta', description: '' }], multiSelect: false }],
  })
  expect(fallback).toEqual({ result: 'the dialog was shown' })
})

test('the active persona adds its section to the system prompt', async ($, on) => {
  boot(on, { active: 'rudy' })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const { sections } = await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(sections.map(s => s.id)).toEqual(['intro', 'sidekick:persona'])
  expect(sections[1]?.text).toContain('You are Rudy')
  expect(sections[1]?.text).toContain('AskUserQuestion')
})

test('persona helpers: parse and spoken', () => {
  expect(parseGenerated('nonsense')).toBeUndefined()
  expect(parseGenerated(JSON.stringify({ ...NOVA, color: 'plaid', voice: 'HAL' }))).toMatchObject({ id: 'nova', color: 'cyan', voice: 'Samantha' })
  expect(spoken('# Title\n\n- one `two` [three](http://x)\n\nmore', false)).toBe('Title')
  expect(spoken('Hi there.\n\n---\n\nnot spoken', true)).toBe('Hi there.')
  const labels = ['Run it', 'Refuse', 'Ask me later']
  expect(pickOption('the second one', labels, false)).toBe('Refuse')
  expect(pickOption('yeah run it', labels, false)).toBe('Run it')
  expect(pickOption('later please', labels, false)).toBe('Ask me later')
  expect(pickOption('one and three', labels, true)).toBe('Run it, Ask me later')
  expect(pickOption('hmm', labels, false)).toBeUndefined()
  expect(pickOption('call it release candidate two', [], false)).toBe('call it release candidate two')
})

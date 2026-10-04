import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Persona } from '../types'
import { parseGenerated, spoken } from '../hooks/persona'

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
  return { saved, spokenTexts, commands, clock }
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

test('/sidekick talk turns native dictation on and speaks only the head of a reply', async ($, on) => {
  const { commands, spokenTexts, saved, clock } = boot(on, { active: 'ada' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const answer = await run($, 'talk')
  expect(answer.text).toContain('Talk mode on')
  await clock.settle()
  expect(commands).toEqual(['voice tap'])
  expect(saved.get('isTalk')).toBe(true)

  const BAND = {
    plugin: 'sidekick',
    component: 'AbovePrompt',
    requestId: 'AbovePrompt',
    viewport: { columns: 100, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  } as const
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /your turn/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ turnId: 't1', answer: 'Done, the tests pass.\n\n---\n\n```ts\nconst x = 1\n```', durationMs: 10, isAborted: false, reason: 'answer' })
  await settle(() => spokenTexts.length > 0)
  expect(spokenTexts).toEqual(['Done, the tests pass.'])
  await settle(() => false)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'end' })
  await clock.settle()
  expect(commands).toEqual(['voice tap', 'voice off'])
  expect(saved.get('isTalk')).toBe(false)
  await ui.unmount()
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
})

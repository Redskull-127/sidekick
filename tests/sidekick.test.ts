import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Persona } from '../types'
import { parseGenerated, pickOption, spoken, stripEcho } from '../hooks/persona'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const NOVA = {
  name: 'Nova',
  glyph: '🚀',
  color: 'magenta',
  voice: 'Karen',
  tagline: 'Fast, then correct.',
  prompt: 'You are Nova, an upbeat release engineer who ships small changes often and explains every step briefly.',
}

const BAND = {
  plugin: 'sidekick',
  component: 'AbovePrompt',
  requestId: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

/**
 * Stubs everything the mod reaches: the store, the model, speech, and a fake microphone.
 * Speech stays "in progress" until the test ends it or the mod hushes it. The microphone
 * waits for the test to `hear` something; `pkill` from the mod ends a pending listen.
 */
function boot(on: On, seed: Record<string, unknown> = {}) {
  const saved = new Map<string, unknown>(Object.entries(seed))
  const spokenTexts: string[] = []
  const runs: string[] = []
  const submitted: { text: string; asUser?: true }[] = []
  const aborted: string[] = []
  const clock = mock.clock(on)
  let spawns = 0

  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'sidekick' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.abort', ($, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('env.get', () => ({ value: '/Users/test' }))
  on('fs.exists', () => ({ value: true }))
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, asUser: (e.origin as { asUser?: true }).asUser })
    return { text: e.text }
  })

  // speech: pending until hushed or finished by the test
  let endSpeech: (() => void) | null = null
  on('audio.speak', ($, e) => {
    spokenTexts.push(e.text)
    return new Promise<{ value: { via: 'system' } }>(resolve => {
      endSpeech = () => {
        endSpeech = null
        resolve({ value: { via: 'system' } })
      }
    })
  })
  const finishSpeech = () => endSpeech?.()

  // the microphone: a queue the test feeds; pkill ends a pending listen
  const CANCEL = Symbol('cancel')
  const queue: (string | typeof CANCEL)[] = []
  const waiters: ((v: string | typeof CANCEL) => void)[] = []
  const feed = (v: string | typeof CANCEL) => {
    const w = waiters.shift()
    if (w) w(v)
    else queue.push(v)
  }
  const take = () => new Promise<string | typeof CANCEL>(resolve => {
    const v = queue.shift()
    if (v !== undefined) resolve(v)
    else waiters.push(resolve)
  })
  on('process.run', ($, e) => {
    const cmd = e.argv.join(' ')
    runs.push(cmd)
    if (cmd === 'killall say') finishSpeech()
    if (e.argv[0] === 'pkill') feed(CANCEL)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    spawns += 1
    yield { stream: 'stderr', text: 'listening\n' }
    const said = await take()
    if (said === CANCEL) return { value: { code: null, signal: 'SIGTERM' } }
    if (!said) return { value: { code: 2, signal: null } }
    const words = said.split(' ')
    yield { stream: 'stderr', text: `partial:${words.slice(0, 2).join(' ')}\n` }
    yield { stream: 'stdout', text: `${said}\n` }
    return { value: { code: 0, signal: null } }
  })

  return { saved, spokenTexts, runs, submitted, aborted, clock, hear: (s: string) => feed(s), finishSpeech, spawnCount: () => spawns }
}

/** Runs /sidekick <args> as the person would. */
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'sidekick', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

/** Lets work the mod left running catch up. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 4000 && !done(); i++) await Promise.resolve()
}

test('/sidekick new creates a persona, activates it and greets aloud', async ($, on) => {
  const { saved, spokenTexts, finishSpeech } = boot(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Here you go:\n' + JSON.stringify(NOVA), usage: USAGE } }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const answer = await run($, 'new an upbeat release engineer named Nova')

  expect(answer.text).toContain('🚀 Nova is ready')
  const roster = saved.get('personas') as Persona[]
  expect(roster.map(p => p.id)).toEqual(['ada', 'rudy', 'nova'])
  expect(saved.get('active')).toBe('nova')
  await settle(() => spokenTexts.length > 0)
  expect(spokenTexts[0]).toBe('Nova here. Fast, then correct.')
  finishSpeech()
  await settle(() => false)
})

test('a finished turn is spoken short, in the persona voice, unless muted', async ($, on) => {
  const { spokenTexts, finishSpeech } = boot(on, { active: 'rudy' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const essay = 'Fixed the **build**. Then I rewrote three files. Then I ran the tests.\n\nMore paragraphs here.\n\n```sh\nmake\n```'
  await $.turn.complete({ turnId: 't1', answer: essay, durationMs: 10, isAborted: false, reason: 'answer' })
  await settle(() => spokenTexts.length > 0)
  expect(spokenTexts).toEqual(['Fixed the build.'])
  finishSpeech()
  await settle(() => false)

  await run($, 'mute')
  await $.turn.complete({ turnId: 't2', answer: 'Silence.', durationMs: 10, isAborted: false, reason: 'answer' })
  await settle(() => false)
  expect(spokenTexts).toEqual(['Fixed the build.'])
})

test('talk mode: you speak, it sends; you talk over it, it stops; its echo is ignored; "end talk" ends', async ($, on) => {
  const { spokenTexts, submitted, runs, hear, finishSpeech, saved, spawnCount } = boot(on, { active: 'ada' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const answer = await run($, 'talk')
  expect(answer.text).toContain('Talk mode on')
  await settle(() => spawnCount() === 1 && spokenTexts.length === 1)
  expect(spokenTexts[0]).toBe("Ada here. I'm listening.")

  // barge-in: two words that are not Ada's own cut her greeting short, and the sentence is sent
  hear('refactor the auth middleware')
  await settle(() => submitted.length === 1)
  expect(runs).toContain('killall say')
  expect(submitted[0]).toEqual({ text: 'refactor the auth middleware', asUser: true })

  // the reply is spoken; what the microphone hears of it is not a prompt
  await settle(() => spawnCount() === 2)
  await $.turn.complete({ turnId: 't1', answer: 'Done, the tests pass.\n\nAll three suites are green.\n\n---\n\n```ts\nconst x = 1\n```', durationMs: 10, isAborted: false, reason: 'answer' })
  await settle(() => spokenTexts.length === 2)
  expect(spokenTexts[1]).toBe('Done, the tests pass. All three suites are green.')
  hear('done the tests pass all three suites are green')
  await settle(() => spawnCount() === 3)
  expect(submitted.length).toBe(1)
  finishSpeech()

  // a real follow-up after the speech
  hear('what about the docs')
  await settle(() => submitted.length === 2)
  expect(submitted[1]?.text).toBe('what about the docs')

  // "end talk" by voice
  await settle(() => spawnCount() === 4)
  hear('okay end talk please')
  await settle(() => spokenTexts.length === 3)
  expect(spokenTexts[2]).toBe('Talk mode off.')
  finishSpeech()
  await settle(() => false)
  expect(submitted.length).toBe(2)
  expect(saved.get('isTalk')).toBeUndefined()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /is ready/ })).toBeUndefined()
  await band.unmount()
})

test('"stop" while it works aborts the turn instead of queuing a prompt', async ($, on) => {
  const { submitted, aborted, hear, finishSpeech, spawnCount } = boot(on, { active: 'rudy' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await run($, 'talk')
  await settle(() => spawnCount() === 1)
  finishSpeech()

  await $.turn.start({ text: 'do the thing', turnId: 'turn-9' })
  hear('stop stop')
  await settle(() => aborted.length === 1)
  expect(aborted).toEqual(['turn-9'])
  expect(submitted).toEqual([])

  // talking while it works queues the next prompt
  await settle(() => spawnCount() === 2)
  hear('also check the logs')
  await settle(() => submitted.length === 1)
  expect(submitted[0]?.text).toBe('also check the logs')
  await run($, 'talk')
  await settle(() => false)
})

test('pressing talk again and again toggles; it never stacks greetings or listeners', async ($, on) => {
  const { spokenTexts, spawnCount, saved, finishSpeech } = boot(on, { active: 'rudy' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const pane = await $.ui.mount({
    plugin: 'sidekick',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidekick',
    viewport: { columns: 100, rows: 30 },
    props: { title: 'Sidekick', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  await pane.press({ key: 'talk' })
  await pane.press({ key: 'talk' })
  await pane.press({ key: 'talk' })
  await settle(() => spawnCount() === 2)
  expect(saved.get('isTalk')).toBeUndefined()
  // on, off, on: two greetings, the first cut by the second press; one listener alive
  expect(spokenTexts.filter(t => t.includes("I'm listening")).length).toBe(2)
  expect(spawnCount()).toBe(2)
  await pane.press({ key: 'talk' })
  finishSpeech()
  await settle(() => false)
  await pane.unmount()
})

test('in talk mode a question is asked and answered by voice', async ($, on) => {
  const { spokenTexts, submitted, hear, finishSpeech, spawnCount } = boot(on, { active: 'rudy' })
  on('tool.call', () => ({ result: 'the dialog was shown' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await run($, 'talk')
  await settle(() => spawnCount() === 1)
  finishSpeech()
  hear('deploy the thing')
  await settle(() => submitted.length === 1 && spawnCount() === 2)

  const asking = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Deploy where?', header: 'Target', options: [{ label: 'Staging', description: '' }, { label: 'Production', description: '' }], multiSelect: false }],
  })
  await settle(() => spawnCount() === 3 && spokenTexts.at(-1) === 'Deploy where? 1: Staging. 2: Production.')
  hear('the second one')
  const out = await asking
  expect(out).toMatchObject({ result: { answers: { 'Deploy where?': 'Production' } } })

  // nothing understood twice: the dialog takes over
  const fallback = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'Alpha', description: '' }, { label: 'Beta', description: '' }], multiSelect: false }],
  })
  await settle(() => spawnCount() === 4)
  hear('')
  await settle(() => spawnCount() === 5)
  hear('')
  expect(await fallback).toEqual({ result: 'the dialog was shown' })
  expect(submitted.length).toBe(1)
  await run($, 'talk')
  await settle(() => false)
})

test('the active persona adds its section to the system prompt', async ($, on) => {
  boot(on, { active: 'rudy' })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const { sections } = await $.prompt.compose({ model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(sections.map(s => s.id)).toEqual(['intro', 'sidekick:persona'])
  expect(sections[1]?.text).toContain('You are Rudy')
  expect(sections[1]?.text).toContain('AskUserQuestion')
  expect(sections[1]?.text).toContain('No essays')
})

test('persona helpers: parse, spoken, echo, options', () => {
  expect(parseGenerated('nonsense')).toBeUndefined()
  expect(parseGenerated(JSON.stringify({ ...NOVA, color: 'plaid', voice: 'HAL' }))).toMatchObject({ id: 'nova', color: 'cyan', voice: 'Samantha' })

  expect(spoken('# Title\n\n- one `two` [three](http://x)\n\nmore', false)).toBe('Title')
  expect(spoken('First thing. Second thing. Third thing.', false)).toBe('First thing.')
  expect(spoken('Hi there. All good. And more.\n\n---\n\nnot spoken', true)).toBe('Hi there. All good.')

  const speech = 'The build passed, the tests are green, and nothing is pending right now.'
  expect(stripEcho('The past the tests are green and nothing is pending right now', speech)).toBe('')
  expect(stripEcho('the tests are green hey can you check the logs', speech)).toBe('hey can you check the logs')
  expect(stripEcho('check the logs please', speech)).toBe('check the logs please')
  expect(stripEcho('anything', '')).toBe('anything')

  const labels = ['Run it', 'Refuse', 'Ask me later']
  expect(pickOption('the second one', labels, false)).toBe('Refuse')
  expect(pickOption('yeah run it', labels, false)).toBe('Run it')
  expect(pickOption('later please', labels, false)).toBe('Ask me later')
  expect(pickOption('one and three', labels, true)).toBe('Run it, Ask me later')
  expect(pickOption('hmm', labels, false)).toBeUndefined()
  expect(pickOption('call it release candidate two', [], false)).toBe('call it release candidate two')
})

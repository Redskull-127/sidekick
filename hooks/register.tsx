import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Persona, SidekickQuestion } from '../types'
import { LISTENER_PLIST, LISTENER_SWIFT, LISTENER_VERSION } from './listener-src'
import { GEN_SYSTEM, PRESETS, askAloud, contract, parseGenerated, pickOption, spoken } from './persona'

const PANE = 'sidekick'
const roster = atom({ plugin: 'sidekick', key: 'roster' } as const, [] as Persona[])
const active = atom({ plugin: 'sidekick', key: 'active' } as const, null as Persona | null)
const isMuted = atom({ plugin: 'sidekick', key: 'isMuted' } as const, false)
const isTalk = atom({ plugin: 'sidekick', key: 'isTalk' } as const, false)
const isSpeaking = atom({ plugin: 'sidekick', key: 'isSpeaking' } as const, false)
const isListening = atom({ plugin: 'sidekick', key: 'isListening' } as const, false)
const heard = atom({ plugin: 'sidekick', key: 'heard' } as const, '')
const question = atom({ plugin: 'sidekick', key: 'question' } as const, null as SidekickQuestion | null)

const USAGE = [
  '/sidekick                 roster pane',
  '/sidekick new <describe someone>',
  '/sidekick use <name> | off',
  '/sidekick talk            hands-free: speak, it answers, it listens again',
  '/sidekick mute | speak',
  '/sidekick list | rm <name>',
].join('\n')

const END_TALK = /\b(end talk|stop talking|stop listening|that'?s all|goodbye)\b/i

/** Store → state, at session start and after /clear, /resume, /branch. */
async function load($: EngineInterface, speakByDefault: boolean) {
  const saved = (await $.store.get('personas')) as Persona[] | undefined
  const list = saved && saved.length > 0 ? saved : PRESETS
  if (!saved) await $.store.set('personas', list)
  const activeId = (await $.store.get('active')) as string | null | undefined
  const muted = (await $.store.get('isMuted')) as boolean | undefined
  await update($, roster, () => list)
  await update($, active, () => list.find(p => p.id === activeId) ?? null)
  await update($, isMuted, () => muted ?? !speakByDefault)
  // talk mode is per session: a new session starts quiet
  await update($, isTalk, () => false)
}

async function setActive($: EngineInterface, p: Persona | null) {
  await update($, active, () => p)
  await $.store.set('active', p?.id ?? null)
}

async function toggleMute($: EngineInterface) {
  const muted = !(await read($, isMuted))
  await update($, isMuted, () => muted)
  await $.store.set('isMuted', muted)
  return muted
}

/** Speaks in the persona's voice; falls back to the default voice, then to silence. */
async function say($: EngineInterface, text: string, voice: string) {
  if (!text) return
  await update($, isSpeaking, () => true)
  try {
    await $.audio.speak(text, { voice })
  } catch {
    try {
      await $.audio.speak(text)
    } catch {
      // no synthesizer on this platform: text only
    }
  }
  await update($, isSpeaking, () => false)
}

// ponytail: `say` has no abort; killing the macOS synthesizer is the one-line skip
const hush = ($: EngineInterface) => $.process.run(['killall', 'say']).catch(() => {})

// ── the listener: macOS speech recognition in a small native binary, built once ─────────────────

/** Where the compiled listener lives, building it on first use; null when it cannot be built here. */
async function listenerPath($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  if (!home) return null
  const dir = `${home}/.claude/plugins/data/sidekick`
  const bin = `${dir}/listen-${LISTENER_VERSION}`
  if (await $.fs.exists(bin)) return bin
  $.ui.toast('Building the sidekick listener, one time, about 20 seconds…')
  try {
    await $.fs.write(`${dir}/listen.swift`, LISTENER_SWIFT)
    await $.fs.write(`${dir}/Info.plist`, LISTENER_PLIST)
    const built = await $.process.run(
      ['swiftc', '-O', `${dir}/listen.swift`, '-o', bin, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', `${dir}/Info.plist`],
      { timeoutMs: 240_000 },
    )
    if (built.exitCode !== 0) {
      const why = built.stderr.split('\n').find(l => l.includes('error:')) ?? built.stderr.slice(0, 200)
      $.ui.toast(`Listener build failed: ${why}`)
      return null
    }
    return bin
  } catch {
    $.ui.toast('Hands-free needs macOS with the Xcode Command Line Tools (xcode-select --install).')
    return null
  }
}

type Heard = { text: string | null; isCancelled: boolean; isFatal: boolean }

let listening: { bin: string; isCancelled: boolean } | null = null

/** Stops the listener now, from a key press or because a turn started. */
async function stopListening($: EngineInterface) {
  const current = listening
  if (!current) return
  current.isCancelled = true
  // ponytail: a pending stream read cannot be interrupted from here, so the child is ended by name
  await $.process.run(['pkill', '-f', current.bin]).catch(() => {})
}

/** Records one utterance and returns its text; shows the partial transcript in the band meanwhile. */
async function listen($: EngineInterface, bin: string): Promise<Heard> {
  if (listening) await stopListening($)
  const run = { bin, isCancelled: false }
  listening = run
  await update($, heard, () => '')
  await update($, isListening, () => true)
  let out = ''
  let code: number | null = null
  try {
    const child = $.process.spawn({ argv: [bin, '--silence', '1.4', '--max', '45'] })
    for await (const { stream, text } of child) {
      if (stream === 'stdout') {
        out += text
        continue
      }
      for (const line of text.split('\n')) {
        if (line.startsWith('partial:')) await update($, heard, () => line.slice(8))
        else if (line.startsWith('error:')) $.ui.toast(`Listener: ${line.slice(6)}`)
      }
    }
    code = (await child.result).code
  } catch {
    code = 5
  }
  if (listening === run) listening = null
  await update($, isListening, () => false)
  const said = out.trim()
  return { text: run.isCancelled || !said ? null : said, isCancelled: run.isCancelled, isFatal: code !== null && code >= 3 }
}

async function setTalk($: EngineInterface, enabled: boolean) {
  await update($, isTalk, () => enabled)
  if (!enabled) {
    await stopListening($)
    await update($, question, () => null)
  }
}

/** One hands-free round: listen until the human pauses, then send what they said as their prompt. */
async function converse($: EngineInterface) {
  const p = await read($, active)
  if (!p || !(await read($, isTalk))) return
  const bin = await listenerPath($)
  if (!bin) return setTalk($, false)
  for (let quiet = 0; quiet < 3 && (await read($, isTalk)); ) {
    const r = await listen($, bin)
    if (r.isCancelled) return
    if (r.isFatal) return setTalk($, false)
    if (r.text === null) {
      quiet += 1
      continue
    }
    if (END_TALK.test(r.text)) {
      await setTalk($, false)
      if (!(await read($, isMuted))) void say($, 'Talk mode off.', p.voice)
      return
    }
    void $.prompt.submit({ text: r.text, asUser: true })
    return
  }
  // ponytail: three silent rounds end talk mode rather than listening forever
  await setTalk($, false)
  $.ui.toast(`${p.name} stopped listening after a long silence. /sidekick talk to resume.`)
}

async function startTalk($: EngineInterface) {
  const p = await read($, active)
  if (!p) return
  if (!(await listenerPath($))) return setTalk($, false)
  if (!(await read($, isMuted))) await say($, `${p.name} here. I'm listening.`, p.voice)
  await converse($)
}

const findPersona = (list: Persona[], q: string) =>
  list.find(p => p.id === q.toLowerCase() || p.name.toLowerCase() === q.toLowerCase())

export const register: Register = (on, options) => {
  const speakByDefault = options.speak !== false

  on('session.start', async ($, e, next) => {
    await load($, speakByDefault)
    if (await read($, active)) void $.ui.open({ id: PANE, title: 'Sidekick' })
    try {
      await $.command.register({
        name: 'sidekick',
        description: 'Persona agents you can talk to: create, switch, talk hands-free, mute',
        argumentHint: '[new <description> | use <name> | off | talk | mute | speak | list | rm <name>]',
        immediate: true,
      })
    } catch {
      // name taken by another plugin: the pane and hooks still work
    }
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await load($, speakByDefault)
    return next(e)
  })

  on('command.run', { command: 'sidekick' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const list = await read($, roster)

    switch (sub) {
      case '': {
        await $.ui.open({ id: PANE, title: 'Sidekick', focus: true, closeOnEscape: true })
        return {}
      }
      case 'new': {
        if (!arg) return { text: 'Describe who you want: /sidekick new Rudy, a blunt senior Rust dev' }
        const r = await $.model.complete({ model: 'haiku', system: GEN_SYSTEM, prompt: arg, maxTokens: 700, timeoutMs: 20000 })
        if (!r.isAnswered) return { text: `Couldn't reach the model (${r.reason}). Try again.` }
        const p = parseGenerated(r.text)
        if (!p) return { text: 'The model did not return a persona I could read. Try a clearer description.' }
        if (list.some(x => x.id === p.id)) p.id = `${p.id}-${list.length + 1}`
        const grown = [...list, p]
        await update($, roster, () => grown)
        await $.store.set('personas', grown)
        await setActive($, p)
        void $.ui.open({ id: PANE, title: 'Sidekick' })
        if (!(await read($, isMuted))) void say($, `${p.name} here. ${p.tagline}`, p.voice)
        return { text: `${p.glyph} ${p.name} is ready. "${p.tagline}"\n${p.name} is driving now. /sidekick talk to speak with ${p.name}.` }
      }
      case 'use': {
        const p = findPersona(list, arg)
        if (!p) return { text: `No sidekick named "${arg}". /sidekick list` }
        await setActive($, p)
        void $.ui.open({ id: PANE, title: 'Sidekick' })
        if (!(await read($, isMuted))) void say($, `${p.name} here. ${p.tagline}`, p.voice)
        return { text: `${p.glyph} ${p.name} is driving now.` }
      }
      case 'off': {
        await setTalk($, false)
        await setActive($, null)
        return { text: 'Sidekick off. Plain Claude is back.' }
      }
      case 'talk': {
        const p = await read($, active)
        if (!p) return { text: 'Pick a sidekick first: /sidekick use Rudy' }
        const turnOn = !(await read($, isTalk))
        await setTalk($, turnOn)
        if (!turnOn) return { text: '🎙 Talk mode off.' }
        void startTalk($)
        return { text: `🎙 Talk mode on. Just speak; ${p.name} answers out loud and listens again. Say "end talk" or press x on the band to stop.` }
      }
      case 'mute':
      case 'speak': {
        const muted = await toggleMute($)
        return { text: muted ? '🔇 Replies are no longer spoken.' : '🔊 Replies are spoken again.' }
      }
      case 'list': {
        const cur = await read($, active)
        return { text: list.map(p => `${p.id === cur?.id ? '●' : ' '} ${p.glyph} ${p.name} — ${p.tagline}`).join('\n') }
      }
      case 'rm': {
        const p = findPersona(list, arg)
        if (!p) return { text: `No sidekick named "${arg}".` }
        const grown = list.filter(x => x.id !== p.id)
        await update($, roster, () => grown)
        await $.store.set('personas', grown)
        if ((await read($, active))?.id === p.id) await setActive($, null)
        return { text: `Removed ${p.glyph} ${p.name}.` }
      }
      default:
        return { text: USAGE }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const p = await read($, active)
    if (!p) return composed
    const talk = await read($, isTalk)
    return { sections: [...composed.sections, { id: 'sidekick:persona', scope: 'session', text: contract(p, talk) }] }
  })

  // a turn starting (typed, or ours) ends any listening in progress
  on('turn.start', async ($, e, next) => {
    await stopListening($)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p || !e.props.isFirstOfReply) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        <Text bold color={p.color}>
          {p.glyph} {p.name}
        </Text>
        {theirs}
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p) return next(e)
    return next({ ...e, props: { ...e.props, suffix: ` · ${p.name} is on it…` } })
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        <Text bold color={p.color}>
          {p.glyph} {p.name} asks:
        </Text>
        {theirs}
      </Box>
    )
  })

  // in talk mode a question is asked and answered by voice; the dialog is the fallback
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p || !(await read($, isTalk))) return next(e)
    const bin = await listenerPath($)
    if (!bin) return next(e)
    const answers: Record<string, string> = {}
    for (const q of e.questions) {
      const labels = q.options?.map(o => o.label) ?? []
      await update($, question, () => ({ text: q.question, options: labels }))
      let picked: string | undefined
      for (let attempt = 0; attempt < 2 && !picked; attempt++) {
        if (!(await read($, isMuted))) await say($, askAloud(q.question, labels, attempt > 0), p.voice)
        const r = await listen($, bin)
        if (r.isCancelled || r.isFatal) break
        if (r.text) picked = labels.length > 0 ? pickOption(r.text, labels, q.multiSelect) : r.text
      }
      await update($, question, () => null)
      if (!picked) {
        $.ui.toast(`${p.name} didn't catch that. Pick with a key.`)
        return next(e)
      }
      answers[q.question] = picked
    }
    return { result: { questions: e.questions, answers } }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p || e.props.hasSurvey || !(await read($, isTalk))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const speaking = await read($, isSpeaking)
    const hearing = await read($, isListening)
    const partial = await read($, heard)
    const muted = await read($, isMuted)
    const asked = await read($, question)
    const status = speaking
      ? `🔊 ${p.name} is speaking…`
      : hearing
        ? `🎙 listening…`
        : e.props.isWorking
          ? `${p.glyph} ${p.name} is working…`
          : `${p.glyph} ${p.name} is ready`
    return (
      <Box flexDirection="column">
        {asked && (
          <Text color={p.color}>
            ❓ {asked.text} {asked.options.map((o, i) => `  ${i + 1}) ${o}`).join('')}
          </Text>
        )}
        <Box flexDirection="row" columnGap={2}>
          <Text color={p.color}>{status}</Text>
          {hearing && partial && <Text dimColor>{partial}</Text>}
          {speaking && <Button key="skip" label="skip" hotkey="s" plain onPress={() => hush($)} />}
          {!speaking && !hearing && !e.props.isWorking && (
            <Button key="listen" label="listen" hotkey="l" plain onPress={() => void converse($)} />
          )}
          <Button key="mute" label={muted ? 'speak' : 'mute'} hotkey="m" plain onPress={() => toggleMute($)} />
          <Button key="end" label="end talk" hotkey="x" plain onPress={() => setTalk($, false)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p || e.props.isDraft || e.props.isWorking || !(await read($, isTalk))) return next(e)
    return next({ ...e, props: { ...e.props, tail: ` · 🎙 talking with ${p.name}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, roster)
    const cur = await read($, active)
    const muted = await read($, isMuted)
    const talk = await read($, isTalk)
    return (
      <Box flexDirection="column">
        {list.slice(0, 9).map((p, i) => (
          <Box flexDirection="row" columnGap={1}>
            <Button
              key={`use-${p.id}`}
              label={`${p.glyph} ${p.name}`}
              hotkey={String(i + 1)}
              plain
              dimColor={cur?.id !== p.id}
              onPress={() => setActive($, p)}
            />
            <Text dimColor>{cur?.id === p.id ? `● ${p.tagline}` : p.tagline}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Box flexDirection="row" columnGap={3}>
          <Button key="off" label="off" hotkey="0" plain onPress={() => setActive($, null)} />
          <Button key="mute" label={muted ? 'speak' : 'mute'} hotkey="m" plain onPress={() => toggleMute($)} />
          <Button
            key="talk"
            label={talk ? 'end talk' : 'talk'}
            hotkey="t"
            plain
            onPress={async () => {
              await setTalk($, !talk)
              if (!talk) void startTalk($)
            }}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>/sidekick new {'<describe someone>'} to add one</Text>
      </Box>
    )
  })

  // the reply is spoken, then in talk mode the sidekick listens for what comes next
  on('turn.complete', async ($, e, next) => {
    const p = await read($, active)
    if (p && e.reason === 'answer' && !e.agentId) {
      void (async () => {
        if (!(await read($, isMuted))) await say($, spoken(e.answer, await read($, isTalk)), p.voice)
        if (await read($, isTalk)) await converse($)
      })()
    }
    return next(e)
  })
}

import type { EngineInterface, Register } from 'claude-code'

import type { Persona, SidekickQuestion } from '../types'
import { CHIME_OFF, CHIME_ON } from './chime'
import { LISTENER_PLIST, LISTENER_SWIFT } from './listener-source'
import { GEN_SYSTEM, PRESETS, VOICES, askAloud, bestVoice, contract, foreignWords, hasNaturalVoice, parseGenerated, parseSayVoices, pickOption, spoken, stripEcho } from './persona'

const PANE = 'sidekick'
// session state the drawings read; each a literal reference for `$.state`
const roster = { plugin: 'sidekick', key: 'roster' } as const
const active = { plugin: 'sidekick', key: 'active' } as const
const isMuted = { plugin: 'sidekick', key: 'isMuted' } as const
const isTalk = { plugin: 'sidekick', key: 'isTalk' } as const
const isSpeaking = { plugin: 'sidekick', key: 'isSpeaking' } as const
const isListening = { plugin: 'sidekick', key: 'isListening' } as const
const heard = { plugin: 'sidekick', key: 'heard' } as const
const question = { plugin: 'sidekick', key: 'question' } as const

const USAGE = [
  '/sidekick                 roster pane',
  '/sidekick new <describe someone>',
  '/sidekick use <name> | off',
  '/sidekick talk            hands-free: speak, it answers, it listens again',
  '/sidekick mute | speak',
  '/sidekick voices [install]  natural Apple voices',
  '/sidekick list | rm <name>',
].join('\n')

const VOICE_SETTINGS = 'x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent'
const VOICE_STEPS = [
  'System Settings → Accessibility → Spoken Content → System Voice → ⓘ Manage Voices → English.',
  'Download Ava (Premium) and Tom (Enhanced), or any voice marked Premium or Enhanced. Sidekicks pick them up at once.',
].join('\n')

const END_TALK = /\b(end talk|stop talking|stop listening|that'?s all|goodbye)\b/i
const STOP = /^(stop|wait|hold on|hang on|never ?mind|shut up|quiet)\b/i

let installedVoices: string[] = []

/** Which voices `say` has right now; a natural one that was downloaded since is found on the next session. */
async function loadVoices($: EngineInterface) {
  try {
    const r = await $.process.run(['say', '-v', '?'])
    installedVoices = parseSayVoices(r.stdout)
  } catch {
    installedVoices = []
  }
}

/** Store → state, at session start and after /clear, /resume, /branch. */
async function load($: EngineInterface, speakByDefault: boolean) {
  const saved = (await $.store.get('personas')) as Persona[] | undefined
  // our presets keep our voice choices; personas the person made keep theirs
  const list = (saved && saved.length > 0 ? saved : PRESETS).map(p => ({ ...p, voice: PRESETS.find(x => x.id === p.id)?.voice ?? p.voice }))
  if (!saved) await $.store.set('personas', list)
  const activeId = (await $.store.get('active')) as string | null | undefined
  const muted = (await $.store.get('isMuted')) as boolean | undefined
  await $.state.set(roster, list)
  await $.state.set(active, list.find(p => p.id === activeId) ?? null)
  await $.state.set(isMuted, muted ?? !speakByDefault)
  // talk mode is per session: a new session starts quiet
  await $.state.set(isTalk, false)
}

async function setActive($: EngineInterface, p: Persona | null) {
  await $.state.set(active, p)
  await $.store.set('active', p?.id ?? null)
}

async function toggleMute($: EngineInterface) {
  const muted = !(((await $.state.get(isMuted)).value ?? false))
  await $.state.set(isMuted, muted)
  await $.store.set('isMuted', muted)
  return muted
}

let speechNow = ''
let recentSpeech: string[] = []
let sayId = 0
let isHushed = false

// ponytail: the last three utterances are the echo vocabulary; the recognizer delivers its transcript
// well after the speaker goes quiet, so "what is playing right now" was never the right question
const echoText = () => recentSpeech.join(' ')

/** Speaks in the persona's voice, cutting any speech still going; falls back to the default voice, then to silence. */
async function say($: EngineInterface, text: string, voice: string) {
  if (!text) return
  if (((await $.state.get(isSpeaking)).value ?? false)) await hush($)
  const mine = ++sayId
  isHushed = false
  speechNow = text
  recentSpeech = [...recentSpeech.slice(-2), text]
  await $.state.set(isSpeaking, true)
  try {
    await $.audio.speak(text, { voice: bestVoice(voice, installedVoices) })
  } catch {
    if (!isHushed) {
      try {
        await $.audio.speak(text)
      } catch {
        // no synthesizer on this platform: text only
      }
    }
  }
  if (sayId !== mine) return
  speechNow = ''
  await $.state.set(isSpeaking, false)
  if (!isHushed && (((await $.state.get(isTalk)).value ?? false))) void chime($)
}

/** Awaits a call whose failure does not matter (a chime that cannot play, a program not running). */
async function quietly(work: Promise<unknown>) {
  try {
    await work
  } catch {
    // nothing to do
  }
}

/** The cabin chime: "a sidekick is on" and "your turn"; the lower one when talk mode ends. */
async function chime($: EngineInterface, kind: 'on' | 'off' = 'on') {
  await quietly($.audio.play({ base64: kind === 'off' ? CHIME_OFF : CHIME_ON, mime: 'audio/wav' }))
}

// ponytail: `say` has no abort; killing the macOS synthesizer is the one-line skip
async function hush($: EngineInterface) {
  isHushed = true
  await quietly($.process.run(['killall', 'say']))
}

// ── the listener: macOS speech recognition in a small native binary, built once ─────────────────

/** A short stable hash of the listener's source, so a changed source gets a fresh build. */
function sourceVersion(source: string): string {
  let h = 5381
  for (let i = 0; i < source.length; i++) h = ((h * 33) ^ source.charCodeAt(i)) >>> 0
  return h.toString(16)
}

// where the listener is built and run: fixed paths, outside any project
const LISTENER_DIR = '/var/tmp/sidekick'
const LISTENER_SOURCE = '/var/tmp/sidekick/listen.swift'
const LISTENER_PLIST_PATH = '/var/tmp/sidekick/Info.plist'
const LISTENER_BIN = '/var/tmp/sidekick/listen'
const LISTENER_VERSION_FILE = '/var/tmp/sidekick/listen.version'

/** Where the compiled listener lives, building it on first use from the source in listener-source.ts; null when it cannot be built here. */
async function listenerPath($: EngineInterface): Promise<string | null> {
  const version = sourceVersion(LISTENER_SWIFT)
  let built = ''
  try {
    built = await $.fs.read(LISTENER_VERSION_FILE)
  } catch {
    built = ''
  }
  if (built.trim() === version && (await $.fs.exists(LISTENER_BIN))) return LISTENER_BIN
  $.ui.toast('Building the sidekick listener, one time, about 20 seconds…')
  try {
    await $.process.run(['mkdir', '-p', LISTENER_DIR])
    await $.fs.write(LISTENER_SOURCE, LISTENER_SWIFT)
    await $.fs.write(LISTENER_PLIST_PATH, LISTENER_PLIST)
    const compiled = await $.process.run(
      ['swiftc', '-O', '/var/tmp/sidekick/listen.swift', '-o', '/var/tmp/sidekick/listen', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', '/var/tmp/sidekick/Info.plist'],
      { timeoutMs: 240_000 },
    )
    if (compiled.exitCode !== 0) {
      const why = compiled.stderr.split('\n').find(l => l.includes('error:')) ?? compiled.stderr.slice(0, 200)
      $.ui.toast(`Listener build failed: ${why}`)
      return null
    }
    await $.fs.write(LISTENER_VERSION_FILE, version)
    return LISTENER_BIN
  } catch {
    $.ui.toast('Hands-free needs macOS with the Xcode Command Line Tools (xcode-select --install).')
    return null
  }
}

type Heard = { text: string | null; isCancelled: boolean; isFatal: boolean; isEcho: boolean }

let listening: { bin: string; isCancelled: boolean } | null = null
let earLoop: Promise<void> | null = null
let earPaused = false
let runningTurn: string | null = null

/** Stops the listener now, from a key press or because talk mode ended. */
async function stopListening($: EngineInterface) {
  const current = listening
  if (!current) return
  current.isCancelled = true
  // ponytail: a pending stream read cannot be interrupted from here, so the child is ended by name
  await quietly($.process.run(['pkill', '-f', '/var/tmp/sidekick/listen']))
}

/**
 * Records one utterance and returns its text. The sidekick's own voice coming back through the
 * microphone is filtered out by its words; the first words that are not its own cut the speech short.
 */
async function listen($: EngineInterface, bin: string): Promise<Heard> {
  if (listening) await stopListening($)
  const run = { bin, isCancelled: false }
  listening = run
  await $.state.set(heard, '')
  await $.state.set(isListening, true)
  let out = ''
  let code: number | null = null
  let bargedIn = false
  try {
    const child = $.process.spawn({ argv: ['/var/tmp/sidekick/listen', '--silence', '1.4', '--max', '60'] })
    for await (const { stream, text } of child) {
      if (stream === 'stdout') {
        out += text
        continue
      }
      for (const line of text.split('\n')) {
        if (line.startsWith('partial:')) {
          const own = stripEcho(line.slice(8), echoText())
          await $.state.set(heard, own)
          // two words that are not in its own speech mean the human is talking over it
          if (speechNow && !bargedIn && foreignWords(line.slice(8), echoText()) >= 2) {
            bargedIn = true
            void hush($)
          }
        } else if (line.startsWith('error:')) $.ui.toast(`Listener: ${line.slice(6)}`)
      }
    }
    code = (await child.result).code
  } catch {
    code = 5
  }
  if (listening === run) listening = null
  await $.state.set(isListening, false)
  const raw = out.trim()
  const said = stripEcho(raw, echoText())
  return {
    text: run.isCancelled || !said ? null : said,
    isCancelled: run.isCancelled,
    isFatal: code !== null && code >= 3,
    isEcho: raw.length > 0 && !said,
  }
}

async function setTalk($: EngineInterface, enabled: boolean) {
  const was = ((await $.state.get(isTalk)).value ?? false)
  await $.state.set(isTalk, enabled)
  if (!enabled) {
    await stopListening($)
    await $.state.set(question, null)
    if (was) void chime($, 'off')
  }
}

/** The ear: one listener at a time for as long as talk mode is on. What it hears becomes the next prompt. */
async function runEar($: EngineInterface) {
  const p = ((await $.state.get(active)).value ?? null)
  if (!p) return
  const bin = await listenerPath($)
  if (!bin) return setTalk($, false)
  let quiet = 0
  while (((await $.state.get(isTalk)).value ?? false)) {
    if (earPaused) {
      await $.clock.sleep(200)
      continue
    }
    const r = await listen($, bin)
    if (r.isCancelled) {
      if (!(((await $.state.get(isTalk)).value ?? false))) return
      continue
    }
    if (r.isFatal) return setTalk($, false)
    if (r.text === null) {
      const busy = r.isEcho || runningTurn !== null || (((await $.state.get(isSpeaking)).value ?? false))
      if (!busy && ++quiet >= 3) {
        // ponytail: three silent rounds end talk mode rather than listening forever
        await setTalk($, false)
        $.ui.toast(`${p.name} stopped listening after a long silence. /sidekick talk to resume.`)
        return
      }
      continue
    }
    quiet = 0
    const said = r.text
    if (((await $.state.get(isSpeaking)).value ?? false)) await hush($)
    if (END_TALK.test(said)) {
      await setTalk($, false)
      return
    }
    if (STOP.test(said)) {
      if (runningTurn) await quietly($.turn.abort({ turnId: runningTurn }))
      continue
    }
    void $.prompt.submit({ text: said, asUser: true })
  }
}

/** Turns talk mode on: greets, and starts the ear once. */
async function startTalk($: EngineInterface) {
  const p = ((await $.state.get(active)).value ?? null)
  if (!p) return
  void chime($)
  if (earLoop) return
  earLoop = quietly(runEar($)).finally(() => {
    earLoop = null
  })
}

async function toggleTalk($: EngineInterface) {
  if (((await $.state.get(isTalk)).value ?? false)) {
    await hush($)
    return setTalk($, false)
  }
  await setTalk($, true)
  void startTalk($)
}

const findPersona = (list: Persona[], q: string) =>
  list.find(p => p.id === q.toLowerCase() || p.name.toLowerCase() === q.toLowerCase())

export const register: Register = (on, options) => {
  const speakByDefault = options.speak !== false

  on('session.start', async ($, e, next) => {
    await loadVoices($)
    await load($, speakByDefault)
    if (((await $.state.get(active)).value ?? null)) void $.ui.open({ id: PANE, title: 'Sidekick' })
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
    const list: Persona[] = (await $.state.get(roster)).value ?? []

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
        await $.state.set(roster, grown)
        await $.store.set('personas', grown)
        await setActive($, p)
        void $.ui.open({ id: PANE, title: 'Sidekick' })
        void chime($)
        return { text: `${p.glyph} ${p.name} is ready. "${p.tagline}"\n${p.name} is driving now. /sidekick talk to speak with ${p.name}.` }
      }
      case 'use': {
        const p = findPersona(list, arg)
        if (!p) return { text: `No sidekick named "${arg}". /sidekick list` }
        await setActive($, p)
        void $.ui.open({ id: PANE, title: 'Sidekick' })
        void chime($)
        return { text: `${p.glyph} ${p.name} is driving now.` }
      }
      case 'off': {
        await setTalk($, false)
        await setActive($, null)
        return { text: 'Sidekick off. Plain Claude is back.' }
      }
      case 'talk': {
        const p = ((await $.state.get(active)).value ?? null)
        if (!p) return { text: 'Pick a sidekick first: /sidekick use Rudy' }
        const wasOn = ((await $.state.get(isTalk)).value ?? false)
        await toggleTalk($)
        if (wasOn) return { text: '🎙 Talk mode off.' }
        if (!hasNaturalVoice(installedVoices)) $.ui.toast('Voice sounds robotic? /sidekick voices install gets Apple\'s natural ones.')
        return { text: `🎙 Talk mode on. Just speak; ${p.name} answers out loud and listens again. Talk over ${p.name} to interrupt. Say "end talk" or press x on the band to stop.` }
      }
      case 'voices': {
        if (arg === 'install') {
          await quietly($.process.run(['open', VOICE_SETTINGS]))
          return { text: `Opened System Settings.\n${VOICE_STEPS}` }
        }
        await loadVoices($)
        const natural = installedVoices.filter(v => /\((Premium|Enhanced)\)$/.test(v))
        const cur = ((await $.state.get(active)).value ?? null)
        const lines = [
          natural.length > 0 ? `Natural voices installed: ${natural.join(', ')}` : 'No natural (Premium/Enhanced) voices installed yet, so sidekicks use the compact ones.',
          cur ? `${cur.glyph} ${cur.name} speaks as ${bestVoice(cur.voice, installedVoices)}.` : '',
          `Sidekicks choose from: ${VOICES.join(', ')}.`,
          natural.length > 0 ? '' : `/sidekick voices install opens the download pane.\n${VOICE_STEPS}`,
        ]
        return { text: lines.filter(Boolean).join('\n') }
      }
      case 'mute':
      case 'speak': {
        const muted = await toggleMute($)
        return { text: muted ? '🔇 Replies are no longer spoken.' : '🔊 Replies are spoken again.' }
      }
      case 'list': {
        const cur = ((await $.state.get(active)).value ?? null)
        return { text: list.map(p => `${p.id === cur?.id ? '●' : ' '} ${p.glyph} ${p.name} — ${p.tagline}`).join('\n') }
      }
      case 'rm': {
        const p = findPersona(list, arg)
        if (!p) return { text: `No sidekick named "${arg}".` }
        const grown = list.filter(x => x.id !== p.id)
        await $.state.set(roster, grown)
        await $.store.set('personas', grown)
        if ((((await $.state.get(active)).value ?? null))?.id === p.id) await setActive($, null)
        return { text: `Removed ${p.glyph} ${p.name}.` }
      }
      default:
        return { text: USAGE }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const p = ((await $.state.get(active)).value ?? null)
    if (!p) return composed
    const talk = ((await $.state.get(isTalk)).value ?? false)
    return { sections: [...composed.sections, { id: 'sidekick:persona', scope: 'session', text: contract(p, talk) }] }
  })

  // the ear keeps listening through a turn: what you say meanwhile is the next prompt, "stop" aborts the turn
  on('turn.start', async ($, e, next) => {
    runningTurn = e.turnId
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const p = ((await $.state.get(active)).value ?? null)
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
    const p = ((await $.state.get(active)).value ?? null)
    if (!p) return next(e)
    return next({ ...e, props: { ...e.props, suffix: ` · ${p.name} is on it…` } })
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const p = ((await $.state.get(active)).value ?? null)
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
    const p = ((await $.state.get(active)).value ?? null)
    if (!p || !(((await $.state.get(isTalk)).value ?? false))) return next(e)
    const bin = await listenerPath($)
    if (!bin) return next(e)
    earPaused = true
    await stopListening($)
    try {
      const answers: Record<string, string> = {}
      for (const q of e.questions) {
        const labels = q.options?.map(o => o.label) ?? []
        await $.state.set(question, ({ text: q.question, options: labels }))
        let picked: string | undefined
        for (let attempt = 0; attempt < 2 && !picked; attempt++) {
          // listen while asking, so an answer spoken over the question still lands
          const hearing = listen($, bin)
          if (!(((await $.state.get(isMuted)).value ?? false))) void say($, askAloud(q.question, labels, attempt > 0), p.voice)
          const r = await hearing
          await hush($)
          if (r.isCancelled || r.isFatal) break
          if (r.text) picked = labels.length > 0 ? pickOption(r.text, labels, q.multiSelect) : r.text
        }
        await $.state.set(question, null)
        if (!picked) {
          $.ui.toast(`${p.name} didn't catch that. Pick with a key.`)
          return next(e)
        }
        answers[q.question] = picked
      }
      return { result: { questions: e.questions, answers } }
    } finally {
      earPaused = false
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = ((await $.state.get(active)).value ?? null)
    if (!p || e.props.hasSurvey || !(((await $.state.get(isTalk)).value ?? false))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const speaking = ((await $.state.get(isSpeaking)).value ?? false)
    const hearing = ((await $.state.get(isListening)).value ?? false)
    const partial = ((await $.state.get(heard)).value ?? '')
    const muted = ((await $.state.get(isMuted)).value ?? false)
    const asked = ((await $.state.get(question)).value ?? null)
    const status = speaking
      ? `🔊 ${p.name} is speaking… talk over to interrupt`
      : e.props.isWorking
        ? `${p.glyph} ${p.name} is working… say "stop" to cancel`
        : hearing
          ? `🎙 listening…`
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
            <Button key="listen" label="listen" hotkey="l" plain onPress={() => void startTalk($)} />
          )}
          <Button key="mute" label={muted ? 'speak' : 'mute'} hotkey="m" plain onPress={() => toggleMute($)} />
          <Button key="end" label="end talk" hotkey="x" plain onPress={() => toggleTalk($)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const p = ((await $.state.get(active)).value ?? null)
    if (!p || e.props.isDraft || e.props.isWorking || !(((await $.state.get(isTalk)).value ?? false))) return next(e)
    return next({ ...e, props: { ...e.props, tail: ` · 🎙 talking with ${p.name}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list: Persona[] = (await $.state.get(roster)).value ?? []
    const cur = ((await $.state.get(active)).value ?? null)
    const muted = ((await $.state.get(isMuted)).value ?? false)
    const talk = ((await $.state.get(isTalk)).value ?? false)
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
          <Button key="talk" label={talk ? 'end talk' : 'talk'} hotkey="t" plain onPress={() => toggleTalk($)} />
        </Box>
        <Text> </Text>
        <Text dimColor>/sidekick new {'<describe someone>'} to add one</Text>
      </Box>
    )
  })

  // the reply is spoken, then in talk mode the sidekick listens for what comes next
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) runningTurn = null
    const p = ((await $.state.get(active)).value ?? null)
    if (p && e.reason === 'answer' && !e.agentId && !(((await $.state.get(isMuted)).value ?? false))) {
      void say($, spoken(e.answer, ((await $.state.get(isTalk)).value ?? false)), p.voice)
    }
    return next(e)
  })
}

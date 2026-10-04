import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Persona } from '../types'
import { GEN_SYSTEM, PRESETS, contract, parseGenerated, spoken } from './persona'

const PANE = 'sidekick'
const roster = atom({ plugin: 'sidekick', key: 'roster' } as const, [] as Persona[])
const active = atom({ plugin: 'sidekick', key: 'active' } as const, null as Persona | null)
const isMuted = atom({ plugin: 'sidekick', key: 'isMuted' } as const, false)
const isTalk = atom({ plugin: 'sidekick', key: 'isTalk' } as const, false)
const isSpeaking = atom({ plugin: 'sidekick', key: 'isSpeaking' } as const, false)

const USAGE = [
  '/sidekick                 roster pane',
  '/sidekick new <describe someone>',
  '/sidekick use <name> | off',
  '/sidekick talk            speak to your sidekick, hear it answer',
  '/sidekick mute | speak',
  '/sidekick list | rm <name>',
].join('\n')

/** Store → state, at session start and after /clear, /resume, /branch. */
async function load($: EngineInterface, speakByDefault: boolean) {
  const saved = (await $.store.get('personas')) as Persona[] | undefined
  const list = saved && saved.length > 0 ? saved : PRESETS
  if (!saved) await $.store.set('personas', list)
  const activeId = (await $.store.get('active')) as string | null | undefined
  const muted = (await $.store.get('isMuted')) as boolean | undefined
  const talk = (await $.store.get('isTalk')) as boolean | undefined
  await update($, roster, () => list)
  await update($, active, () => list.find(p => p.id === activeId) ?? null)
  await update($, isMuted, () => muted ?? !speakByDefault)
  await update($, isTalk, () => talk ?? false)
}

async function setActive($: EngineInterface, p: Persona | null) {
  await update($, active, () => p)
  await $.store.set('active', p?.id ?? null)
}

async function setTalk($: EngineInterface, enabled: boolean) {
  await update($, isTalk, () => enabled)
  await $.store.set('isTalk', enabled)
  // ponytail: a command hook may not run another command (it would wait on its own turn), so the /voice toggle runs on a zero-delay timer, outside the dispatch
  $.clock.after(0, () => {
    $.command.run({ command: 'voice', args: enabled ? 'tap' : 'off' }).catch(() => {
      $.ui.toast(enabled ? 'Talk mode: /voice is unavailable here (it needs a claude.ai sign-in). Type instead.' : 'Talk mode off.')
    })
  })
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
        description: 'Persona agents you can talk to: create, switch, talk, mute',
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
        return { text: `${p.glyph} ${p.name} is ready. "${p.tagline}"\n${p.name} is driving now. /sidekick talk to speak out loud.` }
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
        await setActive($, null)
        return { text: 'Sidekick off. Plain Claude is back.' }
      }
      case 'talk': {
        const turnOn = !(await read($, isTalk))
        await setTalk($, turnOn)
        const p = await read($, active)
        if (!turnOn) return { text: '🎙 Talk mode off.' }
        const who = p ? p.name : 'your sidekick'
        return { text: `🎙 Talk mode on. Tap Space, speak, tap Space again to send. ${who} answers out loud, then it's your turn.` }
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

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const p = await read($, active)
    if (p && (await read($, isTalk)) && !(await read($, isMuted))) {
      const q = e.questions[0]
      if (q) void say($, `${q.question} Options: ${q.options.map(o => o.label).join(', ')}.`, p.voice)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p || e.props.hasSurvey || !(await read($, isTalk))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const speaking = await read($, isSpeaking)
    const muted = await read($, isMuted)
    const status = speaking
      ? `🔊 ${p.name} is speaking…`
      : e.props.isWorking
        ? `${p.glyph} ${p.name} is working…`
        : `🎙 your turn · tap space to talk to ${p.name}`
    return (
      <Box flexDirection="row" columnGap={2}>
        <Text color={p.color}>{status}</Text>
        {speaking && <Button key="skip" label="skip" hotkey="s" plain onPress={() => $.process.run(['killall', 'say']).catch(() => {})} />}
        <Button key="mute" label={muted ? 'speak' : 'mute'} hotkey="m" plain onPress={() => toggleMute($)} />
        <Button key="end" label="end talk" hotkey="x" plain onPress={() => setTalk($, false)} />
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const p = await read($, active)
    if (!p || e.props.isDraft || e.props.isWorking || !(await read($, isTalk))) return next(e)
    return next({ ...e, props: { ...e.props, tail: ` · tap space to answer ${p.name}` } })
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
          <Button key="talk" label={talk ? 'end talk' : 'talk'} hotkey="t" plain onPress={() => setTalk($, !talk)} />
        </Box>
        <Text> </Text>
        <Text dimColor>/sidekick new {'<describe someone>'} to add one</Text>
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    const p = await read($, active)
    if (p && e.reason === 'answer' && !e.agentId && !(await read($, isMuted))) {
      const talk = await read($, isTalk)
      void say($, spoken(e.answer, talk), p.voice)
    }
    return next(e)
  })
}

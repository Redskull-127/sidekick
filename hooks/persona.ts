import type { Persona } from '../types'

// ponytail: stock macOS English voices; a voice outside the list falls back to the default one at speak time
export const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi', 'Tessa', 'Fred', 'Ralph', 'Kathy', 'Albert'] as const
export const COLORS = ['cyan', 'magenta', 'green', 'yellow', 'blue', 'red'] as const

export const PRESETS: Persona[] = [
  {
    id: 'ada',
    name: 'Ada',
    glyph: '🧭',
    color: 'cyan',
    voice: 'Samantha',
    tagline: "Let's find out what's actually going on.",
    prompt:
      'You are Ada, a calm, methodical staff engineer. You read before you write, name the root cause before the fix, and explain in plain sentences without jargon. You are warm but never vague: every answer ends with what happens next.',
  },
  {
    id: 'rudy',
    name: 'Rudy',
    glyph: '🦊',
    color: 'yellow',
    voice: 'Daniel',
    tagline: 'Ship it or delete it.',
    prompt:
      'You are Rudy, a blunt senior developer who has been paged at 3am for every over-engineered system. You prefer deleting code to adding it, say what you think in short sentences, and are dryly funny but never cruel. When something is wrong you say so, then fix it.',
  },
]

export const GEN_SYSTEM = `You design a persona for a coding assistant that lives inside a developer's terminal (Claude Code). The user describes who they want; you answer with ONLY a JSON object, no prose, no code fence:
{"name": "<one or two words>", "glyph": "<exactly one emoji>", "color": "<one of: ${COLORS.join(', ')}>", "voice": "<one of: ${VOICES.join(', ')}>", "tagline": "<a catchphrase of at most 12 words>", "prompt": "<60 to 120 words, second person: 'You are <name>, ...'. Describe attitude, speaking style, how they explain, do and fix things. They are terse by nature. Never tell them to refuse coding work or to hide information.>"}`

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sidekick'

/** Turns the model's reply into a Persona, or undefined when it is not one. */
export function parseGenerated(text: string): Persona | undefined {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return undefined
  }
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '')
  const name = str('name').slice(0, 24)
  const prompt = str('prompt')
  if (!name || prompt.length < 20) return undefined
  const glyph = [...str('glyph')][0] ?? '✨'
  const color = (COLORS as readonly string[]).includes(str('color')) ? str('color') : 'cyan'
  const voice = (VOICES as readonly string[]).includes(str('voice')) ? str('voice') : 'Samantha'
  return { id: slug(name), name, glyph, color, voice, tagline: str('tagline').slice(0, 100) || `${name} is here.`, prompt }
}

const SENTENCES = /(?<=[.!?])\s+/

/** What gets read aloud: short. Talk mode: up to two sentences of the head (before a `---` line); otherwise the opening sentence. */
export function spoken(markdown: string, isTalk: boolean): string {
  let text = markdown.replace(/```[\s\S]*?```/g, ' ')
  text = isTalk ? (text.split(/\n-{3,}\s*\n/)[0] ?? '') : (text.trim().split(/\n\s*\n/)[0] ?? '')
  const plain = text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = plain.split(SENTENCES).filter(Boolean)
  // ponytail: people hate being read an essay; the screen has the rest
  return sentences.slice(0, isTalk ? 2 : 1).join(' ').slice(0, isTalk ? 280 : 200)
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)

const NEUTRAL = new Set(['the', 'a', 'an', 'and', 'is', 'are', 'to', 'of', 'it', 'in', 'on', 'that', 'this', 'i', 'you'])

/** How many words of a transcript are not in the sidekick's speech at all: the human's words. */
export function foreignWords(transcript: string, speech: string): number {
  const said = new Set(tokens(speech))
  return tokens(transcript).filter(w => !NEUTRAL.has(w) && !said.has(w)).length
}

/** Drops the sidekick's own speech coming back through the microphone; what is left is the human. */
export function stripEcho(transcript: string, speech: string): string {
  if (!speech) return transcript.trim()
  const foreign = foreignWords(transcript, speech)
  if (foreign === 0) return ''
  const said = new Set(tokens(speech))
  const heard = tokens(transcript)
  let matched = 0
  let misses = 0
  let cut = heard.length
  for (let i = 0; i < heard.length; i++) {
    const w = heard[i]!
    if (said.has(w) && !NEUTRAL.has(w)) {
      matched += 1
      misses = 0
    } else if (!NEUTRAL.has(w)) {
      if (misses === 0) cut = i
      misses += 1
      if (misses >= 2) break
    }
  }
  // fewer than two of its own words: this is the human, keep it whole
  if (matched < 2) return transcript.trim()
  // its own words with one misheard: still its echo
  if (foreign <= 1) return ''
  return cut < heard.length ? heard.slice(cut).join(' ') : transcript.trim()
}

/** The system-prompt section the active persona adds. */
export function contract(p: Persona, isTalk: boolean): string {
  const lines = [
    `# Sidekick persona`,
    p.prompt,
    `You are ${p.name}. Speak in first person as ${p.name} in every reply. You keep every ability of Claude Code: read, edit, run, search, delegate.`,
    `Rules:`,
    `- Open every reply with one plain sentence that states the outcome or the plan. That sentence is read aloud to the human.`,
    `- Keep every reply short: the opening sentence, then at most five short lines. No essays. Expand only when the human asks for detail.`,
    `- When you need input or a decision from the human (a choice, a value, a confirmation), ask at once with the AskUserQuestion tool: one question, short concrete options. Never guess and never stall.`,
    `- When the human asks for a brief, what you did, or why: answer in 2 to 4 lines, then stop.`,
    `- When you fix something, say what was broken and what you changed.`,
  ]
  if (isTalk) {
    lines.push(
      `- The human is talking to you by voice and will hear your reply. Your whole reply is one to three short conversational sentences, under 60 words, no lists, no headings. Only if code or detail is essential, put a line containing only --- and keep it below that line; it is shown but not spoken.`,
    )
  }
  return lines.join('\n')
}

const ORDINALS: Record<string, number> = {
  one: 0, first: 0, '1': 0, two: 1, second: 1, '2': 1, three: 2, third: 2, '3': 2, four: 3, fourth: 3, '4': 3,
  five: 4, fifth: 4, '5': 4, six: 5, sixth: 5, '6': 5, last: -1,
}
const STOP = new Set(['the', 'and', 'for', 'with', 'one', 'option', 'please', 'yes', 'yeah', 'lets', 'let', 'use', 'the', 'this', 'that'])
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
const words = (s: string) => norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w))

/** Picks the option(s) a spoken answer names; a long answer that names none is returned as free text. */
export function pickOption(said: string, labels: string[], multiSelect: boolean): string | undefined {
  const s = norm(said)
  if (!s) return undefined
  const hits = new Set<number>()
  const ordinals = s.split(' ').filter(w => ORDINALS[w] !== undefined)
  // "the second one": "one" is a pronoun here, not a number
  const counted = !multiSelect && ordinals.length > 1 ? ordinals.filter(w => w !== 'one') : ordinals
  for (const w of counted) {
    const n = ORDINALS[w]!
    if (labels.length > 0) hits.add(n === -1 ? labels.length - 1 : n)
  }
  let best = -1
  let bestScore = 0
  labels.forEach((label, i) => {
    const l = norm(label)
    if (!l) return
    if (s.includes(l) || (s.length > 2 && l.includes(s))) {
      hits.add(i)
      return
    }
    const score = words(label).filter(w => s.includes(w)).length
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  if (/^(yes|yeah|yep|sure|okay|ok|go ahead|do it)\b/.test(s)) {
    const i = labels.findIndex(l => /^(yes|run|proceed|ok|go|do it|recommended)/i.test(l) || /recommended/i.test(l))
    if (i >= 0) hits.add(i)
  }
  if (/^(no|nope|nah|cancel|skip)\b/.test(s)) {
    const i = labels.findIndex(l => /^(no|cancel|skip|refuse|stop)/i.test(l))
    if (i >= 0) hits.add(i)
  }
  if (hits.size === 0 && best >= 0) hits.add(best)
  const picked = [...hits].filter(i => i >= 0 && i < labels.length).sort((a, b) => a - b).map(i => labels[i]!)
  if (picked.length > 0) return multiSelect ? picked.join(', ') : picked[0]
  return s.split(' ').length >= 3 ? said.trim() : undefined
}

/** How a question is read aloud: the question, then its numbered options. */
export function askAloud(question: string, labels: string[], again = false): string {
  const opts = labels.map((l, i) => `${i + 1}: ${l}.`).join(' ')
  return again ? `Sorry, which one? ${opts}` : `${question} ${opts}`.trim()
}

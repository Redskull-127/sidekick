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
{"name": "<one or two words>", "glyph": "<exactly one emoji>", "color": "<one of: ${COLORS.join(', ')}>", "voice": "<one of: ${VOICES.join(', ')}>", "tagline": "<a catchphrase of at most 12 words>", "prompt": "<60 to 120 words, second person: 'You are <name>, ...'. Describe attitude, speaking style, how they explain, do and fix things. Never tell them to refuse coding work or to hide information.>"}`

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

/** What gets read aloud: the talk-mode head (before a `---` line) or the first paragraph, markdown stripped. */
export function spoken(markdown: string, isTalk: boolean): string {
  let text = markdown.replace(/```[\s\S]*?```/g, ' ')
  if (isTalk) {
    text = text.split(/\n-{3,}\s*\n/)[0] ?? ''
  } else {
    text = text.trim().split(/\n\s*\n/)[0] ?? ''
  }
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
}

/** The system-prompt section the active persona adds. */
export function contract(p: Persona, isTalk: boolean): string {
  const lines = [
    `# Sidekick persona`,
    p.prompt,
    `You are ${p.name}. Speak in first person as ${p.name} in every reply. You keep every ability of Claude Code: read, edit, run, search, delegate.`,
    `Rules:`,
    `- Open every reply with one plain sentence that states the outcome or the plan. That sentence is read aloud to the human.`,
    `- When you need input or a decision from the human (a choice, a value, a confirmation), ask at once with the AskUserQuestion tool: one question, short concrete options. Never guess and never stall.`,
    `- When the human asks for a brief, what you did, or why: answer in 2 to 4 lines, then stop.`,
    `- When you fix something, say what was broken and what you changed.`,
  ]
  if (isTalk) {
    lines.push(
      `- The human is talking to you by voice and will hear your reply. Lead with 1 to 3 conversational sentences, no lists. Then, if there is code or detail, put a line containing only --- and everything after it is shown but not spoken.`,
    )
  }
  return lines.join('\n')
}

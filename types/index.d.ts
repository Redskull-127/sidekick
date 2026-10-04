export type Persona = {
  id: string
  name: string
  glyph: string
  color: string
  voice: string
  tagline: string
  prompt: string
}

/** A question being asked by voice: what the band shows while the sidekick waits for an answer. */
export type SidekickQuestion = {
  text: string
  options: string[]
}

declare module 'claude-code' {
  interface PluginState {
    sidekick: {
      roster: Persona[]
      active: Persona | null
      isMuted: boolean
      isTalk: boolean
      isSpeaking: boolean
      isListening: boolean
      heard: string
      question: SidekickQuestion | null
    }
  }
}

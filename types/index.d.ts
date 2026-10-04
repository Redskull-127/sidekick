export type Persona = {
  id: string
  name: string
  glyph: string
  color: string
  voice: string
  tagline: string
  prompt: string
}

declare module 'claude-code' {
  interface PluginState {
    sidekick: {
      roster: Persona[]
      active: Persona | null
      isMuted: boolean
      isTalk: boolean
      isSpeaking: boolean
    }
  }
}

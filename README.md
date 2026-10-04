# sidekick

Persona agents you can talk to inside Claude Code. A sidekick is the one driving your session: it explains, does and fixes things in character, asks you the moment it needs a decision, gives you a brief when you ask for one, and speaks its replies out loud. You can talk back with your voice.

```
/sidekick new Rudy, a blunt senior Rust dev who hates abstractions
  🦊 Rudy is ready. "Ship it or delete it."        ← spoken aloud in Rudy's voice

/sidekick talk
  🎙 Talk mode on. Tap Space, speak, tap Space again to send. Rudy answers out loud, then it's your turn.
```

Two sidekicks ship so it works before you create anyone: **Ada** (calm staff engineer) and **Rudy** (blunt senior dev).

## What changes in your session

- Every reply is headed with the sidekick's glyph and name, the spinner reads `Thinking · Rudy is on it…`, and the question dialog is headed `🦊 Rudy asks:`.
- The sidekick is told to ask you with a short, concrete question whenever it needs input instead of guessing, to answer "brief?" in a few lines, and to say what broke and what it changed when it fixes something.
- The opening sentence of each reply is read aloud in the sidekick's macOS voice. `/sidekick mute` turns that off.
- **Talk mode** (`/sidekick talk`) switches on Claude Code's own voice dictation in tap mode, so the loop is: tap Space, speak, tap Space, hear the answer, repeat. A band above the prompt shows whose turn it is, with `s` to skip the speech, `m` to mute and `x` to end. In talk mode the sidekick keeps the spoken part short and puts code after a `---` line that is shown but not read. Questions and their options are read aloud too; pick with a number key.

## Commands

| Command | What it does |
| :- | :- |
| `/sidekick` | Roster pane: `1`–`9` switch, `0` off, `m` mute, `t` talk |
| `/sidekick new <description>` | Generates a persona (name, glyph, voice, catchphrase, character) with Haiku and makes it active |
| `/sidekick use <name>` / `/sidekick off` | Switch sidekick / plain Claude |
| `/sidekick talk` | Toggle talk mode (voice in, voice out) |
| `/sidekick mute` / `/sidekick speak` | Toggle spoken replies |
| `/sidekick list` / `/sidekick rm <name>` | Housekeeping |

Sidekicks, the active one, and mute/talk state persist across sessions in the plugin's store. The `Speak replies` option in `/config` sets the default.

## Requirements

- Claude Code **2.1.287 or later** (tested on 2.1.289). Mods run in the terminal and the Desktop app's Code tab.
- **Speech out** uses macOS `say`; on Linux and Windows replies stay text.
- **Voice in** is Claude Code's built-in dictation: it needs a claude.ai sign-in and a local microphone. If `/voice` is unavailable, talk mode still speaks and you type.

## Install

```sh
claude plugin marketplace add meertarbani/voice-agent
claude plugin install sidekick@meer-mods
```

Or for one session: `claude --plugin-dir /path/to/voice-agent`.

Before installing any mod, you can list what it hooks and calls without running it: `claude plugin validate /path/to/voice-agent`.

## Develop

```sh
claude plugin validate .   # what the engine reads from the module
claude plugin test .       # tests/sidekick.test.ts, no session or network
claude --plugin-dir .      # hot-reloads on save
```

## Not in v1

- Hands-free listening (mic opens by itself after the sidekick speaks): the mods API can't start a recording. Possible later with a local recorder plus whisper.cpp feeding `$.prompt.submit`.
- Answering a question dialog by voice: in the dialog Space toggles options, so pick with a number key.

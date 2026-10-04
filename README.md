# sidekick

Persona agents you can talk to inside Claude Code. A sidekick is the one driving your session: it explains, does and fixes things in character, asks you the moment it needs a decision, gives you a brief when you ask for one, and speaks its replies out loud. You can talk back with your voice.

```
/sidekick new Rudy, a blunt senior Rust dev who hates abstractions
  🦊 Rudy is ready. "Ship it or delete it."        ← spoken aloud in Rudy's voice

/sidekick talk
  🎙 Talk mode on. Just speak; Rudy answers out loud and listens again.
```

Two sidekicks ship so it works before you create anyone: **Ada** (calm staff engineer) and **Rudy** (blunt senior dev).

## What changes in your session

- Every reply is headed with the sidekick's glyph and name, the spinner reads `Thinking · Rudy is on it…`, and the question dialog is headed `🦊 Rudy asks:`.
- The sidekick is told to ask you with a short, concrete question whenever it needs input instead of guessing, to answer "brief?" in a few lines, and to say what broke and what it changed when it fixes something.
- The opening sentence of each reply is read aloud in the sidekick's macOS voice. `/sidekick mute` turns that off.
- **Talk mode** (`/sidekick talk`) is hands-free. The sidekick greets you and listens; when you pause it sends what you said as your prompt, works, speaks the answer, and listens again. No key to hold. A band above the prompt shows what is happening (`listening…` with the words as they are recognized, `speaking…`, `working…`) with `s` to skip the speech, `l` to listen now, `m` to mute and `x` to end. Say "end talk" to stop. Three long silences in a row end talk mode on their own.
- **Questions by voice.** When the sidekick needs a decision in talk mode it reads the question and the numbered options aloud, listens, and takes your answer: "the second one", "production", "yes", or a free-text answer of a few words. If it can't match what you said after two tries, the normal dialog opens and you pick with a key.
- In talk mode the sidekick keeps the spoken part short and puts code after a `---` line that is shown but not read.

## Commands

| Command | What it does |
| :- | :- |
| `/sidekick` | Roster pane: `1`–`9` switch, `0` off, `m` mute, `t` talk |
| `/sidekick new <description>` | Generates a persona (name, glyph, voice, catchphrase, character) with Haiku and makes it active |
| `/sidekick use <name>` / `/sidekick off` | Switch sidekick / plain Claude |
| `/sidekick talk` | Toggle hands-free talk mode (voice in, voice out) |
| `/sidekick mute` / `/sidekick speak` | Toggle spoken replies |
| `/sidekick list` / `/sidekick rm <name>` | Housekeeping |

Sidekicks, the active one, and mute/talk state persist across sessions in the plugin's store. The `Speak replies` option in `/config` sets the default.

## Requirements

- Claude Code **2.1.287 or later** (tested on 2.1.289). Mods run in the terminal and the Desktop app's Code tab.
- **Speech out** uses macOS `say`; on Linux and Windows replies stay text.
- **Voice in** is a 90-line native listener (`bin/listen.swift`) that uses macOS's own speech recognition, on-device where the language model is installed. It is compiled once on first use into `~/.claude/plugins/data/sidekick/` with `swiftc`, which comes with the Xcode Command Line Tools (`xcode-select --install`). The first run asks for Microphone and Speech Recognition permission for your terminal. Nothing is sent to any third party; on-device recognition sends nothing anywhere.
- Prefer push-to-talk? Claude Code's own `/voice` dictation still works alongside; the sidekick speaks its replies either way.

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

## How hands-free works

A mod cannot open a microphone itself, so the sidekick spawns the listener binary. It records until you pause for 1.4 seconds (or 45 seconds at most), streams the partial transcript to the band, prints the final text, and exits. The mod submits that text as your prompt. While the sidekick speaks, nothing listens, so it never hears itself. A turn you start by typing stops any listening in progress.

## Not in v1

- Interrupting the sidekick by talking over it (barge-in). Press `s` to skip the speech instead.
- Languages: the listener uses your macOS locale. Pass `--lang` in `hooks/register.tsx` to pin one.

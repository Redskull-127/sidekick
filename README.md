# sidekick

Persona agents you can talk to inside Claude Code. A sidekick is the one driving your session: it explains, does and fixes things in character, asks you the moment it needs a decision, gives you a brief when you ask for one, and speaks its replies out loud. You can talk back with your voice.

```
/sidekick new Rudy, a blunt senior Rust dev who hates abstractions
  🦊 Rudy is ready. "Ship it or delete it."        ← spoken aloud in Rudy's voice

/sidekick talk
  🎙 Talk mode on. Just speak; Rudy answers out loud and listens again.
```

Two sidekicks ship so it works before you create anyone: **Ada** (calm staff engineer) and **Rudy** (blunt senior dev). A sidekick never announces itself by voice; a cabin-style chime says "on" and "your turn", and a lower one says talk mode ended. The name is in the terminal header.

## What changes in your session

- Every reply is headed with the sidekick's glyph and name, the spinner reads `Thinking · Rudy is on it…`, and the question dialog is headed `🦊 Rudy asks:`.
- The sidekick is told to ask you with a short, concrete question whenever it needs input instead of guessing, to answer "brief?" in a few lines, and to say what broke and what it changed when it fixes something.
- The opening sentence of each reply is read aloud in the sidekick's macOS voice. `/sidekick mute` turns that off.
- **Talk mode** (`/sidekick talk`) is hands-free and continuous. The sidekick greets you and listens; when you pause it sends what you said as your prompt, works, speaks the answer, and keeps listening. No key to hold. **Talk over it to interrupt**: the moment it hears words that aren't its own, it stops speaking and takes yours as the next prompt. Say **"stop"** or "wait" while it works to cancel the turn. Say **"end talk"** to stop. A band above the prompt shows what is happening (`listening…` with the words as they are recognized, `speaking…`, `working…`) with `s` to skip the speech, `m` to mute and `x` to end. Three long silences in a row end talk mode on their own.
- **Short answers.** Spoken replies are one sentence (two in talk mode); the persona is told to keep the whole reply to a few lines and to expand only when asked.
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

A mod cannot open a microphone itself, so the sidekick spawns the listener binary, over and over, for as long as talk mode is on. Each run records until you pause for 1.4 seconds (or 60 seconds at most), streams the partial transcript to the band, prints the final text, and exits. The mod submits that text as your prompt.

The listener runs while the sidekick speaks too, so you can interrupt. Its own voice comes back through the microphone, so the mod drops the leading words that match what it was saying; the first two words that aren't its own cut the speech short. The listener captures through AVFoundation and picks the system's default microphone (`bin/listen.swift --list-devices` shows them; pass `--device <name part>` in `hooks/register.tsx` to pin one).

## Known limits

- Echo is filtered by words, not by acoustics. Repeating the sidekick's own words back to it right after it says them won't register as a new prompt.
- Languages: the listener uses your macOS locale. Pass `--lang` in `hooks/register.tsx` to pin one.
- After editing `bin/listen.swift`, run `python3 scripts/embed-listener.py`; the binary rebuilds on next use.

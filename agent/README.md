# Piťu — voice assistant agent

A background Python process on the PC. It listens for a wake phrase locally, understands Slovak speech through Azure, answers with Claude in the voice of Azure's *sk-SK-LukasNeural*, runs a handful of PC commands, and drives a face on the Kraken LCD over a loopback WebSocket.

```
mic ─► wake word (openWakeWord, local) ─► Azure STT ─► Claude (+ commands) ─► Azure TTS ─► speakers
                                                                               └─► mouth envelope ─► ws://127.0.0.1:8765 ─► LCD face
```

## Setup

1. **Python 3.12.** `winget install Python.Python.3.12`, then from this folder:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

2. **Keys.** Copy `.env.example` to `.env` and fill it in. `.env` is gitignored; keys never go anywhere else.
   - Azure portal → create a **Speech** resource, pricing tier **Free F0**, region West Europe → *Keys and Endpoint*.
   - [console.anthropic.com](https://console.anthropic.com) → API keys.
   - Optional, for "pusti mi Elán" (Spotify Premium): put the LCD page's Spotify Client ID in `SPOTIFY_CLIENT_ID`, add `http://127.0.0.1:8766/callback` to that app's Redirect URIs in the Spotify Developer Dashboard, then log in once with `.\.venv\Scripts\python.exe -m pitu.spotify`.

3. **Microphone access.** Windows Settings → Privacy & security → Microphone → *Let desktop apps access your microphone* must be on.

4. **Try it**, then install it:

   ```powershell
   .\.venv\Scripts\python.exe -m pitu        # say "Hej Piťu"
   .\install.ps1                             # start at logon, hidden
   ```

`install.ps1` registers a Task Scheduler logon task that runs `pythonw -m pitu` with no window at below-normal priority, and re-launches it within 5 minutes if it ever dies. `.\install.ps1 -Uninstall` removes it. The LCD side needs nothing: the page on GitHub Pages reconnects to the agent on its own, whichever of the two starts first.

## Testing without the mic or the LCD

| Command | What it does |
| --- | --- |
| `python -m pitu --text` | type instead of speaking; real Claude, real voice, real face events |
| `python -m pitu --text --no-tts` | replies are printed instead of spoken |
| `python -m pitu --text --fake-brain --no-tts` | canned replies — no keys, no cost |
| `python -m pitu --simulate offline` | no internet: the cached "Nejde mi internet" phrase and the offline face |
| `python -m pitu --simulate stt-fail` / `claude-slow` | the other failure paths |
| `python -m pitu --wake-test` | live wake-word scores, to tune `WAKE_THRESHOLD` |
| `python -m pitu --list-devices` | WASAPI devices, for `MIC_DEVICE` / `SPEAKER_DEVICE` |
| `-v` | debug logging |

With the agent running and `FACE_DEV_ORIGINS=1` in `.env`, `npm run dev` and `http://127.0.0.1:5173/?kraken=1` shows the face exactly as the LCD will. Without that flag the agent only accepts the GitHub Pages origin, so other local projects on Vite's ports can't connect. Without the agent, `?kraken=1&mock=1` drives the face from the keyboard: `1` sleep, `2` listen, `3` think, `4` speak, `5` offline, `6` alarm, `7` error, `w` a whole turn.

Logs: `data/logs/pitu.log`. Every turn logs its latency split (end of speech → transcript → first token → first audio).

## Diagnostics page

While the agent runs, open **http://127.0.0.1:8765/** in any browser. It shows:
- a volume slider for Piťu's own beeps and speech; it applies at once and is kept in `data/settings.json`, ahead of `VOLUME` in `.env`;
- live mic level and wake-word score against the threshold;
- the face state and a two-minute state timeline;
- every turn: what was heard, the reply, each tool call with its result, the latency split against the 2 s target, and tokens including cache reads;
- CPU, memory, ducking, timers, whether an LCD page is connected, CAM temperatures;
- the live log.

The detailed stream (transcripts included) only goes to this page, which the agent serves itself; the LCD connection carries face states and nothing you said.

The agent also serves the repo's local build at `http://127.0.0.1:8765/display/` (`npm run build` in the repo root; rebuild after changing the display code). It is the fallback for CAM. Current Chrome no longer lets a public site such as GitHub Pages reach `127.0.0.1`. CAM 4.76 runs Chrome 128 and isn't affected, but if a CAM update leaves the face blank, point CAM's Web Integration URL at `http://127.0.0.1:8765/display/` instead. That copy has its own storage, so photos and the Spotify login have to be set up again there.

## Making it yours

- **Personality** — `persona.md`, plain Slovak text. It is re-read on the next turn after you save it. Private details (names, habits) go in `persona.local.md`, which is gitignored.
- **Apps and sites it may open** — `apps.toml`. It opens nothing else: the names become a fixed list the model must choose from.
- **Lights** — `lights.toml`: a name you say, and how to reach the light over the home network. Yeelight works locally with *LAN Control* switched on in the Yeelight app; no account or cloud is involved. Tuya bulbs (Immax NEO, Smart Life) are also controlled locally, but each needs its local key in `.env` as `TUYA_KEY_<id>`: pair them in Smart Life, link that account to a cloud project on iot.tuya.com, and `python -m tinytuya wizard` lists the keys. Re-pairing changes the key. A `group` entry switches several lights at once. `[moods.*]` names a brightness and colour ("svetlo na čítanie"); the effects párty, prelievanie and sviečka run inside the bulbs themselves, so they keep going without the agent.
- **Memory** — what Piťu learns about you ("zapamätaj si…", your name, what you like) is kept in `data/memory.md`, one line per fact, and given to Claude at the start of every conversation. Edit or delete lines by hand, or say "zabudni…".
- **Routines** — `routines.toml`: several steps on one sentence ("nachystaj ma do roboty"): switch to a virtual desktop, open apps from `apps.toml` there, start Mouse Jiggler.
- **Settings** — the optional lines in `.env.example`: model, voice and rate, wake threshold, how long it keeps listening after answering, how far other apps are turned down while it talks.

### Adding a command

Drop a function into any module in `pitu/commands/` (or a new module there). The decorator turns its signature into the tool schema; nothing else needs registering.

```python
import ctypes
from . import CommandError, command

@command("Uzamkne počítač.")
def lock_pc() -> str:
    ctypes.windll.user32.LockWorkStation()
    return "locked"

@command("Zistí voľné miesto na disku C.", speaks=False)
def free_space() -> dict:
    ...
```

- Action commands (the default) get an extra `say` argument: the sentence Claude wants spoken after the action. No second model call is needed.
- `speaks=False` commands return data, and Claude phrases the answer from it.
- Raise `CommandError("…")` with a Slovak sentence to have it said out loud.
- Parameters: `int`, `float`, `str`, `bool`, `Literal[...]`, or `Annotated[str, Choices(fn)]` for a list known only at runtime. Commands run on a worker thread with COM initialised, and time out after 5 s unless you pass `timeout=`.

## Behaviour worth knowing

- **You can talk over it.** WebRTC echo cancellation (livekit) removes its own voice from the mic using what the first `SPEAKER_DEVICE` plays, so list the speakers the mic hears first. Any speech while it talks (voice detection ≥ `BARGE_VAD` for ~0.3 s) or the wake word stops it, and what you say becomes the next turn; the model is told how far it got. `ECHO_DELAY_MS` is the speaker→mic latency hint. With `BARGE_IN=0`, or if livekit fails to load, it is half-duplex: the mic is ignored while it talks.
- **Follow-ups need no wake word.** After an answer it listens for about 5 s, but only sends audio to Azure once local voice detection hears someone.
- **Other apps are ducked** to 30 % while it listens and talks. The original levels are saved to disk first, so a crash can't leave them low.
- **Web search** runs on Anthropic's side (the `web_search` server tool, at most 3 searches per answer): "aké bude zajtra počasie", "ako hral Slovan". It says "Pozriem sa." first, since an answer takes about 5 s. The browser only opens on "vygoogli mi…". Each search costs $0.01 on top of tokens.
- **Timers** are kept in `data/timers.json`. They ring without internet: alarm face, chime, and the label spoken (or a cached phrase when offline).
- **Offline.** The wake word and timers keep working. Anything needing the cloud gets a short spoken apology from a phrase cache built while online, and the face shows offline.
- **Privacy.** No audio leaves the PC before the wake word. After it, only the utterance goes to Azure. No audio is saved, but transcripts appear in the log. Conversation memory lasts 3 minutes.
- **Resources.** Idle: about 4 % of one core (wake word and echo cancellation on CPU), ~300 MB RAM, no GPU.

## Wake word

**"Hej Piťu"** is `models/hej_pitu.onnx`, trained on synthetic Slovak voices; see [training/](training/README.md) for how it was made and how well it does. If it misses you too often, lower `WAKE_THRESHOLD` (the diagnostics page shows the live score against it). `WAKE_MODEL=hey_jarvis` in `.env` switches back to openWakeWord's stock English "Hey Jarvis".

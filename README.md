# Kraken LCD

A custom screen for the 2.72" round LCD on an NZXT Kraken Elite V2, running through NZXT CAM's **Web Integration** mode and hosted on GitHub Pages.

Three states on one page:

- **Slideshow** — your own photos, crossfading. They are stored in the browser and never leave the machine.
- **Now playing** — the album art becomes a full-screen rotating record, with progress as a hairline arc riding the outer rim and no text anywhere. Takes over automatically when something plays; falls back to the slideshow a configurable delay after it stops.
- **Clock + temperatures** — the current time at the top of the circle with CPU and GPU temperatures beneath it, slideshow only; the music screen carries no text at all. The ink flips light/dark per photo so it stays readable, and the temperature row is toggleable.

The configuration window is in Slovak. Code, comments and commits are in English.

---

## Setup

### 1. Publish it

Fork or clone this repo, then in **Settings → Pages** set the source to **GitHub Actions**. Pushing to `main` builds and deploys via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

Your URL will be `https://<user>.github.io/<repo>/`.

> The repo has to be public for Pages on the free plan. That is fine here: there is no client secret anywhere (PKCE does not use one), and your photos are stored in the browser, never in the repo.

### 2. Create a Spotify app

Optional — skip it if you only want the slideshow.

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Set the redirect URI to **exactly** your Pages URL including the trailing slash: `https://<user>.github.io/<repo>/`. The config window prints the exact string with a copy button — use that rather than typing it.
3. Copy the **Client ID** (not the secret — you will never need it) into the config window and press *Pripojiť Spotify*.

Creating a developer app may require a Spotify Premium account.

### 3. Point CAM at it

In CAM: **Lighting → Kraken → LCD Display → Web Integration → Custom**, paste the URL, confirm. The **Configure** button opens the settings window, where you add photos and connect Spotify.

CAM opens two windows of the same URL: a hidden one with `?kraken=1` appended that is streamed to the panel, and the normal configuration window. They share an origin, so settings, photos and tokens pass between them over `localStorage` and a `BroadcastChannel`.

---

## Local development

```bash
npm install
npm run dev
```

Serves on `http://127.0.0.1:5173` — the loopback **IP literal**, not `localhost`. Spotify rejects the hostname `localhost` as a redirect URI but explicitly permits plain HTTP on a loopback IP, so real OAuth works locally with no certificate setup. Add `http://127.0.0.1:5173/` as a second redirect URI on your Spotify app to test the real flow.

### Mock mode

`?mock=1` injects fake CAM telemetry and a fake player, so the whole UI can be built and profiled without hardware or an account.

| URL | Shows |
| --- | --- |
| `http://127.0.0.1:5173/` | the configuration window |
| `http://127.0.0.1:5173/?kraken=1` | exactly what the panel renders |
| `http://127.0.0.1:5173/?kraken=1&mock=1` | the panel, driven by fake data |

Keys in mock mode:

| Key | Effect |
| --- | --- |
| `space` | play / pause |
| `n` | next track |
| `←` `→` | seek ∓10 s |
| `s` | stop — nothing playing, triggers the fallback to the slideshow |
| `e` | toggle forced poll errors |
| `u` | toggle "authorisation revoked" |
| `d` | toggle a degraded monitoring payload with missing fields |
| `t` | force a temperature spike |

The mock tracks deliberately include Slovak diacritics, an over-long title, and a podcast episode, because those are the three things that break this layout.

---

## How it is built

Vite + TypeScript, vanilla DOM, no framework. `base: './'` so the build works from a Pages subpath.

```
src/
  core/      display geometry, cross-window bus, state machine, frame ticker
  data/      CAM monitoring, Spotify auth + polling, IndexedDB photos, settings, mock
  render/    the screen and its views — shared by the panel and the config preview
  config/    the settings window
```

A few decisions worth knowing about, because they are load-bearing rather than stylistic:

**The music screen does no per-frame JavaScript.** Rotation is a Web Animations infinite rotate whose speed is changed through `playbackRate`, so it stays on the compositor and never jumps phase. The progress arc is set once per two-second poll with a linear transition aimed one interval ahead — the tween *is* the progress interpolation. The arc is two rotated half-rings rather than an animated `stroke-dashoffset`, which would repaint the whole panel every frame. Measured on the settled screen: zero DOM mutations from the disc over seven seconds.

**The hidden window may not composite.** In that state `requestAnimationFrame` can be starved and `HTMLImageElement.decode()` can stay pending forever — both observed, not theorised. The ticker watches for starvation and falls back to a timer, and image loading is gated on `load` with `decode()` raced against a small budget.

**Refresh tokens rotate.** Two windows refreshing at once would invalidate each other and log you out, so a timestamped claim in `localStorage` elects one refresher and the loser adopts the winner's token.

**Nothing is 640-hardcoded.** The panel's size, shape and target FPS come from `window.nzxt.v1`, with 640 / circle / 60 as fallbacks. The stylesheet is authored in a 640-space that is scaled by a single `--u` multiplier, and text is clipped to the chord of the safe circle at its own baseline so a long title cannot reach the steep-angle outer ring.

**Photos are cover-scaled, not fit.** The brief said fit 640×640; letterboxing a 16:9 photo would put black bars across a round panel. The short edge lands on the display size and the long edge is capped so a panorama cannot balloon the store.

## Privacy

Photos are downscaled in the browser, re-encoded as WebP and stored in IndexedDB. They are never uploaded and never committed. Spotify tokens live in `localStorage` on your machine. There is no backend and no client secret.

Photos live in **this browser profile only**. Keep your originals on disk — resetting the CAM profile wipes them.

## Fonts

[Inter](https://github.com/rsms/inter) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), both SIL Open Font License, vendored in `public/fonts/` (latin + latin-ext subsets, gated by `unicode-range`). Licences are alongside them. Non-latin track titles fall through to the system face.

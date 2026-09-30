# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static VanillaJS single-page app that flies an arcade lunar lander with a Jev-style
decision model served by a local Ollama (`/v1/systemone`, Ollama 0.35+). No build
step, no npm, no Python at run time. Physics, guidance and the model prompt are a
line-for-line port of the sibling `../lunar-laya` (Python), which is the source of
truth for those parts. Not a git repository.

## Commands

```bash
python3 -m http.server 8765 --bind 127.0.0.1   # serve; open http://127.0.0.1:8765/
node --check sim.js && node --check app.js      # syntax
node check.cjs                                  # the only test; see below
ollama pull tev1:0.8b                           # smallest decision model (~90 ms/decision)
```

`check.cjs` runs three things and prints `ok`/`skip` per item:
1. Baseline (guidance only) lands 30/30 seed/pad combinations.
2. Parity with `../lunar-laya`: starts Python from the same state, requires every
   prompt string and state to match to 1e-9. Skipped if the sibling is absent.
   Needs only Python 3, no MLX.
3. One live assisted flight through Ollama with the smallest installed `decision`
   model. Skipped if Ollama is unreachable. `JEV_MODEL=nimble` overrides the model;
   `OLLAMA_HOST` may lack a scheme and `0.0.0.0` is rewritten to `localhost`.

There is no single-test filter; comment out a section or run a one-off script that
`require("./sim.js")`s, as the headless flights during development did.

## Why the page must be served, not opened from disk

Browsers send `Origin: null` for `file://` pages and Ollama's default CORS allowlist
does not accept `null`, so `fetch` fails before leaving the browser. Any loopback
`http://127.0.0.1:*` or `http://localhost:*` origin is allowed by Ollama out of the
box. Do not "fix" this in the app; it is an Ollama-side policy (`OLLAMA_ORIGINS`).

## Architecture

- `sim.js` is loaded by both the browser (plain script) and Node (`module.exports`
  guard at the bottom). It holds physics (`Game`), PD `guidance`, the prompt
  (`observation`), the two `QUESTIONS`, the Ollama client (`askJev`) and `decide`,
  which mirrors lunar-laya's `Pilot.decide` contract: `baseline` flies guidance,
  `jev` flies the model, `assisted` flies the model unless it disagrees with guidance.
- `app.js` is DOM only: controls, the flight loop, canvas drawing, flight log,
  recording download. Globals from `sim.js` are used directly (`Game`, `decide`,
  `PADS`, `TERRAIN`, `ground`, `wrap`, `RADIUS`, `DT`, `CONTROL_STEPS`).
- The flight loop pipelines: after stepping physics for stage N it immediately
  requests decision N+1 and animates stage N while waiting, so model latency under
  200 ms costs no wall time at 1x. The pending promise gets a no-op `.catch` so an
  abort mid-animation does not surface as an unhandled rejection.
- Decision latency for a 9B model is dominated by prompt processing of the ~640
  token state string, so quantization does not help and the prompt cache does not
  hit (the sentence changes at its start). Keep this in mind before adding text to
  `observation`.

## Invariants to preserve

- `observation()` and `QUESTIONS` must stay byte-identical to lunar-laya's
  `pilot.py`; `check.cjs` item 2 enforces the prompt. Changing them is a deliberate
  decision to diverge, and the README's parity claim must change with it.
- `Game.step`, `guidance`, `ground`, `surfaceHeight` and the constants are the port;
  the one intended divergence is the start distribution (`x` uniform 100–900 m,
  lunar-laya starts near the target pad). Seeds use mulberry32 and are not
  lunar-laya's Python seeds.
- `drawLander` and its `HULL`/`NOZZLE`/`STRUTS`/`PADS_ART` tables are shared byte for
  byte with lunar-laya, lunar-mpc and lunar-mpc-laya. Do not restyle them here.
- Downloaded recordings use lunar-laya's `schema_version: 1` layout so its replay
  tooling can read them.
- Model dropdown lists only models whose `/api/tags` entry has the `decision`
  capability, sorted smallest first (nimble is ~0.7 s/decision here, tev1 ~90 ms).

## Documentation conventions

README states measured results with the machine, model tag and seed range, and keeps
unfavorable ones (nimble's latency, the cut-short matrix). Landings demonstrate
request following, not independent piloting, because the prompt carries the
requested command; keep that framing.

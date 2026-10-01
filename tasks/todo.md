# Browser pilot: fine-tune on gc5, run in the browser

Goal: a Jev-style decision model that flies the lander inside the page with no Ollama,
no server, no cloud. Fine-tuned by us on an Apache-2.0 base, short prompt, loaded once
and cached. Plan only; nothing below is started.

## Why this route (measured 2026-09-30)

- Same 100 recorded prompts (644-720 tokens), sequential, server-side wall time:
  tev1:0.8b 91 ms on M4 Max vs 95 ms on RTX PRO 6000; nimble 9B 646 vs 300 ms.
  4 parallel clients: latency triples, throughput only 1.3-1.6x, GPU at 21%.
  Ollama's systemone path is serialized per question row; a bigger GPU does not help.
- In-browser cost is prefill of two ~650-token rows per decision (research estimate
  0.4-0.9 s on WebGPU). Only a shorter prompt fixes that.
- tev1 weights: license "being finalized". Nothing public ships on them.
- Fine-tuning buys: short prompt, our weights, and optionally real piloting
  (no requested command in the prompt, model imitates guidance from telemetry alone).

## Decisions

- Base: Qwen3-0.6B (Apache-2.0, plain transformer, prebuilt in onnx-community and
  WebLLM). Not Qwen3.5-0.8B: Gated DeltaNet hybrid blocks prefix caching in the browser
  and needs a custom MLC compile. Try smaller (SmolLM2-360M/135M) if 0.6B misses
  latency; the task is two 3-way choices from 9 numbers.
- Runtime: transformers.js v4 / ONNX Runtime Web. Raw logits from forward(), WebGPU
  plus WASM fallback, Cache API. WebLLM is the fallback (reuse prebuilt wasm if arch
  and q4f16_1 quant are kept; logits via LogitProcessor).
- Prompt: new short format (~100 tokens), fixed schema text first, changing state last,
  so the prefix can be prefilled once. This is a deliberate divergence from
  lunar-laya's sentence; keep observation() for the Ollama pilots untouched and add a
  second builder for the browser pilot.
- Framing stays honest: with the requested command in the prompt, landings show
  request following; without it, landings show imitation of PD guidance. README says
  which one is flying.

## Phase 0: data (Mac, no GPU) `[ ]`

- [ ] `data.cjs`: fly baseline on seeds x 3 pads via `sim.fly`, emit
      `{state_text, rotation, engine}` JSONL. Target 500k rows. Seconds of compute.
- [ ] Off-trajectory states: every k stages take 1-5 random commands, then record
      what guidance would do from there. Without this the model only sees perfect
      flights and fails after its first mistake (DAgger-style coverage).
- [ ] Two variants of state_text: with and without the requested command.
- [ ] Hold out seeds 9000-9999 for evaluation. Never train on them.
- [ ] Check letter codes A/B/C are single tokens in the base tokenizer.

## Phase 1: fine-tune on gc5 (tmux session `lunar-jev`) `[ ]`

- [ ] `uv venv` in `~/lunar-jev/ft`, torch + transformers + trl + peft. One GPU.
- [ ] SFT: prompt = short state (+ schema), target = one letter per question row,
      same two-row layout Ollama uses so the browser scorer mirrors it. Full fine-tune
      of 0.6B fits easily in 96 GB; LoRA if iterating fast.
- [ ] Eval offline: exact match vs guidance on held-out seeds, per question.
- [ ] Eval closed loop before any browser work: 30-line HTTP shim on gc5 that speaks
      `/v1/systemone` over the fine-tuned model (HF generate with logits, or vLLM).
      Point the SPA's host box at it through an ssh tunnel; fly jev mode on 30 seeds x
      3 pads; require landings comparable to baseline. Measure override rate in
      assisted mode. Repeat for the no-request variant.
- [ ] Record results (landed/N, overrides, p50) in README's measured table with the
      host and model named.

## Phase 2: export `[ ]`

- [ ] safetensors -> ONNX with optimum / transformers.js conversion script, q4f16 and
      q8. Parity: Node ORT vs HF on 1000 held-out prompts, same argmax, probabilities
      within quantization noise.
- [ ] Pick quant by measured error, not size.
- [ ] Publish ONNX + tokenizer to a HF repo (CORS-enabled) with attribution to the
      base model. Note license in README.

## Phase 3: browser scorer `[ ]`

- [ ] `jev-browser.js`: same contract as `askJev(host, model, state, signal)` ->
      `{answers}`: tokenizer, prefill schema prefix once per flight, run the two state
      tails, gather letter logits, softmax, confidence = 1 - H(p)/ln N.
- [ ] `decide()` gains a runtime switch: `ollama` (today) or `browser`.
- [ ] `check.cjs` item 4: browser scorer vs Ollama-shim answers on identical prompts
      (skip if ONNX absent). Headless Chrome with WebGPU for the live flight check.

## Phase 4: integrate `[ ]`

- [ ] Runtime selector in the controls (Ollama | In browser). Model dropdown lists the
      browser model when selected.
- [ ] Download progress bar, `navigator.storage.persist()`, show `estimate()`.
- [ ] WebGPU detection; WASM fallback with a notice that only `max` speed is usable.
- [ ] Measure p50/p95 on M4 Max in Chrome and Safari; record in README.
- [ ] Target: under 200 ms per decision on WebGPU so 1x costs no wall time.

## Phase 5: wrap up `[ ]`

- [ ] README: new section on the browser pilot, what it was trained on, what a
      landing proves, model size and first-load cost.
- [ ] CLAUDE.md: the second prompt builder is not covered by the lunar-laya parity
      invariant; say so.
- [ ] Tear down gc5: stop `~/ollama/bin/ollama serve`, remove `~/ollama`,
      `~/.ollama` (10.3 GB), `~/lunar-jev` when no longer needed.

## Open questions

- Keep the requested command in the browser prompt (safe, request following) or
  drop it (riskier, real imitation)? Train both; decide on closed-loop numbers.
- Smallest model that lands: 0.6B is the starting point, not the answer.
- Safari deletes script-writable storage after 7 days without a visit; acceptable?

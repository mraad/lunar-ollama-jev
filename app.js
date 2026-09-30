"use strict";

const $ = id => document.getElementById(id);
const canvas = $("flight-canvas"), ctx = canvas.getContext("2d");
const run = {game: null, frames: [], frame: null, blend: 0, abort: null, log: []};
const DESCRIPTIONS = {
  baseline: "Deterministic PD guidance flies the ship. No model call.",
  jev: "The Jev model's answers execute directly. No overrides.",
  assisted: "The Jev model proposes; any disagreement with guidance is replaced.",
};

$("host").value = localStorage.getItem("host") || "http://localhost:11434";
$("host").onchange = () => { localStorage.setItem("host", $("host").value); loadModels(); };

async function loadModels() {
  $("model").replaceChildren();
  try {
    const response = await fetch(`${$("host").value}/api/tags`);
    const tags = (await response.json()).models.filter(m => m.capabilities?.includes("decision"));
    if (!tags.length) throw new Error("No decision model installed. Run: ollama pull tev1:0.8b");
    tags.sort((a, b) => a.size - b.size); // smallest first: it is the one that keeps up with 1x playback
    for (const m of tags) $("model").append(new Option(`${m.name} · ${m.details.parameter_size}`, m.name));
    $("model").value = tags[0].name;
    $("notice").textContent = "";
    $("launch").disabled = false;
  } catch (error) {
    $("notice").textContent = `${error.message}. Is Ollama 0.35+ running at ${$("host").value}?`;
    $("launch").disabled = true;
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch() {
  if (run.abort) { run.abort.abort(); return; }
  const abort = new AbortController(), signal = abort.signal;
  run.abort = abort;
  const opts = {mode: $("pilot").value, host: $("host").value, model: $("model").value, signal};
  const game = new Game(Number($("seed").value), Number($("pad").value));
  run.game = game; run.frames = []; run.frame = null;
  $("launch").textContent = "■ Abort";
  $("notice").textContent = "";
  $("pilot-description").textContent = DESCRIPTIONS[opts.mode];
  $("engine-tag").textContent = opts.mode === "baseline" ? "GUIDANCE" : opts.model;
  try {
    let before = game.snapshot(), next = decide(game, opts);
    while (game.state.status === "flying" && run.frames.length < 900) {
      const {command, decision} = await next;
      const after = game.step(command);
      run.frame = {before, decision, after};
      run.frames.push(run.frame);
      // Ask for the next decision while this 0.2 s stage animates, so model latency
      // under one stage costs no wall time at 1x.
      next = game.state.status === "flying" ? decide(game, opts) : null;
      next?.catch(() => {}); // rejection is handled at the next await; keep it out of the console
      const span = Number($("speed").value) ? (after.time - before.time) * 1000 / Number($("speed").value) : 0;
      for (const start = performance.now(); performance.now() - start < span && !signal.aborted;) {
        run.blend = (performance.now() - start) / span;
        render();
        await new Promise(requestAnimationFrame);
      }
      run.blend = 1;
      before = after;
    }
    finish(opts);
  } catch (error) {
    if (error.name !== "AbortError") $("notice").textContent = `${error.message}. Flight stopped.`;
    else $("notice").textContent = "Flight aborted.";
  } finally {
    run.abort = null;
    $("launch").textContent = "▲ Launch";
    render();
  }
}

function finish(opts) {
  const terminal = run.game.snapshot();
  if (terminal.status === "flying") terminal.status = "truncated";
  const times = run.frames.map(f => f.decision.latency_ms).sort((a, b) => a - b);
  const summary = {seed: run.game.seed, target: run.game.target, ...terminal, decisions: run.frames.length,
    interventions: run.frames.filter(f => f.decision.intervened).length,
    latency_p50_ms: times[Math.floor(times.length / 2)] ?? 0,
    latency_p95_ms: times[Math.ceil(times.length * 0.95) - 1] ?? 0};
  run.log.push({pilot: opts.mode, model: opts.mode === "baseline" ? "—" : opts.model, summary});
  const tr = document.createElement("tr");
  for (const v of [opts.mode, run.log.at(-1).model, `${summary.seed} / ${summary.target + 1}`,
    summary.status.replaceAll("_", " "), summary.score, `${summary.interventions}/${summary.decisions}`,
    `${summary.latency_p50_ms.toFixed(0)} ms`]) {
    const td = document.createElement("td"); td.textContent = String(v); tr.append(td);
  }
  $("log").prepend(tr);
  // Same schema-1 shape as lunar-laya recordings, so its replay tooling can read the file.
  const record = {schema_version: 1, pilot: {mode: opts.mode, model: run.log.at(-1).model, runtime: "ollama /v1/systemone"},
    world: {terrain: TERRAIN, pads: PADS, dt: DT, control_steps: CONTROL_STEPS},
    episodes: [{summary, frames: run.frames}]};
  URL.revokeObjectURL($("download").href);
  $("download").href = URL.createObjectURL(new Blob([JSON.stringify(record)], {type: "application/json"}));
  $("download").download = `lunar-jev-${opts.mode}-${summary.seed}.json`;
  $("download").hidden = false;
}

const command = c => `${["LEFT", "HOLD", "RIGHT"][c.turn + 1]} / ${Math.round(c.throttle * 100)}%`;

function probabilities(answers) {
  $("probabilities").replaceChildren();
  if (!answers) { $("probabilities").textContent = "Guidance controls this flight. No model distribution."; return; }
  for (const [q, answer] of Object.entries(answers)) {
    const group = document.createElement("div"); group.className = "prob-group";
    const title = document.createElement("div"); title.className = "prob-title";
    title.textContent = `${q === "rotation" ? "ROTATION" : "MAIN ENGINE"} · confidence ${(answer.confidence * 100).toFixed(0)}%`;
    group.append(title);
    for (const [label, p] of Object.entries(answer.probabilities)) {
      const row = document.createElement("div"); row.className = "prob-row" + (label === answer.choice ? " selected" : "");
      const bar = document.createElement("div"); bar.className = "prob-bar";
      const fill = document.createElement("i"); fill.style.width = `${Math.max(0, Math.min(100, p * 100))}%`;
      bar.append(fill);
      const l = document.createElement("span"); l.textContent = label;
      const r = document.createElement("span"); r.textContent = `${(p * 100).toFixed(0)}%`;
      row.append(l, bar, r); group.append(row);
    }
    $("probabilities").append(group);
  }
}

function render() {
  if (!run.game) return;
  const f = run.frame, flying = run.abort !== null;
  const s = f ? f.before : run.game.snapshot(), pad = PADS[run.game.target];
  const shown = flying || !f ? s : run.game.snapshot();
  $("mission-label").textContent = `SEED ${run.game.seed} / PAD 0${run.game.target + 1}`;
  $("altitude").textContent = `${Math.max(0, shown.y - pad[2] - RADIUS).toFixed(0)} m`;
  $("vertical").textContent = `${shown.vy.toFixed(1)} m/s`;
  $("horizontal").textContent = `${shown.vx.toFixed(1)} m/s`;
  $("fuel").textContent = `${shown.fuel.toFixed(1)}%`;
  $("flight-status").textContent = shown.status.replaceAll("_", " ").toUpperCase();
  $("mission-time").textContent = `T+ ${shown.time.toFixed(2)} s`;
  $("tilt").textContent = `TILT ${shown.angle.toFixed(1)}°`;
  $("frame-label").textContent = `DECISION ${run.frames.length}`;
  if (f) {
    const d = f.decision;
    $("proposed").textContent = command(d.proposed);
    $("executed").textContent = command(d.executed);
    $("latency").textContent = `${d.latency_ms.toFixed(0)} ms`;
    $("prompt").textContent = d.prompt;
    $("intervention").textContent = d.intervened ? "GUIDANCE OVERRIDE · Proposal replaced" :
      $("pilot").value === "assisted" && d.answers ? "MODEL AGREES WITH GUIDANCE" : "DIRECT EXECUTION";
    $("intervention").classList.toggle("warning", d.intervened);
    probabilities(d.answers);
  }
  const end = !flying;
  draw(end || !f ? shown : pose(f.before, f.after, run.blend), f?.decision, end);
}

// ---------- shared lander art ----------
// One chamfered-box lander, shared byte for byte with lunar-laya, lunar-mpc and lunar-mpc-laya.
// Coordinates are in units of RADIUS/8 with y pointing down, so the footpads sit
// exactly RADIUS below the hull centre and rest on the surface at touchdown.
const HULL = [[-6, -7], [-4, -9], [4, -9], [6, -7], [6, 1], [4, 3], [-4, 3], [-6, 1]];
const NOZZLE = [[-1.7, 3], [1.7, 3], [1.1, 5.2], [-1.1, 5.2]];
const STRUTS = [[-4, 3, -7.2, 8], [4, 3, 7.2, 8]];
const PADS_ART = [[-8.6, 8, -5.8, 8], [5.8, 8, 8.6, 8]];

function drawLander(ctx, u, { body = "#d6e6de", trim = "#f0f5eb", glass = "#3a6265", flip = 1 } = {}) {
  const path = points => {
    ctx.beginPath();
    points.forEach(([x, y], i) => i ? ctx.lineTo(x * u, y * u * flip) : ctx.moveTo(x * u, y * u * flip));
    ctx.closePath();
  };
  ctx.lineJoin = "miter";
  path(NOZZLE); ctx.fillStyle = glass; ctx.fill();
  path(HULL); ctx.fillStyle = body; ctx.fill();
  ctx.strokeStyle = trim; ctx.lineWidth = Math.max(0.8, 0.35 * u); ctx.stroke();
  ctx.fillStyle = glass; ctx.fillRect(-2.2 * u, (flip > 0 ? -6.4 : 2) * u, 4.4 * u, 4.4 * u);
  ctx.strokeStyle = trim; ctx.lineWidth = Math.max(0.7, 0.25 * u);
  ctx.beginPath();
  ctx.moveTo(-6 * u, -1.2 * u * flip); ctx.lineTo(6 * u, -1.2 * u * flip);
  for (const [x0, y0, x1, y1] of STRUTS) { ctx.moveTo(x0 * u, y0 * u * flip); ctx.lineTo(x1 * u, y1 * u * flip); }
  ctx.stroke();
  ctx.lineWidth = Math.max(1.2, 0.5 * u); ctx.lineCap = 'butt';
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of PADS_ART) { ctx.moveTo(x0 * u, y0 * u * flip); ctx.lineTo(x1 * u, y1 * u * flip); }
  ctx.stroke();
}

// A stage is 0.2 s; drawing only at stage ends animates at 5 fps. Blend the end state
// back into the start state by the fraction of the stage the wall clock has covered.
function pose(before, after, blend) {
  if (before.status !== "flying") return before;
  const t = Math.max(0, Math.min(1, blend)), spin = wrap(after.angle - before.angle);
  return {...before, x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t,
    angle: before.angle + spin * t};
}

function draw(s, decision, end) {
  const W = canvas.width, H = canvas.height, scale = W / 1100;
  const px = x => 50 * scale + x * scale;
  const py = y => H - 38 * scale - y * (H - 58 * scale) / 750;
  ctx.fillStyle = "#070e17"; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 100; i++) {
    ctx.fillStyle = i % 7 ? "#263847" : "#687e8c";
    ctx.fillRect((i * 173 + 19) % W, (i * 79 + 31) % (H - 100), 1.4, 1.4);
  }
  ctx.strokeStyle = "#142333"; ctx.lineWidth = 1;
  for (let x = 0; x <= 1000; x += 100) { ctx.beginPath(); ctx.moveTo(px(x), 0); ctx.lineTo(px(x), H - 38); ctx.stroke(); }
  for (let y = 100; y <= 700; y += 100) {
    ctx.beginPath(); ctx.moveTo(px(0), py(y)); ctx.lineTo(px(1000), py(y)); ctx.stroke();
    ctx.fillStyle = "#3b5366"; ctx.font = "10px monospace"; ctx.fillText(String(y), 13, py(y) + 3);
  }
  const line = (points, color, width) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
    points.forEach(([x, y], i) => i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y)));
    ctx.stroke();
  };
  line(run.frames.map(f => [f.before.x, f.before.y]).concat([[s.x, s.y]]), "#316459", 1.5);
  ctx.beginPath(); ctx.moveTo(px(0), H);
  TERRAIN.forEach(([x, y]) => ctx.lineTo(px(x), py(y)));
  ctx.lineTo(px(1000), H); ctx.closePath(); ctx.fillStyle = "#14212d"; ctx.fill();
  line(TERRAIN, "#7b929e", 1.5);
  PADS.forEach((p, i) => {
    const selected = i === run.game.target;
    line([[p[0], p[2]], [p[1], p[2]]], selected ? "#90edd0" : "#678397", selected ? 4 : 2);
    ctx.font = "11px monospace"; ctx.fillStyle = selected ? "#90edd0" : "#6d8596";
    ctx.fillText(`0${i + 1} / ${p[3]}×`, px(p[0]), py(p[2]) + 22);
  });
  const x = px(s.x), y = py(s.y);
  ctx.strokeStyle = "#244c46"; ctx.setLineDash([3, 7]); ctx.beginPath();
  ctx.moveTo(x, y + 24); ctx.lineTo(x, py(ground(s.x))); ctx.stroke(); ctx.setLineDash([]);
  ctx.save(); ctx.translate(x, y); ctx.rotate(s.angle * Math.PI / 180);
  const u = (H - 58 * scale) / 750;
  if (!end && decision && s.fuel > 0 && decision.executed.throttle > 0) {
    const reach = (6 + 11 * decision.executed.throttle + Math.random()) * u;
    ctx.beginPath(); ctx.moveTo(-1.5 * u, 5 * u); ctx.lineTo(1.5 * u, 5 * u); ctx.lineTo(0, 5 * u + reach); ctx.closePath();
    ctx.fillStyle = "#edbf7f"; ctx.fill();
  }
  const wrecked = s.status === "crashed" || s.status === "out_of_bounds";
  drawLander(ctx, u, wrecked ? {body: "#8a5f4b", trim: "#e7ac83", glass: "#4b2f24"} : {body: "#c8ded4", trim: "#d9fff0", glass: "#24424c"});
  ctx.restore();
  ctx.fillStyle = "#829eab"; ctx.font = "10px monospace";
  ctx.fillText("LUNAR SURFACE / LIVE OLLAMA DECISIONS", 24, H - 12);
}

// Show the chosen start (position, drift, tilt, pad) before launch; ignored mid-flight.
function preview() {
  if (run.abort) return;
  run.game = new Game(Number($("seed").value), Number($("pad").value));
  run.frames = []; run.frame = null;
  render();
}
$("seed").oninput = $("pad").onchange = preview;
$("random").onclick = () => { $("seed").value = Math.floor(Math.random() * 100000); preview(); };
$("launch").onclick = launch;
$("pilot").onchange = () => { $("pilot-description").textContent = DESCRIPTIONS[$("pilot").value]; };
$("pilot").onchange();
loadModels();
preview();

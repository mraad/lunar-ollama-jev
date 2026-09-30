"use strict";
// Arcade lunar physics and PD guidance, ported line for line from lunar-laya's
// game.py and pilot.py so the two projects fly the same world. Loaded by the
// browser as a plain script and by check.cjs through module.exports.

const GRAVITY = 1.62, THRUST = 5.0, TURN_RATE = 30.0, DT = 0.02, CONTROL_STEPS = 10, RADIUS = 8.0;
const TERRAIN = [[0, 85], [80, 120], [150, 30], [240, 30], [300, 105], [370, 70], [440, 20], [560, 20],
  [640, 100], [720, 55], [775, 40], [825, 40], [900, 130], [1000, 90]];
const PADS = [[150, 240, 30, 2], [440, 560, 20, 1], [775, 825, 40, 4]];

const QUESTIONS = {
  rotation: {
    type: "choice",
    instructions: "Control lunar lander tilt. Follow the requested tilt correction.",
    criteria: {left: "Decrease tilt angle", hold: "Keep current tilt", right: "Increase tilt angle"},
  },
  engine: {
    type: "choice",
    instructions: "Control lunar lander engine. Follow the requested engine power.",
    criteria: {off: "Zero thrust", half: "Half thrust", full: "Full thrust"},
  },
};
const TURNS = {left: -1, hold: 0, right: 1};
const THROTTLES = {off: 0, half: 0.5, full: 1};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = a => ((a + 180) % 360 + 360) % 360 - 180; // Python's non-negative modulo

function ground(x) {
  x = clamp(x, 0, 1000);
  for (let i = 1; i < TERRAIN.length; i++) {
    const [x0, y0] = TERRAIN[i - 1], [x1, y1] = TERRAIN[i];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return TERRAIN.at(-1)[1];
}

// mulberry32: seeds are reproducible here but are not lunar-laya's Python seeds.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Game {
  constructor(seed = 0, target = 1) {
    this.seed = seed; this.target = target;
    const r = rng(seed), u = (lo, hi) => lo + (hi - lo) * r();
    // Start anywhere over the map, not near the target pad as lunar-laya does,
    // so the pad choice and the start are independent knobs.
    this.state = {x: u(100, 900), y: 450, vx: u(-8, 8), vy: -8, angle: u(-12, 12),
      fuel: 100, time: 0, status: "flying", score: 0};
  }

  snapshot() { return {...this.state}; }

  surfaceHeight() {
    const x = this.state.x;
    return Math.max(ground(x - RADIUS), ground(x + RADIUS),
      ...TERRAIN.filter(([px]) => x - RADIUS <= px && px <= x + RADIUS).map(p => p[1]));
  }

  // Advance at most 0.2 simulation seconds; terminal states are absorbing.
  step({turn, throttle}) {
    const s = this.state;
    for (let i = 0; i < CONTROL_STEPS && s.status === "flying"; i++) {
      const cost = (throttle * 0.65 + Math.abs(turn) * 0.04) * DT;
      const fraction = cost ? Math.min(1, s.fuel / cost) : 1;
      s.fuel = Math.max(0, s.fuel - cost);
      s.angle = wrap(s.angle + turn * TURN_RATE * DT * fraction);
      const thrust = throttle * THRUST * fraction, rad = s.angle * Math.PI / 180;
      s.vx += Math.sin(rad) * thrust * DT;
      s.vy += (Math.cos(rad) * thrust - GRAVITY) * DT;
      s.x += s.vx * DT;
      s.y += s.vy * DT;
      s.time += DT;
      if (s.x < RADIUS || s.x > 1000 - RADIUS || s.y > 750) {
        s.status = "out_of_bounds";
      } else if (s.y - RADIUS <= this.surfaceHeight()) {
        const pad = PADS.find(p => p[0] + RADIUS <= s.x && s.x <= p[1] - RADIUS);
        const safe = pad && Math.abs(s.vx) <= 2 && -3 <= s.vy && s.vy <= 0 && Math.abs(s.angle) <= 8;
        s.status = safe ? "landed" : "crashed";
        s.score = safe ? 50 * pad[3] : 0;
      } else if (s.time >= 180) {
        s.status = "timeout";
      }
    }
    return this.snapshot();
  }
}

// PD navigation: a desired tilt and vertical acceleration, then the nearest discrete command.
function guidance(game) {
  const s = game.state, pad = PADS[game.target];
  const dx = (pad[0] + pad[1]) / 2 - s.x;
  const altitude = Math.max(0, s.y - pad[2] - RADIUS);
  const desiredVx = clamp(dx * 0.15, -10, 10);
  const ax = clamp((desiredVx - s.vx) * 0.65, -1.8, 1.8);
  let desiredVy = -Math.min(12, Math.max(0.7, altitude * 0.12));
  if (Math.abs(dx) > 35 && altitude < 120) desiredVy = Math.max(desiredVy, (120 - altitude) * 0.15);
  const ay = GRAVITY + (desiredVy - s.vy) * 0.8;
  const desiredAngle = clamp(Math.atan2(ax, Math.max(0.8, ay)) * 180 / Math.PI, -30, 30);
  const error = desiredAngle - s.angle;
  const turn = error > 3 ? 1 : error < -3 ? -1 : 0;
  const power = clamp(ay / (THRUST * Math.max(0.5, Math.cos(s.angle * Math.PI / 180))), 0, 1);
  const throttle = power < 0.25 ? 0 : power < 0.75 ? 0.5 : 1;
  return {command: {turn, throttle},
    metrics: {target_dx: dx, altitude, desired_angle: desiredAngle, desired_vy: desiredVy}};
}

const name = (table, value) => Object.keys(table).find(k => table[k] === value);

function observation(game, requested, m) {
  const s = game.state;
  return `Lunar landing. Requested tilt correction: ${name(TURNS, requested.turn)}. ` +
    `Requested engine power: ${name(THROTTLES, requested.throttle)}. ` +
    `Altitude ${m.altitude.toFixed(1)} m. Pad offset ${m.target_dx.toFixed(1)} m. ` +
    `Horizontal velocity ${s.vx.toFixed(1)} m/s. Vertical velocity ${s.vy.toFixed(1)} m/s. ` +
    `Tilt ${s.angle.toFixed(1)} degrees; desired ${m.desired_angle.toFixed(1)}. ` +
    `Desired vertical velocity ${m.desired_vy.toFixed(1)} m/s. Fuel ${s.fuel.toFixed(1)}. ` +
    "Positive x is right, positive y is up, positive tilt is right. " +
    "Land upright with horizontal speed <=2 and downward speed <=3 m/s.";
}

// One request to Ollama's Jev-style endpoint: state text in, typed answers out.
async function askJev(host, model, state, signal) {
  const response = await fetch(`${host}/v1/systemone`, {method: "POST", signal,
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({model, state, questions: QUESTIONS})});
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const {answers} = await response.json();
  for (const q of Object.keys(QUESTIONS)) {
    if (!(answers?.[q]?.choice in QUESTIONS[q].criteria)) throw new Error(`Malformed answer for "${q}"`);
  }
  return answers;
}

// Same contract as lunar-laya's Pilot.decide: baseline flies guidance, jev flies the
// model, assisted flies the model unless it disagrees with guidance.
async function decide(game, {mode, host, model, signal}) {
  const start = performance.now();
  const {command: reference, metrics} = guidance(game);
  const prompt = observation(game, reference, metrics);
  let answers = null, proposed = reference;
  if (mode !== "baseline") {
    answers = await askJev(host, model, prompt, signal);
    proposed = {turn: TURNS[answers.rotation.choice], throttle: THROTTLES[answers.engine.choice]};
  }
  const intervened = mode === "assisted" && (proposed.turn !== reference.turn || proposed.throttle !== reference.throttle);
  const executed = intervened ? reference : proposed;
  return {command: executed, decision: {proposed, executed, intervened, answers, guidance: metrics, prompt,
    latency_ms: performance.now() - start}};
}

// Installed models that answer /v1/systemone, smallest first: the small one is the
// one that keeps up with 1x playback.
async function decisionModels(host) {
  const {models} = await (await fetch(`${host}/api/tags`)).json();
  return models.filter(m => m.capabilities?.includes("decision")).sort((a, b) => a.size - b.size);
}

// One flight as a stream of schema-1 frames. Decision N+1 is requested before frame N
// is yielded, so a consumer that animates frame N hides model latency under one stage.
async function* fly(game, opts, max = 900) {
  let before = game.snapshot(), next = decide(game, opts);
  while (game.state.status === "flying" && max-- > 0) {
    const {command, decision} = await next;
    opts.signal?.throwIfAborted(); // baseline never fetches, so the signal is checked here too
    const after = game.step(command);
    if (game.state.status === "flying") { next = decide(game, opts); next.catch(() => {}); }
    yield {before, decision, after};
    before = after;
  }
}

if (typeof module !== "undefined") module.exports = {Game, fly, decisionModels, QUESTIONS};

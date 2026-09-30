// One runnable check: physics/guidance parity with lunar-laya (when the sibling
// checkout exists), the baseline landing every seed, and one live assisted flight
// against Ollama (when it is running). `node check.cjs`
const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const sim = require("./sim.js");

const PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
from lunar_laya.game import Game, State
from lunar_laya.pilot import Pilot
job = json.load(sys.stdin)
game = Game(0, job["target"]); game.state = State(**job["state"]); pilot = Pilot("baseline")
frames = []
while game.state.status == "flying" and len(frames) < 900:
    command, decision = pilot.decide(game)
    frames.append({"prompt": decision["prompt"], "after": game.step(command)})
print(json.dumps(frames))`;

async function fly(game, opts) {
  const frames = [];
  for await (const f of sim.fly(game, opts)) frames.push(f);
  return frames;
}

async function main() {
  // 1. Every baseline flight lands on every pad, as lunar-laya's baseline does.
  for (let seed = 0; seed < 10; seed++) for (const target of [0, 1, 2]) {
    const game = new sim.Game(seed, target);
    await fly(game, {mode: "baseline"});
    assert.equal(game.state.status, "landed", `baseline seed ${seed} pad ${target} ended ${game.state.status}`);
  }
  console.log("ok  baseline lands 30/30");

  // 2. Same start state, same prompts and same states as the Python original.
  const sibling = path.join(__dirname, "..", "lunar-laya");
  if (fs.existsSync(path.join(sibling, "lunar_laya", "game.py"))) {
    for (const seed of [0, 1, 2]) {
      const game = new sim.Game(seed, seed);
      const start = game.snapshot();
      const py = spawnSync("python3", ["-c", PY, sibling], {input: JSON.stringify({state: start, target: seed}), encoding: "utf8"});
      assert.equal(py.status, 0, py.stderr);
      const expected = JSON.parse(py.stdout), actual = await fly(game, {mode: "baseline"});
      assert.equal(actual.length, expected.length, "frame count");
      actual.forEach((f, i) => {
        assert.equal(f.decision.prompt, expected[i].prompt, `prompt at frame ${i}`);
        for (const k of ["x", "y", "vx", "vy", "angle", "fuel", "time"]) {
          assert.ok(Math.abs(f.after[k] - expected[i].after[k]) < 1e-9, `${k} at frame ${i}`);
        }
        assert.equal(f.after.status, expected[i].after.status);
      });
    }
    console.log("ok  physics, guidance and prompt match lunar-laya (3 flights)");
  } else {
    console.log("skip lunar-laya sibling not found; parity check not run");
  }

  // 3. One live assisted flight through Ollama.
  const raw = process.env.OLLAMA_HOST || "localhost:11434";
  const host = (/^https?:\/\//.test(raw) ? raw : `http://${raw}`).replace("0.0.0.0", "localhost");
  let models;
  try { models = await sim.decisionModels(host); } catch { console.log(`skip Ollama not reachable at ${host}`); return; }
  if (!models.length) { console.log("skip no decision model installed (ollama pull tev1:0.8b)"); return; }
  const model = process.env.JEV_MODEL || models[0].name;
  const game = new sim.Game(0, 1);
  const frames = await fly(game, {mode: "assisted", host, model});
  for (const f of frames) for (const q of Object.keys(sim.QUESTIONS)) {
    const p = f.decision.answers[q].probabilities;
    assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 1e-3, `${q} probabilities sum to 1`);
  }
  const times = frames.map(f => f.decision.latency_ms).sort((a, b) => a - b);
  const overrides = frames.filter(f => f.decision.intervened).length;
  assert.equal(game.state.status, "landed");
  console.log(`ok  live assisted flight with ${model}: landed, ${overrides}/${frames.length} overrides, p50 ${times[times.length >> 1].toFixed(0)} ms`);
}

main().catch(error => { console.error(error); process.exit(1); });

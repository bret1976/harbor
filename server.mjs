import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3340;
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const LOCAL_ENGINE = process.platform === "darwin";
const DATA = path.join(ROOT, "data");
const STATE_PATH = path.join(DATA, "state.json");
const PUBLIC = path.join(ROOT, "public");
const VIDEO_ROOT = path.join(ROOT, "models/FastMetal-1.3B-QAD");
const IMAGE_ROOT = path.join(ROOT, "models/sd-turbo");
const PY = path.join(ROOT, "engine/.venv/bin/python");
const VIDEO_SCRIPT = path.join(
  ROOT,
  "engine/FastVideo/examples/inference/basic/mlx_wan_prompt_to_video.py",
);

const COASTAL_IDEA = [
  "A young girl walks through a quiet coastal village at sunrise.",
  "She carries a small blue umbrella and walks beside a narrow stone path surrounded by wildflowers.",
  "Warm sunlight passes through the morning mist. Small birds fly between the rooftops.",
  "Laundry moves gently in the ocean breeze, and distant waves show beyond the houses.",
  "She notices a tiny glowing creature hiding beneath an old wooden bridge.",
  "She stops, slowly kneels, and reaches toward it with a curious smile.",
  "The creature grows brighter and floats into the air, leaving tiny golden particles around them.",
].join(" ");

function seedState() {
  return {
    rev: 1,
    characters: [],
    stories: [
      {
        id: "coastal-morning",
        title: "Coastal morning",
        world:
          "A quiet coastal village at sunrise. Narrow stone path, wildflowers, morning mist, ocean breeze, laundry on lines, distant waves, an old wooden bridge.",
        characterId: "",
        style: "painted",
        scenes: [
          {
            id: "scene-bridge",
            title: "The bridge",
            idea: COASTAL_IDEA,
            prompt: "",
            galleryId: "",
          },
        ],
      },
    ],
    gallery: [],
    jobs: [],
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    const state = seedState();
    saveState(state);
    return state;
  }
}

function saveState(state) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

let state = loadState();
let active = null;

function pidAlive(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return pid;
  } catch {
    return false;
  }
}

function tailFile(file, lines = 24) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function freeBytes() {
  const s = fs.statfsSync("/");
  return Number(s.bavail) * Number(s.bsize);
}

function fileBig(file, minBytes) {
  try {
    return fs.statSync(file).size >= minBytes;
  } catch {
    return false;
  }
}

function textEncoderShards() {
  const indexPath = path.join(VIDEO_ROOT, "text_encoder/model.safetensors.index.json");
  if (!fileBig(indexPath, 100)) return [];
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const names = [...new Set(Object.values(index.weight_map || {}))];
  return names.map((name) => path.join(VIDEO_ROOT, "text_encoder", path.basename(name)));
}

function videoReady() {
  const shards = textEncoderShards();
  return (
    fileBig(path.join(VIDEO_ROOT, "mlx_dit.safetensors"), 1_000_000_000) &&
    fileBig(path.join(VIDEO_ROOT, "vae/diffusion_pytorch_model.safetensors"), 100_000_000) &&
    shards.length >= 5 &&
    shards.every((file) => fileBig(file, 1_000_000_000)) &&
    fs.existsSync(PY) &&
    fs.existsSync(path.join(DATA, "smoke-ok"))
  );
}

function imageReady() {
  return (
    fs.existsSync(path.join(IMAGE_ROOT, "unet/diffusion_pytorch_model.fp16.safetensors")) &&
    fs.existsSync(PY) &&
    fs.existsSync(path.join(DATA, "smoke-ok"))
  );
}

function installText() {
  try {
    return fs.readFileSync(path.join(DATA, "install.log"), "utf8");
  } catch {
    return "";
  }
}

function folderBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else total += fs.statSync(full).size;
    }
  }
  return total;
}

function latestRun(full) {
  const at = full.lastIndexOf("=== start ");
  return at >= 0 ? full.slice(at) : full;
}

function progressLine() {
  const shards = textEncoderShards();
  const done = shards.filter((file) => fileBig(file, 1_000_000_000)).length;
  const gb = Math.round((folderBytes(VIDEO_ROOT) / 1e9) * 10) / 10;
  let current = "";
  try {
    const incompletes = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".incomplete")) {
          const size = fs.statSync(full).size;
          if (size > 1_000_000) incompletes.push({ full, size });
        }
      }
    };
    walk(path.join(VIDEO_ROOT, ".cache"));
    incompletes.sort((a, b) => b.size - a.size);
    if (incompletes[0]) {
      const part = incompletes[0].full.includes(`${path.sep}text_encoder${path.sep}`)
        ? "text encoder"
        : "video weights";
      current = `${part} file ${Math.round(incompletes[0].size / 1e9 * 10) / 10} GB`;
    }
  } catch {
    current = "";
  }
  const shardNote = shards.length ? `${done} of ${shards.length} text-encoder parts saved` : "text-encoder parts not saved yet";
  return `Downloading Coast Video: ${gb} GB of 13.4 GB. ${shardNote}.${current ? ` Now: ${current}.` : ""}`;
}

function presetView() {
  if (!LOCAL_ENGINE) {
    return {
      installing: false,
      localEngine: false,
      log: "The models run on the Mac. This hosted copy is the studio: prompts, characters, and stories.",
      freeGb: Math.round((freeBytes() / 1024 ** 3) * 10) / 10,
      downloadGb: 0,
      totalGb: 13.4,
      presets: [
        {
          id: "coast-video",
          name: "Coast Video",
          media: "video",
          status: "mac",
          blurb: "Local cinematic clips. Installed on the Mac, not on this host.",
          size: "12.5 GB",
        },
        {
          id: "still-image",
          name: "Still Image",
          media: "image",
          status: "mac",
          blurb: "Local stills. Installed on the Mac, not on this host.",
          size: "about 2 GB",
        },
      ],
    };
  }
  const installing = Boolean(pidAlive(path.join(DATA, "install.pid")));
  const full = installText();
  const run = latestRun(full);
  const log = [progressLine(), ...run.replace(/\r/g, "\n").trim().split("\n").slice(-8)].join("\n");
  const failed = /FAILED_SETUP/.test(run) && !installing;
  const video = videoReady()
    ? "ready"
    : installing
      ? "installing"
      : failed
        ? "error"
        : "idle";
  let image = imageReady() ? "ready" : "idle";
  if (!imageReady()) {
    if (installing && video === "ready") image = "installing";
    else if (installing && video === "installing") image = "waiting";
    else if (/IMAGE_SKIPPED/.test(full)) image = "skipped";
    else if (failed) image = "error";
  }
  return {
    installing,
    localEngine: LOCAL_ENGINE,
    log,
    freeGb: Math.round((freeBytes() / 1024 ** 3) * 10) / 10,
    downloadGb: Math.round((folderBytes(VIDEO_ROOT) / 1e9) * 10) / 10,
    totalGb: 13.4,
    presets: [
      {
        id: "coast-video",
        name: "Coast Video",
        media: "video",
        status: video,
        blurb:
          "Local cinematic clips, about 5 seconds at 480p. This is the video preset that fits this Mac.",
        size: "12.5 GB",
      },
      {
        id: "still-image",
        name: "Still Image",
        media: "image",
        status: image,
        blurb: "Local stills in a few seconds. Used for frames and for trying a character in a scene.",
        size: "about 2 GB",
      },
    ],
  };
}

function ensureInstall() {
  if (videoReady() && imageReady()) return;
  if (pidAlive(path.join(DATA, "install.pid"))) return;
  const log = installText();
  if (/FAILED_SETUP/.test(latestRun(installText())) && !process.env.HARBOR_RETRY_INSTALL) return;
  const child = spawn("bash", [path.join(ROOT, "engine/setup.sh")], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function publicState() {
  const install = presetView();
  return {
    rev: state.rev,
    characters: state.characters,
    stories: state.stories,
    gallery: state.gallery,
    job: active
      ? {
          id: active.id,
          status: active.status,
          media: active.media,
          log: active.log.split("\n").slice(-12).join("\n"),
          error: active.error || "",
        }
      : null,
    install,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 12_000_000) {
        reject(new Error("Upload is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Could not read that request."));
      }
    });
    req.on("error", reject);
  });
}

function send(res, code, body, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function savePortrait(id, dataUrl) {
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(dataUrl || "");
  if (!match) return "";
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const file = `${id}.${ext}`;
  fs.mkdirSync(path.join(DATA, "characters"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "characters", file), Buffer.from(match[2], "base64"));
  return file;
}

function characterLock(character, prompt) {
  if (!character) return prompt;
  const appearance = (character.appearance || "").trim();
  const lock = appearance
    ? `The character is ${character.name}. Keep this exact person: ${appearance}.`
    : `The character is ${character.name}. Keep the same face, hair, and clothing.`;
  return `${lock}\n${prompt}`.trim();
}

function videoSize(aspect) {
  if (aspect === "9:16") return { height: 832, width: 480 };
  return { height: 480, width: 832 };
}

function imageSize(aspect) {
  if (aspect === "9:16" || aspect === "2:3") return { width: 512, height: 768 };
  if (aspect === "1:1") return { width: 512, height: 512 };
  return { width: 768, height: 512 };
}

function finishJob(code) {
  if (!active) return;
  const job = active;
  active = null;
  const file = path.join(DATA, "gallery", job.file);
  if (code === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000) {
    job.status = "done";
    const item = {
      id: job.id,
      media: job.media,
      prompt: job.prompt,
      preset: job.preset,
      characterId: job.characterId || "",
      aspect: job.aspect,
      file: job.file,
      stillFile: job.stillFile && fs.existsSync(path.join(DATA, "gallery", job.stillFile)) ? job.stillFile : "",
      createdAt: new Date().toISOString(),
      storyId: job.storyId || "",
      sceneId: job.sceneId || "",
    };
    if (job.proof) fs.writeFileSync(path.join(DATA, `proof-${job.proof}.ok`), item.file);
    state.gallery.unshift(item);
    if (job.storyId && job.sceneId) {
      const story = state.stories.find((s) => s.id === job.storyId);
      const scene = story?.scenes.find((s) => s.id === job.sceneId);
      if (scene) {
        scene.galleryId = job.id;
        scene.prompt = job.prompt;
      }
    }
    state.jobs.unshift({ id: job.id, status: "done", media: job.media, at: item.createdAt });
  } else {
    job.status = "error";
    job.error = job.error || `Generation stopped (code ${code}).`;
    fs.mkdirSync(path.join(DATA, "jobs"), { recursive: true });
    fs.writeFileSync(path.join(DATA, "jobs", `${job.id}.log`), `${job.error}\n${job.log || ""}`);
    if (job.proof) fs.writeFileSync(path.join(DATA, `proof-${job.proof}.fail`), job.error);
    state.jobs.unshift({ id: job.id, status: "error", media: job.media, at: new Date().toISOString() });
  }
  state.rev += 1;
  saveState(state);
}

function startJob(input) {
  if (active) {
    const error = new Error("A generation is already running.");
    error.status = 409;
    throw error;
  }
  const media = input.media === "image" ? "image" : "video";
  const prompt = String(input.prompt || "").trim();
  if (!prompt) {
    const error = new Error("Write a prompt first.");
    error.status = 400;
    throw error;
  }
  if (!LOCAL_ENGINE) {
    const error = new Error("Image and video generation run on the Mac, where the models are installed. This hosted copy is the studio.");
    error.status = 409;
    throw error;
  }
  if (media === "video" && !videoReady()) {
    const error = new Error("Coast Video is still installing. Watch it under Presets.");
    error.status = 409;
    throw error;
  }
  if (media === "image" && !imageReady()) {
    const error = new Error("Still Image is still installing. Watch it under Presets.");
    error.status = 409;
    throw error;
  }

  const character = state.characters.find((c) => c.id === input.characterId) || null;
  const finalPrompt = characterLock(character, prompt).slice(0, 1800);
  const portrait = character?.file
    ? path.join(DATA, "characters", path.basename(character.file))
    : "";
  const id = crypto.randomBytes(8).toString("hex");
  const aspect = String(input.aspect || "16:9");
  const pace = input.pace === "fine" || input.pace === "standard" ? input.pace : "quick";
  const seed = Number.isFinite(Number(input.seed)) && String(input.seed).trim() !== ""
    ? Number(input.seed)
    : crypto.randomInt(1, 2_000_000_000);
  const ext = media === "video" ? "mp4" : "png";
  const file = `${id}.${ext}`;
  const out = path.join(DATA, "gallery", file);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const env = {
    ...process.env,
    PYTHONPATH: path.join(ROOT, "engine/FastVideo"),
    PYTHONUNBUFFERED: "1",
    HF_HOME: path.join(ROOT, "models/hf-home"),
    HF_HUB_DISABLE_TELEMETRY: "1",
    PYTORCH_ENABLE_MPS_FALLBACK: "1",
  };

  let args;
  if (media === "video") {
    const { height, width } = videoSize(aspect);
    const frames = Number(input.seconds) <= 3 ? 49 : 81;
    args = [
      VIDEO_SCRIPT,
      "--model-root", VIDEO_ROOT,
      "--mlx-checkpoint", VIDEO_ROOT,
      "--prompt", finalPrompt,
      "--output-path", out,
      "--height", String(height),
      "--width", String(width),
      "--num-frames", String(frames),
      "--fps", "16",
      "--seed", String(seed),
      "--mlx-memory-limit-gib", "5",
      "--torch-device", "cpu",
      "--prompt-encode-mode", "subprocess",
      "--text-encoder-dtype", "fp16",
      "--torch-mps-high-watermark-ratio", "0.0",
      "--metrics-json", path.join(DATA, "gallery", `${id}.json`),
    ];
    if (pace === "quick") args.push("--fast", "--fast-spatial");
    else if (pace === "standard") args.push("--fast");
  } else {
    const { width, height } = imageSize(aspect);
    args = [
      path.join(ROOT, "engine/image_gen.py"),
      "--model", IMAGE_ROOT,
      "--prompt", finalPrompt,
      "--negative", String(input.negative || "blurry, watermark, text, extra fingers"),
      "--output", out,
      "--width", String(width),
      "--height", String(height),
      "--steps", "2",
      "--seed", String(seed),
    ];
    if (portrait && fs.existsSync(portrait) && input.usePortrait !== false) {
      args.push("--init-image", portrait, "--strength", "0.72");
    }
  }

  const stillFile = media === "video" && portrait && fs.existsSync(portrait) && imageReady()
    ? `${id}-still.png`
    : "";
  const stillArgs = stillFile
    ? [
        path.join(ROOT, "engine/image_gen.py"),
        "--model", IMAGE_ROOT,
        "--prompt", finalPrompt,
        "--negative", "blurry, watermark, text, extra fingers",
        "--output", path.join(DATA, "gallery", stillFile),
        "--width", String(imageSize(aspect).width),
        "--height", String(imageSize(aspect).height),
        "--steps", "4",
        "--seed", String(seed),
        "--init-image", portrait,
        "--strength", "0.72",
      ]
    : null;

  const job = {
    id,
    status: "running",
    media,
    prompt: finalPrompt,
    preset: media === "video" ? "coast-video" : "still-image",
    characterId: character?.id || "",
    aspect,
    pace,
    seed,
    file,
    storyId: input.storyId || "",
    sceneId: input.sceneId || "",
    stillFile,
    proof: input.proof || "",
    log: stillFile
      ? "Making a scene still from the character photo, then the clip…\n"
      : "Starting on this Mac…\n",
    error: "",
    child: null,
  };
  active = job;
  const append = (buf) => {
    job.log = (job.log + buf.toString("utf8")).slice(-8000);
    const text = buf.toString("utf8");
    if (/Error|Traceback|FAILED|OutOfMemory|OOM/i.test(text)) job.error = text.trim().split("\n").slice(-4).join(" ");
  };
  function launch(commandArgs, onExit) {
    const child = spawn(PY, commandArgs, { cwd: ROOT, env, detached: true });
    job.child = child;
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      job.error = err.message;
      finishJob(1);
    });
    child.on("exit", (code) => onExit(code ?? 1));
  }
  if (stillArgs) {
    launch(stillArgs, (code) => {
      if (code !== 0) job.log += "Scene still did not finish. Starting the clip.\n";
      launch(args, (videoCode) => finishJob(videoCode));
    });
  } else {
    launch(args, (code) => finishJob(code));
  }
  state.rev += 1;
  saveState(state);
  return { id, status: "running" };
}

function stopJob() {
  if (!active?.child?.pid) return false;
  try {
    process.kill(-active.child.pid, "SIGTERM");
  } catch {
    active.child.kill("SIGTERM");
  }
  return true;
}

function contentType(file) {
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function safeFile(root, name) {
  const base = path.basename(name || "");
  if (!base || base !== name) return "";
  const full = path.join(root, base);
  if (!full.startsWith(root)) return "";
  return fs.existsSync(full) ? full : "";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(res, 200, publicState());
    }
    if (req.method === "POST" && url.pathname === "/api/install") {
      fs.rmSync(path.join(DATA, "install.pid"), { force: true });
      const log = path.join(DATA, "install.log");
      if (fs.existsSync(log)) fs.writeFileSync(log, "");
      process.env.HARBOR_RETRY_INSTALL = "1";
      ensureInstall();
      return send(res, 202, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body = await readBody(req);
      return send(res, 202, startJob(body));
    }
    if (req.method === "POST" && url.pathname === "/api/cancel") {
      return send(res, 200, { ok: stopJob() });
    }
    if (req.method === "POST" && url.pathname === "/api/characters") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const appearance = String(body.appearance || "").trim();
      if (!name || !appearance) {
        return send(res, 400, { error: "A character needs a name and a short description of how they look." });
      }
      const id = crypto.randomBytes(6).toString("hex");
      const file = body.portrait ? savePortrait(id, body.portrait) : "";
      const character = { id, name, appearance, file, createdAt: new Date().toISOString() };
      state.characters.unshift(character);
      state.rev += 1;
      saveState(state);
      return send(res, 201, character);
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/characters/")) {
      const id = url.pathname.split("/").pop();
      const current = state.characters.find((c) => c.id === id);
      state.characters = state.characters.filter((c) => c.id !== id);
      if (current?.file) fs.rmSync(path.join(DATA, "characters", path.basename(current.file)), { force: true });
      state.rev += 1;
      saveState(state);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/stories") {
      const body = await readBody(req);
      const title = String(body.title || "").trim();
      if (!title) return send(res, 400, { error: "Name the story." });
      const story = {
        id: crypto.randomBytes(6).toString("hex"),
        title,
        world: String(body.world || "").trim(),
        characterId: String(body.characterId || ""),
        style: String(body.style || "painted"),
        scenes: [],
      };
      state.stories.unshift(story);
      state.rev += 1;
      saveState(state);
      return send(res, 201, story);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/stories/") && url.pathname.endsWith("/scenes")) {
      const id = url.pathname.split("/")[3];
      const story = state.stories.find((s) => s.id === id);
      if (!story) return send(res, 404, { error: "Story not found." });
      const body = await readBody(req);
      const scene = {
        id: crypto.randomBytes(6).toString("hex"),
        title: String(body.title || `Scene ${story.scenes.length + 1}`).trim(),
        idea: String(body.idea || "").trim(),
        prompt: String(body.prompt || "").trim(),
        galleryId: "",
      };
      story.scenes.push(scene);
      state.rev += 1;
      saveState(state);
      return send(res, 201, scene);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/stories/") && url.pathname.endsWith("/settings")) {
      const id = url.pathname.split("/")[3];
      const story = state.stories.find((s) => s.id === id);
      if (!story) return send(res, 404, { error: "Story not found." });
      const body = await readBody(req);
      if (typeof body.world === "string") story.world = body.world.trim();
      if (typeof body.characterId === "string") story.characterId = body.characterId;
      if (typeof body.style === "string") story.style = body.style;
      if (typeof body.title === "string" && body.title.trim()) story.title = body.title.trim();
      state.rev += 1;
      saveState(state);
      return send(res, 200, story);
    }
    if (req.method === "GET" && url.pathname.startsWith("/media/gallery/")) {
      const file = safeFile(path.join(DATA, "gallery"), url.pathname.slice("/media/gallery/".length));
      if (!file) return send(res, 404, { error: "Missing file." });
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "GET" && url.pathname.startsWith("/media/characters/")) {
      const file = safeFile(path.join(DATA, "characters"), url.pathname.slice("/media/characters/".length));
      if (!file) return send(res, 404, { error: "Missing portrait." });
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      return fs.createReadStream(file).pipe(res);
    }

    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = safeFile(PUBLIC, rel) || (rel.includes(".") ? "" : safeFile(PUBLIC, "index.html"));
    if (!file) return send(res, 404, { error: "Not found." });
    res.writeHead(200, { "Content-Type": contentType(file) });
    return fs.createReadStream(file).pipe(res);
  } catch (error) {
    return send(res, error.status || 500, { error: error.message || "Something went wrong." });
  }
});

function maybeProve() {
  if (active) return;
  try {
    if (imageReady() && !fs.existsSync(path.join(DATA, "proof-image.ok"))) {
      startJob({
        media: "image",
        prompt: "Hand-painted sunrise over a quiet coastal village, wildflowers beside a stone path, soft mist, no text",
        aspect: "16:9",
        proof: "image",
      });
      return;
    }
    if (videoReady() && !fs.existsSync(path.join(DATA, "proof-video.ok")) && !fs.existsSync(path.join(DATA, "proof-video.fail"))) {
      startJob({
        media: "video",
        prompt: "A young girl with a blue umbrella walks a stone path through a quiet coastal village at sunrise, hand-painted, gentle camera, no text",
        aspect: "16:9",
        seconds: 3,
        pace: "quick",
        proof: "video",
      });
    }
  } catch {
    // A job is already running, or the model is not ready yet.
  }
}

if (LOCAL_ENGINE) {
  ensureInstall();
  setInterval(maybeProve, 20000);
}
server.listen(PORT, HOST, () => {
  console.log(`Harbor http://${HOST}:${PORT}`);
});

const LOOKS = {
  painted: {
    label: "Hand-painted fantasy",
    text: "Hand-painted fantasy animation, soft painterly backgrounds, expressive character animation, magical emotional tone.",
  },
  cinematic: {
    label: "Cinematic live action",
    text: "Cinematic live action, natural skin, shallow depth of field, filmic color, subtle grain.",
  },
  ink: {
    label: "Ink and paper",
    text: "Ink and watercolor on paper, visible brush texture, gentle outlines, storybook framing.",
  },
  dawn: {
    label: "Quiet realism",
    text: "Quiet realistic cinematography, natural movement, restrained color, morning air.",
  },
};

const CAMERAS = {
  gentle: { label: "Gentle move", text: "Gentle camera movement, one continuous shot, no cuts." },
  locked: { label: "Locked frame", text: "Locked-off camera, the action happens inside a still frame." },
  follow: { label: "Following", text: "The camera follows the character at their pace." },
  around: { label: "Slow arc", text: "The camera slowly moves around the character." },
};

const LIGHTS = {
  morning: { label: "Morning mist", text: "Warm morning sunlight through mist, atmospheric depth." },
  golden: { label: "Golden hour", text: "Low golden-hour light, long soft shadows." },
  sunset: { label: "Sunset", text: "Sunset light, warm rim light, deepening color in the trees." },
  overcast: { label: "Soft overcast", text: "Soft overcast light, even skin, muted color." },
};

const MOODS = {
  wonder: { label: "Wonder", text: "A sense of quiet wonder." },
  calm: { label: "Calm", text: "Calm, unhurried, intimate." },
  tense: { label: "Tension", text: "A held breath, something about to change." },
  joy: { label: "Joy", text: "Light, playful, emotionally warm." },
};

const NEXT_BEAT = "She follows the glowing creature through the village toward a hidden forest path. Same girl, same umbrella, same village, the story continuing.";

const main = document.querySelector("#main");
const wizardEl = document.querySelector("#wizard");

let view = "generate";
let state = null;
let form = {
  media: "video",
  prompt: (() => { try { return localStorage.getItem("harbor-prompt") || ""; } catch { return ""; } })(),
  characterId: "",
  aspect: "16:9",
  seconds: 5,
  pace: "quick",
  negative: "blurry, watermark, text, extra fingers",
  seed: "",
  usePortrait: true,
  storyId: "",
  sceneId: "",
};
let stage = { kind: "empty", html: "Your clip shows up here after you generate." };
let wizard = null;
let openStory = "coastal-morning";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function preset(id) {
  return state?.install.presets.find((item) => item.id === id);
}

function ready(media) {
  const id = media === "image" ? "still-image" : "coast-video";
  return preset(id)?.status === "ready";
}

function characterById(id) {
  return state?.characters.find((item) => item.id === id) || null;
}

function clip(text, max = 480) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const stop = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"));
  return stop > 160 ? slice.slice(0, stop + 1) : `${slice.trim()}…`;
}

function buildPrompt(input) {
  const look = LOOKS[input.style] || LOOKS.painted;
  const camera = CAMERAS[input.camera] || CAMERAS.gentle;
  const light = LIGHTS[input.light] || LIGHTS.morning;
  const mood = MOODS[input.mood] || MOODS.wonder;
  const character = characterById(input.characterId);
  const parts = [];
  if (input.previous) {
    parts.push(`This shot continues the previous scene. Same character, same costume, same world, same visual style. Previous moment: ${input.previous}`);
  }
  if (input.world) {
    const world = input.world.trim().replace(/\.+$/, "");
    parts.push(`World: ${world}.`);
  }
  if (character) {
    const appearance = character.appearance.trim().replace(/\.+$/, "");
    parts.push(`The character is ${character.name}. Appearance lock: ${appearance}. Keep this exact person in frame.`);
  }
  parts.push(input.idea.trim());
  parts.push(`${look.text} ${camera.text} ${light.text} ${mood.text}`);
  parts.push(input.media === "image"
    ? "Single still frame, detailed, no text, no watermark."
    : "Natural body movement, detailed environmental motion, cinematic composition. No on-screen text.");
  return parts.filter(Boolean).join(" ");
}

function statusLabel(status) {
  return {
    ready: "Installed",
    installing: "Installing",
    waiting: "Waiting",
    skipped: "Needs disk space",
    error: "Stopped",
    idle: "Not installed",
    mac: "On your Mac",
  }[status] || status;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function refresh() {
  const next = await api("/api/state");
  const jobChanged = state?.job?.id !== next.job?.id || state?.job?.status !== next.job?.status;
  const revChanged = state?.rev !== next.rev;
  state = next;
  document.querySelector("#machine").textContent = next.install.localEngine === false
    ? "Hosted studio"
    : `${next.install.freeGb} GB free on this Mac`;
  document.querySelectorAll("nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  if (view === "generate") updateGenerateLive();
  else if (revChanged || jobChanged || view === "presets") paint();
  if (next.job?.status === "running") {
    stage = { kind: "log", html: esc(next.job.log || "Working…") };
    if (view === "generate") updateGenerateLive();
  }
}

function updateGenerateLive() {
  const status = document.querySelector("#job-status");
  const stageEl = document.querySelector("#stage-body");
  if (!status || !stageEl || !state) return;
  const job = state.job;
  if (job?.status === "running") {
    status.className = "status running";
    status.textContent = job.media === "video"
      ? "Generating on this Mac. The first clip is the slow one, because the model has to load."
      : "Making the still on this Mac.";
    stageEl.innerHTML = `<div class="log">${esc(job.log || "Working…")}</div>`;
  } else if (job?.status === "error") {
    status.className = "status error";
    status.textContent = job.error || "That generation did not finish.";
  } else if (state.install.localEngine === false) {
    status.className = "status";
    status.textContent = "Generate on the Mac app. This hosted copy keeps the studio, not the models.";
  } else if (!ready(form.media)) {
    const item = preset(form.media === "image" ? "still-image" : "coast-video");
    status.className = "status";
    const got = state.install.downloadGb;
    const total = state.install.totalGb;
    const live = (state.install.log || "").split("\n")[0];
    status.textContent = item?.status === "error"
      ? "The model download stopped. Open Presets and choose Install presets."
      : live || (form.media === "video"
        ? `The video model is still downloading${got ? ` (${got} GB of ${total} GB)` : ""}. Your prompt stays in the box.`
        : "The image model is not installed yet. Your prompt stays in the box.");
  } else {
    status.className = "status";
    status.textContent = "";
  }
  const button = document.querySelector("#generate");
  if (button) {
    const hosted = state.install.localEngine === false;
    const installed = ready(form.media);
    button.disabled = hosted || !installed || !form.prompt.trim() || state.job?.status === "running";
    button.textContent = hosted
      ? "Runs on your Mac"
      : state.job?.status === "running"
        ? "Generating…"
        : installed
          ? "Generate on this Mac"
          : "Downloading the video model";
  }
  const cancel = document.querySelector("#cancel");
  if (cancel) cancel.hidden = state.job?.status !== "running";
}

function paint() {
  document.querySelectorAll("nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const views = { generate: renderGenerate, presets: renderPresets, characters: renderCharacters, stories: renderStories, gallery: renderGallery };
  main.innerHTML = views[view]();
  bind();
  if (view === "generate") updateGenerateLive();
}

function renderGenerate() {
  const characters = state.characters.map((item) =>
    `<option value="${esc(item.id)}" ${item.id === form.characterId ? "selected" : ""}>${esc(item.name)}</option>`
  ).join("");
  const character = characterById(form.characterId);
  const latest = state.gallery.find((item) => item.media === form.media);
  let stageHtml = `<div class="empty">${esc(stage.html)}</div>`;
  if (state.job?.status === "running") stageHtml = `<div class="log">${esc(state.job.log || "Working…")}</div>`;
  else if (latest) {
    const src = `/media/gallery/${encodeURIComponent(latest.file)}`;
    stageHtml = latest.media === "video"
      ? `<video src="${src}" controls autoplay loop playsinline></video>`
      : `<img src="${src}" alt="Generated still" />`;
  }
  return `
    <h1>Generate</h1>
    <p class="lead">${state.install.localEngine === false
      ? "This is the hosted studio. Building prompts, characters, and stories works here. Image and video generation run on the Mac, where the models are installed."
      : "Pick image or video, build a full prompt from a simple idea, then run it on this Mac. No credits."}</p>
    <div class="generate">
      <section class="card">
        <div class="choice" id="media">
          <button type="button" data-media="video" class="${form.media === "video" ? "on" : ""}">Video</button>
          <button type="button" data-media="image" class="${form.media === "image" ? "on" : ""}">Image</button>
        </div>
        <label for="prompt">Prompt</label>
        <textarea id="prompt">${esc(form.prompt)}</textarea>
        <div class="actions">
          <button type="button" class="ghost" id="open-wizard">Build prompt</button>
          <button type="button" class="ghost" id="use-coastal">Use the coastal scene</button>
        </div>
        <label for="character">Character</label>
        <select id="character">
          <option value="">No character yet</option>
          ${characters}
        </select>
        <p class="note">${character
          ? (form.media === "video"
            ? `${esc(character.name)} is written into the clip. ${character.file ? "Their photo is also used to make a scene still saved with the clip." : "Add a photo on the Characters page and it will be used for that still."}`
            : `${esc(character.name)}'s portrait is the starting image. The prompt is the new scene.`)
          : "Create a character once, then pick them here for the next scenes."}</p>
        <div class="row">
          <div>
            <label for="aspect">Shape</label>
            <select id="aspect">
              <option value="16:9" ${form.aspect === "16:9" ? "selected" : ""}>Landscape 16:9</option>
              <option value="9:16" ${form.aspect === "9:16" ? "selected" : ""}>Portrait 9:16</option>
              ${form.media === "image" ? `<option value="1:1" ${form.aspect === "1:1" ? "selected" : ""}>Square</option>` : ""}
            </select>
          </div>
          ${form.media === "video" ? `
            <div>
              <label for="seconds">Length</label>
              <select id="seconds">
                <option value="5" ${Number(form.seconds) === 5 ? "selected" : ""}>5 seconds</option>
                <option value="3" ${Number(form.seconds) === 3 ? "selected" : ""}>3 seconds</option>
              </select>
            </div>
            <div>
              <label for="pace">Pace</label>
              <select id="pace">
                <option value="quick" ${form.pace === "quick" ? "selected" : ""}>Quick</option>
                <option value="standard" ${form.pace === "standard" ? "selected" : ""}>Standard</option>
                <option value="fine" ${form.pace === "fine" ? "selected" : ""}>Fine</option>
              </select>
            </div>` : ""}
        </div>
        <label for="seed">Seed, optional</label>
        <input id="seed" type="number" value="${esc(form.seed)}" placeholder="Leave blank for a new variation" />
        <div class="actions">
          <button type="button" class="primary" id="generate">Generate on this Mac</button>
          <button type="button" class="danger" id="cancel" hidden>Stop</button>
        </div>
        <p class="status" id="job-status"></p>
      </section>
      <section class="stage">
        <div id="stage-body">${stageHtml}</div>
      </section>
    </div>`;
}

function renderPresets() {
  const cards = state.install.presets.map((item) => `
    <article class="card preset">
      <span class="pill ${esc(item.status)}">${esc(statusLabel(item.status))}</span>
      <h2>${esc(item.name)}</h2>
      <p class="note">${esc(item.blurb)}</p>
      <p class="note">Download ${esc(item.size)}.</p>
    </article>`).join("");
  const showRetry = state.install.presets.some((item) => item.status === "error" || item.status === "idle" || item.status === "skipped");
  return `
    <h1>Presets</h1>
    <p class="lead">Install a model once. After that, every generation stays on this Mac.</p>
    <div class="card" style="margin-bottom:14px">
      <p class="note">MiniMax H3, the model in that Windows tutorial, does not fit here. Its files are about 42 GB, and this Mac has 16 GB of memory and ${esc(state.install.freeGb)} GB free on the disk. The SimpliGen installer is a Windows program, so it will not open on this Mac either. Coast Video is the local video preset that does fit.</p>
    </div>
    <div class="grid">${cards}</div>
    ${showRetry ? `<div class="actions"><button type="button" class="primary" id="retry-install">Install presets</button></div>` : ""}
    <h2 style="margin-top:22px">Setup log</h2>
    <div class="log">${esc(state.install.log || "Waiting to start.")}</div>`;
}

function renderCharacters() {
  const cards = state.characters.map((item) => `
    <article class="card person">
      ${item.file ? `<img src="/media/characters/${esc(item.file)}" alt="" />` : `<div class="thumb"></div>`}
      <h2>${esc(item.name)}</h2>
      <p class="note">${esc(item.appearance)}</p>
      <button type="button" class="ghost" data-use="${esc(item.id)}">Use in Generate</button>
      <button type="button" class="danger" data-delete="${esc(item.id)}">Remove</button>
    </article>`).join("");
  return `
    <h1>Characters</h1>
    <p class="lead">Create a character once. Pick them on the next scenes so the description stays the same.</p>
    <div class="grid">
      <form class="card" id="character-form">
        <h2>New character</h2>
        <label for="name">Name</label>
        <input id="name" name="name" type="text" placeholder="Mara" required />
        <label for="appearance">How they look</label>
        <textarea id="appearance" name="appearance" required placeholder="Young girl, dark hair in a loose braid, linen dress, small blue umbrella, curious expression."></textarea>
        <label for="portrait">Reference image</label>
        <input id="portrait" name="portrait" type="file" accept="image/*" />
        <div class="actions"><button class="primary" type="submit">Save character</button></div>
      </form>
      ${cards || `<article class="card"><p class="note">No characters yet.</p></article>`}
    </div>`;
}

function renderStories() {
  const story = state.stories.find((item) => item.id === openStory) || state.stories[0];
  if (!story) {
    return `<h1>Stories</h1><p class="lead">No stories yet.</p>`;
  }
  const characterOptions = [`<option value="">No character</option>`].concat(state.characters.map((item) =>
    `<option value="${esc(item.id)}" ${item.id === story.characterId ? "selected" : ""}>${esc(item.name)}</option>`
  )).join("");
  const scenes = story.scenes.map((scene, index) => {
    const shot = state.gallery.find((item) => item.id === scene.galleryId);
    const media = shot
      ? (shot.media === "video"
        ? `<video class="thumb" src="/media/gallery/${esc(shot.file)}" controls playsinline></video>`
        : `<img class="thumb" src="/media/gallery/${esc(shot.file)}" alt="" />`)
      : `<div class="thumb"></div>`;
    return `
      <article class="scene">
        <div>${media}</div>
        <div>
          <h3>${esc(scene.title || `Scene ${index + 1}`)}</h3>
          <p class="note">${esc(scene.prompt || scene.idea || "No prompt yet.")}</p>
          <div class="actions">
            <button type="button" class="ghost" data-build-scene="${esc(scene.id)}">Build prompt</button>
            <button type="button" class="primary" data-run-scene="${esc(scene.id)}">Generate this scene</button>
          </div>
        </div>
      </article>`;
  }).join("");
  const list = state.stories.map((item) =>
    `<button type="button" class="ghost" data-story="${esc(item.id)}">${esc(item.title)}</button>`
  ).join("");
  return `
    <h1>Stories</h1>
    <p class="lead">Keep one world, one character, and one look, then add the next scene instead of starting over.</p>
    <div class="row" style="margin-bottom:14px">${list}</div>
    <section class="card">
      <h2>${esc(story.title)}</h2>
      <label for="world">World</label>
      <textarea id="world">${esc(story.world)}</textarea>
      <div class="row">
        <div>
          <label for="story-character">Character</label>
          <select id="story-character">${characterOptions}</select>
        </div>
        <div>
          <label for="story-style">Look</label>
          <select id="story-style">
            ${Object.entries(LOOKS).map(([id, item]) => `<option value="${id}" ${story.style === id ? "selected" : ""}>${esc(item.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="actions">
        <button type="button" class="ghost" id="save-story">Save story settings</button>
        <button type="button" class="primary" id="next-scene">Next scene</button>
      </div>
      ${scenes}
    </section>`;
}

function renderGallery() {
  if (!state.gallery.length) {
    return `<h1>Gallery</h1><p class="lead">Finished images and clips land here.</p><div class="empty">Nothing generated yet.</div>`;
  }
  const items = state.gallery.map((item) => {
    const src = `/media/gallery/${encodeURIComponent(item.file)}`;
    const still = item.stillFile
      ? `<img src="/media/gallery/${encodeURIComponent(item.stillFile)}" alt="Scene still from the character photo" />`
      : "";
    const media = item.media === "video"
      ? `${still}<video src="${src}" controls playsinline loop></video>`
      : `<img src="${src}" alt="" />`;
    return `<figure class="card">${media}<figcaption>${esc(item.prompt.slice(0, 160))}</figcaption></figure>`;
  }).join("");
  return `<h1>Gallery</h1><div class="gallery-grid">${items}</div>`;
}

function readGenerateForm() {
  const prompt = document.querySelector("#prompt");
  if (!prompt) return;
  form.prompt = prompt.value;
  form.characterId = document.querySelector("#character")?.value || "";
  form.aspect = document.querySelector("#aspect")?.value || "16:9";
  form.seconds = Number(document.querySelector("#seconds")?.value || form.seconds);
  form.pace = document.querySelector("#pace")?.value || form.pace;
  form.seed = document.querySelector("#seed")?.value || "";
}

function bind() {
  document.querySelector("#media")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-media]");
    if (!button) return;
    readGenerateForm();
    form.media = button.dataset.media;
    paint();
  });
  document.querySelector("#prompt")?.addEventListener("input", (event) => {
    form.prompt = event.target.value;
  try { localStorage.setItem("harbor-prompt", form.prompt); } catch { /* private mode */ }
    updateGenerateLive();
  });
  document.querySelector("#open-wizard")?.addEventListener("click", () => {
    readGenerateForm();
    openWizard({ idea: form.prompt, characterId: form.characterId, media: form.media });
  });
  document.querySelector("#use-coastal")?.addEventListener("click", () => {
    const story = state.stories.find((item) => item.id === "coastal-morning");
    const scene = story?.scenes[0];
    form.prompt = buildPrompt({
      idea: scene?.idea || "",
      world: story?.world || "",
      style: "painted",
      camera: "gentle",
      light: "morning",
      mood: "wonder",
      characterId: form.characterId,
      media: form.media,
    });
    form.storyId = story?.id || "";
    form.sceneId = scene?.id || "";
    paint();
  });
  document.querySelector("#generate")?.addEventListener("click", generateCurrent);
  document.querySelector("#cancel")?.addEventListener("click", async () => {
    await api("/api/cancel", { method: "POST" });
    await refresh();
  });
  document.querySelector("#retry-install")?.addEventListener("click", async () => {
    await api("/api/install", { method: "POST" });
    await refresh();
  });
  document.querySelector("#character-form")?.addEventListener("submit", saveCharacter);
  document.querySelectorAll("[data-use]").forEach((button) => {
    button.addEventListener("click", () => {
      form.characterId = button.dataset.use;
      view = "generate";
      paint();
    });
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/characters/${button.dataset.delete}`, { method: "DELETE" });
      await refresh();
      paint();
    });
  });
  document.querySelectorAll("[data-story]").forEach((button) => {
    button.addEventListener("click", () => {
      openStory = button.dataset.story;
      paint();
    });
  });
  document.querySelector("#save-story")?.addEventListener("click", saveStorySettings);
  document.querySelector("#next-scene")?.addEventListener("click", () => {
    const story = state.stories.find((item) => item.id === openStory);
    const previous = [...(story?.scenes || [])].reverse().find((scene) => scene.prompt || scene.idea);
    openWizard({
      idea: NEXT_BEAT,
      world: story?.world || "",
      style: story?.style || "painted",
      characterId: story?.characterId || "",
      previous: clip(previous?.prompt || previous?.idea || ""),
      media: "video",
      storyId: story?.id || "",
      mode: "next",
    });
  });
  document.querySelectorAll("[data-build-scene]").forEach((button) => {
    button.addEventListener("click", () => {
      const story = state.stories.find((item) => item.id === openStory);
      const scene = story?.scenes.find((item) => item.id === button.dataset.buildScene);
      const index = story.scenes.findIndex((item) => item.id === scene.id);
      const previous = index > 0 ? story.scenes[index - 1] : null;
      openWizard({
        idea: scene.idea || scene.prompt,
        world: story.world,
        style: story.style,
        characterId: story.characterId,
        previous: previous ? (previous.prompt || previous.idea || "").slice(0, 500) : "",
        media: "video",
        storyId: story.id,
        sceneId: scene.id,
      });
    });
  });
  document.querySelectorAll("[data-run-scene]").forEach((button) => {
    button.addEventListener("click", () => runScene(button.dataset.runScene));
  });
}

async function generateCurrent() {
  readGenerateForm();
  try {
    await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    await refresh();
    paint();
  } catch (error) {
    const status = document.querySelector("#job-status");
    if (status) {
      status.className = "status error";
      status.textContent = error.message;
    }
  }
}

async function runScene(sceneId) {
  const story = state.stories.find((item) => item.id === openStory);
  const scene = story?.scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  const prompt = scene.prompt || buildPrompt({
    idea: scene.idea,
    world: story.world,
    style: story.style || "painted",
    camera: "gentle",
    light: "morning",
    mood: "wonder",
    characterId: story.characterId,
    media: "video",
    previous: "",
  });
  scene.prompt = prompt;
  form = { ...form, media: "video", prompt, characterId: story.characterId || "", storyId: story.id, sceneId: scene.id };
  view = "generate";
  paint();
  await generateCurrent();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function saveCharacter(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  const portraitFile = event.target.portrait.files[0];
  const portrait = portraitFile ? await fileToDataUrl(portraitFile) : "";
  const character = await api("/api/characters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: data.get("name"),
      appearance: data.get("appearance"),
      portrait,
    }),
  });
  form.characterId = character.id;
  await refresh();
  paint();
}

async function saveStorySettings() {
  const story = state.stories.find((item) => item.id === openStory);
  await api(`/api/stories/${story.id}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      world: document.querySelector("#world").value,
      characterId: document.querySelector("#story-character").value,
      style: document.querySelector("#story-style").value,
    }),
  });
  await refresh();
  paint();
}

function openWizard(seed) {
  wizard = {
    step: 1,
    idea: seed.idea || "",
    world: seed.world || "",
    style: seed.style || "painted",
    camera: seed.camera || "gentle",
    light: seed.light || "morning",
    mood: seed.mood || "wonder",
    characterId: seed.characterId || form.characterId || "",
    previous: seed.previous || "",
    media: seed.media || form.media,
    storyId: seed.storyId || "",
    sceneId: seed.sceneId || "",
    mode: seed.mode || "",
    prompt: "",
  };
  wizard.prompt = buildPrompt(wizard);
  paintWizard();
}

function paintWizard() {
  wizardEl.hidden = false;
  const chips = (group, key) => Object.entries(group).map(([id, item]) =>
    `<button type="button" data-key="${key}" data-value="${id}" class="${wizard[key] === id ? "on" : ""}">${esc(item.label)}</button>`
  ).join("");
  const characters = [`<option value="">No character</option>`].concat(state.characters.map((item) =>
    `<option value="${esc(item.id)}" ${item.id === wizard.characterId ? "selected" : ""}>${esc(item.name)}</option>`
  )).join("");
  const body = wizard.step === 1 ? `
      <label for="idea">${wizard.previous ? "What happens next" : "The idea"}</label>
      <textarea id="idea">${esc(wizard.idea)}</textarea>
      <label for="wiz-world">World, if it should stay the same</label>
      <textarea id="wiz-world">${esc(wizard.world)}</textarea>
      ${wizard.previous ? `<p class="note">Continuing from: ${esc(wizard.previous.slice(0, 280))}</p>` : ""}
    ` : wizard.step === 2 ? `
      <label>Look</label><div class="chips">${chips(LOOKS, "style")}</div>
      <label>Camera</label><div class="chips">${chips(CAMERAS, "camera")}</div>
      <label>Light</label><div class="chips">${chips(LIGHTS, "light")}</div>
      <label>Mood</label><div class="chips">${chips(MOODS, "mood")}</div>
      <label for="wiz-character">Character</label>
      <select id="wiz-character">${characters}</select>
    ` : `
      <label for="wiz-prompt">Production prompt</label>
      <textarea id="wiz-prompt">${esc(wizard.prompt)}</textarea>
      <p class="note">Edit anything that does not match the shot you want. This is what the model receives.</p>
    `;
  wizardEl.innerHTML = `
    <div class="wizard-card">
      <div class="steps">
        <span class="${wizard.step === 1 ? "on" : ""}">1 Idea</span>
        <span class="${wizard.step === 2 ? "on" : ""}">2 Look</span>
        <span class="${wizard.step === 3 ? "on" : ""}">3 Prompt</span>
      </div>
      <h2>${wizard.step === 3 ? "Use this prompt" : wizard.step === 2 ? "Choose the look" : "Start with the idea"}</h2>
      ${body}
      <div class="actions">
        <button type="button" class="ghost" id="wiz-close">Close</button>
        ${wizard.step > 1 ? `<button type="button" class="ghost" id="wiz-back">Back</button>` : ""}
        <button type="button" class="primary" id="wiz-next">${wizard.step === 3 ? "Use this prompt" : "Next"}</button>
      </div>
    </div>`;
  wizardEl.querySelector("#wiz-close").addEventListener("click", closeWizard);
  wizardEl.querySelector("#wiz-back")?.addEventListener("click", () => {
    readWizard();
    wizard.step -= 1;
    paintWizard();
  });
  wizardEl.querySelector("#wiz-next").addEventListener("click", onWizardNext);
  wizardEl.querySelectorAll(".chips button").forEach((button) => {
    button.addEventListener("click", () => {
      wizard[button.dataset.key] = button.dataset.value;
      paintWizard();
    });
  });
}

function readWizard() {
  if (wizard.step === 1) {
    wizard.idea = document.querySelector("#idea")?.value || "";
    wizard.world = document.querySelector("#wiz-world")?.value || "";
  }
  if (wizard.step === 2) wizard.characterId = document.querySelector("#wiz-character")?.value || "";
  if (wizard.step === 3) wizard.prompt = document.querySelector("#wiz-prompt")?.value || wizard.prompt;
}

async function onWizardNext() {
  readWizard();
  if (wizard.step < 3) {
    wizard.prompt = buildPrompt(wizard);
    wizard.step += 1;
    paintWizard();
    return;
  }
  form.prompt = wizard.prompt;
  form.characterId = wizard.characterId;
  form.media = wizard.media || form.media;
  form.storyId = wizard.storyId || form.storyId;
  form.sceneId = wizard.sceneId || "";
  if (wizard.mode === "next" && wizard.storyId) {
    const scene = await api(`/api/stories/${wizard.storyId}/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Next scene",
        idea: wizard.idea,
        prompt: wizard.prompt,
      }),
    });
    form.sceneId = scene.id;
    await refresh();
  } else if (wizard.sceneId && wizard.storyId) {
    const story = state.stories.find((item) => item.id === wizard.storyId);
    const scene = story?.scenes.find((item) => item.id === wizard.sceneId);
    if (scene) scene.prompt = wizard.prompt;
  }
  closeWizard();
  view = "generate";
  paint();
}

function closeWizard() {
  wizard = null;
  wizardEl.hidden = true;
  wizardEl.innerHTML = "";
}

document.querySelector("nav").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) return;
  if (view === "generate") readGenerateForm();
  view = button.dataset.view;
  paint();
});

refresh().then(paint);
setInterval(() => { refresh().catch(() => {}); }, 2000);

/**
 * Python AsyncIO Animation Engine & Interactive Controller
 * Provides card utilities, state transitions, interactive playback controls,
 * scrubber, step explainer, navigation, and keyboard shortcuts.
 */

// Global state variables for stepper and replay
let initAppHandler = null;
let initialContainerHTML = null;
let isFastReplaying = false;
let currentStepsRef = [];
let totalSteps = 0;
let currentStepIndex = 0;
let isPlaying = false;
let playIntervalId = null;
let playSpeed = 1000; // ms per step at 1x
let speedMultiplier = 1; // 1x default

// Example metadata directory for navigation and header
const EXAMPLES_INFO = [
  { file: "example_1.html", num: 1, title: "Synchronous Version", subtitle: "Sequential execution without AsyncIO or Event Loop" },
  { file: "example_2.html", num: 2, title: "Awaiting Coroutines Directly", subtitle: "Direct await without tasks executes sequentially" },
  { file: "example_3.html", num: 3, title: "Concurrent Tasks with create_task", subtitle: "Scheduling coroutines concurrently on the Event Loop" },
  { file: "example_4.html", num: 4, title: "Awaiting in Different Orders", subtitle: "Background tasks finish independently of await order" },
  { file: "example_5.html", num: 5, title: "Blocking the Event Loop", subtitle: "Synchronous blocking calls freeze all asynchronous tasks" },
  { file: "example_6.html", num: 6, title: "Threads & Multiprocessing", subtitle: "Offloading blocking I/O and CPU work with to_thread and ProcessPool" },
  { file: "example_7.html", num: 7, title: "Task Scheduling Primitives", subtitle: "TaskGroup, gather, and modern structured concurrency" },
];

// Determine current example metadata
function getCurrentExampleInfo() {
  const currentPath = window.location.pathname;
  const match = currentPath.match(/example_(\d+)\.html/);
  const num = match ? parseInt(match[1], 10) : 1;
  const info = EXAMPLES_INFO.find((ex) => ex.num === num) || EXAMPLES_INFO[0];
  const prev = EXAMPLES_INFO.find((ex) => ex.num === num - 1) || null;
  const next = EXAMPLES_INFO.find((ex) => ex.num === num + 1) || null;
  return { ...info, prev, next };
}

// Intercept DOMContentLoaded so we can snapshot and replay
const originalAddEventListener = document.addEventListener.bind(document);
document.addEventListener = function (type, listener, options) {
  if (type === "DOMContentLoaded") {
    initAppHandler = listener;
    return originalAddEventListener(
      type,
      function (event) {
        const container = document.querySelector(".container");
        if (container && !initialContainerHTML) {
          initialContainerHTML = container.innerHTML;
        }
        listener(event);
      },
      options
    );
  }
  return originalAddEventListener(type, listener, options);
};

// Utility function to create cards
function createCard(id, spinner = false) {
  const card = document.createElement("div");
  card.className = "card";
  card.id = id;

  let spinnerHTML = "";
  if (spinner) {
    spinnerHTML = `<div class="spinner"></div>`;
  }

  card.innerHTML = `
    <div class="card-header">
      <h3></h3>${spinnerHTML}
      <span class="status"></span>
    </div>
    <div class="card-body"></div>
  `;

  return card;
}

function setCardStatus(card, status) {
  if (card) {
    card.classList.remove(
      "ready-status",
      "running-status",
      "suspended-status",
      "complete-status",
      "IO-status"
    );
    card.classList.add(`${status}-status`);
    const statusElem = card.querySelector(".status");
    if (statusElem) {
      statusElem.textContent =
        status.charAt(0).toUpperCase() + status.slice(1);
    }
  }
}

// Adding a card with animation (bypassed during fast replay)
function addCard(parent, card) {
  if (isFastReplaying) {
    card.classList.remove("card-entering");
    parent.appendChild(card);
    return;
  }
  card.classList.add("card-entering");
  parent.appendChild(card);

  card.addEventListener(
    "animationend",
    () => {
      card.classList.remove("card-entering");
    },
    { once: true }
  );
}

// Removing a card with animation (bypassed during fast replay)
function removeCard(parent, card) {
  if (isFastReplaying) {
    if (card && card.parentNode === parent) {
      parent.removeChild(card);
    }
    card.classList.remove("card-exiting");
    return;
  }
  card.classList.add("card-exiting");

  card.addEventListener(
    "animationend",
    () => {
      if (card && card.parentNode === parent) {
        parent.removeChild(card);
      }
      card.classList.remove("card-exiting");
    },
    { once: true }
  );
}

// Generate an informative, plain-English explanation of the current step
function getStepExplanation(stepIdx, total) {
  if (stepIdx === 0) {
    return {
      type: "ready",
      icon: "🏁",
      title: "Initial State",
      text: "Program initialized. Click Play or Step Forward (or press Space / Right Arrow) to begin execution.",
    };
  }
  if (stepIdx >= total) {
    return {
      type: "done",
      icon: "🎉",
      title: "Completed",
      text: "Execution finished! All coroutines and tasks have completed, and final results are printed.",
    };
  }

  // Inspect currently highlighted lines in code blocks
  const highlightedCode = document.querySelector(".highlight");
  const inactiveCode = document.querySelector(".highlight-inactive");
  const runningCard = document.querySelector(".running-status h3");
  const suspendedCard = document.querySelector(".suspended-status h3");
  const ioCard = document.querySelector(".IO-status h3");
  const completeCard = document.querySelector(".complete-status h3");

  const lineText = highlightedCode ? highlightedCode.textContent.trim() : "";

  if (lineText.includes("import asyncio") || lineText.includes("import time") || lineText.includes("from concurrent.futures")) {
    return {
      type: "thread",
      icon: "📦",
      title: "Importing Modules",
      text: `Importing required runtime modules: \`${lineText}\`.`,
    };
  }
  if (lineText.startsWith("def ") || lineText.startsWith("async def ")) {
    return {
      type: "thread",
      icon: "📝",
      title: "Defining Function",
      text: `Python registers function definition: \`${lineText}\`.`,
    };
  }
  if (lineText.includes("asyncio.run(")) {
    return {
      type: "loop",
      icon: "🔄",
      title: "Starting Event Loop",
      text: "Initializing Python's Event Loop via `asyncio.run()`. It becomes the active event loop for this thread.",
    };
  }
  if (lineText.includes("asyncio.create_task(")) {
    return {
      type: "loop",
      icon: "⚡",
      title: "Scheduling Task",
      text: `Creating Task: \`${lineText}\`. The coroutine is wrapped into a Task and queued as 'Ready' on the Event Loop.`,
    };
  }
  if (lineText.includes("await ")) {
    return {
      type: "yield",
      icon: "⏸️",
      title: "Awaiting (Yielding Control)",
      text: `Executing \`${lineText}\`. Yields execution back to the Event Loop while waiting for completion.`,
    };
  }
  if (lineText.includes("time.sleep(")) {
    return {
      type: "blocking",
      icon: "⛔",
      title: "Blocking Call Detected!",
      text: `Running \`${lineText}\`. Warning: Synchronous sleep halts the entire OS thread, completely blocking the Event Loop!`,
    };
  }
  if (lineText.includes("asyncio.to_thread(")) {
    return {
      type: "threadpool",
      icon: "🧵",
      title: "Offloading to Worker Thread",
      text: `Executing \`${lineText}\`. Function dispatched to background thread pool, leaving the Event Loop responsive.`,
    };
  }
  if (lineText.includes("run_in_executor(") || lineText.includes("ProcessPoolExecutor")) {
    return {
      type: "process",
      icon: "⚙️",
      title: "Offloading to Process Pool",
      text: `Dispatching to separate worker process. Runs independently without GIL contention.`,
    };
  }
  if (lineText.includes("TaskGroup()")) {
    return {
      type: "structured",
      icon: "🛡️",
      title: "TaskGroup (Structured Concurrency)",
      text: `Entering \`TaskGroup\`. Manages task lifecycle and guarantees all child tasks are awaited before exiting.`,
    };
  }
  if (lineText.includes("asyncio.gather(")) {
    return {
      type: "gather",
      icon: "🔀",
      title: "Gathering Concurrently",
      text: `Running \`asyncio.gather()\`. Bundles multiple awaitables and runs them concurrently, gathering results in order.`,
    };
  }
  if (lineText.includes("print(")) {
    return {
      type: "io",
      icon: "🖨️",
      title: "Standard Output",
      text: `Printing output: \`${lineText}\`.`,
    };
  }
  if (lineText.includes("return ")) {
    return {
      type: "complete",
      icon: "✅",
      title: "Returning Value",
      text: `Returning value from coroutine: \`${lineText}\`.`,
    };
  }

  // Card status events
  if (runningCard) {
    return {
      type: "running",
      icon: "▶️",
      title: "Running Coroutine",
      text: `Event Loop granted execution time slice to coroutine \`${runningCard.textContent.trim()}\`.`,
    };
  }
  if (ioCard) {
    return {
      type: "io",
      icon: "⏳",
      title: "Background I/O Waiting",
      text: `Background operation active: \`${ioCard.textContent.trim()}\`. Coroutine paused until I/O notifies ready.`,
    };
  }
  if (completeCard) {
    return {
      type: "complete",
      icon: "✨",
      title: "Task Complete",
      text: `Task \`${completeCard.textContent.trim()}\` completed its work and resolved its result.`,
    };
  }

  return {
    type: "step",
    icon: "🔹",
    title: `Step ${stepIdx}`,
    text: `Executing instruction step ${stepIdx} of ${total}.`,
  };
}

// Jump to a specific step index (handles step forward, backward, reset, and scrubbing)
function goToStep(targetStep) {
  if (targetStep < 0) targetStep = 0;
  if (targetStep > totalSteps) targetStep = totalSteps;

  // Single forward step: execute directly
  if (targetStep === currentStepIndex + 1 && targetStep <= totalSteps) {
    currentStepsRef[currentStepIndex]();
    currentStepIndex = targetStep;
    updateUI();
    return;
  }

  // Replay from scratch to targetStep
  isFastReplaying = true;
  const container = document.querySelector(".container");
  if (container && initialContainerHTML) {
    container.innerHTML = initialContainerHTML;
  }

  if (initAppHandler) {
    initAppHandler();
  }

  for (let i = 0; i < targetStep; i++) {
    if (currentStepsRef[i]) {
      currentStepsRef[i]();
    }
  }

  isFastReplaying = false;
  currentStepIndex = targetStep;
  updateUI();
}

// Next Step
function stepForward() {
  if (currentStepIndex < totalSteps) {
    goToStep(currentStepIndex + 1);
  } else {
    stopAutoPlay();
  }
}

// Previous Step
function stepBackward() {
  if (currentStepIndex > 0) {
    goToStep(currentStepIndex - 1);
  }
}

// Reset to Step 0
function resetSteps() {
  stopAutoPlay();
  goToStep(0);
}

// Auto-play controls
function startAutoPlay() {
  if (currentStepIndex >= totalSteps) {
    goToStep(0);
  }
  isPlaying = true;
  updatePlayButton();
  playIntervalId = setInterval(() => {
    if (currentStepIndex < totalSteps) {
      stepForward();
    } else {
      stopAutoPlay();
    }
  }, playSpeed / speedMultiplier);
}

function stopAutoPlay() {
  isPlaying = false;
  if (playIntervalId) {
    clearInterval(playIntervalId);
    playIntervalId = null;
  }
  updatePlayButton();
}

function toggleAutoPlay() {
  if (isPlaying) {
    stopAutoPlay();
  } else {
    startAutoPlay();
  }
}

function setSpeed(multiplier) {
  speedMultiplier = multiplier;
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.classList.toggle("active", parseFloat(btn.dataset.speed) === multiplier);
  });
  if (isPlaying) {
    stopAutoPlay();
    startAutoPlay();
  }
}

// Update Play/Pause button appearance
function updatePlayButton() {
  const playBtn = document.getElementById("hud-play-btn");
  if (!playBtn) return;
  if (isPlaying) {
    playBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16" rx="1.5"></rect>
        <rect x="14" y="4" width="4" height="16" rx="1.5"></rect>
      </svg>
      <span>Pause</span>
    `;
    playBtn.classList.add("playing");
  } else {
    playBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5,3 19,12 5,21"></polygon>
      </svg>
      <span>Play</span>
    `;
    playBtn.classList.remove("playing");
  }
}

// Update UI elements (Scrubber, Step Counter, Explainer, Navigation)
function updateUI() {
  updatePlayButton();

  // Scrubber & Counter
  const slider = document.getElementById("hud-scrubber");
  const stepLabel = document.getElementById("hud-step-counter");
  const progressFill = document.getElementById("hud-progress-fill");

  if (slider) {
    slider.value = currentStepIndex;
    slider.max = totalSteps;
  }

  const pct = totalSteps > 0 ? Math.round((currentStepIndex / totalSteps) * 100) : 0;
  if (progressFill) {
    progressFill.style.width = `${pct}%`;
  }

  if (stepLabel) {
    stepLabel.textContent = `Step ${currentStepIndex} / ${totalSteps} (${pct}%)`;
  }

  // Prev / Next button states
  const prevBtn = document.getElementById("hud-prev-btn");
  const nextBtn = document.getElementById("hud-next-btn");
  if (prevBtn) prevBtn.disabled = currentStepIndex <= 0;
  if (nextBtn) nextBtn.disabled = currentStepIndex >= totalSteps;

  // Step Explainer Banner
  const explainerCard = document.getElementById("step-explainer-banner");
  if (explainerCard) {
    const info = getStepExplanation(currentStepIndex, totalSteps);
    explainerCard.className = `step-explainer ${info.type}`;
    explainerCard.innerHTML = `
      <div class="explainer-icon">${info.icon}</div>
      <div class="explainer-content">
        <div class="explainer-title">${info.title}</div>
        <div class="explainer-text">${info.text}</div>
      </div>
      <div class="explainer-badge">${currentStepIndex} / ${totalSteps}</div>
    `;
  }
}

// Build and inject UI chrome (Top Bar, Control HUD, Shortcuts Modal)
function injectUI() {
  if (document.getElementById("app-topbar")) return;

  const currentInfo = getCurrentExampleInfo();

  // 1. Top Navigation Bar
  const topBar = document.createElement("header");
  topBar.id = "app-topbar";
  topBar.innerHTML = `
    <div class="topbar-left">
      <a href="index.html" class="topbar-btn home-btn" title="Back to Examples Hub">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
          <polyline points="9 22 9 12 15 12 15 22"></polyline>
        </svg>
        <span>All Examples</span>
      </a>
      <div class="topbar-divider"></div>
      <span class="topbar-badge">Example ${currentInfo.num} of 7</span>
    </div>

    <div class="topbar-center">
      <h1 class="topbar-title">${currentInfo.title}</h1>
      <span class="topbar-subtitle">${currentInfo.subtitle}</span>
    </div>

    <div class="topbar-right">
      ${
        currentInfo.prev
          ? `<a href="${currentInfo.prev.file}" class="topbar-nav-btn" title="Previous: ${currentInfo.prev.title}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
              <span>Prev</span>
            </a>`
          : `<span class="topbar-nav-btn disabled"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg> Prev</span>`
      }
      ${
        currentInfo.next
          ? `<a href="${currentInfo.next.file}" class="topbar-nav-btn" title="Next: ${currentInfo.next.title}">
              <span>Next</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </a>`
          : `<span class="topbar-nav-btn disabled">Next <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg></span>`
      }
      <button id="btn-shortcuts-toggle" class="topbar-btn help-btn" title="Keyboard Shortcuts (?)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <span>Keys</span>
      </button>
    </div>
  `;
  document.body.prepend(topBar);

  // 2. Step Explainer Banner
  const explainer = document.createElement("div");
  explainer.id = "step-explainer-banner";
  explainer.className = "step-explainer ready";
  document.body.insertBefore(explainer, document.querySelector(".container"));

  // 3. Floating Control HUD Dock
  const dock = document.createElement("nav");
  dock.id = "app-dock";
  dock.innerHTML = `
    <!-- Scrubber & Progress Bar -->
    <div class="hud-timeline">
      <div class="hud-timeline-track">
        <div id="hud-progress-fill" class="hud-progress-fill"></div>
        <input type="range" id="hud-scrubber" class="hud-slider" min="0" max="${totalSteps}" value="0" step="1" title="Scrub through animation steps" />
      </div>
      <div class="hud-timeline-info">
        <span id="hud-step-counter" class="hud-counter">Step 0 / ${totalSteps} (0%)</span>
        <div class="hud-legend-chips">
          <span class="chip chip-ready" title="Waiting in event loop queue">Ready</span>
          <span class="chip chip-running" title="Currently executing on Python thread">Running</span>
          <span class="chip chip-suspended" title="Paused at await expression">Suspended</span>
          <span class="chip chip-complete" title="Completed with result">Complete</span>
          <span class="chip chip-io" title="Waiting on external timer/I/O">I/O</span>
        </div>
      </div>
    </div>

    <!-- Controls Row -->
    <div class="hud-controls-row">
      <!-- Playback Buttons -->
      <div class="hud-btn-group">
        <button id="hud-reset-btn" class="hud-btn" title="Reset to Start (R)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="19 20 9 12 19 4 19 20"></polygon>
            <line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="3"></line>
          </svg>
          <span class="btn-text">Reset</span>
        </button>

        <button id="hud-prev-btn" class="hud-btn" title="Previous Step (Left Arrow / J)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="18 4 6 12 18 20"></polygon>
          </svg>
          <span class="btn-text">Prev</span>
        </button>

        <button id="hud-play-btn" class="hud-btn hud-btn-primary" title="Play / Pause (Space / K)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21"></polygon>
          </svg>
          <span>Play</span>
        </button>

        <button id="hud-next-btn" class="hud-btn" title="Next Step (Right Arrow / L)">
          <span class="btn-text">Next</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 4 18 12 6 20"></polygon>
          </svg>
        </button>
      </div>

      <!-- Speed Selector -->
      <div class="hud-speed-group">
        <span class="speed-label">Speed:</span>
        <button class="speed-btn" data-speed="0.5">0.5x</button>
        <button class="speed-btn active" data-speed="1">1x</button>
        <button class="speed-btn" data-speed="1.5">1.5x</button>
        <button class="speed-btn" data-speed="2">2x</button>
      </div>
    </div>
  `;
  document.body.appendChild(dock);

  // 4. Keyboard Shortcuts Modal
  const modal = document.createElement("div");
  modal.id = "app-shortcuts-modal";
  modal.className = "shortcuts-modal";
  modal.innerHTML = `
    <div class="shortcuts-card">
      <div class="shortcuts-header">
        <h3>Keyboard Shortcuts</h3>
        <button id="btn-close-modal" class="modal-close-btn">&times;</button>
      </div>
      <div class="shortcuts-body">
        <div class="shortcut-row"><kbd>Space</kbd> or <kbd>K</kbd> <span>Play / Pause</span></div>
        <div class="shortcut-row"><kbd>→</kbd> or <kbd>L</kbd> <span>Step Forward</span></div>
        <div class="shortcut-row"><kbd>←</kbd> or <kbd>J</kbd> <span>Step Backward</span></div>
        <div class="shortcut-row"><kbd>R</kbd> <span>Reset to Step 0</span></div>
        <div class="shortcut-row"><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> <span>Set Speed (0.5x, 1x, 2x)</span></div>
        <div class="shortcut-row"><kbd>?</kbd> <span>Toggle this shortcuts guide</span></div>
        <div class="shortcut-row"><kbd>Esc</kbd> <span>Close dialog</span></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Wire event listeners
  document.getElementById("hud-play-btn").addEventListener("click", toggleAutoPlay);
  document.getElementById("hud-next-btn").addEventListener("click", () => {
    stopAutoPlay();
    stepForward();
  });
  document.getElementById("hud-prev-btn").addEventListener("click", () => {
    stopAutoPlay();
    stepBackward();
  });
  document.getElementById("hud-reset-btn").addEventListener("click", resetSteps);

  // Slider scrubber
  const slider = document.getElementById("hud-scrubber");
  slider.addEventListener("input", (e) => {
    stopAutoPlay();
    goToStep(parseInt(e.target.value, 10));
  });

  // Speed buttons
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setSpeed(parseFloat(btn.dataset.speed));
    });
  });

  // Shortcuts modal toggle
  const toggleBtn = document.getElementById("btn-shortcuts-toggle");
  const closeBtn = document.getElementById("btn-close-modal");
  const toggleModal = () => modal.classList.toggle("open");
  toggleBtn.addEventListener("click", toggleModal);
  closeBtn.addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("open");
  });

  // Global Keyboard Listener
  document.addEventListener("keydown", (e) => {
    // Avoid triggering when inside inputs
    if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;

    if (e.key === " " || e.key === "k" || e.key === "K") {
      e.preventDefault();
      toggleAutoPlay();
    } else if (e.key === "ArrowRight" || e.key === "l" || e.key === "L") {
      e.preventDefault();
      stopAutoPlay();
      stepForward();
    } else if (e.key === "ArrowLeft" || e.key === "j" || e.key === "J") {
      e.preventDefault();
      stopAutoPlay();
      stepBackward();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      resetSteps();
    } else if (e.key === "1") {
      setSpeed(0.5);
    } else if (e.key === "2") {
      setSpeed(1);
    } else if (e.key === "3") {
      setSpeed(2);
    } else if (e.key === "?" || e.key === "/") {
      toggleModal();
    } else if (e.key === "Escape") {
      modal.classList.remove("open");
    }
  });
}

// Master Stepper Setup - Called by all example scripts
function setupStepper(steps) {
  currentStepsRef = steps;
  totalSteps = steps.length;

  injectUI();
  updateUI();
}

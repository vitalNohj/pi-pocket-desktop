/** Desktop Settings: Home (where Pi Pocket runs, and the way into it) and Settings (every section), with a sidebar. */
import type {
  BillionContextAction,
  ChoiceStatus,
  ConfigReason,
  ConfigState,
  DictationModelState,
  GuiConfigApi,
  RecentDictation,
  LocalAction,
  LocalState,
  ProbeResult,
  RunnerState,
  Settings,
  Side,
} from "../../shared/types";

declare global {
  interface Window {
    gui: GuiConfigApi;
  }
}

const gui = window.gui;

// ——— Home and Settings ———

type View = "home" | "settings";

/** The sections of Settings, in page order; Home is its own view. */
const SECTIONS = [
  "window",
  "appearance",
  "notifications",
  "dictation",
  "updates",
  "runner",
  "server",
] as const;
let view: View = "home";
let current = "home";

function markCurrent(go: string): void {
  current = go;

  for (const item of document.querySelectorAll<HTMLAnchorElement>(
    ".nav-item",
  )) {
    if (item.dataset.go === go) {
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  }
}

/** Shows Home, or Settings at a section (its top when none). */
function showView(next: View, section?: string): void {
  view = next;
  element("view-home").hidden = next !== "home";
  element("settings-form").hidden = next !== "settings";

  if (next === "home") {
    markCurrent("home");
    window.scrollTo(0, 0);

    return;
  }

  const target =
    section === undefined
      ? undefined
      : document.getElementById(`sec-${section}`);

  markCurrent(section ?? SECTIONS[0]);

  if (target === undefined || target === null) {
    window.scrollTo(0, 0);
  } else {
    target.scrollIntoView({ block: "start" });
  }
}

function go(where: string): void {
  if (where === "home") {
    showView("home");
  } else {
    showView("settings", where);
  }
}

for (const link of document.querySelectorAll<HTMLElement>("[data-go]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    go(link.dataset.go ?? "home");
  });
}

/** In Settings, the sidebar marks the section being read. */
function followScroll(): void {
  if (view !== "settings") {
    return;
  }

  let reading: string = SECTIONS[0];

  for (const section of SECTIONS) {
    const top =
      document.getElementById(`sec-${section}`)?.getBoundingClientRect().top ??
      Infinity;

    if (top <= 160) {
      reading = section;
    }
  }

  // At the bottom, the last section is the one read, even when it is too short to reach the top.
  if (
    window.innerHeight + window.scrollY >=
    document.documentElement.scrollHeight - 4
  ) {
    reading = SECTIONS[SECTIONS.length - 1]!;
  }

  if (reading !== current) {
    markCurrent(reading);
  }
}

if (typeof window.addEventListener === "function") {
  window.addEventListener("scroll", followScroll, { passive: true });
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (found === null) {
    throw new Error(`#${id} is missing`);
  }

  return found as T;
}

const urlInput = element<HTMLInputElement>("url");
const schemeInput = element<HTMLSelectElement>("scheme");
const hostInput = element<HTMLInputElement>("host");
const portInput = element<HTMLInputElement>("port");
const pathInput = element<HTMLInputElement>("path");
const urlFields = element<HTMLDivElement>("url-fields");
const partFields = element<HTMLDivElement>("part-fields");
const urlError = element<HTMLParagraphElement>("url-error");
const status = element<HTMLSpanElement>("status");
const statusDetail = element<HTMLParagraphElement>("status-detail");
const banner = element<HTMLDivElement>("banner");
const back = element<HTMLButtonElement>("back");
const retry = element<HTMLButtonElement>("retry");
const retryNote = element<HTMLSpanElement>("retry-note");
const saved = element<HTMLSpanElement>("saved");

let state: ConfigState | undefined;
/** The address the person is editing; a state update from the main process does not overwrite it while it differs. */
let editing = false;
let checkSeq = 0;
/** The last check this page made, and of which address: Connect, once connected, waits for a check of a new one. */
let checked: ProbeResult | undefined;
let checkedInput: string | undefined;
let checking: number | undefined;
let connecting = false;
const connectButton = element<HTMLButtonElement>("connect");

// ——— The address, as one field or as parts ———

function mode(): "url" | "parts" {
  return (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')
    ?.value ?? "url") as "url" | "parts";
}

function typedUrl(): string {
  if (mode() === "url") {
    return urlInput.value.trim();
  }

  const host = hostInput.value.trim();
  const port = portInput.value.trim();
  const path = pathInput.value.trim();

  if (host === "") {
    return "";
  }

  const bracketed =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

  return `${schemeInput.value}://${bracketed}${port === "" ? "" : `:${port}`}${path === "" || path === "/" ? "" : path.startsWith("/") ? path : `/${path}`}`;
}

function fillAddress(url: string): void {
  urlInput.value = url;

  try {
    const parsed = new URL(url);

    schemeInput.value = parsed.protocol === "https:" ? "https" : "http";
    hostInput.value = parsed.hostname.replace(/^\[|\]$/g, "");
    portInput.value = parsed.port;
    pathInput.value = parsed.pathname === "/" ? "" : parsed.pathname;
  } catch {
    hostInput.value = "";
  }
}

for (const radio of document.querySelectorAll<HTMLInputElement>(
  'input[name="mode"]',
)) {
  radio.addEventListener("change", () => {
    const url = mode() === "parts" ? urlInput.value.trim() : typedUrl();

    if (url !== "") {
      fillAddress(url);
    }

    urlFields.hidden = mode() !== "url";
    partFields.hidden = mode() !== "parts";
    addressChanged();
  });
}

function addressChanged(): void {
  editing = true;
  urlError.hidden = true;
  checkSeq++;
  checking = undefined;
  checked = undefined;
  checkedInput = undefined;

  if (state !== undefined && connectedHere(state)) {
    showConnected(state);
  } else if (state === undefined || !showDisconnected(state)) {
    showStatus(undefined, "Not checked yet");
  }

  updateConnect();
}

for (const input of [urlInput, hostInput, portInput, pathInput, schemeInput]) {
  input.addEventListener("input", addressChanged);
}

// ——— What the check found ———

function showStatus(probe: ProbeResult | undefined, pending?: string): void {
  if (probe === undefined) {
    status.dataset.state = "checking";
    status.textContent = pending ?? "Checking…";
    statusDetail.textContent = "";

    return;
  }

  switch (probe.kind) {
    case "detected":
      status.dataset.state = "detected";
      status.textContent = "Detected";
      statusDetail.textContent =
        probe.bridge > 0
          ? `Pi Pocket is available at ${probe.url}.`
          : `Pi Pocket is available at ${probe.url}. Update the server to enable notifications and tray pins.`;
      break;
    case "other":
      status.dataset.state = "other";
      status.textContent = "Not detected";
      statusDetail.textContent = probe.message;
      break;
    case "unreachable":
      status.dataset.state = "not-detected";
      status.textContent = "Not detected";
      statusDetail.textContent = `Cannot reach ${probe.url}. ${probe.message}`;
      break;
    case "invalid":
      status.dataset.state = "not-detected";
      status.textContent = "Not detected";
      statusDetail.textContent = probe.message;
      break;
  }
}

/** The typed address is the one Pi Pocket is open at. */
function connectedHere(next: ConfigState): boolean {
  return (
    next.connectedUrl !== undefined && sameUrl(typedUrl(), next.connectedUrl)
  );
}

function sameUrl(a: string, b: string): boolean {
  const plain = (url: string) => {
    try {
      const parsed = new URL(url.trim());

      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      return url.trim().replace(/\/+$/, "");
    }
  };

  return plain(a) === plain(b);
}

/** The window's connection to another server dropped, and the typed address is that server's. */
function showDisconnected(next: ConfigState): boolean {
  const lost = next.disconnected;

  if (
    lost === undefined ||
    next.connectedUrl !== undefined ||
    !sameUrl(typedUrl(), lost.url) ||
    next.probe?.kind === "detected"
  ) {
    return false;
  }

  status.dataset.state = "not-detected";
  status.textContent = "Disconnected";
  statusDetail.textContent = `Disconnected: ${lost.line}.`;

  return true;
}

function showConnected(next: ConfigState): void {
  if (
    next.probe?.kind === "other" &&
    sameUrl(next.probe.url, next.connectedUrl ?? "")
  ) {
    showStatus(next.probe);

    return;
  }

  const bridge =
    next.probe !== undefined &&
    next.probe.kind === "detected" &&
    sameUrl(next.probe.url, next.connectedUrl ?? "")
      ? next.probe.bridge
      : 1;

  status.dataset.state = "connected";
  status.textContent = "Connected";
  statusDetail.textContent =
    bridge > 0
      ? `Pi Pocket is open at ${next.connectedUrl ?? ""}.`
      : `Pi Pocket is open at ${next.connectedUrl ?? ""}. Update the server to enable notifications and tray pins.`;
}

function checkedHere(): ProbeResult | undefined {
  if (
    checked !== undefined &&
    (checkedInput === typedUrl() || sameUrl(checked.url, typedUrl()))
  ) {
    return checked;
  }

  return state?.probe !== undefined && sameUrl(state.probe.url, typedUrl())
    ? state.probe
    : undefined;
}

/** The first Connect may check for you, but a failed check never opens an error/API page. */
function updateConnect(): void {
  for (const input of [
    urlInput,
    hostInput,
    portInput,
    pathInput,
    schemeInput,
    ...document.querySelectorAll<HTMLInputElement>('input[name="mode"]'),
  ]) {
    input.disabled = connecting;
  }

  element<HTMLButtonElement>("test").disabled =
    connecting || checking !== undefined;

  if (connecting || checking !== undefined) {
    connectButton.disabled = true;
    connectButton.textContent = connecting ? "Connecting…" : "Checking…";

    return;
  }

  const current = checkedHere();
  const unverified = current?.kind === "other" && current.canOpen;

  connectButton.textContent = unverified ? "Open webpage anyway" : "Connect";
  connectButton.title = "";

  if (state !== undefined && connectedHere(state)) {
    connectButton.disabled = true;
    connectButton.title =
      "Already open at this address. Use Back to Pi Pocket to return.";
  } else if (current !== undefined) {
    connectButton.disabled = current.kind !== "detected" && !unverified;
    connectButton.title = connectButton.disabled
      ? "Pi Pocket was not detected. Check the server address."
      : "";
  } else {
    connectButton.disabled = state?.connectedUrl !== undefined;
    connectButton.title = connectButton.disabled
      ? "Check the new address first."
      : "";
  }
}

function reasonBanner(
  reason: ConfigReason,
): { text: string; tone: "error" | "info" } | undefined {
  switch (reason.kind) {
    case "not-detected":
      return reason.probe.kind === "detected"
        ? undefined
        : {
            text: reason.probe.message,
            tone:
              reason.probe.kind === "other" && reason.probe.canOpen
                ? "info"
                : "error",
          };
    case "load-failed":
      return {
        text: `Pi Pocket did not load from ${reason.url}: ${reason.message}`,
        tone: "error",
      };
    case "outage":
      return {
        text: `Lost connection to ${reason.url}. ${reason.message} The app reconnects when the server answers.`,
        tone: "error",
      };
    case "crashed":
      return {
        text: `${reason.message} Choose Retry now to reopen Pi Pocket.`,
        tone: "error",
      };
    case "first-run":
      return {
        text: "Choose where Pi Pocket runs. Connect to an existing server, or install it on this computer.",
        tone: "info",
      };
    case "local":
      return undefined;
    default:
      return undefined;
  }
}

let countdown: number | undefined;
let lastReason: string | undefined;

/** The Updates card: where the app's own update stands, and the button for its next step. */
function renderUpdate(next: ConfigState): void {
  const update = next.update;
  const action = element("update-action") as HTMLButtonElement;
  const check = element("update-check") as HTMLButtonElement;
  const busy = update.status === "checking" || update.status === "downloading";
  const when =
    update.checkedAt === undefined
      ? ""
      : `Checked ${new Date(update.checkedAt).toLocaleString()}.`;
  const how: Record<typeof update.method, string> = {
    install: "Updates download automatically. Restart the app to install them.",
    download:
      "This unsigned macOS app cannot update itself. Download the update, then choose Quit and install: Pi Pocket quits and opens the disk image. Drag Pi Pocket into Applications over the old one, then open it.",
    page: "Open the release page and install the new version.",
    source: "Running from source. Use git pull to update the app.",
  };
  let status = "Not checked yet";
  let label = "";

  switch (update.status) {
    case "checking":
      status = "Checking…";
      break;
    case "current":
      status =
        update.method === "source"
          ? `Running from source (${next.appVersion})`
          : `App up to date (${next.appVersion})`;
      break;
    case "available":
      status = `Desktop app ${update.version ?? ""} is available`;
      label =
        update.method === "download"
          ? "Download"
          : update.method === "page"
            ? "Open release"
            : "";
      break;
    case "downloading":
      status = `Downloading ${update.version ?? ""}… ${update.percent ?? 0}%`;
      break;
    case "ready":
      status =
        update.method === "install"
          ? `Desktop app ${update.version ?? ""} is ready`
          : `Desktop app ${update.version ?? ""} downloaded`;
      label = update.method === "install" ? "Restart app" : "Quit and install";
      break;
    case "error":
      status = "Update check failed";
      break;
    default:
      break;
  }

  element("update-status").textContent = status;
  element("update-detail").textContent =
    update.status === "error"
      ? `${update.message ?? ""} ${when}`.trim()
      : `${how[update.method]} ${when}`.trim();
  action.hidden = label === "";
  action.textContent = label;
  check.disabled = busy;
}

element("update-check").addEventListener("click", () => {
  void gui.checkUpdates();
});

element("update-action").addEventListener("click", () => {
  void gui.updateAction();
});

/** Pi Pocket's colors, as its page shows them: this screen looks like the Pi Pocket it opens. */
function renderTheme(next: ConfigState): void {
  const root = document.documentElement;

  for (const [token, value] of Object.entries(next.theme.colors)) {
    root.style.setProperty(`--${token}`, value);
  }

  root.dataset.mode = next.theme.mode;
  root.dataset.ready = "";
}

// ——— This computer's Pi Pocket ———

const ACCESS_NOTES: Record<string, string> = {
  local:
    "Only this computer can connect. To use a phone, choose Tailscale or Cloudflare.",
  lan: "Devices on the same network can reach the sign-in page.",
  tailscale:
    "Your Tailscale devices can connect from anywhere. Tailscale must run on this computer.",
  cloudflare:
    "Create a public HTTPS link. Pi Pocket downloads Cloudflare's tunnel software once.",
};

const LOCAL_LABELS: Record<
  LocalState["status"],
  { pill: string; state: string }
> = {
  absent: { pill: "Not installed", state: "other" },
  installing: { pill: "Installing…", state: "checking" },
  stopped: { pill: "Stopped", state: "other" },
  starting: { pill: "Starting…", state: "checking" },
  running: { pill: "Running", state: "connected" },
  external: { pill: "Already running", state: "detected" },
  stopping: { pill: "Stopping…", state: "checking" },
  failed: { pill: "Stopped", state: "not-detected" },
};

/** Home's heading for each state of this computer's Pi Pocket. */
const LOCAL_TITLES: Record<LocalState["status"], string> = {
  absent: "Run Pi Pocket on this computer",
  installing: "Setting up Pi Pocket on this computer",
  stopped: "Pi Pocket is installed and ready to start",
  starting: "Starting Pi Pocket…",
  running: "Pi Pocket is running on this computer",
  external: "Pi Pocket already runs on this computer",
  stopping: "Stopping Pi Pocket…",
  failed: "Pi Pocket stopped",
};

/** A choice's status pill, and its error line (clipped; the card has the whole text). */
function renderChoice(side: Side, choice: ChoiceStatus): void {
  const pill = element(`choice-${side}`);
  const error = element(`choice-${side}-error`);

  pill.textContent = choice.label;
  pill.dataset.state = choice.state;
  error.hidden = choice.detail === undefined;
  error.textContent = choice.detail ?? "";
  error.title = choice.detail ?? "";
}

function renderLocal(next: ConfigState): void {
  const local = next.local;
  // The side shown, which only a click on a choice changes: not the server the window uses.
  const isLocal = next.viewing === "local";
  const inUse = next.inUse === "local";

  for (const radio of document.querySelectorAll<HTMLInputElement>(
    'input[name="where"]',
  )) {
    radio.checked = radio.value === next.viewing;
  }

  renderChoice("local", next.choices.local);
  renderChoice("remote", next.choices.remote);

  // Home and Settings → Server show the side chosen: switching on Home brings the other side's settings.
  element("preferences").hidden = !isLocal;
  element("server-local-settings").hidden = !isLocal;
  element("remote-settings-heading").hidden = isLocal;
  element("remote-settings-card").hidden = isLocal;
  element("server-intro").textContent = isLocal
    ? "Pi Pocket on this computer, and server extensions. To use another server, choose it on Home."
    : "The server this app connects to, and server extensions. To run Pi Pocket here, choose This computer on Home.";
  element("local-card").hidden = !isLocal;
  element("remote-card").hidden = isLocal;
  element("get-card").hidden = isLocal;
  element("remote-back-row").hidden = isLocal || !next.canReturn;
  element("remote-address").textContent = next.connectedUrl ?? "";
  element("connection-title").textContent =
    next.connectedUrl === undefined
      ? "Connect to your Pi Pocket server"
      : "Connected to your Pi Pocket server";
  element("local-address").textContent =
    local.status === "running" || local.status === "external"
      ? (local.url ?? "")
      : "";
  element("local-title").textContent = LOCAL_TITLES[local.status];

  const label = LOCAL_LABELS[local.status];
  const pill = element("local-status");

  pill.textContent = label.pill;
  pill.dataset.state = label.state;

  const versions =
    local.installed === undefined
      ? ""
      : `Pi Pocket ${local.installed.pocket}, Node.js ${local.installed.node}.`;
  const detail: Record<LocalState["status"], string> = {
    absent: "Downloads Pi Pocket and Node.js (about 60 MB; 400 MB on disk).",
    installing: local.message ?? "Installing…",
    stopped: inUse
      ? `${versions} It starts with the app.`
      : `${versions} Start runs it and opens it in this window.`,
    starting: `${versions} Starting…`,
    running: inUse
      ? `${versions} Open at ${local.url ?? ""}. Quitting the app stops the server. Sessions continue at the next start.`
      : `${versions} Runs at ${local.url ?? ""}, while the window uses another server. Open switches the window to it. Quitting the app stops the server.`,
    external: `${local.message ?? "Pi Pocket already runs on this port."} Open it, or stop it outside the app to run a server here.`,
    stopping: "Stopping…",
    failed:
      local.crash !== undefined
        ? `Stopped on its own. ${local.message ?? ""}`.trim()
        : (local.message ?? "Pi Pocket stopped."),
  };

  element("local-detail").textContent = detail[local.status];

  const bar = element("local-progress");
  const percent = local.progress?.percent;

  bar.hidden = local.status !== "installing";
  (bar.firstElementChild as HTMLElement).style.width =
    percent === undefined ? "100%" : `${String(percent)}%`;
  bar.classList.toggle("indeterminate", percent === undefined);

  const show = (action: string, visible: boolean) => {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      `.actions [data-local="${action}"]`,
    )) {
      button.hidden = !visible;
    }
  };
  const installed = local.installed !== undefined;

  show(
    "install",
    local.status === "absent" || (local.status === "failed" && !installed),
  );
  show(
    "start",
    installed && (local.status === "stopped" || local.status === "failed"),
  );
  // Open: one started outside the app, or the app's own while the window uses another server.
  show(
    "open",
    local.status === "external" ||
      (local.status === "running" && !(inUse && next.canReturn)),
  );
  show("restart", local.status === "running");
  show("stop", local.status === "running" || local.status === "starting");
  element("local-uninstall-row").hidden =
    !installed || local.status === "installing" || local.status === "stopping";
  // The window uses it and has it open: Show goes back to it, like Back to Pi Pocket.
  element("local-show").hidden = !(
    local.status === "running" &&
    inUse &&
    next.canReturn
  );
  element("local-restart-row").hidden = !local.restartNeeded;

  element<HTMLInputElement>("local-folder").placeholder = local.defaults.folder;
  element<HTMLInputElement>("local-data").placeholder = local.defaults.data;
  element("access-note").textContent =
    ACCESS_NOTES[next.settings.local.access] ?? "";

  const update = local.update;
  const updateStatus: Record<typeof update.status, string> = {
    idle: "Not checked yet",
    checking: "Checking…",
    current: "Up to date",
    building: `Installing Pi Pocket ${update.pocket ?? ""}${update.percent === undefined ? "" : ` (${String(update.percent)}%)`}…`,
    ready: `Pi Pocket ${update.pocket ?? ""} is ready`,
    error: "Server update failed",
  };

  element("local-update-status").textContent = updateStatus[update.status];
  element("local-update-detail").textContent =
    update.status === "error"
      ? (update.message ?? "")
      : update.status === "ready"
        ? "Restart Pi Pocket to use the update. You can also quit and reopen the app."
        : update.checkedAt === undefined
          ? ""
          : `Checked ${new Date(update.checkedAt).toLocaleString()}.`;
  element<HTMLButtonElement>("local-update-check").disabled =
    !installed ||
    update.status === "checking" ||
    update.status === "building" ||
    local.status === "installing";

  const log = element("local-log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;

  log.textContent = local.log.join("\n");

  if (atBottom) {
    log.scrollTop = log.scrollHeight;
  }

  element("local-log-box").hidden = local.log.length === 0;

  if (local.status === "failed") {
    (element("local-log-box") as HTMLDetailsElement).open = true;
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-local]",
)) {
  button.addEventListener("click", () => {
    void gui.local(button.dataset.local as LocalAction);
  });
}

for (const id of ["local-show", "remote-back"]) {
  element(id).addEventListener("click", () => {
    void gui.back();
  });
}

for (const radio of document.querySelectorAll<HTMLInputElement>(
  'input[name="where"]',
)) {
  radio.addEventListener("change", () => {
    if (radio.checked) {
      // Only shows that side: nothing connects, disconnects, starts, or stops.
      void gui.view(radio.value === "local" ? "local" : "remote");
    }
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-choose]",
)) {
  button.addEventListener("click", () => {
    const input = element<HTMLInputElement>(button.dataset.choose ?? "");

    void gui.chooseFolder(input.value || input.placeholder).then((folder) => {
      if (folder !== undefined) {
        input.value = folder;
        scheduleSave();
      }
    });
  });
}

function render(next: ConfigState): void {
  state = next;
  renderTheme(next);
  document.body.classList.toggle("recovering", next.recovery);
  element("recovery").hidden = !next.recovery;
  element("settings-page").hidden = next.recovery;
  element("settings-shortcut").textContent =
    `Open Desktop Settings from the tray menu, with a right-click on the page, or with ${next.platform === "darwin" ? "⌘ + comma" : "Ctrl + comma"}.`;
  renderLocal(next);
  renderDictation(next);
  renderRecent(next);
  renderAnywhere(next);
  renderBillionContext(next);
  renderRunner(next);
  element("app-version").textContent = next.appVersion;
  renderUpdate(next);
  element("config-path").textContent = next.configPath;

  if (!editing) {
    fillAddress(next.settings.server.url);
  }

  const message = reasonBanner(next.reason);

  banner.hidden = message === undefined;

  if (message !== undefined) {
    banner.textContent = message.text;
    banner.dataset.tone = message.tone;
  }

  back.hidden = !next.canReturn;
  renderGlance(next);

  // A new reason the app shows this screen for (a failure, the first run, this computer's server): Home says it.
  const why = JSON.stringify(next.reason);

  if (why !== lastReason) {
    lastReason = why;

    if (next.reason.kind !== "user" && view !== "home") {
      showView("home");
    }
  }

  const failing =
    next.reason.kind === "load-failed" ||
    next.reason.kind === "outage" ||
    next.reason.kind === "crashed" ||
    next.reason.kind === "not-detected";

  retry.hidden = !failing && next.nextRetryAt === undefined;

  if (connectedHere(next)) {
    showConnected(next);
  } else if (showDisconnected(next)) {
    // Said in the status: the connection dropped.
  } else if (
    !editing ||
    (next.probe !== undefined && sameUrl(next.probe.url, typedUrl()))
  ) {
    showStatus(next.probe);
  }

  updateConnect();

  window.clearInterval(countdown);
  countdown = undefined;

  if (next.nextRetryAt !== undefined) {
    const tick = () => {
      const left = Math.max(
        0,
        Math.round(((next.nextRetryAt ?? 0) - Date.now()) / 1000),
      );

      retryNote.textContent =
        left > 0 ? `Trying again in ${String(left)} s` : "Trying again…";
    };

    tick();
    countdown = window.setInterval(tick, 1000);
  } else {
    retryNote.textContent = "";
  }

  renderSettings(next);
}

// ——— Connection actions ———

async function check(): Promise<ProbeResult | undefined> {
  const url = typedUrl();

  if (url === "") {
    urlError.hidden = false;
    urlError.textContent = "Enter the server address.";

    return undefined;
  }

  const seq = ++checkSeq;

  checking = seq;
  showStatus(undefined);
  updateConnect();

  let result: ProbeResult;

  try {
    result = await gui.probe(url);
  } catch (error) {
    result = { kind: "unreachable", url, message: String(error) };
  }

  if (checking === seq) {
    checking = undefined;
  }

  // Editing while a request was in flight cancels that result, including a submit waiting to connect to it.
  if (seq !== checkSeq || url !== typedUrl()) {
    updateConnect();

    return undefined;
  }

  checked = result;
  checkedInput = url;
  showStatus(result);
  updateConnect();

  if (result.kind === "invalid") {
    urlError.hidden = false;
    urlError.textContent = result.message;
  }

  return result;
}

element("test").addEventListener("click", () => {
  void check();
});

element<HTMLFormElement>("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();

  if (connectButton.disabled) {
    return;
  }

  void (async () => {
    // An unknown HTML page needs a separate, explicit click after Check, not an automatic fallback.
    const previous = checkedHere();
    const allowUnverified = previous?.kind === "other" && previous.canOpen;
    const result = await check();

    if (
      result === undefined ||
      (result.kind !== "detected" &&
        !(allowUnverified && result.kind === "other" && result.canOpen))
    ) {
      return;
    }

    connecting = true;
    updateConnect();

    try {
      const found = await gui.connect(result.url, allowUnverified);

      checked = found;
      checkedInput = typedUrl();

      if (
        found.kind === "detected" ||
        (allowUnverified && found.kind === "other" && found.canOpen)
      ) {
        editing = false;
      }

      render(await gui.state());

      if (found.kind !== "detected") {
        showStatus(found);
      }
    } catch (error) {
      urlError.hidden = false;
      urlError.textContent = `Could not connect: ${String(error)}`;
    } finally {
      connecting = false;
      updateConnect();
    }
  })();
});

retry.addEventListener("click", () => {
  void gui.retryNow();
});

back.addEventListener("click", () => {
  void gui.back();
});

element("server-settings").addEventListener("click", () => {
  void gui.openSettings();
});

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-open]",
)) {
  button.addEventListener("click", () => {
    void gui.openExternal(button.dataset.open as "github" | "docs");
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-copy]",
)) {
  button.addEventListener("click", () => {
    const text = element(button.dataset.copy ?? "").textContent ?? "";

    void navigator.clipboard.writeText(text).then(() => {
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1500);
    });
  });
}

element("show-file").addEventListener("click", () => {
  void gui.showConfigFile();
});

// ——— Settings ———

const settingInputs = [
  ...document.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("[data-key]"),
];

function read(settings: Settings, key: string): unknown {
  const [section, name] = key.split(".") as [keyof Settings, string];

  return (settings[section] as Record<string, unknown>)[name];
}

function renderSettings(next: ConfigState): void {
  for (const input of settingInputs) {
    // Being typed in, or set by a button and not saved yet (the dictation key): keep what the person chose.
    if (input === document.activeElement || input.dataset.pending === "true") {
      continue;
    }

    const value = read(next.settings, input.dataset.key ?? "");

    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      input.checked = value === true;
    } else if (Array.isArray(value)) {
      input.value = value.join("\n");
    } else {
      input.value = String(value);
    }
  }

  renderAppearance(next);
  renderTitleBar(next);

  element("tray-note").textContent = next.trayAvailable
    ? "Keep the app running for notifications after you close the window."
    : "No tray is available, so closing minimizes the window. On GNOME, install the AppIndicator extension to add a tray.";

  const problems = element("problems");
  const list = element("problem-list");

  problems.hidden = next.problems.length === 0;
  list.replaceChildren(
    ...next.problems.map((problem) => {
      const item = document.createElement("li");
      const path = document.createElement("code");

      path.textContent = problem.path;
      item.append(path, ` ${problem.message}`);

      return item;
    }),
  );
}

function collect(): Settings {
  const settings = structuredClone(state!.settings);

  for (const input of settingInputs) {
    const [section, name] = (input.dataset.key ?? "").split(".") as [
      keyof Settings,
      string,
    ];
    const target = settings[section] as Record<string, unknown>;
    let value: unknown;

    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      value = input.checked;
    } else if (
      input instanceof HTMLInputElement &&
      (input.type === "number" || input.type === "range")
    ) {
      value = input.value === "" ? Number.NaN : Number(input.value);
    } else if (input instanceof HTMLTextAreaElement) {
      value = input.value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    } else {
      value = input.value;
    }

    target[name] = value;
  }

  return settings;
}

let saveTimer: number | undefined;

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void (async () => {
      const sent = new Map(settingInputs.map((input) => [input, input.value]));
      const next = await gui.save(collect());

      // Saved now, unless changed again while this save was on its way.
      for (const input of settingInputs) {
        if (sent.get(input) === input.value) {
          delete input.dataset.pending;
        }
      }

      render(next);
      saved.textContent =
        next.problems.length === 0 ? "Saved" : "Saved. Check the values above.";
      window.setTimeout(() => {
        saved.textContent = "";
      }, 2000);
    })();
  }, 300);
}

/** The title bar: a change takes a new window. Seamless on Windows and Linux has no menu bar to show. */
function renderTitleBar(next: ConfigState): void {
  const chosen = next.settings.window.titleBar;

  element("title-bar-restart").hidden = chosen === next.titleBarAtStart;
  element("menu-bar-row").hidden =
    next.platform === "darwin" || next.titleBarAtStart === "seamless";
  element("title-bar-note").textContent =
    next.platform === "darwin"
      ? "Seamless puts the window buttons over the page."
      : "Seamless puts the window buttons over the page. Menu shortcuts still work, such as Ctrl + comma for Desktop Settings.";
}

/** The Appearance card: what this desktop can do, and the config screen itself see-through like the server's page. */
function renderAppearance(next: ConfigState): void {
  const appearance = next.settings.appearance;
  const support = next.translucency;
  const toggle = document.querySelector<HTMLInputElement>(
    '[data-key="appearance.translucent"]',
  )!;
  const note = element("translucent-note");

  for (const row of document.querySelectorAll<HTMLElement>("[data-platform]")) {
    row.hidden = row.dataset.platform !== next.platform;
  }

  if (support.kind === "unsupported") {
    note.textContent = support.message;
    toggle.disabled = true;
  } else {
    toggle.disabled = false;
    note.textContent =
      next.platform === "linux"
        ? "Shows the desktop behind Pi Pocket. Enable blur in Hyprland (decoration:blur) or KDE (Blur effect). GNOME shows no blur."
        : "Show the desktop behind Pi Pocket, with blur.";
  }

  // Linux: on takes a new window; off works now, but the window stays see-through-capable until a restart.
  element("translucent-restart").hidden = !(
    next.platform === "linux" &&
    appearance.translucent !== next.translucentAtStart
  );

  const live = appearance.translucent && support.kind === "live";

  for (const row of element("appearance-card").querySelectorAll<HTMLElement>(
    ".row",
  )) {
    // The tray menu is its own setting: it stays usable while translucency is off.
    if (
      row.contains(toggle) ||
      row.id === "translucent-restart" ||
      row.id === "tray-menu-row"
    ) {
      continue;
    }

    row.classList.toggle("off", !appearance.translucent);
  }

  showOpacity(appearance.opacity);
  document.documentElement.dataset.translucent = live ? "on" : "off";
}

function showOpacity(value: number): void {
  element("opacity-value").textContent = `${String(value)}%`;
  document.documentElement.style.setProperty("--opacity", `${String(value)}%`);
}

for (const input of settingInputs) {
  input.addEventListener("change", scheduleSave);
}

// The opacity follows the slider as it moves; the save waits for the slider to settle.
const opacity = document.querySelector<HTMLInputElement>(
  '[data-key="appearance.opacity"]',
)!;

opacity.addEventListener("input", () => {
  showOpacity(Number(opacity.value));
  scheduleSave();
});

for (const button of document.querySelectorAll("[data-relaunch]")) {
  button.addEventListener("click", () => {
    void gui.relaunch();
  });
}

element<HTMLFormElement>("settings-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
  },
);

// ——— Dictation ———

function formatSize(bytes: number): string {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${String(Math.max(1, Math.round(bytes / 1e6)))} MB`;
}

/** Runs a dictation action; a failure shows in the card. */
function dictationAction(
  type: "download" | "cancel" | "remove" | "use",
  id: string,
): void {
  gui.dictation({ type, id }).catch((error: unknown) => {
    const message = element("dictation-message");

    message.textContent = (error as Error).message;
    message.hidden = false;
  });
}

function modelRow(model: DictationModelState, busy: boolean): HTMLElement {
  const row = document.createElement("div");
  const text = document.createElement("span");
  const name = document.createElement("strong");
  const about = document.createElement("small");
  const buttons = document.createElement("span");

  row.className = "row model";
  row.dataset.chosen = String(model.chosen);
  row.dataset.downloading = String(model.download !== undefined);
  name.textContent = model.name;

  if (model.recommended) {
    const tag = document.createElement("em");

    tag.textContent = "Recommended";
    name.append(" ", tag);
  }

  if (model.chosen) {
    const tag = document.createElement("em");

    tag.className = "in-use";
    tag.textContent = "In use";
    name.append(" ", tag);
  }

  about.textContent = `${model.languages} · ${formatSize(model.size)} · ${model.note} ${model.license}.`;
  text.append(name, about);
  buttons.className = "buttons";

  const button = (
    label: string,
    type: "download" | "cancel" | "remove" | "use",
    kind = "secondary",
  ): void => {
    const each = document.createElement("button");

    each.type = "button";
    each.className = kind;
    each.textContent = label;
    each.addEventListener("click", () => {
      if (
        type === "remove" &&
        !confirm(`Remove ${model.name}? It can be downloaded again.`)
      ) {
        return;
      }

      dictationAction(type, model.id);
    });
    buttons.append(each);
  };

  if (model.download !== undefined) {
    const progress = document.createElement("span");
    const bar = document.createElement("div");
    const fill = document.createElement("div");
    const step = document.createElement("small");

    progress.className = "model-progress";
    bar.className = "progress";
    fill.style.width = `${String(model.download.percent)}%`;
    bar.append(fill);
    step.textContent = `${model.download.step} ${String(model.download.percent)}%`;
    progress.append(bar, step);
    text.append(progress);
    button("Cancel", "cancel");
  } else if (model.installed) {
    if (!model.chosen) {
      button("Use", "use");
    }

    button("Remove", "remove", "secondary danger");

    // Removing waits for a download: they share the engine.
    for (const each of buttons.querySelectorAll("button")) {
      each.disabled = busy;
    }
  } else {
    button("Download", "download");
    buttons.querySelector("button")!.disabled = busy;
  }

  row.append(text, buttons);

  return row;
}

const modelsSection = element<HTMLDetailsElement>("dictation-models-section");
const modelsList = element("dictation-models");
let modelsDownloading = false;

function updateModelsFade(): void {
  modelsList.classList.toggle(
    "has-more",
    modelsList.scrollTop + modelsList.clientHeight <
      modelsList.scrollHeight - 1,
  );
}

modelsList.addEventListener("scroll", updateModelsFade);
if (typeof ResizeObserver !== "undefined")
  new ResizeObserver(updateModelsFade).observe(modelsList);

function revealImportantModel(): void {
  const list = element("dictation-models");
  const row =
    list.querySelector<HTMLElement>("[data-downloading='true']") ??
    list.querySelector<HTMLElement>("[data-chosen='true']");

  if (row) {
    list.scrollTop +=
      row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }
}

element("dictation-models-toggle").addEventListener("click", (event) => {
  if (modelsSection.open && modelsDownloading) event.preventDefault();
});
modelsSection.addEventListener("toggle", () => {
  if (!modelsSection.open && modelsDownloading) modelsSection.open = true;
  if (modelsSection.open) {
    revealImportantModel();
    updateModelsFade();
  }
});

function renderDictation(next: ConfigState): void {
  const dictation = next.dictation;
  const card = element("dictation-card");
  const list = element("dictation-models");
  const message = element("dictation-message");

  element("dictation-engine-size").textContent = dictation.engine.installed
    ? "installed"
    : `${formatSize(dictation.engine.size)}`;
  element("dictation-folder").textContent = dictation.folder;
  message.hidden = dictation.message === undefined;
  message.textContent = dictation.message ?? "";

  if (!dictation.supported) {
    element("dictation-note").textContent =
      "Dictation is not available for this computer's operating system or processor.";
    list.replaceChildren();
    card
      .querySelectorAll<HTMLElement>(".row")
      .forEach((row) => row.classList.add("off"));

    return;
  }

  const chosen = dictation.models.find((model) => model.chosen);
  const installed = dictation.models.some((model) => model.installed);
  element("dictation-models-summary").textContent = chosen
    ? `· ${chosen.name} in use`
    : installed
      ? "· none in use"
      : "· none downloaded";
  const started = dictation.downloading && !modelsDownloading;
  modelsDownloading = dictation.downloading;
  list.replaceChildren(
    ...dictation.models.map((model) => modelRow(model, dictation.downloading)),
  );
  if (modelsSection.open) updateModelsFade();
  if (started) {
    modelsSection.open = true;
    revealImportantModel();
  }
}

// ——— Recent dictations ———

/** When a dictation ended: the time of day, with the date when it was not today. Never goes stale on screen. */
function whenSaid(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function recentRow(each: RecentDictation): HTMLElement {
  const row = document.createElement("div");
  const text = document.createElement("span");
  const words = document.createElement("p");
  const about = document.createElement("small");
  const copy = document.createElement("button");

  row.className = "row recent-item";
  words.className = "recent-text";
  words.textContent = each.text;
  // Long words stay folded to a few lines; a click shows all of them.
  words.title = "Click to show all";
  words.addEventListener("click", () => {
    // Selecting some of the words is no click to fold them.
    if (window.getSelection()?.isCollapsed === false) return;
    words.classList.toggle("open");
  });
  about.textContent = [
    whenSaid(each.at),
    each.where === "anywhere" ? "Dictate anywhere" : "Pi Pocket",
    ...(each.dropped === true ? ["dropped, not pasted"] : []),
    ...(each.error !== undefined ? [`stopped: ${each.error}`] : []),
  ].join(" · ");
  about.classList.toggle("error", each.error !== undefined);
  text.append(words, about);
  copy.type = "button";
  copy.className = "secondary";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(each.text).then(() => {
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1500);
    });
  });
  row.append(text, copy);

  return row;
}

/** The ids the list shows now: it is drawn again only when they change, so a click on Copy or on folded words holds. */
let recentShown = "";

function renderRecent(next: ConfigState): void {
  const recent = next.dictation.recent;
  const shown = recent.map((each) => each.id).join(",");

  element("dictation-recent-summary").textContent =
    recent.length === 0 ? "· none yet" : `· ${String(recent.length)}`;
  element("dictation-recent-actions").hidden = recent.length === 0;

  if (shown === recentShown) return;

  recentShown = shown;
  element("dictation-recent").replaceChildren(...recent.map(recentRow));
}

element("dictation-recent-clear").addEventListener("click", () => {
  void gui.clearRecentDictations();
});

/** Dictate anywhere's card: its status, and the notes for this computer's keyboard and desktop. */
function renderAnywhere(next: ConfigState): void {
  const anywhere = next.anywhere;
  const settings = next.settings.anywhere;
  const mac = next.platform === "darwin";
  const ready = next.dictation.models.some(
    (model) => model.chosen && model.installed,
  );
  const message = element("anywhere-message");
  if (keyRecording === undefined) {
    element("dictation-key-label").textContent =
      next.dictationKeyLabel === "" ? "None" : next.dictationKeyLabel;
  }

  element<HTMLButtonElement>("dictation-key-auto").disabled =
    next.settings.dictation.key === "auto";
  element<HTMLButtonElement>("dictation-key-off").disabled =
    next.settings.dictation.key === "off";

  message.hidden = anywhere.message === undefined;
  message.textContent = anywhere.message ?? "";
  element("anywhere-permission").hidden = !(
    mac &&
    settings.enabled &&
    anywhere.permission === true
  );
  element("anywhere-status").textContent = !settings.enabled
    ? "Off"
    : anywhere.status === "recording"
      ? "Recording now"
      : anywhere.status === "working"
        ? "Transcribing"
        : anywhere.status === "error"
          ? "Cannot run: see above"
          : ready
            ? "On: press the key in any app"
            : "On, but no speech model is downloaded yet";

  const key = next.settings.dictation.key;

  if (keyRecording === undefined) {
    element("dictation-key-note").textContent =
      key === "off"
        ? "No key: use the mic button, or Alt+V in Pi Pocket. Click to set one."
        : !mac && key.split("+").includes("AltRight")
          ? "On many keyboards Right Alt is AltGr, which types characters such as @ or €: those still work, but pick another key if you use them often."
          : "It turns on the mic of the session in front, or dictates anywhere. Click to set another key or combination.";
  }
  element("anywhere-output-note").textContent = anywhere.copyOnly
    ? "On Wayland the words are always copied: paste them yourself."
    : "Pasting puts back what you had copied.";

  const tip = element("anywhere-tip");

  tip.hidden = !(next.platform === "win32" || mac);
  tip.textContent =
    next.platform === "win32"
      ? "Tip: Windows keeps apps run as administrator apart. To dictate into those, run Pi Pocket as administrator too."
      : "macOS asks once to let Pi Pocket use Accessibility (to see the key and paste) and the microphone.";
}

element("anywhere-reset").addEventListener("click", () => {
  const button = element<HTMLButtonElement>("anywhere-reset");

  button.disabled = true;
  void gui.resetAccessibility().then((removed) => {
    button.disabled = false;
    element("anywhere-permission-note").textContent = removed
      ? "Asked: allow Pi Pocket in the window macOS shows."
      : "Could not remove it. In System Settings → Privacy & Security → Accessibility, remove Pi Pocket with −, then turn Dictate anywhere off and on.";
  });
});

element("dictation-show-folder").addEventListener("click", () => {
  void gui.showDictationFolder();
});

gui.onFocus((section) => {
  if (section === "home" || (SECTIONS as readonly string[]).includes(section)) {
    go(section);
  }
});

// ——— Billion context ———

function billionContextAction(action: BillionContextAction): void {
  gui.billionContext(action).catch(() => {
    // The error shows in the card, through the state.
  });
}

function renderBillionContext(next: ConfigState): void {
  const extension = next.billionContext;
  const remote = extension.server === "remote";
  const installed = extension.installed;
  const runtime = extension.extension?.runtime;
  const busy = extension.busy !== undefined || runtime?.busy === true;
  const running = extension.server === "running";
  const message = element("bc-message");
  const shown = (id: string, visible: boolean): void => {
    const button = element<HTMLButtonElement>(id);

    button.hidden = !visible;
    button.disabled = busy;
  };

  element("bc-local").hidden = remote;
  element("bc-remote").hidden = !remote;
  element("bc-command").textContent = extension.command;
  element("bc-folder").textContent = extension.folder;
  message.hidden = extension.message === undefined;
  message.textContent = extension.message ?? "";

  const updates = extension.extension?.updates;
  const available =
    extension.updateAvailable ||
    runtime?.updateAvailable === true ||
    updates?.available === true;
  const checkedAt = updates?.checkedAt ?? extension.checkedAt;
  const version = runtime?.version ?? installed?.version ?? "?";
  const bundled = installed?.bundled === true;
  let status: string;
  let detail =
    extension.message ??
    updates?.error ??
    (available
      ? `Update available: BCP ${updates?.latest?.version ?? extension.latest?.version ?? runtime?.availableVersion ?? "?"}`
      : checkedAt === undefined
        ? ""
        : `Up to date · checked ${new Date(checkedAt).toLocaleString()}`);

  if (installed === undefined) {
    status = "Not installed";
    detail = extension.foreign
      ? "Installed under another name. Manage it in Menu → Extensions, or remove that copy before installing here."
      : extension.server === "absent"
        ? "First, install Pi Pocket under This computer on Home."
        : extension.server === "stopped"
          ? "Start Pi Pocket before installing or turning on the extension."
          : "Download the extension, turn it on, and install its pinned runtime.";
  } else if (installed.enabled === false) {
    status = "Off in Menu → Extensions";
  } else if (runtime?.state === "error" || installed.error !== undefined) {
    status = "Needs repair";
    detail = runtime?.error ?? installed.error ?? "";
  } else if (runtime?.state === "installed") {
    status = `Active · BCP ${version}`;
  } else if (
    runtime?.state === "legacy" ||
    (bundled && installed.enabled === true)
  ) {
    status = `Active · BCP ${version} (bundled copy)`;
  } else if (runtime?.state === "uninstalled") {
    status = "Program uninstalled · Pi Pocket manages context";
  } else {
    status = "Program not installed";
  }

  if (installed !== undefined && !running) {
    detail = `${detail} Start Pi Pocket to turn it on or off.`.trim();
  }

  element("bc-status").textContent = extension.busy ?? status;
  element("bc-detail").textContent = detail;
  element("bc-install").textContent =
    installed === undefined ||
    runtime?.state === "absent" ||
    runtime?.state === "uninstalled"
      ? "Install"
      : extension.updateAvailable || runtime?.updateAvailable === true
        ? "Update"
        : "Reinstall";
  shown("bc-install", !extension.foreign && running);
  shown("bc-check", installed !== undefined);
  shown(
    "bc-uninstall",
    running &&
      (bundled ||
        runtime?.state === "installed" ||
        runtime?.state === "legacy" ||
        runtime?.state === "error"),
  );
}

for (const [id, action] of [
  ["bc-install", "install"],
  ["bc-check", "check"],
  ["bc-uninstall", "uninstall"],
  ["bc-show-folder", "show-folder"],
] as const) {
  element(id).addEventListener("click", () => billionContextAction(action));
}

element("bc-page").addEventListener("click", (event) => {
  event.preventDefault();
  billionContextAction("open-page");
});

// ——— Runner ———

const RUNNER_STATUS: Record<RunnerState["status"], string> = {
  unlinked: "Not linked",
  off: "Turned off",
  connecting: "Connecting…",
  connected: "Connected",
  failed: "Stopped",
  ended: "Link ended",
  stopping: "Stopping…",
};

function renderRunner(next: ConfigState): void {
  const runner = next.runner;
  const link = runner.link;
  const busy = runner.busy !== undefined;
  let detail: string;

  if (link === undefined) {
    detail = "Not linked to a server yet.";
  } else if (runner.status === "connected") {
    detail = `Linked as “${link.name}” to ${link.server}. Sessions can use this computer.`;
  } else {
    detail = `Linked as “${link.name}” to ${link.server}.${runner.message === undefined ? "" : ` ${runner.message}`}`;
  }

  element("runner-status").textContent =
    runner.busy ?? RUNNER_STATUS[runner.status] ?? "";
  element("runner-detail").textContent = detail;
  // The form shows until a link works: also after the server ended one, to link again.
  const linking = link === undefined || runner.status === "ended";

  element("runner-link-form").hidden = !linking;
  // The link form says what linking means; once linked, this note says it, once at a time.
  element("runner-linked-note").hidden = linking;
  element<HTMLButtonElement>("runner-link").disabled = busy;

  const address = element<HTMLInputElement>("runner-server");

  if (address.value === "" && document.activeElement !== address) {
    address.value = link?.server ?? runner.suggestedServer ?? "";
  }
  element("runner-enabled-row").classList.toggle("off", link === undefined);
  element("runner-confirm-error").hidden = runner.confirmError === undefined;
  element("runner-confirm-error").textContent = runner.confirmError ?? "";

  const restart = element<HTMLButtonElement>("runner-restart");
  const unlink = element<HTMLButtonElement>("runner-unlink");

  restart.hidden =
    link === undefined || !runner.enabled || runner.status === "connected";
  restart.disabled = busy;
  unlink.hidden = link === undefined;
  unlink.disabled = busy;

  element("runner-folders-error").hidden = runner.foldersError === undefined;
  element("runner-folders-error").textContent = runner.foldersError ?? "";
  const folders = element("runner-folders");

  folders.replaceChildren();

  if (runner.folders === undefined || runner.folders.length === 0) {
    const empty = document.createElement("p");

    empty.className = "row-note";
    empty.textContent =
      runner.folders === undefined
        ? runner.foldersError === undefined
          ? "Loading allowed folders…"
          : "Allowed folders are unavailable."
        : "No allowed folders yet. A folder is added when you allow a session in it.";
    folders.append(empty);
  } else {
    for (const folder of runner.folders) {
      const row = document.createElement("div");
      const name = document.createElement("span");
      const remove = document.createElement("button");

      row.className = "row";
      name.textContent = folder;
      name.style.overflowWrap = "anywhere";
      remove.type = "button";
      remove.className = "secondary danger";
      remove.textContent = "Remove";
      remove.disabled = busy;
      remove.setAttribute("aria-label", `Remove allowed folder ${folder}`);
      remove.addEventListener("click", () => {
        void gui.runnerFolders(folder).catch(() => {});
      });
      row.append(name, remove);
      folders.append(row);
    }
  }

  element("runner-log-box").hidden = runner.log.length === 0;
  element("runner-log").textContent = runner.log.join("\n");
}

/** The Runner card's Link: `runner link <server> <code>`, as on any computer. (Inside the settings form: no form here.) */
function linkRunner(): void {
  const error = element("runner-link-error");
  const code = element<HTMLInputElement>("runner-code");

  error.hidden = true;
  gui
    .linkRunner({
      server: element<HTMLInputElement>("runner-server").value,
      code: code.value,
    })
    .then(() => {
      code.value = "";
    })
    .catch((failure: unknown) => {
      // Electron puts "Error invoking remote method 'config:link-runner': Error: " in front of the message.
      error.textContent = (failure as Error).message.replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        "",
      );
      error.hidden = false;
    });
}

element("runner-link").addEventListener("click", linkRunner);
// The allowed folders, read when this screen loads; the app reads them again each time Settings opens.
void gui.runnerFolders().catch(() => {});

for (const id of ["runner-server", "runner-code"]) {
  element(id).addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") {
      event.preventDefault();
      linkRunner();
    }
  });
}

element("runner-restart").addEventListener("click", () => {
  gui.runner("restart").catch(() => {});
});
element("runner-unlink").addEventListener("click", () => {
  gui.runner("unlink").catch(() => {});
});

// ——— Home at a glance ———

function tile(
  id: string,
  pill: { text: string; state: string },
  text: string,
  title?: string,
): void {
  const badge = element(`tile-${id}-pill`);

  badge.textContent = pill.text;
  badge.dataset.state = pill.state;
  element(`tile-${id}-text`).textContent = text;

  if (title !== undefined) {
    element(`tile-${id}-title`).textContent = title;
  }
}

/** The status by Home in the sidebar, and the Runner, Updates, and Dictation tiles: each opens its section. */
function renderGlance(next: ConfigState): void {
  const choice = next.choices[next.viewing];
  const dot = element("nav-status");

  dot.dataset.state = choice.state;
  element("nav-status-text").textContent = choice.label;

  const runner = next.runner;

  tile(
    "runner",
    {
      text:
        runner.link === undefined
          ? "Not linked"
          : (RUNNER_STATUS[runner.status] ?? ""),
      state:
        runner.status === "connected"
          ? "connected"
          : runner.status === "failed" || runner.status === "ended"
            ? "not-detected"
            : runner.link === undefined
              ? "checking"
              : "other",
    },
    runner.link === undefined
      ? "Let your server use this computer's files and commands."
      : `Linked as “${runner.link.name}” to ${runner.link.server}.`,
  );

  const update = next.update;
  const waiting = update.status === "available" || update.status === "ready";

  tile(
    "updates",
    {
      text: waiting
        ? (update.version ?? "New")
        : update.status === "error"
          ? "Failed"
          : update.status === "checking" || update.status === "downloading"
            ? "Checking"
            : next.appVersion,
      state: waiting
        ? "other"
        : update.status === "error"
          ? "not-detected"
          : update.status === "current"
            ? "connected"
            : "checking",
    },
    update.status === "ready"
      ? "Restart the app to finish the update."
      : update.status === "available"
        ? "A new version of the desktop app is available."
        : update.status === "error"
          ? "The last update check failed."
          : "The desktop app is up to date.",
    update.status === "ready"
      ? "Update ready"
      : update.status === "available"
        ? "Update available"
        : "Updates",
  );

  const dictation = next.dictation;
  const model = dictation.models.find((each) => each.chosen);

  tile(
    "dictation",
    {
      text: !dictation.supported
        ? "Unavailable"
        : model !== undefined
          ? "On"
          : "Off",
      state: model !== undefined ? "connected" : "checking",
    },
    !dictation.supported
      ? "Not available on this computer."
      : model !== undefined
        ? `${model.name}. Audio stays on this computer.${next.settings.anywhere.enabled ? " Dictate anywhere is on." : ""}`
        : "Download a speech model to talk to Pi offline.",
  );
}

// ——— The dictation key: click, press a key or combination, let go ———

/** The keys held now while recording (KeyboardEvent.code); undefined when not recording. */
let keyRecording: Set<string> | undefined;
/** Every key pressed during this recording: the combination, saved when all are let go. */
let keyPressed = new Set<string>();
const keyButton = element<HTMLButtonElement>("dictation-key-record");

function keyRecordEnd(): void {
  if (keyRecording === undefined) {
    return;
  }

  keyRecording = undefined;
  keyButton.dataset.recording = "false";
  void gui.recordKey(false);

  if (state !== undefined) {
    render(state);
  }
}

function setDictationKey(value: string): void {
  const input = element<HTMLInputElement>("dictation-key");

  input.value = value;
  input.dataset.pending = "true";
  scheduleSave();
}

keyButton.addEventListener("click", () => {
  if (keyRecording !== undefined) {
    keyRecordEnd();

    return;
  }

  keyRecording = new Set();
  keyPressed = new Set();
  keyButton.dataset.recording = "true";
  element("dictation-key-label").textContent = "Press keys…";
  element("dictation-key-note").textContent =
    "Press a key or a combination, then let go. Escape cancels.";
  void gui.recordKey(true);
});

element("dictation-key-auto").addEventListener("click", () => {
  keyRecordEnd();
  setDictationKey("auto");
});

element("dictation-key-off").addEventListener("click", () => {
  keyRecordEnd();
  setDictationKey("off");
});

/** A key while recording: held keys build the combination; letting all go saves it. */
function keyRecorded(event: KeyboardEvent): void {
  if (keyRecording === undefined) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  if (event.type === "keydown") {
    if (event.repeat) {
      return;
    }

    if (event.code === "Escape" && keyRecording.size === 0) {
      keyRecordEnd();

      return;
    }

    keyRecording.add(event.code);
    keyPressed.add(event.code);

    const keys = [...keyPressed].join("+");

    void gui.checkKey(keys).then((checked) => {
      if (keyRecording !== undefined && [...keyPressed].join("+") === keys) {
        element("dictation-key-label").textContent = checked.ok
          ? checked.label
          : keys.replaceAll("+", " + ");
      }
    });

    return;
  }

  keyRecording.delete(event.code);

  if (keyRecording.size > 0 || keyPressed.size === 0) {
    return;
  }

  const keys = [...keyPressed].join("+");

  keyPressed = new Set();
  void gui.checkKey(keys).then((checked) => {
    if (!checked.ok) {
      element("dictation-key-label").textContent = "Press keys…";
      element("dictation-key-note").textContent = checked.problem;

      return;
    }

    keyRecordEnd();
    element("dictation-key-label").textContent = checked.label;
    setDictationKey(checked.key);
  });
}

// While recording, every key goes to the recorder, wherever the focus is; leaving the window stops it.
if (typeof document.addEventListener === "function") {
  document.addEventListener("keydown", keyRecorded, true);
  document.addEventListener("keyup", keyRecorded, true);
  window.addEventListener("blur", keyRecordEnd);
}

// Esc: back to Pi Pocket, as the sidebar's button.
if (typeof document.addEventListener === "function") {
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !back.hidden &&
      !event.defaultPrevented &&
      !(event.target instanceof HTMLSelectElement)
    ) {
      void gui.back();
    }
  });
}

// ——— Start ———

gui.onState(render);
void gui.state().then(render);

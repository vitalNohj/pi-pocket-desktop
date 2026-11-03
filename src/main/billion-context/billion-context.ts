/**
 * billion-context-pi-pocket in this computer's Pi Pocket: installs, updates, and removes the drop-in extension.
 * Files come from a checked commit of its main branch. Pi Pocket's owner API controls activation; its config and
 * conversation state are never written here. Old GUI installations migrate with their identity and state path intact.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BillionContextState, Settings } from "../../shared/types";
import { downloadChecked } from "../core/download";

export const INTEGRATION = {
    repo: "vitalNohj/billion-context-pi-pocket",
    branch: "main",
    file: "billion-context-pi-pocket.ts",
    folder: "billion-context-pi-pocket",
    settings: "billion-context-pi-pocket.json",
} as const;

export const LEGACY_INTEGRATION = {
    file: "billion-context-pi-pocket-adapter.ts",
    folder: "billion-context-pi-pocket-adapter",
    settings: "billion-context-pi-pocket-adapter.json",
} as const;

export const INTEGRATION_PAGE = `https://github.com/${INTEGRATION.repo}`;

/** A remote server is not managed here. Refuse an old installation rather than create a second module beside it. */
export const REMOTE_COMMAND =
    `cd ~/.pi-pocket/extensions && ` +
    `if [ -e ${LEGACY_INTEGRATION.file} ] || [ -e ${LEGACY_INTEGRATION.folder} ] || [ -e ${LEGACY_INTEGRATION.settings} ] || ` +
    `{ [ -e ${INTEGRATION.folder} ] && [ ! -e ${INTEGRATION.file} ]; }; then ` +
    `printf '%s\\n' 'An existing installation needs manual migration. Follow the migration instructions at ${INTEGRATION_PAGE} before installing.'; false; ` +
    `else curl -fsSL https://codeload.github.com/${INTEGRATION.repo}/tar.gz/${INTEGRATION.branch} | ` +
    `tar -xz --strip-components=1 ${INTEGRATION.folder}-${INTEGRATION.branch}/${INTEGRATION.file} ${INTEGRATION.folder}-${INTEGRATION.branch}/${INTEGRATION.folder}; fi`;

/** In the helper folder: which commit the app installed. Its absence means someone else installed the files. */
const MARKER = ".pi-pocket-gui.json";

export interface TreeEntry {
    path: string;
    mode: string;
    type: string;
    sha: string;
    size?: number;
}

/** Only the new module and its helper files come from the repository; never repository settings or user state. */
export function integrationFiles(tree: readonly TreeEntry[]): TreeEntry[] {
    const files = tree.filter((entry) => entry.type === "blob" && (entry.path === INTEGRATION.file || entry.path.startsWith(`${INTEGRATION.folder}/`)));

    if (!files.some((entry) => entry.path === INTEGRATION.file) || !files.some((entry) => entry.path === `${INTEGRATION.folder}/bundle.json`)) {
        throw new Error("This extension version is missing required files.");
    }

    for (const entry of files) {
        if ((entry.mode !== "100644" && entry.mode !== "100755") || entry.path.split("/").some((part) => part === ".." || part === "")) {
            throw new Error(`${entry.path} in the extension repository is not a regular file.`);
        }
    }

    return files;
}

/** Git's hash of a file's content (a blob): what the commit's tree lists for it. */
export function blobSha(data: Buffer): string {
    return createHash("sha1").update(`blob ${String(data.length)}\0`).update(data).digest("hex");
}

export interface BillionContextHost {
    /** The app's own folder for downloads while installing. */
    home: string;
    platform: NodeJS.Platform;
    settings: () => Settings;
    /** Pi Pocket's data folder on this computer: its drop-in folder and its owner token are in it. */
    dataFolder: () => string;
    /** This computer's Pi Pocket, as the app runs it: its address while it runs, and whether it is installed. */
    local: () => { installed: boolean; url: string | undefined };
    /** Requests to GitHub. */
    fetch: (url: string, headers?: Record<string, string>) => Promise<Response>;
    /** Requests to this computer's Pi Pocket. */
    request: (url: string, init: RequestInit) => Promise<Response>;
    changed: () => void;
}

interface Installed {
    layout: typeof INTEGRATION | typeof LEGACY_INTEGRATION;
    /** billion-context-pi's version, from the helper folder's bundle.json. */
    version: string;
    /** The commit the app installed; undefined when the files came from elsewhere. */
    commit?: string;
}

const LAYOUTS = [INTEGRATION, LEGACY_INTEGRATION] as const;
const TRANSACTION = `_${INTEGRATION.folder}.update`;
const SAVED_PATHS: readonly string[] = [INTEGRATION.file, INTEGRATION.folder, INTEGRATION.settings, LEGACY_INTEGRATION.file, LEGACY_INTEGRATION.folder];

interface Transaction {
    version: 1;
    previous: "current" | "legacy" | null;
    wasOn: boolean;
    present: string[];
    committed: boolean;
}

/** Pin the old defaults as well as explicit overrides. Conversations and checkpoints store these identifiers. */
export function legacySettings(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("The extension settings must hold a JSON object. Nothing was installed.");
    }

    const settings = value as Record<string, unknown>;

    for (const key of ["extensionName", "stateDir", "billionContextPi"]) {
        if (settings[key] !== undefined && (typeof settings[key] !== "string" || settings[key] === "")) {
            throw new Error(`The extension setting "${key}" must be a non-empty string. Nothing was installed.`);
        }
    }

    return { ...settings, extensionName: settings.extensionName ?? "billion-context-pi", stateDir: settings.stateDir ?? "billion-context-pi" };
}

interface ExtensionInfo {
    file: string;
    enabled: boolean;
    error?: string;
}

export function setUpBillionContext(host: BillionContextHost) {
    let busy: string | undefined;
    let message: string | undefined;
    let latest: { commit: string; version?: string } | undefined;
    let checkedAt: number | undefined;
    /** What Pi Pocket said about the extension, the last time it was asked. */
    let modules: ExtensionInfo[] = [];

    const folder = () => join(host.dataFolder(), "extensions");
    const transactionFolder = () => join(folder(), TRANSACTION);
    const presentLayouts = () => LAYOUTS.filter((layout) => existsSync(join(folder(), layout.file)));
    const moduleInfo = () => {
        const file = installed()?.layout.file;

        return modules.find((each) => each.file === file);
    };

    const installed = (): Installed | undefined => {
        const layout = presentLayouts()[0];

        if (layout === undefined) {
            return undefined;
        }

        const root = join(folder(), layout.folder);
        let version = "?";

        try {
            version = (JSON.parse(readFileSync(join(root, "bundle.json"), "utf8")) as { version?: string }).version ?? "?";
        } catch {
            // The helper folder is missing or broken: Pi Pocket shows the extension's error.
        }

        try {
            const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as { commit?: unknown };

            return typeof marker.commit === "string" ? { layout, version, commit: marker.commit } : { layout, version };
        } catch {
            return { layout, version };
        }
    };

    /** Either helper folder without its matching module may belong to an installation under another name. */
    const foreign = (): boolean => LAYOUTS.some((layout) => existsSync(join(folder(), layout.folder)) && !existsSync(join(folder(), layout.file)));

    const checkCopies = (): void => {
        if (presentLayouts().length > 1) {
            throw new Error(`Both extension module names exist in ${folder()}. Resolve the duplicate copies in Menu → Extensions before continuing.`);
        }

        if (foreign()) {
            throw new Error(`An extension copy already exists in ${folder()}. Remove that copy before installing here.`);
        }
    };

    const ownerToken = (): string => {
        try {
            const config = JSON.parse(readFileSync(join(host.dataFolder(), "config.json"), "utf8")) as { ownerToken?: unknown };

            if (typeof config.ownerToken === "string" && config.ownerToken !== "") {
                return config.ownerToken;
            }
        } catch {
            // Below.
        }

        throw new Error(`Pi Pocket's owner sign-in was not found in ${host.dataFolder()}.`);
    };

    /** Calls Pi Pocket's API as its owner. */
    const api = async (path: string, body?: unknown): Promise<unknown> => {
        const url = host.local().url;

        if (url === undefined) {
            throw new Error("Start Pi Pocket first.");
        }

        const response = await host.request(`${url}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${ownerToken()}`,
                "x-pocket": "1",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const answer = (await response.json().catch(() => undefined)) as { error?: string } | undefined;

        if (!response.ok) {
            throw new Error(answer?.error ?? `Pi Pocket answered HTTP ${String(response.status)}.`);
        }

        return answer;
    };

    const remember = (answer: unknown): void => {
        const listed = (answer as { modules?: ExtensionInfo[] } | undefined)?.modules;

        if (!Array.isArray(listed)) {
            throw new Error("Pi Pocket did not return its extension modules.");
        }

        modules = listed;
    };

    /** Turns the extension on or off in Pi Pocket; on, a load error comes back as the request's error. */
    const setEnabled = async (enabled: boolean, file = installed()?.layout.file ?? INTEGRATION.file): Promise<void> => {
        try {
            remember(await api(`/api/extensions/${encodeURIComponent(file)}`, { enabled }));
        } finally {
            await ask().catch(() => {});
        }
    };

    /** Asks Pi Pocket whether the extension is on. */
    const ask = async (): Promise<void> => {
        if (host.local().url === undefined) {
            modules = [];

            return;
        }

        remember(await api("/api/extensions"));
    };

    const github = async (path: string, accept = "application/vnd.github+json"): Promise<Response> => {
        const response = await host.fetch(`https://api.github.com/repos/${INTEGRATION.repo}${path}`, { accept });

        if (!response.ok) {
            throw new Error(
                response.status === 403 || response.status === 429
                    ? "GitHub is limiting requests from this network. Try again in an hour."
                    : `GitHub answered HTTP ${String(response.status)}.`,
            );
        }

        return response;
    };

    /** The newest commit on the integration's branch, and billion-context-pi's version in it. */
    const check = async (): Promise<void> => {
        const commit = (await (await github(`/commits/${INTEGRATION.branch}`, "application/vnd.github.sha")).text()).trim();

        if (!/^[0-9a-f]{40}$/.test(commit)) {
            throw new Error("GitHub did not return a valid extension version.");
        }

        let version: string | undefined;

        try {
            const bundle = await host.fetch(`https://raw.githubusercontent.com/${INTEGRATION.repo}/${commit}/${INTEGRATION.folder}/bundle.json`);

            version = bundle.ok ? ((await bundle.json()) as { version?: string }).version : undefined;
        } catch {
            // The version is only shown.
        }

        latest = { commit, ...(version === undefined ? {} : { version }) };
        checkedAt = Date.now();
    };

    const run = (file: string, args: string[]): Promise<void> =>
        new Promise((done, fail) => {
            execFile(file, args, { windowsHide: true }, (error, _stdout, stderr) => {
                if (error === null) {
                    done();
                } else {
                    fail(new Error(`${file} failed: ${stderr.trim() || error.message}`));
                }
            });
        });

    /** Downloads the commit's files, checks each against the commit's tree, and puts them in a folder of their own. */
    const fetchFiles = async (commit: string, into: string, step: (text: string) => void): Promise<void> => {
        step("Listing extension files…");

        const tree = (await (await github(`/git/trees/${commit}?recursive=1`)).json()) as { tree?: TreeEntry[]; truncated?: boolean };

        if (tree.truncated === true || tree.tree === undefined) {
            throw new Error("GitHub did not list all extension files.");
        }

        const files = integrationFiles(tree.tree);
        const downloads = join(host.home, "downloads");

        await mkdir(downloads, { recursive: true });
        // Own a fresh directory. A configured stateDir can point at any pre-existing path, even an old unpack path.
        const unpacked = await mkdtemp(join(host.home, "unpack-"));

        try {
            step("Downloading…");

            const archive = await downloadChecked({
                url: `https://codeload.github.com/${INTEGRATION.repo}/tar.gz/${commit}`,
                name: `billion-context-${commit}.tar.gz`,
                folder: downloads,
                fetch: (url) => host.fetch(url),
                onProgress: (percent) => step(`Downloading… ${String(percent)}%`),
            });

            step("Checking the files…");
            // Windows 10 and later have bsdtar.
            const tar = host.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

            await run(tar, ["-xzf", archive, "-C", unpacked, "--strip-components=1"]);
            await rm(archive, { force: true });

            for (const entry of files) {
                const from = join(unpacked, ...entry.path.split("/"));
                const data = await readFile(from).catch(() => undefined);

                if (data === undefined || blobSha(data) !== entry.sha) {
                    throw new Error(`${entry.path} failed verification. Nothing was installed.`);
                }

                const to = join(into, ...entry.path.split("/"));

                await mkdir(dirname(to), { recursive: true });
                await copyFile(from, to);
            }

            await writeFile(join(into, INTEGRATION.folder, MARKER), `${JSON.stringify({ commit, installedAt: new Date().toISOString() }, null, 4)}\n`);
        } finally {
            await rm(unpacked, { recursive: true, force: true }).catch(() => {});
        }
    };

    const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

    /** A configured state folder must never be inside files this installer replaces or removes. */
    const protectState = (settings: Record<string, unknown>): void => {
        const paths = (path: string): string[] => {
            const absolute = resolve(path);
            const suffix: string[] = [];
            let ancestor = absolute;

            // A state folder can be absent while its parent is a link into a managed folder.
            while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
                suffix.unshift(basename(ancestor));
                ancestor = dirname(ancestor);
            }

            const real = resolve(realpathSync(ancestor), ...suffix);

            return [absolute, real].map((each) => host.platform === "win32" ? each.toLowerCase() : each);
        };
        const statePaths = paths(resolve(host.dataFolder(), settings.stateDir as string));

        for (const path of [INTEGRATION.folder, LEGACY_INTEGRATION.folder, TRANSACTION]) {
            const managedPaths = paths(join(folder(), path));

            if (statePaths.some((state) => managedPaths.some((managed) => state === managed || state.startsWith(`${managed}${sep}`)))) {
                throw new Error(`The configured stateDir is inside ${path}, which the installer replaces or removes. Choose a separate state folder before continuing. Nothing was installed.`);
            }
        }
    };

    const readSettings = (path: string): Record<string, unknown> => {
        try {
            return legacySettings(JSON.parse(readFileSync(path, "utf8")));
        } catch (error) {
            throw new Error(`${path}: ${(error as Error).message}`);
        }
    };

    /** The new settings are authoritative after migration, including after uninstall/reinstall. */
    const migratedSettings = (was: Installed | undefined): Record<string, unknown> | undefined => {
        const oldPath = join(folder(), LEGACY_INTEGRATION.settings);
        const newPath = join(folder(), INTEGRATION.settings);

        if (was?.layout === INTEGRATION || (was === undefined && existsSync(newPath))) {
            // Match the loader: a present but invalid new file must never fall back to the old one.
            protectState(existsSync(newPath) ? readSettings(newPath) : existsSync(oldPath) ? readSettings(oldPath) : legacySettings({}));

            return undefined;
        }

        const settings = existsSync(oldPath) ? readSettings(oldPath) : legacySettings({});

        protectState(settings);

        if (was?.layout !== LEGACY_INTEGRATION && !existsSync(oldPath)) {
            return undefined;
        }

        if (existsSync(newPath) && !isDeepStrictEqual(settings, readSettings(newPath))) {
            throw new Error(`The old and new extension settings conflict in ${folder()}. Reconcile them before updating. Nothing was installed.`);
        }

        return settings;
    };

    const saveTransaction = async (transaction: Transaction): Promise<void> => {
        const temporary = join(transactionFolder(), "transaction.next");

        await writeFile(temporary, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
        await rename(temporary, join(transactionFolder(), "transaction.json"));
    };

    /** Restore an interrupted or failed update before any other action. Backups stay until recovery succeeds. */
    const recover = async (): Promise<void> => {
        const root = transactionFolder();
        const journal = join(root, "transaction.json");

        if (!existsSync(root)) {
            return;
        }

        // A user can choose any stateDir, even the reserved transaction folder. Never mistake it for our staging.
        const settingsPath = installed()?.layout === LEGACY_INTEGRATION || !existsSync(join(folder(), INTEGRATION.settings))
            ? join(folder(), LEGACY_INTEGRATION.settings)
            : join(folder(), INTEGRATION.settings);

        protectState(existsSync(settingsPath) ? readSettings(settingsPath) : legacySettings({}));

        if (!existsSync(journal)) {
            // Downloads and backups can be incomplete, but no installed file changed before the journal was saved.
            await rm(root, { recursive: true, force: true });

            return;
        }

        const transaction = JSON.parse(await readFile(journal, "utf8")) as Transaction;

        if (
            transaction.version !== 1 ||
            !["current", "legacy", null].includes(transaction.previous) ||
            typeof transaction.wasOn !== "boolean" ||
            typeof transaction.committed !== "boolean" ||
            !Array.isArray(transaction.present) ||
            transaction.present.some((path) => !SAVED_PATHS.includes(path))
        ) {
            throw new Error(`The extension recovery record is invalid. Keep the backups in ${root} and resolve it before continuing.`);
        }

        if (transaction.committed) {
            await rm(root, { recursive: true, force: true });

            return;
        }

        for (const path of transaction.present) {
            if (!existsSync(join(root, "saved", path))) {
                throw new Error(`The extension backup is missing ${path}. Keep ${root} and resolve it before continuing.`);
            }
        }

        await ask();

        for (const layout of presentLayouts()) {
            await setEnabled(false, layout.file);
        }

        // Remove modules first. Restore helpers and settings before a module can be discovered by the watcher.
        for (const path of SAVED_PATHS) {
            await rm(join(folder(), path), { recursive: true, force: true });
        }

        for (const path of [...transaction.present].sort((a, b) => Number(a.endsWith(".ts")) - Number(b.endsWith(".ts")))) {
            await cp(join(root, "saved", path), join(folder(), path), { recursive: true });
        }

        await settle();

        if (transaction.previous !== null) {
            const layout = transaction.previous === "legacy" ? LEGACY_INTEGRATION : INTEGRATION;

            await setEnabled(transaction.wasOn, layout.file);
        }

        await ask();
        await rm(root, { recursive: true, force: true });
    };

    /** Verify first; keep a durable backup until the replacement loads and the original choice is restored. */
    const put = async (step: (text: string) => void): Promise<void> => {
        if (host.local().url === undefined) {
            throw new Error("Start Pi Pocket before installing or turning on the extension.");
        }

        checkCopies();
        migratedSettings(installed()); // Refuse conflicts before downloading or turning anything off.
        step("Looking for the newest version…");
        await check();

        const staging = join(transactionFolder(), "new");
        let journalSaved = false;

        await mkdir(staging, { recursive: true });

        try {
            await fetchFiles(latest!.commit, staging, step);
            step("Installing…");
            await ask();
            checkCopies();

            const was = installed();
            const settings = migratedSettings(was);
            const previousModule = moduleInfo();

            if (was !== undefined && previousModule === undefined) {
                throw new Error(`Pi Pocket did not list ${was.layout.file}. Nothing was installed.`);
            }

            const transaction: Transaction = {
                version: 1,
                previous: was === undefined ? null : was.layout === LEGACY_INTEGRATION ? "legacy" : "current",
                wasOn: previousModule?.enabled === true,
                present: SAVED_PATHS.filter((path) => existsSync(join(folder(), path))),
                committed: false,
            };

            await mkdir(join(transactionFolder(), "saved"));

            for (const path of transaction.present) {
                await cp(join(folder(), path), join(transactionFolder(), "saved", path), { recursive: true });
            }

            await saveTransaction(transaction);
            journalSaved = true;

            if (was !== undefined) {
                await setEnabled(false, was.layout.file);
            }

            if (settings !== undefined) {
                const temporary = join(transactionFolder(), "settings.next");

                await writeFile(temporary, `${JSON.stringify(settings, null, 4)}\n`, { mode: 0o600 });
                await rename(temporary, join(folder(), INTEGRATION.settings));
            }

            if (!existsSync(join(folder(), INTEGRATION.file))) {
                // An uninstalled module can still have an old enabled choice. Disarm that choice with a no-op module
                // before publishing real code, even when the legacy installation must remain off.
                await writeFile(join(folder(), INTEGRATION.file), "export default function (_host, web) { web.onDispose(() => {}); }\n", { flag: "wx" });
                await setEnabled(false, INTEGRATION.file);
            }

            await rm(join(folder(), INTEGRATION.folder), { recursive: true, force: true });
            await rename(join(staging, INTEGRATION.folder), join(folder(), INTEGRATION.folder));
            await rename(join(staging, INTEGRATION.file), join(folder(), INTEGRATION.file));
            await settle();

            if (was === undefined || transaction.wasOn) {
                step("Turning it on…");
                await setEnabled(true, INTEGRATION.file);
            }

            if (was?.layout === LEGACY_INTEGRATION) {
                await rm(join(folder(), LEGACY_INTEGRATION.file), { force: true });
                await rm(join(folder(), LEGACY_INTEGRATION.folder), { recursive: true, force: true });
            }

            transaction.committed = true;
            await saveTransaction(transaction);
            await rm(transactionFolder(), { recursive: true, force: true }).catch(() => {});
        } catch (error) {
            if (journalSaved) {
                try {
                    await recover();
                } catch (recoveryError) {
                    throw new Error(`${(error as Error).message} Recovery also failed: ${(recoveryError as Error).message} Backups remain in ${transactionFolder()}.`);
                }
            } else {
                await rm(transactionFolder(), { recursive: true, force: true }).catch(() => {});
            }

            throw error;
        }
    };

    /** Remove either known layout, but keep both settings files and all compression state. */
    const remove = async (): Promise<void> => {
        checkCopies();

        const was = installed();

        if (was === undefined) {
            return;
        }

        migratedSettings(was);

        if (host.local().url !== undefined) {
            await ask();
            await setEnabled(false, was.layout.file);
        }

        await rm(join(folder(), was.layout.file), { force: true });
        await rm(join(folder(), was.layout.folder), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
        modules = [];
    };

    /** One action at a time; its steps and its error show in the card. */
    const act = async (name: string, work: (step: (text: string) => void) => Promise<void>): Promise<void> => {
        if (busy !== undefined) {
            throw new Error("Wait for the current step to end.");
        }

        message = undefined;
        busy = name;
        host.changed();

        try {
            await recover();
            await work((text) => {
                busy = text;
                host.changed();
            });
        } catch (error) {
            message = (error as Error).message;

            throw error;
        } finally {
            busy = undefined;
            host.changed();
        }
    };

    const updateAvailable = (): boolean => {
        const now = installed();

        return now?.commit !== undefined && latest !== undefined && (latest.commit !== now.commit || now.layout === LEGACY_INTEGRATION);
    };

    /** Looks for a newer commit; installs it when the setting says so and the app installed the one there. */
    const checkAndUpdate = async (): Promise<void> => {
        if (busy !== undefined || installed()?.commit === undefined || host.local().url === undefined) {
            return;
        }

        try {
            await act("Looking for the newest version…", async (step) => {
                await check();

                if (updateAvailable() && host.settings().billionContext.autoUpdate) {
                    await put(step);
                }
            });
        } catch (error) {
            console.error("billion-context-pi-pocket update:", error);
        }
    };

    return {
        state(): BillionContextState {
            const local = host.local();
            const now = installed();
            const module = moduleInfo();
            const error = presentLayouts().length > 1
                ? "Both extension module names exist. Resolve the duplicate copies in Menu → Extensions before continuing."
                : module?.error;

            return {
                server: host.settings().server.mode === "remote" ? "remote" : !local.installed ? "absent" : local.url === undefined ? "stopped" : "running",
                ...(now === undefined
                    ? {}
                    : {
                          installed: {
                              file: now.layout.file,
                              version: now.version,
                              ...(now.commit === undefined ? {} : { commit: now.commit }),
                              ...(module === undefined ? {} : { enabled: module.enabled }),
                              ...(error === undefined ? {} : { error }),
                          },
                      }),
                foreign: now === undefined && foreign(),
                ...(latest === undefined ? {} : { latest }),
                ...(checkedAt === undefined ? {} : { checkedAt }),
                updateAvailable: updateAvailable(),
                ...(busy === undefined ? {} : { busy }),
                ...(message === undefined ? {} : { message }),
                folder: folder(),
                page: INTEGRATION_PAGE,
                command: REMOTE_COMMAND,
            };
        },
        install: () => act("Installing…", put),
        update: () => act("Updating…", put),
        uninstall: () => act("Removing…", remove),
        enable: () => act("Turning it on…", async () => {
            checkCopies();
            await setEnabled(true);
        }),
        disable: () => act("Turning it off…", async () => {
            checkCopies();
            await setEnabled(false);
        }),
        check: () =>
            act("Looking for the newest version…", async () => {
                await check();
                await ask().catch(() => {});
            }),
        /** This computer's Pi Pocket is up: see whether the extension is on, and look for a newer one. */
        serverReady: (): void => {
            void act("Checking the extension…", ask)
                .then(checkAndUpdate)
                .catch((error) => console.error("billion-context-pi-pocket startup:", error));
        },
        serverDown: (): void => {
            modules = [];
            host.changed();
        },
        /** The person opened Settings: look for a newer version (it does nothing while the server is down). */
        settingsOpened: (): void => {
            void checkAndUpdate();
        },
    };
}

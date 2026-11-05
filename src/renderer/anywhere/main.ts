/**
 * Dictate anywhere's pill (src/main/dictation/anywhere.ts shows it): reads the microphone while it records, sends the
 * audio at 16 kHz to the main process, and shows what happens: recording (a dot that grows with the voice),
 * recognising, pasted, or why it failed.
 */
export {};

/** What the main process sends (PillMessage in src/main/dictation/anywhere.ts). */
type PillMessage =
    | { type: "record"; title: string; colors: Record<string, string>; mode: "dark" | "light"; sound: boolean }
    | { type: "stop" }
    | { type: "show"; state: "working" | "done" | "error"; title: string; detail?: string }
    | { type: "words"; text: string }
    | { type: "edge"; edge: "top" | "bottom" }
    | { type: "hide" };

declare global {
    interface Window {
        anywhere: {
            listen(listener: (message: PillMessage) => void): void;
            audio(samples: Float32Array): void;
            stopped(error?: string): void;
        };
    }
}

const pill = document.getElementById("pill")!;
const title = document.getElementById("title")!;
const detail = document.getElementById("detail")!;
const root = document.documentElement;

let release: (() => void) | undefined;
let sound = true;

/** A short, quiet tone: up when recording starts, down when it stops. */
function chime(rising: boolean): void {
    if (!sound) {
        return;
    }

    const context = new AudioContext();
    const tone = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;

    tone.type = "sine";
    tone.frequency.setValueAtTime(rising ? 660 : 880, now);
    tone.frequency.linearRampToValueAtTime(rising ? 880 : 660, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    tone.connect(gain);
    gain.connect(context.destination);
    tone.start(now);
    tone.stop(now + 0.13);
    tone.onended = () => void context.close();
}
/** Counts recordings: a microphone that opens after its recording ended is closed at once. */
let recording = 0;

function show(state: string, heading: string, more = ""): void {
    pill.dataset.state = state;
    pill.dataset.shown = "true";
    title.textContent = heading;
    delete detail.dataset.live;
    delete detail.dataset.cut;
    detail.textContent = more;
    detail.scrollLeft = 0;
}

/** Words heard so far: the line follows the newest ones, and fades out on the left once the start no longer fits. */
function follow(text: string): void {
    detail.dataset.live = "true";
    detail.textContent = text;
    detail.scrollLeft = detail.scrollWidth;
    detail.toggleAttribute("data-cut", detail.scrollWidth > detail.clientWidth);
}

async function record(number: number): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    if (number !== recording) {
        stream.getTracks().forEach((track) => track.stop());

        return;
    }

    const context = new AudioContext({ sampleRate: 16_000 });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(1024, 1, 1);
    const mute = context.createGain();
    let level = 0;

    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
        const samples = new Float32Array(event.inputBuffer.getChannelData(0));
        let sum = 0;

        for (const sample of samples) {
            sum += sample * sample;
        }

        // Loudness on a rough scale of 0 to 1, quick to rise and slow to fall.
        const now = Math.min(1, Math.sqrt(sum / samples.length) * 8);

        level = now > level ? now : level * 0.85 + now * 0.15;
        root.style.setProperty("--level", level.toFixed(3));
        window.anywhere.audio(samples);
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);

    release = () => {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        root.style.setProperty("--level", "0");
        void context.close();
    };
}

function stopRecording(error?: string): void {
    recording += 1;
    release?.();
    release = undefined;
    window.anywhere.stopped(error);
}

window.anywhere.listen((message) => {
    switch (message.type) {
        case "record": {
            for (const [name, value] of Object.entries(message.colors)) {
                root.style.setProperty(`--${name}`, value);
            }

            root.style.colorScheme = message.mode;
            sound = message.sound;
            show("recording", message.title);
            chime(true);

            const number = ++recording;

            void record(number).catch((error: unknown) => {
                if (number !== recording) {
                    return;
                }

                const name = (error as Error).name;

                stopRecording(name === "NotAllowedError" ? "not-allowed" : name === "NotFoundError" ? "no-microphone" : (error as Error).message);
            });
            break;
        }
        case "stop":
            if (release !== undefined) {
                chime(false);
            }

            stopRecording();
            break;
        case "show":
            show(message.state, message.title, message.detail ?? "");
            break;
        case "words":
            follow(message.text);
            break;
        case "edge":
            pill.dataset.edge = message.edge;
            break;
        case "hide":
            pill.dataset.shown = "false";
            break;
    }
});

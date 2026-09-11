# HushNote
> Privacy-First Local-First AI Note Drafting Assistant for Therapists

HushNote is a local-first, privacy-focused clinical note drafting prototype designed to help mental health professionals draft structured DAP and SOAP notes from session audio snippets without compromising client confidentiality or storing raw audio data permanently.

---

## Key Features & Privacy Architecture

- **Local-First LLM Processing**: Interacts directly with a local **Ollama** instance running Gemma (`gemma4` by default; override with `OLLAMA_MODEL`).
- **Zero Raw Data Retention**: Audio never leaves the browser. The transcript reaches the local server only for the length of a drafting request and is **not kept there**; the browser's own copy of the audio and transcript is cleared when the note is approved or the session is discarded.
- **Verified Evidence Quotes**: Grounds generated notes in quotes checked against the session transcript, never trusted from the model. Each quote is matched as verbatim, abridged (marked with `...` or `[brackets]`, so what was left out stays visible), or unverified (not found in the transcript, or too short to count as evidence) — shown as three distinct chip shapes, not colour alone. A quote's time comes from the transcript's own `[MM:SS]` markers and is shown only when the quote can be matched to one; otherwise its chip says "time not available". Live recordings have no markers, so quotes from them never carry a time.
- **Adaptive Purpose Readiness**:
  - **Progress Tracking**: Validates therapeutic outcomes and linked evidence quotes.
  - **Billing-Ready**: Ensures duration verification, intervention notes, and treatment plan updates.
  - **Insurance Review-Ready**: Highlights audit flags (medical necessity, EHR diagnosis alignment) and multi-quote evidence.
- **Stitch-Compatible Frontend**: Standard HTML/CSS layout easily connected to Stitch-exported UI screens via `app.js`.

---

## Built to Deserve "Privacy-First"

The privacy claims above aren't just a description, they're the result of an actual audit. Early builds of HushNote made several claims that weren't quite true: a fallback note that looked like real model output but wasn't, a billing code derived from the length of the generated note instead of the actual session duration, edits a clinician made on the review screen that got discarded before approval, and a raw transcript the server kept in memory well after a session was reset or discarded, sometimes indefinitely.

Each of those got found and fixed, with the fix verified against the actual failure, not just assumed correct. The server no longer stores the transcript at all, once it became clear nothing in the code ever read it back, so there's nothing left to leak. `clearRawSessionData()` and `clearReviewPanels()` together clear every copy of a session: transcript, audio, draft, and the review screen's own rendered text, on approve, discard, or reset, closing a real bug where a discarded recording could reappear, fully playable, after starting a new session. Evidence quotes are located in the transcript itself, word for word, rather than trusted from the model: each is marked verbatim, abridged, or unverified, and only a verbatim or abridged match can carry a timestamp, taken from the transcript's own markers rather than the model's claim, so a quote never shows a time that isn't actually in the session — including live recordings, which have no timestamps to fabricate from in the first place.

---

## Prerequisites

1. **Node.js**: 22.22.2 or later on the 22.x line, 24.15 or later on 24.x, or 26+. The test suite needs this range (it is jsdom 30's supported range, and the tests load ES modules with plain `require()`). Running the app alone (`npm run dev`) needs 20.19+ or 22.12+, per `@vitejs/plugin-react`.
2. **Ollama**: Download and install from [Ollama.com](https://ollama.com)
3. **Gemma Model**:
   ```bash
   ollama pull gemma4
   ```
   To use a different tag, set `OLLAMA_MODEL` in `.env` to match whatever
   `ollama list` reports.

---

## Quick Start & Running Locally

1. **Clone the repository and install dependencies**:
   ```bash
   git clone <repository-url>
   cd hushnote
   npm install
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   *Default configuration:*
   ```env
   PORT=3000
   OLLAMA_BASE_URL="http://127.0.0.1:11434"
   OLLAMA_MODEL="gemma4"
   ```

3. **Start the Local Ollama Model**:
   Ensure Ollama is running locally:
   ```bash
   ollama serve
   ```

4. **Launch HushNote Server**:
   ```bash
   npm run dev
   ```
   Open your browser to `http://localhost:3000`.

5. **Run the Tests and Type Check**:
   ```bash
   npm test
   npm run lint
   ```
   `npm test` runs every suite in `tests/` (the jsdom UI suites, plus unit tests for `verify-evidence.js` and `readiness.ts`) and needs neither the server nor a model. `npm run lint` runs `tsc --noEmit`.

---

## Connecting Google Stitch Exported HTML/CSS to `app.js`

`app.js` is engineered to seamlessly bind state and event listeners to standard Stitch-exported HTML components. To connect your exported Stitch UI screens:

1. Include `app.js` at the bottom of your exported `index.html`:
   ```html
   <script type="module" src="/app.js"></script>
   ```

2. Attach the following target `id` attributes to your Stitch HTML elements:

| Element Description | Required Stitch `id` Attribute | Function in `app.js` |
|---|---|---|
| Hero "Start Session" Button | `startSessionBtn` | Transitions from landing screen to consent modal |
| Informed Consent Checkbox | `consentCheckbox` | Confirms client recording consent |
| Confirm Consent Button | `confirmConsentBtn` | Enables when consent is checked & opens recorder |
| Start Recording Button | `startRecordingBtn` | Retry button, shown only after the microphone fails; recording starts on its own once consent is confirmed |
| Stop Recording Button | `stopRecordingBtn` | Stops recording & opens format selection |
| Transcript Textarea / Input | `transcriptInput` | Displays live transcript or allows manual pasting |
| Audio Playback Tag | `audioPlayback` | `<audio>` tag playing temporary memory blob |
| Recording Timer Counter | `recordingTimer` | Displays live recording counter (`00:45`) |
| Format Options Container | `noteFormat` | Wraps the DAP / SOAP / BOTH cards; `app.js` reads the `note-format` radios inside it, not this `id` |
| Generate Progress Note Button | `generateNoteBtn` | Opens purpose selection |
| Purpose Selection Form | `purpose-form` | Selects Progress Tracking or Billing & Insurance readiness; submitting it triggers POST `/api/generate-note` |
| Draft Note Text Area | `noteBody` | Editable DAP / SOAP note sections |
| Readiness Status Badge | `readinessLabel` | Displays readiness state ("Ready for therapist review") |
| Missing Fields Checklist | `missingFields` | Renders missing clinical fields checklist |
| Evidence Chips Container | `evidenceChips` | Displays evidence quote chips — verbatim, abridged or unverified — with a time only where one was confirmed against the transcript |
| Approve & Delete Raw Data Button | `approveDeleteBtn` | Clears the audio, transcript and draft from browser memory, keeping the approved note, and calls POST `/api/delete-raw-session` for the audit log (the wipe does not wait on it) |

---

## Project Structure

```
.
├── server.ts             # Express backend: drafts notes with local Ollama, keeps no session data
├── readiness.ts          # Readiness report and time-based CPT suggestion (no I/O, unit tested)
├── verify-evidence.js    # Locates each evidence quote in the transcript (verbatim/abridged/unverified) and confirms its timestamp
├── app.js                # Plain JS state machine & Stitch DOM event wiring
├── index.html            # Main UI container holding 8 Stitch-exported screens (app.js also accepts a legacy landing-screen id)
├── src/
│   ├── index.css         # Tailwind v4 theme and styles, loaded by index.html
│   ├── main.tsx          # Unused React scaffold (not loaded by index.html)
│   └── App.tsx           # Unused React scaffold
├── tests/                # jsdom UI suites and unit tests, run with npm test
├── vite.config.ts        # Vite dev server configuration
├── tsconfig.json         # TypeScript settings used by npm run lint
├── .env.example          # Sample environment variables
├── metadata.json         # AI Studio applet configuration
├── package.json          # Node.js dependencies & full-stack build scripts
├── CLAUDE.md             # Git branching and pull request conventions for this repo
└── README.md             # Project documentation & integration guide
```

---

## HIPAA & Security Compliance Integration Guidance

For production healthcare deployment:

1. **Encryption-at-Rest**: `server.ts` holds no session data today. Any future server-side storage of transcripts or audio needs AES-256-GCM encryption at rest and TTL purging before it ships.
2. **Authentication & Access Control**: Integrate OAuth2 / SAML single-sign-on (SSO) with role-based access control (RBAC).
3. **Audit Logging**: Emit append-only, tamper-evident audit trail events in `POST /api/delete-raw-session`.
4. **BAA Execution**: Execute Business Associate Agreements (BAA) with all cloud hosting providers.

# HushNote
> Privacy-First Local-First AI Note Drafting Assistant for Therapists

HushNote is a local-first, privacy-focused clinical note drafting prototype designed to help mental health professionals draft structured DAP and SOAP notes from session audio snippets without compromising client confidentiality or storing raw audio data permanently.

---

## Key Features & Privacy Architecture

- **Local-First LLM Processing**: Interacts directly with a local **Ollama** instance running Gemma (`gemma4` by default; override with `OLLAMA_MODEL`).
- **Zero Raw Data Retention**: Audio never leaves the browser. The transcript reaches the local server only for the length of a drafting request and is **not kept there**; the browser's own copy of the audio and transcript is cleared when the note is approved or the session is discarded.
- **Timestamped Evidence Quotes**: Links specific transcript quotes with exact time markers (`00:12`, `00:41`) to ground generated notes in factual session evidence.
- **Adaptive Purpose Readiness**:
  - **Progress Tracking**: Validates therapeutic outcomes and linked evidence quotes.
  - **Billing-Ready**: Ensures duration verification, intervention notes, and treatment plan updates.
  - **Insurance Review-Ready**: Highlights audit flags (medical necessity, EHR diagnosis alignment) and multi-quote evidence.
- **Stitch-Compatible Frontend**: Standard HTML/CSS layout easily connected to Stitch-exported UI screens via `app.js`.

---

## Prerequisites

1. **Node.js**: v18.0.0 or later
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
| Start Recording Button | `startRecordingBtn` | Starts browser microphone audio snippet recording |
| Stop Recording Button | `stopRecordingBtn` | Stops recording & opens format selection |
| Transcript Textarea / Input | `transcriptInput` | Displays live transcript or allows manual pasting |
| Audio Playback Tag | `audioPlayback` | `<audio>` tag playing temporary memory blob |
| Recording Timer Counter | `recordingTimer` | Displays live recording counter (`00:45`) |
| Format Options Container | `noteFormat` | DAP / SOAP / BOTH card selection |
| Generate Progress Note Button | `generateNoteBtn` | Triggers POST `/api/generate-note` |
| Purpose Selection Form | `purpose-form` | Selects Progress / Billing / Insurance readiness |
| Draft Note Text Area | `noteBody` | Editable DAP / SOAP note sections |
| Readiness Status Badge | `readinessLabel` | Displays readiness state ("Ready for therapist review") |
| Missing Fields Checklist | `missingFields` | Renders missing clinical fields checklist |
| Evidence Timestamps Container | `evidenceChips` | Displays timestamped quote tags (`00:12`) |
| Approve & Delete Raw Data Button | `approveDeleteBtn` | Calls POST `/api/delete-raw-session`, then clears the audio and transcript from browser memory |

---

## Project Structure

```
.
├── server.ts             # Express backend with Ollama integration & fallback engine
├── server.js             # Standalone Express runner export
├── app.js                # Plain JS state machine & Stitch DOM event wiring
├── index.html            # Main UI container holding 7 Stitch-exported screens
├── .env.example          # Sample environment variables
├── metadata.json         # AI Studio applet configuration
├── package.json          # Node.js dependencies & full-stack build scripts
└── README.md             # Project documentation & integration guide
```

---

## HIPAA & Security Compliance Integration Guidance

For production healthcare deployment:

1. **Encryption-at-Rest**: `server.ts` holds no session data today. Any future server-side storage of transcripts or audio needs AES-256-GCM encryption at rest and TTL purging before it ships.
2. **Authentication & Access Control**: Integrate OAuth2 / SAML single-sign-on (SSO) with role-based access control (RBAC).
3. **Audit Logging**: Emit append-only, tamper-evident audit trail events in `POST /api/delete-raw-session`.
4. **BAA Execution**: Execute Business Associate Agreements (BAA) with all cloud hosting providers.

import express, { Request, Response } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { verifyEvidence } from './verify-evidence.js';
import { calculateReadiness } from './readiness.js';

dotenv.config();

const currentFilename = typeof __filename !== 'undefined' 
  ? __filename 
  : process.cwd();

const currentDirname = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(currentFilename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * PRIVACY & COMPLIANCE ARCHITECTURE NOTE:
 * - The server keeps no session data. A transcript exists here only for the
 *   life of the /api/generate-note request that carries it: it goes to the
 *   local model and is dropped once the response is sent. Audio never reaches
 *   the server at all; it stays in the browser tab.
 * - Production-grade deployment requirements:
 *   1. Strict authentication & authorization: OAuth2 / JWT with role-based access controls.
 *   2. Immutable Audit Logging: Append-only log of note generation and approve/discard events for HIPAA compliance.
 *   3. Zero retention stays the rule: anything that starts holding transcripts
 *      server-side needs encryption at rest and TTL purging before it ships.
 */

/*
 * Local model defaults, defined once. /api/health previously carried its own
 * copies ('gemma2', 'localhost:11434') which had drifted from what the
 * generation path actually used, so health reported a model that would never
 * be called.
 */
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma4';

/**
 * The response when no model produced a note.
 *
 * This returns NO clinical content, deliberately. An earlier version of this
 * function returned fixed prose about anxiety and chest tightness regardless of
 * what the transcript said, and once rendered it was indistinguishable from a
 * real draft — the precise failure a clinical tool must not have. Empty sections
 * plus an explicit unavailable state is the only honest answer.
 *
 * Two things are deliberately NOT done here:
 *
 *  1. calculateReadiness() is not called. It scores a drafted note — sections
 *     documented, plan present, evidence linked — and recommends a CPT code.
 *     None of that is meaningful when nothing was drafted.
 *  2. No evidence quotes are extracted. Pulling real quotes out of the
 *     transcript would be accurate but misleading: it implies the session was
 *     analysed and a note was grounded in it, when neither happened.
 *
 * The server keeps nothing from this request, and the therapist loses nothing
 * either: the transcript is still in the browser, and drafting again once the
 * model is up sends it afresh.
 */
function buildUnavailableResponse(format: string, purpose: string) {
  return {
    format,
    purpose,
    note: {
      data: [],
      subjective: [],
      objective: [],
      assessment: [],
      plan: []
    },
    evidence: [],
    missing_fields: [],
    readiness: {
      completed: false,
      unavailable: true,
      label: 'Not drafted — model unavailable',
      checksPassed: [],
      missing: []
    }
  };
}

// POST /api/generate-note
app.post('/api/generate-note', async (req: Request, res: Response) => {
  try {
    // `model` has no default here on purpose. Defaulting it made it always
    // truthy, which short-circuited the `|| process.env.OLLAMA_MODEL` below and
    // left OLLAMA_MODEL dead — health would honour the env var while generation
    // silently ignored it.
    const { transcript, format = 'DAP', purpose = 'progress', model, durationSeconds } = req.body;

    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ error: 'Transcript content is required.' });
    }

    // The transcript is used for this request only and never stored, so nothing
    // outlives the response however the session ends — approved, discarded, or
    // abandoned with the tab.

    const systemPrompt = `You are HushNote, a clinical AI note drafting assistant for therapists.
STRICT CLINICAL RULES:
1. Use ONLY facts directly stated in the transcript.
2. DO NOT invent symptoms, risk factors, diagnoses, or unstated facts.
3. If crucial clinical information is missing from the transcript, return "Not documented" for that detail.
4. Include timestamped evidence quotes directly from the session transcript wherever available.
5. Format output strictly as a JSON object adhering to the specified schema.`;

    const userPrompt = `Format requested: ${format}
Purpose: ${purpose}

Session Transcript:
"""
${transcript}
"""

Return a JSON object with this EXACT structure:
{
  "format": "${format}",
  "note": {
    "data": ["fact 1", "fact 2"],
    "subjective": ["statement 1"],
    "objective": ["observation 1"],
    "assessment": ["clinical evaluation 1"],
    "plan": ["treatment step 1"]
  },
  "evidence": [
    {
      "quote": "exact quote",
      "timestamp": "00:00",
      "section": "subjective or data"
    }
  ],
  "missing_fields": ["Field: Not documented"]
}`;

    let resultJson: any = null;
    let aiSource = 'ollama_gemma';
    // Why the local model produced nothing. This is not diagnostics — the client
    // shows it to the therapist to explain why no note could be drafted.
    let ollamaError: string | null = null;

    // Local-only Ollama generation. Request override, then env, then default —
    // the same order /api/health reports.
    const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
    const modelName = model || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
    if (!resultJson && ollamaBaseUrl) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout for local model generation

        const ollamaResponse = await fetch(`${ollamaBaseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: modelName,
            prompt: `${systemPrompt}\n\n${userPrompt}`,
            format: 'json',
            stream: false
          })
        });

        clearTimeout(timeoutId);

        if (ollamaResponse.ok) {
          const ollamaData = await ollamaResponse.json();
          if (ollamaData && ollamaData.response) {
            try {
              resultJson = JSON.parse(ollamaData.response);
              aiSource = 'ollama_gemma';
            } catch (e) {
              const jsonMatch = ollamaData.response.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                resultJson = JSON.parse(jsonMatch[0]);
                aiSource = 'ollama_gemma';
              }
            }
          }
          if (!resultJson) {
            ollamaError = `the model "${modelName}" returned no usable JSON`;
          }
        } else {
          ollamaError = `the model server replied ${ollamaResponse.status} — check that "${modelName}" has been pulled`;
        }
      } catch (ollamaErr: any) {
        ollamaError = ollamaErr?.name === 'AbortError'
          ? 'the local model did not respond within 60 seconds'
          : `the local model could not be reached (${ollamaErr?.message || 'unknown error'})`;
      }
    }

    // 3. Process structured note result or fallback
    if (resultJson && resultJson.note) {
      // Times come from the transcript the model was given, never from the model:
      // anything verifyEvidence() cannot pin to a marker-led line is set to null
      // before readiness counts it or the client sees it.
      resultJson.evidence = verifyEvidence(transcript, resultJson.evidence);
      const readiness = calculateReadiness(purpose, resultJson.note, resultJson.evidence, transcript, durationSeconds);
      resultJson.readiness = readiness;
      resultJson.purpose = purpose;
      // Trust fields go LAST: model output must not be able to claim its own provenance.
      return res.json({ ...resultJson, success: true, source: aiSource, fallback: false, model: modelName });
    }

    /*
     * No model output. The response carries empty sections and an explicit
     * unavailable state — never invented content — and must not be attributable
     * to the drafting engine. `fallback: true` is what the client gates on;
     * `source` is deliberately not an engine name.
     */
    return res.json({
      ...buildUnavailableResponse(format, purpose),
      success: true,
      source: 'fallback_offline',
      fallback: true,
      fallbackReason: `HushNote could not draft this note because ${ollamaError || `no local model was reachable at ${ollamaBaseUrl}`}.`
    });

  } catch (error: any) {
    console.error('Error generating note:', error);
    res.status(500).json({ error: 'Failed to generate note', details: error.message });
  }
});

// POST /api/delete-raw-session
app.post('/api/delete-raw-session', (req: Request, res: Response) => {
  /*
   * There is nothing here to delete: the server keeps no session data (see
   * /api/generate-note). The endpoint stays because the client's approve and
   * discard flow calls it before clearing the browser's own copy, and because it
   * is where that event would be audited.
   *
   * COMPLIANCE AUDIT LOGGING STUB:
   * In a HIPAA-compliant production build, emit an immutable audit event:
   * auditLogger.log({
   *   event: 'SESSION_WIPE_REQUESTED',
   *   timestamp: new Date().toISOString(),
   *   actorId: req.user.id,
   *   status: 'SUCCESS'
   * });
   */

  return res.json({
    success: true,
    message: 'No session data is held on the server, so there was nothing to delete.',
    timestamp: new Date().toISOString()
  });
});

// GET /api/health
// No rawSessionInMemory flag: with nothing retained it could only ever be false.
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    appName: 'HushNote',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  /*
   * Loopback only, deliberately.
   *
   * Binding to 0.0.0.0 published the note-drafting API to every device on the
   * network, with no authentication, while an unencrypted session transcript
   * sat in memory. On a clinic or café network that is a stranger's read of a
   * live session. The local-first promise has to hold at the network layer, not
   * only in how data is stored, so nothing off this machine can reach the API.
   */
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[HushNote Server] Running on http://127.0.0.1:${PORT} (loopback only)`);
  });
}

startServer();

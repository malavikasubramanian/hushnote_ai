import express, { Request, Response } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

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
 * - This prototype stores raw transcript and audio snippets ONLY temporarily in memory.
 * - Production-grade deployment requirements:
 *   1. Encryption-at-rest: AES-256-GCM for ephemeral storage.
 *   2. Strict authentication & authorization: OAuth2 / JWT with role-based access controls.
 *   3. Immutable Audit Logging: Append-only log of access, note generation, and deletion events for HIPAA compliance.
 *   4. Zero-retention policy enforcement: Automatic TTL purging of temporary session buffers.
 */
interface RawSessionBuffer {
  id?: string;
  transcript: string;
  timestamp: string;
  audioBlobReceived?: boolean;
}

let activeRawSession: RawSessionBuffer | null = null;

/*
 * Local model defaults, defined once. /api/health previously carried its own
 * copies ('gemma2', 'localhost:11434') which had drifted from what the
 * generation path actually used, so health reported a model that would never
 * be called.
 */
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'gemma4';

function formatMinutes(minutes: number) {
  return `${Math.round(minutes)} min`;
}

/**
 * Session length, from the strongest signal actually available.
 *
 * Returns null rather than guessing. Time-based CPT codes are defined in
 * minutes of psychotherapy, so an estimate that lands in the wrong band is
 * upcoding or downcoding on a real claim — not a rounding error.
 */
function deriveSessionDuration(transcript: string, recordedSeconds?: unknown) {
  // 1. Explicit [MM:SS] markers. The last one is the session's own clock.
  //    Two or more are required: a single marker is a label, not a span.
  const marks = [...transcript.matchAll(/\[(\d{1,2}):([0-5]\d)\]/g)];
  if (marks.length >= 2) {
    const last = marks[marks.length - 1];
    const minutes = Number(last[1]) + Number(last[2]) / 60;
    // The last marker opens the final exchange, so the real session runs a
    // little longer than this. Erring short is the safe direction for coding.
    if (minutes >= 1) {
      return { minutes, source: 'transcript timestamps' };
    }
  }

  // 2. The client's recording timer — measured wall-clock, not inferred.
  //    Coerced rather than type-checked: this arrives straight off a JSON body,
  //    and a strict typeof rejected "2700" outright, which then reported the
  //    duration as "not captured" when one had in fact been sent.
  //    Number(undefined) and Number('abc') are NaN, so those still fall through.
  const seconds = Number(recordedSeconds);
  if (Number.isFinite(seconds) && seconds >= 60) {
    return { minutes: seconds / 60, source: 'recorded session length' };
  }

  /*
   * 3. Nothing measured. Word count is deliberately NOT used as a proxy: a
   *    transcript omits the silences, pauses and reflection that make up real
   *    session time, so any word-derived estimate skews low and would push
   *    sessions into a lower-paying, incorrect code band.
   */
  return null;
}

/**
 * Time-defined individual psychotherapy codes, by the standard CPT bands.
 * Below 16 minutes there is no time-based psychotherapy code to bill.
 */
function timeBasedCpt(minutes: number) {
  if (minutes < 16) return null;
  if (minutes <= 37) return { code: '90832', title: 'Psychotherapy, 30 minutes (16-37 min)' };
  if (minutes <= 52) return { code: '90834', title: 'Psychotherapy, 45 minutes (38-52 min)' };
  return { code: '90837', title: 'Psychotherapy, 60 minutes (53+ min)' };
}

/**
 * Session-type codes that would REPLACE the time-based code where they apply.
 *
 * Keyword matching cannot establish any of these: "any thoughts of self-harm?"
 * is routine screening rather than a crisis session, and a client mentioning a
 * partner is not conjoint family therapy — 90847 needs that person in the room.
 * So these are surfaced for the clinician to consider, never auto-selected.
 */
function detectAlternateCodes(transcript: string) {
  const text = transcript.toLowerCase();
  const found: Array<{ code: string; title: string; why: string }> = [];

  if (/\b(intake|initial evaluation|first session|background history)\b/.test(text)) {
    found.push({
      code: '90791',
      title: 'Psychiatric Diagnostic Evaluation',
      why: 'intake or initial-evaluation language appears in the transcript'
    });
  }
  if (/\b(crisis|suicidal|self-harm|emergency)\b/.test(text)) {
    found.push({
      code: '90839',
      title: 'Psychotherapy for Crisis, first 60 min',
      why: 'crisis or risk language appears — applies only to an acute crisis session, not routine risk screening'
    });
  }
  if (/\b(family session|conjoint|spouse|partner)\b/.test(text)) {
    found.push({
      code: '90847',
      title: 'Family Psychotherapy, conjoint with patient',
      why: 'relational content appears — applies only if the family member was present in the session'
    });
  }
  return found;
}

// Readiness evaluation logic based on purpose selection
function calculateReadiness(
  purpose: string,
  note: any,
  evidence: any[],
  transcript: string = '',
  durationSeconds?: unknown
) {
  const missing: string[] = [];
  const checksPassed: string[] = [];
  
  const hasDataOrSubjObj = (note.data?.length > 0 || note.subjective?.length > 0) && (note.objective?.length > 0 || note.assessment?.length > 0);
  const hasInterventionAndPlan = (note.plan?.length > 0);
  const evidenceCount = Array.isArray(evidence) ? evidence.length : 0;

  if (purpose === 'progress') {
    // For progress tracking: ensure note has enough session content and at least 1 evidence reference
    if (!hasDataOrSubjObj) {
      missing.push('Insufficient session content in Data/Subjective section');
    }
    if (evidenceCount < 1) {
      missing.push('At least one evidence quote timestamp required');
    } else {
      checksPassed.push('Timestamp evidence linked');
    }

    const completed = missing.length === 0;
    return {
      completed,
      label: completed ? 'Ready for Progress Tracking' : 'Incomplete progress data',
      checksPassed,
      missing
    };
  } else {
    /*
     * Billing & Insurance Readiness Report.
     *
     * The code is chosen from the SESSION, not from the drafted note. An
     * earlier version measured the character length of the generated note and
     * treated that as session duration, which meant the note's verbosity —
     * a property of the model, not the appointment — decided the billing tier.
     */
    const duration = deriveSessionDuration(transcript, durationSeconds);
    const cpt = duration ? timeBasedCpt(duration.minutes) : null;
    const alternates = detectAlternateCodes(transcript);

    if (!hasDataOrSubjObj) missing.push('Detailed subjective/objective clinical data');
    if (!hasInterventionAndPlan) missing.push('Clear clinical intervention & next-step plan');
    if (!duration) missing.push('Session duration — not captured, so no time-based CPT code can be suggested');

    // Only what actually held. The previous build returned a fixed list that
    // claimed "Session Duration Verified via Transcript" in every response.
    const passed: string[] = [];
    if (hasDataOrSubjObj) passed.push('Subjective/objective clinical data documented');
    if (hasInterventionAndPlan) passed.push('Treatment plan & intervention documented');
    if (evidenceCount > 0) {
      passed.push(`${evidenceCount} timestamped evidence quote${evidenceCount === 1 ? '' : 's'} linked`);
    }
    if (duration) {
      passed.push(`Session duration ${formatMinutes(duration.minutes)}, from ${duration.source}`);
    }

    const auditFlags = [
      'Verify medical necessity linkage to primary ICD-10 diagnosis',
      'Confirm session start/end times in the EHR match this note',
      'Sign and date the note prior to claim submission'
    ];
    for (const alt of alternates) {
      auditFlags.push(`Consider CPT ${alt.code} (${alt.title}) instead — ${alt.why}`);
    }

    const completed = missing.length === 0;
    return {
      completed,
      label: completed ? 'Billing & Insurance Audit Ready' : 'Requires Clinical Review',
      checksPassed: passed,
      missing,
      suggestedCpt: cpt
        ? { ...cpt, rationale: `Based on ${formatMinutes(duration!.minutes)}, from ${duration!.source}.` }
        : null,
      cptUnavailableReason: cpt
        ? null
        : duration
          ? `Session ran ${formatMinutes(duration.minutes)}, below the 16-minute floor for a time-based psychotherapy code.`
          : 'Session duration was not captured, so no time-based code can be suggested. Set the code in your EHR.',
      sessionDuration: duration ? `${formatMinutes(duration.minutes)} (${duration.source})` : null,
      // Asserted only when the note actually carries both halves of it.
      medicalNecessity: hasDataOrSubjObj && hasInterventionAndPlan
        ? 'Clinical distress, symptom presentation, and specific therapeutic intervention documented.'
        : null,
      auditFlags
    };
  }
}

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
 * The transcript itself is untouched and still held in activeRawSession, so the
 * therapist loses nothing by drafting again once the model is up.
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

    // Keep raw session temporarily in memory (for prototype flow)
    activeRawSession = {
      id: 'session_' + Date.now(),
      transcript,
      timestamp: new Date().toISOString()
    };

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
      const readiness = calculateReadiness(purpose, resultJson.note, resultJson.evidence || [], transcript, durationSeconds);
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
  // Permanently delete raw transcript and audio buffer from memory
  activeRawSession = null;

  /*
   * COMPLIANCE AUDIT LOGGING STUB:
   * In a HIPAA-compliant production build, emit an immutable audit event:
   * auditLogger.log({
   *   event: 'RAW_SESSION_PURGED',
   *   timestamp: new Date().toISOString(),
   *   actorId: req.user.id,
   *   action: 'PERMANENT_ERASURE',
   *   status: 'SUCCESS'
   * });
   */

  return res.json({
    success: true,
    message: 'Raw audio buffer and transcript purged permanently from memory.',
    timestamp: new Date().toISOString()
  });
});

// GET /api/health
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    appName: 'HushNote',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
    rawSessionInMemory: !!activeRawSession
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

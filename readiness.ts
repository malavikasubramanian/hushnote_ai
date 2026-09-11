/**
 * Readiness for a drafted note: what is documented, what is missing, and, for
 * billing, which time-based code the session length supports.
 *
 * No server, no I/O, so it can be tested directly.
 */

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

/**
 * The checklist line for a draft's evidence quotes: how many there are, and how
 * many carry a timestamp verifyEvidence() confirmed against the transcript. It
 * has to stay true at every count, including none confirmed, which is always
 * the case for a live recording.
 */
function describeEvidence(total: number, confirmed: number) {
  const quotes = `${total} evidence quote${total === 1 ? '' : 's'} referenced`;
  if (confirmed === 0) return `${quotes}, no timestamp confirmed against the transcript`;
  if (confirmed === total) {
    return total === 1
      ? `${quotes}, its timestamp confirmed against the transcript`
      : `${quotes}, all timestamps confirmed against the transcript`;
  }
  return `${quotes}, ${confirmed} with a timestamp confirmed against the transcript`;
}

// Readiness evaluation logic based on purpose selection
export function calculateReadiness(
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
  // Evidence has already been through verifyEvidence(): a timestamp that is
  // still set was confirmed against the transcript, and every other one is null.
  const evidenceCount = Array.isArray(evidence) ? evidence.length : 0;
  const confirmedCount = Array.isArray(evidence) ? evidence.filter((ev) => ev && ev.timestamp).length : 0;

  if (purpose === 'progress') {
    // For progress tracking: ensure note has enough session content and at least
    // 1 evidence quote. A confirmed time is reported, not required: a live
    // recording has no times to confirm, and that must not block the draft.
    if (!hasDataOrSubjObj) {
      missing.push('Insufficient session content in Data/Subjective section');
    }
    if (evidenceCount < 1) {
      missing.push('At least one evidence quote required');
    } else {
      checksPassed.push(describeEvidence(evidenceCount, confirmedCount));
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
      passed.push(describeEvidence(evidenceCount, confirmedCount));
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

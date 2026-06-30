import {
    appendEntry,
    buildHeaders,
    loadSession,
    normalizeReport,
    parseJsonSafe,
    saveReport,
    stripSnapshotBase64,
    supabaseEnv,
    uploadProctorSnapshot,
} from './proctor-store.mjs';

const VISION_MODEL = 'gemini-2.0-flash';
const MAX_IMAGE_BYTES = 900000;

function mimeFromUrl(url) {
    const u = String(url || '').toLowerCase();
    if (u.includes('.png')) return 'image/png';
    if (u.includes('.webp')) return 'image/webp';
    return 'image/jpeg';
}

function verdictFromResult(parsed) {
    const rawVerdict = String(parsed?.verdict || '').toLowerCase();
    const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed?.confidence) || 0)));
    const samePerson = parsed?.same_person === true;

    if (rawVerdict === 'no_face' || parsed?.face_visible_live === false) {
        return { verdict: 'no_face', confidence, same_person: false, suspicious: false };
    }
    if (rawVerdict === 'mismatch' || (confidence > 0 && confidence < 50 && !samePerson)) {
        return { verdict: 'mismatch', confidence, same_person: false, suspicious: true };
    }
    if (rawVerdict === 'review' || (confidence >= 50 && confidence < 75)) {
        return { verdict: 'review', confidence, same_person: samePerson, suspicious: false };
    }
    if (samePerson || rawVerdict === 'match' || confidence >= 75) {
        return { verdict: 'match', confidence, same_person: true, suspicious: false };
    }
    return { verdict: 'review', confidence, same_person: false, suspicious: false };
}

export async function fetchImageAsBase64(url) {
    const res = await fetch(String(url || '').trim(), { redirect: 'follow' });
    if (!res.ok) {
        throw new Error(`reference_fetch_failed (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('reference_image_too_small');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('reference_image_too_large');
    return {
        base64: buf.toString('base64'),
        mime: res.headers.get('content-type')?.split(';')[0]?.trim() || mimeFromUrl(url),
    };
}

export function profilePhotoFromSession(session) {
    const cfg = parseJsonSafe(session?.config, {});
    const screening = parseJsonSafe(session?.screening, {});
    const fromCfg = String(cfg.profile_photo_url || '').trim();
    if (fromCfg) return fromCfg;
    const fromScreening = String(screening.profile_photo_url || '').trim();
    if (fromScreening) return fromScreening;
    return '';
}

export async function lookupCandidateProfilePhoto(sbUrl, sbKey, email, requisitionId) {
    const em = String(email || '').trim().toLowerCase();
    if (!em) return '';

    const tries = [];
    const req = String(requisitionId || '').trim();
    if (req) {
        tries.push(
            `${sbUrl}/rest/v1/candidates?candidate_email=eq.${encodeURIComponent(em)}` +
            `&requisition_id=eq.${encodeURIComponent(req)}&select=notes&order=created_at.desc&limit=1`
        );
    }
    tries.push(
        `${sbUrl}/rest/v1/candidates?candidate_email=eq.${encodeURIComponent(em)}` +
        '&select=notes,requisition_id&order=created_at.desc&limit=3'
    );

    for (const url of tries) {
        try {
            const res = await fetch(url, { headers: buildHeaders(sbKey) });
            if (!res.ok) continue;
            const rows = await res.json();
            if (!Array.isArray(rows)) continue;
            for (const row of rows) {
                const notes = parseJsonSafe(row.notes, {});
                const photo = String(notes.profile_photo_url || '').trim();
                if (photo) return photo;
            }
        } catch (_) {
            /* next */
        }
    }
    return '';
}

export async function resolveReferencePhotoUrl(sbUrl, sbKey, session) {
    const direct = profilePhotoFromSession(session);
    if (direct) return direct;
    const cfg = parseJsonSafe(session?.config, {});
    return lookupCandidateProfilePhoto(
        sbUrl,
        sbKey,
        session?.candidate_email,
        session?.requisition_id || cfg.requisition_id
    );
}

export async function compareFacesWithGemini(apiKey, referenceBase64, referenceMime, liveBase64) {
    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const prompt =
        'You verify whether the same person appears in two photos for a proctored job assessment.\n\n' +
        'Image 1 = REFERENCE (profile photo from job application).\n' +
        'Image 2 = LIVE (webcam capture during assessment).\n\n' +
        'Compare face structure (eyes, nose, jaw, hairline). Ignore lighting, background, glasses, beard, or hairstyle changes.\n' +
        'If live image has no clear face, set face_visible_live=false.\n' +
        'If reference has no clear face, set face_visible_reference=false.\n' +
        'Be conservative: if uncertain, verdict="review" and same_person=false.\n' +
        'Do not identify the person by name.\n\n' +
        'Return JSON only:\n' +
        '{"same_person":boolean,"confidence":number,"verdict":"match"|"mismatch"|"review"|"no_face",' +
        '"face_visible_reference":boolean,"face_visible_live":boolean,"reasons":string[]}';

    const refMime = String(referenceMime || 'image/jpeg').split(';')[0].trim() || 'image/jpeg';
    const liveMime = 'image/jpeg';

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [
                    { text: prompt },
                    { text: 'REFERENCE PHOTO:' },
                    { inline_data: { mime_type: refMime, data: referenceBase64 } },
                    { text: 'LIVE WEBCAM:' },
                    { inline_data: { mime_type: liveMime, data: liveBase64 } },
                ],
            }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 420,
                responseMimeType: 'application/json',
            },
        }),
    });

    const json = await res.json();
    if (!res.ok) {
        throw new Error(json?.error?.message || `gemini_${res.status}`);
    }

    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        parsed = { verdict: 'review', confidence: 0, same_person: false, reasons: ['Could not parse Gemini response'] };
    }

    const verdictMeta = verdictFromResult(parsed);
    return {
        ...verdictMeta,
        reasons: Array.isArray(parsed.reasons)
            ? parsed.reasons.map((r) => String(r).trim()).filter(Boolean).slice(0, 4)
            : [],
        face_visible_reference: parsed.face_visible_reference !== false,
        face_visible_live: parsed.face_visible_live !== false,
        model: VISION_MODEL,
    };
}

function buildIdentitySummary(checks) {
    const list = Array.isArray(checks) ? checks.slice() : [];
    if (!list.length) return null;
    const latest = list[list.length - 1];
    const mismatches = list.filter((c) => c.verdict === 'mismatch').length;
    const reviews = list.filter((c) => c.verdict === 'review').length;
    const matches = list.filter((c) => c.verdict === 'match').length;
    let overall = latest.verdict || 'review';
    if (mismatches > 0) overall = 'mismatch';
    else if (reviews > 0 && matches === 0) overall = 'review';
    else if (matches > 0) overall = 'match';

    return {
        overall_verdict: overall,
        latest_verdict: latest.verdict,
        latest_confidence: latest.confidence,
        checks_count: list.length,
        match_count: matches,
        review_count: reviews,
        mismatch_count: mismatches,
        reference_url: latest.reference_url || null,
        updated_at: latest.at,
    };
}

export async function appendIdentityCheck(sbUrl, sbKey, sessionId, checkRecord, proctorEntry) {
    const session = await loadSession(sbUrl, sbKey, sessionId);
    if (!session?.id) throw new Error('session_not_found');

    const report = normalizeReport(session.proctor_report);
    const checks = Array.isArray(report.identity_checks) ? report.identity_checks.slice() : [];
    checks.push(checkRecord);
    report.identity_checks = checks.slice(-20);
    report.identity_summary = buildIdentitySummary(report.identity_checks);

    if (proctorEntry) {
        const withEntry = appendEntry(report, proctorEntry);
        withEntry.identity_checks = report.identity_checks;
        withEntry.identity_summary = report.identity_summary;
        await saveReport(sbUrl, sbKey, sessionId, withEntry);
        return { check: checkRecord, report: withEntry, entry: proctorEntry };
    }

    await saveReport(sbUrl, sbKey, sessionId, report);
    return { check: checkRecord, report };
}

export async function runIdentityCheck({
    sessionId,
    webcamBase64,
    webcamThumbBase64,
    checkPoint = 'start',
    phase = null,
    sbUrl,
    sbKey,
    apiKey,
}) {
    const sid = String(sessionId || '').trim();
    const liveB64 = stripSnapshotBase64(webcamBase64);
    if (!sid) throw new Error('session_id_required');
    if (!liveB64 || liveB64.length < 500) throw new Error('webcam_frame_required');

    const env = supabaseEnv();
    const url = sbUrl || env.url;
    const key = sbKey || env.key;
    if (!url || !key) throw new Error('supabase_not_configured');

    const geminiKey = String(apiKey || process.env.GEMINI_API_KEY || '').trim();
    if (!geminiKey) throw new Error('gemini_key_missing');

    const session = await loadSession(url, key, sid);
    if (!session?.id) throw new Error('session_not_found');

    const referenceUrl = await resolveReferencePhotoUrl(url, key, session);
    if (!referenceUrl) {
        return { ok: false, skipped: true, reason: 'no_reference_photo' };
    }

    let snapshotPath = null;
    let snapshotBucket = 'proctor-snapshots';
    try {
        const uploaded = await uploadProctorSnapshot(url, key, sid, liveB64, `identity-${checkPoint}`);
        snapshotPath = uploaded.path;
        snapshotBucket = uploaded.bucket;
    } catch (err) {
        console.warn('[identity-verify] snapshot upload failed:', err.message);
    }

    const reference = await fetchImageAsBase64(referenceUrl);
    const comparison = await compareFacesWithGemini(
        geminiKey,
        reference.base64,
        reference.mime,
        liveB64
    );

    const now = new Date().toISOString();
    const checkRecord = {
        at: now,
        check_point: String(checkPoint || 'start').slice(0, 32),
        reference_url: referenceUrl,
        snapshot_path: snapshotPath,
        snapshot_bucket: snapshotBucket,
        snapshot_thumb: webcamThumbBase64
            ? stripSnapshotBase64(webcamThumbBase64).slice(0, 80000)
            : null,
        same_person: comparison.same_person,
        confidence: comparison.confidence,
        verdict: comparison.verdict,
        reasons: comparison.reasons,
        face_visible_reference: comparison.face_visible_reference,
        face_visible_live: comparison.face_visible_live,
    };

    const summaryText =
        comparison.verdict === 'match'
            ? `Identity check (${checkPoint}): likely same person (${comparison.confidence}%)`
            : comparison.verdict === 'mismatch'
                ? `Identity check (${checkPoint}): likely different person (${comparison.confidence}%)`
                : comparison.verdict === 'no_face'
                    ? `Identity check (${checkPoint}): face not visible on webcam`
                    : `Identity check (${checkPoint}): needs manual review (${comparison.confidence}%)`;

    const proctorEntry = {
        at: now,
        phase: phase != null ? Number(phase) : null,
        category: 'identity_check',
        summary: summaryText.slice(0, 1200),
        suspicious: comparison.suspicious,
        meta: {
            identity_check: true,
            check_point: checkRecord.check_point,
            verdict: comparison.verdict,
            confidence: comparison.confidence,
            reference_url: referenceUrl,
            webcam_snapshot_path: snapshotPath,
            webcam_snapshot_bucket: snapshotBucket,
            webcam_snapshot_thumb: checkRecord.snapshot_thumb || undefined,
        },
    };

    const saved = await appendIdentityCheck(url, key, sid, checkRecord, proctorEntry);
    return {
        ok: true,
        skipped: false,
        check: checkRecord,
        comparison,
        entry: saved.entry,
    };
}

// Vercel — manual shortlist from Review queue (creates assessment session + updates candidate).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, GROQ_API_KEY
// Optional: PORTAL_BASE_URL (default talent-acquisition-six.vercel.app)
// Optional: MANUAL_SHORTLIST_WEBHOOK_URL — or app_config key manual_shortlist_webhook

const DEFAULT_PORTAL = 'https://talent-acquisition-six.vercel.app';
const APPROVE_ROLES = new Set(['super_admin', 'hr_head', 'recruiter']);

function env(name, fallback = '') {
    return String(process.env[name] || fallback).trim();
}

async function resolveMailWebhook(supabaseUrl, serviceKey) {
    const fromEnv = env('MANUAL_SHORTLIST_WEBHOOK_URL');
    if (fromEnv) return fromEnv;

    const cfgRes = await sbFetch(
        supabaseUrl,
        serviceKey,
        '/rest/v1/app_config?key=eq.manual_shortlist_webhook&select=value&limit=1'
    );
    const row = Array.isArray(cfgRes.data) ? cfgRes.data[0] : null;
    return String(row?.value || '').trim();
}

function formatSbError(result) {
    const data = result?.data;
    if (typeof data === 'object' && data) {
        const msg = data.message || data.error || data.hint || data.details;
        if (msg) return String(msg).slice(0, 300);
        return JSON.stringify(data).slice(0, 300);
    }
    return String(data || result?.status || 'unknown error').slice(0, 300);
}

async function sbFetch(base, key, path, options = {}) {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
        ...options,
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
    });
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch (_) {
        data = text;
    }
    return { ok: res.ok, status: res.status, data };
}

async function verifyApprover(req, supabaseUrl, anonKey) {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) return { error: 'unauthorized', status: 401 };
    const token = auth.slice(7).trim();
    if (!token) return { error: 'unauthorized', status: 401 };

    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return { error: 'unauthorized', status: 401 };
    const user = await userRes.json();
    if (!user?.id) return { error: 'unauthorized', status: 401 };

    const profRes = await sbFetch(
        supabaseUrl,
        anonKey,
        `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,email&limit=1`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    const profile = Array.isArray(profRes.data) ? profRes.data[0] : null;
    if (!profile || !APPROVE_ROLES.has(profile.role)) {
        return { error: 'forbidden', status: 403 };
    }
    return { user, profile };
}

function parseNotes(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return {};
    }
}

function timerBounds() {
    return { min: 60, max: 600 };
}

function useAiTimeLimitSeconds(raw) {
    const { min, max } = timerBounds();
    let sec = Number(raw);
    if (!Number.isFinite(sec) || sec <= 0) sec = 240;
    return Math.min(max, Math.max(min, Math.round(sec)));
}

function buildDeadline(isoStart, seconds) {
    return new Date(new Date(isoStart).getTime() + seconds * 1000).toISOString();
}

async function generatePhase1Question(groqKey, { jdTitle, jdReq, cvContext, screeningSummary }) {
    const systemText = [
        'You are a senior technical interviewer.',
        'Generate exactly one Phase 1 written assessment question for this role.',
        'Use scenario-based natural wording — no "on your CV", no company names from background text.',
        'Match depth to the role and any candidate context provided.',
        'Output JSON only:',
        '- phase_1_question: string',
        '- phase_1_time_limit_seconds: number (90-600)',
        '- phase_1_complexity_tier: A | B | C | D',
    ].join('\n');

    const userText = [
        `Job title: ${jdTitle}`,
        `Requirements: ${jdReq}`,
        screeningSummary ? `Screening summary: ${screeningSummary}` : '',
        cvContext ? `Candidate background:\n${cvContext}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${groqKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemText },
                { role: 'user', content: userText },
            ],
            temperature: 0.4,
            response_format: { type: 'json_object' },
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const payload = await res.json();
    const text = payload?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (_) {
        throw new Error('Could not parse Phase 1 question from Groq');
    }

    const q = String(parsed.phase_1_question || '').trim();
    if (!q) throw new Error('Groq returned empty phase_1_question');
    return {
        question: q,
        time_limit_seconds: useAiTimeLimitSeconds(parsed.phase_1_time_limit_seconds),
        complexity_tier: parsed.phase_1_complexity_tier || 'B',
    };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'method_not_allowed' });
        return;
    }

    const supabaseUrl = env('SUPABASE_URL', env('TA_SUPABASE_URL', 'https://vnxstyadacgntnsvcvzn.supabase.co'));
    const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = env('SUPABASE_ANON_KEY', env('TA_SUPABASE_ANON_KEY'));
    const groqKey = env('GROQ_API_KEY');
    const portalBase = env('PORTAL_BASE_URL', DEFAULT_PORTAL).replace(/\/+$/, '');

    if (!serviceKey) {
        res.status(500).json({ ok: false, error: 'service_role_missing' });
        return;
    }
    if (!anonKey) {
        res.status(500).json({ ok: false, error: 'anon_key_missing' });
        return;
    }
    if (!groqKey) {
        res.status(500).json({ ok: false, error: 'groq_key_missing' });
        return;
    }

    const auth = await verifyApprover(req, supabaseUrl, anonKey);
    if (auth.error) {
        res.status(auth.status).json({ ok: false, error: auth.error });
        return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const candidateId = String(body.candidate_id || '').trim();
    if (!candidateId) {
        res.status(400).json({ ok: false, error: 'candidate_id_required' });
        return;
    }

    try {
        const candRes = await sbFetch(
            supabaseUrl,
            serviceKey,
            `/rest/v1/candidates?id=eq.${encodeURIComponent(candidateId)}&limit=1`
        );
        if (!candRes.ok) throw new Error('Could not load candidate');
        const candidate = Array.isArray(candRes.data) ? candRes.data[0] : null;
        if (!candidate) {
            res.status(404).json({ ok: false, error: 'candidate_not_found' });
            return;
        }

        const stage = String(candidate.stage || '');
        if (stage !== 'ReviewQueue') {
            res.status(400).json({
                ok: false,
                error: 'not_in_review',
                message: 'Only Review queue candidates can be manually shortlisted.',
            });
            return;
        }

        const email = String(candidate.candidate_email || '').trim().toLowerCase();
        const requisitionId = String(candidate.requisition_id || '').trim();
        const notes = parseNotes(candidate.notes);
        const screeningSummary = String(notes.summary || notes.screening_summary || '').trim();

        const jobRes = await sbFetch(
            supabaseUrl,
            serviceKey,
            `/rest/v1/jobs?job_id=eq.${encodeURIComponent(requisitionId)}&limit=1`
        );
        const job = Array.isArray(jobRes.data) ? jobRes.data[0] : null;
        const jdTitle = String(job?.title || notes.requisition_title || requisitionId).trim();
        const jdReq = String(job?.jd_text || notes.requisition_requirements || '').trim();
        if (!jdReq) {
            res.status(400).json({ ok: false, error: 'job_description_missing' });
            return;
        }

        const cvContext = String(
            notes.cv_plaintext || notes.cv_text || screeningSummary || ''
        ).slice(0, 12000);

        const phase1 = await generatePhase1Question(groqKey, {
            jdTitle,
            jdReq,
            cvContext,
            screeningSummary,
        });

        const nowIso = new Date().toISOString();
        const timeLimit = phase1.time_limit_seconds;

        const shortlistedNotes = {
            ...notes,
            requisition_id: requisitionId,
            requisition_title: jdTitle,
            recommendation: 'SHORTLIST',
            decision: 'SHORTLIST',
            manual_shortlist: true,
            approved_at: nowIso,
            approved_by: auth.profile.email,
        };

        const stagePatchRes = await sbFetch(
            supabaseUrl,
            serviceKey,
            `/rest/v1/candidates?id=eq.${encodeURIComponent(candidateId)}`,
            {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({
                    stage: 'Shortlisted',
                    notes: shortlistedNotes,
                }),
            }
        );
        if (!stagePatchRes.ok) {
            const detail = formatSbError(stagePatchRes);
            const hint =
                stagePatchRes.status === 409
                    ? ' A Shortlisted row may already exist for this email and job — check candidates table.'
                    : '';
            throw new Error(`Candidate stage update failed: ${detail}${hint}`);
        }

        const sessionBody = {
            gmail_thread_id: null,
            candidate_email: email,
            current_phase: 1,
            max_phases: 5,
            status: 'assessment',
            screening: { ...notes, manual_shortlist: true, approved_by: auth.profile.email },
            score: candidate.score,
            requisition_id: requisitionId,
            fingerprint: candidate.fingerprint || '',
            cv_plaintext: cvContext,
            last_question_sent_at: nowIso,
            updated_at: nowIso,
            config: {
                requisition_id: requisitionId,
                requisition_title: jdTitle,
                requisition_requirements: jdReq,
                organization_name: 'CONVO',
                max_questions: 5,
                speech_phases: 5,
                speech_enabled: true,
                pass_score_threshold: 60,
                fail_score_threshold: 30,
                timer_min_seconds: 60,
                timer_max_seconds: 600,
            },
            interview_history: [
                {
                    phase: 1,
                    question_text: phase1.question,
                    answer_text: null,
                    score: null,
                    suggested_answer: null,
                    feedback: null,
                    time_limit_seconds: timeLimit,
                    deadline_at: buildDeadline(nowIso, timeLimit),
                    complexity_tier: phase1.complexity_tier,
                    sent_at: nowIso,
                },
            ],
        };

        const insertRes = await sbFetch(supabaseUrl, serviceKey, '/rest/v1/assessment_sessions', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(sessionBody),
        });
        if (!insertRes.ok) {
            const msg =
                typeof insertRes.data === 'object'
                    ? JSON.stringify(insertRes.data).slice(0, 300)
                    : String(insertRes.data || '').slice(0, 300);
            throw new Error(`Session insert failed: ${msg}`);
        }
        const session = Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data;
        const sessionId = session?.id;
        if (!sessionId) throw new Error('Session created but no id returned');

        const notesPatchRes = await sbFetch(
            supabaseUrl,
            serviceKey,
            `/rest/v1/candidates?id=eq.${encodeURIComponent(candidateId)}`,
            {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify({
                    notes: {
                        ...shortlistedNotes,
                        assessment_session_id: sessionId,
                    },
                }),
            }
        );
        if (!notesPatchRes.ok) {
            console.warn('manual-shortlist: session link note update failed:', formatSbError(notesPatchRes));
        }

        const assessmentLink =
            `${portalBase}/?session=${encodeURIComponent(sessionId)}&email=${encodeURIComponent(email)}`;

        let emailSent = false;
        let emailError = '';
        const mailWebhook = await resolveMailWebhook(supabaseUrl, serviceKey);
        if (mailWebhook) {
            try {
                const mailRes = await fetch(mailWebhook, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'ngrok-skip-browser-warning': '1',
                    },
                    body: JSON.stringify({
                        candidate_email: email,
                        session_id: sessionId,
                        requisition_id: requisitionId,
                        requisition_title: jdTitle,
                        score: candidate.score,
                        max_questions: 5,
                        organization_name: 'CONVO',
                        portal_base_url: portalBase,
                        assessment_link: assessmentLink,
                        manual_shortlist: true,
                        approved_by: auth.profile.email,
                    }),
                });
                emailSent = mailRes.ok;
                if (!mailRes.ok) {
                    emailError = String(await mailRes.text()).slice(0, 200);
                }
            } catch (mailErr) {
                emailError = String(mailErr?.message || mailErr).slice(0, 200);
            }
        }

        res.status(200).json({
            ok: true,
            session_id: sessionId,
            assessment_link: assessmentLink,
            candidate_email: email,
            requisition_id: requisitionId,
            email_sent: emailSent,
            email_error: emailError || undefined,
            webhook_configured: !!mailWebhook,
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: 'shortlist_failed',
            message: String(err?.message || err).slice(0, 400),
        });
    }
}

/**
 * Talent Acquisition — Admin panel extensions
 * Loaded by dashboard.html after core bootstrap.
 */
(function () {
    'use strict';

    const WEBHOOK_STORAGE = 'ta_cv_ingest_webhook';
    let deps = null;
    let JOBS = [];
    let ONSITE = [];

    function slugFromTitle(title) {
        return String(title || 'role')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 48) || 'role';
    }

    function normalizeWebhookUrl(raw) {
        let url = String(raw || '').trim();
        if (!url) return '';
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        return url.replace(/\/+$/, '');
    }

    function generateJdFromCriteria(opts) {
        const title = String(opts.title || 'Open Position').trim();
        const dept = String(opts.department || 'Engineering').trim();
        const loc = String(opts.location || 'Remote').trim();
        const emp = String(opts.employment_type || 'Full-time').trim();
        const criteria = String(opts.criteria || '')
            .split(/\n/)
            .map((l) => l.replace(/^[\s\-•*]+/, '').trim())
            .filter(Boolean);
        const nice = String(opts.nice || '')
            .split(/\n/)
            .map((l) => l.replace(/^[\s\-•*]+/, '').trim())
            .filter(Boolean);

        const must = criteria.length
            ? criteria.map((c) => `• ${c}`).join('\n')
            : '• Relevant degree or equivalent practical experience\n• Strong communication and ownership';

        const optional = nice.length
            ? nice.map((c) => `• ${c}`).join('\n')
            : '• Experience in fast-paced product teams\n• Open-source or portfolio contributions';

        return (
            `${title}\n` +
            `${dept} · ${emp} · ${loc}\n\n` +
            `About the role\n` +
            `We are hiring a ${title} to deliver on core product and engineering outcomes. ` +
            `You will work closely with stakeholders to ship reliable solutions aligned with business goals.\n\n` +
            `Key responsibilities\n` +
            `${must}\n\n` +
            `Required skills & experience\n` +
            `${must}\n\n` +
            `Nice to have\n` +
            `${optional}\n\n` +
            `What we offer\n` +
            `• Collaborative team and clear growth path\n` +
            `• Modern tooling and structured hiring process\n\n` +
            `How to apply\n` +
            `Submit your CV through our careers portal. Shortlisted candidates complete a structured technical assessment before interview scheduling.`
        );
    }

    async function loadWebhookConfig() {
        if (!deps?.sb) return '';
        const { data } = await deps.sb.from('app_config').select('value').eq('key', 'cv_ingest_webhook').maybeSingle();
        const url = normalizeWebhookUrl(data?.value || localStorage.getItem(WEBHOOK_STORAGE) || '');
        const inp = document.getElementById('admWebhook');
        if (inp && url) inp.value = url;
        return url;
    }

    async function saveWebhookConfig() {
        const url = normalizeWebhookUrl(document.getElementById('admWebhook')?.value || '');
        if (!url) {
            deps.banner('Enter a valid n8n CV ingest webhook URL.', 'err');
            return;
        }
        localStorage.setItem(WEBHOOK_STORAGE, url);
        if (deps.sb) {
            await deps.sb.from('app_config').upsert(
                { key: 'cv_ingest_webhook', value: url, updated_at: new Date().toISOString() },
                { onConflict: 'key' }
            );
        }
        deps.banner('Webhook URL saved.', 'ok');
    }

    async function loadJobs() {
        if (!deps?.sb) return;
        const { data, error } = await deps.sb.from('jobs').select('*').order('updated_at', { ascending: false });
        if (error) {
            deps.banner('Jobs load failed: ' + error.message, 'err');
            return;
        }
        JOBS = data || [];
        renderJobs();
        populateJobSelects();
    }

    function populateJobSelects() {
        const selects = ['scrJob', 'onsJob', 'jobEditId'];
        selects.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (id === 'jobEditId') {
                el.innerHTML = '<option value="">New job</option>' +
                    JOBS.map((j) => `<option value="${j.id}">${deps.esc(j.title)} (${j.status})</option>`).join('');
                return;
            }
            const openJobs = JOBS.filter((j) => j.status === 'open');
            el.innerHTML = '<option value="">Select job…</option>' +
                openJobs.map((j) =>
                    `<option value="${deps.esc(j.job_id)}" data-job-id="${deps.esc(j.id)}">${deps.esc(j.title)}</option>`
                ).join('');
        });
    }

    function renderJobs() {
        const tb = document.getElementById('jobsBody');
        if (!tb) return;
        if (!JOBS.length) {
            tb.innerHTML = '<tr><td class="empty" colspan="6">No jobs yet — create one in the form.</td></tr>';
            return;
        }
        tb.innerHTML = JOBS.map((j) =>
            `<tr data-job="${j.id}">
                <td><strong>${deps.esc(j.title)}</strong><div class="c-role">${deps.esc(j.job_id)}</div></td>
                <td>${deps.esc(j.location || '—')}</td>
                <td><span class="pill ${j.status === 'open' ? 'p-pass' : j.status === 'draft' ? 'p-pending' : 'p-reject'}">${deps.esc(j.status)}</span></td>
                <td class="c-role">${deps.fmtDate(j.updated_at)}</td>
                <td><button type="button" class="btn-sm" data-edit-job="${j.id}">Edit</button></td>
                <td><button type="button" class="btn-sm btn-danger" data-del-job="${j.id}">Delete</button></td>
            </tr>`
        ).join('');

        tb.querySelectorAll('[data-edit-job]').forEach((btn) => {
            btn.addEventListener('click', () => fillJobForm(btn.getAttribute('data-edit-job')));
        });
        tb.querySelectorAll('[data-del-job]').forEach((btn) => {
            btn.addEventListener('click', () => deleteJob(btn.getAttribute('data-del-job')));
        });
    }

    function setSelectValue(id, value, fallback) {
        const el = document.getElementById(id);
        if (!el) return;
        const v = String(value || fallback || '').trim();
        if (v && ![...el.options].some((o) => o.value === v)) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            el.appendChild(opt);
        }
        el.value = v || fallback || el.options[0]?.value || '';
    }

    function fillJobForm(id) {
        const j = JOBS.find((x) => x.id === id);
        if (!j) return;
        document.getElementById('jobEditId').value = j.id;
        document.getElementById('jobTitleIn').value = j.title || '';
        document.getElementById('jobDeptIn').value = j.department || '';
        setSelectValue('jobLocIn', j.location, 'Remote');
        setSelectValue('jobTypeIn', j.employment_type, 'Full-time');
        document.getElementById('jobIntIn').value = j.interviewer_email || '';
        document.getElementById('jobStatusIn').value = j.status || 'draft';
        document.getElementById('jobCriteriaIn').value = '';
        document.getElementById('jobJdIn').value = j.jd_text || '';
        deps.setView('jobs');
    }

    async function saveJob() {
        const id = document.getElementById('jobEditId').value;
        const title = document.getElementById('jobTitleIn').value.trim();
        const jd_text = document.getElementById('jobJdIn').value.trim();
        const interviewer_email = document.getElementById('jobIntIn').value.trim().toLowerCase();
        if (!title || !jd_text) {
            deps.banner('Job title and description are required.', 'err');
            return;
        }
        if (!interviewer_email) {
            deps.banner('Interviewer email is required.', 'err');
            return;
        }
        const row = {
            title,
            jd_text,
            job_id: slugFromTitle(title),
            department: document.getElementById('jobDeptIn').value.trim() || null,
            location: document.getElementById('jobLocIn').value || 'Remote',
            employment_type: document.getElementById('jobTypeIn').value || 'Full-time',
            interviewer_email,
            status: document.getElementById('jobStatusIn').value || 'draft',
            updated_at: new Date().toISOString(),
        };
        let error;
        if (id) {
            ({ error } = await deps.sb.from('jobs').update(row).eq('id', id));
        } else {
            ({ error } = await deps.sb.from('jobs').insert(row));
        }
        if (error) {
            deps.banner('Save job failed: ' + error.message, 'err');
            return;
        }
        deps.banner('Job saved.', 'ok');
        document.getElementById('jobForm').reset();
        document.getElementById('jobEditId').value = '';
        await loadJobs();
    }

    async function deleteJob(id) {
        if (!confirm('Delete this job posting?')) return;
        const { error } = await deps.sb.from('jobs').delete().eq('id', id);
        if (error) {
            deps.banner('Delete job failed: ' + error.message + ' — run supabase_admin_panel.sql', 'err');
            return;
        }
        deps.banner('Job deleted.', 'ok');
        await loadJobs();
    }

    function onJobCriteriaGenerate() {
        const jd = generateJdFromCriteria({
            title: document.getElementById('jobTitleIn').value,
            department: document.getElementById('jobDeptIn').value,
            location: document.getElementById('jobLocIn').value,
            employment_type: document.getElementById('jobTypeIn').value,
            criteria: document.getElementById('jobCriteriaIn').value,
            nice: document.getElementById('jobNiceIn').value,
        });
        document.getElementById('jobJdIn').value = jd;
        deps.banner('Job description generated from criteria — review and edit before saving.', 'ok');
    }

    function onScreenJobPick() {
        const sel = document.getElementById('scrJob');
        const opt = sel?.selectedOptions?.[0];
        const job = JOBS.find((j) => j.id === opt?.dataset?.jobId);
        if (!job) return;
        document.getElementById('scrTitle').value = job.title || '';
        document.getElementById('scrJd').value = job.jd_text || '';
        document.getElementById('scrInt').value = job.interviewer_email || '';
    }

    async function submitManualScreen(e) {
        e.preventDefault();
        const webhook = normalizeWebhookUrl(document.getElementById('admWebhook')?.value || localStorage.getItem(WEBHOOK_STORAGE));
        if (!webhook) {
            deps.banner('Set CV ingest webhook in Settings first.', 'err');
            deps.setView('settings');
            return;
        }
        const email = document.getElementById('scrEmail').value.trim().toLowerCase();
        const title = document.getElementById('scrTitle').value.trim();
        const requirements = document.getElementById('scrJd').value.trim();
        const interviewer = document.getElementById('scrInt').value.trim();
        const cvText = document.getElementById('scrCvText').value.trim();
        const file = document.getElementById('scrCvFile').files?.[0];
        if (!email || !title || !requirements) {
            deps.banner('Email, job title, and JD are required.', 'err');
            return;
        }
        if (!cvText && !file) {
            deps.banner('Paste CV text or upload a PDF.', 'err');
            return;
        }

        const btn = document.getElementById('scrSubmit');
        btn.disabled = true;
        btn.textContent = 'Screening…';
        try {
            const fd = new FormData();
            fd.append('candidate_email', email);
            fd.append('requisition_title', title);
            fd.append('requisition_requirements', requirements);
            fd.append('requisition_id', slugFromTitle(title));
            fd.append('source', 'admin_manual_screen');
            if (interviewer) fd.append('interviewer_email', interviewer);
            if (file) fd.append('cv_file', file, file.name);
            else fd.append('cv_text', cvText);

            const res = await fetch(webhook, { method: 'POST', body: fd, headers: { 'ngrok-skip-browser-warning': '1' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            deps.banner('CV sent for AI screening — refresh Candidates in ~30s.', 'ok');
            document.getElementById('screenForm').reset();
            setTimeout(() => deps.loadData(), 4000);
        } catch (err) {
            deps.banner('Screening failed: ' + (err.message || err), 'err');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Run AI screening';
        }
    }

    async function loadOnsite() {
        if (!deps?.sb) return;
        const { data, error } = await deps.sb.from('onsite_interviews').select('*').order('interview_date', { ascending: false }).limit(500);
        if (error) {
            deps.banner('Onsite records: ' + error.message + ' — run supabase_admin_panel.sql', 'err');
            return;
        }
        ONSITE = data || [];
        renderOnsite();
    }

    function renderOnsite() {
        const tb = document.getElementById('onsiteBody');
        if (!tb) return;
        if (!ONSITE.length) {
            tb.innerHTML = '<tr><td class="empty" colspan="6">No onsite interview records yet.</td></tr>';
            return;
        }
        tb.innerHTML = ONSITE.map((r) =>
            `<tr>
                <td><strong>${deps.esc(r.candidate_email)}</strong>${r.candidate_name ? '<div class="c-role">' + deps.esc(r.candidate_name) + '</div>' : ''}</td>
                <td class="c-role">${deps.esc(r.job_title || r.job_id || '—')}</td>
                <td>${deps.fmtDateTime(r.interview_date)}</td>
                <td>${deps.esc(r.interview_type || 'onsite')}</td>
                <td><span class="pill p-pending">${deps.esc(r.outcome || 'pending')}</span></td>
                <td><button type="button" class="btn-sm btn-danger" data-del-onsite="${r.id}">Delete</button></td>
            </tr>`
        ).join('');
        tb.querySelectorAll('[data-del-onsite]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this onsite record?')) return;
                await deps.sb.from('onsite_interviews').delete().eq('id', btn.getAttribute('data-del-onsite'));
                await loadOnsite();
            });
        });
    }

    async function saveOnsite(e) {
        e.preventDefault();
        const row = {
            candidate_email: document.getElementById('onsEmail').value.trim().toLowerCase(),
            candidate_name: document.getElementById('onsName').value.trim() || null,
            job_id: document.getElementById('onsJob').value || null,
            job_title: (() => {
                const opt = document.getElementById('onsJob')?.selectedOptions?.[0];
                const job = JOBS.find((j) => j.id === opt?.dataset?.jobId);
                return job?.title || null;
            })(),
            interview_date: new Date(document.getElementById('onsDate').value).toISOString(),
            interview_type: document.getElementById('onsType').value,
            outcome: document.getElementById('onsOutcome').value || 'pending',
            interviewer_name: document.getElementById('onsInterviewer').value.trim() || null,
            location: document.getElementById('onsLocation').value.trim() || null,
            notes: document.getElementById('onsNotes').value.trim() || null,
            score: document.getElementById('onsScore').value ? Number(document.getElementById('onsScore').value) : null,
        };
        if (!row.candidate_email || !document.getElementById('onsDate').value) {
            deps.banner('Candidate email and interview date required.', 'err');
            return;
        }
        const { error } = await deps.sb.from('onsite_interviews').insert(row);
        if (error) {
            deps.banner('Save onsite failed: ' + error.message, 'err');
            return;
        }
        deps.banner('Onsite interview recorded.', 'ok');
        document.getElementById('onsiteForm').reset();
        await loadOnsite();
    }

    async function deleteCandidateRecord(m) {
        if (!m || !confirm('Permanently delete all records for ' + m.email + '? This cannot be undone.')) return;
        const email = String(m.email || '').toLowerCase();
        const errs = [];

        if (m.session?.id) {
            const { error } = await deps.sb.from('assessment_sessions').delete().eq('id', m.session.id);
            if (error) errs.push('session: ' + error.message);
        } else {
            const { error } = await deps.sb.from('assessment_sessions').delete().eq('candidate_email', email);
            if (error) errs.push('session: ' + error.message);
        }
        if (m.candidateId) {
            const { error } = await deps.sb.from('candidates').delete().eq('id', m.candidateId);
            if (error) errs.push('candidate: ' + error.message);
        } else {
            const { error } = await deps.sb.from('candidates').delete().eq('candidate_email', email);
            if (error) errs.push('candidate: ' + error.message);
        }
        await deps.sb.from('onsite_interviews').delete().eq('candidate_email', email);

        if (errs.length) {
            deps.banner('Partial delete — run supabase_admin_panel.sql. ' + errs.join('; '), 'err');
        } else {
            deps.banner('Candidate deleted.', 'ok');
        }
        deps.closeDrawer();
        await deps.loadData();
        await loadOnsite();
    }

    function bindEvents() {
        document.getElementById('jobForm')?.addEventListener('submit', (e) => { e.preventDefault(); saveJob(); });
        document.getElementById('jobGenBtn')?.addEventListener('click', onJobCriteriaGenerate);
        document.getElementById('jobResetBtn')?.addEventListener('click', () => {
            document.getElementById('jobForm').reset();
            document.getElementById('jobEditId').value = '';
        });
        document.getElementById('screenForm')?.addEventListener('submit', submitManualScreen);
        document.getElementById('scrJob')?.addEventListener('change', onScreenJobPick);
        document.getElementById('onsiteForm')?.addEventListener('submit', saveOnsite);
        document.getElementById('saveWebhookBtn')?.addEventListener('click', saveWebhookConfig);
        document.getElementById('drawerDeleteBtn')?.addEventListener('click', () => {
            if (deps.activeCandidate) deleteCandidateRecord(deps.activeCandidate);
        });
    }

    window.TAAdmin = {
        init(d) {
            deps = d;
            deps.activeCandidate = null;
            bindEvents();
            loadWebhookConfig();
            loadJobs();
            loadOnsite();
        },
        onViewChange(view) {
            if (view === 'jobs') loadJobs();
            if (view === 'onsite') loadOnsite();
            if (view === 'settings') loadWebhookConfig();
        },
        setActiveCandidate(m) {
            deps.activeCandidate = m;
            const btn = document.getElementById('drawerDeleteBtn');
            if (btn) btn.style.display = m ? 'inline-flex' : 'none';
        },
        renderOnsiteForDrawer(email) {
            const rows = ONSITE.filter((r) => String(r.candidate_email).toLowerCase() === String(email).toLowerCase());
            if (!rows.length) return '';
            let html = '<div class="section"><div class="section-h">Onsite interviews</div>';
            rows.forEach((r) => {
                html += '<div class="qblock"><div class="qphase"><strong>' + deps.esc(deps.fmtDateTime(r.interview_date)) + '</strong>' +
                    '<span class="pill p-pending">' + deps.esc(r.outcome || 'pending') + '</span></div>';
                if (r.notes) html += '<div class="qtext ans">' + deps.esc(r.notes) + '</div>';
                html += '</div>';
            });
            return html + '</div>';
        },
    };
})();

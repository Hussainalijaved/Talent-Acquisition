// Unit test: final combined score = tech*0.7 + voice*0.3
function avgPhaseScores(history, predicate) {
    const scores = history
        .filter(predicate)
        .map((h) => Number(h.score))
        .filter((n) => Number.isFinite(n));
    if (!scores.length) return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function computeFinalScores(session, history, maxQ, sessCfg) {
    const speechPhases = Number(sessCfg.speech_phases ?? 5);
    const techFromHistory = avgPhaseScores(history, (h) => {
        const ph = Number(h.phase);
        return ph >= 1 && ph <= maxQ;
    });
    const techAvg = Number(session.technical_score) || techFromHistory || 0;
    const speechFromHistory = avgPhaseScores(history, (h) => Number(h.phase) > maxQ);
    const speechAvg = speechFromHistory || 0;
    const tw = Number(sessCfg.technical_weight ?? 0.7);
    const sw = Number(sessCfg.speech_weight ?? 0.3);
    const pt = Number(sessCfg.pass_score_threshold ?? 60);
    const combined = techAvg > 0 ? Math.round(techAvg * tw + speechAvg * sw) : speechAvg;
    const result = combined >= pt ? 'PASS' : 'FAIL';
    return { techAvg, speechAvg, combined, result, speechPhases, passThreshold: pt };
}

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok   - ${name}`);
    else { failures += 1; console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`); }
}

const history = [];
for (let p = 1; p <= 5; p++) history.push({ phase: p, score: 64, answer_text: 'a' });
for (let p = 6; p <= 10; p++) history.push({ phase: p, score: 47, answer_text: 'a', mode: 'live_speech' });

const out = computeFinalScores({ technical_score: 64 }, history, 5, {
    technical_weight: 0.7,
    speech_weight: 0.3,
    pass_score_threshold: 60,
    speech_phases: 5,
});

console.log('=== final combined score ===');
check('combined is 59', out.combined === 59, String(out.combined));
check('result is FAIL', out.result === 'FAIL', out.result);
check('tech avg 64', out.techAvg === 64);
check('speech avg 47', out.speechAvg === 47);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

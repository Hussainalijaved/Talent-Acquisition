// Unit test: scoreAllTurnsOverall — voice-only, no transcripts.
import { scoreAllTurnsOverall } from '../relay/lib/score-turns.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}`);
  else { failures += 1; console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`); }
}

const ctx = { requisition_title: 'Backend Engineer', voice_only: true };
const tinyPcm = Buffer.from(new Int16Array([100, -100, 200, -200]).buffer).toString('base64');
const turnsWithAudio = [
  { phase: 6, voice_question_number: 1, question_text: 'Tell me about a project.', answer_text: '[Voice response recorded]', answer_pcm_chunks: [tinyPcm], answer_pcm_sample_rate: 16000 },
  { phase: 7, voice_question_number: 2, question_text: 'A challenge?', answer_text: '[Voice response recorded]', answer_pcm_chunks: [tinyPcm, tinyPcm], answer_pcm_sample_rate: 16000 },
];

const origFetch = global.fetch;

async function run() {
  console.log('=== scoreAllTurnsOverall (voice-only) ===');

  // 1) No PCM → no_speech without calling API.
  let callCount = 0;
  global.fetch = async () => { callCount += 1; return { ok: true, json: async () => ({}) }; };
  const r0 = await scoreAllTurnsOverall({
    apiKey: 'k', context: ctx,
    turns: [{ phase: 6, question_text: 'Q?', answer_text: '[Voice response recorded]', answer_pcm_chunks: [] }],
  });
  check('no PCM → no_speech, no API call', r0.scoring_source === 'no_speech' && callCount === 0, JSON.stringify(r0));

  // 2) Happy path — audio-only overall score.
  callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          overall_score: 78,
          communication_clarity: 80,
          fluency: 75,
          confidence: 76,
          professionalism: 82,
          english_proficiency: 79,
          answer_relevance: 74,
          final_feedback: 'Clear, confident delivery overall.',
        }) }] } }],
      }),
      text: async () => '',
    };
  };
  const r1 = await scoreAllTurnsOverall({ apiKey: 'k', context: ctx, turns: turnsWithAudio });
  check('single API call with audio', callCount === 1, `calls=${callCount}`);
  check('overall score parsed', r1.combined_speech_score === 78, String(r1.combined_speech_score));
  check('audio-only source', r1.scoring_source === 'audio_primary_overall', r1.scoring_source);

  // 3) API failure → voice PCM heuristic (not transcript fallback).
  global.fetch = async () => { throw new Error('network down'); };
  const r2 = await scoreAllTurnsOverall({ apiKey: 'k', context: ctx, turns: turnsWithAudio });
  check('fallback uses voice heuristic', r2.scoring_source === 'voice_pcm_heuristic', r2.scoring_source);
  check('fallback yields score', Number.isFinite(r2.combined_speech_score), String(r2.combined_speech_score));

  // 4) Empty turns.
  const r3 = await scoreAllTurnsOverall({ apiKey: 'k', context: ctx, turns: [] });
  check('no turns → 0', r3.combined_speech_score === 0 && r3.scoring_source === 'no_speech', JSON.stringify(r3));
}

run()
  .catch((e) => { console.error(e); failures += 1; })
  .finally(() => {
    global.fetch = origFetch;
    console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
    process.exit(failures === 0 ? 0 : 1);
  });

// Unit test: scoreAllTurnsOverall produces ONE overall speech score from all
// answers in a single call, and falls back to a per-turn average on failure.
import { scoreAllTurnsOverall } from '../relay/lib/score-turns.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}`);
  else { failures += 1; console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`); }
}

const ctx = { requisition_title: 'Backend Engineer' };
const turns = [
  { phase: 6, voice_question_number: 1, question_text: 'Tell me about a project.', answer_text: 'I built a scalable API used by thousands of users daily.', answer_pcm_chunks: [] },
  { phase: 7, voice_question_number: 2, question_text: 'A challenge you faced?', answer_text: 'We had a major outage and I led the incident response calmly.', answer_pcm_chunks: [] },
  { phase: 8, voice_question_number: 3, question_text: 'Teamwork example?', answer_text: 'I mentored two juniors and we shipped on time.', answer_pcm_chunks: [] },
];

const origFetch = global.fetch;

async function run() {
  console.log('=== scoreAllTurnsOverall ===');

  // 1) Happy path — model returns one overall score in a single call.
  let callCount = 0;
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
  const r1 = await scoreAllTurnsOverall({ apiKey: 'k', context: ctx, turns });
  check('single API call for all turns', callCount === 1, `calls=${callCount}`);
  check('overall score parsed', r1.combined_speech_score === 78, String(r1.combined_speech_score));
  check('soft skills present', r1.soft_skills && r1.soft_skills.fluency === 75, JSON.stringify(r1.soft_skills));
  check('feedback present', /confident/i.test(r1.final_feedback), r1.final_feedback);
  check('scoring_source transcript (no audio)', r1.scoring_source === 'transcript_only_overall', r1.scoring_source);

  // 2) Failure path — overall call throws, falls back to per-turn average.
  let n = 0;
  global.fetch = async () => {
    n += 1;
    if (n === 1) throw new Error('network down');
    // Per-turn fallback calls return a fixed score each.
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          phase: 6, score: 60, communication_clarity: 60, fluency: 60,
          confidence: 60, professionalism: 60, english_proficiency: 60, answer_relevance: 60,
          feedback: 'ok',
        }) }] } }],
      }),
      text: async () => 'err',
    };
  };
  const r2 = await scoreAllTurnsOverall({ apiKey: 'k', context: ctx, turns });
  check('fallback yields a score', Number.isFinite(r2.combined_speech_score), String(r2.combined_speech_score));
  check('fallback source flagged', r2.scoring_source === 'per_turn_average_fallback', r2.scoring_source);

  // 3) No turns — safe zero.
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

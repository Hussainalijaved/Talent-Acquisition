// Unit tests for relay/lib/transcript-utils.mjs
import {
  appendTranscriptionChunk,
  cleanUserAnswerText,
  displayUserTranscript,
  extractEnglishAnswer,
  extractInterviewQuestion,
  isClosingOnlyMessage,
  isClosingMessage,
  isEnglishTranscript,
  resolveCommittedQuestionText,
} from '../relay/lib/transcript-utils.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok   - ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL - ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

console.log('=== extractEnglishAnswer ===');
check('keeps english', extractEnglishAnswer('I built an API with ASP.NET Core')?.includes('ASP.NET'));
check('strips non-latin script', !extractEnglishAnswer('I built an API مرحبا بالعربي')?.includes('مرحبا'));
check('keeps latin-script english', extractEnglishAnswer("okay we did the project close to pilot")?.includes('pilot'));
check('empty on noise', !extractEnglishAnswer('[noise]'));

console.log('\n=== cleanUserAnswerText ===');
check('english answer kept', cleanUserAnswerText('I am motivated by building real .NET backends')?.length > 10);
check('non-english flagged', /non-english/i.test(cleanUserAnswerText('مرحبا كيف حالك بالعربي فقط')));
check('noise flagged', /no spoken|noise/i.test(cleanUserAnswerText('[noise]') || cleanUserAnswerText('')));

console.log('\n=== displayUserTranscript (live captions) ===');
check('partial english shows', displayUserTranscript('okay we were close to the pilot I communicate')?.includes('pilot'));
check('does not blank mid-speech', displayUserTranscript('well actually I use').length > 5);

console.log('\n=== isEnglishTranscript ===');
check('english true', isEnglishTranscript('Hello this is my answer about EF Core'));
check('arabic false', !isEnglishTranscript('مرحبا'));

console.log('\n=== isClosingMessage ===');
check('thank you detected', isClosingMessage('Thank you for your time — that completes the voice interview.'));
check('question not closing', !isClosingMessage('What motivates you about this role?'));

console.log('\n=== isClosingOnlyMessage ===');
check('question with thank-you prefix is not closing-only', !isClosingOnlyMessage(
  'Thank you. Describe a time you had to collaborate with someone who disagreed with your approach. How did you handle it?'
));
check('pure closing is closing-only', isClosingOnlyMessage('Thank you for your time — that completes the voice interview.'));

console.log('\n=== extractInterviewQuestion ===');
check('strips leading thank you', extractInterviewQuestion(
  'Thank you. Describe a time you had to collaborate with someone who disagreed. How did you handle it?'
)?.includes('collaborate'));
check('strips trailing closing', extractInterviewQuestion(
  'What motivates you about this role? Thank you for your time.'
)?.includes('motivates'));

console.log('\n=== appendTranscriptionChunk ===');
check('empty chunk keeps buffer', appendTranscriptionChunk('hello', '') === 'hello');
check('append incremental', appendTranscriptionChunk('hello ', 'world') === 'hello world');
check('dedupe duplicate tail', appendTranscriptionChunk('hello world', 'world') === 'hello world');
check('cumulative replace', appendTranscriptionChunk('hello', 'hello world') === 'hello world');
check('overlap merge', appendTranscriptionChunk('I worked on', 'on a project') === 'I worked on a project');

console.log('\n=== resolveCommittedQuestionText ===');
check('prefers streamed over fallback', resolveCommittedQuestionText(
  'That is good to know. Can you describe a setback you learned from?',
  'Describe a time you had to collaborate with someone who disagreed with your approach. How did you handle it?'
)?.includes('setback'));
check('uses final when no stream', resolveCommittedQuestionText('', 'What is your greatest strength?')?.includes('strength'));

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

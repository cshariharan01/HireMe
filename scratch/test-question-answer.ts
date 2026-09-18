import db from '@/lib/db';
import { resolveChatbotTextAnswer } from '@/lib/apply/naukri';
import { answerScreeningQuestion } from '@/lib/apply/questions';

async function main() {
  const profileRow = db.prepare('SELECT parsed_json FROM my_profile WHERE id = 1').get() as any;
  const profile = JSON.parse(profileRow.parsed_json);

  const testQuestion = 'Are you residing curretly in Hydrabad ?';
  console.log('Profile location:', profile.location);
  console.log('Question:', testQuestion);

  // 1. Check resolveChatbotTextAnswer
  const heuristicAns = resolveChatbotTextAnswer(testQuestion, profile, 'Datagaps');
  console.log('resolveChatbotTextAnswer returned:', JSON.stringify(heuristicAns));

  // 2. Check answerScreeningQuestion
  try {
    const screeningAns = await answerScreeningQuestion(
      testQuestion,
      null,
      profile,
      { jobTitle: 'Data Engineer', company: 'Datagaps' }
    );
    console.log('answerScreeningQuestion returned:', screeningAns);
  } catch (err) {
    console.error('answerScreeningQuestion threw error:', err);
  }
}

main().catch(console.error);

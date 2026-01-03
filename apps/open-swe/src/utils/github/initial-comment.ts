import { generateCommentWithLLM } from "./llm-comment-generator.js";

/**
 * Generate a natural initial comment when an issue is labeled.
 * Uses LLM to generate natural language comments that match the issue language.
 * Responds in the same language as the issue content.
 */
export async function generateInitialComment(input: {
  issueTitle: string;
  issueBody: string;
  isAutoAccept: boolean;
}): Promise<string> {
  const { issueTitle, issueBody, isAutoAccept } = input;
  
  const fallbackMessage = isAutoAccept
    ? "🔥 Oke, để mình xem và bắt tay vào làm ngay nha!"
    : "👀 Nhận! Mình sẽ lên plan rồi gửi bạn review nhé.";

  const prompt = `You are a chill, friendly AI dev assistant. Someone just tagged you on a GitHub issue and you need to drop a quick comment to let them know you're on it.

Issue: "${issueTitle}"
${issueBody ? `Details: ${issueBody.slice(0, 300)}${issueBody.length > 300 ? '...' : ''}` : ''}
Mode: ${isAutoAccept ? "Jump straight into coding" : "Create a plan first for them to review"}

Rules:
- Super short! Just 1-2 casual sentences
- Sound like a real person, not a bot
- Pick a fun emoji to start (🚀, 👀, 🔥, 💪, 🛠️, etc.)
- Match the vibe and language of the issue - if they wrote in Vietnamese, reply in Vietnamese. English issue = English reply.
- ${isAutoAccept ? "Let them know you're diving in right now" : "Mention you'll whip up a plan for them to check out"}
- NO formal language, NO "I will proceed to...", NO corporate speak
- Be genuine, like texting a coworker

Bad examples (too robotic):
- "I have received your request and will begin processing..."
- "Open SWE has been triggered for this issue. Processing..."

Good examples:
- "🔥 Yo! Looks interesting, lemme dig in and get started!"
- "👀 On it! Give me a sec to put together a game plan."
- "🚀 Oke nhận! Để mình xem qua và bắt tay vào làm nha."
- "💪 Ngon, mình sẽ lên plan rồi gửi bạn review nhé!"

Just the comment text, nothing else.`;

  return generateCommentWithLLM(prompt, fallbackMessage, {
    issueTitle,
    isAutoAccept,
    commentType: "initial",
  });
}

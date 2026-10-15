export function greetingReply(text: string): string | null {
  const greeting = text.trim().replace(/^@[a-z0-9_]+\s+/i, "").replace(/\s+@[a-z0-9_]+$/i, "").replace(/[.!?]+$/, "").trim().toLowerCase();
  if (["hi", "hello", "hey"].includes(greeting)) return "Hi!";
  if (greeting === "salom") return "Salom!";
  if (["привет", "здравствуйте"].includes(greeting)) return "Привет!";
  return null;
}

export function contextCoverageLimitation(collectedSince: number): string {
  return `Captured context begins ${new Date(collectedSince).toISOString()}. Only a bounded selection of supplied sources is available. Omitted sources do not prove absence. Uncaptured history is unavailable.`;
}

// Retention prunes and flood skips drop messages from captured context. Say so on results so
// a missing message never reads as proof it did not exist.
export const boundedCaptureLimitation = "Passive capture in this scope was bounded by retention or flood limits, so some older or burst messages are missing. Omitted messages do not prove absence.";

export function conversationAnswer(text: string, limitations: string[], collectedSince: number): string {
  const relevant = limitations.filter(item => item !== contextCoverageLimitation(collectedSince));
  const answer = text.trim().replace(/^Needs input:\s*/, "");
  return [answer || "I couldn't produce an answer. Please try again.", ...relevant].join("\n\n");
}

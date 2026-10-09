export function contextCoverageLimitation(collectedSince: number): string {
  return `Captured context begins ${new Date(collectedSince).toISOString()}. Only a bounded selection of supplied sources is available. Omitted sources do not prove absence. Uncaptured history is unavailable.`;
}

export function conversationAnswer(text: string, limitations: string[], collectedSince: number): string {
  const relevant = limitations.filter(item => item !== contextCoverageLimitation(collectedSince));
  const answer = text.trim().replace(/^Needs input:\s*/, "");
  return [answer || "I couldn't produce an answer. Please try again.", ...relevant].join("\n\n");
}

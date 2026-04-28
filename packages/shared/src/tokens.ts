export interface Message {
  role: string;
  content: string;
  toolResults?: unknown;
  importance?: number;
  timestamp?: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil([...text].length / 4);
}

export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || "");
    if (msg.toolResults) {
      total += estimateTokens(JSON.stringify(msg.toolResults));
    }
  }
  return total;
}

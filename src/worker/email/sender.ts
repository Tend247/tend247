// Outbound email behind one interface. Phase 0 ships the console and memory senders; the
// Cloudflare Email Sending, Postmark and Resend senders arrive with Phase 2 notifications.

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  readonly name: string;
  /** False when nothing can actually reach an inbox; email sign-in links are then turned off. */
  readonly canDeliver: boolean;
  send(message: OutboundEmail): Promise<void>;
}

/**
 * Logs messages instead of sending them. Local development ONLY: the log contains working
 * sign-in links, so production never uses it (see src/worker/index.ts).
 */
export class ConsoleEmailSender implements EmailSender {
  readonly name = "console";
  readonly canDeliver = true;
  async send(message: OutboundEmail): Promise<void> {
    console.log(`[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
  }
}

/** Keeps messages in memory (tests, and the demo's Sent mail viewer later). */
export class MemoryEmailSender implements EmailSender {
  readonly name = "memory";
  readonly canDeliver = true;
  readonly sent: OutboundEmail[] = [];
  async send(message: OutboundEmail): Promise<void> {
    this.sent.push(message);
  }
}

/** No outbound email configured yet: features that need email stay off. */
export class DisabledEmailSender implements EmailSender {
  readonly name = "disabled";
  readonly canDeliver = false;
  async send(): Promise<void> {
    throw new Error("Outbound email is not configured");
  }
}

// Outbound email behind one interface: Cloudflare Email Service (a Worker binding), Postmark
// or Resend in production; console and memory senders for development and tests.

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Replies go here (reply+<code>@inbound-domain threads them onto the record). */
  replyTo?: string;
  /** Extra headers, e.g. In-Reply-To / References to keep a mail client's thread. */
  headers?: Record<string, string>;
}

export interface EmailSender {
  readonly name: string;
  /** False when nothing can actually reach an inbox; email sign-in links are then turned off. */
  readonly canDeliver: boolean;
  /** Sends the message; resolves to the provider's message id when it gives one. */
  send(message: OutboundEmail): Promise<string | void>;
}

/**
 * Logs messages instead of sending them. Local development ONLY: the log contains working
 * sign-in links, so production never uses it (see src/worker/index.ts).
 */
export class ConsoleEmailSender implements EmailSender {
  readonly name = "console";
  readonly canDeliver = true;
  async send(message: OutboundEmail): Promise<void> {
    console.log(
      `[email] to=${message.to} subject=${JSON.stringify(message.subject)}${message.replyTo ? ` reply-to=${message.replyTo}` : ""}\n${message.text}`,
    );
  }
}

/** Keeps messages in memory (tests, and the demo's Sent mail viewer later). */
export class MemoryEmailSender implements EmailSender {
  readonly name = "memory";
  readonly canDeliver = true;
  readonly sent: OutboundEmail[] = [];
  async send(message: OutboundEmail): Promise<string> {
    this.sent.push(message);
    return `<mem-${this.sent.length}@tend247.test>`;
  }
}

/** No outbound email configured: features that need email stay off. */
export class DisabledEmailSender implements EmailSender {
  readonly name = "disabled";
  readonly canDeliver = false;
  async send(): Promise<void> {
    throw new Error("Outbound email is not configured");
  }
}

interface SendEmailBinding {
  send(message: Record<string, unknown>): Promise<{ messageId?: string }>;
}

/** Cloudflare Email Service: wrangler `send_email: [{ name: "EMAIL" }]`, sender domain verified. */
export class CloudflareEmailSender implements EmailSender {
  readonly name = "cloudflare";
  readonly canDeliver = true;
  private readonly binding: SendEmailBinding;
  private readonly from: string;
  constructor(binding: unknown, from: string) {
    this.binding = binding as SendEmailBinding;
    this.from = from;
  }
  async send(m: OutboundEmail): Promise<string | void> {
    const res = await this.binding.send({
      to: m.to,
      from: this.from,
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      ...(m.headers ? { headers: m.headers } : {}),
    });
    return res?.messageId;
  }
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

async function failOnError(res: Response, provider: string): Promise<unknown> {
  const body = await res.text();
  if (!res.ok) throw new Error(`${provider} rejected the email: ${res.status} ${body.slice(0, 300)}`);
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/** Postmark (POST /email with a server token). */
export class PostmarkEmailSender implements EmailSender {
  readonly name = "postmark";
  readonly canDeliver = true;
  private readonly token: string;
  private readonly from: string;
  private readonly fetchFn: FetchFn;
  constructor(token: string, from: string, fetchFn: FetchFn = fetch) {
    this.token = token;
    this.from = from;
    this.fetchFn = fetchFn;
  }
  async send(m: OutboundEmail): Promise<string | void> {
    const res = await this.fetchFn("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-postmark-server-token": this.token },
      body: JSON.stringify({
        From: this.from,
        To: m.to,
        Subject: m.subject,
        TextBody: m.text,
        ...(m.html ? { HtmlBody: m.html } : {}),
        ...(m.replyTo ? { ReplyTo: m.replyTo } : {}),
        ...(m.headers ? { Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
        MessageStream: "outbound",
      }),
    });
    const json = (await failOnError(res, "Postmark")) as { MessageID?: string };
    return json.MessageID;
  }
}

/** Resend (POST /emails with an API key). */
export class ResendEmailSender implements EmailSender {
  readonly name = "resend";
  readonly canDeliver = true;
  private readonly key: string;
  private readonly from: string;
  private readonly fetchFn: FetchFn;
  constructor(key: string, from: string, fetchFn: FetchFn = fetch) {
    this.key = key;
    this.from = from;
    this.fetchFn = fetchFn;
  }
  async send(m: OutboundEmail): Promise<string | void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        from: this.from,
        to: [m.to],
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(m.replyTo ? { reply_to: m.replyTo } : {}),
        ...(m.headers ? { headers: m.headers } : {}),
      }),
    });
    const json = (await failOnError(res, "Resend")) as { id?: string };
    return json.id;
  }
}

import { desc } from "drizzle-orm";
import type { Db } from "./db/client.ts";
import { devMail } from "./db/schema.ts";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly name: string;
  send(mail: Mail): Promise<void>;
}

// Nothing leaves the machine: mail lands in a table and is shown at /v1/dev/mail, like a mailcatcher.
export class OutboxMailer implements Mailer {
  readonly name = "outbox";
  constructor(private readonly db: Db) {}

  async send(mail: Mail) {
    await this.db.insert(devMail).values(mail);
  }

  list(limit = 100) {
    return this.db.select().from(devMail).orderBy(desc(devMail.id)).limit(limit);
  }
}

export class SmtpMailer implements Mailer {
  readonly name = "smtp";
  private transport: Promise<{ sendMail(m: Mail & { from: string }): Promise<unknown> }>;

  constructor(
    smtp: string | { host: string; port: number; secure: boolean; auth?: { user: string; pass: string } },
    private readonly from: string,
  ) {
    this.transport = import("nodemailer").then((m) => m.createTransport(smtp));
  }

  async send(mail: Mail) {
    await (await this.transport).sendMail({ ...mail, from: this.from });
  }
}

// Real mail only when SMTP is configured (SMTP_URL, or SMTP_HOST with optional port/user/pass).
export function mailerFromEnv(db: Db, env = process.env): Mailer {
  const from = env.MAIL_FROM ?? "hive <noreply@hive.demo>";
  if (env.SMTP_URL) return new SmtpMailer(env.SMTP_URL, from);
  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT ?? 587);
    return new SmtpMailer(
      {
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } } : {}),
      },
      from,
    );
  }
  return new OutboxMailer(db);
}

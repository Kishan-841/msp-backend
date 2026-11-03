import nodemailer, { Transporter } from 'nodemailer';

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (cachedTransporter) return cachedTransporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) return null;

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return cachedTransporter;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  fromName?: string;
}

export async function sendEmail({
  to,
  subject,
  html,
  fromName = 'MSP CRM',
}: SendEmailParams): Promise<{ delivered: boolean; preview?: string }> {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const transporter = getTransporter();

  // Dev mode fallback — log to console, no real delivery.
  if (!transporter || !from) {
    console.log(
      `[mailer] (dev) Would send email to ${to}\nSubject: ${subject}\n--- HTML ---\n${html.slice(0, 500)}...`
    );
    return { delivered: false, preview: html };
  }

  await transporter.sendMail({
    from: `"${fromName}" <${from}>`,
    to,
    subject,
    html,
  });

  return { delivered: true };
}

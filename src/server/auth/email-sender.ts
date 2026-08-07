export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
}

/**
 * Email delivery for M1b flows. Default: console (development, no external
 * dependency). When RESEND_API_KEY is set, sends via Resend.
 */
export async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || "conspectus <no-reply@localhost>";
  if (!apiKey) {
    console.log(
      `[mail:dev] to=${input.to} subject="${input.subject}"\n${input.text}`,
    );
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text }),
  });
  if (!response.ok) {
    throw new Error(`resend failed: ${response.status}`);
  }
}

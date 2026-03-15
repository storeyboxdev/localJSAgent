import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";

// ── Auth setup ────────────────────────────────────────────────────────────────

let USER_EMAIL = null;
let gmailReady = false;

const gmailCredsExist =
  existsSync("creds/gmail-oauth.json") && existsSync("creds/gmail-token.json");

if (!gmailCredsExist) {
  console.warn("[gmail] creds/gmail-oauth.json or creds/gmail-token.json not found — Gmail tools disabled");
}

let gmail = null;
let oauth2Client = null;

if (gmailCredsExist) {
  const oauthCreds = JSON.parse(readFileSync("creds/gmail-oauth.json", "utf-8"));
  let storedTokens = JSON.parse(readFileSync("creds/gmail-token.json", "utf-8"));

  const { client_id, client_secret } = oauthCreds.installed ?? oauthCreds.web;
  oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "urn:ietf:wg:oauth:2.0:oob"
  );
  oauth2Client.setCredentials(storedTokens);

  // Persist refreshed access tokens automatically
  oauth2Client.on("tokens", (newTokens) => {
    storedTokens = { ...storedTokens, ...newTokens };
    writeFileSync("creds/gmail-token.json", JSON.stringify(storedTokens, null, 2));
  });

  gmail = google.gmail({ version: "v1", auth: oauth2Client });

  try {
    const { data: profile } = await gmail.users.getProfile({ userId: "me" });
    USER_EMAIL = profile.emailAddress;
    gmailReady = true;
    console.log(`Gmail: connected as ${USER_EMAIL}`);
  } catch (err) {
    console.warn(`Gmail: auth failed (${err.message}) — run 'node gmail-reauth.js' to re-authorize`);
  }
}

function requireGmailAuth() {
  if (!gmailReady) throw new Error("Gmail not configured. Add creds/gmail-oauth.json and creds/gmail-token.json, then run 'node gmail-reauth.js'.");
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function getHeader(message, name) {
  const headers = message.payload?.headers ?? [];
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(message) {
  const payload = message.payload;
  if (!payload) return "";

  // Recursively collect parts
  function collectParts(part) {
    if (part.parts) return part.parts.flatMap(collectParts);
    return [part];
  }

  const parts = payload.parts ? payload.parts.flatMap(collectParts) : [payload];
  const textPart = parts.find((p) => p.mimeType === "text/plain");
  const htmlPart = parts.find((p) => p.mimeType === "text/html");

  const chosen = textPart ?? htmlPart;
  if (!chosen?.body?.data) return "";

  const decoded = Buffer.from(chosen.body.data, "base64").toString("utf-8");

  if (chosen.mimeType === "text/html") {
    // Strip HTML tags for a plain-text approximation
    return decoded
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return decoded;
}

function buildRawEmail({ from, to, cc, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    "",
    body,
  ].filter((l) => l !== null);

  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export const searchEmails = tool({
  description:
    "Search your Gmail inbox using Gmail search syntax. Returns a list of messages with id, threadId, subject, from, date, and snippet.",
  inputSchema: z.object({
    q: z
      .string()
      .describe(
        'Gmail search query (e.g. "from:bob is:unread", "subject:invoice after:2026/01/01")'
      ),
    maxResults: z
      .number()
      .default(10)
      .describe("Maximum number of results to return (default 10)"),
  }),
  execute: async ({ q, maxResults }) => {
    requireGmailAuth();
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults,
    });
    const messages = res.data.messages ?? [];
    if (messages.length === 0) return [];

    // Fetch metadata for each message in parallel
    const details = await Promise.all(
      messages.map((m) =>
        gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"],
        })
      )
    );

    return details.map((d) => ({
      id: d.data.id,
      threadId: d.data.threadId,
      subject: getHeader(d.data, "Subject"),
      from: getHeader(d.data, "From"),
      date: getHeader(d.data, "Date"),
      snippet: d.data.snippet,
    }));
  },
});

export const readEmail = tool({
  description:
    "Read the full content of an email by its messageId. Returns subject, from, to, date, and body (plain text).",
  inputSchema: z.object({
    messageId: z.string().describe("The Gmail message ID to read"),
  }),
  execute: async ({ messageId }) => {
    requireGmailAuth();
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const msg = res.data;
    return {
      id: msg.id,
      threadId: msg.threadId,
      subject: getHeader(msg, "Subject"),
      from: getHeader(msg, "From"),
      to: getHeader(msg, "To"),
      date: getHeader(msg, "Date"),
      body: decodeBody(msg),
    };
  },
});

export const sendEmail = tool({
  description:
    "Compose and send a new email. Requires to, subject, and body. Optional cc.",
  inputSchema: z.object({
    to: z.string().describe("Recipient email address (or comma-separated list)"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body (plain text)"),
    cc: z.string().optional().describe("CC recipients (comma-separated)"),
  }),
  execute: async ({ to, subject, body, cc }) => {
    requireGmailAuth();
    const raw = buildRawEmail({ from: USER_EMAIL, to, cc, subject, body });
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return { success: true, id: res.data.id, threadId: res.data.threadId };
  },
});

export const replyToEmail = tool({
  description:
    "Reply to an existing email thread. Fetches the original message to set correct threading headers.",
  inputSchema: z.object({
    messageId: z
      .string()
      .describe("The Gmail message ID of the message you are replying to"),
    body: z.string().describe("Your reply text (plain text)"),
  }),
  execute: async ({ messageId, body }) => {
    requireGmailAuth();
    // Fetch original to get threading headers
    const orig = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Subject", "From", "To", "Message-ID", "References"],
    });
    const msg = orig.data;
    const originalFrom = getHeader(msg, "From");
    const originalSubject = getHeader(msg, "Subject");
    const messageIdHeader = getHeader(msg, "Message-ID");
    const existingRefs = getHeader(msg, "References");

    const subject = originalSubject.startsWith("Re:")
      ? originalSubject
      : `Re: ${originalSubject}`;
    const references = existingRefs
      ? `${existingRefs} ${messageIdHeader}`
      : messageIdHeader;

    const raw = buildRawEmail({
      from: USER_EMAIL,
      to: originalFrom,
      subject,
      body,
      inReplyTo: messageIdHeader,
      references,
    });

    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, threadId: msg.threadId },
    });
    return { success: true, id: res.data.id, threadId: res.data.threadId };
  },
});

export const forwardEmail = tool({
  description:
    "Forward an email to a new recipient. Optionally prepend a note.",
  inputSchema: z.object({
    messageId: z.string().describe("The Gmail message ID to forward"),
    to: z.string().describe("Recipient to forward to"),
    note: z
      .string()
      .optional()
      .describe("Optional note to prepend before the forwarded body"),
  }),
  execute: async ({ messageId, to, note }) => {
    requireGmailAuth();
    const orig = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    const msg = orig.data;
    const originalSubject = getHeader(msg, "Subject");
    const originalFrom = getHeader(msg, "From");
    const originalDate = getHeader(msg, "Date");
    const originalBody = decodeBody(msg);

    const subject = originalSubject.startsWith("Fwd:")
      ? originalSubject
      : `Fwd: ${originalSubject}`;

    const forwardedBlock = [
      "---------- Forwarded message ---------",
      `From: ${originalFrom}`,
      `Date: ${originalDate}`,
      `Subject: ${originalSubject}`,
      "",
      originalBody,
    ].join("\n");

    const body = note ? `${note}\n\n${forwardedBlock}` : forwardedBlock;

    const raw = buildRawEmail({ from: USER_EMAIL, to, subject, body });
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return { success: true, id: res.data.id, threadId: res.data.threadId };
  },
});

export const trashEmail = tool({
  description: "Move an email to the trash by its messageId.",
  inputSchema: z.object({
    messageId: z.string().describe("The Gmail message ID to trash"),
  }),
  execute: async ({ messageId }) => {
    requireGmailAuth();
    await gmail.users.messages.trash({ userId: "me", id: messageId });
    return { success: true, messageId };
  },
});

export const archiveEmail = tool({
  description:
    "Archive an email (remove from inbox) by its messageId. The message remains searchable.",
  inputSchema: z.object({
    messageId: z.string().describe("The Gmail message ID to archive"),
  }),
  execute: async ({ messageId }) => {
    requireGmailAuth();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["INBOX"] },
    });
    return { success: true, messageId };
  },
});

export const markAsRead = tool({
  description: "Mark an email as read or unread.",
  inputSchema: z.object({
    messageId: z.string().describe("The Gmail message ID"),
    read: z
      .boolean()
      .describe("true to mark as read, false to mark as unread"),
  }),
  execute: async ({ messageId, read }) => {
    requireGmailAuth();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: read
        ? { removeLabelIds: ["UNREAD"] }
        : { addLabelIds: ["UNREAD"] },
    });
    return { success: true, messageId, read };
  },
});

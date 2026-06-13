// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * IMAP Polling for non-Cloudflare-routed mailboxes.
 *
 * Used for accounts that can't use Cloudflare Email Routing as the MX:
 *   - me@christopherlawson.ca       → Fastmail (primary inbox)
 *   - chris@integralleadershipdesign.com → Fastmail (alias on ILD domain,
 *       MX kept on Fastmail to preserve alexa@ILD mailbox)
 *   - chrisnlawson@gmail.com        → Gmail REST API
 *
 * Architecture:
 *   - Cloudflare Cron Trigger fires this poller every 5 minutes.
 *   - Fastmail: JMAP API (HTTP, no TCP needed), uses state cursors for efficiency.
 *   - Gmail: Gmail REST API with OAuth2 refresh token.
 *   - Poll state (JMAP state strings, Gmail historyId) stored in Workers KV.
 *   - On new email: calls stub.createEmail() + agentStub.fetch("onNewEmail"),
 *     exactly replicating the Cloudflare Email Routing inbound path.
 *
 * Required Worker secrets (set via: wrangler secret put <NAME>):
 *   FASTMAIL_TOKEN        — Fastmail App Password (Settings → Password & Security → App Passwords)
 *   GMAIL_CLIENT_ID       — Google OAuth2 client ID (Google Cloud Console)
 *   GMAIL_CLIENT_SECRET   — Google OAuth2 client secret
 *   GMAIL_REFRESH_TOKEN   — Long-lived OAuth2 refresh token (obtained via setup flow)
 */

import type { Env } from "../types";
import { Folders } from "../../shared/folders";

// ── Constants ─────────────────────────────────────────────────────────────────

const FASTMAIL_JMAP_SESSION = "https://api.fastmail.com/.well-known/jmap";
const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_HISTORY_URL = "https://gmail.googleapis.com/gmail/v1/users/me/history";

// Accounts polled via Fastmail JMAP.
//
// DECONFLICTED 2026-06-13 (Email-agent Phase 2d): the local Python JMAP daemon
// is now the sole agent for personal Fastmail/Gmail mail (me@christopherlawson.ca,
// chris@integralleadershipdesign.com, chris@lawsonandchristopher.com, and the
// Gmail forward). This Worker is scoped to websignalytics business mail only,
// which arrives via Cloudflare Email Routing (the email() handler) — NOT via
// this poller. Both arrays are intentionally empty so the cron does no polling.
const FASTMAIL_ACCOUNTS: { mailboxId: string; address: string }[] = [];

// Accounts polled via Gmail REST API. Empty — see note above.
const GMAIL_ACCOUNTS: { mailboxId: string }[] = [];

// ── KV State Keys ──────────────────────────────────────────────────────────────

/** Returns the KV key used to store the JMAP query state cursor for a mailbox. */
function jmapStateKey(mailboxId: string): string {
  return `poll_state:jmap:${mailboxId}`;
}

/** Returns the KV key used to store the Gmail historyId cursor for a mailbox. */
function gmailStateKey(mailboxId: string): string {
  return `poll_state:gmail:${mailboxId}`;
}

// ── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Called by the Cloudflare Cron Trigger (scheduled handler in index.ts).
 * Polls all configured accounts and ingests new emails.
 */
export async function pollAllAccounts(env: Env): Promise<void> {
  const errors: string[] = [];

  // Poll each Fastmail account
  if (env.FASTMAIL_TOKEN) {
    for (const account of FASTMAIL_ACCOUNTS) {
      try {
        await pollFastmail(env, account.mailboxId, account.address);
      } catch (e) {
        const msg = `Fastmail poll failed for ${account.mailboxId}: ${(e as Error).message}`;
        console.error("[poller]", msg);
        errors.push(msg);
      }
    }
  } else {
    console.warn("[poller] FASTMAIL_TOKEN not set — skipping Fastmail accounts");
  }

  // Poll Gmail accounts
  if (env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN) {
    for (const account of GMAIL_ACCOUNTS) {
      try {
        await pollGmail(env, account.mailboxId);
      } catch (e) {
        const msg = `Gmail poll failed for ${account.mailboxId}: ${(e as Error).message}`;
        console.error("[poller]", msg);
        errors.push(msg);
      }
    }
  } else {
    console.warn("[poller] Gmail OAuth2 secrets not set — skipping Gmail accounts");
  }

  if (errors.length > 0) {
    console.error(`[poller] Completed with ${errors.length} error(s):`, errors);
  } else {
    console.log("[poller] Poll cycle complete — no errors");
  }
}

// ── Fastmail JMAP Polling ─────────────────────────────────────────────────────

/**
 * Poll one Fastmail account using the JMAP API.
 * Uses JMAP query state cursors (Email/queryChanges) for efficiency — only
 * fetches emails that arrived since the last successful poll.
 */
async function pollFastmail(env: Env, mailboxId: string, address: string): Promise<void> {
  // Step 1: Get JMAP session (account ID + API URL)
  const session = await fetchJmapSession(env.FASTMAIL_TOKEN);
  const accountId = Object.keys(session.accounts)[0];
  const apiUrl = session.apiUrl;

  if (!accountId) throw new Error("No JMAP account ID found in session");

  // Step 2: Get the inbox mailbox ID from JMAP
  const inboxId = await getJmapInboxId(apiUrl, env.FASTMAIL_TOKEN, accountId);

  // Step 3: Load stored query state (cursor for incremental fetches)
  const storedState = await env.POLL_STATE.get(jmapStateKey(mailboxId));

  let emailIds: string[];
  let newState: string;

  if (!storedState) {
    // First poll: query emails received in the last 24 hours to avoid flooding
    // the inbox with a full historical sync. Store state for future incremental polls.
    console.log(`[poller/fastmail] First poll for ${mailboxId} — fetching last 24h`);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await jmapEmailQuery(apiUrl, env.FASTMAIL_TOKEN, accountId, inboxId, since);
    emailIds = result.ids;
    newState = result.queryState;
  } else {
    // Incremental poll: use Email/queryChanges with the stored state cursor
    // to get only emails that arrived since the last poll.
    const result = await jmapEmailQueryChanges(apiUrl, env.FASTMAIL_TOKEN, accountId, inboxId, storedState);
    emailIds = result.added.map((item: { id: string }) => item.id);
    newState = result.newQueryState;
  }

  // Step 4: Fetch full content for each new email
  if (emailIds.length > 0) {
    console.log(`[poller/fastmail] ${emailIds.length} new email(s) for ${mailboxId}`);
    const emails = await jmapEmailGet(apiUrl, env.FASTMAIL_TOKEN, accountId, emailIds);

    // Step 5: Ingest each email into the MailboxDO and trigger the agent
    for (const email of emails) {
      await ingestEmail(env, mailboxId, convertJmapEmail(email, address));
    }
  } else {
    console.log(`[poller/fastmail] No new emails for ${mailboxId}`);
  }

  // Step 6: Store the new state cursor for next poll
  await env.POLL_STATE.put(jmapStateKey(mailboxId), newState);
}

/** Fetch the JMAP session document which gives us accountId and apiUrl. */
async function fetchJmapSession(token: string): Promise<{ apiUrl: string; accounts: Record<string, unknown> }> {
  const res = await fetch(FASTMAIL_JMAP_SESSION, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`JMAP session fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Get the JMAP inbox mailbox ID for the account. */
async function getJmapInboxId(apiUrl: string, token: string, accountId: string): Promise<string> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        ["Mailbox/query", { accountId, filter: { role: "inbox" } }, "0"],
      ],
    }),
  });
  if (!res.ok) throw new Error(`Mailbox/query failed: ${res.status}`);
  const data: any = await res.json();
  const ids: string[] = data.methodResponses[0][1].ids;
  if (!ids || ids.length === 0) throw new Error("No inbox mailbox found in JMAP account");
  return ids[0];
}

/** Query inbox for emails since a given timestamp (used on first poll). */
async function jmapEmailQuery(
  apiUrl: string, token: string, accountId: string, inboxId: string, since: string,
): Promise<{ ids: string[]; queryState: string }> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [[
        "Email/query", {
          accountId,
          filter: { inMailbox: inboxId, after: since },
          sort: [{ property: "receivedAt", isAscending: false }],
          limit: 50,
        }, "0",
      ]],
    }),
  });
  if (!res.ok) throw new Error(`Email/query failed: ${res.status}`);
  const data: any = await res.json();
  const result = data.methodResponses[0][1];
  return { ids: result.ids ?? [], queryState: result.queryState };
}

/** Get incremental changes since stored state cursor (used on subsequent polls). */
async function jmapEmailQueryChanges(
  apiUrl: string, token: string, accountId: string, inboxId: string, sinceQueryState: string,
): Promise<{ added: { id: string }[]; newQueryState: string }> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [[
        "Email/queryChanges", {
          accountId,
          filter: { inMailbox: inboxId },
          sort: [{ property: "receivedAt", isAscending: false }],
          sinceQueryState,
          maxChanges: 50,
        }, "0",
      ]],
    }),
  });
  if (!res.ok) throw new Error(`Email/queryChanges failed: ${res.status}`);
  const data: any = await res.json();
  const result = data.methodResponses[0][1];
  // Handle "cannotCalculateChanges" — state too old, fall back to full query
  if (data.methodResponses[0][0] === "error" && result.type === "cannotCalculateChanges") {
    console.warn("[poller/fastmail] JMAP state too old, falling back to 24h query");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fallback = await jmapEmailQuery(apiUrl, token, accountId, inboxId, since);
    return { added: fallback.ids.map((id) => ({ id })), newQueryState: fallback.queryState };
  }
  return { added: result.added ?? [], newQueryState: result.newQueryState };
}

/** Fetch full email content for a list of JMAP email IDs. */
async function jmapEmailGet(apiUrl: string, token: string, accountId: string, ids: string[]): Promise<any[]> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [[
        "Email/get", {
          accountId,
          ids,
          // Request the fields we need to reconstruct the email for MailboxDO
          properties: [
            "subject", "from", "to", "cc", "bcc", "receivedAt",
            "htmlBody", "textBody", "bodyValues", "attachments",
            "messageId", "inReplyTo", "references", "headers",
          ],
          // Fetch all body part values (HTML + text)
          fetchAllBodyValues: true,
        }, "0",
      ]],
    }),
  });
  if (!res.ok) throw new Error(`Email/get failed: ${res.status}`);
  const data: any = await res.json();
  return data.methodResponses[0][1].list ?? [];
}

/** Convert a JMAP email object to the format expected by ingestEmail(). */
function convertJmapEmail(jmap: any, recipientAddress: string): IngestableEmail {
  // Extract the best body: prefer HTML, fall back to plain text
  let body = "";
  if (jmap.htmlBody && jmap.htmlBody.length > 0 && jmap.bodyValues) {
    const partId = jmap.htmlBody[0].partId;
    body = jmap.bodyValues[partId]?.value ?? "";
  } else if (jmap.textBody && jmap.textBody.length > 0 && jmap.bodyValues) {
    const partId = jmap.textBody[0].partId;
    body = jmap.bodyValues[partId]?.value ?? "";
  }

  // Extract sender address from JMAP EmailAddress object
  const from = jmap.from?.[0];
  const sender = from?.email?.toLowerCase() ?? "";

  // Extract recipient list
  const toList: string[] = (jmap.to ?? []).map((a: any) => a.email?.toLowerCase()).filter(Boolean);
  const ccList: string[] = (jmap.cc ?? []).map((a: any) => a.email?.toLowerCase()).filter(Boolean);
  const bccList: string[] = (jmap.bcc ?? []).map((a: any) => a.email?.toLowerCase()).filter(Boolean);

  // Extract references for threading
  const inReplyTo = jmap.inReplyTo?.[0] ?? null;
  const references: string[] = jmap.references ?? [];

  // Build thread ID using same logic as the Email Routing handler
  const threadId = references[0] || inReplyTo || crypto.randomUUID();

  // Extract the original Message-ID header (used for deduplication)
  const messageId = jmap.messageId?.[0] ?? null;

  return {
    subject: jmap.subject ?? "",
    sender,
    // Use the recipient that matches this mailbox, not all To: addresses
    recipient: recipientAddress,
    cc: ccList.join(", ") || null,
    bcc: bccList.join(", ") || null,
    date: jmap.receivedAt ?? new Date().toISOString(),
    body,
    inReplyTo: inReplyTo ? stripAngleBrackets(inReplyTo) : null,
    references: references.map(stripAngleBrackets),
    threadId,
    messageId: messageId ? stripAngleBrackets(messageId) : null,
    rawHeaders: jmap.headers ? JSON.stringify(jmap.headers) : null,
  };
}

// ── Gmail REST API Polling ────────────────────────────────────────────────────

/**
 * Poll Gmail using the Gmail REST API with OAuth2.
 * Uses history.list with a historyId cursor for incremental fetches.
 *
 * SETUP REQUIRED before this works:
 * 1. Create a Google Cloud project at console.cloud.google.com
 * 2. Enable the Gmail API
 * 3. Create OAuth2 credentials (type: Web application or Desktop app)
 * 4. Run the OAuth2 authorization flow to get a refresh token:
 *    - Authorize URL: https://accounts.google.com/o/oauth2/auth?client_id={ID}&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/gmail.readonly&response_type=code
 *    - Exchange code for tokens via POST to https://oauth2.googleapis.com/token
 * 5. Set Worker secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 */
async function pollGmail(env: Env, mailboxId: string): Promise<void> {
  // Step 1: Get a fresh access token from the refresh token
  const accessToken = await getGmailAccessToken(
    env.GMAIL_CLIENT_ID,
    env.GMAIL_CLIENT_SECRET,
    env.GMAIL_REFRESH_TOKEN,
  );

  // Step 2: Load stored historyId cursor
  const storedHistoryId = await env.POLL_STATE.get(gmailStateKey(mailboxId));

  let messageIds: string[];
  let newHistoryId: string;

  if (!storedHistoryId) {
    // First poll: list messages from the last 24 hours
    console.log(`[poller/gmail] First poll for ${mailboxId} — fetching last 24h`);
    const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const result = await gmailListMessages(accessToken, `in:inbox after:${since}`);
    messageIds = result.messages?.map((m: { id: string }) => m.id) ?? [];
    newHistoryId = result.historyId ?? "";
  } else {
    // Incremental poll: get messages added since stored historyId
    const result = await gmailListHistory(accessToken, storedHistoryId);
    messageIds = result.newMessageIds;
    newHistoryId = result.historyId ?? storedHistoryId;
  }

  if (messageIds.length > 0) {
    console.log(`[poller/gmail] ${messageIds.length} new email(s) for ${mailboxId}`);
    for (const msgId of messageIds) {
      try {
        const email = await gmailGetMessage(accessToken, msgId);
        await ingestEmail(env, mailboxId, convertGmailMessage(email, mailboxId));
      } catch (e) {
        console.error(`[poller/gmail] Failed to ingest message ${msgId}:`, (e as Error).message);
      }
    }
  } else {
    console.log(`[poller/gmail] No new emails for ${mailboxId}`);
  }

  if (newHistoryId) {
    await env.POLL_STATE.put(gmailStateKey(mailboxId), newHistoryId);
  }
}

/** Exchange the refresh token for a short-lived access token. */
async function getGmailAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status} ${await res.text()}`);
  const data: any = await res.json();
  return data.access_token;
}

/** List Gmail messages matching a query. */
async function gmailListMessages(accessToken: string, query: string): Promise<any> {
  const url = `${GMAIL_MESSAGES_URL}?q=${encodeURIComponent(query)}&maxResults=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Gmail messages.list failed: ${res.status}`);
  return res.json();
}

/** List Gmail history changes since a given historyId. Returns new message IDs. */
async function gmailListHistory(accessToken: string, startHistoryId: string): Promise<{ newMessageIds: string[]; historyId: string }> {
  const url = `${GMAIL_HISTORY_URL}?startHistoryId=${startHistoryId}&historyTypes=messageAdded&labelId=INBOX&maxResults=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  // 404 means the historyId is too old — fall back to fresh list
  if (res.status === 404) {
    console.warn("[poller/gmail] historyId too old, falling back to 24h query");
    const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const fallback = await gmailListMessages(accessToken, `in:inbox after:${since}`);
    return {
      newMessageIds: fallback.messages?.map((m: { id: string }) => m.id) ?? [],
      historyId: fallback.historyId ?? startHistoryId,
    };
  }
  if (!res.ok) throw new Error(`Gmail history.list failed: ${res.status}`);
  const data: any = await res.json();
  // Extract unique message IDs from messageAdded history events
  const newMessageIds: string[] = [];
  const seen = new Set<string>();
  for (const record of data.history ?? []) {
    for (const msg of record.messagesAdded ?? []) {
      if (!seen.has(msg.message.id)) {
        seen.add(msg.message.id);
        newMessageIds.push(msg.message.id);
      }
    }
  }
  return { newMessageIds, historyId: data.historyId ?? startHistoryId };
}

/** Fetch a full Gmail message by ID. */
async function gmailGetMessage(accessToken: string, messageId: string): Promise<any> {
  const url = `${GMAIL_MESSAGES_URL}/${messageId}?format=full`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail messages.get failed for ${messageId}: ${res.status}`);
  return res.json();
}

/**
 * Convert a Gmail API message object to IngestableEmail format.
 * Gmail returns messages as MIME payloads with base64url-encoded parts.
 */
function convertGmailMessage(msg: any, mailboxId: string): IngestableEmail {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  // Extract body from MIME payload tree
  const body = extractGmailBody(msg.payload);

  // Parse threading headers
  const inReplyTo = headers["in-reply-to"] ? stripAngleBrackets(headers["in-reply-to"]) : null;
  const references = headers["references"]
    ? headers["references"].split(/\s+/).filter(Boolean).map(stripAngleBrackets)
    : [];
  const messageId = headers["message-id"] ? stripAngleBrackets(headers["message-id"]) : null;
  const threadId = references[0] || inReplyTo || crypto.randomUUID();

  return {
    subject: headers["subject"] ?? "",
    sender: parseEmailAddress(headers["from"] ?? ""),
    recipient: mailboxId,
    cc: headers["cc"] ?? null,
    bcc: headers["bcc"] ?? null,
    date: headers["date"] ? new Date(headers["date"]).toISOString() : new Date().toISOString(),
    body,
    inReplyTo,
    references,
    threadId,
    messageId,
    rawHeaders: JSON.stringify(headers),
  };
}

/** Recursively extract the best body from a Gmail MIME payload tree. */
function extractGmailBody(payload: any): string {
  if (!payload) return "";
  // Prefer text/html, fall back to text/plain
  if (payload.mimeType === "text/html" || payload.mimeType === "text/plain") {
    const encoded = payload.body?.data ?? "";
    // Gmail uses base64url — replace - with + and _ with /
    const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
    try {
      return atob(standard);
    } catch {
      return "";
    }
  }
  // Recurse into multipart parts
  if (payload.parts) {
    // Try HTML parts first
    for (const part of payload.parts) {
      if (part.mimeType === "text/html") return extractGmailBody(part);
    }
    // Then plain text
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain") return extractGmailBody(part);
    }
    // Then recurse into nested multipart
    for (const part of payload.parts) {
      const result = extractGmailBody(part);
      if (result) return result;
    }
  }
  return "";
}

// ── Shared Email Ingestion ────────────────────────────────────────────────────

/** Normalized email format used to feed the MailboxDO from any polling source. */
interface IngestableEmail {
  subject: string;
  sender: string;
  recipient: string;
  cc: string | null;
  bcc: string | null;
  date: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  threadId: string;
  messageId: string | null;
  rawHeaders: string | null;
}

/**
 * Ingest an email into the MailboxDO and trigger the agent auto-draft.
 * Replicates the exact flow used by the Cloudflare Email Routing handler.
 */
async function ingestEmail(env: Env, mailboxId: string, email: IngestableEmail): Promise<void> {
  // Verify the mailbox exists before trying to write to it
  const mailboxSettings = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
  if (!mailboxSettings) {
    console.warn(`[poller] Mailbox ${mailboxId} does not exist — skipping email`);
    return;
  }

  const messageId = crypto.randomUUID();
  const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

  // Store the email in the Durable Object SQLite database
  await (stub as any).createEmail(Folders.INBOX, {
    id: messageId,
    subject: email.subject,
    sender: email.sender,
    recipient: email.recipient,
    cc: email.cc,
    bcc: email.bcc,
    date: email.date,
    body: email.body,
    in_reply_to: email.inReplyTo,
    email_references: email.references.length > 0 ? JSON.stringify(email.references) : null,
    thread_id: email.threadId,
    message_id: email.messageId,
    raw_headers: email.rawHeaders,
  }, []); // No attachment support in IMAP polling (attachments require R2 uploads)

  // Trigger the agent to auto-draft a reply (same call as Email Routing handler)
  const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
  await agentStub.fetch(new Request("https://agents/onNewEmail", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mailboxId,
      emailId: messageId,
      sender: email.sender,
      subject: email.subject,
      threadId: email.threadId,
    }),
  })).catch((e: Error) => console.error("[poller] Auto-draft trigger failed:", e.message));

  console.log(`[poller] Ingested email "${email.subject}" from ${email.sender} into ${mailboxId}`);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Remove angle brackets from a Message-ID header value: <id@host> → id@host */
function stripAngleBrackets(s: string): string {
  const match = s.match(/<([^>]+)>/);
  return match ? match[1] : s.trim().split(/\s+/)[0];
}

/** Parse an email address from a "Name <address>" or bare "address" string. */
function parseEmailAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  return raw.trim().toLowerCase();
}

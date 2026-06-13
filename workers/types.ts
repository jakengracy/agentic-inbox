// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	// Set to "true" in .dev.vars to bypass Access in local/remote dev mode
	DEV_BYPASS?: string;
	TEAM_DOMAIN: string;
	// IMAP polling secrets (set via: wrangler secret put <name>)
	FASTMAIL_TOKEN: string;       // Fastmail App Password for JMAP API
	GMAIL_CLIENT_ID: string;      // Google OAuth2 client ID
	GMAIL_CLIENT_SECRET: string;  // Google OAuth2 client secret
	GMAIL_REFRESH_TOKEN: string;  // Long-lived Gmail OAuth2 refresh token
	// KV namespace for storing poll state cursors
	POLL_STATE: KVNamespace;
}

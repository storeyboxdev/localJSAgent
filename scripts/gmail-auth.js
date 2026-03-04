#!/usr/bin/env node
// scripts/gmail-auth.js — One-time OAuth2 flow to generate creds/gmail-token.json
//
// Usage: node scripts/gmail-auth.js
//
// Prerequisites:
//   1. Enable Gmail API in your GCP project
//   2. Create an OAuth 2.0 Client ID (Desktop app) and download as creds/gmail-oauth.json

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify", // read + archive + label + trash
  "https://www.googleapis.com/auth/gmail.send",   // compose + send
];

const TOKEN_PATH = "creds/gmail-token.json";
const CREDS_PATH = "creds/gmail-oauth.json";

let rawCreds;
try {
  rawCreds = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
} catch {
  console.error(`Error: Could not read ${CREDS_PATH}`);
  console.error("Download your OAuth 2.0 Client ID JSON from GCP and save it as creds/gmail-oauth.json");
  process.exit(1);
}

const { client_id, client_secret } = rawCreds.installed ?? rawCreds.web;
const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  "urn:ietf:wg:oauth:2.0:oob"
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

console.log("\nOpen this URL in your browser to authorize access:\n");
console.log(authUrl);
console.log();

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste the authorization code here: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log(`\nTokens saved to ${TOKEN_PATH}`);
    console.log("You can now start the server — Gmail tools will load automatically.");
  } catch (err) {
    console.error("Failed to exchange code for tokens:", err.message);
    process.exit(1);
  }
});

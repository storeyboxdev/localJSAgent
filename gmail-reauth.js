import { google } from "googleapis";
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const oauthCreds = JSON.parse(readFileSync("creds/gmail-oauth.json", "utf-8"));
const { client_id, client_secret } = oauthCreds.installed ?? oauthCreds.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, "urn:ietf:wg:oauth:2.0:oob");

const url = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
  prompt: "consent", // force new refresh token
});

console.log("\nOpen this URL in your browser:\n");
console.log(url);
console.log("\nPaste the authorization code here:");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("> ", async (code) => {
  rl.close();
  const { tokens } = await oauth2Client.getToken(code.trim());
  writeFileSync("creds/gmail-token.json", JSON.stringify(tokens, null, 2));
  console.log("Tokens saved to creds/gmail-token.json — restart the server.");
});

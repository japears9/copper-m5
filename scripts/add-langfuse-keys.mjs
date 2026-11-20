// Module 5: asks for the Langfuse keys with hidden input and saves them to
// .env.local, so they never show on screen or in a chat.
// Run: node scripts/add-langfuse-keys.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";

function ask(question, hidden) {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") process.exit(1);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
      if (!hidden) {
        stdout.write("\r\x1b[K" + question + value);
      }
    };
    stdin.on("data", onData);
  });
}

const publicKey = await ask("Langfuse Public Key (pk-lf-...): ", true);
const secretKey = await ask("Langfuse Secret Key (sk-lf-...), hidden: ", true);
let baseUrl = await ask(
  "Langfuse Host (press Enter for https://cloud.langfuse.com): ",
  false,
);
if (!baseUrl) baseUrl = "https://cloud.langfuse.com";

if (!publicKey.startsWith("pk-lf-") || !secretKey.startsWith("sk-lf-")) {
  console.error(
    "Those don't look right: the public key starts with pk-lf- and the secret key with sk-lf-. Run this again.",
  );
  process.exit(1);
}

const file = ".env.local";
const lines = (existsSync(file) ? readFileSync(file, "utf8") : "")
  .split("\n")
  .filter((l) => l && !/^LANGFUSE_(PUBLIC_KEY|SECRET_KEY|BASE_URL)=/.test(l));
lines.push(
  `LANGFUSE_PUBLIC_KEY=${publicKey}`,
  `LANGFUSE_SECRET_KEY=${secretKey}`,
  `LANGFUSE_BASE_URL=${baseUrl.replace(/\/$/, "")}`,
);
writeFileSync(file, lines.join("\n") + "\n");

const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/public/projects`, {
  headers: { Authorization: `Basic ${auth}` },
});
console.log(
  res.ok
    ? "Saved, and Langfuse accepted the keys. You can close this tab."
    : `Saved, but Langfuse said ${res.status}. Check the keys and the host, then run this again.`,
);

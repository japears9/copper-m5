// Module 5: asks for the Langfuse keys with hidden input and saves them to
// .env.local, so they never show on screen or in a chat.
// Run: npm run langfuse:keys
// Paste the keys one at a time, or paste Langfuse's whole .env snippet at the
// first question: the script finds pk-lf-..., sk-lf-... and the host in
// whatever you paste (quotes, labels and page URLs are fine).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";

const PUBLIC = /pk-lf-[A-Za-z0-9-]+/;
const SECRET = /sk-lf-[A-Za-z0-9-]+/;
const HOST = /https?:\/\/[A-Za-z0-9.-]+/;

// Input that arrived after the last answer's Enter, kept for the next one.
let pending = "";

/** Reads one answer. Pasted text and Enter can arrive in any chunks. */
function ask(question, { hidden }) {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write(hidden && value ? " (received)\n" : "\n");
      // Drop the terminal's invisible "bracketed paste" markers
      // (ESC[200~ ... ESC[201~) and any other control characters.
      resolve(
        value
          .replace(/\u001b\[20[01]~/g, " ")
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .trim(),
      );
    };
    const onData = (chunk) => {
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === "\u0003") process.exit(1);
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        // Enter ends the answer, but not a newline inside pasted text.
        const pasting =
          value.lastIndexOf("\u001b[200~") > value.lastIndexOf("\u001b[201~");
        if ((ch === "\r" || ch === "\n") && !pasting) {
          if (value.trim() || !hidden) {
            // A non-empty answer, or an empty host (use the default).
            pending = chars.slice(i + 1).join("");
            return finish();
          }
          continue; // ignore a stray Enter before the paste
        }
        value += ch;
      }
      if (!hidden) stdout.write(`\r\u001b[K${question}${value}`);
    };
    stdin.on("data", onData);
    if (pending) {
      const rest = pending;
      pending = "";
      onData(rest);
    }
  });
}

const found = { publicKey: "", secretKey: "", host: "" };
const take = (text) => {
  found.publicKey ||= text.match(PUBLIC)?.[0] ?? "";
  found.secretKey ||= text.match(SECRET)?.[0] ?? "";
  found.host ||= text.match(HOST)?.[0] ?? "";
};

take(await ask("Langfuse Public Key (pk-lf-...): ", { hidden: true }));
if (!found.secretKey)
  take(await ask("Langfuse Secret Key (sk-lf-...): ", { hidden: true }));
if (!found.host)
  take(
    await ask(
      "Langfuse Host, e.g. https://us.cloud.langfuse.com (Enter for https://cloud.langfuse.com): ",
      { hidden: false },
    ),
  );

const baseUrl = new URL(found.host || "https://cloud.langfuse.com").origin;

if (!found.publicKey || !found.secretKey) {
  console.error(
    `${found.publicKey ? "Got" : "Didn't find"} a public key (pk-lf-...), ${found.secretKey ? "got" : "didn't find"} a secret key (sk-lf-...). Nothing was saved. Run this again: npm run langfuse:keys`,
  );
  process.exit(1);
}

const file = ".env.local";
const lines = (existsSync(file) ? readFileSync(file, "utf8") : "")
  .split("\n")
  .filter((l) => l && !/^LANGFUSE_(PUBLIC_KEY|SECRET_KEY|BASE_URL)=/.test(l));
lines.push(
  `LANGFUSE_PUBLIC_KEY=${found.publicKey}`,
  `LANGFUSE_SECRET_KEY=${found.secretKey}`,
  `LANGFUSE_BASE_URL=${baseUrl}`,
);
writeFileSync(file, lines.join("\n") + "\n");

const auth = Buffer.from(`${found.publicKey}:${found.secretKey}`).toString(
  "base64",
);
const res = await fetch(`${baseUrl}/api/public/projects`, {
  headers: { Authorization: `Basic ${auth}` },
});
if (res.ok) {
  console.log(`Saved, and Langfuse (${baseUrl}) accepted the keys.`);
} else {
  console.error(
    `Saved, but Langfuse (${baseUrl}) said ${res.status}${res.status === 401 ? " (wrong keys, or the wrong region: US keys need https://us.cloud.langfuse.com)" : ""}. Run this again: npm run langfuse:keys`,
  );
  process.exit(1);
}

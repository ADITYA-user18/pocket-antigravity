// =============================================================================
// WhatsApp ↔ Antigravity Bridge Server
// =============================================================================
// This server receives WhatsApp messages via webhook, forwards them to the
// agy CLI for execution on your project, and sends the response back via
// WhatsApp.
//
// Features:
//   - Auto-detects active workspace from Antigravity IDE
//   - WhatsApp commands: /workspace, /projects, /project <path>, /project auto
//   - Auto-starts ngrok tunnel (no separate ngrok process needed)
//   - Message queuing (prevents overlapping agent calls)
//   - Image download support
//   - Auto message splitting for long responses
//   - Security filtering by phone number
// =============================================================================

require("dotenv").config();
const express = require("express");
const ngrok = require("@ngrok/ngrok");
const axios = require("axios");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();
app.use(express.json());

// Persistent HTTPS agent for instant sub-50ms API calls to Meta
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000 });
const fbGraphApi = axios.create({
  baseURL: "https://graph.facebook.com/v21.0",
  httpsAgent,
  timeout: 10000,
});

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  myNumber: process.env.MY_WHATSAPP_NUMBER,
  verifyToken: process.env.WEBHOOK_VERIFY_TOKEN || "my_antigravity_bridge_token",
  projectDir: process.env.PROJECT_DIR || "auto",
  defaultFallbackDir: "d:\\tftr",
  agyModel: process.env.AGY_MODEL || "",
  agyEffort: process.env.AGY_EFFORT || "high",
  agyTimeout: process.env.AGY_PRINT_TIMEOUT || "10m0s",
  port: process.env.PORT || 3000,
  // ngrok config
  ngrokAuthtoken: process.env.NGROK_AUTHTOKEN || "",
  ngrokDomain: process.env.NGROK_DOMAIN || "", // Free static domain from ngrok dashboard
};

// Dynamic override state (can be changed via /project command from WhatsApp)
let manualOverrideDir = null;

// Directory for saving incoming images
const IMAGE_DIR = path.join(__dirname, "input_images");
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// Directory for logs
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// =============================================================================
// Logging
// =============================================================================

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${data ? " | " + JSON.stringify(data) : ""}`;
  console.log(logLine);

  const logFile = path.join(LOG_DIR, `bridge-${new Date().toISOString().split("T")[0]}.log`);
  try {
    fs.appendFileSync(logFile, logLine + "\n");
  } catch (e) {
    // Ignore logging errors
  }
}

// =============================================================================
// Workspace Detection
// =============================================================================

/**
 * Converts VS Code / Antigravity file URI to local Windows filesystem path
 * e.g. file:///d%3A/BroadCastNow -> d:\BroadCastNow
 */
function uriToPath(uri) {
  if (!uri || typeof uri !== "string") return null;
  let p = uri;
  if (p.startsWith("file:///")) {
    p = p.substring(8);
  } else if (p.startsWith("file://")) {
    p = p.substring(7);
  }
  p = decodeURIComponent(p);
  p = p.replace(/\//g, "\\");
  return p;
}

/**
 * Automatically detects the currently active workspace directory opened in Antigravity IDE
 */
function getActiveWorkspace() {
  // 1. Manual override from WhatsApp command takes top precedence
  if (manualOverrideDir) {
    return { dir: manualOverrideDir, source: "manual override" };
  }

  // 2. Explicit fixed project directory in .env (if not 'auto')
  if (CONFIG.projectDir && CONFIG.projectDir.toLowerCase() !== "auto") {
    return { dir: CONFIG.projectDir, source: ".env config" };
  }

  const appData = process.env.APPDATA || "";
  const candidateIdeDirs = [
    path.join(appData, "Antigravity IDE", "User"),
    path.join(appData, "Antigravity", "User"),
  ];

  // 3. Try to read active window from storage.json
  for (const ideDir of candidateIdeDirs) {
    const storagePath = path.join(ideDir, "globalStorage", "storage.json");
    if (fs.existsSync(storagePath)) {
      try {
        const storage = JSON.parse(fs.readFileSync(storagePath, "utf8"));
        
        // Priority: lastActiveWindow
        let folderUri = storage.windowsState?.lastActiveWindow?.folder;
        
        // Priority: openedWindows
        if (!folderUri && storage.windowsState?.openedWindows?.length > 0) {
          folderUri = storage.windowsState.openedWindows[0].folder;
        }

        if (folderUri) {
          const folderPath = uriToPath(folderUri);
          if (folderPath && fs.existsSync(folderPath)) {
            return { dir: folderPath, source: "active IDE window" };
          }
        }
      } catch (err) {
        log("WARN", "Failed to parse storage.json", { error: err.message });
      }
    }
  }

  // 4. Fallback to the most recently modified workspace in workspaceStorage
  for (const ideDir of candidateIdeDirs) {
    const wsStorageDir = path.join(ideDir, "workspaceStorage");
    if (fs.existsSync(wsStorageDir)) {
      try {
        const entries = fs.readdirSync(wsStorageDir)
          .map((name) => {
            const full = path.join(wsStorageDir, name);
            try {
              return { name, full, mtime: fs.statSync(full).mtime };
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);

        for (const entry of entries) {
          const wsFile = path.join(entry.full, "workspace.json");
          if (fs.existsSync(wsFile)) {
            try {
              const wsData = JSON.parse(fs.readFileSync(wsFile, "utf8"));
              if (wsData.folder) {
                const folderPath = uriToPath(wsData.folder);
                if (folderPath && fs.existsSync(folderPath)) {
                  return { dir: folderPath, source: "recent IDE workspace" };
                }
              }
            } catch (e) {}
          }
        }
      } catch (err) {
        log("WARN", "Failed to inspect workspaceStorage", { error: err.message });
      }
    }
  }

  // 5. Final fallback
  return { dir: CONFIG.defaultFallbackDir, source: "default fallback" };
}

/**
 * Lists all recent workspace folders known to Antigravity IDE
 */
function getRecentWorkspaces() {
  const list = [];
  const appData = process.env.APPDATA || "";
  const candidateIdeDirs = [
    path.join(appData, "Antigravity IDE", "User"),
    path.join(appData, "Antigravity", "User"),
  ];

  for (const ideDir of candidateIdeDirs) {
    const wsStorageDir = path.join(ideDir, "workspaceStorage");
    if (fs.existsSync(wsStorageDir)) {
      try {
        const entries = fs.readdirSync(wsStorageDir)
          .map((name) => {
            const full = path.join(wsStorageDir, name);
            try {
              return { name, full, mtime: fs.statSync(full).mtime };
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);

        for (const entry of entries) {
          const wsFile = path.join(entry.full, "workspace.json");
          if (fs.existsSync(wsFile)) {
            try {
              const wsData = JSON.parse(fs.readFileSync(wsFile, "utf8"));
              if (wsData.folder) {
                const folderPath = uriToPath(wsData.folder);
                if (folderPath && fs.existsSync(folderPath) && !list.includes(folderPath)) {
                  list.push(folderPath);
                }
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
  }
  return list;
}

// =============================================================================
// WhatsApp API Helpers
// =============================================================================

/**
 * Send a text message back to WhatsApp
 */
async function sendWhatsAppMessage(to, text) {
  // WhatsApp has a 4096 character limit per message
  const chunks = splitMessage(text, 4000);

  for (const chunk of chunks) {
    try {
      await fbGraphApi.post(
        `/${CONFIG.phoneNumberId}/messages`,
        {
          messaging_product: "whatsapp",
          to: to,
          type: "text",
          text: { body: chunk },
        },
        {
          headers: {
            Authorization: `Bearer ${CONFIG.accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      log("INFO", `Sent message chunk to ${to}`, { length: chunk.length });
    } catch (err) {
      log("ERROR", "Failed to send WhatsApp message", {
        error: err.response?.data || err.message,
      });
    }

    // Small delay between chunks to maintain message order
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Send typing indicator & mark incoming message as read in WhatsApp
 */
async function sendTypingIndicator(messageId) {
  if (!messageId || !CONFIG.phoneNumberId || !CONFIG.accessToken) return;

  try {
    const res = await fbGraphApi.post(
      `/${CONFIG.phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: {
          type: "text",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    log("INFO", `Sent typing indicator for message ${messageId}`, res.data);
  } catch (err) {
    log("WARN", "Typing indicator / read status not sent", {
      error: err.response?.data?.error?.message || err.message,
    });
  }
}

/**
 * Split a long message into chunks that fit within WhatsApp's character limit
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < maxLength * 0.5) {
      // If newline is too far back, try splitting at a space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < maxLength * 0.3) {
      // If no good split point, just cut at maxLength
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  // Add part indicators if multiple chunks
  if (chunks.length > 1) {
    return chunks.map(
      (chunk, i) => `📄 (${i + 1}/${chunks.length})\n\n${chunk}`
    );
  }

  return chunks;
}

/**
 * Download media (image) from WhatsApp
 */
async function downloadWhatsAppMedia(mediaId) {
  try {
    // Step 1: Get the media URL
    const mediaInfo = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      {
        headers: { Authorization: `Bearer ${CONFIG.accessToken}` },
      }
    );

    const mediaUrl = mediaInfo.data.url;

    // Step 2: Download the actual file
    const response = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${CONFIG.accessToken}` },
      responseType: "arraybuffer",
    });

    // Step 3: Save to disk
    const extension = mediaInfo.data.mime_type?.split("/")[1] || "jpg";
    const filename = `img_${Date.now()}.${extension}`;
    const filepath = path.join(IMAGE_DIR, filename);

    fs.writeFileSync(filepath, response.data);
    log("INFO", `Downloaded image to ${filepath}`);

    return filepath;
  } catch (err) {
    log("ERROR", "Failed to download media", { error: err.message });
    return null;
  }
}

// =============================================================================
// WhatsApp Text Formatting Helpers
// =============================================================================

/**
 * Converts Markdown tables (| col | col |) into mobile-friendly clean bullet lists
 */
function convertMarkdownTables(text) {
  const tableRegex = /((?:\|[^\n]+\|\r?\n)+)/g;
  return text.replace(tableRegex, (table) => {
    const lines = table.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return table;

    const headers = lines[0].split("|").map((s) => s.trim()).filter(Boolean);
    const rows = lines.slice(1).filter((l) => !/^\|[-:| ]+\|$/.test(l));

    if (headers.length === 0 || rows.length === 0) return table;

    let result = "\n";
    rows.forEach((rowStr) => {
      const cols = rowStr.split("|").map((s) => s.trim()).filter(Boolean);
      result += `• *${cols[0] || ""}*\n`;
      for (let i = 1; i < cols.length; i++) {
        const headerName = headers[i] || `Field ${i}`;
        result += `   ▫️ ${headerName}: ${cols[i] || "-"}\n`;
      }
    });
    return result + "\n";
  });
}

/**
 * Formats Markdown output specifically for WhatsApp mobile reading
 */
function formatForWhatsApp(text) {
  if (!text || typeof text !== "string") return text;

  // 1. Temporarily protect code blocks
  const codeBlocks = [];
  let formatted = text.replace(/```([\s\S]*?)```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // 2. Convert markdown tables to clean mobile bullet items
  formatted = convertMarkdownTables(formatted);

  // 3. Convert markdown headers to styled WhatsApp headers with icons
  formatted = formatted
    .replace(/^#### (.*$)/gim, "▫️ *$1*")
    .replace(/^### (.*$)/gim, "📌 *$1*")
    .replace(/^## (.*$)/gim, "🔹 *$1*")
    .replace(/^# (.*$)/gim, "🏷️ *$1*");

  // 4. Convert markdown bold (**text** -> *text*)
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, "*$1*");

  // 5. Convert strikethrough (~~text~~ -> ~text~)
  formatted = formatted.replace(/~~(.*?)~~/g, "~$1~");

  // 6. Convert markdown links [Text](URL) -> Text (URL)
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // 7. Standardize list bullets for mobile readability
  formatted = formatted.replace(/^[ \t]*[-*+][ \t]+/gim, "• ");
  formatted = formatted.replace(/^[ \t]{2,}[-*+][ \t]+/gim, "   ◦ ");

  // 8. Restore code blocks
  formatted = formatted.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => {
    return codeBlocks[parseInt(index, 10)] || match;
  });

  // 9. Normalize multiple consecutive blank lines
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return formatted.trim();
}

// =============================================================================
// agy CLI Integration
// =============================================================================

/**
 * Run a prompt through the agy CLI for a specific workspace directory
 */
function runAgyCommand(prompt, targetDir) {
  return new Promise((resolve, reject) => {
    // Append formatting note for WhatsApp mobile output
    const promptWithInstructions = `${prompt}\n\n[Instruction: Format your response clearly for WhatsApp chat. Use single asterisks *bold* for emphasis, \`code\` for file names, paths, variables and short commands. Use bullet points (•) with icons (📂 for folders, 📄 for files, ✅ for status). Do not use Markdown headers (#) or markdown tables. Keep it readable on a mobile screen.]`;

    // Escape double quotes and normalize newlines
    const sanitizedPrompt = promptWithInstructions
      .replace(/"/g, '\\"')
      .replace(/\r\n/g, " ")
      .replace(/\n/g, " ")
      .replace(/\r/g, "");

    // Build the agy command targeting the active directory
    let cmd = `agy --print "${sanitizedPrompt}"`;
    cmd += ` --add-dir "${targetDir}"`;
    cmd += ` --dangerously-skip-permissions`;
    cmd += ` --continue`;
    cmd += ` --print-timeout ${CONFIG.agyTimeout}`;

    if (CONFIG.agyModel) {
      cmd += ` --model ${CONFIG.agyModel}`;
    }
    if (CONFIG.agyEffort) {
      cmd += ` --effort ${CONFIG.agyEffort}`;
    }

    log("INFO", "Executing agy command", {
      targetDir,
      prompt: prompt.substring(0, 100),
    });

    const timeoutMs = parseInt(CONFIG.agyTimeout) * 60 * 1000 || 600000;

    const child = exec(cmd, {
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer for large responses
      timeout: timeoutMs,
      cwd: targetDir,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data;
    });

    child.stderr.on("data", (data) => {
      stderr += data;
    });

    child.on("close", (code) => {
      if (code === 0) {
        log("INFO", "agy completed successfully", {
          targetDir,
          responseLength: stdout.length,
        });
        resolve(formatForWhatsApp(stdout.trim()));
      } else {
        log("ERROR", "agy exited with error", { code, stderr, targetDir });
        resolve(
          `⚠️ *Agent encountered an error (exit code ${code}):*\n\`\`\`\n${stderr || stdout || "No output"}\n\`\`\``
        );
      }
    });

    child.on("error", (err) => {
      log("ERROR", "Failed to spawn agy", { error: err.message, targetDir });
      reject(err);
    });
  });
}

// =============================================================================
// Request Queue (prevents overlapping agent calls)
// =============================================================================

let isProcessing = false;
const messageQueue = [];

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;

  isProcessing = true;
  const { from, prompt, messageId } = messageQueue.shift();
  let typingInterval = null;

  try {
    // 1. Check for built-in WhatsApp control commands
    const trimmed = prompt.trim();
    if (trimmed.startsWith("/")) {
      if (messageId) await sendTypingIndicator(messageId);
      const handled = await handleControlCommand(from, trimmed);
      if (handled) {
        isProcessing = false;
        processQueue();
        return;
      }
    }

    // 2. Resolve active workspace
    const ws = getActiveWorkspace();
    const folderName = path.basename(ws.dir) || ws.dir;

    log("INFO", `Processing request for folder: ${ws.dir} (${ws.source})`);

    // Start typing dots indicator immediately and keep it active every 10s until response is ready
    if (messageId) {
      await sendTypingIndicator(messageId);
      typingInterval = setInterval(() => {
        sendTypingIndicator(messageId).catch(() => {});
      }, 10000);
    }

    // Run the agent
    const response = await runAgyCommand(prompt, ws.dir);

    // Send the response
    await sendWhatsAppMessage(from, response || "✅ Done (no text output).");
  } catch (err) {
    log("ERROR", "Error processing message", { error: err.message });
    await sendWhatsAppMessage(
      from,
      `❌ Error: ${err.message}\n\nPlease try again.`
    );
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
    isProcessing = false;
    processQueue();
  }
}

/**
 * Handles /workspace, /project, /projects, /help commands directly
 */
async function handleControlCommand(from, commandText) {
  const parts = commandText.split(" ");
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  if (cmd === "/workspace" || cmd === "/status") {
    const ws = getActiveWorkspace();
    const folderName = path.basename(ws.dir) || ws.dir;
    await sendWhatsAppMessage(
      from,
      `📂 *Current Active Workspace*\n\n` +
      `• *Project:* ${folderName}\n` +
      `• *Path:* \`${ws.dir}\`\n` +
      `• *Mode:* ${ws.source}\n\n` +
      `💡 Send */projects* to see recent folders, or */project <path>* to change.`
    );
    return true;
  }

  if (cmd === "/projects") {
    const recents = getRecentWorkspaces();
    const current = getActiveWorkspace().dir.toLowerCase();
    
    if (recents.length === 0) {
      await sendWhatsAppMessage(from, `📁 No recent workspaces found.`);
      return true;
    }

    let text = `📁 *Recent IDE Workspaces (${recents.length})*\n\n`;
    recents.slice(0, 10).forEach((dir, i) => {
      const isCurrent = dir.toLowerCase() === current;
      const marker = isCurrent ? " ⭐ (Active)" : "";
      text += `${i + 1}. *${path.basename(dir)}*${marker}\n   \`${dir}\`\n`;
    });
    text += `\n💡 Switch to any project by sending:\n\`/project <path or index number>\``;
    await sendWhatsAppMessage(from, text);
    return true;
  }

  if (cmd === "/project") {
    if (!arg) {
      const ws = getActiveWorkspace();
      await sendWhatsAppMessage(
        from,
        `📂 Current workspace: \`${ws.dir}\` (${ws.source})\n\n` +
        `Usage:\n` +
        `• \`/project auto\` - Auto-detect whichever folder is open in IDE\n` +
        `• \`/project <path>\` - Manually lock to a specific folder path\n` +
        `• \`/project <number>\` - Switch to one of the numbers from /projects`
      );
      return true;
    }

    if (arg.toLowerCase() === "auto") {
      manualOverrideDir = null;
      const ws = getActiveWorkspace();
      await sendWhatsAppMessage(
        from,
        `🔄 *Auto-detection Enabled!*\nNow tracking Antigravity IDE active folder.\n\nCurrently detected: *${path.basename(ws.dir)}*\n\`${ws.dir}\``
      );
      return true;
    }

    // Check if number from /projects
    const index = parseInt(arg);
    if (!isNaN(index)) {
      const recents = getRecentWorkspaces();
      if (index >= 1 && index <= recents.length) {
        manualOverrideDir = recents[index - 1];
        await sendWhatsAppMessage(
          from,
          `✅ *Switched Project*\n📂 Now working on: *${path.basename(manualOverrideDir)}*\n\`${manualOverrideDir}\`\n\n(Send \`/project auto\` to switch back to auto-detect)`
        );
        return true;
      }
    }

    // Direct path
    if (fs.existsSync(arg)) {
      manualOverrideDir = arg;
      await sendWhatsAppMessage(
        from,
        `✅ *Switched Project*\n📂 Now working on: *${path.basename(manualOverrideDir)}*\n\`${manualOverrideDir}\`\n\n(Send \`/project auto\` to switch back to auto-detect)`
      );
    } else {
      await sendWhatsAppMessage(
        from,
        `⚠️ Folder not found: \`${arg}\`\nPlease check the path and try again.`
      );
    }
    return true;
  }

  if (cmd === "/help") {
    await sendWhatsAppMessage(
      from,
      `🤖 *WhatsApp ↔ Antigravity Bridge Commands*\n\n` +
      `• \`/workspace\` or \`/status\` - View current active folder\n` +
      `• \`/projects\` - List recent IDE workspace folders\n` +
      `• \`/project auto\` - Auto-track whichever folder is open in IDE\n` +
      `• \`/project <path>\` - Manually switch to a specific folder\n` +
      `• \`/help\` - Show this help menu\n\n` +
      `Or just type any question or instruction to work on your code!`
    );
    return true;
  }

  return false;
}

function enqueueMessage(from, prompt, messageId = null) {
  messageQueue.push({ from, prompt, messageId });
  log("INFO", `Message queued. Queue length: ${messageQueue.length}`);
  processQueue();
}

// =============================================================================
// Webhook Routes
// =============================================================================

/**
 * GET /webhook — Verification endpoint for WhatsApp
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.verifyToken) {
    log("INFO", "Webhook verified successfully");
    return res.status(200).send(challenge);
  }

  log("WARN", "Webhook verification failed", { mode, token });
  return res.sendStatus(403);
});

/**
 * POST /webhook — Incoming messages from WhatsApp
 */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages) return;

    const message = value.messages[0];
    const from = message.from;
    const messageId = message.id;

    // Realtime: trigger typing dots & mark read instantaneously before anything else
    if (messageId) {
      sendTypingIndicator(messageId).catch(() => {});
    }

    if (CONFIG.myNumber && from !== CONFIG.myNumber) {
      log("WARN", `Rejected message from unauthorized number: ${from}`);
      return;
    }

    log("INFO", `Received ${message.type} message from ${from}`);

    let prompt = "";

    switch (message.type) {
      case "text":
        prompt = message.text.body;
        break;

      case "image":
        const imagePath = await downloadWhatsAppMedia(message.image.id);
        const caption = message.image.caption || "Look at this image";

        if (imagePath) {
          prompt = `${caption}\n\n[Image saved at: ${imagePath}]`;
        } else {
          prompt = caption + "\n\n(Note: Image download failed)";
        }
        break;

      default:
        log("INFO", `Ignoring unsupported message type: ${message.type}`);
        await sendWhatsAppMessage(
          from,
          `⚠️ Only text and image messages are supported. You sent: ${message.type}`
        );
        return;
    }

    if (!prompt.trim()) return;

    enqueueMessage(from, prompt, messageId);
  } catch (err) {
    log("ERROR", "Error handling webhook", { error: err.message });
  }
});

/**
 * GET /health — Health check endpoint
 */
app.get("/health", (req, res) => {
  const activeWs = getActiveWorkspace();
  res.json({
    status: "ok",
    uptime: process.uptime(),
    queueLength: messageQueue.length,
    isProcessing,
    activeWorkspace: {
      folder: activeWs.dir,
      name: path.basename(activeWs.dir),
      source: activeWs.source,
      manualOverride: manualOverrideDir,
    },
    config: {
      projectDirConfig: CONFIG.projectDir,
      phoneNumberId: CONFIG.phoneNumberId ? "configured" : "missing",
      accessToken: CONFIG.accessToken ? "configured" : "missing",
      myNumber: CONFIG.myNumber ? "configured" : "missing",
    },
  });
});

/**
 * GET / — Landing page
 */
app.get("/", (req, res) => {
  const activeWs = getActiveWorkspace();
  res.send(`
    <html>
      <head><title>WhatsApp ↔ Antigravity Bridge</title></head>
      <body style="font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h1>🤖 WhatsApp ↔ Antigravity Bridge</h1>
        <p>Status: <strong style="color: green;">Running</strong></p>
        <p>Active Project: <strong>${path.basename(activeWs.dir)}</strong> (<code>${activeWs.dir}</code>)</p>
        <p>Mode: <em>${activeWs.source}</em></p>
        <ul>
          <li><strong>Webhook:</strong> <code>/webhook</code></li>
          <li><strong>Health:</strong> <a href="/health">/health</a></li>
        </ul>
        <h3>Available WhatsApp Commands:</h3>
        <ul>
          <li><code>/workspace</code> - Show active folder</li>
          <li><code>/projects</code> - List recent folders</li>
          <li><code>/project auto</code> - Auto-track IDE folder</li>
          <li><code>/project &lt;path&gt;</code> - Manually lock folder</li>
          <li><code>/help</code> - Command list</li>
        </ul>
      </body>
    </html>
  `);
});

// =============================================================================
// Startup — auto-starts ngrok tunnel
// =============================================================================

async function startServer() {
  const initialWs = getActiveWorkspace();

  const server = app.listen(CONFIG.port, () => {
    console.log("\n");
    console.log("=".repeat(60));
    console.log("  🤖 WhatsApp ↔ Antigravity Bridge Server");
    console.log("=".repeat(60));
    console.log(`  📡 Server running on http://localhost:${CONFIG.port}`);
    console.log(`  📂 Active Project: ${path.basename(initialWs.dir)} (${initialWs.dir})`);
    console.log(`  🔍 Detection Mode: ${initialWs.source}`);
    console.log(`  💚 Health check: http://localhost:${CONFIG.port}/health`);
    console.log("=".repeat(60));
  });

  const missing = [];
  if (!CONFIG.phoneNumberId) missing.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!CONFIG.accessToken) missing.push("WHATSAPP_ACCESS_TOKEN");
  if (!CONFIG.myNumber) missing.push("MY_WHATSAPP_NUMBER");
  if (!CONFIG.ngrokAuthtoken) missing.push("NGROK_AUTHTOKEN");

  if (missing.length > 0) {
    console.log("\n  ⚠️  Missing configuration:");
    missing.forEach((m) => console.log(`     - ${m}`));
    console.log("\n  Copy .env.example to .env and fill in the values.\n");
    return;
  }

  console.log("\n  ✅ All configuration values are set!");
  console.log(`  📱 Authorized number: ${CONFIG.myNumber}`);

  try {
    console.log("\n  🔄 Starting ngrok tunnel...");

    const ngrokOptions = {
      addr: CONFIG.port,
      authtoken: CONFIG.ngrokAuthtoken,
    };

    if (CONFIG.ngrokDomain) {
      ngrokOptions.domain = CONFIG.ngrokDomain;
    }

    const listener = await ngrok.forward(ngrokOptions);
    const publicUrl = listener.url();

    console.log("\n  " + "=".repeat(56));
    console.log(`  🌐 PUBLIC URL: ${publicUrl}`);
    console.log(`  🔗 WEBHOOK URL: ${publicUrl}/webhook`);
    console.log("  " + "=".repeat(56));

    if (CONFIG.ngrokDomain) {
      console.log("\n  ✅ Using static domain — webhook URL never changes!");
    } else {
      console.log("\n  ⚠️  URL changes on restart (free ngrok tier).");
    }

    console.log("\n  📲 Ready! Send a WhatsApp message to test.\n");

    fs.writeFileSync(
      path.join(__dirname, "current_url.txt"),
      `${publicUrl}/webhook`
    );
  } catch (err) {
    console.error("\n  ❌ Failed to start ngrok tunnel:", err.message);
    console.error("  The server is still running locally on port", CONFIG.port);
  }
}

startServer().catch(console.error);

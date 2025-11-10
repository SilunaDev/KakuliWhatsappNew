import {
  useMultiFileAuthState,
  makeWASocket,
  DisconnectReason,
  downloadContentFromMessage,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

import fs from "fs";
import path from "path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import qrcode from "qrcode-terminal";
import axios from "axios";
import wikipedia from "wikipedia";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import dotenv from "dotenv";
dotenv.config();

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobe.path);

// Environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const YT_API_KEY = process.env.YT_API_KEY;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;

// Track ongoing processes
const activeProcesses = new Map();

// Helper functions
async function downloadMedia(message, type) {
  const stream = await downloadContentFromMessage(message, type);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function extractText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.ephemeralMessage) return extractText(message.ephemeralMessage.message);
  return "";
}

// Media processing functions
async function createVideoSticker(videoBuffer) {
  const tempDir = "./temp_stickers";
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `video_${timestamp}.mp4`);
  const outputPath = path.join(tempDir, `sticker_${timestamp}.webp`);

  try {
    fs.writeFileSync(inputPath, videoBuffer);

    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => {
        err ? reject(err) : resolve(data);
      });
    });

    const duration = metadata.format.duration;
    if (duration > 15) {
      throw new Error("Video too long! Please send a video under 15 seconds.");
    }

    const targetDuration = Math.min(duration, 10);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([`-t ${targetDuration}`])
        .outputOptions([
          "-vcodec libwebp",
          // Scale so smaller side fits 512, crop to 512x512
          "-vf scale=512:512:force_original_aspect_ratio=increase,crop=512:512,fps=15",
          "-loop 0",
          "-preset default",
          "-an",
          "-lossless 1",
          "-compression_level 6"
        ])
        .on("start", cmd => console.log("Processing video:", cmd))
        .on("progress", progress => console.log("Progress:", progress.timemark))
        .on("error", reject)
        .on("end", resolve)
        .save(outputPath);
    });


    return fs.readFileSync(outputPath);
  } catch (error) {
    console.error("Video sticker creation error:", error);
    throw new Error(error.message || "Failed to create sticker. Try with a shorter video (under 15 seconds).");
  } finally {
    [inputPath, outputPath].forEach(file => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
  }
}

async function createImageSticker(imageBuffer, text = null) {
  const tempDir = "./temp_stickers";
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const outputPath = path.join(tempDir, `sticker_${Date.now()}.webp`);

  try {
    let image = sharp(imageBuffer)
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      });

    if (text) {
      const textSvg = Buffer.from(`
        <svg width="512" height="512">
          <text x="256" y="256" font-family="Arial" font-size="48" fill="white" text-anchor="middle"
                stroke="black" stroke-width="2" stroke-linejoin="round" font-weight="bold">
            ${text}
          </text>
        </svg>
      `);

      image = image.composite([{ input: textSvg, blend: 'over' }]);
    }

    await image.webp({ quality: 90 }).toFile(outputPath);
    return fs.readFileSync(outputPath);
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }
}

async function handleStickerCommand(client, msg, isTextSticker = false) {
  const messageId = msg.key.id;
  if (activeProcesses.has(messageId)) return;
  activeProcesses.set(messageId, true);

  try {
    let mediaMessage = null;
    let isVideo = false;
    let text = null;

    if (isTextSticker) {
      const fullText = extractText(msg.message);
      const parts = fullText.split(' ').filter(p => p.trim().length > 0);
      text = parts.slice(1).join(' ').trim();

      if (!text) {
        return await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Please provide text after the command. Example: !textsticker Hello World"
        });
      }

      if (text.length > 30) {
        return await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Text too long! Please keep it under 30 characters for stickers."
        });
      }
    }

    const getMediaMessage = (message) => {
      if (!message) return null;
      if (message.imageMessage) return { message: message.imageMessage, type: 'image' };
      if (message.videoMessage) return { message: message.videoMessage, type: 'video' };
      if (message.extendedTextMessage?.contextInfo?.quotedMessage) {
        return getMediaMessage(message.extendedTextMessage.contextInfo.quotedMessage);
      }
      return null;
    };

    const mediaData = getMediaMessage(msg.message);
    if (!mediaData) {
      return await client.sendMessage(msg.key.remoteJid, {
        text: `❌ Please send or reply to an image/video with ${isTextSticker ? "!textsticker" : "!sticker"}`
      });
    }

    mediaMessage = mediaData.message;
    isVideo = mediaData.type === 'video';

    if (isTextSticker && isVideo) {
      return await client.sendMessage(msg.key.remoteJid, {
        text: "❌ Text stickers can only be created from images, not videos."
      });
    }

    const mediaBuffer = await downloadMedia(mediaMessage, isVideo ? "video" : "image");
    const stickerBuffer = isVideo
      ? await createVideoSticker(mediaBuffer)
      : await createImageSticker(mediaBuffer, isTextSticker ? text : null);

    await client.sendMessage(msg.key.remoteJid, {
      sticker: stickerBuffer,
      caption: isVideo
        ? "✅ Sticker created from first 10 seconds of video!"
        : (isTextSticker ? "✅ Text sticker created!" : "")
    });
  } catch (error) {
    console.error("Sticker error:", error);
    await client.sendMessage(msg.key.remoteJid, {
      text: `❌ ${error.message || "Failed to create sticker. Please try again."}`
    });
  } finally {
    activeProcesses.delete(messageId);
  }
}

// Command handlers (chat, weather, wiki, ytsearch)
async function handleChatCommand(client, msg, args) {
  const prompt = args.join(" ");
  if (!prompt) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !chat <prompt>" });

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] }
    );
    const aiReply = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "🤖 No response.";
    await client.sendMessage(msg.key.remoteJid, {
      text: `🤖 *AI Response:*\n\n${aiReply}`
    });
  } catch (err) {
    console.error("Gemini error:", err);
    client.sendMessage(msg.key.remoteJid, { text: "❌ Error with Gemini API." });
  }
}

async function handleWeatherCommand(client, msg, args) {
  const city = args.join(" ");
  if (!city) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !weather <city>" });

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${WEATHER_API_KEY}&units=metric`;
    const res = await axios.get(url);
    const { temp, humidity } = res.data.main;
    const desc = res.data.weather[0].description;

    await client.sendMessage(msg.key.remoteJid, {
      text: `🌤️ Weather in *${city}*\n🌡️ Temp: ${temp}°C\n💧 Humidity: ${humidity}%\n🌍 Condition: ${desc}`
    });
  } catch {
    client.sendMessage(msg.key.remoteJid, { text: "❌ City not found!" });
  }
}

async function handleWikiCommand(client, msg, args) {
  const query = args.join(" ");
  if (!query) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !wiki <query>" });

  try {
    const summary = await wikipedia.summary(query);
    await client.sendMessage(msg.key.remoteJid, {
      text: `📖 *Wikipedia: ${query}*\n\n${summary.extract}`
    });
  } catch {
    client.sendMessage(msg.key.remoteJid, { text: "❌ No results found!" });
  }
}

async function handleYTSearchCommand(client, msg, args) {
  const query = args.join(" ");
  if (!query) return client.sendMessage(msg.key.remoteJid, { text: "❌ Usage: !ytsearch <query>" });

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${YT_API_KEY}`;
    const res = await axios.get(url);
    const video = res.data.items[0];
    const videoUrl = `https://www.youtube.com/watch?v=${video.id.videoId}`;

    await client.sendMessage(msg.key.remoteJid, {
      text: `🎥 *Top Result for "${query}"*\n\n*${video.snippet.title}*\n${video.snippet.description.slice(0, 100)}...\n🔗 ${videoUrl}`
    });
  } catch {
    client.sendMessage(msg.key.remoteJid, { text: "❌ YouTube search failed." });
  }
}

// 🟢 MAIN SOCKET FUNCTION
async function startSock() {
  
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_multi");
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

  const client = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console),
    },
    printQRInTerminal: true,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
    defaultQueryTimeoutMs: undefined,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: true,
    fireInitQueries: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  client.ev.on("creds.update", saveCreds);

  client.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.clear();
      console.log("\n📱 ╔════════════════════════════════════╗");
      console.log("   ║  SCAN THIS QR CODE WITH WHATSAPP  ║");
      console.log("   ╚════════════════════════════════════╝\n");
      qrcode.generate(qr, { small: true });
      console.log("\n✅ Waiting for WhatsApp to connect...\n");
    }

    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed:", lastDisconnect?.error?.output?.statusCode, "| Reconnecting:", shouldReconnect);
      
      if (shouldReconnect) {
        console.log("Reconnecting in 3 seconds...");
        setTimeout(() => startSock(), 3000);
      } else {
        console.log("Logged out. Delete auth_info_multi folder to re-authenticate.");
      }
    } else if (connection === "open") {
      console.clear();
      console.log("✅ ══════════════════════════════════");
      console.log("✅   CONNECTED TO WHATSAPP!");
      console.log("✅ ══════════════════════════════════\n");
    } else if (connection === "connecting") {
      console.log("⏳ Connecting to WhatsApp...");
    }
  });

  client.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;

    const body = extractText(msg.message);
    if (!body.startsWith("!")) return;

    const command = body.split(" ")[0];
    const args = body.split(" ").slice(1);

    if (command === "!menu" || command === "!help") {
      await client.sendMessage(msg.key.remoteJid, {
        text: `📌 *Bot Menu* 📌

!help - Show help
!weather <city>
!wiki <query>
!ytsearch <query>
!chat <prompt>
!kakuli <prompt>
!sticker - Create sticker from image/video
!textsticker - Create sticker with text (max 30 chars, images only)
!voice <text>,<VoiceName> - Generate voice from text (max 500 chars)

📢 *Available Voices:*
Achernar, Achird, Algenib, Algieba, Alnilam, Aoede, Autonoe, Callirrhoe, Charon, Despina, Enceladus, Erinome, Fenrir, Gacrux, Iapetus, Kore, Laomedeia, Leda, Orus, Pulcherrima, Puck, Rasalgethi, Sadachbia, Sadaltager, Schedar, Sulafat, Umbriel, Vindemiatrix, Zephyr, Zubenelgenubi`
      });
    } else if (command === "!sticker") {
      await handleStickerCommand(client, msg, false);
    } else if (command === "!textsticker") {
      await handleStickerCommand(client, msg, true);
    } else if (command === "!chat") {
      await handleChatCommand(client, msg, args);
    } else if (command === "!weather") {
      await handleWeatherCommand(client, msg, args);
    } else if (command === "!wiki") {
      await handleWikiCommand(client, msg, args);
    } else if (command === "!ytsearch") {
      await handleYTSearchCommand(client, msg, args);
    } else if (command === "!kakuli") {
      try {
        const { handleKakuliCommand } = await import("./kakuli.js");
        await handleKakuliCommand(client, msg, args.join(" "));
      } catch (e) {
        console.error("Kakuli command error:", e);
        await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Failed to execute !kakuli command."
        });
      }
    } else if (command === "!voice") {
      try {
        const { handleVoiceCommand } = await import("./voice.js");
        await handleVoiceCommand(client, msg, args);
      } catch (e) {
        console.error("Voice command error:", e);
        await client.sendMessage(msg.key.remoteJid, {
          text: "❌ Failed to execute !voice command."
        });
      }
    }
  });
}

// Exit cleanup
process.on("SIGINT", () => {
  console.log("Shutting down gracefully...");
  try {
    if (fs.existsSync("./temp_stickers")) {
      fs.rmSync("./temp_stickers", { recursive: true });
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
  process.exit(0);
});

// Start the bot
startSock().catch(err => {
  console.error("Bot startup failed:", err);
  process.exit(1);
});

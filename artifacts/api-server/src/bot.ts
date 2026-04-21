import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
  type VoiceChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "./lib/logger";

// ── Constants ──────────────────────────────────────────────────────────────

const DISCORD_BOT_TOKEN = process.env["DISCORD_BOT_TOKEN"];
const TARGET_CHANNEL_ID = process.env["DISCORD_VOICE_CHANNEL_ID"];
const BOT_START_TIME = Date.now();
const REJOIN_DELAY_MS = 500;
const STUCK_TIMEOUT_MS = 120_000; // destroy & retry if not Ready after 2 min

if (!DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN environment variable is required");
}

// ── FFmpeg path (resolved once at startup) ─────────────────────────────────

function resolveFfmpegPath(): string {
  try {
    const p = execFileSync("which", ["ffmpeg"], { encoding: "utf-8" }).trim();
    logger.info({ path: p }, "FFmpeg resolved");
    return p;
  } catch {
    logger.warn("'which ffmpeg' failed — falling back to 'ffmpeg'");
    return "ffmpeg";
  }
}

const FFMPEG_PATH = resolveFfmpegPath();

// ── Active channel registry ────────────────────────────────────────────────

const activeChannels = new Map<string, string>(); // guildId → channelName

// Heartbeat: log "Playing silence..." every 10 s to confirm the loop is alive
setInterval(() => {
  for (const [guildId, channelName] of activeChannels) {
    const conn = getVoiceConnection(guildId);
    if (conn?.state.status === VoiceConnectionStatus.Ready) {
      logger.info({ guildId, channelName }, "Playing silence...");
    }
  }
}, 10_000);

// ── Silent audio loop ──────────────────────────────────────────────────────
// FFmpeg generates an infinite null-source (silence) encoded as Ogg Opus.
// StreamType.OggOpus feeds it directly to the voice connection — no native
// encoder required.

function spawnSilence(): ChildProcessWithoutNullStreams {
  const proc = spawn(FFMPEG_PATH, [
    "-loglevel", "quiet",
    "-f", "lavfi",
    "-i", "anullsrc=r=48000:cl=stereo",
    "-c:a", "libopus",
    "-b:a", "8k",
    "-f", "ogg",
    "pipe:1",
  ]);
  proc.stderr.on("data", (d: Buffer) => {
    const t = d.toString().trim();
    if (t) logger.debug({ ffmpegStderr: t }, "FFmpeg stderr");
  });
  return proc;
}

interface AudioLoop {
  player: AudioPlayer;
  stop(): void;
}

function startAudioLoop(connection: VoiceConnection, guildId: string): AudioLoop {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  connection.subscribe(player);

  let ffmpegProc: ChildProcessWithoutNullStreams | null = null;
  let stopped = false;

  function play() {
    if (stopped) return;
    if (ffmpegProc) { ffmpegProc.removeAllListeners(); ffmpegProc.kill("SIGKILL"); ffmpegProc = null; }

    const proc = spawnSilence();
    ffmpegProc = proc;

    proc.on("error", (err) => {
      if (stopped) return;
      logger.warn({ err: err.message }, "FFmpeg error — restarting in 1 s");
      ffmpegProc = null;
      setTimeout(play, 1_000);
    });
    proc.on("exit", (code, sig) => {
      if (stopped) return;
      if (code !== 0 || sig) { ffmpegProc = null; setImmediate(play); }
    });

    player.play(createAudioResource(proc.stdout, { inputType: StreamType.OggOpus }));
  }

  // Restart if idle (stream ended) or errored
  player.on(AudioPlayerStatus.Idle, () => { if (!stopped) setImmediate(play); });
  player.on("error", (err) => { if (!stopped) { logger.warn({ err: err.message }, "Player error — restarting"); setTimeout(play, 1_000); } });

  // Watchdog: every 5 s ensure audio is playing regardless of events
  const watchdog = setInterval(() => {
    if (stopped) { clearInterval(watchdog); return; }
    const s = player.state.status;
    if (s === AudioPlayerStatus.Idle || s === AudioPlayerStatus.AutoPaused) {
      logger.warn({ guildId, status: s }, "Watchdog: player inactive — forcing restart");
      play();
    }
  }, 5_000);

  play(); // start immediately

  return {
    player,
    stop() {
      stopped = true;
      clearInterval(watchdog);
      player.stop(true);
      if (ffmpegProc) { ffmpegProc.removeAllListeners(); ffmpegProc.kill("SIGKILL"); ffmpegProc = null; }
    },
  };
}

// ── Voice connection management ────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // Retry the gateway connection indefinitely on error — never give up.
  retryLimit: Infinity,
  // Fail silently on missing/unknown entities rather than throwing.
  failIfNotExists: false,
});

// Guard against concurrent rejoin calls for the same guild
const rejoining = new Set<string>();

async function joinChannel(channel: VoiceChannel): Promise<void> {
  const guildId = channel.guild.id;

  if (rejoining.has(guildId)) {
    logger.info({ guildId }, "Rejoin already scheduled — skipping duplicate call");
    return;
  }

  // Permission check
  const me = channel.guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    const hasConnect = perms?.has(PermissionFlagsBits.Connect) ?? false;
    const hasSpeak   = perms?.has(PermissionFlagsBits.Speak)   ?? false;
    if (!hasConnect || !hasSpeak) {
      logger.warn({ guildId, channelId: channel.id, hasConnect, hasSpeak },
        "Missing Connect or Speak permission — fix bot role in server settings");
    }
  }

  // Tear down any existing connection cleanly
  const existing = getVoiceConnection(guildId);
  if (existing) { existing.destroy(); }

  logger.info({ guildId, channelId: channel.id, channelName: channel.name }, "Joining voice channel");

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  // ── Log every state transition for diagnostics ──
  connection.on("stateChange", (oldState, newState) => {
    logger.info({ guildId, from: oldState.status, to: newState.status }, "Voice state transition");
  });

  let audio: AudioLoop | null = null;
  let stuckTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRejoin(reason: string) {
    if (rejoining.has(guildId)) return;
    rejoining.add(guildId);
    if (audio) { audio.stop(); audio = null; }
    if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
    activeChannels.delete(guildId);
    logger.info({ guildId, reason }, `Rejoining in ${REJOIN_DELAY_MS / 1000} s`);
    setTimeout(() => { rejoining.delete(guildId); joinChannel(channel); }, REJOIN_DELAY_MS);
  }

  // Safety net: if the connection doesn't reach Ready in 2 minutes, destroy & retry
  stuckTimer = setTimeout(() => {
    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      logger.warn({ guildId, status: connection.state.status },
        `Connection stuck at '${connection.state.status}' after ${STUCK_TIMEOUT_MS / 1000} s — forcing rejoin`);
      connection.destroy();
      scheduleRejoin("stuck-timeout");
    }
  }, STUCK_TIMEOUT_MS);

  // ── Ready: start audio immediately ──────────────────────────────────────
  connection.once(VoiceConnectionStatus.Ready, () => {
    if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
    logger.info({ guildId, channelName: channel.name }, "Connection ready — starting silent audio");
    activeChannels.set(guildId, channel.name);
    audio = startAudioLoop(connection, guildId);
  });

  // ── Disconnected: attempt fast reconnect, fall back to rejoin ───────────
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    logger.warn({ guildId }, "Disconnected — attempting fast reconnect");
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      logger.info({ guildId }, "Fast reconnect succeeded");
    } catch {
      connection.destroy();
      scheduleRejoin("disconnected");
    }
  });

  // ── Destroyed: always clean up and rejoin ───────────────────────────────
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
    scheduleRejoin("destroyed");
  });

  // ── Unexpected errors ────────────────────────────────────────────────────
  connection.on("error", (err) => {
    logger.error({ guildId, err: err.message }, "Voice connection error");
    connection.destroy();
    scheduleRejoin("error");
  });
}

// ── Bot events ─────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  logger.info({ tag: readyClient.user.tag }, "Discord bot logged in");

  if (TARGET_CHANNEL_ID) {
    const channel = await readyClient.channels.fetch(TARGET_CHANNEL_ID).catch(() => null);
    if (channel?.type === ChannelType.GuildVoice) {
      await joinChannel(channel as VoiceChannel);
    } else {
      logger.warn({ channelId: TARGET_CHANNEL_ID }, "DISCORD_VOICE_CHANNEL_ID not found or not a voice channel");
    }
  } else {
    logger.info("No DISCORD_VOICE_CHANNEL_ID set — use !join in a text channel");
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content === "!join") {
    const member = message.guild?.members.cache.get(message.author.id);
    const vc = member?.voice.channel;
    if (!vc || vc.type !== ChannelType.GuildVoice) {
      await message.reply("Join a voice channel first, then use !join.");
      return;
    }
    await joinChannel(vc as VoiceChannel);
    return;
  }

  if (message.content === "!leave") {
    const conn = message.guild ? getVoiceConnection(message.guild.id) : null;
    if (conn) {
      // Mark as intentional — don't rejoin after this destroy
      rejoining.add(message.guild!.id);
      conn.destroy();
      activeChannels.delete(message.guild!.id);
      await message.reply("Left the voice channel.");
    } else {
      await message.reply("Not in a voice channel.");
    }
    return;
  }

  if (message.content === "!status") {
    const guildId = message.guild?.id;
    if (!guildId) return;
    const conn = getVoiceConnection(guildId);
    if (conn) {
      const name = activeChannels.get(guildId) ?? "unknown";
      await message.reply(`In **${name}** — status: \`${conn.state.status}\``);
    } else {
      await message.reply("Not in a voice channel.");
    }
    return;
  }

  // ── Dot-prefix commands ───────────────────────────────────────────────────

  if (message.content === ".ping") {
    const sent = await message.reply("Pinging…");
    const latency = sent.createdTimestamp - message.createdTimestamp;
    const wsLatency = client.ws.ping;
    await sent.edit(
      `🏓 Pong!\nMessage latency: **${latency} ms** | WebSocket heartbeat: **${wsLatency} ms**`
    );
    return;
  }

  if (message.content === ".uptime") {
    const totalMs = Date.now() - BOT_START_TIME;
    const days    = Math.floor(totalMs / 86_400_000);
    const hours   = Math.floor((totalMs % 86_400_000) / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1_000);
    const parts: string[] = [];
    if (days)    parts.push(`${days}d`);
    if (hours)   parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    await message.reply(`⏱️ Bot has been running for **${parts.join(" ")}**.`);
    return;
  }

  if (message.content === ".reboot") {
    await message.reply("♻️ Rebooting now…");
    logger.info({ requestedBy: message.author.tag }, ".reboot command — exiting process");
    // Give Discord time to send the reply before exiting.
    // The workflow runner restarts the process automatically.
    setTimeout(() => process.exit(0), 1_500);
    return;
  }

  if (message.content === ".hhelp") {
    const help = [
      "**Voice commands** (prefix `!`)",
      "`!join` — Bot joins the voice channel you are currently in",
      "`!leave` — Bot leaves the voice channel",
      "`!status` — Shows current voice connection status",
      "",
      "**Utility commands** (prefix `.`)",
      "`.ping` — Shows the bot's response time and WebSocket latency",
      "`.uptime` — Shows how long the bot has been running",
      "`.reboot` — Safely restarts the bot process",
      "`.hhelp` — Shows this help message",
    ].join("\n");
    await message.reply(help);
    return;
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

export function startBot() {
  client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    logger.error({ err }, "Discord login failed");
    process.exit(1);
  });
}

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
    Client,
    GatewayIntentBits,
    ActivityType,
    PermissionsBitField
} = require("discord.js");

const PREFIX = "!";
const MAX_NOTES = 5;

if (!process.env.TOKEN) {
    console.error("ERROR: TOKEN is missing.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

/* ---------- storage ---------- */

const STICKY_FILE =
    process.env.STICKY_PATH ||
    path.join(__dirname, "stickies.json");

// stickies[channelId] = [ { content, lastMessageId }, ... ]
let stickies = {};

try {
    if (fs.existsSync(STICKY_FILE)) {
        stickies = JSON.parse(fs.readFileSync(STICKY_FILE, "utf8"));

        // convert the old one-note-per-channel format
        for (const id of Object.keys(stickies)) {
            if (!Array.isArray(stickies[id])) {
                stickies[id] = [stickies[id]];
            }
        }
    }
} catch (error) {
    console.error("Failed to load stickies:", error.message);
    stickies = {};
}

function saveStickies() {
    try {
        fs.mkdirSync(path.dirname(STICKY_FILE), { recursive: true });
        fs.writeFileSync(STICKY_FILE, JSON.stringify(stickies, null, 2));
    } catch (error) {
        console.error("Failed to save stickies:", error.message);
    }
}

/* ---------- sticky logic ---------- */

const timers = new Map();
const busy = new Set();

async function deleteMessage(channel, messageId) {
    if (!messageId) return;
    const old = await channel.messages.fetch(messageId).catch(() => null);
    if (old) await old.delete().catch(() => {});
}

async function repostSticky(channel) {
    const notes = stickies[channel.id];
    if (!notes || notes.length === 0) return;

    // avoid two reposts running at once (this causes duplicates)
    if (busy.has(channel.id)) {
        scheduleSticky(channel);
        return;
    }

    busy.add(channel.id);

    try {
        for (const note of notes) {
            await deleteMessage(channel, note.lastMessageId);
            note.lastMessageId = null;
        }

        for (let i = 0; i < notes.length; i++) {
            const sent = await channel.send(
                "" + (i + 1) + "**\n" + notes[i].content
            );
            notes[i].lastMessageId = sent.id;
        }

        saveStickies();
    } catch (error) {
        console.error("Sticky repost error:", error.message);
    } finally {
        busy.delete(channel.id);
    }
}

function scheduleSticky(channel) {
    if (!stickies[channel.id]) return;

    clearTimeout(timers.get(channel.id));
    timers.set(
        channel.id,
        setTimeout(() => {
            timers.delete(channel.id);
            repostSticky(channel);
        }, 2000)
    );
}

function canManage(message) {
    return message.member.permissions.has(
        PermissionsBitField.Flags.ManageMessages
    );
}

/* ---------- events ---------- */

client.once("clientReady", () => {
    console.log("Logged in as " + client.user.tag + "!");
    client.user.setActivity("!stickyhelp", { type: ActivityType.Listening });
});

client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    // normal chat: repost the stickies after the channel goes quiet
    if (!message.content.startsWith(PREFIX)) {
        scheduleSticky(message.channel);
        return;
    }

    const body = message.content.slice(PREFIX.length).trim();
    const command = body.split(/\s+/)[0].toLowerCase();
    const content = body.slice(command.length).trim();
    const channelId = message.channel.id;

    const staffCommands = ["sticky", "unsticky", "editsticky"];
    if (staffCommands.includes(command) && !canManage(message)) {
        return message.reply("You need the Manage Messages permission to do that.");
    }

    /* ----- !sticky <note> : add a note ----- */
    if (command === "sticky") {
        if (!content) {
            return message.reply("**Usage:** `!sticky <your note>`");
        }
        if (content.length > 1900) {
            return message.reply("That note is too long. Keep it under 1900 characters.");
        }

        const notes = stickies[channelId] || [];

        if (notes.length >= MAX_NOTES) {
            return message.reply(
                "This channel already has " + MAX_NOTES +
                " sticky notes. Remove one with `!unsticky <number>` first."
            );
        }

        notes.push({ content, lastMessageId: null });
        stickies[channelId] = notes;

        clearTimeout(timers.get(channelId));
        await repostSticky(message.channel);
        return;
    }

    /* ----- !stickies : list notes ----- */
    if (command === "stickies") {
        const notes = stickies[channelId];

        if (!notes || notes.length === 0) {
            return message.reply("There are no sticky notes in this channel.");
        }

        const lines = notes.map((note, i) => {
            const short = note.content.replace(/\n/g, " ").slice(0, 80);
            return (i + 1) + ". " + short + (note.content.length > 80 ? "..." : "");
        });

        return message.reply("**📌 Sticky notes in this channel:**\n" + lines.join("\n"));
    }

    /* ----- !editsticky <number> <new text> ----- */
    if (command === "editsticky") {
        const notes = stickies[channelId];
        const match = content.match(/^(\d+)\s+([\s\S]+)$/);

        if (!notes || notes.length === 0) {
            return message.reply("There are no sticky notes in this channel.");
        }
        if (!match) {
            return message.reply("**Usage:** `!editsticky <number> <new text>`");
        }

        const index = parseInt(match[1], 10) - 1;
        const newText = match[2].trim();

        if (index < 0 || index >= notes.length) {
            return message.reply("There's no sticky number " + (index + 1) + ".");
        }
        if (newText.length > 1900) {
            return message.reply("That note is too long. Keep it under 1900 characters.");
        }

        notes[index].content = newText;

        clearTimeout(timers.get(channelId));
        await repostSticky(message.channel);
        return;
    }

    /* ----- !unsticky [number|all] ----- */
    if (command === "unsticky") {
        const notes = stickies[channelId];

        if (!notes || notes.length === 0) {
            return message.reply("There are no sticky notes in this channel.");
        }

        clearTimeout(timers.get(channelId));

        if (content.toLowerCase() === "all") {
            for (const note of notes) {
                await deleteMessage(message.channel, note.lastMessageId);
            }
            delete stickies[channelId];
            saveStickies();
            return message.reply("📌 Removed all sticky notes.");
        }

        let index;

        if (!content && notes.length === 1) {
            index = 0;
        } else if (/^\d+$/.test(content)) {
            index = parseInt(content, 10) - 1;
        } else {
            return message.reply(
                "**Usage:** `!unsticky <number>` or `!unsticky all`\n" +
                "Use `!stickies` to see the numbers."
            );
        }

        if (index < 0 || index >= notes.length) {
            return message.reply("There's no sticky number " + (index + 1) + ".");
        }

        await deleteMessage(message.channel, notes[index].lastMessageId);
        notes.splice(index, 1);

        if (notes.length === 0) {
            delete stickies[channelId];
            saveStickies();
            return message.reply("📌 Removed. No sticky notes left in this channel.");
        }

        saveStickies();
        await repostSticky(message.channel); // renumbers the rest
        return;
    }

    if (command === "stickyhelp") {
        return message.reply(
            [
                "**📌 STICKY BOT**",
                "`!sticky <note>` — Add a sticky note (up to " + MAX_NOTES + " per channel)",
                "`!stickies` — List the notes in this channel",
                "`!editsticky <number> <text>` — Edit a note",
                "`!unsticky <number>` — Remove one note",
                "`!unsticky all` — Remove every note",
                "Adding, editing and removing need the Manage Messages permission."
            ].join("\n")
        );
    }
});

client.login(process.env.TOKEN).catch((error) => {
    console.error("Failed to start bot:", error);
    process.exit(1);
});

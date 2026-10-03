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

let stickies = {};

try {
    if (fs.existsSync(STICKY_FILE)) {
        stickies = JSON.parse(fs.readFileSync(STICKY_FILE, "utf8"));
    }
} catch (error) {
    console.error("Failed to load stickies:", error.message);
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

async function deleteOld(channel, sticky) {
    if (!sticky.lastMessageId) return;
    const old = await channel.messages
        .fetch(sticky.lastMessageId)
        .catch(() => null);
    if (old) await old.delete().catch(() => {});
}

async function repostSticky(channel) {
    const sticky = stickies[channel.id];
    if (!sticky) return;

    try {
        await deleteOld(channel, sticky);
        const sent = await channel.send("📌 **Sticky note**\n" + sticky.content);
        sticky.lastMessageId = sent.id;
        saveStickies();
    } catch (error) {
        console.error("Sticky repost error:", error.message);
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

    /* normal chat: repost the sticky after the channel goes quiet */
    if (!message.content.startsWith(PREFIX)) {
        scheduleSticky(message.channel);
        return;
    }

    const body = message.content.slice(PREFIX.length).trim();
    const command = body.split(/\s+/)[0].toLowerCase();
    const content = body.slice(command.length).trim();

    if (command === "sticky") {
        if (!canManage(message)) {
            return message.reply("You need the Manage Messages permission to do that.");
        }
        if (!content) {
            return message.reply("**Usage:** `!sticky <your note>`");
        }
        if (content.length > 1900) {
            return message.reply("That note is too long. Keep it under 1900 characters.");
        }

        const old = stickies[message.channel.id];
        stickies[message.channel.id] = {
            content,
            lastMessageId: old ? old.lastMessageId : null
        };

        clearTimeout(timers.get(message.channel.id));
        await repostSticky(message.channel);
        return;
    }

    if (command === "unsticky") {
        if (!canManage(message)) {
            return message.reply("You need the Manage Messages permission to do that.");
        }
        const sticky = stickies[message.channel.id];
        if (!sticky) {
            return message.reply("There's no sticky note in this channel.");
        }

        clearTimeout(timers.get(message.channel.id));
        await deleteOld(message.channel, sticky);
        delete stickies[message.channel.id];
        saveStickies();
        return message.reply("");
    }

    if (command === "stickyhelp") {
        return message.reply(
            [
                "****",
                "`!sticky <note>` — Keep a note at the bottom of this channel",
                "`!unsticky` — Remove the note",
                "Needs the Manage Messages permission."
            ].join("\n")
        );
    }
});

client.login(process.env.TOKEN).catch((error) => {
    console.error("Failed to start bot:", error);
    process.exit(1);
});

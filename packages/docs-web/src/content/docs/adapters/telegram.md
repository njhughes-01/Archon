---
title: Telegram
description: Connect Archon to Telegram using the Bot API for mobile and desktop access.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 3
---

Connect Archon to Telegram so you can interact with your AI coding assistant from any Telegram client.

## Prerequisites

- Archon server running (see [Getting Started](/getting-started/overview/))
- A Telegram account

## Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## Set Environment Variable

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...
```

## Configure User Whitelist (Optional)

To restrict bot access to specific users:
1. Message [@userinfobot](https://t.me/userinfobot) on Telegram to get your user ID
2. Add to environment:

```ini
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

When set, only listed user IDs can interact with the bot. When empty/unset, the bot responds to all users.

## Configure Streaming Mode (Optional)

```ini
TELEGRAM_STREAMING_MODE=stream  # stream (default) | batch
```

For streaming mode details, see [Configuration](/getting-started/configuration/).

`stream` sends a message for every text chunk and tool call, which can exceed Telegram's rate limit during long workflow runs. When Telegram rate-limits a send, the adapter waits the time Telegram asks for (up to 60 seconds) and retries once. A message that still fails is logged as `platform_message_send_failed`; if it was an approval gate's message, the gate fails instead of pausing. Use `batch` if you see `429: Too Many Requests` in the server log.

## Run Follow-ups

When the chat's AI starts a workflow run, with its run tool or with `archon workflow run` in its shell, the chat is told when that run finishes, fails, is cancelled, loses its process, or stops for a decision. The server checks those runs every 15 seconds and sends the chat's AI an automatic message marked `[Archon run update — automatic, not typed by the user]`; the AI then reports the result in its own words and carries on, or asks you. An automatic turn never approves, rejects, resumes, cancels, or abandons a run unless you already gave that decision in the chat.

- Only runs started by this chat's AI are followed up. Runs started from a terminal, the Web UI, or the foreground of a chat message are not.
- Each event is followed up once, also across server restarts. Runs that ended more than 24 hours ago are not picked up.
- If the automatic turn fails, or never reaches the AI because the chat's working directory or project no longer exists, the chat gets a one-line note about the run; the follow-up is not retried.
- If you send `/reset` after the run started, the chat gets one short note instead, and the new session is not woken. Runs that `/reset` itself cancelled get no message.
- A background run that reaches an approval gate pauses and waits for your answer in the chat.

To turn follow-ups off, set the variable below and restart the server:

```ini
TELEGRAM_RUN_FOLLOW_UP=false
```

## Further Reading

- [Configuration](/getting-started/configuration/)

# OpenClaw HIS Team Configuration Backup

This repository contains the configuration, custom plugins, and source patches for the HIS team's OpenClaw deployment.

## Directory Structure

```
├── config/           # OpenClaw main configuration
│   └── openclaw.json
├── extensions/       # Custom plugins
│   ├── bot-mention-dispatcher/  # Bot-to-bot mention dispatcher
│   ├── letta-memory/            # Letta memory integration
│   └── mission-control/         # Mission control dashboard
├── patches/          # Source code patches for OpenClaw
│   ├── 001-probe-botname-fix.patch    # Fix bot name extraction
│   └── 002-monitor-namematch-fix.patch # Add name matching for mentions
├── agents/           # Agent configurations
│   ├── zhugeliang/
│   ├── liubei/
│   ├── guanyu/
│   ├── zhaoyun/
│   ├── zhangfei/
│   ├── xunyu/
│   ├── huatuo/
│   └── chenlin/
└── skills/           # Custom skills
    ├── team-dispatch/  # Team dispatch workflow
    └── zentao/         # Zentao integration
```

## Agents

| Agent ID | Name | Model | Role |
|----------|------|-------|------|
| zhugeliang | 诸葛亮 | qwen3.5-plus | System Architect |
| liubei | 刘备 | kimi-k2.5 | Project Manager |
| guanyu | 关羽 | qwen3-coder-next | Backend Developer |
| zhaoyun | 赵云 | qwen3-coder-next | Frontend Developer |
| zhangfei | 张飞 | qwen3-coder-next | Backend Developer |
| xunyu | 荀彧 | qwen3.5-plus | System Analyst |
| huatuo | 华佗 | qwen3.5-plus | Medical Expert |
| chenlin | 陈琳 | glm-5 | Documentation Expert |

## Patches Applied

### 001-probe-botname-fix.patch
Fixes bot name extraction from Feishu API. The API returns `app_name` but the code was looking for `bot_name`.

### 002-monitor-namematch-fix.patch
Adds name matching for bot mentions in group chats. This allows bots to be mentioned by name when the open_id doesn't match.

## Installation

1. Copy configuration:
   ```bash
   cp config/openclaw.json ~/.openclaw/
   ```

2. Install extensions:
   ```bash
   cp -r extensions/* ~/.openclaw/extensions/
   ```

3. Apply patches:
   ```bash
   cd /path/to/openclaw/dist
   patch -p1 < /path/to/patches/001-probe-botname-fix.patch
   patch -p1 < /path/to/patches/002-monitor-namematch-fix.patch
   ```

## Bot Mention Dispatcher

The `bot-mention-dispatcher` plugin enables bots to dispatch messages to other bots when mentioned:

1. Bot A receives a message with @BotB
2. Plugin intercepts and triggers BotB's agent
3. BotB responds in the same conversation

Note: Due to platform limitations, bots cannot trigger other bots via @mentions. The dispatcher works around this by directly invoking the target agent.

## Date

Backup created: 2026-04-09
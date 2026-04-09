---
name: bot-mention-dispatcher
description: Dispatch mentions between bot agents when a bot sends a message with @mentions
events:
  - message:sent
emoji: 🔄
---

# Bot Mention Dispatcher Hook

This hook listens for `message:sent` events and triggers mentioned bot agents
to respond when one bot @mentions another bot in a group chat.

## How it works

1. When a bot sends a message in a Feishu group chat
2. The hook parses the message content for @mention tags
3. For each mentioned bot, it calls `openclaw agent` to trigger a response

## Supported @mention formats

- Text format: `<at user_id="open_id">名字</at>`
- Card format: `<at id=open_id></at>`
- Simple format: `@名字`

## Bot Open ID Mapping

```javascript
const BOT_OPEN_ID_MAP = {
  "ou_cc8a7c647cb17282217426cc5e8a15d9": "zhugeliang",  // 诸葛亮
  "ou_8b744b7eb0e4be77d7236d6a8429b937": "liubei",      // 刘备
  "ou_97808a5c52f56e7007f91da5ea0fe658": "guanyu",      // 关羽
  "ou_c0f0244f68bcfead3f4df3aedc2ec788": "zhaoyun",     // 赵云
  "ou_abc04f268c245d50b37330d56ead51fd": "zhangfei",    // 张飞
  "ou_37e7c8f79e202aaa8dea970e9638787e": "xunyu",       // 荀彧
  "ou_c38edff7932f9a9f2668594b512019f1": "huatuo",      // 华佗
  "ou_3ba5a025c164f95b9d5e263727621b58": "chenlin",     // 陈琳
};
```

## Handler Script

The handler is located at `./handler.js` and exports a default function
that receives the hook event.
#!/usr/bin/env node
/**
 * Bot Mention Dispatcher - Session Monitor
 *
 * Monitors bot agent session files and dispatches mentions between bots.
 * Run as: node monitor.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Bot Open ID Mapping (correct open_ids from Feishu)
const BOT_OPEN_ID_MAP = {
  "ou_cc8a7c647cb17282217426cc5e8a15d9": "zhugeliang",
  "ou_8b744b7eb0e4be77d7236d6a8429b937": "liubei",
  "ou_97808a5c52f56e7007f91da5ea0fe658": "guanyu",
  "ou_c0f0244f68bcfead3f4df3aedc2ec788": "zhaoyun",
  "ou_abc04f268c245d50b37330d56ead51fd": "zhangfei",
  "ou_37e7c8f79e202aaa8dea970e9638787e": "xunyu",
  "ou_c38edff7932f9a9f2668594b512019f1": "huatuo",
  "ou_3ba5a025c164f95b9d5e263727621b58": "chenlin",
};

const AGENT_NAMES = {
  "zhugeliang": "诸葛亮", "liubei": "刘备", "guanyu": "关羽",
  "zhaoyun": "赵云", "zhangfei": "张飞", "xunyu": "荀彧",
  "huatuo": "华佗", "chenlin": "陈琳",
};

const BOT_ACCOUNT_IDS = ["zhugeliang", "liubei", "guanyu", "zhaoyun", "zhangfei", "xunyu", "huatuo", "chenlin"];

const SESSIONS_DIR = '/root/.openclaw/agents';

// Track processed tool call IDs to avoid duplicates
const processedToolCalls = new Set();

function parseMentionsFromText(text) {
  if (!text || typeof text !== 'string') return [];

  const mentions = [];

  // Text format: <at user_id="open_id">名字</at>
  const textPattern = /<at\s+user_id="([^"]+)">([^<]+)<\/at>/g;
  let match;
  while ((match = textPattern.exec(text)) !== null) {
    const agent_id = BOT_OPEN_ID_MAP[match[1]];
    if (agent_id) {
      mentions.push({ open_id: match[1], name: match[2], agent_id });
    }
  }

  return mentions;
}

function triggerAgent(agentId, message, conversationId, senderName) {
  // 明确指示bot如何发送消息到飞书群
  // 关键：必须使用正确的channel和target格式
  const instructions = `[系统提示] 你被 ${senderName} @了，必须回复到飞书群！

【重要】请立即使用message工具回复，参数必须完全按以下格式：

{
  "action": "send",
  "channel": "feishu",
  "target": "chat:${conversationId}",
  "message": "你的回复内容"
}

注意：
1. channel必须是"feishu"，不是wecom或其他
2. target必须是"chat:${conversationId}"格式，不是user:xxx
3. 不能省略任何参数

群ID: ${conversationId}

原始消息：
${message}`;

  console.log(`[bot-mention-dispatcher] Triggering agent: ${agentId}`);
  console.log(`[bot-mention-dispatcher] Using target: chat:${conversationId}`);

  // 使用 --reply-to 参数强制指定回复目标为群聊
  // 使用 --deliver 确保回复被发送
  const args = [
    'agent',
    '--agent', agentId,
    '--message', instructions,
    '--reply-to', `chat:${conversationId}`,
    '--reply-channel', 'feishu',
    '--deliver'
  ];

  const child = spawn('openclaw', args, {
    detached: true,
    stdio: 'ignore'
  });

  child.on('error', (error) => {
    console.error(`[bot-mention-dispatcher] Failed to trigger ${agentId}:`, error.message);
  });

  child.unref();
}

function parseSessionFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const messages = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message) {
          messages.push(entry);
        }
      } catch (e) {
        // Skip invalid lines
      }
    }

    return messages;
  } catch (error) {
    return [];
  }
}

function extractToolCallMessages(messages) {
  const toolCallMessages = [];

  for (const entry of messages) {
    if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        // 检测message工具调用
        if (block.type === 'toolCall' && block.name === 'message' && block.id && block.arguments?.message) {
          toolCallMessages.push({
            toolCallId: block.id,
            message: block.arguments.message,
            timestamp: entry.timestamp
          });
        }
        // 检测纯文本输出中的@mention
        if (block.type === 'text' && block.text) {
          // 检查是否包含bot mention
          const mentions = parseMentionsFromText(block.text);
          if (mentions.length > 0) {
            toolCallMessages.push({
              toolCallId: `text-${entry.id || entry.timestamp}`,
              message: block.text,
              timestamp: entry.timestamp
            });
          }
        }
      }
    }
  }

  return toolCallMessages;
}

function extractConversationId(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    // 从后往前找最后一个包含conversation_label的user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.message?.role === 'user' && entry.message?.content) {
          const text = Array.isArray(entry.message.content)
            ? entry.message.content.map(c => c.text || '').join('')
            : entry.message.content;
          const match = text.match(/"conversation_label":\s*"([^"]+)"/);
          if (match) {
            return match[1];
          }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return '';
}

// 从消息内容中提取 [CONVERSATION_ID:xxx] 标记
function extractConversationIdFromMessage(message) {
  if (!message || typeof message !== 'string') return '';
  const match = message.match(/\[CONVERSATION_ID:([^\]]+)\]/);
  return match ? match[1] : '';
}

function monitorAgentSessions() {
  console.log('[bot-mention-dispatcher] Starting session monitor...');

  // Poll every 10 seconds (reduced from 5 to avoid lock contention)
  setInterval(() => {
    for (const agentId of BOT_ACCOUNT_IDS) {
      const agentDir = path.join(SESSIONS_DIR, agentId, 'sessions');
      if (!fs.existsSync(agentDir)) continue;

      const sessionFiles = fs.readdirSync(agentDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(agentDir, f));

      for (const sessionFile of sessionFiles) {
        // Skip if lock file exists (agent is actively writing)
        const lockFile = sessionFile + '.lock';
        if (fs.existsSync(lockFile)) {
          continue;
        }

        try {
          const messages = parseSessionFile(sessionFile);
          const toolCalls = extractToolCallMessages(messages);

          for (const tc of toolCalls) {
            // Skip already processed
            if (processedToolCalls.has(tc.toolCallId)) continue;

            // Mark as processed
            processedToolCalls.add(tc.toolCallId);

            // Check for bot mentions
            const mentions = parseMentionsFromText(tc.message);
            if (mentions.length === 0) continue;

            // 先尝试从消息中提取 [CONVERSATION_ID:xxx] 标记
            let conversationId = extractConversationIdFromMessage(tc.message);
            // 如果没有找到，从session文件中提取
            if (!conversationId) {
              conversationId = extractConversationId(sessionFile);
            }
            // 如果还是没有，跳过
            if (!conversationId) {
              console.log(`[bot-mention-dispatcher] No conversationId found for ${tc.toolCallId}, skipping`);
              continue;
            }

            console.log(`[bot-mention-dispatcher] Bot ${agentId} mentioned ${mentions.length} bot(s): ${mentions.map(m => m.name).join(', ')}`);
            const senderName = AGENT_NAMES[agentId] || agentId;

            for (const mention of mentions) {
              if (mention.agent_id === agentId) {
                console.log(`[bot-mention-dispatcher] Skipping self-mention: ${mention.agent_id}`);
                continue;
              }
              console.log(`[bot-mention-dispatcher] Dispatching to ${mention.agent_id} (${mention.name})`);
              triggerAgent(mention.agent_id, tc.message, conversationId, senderName);
            }
          }
        } catch (e) {
          // Skip problematic files
        }
      }
    }
  }, 10000);
}

// Cleanup old processed IDs every 5 minutes
setInterval(() => {
  if (processedToolCalls.size > 10000) {
    processedToolCalls.clear();
    console.log('[bot-mention-dispatcher] Cleared processed tool calls cache');
  }
}, 300000);

console.log('[bot-mention-dispatcher] Monitor started');
monitorAgentSessions();
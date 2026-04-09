/**
 * Bot Mention Dispatcher - Plugin Hook Handler
 *
 * This handler is called by OpenClaw when a message_sent event occurs.
 * It checks if the message is from a bot and contains @mentions to other bots,
 * then triggers those bots to respond.
 *
 * Plugin hook signature: handler(event, ctx)
 * - event: { to, content, success, error? }
 * - ctx: { channelId, accountId, conversationId }
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ============================================================================
// Bot Open ID Mapping
// ============================================================================

// Gateway API返回的最新open_id (2026-04-09)
// 注意：飞书在不同场景返回不同的open_id，需要同时支持API open_id和mention open_id
const BOT_OPEN_ID_MAP = {
  // Gateway API返回的open_id
  "ou_29c41628e544f3474ff9745d87d9b4ab": "zhugeliang",  // 诸葛亮 (API)
  "ou_8b744b7eb0e4be77d7236d6a8429b937": "liubei",      // 刘备
  "ou_fe5ef9321cedbf1972c64c6867855c30": "guanyu",      // 关羽 (API)
  "ou_920793c436282af750c8ee04dc9e488d": "zhaoyun",     // 赵云 (API)
  "ou_d85a0a0fe2780c2319c68b71416161f5": "zhangfei",    // 张飞 (API)
  "ou_93fe7307ee77c984e807a5c954546eb4": "xunyu",       // 荀彧 (API)
  "ou_bdf8c73ca609d6219ed03e06f8bc9e48": "huatuo",      // 华佗 (API)
  "ou_40c0c7a8d1bc9c410bb8857dde729037": "chenlin",     // 陈琳 (API)

  // 群聊消息中mention的实际open_id (飞书返回的不同值)
  // 这些是飞书在群聊@机器人时实际返回的open_id
  "ou_9412ee0c7866224e590f6ad3015f19cc": "huatuo",      // 华佗 (mention)
  "ou_f7aae22cc3319e2b30fd38738a38ae1a": "chenlin",     // 陈琳 (mention)
};

// Reverse mapping
const AGENT_TO_OPEN_ID = Object.fromEntries(
  Object.entries(BOT_OPEN_ID_MAP).map(([k, v]) => [v, k])
);

const AGENT_NAMES = {
  "zhugeliang": "诸葛亮",
  "liubei": "刘备",
  "guanyu": "关羽",
  "zhaoyun": "赵云",
  "zhangfei": "张飞",
  "xunyu": "荀彧",
  "huatuo": "华佗",
  "chenlin": "陈琳",
};

// Feishu account IDs that are bots (account ID = agent ID in our setup)
const BOT_ACCOUNT_IDS = [
  "zhugeliang",  // 诸葛亮
  "liubei",      // 刘备
  "guanyu",      // 关羽
  "zhaoyun",     // 赵云
  "zhangfei",    // 张飞
  "xunyu",       // 荀彧
  "huatuo",      // 华佗
  "chenlin",     // 陈琳
];

// ============================================================================
// Mention Parsing
// ============================================================================

function parseMentionsFromText(text) {
  const mentions = [];

  // Text format: <at user_id="open_id">名字</at>
  const textPattern = /<at\s+user_id="([^"]+)">([^<]+)<\/at>/g;
  let match;
  while ((match = textPattern.exec(text)) !== null) {
    const open_id = match[1];
    const name = match[2];
    const agent_id = BOT_OPEN_ID_MAP[open_id];
    mentions.push({ open_id, name, agent_id });
  }

  // Card format: <at id=open_id></at>
  const cardPattern = /<at\s+id=([^>]+)><\/at>/g;
  while ((match = cardPattern.exec(text)) !== null) {
    let open_id = match[1].trim().replace(/^["']|["']$/g, '');
    if (open_id === "all") {
      for (const [botOpenId, agentId] of Object.entries(BOT_OPEN_ID_MAP)) {
        mentions.push({
          open_id: botOpenId,
          name: AGENT_NAMES[agentId] || agentId,
          agent_id: agentId
        });
      }
    } else {
      const agent_id = BOT_OPEN_ID_MAP[open_id];
      mentions.push({
        open_id,
        name: AGENT_NAMES[agent_id || ''] || open_id,
        agent_id
      });
    }
  }

  // Simple format: @名字
  for (const [agentId, name] of Object.entries(AGENT_NAMES)) {
    const simplePattern = new RegExp(`@${name}`);
    if (simplePattern.test(text)) {
      const open_id = AGENT_TO_OPEN_ID[agentId];
      if (open_id && !mentions.some(m => m.open_id === open_id)) {
        mentions.push({ open_id, name, agent_id: agentId });
      }
    }
  }

  return mentions;
}

function isBotOpenId(open_id) {
  return open_id in BOT_OPEN_ID_MAP;
}

function getAgentId(open_id) {
  return BOT_OPEN_ID_MAP[open_id];
}

// Check if accountId is a known bot account
function isBotAccountId(accountId) {
  return BOT_ACCOUNT_IDS.includes(accountId);
}

// ============================================================================
// Agent Triggering
// ============================================================================

async function triggerAgent(agentId, message, conversationId, senderName) {
  const fullMessage = senderName
    ? `[来自 ${senderName} 的@消息]\n${message}`
    : message;

  try {
    const args = [
      'openclaw', 'agent',
      '--agent', agentId,
      '--message', fullMessage,
    ];

    if (conversationId) {
      args.push('--session-id', `feishu:${conversationId}`);
    }

    console.log(`[bot-mention-dispatcher] Triggering agent: ${agentId}`);

    const { stdout, stderr } = await execAsync(args.join(' '), {
      timeout: 120000,
    });

    return { success: true, result: stdout };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[bot-mention-dispatcher] Failed to trigger agent ${agentId}:`, errorMessage);
    return { success: false, result: errorMessage };
  }
}

// ============================================================================
// Main Handler - Plugin Hook Format
// ============================================================================

/**
 * Plugin hook handler for message_sent event
 *
 * @param {object} event - { to, content, success, error? }
 * @param {object} ctx - { channelId, accountId, conversationId }
 */
module.exports = async function handler(event, ctx) {
  console.log('[bot-mention-dispatcher] Plugin hook called');
  console.log('[bot-mention-dispatcher] Event:', JSON.stringify({
    to: event.to,
    success: event.success,
    hasContent: !!event.content
  }));
  console.log('[bot-mention-dispatcher] Context:', JSON.stringify(ctx));

  // Only process successful messages
  if (!event.success) {
    console.log('[bot-mention-dispatcher] Skipping: message not successful');
    return;
  }

  // Only process Feishu messages
  if (ctx.channelId !== 'feishu') {
    console.log(`[bot-mention-dispatcher] Skipping: not feishu channel (${ctx.channelId})`);
    return;
  }

  // Check if the sender is a bot
  // Note: ctx.accountId is the Feishu account name (e.g., "liubei"), not the open_id
  const senderAccountId = ctx.accountId || '';
  if (!isBotAccountId(senderAccountId)) {
    console.log(`[bot-mention-dispatcher] Sender ${senderAccountId} is not a bot account, skipping`);
    return;
  }

  const senderAgentId = senderAccountId;  // Account ID matches agent ID in our setup
  console.log(`[bot-mention-dispatcher] Bot ${senderAgentId} sent a message`);

  // Parse mentions from message content
  const mentions = parseMentionsFromText(event.content);
  if (mentions.length === 0) {
    console.log('[bot-mention-dispatcher] No mentions found in message');
    return;
  }

  // Filter to bot mentions only
  const botMentions = mentions.filter(m => m.agent_id);
  if (botMentions.length === 0) {
    console.log('[bot-mention-dispatcher] No bot mentions found');
    return;
  }

  console.log(`[bot-mention-dispatcher] Found ${botMentions.length} bot mention(s)`);

  const senderName = AGENT_NAMES[senderAgentId] || senderAgentId;

  // Trigger each mentioned bot
  for (const mention of botMentions) {
    // Skip self-mention
    if (mention.agent_id === senderAgentId) {
      console.log(`[bot-mention-dispatcher] Skipping self-mention: ${mention.agent_id}`);
      continue;
    }

    console.log(`[bot-mention-dispatcher] Dispatching to ${mention.agent_id} (${mention.name})`);

    // Trigger agent asynchronously
    triggerAgent(
      mention.agent_id,
      event.content,
      ctx.conversationId || event.to,
      senderName
    ).then(result => {
      if (result.success) {
        console.log(`[bot-mention-dispatcher] Successfully triggered ${mention.agent_id}`);
      } else {
        console.error(`[bot-mention-dispatcher] Failed to trigger ${mention.agent_id}: ${result.result}`);
      }
    }).catch(error => {
      console.error(`[bot-mention-dispatcher] Error triggering ${mention.agent_id}:`, error);
    });
  }
};

// Export utilities for testing
module.exports.parseMentionsFromText = parseMentionsFromText;
module.exports.isBotOpenId = isBotOpenId;
module.exports.getAgentId = getAgentId;
module.exports.isBotAccountId = isBotAccountId;
module.exports.triggerAgent = triggerAgent;
module.exports.BOT_OPEN_ID_MAP = BOT_OPEN_ID_MAP;
module.exports.BOT_ACCOUNT_IDS = BOT_ACCOUNT_IDS;
module.exports.AGENT_NAMES = AGENT_NAMES;
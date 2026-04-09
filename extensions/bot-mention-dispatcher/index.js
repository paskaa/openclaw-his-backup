/**
 * Bot Mention Dispatcher Plugin
 *
 * Dispatches mentions between bot agents when a bot sends a message with @mentions.
 * Uses after_tool_call hook to intercept message tool calls from bot agents.
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

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

const AGENT_TO_OPEN_ID = Object.fromEntries(
  Object.entries(BOT_OPEN_ID_MAP).map(([k, v]) => [v, k])
);

const AGENT_NAMES = {
  "zhugeliang": "诸葛亮", "liubei": "刘备", "guanyu": "关羽",
  "zhaoyun": "赵云", "zhangfei": "张飞", "xunyu": "荀彧",
  "huatuo": "华佗", "chenlin": "陈琳",
};

const BOT_ACCOUNT_IDS = ["zhugeliang", "liubei", "guanyu", "zhaoyun", "zhangfei", "xunyu", "huatuo", "chenlin"];

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

  // Card format: <at id=open_id></at>
  const cardPattern = /<at\s+id=([^>]+)><\/at>/g;
  while ((match = cardPattern.exec(text)) !== null) {
    let open_id = match[1].trim().replace(/^["']|["']$/g, '');
    if (open_id === "all") {
      for (const [botOpenId, agentId] of Object.entries(BOT_OPEN_ID_MAP)) {
        mentions.push({ open_id: botOpenId, name: AGENT_NAMES[agentId], agent_id: agentId });
      }
    } else {
      const agent_id = BOT_OPEN_ID_MAP[open_id];
      if (agent_id) mentions.push({ open_id, name: AGENT_NAMES[agent_id], agent_id });
    }
  }

  // Simple format: @名字
  for (const [agentId, name] of Object.entries(AGENT_NAMES)) {
    if (new RegExp(`@${name}`).test(text)) {
      const open_id = AGENT_TO_OPEN_ID[agentId];
      if (open_id && !mentions.some(m => m.open_id === open_id)) {
        mentions.push({ open_id, name, agent_id: agentId });
      }
    }
  }

  return mentions;
}

async function triggerAgent(agentId, message, conversationId, senderName) {
  // 明确指示bot如何发送消息到飞书群
  // 关键：必须使用正确的channel和target格式
  const fullMessage = `[系统提示] 你被 ${senderName} @了，必须回复到飞书群！

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

  try {
    const args = ['openclaw', 'agent', '--agent', agentId, '--message', fullMessage];
    console.log(`[bot-mention-dispatcher] Triggering agent: ${agentId}`);
    await execAsync(args.join(' '), { timeout: 120000 });
    console.log(`[bot-mention-dispatcher] Successfully triggered ${agentId}`);
  } catch (error) {
    console.error(`[bot-mention-dispatcher] Failed to trigger ${agentId}:`, error.message);
  }
}

module.exports = function(api) {
  console.log('[bot-mention-dispatcher] Plugin loaded');

  // Hook into after_tool_call to intercept message tool calls from bots
  const toolHandler = async (event, ctx) => {
    const agentId = ctx.agentId || '';
    const toolName = event.toolName || '';

    console.log(`[bot-mention-dispatcher] after_tool_call hook: agent=${agentId}, tool=${toolName}`);

    // Only process message tool calls
    if (toolName !== 'message') {
      return;
    }

    // Only process if sender is a bot
    if (!BOT_ACCOUNT_IDS.includes(agentId)) {
      console.log(`[bot-mention-dispatcher] Agent ${agentId} is not a bot, skipping`);
      return;
    }

    // Extract the message content from tool params
    // The params structure is: { action: "send", message: "..." }
    const messageContent = event.params?.message || '';
    if (!messageContent) {
      console.log('[bot-mention-dispatcher] No message content in tool params');
      return;
    }

    console.log(`[bot-mention-dispatcher] Bot ${agentId} sending message, checking for mentions...`);
    console.log(`[bot-mention-dispatcher] Message: ${messageContent.substring(0, 200)}...`);

    const mentions = parseMentionsFromText(messageContent).filter(m => m.agent_id);
    if (mentions.length === 0) {
      console.log('[bot-mention-dispatcher] No bot mentions found in message');
      return;
    }

    console.log(`[bot-mention-dispatcher] Found ${mentions.length} bot mention(s): ${mentions.map(m => m.name).join(', ')}`);
    const senderName = AGENT_NAMES[agentId] || agentId;

    // Extract conversation ID from sessionKey (format: agent:agentId:feishu:group:conversationId)
    const sessionKey = ctx.sessionKey || '';
    const parts = sessionKey.split(':');
    const conversationId = parts[parts.length - 1] || '';

    console.log(`[bot-mention-dispatcher] SessionKey: ${sessionKey}, conversationId: ${conversationId}`);

    for (const mention of mentions) {
      if (mention.agent_id === agentId) {
        console.log(`[bot-mention-dispatcher] Skipping self-mention: ${mention.agent_id}`);
        continue;
      }
      console.log(`[bot-mention-dispatcher] Dispatching to ${mention.agent_id} (${mention.name})`);
      // Fire and forget - don't wait for the triggered agent
      triggerAgent(mention.agent_id, messageContent, conversationId, senderName);
    }
  };

  // Register after_tool_call hook
  api.registerHook('after_tool_call', toolHandler, { name: 'bot-mention-dispatcher' });
};
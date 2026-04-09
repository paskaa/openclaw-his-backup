/**
 * Bot Mention Dispatcher - OpenClaw Plugin
 *
 * This plugin listens for message:sent events and triggers mentioned bot agents
 * to respond when one bot @mentions another bot in a group chat.
 *
 * This solves the Feishu platform limitation where bot messages don't trigger
 * notification events for other bots.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================================
// Bot Open ID Mapping
// ============================================================================

/**
 * Mapping of Feishu bot open_id to OpenClaw agent_id
 */
const BOT_OPEN_ID_MAP: Record<string, string> = {
  "ou_cc8a7c647cb17282217426cc5e8a15d9": "zhugeliang",  // 诸葛亮
  "ou_8b744b7eb0e4be77d7236d6a8429b937": "liubei",      // 刘备
  "ou_97808a5c52f56e7007f91da5ea0fe658": "guanyu",      // 关羽
  "ou_c0f0244f68bcfead3f4df3aedc2ec788": "zhaoyun",     // 赵云
  "ou_abc04f268c245d50b37330d56ead51fd": "zhangfei",    // 张飞
  "ou_37e7c8f79e202aaa8dea970e9638787e": "xunyu",       // 荀彧
  "ou_c38edff7932f9a9f2668594b512019f1": "huatuo",      // 华佗
  "ou_3ba5a025c164f95b9d5e263727621b58": "chenlin",     // 陈琳
};

// Reverse mapping: agent_id -> open_id
const AGENT_TO_OPEN_ID: Record<string, string> = Object.fromEntries(
  Object.entries(BOT_OPEN_ID_MAP).map(([k, v]) => [v, k])
);

// Agent ID to display name
const AGENT_NAMES: Record<string, string> = {
  "zhugeliang": "诸葛亮",
  "liubei": "刘备",
  "guanyu": "关羽",
  "zhaoyun": "赵云",
  "zhangfei": "张飞",
  "xunyu": "荀彧",
  "huatuo": "华佗",
  "chenlin": "陈琳",
};

// ============================================================================
// Types
// ============================================================================

interface MentionInfo {
  open_id: string;
  name: string;
  agent_id?: string;
}

interface MessageSentContext {
  to: string;
  content: string;
  success: boolean;
  error?: string;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
}

interface InternalHookEvent {
  type: string;
  action: string;
  sessionKey: string;
  context: MessageSentContext;
  timestamp: Date;
  messages: string[];
}

// ============================================================================
// Mention Parsing
// ============================================================================

/**
 * Parse @mention tags from message text
 *
 * Supports formats:
 * - Text format: <at user_id="open_id">名字</at>
 * - Card format: <at id=open_id></at>
 * - Simple format: @名字
 */
function parseMentionsFromText(text: string): MentionInfo[] {
  const mentions: MentionInfo[] = [];

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
      // @everyone - notify all bots
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

/**
 * Check if an open_id is a bot
 */
function isBotOpenId(open_id: string): boolean {
  return open_id in BOT_OPEN_ID_MAP;
}

/**
 * Get agent_id from open_id
 */
function getAgentId(open_id: string): string | undefined {
  return BOT_OPEN_ID_MAP[open_id];
}

// ============================================================================
// Agent Triggering
// ============================================================================

/**
 * Trigger an agent to respond via OpenClaw CLI
 */
async function triggerAgent(
  agentId: string,
  message: string,
  conversationId?: string,
  senderName?: string
): Promise<{ success: boolean; result: string }> {
  // Build message content
  const fullMessage = senderName
    ? `[来自 ${senderName} 的@消息]\n${message}`
    : message;

  try {
    // Build openclaw agent command
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
      timeout: 120000, // 2 minutes timeout
    });

    if (stderr && !stderr.includes('warning')) {
      console.error(`[bot-mention-dispatcher] Agent ${agentId} stderr:`, stderr);
    }

    return { success: true, result: stdout };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[bot-mention-dispatcher] Failed to trigger agent ${agentId}:`, errorMessage);
    return { success: false, result: errorMessage };
  }
}

// ============================================================================
// Hook Handler
// ============================================================================

/**
 * Handle message:sent event
 */
async function handleMentionSent(event: InternalHookEvent): Promise<void> {
  const context = event.context;

  // Only process successful messages
  if (!context.success) {
    return;
  }

  // Only process Feishu messages
  if (context.channelId !== 'feishu') {
    return;
  }

  // Only process group messages
  if (!context.isGroup && !context.groupId) {
    return;
  }

  // Check if the sender is a bot (by checking accountId pattern)
  // In Feishu, accountId is the bot's open_id
  const senderOpenId = context.accountId || '';
  if (!isBotOpenId(senderOpenId)) {
    console.log(`[bot-mention-dispatcher] Sender ${senderOpenId} is not a bot, skipping`);
    return;
  }

  const senderAgentId = getAgentId(senderOpenId);
  if (!senderAgentId) {
    console.log(`[bot-mention-dispatcher] Could not determine agent_id for ${senderOpenId}`);
    return;
  }

  console.log(`[bot-mention-dispatcher] Bot ${senderAgentId} (${senderOpenId}) sent a message`);

  // Parse mentions from message content
  const mentions = parseMentionsFromText(context.content);
  if (mentions.length === 0) {
    return;
  }

  // Filter to bot mentions only
  const botMentions = mentions.filter(m => m.agent_id);
  if (botMentions.length === 0) {
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

    // Trigger agent asynchronously (don't await)
    triggerAgent(
      mention.agent_id!,
      context.content,
      context.conversationId || context.groupId,
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
}

// ============================================================================
// Plugin Registration
// ============================================================================

// This function is called by OpenClaw when the plugin is loaded
export default function register(): void {
  console.log('[bot-mention-dispatcher] Plugin loaded');

  // Register the hook handler for message:sent events
  // Note: OpenClaw's internal hook system uses registerInternalHook
  try {
    // Dynamic import to get registerInternalHook from openclaw
    // This is a workaround since we can't directly import from openclaw
    const hookModule = require('openclaw/dist/plugin-sdk/src/hooks/internal-hooks.js');
    if (hookModule.registerInternalHook) {
      hookModule.registerInternalHook('message:sent', handleMentionSent);
      console.log('[bot-mention-dispatcher] Registered hook for message:sent');
    } else {
      console.warn('[bot-mention-dispatcher] registerInternalHook not found, using fallback');
    }
  } catch (error) {
    console.error('[bot-mention-dispatcher] Failed to register hook:', error);
  }
}

// Export for direct usage
export {
  parseMentionsFromText,
  isBotOpenId,
  getAgentId,
  triggerAgent,
  handleMentionSent,
  BOT_OPEN_ID_MAP,
  AGENT_NAMES
};
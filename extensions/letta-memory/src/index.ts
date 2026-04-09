/**
 * Letta Memory Integration for OpenClaw
 * 为 OpenClaw 智能体提供持久化记忆能力
 */

import Letta from "@letta-ai/letta-client";

// 智能体记忆配置
export interface AgentMemoryConfig {
  agentId: string;          // OpenClaw 智能体 ID
  name: string;             // 智能体名称
  persona: string;          // 人格描述
  humanInfo?: string;       // 用户信息
  lettaAgentId?: string;    // Letta 智能体 ID (创建后自动填充)
}

// 记忆块
export interface MemoryBlock {
  label: string;            // human/persona/skills 等
  value: string;            // 记忆内容
}

// Letta 集成管理器
export class LettaMemoryManager {
  private client: Letta | null = null;
  private localMode: boolean = true;
  private agentMapping: Map<string, string> = new Map(); // openclaw_id -> letta_id
  private initialized: boolean = false;

  constructor() {
    this.loadMapping();
  }

  /**
   * 初始化 Letta 客户端
   * 本地模式: 不需要 API key
   * API模式: 需要 Letta API key
   */
  async init(apiKey?: string): Promise<boolean> {
    try {
      if (apiKey) {
        this.client = new Letta({ apiKey });
        this.localMode = false;
      } else {
        // 本地模式 - 使用 letta CLI
        this.localMode = true;
        this.client = null;
      }
      this.initialized = true;
      console.log(`[Letta] 初始化成功，模式: ${this.localMode ? '本地' : 'API'}`);
      return true;
    } catch (error) {
      console.error('[Letta] 初始化失败:', error);
      return false;
    }
  }

  /**
   * 为智能体创建 Letta 记忆
   */
  async createAgentMemory(config: AgentMemoryConfig): Promise<string | null> {
    const memoryBlocks: MemoryBlock[] = [
      { label: "persona", value: config.persona },
      { label: "human", value: config.humanInfo || `用户与 ${config.name} 交互` }
    ];

    if (this.localMode) {
      // 本地模式：使用 CLI 创建
      const agentId = await this.createLocalAgent(config.name, memoryBlocks);
      if (agentId) {
        this.agentMapping.set(config.agentId, agentId);
        this.saveMapping();
        return agentId;
      }
      return null;
    } else if (this.client) {
      // API 模式
      try {
        const agent = await this.client.agents.create({
          model: "openai/gpt-4o",  // 可配置
          memory_blocks: memoryBlocks,
          tools: ["web_search", "fetch_webpage"]
        });
        this.agentMapping.set(config.agentId, agent.id);
        this.saveMapping();
        console.log(`[Letta] 创建智能体记忆: ${config.name} -> ${agent.id}`);
        return agent.id;
      } catch (error) {
        console.error(`[Letta] 创建智能体失败:`, error);
        return null;
      }
    }
    return null;
  }

  /**
   * 发送消息并获取响应（自动更新记忆）
   */
  async sendMessage(openclawAgentId: string, message: string): Promise<string | null> {
    const lettaAgentId = this.agentMapping.get(openclawAgentId);
    if (!lettaAgentId) {
      console.error(`[Letta] 未找到智能体映射: ${openclawAgentId}`);
      return null;
    }

    if (this.localMode) {
      return await this.sendLocalMessage(lettaAgentId, message);
    } else if (this.client) {
      try {
        const response = await this.client.agents.messages.create(lettaAgentId, {
          input: message
        });
        // 提取响应文本
        const messages = response.messages || [];
        const textMessages = messages
          .filter((m: any) => m.message_type === 'assistant_message')
          .map((m: any) => m.content)
          .join('\n');
        return textMessages;
      } catch (error) {
        console.error(`[Letta] 发送消息失败:`, error);
        return null;
      }
    }
    return null;
  }

  /**
   * 获取智能体记忆内容
   */
  async getMemory(openclawAgentId: string): Promise<MemoryBlock[] | null> {
    const lettaAgentId = this.agentMapping.get(openclawAgentId);
    if (!lettaAgentId || !this.client) {
      return null;
    }

    try {
      const blocks = await this.client.agents.blocks.list(lettaAgentId);
      return blocks.map((b: any) => ({
        label: b.label,
        value: b.value
      }));
    } catch (error) {
      console.error(`[Letta] 获取记忆失败:`, error);
      return null;
    }
  }

  /**
   * 手动更新记忆
   */
  async updateMemory(openclawAgentId: string, label: string, value: string): Promise<boolean> {
    const lettaAgentId = this.agentMapping.get(openclawAgentId);
    if (!lettaAgentId || !this.client) {
      return false;
    }

    try {
      await this.client.agents.blocks.update(lettaAgentId, label, { value });
      console.log(`[Letta] 更新记忆: ${openclawAgentId}[${label}]`);
      return true;
    } catch (error) {
      console.error(`[Letta] 更新记忆失败:`, error);
      return false;
    }
  }

  // 本地模式辅助方法
  private async createLocalAgent(name: string, blocks: MemoryBlock[]): Promise<string | null> {
    // 使用 letta CLI 创建智能体
    const { execSync } = await import('child_process');
    try {
      const personaValue = blocks.find(b => b.label === 'persona')?.value || '';
      const result = execSync(
        `letta --new-agent --name "${name}" --init-blocks persona,human --prompt "创建智能体"`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      // 解析输出获取 agent ID
      const match = result.match(/agent[_-]?id[=:\s]+([a-zA-Z0-9_-]+)/i);
      if (match) {
        return match[1];
      }
      // 如果没有匹配，生成一个本地 ID
      return `local_${name}_${Date.now()}`;
    } catch (error) {
      console.error('[Letta] 本地创建智能体失败:', error);
      // 返回一个模拟 ID，后续可以同步
      return `local_${name}_${Date.now()}`;
    }
  }

  private async sendLocalMessage(lettaAgentId: string, message: string): Promise<string | null> {
    const { execSync } = await import('child_process');
    try {
      const result = execSync(
        `letta --agent "${lettaAgentId}" -p "${message.replace(/"/g, '\\"')}"`,
        { encoding: 'utf-8', timeout: 60000 }
      );
      return result.trim();
    } catch (error) {
      console.error('[Letta] 本地发送消息失败:', error);
      return null;
    }
  }

  // 持久化映射关系
  private mappingFile = '/root/.openclaw/extensions/letta-memory/agent-mapping.json';

  private loadMapping(): void {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.mappingFile)) {
        const data = JSON.parse(fs.readFileSync(this.mappingFile, 'utf-8'));
        this.agentMapping = new Map(Object.entries(data));
      }
    } catch (error) {
      // 忽略加载错误
    }
  }

  private saveMapping(): void {
    try {
      const fs = require('fs');
      const data = Object.fromEntries(this.agentMapping);
      fs.writeFileSync(this.mappingFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('[Letta] 保存映射失败:', error);
    }
  }
}

// 导出单例
export const lettaMemory = new LettaMemoryManager();
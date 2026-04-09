#!/usr/bin/env python3
"""
Team Dispatch MCP Server
提供agent间通信能力，绑过企微API的限制
"""

import asyncio
import json
import httpx
import os
from typing import Any
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Gateway API配置
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://127.0.0.1:18791")
GATEWAY_TOKEN = os.getenv("GATEWAY_TOKEN", "")

# HIS团队agent配置
TEAM_AGENTS = {
    "architect": {"id": "his-architect", "name": "HIS系统架构师", "workspace": "/root/.openclaw/workspace-his-arch"},
    "backend": {"id": "his-backend", "name": "HIS后端开发", "workspace": "/root/.openclaw/workspace-his-backend"},
    "frontend": {"id": "his-frontend", "name": "HIS前端开发", "workspace": "/root/.openclaw/workspace-his-frontend"},
    "database": {"id": "his-database", "name": "HIS数据库专家", "workspace": "/root/.openclaw/workspace-his-db"},
    "tester": {"id": "his-tester", "name": "HIS测试专家", "workspace": "/root/.openclaw/workspace-his-test"},
    "medical": {"id": "his-medical", "name": "HIS医疗专家", "workspace": "/root/.openclaw/workspace-his-medical"},
    "doc": {"id": "doc-specialist", "name": "HIS文档处理专家", "workspace": "/root/.openclaw/workspace-doc-specialist"},
    "pm": {"id": "his-pm", "name": "HIS项目经理", "workspace": "/root/.openclaw/workspace-his-pm"},
}

# Agent关键词映射
KEYWORD_MAP = {
    "全部": ["architect", "backend", "frontend", "database", "tester", "medical", "doc"],
    "所有人": ["architect", "backend", "frontend", "database", "tester", "medical", "doc"],
    "架构": ["architect"],
    "后端": ["backend"],
    "前端": ["frontend"],
    "数据库": ["database"],
    "测试": ["tester"],
    "医疗": ["medical"],
    "文档": ["doc"],
}

server = Server("team-dispatch")

@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="dispatch_to_agent",
            description="触发HIS团队其他agent响应。绑过企微API限制，直接通过gateway内部dispatch消息到指定agent。",
            inputSchema={
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": f"关键词：{list(KEYWORD_MAP.keys())}。发送关键词触发对应agent。"
                    },
                    "message": {
                        "type": "string",
                        "description": "要传递给目标agent的消息内容（可选）"
                    },
                    "target_agents": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "直接指定目标agent列表：architect, backend, frontend, database, tester, medical, doc"
                    },
                    "chat_id": {
                        "type": "string",
                        "description": "企微群聊ID（可选，默认使用当前群）"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="list_team_agents",
            description="列出HIS团队所有agent及其信息",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="send_wecom_message",
            description="直接向企微群发送消息（不触发agent），用于通知类消息",
            inputSchema={
                "type": "object",
                "properties": {
                    "chat_id": {
                        "type": "string",
                        "description": "企微群聊ID"
                    },
                    "content": {
                        "type": "string",
                        "description": "消息内容（支持markdown）"
                    },
                    "account_id": {
                        "type": "string",
                        "description": "企微账号ID（可选）"
                    }
                },
                "required": ["chat_id", "content"]
            }
        )
    ]

async def dispatch_via_gateway(agent_id: str, message: str, chat_id: str = None) -> dict:
    """通过gateway内部API dispatch消息到agent"""
    # 目前gateway没有公开dispatch API，我们使用session文件方式
    # 在agent的session中注入一条"用户消息"
    session_dir = f"/root/.openclaw/agents/{agent_id}/sessions"

    # 找到最新的session文件
    session_files = sorted(
        [f for f in os.listdir(session_dir) if f.endswith('.jsonl')],
        key=lambda x: os.path.getmtime(os.path.join(session_dir, x)),
        reverse=True
    )

    if not session_files:
        return {"error": f"No active session for agent {agent_id}"}

    # 创建一个trigger事件文件
    trigger_file = f"/root/.openclaw/agents/{agent_id}/.trigger"
    trigger_data = {
        "agent_id": agent_id,
        "message": message,
        "chat_id": chat_id,
        "timestamp": int(asyncio.get_event_loop().time() * 1000)
    }

    with open(trigger_file, 'w') as f:
        json.dump(trigger_data, f)

    return {"status": "trigger_created", "agent": agent_id, "trigger_file": trigger_file}

async def send_wecom_direct(chat_id: str, content: str, account_id: str = None) -> dict:
    """直接发送企微消息（通过wecom MCP）"""
    headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}"} if GATEWAY_TOKEN else {}

    async with httpx.AsyncClient() as client:
        # 调用gateway的wecom MCP
        response = await client.post(
            f"{GATEWAY_URL}/mcp/wecom/message/send",
            headers=headers,
            json={
                "chat_id": chat_id,
                "content": content,
                "account_id": account_id
            },
            timeout=30
        )
        return response.json()

@server.call_tool()
async def call_tool(name: str, arguments: Any) -> list[TextContent]:
    if name == "list_team_agents":
        agents_info = []
        for key, info in TEAM_AGENTS.items():
            agents_info.append(f"- **{info['name']}** (关键词: `{key}`)")
            agents_info.append(f"  - ID: {info['id']}")
            agents_info.append(f"  - Workspace: {info['workspace']}")

        return [TextContent(type="text", text="\n".join(agents_info))]

    elif name == "dispatch_to_agent":
        keyword = arguments.get("keyword", "")
        target_agents = arguments.get("target_agents", [])
        message = arguments.get("message", "请响应PM的召集")
        chat_id = arguments.get("chat_id")

        # 解析目标agent
        if keyword:
            target_agents = KEYWORD_MAP.get(keyword, [])
            if not target_agents:
                return [TextContent(type="text", text=f"未知关键词: {keyword}。可用关键词: {list(KEYWORD_MAP.keys())}")]

        if not target_agents:
            return [TextContent(type="text", text="请提供keyword或target_agents参数")]

        # Dispatch到每个agent
        results = []
        for agent_key in target_agents:
            agent_info = TEAM_AGENTS.get(agent_key)
            if not agent_info:
                results.append(f"❌ Agent {agent_key} 不存在")
                continue

            try:
                result = await dispatch_via_gateway(
                    agent_info["id"],
                    f"[PM转发] {message}",
                    chat_id
                )
                if "error" in result:
                    results.append(f"❌ {agent_info['name']}: {result['error']}")
                else:
                    results.append(f"✅ {agent_info['name']}: 已触发")
            except Exception as e:
                results.append(f"❌ {agent_info['name']}: {str(e)}")

        return [TextContent(type="text", text="\n".join(results))]

    elif name == "send_wecom_message":
        chat_id = arguments.get("chat_id")
        content = arguments.get("content")
        account_id = arguments.get("account_id")

        try:
            result = await send_wecom_direct(chat_id, content, account_id)
            return [TextContent(type="text", text=json.dumps(result, indent=2))]
        except Exception as e:
            return [TextContent(type="text", text=f"发送失败: {str(e)}")]

    else:
        return [TextContent(type="text", text=f"未知工具: {name}")]

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())
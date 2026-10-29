import { type IStreamEvent } from '@/utils/AiProviders/baseOpenAILikeProvider';
import { type ToolExecutionContext, type ToolManagerTool } from '@/utils/ToolsManager';
import ToolApproval from '@/utils/ToolsManager/toolApproval';
import { safeJsonParse } from '@/utils/formatters';
import i18n from '@/i18n';
import { McpAuthRequiredError, type McpContent, type McpTool, type McpToolResult } from './client';
import { callServerTool, listServers, type McpServer } from './servers';

/**
 * Turns the tools of the user's MCP servers into regular chat tools. Each gets a function name
 * that is unique across servers and fits what LLM APIs accept (letters, digits, _ and -, max 64).
 */

const MAX_NAME = 64;

function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** `homey__set_light`; long names are trimmed with a short hash so they stay unique */
export function functionNameFor(serverName: string, toolName: string): string {
    const name = `${slug(serverName).slice(0, 20) || 'mcp'}__${slug(toolName)}`;
    if (name.length <= MAX_NAME) return name;
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
    return `${name.slice(0, MAX_NAME - 7)}_${hash.toString(36).slice(0, 6)}`;
}

/** What the model sees from a tool result: text as-is, other content described */
export function resultToText(result: McpToolResult): string {
    const parts: string[] = [];
    for (const item of result.content ?? []) {
        const content = item as McpContent & Record<string, any>;
        if (content.type === 'text') parts.push(content.text);
        else if (content.type === 'resource' && content.resource?.text) parts.push(content.resource.text);
        else if (content.type === 'resource_link') parts.push(`Link: ${content.uri}`);
        else if (content.type === 'image' || content.type === 'audio') parts.push(`[${content.type} ${content.mimeType ?? ''} returned]`);
    }
    if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
    const text = parts.join('\n\n') || 'The tool returned no content.';
    return result.isError ? `The tool reported an error: ${text}` : text;
}

/** Read-only tools run right away; anything that may change something asks first */
export function needsApproval(tool: McpTool): boolean {
    return tool.annotations?.readOnlyHint !== true;
}

function toManagerTool(server: McpServer, tool: McpTool): ToolManagerTool {
    const functionName = functionNameFor(server.name, tool.name);
    const label = tool.title || tool.annotations?.title || tool.name;
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
    return {
        id: `mcp:${server.id}:${tool.name}`,
        name: `${server.name}: ${label}`,
        description: tool.description ?? '',
        defaultEnabled: true,
        category: 'appConnections',
        supportsOnDevice: true,
        // Needs a person to sign in and approve - not handed to unattended scheduled jobs
        hiddenFromScheduledJobs: true,
        definition: {
            type: 'function',
            function: {
                name: functionName,
                description: `[${server.name}] ${tool.description ?? label}`.slice(0, 1024),
                parameters: {
                    type: 'object',
                    properties: schema.properties ?? {},
                    required: Array.isArray(schema.required) ? schema.required : [],
                },
            },
        },
        config: { serverId: server.id, toolName: tool.name },
        execute: async (args: unknown, streamEmitter: (event: IStreamEvent, data: any) => void, context?: ToolExecutionContext): Promise<string> => {
            const parsed = (args && typeof args === 'object' ? args : safeJsonParse(String(args ?? '{}'), {})) as Record<string, any>;
            if (needsApproval(tool)) {
                const approval = await ToolApproval.request({
                    skillName: functionName,
                    description: i18n.t('mcp.approval_description', { tool: label, server: server.name }),
                    payload: parsed,
                    streamEmitter,
                    signal: context?.signal,
                    autoApprove: context?.autoApproveTools,
                });
                if (!approval.approved) return approval.message;
            }
            streamEmitter('report_status', i18n.t('mcp.status_calling', { tool: label, server: server.name }));
            try {
                return resultToText(await callServerTool(server, tool.name, parsed, context?.signal));
            } catch (error: any) {
                if (error instanceof McpAuthRequiredError) {
                    return `The ${server.name} connection needs the user to sign in again in Settings > MCP servers. Tell them so.`;
                }
                return `There was an error calling ${tool.name} on ${server.name}: ${error?.message || 'Unknown error'}`;
            }
        },
    };
}

/** Chat tools from every enabled server, using each server's last fetched tool list */
export async function mcpChatTools(): Promise<ToolManagerTool[]> {
    const servers = await listServers().catch(() => [] as McpServer[]);
    const tools: ToolManagerTool[] = [];
    const used = new Set<string>();
    for (const server of servers) {
        if (!server.enabled) continue;
        for (const tool of server.tools ?? []) {
            if (server.disabledTools?.includes(tool.name)) continue;
            const managed = toManagerTool(server, tool);
            if (used.has(managed.definition.function.name)) continue;
            used.add(managed.definition.function.name);
            tools.push(managed);
        }
    }
    return tools;
}

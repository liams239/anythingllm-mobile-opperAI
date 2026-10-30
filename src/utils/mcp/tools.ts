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
    const schema: Record<string, any> = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
    // The whole schema goes along: keeping only properties/required would drop eg "$defs", which
    // "$ref"s in the properties point to, and the provider then rejects the request
    const schemaRest = { ...schema };
    delete schemaRest.$schema;
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
                    ...schemaRest,
                    type: 'object',
                    properties: schema.properties ?? {},
                    required: Array.isArray(schema.required) ? schema.required : [],
                } as ToolManagerTool['definition']['function']['parameters'],
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

/** Every chat tool of every enabled server, using each server's last fetched tool list */
export async function mcpChatTools(): Promise<ToolManagerTool[]> {
    return (await mcpToolSets()).all;
}

/**
 * MCP tools split by how they reach the model: `loaded` (servers set to "always load") go out with
 * every request; `deferred` only once the model asks for them through the find-tools tool.
 */
export async function mcpToolSets(): Promise<{ loaded: ToolManagerTool[]; deferred: ToolManagerTool[]; all: ToolManagerTool[]; servers: McpServer[] }> {
    const servers = await listServers().catch(() => [] as McpServer[]);
    const loaded: ToolManagerTool[] = [];
    const deferred: ToolManagerTool[] = [];
    const used = new Set<string>();
    const enabledServers: McpServer[] = [];
    for (const server of servers) {
        if (!server.enabled) continue;
        enabledServers.push(server);
        for (const tool of server.tools ?? []) {
            if (server.disabledTools?.includes(tool.name)) continue;
            const managed = toManagerTool(server, tool);
            if (used.has(managed.definition.function.name)) continue;
            used.add(managed.definition.function.name);
            (server.alwaysLoad ? loaded : deferred).push(managed);
        }
    }
    return { loaded, deferred, all: [...loaded, ...deferred], servers: enabledServers };
}

export const FIND_TOOLS_NAME = 'find_tools';
const MAX_FOUND = 5;
const MAX_NAMES_PER_SERVER = 60;

function words(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter((word) => word.length >= 2);
}

/**
 * Plain keyword matching of a search against tool names and descriptions - no model needed, so it
 * works the same for any chat model and language of the tool descriptions. Name hits weigh most.
 */
export function searchTools(tools: ToolManagerTool[], query: string, limit = MAX_FOUND): ToolManagerTool[] {
    const queryWords = [...new Set(words(query))];
    if (!queryWords.length) return [];
    const scored = tools.map((tool) => {
        const name = tool.definition.function.name.toLowerCase();
        const description = (tool.definition.function.description ?? '').toLowerCase();
        let score = 0;
        for (const word of queryWords) {
            if (name.includes(word)) score += 3;
            else if (description.includes(word)) score += 1;
        }
        return { tool, score };
    });
    return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.tool);
}

/**
 * The one tool that stands in for every deferred MCP tool. Its description names the servers and
 * their tools (names only), and stays the same between requests so provider prompt caching works.
 * Calling it hands the matching tools to `activate` (ToolsManager.activateTools), which offers them
 * for the rest of the reply.
 */
export function findToolsTool(deferred: ToolManagerTool[], servers: McpServer[], activate: (tools: ToolManagerTool[]) => void): ToolManagerTool {
    const catalog = servers
        .map((server) => {
            const names = deferred.filter((tool) => tool.config.serverId === server.id).map((tool) => tool.definition.function.name);
            if (!names.length) return null;
            const shown = names.slice(0, MAX_NAMES_PER_SERVER);
            const more = names.length > shown.length ? ` (+${names.length - shown.length} more)` : '';
            return `${server.name}: ${shown.join(', ')}${more}`;
        })
        .filter(Boolean)
        .join('\n');
    return {
        id: 'mcp:find_tools',
        get name() { return i18n.t('mcp.find_tools_name'); },
        get description() { return i18n.t('mcp.find_tools_name'); },
        defaultEnabled: true,
        category: 'appConnections',
        supportsOnDevice: true,
        hiddenFromScheduledJobs: true,
        alwaysOffer: true,
        definition: {
            type: 'function',
            function: {
                name: FIND_TOOLS_NAME,
                description:
                    'Load more tools from the user\'s connected services before using them. These tools exist but are not loaded yet:\n' +
                    `${catalog}\n` +
                    'Call this first whenever one of them could help, with the exact names you need (preferred) or English keywords. ' +
                    'The loaded tools can be called right after. Do not use it for anything the tools you already have can do.',
                parameters: {
                    type: 'object',
                    properties: {
                        names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names from the list above.' },
                        query: { type: 'string', description: 'Keywords when you do not know the names, eg "turn on light".' },
                    },
                    required: [],
                },
            },
        },
        config: {},
        execute: async (args: unknown): Promise<string> => {
            const parsed = (args && typeof args === 'object' ? args : safeJsonParse(String(args ?? '{}'), {})) as { names?: unknown; query?: unknown };
            const wanted = Array.isArray(parsed.names) ? parsed.names.map(String) : [];
            const byName = deferred.filter((tool) => wanted.includes(tool.definition.function.name));
            const found = byName.length ? byName : searchTools(deferred, String(parsed.query ?? wanted.join(' ')));
            if (!found.length) return `No tools matched. Pick exact names from the list in this tool's description.`;
            activate(found);
            return `Loaded ${found.length} tool(s), now available to call: ` +
                found.map((tool) => `${tool.definition.function.name}: ${(tool.definition.function.description ?? '').slice(0, 160)}`).join(' | ');
        },
    };
}

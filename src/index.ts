#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import Evernote from 'evernote';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EN: any = Evernote;

const token = process.env.EVERNOTE_TOKEN;
if (!token) {
  process.stderr.write('Error: EVERNOTE_TOKEN environment variable is required\n');
  process.exit(1);
}

// Set EVERNOTE_SANDBOX=true to use the sandbox environment for development
const sandbox = process.env.EVERNOTE_SANDBOX === 'true';
const client = new EN.Client({ token, sandbox });

function textToEnml(text: string): string {
  if (text.trim().startsWith('<?xml')) return text;
  const body = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">' +
    `<en-note>${body}</en-note>`
  );
}

function enmlToText(enml: string): string {
  return enml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

const TOOLS = [
  // ─── Notebooks ────────────────────────────────────────────────────────────
  {
    name: 'list_notebooks',
    description: 'List all Evernote notebooks',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_notebook',
    description: 'Get a specific notebook by GUID',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Notebook GUID' },
      },
      required: ['guid'],
    },
  },
  {
    name: 'get_default_notebook',
    description: 'Get the default notebook',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_notebook',
    description: 'Create a new notebook',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Notebook name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_notebook',
    description: 'Rename a notebook',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Notebook GUID' },
        name: { type: 'string', description: 'New notebook name' },
      },
      required: ['guid', 'name'],
    },
  },
  {
    name: 'delete_notebook',
    description: 'Permanently delete a notebook and all its notes (cannot be undone)',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Notebook GUID' },
      },
      required: ['guid'],
    },
  },
  // ─── Notes ────────────────────────────────────────────────────────────────
  {
    name: 'create_note',
    description:
      'Create a new note. Content is plain text (auto-converted to ENML) or raw ENML (must start with <?xml).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Note content (plain text or ENML)' },
        notebook_guid: {
          type: 'string',
          description: 'Notebook GUID — uses default notebook if omitted',
        },
        tag_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply to the note',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'get_note',
    description: 'Get a note by GUID including its content (returned as plain text)',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Note GUID' },
      },
      required: ['guid'],
    },
  },
  {
    name: 'update_note',
    description: 'Update a note — only provided fields are changed',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Note GUID' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'New content (plain text or ENML)' },
        notebook_guid: { type: 'string', description: 'Move note to this notebook' },
        tag_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace all tags with these tag names',
        },
      },
      required: ['guid'],
    },
  },
  {
    name: 'delete_note',
    description: 'Move a note to trash (recoverable)',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Note GUID' },
      },
      required: ['guid'],
    },
  },
  {
    name: 'expunge_note',
    description: 'Permanently delete a note (cannot be undone)',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Note GUID' },
      },
      required: ['guid'],
    },
  },
  {
    name: 'list_notes',
    description: 'List notes, optionally filtered to a specific notebook',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_guid: {
          type: 'string',
          description: 'Notebook GUID — lists all notes across notebooks if omitted',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of notes to return (default: 20, max: 100)',
        },
      },
    },
  },
  {
    name: 'search_notes',
    description:
      'Search notes using Evernote search syntax, e.g. "notebook:Work tag:urgent project"',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Evernote search query' },
        notebook_guid: { type: 'string', description: 'Limit search to this notebook' },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default: 20, max: 100)',
        },
      },
      required: ['query'],
    },
  },
  // ─── Tags ─────────────────────────────────────────────────────────────────
  {
    name: 'list_tags',
    description: 'List all tags',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_tag',
    description: 'Create a new tag, optionally nested under a parent tag',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tag name' },
        parent_guid: { type: 'string', description: 'Parent tag GUID for nested tags' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_tag',
    description: 'Rename a tag',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Tag GUID' },
        name: { type: 'string', description: 'New tag name' },
      },
      required: ['guid', 'name'],
    },
  },
  {
    name: 'delete_tag',
    description: 'Permanently delete a tag (notes keep their content, just lose this tag)',
    inputSchema: {
      type: 'object',
      properties: {
        guid: { type: 'string', description: 'Tag GUID' },
      },
      required: ['guid'],
    },
  },
];

const server = new Server(
  { name: 'evernote-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    const noteStore = await client.getNoteStore();

    switch (name) {
      // ── Notebooks ────────────────────────────────────────────────────────
      case 'list_notebooks': {
        const notebooks = await noteStore.listNotebooks();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              notebooks.map((nb: any) => ({
                guid: nb.guid,
                name: nb.name,
                defaultNotebook: nb.defaultNotebook,
                updateSequenceNum: nb.updateSequenceNum,
              })),
              null, 2
            ),
          }],
        };
      }

      case 'get_notebook': {
        const { guid } = args as { guid: string };
        const nb = await noteStore.getNotebook(guid);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              guid: nb.guid,
              name: nb.name,
              defaultNotebook: nb.defaultNotebook,
              updateSequenceNum: nb.updateSequenceNum,
            }, null, 2),
          }],
        };
      }

      case 'get_default_notebook': {
        const nb = await noteStore.getDefaultNotebook();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              guid: nb.guid,
              name: nb.name,
              defaultNotebook: nb.defaultNotebook,
            }, null, 2),
          }],
        };
      }

      case 'create_notebook': {
        const { name: notebookName } = args as { name: string };
        const notebook = new EN.Types.Notebook();
        notebook.name = notebookName;
        const created = await noteStore.createNotebook(notebook);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ guid: created.guid, name: created.name }, null, 2),
          }],
        };
      }

      case 'update_notebook': {
        const { guid, name: newName } = args as { guid: string; name: string };
        const notebook = new EN.Types.Notebook();
        notebook.guid = guid;
        notebook.name = newName;
        await noteStore.updateNotebook(notebook);
        return {
          content: [{ type: 'text', text: `Notebook renamed to "${newName}"` }],
        };
      }

      case 'delete_notebook': {
        const { guid } = args as { guid: string };
        await noteStore.expungeNotebook(guid);
        return {
          content: [{ type: 'text', text: `Notebook ${guid} permanently deleted` }],
        };
      }

      // ── Notes ────────────────────────────────────────────────────────────
      case 'create_note': {
        const { title, content, notebook_guid, tag_names } = args as {
          title: string;
          content: string;
          notebook_guid?: string;
          tag_names?: string[];
        };
        const note = new EN.Types.Note();
        note.title = title;
        note.content = textToEnml(content);
        if (notebook_guid) note.notebookGuid = notebook_guid;
        if (tag_names?.length) note.tagNames = tag_names;
        const created = await noteStore.createNote(note);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              guid: created.guid,
              title: created.title,
              notebookGuid: created.notebookGuid,
              tagNames: created.tagNames,
              created: created.created,
            }, null, 2),
          }],
        };
      }

      case 'get_note': {
        const { guid } = args as { guid: string };
        const note = await noteStore.getNote(guid, true, false, false, false);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              guid: note.guid,
              title: note.title,
              content: note.content ? enmlToText(note.content) : '',
              notebookGuid: note.notebookGuid,
              tagNames: note.tagNames,
              tagGuids: note.tagGuids,
              created: note.created,
              updated: note.updated,
            }, null, 2),
          }],
        };
      }

      case 'update_note': {
        const { guid, title, content, notebook_guid, tag_names } = args as {
          guid: string;
          title?: string;
          content?: string;
          notebook_guid?: string;
          tag_names?: string[];
        };
        const note = new EN.Types.Note();
        note.guid = guid;
        if (title !== undefined) note.title = title;
        if (content !== undefined) note.content = textToEnml(content);
        if (notebook_guid !== undefined) note.notebookGuid = notebook_guid;
        if (tag_names !== undefined) note.tagNames = tag_names;
        const updated = await noteStore.updateNote(note);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              guid: updated.guid,
              title: updated.title,
              notebookGuid: updated.notebookGuid,
              updated: updated.updated,
            }, null, 2),
          }],
        };
      }

      case 'delete_note': {
        const { guid } = args as { guid: string };
        await noteStore.deleteNote(guid);
        return {
          content: [{ type: 'text', text: `Note ${guid} moved to trash` }],
        };
      }

      case 'expunge_note': {
        const { guid } = args as { guid: string };
        await noteStore.expungeNote(guid);
        return {
          content: [{ type: 'text', text: `Note ${guid} permanently deleted` }],
        };
      }

      case 'list_notes':
      case 'search_notes': {
        const { query, notebook_guid, max_results } = args as {
          query?: string;
          notebook_guid?: string;
          max_results?: number;
        };
        const filter = new EN.NoteStore.NoteFilter();
        if (query) filter.words = query;
        if (notebook_guid) filter.notebookGuid = notebook_guid;

        const resultSpec = new EN.NoteStore.NotesMetadataResultSpec();
        resultSpec.includeTitle = true;
        resultSpec.includeCreated = true;
        resultSpec.includeUpdated = true;
        resultSpec.includeNotebookGuid = true;
        resultSpec.includeTagGuids = true;

        const limit = Math.min(max_results ?? 20, 100);
        const result = await noteStore.findNotesMetadata(filter, 0, limit, resultSpec);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              totalNotes: result.totalNotes,
              returned: (result.notes ?? []).length,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              notes: (result.notes ?? []).map((n: any) => ({
                guid: n.guid,
                title: n.title,
                notebookGuid: n.notebookGuid,
                tagGuids: n.tagGuids,
                created: n.created,
                updated: n.updated,
              })),
            }, null, 2),
          }],
        };
      }

      // ── Tags ─────────────────────────────────────────────────────────────
      case 'list_tags': {
        const tags = await noteStore.listTags();
        return {
          content: [{
            type: 'text',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            text: JSON.stringify(tags.map((t: any) => ({
              guid: t.guid,
              name: t.name,
              parentGuid: t.parentGuid,
            })), null, 2),
          }],
        };
      }

      case 'create_tag': {
        const { name: tagName, parent_guid } = args as { name: string; parent_guid?: string };
        const tag = new EN.Types.Tag();
        tag.name = tagName;
        if (parent_guid) tag.parentGuid = parent_guid;
        const created = await noteStore.createTag(tag);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              guid: created.guid,
              name: created.name,
              parentGuid: created.parentGuid,
            }, null, 2),
          }],
        };
      }

      case 'update_tag': {
        const { guid, name: newName } = args as { guid: string; name: string };
        const tag = new EN.Types.Tag();
        tag.guid = guid;
        tag.name = newName;
        await noteStore.updateTag(tag);
        return {
          content: [{ type: 'text', text: `Tag renamed to "${newName}"` }],
        };
      }

      case 'delete_tag': {
        const { guid } = args as { guid: string };
        await noteStore.expungeTag(guid);
        return {
          content: [{ type: 'text', text: `Tag ${guid} deleted` }],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, `Evernote API error: ${message}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Evernote MCP server started\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

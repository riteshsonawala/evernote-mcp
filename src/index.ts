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
import http from 'http';
import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { URL } from 'url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EN: any = Evernote;

const CONSUMER_KEY = process.env.EVERNOTE_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.EVERNOTE_CONSUMER_SECRET;
const SANDBOX = process.env.EVERNOTE_SANDBOX === 'true';
const CALLBACK_PORT = 10500;
const TOKEN_PATH = path.join(os.homedir(), '.evernote-mcp', 'token.json');

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  process.stderr.write(
    'Error: EVERNOTE_CONSUMER_KEY and EVERNOTE_CONSUMER_SECRET are required\n'
  );
  process.exit(1);
}

const unauthClient = new EN.Client({
  consumerKey: CONSUMER_KEY,
  consumerSecret: CONSUMER_SECRET,
  sandbox: SANDBOX,
});

// ─── Token storage ────────────────────────────────────────────────────────────

let storedToken: string | null = null;

async function loadToken(): Promise<void> {
  try {
    const data = await fs.readFile(TOKEN_PATH, 'utf-8');
    storedToken = JSON.parse(data).token ?? null;
  } catch {
    // No token yet — user needs to run authenticate
  }
}

async function saveToken(token: string): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify({ token }, null, 2), 'utf-8');
  storedToken = token;
}

async function clearToken(): Promise<void> {
  try { await fs.unlink(TOKEN_PATH); } catch { /* already gone */ }
  storedToken = null;
}

// ─── Evernote client helpers ──────────────────────────────────────────────────

function requireNoteStore() {
  if (!storedToken) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'Not authenticated. Use the authenticate tool to log in via browser.'
    );
  }
  const client = new EN.Client({ token: storedToken, sandbox: SANDBOX });
  return client.getNoteStore();
}

function getRequestToken(
  callbackUrl: string
): Promise<{ oauthToken: string; oauthTokenSecret: string }> {
  return new Promise((resolve, reject) => {
    unauthClient.getRequestToken(
      callbackUrl,
      (err: any, oauthToken: string, oauthTokenSecret: string) => {
        if (err) reject(new Error(String(err.data ?? err)));
        else resolve({ oauthToken, oauthTokenSecret });
      }
    );
  });
}

function exchangeForAccessToken(
  oauthToken: string,
  oauthTokenSecret: string,
  oauthVerifier: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    unauthClient.getAccessToken(
      oauthToken,
      oauthTokenSecret,
      oauthVerifier,
      (err: any, token: string) => {
        if (err) reject(new Error(String(err.data ?? err)));
        else resolve(token);
      }
    );
  });
}

function waitForOAuthCallback(expectedOauthToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);
        const returnedToken = url.searchParams.get('oauth_token');
        const verifier = url.searchParams.get('oauth_verifier');

        if (returnedToken !== expectedOauthToken || !verifier) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Authorization failed — token mismatch. Please try again.</h1>');
          server.close();
          clearTimeout(timer);
          reject(new Error('OAuth callback had mismatched token or missing verifier'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html><body style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center">
            <h2>&#10003; Authorized!</h2>
            <p>You can close this window and return to Claude.</p>
          </body></html>
        `);
        server.close();
        clearTimeout(timer);
        resolve(verifier);
      } catch (e) {
        server.close();
        clearTimeout(timer);
        reject(e);
      }
    });

    server.on('error', reject);
    server.listen(CALLBACK_PORT);

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out after 2 minutes'));
    }, 120_000);
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd);
}

async function performAuthentication() {
  const callbackUrl = `http://localhost:${CALLBACK_PORT}/callback`;
  const { oauthToken, oauthTokenSecret } = await getRequestToken(callbackUrl);
  const authUrl = unauthClient.getAuthorizeUrl(oauthToken);

  openBrowser(authUrl);
  process.stderr.write(`Opening Evernote auth: ${authUrl}\n`);

  const verifier = await waitForOAuthCallback(oauthToken);
  const token = await exchangeForAccessToken(oauthToken, oauthTokenSecret, verifier);
  await saveToken(token);

  return {
    content: [{
      type: 'text',
      text: `Authenticated successfully. Token saved to ${TOKEN_PATH}`,
    }],
  };
}

// ─── ENML helpers ─────────────────────────────────────────────────────────────

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

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  // Auth
  {
    name: 'authenticate',
    description: 'Open a browser to authorize with Evernote via OAuth. Must be called before using any other tool. Token is saved locally and reused across sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_auth',
    description: 'Check whether the server is currently authenticated with Evernote',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'logout',
    description: 'Remove the stored Evernote access token',
    inputSchema: { type: 'object', properties: {} },
  },
  // Notebooks
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
      properties: { guid: { type: 'string', description: 'Notebook GUID' } },
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
      properties: { name: { type: 'string', description: 'Notebook name' } },
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
      properties: { guid: { type: 'string', description: 'Notebook GUID' } },
      required: ['guid'],
    },
  },
  // Notes
  {
    name: 'create_note',
    description: 'Create a new note. Content is plain text (auto-converted) or raw ENML (starts with <?xml).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Note content (plain text or ENML)' },
        notebook_guid: { type: 'string', description: 'Notebook GUID — uses default if omitted' },
        tag_names: { type: 'array', items: { type: 'string' }, description: 'Tags to apply' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'get_note',
    description: 'Get a note by GUID including its content (returned as plain text)',
    inputSchema: {
      type: 'object',
      properties: { guid: { type: 'string', description: 'Note GUID' } },
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
        tag_names: { type: 'array', items: { type: 'string' }, description: 'Replace all tags' },
      },
      required: ['guid'],
    },
  },
  {
    name: 'delete_note',
    description: 'Move a note to trash (recoverable from Evernote)',
    inputSchema: {
      type: 'object',
      properties: { guid: { type: 'string', description: 'Note GUID' } },
      required: ['guid'],
    },
  },
  {
    name: 'expunge_note',
    description: 'Permanently delete a note (cannot be undone)',
    inputSchema: {
      type: 'object',
      properties: { guid: { type: 'string', description: 'Note GUID' } },
      required: ['guid'],
    },
  },
  {
    name: 'list_notes',
    description: 'List notes, optionally filtered to a specific notebook',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_guid: { type: 'string', description: 'Notebook GUID — lists all notes if omitted' },
        max_results: { type: 'number', description: 'Max results (default: 20, max: 100)' },
      },
    },
  },
  {
    name: 'search_notes',
    description: 'Search notes using Evernote search syntax e.g. "notebook:Work tag:urgent project"',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Evernote search query' },
        notebook_guid: { type: 'string', description: 'Limit search to this notebook' },
        max_results: { type: 'number', description: 'Max results (default: 20, max: 100)' },
      },
      required: ['query'],
    },
  },
  // Tags
  {
    name: 'list_tags',
    description: 'List all tags',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_tag',
    description: 'Create a new tag, optionally nested under a parent',
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
      properties: { guid: { type: 'string', description: 'Tag GUID' } },
      required: ['guid'],
    },
  },
];

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'evernote-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    // Auth tools don't need a noteStore
    if (name === 'authenticate') return await performAuthentication();

    if (name === 'check_auth') {
      return {
        content: [{
          type: 'text',
          text: storedToken
            ? `Authenticated. Token stored at ${TOKEN_PATH}`
            : 'Not authenticated. Use the authenticate tool to log in.',
        }],
      };
    }

    if (name === 'logout') {
      await clearToken();
      return { content: [{ type: 'text', text: 'Logged out. Token removed.' }] };
    }

    // All other tools require an active token
    const noteStore = await requireNoteStore();

    switch (name) {
      // ── Notebooks ──────────────────────────────────────────────────────
      case 'list_notebooks': {
        const notebooks = await noteStore.listNotebooks();
        return {
          content: [{
            type: 'text',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            text: JSON.stringify(notebooks.map((nb: any) => ({
              guid: nb.guid,
              name: nb.name,
              defaultNotebook: nb.defaultNotebook,
              updateSequenceNum: nb.updateSequenceNum,
            })), null, 2),
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
              guid: nb.guid, name: nb.name,
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
            text: JSON.stringify({ guid: nb.guid, name: nb.name, defaultNotebook: nb.defaultNotebook }, null, 2),
          }],
        };
      }

      case 'create_notebook': {
        const { name: notebookName } = args as { name: string };
        const notebook = new EN.Types.Notebook();
        notebook.name = notebookName;
        const created = await noteStore.createNotebook(notebook);
        return {
          content: [{ type: 'text', text: JSON.stringify({ guid: created.guid, name: created.name }, null, 2) }],
        };
      }

      case 'update_notebook': {
        const { guid, name: newName } = args as { guid: string; name: string };
        const notebook = new EN.Types.Notebook();
        notebook.guid = guid;
        notebook.name = newName;
        await noteStore.updateNotebook(notebook);
        return { content: [{ type: 'text', text: `Notebook renamed to "${newName}"` }] };
      }

      case 'delete_notebook': {
        const { guid } = args as { guid: string };
        await noteStore.expungeNotebook(guid);
        return { content: [{ type: 'text', text: `Notebook ${guid} permanently deleted` }] };
      }

      // ── Notes ──────────────────────────────────────────────────────────
      case 'create_note': {
        const { title, content, notebook_guid, tag_names } = args as {
          title: string; content: string; notebook_guid?: string; tag_names?: string[];
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
              guid: created.guid, title: created.title,
              notebookGuid: created.notebookGuid, tagNames: created.tagNames,
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
              guid: note.guid, title: note.title,
              content: note.content ? enmlToText(note.content) : '',
              notebookGuid: note.notebookGuid,
              tagNames: note.tagNames, tagGuids: note.tagGuids,
              created: note.created, updated: note.updated,
            }, null, 2),
          }],
        };
      }

      case 'update_note': {
        const { guid, title, content, notebook_guid, tag_names } = args as {
          guid: string; title?: string; content?: string;
          notebook_guid?: string; tag_names?: string[];
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
              guid: updated.guid, title: updated.title,
              notebookGuid: updated.notebookGuid, updated: updated.updated,
            }, null, 2),
          }],
        };
      }

      case 'delete_note': {
        const { guid } = args as { guid: string };
        await noteStore.deleteNote(guid);
        return { content: [{ type: 'text', text: `Note ${guid} moved to trash` }] };
      }

      case 'expunge_note': {
        const { guid } = args as { guid: string };
        await noteStore.expungeNote(guid);
        return { content: [{ type: 'text', text: `Note ${guid} permanently deleted` }] };
      }

      case 'list_notes':
      case 'search_notes': {
        const { query, notebook_guid, max_results } = args as {
          query?: string; notebook_guid?: string; max_results?: number;
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
                guid: n.guid, title: n.title,
                notebookGuid: n.notebookGuid, tagGuids: n.tagGuids,
                created: n.created, updated: n.updated,
              })),
            }, null, 2),
          }],
        };
      }

      // ── Tags ───────────────────────────────────────────────────────────
      case 'list_tags': {
        const tags = await noteStore.listTags();
        return {
          content: [{
            type: 'text',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            text: JSON.stringify(tags.map((t: any) => ({
              guid: t.guid, name: t.name, parentGuid: t.parentGuid,
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
            text: JSON.stringify({ guid: created.guid, name: created.name, parentGuid: created.parentGuid }, null, 2),
          }],
        };
      }

      case 'update_tag': {
        const { guid, name: newName } = args as { guid: string; name: string };
        const tag = new EN.Types.Tag();
        tag.guid = guid;
        tag.name = newName;
        await noteStore.updateTag(tag);
        return { content: [{ type: 'text', text: `Tag renamed to "${newName}"` }] };
      }

      case 'delete_tag': {
        const { guid } = args as { guid: string };
        await noteStore.expungeTag(guid);
        return { content: [{ type: 'text', text: `Tag ${guid} deleted` }] };
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

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  await loadToken();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const authStatus = storedToken ? 'authenticated' : 'not authenticated (run authenticate tool)';
  process.stderr.write(`Evernote MCP server started — ${authStatus}\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

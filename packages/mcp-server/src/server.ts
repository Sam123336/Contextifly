import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOL_NAMES, type ScreenshotRecord } from '@contextifly/shared';
import { z } from 'zod/v3';
import { BackendClient, BackendError } from './backend-client';
import { recordScreenshotSavings } from './graph/store/usage-ledger';
import { registerGraphTools } from './graph/mcp/tools';

export interface BuildServerOptions {
  backend: BackendClient;
}

const DEFAULT_ANALYZE_TIMEOUT_MS = 120_000;

export function buildServer(opts: BuildServerOptions): McpServer {
  const { backend } = opts;
  const server = new McpServer({
    name: 'contextifly',
    version: '1.0.0',
  });

  server.tool(
    MCP_TOOL_NAMES.ANALYZE_SCREENSHOT,
    'Upload a UI screenshot (PNG/JPEG/WebP) to the Contextifly backend and return ' +
      'structured developer markdown. Blocks until the analysis job completes or times out.',
    {
      filePath: z
        .string()
        .min(1)
        .describe('Absolute path to a local image file (.png, .jpg, .jpeg, .webp).'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Max time to wait for analysis. Default ${DEFAULT_ANALYZE_TIMEOUT_MS}ms.`),
    },
    async ({ filePath, timeoutMs }) => {
      try {
        const uploaded = await backend.uploadScreenshot(filePath);
        const final = await backend.waitForCompletion(uploaded.id, {
          timeoutMs: timeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS,
        });
        if (final.status === 'done' && final.tokenSavings) {
          recordScreenshotSavings(
            final.tokenSavings.imageTokensEstimate,
            final.tokenSavings.markdownTokens,
          );
        }
        return toToolResult(final);
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  server.tool(
    'get_screenshot',
    'Retrieve a previously-uploaded screenshot record by its UUID. Returns current ' +
      'status, markdown (if done), and token-savings stats.',
    {
      id: z.string().uuid().describe('Screenshot UUID returned by analyze_screenshot.'),
    },
    async ({ id }) => {
      try {
        return toToolResult(await backend.getScreenshot(id));
      } catch (err) {
        return toErrorResult(err);
      }
    },
  );

  registerGraphTools(server);

  return server;
}

function toToolResult(record: ScreenshotRecord) {
  const header =
    `**status:** ${record.status}  \n` +
    `**id:** ${record.id}  \n` +
    `**file:** ${record.originalFilename} (${record.mimeType}, ${record.sizeBytes} bytes)`;

  if (record.status === 'failed') {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `${header}\n\n**error:** ${record.errorMessage ?? 'unknown'}`,
        },
      ],
    };
  }

  if (record.status !== 'done' || !record.markdown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${header}\n\n_Analysis not yet complete._`,
        },
      ],
    };
  }

  const savings = record.tokenSavings
    ? `\n\n**token savings:** ${record.tokenSavings.savingsPercent}% ` +
      `(image≈${record.tokenSavings.imageTokensEstimate} → ` +
      `markdown=${record.tokenSavings.markdownTokens})`
    : '';

  return {
    content: [
      {
        type: 'text' as const,
        text: `${header}${savings}\n\n---\n\n${record.markdown}`,
      },
    ],
  };
}

function toErrorResult(err: unknown) {
  const message =
    err instanceof BackendError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

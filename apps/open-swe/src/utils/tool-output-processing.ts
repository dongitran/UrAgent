import { GraphConfig, GraphState, ImageDescription } from "@openswe/shared/open-swe/types";
import { truncateOutput } from "./truncate-outputs.js";
import { handleMcpDocumentationOutput } from "./mcp-output/index.js";
import { parseUrl } from "./url-parser.js";
import { ReadImageResult } from "../tools/read-image.js";
import { generateImageDescriptionAsync } from "./image-description-generator.js";
import { createLogger, LogLevel } from "./logger.js";

const logger = createLogger(LogLevel.INFO, "ToolOutputProcessing");

interface ToolCall {
  name: string;
  args?: Record<string, any>;
}

// Tools that read file content and need higher context limits
const FILE_READ_TOOL_NAMES = ["view", "str_replace_based_edit_tool"];

/**
 * Processes tool call results with appropriate content handling based on tool type.
 * Handles search_document_for, MCP tools, file read tools, and regular tools with different truncation strategies.
 * Returns a new state object with the updated document cache if the tool is a higher context limit tool.
 * 
 * **Hybrid Image Analysis**:
 * For read_image tool, this function also handles background description generation
 * and returns state updates for the imageDescriptionCache.
 */
export async function processToolCallContent(
  toolCall: ToolCall,
  result: string,
  options: {
    higherContextLimitToolNames: string[];
    state: Pick<GraphState, "documentCache"> & { imageDescriptionCache?: Record<string, ImageDescription> };
    config: GraphConfig;
  },
): Promise<{
  content: string;
  stateUpdates?: Partial<Pick<GraphState, "documentCache">>;
  /** Pending image description to be added to cache after async generation */
  pendingImageDescription?: {
    imagePath: string;
    base64DataUrl: string;
  };
}> {
  const { higherContextLimitToolNames, state, config } = options;

  if (toolCall.name === "search_document_for") {
    return {
      content: truncateOutput(result, {
        numStartCharacters: 20000,
        numEndCharacters: 20000,
      }),
    };
  } else if (toolCall.name === "read_image") {
    // =========================================================================
    // HYBRID IMAGE ANALYSIS: Handle first read vs cached read
    // =========================================================================

    // Try to parse as ReadImageResult JSON
    let imageResult: ReadImageResult | null = null;
    try {
      // Check if result is a stringified object (from tool response)
      if (result.startsWith("{")) {
        imageResult = JSON.parse(result) as ReadImageResult;
      }
    } catch {
      // Not JSON, treat as raw result (backward compatibility)
    }

    // If we got a parsed result with isFirstRead metadata
    if (imageResult && typeof imageResult.isFirstRead === "boolean") {
      if (imageResult.isFirstRead && imageResult.base64DataUrl && imageResult.imagePath) {
        // FIRST READ: Return base64 for visual analysis
        // Also schedule async description generation for caching
        logger.info("Processing first-time image read, scheduling description generation", {
          imagePath: imageResult.imagePath,
          base64Length: imageResult.base64DataUrl.length,
        });

        return {
          content: imageResult.base64DataUrl,
          pendingImageDescription: {
            imagePath: imageResult.imagePath,
            base64DataUrl: imageResult.base64DataUrl,
          },
        };
      } else {
        // CACHED READ: Return the cached description
        logger.info("Processing cached image read", {
          imagePath: imageResult.imagePath,
        });

        return {
          content: imageResult.result,
        };
      }
    }

    // FALLBACK: Raw base64 result (backward compatibility / direct base64)
    // CRITICAL: Never truncate read_image output!
    // The base64 image data must be preserved intact for the HumanMessage injection.
    // Truncating base64 data would corrupt the image completely.
    return {
      content: result,
    };
  } else if (FILE_READ_TOOL_NAMES.includes(toolCall.name)) {
    // File read tools (view, str_replace_based_edit_tool with view command) need higher limits
    // to allow AI to read full file content without truncation in the middle
    const isViewCommand = toolCall.name === "view" ||
      (toolCall.name === "str_replace_based_edit_tool" && toolCall.args?.command === "view");

    if (isViewCommand) {
      return {
        content: truncateOutput(result, {
          numStartCharacters: 20000,
          numEndCharacters: 20000,
        }),
      };
    }
    // For non-view commands (str_replace, create, insert), use default truncation
    return {
      content: truncateOutput(result),
    };
  } else if (higherContextLimitToolNames.includes(toolCall.name)) {
    const url = toolCall.args?.url || toolCall.args?.uri || toolCall.args?.path;
    const parsedResult = typeof url === "string" ? parseUrl(url) : null;
    const parsedUrl = parsedResult?.success ? parsedResult.url.href : undefined;

    // avoid generating TOC again if it's already in the cache
    if (parsedUrl && state.documentCache[parsedUrl]) {
      return {
        content: state.documentCache[parsedUrl],
      };
    }

    const processedContent = await handleMcpDocumentationOutput(
      result,
      config,
      {
        url: parsedUrl,
      },
    );

    const stateUpdates = parsedUrl
      ? {
        documentCache: {
          ...state.documentCache,
          [parsedUrl]: result,
        },
      }
      : undefined;

    return {
      content: processedContent,
      stateUpdates,
    };
  } else {
    return {
      content: truncateOutput(result),
    };
  }
}

/**
 * Generate image description asynchronously and update state.
 * Call this after processing tool output to cache the description for future reads.
 * 
 * @param imagePath - Path to the image file (cache key)
 * @param base64DataUrl - The base64 data URL of the image
 * @param config - GraphConfig
 * @param currentCache - Current imageDescriptionCache from state
 * @returns Updated imageDescriptionCache with the new description
 */
export async function generateAndCacheImageDescription(
  imagePath: string,
  base64DataUrl: string,
  config: GraphConfig,
  currentCache: Record<string, ImageDescription> = {},
): Promise<Record<string, ImageDescription>> {
  return new Promise((resolve) => {
    generateImageDescriptionAsync(
      base64DataUrl,
      imagePath,
      config,
      (description) => {
        resolve({
          ...currentCache,
          [imagePath]: description,
        });
      }
    ).catch((error) => {
      logger.error("Failed to generate image description", {
        imagePath,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return unchanged cache on error
      resolve(currentCache);
    });
  });
}
